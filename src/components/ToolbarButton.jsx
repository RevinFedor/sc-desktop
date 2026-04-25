import React from 'react'

// Single source-of-truth button for the SourceDetail action-row. All four
// row-level actions — Обзор / Новый запрос / Picker / Скопировать — share
// one height (h-9), one font weight (regular), one corner radius. Visual
// hierarchy comes from `variant`, not from ad-hoc per-button class soup:
//
//   neutral — secondary actions: text on hover-only background. Toggleable
//             items (Обзор/Picker/Скопировать) flip to active=true → solid
//             zinc-800 fill so the user sees what's currently expanded.
//   primary — the main action of the row (Новый запрос…). Outlined +
//             bright text, but NO solid white fill / NO bold — those made
//             the legacy button visually heavier than its neighbours.
//             Active state inverts to filled zinc-800, matching neutral.
//   accent  — long-running / commit-y action (Проиндексировать). Emerald,
//             always emphasised. Active/disabled greys out.
//
// `active` is a separate prop instead of a fourth variant because every
// variant needs its own active visual; folding that into the variant set
// would mean six combos to remember. Keeping them orthogonal means future
// callers don't think "wait, is `primary-active` a thing?".
//
// Width is determined by content + padding; the row uses flex+gap to lay
// the buttons out, so callers don't need to think about width.
export default function ToolbarButton({
  variant = 'neutral',
  active = false,
  disabled = false,
  title,
  onClick,
  className = '',
  // Toggle buttons swap their label when `active` flips ("Новый запрос…"
  // ↔ "Скрыть форму"). Different glyph counts => width jumps by 30-60px
  // every click, which jerks the row. The fix is to render BOTH labels
  // on top of each other (only the active one visible), so the button
  // takes the width of the longest variant for its lifetime.
  //
  // Pass {idle, active} to opt into this. Falls back to `children` when
  // neither is provided — single-label buttons (Index, Picker without
  // toggle words) don't pay the wrapper cost.
  idleLabel,
  activeLabel,
  children,
  ...rest
}) {
  const cls = [
    'h-9 px-3.5 rounded-md inline-flex items-center justify-center gap-1.5 transition-colors',
    'text-sm leading-none',
    variantClasses(variant, active, disabled),
    disabled ? 'cursor-not-allowed' : '',
    className,
  ].filter(Boolean).join(' ')
  const dual = idleLabel != null && activeLabel != null
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title} className={cls} {...rest}>
      {dual ? <DualLabel idle={idleLabel} active={activeLabel} showActive={!!active} /> : children}
    </button>
  )
}

// Render both label variants stacked. The wider one defines the box; we
// show only the chosen one. Using `invisible` (not `display:none`) keeps
// it in flow so the layout calculation is stable. Grid stacking is more
// robust than absolute positioning — no need to manage `relative` parents
// or vertical-align edge cases.
//
// Each variant is `inline-flex … whitespace-nowrap`: labels now carry a
// lucide icon + text, and plain inline layout let the text break onto a
// second line after the icon when the row got tight (flex-shrink squeezes
// the grid box to min-content). nowrap + flex pins icon and text to one
// line, so the button's height never doubles.
function DualLabel({ idle, active, showActive }) {
  const variantCls = 'inline-flex items-center justify-center gap-1.5 whitespace-nowrap'
  return (
    <span className="inline-grid" style={{ gridTemplateAreas: '"label"' }}>
      <span style={{ gridArea: 'label' }} className={`${variantCls} ${showActive ? '' : 'invisible'}`}>{active}</span>
      <span style={{ gridArea: 'label' }} className={`${variantCls} ${showActive ? 'invisible' : ''}`}>{idle}</span>
    </span>
  )
}

function variantClasses(variant, active, disabled) {
  if (disabled) {
    if (variant === 'accent') return 'bg-zinc-800 text-zinc-500'
    return 'text-zinc-600'
  }
  if (variant === 'accent') {
    return active
      ? 'bg-emerald-800 text-white'
      : 'bg-emerald-700 text-white hover:bg-emerald-600'
  }
  if (variant === 'primary') {
    return active
      ? 'bg-zinc-800 text-zinc-100 border border-zinc-700'
      : 'border border-zinc-600 text-zinc-100 hover:bg-zinc-800 hover:border-zinc-500'
  }
  // neutral
  return active
    ? 'bg-zinc-800 text-zinc-100'
    : 'text-zinc-300 hover:bg-zinc-800'
}
