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
import YouTubeScopeFields, { DEFAULT_YT_RANGE } from './YouTubeScopeFields'

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
  // Stages: 'idle' | 'kickoff' | 'fetching' | 'ready' | 'error'
  //   kickoff = no cache yet, showing scope-fields so the user picks
  //             limit + direction BEFORE the network call (paste-flow used
  //             to auto-fetch with limit=200, which silently downloaded a
  //             lot for big channels — now the user is in control).
  const [stage, setStage] = useState('idle')
  const [channelInfo, setChannelInfo] = useState(null)
  const [fetchJob, setFetchJob] = useState(null)
  const [err, setErr] = useState(null)
  // Scope-fields state — used by the kickoff stage; ignored once we have
  // a fetch job in flight (re-fetch from SourceDetail uses its own form).
  const [range, setRange] = useState(DEFAULT_YT_RANGE)
  const pickerRef = React.useRef(null)

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
        setChannelInfo({
          source_id:           cached.id,
          channel_id:          cached.external_id,
          handle:              cached.handle,
          title:               cached.display_name || cached.handle,
          avatar_url:          cached.avatar_url,
          subs_count:          (() => { try { return JSON.parse(cached.meta_json || '{}').subs_count || null } catch { return null } })(),
          items_total:         cached.items_count,
          total_duration_sec:  null,    // computed below from items
          date_min:            null,
          date_max:            null,
          fromCache:           true,
        })
        // Aggregate stats from items table (fast)
        if (window.api?.itemsList) {
          const items = await window.api.itemsList({
            source_id: cached.id, limit: 1000, offset: 0,
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
      } else {
        // No cache → wait for the user to confirm limit/direction.
        setStage('kickoff')
      }
    })()

    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url])

  async function kickOffFetch(silent = false) {
    if (!silent) setStage('fetching')
    setErr(null)
    try {
      const limit = Math.max(0, Number(range.limit) || 0)
      const reverse = range.direction === 'oldest'
      const id = await startYoutubeChannelFetch({ target: url, limit, reverse })
      if (id == null) { setErr('Электрон-IPC недоступен'); setStage('error'); return }
      const off = watchJob(id, snap => {
        setFetchJob(snap)
        if (snap.yt_channel) {
          setChannelInfo(prev => ({
            ...(prev || {}),
            source_id:          snap.source_id || prev?.source_id,
            channel_id:         snap.yt_channel.channel_id || prev?.channel_id,
            handle:             snap.yt_channel.handle     || prev?.handle,
            title:              snap.yt_channel.title      || prev?.title,
            avatar_url:         snap.yt_channel.avatar_url || prev?.avatar_url,
            subs_count:         snap.yt_channel.subs_count ?? prev?.subs_count,
            items_total:        snap.yt_channel.items_total ?? prev?.items_total,
            total_duration_sec: snap.yt_channel.total_duration_sec ?? prev?.total_duration_sec,
            date_min:           snap.yt_channel.date_min ?? prev?.date_min,
            date_max:           snap.yt_channel.date_max ?? prev?.date_max,
            fromCache:          false,
          }))
        }
        if (snap.status === 'done') {
          refreshSources()
          if (!silent) setStage('ready')
          off()
        }
        if (snap.status === 'error') {
          setErr(snap.error || 'channel fetch failed'); setStage('error'); off()
        }
      })
    } catch (e) {
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
      if (stage === 'idle' || stage === 'error' || stage === 'kickoff') return kickOffFetch(false)
      if (stage === 'ready' && pickerRef.current?.trigger) pickerRef.current.trigger()
    },
  }), [stage])

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 overflow-hidden">
      {stage === 'idle' && !channelInfo && <FetchingHeader fetchJob={null} onCancel={null} />}
      {stage === 'kickoff' && (
        <div className="p-6">
          <div className="mb-4 text-zinc-300">
            <span className="font-medium">YouTube · канал</span>
            <span className="text-zinc-700 mx-2">·</span>
            <span className="text-zinc-500 truncate">{url}</span>
          </div>
          <YouTubeScopeFields range={range} onRangeChange={setRange} />
          <div className="flex items-center justify-end border-t border-zinc-800 pt-3 mt-4">
            <button
              onClick={() => kickOffFetch(false)}
              className="px-5 py-2 rounded-md font-medium bg-zinc-100 text-zinc-900 hover:bg-white"
            >Спарсить</button>
          </div>
        </div>
      )}
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
            onClick={() => kickOffFetch(false)}
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
        Загружаем канал…
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
          {info.items_total != null && (
            <span><span className="tabular-nums text-zinc-200">{info.items_total.toLocaleString()}</span> видео</span>
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
