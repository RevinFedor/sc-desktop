import React, {
  useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, forwardRef,
} from 'react'
import {
  startTiktokBatchTranscribe, watchJob,
} from '../lib/jobs'
import { X } from 'lucide-react'
import Checkbox from './Checkbox'

// ─── helpers ──────────────────────────────────────────────────────────────

function extractTiktokVideoId(url) {
  if (!url) return null
  const m = url.match(/tiktok\.com\/@[\w.-]+\/video\/(\d+)/i)
  if (m) return m[1]
  if (/^\d{15,21}$/.test(url.trim())) return url.trim()
  return null
}

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

// TikTok timestamps are real (Unix epoch from server) — show full date.
function fmtDate(ts) {
  if (!ts) return null
  const d = new Date(ts * 1000)
  if (isNaN(d.getTime())) return null
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: '2-digit' })
            .replace(/\.$/, '').replace(' г', '')
}

function shortTitle(s, max = 28) {
  if (!s) return ''
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

function formatBytes(n) {
  if (n == null) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

const ENGINES = [
  { id: 'gemini',     label: 'Gemini 2.5 Flash' },
  { id: 'assemblyai', label: 'AssemblyAI' },
]

const TikTokBatchPicker = forwardRef(function TikTokBatchPicker({
  sourceId, handle, videos: providedVideos, initialSelected,
  onStarted, onClose,
}, ref) {
  const [videos, setVideos] = useState(providedVideos || [])
  const [loaded, setLoaded] = useState(!!providedVideos)
  const [selected, setSelected] = useState(() => new Set(initialSelected || []))
  const [chips, setChips] = useState([])
  const [chipInput, setChipInput] = useState('')
  const [chipError, setChipError] = useState(null)
  const [search, setSearch] = useState('')
  const [engine, setEngine] = useState('gemini')
  const [batchJob, setBatchJob] = useState(null)
  const [copyToast, setCopyToast] = useState(null)
  const lastClickedRef = useRef(null)

  useEffect(() => {
    if (providedVideos) { setVideos(providedVideos); setLoaded(true); return }
    if (!sourceId || !window.api) return
    let alive = true
    setLoaded(false)
    window.api.itemsList({
      source_id: sourceId, limit: 1000, offset: 0,
      order: 'published_at DESC', type: 'video',
    }).then(items => {
      if (!alive) return
      setVideos(items.map(it => ({
        video_id:        it.external_id,
        title:           it.title || '',
        duration_sec:    it.duration_seconds,
        view_count:      it.views,
        timestamp:       it.published_at,
        url:             it.url,
        transcript_path: it.transcript_path,
      })))
      setLoaded(true)
    })
    return () => { alive = false }
  }, [sourceId, providedVideos])

  const selectionIds = useMemo(() => {
    const set = new Set(selected)
    for (const c of chips) set.add(c.video_id)
    return Array.from(set)
  }, [selected, chips])

  const selectionCount = selectionIds.length

  const transcribedSet = useMemo(() => {
    const s = new Set()
    for (const v of videos) if (v.transcript_path) s.add(v.video_id)
    return s
  }, [videos])

  const alreadyTranscribedCount = useMemo(
    () => selectionIds.reduce((n, id) => n + (transcribedSet.has(id) ? 1 : 0), 0),
    [selectionIds, transcribedSet],
  )

  // Always-AI cost (no subs path on TikTok). Same per-hour rate as YouTube
  // Gemini ($0.0125/hr at 16kHz mono).
  const upperBoundCost = useMemo(() => {
    let secs = 0
    const byId = new Map(videos.map(v => [v.video_id, v]))
    for (const id of selectionIds) {
      if (transcribedSet.has(id)) continue
      const v = byId.get(id)
      if (v?.duration_sec) secs += v.duration_sec
    }
    return (secs / 3600.0) * 0.0125
  }, [selectionIds, videos, transcribedSet])

  function tryAddChip(text) {
    const trimmed = text.trim()
    if (!trimmed) return
    const vid = extractTiktokVideoId(trimmed)
    if (!vid) {
      setChipError(`Не похоже на TikTok-видео: ${shortTitle(trimmed, 40)}`)
      return
    }
    if (chips.some(c => c.video_id === vid) || selected.has(vid)) {
      setChipInput(''); setChipError(null); return
    }
    const inChannel = videos.find(v => v.video_id === vid)
    if (!inChannel) {
      setChipError('Это видео не из текущего канала')
      return
    }
    setChips(prev => [...prev, { video_id: vid, title: inChannel.title }])
    setChipInput(''); setChipError(null)
  }

  function onChipInputKey(e) {
    if (chipError) setChipError(null)
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Tab') {
      if (chipInput.trim()) {
        e.preventDefault()
        tryAddChip(chipInput)
      } else if (e.key === 'Enter' && selectionCount > 0) {
        e.preventDefault()
        runBatch()
      }
    } else if (e.key === 'Backspace' && !chipInput && chips.length) {
      setChips(prev => prev.slice(0, -1))
    }
  }

  function onChipInputPaste(e) {
    const txt = (e.clipboardData?.getData('text') || '')
    if (txt.includes(',') || txt.includes('\n') || txt.includes(' ')) {
      e.preventDefault()
      txt.split(/[\s,]+/).filter(Boolean).forEach(p => tryAddChip(p))
    }
  }

  function removeChip(vid) {
    setChips(prev => prev.filter(c => c.video_id !== vid))
  }

  const toggleVideo = useCallback((vid, e, listForRange) => {
    if (e?.shiftKey && lastClickedRef.current && listForRange) {
      const anchor = lastClickedRef.current
      const ids = listForRange.map(v => v.video_id)
      const ai = ids.indexOf(anchor.vid)
      const bi = ids.indexOf(vid)
      if (ai !== -1 && bi !== -1) {
        const [lo, hi] = ai <= bi ? [ai, bi] : [bi, ai]
        setSelected(prev => {
          const s = new Set(prev)
          for (let i = lo; i <= hi; i++) {
            if (anchor.value) s.add(ids[i]); else s.delete(ids[i])
          }
          return s
        })
        return
      }
    }
    setSelected(prev => {
      const s = new Set(prev)
      const willSelect = !s.has(vid)
      if (willSelect) s.add(vid); else s.delete(vid)
      lastClickedRef.current = { vid, value: willSelect }
      return s
    })
  }, [])

  function toggleAll(filteredList) {
    const ids = filteredList.map(v => v.video_id)
    const allSelected = ids.length > 0 && ids.every(id => selected.has(id))
    setSelected(prev => {
      const s = new Set(prev)
      if (allSelected) for (const id of ids) s.delete(id)
      else            for (const id of ids) s.add(id)
      return s
    })
  }

  const allTranscribed = selectionCount > 0
    && selectionIds.every(id => transcribedSet.has(id))

  async function runBatch() {
    if (selectionCount === 0 || !sourceId) return
    const id = await startTiktokBatchTranscribe({
      video_ids: selectionIds,
      source_id: sourceId,
      handle,
      engine,
    })
    if (id == null) return
    onStarted && onStarted(id)
    const off = watchJob(id, snap => {
      setBatchJob(snap)
      if (snap.status === 'done' || snap.status === 'error' || snap.status === 'cancelled') {
        off()
      }
    })
  }

  async function copySelected() {
    // Reuse YT-side assembler — it concatenates transcript files by source +
    // video_ids regardless of platform.
    if (selectionCount === 0 || !sourceId || !window.api?.ytAssembleBatch) return
    const r = await window.api.ytAssembleBatch({
      action:    'copy',
      source_id: sourceId,
      video_ids: selectionIds,
    })
    if (r.ok) setCopyToast(`Copied · ${r.count} видео · ${formatBytes(r.bytes)}`)
    else      setCopyToast(`Failed: ${r.error || 'unknown'}`)
    setTimeout(() => setCopyToast(null), 2500)
  }

  function primaryAction() {
    if (allTranscribed) return copySelected()
    return runBatch()
  }

  useImperativeHandle(ref, () => ({
    trigger() { if (selectionCount > 0) primaryAction() },
  }), [selectionCount, engine, sourceId, allTranscribed])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q ? videos.filter(v => (v.title || '').toLowerCase().includes(q)) : videos
  }, [videos, search])

  const chipsSet = useMemo(() => new Set(chips.map(c => c.video_id)), [chips])

  if (batchJob && batchJob.status === 'running') {
    return <BatchProgress job={batchJob} />
  }
  if (batchJob && (batchJob.status === 'done' || batchJob.status === 'error' || batchJob.status === 'cancelled')) {
    return <BatchProgress job={batchJob} />
  }

  const filteredAllSelected = filtered.length > 0 && filtered.every(v => selected.has(v.video_id))
  const filteredSomeSelected = filtered.length > 0 && filtered.some(v => selected.has(v.video_id))

  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-zinc-800 flex items-center gap-3">
        <label
          className="group flex items-center gap-2 cursor-pointer select-none"
          title="Выбрать все / снять"
          onClick={(e) => { e.preventDefault(); toggleAll(filtered) }}
        >
          <Checkbox
            checked={filteredAllSelected}
            indeterminate={!filteredAllSelected && filteredSomeSelected}
            onChange={() => toggleAll(filtered)}
            size="md"
          />
          <span className="text-zinc-300">Выбор видео</span>
        </label>
        <span className="text-zinc-700">·</span>
        <span className="text-zinc-500" style={{ fontSize: '14px' }}>
          shift-click — диапазон
        </span>
        <span className="ml-auto text-zinc-400 tabular-nums" style={{ fontSize: '14px' }}>
          выбрано: <span className="text-zinc-100">{selectionCount}</span>
          {alreadyTranscribedCount > 0 && (
            <> · готово: <span className="text-emerald-400">{alreadyTranscribedCount}</span></>
          )}
          {/* DB-запрос капится limit:1000 — честная пометка про обрезку. */}
          {videos.length >= 1000 && (
            <span className="text-amber-400/80 ml-2" title="Показаны первые 1000 видео из БД — хвост канала не загружен в picker">
              · показаны первые 1000
            </span>
          )}
        </span>
        {onClose && (
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-200 inline-flex items-center"
            title="Скрыть picker"
          ><X size={15} /></button>
        )}
      </div>

      {/* Chip input */}
      <div className="px-4 pt-3 pb-2">
        <div className="rounded-md bg-zinc-900 border border-zinc-800 px-2 py-2">
          <div className="flex items-center gap-2 flex-wrap">
            {chips.map(c => (
              <span
                key={c.video_id}
                className="inline-flex items-center gap-1.5 bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 max-w-[200px]"
                style={{ fontSize: '14px' }}
                title={c.title}
              >
                <span className="text-zinc-300 truncate">{shortTitle(c.title, 24)}</span>
                <button
                  onClick={() => removeChip(c.video_id)}
                  className="text-zinc-500 hover:text-zinc-200 leading-none inline-flex items-center"
                  tabIndex={-1}
                ><X size={13} /></button>
              </span>
            ))}
            <input
              value={chipInput}
              onChange={e => setChipInput(e.target.value)}
              onKeyDown={onChipInputKey}
              onPaste={onChipInputPaste}
              placeholder={chips.length ? 'ещё ссылка…' : 'paste video URL → Enter / пробел'}
              className="bg-transparent flex-1 min-w-[200px] focus:outline-none text-zinc-200"
              style={{ fontSize: '14px' }}
            />
          </div>
        </div>
        {chipError && (
          <div className="text-red-400 mt-1.5" style={{ fontSize: '14px' }}>{chipError}</div>
        )}
      </div>

      {/* Search */}
      <div className="px-4 pb-2">
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Поиск по заголовку…"
          className="w-full bg-zinc-900 border border-zinc-800 rounded-md px-3 py-1.5 placeholder-zinc-600 focus:outline-none focus:border-zinc-600"
          style={{ fontSize: '14px' }}
        />
      </div>

      {/* List */}
      <div className="border-y border-zinc-800 divide-y divide-zinc-900 max-h-[400px] overflow-auto">
        {!loaded && (
          <div className="px-4 py-6 text-center text-zinc-600 italic" style={{ fontSize: '14px' }}>
            Загружаем список…
          </div>
        )}
        {loaded && filtered.length === 0 && (
          <div className="px-4 py-6 text-center text-zinc-600 italic" style={{ fontSize: '14px' }}>
            {search ? 'Ничего не найдено' : 'Канал пуст — сделайте Sync new'}
          </div>
        )}
        {filtered.map(v => (
          <VideoRow
            key={v.video_id}
            video={v}
            inSel={selected.has(v.video_id) || chipsSet.has(v.video_id)}
            done={!!v.transcript_path}
            filtered={filtered}
            onToggle={toggleVideo}
          />
        ))}
      </div>

      {/* Controls */}
      <div className="px-4 py-3 border-t border-zinc-800 bg-zinc-950 flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-zinc-500" style={{ fontSize: '14px' }}>Движок</span>
          <select
            value={engine}
            onChange={e => setEngine(e.target.value)}
            className="bg-zinc-900 border border-zinc-700 rounded-md px-2 py-1 text-zinc-200 focus:outline-none focus:border-zinc-500"
            style={{ fontSize: '14px' }}
          >
            {ENGINES.map(en => <option key={en.id} value={en.id}>{en.label}</option>)}
          </select>
        </div>

        <div className="ml-auto flex items-center gap-3">
          {selectionCount > 0 && !allTranscribed && !copyToast && (
            <div className="text-zinc-400 tabular-nums" style={{ fontSize: '14px' }}>
              до <span className="text-zinc-100">${upperBoundCost.toFixed(4)}</span> через {ENGINES.find(e => e.id === engine)?.label}
            </div>
          )}
          <button
            onClick={primaryAction}
            disabled={selectionCount === 0}
            className="min-w-[210px] px-4 py-2 rounded-md font-medium bg-zinc-100 text-zinc-900 hover:bg-white disabled:bg-zinc-800 disabled:text-zinc-500 text-center transition-colors"
            title={allTranscribed
              ? 'Все выбранные уже транскрибированы — копируем в буфер'
              : 'Запустить транскрипцию выбранных'}
          >
            {copyToast
              ? copyToast
              : (allTranscribed
                ? `📋 Скопировать${selectionCount ? ` (${selectionCount})` : ''}`
                : `Транскрибировать${selectionCount ? ` (${selectionCount})` : ''}`)}
          </button>
        </div>
      </div>
    </div>
  )
})

const VideoRow = React.memo(function VideoRow({ video, inSel, done, filtered, onToggle }) {
  const handleClick = (e) => onToggle(video.video_id, e, filtered)
  return (
    <button
      onClick={handleClick}
      className={`group w-full px-4 py-2 flex items-center gap-3 text-left ${
        inSel ? 'bg-zinc-900' : 'hover:bg-zinc-900/60'
      }`}
    >
      <Checkbox checked={inSel} passive size="md" />
      <span className="text-zinc-500 shrink-0 tabular-nums whitespace-nowrap" style={{ fontSize: '14px' }}>
        {fmtDate(video.timestamp) || '—'}
      </span>
      <span className="text-zinc-200 truncate flex-1">{video.title}</span>
      {done && (
        <span className="text-emerald-400 shrink-0" style={{ fontSize: '14px' }} title="Транскрипт уже есть">✓</span>
      )}
      <span className="text-zinc-500 shrink-0 tabular-nums whitespace-nowrap" style={{ fontSize: '14px' }}>
        {fmtDuration(video.duration_sec)}
      </span>
      {video.view_count != null && (
        <span className="text-zinc-600 shrink-0 tabular-nums whitespace-nowrap" style={{ fontSize: '14px' }}>
          {fmtViews(video.view_count)}
        </span>
      )}
    </button>
  )
})

export default TikTokBatchPicker

function BatchProgress({ job }) {
  const b = job?.tk_batch || {}
  const total = job?.items_total || 0
  const done = (b.saved || 0) + (b.skipped || 0) + (b.errors || 0)
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950 px-5 py-4">
      <div className="flex items-center gap-3 mb-3">
        <span className={`inline-block w-2 h-2 rounded-full ${
          job.status === 'running' ? 'bg-emerald-500 animate-pulse'
          : job.status === 'done' ? 'bg-zinc-400'
          : 'bg-red-400'
        }`} />
        <span className="text-zinc-200 font-medium">
          {job.status === 'running' ? 'Транскрибация идёт…' : `Готово (${b.saved || 0}/${total})`}
        </span>
        {b.current && b.current.title && job.status === 'running' && (
          <span className="text-zinc-500 truncate" style={{ fontSize: '14px' }}>
            · {b.current.i}/{b.current.n} · {shortTitle(b.current.title, 36)}
          </span>
        )}
      </div>
      <div className="h-1.5 bg-zinc-900 rounded mb-2 overflow-hidden">
        <div
          className={`h-1.5 rounded transition-all ${
            job.status === 'error' ? 'bg-red-500' : 'bg-emerald-500'
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex items-center gap-4 text-zinc-400" style={{ fontSize: '14px' }}>
        {b.saved > 0   && <span>✓ сохранено <span className="text-zinc-200">{b.saved}</span></span>}
        {b.errors > 0  && <span>· ошибок <span className="text-red-400">{b.errors}</span></span>}
        {b.cost_usd > 0 && <span>· потрачено <span className="text-zinc-200">${b.cost_usd.toFixed(4)}</span></span>}
      </div>
    </div>
  )
}
