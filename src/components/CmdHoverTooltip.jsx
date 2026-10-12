import React, { useEffect, useRef, useState, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'

// Cmd+hover tooltip, anchored to a trigger element. Implements the
// methodology/дизайн-принципы pattern (tooltip-resize-modal.md):
//
//   • visible = cmdPressed && triggerHovered  — opt-in, never on bare hover, so
//     sliding the mouse across the action-row doesn't spray popovers.
//   • Anchored via getBoundingClientRect() of the trigger + a Portal into
//     document.body — survives `transform`/`backdrop-filter` ancestors that
//     would otherwise hijack position:fixed, and re-measures on scroll/resize.
//   • cmdPressed is reset on window blur (Cmd+Tab steals the keyup) plus a
//     self-heal in mousemove (`if (cached && !e.metaKey) cached = false`).
//
// Read-only / lightweight — no resize, no pin. Just echoes the current params.
// pointer-events:none so the tooltip never eats clicks meant for the button.
//
// Usage:
//   <CmdHoverTooltip content={<>…</>}>
//     <button>…</button>
//   </CmdHoverTooltip>
//
// The single child is wrapped in an inline-flex span we attach hover + ref to;
// the child keeps its own click handlers untouched.
export default function CmdHoverTooltip({ content, children, side = 'top', gap = 8 }) {
  const anchorRef = useRef(null)
  const [hovered, setHovered] = useState(false)
  const [cmdDown, setCmdDown] = useState(false)
  const [rect, setRect] = useState(null)

  // Global modifier tracking. keydown/keyup flip cmdDown; window blur force-
  // clears it (Cmd+Tab releases to another window). mousemove self-heals a
  // stale-true cache when the event says Cmd isn't actually held.
  useEffect(() => {
    const onKeyDown = (e) => { if (e.key === 'Meta' || e.key === 'Control') setCmdDown(true) }
    const onKeyUp   = (e) => { if (e.key === 'Meta' || e.key === 'Control') setCmdDown(false) }
    const onBlur    = () => setCmdDown(false)
    const onMove    = (e) => { if (!e.metaKey && !e.ctrlKey) setCmdDown(prev => (prev ? false : prev)) }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    window.addEventListener('mousemove', onMove)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('mousemove', onMove)
    }
  }, [])

  const visible = cmdDown && hovered && content != null

  // Measure the trigger when the tooltip is about to show, and keep it pinned
  // on scroll/resize. getBoundingClientRect → fixed coords, no width formula.
  useLayoutEffect(() => {
    if (!visible || !anchorRef.current) return
    const measure = () => {
      const el = anchorRef.current
      if (el) setRect(el.getBoundingClientRect())
    }
    measure()
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
  }, [visible])

  const tip = visible && rect
    ? createPortal(
        <div
          style={{
            position: 'fixed',
            left: Math.round(rect.left),
            // Anchor the BOTTOM edge of the tooltip to the top of the trigger
            // (side='top'): tooltip grows upward, its bottom border stays glued
            // `gap`px above the button regardless of its own height.
            ...(side === 'top'
              ? { bottom: Math.round(window.innerHeight - rect.top + gap) }
              : { top: Math.round(rect.bottom + gap) }),
            maxWidth: 360,
            pointerEvents: 'none',
            zIndex: 9999,
          }}
          className="rounded-md border border-zinc-700 bg-zinc-900/95 backdrop-blur-sm shadow-2xl px-3 py-2 text-zinc-200"
        >
          {content}
        </div>,
        document.body,
      )
    : null

  return (
    <span
      ref={anchorRef}
      className="inline-flex"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {children}
      {tip}
    </span>
  )
}
