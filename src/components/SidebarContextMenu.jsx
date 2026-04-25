import React, { useEffect, useRef, useState } from 'react'
import { CONTENT_TYPES, defaultContent } from './TelegramTypesPopover'
import { useTelegramSelection } from '../lib/telegramSelection'

// Keep in sync with TelegramConfigForm — same localStorage blob feeds both,
// so the context-menu reflects whatever the user last picked in the paste-flow
// form. Reading is enough; the menu doesn't write here.
const LAST_USED_KEY = 'tg-config-form-last'

function readLastUsedContent() {
  try {
    const raw = localStorage.getItem(LAST_USED_KEY)
    if (!raw) return defaultContent()
    const v = JSON.parse(raw)
    const base = defaultContent()
    if (!v || !v.content || typeof v.content !== 'object') return base
    const next = { ...base }
    for (const k of Object.keys(base)) {
      if (typeof v.content[k] === 'boolean') next[k] = v.content[k]
    }
    return next
  } catch { return defaultContent() }
}

function readLastUsedEngine() {
  try {
    const raw = localStorage.getItem(LAST_USED_KEY)
    if (!raw) return 'assemblyai'
    const v = JSON.parse(raw)
    return (v && (v.engine === 'assemblyai' || v.engine === 'gemini'))
      ? v.engine : 'assemblyai'
  } catch { return 'assemblyai' }
}

// Human label for a picked type — comma-list under the action label so the
// user sees what will actually be fetched. `comments` is dropped from the
// summary (it's a per-channel switch, the umbrella catch-up doesn't know
// per-channel discussion availability yet).
function summarisePickedTypes(content) {
  const picked = CONTENT_TYPES
    .filter(c => content[c.id] && c.id !== 'comments')
    .map(c => c.label)
  if (picked.length === 0) return 'нет выбранных типов'
  return picked.join(' · ')
}

/**
 * Right-click menu on Telegram sidebar rows.
 *
 * Currently a single action — «Запросить до конца» — that catches up every
 * selected chat from its last saved message to «now». The action label is
 * suffixed with the picked content types so the user sees what's about to
 * be fetched without opening anything else (the types come from the last
 * Paste-flow form configuration; users almost always pick once).
 *
 * Props:
 *   x, y        — click coordinates (relative to viewport)
 *   sourceIds   — list of Telegram source ids to catch up
 *   onClose()   — close menu (Esc / outside click / action fired)
 */
export default function SidebarContextMenu({ x, y, sourceIds, onClose }) {
  const ref = useRef(null)
  const selection = useTelegramSelection()
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState(null)

  const content = readLastUsedContent()
  const engine  = readLastUsedEngine()
  const typesSummary = summarisePickedTypes(content)
  const pickedTypes = Object.keys(content).filter(k => content[k] && k !== 'comments')
  const canFire = pickedTypes.length > 0 && sourceIds.length > 0 && !submitting

  // Close on Esc / outside click. Mousedown listener guards against the
  // click that opened us — the right-click already fired before this
  // component mounted, so mousedown only fires on the NEXT user gesture.
  useEffect(() => {
    function onDoc(e) {
      if (ref.current && !ref.current.contains(e.target)) onClose()
    }
    function onEsc(e) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onEsc)
    }
  }, [onClose])

  async function runCatchUp() {
    if (!canFire) return
    if (!window.api?.tgCatchUp) {
      setErr('IPC недоступен'); return
    }
    setSubmitting(true); setErr(null)
    try {
      const res = await window.api.tgCatchUp({
        source_ids: sourceIds,
        types:      pickedTypes,
        engine:     (content.voice || content.video) ? engine : null,
      })
      if (!res?.ok) {
        setErr(res?.error || 'Ошибка запуска')
        setSubmitting(false)
        return
      }
      // Drop selection after firing — user expectation is "I asked, it's
      // running, now let me get back to clicking around". Job is visible in
      // Activity panel; selection has served its purpose.
      selection.clear()
      onClose()
    } catch (e) {
      setErr(String(e && e.message || e))
      setSubmitting(false)
    }
  }

  // Clamp so the menu never bleeds off-screen. Width is content-driven (w-max).
  const MAX_W = 280, H = 56
  const left = Math.min(x, window.innerWidth  - MAX_W - 8)
  const top  = Math.min(y, window.innerHeight - H     - 8)

  return (
    <div
      ref={ref}
      onContextMenu={e => e.preventDefault()}
      className="fixed z-50 rounded-md border border-zinc-700 bg-zinc-900 shadow-xl py-0.5 w-max"
      style={{ left, top, maxWidth: MAX_W }}
    >
      <button
        type="button"
        onClick={runCatchUp}
        disabled={!canFire}
        className={`w-full text-left px-3 py-1.5 flex items-start gap-2 outline-none ${
          canFire ? 'hover:bg-zinc-800 text-zinc-100' : 'text-zinc-600 cursor-not-allowed'
        }`}
        style={{ fontSize: '13px' }}
      >
        <div className="flex-1 min-w-0">
          <div className="whitespace-nowrap">
            Запросить до конца
            <span className="text-zinc-500 ml-1 tabular-nums">· {sourceIds.length}</span>
          </div>
          <div className="text-zinc-500 whitespace-nowrap" style={{ fontSize: '11px' }}>
            {typesSummary}
            {(content.voice || content.video) && (
              <span className="text-zinc-600"> · {engine}</span>
            )}
          </div>
        </div>
        {submitting && (
          <span className="inline-block w-3 h-3 mt-0.5 rounded-full border-2 border-zinc-700 border-t-zinc-300 animate-spin shrink-0" />
        )}
      </button>
      {err && (
        <div className="px-3 pb-1 text-red-300" style={{ fontSize: '11px' }}>
          {err}
        </div>
      )}
    </div>
  )
}
