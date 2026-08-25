import React, { useEffect, useRef, useState } from 'react'
import { useStore, closeActivity } from './lib/store'
import TitleBar from './components/TitleBar'
import LibrarySidebar from './components/LibrarySidebar'
import ActivityPanel from './components/ActivityPanel'
import Footer from './components/Footer'
import Breadcrumbs from './components/Breadcrumbs'
import QuickOpen from './components/QuickOpen'
import ToastHost from './components/ToastHost'
import { wireJobInvalidation } from './lib/jobInvalidation'
import { wireSessionToasts } from './lib/sessionToasts'

wireJobInvalidation()
wireSessionToasts()

import PasteScreen from './screens/PasteScreen'
import TelegramConfig from './screens/TelegramConfig'
import TelegramScreen from './screens/TelegramScreen'
import YouTubeConfig from './screens/YouTubeConfig'
import InstagramConfig from './screens/InstagramConfig'
import SettingsScreen from './screens/SettingsScreen'
import PlatformScreen from './screens/PlatformScreen'
import JobDetail from './screens/JobDetail'
import SourceDetail from './screens/SourceDetail'
import NotesScreen from './screens/NotesScreen'
import AistudioJobScreen from './screens/AistudioJobScreen'
import NewResearchScreen from './screens/NewResearchScreen'
import McpHistoryPanel from './components/McpHistoryPanel'

const YouTubeScreen = () => <PlatformScreen platform="youtube" />
const BoostyScreen = () => <PlatformScreen platform="boosty" />
const InstagramScreen = () => <PlatformScreen platform="instagram" />
const RedditScreen = () => <PlatformScreen platform="reddit" />
const TikTokScreen = () => <PlatformScreen platform="tiktok" />
const TwitterScreen = () => <PlatformScreen platform="twitter" />

const SCREENS = {
  paste:           PasteScreen,
  'tg-config':     TelegramConfig,
  telegram:        TelegramScreen,
  youtube:         YouTubeScreen,
  boosty:          BoostyScreen,
  instagram:       InstagramScreen,
  reddit:          RedditScreen,
  tiktok:          TikTokScreen,
  twitter:         TwitterScreen,
  'yt-config':     YouTubeConfig,
  'ig-config':     InstagramConfig,
  settings:        SettingsScreen,
  'job-detail':    JobDetail,
  'source-detail': SourceDetail,
  'notes':         NotesScreen,
  'aistudio-job':  AistudioJobScreen,
  'new-research':  NewResearchScreen,
}

const SIDEBAR_WIDTH_KEY = 'layout.librarySidebarWidth'
const DEFAULT_SIDEBAR_WIDTH = 240
const MIN_SIDEBAR_WIDTH = 180
const MAX_SIDEBAR_WIDTH = 420

function clampSidebarWidth(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_SIDEBAR_WIDTH
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, Math.round(n)))
}

export default function App() {
  const screen = useStore(s => s.screen)
  const activityOpen = useStore(s => s.activityOpen)
  const Component = SCREENS[screen.name] || PasteScreen
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH)
  const [sidebarResizing, setSidebarResizing] = useState(false)
  const sidebarWidthRef = useRef(DEFAULT_SIDEBAR_WIDTH)
  const workspaceGridRef = useRef(null)
  const resizeLabelRef = useRef(null)

  useEffect(() => {
    sidebarWidthRef.current = sidebarWidth
    workspaceGridRef.current?.style.setProperty('--library-sidebar-width', `${sidebarWidth}px`)
  }, [sidebarWidth])

  useEffect(() => {
    if (!window.api?.uiPreferenceGet) return
    let alive = true
    window.api.uiPreferenceGet(SIDEBAR_WIDTH_KEY)
      .then(value => {
        if (!alive || value == null) return
        setSidebarWidth(clampSidebarWidth(value))
      })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  function persistSidebarWidth(width) {
    if (!window.api?.uiPreferenceSet) return
    window.api.uiPreferenceSet(SIDEBAR_WIDTH_KEY, clampSidebarWidth(width))
      .catch(err => console.error('[Layout] sidebar width save failed', err))
  }

  function startSidebarResize(e) {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = sidebarWidthRef.current
    const prevCursor = document.body.style.cursor
    const prevUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    setSidebarResizing(true)

    const apply = (clientX) => {
      const next = clampSidebarWidth(startWidth + clientX - startX)
      sidebarWidthRef.current = next
      workspaceGridRef.current?.style.setProperty('--library-sidebar-width', `${next}px`)
      if (resizeLabelRef.current) resizeLabelRef.current.textContent = `${next}px`
      return next
    }

    function cleanup(finalWidth) {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.style.cursor = prevCursor
      document.body.style.userSelect = prevUserSelect
      setSidebarWidth(finalWidth)
      setSidebarResizing(false)
      persistSidebarWidth(finalWidth)
    }

    function onMove(ev) {
      apply(ev.clientX)
    }

    function onUp(ev) {
      cleanup(apply(ev.clientX))
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // Close-on-outside-click via document listener. The capture-on-parent
  // approach fired before the inner buttons could handle their own click,
  // so the panel snapped shut and the navigation never ran. Document-level
  // mousedown checks containment of the panel + the toggle button instead.
  const panelRef = useRef(null)
  const toggleRef = useRef(null)
  useEffect(() => {
    if (!activityOpen) return
    function onDocMouseDown(e) {
      const t = e.target
      if (panelRef.current && panelRef.current.contains(t)) return
      if (toggleRef.current && toggleRef.current.contains(t)) return
      closeActivity()
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [activityOpen])

  // MCP-history sidepanel state — отдельный от Activity, открывается из
  // TitleBar 🕘 кнопки. Outside-click закрывает (по тому же паттерну).
  // `mcpToggleRef` — кнопка "Запущенные MCP" (popover-trigger).
  // `mcpHistoryToggleRef` — кнопка History (sidepanel-trigger). Обе должны
  // быть исключены из outside-click, иначе повторный клик по History
  // одновременно закрывает (outside-click) и открывает (onClick) — финал
  // open, кнопка не toggle'ит.
  const [mcpHistoryOpen, setMcpHistoryOpen] = useState(false)
  const mcpPanelRef = useRef(null)
  const mcpToggleRef = useRef(null)
  const mcpHistoryToggleRef = useRef(null)
  useEffect(() => {
    if (!mcpHistoryOpen) return
    function onDocMouseDown(e) {
      const t = e.target
      if (mcpPanelRef.current && mcpPanelRef.current.contains(t)) return
      if (mcpToggleRef.current && mcpToggleRef.current.contains(t)) return
      if (mcpHistoryToggleRef.current && mcpHistoryToggleRef.current.contains(t)) return
      setMcpHistoryOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [mcpHistoryOpen])

  // Cmd+P / Ctrl+P → quick-open modal (search across all sources). No
  // history is persisted by design — same as VS Code's quickopen, which
  // relies on the user typing every time. See gt-editor's fact-navigation
  // for the deep version of this UX (we adopt only the file-search half).
  const [quickOpen, setQuickOpen] = useState(false)
  useEffect(() => {
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'p' || e.key === 'P')) {
        // Don't intercept Cmd+Shift+P — Chrome dev tools owns that one
        // and we don't want to break "open file in workspace" muscle memory
        // for any future addition.
        if (e.shiftKey) return
        e.preventDefault()
        setQuickOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const componentKey = screen.name === 'source-detail'
    ? `source-detail:${screen.payload?.sourceId ?? 'missing'}`
    : screen.name === 'job-detail'
      ? `job-detail:${screen.payload?.jobId ?? screen.payload?.job?.id ?? 'missing'}`
      : screen.name

  return (
    <div className="h-full flex flex-col">
      <TitleBar
        toggleRef={toggleRef}
        mcpToggleRef={mcpToggleRef}
        mcpHistoryToggleRef={mcpHistoryToggleRef}
        onToggleMcpHistory={() => setMcpHistoryOpen(o => !o)}
        mcpHistoryOpen={mcpHistoryOpen}
        closeMcpHistory={() => setMcpHistoryOpen(false)}
      />
      <div
        ref={workspaceGridRef}
        className="flex-1 grid min-h-0 relative"
        style={{
          '--library-sidebar-width': `${sidebarWidth}px`,
          gridTemplateColumns: 'var(--library-sidebar-width) minmax(0, 1fr)',
        }}
      >
        <div className="relative min-w-0 min-h-0 h-full overflow-hidden">
          <LibrarySidebar />
          <button
            type="button"
            aria-label="Изменить ширину библиотеки"
            onPointerDown={startSidebarResize}
            className={`absolute top-0 bottom-0 -right-1.5 w-3 z-20 !cursor-col-resize group focus:outline-none ${
              sidebarResizing ? 'bg-emerald-500/5' : ''
            }`}
            style={{ cursor: 'col-resize' }}
          >
            <span className={`absolute top-0 bottom-0 left-1/2 -translate-x-1/2 rounded-full transition-[background-color,width] ${
              sidebarResizing
                ? 'w-[3px] bg-emerald-500'
                : 'w-px bg-transparent group-hover:w-[3px] group-hover:bg-zinc-500'
            }`} />
            {sidebarResizing && (
              <span ref={resizeLabelRef} className="absolute top-2 left-3 px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-[11px] tabular-nums text-zinc-300 shadow-xl">
                {sidebarWidth}px
              </span>
            )}
          </button>
        </div>
        <div className="min-h-0 flex flex-col overflow-hidden">
          <Breadcrumbs />
          <div className="flex-1 min-h-0 overflow-hidden">
            <Component key={componentKey} payload={screen.payload} />
          </div>
        </div>

        {/* Activity panel — overlay on the right, absolute over content,
            doesn't push layout. Hidden by default, opened from TitleBar. */}
        <aside
          ref={panelRef}
          className={`absolute top-0 right-0 h-full w-[300px] z-30 bg-zinc-950 border-l border-zinc-800 shadow-2xl transition-transform duration-200 ${
            activityOpen ? 'translate-x-0' : 'translate-x-full pointer-events-none'
          }`}
        >
          <ActivityPanel mountedVisible={activityOpen} />
        </aside>

        {/* MCP-history panel — overlay on the right (то же что Activity,
            но смещён или поверх; пока кладём НАД Activity если оба
            открыты — z-40). Контент — список aistudio jobs. */}
        <aside
          ref={mcpPanelRef}
          className={`absolute top-0 right-0 h-full w-[340px] z-40 bg-zinc-950 border-l border-zinc-800 shadow-2xl transition-transform duration-200 ${
            mcpHistoryOpen ? 'translate-x-0' : 'translate-x-full pointer-events-none'
          }`}
        >
          <McpHistoryPanel onClose={() => setMcpHistoryOpen(false)} />
        </aside>
      </div>
      <Footer />
      <QuickOpen open={quickOpen} onClose={() => setQuickOpen(false)} />
      <ToastHost />
    </div>
  )
}
