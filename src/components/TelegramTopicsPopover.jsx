import React, { useState, useRef, useEffect } from 'react'
import Checkbox from './Checkbox'

/**
 * Forum-topics popover. Two modes — same chip styling, different
 * semantics inside the dropdown.
 *
 * Multi-mode (default, fetch flow):
 *   topics       — [{ id, title, count }]. Empty array = control hides itself.
 *   selectedIds  — Set<number> | array<number>. Empty = «Все темы».
 *   onChange(set | (prev) => next) — Set replacement.
 *
 * Single-mode (mode="single", copy flow):
 *   selectedId  — number | null. null = «Все темы».
 *   onChange(idOrNull) — picks one topic, null clears the filter.
 *
 * Mode is gated on the `mode` prop; everything else (visual chip, popover
 * width, summary line) stays identical so this looks like the same
 * control in both flows.
 */
export default function TelegramTopicsPopover({
  topics, selectedIds, onChange,
  mode = 'multi', selectedId = null,
}) {
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

  const isSingle = mode === 'single'
  // Normalise to a Set so we can do .has() / .add() / .delete() consistently
  // regardless of what the parent passed (multi-mode only).
  const selSet = isSingle
    ? new Set(selectedId != null ? [selectedId] : [])
    : (selectedIds instanceof Set
        ? selectedIds
        : new Set(Array.isArray(selectedIds) ? selectedIds : []))

  function patch(updater) {
    const next = updater(new Set(selSet))
    onChange(next)
  }

  const list = Array.isArray(topics) ? topics : []
  if (list.length === 0) return null   // non-forum chat or no topics yet

  const selected = list.filter(t => selSet.has(t.id))
  const summary = selected.length === 0
    ? 'Все темы'
    : selected.map(t => t.title || `#${t.id}`).join(' · ')

  // Header row: tri-state «Все темы» (empty Set = "all", every-id-set =
  // also "all" but explicitly via «Снять выбор»). We don't conflate
  // empty Set with "everything" *visually* — empty Set is the natural
  // server-side default and we want the user to land there with one
  // click.
  const allOn = selSet.size === list.length && list.length > 0
  const noneOn = selSet.size === 0
  const indeterminate = !allOn && !noneOn
  function flipAll() {
    if (allOn || noneOn === false) {
      // Anything selected → clear, returning to natural "Все темы"
      onChange(new Set())
    } else {
      const next = new Set()
      for (const t of list) next.add(t.id)
      onChange(next)
    }
  }
  const summaryLine = noneOn
    ? `${list.length} тем доступно`
    : `Выбрано ${selected.length} из ${list.length}`

  return (
    <div ref={wrapRef} className="relative inline-block min-w-0">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={`flex items-center gap-2 rounded-md border px-3 py-1.5 max-w-[280px] ${
          open ? 'bg-zinc-900 border-zinc-500'
               : 'bg-zinc-900 border-zinc-700 hover:border-zinc-600'
        }`}
        style={{ fontSize: '14px' }}
        title={selected.length > 0 ? summary : undefined}
      >
        <span className={`truncate min-w-0 ${
          selected.length === 0 ? 'text-zinc-500' : 'text-zinc-100'
        }`}>
          {summary}
        </span>
        <svg
          width="12" height="12" viewBox="0 0 24 24"
          className={`shrink-0 text-zinc-500 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none" stroke="currentColor" strokeWidth="2"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div className="absolute z-50 mt-1 left-0 w-[320px] max-h-[420px] overflow-y-auto rounded-md border border-zinc-700 bg-zinc-900 shadow-2xl py-1">
          {/* Header row — in multi mode it's a tri-state «Все темы» / «Снять
              выбор»; in single mode it's the «Все темы» radio (clear the
              filter, copy assembles the entire chat). */}
          {isSingle ? (
            <div
              role="button"
              tabIndex={0}
              onClick={() => { onChange(null); setOpen(false) }}
              onKeyDown={(e) => {
                if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onChange(null); setOpen(false) }
              }}
              className="px-3 py-1.5 flex items-center gap-2.5 hover:bg-zinc-800 cursor-pointer text-zinc-200 border-b border-zinc-800"
            >
              <Radio checked={selectedId == null} />
              <div className="flex-1 min-w-0 leading-tight">
                <span className="truncate">Все темы</span>
                <span className="text-zinc-500 ml-2" style={{ fontSize: '12px' }}>
                  Заголовки тем будут вставлены автоматически
                </span>
              </div>
            </div>
          ) : (
            <div
              role="button"
              tabIndex={0}
              onClick={flipAll}
              onKeyDown={(e) => {
                if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flipAll() }
              }}
              className="px-3 py-1.5 flex items-center gap-2.5 hover:bg-zinc-800 cursor-pointer text-zinc-200 border-b border-zinc-800"
            >
              <Checkbox
                checked={allOn}
                indeterminate={indeterminate}
                onChange={flipAll}
                size="sm"
              />
              <div className="flex-1 min-w-0 leading-tight">
                <span className="truncate">
                  {selected.length === 0 ? 'Все темы' : 'Снять выбор'}
                </span>
                <span className="text-zinc-500 ml-2" style={{ fontSize: '12px' }}>
                  {summaryLine}
                </span>
              </div>
            </div>
          )}
          {list.map(t => {
            const isOn = selSet.has(t.id)
            const toggle = () => {
              if (isSingle) {
                onChange(t.id)
                setOpen(false)
                return
              }
              patch(s => {
                if (s.has(t.id)) s.delete(t.id); else s.add(t.id)
                return s
              })
            }
            return (
              <div
                key={t.id}
                role="button"
                tabIndex={0}
                onClick={toggle}
                onKeyDown={(e) => {
                  if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle() }
                }}
                className={`px-3 py-2 flex items-center gap-2.5 hover:bg-zinc-800 cursor-pointer ${
                  isOn ? 'text-zinc-100' : 'text-zinc-300'
                }`}
              >
                {isSingle
                  ? <Radio checked={isOn} />
                  : <Checkbox checked={isOn} onChange={toggle} size="sm" />}
                <div className="flex-1 min-w-0 leading-tight truncate">
                  {t.title || `#${t.id}`}
                </div>
                {t.count != null && (
                  <span style={{ fontSize: '13px' }} className="text-zinc-400 shrink-0 tabular-nums">
                    {t.count.toLocaleString('ru-RU')}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// Local radio dot — same visual weight as the Checkbox we use elsewhere so
// single-mode and multi-mode rows align pixel-for-pixel.
function Radio({ checked }) {
  return (
    <span
      className={`inline-flex items-center justify-center w-4 h-4 rounded-full border ${
        checked ? 'border-zinc-300' : 'border-zinc-600'
      }`}
    >
      {checked && <span className="w-2 h-2 rounded-full bg-zinc-200" />}
    </span>
  )
}
