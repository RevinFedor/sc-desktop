import React from 'react'
import { ChevronRight, Zap, Loader2 } from 'lucide-react'
import CmdHoverTooltip from './CmdHoverTooltip'

// Split «Новый запрос» control for the SourceDetail action-row (Telegram).
//
// Two segments under one outline, matching ToolbarButton variant="primary"
// height (h-9) and colour so it sits flush with its row neighbours:
//
//   ┌─────────────────────────────┬─────┐
//   │ ›  Новый запрос…            │  ⚡  │
//   └─────────────────────────────┴─────┘
//      left: toggle inline form       right: instant catch-up fetch
//
// • Left segment — toggles the inline TelegramConfigForm. Fixed width and a
//   CONSTANT label («Новый запрос…», never swapped to «Скрыть форму»); open
//   state is shown by the left chevron rotating 90° (collapsible convention),
//   so the button never changes width or text on click.
// • Right segment — fires a one-click sync_new catch-up (last saved message →
//   now) with the user's last-used content/engine, WITHOUT opening the form.
//   Lightning glyph = "instant". Spins a loader while a catch-up job runs.
//
// Cmd+hover over either segment surfaces the current params (the tooltip is
// supplied by the caller as `tooltipContent`).
export default function NewRequestSplitButton({
  open = false,
  onToggle,
  onQuickFetch,
  busy = false,
  quickDisabled = false,
  quickTitle,
  tooltipContent = null,
}) {
  const base = open
    ? 'bg-zinc-800 text-zinc-100'
    : 'text-zinc-100 hover:bg-zinc-800'
  return (
    <CmdHoverTooltip content={tooltipContent}>
      <div
        className={`h-9 inline-flex items-stretch rounded-md border overflow-hidden ${
          open ? 'border-zinc-700' : 'border-zinc-600 hover:border-zinc-500'
        }`}
      >
        {/* Left — toggle form. Fixed width keeps the row stable. */}
        <button
          type="button"
          onClick={onToggle}
          title="Открыть форму с параметрами запроса"
          className={`w-[190px] px-3.5 inline-flex items-center gap-2 text-sm leading-none transition-colors ${base}`}
        >
          <ChevronRight
            size={15}
            className={`shrink-0 text-zinc-400 transition-transform ${open ? 'rotate-90' : ''}`}
          />
          <span className="shrink-0">Новый запрос…</span>
        </button>

        {/* Divider between the two segments. */}
        <span className={`w-px self-stretch ${open ? 'bg-zinc-700' : 'bg-zinc-600'}`} />

        {/* Right — instant catch-up. Icon-only; loader while a job runs. */}
        <button
          type="button"
          onClick={onQuickFetch}
          disabled={busy || quickDisabled}
          title={quickTitle || 'Догрузить новые сообщения (от последнего до сейчас) с текущими параметрами'}
          className={`w-10 inline-flex items-center justify-center transition-colors ${
            busy || quickDisabled
              ? 'text-zinc-600 cursor-not-allowed'
              : 'text-emerald-300 hover:bg-emerald-900/30 hover:text-emerald-200'
          }`}
        >
          {busy
            ? <Loader2 size={15} className="animate-spin" />
            : <Zap size={15} className="shrink-0" />}
        </button>
      </div>
    </CmdHoverTooltip>
  )
}
