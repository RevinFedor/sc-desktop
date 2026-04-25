import React from 'react'
import { ArrowLeftRight } from 'lucide-react'

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
      <RowLabel label="Сколько">
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
          <DirectionToggle value={range.direction} onChange={v => patch({ direction: v })} />
          <span className="text-zinc-500" style={{ fontSize: '13px' }}>
            видео · 0 = весь канал
          </span>
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
  const next = isOldest ? 'newest' : 'oldest'
  const title = isOldest
    ? 'Берём N самых старых видео (от первого видео канала). Клик → переключить на «с конца».'
    : 'Берём N самых свежих видео (от последнего загруженного). Клик → переключить на «с начала».'
  return (
    <button
      type="button"
      onClick={() => onChange(next)}
      title={title}
      aria-label={isOldest ? 'Сейчас: с начала' : 'Сейчас: с конца'}
      aria-pressed={isOldest}
      className={`inline-flex items-center justify-center h-[34px] w-[34px] rounded-md border transition-colors ${
        isOldest
          ? 'bg-zinc-100 text-zinc-900 border-zinc-100 hover:bg-white'
          : 'bg-zinc-900 text-zinc-300 border-zinc-700 hover:border-zinc-500 hover:text-zinc-100'
      }`}
    >
      <ArrowLeftRight size={14} className="shrink-0" />
    </button>
  )
}
