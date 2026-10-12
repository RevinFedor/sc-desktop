import React, {
  useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, forwardRef,
} from 'react'
import { Virtuoso } from 'react-virtuoso'
import {
  startYoutubeBatchTranscribe, watchJob,
} from '../lib/jobs'
import { Copy, MessageCircle, Check, X } from 'lucide-react'
import Checkbox from './Checkbox'
import DatePicker from './DatePicker'
import YouTubeCommentsForm from './YouTubeCommentsForm'

// Quick-presets for the date-range filter — most common YouTube search slices.
const DATE_FROM_PRESETS = [
  { label: '-7д',  daysAgo: 7   },
  { label: '-1мес', daysAgo: 30  },
  { label: '-1год', daysAgo: 365 },
]
const DATE_TO_PRESETS = [
  { label: 'сегодня', daysAgo: 0 },
]

// Labels for URL-locked sections — duplicate of the YouTubeSearchForm
// dictionary, kept inline so the picker doesn't need a cross-import.
const URL_UPLOAD_LABEL = {
  1: 'за последний час',
  2: 'за сегодня',
  3: 'за неделю',
  4: 'за месяц',
  5: 'за год',
}
const DURATION_LABEL_INLINE = { 1: 'до 4 мин', 3: '4–20 мин', 2: 'свыше 20 мин' }

function isoDaysAgo(days) {
  const d = new Date()
  d.setDate(d.getDate() - days)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const da = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${da}`
}

// ─── helpers ──────────────────────────────────────────────────────────────

function extractVideoId(url) {
  if (!url) return null
  const patterns = [
    /(?:[?&]v=|\/v\/|\/embed\/|\/shorts\/|\/live\/)([0-9A-Za-z_-]{11})/,
    /youtu\.be\/([0-9A-Za-z_-]{11})/,
  ]
  for (const p of patterns) {
    const m = url.match(p)
    if (m) return m[1]
  }
  // Bare 11-char id
  if (/^[0-9A-Za-z_-]{11}$/.test(url.trim())) return url.trim()
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

// YouTube tab pages give "approximate" timestamps — yt-dlp parses "N months
// ago" into today-minus-N*30. The resulting day-of-month is a side-effect
// of that arithmetic and lies (it'll often equal today's day for every
// video). Show month-precision only so users don't read fake exact dates.
function fmtDate(ts) {
  if (!ts) return null
  const d = new Date(ts * 1000)
  if (isNaN(d.getTime())) return null
  // 'мар 26' style — short month name + 2-digit year. Compact, fits the row.
  return d.toLocaleDateString('ru-RU', { month: 'short', year: '2-digit' })
                 .replace('.', '')   // "мар. 26" → "мар 26"
}

// Full DD MMM YYYY — used in search rows where the date is genuinely useful
// (sort by date, range filter etc.). Compact: "29 апр 2026".
function fmtDateFull(ts) {
  if (!ts) return null
  const d = new Date(ts * 1000)
  if (isNaN(d.getTime())) return null
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' })
                 .replace(/\sг\.?$/, '')   // strip trailing "г."
                 .replace('.', '')
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

// Token-count heuristic shared with CopySavedPanel: bytes/3 averages
// mixed RU/EN BPE. Always rendered as "~N" — never claim precision we
// don't have (no real tokenizer here).
function formatTokens(n) {
  if (!n || n < 1000) return String(n || 0)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

const ENGINES = [
  { id: 'assemblyai', label: 'AssemblyAI' },
  { id: 'gemini',     label: 'Gemini 2.5 Flash' },
]

/**
 * Standalone batch picker for a YouTube source. Used both in the inline
 * paste-screen flow (under the channel form) and as an inline action panel
 * inside SourceDetail.
 *
 * Props:
 *   sourceId       — required (the YouTube source row in DB)
 *   videos         — optional pre-loaded array of {video_id,title,duration_sec,
 *                    view_count,timestamp,url,transcript_path}.  If omitted,
 *                    the picker will load from items table itself.
 *   initialSelected — optional Set<video_id> to seed selection
 *   onStarted(id)   — fires after batch job is enqueued
 *   onClose         — optional, shows a "× закрыть" affordance
 */
const YouTubeBatchPicker = forwardRef(function YouTubeBatchPicker({
  sourceId, videos: providedVideos, initialSelected,
  onStarted, onClose,
  // Sourceless (search) mode props:
  searchQuery,           // string — will be persisted into job params
  onLoadMore,            // optional () => void — shows "+N" button below list
  loadMoreLabel,         // optional string for the +N button text
  loadingMore,           // optional bool — disables the +N button while fetching
  showSearchControls,    // optional bool — show sort + date-range filter controls
  totalLoaded,           // optional number — for the "0 из N" hint
  currentLimit,          // optional number — committed search limit
  onApplyLimit,          // optional (n) => void — change limit (re-fetch / trim)
  reachedCeiling,        // optional bool — yt-dlp returned fewer than asked
  urlFilterLocked,       // optional decoded sp= object — locks the controls
                         // YouTube already enforced via the URL (sort,
                         // upload-date, type, duration). Visual cue +
                         // disabled inputs so the user doesn't fight the
                         // URL filter with redundant client-side ones.
}, ref) {
  const [videos, setVideos] = useState(providedVideos || [])
  const [loaded, setLoaded] = useState(!!providedVideos)
  const [selected, setSelected] = useState(() => new Set(initialSelected || []))
  const [chips, setChips] = useState([])
  const [chipInput, setChipInput] = useState('')
  const [chipError, setChipError] = useState(null)
  const [search, setSearch] = useState('')
  // Free subtitles are the safe default. AI fallback can create real cost,
  // especially after "select all", so it requires an explicit opt-in.
  const [autoAi, setAutoAi] = useState(false)
  const [engine, setEngine] = useState('assemblyai')
  const [lang, setLang] = useState('ru')
  const [withTs, setWithTs] = useState(false)
  const [batchJob, setBatchJob] = useState(null)
  const [copyToast, setCopyToast] = useState(null)
  const lastClickedRef = useRef(null)        // for shift-click range select

  useEffect(() => {
    let alive = true
    window.api?.appSettingsGet?.().then(settings => {
      if (!alive) return
      const yt = settings?.youtube || {}
      if (typeof yt.preferred_lang === 'string' && yt.preferred_lang) setLang(yt.preferred_lang)
      if (yt.engine === 'gemini' || yt.engine === 'assemblyai') setEngine(yt.engine)
    }).catch(() => {})
    return () => { alive = false }
  }, [])

  // Load videos from DB if not provided (channel-source path).
  // Search mode skips this — providedVideos comes from the search form.
  useEffect(() => {
    if (providedVideos) { setVideos(providedVideos); setLoaded(true); return }
    if (!sourceId || !window.api) return
    let alive = true
    setLoaded(false)
    window.api.itemsList({
      source_id: sourceId, limit: 20000, offset: 0,
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

  // Sync incoming providedVideos when they grow (pagination in search mode).
  // Merge cache fields back in so the global-lookup effect doesn't have to
  // re-fire on every parent rerender (only on truly new ids).
  // Important: returning a brand-new array on every providedVideos change
  // would invalidate the lookup-effect's `[videos]` dep mid-flight (cleanup
  // resets alive=false before the IPC promise resolves, the merge gets
  // dropped). Only setVideos when there's actually something new.
  useEffect(() => {
    if (!providedVideos) return
    setVideos(prev => {
      // Build cache snapshot from current state (preserves enrichments).
      const cacheById = new Map()
      for (const v of prev) {
        if (v.cache_origin || v.transcript_path) {
          cacheById.set(v.video_id, {
            transcript_path:     v.transcript_path,
            cache_origin:        v.cache_origin,
            cache_source_handle: v.cache_source_handle,
          })
        }
      }
      // No-op detection: ids identical AND cache hasn't been merged into prev yet.
      const sameLength = prev.length === providedVideos.length
      const sameIds = sameLength && prev.every((v, i) => v.video_id === providedVideos[i].video_id)
      if (sameIds && cacheById.size === 0) return prev   // nothing changed — keep ref
      return providedVideos.map(v => {
        const c = cacheById.get(v.video_id)
        return c ? { ...v, ...c } : v
      })
    })
  }, [providedVideos])

  // Cross-source transcript hits for search mode. yt-dlp gives us video_ids
  // but not whether they're already in our DB. We bulk-lookup against items
  // (any channel) + sourceless yt_transcribe jobs and merge transcript_path
  // into local videos[]. Without this the user re-transcribes (and pays for)
  // a video that already lives under a previously-fetched channel.
  // See `fact-youtube.md::Cache lookup`.
  // Track which ids we've already asked about so re-render doesn't refire.
  // We DON'T use an `alive` flag inside the effect — StrictMode double-mount
  // would reset alive=false on the first invocation's cleanup, and the
  // dedup-Set blocks the second invocation from re-firing IPC. Result: the
  // promise resolves with alive=false → setVideos never runs → no merge.
  // Fix: drop the alive guard entirely. setVideos on an unmounted component
  // is a benign warning, not a bug, and React 18 only logs it in dev. In
  // exchange we get a reliable single-fire merge.
  const lookedUpIdsRef = useRef(new Set())
  const providedIds = providedVideos ? providedVideos.map(v => v.video_id).join(',') : ''
  useEffect(() => {
    if (sourceId || !showSearchControls) return       // channel-mode already has it
    if (!window.api?.ytItemsStateGlobal) return
    if (!providedVideos || !providedVideos.length) return
    const ids = providedVideos
      .filter(v => !v.transcript_path && !lookedUpIdsRef.current.has(v.video_id))
      .map(v => v.video_id)
    if (ids.length === 0) return
    for (const id of ids) lookedUpIdsRef.current.add(id)
    window.api.ytItemsStateGlobal({ video_ids: ids }).then(rows => {
      if (!Array.isArray(rows) || rows.length === 0) return
      const byId = new Map(rows.map(r => [r.external_id, r]))
      setVideos(prev => prev.map(v => {
        const hit = byId.get(v.video_id)
        if (!hit) return v
        return { ...v, transcript_path: hit.transcript_path,
                       cache_origin:    hit.origin,
                       cache_source_handle: hit.source_handle || null }
      }))
    }).catch(() => {})
  }, [sourceId, showSearchControls, providedIds])

  // Per-video comments-state. Independent of transcript lookup since the
  // two products can be cached separately. We re-query on `videos.length`
  // change so paginated loads / channel sync grab the fresh batch too.
  // commentsState: Map<video_id, {file_path, finished_at, count_total, ...}>
  const [commentsState, setCommentsState] = useState(() => new Map())
  const commentsLookedUpRef = useRef(new Set())
  useEffect(() => {
    if (!window.api?.ytItemsCommentsState) return
    if (!videos.length) return
    const ids = videos
      .filter(v => !commentsLookedUpRef.current.has(v.video_id))
      .map(v => v.video_id)
    if (ids.length === 0) return
    for (const id of ids) commentsLookedUpRef.current.add(id)
    window.api.ytItemsCommentsState({ video_ids: ids }).then(rows => {
      if (!Array.isArray(rows) || rows.length === 0) return
      setCommentsState(prev => {
        const next = new Map(prev)
        for (const r of rows) next.set(r.external_id, r)
        return next
      })
    }).catch(() => {})
  }, [videos.length])

  // Live cache invalidation: when a yt_comments job completes, update the
  // marker for that video without re-querying. The job's params carry
  // video_id, file_path, count_total etc.
  useEffect(() => {
    if (!window.api?.onJobUpdate) return
    const off = window.api.onJobUpdate(j => {
      if (!j || j.type !== 'yt_comments') return
      const vid = j.yt_comments?.video_id || j.params?.video_id
      if (!vid) return
      if (j.status === 'done' && j.file_path) {
        setCommentsState(prev => {
          const next = new Map(prev)
          next.set(vid, {
            external_id:     vid,
            file_path:       j.file_path,
            finished_at:     j.finished_at,
            sort:            j.params?.sort || j.yt_comments?.sort || null,
            limit:           j.params?.limit ?? j.yt_comments?.limit ?? null,
            include_replies: !!(j.params?.include_replies ?? j.params?.includeReplies ?? j.yt_comments?.include_replies),
            count_total:     j.yt_comments?.count_total ?? j.params?.count_total ?? null,
          })
          return next
        })
      }
    })
    return () => { off && off() }
  }, [])

  // Which video has its inline comments-form expanded under it. Only one at
  // a time — clicking the same row toggles it; clicking another collapses
  // the previous and opens the new one.
  const [expandedCommentsId, setExpandedCommentsId] = useState(null)
  const toggleComments = useCallback((vid) => {
    setExpandedCommentsId(prev => prev === vid ? null : vid)
  }, [])

  // Pick up an already-running batch for this source (e.g. user kicked it
  // off in PasteScreen, then navigated to SourceDetail — this fresh picker
  // instance still needs to render BatchProgress instead of the kickoff UI).
  // Watches jobsList on mount + onJobUpdate stream for live transitions.
  // Skipped for sourceless (search) mode — search batches are watched by
  // job id directly inside YouTubeSearchForm.
  useEffect(() => {
    if (!sourceId || !window.api) return
    let alive = true
    const matches = (j) =>
      j && j.type === 'yt_batch_transcribe' && j.source_id === sourceId
        && (j.status === 'running' || j.status === 'awaiting_ai')

    window.api.jobsList().then(list => {
      if (!alive) return
      const live = (list || []).find(matches)
      if (live) setBatchJob(live)
    }).catch(() => {})

    const off = window.api.onJobUpdate(j => {
      if (!alive) return
      if (!j || j.type !== 'yt_batch_transcribe' || j.source_id !== sourceId) return
      setBatchJob(prev => {
        // If the just-arrived snapshot is a terminal state for *our* current
        // tracked job → keep it visible on the same instance, but otherwise
        // drop unrelated terminal updates (jobs that finished before this
        // picker mounted shouldn't take over the kickoff UI).
        if (prev?.id === j.id) return j
        if (j.status === 'running' || j.status === 'awaiting_ai') return j
        return prev
      })
      // After each batch save the items table flips transcript_path on the
      // saved video → reload so the ✓ marker appears.
      if (j.yt_batch && (j.status === 'running' || j.status === 'done')) {
        if (!providedVideos && window.api?.itemsList) {
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
          }).catch(() => {})
        }
      }
    })
    return () => { alive = false; off && off() }
  }, [sourceId, providedVideos])

  const selectionIds = useMemo(() => {
    const set = new Set(selected)
    for (const c of chips) set.add(c.video_id)
    return Array.from(set)
  }, [selected, chips])

  const selectionCount = selectionIds.length

  // Quick lookup: video_id -> bool (has saved transcript on disk).
  // Derived from `videos` itself — no extra IPC, no async refresh on every
  // checkbox toggle. Memoised so VideoRow can stay React.memo-safe.
  const transcribedSet = useMemo(() => {
    const s = new Set()
    for (const v of videos) if (v.transcript_path) s.add(v.video_id)
    return s
  }, [videos])

  const alreadyTranscribedCount = useMemo(
    () => selectionIds.reduce((n, id) => n + (transcribedSet.has(id) ? 1 : 0), 0),
    [selectionIds, transcribedSet],
  )

  const upperBoundCost = useMemo(() => {
    if (!autoAi) return 0
    let secs = 0
    const byId = new Map(videos.map(v => [v.video_id, v]))
    for (const id of selectionIds) {
      if (transcribedSet.has(id)) continue
      const v = byId.get(id)
      if (v?.duration_sec) secs += v.duration_sec
    }
    return (secs / 3600.0) * 0.0125
  }, [autoAi, selectionIds, videos, transcribedSet])

  // True when every selected video already has a saved transcript on disk.
  // In that case the primary action becomes "Copy" instead of "Transcribe",
  // and the price-hint flips into a token/size estimate.
  const allTranscribed = selectionCount > 0
    && selectionIds.every(id => transcribedSet.has(id))

  // ─── Token / size estimate when allTranscribed ────────────────────────
  // Mirrors CopySavedPanel: hits IPC with action='estimate', sums file
  // sizes server-side (no body read), shows "~Nk токенов · KB" left of
  // the Copy button so the user knows the size before clicking.
  // Search mode (no sourceId): skip — estimate path needs a saved batch job
  // to look up files; for live ad-hoc selection just don't show the hint.
  const [copyEstimate, setCopyEstimate] = useState(null)
  useEffect(() => {
    if (!allTranscribed || !sourceId || !window.api?.ytAssembleBatch) {
      setCopyEstimate(null); return
    }
    let alive = true
    const t = setTimeout(async () => {
      try {
        const r = await window.api.ytAssembleBatch({
          action:    'estimate',
          source_id: sourceId,
          video_ids: selectionIds,
        })
        if (alive && r?.ok) setCopyEstimate({ bytes: r.bytes, tokens: r.tokens, count: r.count })
      } catch {}
    }, 150)
    return () => { alive = false; clearTimeout(t) }
  }, [allTranscribed, sourceId, selectionIds.join(',')])

  // Chip input
  function tryAddChip(text) {
    const trimmed = text.trim()
    if (!trimmed) return
    const vid = extractVideoId(trimmed)
    if (!vid) {
      setChipError(`Не похоже на видео-URL: ${shortTitle(trimmed, 40)}`)
      return
    }
    if (chips.some(c => c.video_id === vid) || selected.has(vid)) {
      setChipInput(''); setChipError(null); return
    }
    const inList = videos.find(v => v.video_id === vid)
    if (!inList && sourceId) {
      // Channel mode: chip must be one of the channel's videos.
      setChipError('Это видео не из текущего канала')
      return
    }
    // Search mode (no sourceId): allow any video URL — just chip it.
    setChips(prev => [...prev, { video_id: vid, title: inList?.title || vid }])
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
    // Shift+click extends from the last single-click anchor to vid in the
    // currently-rendered (filtered) list — anything in between gets the
    // anchor's selection state copied.
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

  async function runBatch() {
    if (selectionCount === 0) return
    const isSearch = !sourceId && !!searchQuery
    // For search-batch, snapshot the *full* video metadata of selected items
    // so JobDetail can render the finalized list later (no items table).
    const searchVideos = isSearch
      ? videos.filter(v => selectionIds.includes(v.video_id))
      : null
    const id = await startYoutubeBatchTranscribe({
      video_ids: selectionIds,
      source_id: sourceId || null,
      lang, with_ts: withTs,
      auto_ai: autoAi, engine,
      ...(isSearch ? {
        is_search:     true,
        search_query:  searchQuery,
        search_videos: searchVideos,
      } : {}),
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
    if (selectionCount === 0 || !window.api?.ytAssembleBatch) return
    // In sourceless mode the picker can't assemble — assembly needs files
    // on disk, which only exist after a batch run. The "Copy" affordance
    // appears only when allTranscribed=true; that flag is false in search
    // mode (no transcript_path on incoming videos), so this path is unreachable
    // there. Channel mode keeps the original logic.
    if (!sourceId) return
    const r = await window.api.ytAssembleBatch({
      action:    'copy',
      source_id: sourceId,
      video_ids: selectionIds,
    })
    if (r.ok) {
      // Use the same compact "✓ Скопировано · ~Nk токенов · KB" label as
      // every other Copy site — server returns real bytes/tokens here.
      const tokenStr = r.tokens ? ` · ~${formatTokens(r.tokens)} токенов` : ''
      setCopyToast(`✓ Скопировано · ${r.count} видео${tokenStr} · ${formatBytes(r.bytes)}`)
    } else {
      setCopyToast(`Ошибка: ${r.error || 'неизвестно'}`)
    }
    setTimeout(() => setCopyToast(null), 2500)
  }

  function primaryAction() {
    if (allTranscribed) return copySelected()
    return runBatch()
  }

  async function kickBatchComments() {
    if (selectionCount === 0 || !window.api?.ytBatchComments) return
    // Defaults: new sort, 500 limit, no replies — same as the single-video
    // form. Users can fine-tune per-video via the inline 💬 marker if they
    // need different params for specific videos.
    const id = await window.api.ytBatchComments({
      source_id:        sourceId || null,
      video_ids:        selectionIds,
      sort:             'new',
      limit:            500,
      includeReplies:   false,
    })
    if (id == null) return
    onStarted && onStarted(id)
  }

  useImperativeHandle(ref, () => ({
    trigger() { if (selectionCount > 0) primaryAction() },
  }), [selectionCount, lang, withTs, autoAi, engine, sourceId, allTranscribed])

  // Sort + date-range filter for search mode (channel mode renders these
  // off — videos there are pre-sorted by published_at DESC and dates are
  // less interesting since the user is already inside a known channel).
  // Defaults: from = year ago, to = today. Pre-applied so the search list
  // is bounded out of the box; user can clear via the × control.
  const [sortBy, setSortBy] = useState('relevance')   // 'relevance' | 'date' | 'views'
  const [dateFrom, setDateFrom] = useState(() => isoDaysAgo(365))
  const [dateTo,   setDateTo]   = useState(() => isoDaysAgo(0))
  const [minViewsK, setMinViewsK] = useState('1')     // thousands; '' = no filter, '1' = 1000+
  // Default 60min cap — typical use case is "найди подкасты по теме".
  // Empty string means "no upper bound". Stored as string for the input
  // (commit only on blur via the same draft-input pattern).
  const [maxDurationMin, setMaxDurationMin] = useState('60')

  // Which client-side controls are overridden by an URL filter the user
  // pasted in. Each section is rendered as disabled+annotated when locked,
  // so the user understands why they can't change it (and why client-side
  // tweaks wouldn't survive the next yt-dlp call anyway).
  const lockSort     = !!urlFilterLocked?.sort && urlFilterLocked.sort !== 'relevance'
  const lockUpload   = !!urlFilterLocked?.uploadDate
  const lockDuration = !!urlFilterLocked?.duration

  // Sync local state to the URL filter on first arrival of urlFilterLocked,
  // so the chip + sort row reflect what's actually in flight (instead of
  // showing "релевантность" while YouTube is sorting by date underneath).
  useEffect(() => {
    if (urlFilterLocked?.sort && urlFilterLocked.sort !== 'relevance') {
      setSortBy(urlFilterLocked.sort)
    }
  }, [urlFilterLocked?.sort])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    let arr = q ? videos.filter(v => (v.title || '').toLowerCase().includes(q)) : videos

    if (showSearchControls && (dateFrom || dateTo)) {
      let fromTs = dateFrom ? Math.floor(new Date(dateFrom + 'T00:00:00Z').getTime() / 1000) : null
      let toTs   = dateTo   ? Math.floor(new Date(dateTo   + 'T23:59:59Z').getTime() / 1000) : null
      // Allow any direction: if the user enters from > to, swap them so the
      // filter still works as "between these two dates" instead of returning
      // an empty list.
      if (fromTs != null && toTs != null && fromTs > toTs) {
        [fromTs, toTs] = [toTs, fromTs]
      }
      arr = arr.filter(v => {
        if (!v.timestamp) return false
        if (fromTs != null && v.timestamp < fromTs) return false
        if (toTs   != null && v.timestamp > toTs)   return false
        return true
      })
    }

    if (showSearchControls && minViewsK) {
      const minViews = (Number(minViewsK) || 0) * 1000
      if (minViews > 0) {
        arr = arr.filter(v => (v.view_count || 0) >= minViews)
      }
    }

    if (showSearchControls && maxDurationMin) {
      const maxSec = (Number(maxDurationMin) || 0) * 60
      if (maxSec > 0) {
        arr = arr.filter(v => !v.duration_sec || v.duration_sec <= maxSec)
      }
    }

    if (showSearchControls && sortBy !== 'relevance') {
      arr = [...arr]
      if (sortBy === 'date') {
        arr.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      } else if (sortBy === 'views') {
        arr.sort((a, b) => (b.view_count || 0) - (a.view_count || 0))
      }
    }
    return arr
  }, [videos, search, showSearchControls, sortBy, dateFrom, dateTo, minViewsK, maxDurationMin])

  // O(1) lookups for the row renderer — without these each row would scan
  // the chips array (O(n²) total) and trigger a full list re-paint on each
  // checkbox toggle.
  const chipsSet = useMemo(() => new Set(chips.map(c => c.video_id)), [chips])
  const youtubeListComponents = useMemo(() => ({
    Footer: () => (
      <>
        {onLoadMore && (
          <button
            onClick={onLoadMore}
            disabled={loadingMore}
            className="w-full px-4 py-3 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900/60 disabled:text-zinc-600 disabled:hover:bg-transparent flex items-center justify-center gap-2 border-t border-zinc-900"
            style={{ fontSize: '14px' }}
          >
            {loadingMore ? (
              <><span className="inline-block w-3 h-3 rounded-full border-2 border-zinc-600 border-t-zinc-300 animate-spin" /><span>Загружаю…</span></>
            ) : <span>{loadMoreLabel || '+ Показать ещё'}</span>}
          </button>
        )}
        {reachedCeiling && !onLoadMore && videos.length > 0 && (
          <div className="w-full px-4 py-3 text-zinc-500 text-center border-t border-zinc-900" style={{ fontSize: '13px' }}>
            YouTube отдал всё что есть для этого запроса — <span className="text-zinc-300">{videos.length} видео</span>.
            Чтобы получить больше — расширьте диапазон в самом YouTube или попробуйте убрать фильтры URL ↑
          </div>
        )}
      </>
    ),
  }), [onLoadMore, loadingMore, loadMoreLabel, reachedCeiling, videos.length])

  // While a batch job is running, switch the panel to a progress view.
  if (batchJob && batchJob.status === 'running') {
    return <BatchProgress job={batchJob} />
  }
  if (batchJob && (batchJob.status === 'done' || batchJob.status === 'error' || batchJob.status === 'cancelled')) {
    return <BatchProgress job={batchJob} />
  }

  // "Select all" state for the *currently filtered* list — partial / full / none.
  const filteredAllSelected = filtered.length > 0 && filtered.every(v => selected.has(v.video_id))
  const filteredSomeSelected = filtered.length > 0 && filtered.some(v => selected.has(v.video_id))

  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950">
      {/* Channel mode keeps the top "Выбор видео" bar; search mode moves
          it into the list header below — there's no chip-input row above. */}
      {!showSearchControls && (
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
          {/* Safety ceiling for pathological channels — if reached, report
              что «Выбрать все» выбирает не весь канал. */}
          {!providedVideos && videos.length >= 20000 && (
            <span className="text-amber-400/80 ml-2" title="Показаны первые 20 000 видео из БД — хвост канала не загружен в список">
              · показаны первые 20 000
            </span>
          )}
        </span>
        {onClose && (
          <button
            onClick={onClose}
            className="inline-flex items-center justify-center text-zinc-500 hover:text-zinc-200"
            style={{ fontSize: '14px' }}
            title="Скрыть picker"
          ><X size={14} /></button>
        )}
      </div>
      )}

      {/* Chip input — channel mode only (search mode lets the user pick
          straight from the result list, external URLs aren't relevant). */}
      {!showSearchControls && (
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
                    className="inline-flex items-center justify-center text-zinc-500 hover:text-zinc-200 leading-none"
                    tabIndex={-1}
                  ><X size={14} /></button>
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
      )}

      {/* Channel mode: full-width search input on its own row. */}
      {!showSearchControls && (
        <div className="px-4 pt-3 pb-2">
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Поиск по заголовку…"
            className="w-full bg-zinc-900 border border-zinc-800 rounded-md px-3 py-1.5 placeholder-zinc-600 focus:outline-none focus:border-zinc-600"
            style={{ fontSize: '14px' }}
          />
        </div>
      )}

      {/* Search mode: dates on the left, title-search on the right.
          Sort chips on their own row above. */}
      {showSearchControls && (
        <>
          <div className="px-4 pt-3 pb-2 flex items-center gap-2 flex-wrap">
            <span className="text-zinc-500" style={{ fontSize: '14px' }}>Сортировка</span>
            <SortChip active={sortBy === 'relevance'} disabled={lockSort} onClick={() => !lockSort && setSortBy('relevance')}>релевантность</SortChip>
            <SortChip active={sortBy === 'date'}      disabled={lockSort} onClick={() => !lockSort && setSortBy('date')}>дата ↓</SortChip>
            <SortChip active={sortBy === 'views'}     disabled={lockSort} onClick={() => !lockSort && setSortBy('views')}>просмотры ↓</SortChip>
            {lockSort && (
              <span className="text-amber-400/80" style={{ fontSize: '12px' }} title="Сортировка задана в URL — нажми «убрать» в шапке чтобы переключить">
                · из URL
              </span>
            )}
            <span className="text-zinc-700 mx-1">·</span>
            <span className="text-zinc-500" style={{ fontSize: '14px' }}>Мин. просм.</span>
            <div className="relative">
              <input
                type="text"
                inputMode="numeric"
                value={minViewsK}
                onChange={e => {
                  // Keep digits only — input is in thousands.
                  const v = e.target.value.replace(/[^\d]/g, '').slice(0, 6)
                  setMinViewsK(v)
                }}
                placeholder="0"
                className="bg-zinc-900 border border-zinc-800 rounded text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 tabular-nums"
                style={{ fontSize: '13px', width: 64, paddingLeft: 6, paddingRight: 18, paddingTop: 2, paddingBottom: 2 }}
              />
              <span
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none"
                style={{ fontSize: '11px' }}
              >K</span>
            </div>
            {minViewsK && (
              <button
                onClick={() => setMinViewsK('')}
                className="inline-flex items-center justify-center text-zinc-500 hover:text-zinc-200"
                style={{ fontSize: '14px' }}
                title="Сбросить минимум просмотров"
              ><X size={14} /></button>
            )}
            <span className="text-zinc-700 mx-1">·</span>
            <span className="text-zinc-500" style={{ fontSize: '14px' }} title={lockDuration ? 'Длительность задана в URL — нажми «убрать» в шапке чтобы переключить' : null}>
              Макс. длит.
            </span>
            <div className="relative">
              <input
                type="text"
                inputMode="numeric"
                value={maxDurationMin}
                disabled={lockDuration}
                onChange={e => {
                  const v = e.target.value.replace(/[^\d]/g, '').slice(0, 4)
                  setMaxDurationMin(v)
                }}
                placeholder="∞"
                className="bg-zinc-900 border border-zinc-800 rounded text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 tabular-nums disabled:text-zinc-600 disabled:cursor-not-allowed"
                style={{ fontSize: '13px', width: 60, paddingLeft: 6, paddingRight: 22, paddingTop: 2, paddingBottom: 2 }}
              />
              <span
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none"
                style={{ fontSize: '11px' }}
              >мин</span>
            </div>
            {maxDurationMin && !lockDuration && (
              <button
                onClick={() => setMaxDurationMin('')}
                className="inline-flex items-center justify-center text-zinc-500 hover:text-zinc-200"
                style={{ fontSize: '14px' }}
                title="Без ограничения длины"
              ><X size={14} /></button>
            )}
            {lockDuration && (
              <span className="text-amber-400/80" style={{ fontSize: '12px' }}>
                · {DURATION_LABEL_INLINE[urlFilterLocked.duration] || 'из URL'}
              </span>
            )}
          </div>
          <div className="px-4 pb-2 flex items-center gap-3">
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <span
                className="text-zinc-500 shrink-0"
                style={{ fontSize: '14px' }}
                title={lockUpload
                  ? 'Период задан в URL — нажми «убрать» в шапке чтобы выбрать произвольный диапазон'
                  : 'Фильтрует уже загруженные видео (без повторного запроса в YouTube). Чтобы расширить выдачу — увеличь «запросить» справа.'}
              >
                Даты
              </span>
              <div className={lockUpload ? 'flex items-center gap-2 opacity-50 pointer-events-none' : 'flex items-center gap-2'}>
                <DatePicker
                  value={dateFrom}
                  onChange={setDateFrom}
                  placeholder="с даты"
                  ariaLabel="Начало диапазона"
                  presets={DATE_FROM_PRESETS}
                  direction="up"
                />
                <span className="text-zinc-600">—</span>
                <DatePicker
                  value={dateTo}
                  onChange={setDateTo}
                  placeholder="по дату"
                  ariaLabel="Конец диапазона"
                  presets={DATE_TO_PRESETS}
                  direction="up"
                />
                {(dateFrom || dateTo) && !lockUpload && (
                  <button
                    onClick={() => { setDateFrom(''); setDateTo('') }}
                    className="inline-flex items-center justify-center text-zinc-500 hover:text-zinc-200 shrink-0"
                    style={{ fontSize: '14px' }}
                    title="Сбросить даты"
                  ><X size={14} /></button>
                )}
              </div>
              {lockUpload && (
                <span
                  className="text-amber-400/80 shrink-0"
                  style={{ fontSize: '12px' }}
                  title="Период задан в URL"
                >
                  · {URL_UPLOAD_LABEL[urlFilterLocked.uploadDate] || 'из URL'}
                </span>
              )}
            </div>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Поиск по заголовку…"
              className="bg-zinc-900 border border-zinc-800 rounded px-2 py-0.5 text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 shrink-0"
              style={{ fontSize: '13px', width: 180 }}
            />
          </div>
        </>
      )}

      {/* Select-all bar (search mode) — sits flush with the list so the
          user sees the action right where the rows live.
          Counter semantics:
            - "выбрано: X из Y"  — Y is filtered.length, the rows actually
              visible after sort+date+views+title filter. This is what the
              user sees and can act on; using `currentLimit` here was
              misleading because filters could hide most of those rows.
            - "загружено: M  · запросить: [N]"  — M = videos.length (what
              yt-dlp returned), N = currentLimit (what we ask next time).
              When yt-dlp hits its ceiling we mark M with a "·" cap so
              the user knows "+N" won't add more. */}
      {showSearchControls && (
        <div className="px-4 py-2 border-y border-zinc-800 bg-zinc-950 flex items-center gap-3 flex-wrap">
          <label
            className="flex items-center gap-2 cursor-pointer select-none"
            title="Выбрать все / снять"
            onClick={(e) => { e.preventDefault(); toggleAll(filtered) }}
          >
            <Checkbox
              checked={filteredAllSelected}
              indeterminate={!filteredAllSelected && filteredSomeSelected}
              onChange={() => toggleAll(filtered)}
              size="md"
            />
            <span className="text-zinc-300">Выбрать все</span>
          </label>
          <span className="text-zinc-700">·</span>
          <span className="text-zinc-500" style={{ fontSize: '14px' }}>
            shift-click — диапазон
          </span>
          <span className="ml-auto text-zinc-400 tabular-nums flex items-center gap-2" style={{ fontSize: '14px' }}>
            <span>
              выбрано: <span className="text-zinc-100">{selectionCount}</span> из{' '}
              <span className="text-zinc-100">{filtered.length}</span>
            </span>
            {/* Loaded vs filtered hint — only when filters actually hide rows. */}
            {filtered.length !== videos.length && (
              <span className="text-zinc-600" title="Скрыто фильтрами">
                · загружено {videos.length}
              </span>
            )}
            <span className="text-zinc-700">·</span>
            <span className="text-zinc-500">запросить:</span>
            <LimitInput
              value={currentLimit ?? videos.length}
              loading={loadingMore}
              onApply={onApplyLimit}
              ceiling={reachedCeiling ? videos.length : null}
            />
            {reachedCeiling && (
              <span
                className="text-amber-400/80"
                title="YouTube не отдаёт больше результатов для этого запроса. Попробуйте убрать фильтры URL или расширить диапазон в самом YouTube."
                style={{ fontSize: '13px' }}
              >
                · потолок
              </span>
            )}
          </span>
        </div>
      )}

      {/* List */}
      <div data-youtube-video-list className={`${showSearchControls ? '' : 'border-y border-zinc-800'} overflow-hidden`}>
        {!loaded && (
          <div className="px-4 py-6 text-center text-zinc-600 italic" style={{ fontSize: '14px' }}>
            Загружаем список…
          </div>
        )}
        {loaded && filtered.length === 0 && (
          <div className="px-4 py-6 text-center text-zinc-600 italic" style={{ fontSize: '14px' }}>
            {search ? 'Ничего не найдено' : (showSearchControls ? 'Ничего не найдено в выбранном диапазоне' : 'Канал пуст — сделайте Sync new')}
          </div>
        )}
        {loaded && filtered.length > 0 && (
          <Virtuoso
            style={{ height: Math.min(400, Math.max(64, filtered.length * 54 + (onLoadMore || reachedCeiling ? 48 : 0))) }}
            data={filtered}
            defaultItemHeight={54}
            increaseViewportBy={160}
            computeItemKey={(_index, video) => video.video_id}
            components={youtubeListComponents}
            itemContent={(_index, video) => {
              const commentsHit = commentsState.get(video.video_id) || null
              const expanded = expandedCommentsId === video.video_id
              return (
                <div data-youtube-video-row className="border-b border-zinc-900 last:border-b-0">
                  <VideoRow
                    video={video}
                    inSel={selected.has(video.video_id) || chipsSet.has(video.video_id)}
                    done={!!video.transcript_path}
                    filtered={filtered}
                    onToggle={toggleVideo}
                    fullDate={!!showSearchControls}
                    commentsHit={commentsHit}
                    commentsExpanded={expanded}
                    onToggleComments={toggleComments}
                  />
                  {expanded && (
                    <div className="px-4 pb-3 -mt-1 bg-zinc-950/60">
                      <YouTubeCommentsForm compact url={video.url || `https://www.youtube.com/watch?v=${video.video_id}`} />
                    </div>
                  )}
                </div>
              )
            }}
          />
        )}
      </div>

      {/* Controls */}
      <div className="px-4 py-3 border-t border-zinc-800 bg-zinc-950 flex items-center gap-4 flex-wrap">
        <ToggleSwitch
          checked={autoAi}
          onChange={setAutoAi}
          label="AI-расшифровка, если субтитров нет"
        />
        {autoAi && (
          <select
            value={engine}
            onChange={e => setEngine(e.target.value)}
            className="bg-zinc-900 border border-zinc-700 rounded-md px-2 py-1 text-zinc-200 focus:outline-none focus:border-zinc-500"
            style={{ fontSize: '14px' }}
          >
            {ENGINES.map(en => <option key={en.id} value={en.id}>{en.label}</option>)}
          </select>
        )}
        <div className="flex items-center gap-2 ml-2">
          <span className="text-zinc-500" style={{ fontSize: '14px' }}>Язык</span>
          <select
            value={lang}
            onChange={e => setLang(e.target.value)}
            className="bg-zinc-900 border border-zinc-800 rounded-md px-2 py-1 text-zinc-200 focus:outline-none focus:border-zinc-500"
            style={{ fontSize: '14px' }}
          >
            <option value="ru">ru</option>
            <option value="en">en</option>
          </select>
        </div>
        <Checkbox
          checked={withTs}
          onChange={setWithTs}
          size="sm"
          label="с таймкодами"
        />

        <div className="ml-auto flex items-center gap-3">
          {selectionCount > 0 && !copyToast && (
            <div className="text-zinc-400 tabular-nums" style={{ fontSize: '14px' }}>
              {allTranscribed ? (
                copyEstimate ? (
                  <>~<span className="text-zinc-100">{formatTokens(copyEstimate.tokens)}</span> токенов · {formatBytes(copyEstimate.bytes)}</>
                ) : (
                  <span className="text-zinc-500">Считаю…</span>
                )
              ) : autoAi ? (
                <>до <span className="text-zinc-100">${upperBoundCost.toFixed(4)}</span> через {ENGINES.find(e => e.id === engine)?.label}</>
              ) : (
                <>бесплатно (только субтитры)</>
              )}
            </div>
          )}
          <button
            onClick={kickBatchComments}
            disabled={selectionCount === 0}
            title="Скачать комментарии для всех выбранных видео (новые, 500, без ответов)"
            className="px-4 py-2 rounded-md font-medium text-center transition-colors bg-zinc-800 text-zinc-200 hover:bg-zinc-700 hover:text-zinc-100 disabled:bg-zinc-900 disabled:text-zinc-600"
          >
            <span className="inline-flex items-center gap-1.5"><MessageCircle size={16} />Комментарии{selectionCount ? ` (${selectionCount})` : ''}</span>
          </button>
          <button
            onClick={primaryAction}
            disabled={selectionCount === 0 || !!copyToast}
            className={`min-w-[210px] px-4 py-2 rounded-md font-medium text-center transition-colors ${
              copyToast
                ? 'bg-emerald-700 text-emerald-50 cursor-default'
                : 'bg-zinc-100 text-zinc-900 hover:bg-white disabled:bg-zinc-800 disabled:text-zinc-500'
            }`}
            title={allTranscribed
              ? 'Все выбранные уже транскрибированы — копируем в буфер'
              : autoAi
                ? 'Получить субтитры; если их нет — явно разрешена AI-расшифровка'
                : 'Получить доступные субтитры бесплатно; видео без субтитров будут пропущены'}
          >
            {copyToast
              ? copyToast
              : (allTranscribed
                ? <span className="inline-flex items-center justify-center gap-1.5"><Copy size={16} />Скопировать{selectionCount ? ` (${selectionCount})` : ''}</span>
                : `Получить тексты${selectionCount ? ` (${selectionCount})` : ''}`)}
          </button>
        </div>
      </div>
    </div>
  )
})

// Memoised row — re-renders only when its own props change (selection of
// a different row no longer repaints this one).  `filtered` is passed as
// a positional argument to onToggle for the shift-click range, so the row
// itself doesn't depend on it.
const VideoRow = React.memo(function VideoRow({
  video, inSel, done, filtered, onToggle, fullDate,
  commentsHit, commentsExpanded, onToggleComments,
}) {
  const handleClick = (e) => onToggle(video.video_id, e, filtered)
  const dateStr = (fullDate ? fmtDateFull(video.timestamp) : fmtDate(video.timestamp)) || '—'
  // Comments marker has three resting states:
  //   present  — cached file exists for this video (any params)
  //   absent   — no cache; clicking still expands the form so user can fetch
  //   expanded — same icon, with active border, indicates the inline form is open
  const cmtTitle = commentsHit
    ? `Комментарии: ${commentsHit.count_total ?? '?'} в кэше — клик чтобы скопировать или сменить параметры`
    : 'Комментарии: ещё не запрошены — клик чтобы открыть форму'
  return (
    <button
      onClick={handleClick}
      className={`group w-full px-4 py-2 flex items-center gap-3 text-left ${
        inSel ? 'bg-zinc-900' : 'hover:bg-zinc-900/60'
      }`}
    >
      <Checkbox
        checked={inSel}
        // Click handled by the row <button> wrapper (it has the shift
        // event needed for range selection); checkbox is purely visual.
        passive
        size="md"
      />
      <span className="text-zinc-500 shrink-0 tabular-nums whitespace-nowrap" style={{ fontSize: '14px' }}>
        {dateStr}
      </span>
      <span className="text-zinc-200 truncate flex-1">{video.title}</span>
      {video.uploader && (
        <span
          className="text-zinc-500 shrink-0 truncate max-w-[120px]"
          style={{ fontSize: '13px' }}
          title={video.uploader}
        >
          {video.uploader}
        </span>
      )}
      {done && (
        <span
          className="text-emerald-400 shrink-0"
          style={{ fontSize: '14px' }}
          title={video.cache_source_handle
            ? `Уже есть в канале ${video.cache_source_handle} — повторно не запрашиваем`
            : video.cache_origin === 'jobs'
              ? 'Уже транскрибирован ранее — повторно не запрашиваем'
              : 'Транскрипт уже есть'}
        >✓</span>
      )}
      {/* Comments marker — rendered as a clickable span inside the row
          button. We stopPropagation so the chip click toggles the inline
          form instead of selecting the row. */}
      <span
        role="button"
        tabIndex={-1}
        onClick={(e) => { e.stopPropagation(); onToggleComments(video.video_id) }}
        title={cmtTitle}
        className={`shrink-0 px-1.5 rounded transition-colors ${
          commentsExpanded
            ? 'bg-zinc-700 text-zinc-100'
            : commentsHit
              ? 'text-emerald-400 hover:bg-zinc-800'
              : 'text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800'
        }`}
        style={{ fontSize: '14px' }}
      >
        <span className="inline-flex items-center gap-0.5"><MessageCircle size={14} />{commentsHit && <Check size={12} />}</span>
      </span>
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

// Inline limit input for the search picker — committed value lives in the
// parent (YouTubeSearchForm); this is a thin draft+commit wrapper so the
// user can type "150" without firing a fetch on each digit.
//
// `ceiling` (optional) — once parent detects that yt-dlp returned fewer
// items than asked, it passes the actual count here. We snap any larger
// input back down: requesting 200 when YouTube only has 17 just sends
// the same fetch again with no benefit.
function LimitInput({ value, loading, onApply, ceiling }) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => { setDraft(String(value)) }, [value])
  function commit() {
    let n = Math.max(1, Math.min(500, Number(draft) || 0))
    if (ceiling != null && n > ceiling) n = ceiling
    if (n !== value && onApply) onApply(n)
    else setDraft(String(value))
  }
  if (!onApply) {
    // Static fallback when limit-control isn't wired.
    return <span className="text-zinc-100">{value}</span>
  }
  return (
    <span className="inline-flex items-center gap-1">
      <input
        type="text"
        inputMode="numeric"
        value={draft}
        onChange={e => setDraft(e.target.value.replace(/[^\d]/g, '').slice(0, 3))}
        onKeyDown={e => { if (e.key === 'Enter') { e.currentTarget.blur() } }}
        onBlur={commit}
        disabled={loading}
        className="bg-zinc-900 border border-zinc-800 rounded text-zinc-100 focus:outline-none focus:border-zinc-500 tabular-nums disabled:text-zinc-500"
        style={{ fontSize: '13px', width: 48, padding: '2px 6px', textAlign: 'right' }}
        title={ceiling != null
          ? `Сколько результатов запрашивать. YouTube отдаёт максимум ${ceiling} для этого запроса.`
          : 'Сколько результатов запрашивать (Enter применит)'}
      />
      {loading && (
        <span className="inline-block w-3 h-3 rounded-full border-2 border-zinc-600 border-t-zinc-300 animate-spin" />
      )}
    </span>
  )
}

function SortChip({ active, onClick, children, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`px-2 py-0.5 rounded transition-colors ${
        active
          ? disabled
            ? 'bg-zinc-900 text-zinc-500 border border-zinc-800 cursor-not-allowed'
            : 'bg-zinc-800 text-zinc-100 border border-zinc-700'
          : disabled
            ? 'text-zinc-700 border border-transparent cursor-not-allowed'
            : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60 border border-transparent'
      }`}
      style={{ fontSize: '13px' }}
    >
      {children}
    </button>
  )
}

function ToggleSwitch({ checked, onChange, label }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer select-none">
      <span
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative w-9 h-5 rounded-full transition-colors duration-200 ${
          checked ? 'bg-emerald-600' : 'bg-zinc-700'
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform duration-200 ${
            checked ? 'translate-x-4' : 'translate-x-0'
          }`}
        />
      </span>
      <span className="text-zinc-300" style={{ fontSize: '14px' }}>{label}</span>
    </label>
  )
}

export default YouTubeBatchPicker

function BatchProgress({ job }) {
  const b = job?.yt_batch || {}
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
        {b.skipped > 0 && <span>· пропущено <span className="text-zinc-300">{b.skipped}</span></span>}
        {b.errors > 0  && <span>· ошибок <span className="text-red-400">{b.errors}</span></span>}
        {b.cost_usd > 0 && <span>· потрачено <span className="text-zinc-200">${b.cost_usd.toFixed(4)}</span></span>}
      </div>
    </div>
  )
}
