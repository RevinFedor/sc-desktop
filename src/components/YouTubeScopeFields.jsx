import React from 'react'

// Minimal scope-fields for YouTube channel fetches. Mirrors the visual
// language of <TelegramScopeFields> (RowLabel + h-9 inputs) but only
// surfaces what the backend actually understands:
//
//   yt_channel_ndjson.py — `--limit N` and `--reverse` (oldest-first).
//   No date filters: yt-dlp `--playlist-end N` slices by *count*, not
//   by upload timestamp. Adding a date window would mean post-filtering
//   the resulting list in Python — same network cost, only smaller
//   client-visible result. Not worth introducing here.
//
// `range` shape:
//   { limit: '50', direction: 'newest' | 'oldest' }
//
// Keeps state-shape compatible across uses (PasteScreen kickoff +
// SourceDetail quick fetch). 0 in the limit field = «весь канал» —
// the backend treats limit≤0 as «no playlist-end cap».
export const DEFAULT_YT_RANGE = { limit: '50', direction: 'newest' }

export default function YouTubeScopeFields({ range, onRangeChange, children }) {
  function patch(p) { onRangeChange({ ...range, ...p }) }
  return (
    <div className="space-y-3">
      <RowLabel label="Каталог">
        <div className="flex items-center gap-2 min-h-[34px]">
          <input
            type="number"
            min="0"
            max="2000"
            value={range.limit}
            onChange={e => patch({ limit: e.target.value })}
            className="bg-zinc-900 border border-zinc-700 rounded-md px-3 py-1.5 w-24 focus:outline-none focus:border-zinc-500"
            style={{ fontSize: '14px' }}
            placeholder="50"
          />
          <span className="text-zinc-500" style={{ fontSize: '13px' }}>
            видео
          </span>
          <DirectionToggle value={range.direction} onChange={v => patch({ direction: v })} />
          <span className="text-zinc-500" style={{ fontSize: '13px' }}>0 = весь канал</span>
          <div className="ml-auto flex items-center gap-1.5">{children}</div>
        </div>
      </RowLabel>
    </div>
  )
}

function RowLabel({ label, children }) {
  return (
    <div className="grid grid-cols-[120px_1fr] items-start gap-3 py-1.5">
      <div
        className="uppercase tracking-wider text-zinc-500 pt-2"
        style={{ fontSize: '11px' }}
      >{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

// Same icon-only toggle as in TelegramScopeFields. Kept duplicated rather
// than extracted because pulling it into a shared module would drag along
// styling tokens that aren't yet stable enough to spec.
function DirectionToggle({ value, onChange }) {
  const isOldest = value === 'oldest'
  return (
    <div className="h-[34px] inline-flex rounded-md border border-zinc-700 overflow-hidden" aria-label="Какие видео загружать">
      <button
        type="button"
        onClick={() => onChange('newest')}
        aria-pressed={!isOldest}
        className={`px-3 transition-colors ${!isOldest ? 'bg-zinc-100 text-zinc-900' : 'bg-zinc-900 text-zinc-400 hover:text-zinc-100'}`}
      >Новые</button>
      <button
        type="button"
        onClick={() => onChange('oldest')}
        aria-pressed={isOldest}
        className={`px-3 border-l border-zinc-700 transition-colors ${isOldest ? 'bg-zinc-100 text-zinc-900' : 'bg-zinc-900 text-zinc-400 hover:text-zinc-100'}`}
      >Старые</button>
    </div>
  )
}
