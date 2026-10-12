import React, { useState, useRef, useEffect } from 'react'
import Checkbox from './Checkbox'
import Select from './Select'

// Shared between TelegramConfigForm (single chat) and TelegramScreen (folder
// batch). One source of truth so adding a content type only changes things
// in one place. `processor` is shown right under the label so the user
// always sees what model handles each type — design.md::Detection #1.
export const CONTENT_TYPES = [
  // «Текст» теперь автоматически тянет с собой опросы и реакции — они
  // парсятся бесплатно (одно поле в Telethon-объекте), весят копейки и
  // живут в той же текстовой сборке. Отдельных чекбоксов под них нет.
  { id: 'text',     label: 'Текст',        processor: 'текст + опросы + реакции', default: true },
  { id: 'voice',    label: 'Голосовые',    processor: 'транскрибация',            default: false },
  { id: 'video',    label: 'Видео',        processor: 'транскрибация',            default: false },
  { id: 'photo',    label: 'Фото',         processor: 'Gemini Vision (описание)', default: false },
  { id: 'docs',     label: 'Документы',    processor: 'текстовые локально · PDF через Gemini', default: false },
  // Comments are channel-only (linked discussion group). On folder pages we
  // don't pass per-channel `hasDiscussion`, so we hide that row by default
  // there; single-chat form keeps it for the per-channel awareness.
  { id: 'comments', label: 'Комментарии',  processor: 'обсуждения под постами',   default: false, isComments: true },
]

export const ENGINES = [
  { id: 'assemblyai', label: 'AssemblyAI',       hint: 'Long-form (>2ч подкасты)' },
  { id: 'gemini',     label: 'Gemini 2.5 Flash', hint: 'Быстро, дёшево, чанки 10мин' },
]

export function defaultContent() {
  return Object.fromEntries(CONTENT_TYPES.map(c => [c.id, c.default]))
}

function fmtInt(n) {
  return Number(n || 0).toLocaleString('ru-RU')
}

function fmtDuration(seconds) {
  const s = Math.round(Number(seconds || 0))
  if (!s) return ''
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  return `${m}:${String(sec).padStart(2, '0')}`
}

function previewCountFor(id, preview) {
  const counts = preview?.type_counts
  if (!counts) return null
  if (id === 'text') return (counts.text || 0) + (counts.poll || 0)
  if (id === 'docs') return counts.document ?? null
  return counts[id] ?? null
}

function estimateFor(id, estimate) {
  const by = estimate?.by_type || {}
  if (!by || !estimate?.ok) return null
  const zero = { count: 0, duration_seconds: 0 }
  if (id === 'text') {
    const text = by.text || {}
    const poll = by.poll || {}
    return { count: (text.count || 0) + (poll.count || 0), duration_seconds: 0 }
  }
  if (id === 'docs') return by.document || zero
  return by[id] || zero
}

function TypeEstimateBadge({ id, preview, estimate, busy }) {
  if (busy) {
    return (
      <span
        className="inline-block w-3.5 h-3.5 rounded-full border-2 border-zinc-700 border-t-zinc-300 animate-spin shrink-0"
        title="Считаю по сохранённым сообщениям"
      />
    )
  }

  const local = estimateFor(id, estimate)
  const previewCount = previewCountFor(id, preview)
  const count = local ? local.count : previewCount
  if (count == null) return null
  const duration = local?.duration_seconds || 0
  const durationText = duration > 0 ? fmtDuration(duration) : ''
  return (
    <span
      style={{ fontSize: '13px' }}
      className="text-zinc-400 shrink-0 tabular-nums whitespace-nowrap"
      title={local ? 'По уже сохранённым сообщениям в выбранном диапазоне' : undefined}
    >
      {fmtInt(count)}{durationText ? ` · ${durationText}` : ''}
    </span>
  )
}

/**
 * Compact multi-select for Telegram content types. One-line button shows
 * what's picked; click opens a popover with checkboxes.
 *
 * Props:
 *   content        — { text: bool, voice: bool, ... }
 *   onChange(next) — replacement (or updater) for the content map
 *   preview        — pre-analysis result with `type_counts` (optional;
 *                    drives the right-side counter on each row)
 *   hasDiscussion  — true | false | null. When false the «Комментарии» row
 *                    becomes disabled with a hint. Pass null on folder
 *                    pages to skip that row entirely.
 *   showComments   — explicitly hide the «Комментарии» row when irrelevant
 *                    (folder mode). Defaults to true (single-chat form).
 *   engine, onEngineChange — optional. When provided, the «Голосовые» row
 *                    grows a nested <Select> on the right that picks the
 *                    transcription engine ('assemblyai' | 'gemini'). Only
 *                    visible while voice OR video is on (engine drives both —
 *                    same gemini_utils.transcribe_audio under the hood).
 *                    Click on the engine select doesn't toggle the row's
 *                    voice checkbox (stopPropagation in the wrapper).
 */
export function TelegramTypesPopover({
  content, onChange, preview = null, hasDiscussion = null,
  showComments = true,
  engine = null, onEngineChange = null,
  mediaEstimate = null,
  estimateBusy = false,
}) {
  const showEngineRow = !!onEngineChange
    && (content.voice || content.video)
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)
  useEffect(() => {
    if (!open) return
    function onDoc(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const visibleTypes = showComments
    ? CONTENT_TYPES
    : CONTENT_TYPES.filter(c => !c.isComments)

  const picked = visibleTypes.filter(c => content[c.id])
  const summary = picked.length === 0
    ? 'не выбрано'
    : picked.map(c => c.label).join(' · ')

  return (
    <div ref={wrapRef} className="relative inline-block min-w-0">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        // No width cap: the summary shows in full. When many types are picked
        // («Текст · Голосовые · Видео · Фото · Документы · Комментарии») the
        // button just grows; the row is flex-wrap so the topics popover wraps
        // to the next line instead of the summary collapsing into a «…».
        className={`flex items-center gap-2 rounded-md border px-3 py-1.5 ${
          open ? 'bg-zinc-900 border-zinc-500'
               : 'bg-zinc-900 border-zinc-700 hover:border-zinc-600'
        }`}
        style={{ fontSize: '14px' }}
        title={picked.length > 0 ? summary : undefined}
      >
        <span className={
          picked.length === 0 ? 'text-zinc-500' : 'text-zinc-100'
        }>
          {summary}
        </span>
        <svg
          width="12" height="12" viewBox="0 0 24 24"
          className={`shrink-0 text-zinc-500 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none" stroke="currentColor" strokeWidth="2"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (() => {
        // Header "Все" row: tri-state checkbox over the rows below. We treat
        // disabled rows (comments without a linked discussion) as outside
        // the population — they're not toggleable, so neither "all" nor
        // "none" should depend on them. Same logic for the click handler.
        const toggleable = visibleTypes.filter(
          c => !(c.isComments && hasDiscussion === false)
        )
        const onCount = toggleable.filter(c => content[c.id]).length
        const totalCount = toggleable.length
        const allOn = totalCount > 0 && onCount === totalCount
        const noneOn = onCount === 0
        const indeterminate = !allOn && !noneOn
        // "All" click target — flips every toggleable row to the new state.
        // When some are on (indeterminate), the convention is: click → all on.
        // Click on already-all-on → all off.
        const flipAll = () => {
          const next = !allOn
          onChange(prev => {
            const out = { ...prev }
            for (const c of toggleable) out[c.id] = next
            return out
          })
        }
        const summaryLine = noneOn
          ? 'Ничего не выбрано'
          : allOn
            ? `Выбрано всё · ${totalCount}`
            : `Выбрано ${onCount} из ${totalCount}`
        return (
        <div className="absolute z-50 mt-1 left-0 w-[420px] rounded-md border border-zinc-700 bg-zinc-900 shadow-2xl py-1">
          <div
            role="button"
            tabIndex={0}
            onClick={flipAll}
            onKeyDown={(e) => {
              if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flipAll() }
            }}
            className="px-3 py-1.5 flex items-center gap-2.5 hover:bg-zinc-800 cursor-pointer text-zinc-200 border-b border-zinc-800"
          >
            <Checkbox
              checked={allOn}
              indeterminate={indeterminate}
              onChange={flipAll}
              size="sm"
            />
            <div className="flex-1 min-w-0 leading-tight">
              <span className="truncate">
                {allOn ? 'Снять всё' : indeterminate ? 'Выбрать всё' : 'Выбрать всё'}
              </span>
              <span className="text-zinc-500 ml-2" style={{ fontSize: '12px' }}>
                {summaryLine}
              </span>
            </div>
          </div>
          {visibleTypes.map(c => {
            const isOn = !!content[c.id]
            const disabled = c.isComments && hasDiscussion === false
            const hint = disabled ? 'У канала нет обсуждений' : c.processor
            // Whole-row click handler: toggle the same way the Checkbox
            // would. Checkbox itself stopPropagation's on its own click,
            // so a direct click on the box flips state via Checkbox and
            // the row handler doesn't double-fire. Click anywhere else
            // (label, processor text, count) bubbles to this onClick and
            // toggles too — matches user expectation that the row IS the
            // checkbox.
            const toggle = (e) => {
              if (disabled) return
              onChange(prev => ({ ...prev, [c.id]: !isOn }))
            }
            return (
              <div
                key={c.id}
                role="button"
                tabIndex={disabled ? -1 : 0}
                onClick={toggle}
                onKeyDown={(e) => {
                  if (disabled) return
                  if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(e) }
                }}
                className={`px-3 py-2 flex items-center gap-2.5 hover:bg-zinc-800 ${
                  isOn ? 'text-zinc-100' : 'text-zinc-300'
                } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                title={disabled ? hint : ''}
              >
                <Checkbox
                  checked={isOn}
                  onChange={next => {
                    if (disabled) return
                    onChange(prev => ({ ...prev, [c.id]: next }))
                  }}
                  size="sm"
                  disabled={disabled}
                />
                <div className="flex-1 min-w-0 leading-tight">
                  <div className="truncate">{c.label}</div>
                  <div style={{ fontSize: '12px' }} className="text-zinc-500 truncate">{hint}</div>
                </div>
                {/* Voice row gets a nested engine select on the right when
                    the caller wired engine state in. Lives inside the row
                    visually but doesn't toggle the row's checkbox: the
                    Select wrapper stops propagation so click → opens engine
                    dropdown, not flips voice on/off. Hidden when neither
                    voice nor video is on (engine has nothing to drive yet)
                    to avoid premature noise. Same engine governs video too,
                    that's why we show this row even with video-only on. */}
                <div className="ml-auto flex items-center gap-2 shrink-0">
                  {c.id === 'voice' && showEngineRow && (
                    <div
                      className="shrink-0 w-[128px]"
                      onClick={e => e.stopPropagation()}
                      onKeyDown={e => e.stopPropagation()}
                    >
                      <Select
                        value={engine || 'assemblyai'}
                        onChange={onEngineChange}
                        options={ENGINES}
                        compact
                        hideHint
                      />
                    </div>
                  )}
                  {!c.isComments && (
                    <TypeEstimateBadge
                      id={c.id}
                      preview={preview}
                      estimate={mediaEstimate}
                      busy={estimateBusy && isOn}
                    />
                  )}
                </div>
              </div>
            )
          })}
        </div>
        )
      })()}
    </div>
  )
}
