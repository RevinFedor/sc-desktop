import React from 'react'

export default function ToggleSwitch({ checked, onChange, label, onLabel, offLabel, disabled = false, className = '', ...props }) {
  return (
    <button {...props} type="button" role="switch" aria-checked={!!checked} aria-label={label}
      disabled={disabled} onClick={() => onChange(!checked)}
      className={`inline-flex items-center gap-3 cursor-pointer select-none disabled:opacity-40 disabled:cursor-not-allowed rounded focus-visible:outline-2 focus-visible:outline-emerald-500 ${className}`}>
      <span aria-hidden="true" className={`relative w-9 h-5 rounded-full shrink-0 transition-colors ${checked ? 'bg-emerald-600' : 'bg-zinc-700'}`}>
        <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${checked ? 'translate-x-4' : 'translate-x-0'}`} />
      </span>
      {(onLabel || offLabel) && <span aria-hidden="true" className="inline-grid text-sm text-zinc-300 text-left">
        <span style={{ gridArea: '1 / 1' }} className={`whitespace-nowrap ${checked ? '' : 'invisible'}`}>{onLabel}</span>
        <span style={{ gridArea: '1 / 1' }} className={`whitespace-nowrap ${checked ? 'invisible' : ''}`}>{offLabel}</span>
      </span>}
    </button>
  )
}
