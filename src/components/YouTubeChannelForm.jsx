import React, {
  useEffect, useImperativeHandle, useState, forwardRef,
} from 'react'
import {
  lookupYoutubeChannel, startYoutubeChannelFetch,
  watchJob, cancelJob,
} from '../lib/jobs'
import { pushScreen } from '../lib/store'
import { refreshSources } from '../lib/sources'
import YouTubeBatchPicker from './YouTubeBatchPicker'

// ─── helpers ──────────────────────────────────────────────────────────────

function fmtDuration(secs) {
  if (!secs) return '—'
  secs = Math.round(secs)
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = secs % 60
  if (h > 0) return `${h}ч ${m}м`
  if (m > 0) return `${m}м ${s.toString().padStart(2, '0')}с`
  return `${s}с`
}

function fmtViews(n) {
  if (!n) return ''
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}K`
  return String(n)
}

// Same caveat as YouTubeBatchPicker: timestamps are approximate (month
// granularity) — render month + year only.
function fmtDate(ts) {
  if (!ts) return null
  const d = new Date(ts * 1000)
  if (isNaN(d.getTime())) return null
  return d.toLocaleDateString('ru-RU', { month: 'short', year: '2-digit' }).replace('.', '')
}

function handleFromUrl(u) {
  if (!u) return null
  const m = u.match(/youtube\.com\/(@[\w.-]+|c\/[\w.-]+|channel\/UC[\w-]+|user\/[\w.-]+)/i)
  if (!m) return null
  const seg = m[1]
  return seg.startsWith('@') ? seg : '@' + seg.split('/', 1)[0]
}

// ─── form ─────────────────────────────────────────────────────────────────

/**
 * Inline YouTube channel form. On mount:
 *   - if cached: render channel header + picker immediately, refresh in bg
 *   - else: spawn channel fetch, render header as data streams in
 *
 * Layout (single column):
 *   ┌─ ChannelHeader (clickable → SourceDetail) ─────────┐
 *   ├─ YouTubeBatchPicker (same component as SourceDetail)─┤
 *   └─────────────────────────────────────────────────────┘
 *
 * Parent (PasteScreen) calls formRef.current.trigger() on Enter to advance —
 * we forward to the picker's trigger (run batch on selection).
 */
const YouTubeChannelForm = forwardRef(function YouTubeChannelForm({ url, onStarted }, ref) {
  // Stages: 'idle' | 'fetching' | 'ready' | 'error'. A new channel starts a
  // complete metadata-catalog pass automatically. This is the free inventory
  // phase; transcript/AI work still requires an explicit picker action.
  const [stage, setStage] = useState('idle')
  const [channelInfo, setChannelInfo] = useState(null)
  const [fetchJob, setFetchJob] = useState(null)
  const [err, setErr] = useState(null)
  const pickerRef = React.useRef(null)
  const autoStartedRef = React.useRef(null)

  // On mount: cache lookup → if found, render ready. Else show kickoff
  // scope-fields and wait for the user to start the fetch.
  useEffect(() => {
    if (!url) return
    let alive = true
    setStage('idle'); setErr(null); setChannelInfo(null); setFetchJob(null)

    ;(async () => {
      const cached = await lookupYoutubeChannel({ handle: handleFromUrl(url) })
      if (!alive) return

      if (cached && cached.items_count) {
        let meta = {}
        try { meta = JSON.parse(cached.meta_json || '{}') || {} } catch {}
        setChannelInfo({
          source_id:           cached.id,
          channel_id:          cached.external_id,
          handle:              cached.handle,
          title:               cached.display_name || cached.handle,
          avatar_url:          cached.avatar_url,
          subs_count:          (() => { try { return JSON.parse(cached.meta_json || '{}').subs_count || null } catch { return null } })(),
          items_total:         cached.items_count,
          loaded_count:        cached.items_count,
          catalog_total:       meta.catalog_total ?? null,
          catalog_complete:    meta.catalog_complete === true,
          total_duration_sec:  null,    // computed below from items
          date_min:            null,
          date_max:            null,
          fromCache:           true,
        })
        // Aggregate stats from items table (fast)
        if (window.api?.itemsList) {
          const items = await window.api.itemsList({
            source_id: cached.id, limit: 20000, offset: 0,
            order: 'published_at DESC', type: 'video',
          })
          if (!alive) return
          const validTs = items.filter(i => i.published_at).map(i => i.published_at)
          setChannelInfo(prev => prev && {
            ...prev,
            total_duration_sec: items.reduce((s, it) => s + (it.duration_seconds || 0), 0),
            date_min: validTs.length ? Math.min(...validTs) : null,
            date_max: validTs.length ? Math.max(...validTs) : null,
          })
        }
        setStage('ready')
      } else if (autoStartedRef.current !== url) {
        autoStartedRef.current = url
        setStage('fetching')
        void kickOffFetch(false, { limit: 0, reverse: false })
      }
    })()

    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url])

  async function kickOffFetch(silent = false, request = null) {
    if (!silent) setStage('fetching')
    setErr(null)
    try {
      const limit = request ? Math.max(0, Number(request.limit) || 0) : 0
      const reverse = request ? !!request.reverse : false
      const id = await startYoutubeChannelFetch({ target: url, limit, reverse })
      if (id == null) { setErr('Электрон-IPC недоступен'); setStage('error'); return }
      const off = watchJob(id, snap => {
        setFetchJob(snap)
        if (snap.yt_channel && (
          snap.yt_channel.channel_id
          || snap.yt_channel.title
          || snap.yt_channel.handle
        )) {
          setChannelInfo(prev => ({
            ...(prev || {}),
            source_id:          snap.source_id || prev?.source_id,
            channel_id:         snap.yt_channel.channel_id || prev?.channel_id,
            handle:             snap.yt_channel.handle     || prev?.handle,
            title:              snap.yt_channel.title      || prev?.title,
            avatar_url:         snap.yt_channel.avatar_url || prev?.avatar_url,
            subs_count:         snap.yt_channel.subs_count ?? prev?.subs_count,
            items_total:        snap.yt_channel.items_total ?? prev?.items_total,
            loaded_count:       snap.yt_channel.loaded_count ?? snap.yt_channel.items_total ?? prev?.loaded_count,
            catalog_total:      snap.yt_channel.catalog_total ?? prev?.catalog_total,
            catalog_complete:   snap.yt_channel.catalog_complete ?? prev?.catalog_complete,
            total_duration_sec: snap.yt_channel.total_duration_sec ?? prev?.total_duration_sec,
            date_min:           snap.yt_channel.date_min ?? prev?.date_min,
            date_max:           snap.yt_channel.date_max ?? prev?.date_max,
            fromCache:          false,
          }))
        }
        if (snap.status === 'done') {
          autoStartedRef.current = null
          refreshSources()
          if (!silent) setStage('ready')
          off()
        }
        if (snap.status === 'error') {
          autoStartedRef.current = null
          setErr(snap.error || 'channel fetch failed'); setStage('error'); off()
        }
      })
    } catch (e) {
      autoStartedRef.current = null
      setErr(String(e?.message || e)); setStage('error')
    }
  }

  function cancelFetch() {
    if (fetchJob?.id != null && fetchJob.status === 'running') cancelJob(fetchJob.id)
  }

  function openInLibrary() {
    if (channelInfo?.source_id) pushScreen('source-detail', { sourceId: channelInfo.source_id })
  }

  // Enter from PasteScreen → first start fetch, then advance picker (run batch).
  useImperativeHandle(ref, () => ({
    trigger() {
      if (stage === 'error') return kickOffFetch(false, { limit: 0, reverse: false })
      if (stage === 'ready' && pickerRef.current?.trigger) pickerRef.current.trigger()
    },
  }), [stage])

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 overflow-hidden">
      {stage === 'idle' && !channelInfo && <FetchingHeader fetchJob={null} onCancel={null} />}
      {stage === 'fetching' && !channelInfo && <FetchingHeader fetchJob={fetchJob} onCancel={cancelFetch} />}
      {channelInfo && (
        <>
          <ChannelHeader
            info={channelInfo}
            fetchJob={fetchJob}
            onClick={channelInfo.source_id ? openInLibrary : null}
          />
          {stage === 'ready' && channelInfo.source_id && (
            <div className="p-4">
              <YouTubeBatchPicker
                ref={pickerRef}
                sourceId={channelInfo.source_id}
                onStarted={onStarted}
              />
            </div>
          )}
        </>
      )}
      {err && stage === 'error' && (
        <div className="px-6 py-4 text-red-400 border-t border-red-900/50 bg-red-950/20">
          {err}
          <button
            onClick={() => kickOffFetch(false, { limit: 0, reverse: false })}
            className="ml-3 px-2 py-1 rounded text-xs bg-red-900/40 hover:bg-red-900/60"
          >Повторить</button>
        </div>
      )}
    </div>
  )
})

export default YouTubeChannelForm

// ─── sub-components ──────────────────────────────────────────────────────

function FetchingHeader({ fetchJob, onCancel }) {
  const loaded = fetchJob?.items_done || 0
  return (
    <div className="px-6 py-5 flex items-center gap-3">
      <div className="text-zinc-300 flex items-center gap-2">
        <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
        Загружаем полный каталог…
      </div>
      {loaded > 0 && (
        <div className="text-zinc-500" style={{ fontSize: '14px' }}>
          {loaded} видео…
        </div>
      )}
      {fetchJob && fetchJob.status === 'running' && onCancel && (
        <button
          onClick={onCancel}
          className="ml-auto text-zinc-500 hover:text-red-400"
          style={{ fontSize: '14px' }}
        >Отменить</button>
      )}
    </div>
  )
}

function ChannelHeader({ info, fetchJob, onClick }) {
  if (!info) return null
  const dMin = info.date_min ? fmtDate(info.date_min) : null
  const dMax = info.date_max ? fmtDate(info.date_max) : null
  const dateRange = (dMin && dMax) ? `${dMin} – ${dMax}` : null
  const refreshing = fetchJob && fetchJob.status === 'running' && info.fromCache
  const clickable = !!onClick
  const loaded = Number(info.loaded_count ?? info.items_total ?? 0)
  const total = info.catalog_total == null ? null : Number(info.catalog_total)
  const complete = info.catalog_complete === true

  return (
    <div
      onClick={onClick || undefined}
      role={clickable ? 'button' : undefined}
      title={clickable ? 'Открыть канал в Library' : undefined}
      className={`px-6 py-5 border-b border-zinc-800 flex items-center gap-4 ${
        clickable ? 'cursor-pointer hover:bg-zinc-900/40 transition-colors' : ''
      }`}
    >
      {info.avatar_url
        ? <img src={info.avatar_url} alt="" className="w-12 h-12 rounded-full bg-zinc-800 shrink-0" />
        : <div className="w-12 h-12 rounded-full bg-zinc-800 shrink-0" />}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium text-zinc-100 truncate">{info.title || info.handle}</span>
          {info.subs_count != null && (
            <span className="text-zinc-500 shrink-0" style={{ fontSize: '14px' }}>
              · {fmtViews(info.subs_count)} подписчиков
            </span>
          )}
          {refreshing && (
            <span className="text-zinc-500 ml-2 animate-pulse" style={{ fontSize: '14px' }}>
              · обновляем…
            </span>
          )}
        </div>
        <div className="text-zinc-400 mt-1 flex items-center gap-3" style={{ fontSize: '14px' }}>
          {loaded > 0 && (
            <span>
              {complete
                ? <><span className="tabular-nums text-zinc-200">{loaded.toLocaleString()}</span> видео</>
                : <><span className="text-zinc-500">загружено</span> <span className="tabular-nums text-zinc-200">{loaded.toLocaleString()}</span>{total != null ? <> из {total.toLocaleString()}</> : null}</>}
            </span>
          )}
          {complete && (
            <><span className="text-zinc-700">·</span><span className="text-emerald-500/80">каталог полный</span></>
          )}
          {info.total_duration_sec ? (
            <>
              <span className="text-zinc-700">·</span>
              <span>{fmtDuration(info.total_duration_sec)}</span>
            </>
          ) : null}
          {dateRange && (
            <>
              <span className="text-zinc-700">·</span>
              <span>{dateRange}</span>
            </>
          )}
        </div>
      </div>
      {clickable && <span className="text-zinc-600 shrink-0">→</span>}
    </div>
  )
}
