import React, {
  useEffect, useImperativeHandle, useState, forwardRef,
} from 'react'
import { RotateCw, X } from 'lucide-react'
import { ytSearchFetch } from '../lib/jobs'
import YouTubeBatchPicker from './YouTubeBatchPicker'

const DEFAULT_LIMIT = 30

// ─── &sp= decoder ──────────────────────────────────────────────────────
// YouTube encodes filter UI choices into a base64 of a small protobuf-ish
// blob. We don't fully parse it (the spec isn't published), but we recognise
// the common short codes the user is most likely to paste from the YouTube
// search UI. Anything we don't recognise is rendered as the raw token so
// the user at least sees something concrete instead of "URL filter".
//
// Reference (decoded byte pairs): https://ktsk.xyz/docs/programming/decoding-youtube-filters/
//   header(byte0=0x00..)+filter(byte0,byte1)
//   sort      (header) → CAI=, CAM=, CAE=  (byte0=0x08)
//   uploadDate          → 0x12, 0x02, 0x08 0xNN
//   type                → 0x12, 0x02, 0x10 0xNN
//   duration            → 0x12, 0x02, 0x18 0xNN
//   features            → 0x12, 0x02, 0xNN 0x01  (each in its own group)
const SP_KNOWN = {
  // Pure-sort codes (no sp= prefix decoding needed).
  'CAI=':  { sort: 'date'      },
  'CAM=':  { sort: 'views'     },
  'CAE=':  { sort: 'rating'    },
  'CAASAhAB':         { sort: 'relevance', type: 'video' },
  'CAISAhAB':         { sort: 'date',      type: 'video' },
  'CAMSAhAB':         { sort: 'views',     type: 'video' },
}

const UPLOAD_LABEL = {
  1: 'за последний час',
  2: 'за сегодня',
  3: 'за неделю',
  4: 'за месяц',
  5: 'за год',
}
const DURATION_LABEL = { 1: '< 4 мин', 3: '4–20 мин', 2: '> 20 мин' }
const TYPE_LABEL = { 1: 'видео', 2: 'каналы', 3: 'плейлисты', 4: 'фильмы' }
const FEATURE_LABEL = {
  0x20: 'HD', 0x28: 'CC', 0x70: '4K',
  0x40: 'live', 0x38: '3D', 0x78: '360°',
}

/** Decode a YouTube `sp=` token into a human-readable filter object. */
function decodeYtSp(spRaw) {
  if (!spRaw) return null
  const known = SP_KNOWN[spRaw]
  if (known) return { ...known, raw: spRaw }
  // Best-effort: base64 → byte array; walk in 2-byte words after a header.
  let bytes
  try {
    const std = spRaw.replace(/-/g, '+').replace(/_/g, '/').replace(/%3D/gi, '=')
    const padLen = (4 - (std.length % 4)) % 4
    const b64 = std + '='.repeat(padLen)
    const bin = atob(b64)
    bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  } catch { return { raw: spRaw } }
  const out = { raw: spRaw }
  // Outer sort is the first byte-pair when present (0x08 0xNN).
  if (bytes.length >= 2 && bytes[0] === 0x08) {
    out.sort = bytes[1] === 0x01 ? 'rating'
            : bytes[1] === 0x02 ? 'date'
            : bytes[1] === 0x03 ? 'views' : 'relevance'
  }
  // Filters live inside one or more `0x12 0x02 <kind> <val>` triples.
  for (let i = 0; i < bytes.length - 3; i++) {
    if (bytes[i] === 0x12 && bytes[i + 1] === 0x02) {
      const kind = bytes[i + 2]
      const val  = bytes[i + 3]
      if (kind === 0x08) out.uploadDate = val          // upload window
      else if (kind === 0x10) out.type = val           // type=video|channel...
      else if (kind === 0x18) out.duration = val       // duration bucket
      else if (FEATURE_LABEL[kind]) {
        out.features = out.features || []
        out.features.push(kind)
      }
      i += 3
    }
  }
  return out
}

/** Stable English-ish summary for the chip + tooltip ("сорт. по дате · видео · за неделю"). */
function describeYtSp(decoded) {
  if (!decoded) return null
  const parts = []
  if (decoded.sort && decoded.sort !== 'relevance') {
    parts.push(decoded.sort === 'date'  ? 'сорт. по дате'
            : decoded.sort === 'views'  ? 'сорт. по просм.'
            : decoded.sort === 'rating' ? 'сорт. по рейтингу'
            : null)
  }
  if (decoded.uploadDate) parts.push(UPLOAD_LABEL[decoded.uploadDate] || `период ${decoded.uploadDate}`)
  if (decoded.type && decoded.type !== 1) parts.push(TYPE_LABEL[decoded.type] || `тип ${decoded.type}`)
  if (decoded.duration) parts.push(DURATION_LABEL[decoded.duration] || `длит. ${decoded.duration}`)
  if (decoded.features?.length) {
    parts.push(decoded.features.map(f => FEATURE_LABEL[f] || `0x${f.toString(16)}`).join(' '))
  }
  return parts.filter(Boolean).join(' · ') || null
}

/**
 * Inline YouTube search form. Sourceless: results aren't persisted to the
 * Library, only flow into the batch picker → batch transcribe job.
 *
 *   target — full URL (YouTube `?search_query=...&sp=...`) OR plain query
 *
 * The Python script (yt_search_ndjson.py) accepts both shapes. URL form
 * preserves YouTube's own filters (sort by upload date, type=video, etc.).
 */
const YouTubeSearchForm = forwardRef(function YouTubeSearchForm({ url, query, onStarted }, ref) {
  // The query passed to yt-dlp: prefer the full URL if pasted, else the
  // raw query (which gets ytsearch{N}: wrapped on the Python side).
  const ytdlpInput = url || query || ''
  const displayQuery = query
    || (() => {
      try {
        const u = new URL(url)
        return u.searchParams.get('search_query') || ''
      } catch { return url || '' }
    })()

  // True if the pasted URL carries YouTube's own filter encoding (`sp=`):
  // `sort by upload date this week`, `type=video`, etc. These can hard-cap
  // the result count below DEFAULT_LIMIT — important to surface to the user
  // because no amount of "+30" will ever return more (yt-dlp just resends
  // the same shorter list).
  // We also decode it so the user *sees* what the URL actually filters by
  // — opaque "URL filters" was confusing them out of using it.
  const urlFilter = React.useMemo(() => {
    if (!url) return null
    try {
      const sp = new URL(url).searchParams.get('sp')
      return sp ? decodeYtSp(sp) : null
    } catch { return null }
  }, [url])
  const hasUrlFilter = !!urlFilter

  // Stages: 'idle' | 'fetching' | 'ready' | 'error'
  const [stage, setStage] = useState('idle')
  const [videos, setVideos] = useState([])
  const [limit, setLimit] = useState(DEFAULT_LIMIT)
  const [loadingMore, setLoadingMore] = useState(false)
  // True once yt-dlp returned fewer items than we requested — means YouTube
  // has no more results for this query/filter combination. Disables further
  // "+30" attempts and switches the LimitInput hint into a ceiling marker.
  const [reachedCeiling, setReachedCeiling] = useState(false)
  // Override: if the user clicks "× убрать фильтры", we re-query with a
  // sanitized URL (sp stripped). Stored locally so we can show "filters
  // off" affordance and re-enable URL filter again.
  const [filterStripped, setFilterStripped] = useState(false)
  const [err, setErr] = useState(null)
  const pickerRef = React.useRef(null)

  // What we actually pass to yt-dlp: optionally with `&sp=` removed.
  const effectiveInput = (() => {
    if (!filterStripped || !url) return ytdlpInput
    try {
      const u = new URL(url)
      u.searchParams.delete('sp')
      return u.toString()
    } catch { return ytdlpInput }
  })()

  async function fetchTotal(targetLimit) {
    const r = await ytSearchFetch({
      query: effectiveInput, limit: targetLimit, offset: 0,
    })
    return (r?.items || []).filter(v => v && v.video_id)
  }

  // First-page fetch on mount + on filter strip toggle.
  useEffect(() => {
    if (!ytdlpInput) return
    let alive = true
    setStage('fetching'); setErr(null); setVideos([])
    setLimit(DEFAULT_LIMIT); setReachedCeiling(false)
    ;(async () => {
      try {
        const items = await fetchTotal(DEFAULT_LIMIT)
        if (!alive) return
        if (items.length === 0) {
          setErr('Поиск не вернул результатов'); setStage('error'); return
        }
        setVideos(items)
        if (items.length < DEFAULT_LIMIT) setReachedCeiling(true)
        setStage('ready')
      } catch (e) {
        if (!alive) return
        setErr(String(e?.message || e)); setStage('error')
      }
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ytdlpInput, filterStripped])

  async function applyLimit(newLimit) {
    if (loadingMore || !Number.isFinite(newLimit) || newLimit < 1) return
    // Block fetches above the discovered ceiling — yt-dlp will just
    // return the same shorter list; we'd waste 1-2s and the user would
    // see "ничего не изменилось" again.
    if (reachedCeiling && newLimit > videos.length) {
      setLimit(videos.length)
      return
    }
    if (newLimit === videos.length) return
    setLoadingMore(true)
    setLimit(newLimit)
    try {
      // Local trim is free — no fetch needed.
      if (newLimit < videos.length) {
        setVideos(prev => prev.slice(0, newLimit))
        return
      }
      // Need more — re-query for the larger window. yt-dlp's ranked-search
      // returns a stable prefix for the same N+offset, so we just refetch
      // top-N at the new size and dedupe.
      const items = await fetchTotal(newLimit)
      // Preserve order; dedupe by video_id.
      const seen = new Set()
      const merged = []
      for (const it of items) {
        if (seen.has(it.video_id)) continue
        seen.add(it.video_id); merged.push(it)
      }
      setVideos(merged)
      // If yt-dlp gave us fewer items than we asked for, we hit the
      // platform-side ceiling for this query+filter.
      if (merged.length < newLimit) setReachedCeiling(true)
    } catch (e) {
      setErr(String(e?.message || e))
    } finally {
      setLoadingMore(false)
    }
  }

  async function loadMore() {
    if (reachedCeiling) return
    return applyLimit(videos.length + DEFAULT_LIMIT)
  }

  function retry() {
    setErr(null); setStage('fetching')
    ;(async () => {
      try {
        const items = await fetchTotal(limit)
        setVideos(items)
        if (items.length < limit) setReachedCeiling(true)
        else setReachedCeiling(false)
        setStage('ready')
      } catch (e) { setErr(String(e?.message || e)); setStage('error') }
    })()
  }

  useImperativeHandle(ref, () => ({
    trigger() {
      if (stage === 'ready' && pickerRef.current?.trigger) pickerRef.current.trigger()
      else if (stage === 'error') retry()
    },
  }), [stage])

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950">
      <SearchHeader
        query={displayQuery}
        url={url}
        stage={stage}
        urlFilter={urlFilter}
        filterStripped={filterStripped}
        onToggleFilter={() => setFilterStripped(v => !v)}
      />
      {stage === 'ready' && (
        <div className="p-4">
          <YouTubeBatchPicker
            ref={pickerRef}
            sourceId={null}
            videos={videos}
            searchQuery={effectiveInput}
            showSearchControls
            onStarted={onStarted}
            onLoadMore={reachedCeiling ? null : loadMore}
            loadingMore={loadingMore}
            loadMoreLabel={`+ Показать ещё ${DEFAULT_LIMIT}`}
            totalLoaded={videos.length}
            currentLimit={limit}
            onApplyLimit={applyLimit}
            reachedCeiling={reachedCeiling}
            // Pass the decoded URL filter only when it's actually active —
            // when the user strips it, the picker should treat the date
            // range and sort as freely editable again.
            urlFilterLocked={hasUrlFilter && !filterStripped ? urlFilter : null}
          />
        </div>
      )}
      {stage === 'error' && err && (
        <div className="px-6 py-4 text-red-400 border-t border-red-900/50 bg-red-950/20">
          {err}
          <button
            onClick={retry}
            className="ml-3 px-2 py-1 rounded text-xs bg-red-900/40 hover:bg-red-900/60"
          >Повторить</button>
        </div>
      )}
    </div>
  )
})

export default YouTubeSearchForm

// ─── sub-components ──────────────────────────────────────────────────────

function SearchHeader({ query, url, stage, urlFilter, filterStripped, onToggleFilter }) {
  const fetching = stage === 'fetching'
  const hasUrlFilter = !!urlFilter
  // Two stacked rows: query text on top, filter chip + breakdown on the
  // bottom. Lifting the breakdown out of the tooltip means the user can
  // see *what* "URL filters" means without hovering — the previous
  // single-line "фильтры URL · убрать" was opaque.
  const summary = describeYtSp(urlFilter)
  return (
    <div className="px-6 py-3 border-b border-zinc-800">
      <div className="flex items-center gap-3 min-h-[28px]">
        <span className="text-zinc-500 text-lg shrink-0">🔍</span>
        <span className="font-medium text-zinc-100 truncate">{query || '—'}</span>
        {fetching && (
          <span className="text-zinc-500 animate-pulse shrink-0" style={{ fontSize: '14px' }}>
            · ищем…
          </span>
        )}
      </div>
      {hasUrlFilter && (
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          <span className="text-zinc-500 shrink-0" style={{ fontSize: '12px' }}>Из ссылки:</span>
          <span
            className={`shrink-0 px-2 py-0.5 rounded border ${
              filterStripped
                ? 'bg-zinc-900 text-zinc-500 border-zinc-800 line-through decoration-zinc-700'
                : 'bg-amber-900/20 text-amber-200 border-amber-800/40'
            }`}
            style={{ fontSize: '12px' }}
            title={`sp=${urlFilter.raw}`}
          >
            {summary || urlFilter.raw}
          </span>
          <button
            onClick={onToggleFilter}
            className="shrink-0 px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 border border-zinc-700 hover:bg-zinc-700 inline-flex items-center gap-1"
            style={{ fontSize: '12px' }}
            title={filterStripped
              ? 'Вернуть фильтры из ссылки и переискать'
              : 'Убрать фильтры из ссылки и переискать (даты слева станут активными)'}
          >
            {filterStripped
              ? <><RotateCw size={12} /> вернуть</>
              : <><X size={12} /> убрать и переискать</>}
          </button>
        </div>
      )}
    </div>
  )
}
