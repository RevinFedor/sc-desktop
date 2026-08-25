import React, { useEffect, useRef, useState } from 'react'
import { Brain, ChevronLeft, ChevronRight } from 'lucide-react'

/**
 * Semantic-index button for the action-row in SourceDetail.
 *
 *   [ ◀ full|N ] [ Проиндексировать (full|N) ]
 *
 * Left chevron-button toggles a slide-in numeric input that defines a limit
 * (last N messages by published_at). Empty input = full mode. The main button
 * triggers the actual job — label reflects current limit so the user always
 * sees what will run.
 *
 * Keeps row height stable: input slides INTO the same flex row from the left
 * (no absolute positioning, no margin tricks).
 */
export default function IndexButton({ sourceId, status, onStart }) {
  const [open, setOpen] = useState(false)
  const [limitStr, setLimitStr] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus()
  }, [open])

  const limit = (() => {
    const n = parseInt(limitStr, 10)
    return Number.isFinite(n) && n > 0 ? n : null
  })()
  const labelLimit = limit ? limit.toLocaleString() : 'full'

  const indexing = status?.state === 'running'
  const complete = !indexing
    && Number(status?.total || 0) > 0
    && Number(status?.done || 0) >= Number(status?.total || 0)
  const pct = indexing && status?.total
    ? Math.min(100, Math.round((status.done / status.total) * 100))
    : null

  const mainLabel = indexing
    ? `Индексирую… ${status?.done?.toLocaleString() ?? 0} / ${status?.total?.toLocaleString() ?? '?'}${pct != null ? ` (${pct}%)` : ''}`
    : complete
      ? 'Индекс готов'
    : `Проиндексировать (${labelLimit})`

  return (
    <div className="ml-auto flex items-center gap-1">
      {/* Slide-in input. Renders before the chevron so it visually
          extends LEFT from the chevron (which pivots the row). */}
      {open && (
        <input
          ref={inputRef}
          type="number"
          min="1"
          step="100"
          placeholder="N сообщ."
          value={limitStr}
          onChange={(e) => setLimitStr(e.target.value.replace(/\D+/g, ''))}
          className="w-32 h-9 px-3 rounded-md bg-zinc-900 border border-zinc-700 text-zinc-100 text-sm focus:outline-none focus:border-zinc-500"
          title="Количество последних сообщений (от новых). Пусто = все."
        />
      )}

      {/* Chevron toggle — shows current mode marker (full|N). */}
      <button
        onClick={() => setOpen(v => !v)}
        disabled={indexing || complete}
        className={`h-9 px-2 rounded-md text-xs font-medium inline-flex items-center gap-1 ${
          open
            ? 'bg-zinc-800 text-zinc-100'
            : 'text-zinc-400 hover:bg-zinc-800'
        } disabled:opacity-50`}
        title="Задать лимит (от самых новых)"
      >
        {open ? <ChevronRight size={14} className="shrink-0" /> : <ChevronLeft size={14} className="shrink-0" />} {labelLimit}
      </button>

      {/* Main button. Fixed min-width so the label swinging from
          «Проиндексировать (full)» to «Индексирую… 12 000 / 32 145 (37%)»
          doesn't reflow the action-row on every progress tick. The live label
          is the wider one; min-w sized for it + tabular-nums keeps the digits
          from jittering. justify-center so the shorter idle label stays
          centred inside the reserved width. */}
      <button
        data-index-start
        onClick={() => onStart?.(limit)}
        disabled={indexing || complete}
        className="h-9 px-4 min-w-[260px] inline-flex items-center justify-center rounded-md font-medium tabular-nums bg-emerald-700 text-white hover:bg-emerald-600 disabled:bg-zinc-800 disabled:text-zinc-500 disabled:cursor-not-allowed"
        title={
          indexing
            ? 'Индексация уже идёт'
            : complete
              ? 'Все сообщения уже проиндексированы'
            : 'Создать семантический индекс по сообщениям (Gemini embeddings)'
        }
      >
        <Brain size={16} className="shrink-0" /> {mainLabel}
      </button>
    </div>
  )
}
