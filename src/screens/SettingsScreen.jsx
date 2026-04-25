import React from 'react'

const SECTIONS = [
  {
    id: 'general', title: 'General',
    rows: [
      { label: 'Library path',   value: '~/Library/Application Support/sc-desktop', kind: 'path' },
      { label: 'Auto-delete mp4 after transcribe', value: 'No', kind: 'toggle' },
      { label: 'Disk quota warning', value: '20 GB', kind: 'text' },
    ],
  },
  {
    id: 'platforms', title: 'Platforms',
    rows: [
      { label: 'Instagram backend',   value: 'auto · api → apify → browser', kind: 'select' },
      { label: 'Instagram session',   value: 'vaito_xr · last login 23h ago', kind: 'text' },
      { label: 'Telegram session',    value: 'connected',                    kind: 'text' },
      { label: 'YouTube cookies',     value: 'firefox',                      kind: 'select' },
    ],
  },
  {
    id: 'engines', title: 'Engines',
    rows: [
      { label: 'Default transcribe engine', value: 'Gemini 2.5 Flash', kind: 'select' },
      { label: 'Long-form fallback',        value: 'AssemblyAI',       kind: 'select' },
      { label: 'AI vision (photos)',        value: 'Gemini 2.0 Flash-Lite', kind: 'select' },
    ],
  },
  {
    id: 'api', title: 'API keys',
    rows: [
      { label: 'GEMINI_API_KEY',     value: '●●●●●●●●', kind: 'secret' },
      { label: 'ASSEMBLYAI_API_KEY', value: '●●●●●●●●', kind: 'secret' },
      { label: 'OPENAI_API_KEY',     value: '(not set)', kind: 'secret' },
      { label: 'Apify token',        value: '●●●●●●●●', kind: 'secret' },
    ],
  },
]

export default function SettingsScreen() {
  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 overflow-auto px-8 py-6">
        <div className="max-w-2xl mx-auto">
          <div className="mb-6">
            <span className="text-xl font-semibold text-zinc-100">Settings</span>
          </div>
          {SECTIONS.map(s => (
            <Section key={s.id} title={s.title} rows={s.rows} />
          ))}
          <div className="text-xs text-zinc-600 mt-8">
            Stored in <code className="text-zinc-500">~/.config/sc/settings.json</code> (shared with the <code className="text-zinc-500">sc</code> CLI).
          </div>
        </div>
      </div>
    </div>
  )
}

function Section({ title, rows }) {
  return (
    <div className="mb-8">
      <div className="text-xs uppercase tracking-wider text-zinc-500 mb-3">{title}</div>
      <div className="rounded-md border border-zinc-800 divide-y divide-zinc-800 bg-zinc-950">
        {rows.map(r => <Row key={r.label} {...r} />)}
      </div>
    </div>
  )
}

function Row({ label, value, kind }) {
  return (
    <div className="flex items-center px-4 py-3 gap-4">
      <div className="text-sm text-zinc-300 flex-1">{label}</div>
      <div className="text-sm text-zinc-500 max-w-[280px] truncate">{value}</div>
      <button className="text-xs text-zinc-500 hover:text-zinc-300 ml-2">
        {kind === 'toggle' ? 'Toggle' : 'Edit'}
      </button>
    </div>
  )
}
