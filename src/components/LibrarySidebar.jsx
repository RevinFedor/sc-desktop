import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { ChevronDown, ChevronRight, Settings, Plus, RotateCw } from 'lucide-react'
import { PLATFORMS } from '../lib/detect'
import { pushScreen, useStore } from '../lib/store'
import { useSources, refreshSources, useSourcesLoaded } from '../lib/sources'
import { useJobs } from '../lib/jobs'
import PlatformLogo from './PlatformLogo'
import Avatar from './Avatar'
import { useTelegramSelection } from '../lib/telegramSelection'
import SidebarContextMenu from './SidebarContextMenu'

// Platforms that get a group header even when they have no sources yet —
// because the header itself is a clickable shortcut into per-platform
// settings (Telegram sessions, Instagram backend / sessions).
const PLATFORM_GROUP_ORDER = ['telegram', 'youtube', 'instagram', 'reddit']

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
  const grouped = group(sources)
  const activeSourceId = screen.name === 'source-detail' ? screen.payload?.sourceId : null
  const jobs = useJobs()
  const liveIndexBySource = useMemo(() => {
    const map = new Map()
    for (const job of jobs) {
      if (job?.type !== 'tg_index') continue
      if (job.status !== 'running' && job.status !== 'awaiting_ai') continue
      if (job.source_id == null) continue
      map.set(Number(job.source_id), job)
    }
    return map
  }, [jobs])
  // Сохраняем какие «Прочее»-подгруппы свёрнуты — между перезапусками. Свёрнуто
  // по умолчанию (пустой Set значит «всё свёрнуто»: см. PlatformGroup).
  const [collapsed, setCollapsed] = useState(loadCollapsedSet)

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
  }, [tgOrderedIds.join(',')])

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
    <aside className="border-r border-zinc-800 flex flex-col h-full min-h-0 min-w-0 max-w-full overflow-hidden">
      <div className="px-4 pt-4 pb-2 flex items-center justify-between">
        <div className="text-xs uppercase tracking-wider text-zinc-500">Library</div>
        <div className="flex items-center gap-2">
          <button
            onClick={refreshSources}
            title="Refresh"
            className="text-zinc-500 hover:text-zinc-200"
          ><RotateCw size={13} /></button>
          <button
            onClick={() => pushScreen('paste')}
            title="Add source"
            className="text-zinc-500 hover:text-zinc-200"
          ><Plus size={15} /></button>
        </div>
      </div>

      <div
        className="flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-2 pb-2 min-h-0 min-w-0"
        style={{ scrollbarGutter: 'stable' }}
      >
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
        {PLATFORM_GROUP_ORDER.map(platform => (
          <PlatformGroup
            key={platform}
            platform={platform}
            items={grouped[platform] || []}
            activeSourceId={activeSourceId}
            collapsedOther={!collapsed.has(platform)}
            onToggleOther={() => toggleCollapsed(platform)}
            tgOrderedIds={tgOrderedIds}
            selection={selection}
            liveIndexBySource={liveIndexBySource}
            onContextMenu={(payload) => setCtxMenu(payload)}
          />
        ))}
        {Object.entries(grouped)
          .filter(([p]) => !PLATFORM_GROUP_ORDER.includes(p))
          .map(([platform, items]) => (
            <PlatformGroup
              key={platform}
              platform={platform}
              items={items}
              activeSourceId={activeSourceId}
              collapsedOther={!collapsed.has(platform)}
              onToggleOther={() => toggleCollapsed(platform)}
              tgOrderedIds={tgOrderedIds}
              selection={selection}
              liveIndexBySource={liveIndexBySource}
              onContextMenu={(payload) => setCtxMenu(payload)}
            />
          ))}
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

function PlatformGroup({
  platform, items, activeSourceId, collapsedOther, onToggleOther,
  tgOrderedIds, selection, liveIndexBySource, onContextMenu,
}) {
  const meta = PLATFORMS[platform]
  // Per-platform header screen. Telegram has a dedicated TelegramScreen with
  // folders + multi-chat batch fetch; settings live in its top-right corner
  // (no separate sidebar entry to keep). Instagram still goes to its existing
  // settings screen until it gets the same treatment.
  const headerScreen =
    platform === 'telegram'  ? 'telegram' :
    platform === 'instagram' ? 'ig-settings' :
    null
  const headerIcon =
    platform === 'telegram'  ? null :     // no ⚙ — header is the screen, not "settings"
    platform === 'instagram' ? 'settings' :
    null
  const onHeaderClick = headerScreen ? () => pushScreen(headerScreen) : null

  // Разделяем источники на основной список и свёрнутый «Прочее». См.
  // splitSources() — для Telegram туда же уезжают чаты с 0 сохранённых
  // сообщений (заброшенные / ещё не спарсенные), отсортированные по дате
  // последнего запроса.
  const { explicit, other } = splitSources(items, platform)
  const totalCount = items.length

  const isTelegram = platform === 'telegram'

  return (
    <div className="mb-3">
      <div
        onClick={onHeaderClick || undefined}
        role={onHeaderClick ? 'button' : undefined}
        title={onHeaderClick
          ? (platform === 'telegram'
              ? `${meta?.label} · все чаты и папки`
              : `${meta?.label} · settings`)
          : undefined}
        className={`px-2 pt-2 pb-1 mb-1 flex items-center gap-1.5 border-b border-zinc-800 min-w-0 ${
          onHeaderClick ? 'cursor-pointer hover:text-zinc-300 group' : ''
        }`}
      >
        <PlatformLogo platform={platform} size={11} />
        <span
          className="text-zinc-500 group-hover:text-zinc-400 truncate min-w-0 uppercase tracking-wider"
          style={{ fontSize: '11px', letterSpacing: '0.08em' }}
        >
          {meta?.label || platform}
        </span>
        {onHeaderClick && headerIcon === 'settings' && (
          <Settings size={11} className="text-zinc-700 group-hover:text-zinc-400 shrink-0" />
        )}
        <span
          className="text-zinc-600 ml-auto shrink-0 tabular-nums"
          style={{ fontSize: '11px' }}
        >
          {totalCount > 0 ? totalCount : ''}
        </span>
      </div>
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
  // Cmd/Ctrl-click = toggle. Shift-click = range from anchor to this row.
  // Plain click = single-select navigation (existing behaviour).
  const onClick = (e) => {
    if (!isTelegram) {
      pushScreen('source-detail', { sourceId: source.id })
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
    pushScreen('source-detail', { sourceId: source.id })
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
      onClick={onClick}
      onContextMenu={onCtx}
      className={`relative w-full text-left ${isTelegram ? 'pl-4 pr-2' : 'px-2'} py-1.5 rounded-md flex items-center gap-2 group min-w-0 select-none outline-none focus:outline-none ${
        selected
          ? 'bg-emerald-900/40 ring-1 ring-emerald-700/60'
          : active ? 'bg-zinc-800' : 'hover:bg-zinc-900'
      }`}
    >
      {isTelegram && <SemanticIndexRail source={source} indexJob={indexJob} />}
      <Avatar source={source} size={20} />
      <span className="text-zinc-300 truncate text-sm min-w-0 flex-1">
        {source.display_name && source.display_name !== source.handle
          ? source.display_name
          : `@${source.handle}`}
      </span>
      <span className={`text-xs ml-auto shrink-0 ${
        selected ? 'text-emerald-300'
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
  const inMain = (s) => !!s.is_explicit && (!isTg || (s.items_count || 0) > 0)
  const explicit = items.filter(inMain).sort(byItemsDescNameAsc)
  const other    = items.filter(s => !inMain(s)).sort(byLastSyncedDesc)
  return { explicit, other }
}
