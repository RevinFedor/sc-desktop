import React, {
  useEffect, useImperativeHandle, useState, forwardRef,
} from 'react'
import {
  lookupTiktokChannel, startTiktokChannelFetch,
  watchJob, cancelJob,
} from '../lib/jobs'
import { pushScreen } from '../lib/store'
import { refreshSources } from '../lib/sources'
import TikTokBatchPicker from './TikTokBatchPicker'

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

// TikTok timestamps are real (yt-dlp returns Unix epoch from server). Show
// full date — `26 апр 26` style, compact and unambiguous.
function fmtDate(ts) {
  if (!ts) return null
  const d = new Date(ts * 1000)
  if (isNaN(d.getTime())) return null
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: '2-digit' })
            .replace(/\.$/, '').replace(' г', '')
}

function handleFromUrl(u) {
  if (!u) return null
  const m = u.match(/tiktok\.com\/@([\w.-]+)/i)
  return m ? '@' + m[1] : null
}

// ─── form ─────────────────────────────────────────────────────────────────

const TikTokChannelForm = forwardRef(function TikTokChannelForm({ url, onStarted }, ref) {
  const [stage, setStage] = useState('idle')
  const [channelInfo, setChannelInfo] = useState(null)
  const [fetchJob, setFetchJob] = useState(null)
  const [err, setErr] = useState(null)
  const pickerRef = React.useRef(null)

  useEffect(() => {
    if (!url) return
    let alive = true
    setStage('idle'); setErr(null); setChannelInfo(null); setFetchJob(null)

    ;(async () => {
      const cached = await lookupTiktokChannel({ handle: handleFromUrl(url) })
      if (!alive) return

      if (cached && cached.items_count) {
        setChannelInfo({
          source_id:           cached.id,
          channel_id:          cached.external_id,
          handle:              cached.handle,
          title:               cached.display_name || cached.handle,
          avatar_url:          cached.avatar_url,
          items_total:         cached.items_count,
          total_duration_sec:  null,
          date_min:            null,
          date_max:            null,
          fromCache:           true,
        })
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
        kickOffFetch(false)
      }
    })()

    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url])

  async function kickOffFetch(silent = false) {
    if (!silent) setStage('fetching')
    setErr(null)
    try {
      const id = await startTiktokChannelFetch({ target: url, limit: 200 })
      if (id == null) { setErr('Электрон-IPC недоступен'); setStage('error'); return }
      const off = watchJob(id, snap => {
        setFetchJob(snap)
        if (snap.tk_channel) {
          setChannelInfo(prev => ({
            ...(prev || {}),
            source_id:          snap.source_id || prev?.source_id,
            channel_id:         snap.tk_channel.channel_id || prev?.channel_id,
            handle:             snap.tk_channel.handle     || prev?.handle,
            title:              snap.tk_channel.title      || prev?.title,
            avatar_url:         snap.tk_channel.avatar_url || prev?.avatar_url,
            items_total:        snap.tk_channel.items_total ?? prev?.items_total,
            total_duration_sec: snap.tk_channel.total_duration_sec ?? prev?.total_duration_sec,
            date_min:           snap.tk_channel.date_min ?? prev?.date_min,
            date_max:           snap.tk_channel.date_max ?? prev?.date_max,
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

  useImperativeHandle(ref, () => ({
    trigger() {
      if (stage === 'idle' || stage === 'error') return kickOffFetch(false)
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
              <TikTokBatchPicker
                ref={pickerRef}
                sourceId={channelInfo.source_id}
                handle={channelInfo.handle}
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

export default TikTokChannelForm

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
