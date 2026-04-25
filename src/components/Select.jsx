import React, { useState, useRef, useEffect, useCallback } from 'react'

/**
 * Custom dropdown select. Closes on outside click / Escape.
 * options: [{ id, label, hint?, icon? }]
 *
 * compact=true → trigger row stays one-line (label + chevron only),
 * dropdown still shows hints. Used for secondary fields like engine
 * picker where user already knows what they're picking.
 *
 * hideHint=true → trigger shows label only (no «· hint» tail), even when
 * compact. Use when hint is helpful for picking but noisy after pick (e.g.
 * range modes — «Последние N · Самый быстрый…» reads as instructional clutter
 * once chosen). Dropdown still renders the hint.
 *
 * disabled=true → trigger не открывается, приглушён, cursor not-allowed.
 * Используется когда значение поля логически не применимо при текущих
 * соседних контролах (Effort при выключенном Thinking).
 */
export default function Select({ value, onChange, options, placeholder = 'Выбрать…', compact = false, hideHint = false, disabled = false }) {
  const [open, setOpen] = useState(false)
  const [hovered, setHovered] = useState(null)
  const wrapRef = useRef(null)
  const listRef = useRef(null)

  const current = options.find(o => o.id === value)

  // Close on outside click
  useEffect(() => {
    if (!open) return
    function onDoc(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  // Keyboard navigation
  const onKey = useCallback((e) => {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault()
        setOpen(true)
        setHovered(value || options[0]?.id)
      }
      return
    }
    if (e.key === 'Escape')      { e.preventDefault(); setOpen(false) }
    else if (e.key === 'Enter')  {
      e.preventDefault()
      if (hovered != null) { onChange(hovered); setOpen(false) }
    }
    else if (e.key === 'ArrowDown') {
      e.preventDefault()
      const idx = options.findIndex(o => o.id === hovered)
      const next = options[Math.min(options.length - 1, idx + 1)]?.id ?? options[0]?.id
      setHovered(next)
    }
    else if (e.key === 'ArrowUp') {
      e.preventDefault()
      const idx = options.findIndex(o => o.id === hovered)
      const next = options[Math.max(0, idx - 1)]?.id ?? options[0]?.id
      setHovered(next)
    }
  }, [open, hovered, value, options, onChange])

  // Scroll hovered into view
  useEffect(() => {
    if (!open || !listRef.current || hovered == null) return
    const el = listRef.current.querySelector(`[data-id="${hovered}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [hovered, open])

  // Compact mode is for inline form fields where the Select sits next to
  // h-9 inputs/buttons — it must visually match that scale, not the
  // full-screen mode picker the non-compact variant was designed for.
  // Sizes are explicit (no Tailwind tokens) so future text-base/text-sm
  // shifts in the design system don't quietly bloat or shrink the field.
  const triggerLabelSize  = compact ? '14px' : '16px'
  const triggerHintSize   = compact ? '13px' : '14px'
  const optionLabelSize   = compact ? '14px' : '16px'
  const optionHintSize    = compact ? '12px' : '14px'
  const optionPadY        = compact ? 'py-1.5' : 'py-2.5'
  const optionPadX        = compact ? 'px-3' : 'px-4'

  return (
    <div ref={wrapRef} className="relative" onKeyDown={onKey}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => { if (!disabled) setOpen(o => !o) }}
        className={`w-full flex items-center gap-3 rounded-md border text-left ${
          compact ? 'px-3 py-1.5' : 'px-4 py-3'
        } ${
          disabled
            ? 'bg-zinc-900/60 border-zinc-800 opacity-50'
            : open
            ? 'bg-zinc-900 border-zinc-500'
            : 'bg-zinc-900 border-zinc-700 hover:border-zinc-600'
        }`}
      >
        <div className="flex-1 min-w-0">
          {current ? (
            <>
              <div
                className={compact ? 'text-zinc-100 truncate' : 'font-medium text-zinc-100'}
                style={{ fontSize: triggerLabelSize }}
              >
                {current.label}
                {compact && current.hint && !hideHint && (
                  <span style={{ fontSize: triggerHintSize }} className="text-zinc-500 ml-2">· {current.hint}</span>
                )}
              </div>
              {!compact && current.hint && !hideHint && (
                <div style={{ fontSize: triggerHintSize }} className="text-zinc-500 mt-0.5">{current.hint}</div>
              )}
            </>
          ) : (
            <div className="text-zinc-500" style={{ fontSize: triggerLabelSize }}>{placeholder}</div>
          )}
        </div>
        <Chevron open={open} />
      </button>

      {open && (
        <div
          ref={listRef}
          className="absolute z-50 mt-1 left-0 right-0 max-h-80 overflow-auto rounded-md border border-zinc-700 bg-zinc-900 shadow-2xl py-1"
        >
          {options.map(o => {
            const isSelected = o.id === value
            const isHovered  = o.id === hovered
            return (
              <button
                key={o.id}
                data-id={o.id}
                type="button"
                onMouseEnter={() => setHovered(o.id)}
                onClick={() => { onChange(o.id); setOpen(false) }}
                className={`w-full text-left ${optionPadX} ${optionPadY} flex items-start gap-3 ${
                  isHovered ? 'bg-zinc-800' : ''
                } ${isSelected ? 'text-zinc-100' : 'text-zinc-300'}`}
              >
                <div className="flex-1 min-w-0">
                  <div className={compact ? '' : 'font-medium'} style={{ fontSize: optionLabelSize }}>
                    {o.label}
                  </div>
                  {o.hint && (
                    <div style={{ fontSize: optionHintSize }} className="text-zinc-500 mt-0.5">{o.hint}</div>
                  )}
                </div>
                {isSelected && <span className="text-zinc-300" style={{ fontSize: optionLabelSize }}>✓</span>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function Chevron({ open }) {
  return (
    <svg
      width="14" height="14" viewBox="0 0 24 24"
      className={`shrink-0 text-zinc-500 transition-transform ${open ? 'rotate-180' : ''}`}
      fill="none" stroke="currentColor" strokeWidth="2"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  )
}
