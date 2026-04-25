import React from 'react'

const OPTIONS = [
  { id: 'api', title: 'Free', subtitle: 'browser cookies' },
  { id: 'auto', title: 'Auto', subtitle: 'fallback Apify' },
  { id: 'apify', title: 'Apify', subtitle: 'paid actor' },
]

export default function RedditBackendControl({ value, onChange, disabled = false }) {
  return (
    <div>
      <label className="block text-xs text-zinc-500 mb-1">Backend</label>
      <div className="grid grid-cols-3 gap-1 rounded-md border border-zinc-800 bg-zinc-900 p-1">
        {OPTIONS.map(opt => {
          const active = value === opt.id
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => onChange(opt.id)}
              disabled={disabled}
              className={[
                'min-w-0 rounded px-2 py-1.5 text-left transition-colors',
                active
                  ? 'bg-orange-600 text-white'
                  : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200',
                disabled ? 'cursor-not-allowed opacity-60' : '',
              ].join(' ')}
            >
              <div className="truncate text-xs font-medium">{opt.title}</div>
              <div className={['truncate text-[11px]', active ? 'text-orange-100' : 'text-zinc-500'].join(' ')}>
                {opt.subtitle}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
