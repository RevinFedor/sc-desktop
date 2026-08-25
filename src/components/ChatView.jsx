import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import { Virtuoso } from 'react-virtuoso'
import Checkbox from './Checkbox'
import Select from './Select'
import { ENGINES } from './TelegramTypesPopover'
import { useInvalidator } from '../lib/dataBus'
import { useChatSelection } from '../lib/chatSelection'
import { useJobsSelector } from '../lib/jobs'
import { jobsForSource, sameArrayItems } from '../lib/jobSelectorCore.mjs'
import { Loader2, Mic, ScanEye, ScanText, Sparkles, Copy, RotateCw, ChevronDown, ChevronUp, X } from 'lucide-react'

// Collapse long message bodies to this many chars; «Раскрыть» reveals the rest.
// Matches the previous hard truncate(text, 600) so short messages are
// unaffected and only genuinely long ones gain the control.
const EXPAND_LIMIT = 600

// Which physical message types carry media that can be AI-processed on demand,
// and which AI pipeline each maps to. Mirrors job-runner's TG_TYPE_TO_MEDIA_KIND
// and Python's process_media() routing: voice/audio/video → transcription,
// photo → Vision describe, document → PDF extract. Text/poll/etc. have no
// pipeline, so no action button.
const MEDIA_KIND_BY_TYPE = {
  voice: 'voice', audio: 'voice', video: 'voice',
  photo: 'photo', document: 'docs',
}

// Per-kind action verb + icon. The earlier «перевести»/Languages styling read
// as RU→EN translation, but the pipelines are transcription / Vision-describe /
// PDF-extract — recognition, not translation. So each media kind gets its own
// honest verb and a matching lucide glyph:
//   voice/audio/video → расшифровать (Mic)      — speech-to-text
//   photo             → описать      (ScanEye)  — Vision description
//   document          → извлечь      (ScanText) — PDF text extraction
// Bulk over a mixed selection uses the neutral «обработать» (Sparkles).
const MEDIA_ACTION = {
  voice: { verb: 'расшифровать', Icon: Mic },
  photo: { verb: 'описать',      Icon: ScanEye },
  docs:  { verb: 'извлечь',      Icon: ScanText },
}
function mediaActionForType(type) {
  return MEDIA_ACTION[MEDIA_KIND_BY_TYPE[type]] || null
}

// Short Russian labels for the per-row loader, keyed by the media-progress
// `stage` value emitted by tg_fetch_json.process_media (see fact-jobs.md).
const STAGE_LABEL = {
  downloading:  'скачиваю',
  uploading:    'загружаю',
  queued:       'в очереди',
  transcribing: 'расшифровка',
  describing:   'описываю',
  extracting:   'извлекаю',
  completed:    'готово',
}

function formatBytes(n) {
  if (n == null) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

const PAGE_SIZE = 100
const FIRST_ITEM_INDEX_BASE = 1_000_000
// Потолок FTS-выдачи (itemsSearch). Достигли — футер честно говорит про
// обрезку, а не рапортует «200 результатов» как полный список.
const FTS_LIMIT = 200

const TYPE_ICON = {
  text: '💬', voice: '🎤', video: '🎬', photo: '🖼',
  audio: '🎵', sticker: '🎟', gif: '🎞',
  document: '📎', poll: '📊', service: '⚙', other: '·',
}
const TYPE_LABEL = {
  text: 'Текст', voice: 'Голос', video: 'Видео', photo: 'Фото',
  audio: 'Аудио', sticker: 'Стикеры', gif: 'GIF',
  document: 'Документы', poll: 'Опросы', service: 'Системные', other: 'Прочее',
}
const ALL_TYPES = ['text', 'voice', 'video', 'photo', 'audio', 'document', 'poll']

function ChatView({ sourceId, platform = 'telegram' }) {
  const [items, setItems] = useState([])
  const [offset, setOffset] = useState(0)
  const [cursor, setCursor] = useState(null)
  const [loading, setLoading] = useState(false)
  const [exhausted, setExhausted] = useState(false)
  const [query, setQuery] = useState('')
  const [searchActive, setSearchActive] = useState(false)
  // 'fts' = exact-word full-text search (existing FTS5 over caption/transcript)
  // 'sem' = hybrid semantic search (FTS + vector RRF, see electron/embedder.js).
  // Selected mode is captured in `runSearch` so changing it after results
  // appear doesn't silently re-shuffle them — user must press the button again.
  const [searchMode, setSearchMode] = useState('fts')
  // Number of semantic hits to fetch — load-more bumps this by SEM_PAGE.
  // Reset to SEM_PAGE on every fresh search via runSearch().
  const SEM_PAGE = 50
  const [semLimit, setSemLimit] = useState(SEM_PAGE)
  // Cosine-similarity floor for semantic results. Items below it are still
  // fetched (so user can drag the slider down without re-querying) but
  // hidden in the UI. 0.50 is empirically the boundary between "kinda
  // related" and "noise" for Gemini RETRIEVAL embeddings on Russian text.
  // FTS-only hits have _cos = null and are always shown — exact matches
  // bypass the threshold by definition.
  const [semThreshold, setSemThreshold] = useState(0.50)
  // Multi-select content types. Empty Set = "all types" (no SQL filter).
  const [selectedTypes, setSelectedTypes] = useState(() => new Set())
  // Visual date order. Telegram keeps fetching the freshest page first; the
  // switch only reverses the rendered list so "Дата ↑" stays chat-like.
  const [dateSort, setDateSort] = useState('asc')
  // null = "Все темы". Forum topic id otherwise.
  const [selectedTopic, setSelectedTopic] = useState(null)
  // [{id, title, count}, ...] — empty for non-forum chats / empty DB.
  const [topics, setTopics] = useState([])
  // [{type, count, ...}, ...] for the current topic (or whole source when topic=null)
  const [typeBreakdown, setTypeBreakdown] = useState([])

  const inFlightRef = useRef(null)
  const requestGenerationRef = useRef(0)
  const itemsRef = useRef([])
  const loadedIdsRef = useRef(new Set())
  const virtuosoRef = useRef(null)
  const [firstItemIndex, setFirstItemIndex] = useState(FIRST_ITEM_INDEX_BASE)
  const [listEpoch, setListEpoch] = useState(0)
  const [expandedIds, setExpandedIds] = useState(() => new Set())
  // ── Chat-style scroll (flipped mode) machinery ───────────────────────
  // While true, live messages appended by an active Telegram fetch keep the
  // viewport pinned to the bottom. User scroll-up flips it off.
  const stickToBottomRef = useRef(true)
  // One key drives everything in this view — topics, type breakdown, and
  // the items list itself. jobInvalidation.js bumps `items:<id>` whenever
  // a job for this source finishes, so the dropdown count and chip-row
  // refresh without us subscribing to job:update directly.
  const itemsVer = useInvalidator(`items:${sourceId}`)

  useEffect(() => {
    if (platform !== 'telegram' || !sourceId || !window.api?.jobsSetLiveSource) return
    window.api.jobsSetLiveSource(sourceId).catch(() => {})
    return () => { window.api.jobsSetLiveSource(null).catch(() => {}) }
  }, [sourceId, platform])

  // ── On-demand media processing (Telegram only) ────────────────────────
  // Multi-select + per-row «перевести»/«копировать». Selection lives in the
  // external store so the bulk bar and per-row checkboxes share one truth.
  const sel = useChatSelection()
  // Engine for the on-demand transcription (voice/video). Photo/docs ignore it
  // (always Gemini Vision / PDF). Default gemini — cheap & fast, matches the
  // form default mental model.
  const [bulkEngine, setBulkEngine] = useState('gemini')
  const canProcess = platform === 'telegram'

  // Live per-message processing state, derived from running jobs' media_phase.
  // A row is «in flight» when some running job for this source currently has
  // media_phase[kind].current.msg_id === this row's external_id. Map keyed by
  // external_id(string) → { stage, engine, kind }. See fact-jobs.md::media_phase.
  const liveJobs = useJobsSelector(
    jobs => jobsForSource(jobs, sourceId, { activeOnly: true }),
    sameArrayItems,
  )
  const liveFetchJobs = React.useMemo(
    () => liveJobs.filter(j => j && j.source_id === sourceId
      && j.type === 'tg_fetch'
      && (j.status === 'running' || j.status === 'awaiting_ai' || j.status === 'cancelling')
      && j.params?.mode !== 'media_only'),
    [liveJobs, sourceId],
  )
  const liveTailItems = React.useMemo(() => {
    if (platform !== 'telegram' || searchActive) return []
    const byExternalId = new Map()
    for (const j of liveFetchJobs) {
      const rows = Array.isArray(j.tg_live_items) ? j.tg_live_items : []
      for (const row of rows) {
        if (!row || row.external_id == null) continue
        if (selectedTopic != null && row.topic_id !== selectedTopic) continue
        if (selectedTypes.size && !selectedTypes.has(row.type)) continue
        byExternalId.set(String(row.external_id), row)
      }
    }
    return [...byExternalId.values()].sort(compareNewestFirst)
  }, [liveFetchJobs, platform, searchActive, selectedTopic, selectedTypes])
  const processingByExtId = React.useMemo(() => {
    const m = new Map()
    for (const j of liveJobs) {
      if (!j || j.source_id !== sourceId) continue
      if (j.status !== 'running' && j.status !== 'awaiting_ai' && j.status !== 'cancelling') continue
      const mp = j.media_phase
      if (!mp) continue
      for (const kind of ['voice', 'photo', 'pdf']) {
        const cur = mp[kind] && mp[kind].current
        if (cur && cur.msg_id != null) {
          m.set(String(cur.msg_id), { stage: cur.stage, engine: cur.engine, kind })
        }
      }
    }
    return m
  }, [liveJobs, sourceId])
  // Any media-only job for this source still running? Drives the bulk-bar
  // «идёт перевод…» note and disables re-launch to avoid duplicate work.
  const mediaJobRunning = React.useMemo(
    () => liveJobs.some(j => j && j.source_id === sourceId
      && (j.status === 'running' || j.status === 'awaiting_ai' || j.status === 'cancelling')
      && j.params?.mode === 'media_only'),
    [liveJobs, sourceId],
  )

  // Telegram renders like a chat: chronological (oldest at top, newest at
  // bottom), opened at the bottom, older pages joining on scroll-UP. Search
  // results are NOT flipped — they stay ranked top-down by relevance, and
  // other platforms keep the plain newest-first list. State `items` itself
  // stays newest-first (pages append as fetched); only the render order flips.
  const flipped = platform === 'telegram' && !searchActive && dateSort === 'asc'
  const renderItems = React.useMemo(() => {
    if (searchActive || liveTailItems.length === 0) return items
    const liveExtIds = new Set(liveTailItems.map(it => String(it.external_id)))
    return [
      ...liveTailItems,
      ...items.filter(it => !liveExtIds.has(String(it.external_id))),
    ]
  }, [items, liveTailItems, searchActive])
  const visualItems = React.useMemo(
    () => (flipped ? [...renderItems].reverse() : renderItems),
    [renderItems, flipped],
  )
  const displayedItems = React.useMemo(
    () => visualItems.filter(it => (
      !searchActive || searchMode !== 'sem' || it._cos == null || it._cos >= semThreshold
    )),
    [visualItems, searchActive, searchMode, semThreshold],
  )
  // Ordered list of actually rendered message ids — Shift-range select must
  // not include rows hidden by the semantic relevance threshold.
  const orderedIds = React.useMemo(() => displayedItems.map(it => it.id), [displayedItems])
  // Prune selection to what's still visible whenever the rendered set changes
  // (filter / search / source switch drops rows).
  useEffect(() => {
    sel.pruneTo(new Set(orderedIds))
    // pruneTo is a stable module-level function exposed by the selection store.
    // Depending on the memoized array avoids rebuilding a multi-thousand-ID
    // join string on every unrelated render.
  }, [orderedIds, sel.pruneTo])
  // Drop selection entirely when the source changes — ids belong to the old chat.
  useEffect(() => { sel.clear() /* eslint-disable-next-line */ }, [sourceId])

  // Map a selected/clicked item to its on-demand process flags. Returns null
  // for non-media types (text/poll/…) — those have no «перевести».
  function mediaFlagsForType(type) {
    const kind = MEDIA_KIND_BY_TYPE[type]
    if (!kind) return null
    return {
      process_voice: kind === 'voice',
      process_photo: kind === 'photo',
      process_docs:  kind === 'docs',
    }
  }

  // Launch a media-only (re)processing job for a set of items. Builds the
  // union of process flags across the picked rows so one job can cover a mixed
  // voice+photo selection. msg_ids are the external_ids (Telegram msg ids).
  async function runTranscribe(pickedItems) {
    if (!canProcess || !window.api?.tgFetch) return
    const media = pickedItems.filter(it => MEDIA_KIND_BY_TYPE[it.type])
    if (media.length === 0) return
    // The fetch needs the source handle for its target. It's usually already
    // resolved by the mount effect, but guard against a fast click before that
    // lands: resolve it on-demand (one IPC) rather than spawning a job with an
    // empty '@' target that Python would reject. handle is NOT NULL in the DB,
    // so this always yields a value.
    let h = handle
    let sess = sourceSession
    let conflict = sourceSessionConflict
    if (!h && window.api?.sourceGet) {
      try {
        const src = await window.api.sourceGet(sourceId)
        h = src?.handle || null
        sess = src?.tg_session || null
        conflict = !!src?.tg_session_conflict
        if (h) setHandle(h)
        if (sess) setSourceSession(sess)
        setSourceSessionConflict(conflict)
      } catch {}
    }
    if (!h) {
      console.warn('[ChatView] runTranscribe: no source handle yet')
      return
    }
    if (conflict || !sess) {
      console.warn('[ChatView] runTranscribe: source telegram session not pinned')
      return
    }
    const flags = { process_voice: false, process_photo: false, process_docs: false }
    for (const it of media) {
      const f = mediaFlagsForType(it.type)
      if (f) {
        flags.process_voice = flags.process_voice || f.process_voice
        flags.process_photo = flags.process_photo || f.process_photo
        flags.process_docs  = flags.process_docs  || f.process_docs
      }
    }
    const msgIds = media
      .map(it => Number(it.external_id))
      .filter(Number.isFinite)
    if (msgIds.length === 0) return
    try {
      await window.api.tgFetch({
        target: '@' + String(h).replace(/^@/, ''),
        mode: 'media_only',
        _source_id: sourceId,
        _tg_session_override: sess,
        _media_only_msg_ids: msgIds,
        transcribe_engine: bulkEngine,
        ...flags,
      })
    } catch (err) {
      console.error('[ChatView] media_only launch failed', err)
    }
  }

  // Copy caption(s) of specific messages (per-row or bulk). Caption already
  // carries the appended AI block, so this returns ready-to-paste text.
  const [copyToast, setCopyToast] = useState(null)
  async function runCopy(pickedItems) {
    if (!window.api?.itemsCopyMany) return
    const ids = pickedItems.map(it => String(it.external_id))
    if (ids.length === 0) return
    try {
      const r = await window.api.itemsCopyMany({ source_id: sourceId, external_ids: ids })
      if (r?.ok) {
        setCopyToast(`Скопировано · ${r.count} · ${formatBytes(r.bytes)}`)
      } else {
        setCopyToast('Нечего копировать')
      }
    } catch (err) {
      setCopyToast('Ошибка копирования')
    }
    setTimeout(() => setCopyToast(null), 2500)
  }

  // Need the source handle for the tgFetch target. ChatView doesn't get it as a
  // prop, but items carry no handle either — so we read it lazily from the
  // first time we launch (SourceDetail passes platform but not handle). We
  // resolve it from window.api.sourceGet once.
  const [handle, setHandle] = useState(null)
  const [sourceSession, setSourceSession] = useState(null)
  const [sourceSessionConflict, setSourceSessionConflict] = useState(false)
  useEffect(() => {
    if (!canProcess || !sourceId || !window.api?.sourceGet) return
    let alive = true
    window.api.sourceGet(sourceId).then(s => {
      if (alive && s) {
        setHandle(s.handle || null)
        setSourceSession(s.tg_session || null)
        setSourceSessionConflict(!!s.tg_session_conflict)
      }
    }).catch(() => {})
    return () => { alive = false }
  }, [sourceId, canProcess])

  const reset = useCallback(() => {
    requestGenerationRef.current += 1
    inFlightRef.current = null
    itemsRef.current = []
    loadedIdsRef.current = new Set()
    setItems([])
    setLoading(false)
    setOffset(0)
    setCursor(null)
    setExhausted(false)
    setFirstItemIndex(FIRST_ITEM_INDEX_BASE)
    setListEpoch(n => n + 1)
    setExpandedIds(new Set())
    stickToBottomRef.current = true
  }, [])

  // Refresh topic list when source or items-version changes.
  useEffect(() => {
    if (!window.api?.itemsTopics || !sourceId) { setTopics([]); return }
    let alive = true
    window.api.itemsTopics(sourceId).then(rows => {
      if (alive) setTopics(rows || [])
    }).catch(() => alive && setTopics([]))
    return () => { alive = false }
  }, [sourceId, itemsVer])

  // Type counts in the Filters dropdown — live.
  useEffect(() => {
    if (!window.api?.itemsTypeBreakdown || !sourceId) { setTypeBreakdown([]); return }
    let alive = true
    window.api.itemsTypeBreakdown({ source_id: sourceId, topic_id: selectedTopic })
      .then(rows => alive && setTypeBreakdown(rows || []))
      .catch(() => alive && setTypeBreakdown([]))
    return () => { alive = false }
  }, [sourceId, selectedTopic, itemsVer])

  // Load page (or full search)
  const loadPage = useCallback(async () => {
    const generation = requestGenerationRef.current
    if (inFlightRef.current === generation || exhausted || !window.api) return
    inFlightRef.current = generation
    setLoading(true)
    try {
      let rows
      if (searchActive && query.trim()) {
        if (searchMode === 'sem') {
          // Hybrid semantic — runs the query through Gemini + RRF over
          // FTS5 + items_vec. Returns up to `limit` already ranked rows.
          // semLimit grows on "Показать ещё +50" — re-query is unavoidable
          // because vec0 needs `k` at MATCH time, can't paginate after.
          const r = await window.api.tgSearch({
            sourceId,
            query: query.trim(),
            limit: semLimit,
          })
          if (generation !== requestGenerationRef.current) return
          if (r?.error) {
            console.error('[ChatView] semantic search failed:', r.error)
            window.alert(`Семантический поиск не сработал: ${r.error}`)
            rows = []
          } else {
            rows = r?.results || []
          }
        } else {
          rows = await window.api.itemsSearch({
            source_id: sourceId,
            query: query.trim(),
            limit: FTS_LIMIT,
          })
          if (generation !== requestGenerationRef.current) return
        }
        setExhausted(true)
      } else {
        const pageParams = {
          source_id: sourceId,
          limit: PAGE_SIZE,
          order: platform === 'telegram'
            ? 'published_at DESC'
            : (dateSort === 'asc' ? 'published_at ASC' : 'published_at DESC'),
          types: selectedTypes.size ? [...selectedTypes] : null,
          topic_id: selectedTopic,
        }
        if (window.api.itemsListPage) {
          const page = await window.api.itemsListPage({ ...pageParams, cursor })
          rows = page?.items || []
          if (generation !== requestGenerationRef.current) return
          setCursor(page?.nextCursor || null)
          setExhausted(!page?.hasMore)
        } else {
          rows = await window.api.itemsList({ ...pageParams, offset })
          if (generation !== requestGenerationRef.current) return
          if (rows.length < PAGE_SIZE) setExhausted(true)
          setOffset(o => o + rows.length)
        }
        if (generation !== requestGenerationRef.current) return
      }
      if (searchActive) {
        loadedIdsRef.current = new Set(rows.map(row => row.id))
        itemsRef.current = rows
        setItems(rows)
      } else {
        const prev = itemsRef.current
        const seen = loadedIdsRef.current
        const fresh = rows.filter(row => {
          if (seen.has(row.id)) return false
          seen.add(row.id)
          return true
        })
        const next = fresh.length === rows.length ? [...prev, ...rows] : [...prev, ...fresh]
        // `items` stays newest-first, so a newly fetched older page appears at
        // the start of visualItems after reversal. Virtuoso preserves the
        // reading frame when firstItemIndex decreases by exactly that prepend.
        if (flipped && fresh.length) setFirstItemIndex(index => index - fresh.length)
        itemsRef.current = next
        setItems(next)
      }
    } catch (err) {
      if (generation === requestGenerationRef.current) console.error('chat load failed', err)
    } finally {
      if (inFlightRef.current === generation) {
        inFlightRef.current = null
        if (generation === requestGenerationRef.current) setLoading(false)
      }
    }
    // eslint-disable-next-line
  }, [sourceId, offset, cursor, exhausted, searchActive, searchMode, semLimit, query, selectedTypes, selectedTopic, flipped, dateSort, platform])

  // When the user navigates to a different source, the existing topic /
  // type-filter scope is meaningless (those ids belong to the previous
  // chat). Drop them so the new view starts at "Все темы / Все типы".
  useEffect(() => {
    setSelectedTopic(null)
    setSelectedTypes(new Set())
  }, [sourceId])

  // Reset list whenever scope changes — including a job-driven invalidation
  // (new items merged into this source). Drops pagination so the first page
  // includes whatever just landed.
  useEffect(() => { reset() }, [sourceId, selectedTopic, itemsVer, reset])
  // selectedTypes change is also a scope change but Set identity doesn't trigger
  // useMemo deps cleanly — convert to a stable string for the dep.
  const typesKey = [...selectedTypes].sort().join(',')
  useEffect(() => { reset() }, [typesKey, reset])
  useEffect(() => { reset() }, [dateSort, reset])

  useEffect(() => {
    if (items.length === 0 && !loading && !exhausted) loadPage()
    // eslint-disable-next-line
  }, [items.length, sourceId, selectedTopic, typesKey, itemsVer, searchActive, searchMode, semLimit, query, loadPage, loading, exhausted])

  // A capped live tail eventually replaces one old row for each new row, so
  // its length can stay constant. followOutput only reacts to count changes;
  // this identity marker keeps a reader who is already at the bottom pinned
  // through those same-length replacements without dragging a scrolled-up
  // reader away from their position.
  const liveTailMarker = liveTailItems[0]?.external_id || null
  useEffect(() => {
    if (!flipped || !liveTailMarker || !stickToBottomRef.current || visualItems.length === 0) return
    const frame = requestAnimationFrame(() => {
      virtuosoRef.current?.scrollToIndex({
        index: firstItemIndex + visualItems.length - 1,
        align: 'end',
        behavior: 'auto',
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [liveTailMarker, flipped, firstItemIndex, visualItems.length])

  const listComponents = useMemo(() => ({
    Header: () => flipped ? (
      <div className="px-4 py-3 text-center text-xs text-zinc-600 border-b border-zinc-900">
        {loading ? 'Загружаю…' : exhausted ? `Всё загружено (${items.length})` : 'Прокрутите вверх — ещё'}
      </div>
    ) : null,
    Footer: () => (
      <>
        {platform === 'telegram' && liveFetchJobs.length > 0 && (
          <LiveFetchFooter jobs={liveFetchJobs} liveCount={liveTailItems.length} searchActive={searchActive} />
        )}
        {!flipped && !searchActive && (
          <div className="px-4 py-3 text-center text-xs text-zinc-600 border-t border-zinc-900">
            {loading ? 'Загружаю…' : exhausted ? `Всё загружено (${items.length})` : 'Прокрутите вниз — ещё'}
          </div>
        )}
      </>
    ),
  }), [flipped, loading, exhausted, items.length, platform, liveFetchJobs, liveTailItems.length, searchActive])

  function runSearch(mode) {
    if (!query.trim()) {
      setSearchActive(false)
      reset()
      return
    }
    if (mode) setSearchMode(mode)
    setSemLimit(SEM_PAGE)   // fresh search starts from page 1
    setSearchActive(true)
    reset()
    setExhausted(false)
  }

  // Bumps the semantic-search ceiling and re-fires the query. Reset()
  // followed by exhausted=false triggers loadPage on the next render
  // through the existing items.length===0 effect.
  function loadMoreSemantic() {
    setSemLimit(n => n + SEM_PAGE)
    reset()
    setExhausted(false)
  }

  function clearSearch() {
    setQuery('')
    setSearchActive(false)
    reset()
  }

  const setMessageExpanded = useCallback((id, expanded) => {
    setExpandedIds(prev => {
      const has = prev.has(id)
      if (has === expanded) return prev
      const next = new Set(prev)
      if (expanded) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  const isForum = topics.length > 1
  // Single-topic chat: show one informational chip with the topic name so the
  // user knows messages are scoped to it (per-source clarity), but nothing
  // to switch — same UX as no chips for a personal chat.
  const showTopicRow = topics.length >= 1 && platform === 'telegram'

  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950 overflow-hidden">
      <div className="px-3 py-2 border-b border-zinc-800 flex items-center gap-2">
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => {
            if (e.key !== 'Enter') return
            // Cmd/Ctrl+Enter → semantic, plain Enter → FTS (matches the
            // visual order of buttons: FTS first, Semantic on the right).
            runSearch(e.metaKey || e.ctrlKey ? 'sem' : 'fts')
          }}
          placeholder="Поиск по транскриптам и тексту…  (Enter = FTS, ⌘+Enter = Semantic)"
          className="bg-zinc-900 border border-zinc-700 rounded-md px-3 py-1.5 text-sm flex-1 placeholder-zinc-500 focus:outline-none focus:border-zinc-500"
        />
        {searchActive && (
          <button onClick={clearSearch} className="text-xs text-zinc-500 hover:text-zinc-300 inline-flex items-center gap-1">
            <X size={12} /> очистить
          </button>
        )}
        <FiltersButton
          selected={selectedTypes}
          onChange={setSelectedTypes}
          breakdown={typeBreakdown}
        />
        <button
          onClick={() => runSearch('fts')}
          className={`text-xs px-3 py-1.5 rounded-md ${
            searchActive && searchMode === 'fts'
              ? 'bg-zinc-700 text-zinc-100'
              : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
          }`}
          title="Полнотекстовый поиск (FTS5) — точные слова, нечувствителен к смыслу"
        >FTS</button>
        <button
          onClick={() => runSearch('sem')}
          className={`text-xs px-3 py-1.5 rounded-md ${
            searchActive && searchMode === 'sem'
              ? 'bg-emerald-700 text-white'
              : 'bg-emerald-900/60 text-emerald-200 hover:bg-emerald-800/80'
          }`}
          title="Семантический поиск (Gemini embeddings + FTS, RRF). Длинный текст — нормально."
        ><span className="inline-flex items-center gap-1"><Sparkles size={13} /> Семантика</span></button>
      </div>

      {!searchActive && (
        <div className="px-3 py-1.5 border-b border-zinc-800 flex items-center gap-2 text-xs">
          <span className="text-zinc-500 shrink-0">Сортировка</span>
          <button
            onClick={() => setDateSort(v => (v === 'asc' ? 'desc' : 'asc'))}
            className="px-2.5 py-1 rounded-md bg-zinc-900 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 inline-flex items-center gap-1.5"
            title={dateSort === 'asc'
              ? 'Старые сверху, новые снизу'
              : 'Новые сверху, старые снизу'}
          >
            <span>Дата</span>
            <span className="tabular-nums text-zinc-500">{dateSort === 'asc' ? '↑' : '↓'}</span>
          </button>
        </div>
      )}

      {!searchActive && showTopicRow && isForum && (
        <div className="px-3 py-2 border-b border-zinc-800 flex items-center gap-1 flex-wrap">
          <TopicChip
            active={selectedTopic === null}
            onClick={() => setSelectedTopic(null)}
            label="Все темы"
            count={topics.reduce((sum, t) => sum + t.count, 0)}
          />
          {topics.map(t => (
            <TopicChip
              key={t.id}
              active={selectedTopic === t.id}
              onClick={() => setSelectedTopic(t.id)}
              label={t.title || `#${t.id}`}
              count={t.count}
            />
          ))}
        </div>
      )}

      {!searchActive && showTopicRow && !isForum && topics[0]?.title && (
        <div className="px-3 py-1.5 border-b border-zinc-800 text-zinc-500" style={{ fontSize: '14px' }}>
          Тема: <span className="text-zinc-300">{topics[0].title}</span>
        </div>
      )}

      {searchActive && searchMode === 'sem' && (
        <div className="px-3 py-2 border-b border-zinc-800 flex items-center gap-3 text-xs">
          <span className="text-zinc-400 shrink-0">Порог релевантности</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={semThreshold}
            onChange={e => setSemThreshold(parseFloat(e.target.value))}
            className="flex-1 accent-emerald-500"
            title="Скрыть результаты с косинусной близостью ниже этого значения"
          />
          <span className="text-zinc-300 tabular-nums shrink-0 w-10 text-right">
            {semThreshold.toFixed(2)}
          </span>
          <span className="text-zinc-500 shrink-0">
            показано {visibleCount(items, semThreshold)} / {items.length}
          </span>
        </div>
      )}

      {/* Bulk action bar — appears only on Telegram when ≥1 message is
          selected. Engine selector governs voice/video transcription;
          photo/docs ignore it. «перевести N» fires one media_only job over
          the picked media rows; «копировать N» joins their captions. */}
      {canProcess && sel.size > 0 && (
        <div className="px-3 py-2 border-b border-zinc-800 bg-zinc-900/60 flex items-center gap-2 flex-wrap">
          <span className="text-zinc-300 shrink-0" style={{ fontSize: '14px' }}>
            Выбрано: <span className="tabular-nums text-zinc-100">{sel.size}</span>
          </span>
          <span className="text-zinc-700">·</span>
          <span className="text-zinc-500 shrink-0" style={{ fontSize: '13px' }}>движок</span>
          <div className="w-[150px] shrink-0">
            <Select value={bulkEngine} onChange={setBulkEngine} options={ENGINES} compact hideHint />
          </div>
          <button
            onClick={() => {
              const picked = items.filter(it => sel.has(it.id) && MEDIA_KIND_BY_TYPE[it.type])
              runTranscribe(picked)
            }}
            disabled={mediaJobRunning}
            className="px-3 py-1.5 rounded-md bg-emerald-700 text-white hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
            style={{ fontSize: '14px' }}
            title="Распознать выбранные медиа: голос → расшифровка, фото → описание, документы → извлечение текста"
          >
            <Sparkles size={14} /> обработать{(() => {
              const n = items.filter(it => sel.has(it.id) && MEDIA_KIND_BY_TYPE[it.type]).length
              return n ? ` · ${n}` : ''
            })()}
          </button>
          <button
            onClick={() => runCopy(items.filter(it => sel.has(it.id)))}
            className="px-3 py-1.5 rounded-md text-zinc-300 hover:bg-zinc-800 flex items-center gap-1.5"
            style={{ fontSize: '14px' }}
            title="Скопировать текст / расшифровки выбранных сообщений"
          >
            <Copy size={14} /> копировать · {sel.size}
          </button>
          <button
            onClick={() => sel.clear()}
            className="text-zinc-500 hover:text-zinc-300 ml-1 inline-flex items-center gap-1"
            style={{ fontSize: '13px' }}
          ><X size={12} /> снять</button>
          {mediaJobRunning && (
            <span className="text-amber-400/90 flex items-center gap-1.5 ml-1" style={{ fontSize: '13px' }}>
              <Loader2 size={13} className="animate-spin" /> идёт перевод…
            </span>
          )}
          {copyToast && (
            <span className="text-zinc-400 ml-1" style={{ fontSize: '13px' }}>{copyToast}</span>
          )}
        </div>
      )}

      <div data-chat-virtual-list className="h-[480px] min-h-0">
        {displayedItems.length === 0 ? (
          <div className="h-full px-4 py-8 flex items-center justify-center text-center text-zinc-600 italic text-sm">
            {loading
              ? 'Загружаю…'
              : searchActive
                ? 'Ничего не найдено'
                : 'В этой коллекции нет сообщений (или они ещё не загружены)'}
          </div>
        ) : (
          <Virtuoso
            key={`${sourceId}:${listEpoch}:${searchActive ? searchMode : 'feed'}`}
            ref={virtuosoRef}
            data={displayedItems}
            firstItemIndex={firstItemIndex}
            initialTopMostItemIndex={flipped ? displayedItems.length - 1 : 0}
            alignToBottom={flipped}
            followOutput={flipped ? (isAtBottom => isAtBottom ? 'auto' : false) : false}
            atBottomThreshold={64}
            atBottomStateChange={atBottom => { stickToBottomRef.current = atBottom }}
            startReached={() => {
              if (flipped && !searchActive && !loading && !exhausted) loadPage()
            }}
            endReached={() => {
              if (!flipped && !searchActive && !loading && !exhausted) loadPage()
            }}
            defaultItemHeight={72}
            increaseViewportBy={240}
            computeItemKey={(index, item) => item?.id ?? index}
            components={listComponents}
            itemContent={(_index, it) => (
              <MessageRow
                item={it}
                highlight={searchActive ? query : null}
                platform={platform}
                selectable={canProcess && !it.__live}
                selected={!it.__live && sel.has(it.id)}
                onToggleSelect={(e) => {
                  if (e.shiftKey) sel.rangeTo(it.id, orderedIds)
                  else sel.toggle(it.id)
                }}
                live={!!it.__live}
                processing={processingByExtId.get(String(it.external_id)) || null}
                expanded={expandedIds.has(it.id)}
                onExpandedChange={expanded => setMessageExpanded(it.id, expanded)}
                onTranscribe={!it.__live && MEDIA_KIND_BY_TYPE[it.type] ? () => runTranscribe([it]) : null}
                onCopy={!it.__live ? () => runCopy([it]) : null}
              />
            )}
          />
        )}
      </div>

      {searchActive && exhausted && items.length > 0 && (
        <div className="px-4 py-3 text-center text-xs text-zinc-600 border-t border-zinc-900">
          {searchMode === 'sem' ? (
            items.length >= semLimit ? (
              <button
                onClick={loadMoreSemantic}
                disabled={loading}
                className="px-4 py-1.5 rounded-md bg-emerald-900/60 text-emerald-200 hover:bg-emerald-800/80 disabled:opacity-50"
              >
                {loading ? 'Загружаю…' : `Показать ещё +${SEM_PAGE}`}
              </button>
            ) : (
              <>Всего {items.length} результатов · больше нет</>
            )
          ) : (
            items.length >= FTS_LIMIT
              ? `Показаны первые ${FTS_LIMIT} — уточните запрос, чтобы сузить`
              : `${items.length} результатов`
          )}
        </div>
      )}
    </div>
  )
}

// How many rows pass the cosine threshold — used in the slider header so
// the user knows what dragging the slider actually does without scrolling.
function visibleCount(items, threshold) {
  let n = 0
  for (const it of items) {
    if (it._cos == null || it._cos >= threshold) n++
  }
  return n
}

function compareNewestFirst(a, b) {
  const at = a?.published_at || 0
  const bt = b?.published_at || 0
  if (bt !== at) return bt - at
  return (Number(b?.external_id) || 0) - (Number(a?.external_id) || 0)
}

function LiveFetchFooter({ jobs, liveCount, searchActive }) {
  const done = jobs.reduce((sum, j) => sum + Number(j.items_done || 0), 0)
  const total = jobs.reduce((sum, j) => sum + Number(j.items_total || 0), 0)
  const label = searchActive ? 'Загрузка новых сообщений идёт в фоне' : liveFetchLabel(jobs)
  const currentLine = liveFetchCurrentLine(jobs)
  return (
    <div className="sticky bottom-0 z-10 border-t border-emerald-900/40 bg-zinc-950/95 backdrop-blur px-4 py-2 flex items-start gap-2" style={{ fontSize: '13px' }}>
      <Loader2 size={14} className="animate-spin shrink-0 mt-0.5 text-emerald-300" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0 text-emerald-300">
          <span className="truncate">{label}</span>
          <span className="ml-auto flex items-center gap-2 text-zinc-500 shrink-0 tabular-nums">
            {liveCount > 0 && <span className="text-emerald-300">+{liveCount}</span>}
            {done > 0 && <span>{done.toLocaleString('ru-RU')}{total > 0 ? ` / ${total.toLocaleString('ru-RU')}` : ''}</span>}
          </span>
        </div>
        {currentLine && (
          <div className="mt-0.5 text-zinc-500 truncate">
            {currentLine}
          </div>
        )}
      </div>
    </div>
  )
}

function liveFetchLabel(jobs) {
  const hasMedia = jobs.some(j => j?.params?.process_voice || j?.params?.process_photo || j?.params?.process_docs)
  const hasComments = jobs.some(j => j?.params?.include_comments)
  if (hasMedia && hasComments) return 'Парсятся новые сообщения, медиа и комментарии'
  if (hasMedia) return 'Парсятся новые сообщения и медиа'
  if (hasComments) return 'Парсятся новые сообщения и комментарии'
  return 'Парсятся текстовые сообщения'
}

function liveFetchCurrentLine(jobs) {
  const itemByMsgId = new Map()
  for (const j of jobs) {
    const rows = Array.isArray(j?.tg_live_items) ? j.tg_live_items : []
    for (const row of rows) {
      if (row?.external_id != null) itemByMsgId.set(String(row.external_id), row)
    }
  }

  for (const j of jobs) {
    const media = currentMediaPhase(j)
    if (media) {
      const item = itemByMsgId.get(String(media.msg_id))
      const itemText = item ? compactItemText(item, 52) : ''
      return `сейчас: #${media.msg_id} · ${media.label} · ${media.stage}${itemText ? ` · ${itemText}` : ''}`
    }
  }

  for (const j of jobs) {
    if (j?.tg_current_item) {
      return `сейчас: ${formatCurrentItem(j.tg_current_item)}`
    }
  }

  const resolving = jobs.some(j => Number(j?.resolve_scanned || 0) > 0)
  return resolving ? 'сейчас: ищу чат в Telegram' : 'сейчас: жду первое сообщение'
}

function currentMediaPhase(job) {
  const mp = job?.media_phase
  if (!mp) return null
  const defs = [
    ['voice', 'голос'],
    ['photo', 'фото'],
    ['pdf', 'документ'],
  ]
  for (const [kind, label] of defs) {
    const cur = mp[kind]?.current
    if (cur?.msg_id != null) {
      return {
        msg_id: cur.msg_id,
        label,
        stage: STAGE_LABEL[cur.stage] || cur.stage || 'обработка',
      }
    }
  }
  return null
}

function formatCurrentItem(item) {
  const id = item?.external_id != null ? `#${item.external_id}` : '#?'
  const type = TYPE_LABEL[item?.type] || item?.type || 'Сообщение'
  const text = compactItemText(item, 72)
  return [id, type, text].filter(Boolean).join(' · ')
}

function compactItemText(item, maxLen) {
  const sender = item?.sender ? String(item.sender).trim() : ''
  const body = String(item?.caption || '').replace(/\s+/g, ' ').trim()
  const fallback = body || itemPlaceholder(item)
  const text = [sender, fallback].filter(Boolean).join(': ')
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text
}

function itemPlaceholder(item) {
  const dur = item?.duration_seconds || item?.duration
  if (item?.type === 'voice') return `голосовое${dur ? ` · ${Math.round(dur)}s` : ''}`
  if (item?.type === 'audio') return `аудио${dur ? ` · ${Math.round(dur)}s` : ''}`
  if (item?.type === 'video') return 'видео'
  if (item?.type === 'photo') return 'фото'
  if (item?.type === 'document') return 'документ'
  if (item?.type === 'poll') return 'опрос'
  if (item?.type === 'sticker') return 'стикер'
  if (item?.type === 'gif') return 'GIF'
  if (item?.type === 'service') return 'системное сообщение'
  return ''
}

// Color band for cosine similarity. Tuned for Gemini RETRIEVAL embeddings on
// Russian chat text — boundaries don't generalise to other models.
function confidenceColor(cos) {
  if (cos == null) return null
  if (cos >= 0.70) return { bg: 'bg-emerald-500',  text: 'text-emerald-300', label: 'strong' }
  if (cos >= 0.55) return { bg: 'bg-yellow-500',   text: 'text-yellow-300',  label: 'medium' }
  return                    { bg: 'bg-rose-500',   text: 'text-rose-300',    label: 'weak' }
}

function TopicChip({ active, onClick, label, count }) {
  return (
    <button
      onClick={onClick}
      className={`text-xs px-2.5 py-1 rounded-md flex items-center gap-1.5 ${
        active
          ? 'bg-zinc-200 text-zinc-900'
          : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
      }`}
      title={label}
    >
      <span className="truncate max-w-[180px]">{label}</span>
      <span className={`tabular-nums ${active ? 'text-zinc-600' : 'text-zinc-600'}`}>
        {count.toLocaleString('ru-RU')}
      </span>
    </button>
  )
}

/**
 * "Фильтры" — popover button. Multi-select checkbox list of content types.
 * Empty selection = "all". Button label shows summary so the user knows the
 * current scope without opening it.
 *
 * Outside-click closes the popover (mirrors `Select.jsx` pattern).
 */
function FiltersButton({ selected, onChange, breakdown }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)

  useEffect(() => {
    if (!open) return
    function onDoc(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const counts = Object.fromEntries((breakdown || []).map(b => [b.type, b.count]))
  const totalShown = selected.size === 0
    ? Object.values(counts).reduce((a, b) => a + b, 0)
    : [...selected].reduce((a, t) => a + (counts[t] || 0), 0)

  const summary = selected.size === 0
    ? 'Все типы'
    : selected.size === 1
      ? TYPE_LABEL[[...selected][0]] || [...selected][0]
      : `${selected.size} типа`

  function toggle(t) {
    const next = new Set(selected)
    if (next.has(t)) next.delete(t); else next.add(t)
    onChange(next)
  }

  return (
    <div className="relative" ref={wrapRef}>
      <button
        onClick={() => setOpen(o => !o)}
        className={`text-xs px-3 py-1.5 rounded-md flex items-center gap-2 ${
          selected.size > 0
            ? 'bg-zinc-200 text-zinc-900'
            : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
        }`}
      >
        <span>Фильтры</span>
        <span className="text-zinc-500 tabular-nums">
          {summary} · {totalShown.toLocaleString('ru-RU')}
        </span>
        <span className={`text-zinc-500 transition-transform ${open ? 'rotate-180' : ''}`}>▾</span>
      </button>
      {open && (
        <div className="absolute right-0 mt-1 w-64 z-50 rounded-md border border-zinc-700 bg-zinc-900 shadow-xl py-1">
          <div className="px-3 py-1.5 flex items-center justify-between">
            <div className="text-xs uppercase tracking-wider text-zinc-500">Типы контента</div>
            {selected.size > 0 && (
              <button
                onClick={() => onChange(new Set())}
                className="text-zinc-500 hover:text-zinc-200"
                style={{ fontSize: '14px' }}
              >Сбросить</button>
            )}
          </div>
          {ALL_TYPES.map(t => {
            const n = counts[t] || 0
            const isOn = selected.has(t)
            return (
              <label
                key={t}
                className={`px-3 py-1.5 flex items-center gap-3 cursor-pointer ${
                  n === 0 ? 'opacity-40' : 'hover:bg-zinc-800'
                }`}
              >
                <Checkbox
                  checked={isOn}
                  onChange={() => toggle(t)}
                  size="sm"
                />
                <span className="text-zinc-300 flex-1">
                  <span className="mr-1">{TYPE_ICON[t]}</span>
                  {TYPE_LABEL[t] || t}
                </span>
                <span className="text-zinc-500 tabular-nums" style={{ fontSize: '14px' }}>
                  {n.toLocaleString('ru-RU')}
                </span>
              </label>
            )
          })}
        </div>
      )}
    </div>
  )
}

const MessageRow = React.memo(function MessageRow({
  item, highlight, platform = 'telegram',
  selectable = false, selected = false, onToggleSelect = null,
  live = false, processing = null, onTranscribe = null, onCopy = null,
  expanded = false, onExpandedChange = null,
}) {
  const isYoutube   = platform === 'youtube'
  const isTiktok    = platform === 'tiktok'
  const isInstagram = platform === 'instagram'
  const isStreamingPlatform = isYoutube || isTiktok || isInstagram
  const dt = item.published_at ? new Date(item.published_at * 1000) : null
  const date = !dt
    ? '—'
    : isYoutube
      ? dt.toLocaleDateString('ru-RU', { month: 'short', year: '2-digit' }).replace('.', '')
      : dt.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })
  const icon = TYPE_ICON[item.type] || '·'
  const text = (item.caption || '').trim()
  // "No file" warning is for items the user might want to re-download.
  // Items already processed by AI (voice transcribed, photo described, PDF
  // extracted) have transcribe_status='done' and `caption` carries the
  // resulting text — the raw media file is no longer load-bearing, so
  // suppress the warning. Same for items that have a transcript_path.
  const aiProcessed = item.transcribe_status === 'done' || !!item.transcript_path
  const noFile = !live && !isStreamingPlatform && !!item.has_media && !item.media_path && !aiProcessed
  const sender = isStreamingPlatform
    ? null
    : (item.sender || '(unknown)')

  const displayId = String(item.external_id || '').replace(/^(reel|post):/, '')

  const placeholder = !isYoutube && !isTiktok && !text ? (
    item.type === 'photo'    ? (isInstagram ? 'Фото-пост' : 'Фото без подписи')
    : item.type === 'video'  ? (isInstagram ? 'Reel без подписи' : 'Видео без подписи')
    : item.type === 'voice'  ? `Голосовое сообщение${item.duration ? ` · ${Math.round(item.duration)}s` : ''}`
    : item.type === 'audio'  ? `Аудио${item.duration ? `· ${Math.round(item.duration)}s` : ''}`
    : item.type === 'document' ? 'Документ'
    : item.type === 'poll'   ? 'Опрос'
    : item.type === 'sticker'? 'Стикер'
    : item.type === 'gif'    ? 'GIF'
    : item.type === 'service'? 'Системное сообщение'
    : item.type === 'other'  ? 'Стикер / системное сообщение (старый fetch)'
    : ''
  ) : ''

  // Semantic-search confidence badge: cosine-similarity score with color band.
  // FTS branch was removed — all semantic hits are vec-only now, so we don't
  // surface the branch icon anymore.
  const conf = confidenceColor(item._cos)

  // Media-row affordances (Telegram on-demand processing). A row offers
  // «перевести» when it carries an AI-processable medium (voice/video/photo/
  // document) — onTranscribe is passed only for those by the parent. It's
  // «already done» when AI text is present; we still allow re-processing (per
  // the user's «заново» choice), so the button stays — relabelled.
  const isMediaRow = selectable && !!onTranscribe
  // Kind-specific verb/icon (расшифровать/описать/извлечь). Null for non-media
  // rows — the button is only rendered when both isMediaRow and this are set.
  const mediaAction = mediaActionForType(item.type)
  const isProcessing = !!processing
  const stageLabel = processing ? (STAGE_LABEL[processing.stage] || processing.stage || 'обработка') : null

  // Long-text expand/collapse. Plain (non-search) bodies over EXPAND_LIMIT get
  // a «Раскрыть» control; once open, a sticky «Свернуть» rides the top of the
  // message so the user can re-collapse without scrolling back down through a
  // wall of text. Search results keep their own Highlighted truncation (the
  // user is scanning for a hit, not reading the whole body), so the control is
  // plain-view only.
  const isLong = !highlight && !!text && text.length > EXPAND_LIMIT

  return (
    <div data-chat-message-row data-message-id={item.id} className={`px-4 py-2 hover:bg-zinc-900/60 flex gap-3 ${selected ? 'bg-emerald-950/20' : ''}`}>
      {/* Left checkbox gutter — Telegram only. Click toggles; Shift-click fills
          the range (parent reads e.shiftKey). `passive` lets the wrapper own
          the click so Shift is observable. */}
      {selectable && (
        <div
          role="button"
          tabIndex={0}
          onClick={(e) => { e.stopPropagation(); onToggleSelect && onToggleSelect(e) }}
          onKeyDown={(e) => {
            if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onToggleSelect && onToggleSelect(e) }
          }}
          className="pt-0.5 shrink-0 cursor-pointer select-none"
          title="Выбрать (Shift — диапазон)"
        >
          <Checkbox checked={selected} onChange={() => {}} size="sm" passive />
        </div>
      )}

      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-3">
          <span className="text-zinc-500 shrink-0 whitespace-nowrap tabular-nums" style={{ fontSize: '14px' }}>{date}</span>
          <span className="text-zinc-400 shrink-0">{icon}</span>
          {/* truncate + max-w: длинное display-name отправителя не должно
              выталкивать #id / cos-бейдж за край строки (гориз. скролл). */}
          {sender && <span className="text-zinc-300 font-medium truncate max-w-[220px]">{sender}</span>}
          {(isYoutube || isTiktok) && item.title && (
            <span className="text-zinc-200 truncate flex-1" title={item.title}>{item.title}</span>
          )}
          <div className="ml-auto flex items-center gap-2 shrink-0">
            {conf && (
              <span
                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded ${conf.text} bg-zinc-900 border border-zinc-800`}
                style={{ fontSize: '11px' }}
                title={`Косинусная близость: ${item._cos.toFixed(3)} (${conf.label})`}
              >
                <span className={`inline-block w-1.5 h-1.5 rounded-full ${conf.bg}`} />
                {item._cos.toFixed(2)}
              </span>
            )}
            <span className="text-zinc-700" style={{ fontSize: '14px' }}>#{displayId}</span>
          </div>
        </div>
        {text && (
          <div className="mt-1">
            {/* Sticky «Свернуть» — only while expanded. Rides the top of the
                scroll viewport (the list is `max-h-[480px] overflow-auto`), so
                after reading a long body the user collapses it in place instead
                of scrolling all the way back down to a bottom button. */}
            {isLong && expanded && (
              <div className="sticky top-0 z-10 py-1 mb-1 bg-zinc-950/95 backdrop-blur-sm border-b border-zinc-800/60 flex">
                <button
                  onClick={(e) => { e.stopPropagation(); onExpandedChange?.(false) }}
                  className="inline-flex items-center gap-1 text-zinc-400 hover:text-zinc-200"
                  style={{ fontSize: '13px' }}
                >
                  <ChevronUp size={14} /> Свернуть
                </button>
              </div>
            )}
            <div className="text-zinc-300 whitespace-pre-wrap break-words">
              {highlight
                ? <Highlighted text={text} q={highlight} />
                : (isLong && !expanded ? truncate(text, EXPAND_LIMIT) : text)}
            </div>
            {isLong && !expanded && (
              <button
                onClick={(e) => { e.stopPropagation(); onExpandedChange?.(true) }}
                className="mt-0.5 inline-flex items-center gap-1 text-zinc-400 hover:text-zinc-200"
                style={{ fontSize: '13px' }}
              >
                <ChevronDown size={14} /> Раскрыть
              </button>
            )}
          </div>
        )}
        {!text && placeholder && (
          <div className="text-zinc-500 italic mt-0.5" style={{ fontSize: '14px' }}>
            {placeholder}
          </div>
        )}
        {noFile && (
          <div className="text-amber-400 mt-1" style={{ fontSize: '14px' }}>
            ⚠ Только метаданные ({TYPE_LABEL[item.type] || item.type}{item.type === 'poll' ? '' : ', файл не загружен'})
          </div>
        )}
        {item.transcript_path && (
          <div className="text-emerald-400 mt-1" style={{ fontSize: '14px' }}>
            ✓ Транскрипт сохранён
          </div>
        )}
        <ReactionsRow reactions={item.reactions} />
      </div>

      {/* Per-row action column — Telegram only. Loader while this exact message
          is in flight (matched by media_phase.current.msg_id upstream), else
          «перевести» (media rows) + «копировать» (all rows). Hover-revealed to
          keep the list calm; the loader stays visible regardless of hover. */}
      {(selectable || isProcessing) && (
        <div className="shrink-0 flex items-center gap-1.5 self-start pt-0.5">
          {isProcessing ? (
            <span className="inline-flex items-center gap-1.5 text-emerald-300" style={{ fontSize: '13px' }}>
              <Loader2 size={14} className="animate-spin" />
              <span className="tabular-nums">{stageLabel}</span>
            </span>
          ) : (
            <>
              {isMediaRow && mediaAction && (
                <button
                  onClick={(e) => { e.stopPropagation(); onTranscribe && onTranscribe() }}
                  className="px-2 py-0.5 rounded text-emerald-300 hover:bg-emerald-900/30 border border-emerald-800/40 flex items-center gap-1 opacity-60 hover:opacity-100"
                  style={{ fontSize: '12px' }}
                  title={aiProcessed
                    ? `Обработать заново (другим движком / повтор): ${mediaAction.verb}`
                    : `${mediaAction.verb[0].toUpperCase()}${mediaAction.verb.slice(1)} это сообщение`}
                >
                  {aiProcessed ? <RotateCw size={12} /> : <mediaAction.Icon size={12} />}
                  {aiProcessed ? 'заново' : mediaAction.verb}
                </button>
              )}
              <button
                onClick={(e) => { e.stopPropagation(); onCopy && onCopy() }}
                className="px-2 py-0.5 rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 flex items-center gap-1 opacity-60 hover:opacity-100"
                style={{ fontSize: '12px' }}
                title="Скопировать текст / расшифровку этого сообщения"
              >
                <Copy size={12} /> копировать
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
})

// Compact chip-row for parsed Telegram reactions. Reads the JSON-stringified
// list from items.reactions; null means "not parsed by this fetch", empty
// list means "checked, no reactions". We hide both — empty rows would just
// add noise. Custom emoji (custom:<doc_id>) are shown as a generic 🎴 since
// we don't fetch the actual sticker set; the count still travels with the
// chip so re-rank-by-popularity works.
function ReactionsRow({ reactions }) {
  let arr = null
  try {
    arr = typeof reactions === 'string' ? JSON.parse(reactions) : reactions
  } catch { arr = null }
  if (!Array.isArray(arr) || arr.length === 0) return null
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {arr.map((r, i) => {
        const e = String(r.e || '')
        const display = e.startsWith('custom:') ? '🎴' : e
        const n = Number(r.n) || 0
        return (
          <span key={i}
                className="inline-flex items-center gap-1 rounded-full border border-zinc-800 bg-zinc-900/60 px-1.5 py-0.5 text-zinc-300"
                style={{ fontSize: '12px' }}
                title={e.startsWith('custom:') ? `custom emoji ${e.slice(7)} · ${n}` : `${e} · ${n}`}>
            <span>{display}</span>
            <span className="tabular-nums text-zinc-400">{n}</span>
          </span>
        )
      })}
    </div>
  )
}

function truncate(s, n) {
  if (!s) return ''
  return s.length > n ? s.slice(0, n) + '…' : s
}

function Highlighted({ text, q }) {
  if (!q) return <span>{truncate(text, 800)}</span>
  const parts = text.split(new RegExp(`(${escapeRe(q)})`, 'ig'))
  return (
    <span>
      {parts.map((p, i) =>
        p.toLowerCase() === q.toLowerCase()
          ? <mark key={i} className="bg-yellow-500/30 text-yellow-200 px-0.5 rounded">{p}</mark>
          : <span key={i}>{i === 0 ? truncate(p, 400) : (i === parts.length - 1 ? truncate(p, 400) : p)}</span>,
      )}
    </span>
  )
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

export default React.memo(ChatView)
