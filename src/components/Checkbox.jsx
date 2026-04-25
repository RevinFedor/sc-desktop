import React from 'react'

/**
 * Custom checkbox — uniform across the app.
 *
 * Native <input type="checkbox"> doesn't restyle reliably across platforms
 * (the `accent-color` CSS prop is hit-or-miss on macOS Electron, sizes
 * inconsistent), so we render a fully visual <span> + a tiny invisible
 * native input behind it for keyboard / a11y.
 *
 * Props:
 *   checked        — bool
 *   indeterminate? — bool (mixed state for "select all")
 *   onChange       — (next: bool) => void
 *   size?          — 'sm' (16px) | 'md' (18px, default) | 'lg' (20px)
 *   disabled?      — bool
 *   className?     — extra classes for the outer wrapper
 *   label?         — optional text (the wrapper becomes a <label>)
 */
export default function Checkbox({
  checked,
  indeterminate = false,
  onChange,
  size = 'md',
  disabled = false,
  className = '',
  label,
  onClick,                // optional — propagates to the wrapper
  passive = false,        // see below
}) {
  const dim = size === 'sm' ? 16 : size === 'lg' ? 20 : 18
  const stroke = 2          // px

  const filled = checked || indeterminate
  const baseBg = filled
    ? 'bg-emerald-600 border-emerald-600'
    : 'bg-zinc-900 border-zinc-600 group-hover:border-zinc-400'

  // `passive` mode: the checkbox is purely a visual indicator and lets all
  // pointer events fall through to whatever wrapper handles them (e.g. a
  // row <button> that wants to receive shift-click for range select).

  const Inner = (
    <span
      role="checkbox"
      aria-checked={indeterminate ? 'mixed' : !!checked}
      onClick={passive ? undefined : (e) => {
        if (disabled) return
        e.stopPropagation()
        onChange && onChange(!checked)
        onClick && onClick(e)
      }}
      className={`relative inline-flex items-center justify-center rounded-[5px] border transition-colors shrink-0 ${
        passive ? 'pointer-events-none' : 'cursor-pointer'
      } ${baseBg} ${
        disabled ? 'opacity-40 cursor-not-allowed' : ''
      }`}
      style={{ width: dim, height: dim }}
    >
      {indeterminate ? (
        <svg width={dim - 6} height={dim - 6} viewBox="0 0 16 16" fill="none">
          <line x1="3" y1="8" x2="13" y2="8" stroke="white" strokeWidth={stroke + 0.5} strokeLinecap="round" />
        </svg>
      ) : checked ? (
        <svg width={dim - 4} height={dim - 4} viewBox="0 0 16 16" fill="none">
          <path
            d="M3 8.5L6.5 12L13 4.5"
            stroke="white"
            strokeWidth={stroke + 0.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : null}
    </span>
  )

  if (!label) {
    return <span className={className}>{Inner}</span>
  }
  return (
    <label className={`group inline-flex items-center gap-2 cursor-pointer select-none ${className}`}>
      {Inner}
      <span className="text-zinc-300" style={{ fontSize: '14px' }}>{label}</span>
    </label>
  )
}
