import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { Virtuoso } from 'react-virtuoso'
import { ChevronDown, ChevronRight, ChevronUp, Minus, TriangleAlert } from 'lucide-react'
import { PLATFORMS } from '../lib/detect'
import { toggleScreen, useStore } from '../lib/store'
import { useSources, useSourcesLoaded } from '../lib/sources'
import { useJobsSelector } from '../lib/jobs'
import { sameArrayItems } from '../lib/jobSelectorCore.mjs'
import PlatformLogo from './PlatformLogo'
import Avatar from './Avatar'
import { useTelegramSelection } from '../lib/telegramSelection'
import SidebarContextMenu from './SidebarContextMenu'
import {
  isTelegramSourceUnavailable,
  telegramSourceHealthTitle,
} from '../lib/telegramSourceHealth'

// Keep every first-class platform reachable even when its source list is
// empty. The same names are the platform-level screen routes.
const PLATFORM_GROUP_ORDER = [
  'telegram',
  'youtube',
  'boosty',
  'instagram',
  'reddit',
  'tiktok',
  'twitter',
]

const COLLAPSED_KEY = 'sc-other-collapsed'

function loadCollapsedSet() {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY)
    if (!raw) return new Set()
    return new Set(JSON.parse(raw))
  } catch { return new Set() }
}

export default function LibrarySidebar() {
  const sources = useSources()
  const loaded  = useSourcesLoaded()
  const screen = useStore(s => s.screen)
  const grouped = useMemo(() => group(sources), [sources])
  const activeSourceId = screen.name === 'source-detail' ? screen.payload?.sourceId : null
  const jobs = useJobsSelector(
    list => list.filter(job => (
      (job?.type === 'tg_index' || job?.type === 'yt_index')
      && (job.status === 'running' || job.status === 'awaiting_ai' || job.status === 'cancelling')
      && job.source_id != null
    )),
    sameArrayItems,
  )
  const liveIndexBySource = useMemo(() => {
    const map = new Map()
    for (const job of jobs) {
      map.set(Number(job.source_id), job)
    }
    return map
  }, [jobs])
  // Сохраняем какие «Прочее»-подгруппы свёрнуты — между перезапусками. Свёрнуто
  // по умолчанию (пустой Set значит «всё свёрнуто»: см. PlatformGroup).
  const [collapsed, setCollapsed] = useState(loadCollapsedSet)
  const sidebarRef = useRef(null)
  const virtuosoRef = useRef(null)
  const [platformPositions, setPlatformPositions] = useState({})
  const [visiblePlatforms, setVisiblePlatforms] = useState({})
  const [widePlatformPanel, setWidePlatformPanel] = useState(false)

  // Multi-select state lives in a small dedicated module — sidebar reads it,
  // the context-menu component reads it, and we want the same selection
  // surviving an Activity → return navigation. See lib/telegramSelection.js.
  const selection = useTelegramSelection()

  // ─── Visible Telegram order, for shift-range selection ──────────────
  // Build the flat ordered id list exactly as rendered (explicit list first,
  // then Прочее — but only when its toggle is expanded; collapsed «Прочее»
  // sources can't take part in shift-ranges because the user can't see them).
  // Uses the SAME splitSources() helper PlatformGroup renders with, so the two
  // never disagree on which rows are where or in what order.
  const tgOrderedIds = useMemo(() => {
    const { explicit, other } = splitSources(grouped.telegram || [], 'telegram')
    const otherCollapsed = !collapsed.has('telegram')
    const visible = otherCollapsed ? explicit : [...explicit, ...other]
    return visible.map(s => s.id)
  }, [grouped.telegram, collapsed])

  // Drop ids that vanished from the source list (e.g. after delete) so the
  // selection stays consistent with what's actually rendered.
  useEffect(() => {
    const known = new Set(tgOrderedIds)
    selection.pruneTo(known)
  }, [tgOrderedIds, selection.pruneTo])

  const sidebarModel = useMemo(() => {
    const extra = Object.keys(grouped).filter(platform => !PLATFORM_GROUP_ORDER.includes(platform))
    const platforms = [...PLATFORM_GROUP_ORDER, ...extra]
    const rows = []
    const headerIndexes = new Map()
    const spans = new Map()
    for (const platform of platforms) {
      const items = grouped[platform] || []
      const start = rows.length
      headerIndexes.set(platform, start)
      rows.push({ kind: 'header', platform, items })
      const { explicit, other } = splitSources(items, platform)
      for (const source of explicit) rows.push({ kind: 'source', platform, source })
      if (other.length) {
        rows.push({ kind: 'other-toggle', platform, count: other.length })
        if (collapsed.has(platform)) {
          for (const source of other) rows.push({ kind: 'source', platform, source, secondary: true })
        }
      }
      spans.set(platform, { start, end: Math.max(start, rows.length - 1) })
    }
    return { rows, headerIndexes, spans }
  }, [grouped, collapsed])

  const handleRangeChanged = useCallback(({ startIndex, endIndex }) => {
    const nextPositions = {}
    const nextVisible = {}
    for (const platform of PLATFORM_GROUP_ORDER) {
      const header = sidebarModel.headerIndexes.get(platform)
      const span = sidebarModel.spans.get(platform)
      if (header == null || !span) continue
      nextPositions[platform] = header < startIndex ? 'up' : header > endIndex ? 'down' : 'visible'
      nextVisible[platform] = span.end >= startIndex && span.start <= endIndex
    }
    setPlatformPositions(prev => (
      PLATFORM_GROUP_ORDER.some(platform => prev[platform] !== nextPositions[platform])
        ? nextPositions : prev
    ))
    setVisiblePlatforms(prev => (
      PLATFORM_GROUP_ORDER.some(platform => prev[platform] !== nextVisible[platform])
        ? nextVisible : prev
    ))
  }, [sidebarModel])

  const updatePlatformPanelLayout = useCallback(() => {
    const wide = (sidebarRef.current?.clientWidth || 0) >= 340
    setWidePlatformPanel(prev => prev === wide ? prev : wide)
  }, [])

  useEffect(() => {
    updatePlatformPanelLayout()
    const observer = new ResizeObserver(() => {
      updatePlatformPanelLayout()
    })
    if (sidebarRef.current) observer.observe(sidebarRef.current)
    return () => observer.disconnect()
  }, [updatePlatformPanelLayout])

  const scrollToPlatform = useCallback((platform) => {
    const index = sidebarModel.headerIndexes.get(platform)
    if (index == null) return
    virtuosoRef.current?.scrollToIndex({ index, align: 'start', behavior: 'auto' })
  }, [sidebarModel])

  function toggleCollapsed(platform) {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(platform)) next.delete(platform); else next.add(platform)
      try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next])) } catch {}
      return next
    })
  }

  // ─── Context-menu state ───────────────────────────────────────────
  const [ctxMenu, setCtxMenu] = useState(null)   // { x, y, sourceIds } | null
  // Refs so the wrapper-level mouseup/blur handlers can read selection without
  // re-binding. Static contract: useEffect-wired listeners read from refs
  // rather than capturing state.
  const closeCtxMenu = useCallback(() => setCtxMenu(null), [])

  // Close on Esc / outside click — handled inside SidebarContextMenu itself.

  return (
    <aside
      ref={sidebarRef}
      className="border-r border-zinc-800 flex flex-col h-full min-h-0 min-w-0 max-w-full overflow-hidden"
    >
      <nav
        className={`shrink-0 grid gap-1 px-2 pt-2 pb-2 border-b border-zinc-800 ${
          widePlatformPanel ? 'grid-cols-6' : 'grid-cols-3'
        }`}
        aria-label="Платформы"
      >
        {PLATFORM_GROUP_ORDER.map(platform => (
          <PlatformShortcut
            key={platform}
            platform={platform}
            position={platformPositions[platform]}
            visible={!!visiblePlatforms[platform]}
            onOpen={() => toggleScreen(platform)}
            onScroll={() => scrollToPlatform(platform)}
          />
        ))}
      </nav>

      <div className="flex-1 min-h-0 min-w-0 px-2 pb-2">
        {/* Three states for the empty body:
            - !loaded → shimmer rows (waiting for first sourcesList resolve)
            - loaded + no sources → real "пусто" hint
            - loaded + sources    → normal grouped render below */}
        {!loaded && (
          <div className="space-y-1.5 px-1 py-1">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex items-center gap-2 px-2 py-1.5">
                <div className="w-5 h-5 rounded-full bg-zinc-800/80 animate-pulse shrink-0" />
                <div className="h-3 rounded bg-zinc-800/80 animate-pulse"
                     style={{ width: `${60 + ((i * 7) % 30)}%` }} />
              </div>
            ))}
          </div>
        )}
        {loaded && sources.length === 0 && (
          <div className="px-2 py-2 text-zinc-600 italic text-sm">
            No sources yet — paste a URL or @username
          </div>
        )}
        {loaded && (
          <Virtuoso
            ref={virtuosoRef}
            style={{ height: '100%' }}
            data={sidebarModel.rows}
            defaultItemHeight={34}
            increaseViewportBy={100}
            rangeChanged={handleRangeChanged}
            computeItemKey={(index, row) => row.kind === 'source'
              ? `source:${row.source.id}`
              : `${row.kind}:${row.platform}:${index}`}
            itemContent={(_index, row) => {
              if (row.kind === 'header') {
                return (
                  <PlatformHeaderRow
                    platform={row.platform}
                    items={row.items}
                    active={screen.name === row.platform}
                  />
                )
              }
              if (row.kind === 'other-toggle') {
                return (
                  <OtherToggleRow
                    platform={row.platform}
                    count={row.count}
                    expanded={collapsed.has(row.platform)}
                    onToggle={() => toggleCollapsed(row.platform)}
                  />
                )
              }
              const content = (
                <SourceRow
                  source={row.source}
                  active={row.source.id === activeSourceId}
                  isTelegram={row.platform === 'telegram'}
                  selection={selection}
                  tgOrderedIds={tgOrderedIds}
                  indexJob={liveIndexBySource?.get(Number(row.source.id))}
                  onContextMenu={(payload) => setCtxMenu(payload)}
                />
              )
              return row.secondary
                ? <div className="ml-2 border-l border-zinc-800 pl-1">{content}</div>
                : content
            }}
          />
        )}
      </div>
      {ctxMenu && (
        <SidebarContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          sourceIds={ctxMenu.sourceIds}
          onClose={closeCtxMenu}
        />
      )}
    </aside>
  )
}

function PlatformHeaderRow({ platform, items, active }) {
  const meta = PLATFORMS[platform]
  const unavailableCount = platform === 'telegram'
    ? items.filter(isTelegramSourceUnavailable).length
    : 0
  const clickable = PLATFORM_GROUP_ORDER.includes(platform)
  const Header = clickable ? 'button' : 'div'
  return (
    <div className="pt-1">
      <Header
        data-library-platform-header={platform}
        type={clickable ? 'button' : undefined}
        onClick={clickable ? () => toggleScreen(platform) : undefined}
        className={`w-full px-2 py-1.5 mb-1 flex items-center gap-2 rounded-md border min-w-0 group transition-colors ${
          clickable
            ? active ? 'border-zinc-700 bg-zinc-800' : 'border-zinc-800 bg-zinc-950 hover:border-zinc-700 hover:bg-zinc-900'
            : 'border-transparent'
        }`}
      >
        <PlatformLogo platform={platform} size={14} />
        <span className="text-zinc-400 group-hover:text-zinc-200 truncate min-w-0 text-sm">
          {meta?.label || platform}
        </span>
        {unavailableCount > 0 && (
          <span className="ml-auto inline-flex items-center gap-1 text-red-400 shrink-0 tabular-nums text-xs">
            <TriangleAlert size={12} />{unavailableCount}
          </span>
        )}
        <span className={`${unavailableCount > 0 ? '' : 'ml-auto'} text-zinc-500 shrink-0 tabular-nums text-xs`}>
          {items.length.toLocaleString('ru-RU')}
        </span>
      </Header>
    </div>
  )
}

function OtherToggleRow({ platform, count, expanded, onToggle }) {
  return (
    <button
      data-library-other-toggle={platform}
      onClick={onToggle}
      className="w-full text-left px-2 py-1 flex items-center gap-1.5 rounded-md hover:bg-zinc-900 text-zinc-500 hover:text-zinc-300 min-w-0"
      style={{ fontSize: '12px' }}
      title={platform === 'telegram'
        ? 'Чаты без сохранённых сообщений и случайные каналы — по дате последнего запроса'
        : 'Случайные каналы'}
    >
      {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      <span className="truncate min-w-0">Прочее ({count})</span>
    </button>
  )
}

function PlatformShortcut({ platform, position, visible, onOpen, onScroll }) {
  const meta = PLATFORMS[platform]
  const headerVisible = position === 'visible'
  const disabled = !position || headerVisible
  const DirectionIcon = position === 'up'
    ? ChevronUp
    : position === 'down'
      ? ChevronDown
      : Minus
  const directionLabel = position === 'up' ? 'выше' : 'ниже'

  return (
    <div data-library-shortcut={platform} className={`flex h-8 min-w-0 overflow-hidden rounded-md border transition-colors ${
      visible
        ? 'border-zinc-600 bg-zinc-800'
        : 'border-zinc-800 bg-zinc-950 hover:border-zinc-700'
    }`}>
      <button
        type="button"
        onClick={onOpen}
        className="flex-1 min-w-0 flex items-center justify-center hover:bg-zinc-800"
        title={`Открыть ${meta?.label || platform}`}
        aria-label={`Открыть ${meta?.label || platform}`}
      >
        <PlatformLogo platform={platform} size={16} />
      </button>
      <button
        type="button"
        onClick={onScroll}
        disabled={disabled}
        className={`w-6 shrink-0 border-l border-zinc-800 flex items-center justify-center ${
          disabled
            ? 'text-zinc-700 cursor-default'
            : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100'
        }`}
        title={headerVisible
          ? `${meta?.label || platform} уже виден в библиотеке`
          : position
            ? `${meta?.label || platform} ${directionLabel} — прокрутить к разделу`
            : 'Определяю положение раздела'}
        aria-label={headerVisible
          ? `${meta?.label || platform} уже виден в библиотеке`
          : `Прокрутить к разделу ${meta?.label || platform}`}
      >
        <DirectionIcon size={13} />
      </button>
    </div>
  )
}

function PlatformGroup({
  platform, items, activeSourceId, collapsedOther, onToggleOther,
  tgOrderedIds, selection, liveIndexBySource, onContextMenu,
  headerRef, groupRef, active,
}) {
  const meta = PLATFORMS[platform]
  const headerScreen = PLATFORM_GROUP_ORDER.includes(platform) ? platform : null
  const onHeaderClick = headerScreen ? () => toggleScreen(headerScreen) : null

  // Разделяем источники на основной список и свёрнутый «Прочее». См.
  // splitSources() — для Telegram туда же уезжают чаты с 0 сохранённых
  // сообщений (заброшенные / ещё не спарсенные), отсортированные по дате
  // последнего запроса.
  const { explicit, other } = splitSources(items, platform)
  const totalCount = items.length

  const isTelegram = platform === 'telegram'
  const unavailableCount = isTelegram
    ? items.filter(isTelegramSourceUnavailable).length
    : 0
  const Header = onHeaderClick ? 'button' : 'div'

  return (
    <div ref={groupRef} data-library-platform-group={platform} className="mb-3">
      <Header
        ref={headerRef}
        data-library-platform-header={platform}
        type={onHeaderClick ? 'button' : undefined}
        onClick={onHeaderClick || undefined}
        title={onHeaderClick ? `Открыть ${meta?.label || platform}` : undefined}
        className={`w-full px-2 py-1.5 mb-1 flex items-center gap-2 rounded-md border min-w-0 group transition-colors ${
          onHeaderClick
            ? active
              ? 'border-zinc-700 bg-zinc-800'
              : 'border-zinc-800 bg-zinc-950 hover:border-zinc-700 hover:bg-zinc-900'
            : 'border-transparent'
        }`}
      >
        <PlatformLogo platform={platform} size={14} />
        <span
          className="text-zinc-400 group-hover:text-zinc-200 truncate min-w-0 text-sm"
        >
          {meta?.label || platform}
        </span>
        {unavailableCount > 0 && (
          <span
            className="ml-auto inline-flex items-center gap-1 text-red-400 shrink-0 tabular-nums text-xs"
            title={`${unavailableCount} недоступных Telegram-источников`}
          >
            <TriangleAlert size={12} />
            {unavailableCount}
          </span>
        )}
        <span
          className={`${unavailableCount > 0 ? '' : 'ml-auto'} text-zinc-500 shrink-0 tabular-nums text-xs`}
        >
          {totalCount.toLocaleString('ru-RU')}
        </span>
      </Header>
      <div>
        {explicit.map(s => (
          <SourceRow
            key={s.id}
            source={s}
            active={s.id === activeSourceId}
            isTelegram={isTelegram}
            selection={selection}
            tgOrderedIds={tgOrderedIds}
            indexJob={liveIndexBySource?.get(Number(s.id))}
            onContextMenu={onContextMenu}
          />
        ))}
        {other.length > 0 && (
          <div className="mt-1">
            <button
              onClick={onToggleOther}
              className="w-full text-left px-2 py-1 flex items-center gap-1.5 rounded-md hover:bg-zinc-900 text-zinc-500 hover:text-zinc-300 min-w-0"
              style={{ fontSize: '12px' }}
              title={isTelegram
                ? 'Чаты без сохранённых сообщений и случайные каналы — по дате последнего запроса'
                : 'Случайные каналы (single-paste из расширения)'}
            >
              {collapsedOther
                ? <ChevronRight size={14} className="shrink-0" />
                : <ChevronDown  size={14} className="shrink-0" />}
              <span className="truncate min-w-0">Прочее ({other.length})</span>
            </button>
            {!collapsedOther && (
              <div className="ml-2 border-l border-zinc-800 pl-1">
                {other.map(s => (
                  <SourceRow
                    key={s.id}
                    source={s}
                    active={s.id === activeSourceId}
                    isTelegram={isTelegram}
                    selection={selection}
                    tgOrderedIds={tgOrderedIds}
                    indexJob={liveIndexBySource?.get(Number(s.id))}
                    onContextMenu={onContextMenu}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function SourceRow({
  source, active,
  isTelegram, selection, tgOrderedIds, indexJob, onContextMenu,
}) {
  // Selection only applies to Telegram rows — multi-select is meaningless for
  // YouTube / Instagram (different operations per platform).
  const selected = !!(isTelegram && selection.has(source.id))
  const unavailable = !!(isTelegram && isTelegramSourceUnavailable(source))
  const healthTitle = unavailable ? telegramSourceHealthTitle(source) : ''
  // Cmd/Ctrl-click = toggle. Shift-click = range from anchor to this row.
  // Plain click = single-select navigation (existing behaviour).
  const onClick = (e) => {
    if (!isTelegram) {
      toggleScreen('source-detail', { sourceId: source.id })
      return
    }
    const meta = e.metaKey || e.ctrlKey
    const shift = e.shiftKey
    if (meta) {
      e.preventDefault()
      selection.toggle(source.id)
      return
    }
    if (shift) {
      e.preventDefault()
      selection.rangeTo(source.id, tgOrderedIds)
      return
    }
    selection.clear()
    // Preserve anchor so the NEXT shift-click can extend a range starting
    // from this row, even though nothing is visually selected yet.
    selection.setAnchorOnly(source.id)
    toggleScreen('source-detail', { sourceId: source.id })
  }

  const onCtx = (e) => {
    if (!isTelegram) return
    e.preventDefault()
    // If the user right-clicks an un-selected row while a selection exists,
    // the right-click subject becomes ONLY this row (replaces selection) —
    // matches the Finder / VS Code convention.
    let ids
    if (selection.has(source.id)) {
      ids = selection.list()
    } else {
      selection.replace([source.id])
      ids = [source.id]
    }
    onContextMenu({ x: e.clientX, y: e.clientY, sourceIds: ids })
  }

  return (
    <button
      data-library-source-id={source.id}
      onClick={onClick}
      onContextMenu={onCtx}
      title={healthTitle || undefined}
      className={`relative w-full text-left ${isTelegram ? 'pl-4 pr-2' : 'px-2'} py-1.5 rounded-md flex items-center gap-2 group min-w-0 select-none outline-none focus:outline-none ${
        unavailable
          ? selected
            ? 'bg-red-950/50 ring-1 ring-red-600/80'
            : active ? 'bg-red-950/45 ring-1 ring-red-800/70' : 'bg-red-950/20 hover:bg-red-950/40'
          : selected
            ? 'bg-emerald-900/40 ring-1 ring-emerald-700/60'
            : active ? 'bg-zinc-800' : 'hover:bg-zinc-900'
      }`}
    >
      {isTelegram && <SemanticIndexRail source={source} indexJob={indexJob} />}
      <span className={unavailable ? 'rounded-full ring-1 ring-red-700/80' : ''}>
        <Avatar source={source} size={20} />
      </span>
      <span className={`${unavailable ? 'text-red-300' : 'text-zinc-300'} truncate text-sm min-w-0 flex-1`}>
        {source.display_name && source.display_name !== source.handle
          ? source.display_name
          : `@${source.handle}`}
      </span>
      {unavailable && <TriangleAlert size={13} className="text-red-400 shrink-0" />}
      <span className={`text-xs ml-auto shrink-0 ${
        unavailable ? 'text-red-400'
          : selected ? 'text-emerald-300'
            : active ? 'text-zinc-300' : 'text-zinc-600 group-hover:text-zinc-500'
      }`}>
        {source.items_count || 0}
      </span>
    </button>
  )
}

function SemanticIndexRail({ source, indexJob }) {
  const total = Number(source.semantic_indexable_count || 0)
  const storedIndexed = Number(source.semantic_indexed_count || 0)
  const liveIndexed = Number.isFinite(Number(indexJob?.items_done))
    ? Number(indexJob.items_done)
    : null
  const indexed = Math.min(total, Math.max(0, liveIndexed ?? storedIndexed))
  const ratio = total > 0 ? indexed / total : 0
  const pct = Math.max(0, Math.min(100, ratio * 100))
  const fillClass =
    pct >= 95 ? 'bg-emerald-500' :
    pct >= 25 ? 'bg-amber-500' :
    'bg-rose-500'

  return (
    <span
      className="pointer-events-none absolute left-1 top-1 bottom-1 w-[3px] rounded-full bg-zinc-700/75 overflow-hidden"
      aria-hidden="true"
    >
      {pct > 0 && (
        <span
          className={`absolute bottom-0 left-0 right-0 rounded-full transition-[height] duration-300 ${fillClass}`}
          style={{ height: `${pct}%` }}
        />
      )}
    </span>
  )
}

function group(sources) {
  const out = {}
  for (const s of sources) {
    if (!out[s.platform]) out[s.platform] = []
    out[s.platform].push(s)
  }
  // Within each platform, sort by item count descending — heavy chats /
  // channels float to the top so the user lands on what they actually
  // use. Tie-break on display name so the order is deterministic when
  // counts match (no flicker on refresh). The "Прочее" bucket inside
  // PlatformBlock is filtered from the same array, so it inherits the
  // same ordering for free.
  for (const k of Object.keys(out)) {
    out[k].sort(byItemsDescNameAsc)
  }
  return out
}

// Main-list sort: heaviest chats first, name tie-break (deterministic, no
// flicker on refresh).
function byItemsDescNameAsc(a, b) {
  const ca = a.items_count || 0
  const cb = b.items_count || 0
  if (cb !== ca) return cb - ca
  const na = (a.display_name || a.handle || '').toLowerCase()
  const nb = (b.display_name || b.handle || '').toLowerCase()
  return na.localeCompare(nb, 'ru')
}

// «Прочее» sort: by last request (last_synced_at) DESC — most-recently-touched
// abandoned/empty chats on top, so a chat you just probed is easy to find.
// Sources never fetched (null last_synced_at) sink to the bottom, name-ordered.
function byLastSyncedDesc(a, b) {
  const sa = a.last_synced_at || 0
  const sb = b.last_synced_at || 0
  if (sb !== sa) return sb - sa
  const na = (a.display_name || a.handle || '').toLowerCase()
  const nb = (b.display_name || b.handle || '').toLowerCase()
  return na.localeCompare(nb, 'ru')
}

// Split a platform's sources into the main list (`explicit`) and the collapsed
// «Прочее» bucket (`other`). Two independent reasons a source lands in «Прочее»:
//
//   1. Not explicitly requested (is_explicit=0) — single-paste of one video
//      from the browser-extension, folder-demoted chats. Existing behaviour.
//   2. Telegram chat with ZERO saved messages — abandoned or never-fetched
//      chats. They flooded the main list (288 of 371 here), burying the chats
//      the user actually works with. A 0-item chat carries no content to show,
//      so it belongs in «Прочее» until a fetch gives it substance. NON-Telegram
//      platforms keep their existing rule (a YT channel row is meaningful even
//      at 0 — the picker lives on its page), so this demotion is TG-only.
//
// «Прочее» is sorted by last-request date so the user's recent probes surface;
// the main list keeps the by-weight order.
function splitSources(items, platform) {
  const isTg = platform === 'telegram'
  // A broken Telegram source must never disappear inside collapsed
  // «Прочее»: the whole point of the persistent marker is that it remains
  // visible even after background pulls stop producing History rows.
  const inMain = (s) => (isTg && isTelegramSourceUnavailable(s))
    || (!!s.is_explicit && (!isTg || (s.items_count || 0) > 0))
  const explicit = items.filter(inMain).sort((a, b) => {
    if (isTg) {
      const dangerDiff = Number(isTelegramSourceUnavailable(b))
        - Number(isTelegramSourceUnavailable(a))
      if (dangerDiff) return dangerDiff
    }
    return byItemsDescNameAsc(a, b)
  })
  const other    = items.filter(s => !inMain(s)).sort(byLastSyncedDesc)
  return { explicit, other }
}
