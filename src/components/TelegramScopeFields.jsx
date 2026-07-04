import React, { useEffect, useState } from 'react'
import { ArrowLeftRight } from 'lucide-react'
import Select from './Select'
import Checkbox from './Checkbox'
import TelegramTopicsPopover from './TelegramTopicsPopover'
import {
  CONTENT_TYPES, ENGINES, defaultContent,
  TelegramTypesPopover,
} from './TelegramTypesPopover'

// Single source-of-truth presentational fieldset shared by:
//   • TelegramConfigForm (use="fetch")  — runs a tg_fetch job
//   • CopySavedPanel    (use="copy")   — assembles already-saved items
//
// Both flows pick the same conceptual slice — date range × content types ×
// optional topic — so the inputs are identical. The differences live OUTSIDE
// this component (estimate vs. preview, Start fetch vs. Save/Copy actions).
//
// Anything `use`-specific is gated explicitly:
//   • range modes      — `between` / `single` are fetch-only (need URLs;
//                        copy works against rows already in the DB)
//   • engine select    — fetch-only (decides which model transcribes new
//                        media; copy reads transcripts already on disk)
//   • comments inputs  — fetch: «Комментарии» tile lives inside the types
//                        popover (it's a kind of content to download), with
//                        a per-post limit row when on. Copy: a flat checkbox
//                        outside the types group ("с комментариями"), no
//                        limit — the slice ships whatever's already on disk.

// Time-presets that resolve to the same `from_date` shape downstream as
// the manual `from_date` mode. Centralised here so any caller (forms,
// scope-builders, label lookup) reads the day-count from one source.
// `days` = days back from now; `id` = `last_<key>` so it's distinct from
// the open-ended `last_n` mode (which counts MESSAGES, not days).
// Single-week preset is the only "по-быстрому" entry the user asked to keep —
// the rest (day, 3 days, 2 weeks, month, 3 months) cluttered the dropdown
// without adding decisive value. Manual ranges (from_date / date_range /
// last_n) cover everything finer-grained than week. Add a preset back here
// only when the same constant is requested by hand more than ~3 times.
export const PERIOD_PRESETS = [
  { id: 'last_week',    label: 'Последняя неделя',   days: 7 },
]

// Quick id ⇄ days lookup for scope builders.
const PRESET_BY_ID   = Object.fromEntries(PERIOD_PRESETS.map(p => [p.id, p]))
const PRESET_BY_DAYS = Object.fromEntries(PERIOD_PRESETS.map(p => [p.days, p]))
export function presetDaysOf(id) { return PRESET_BY_ID[id]?.days ?? null }
export function presetIdForDays(days) { return PRESET_BY_DAYS[days]?.id ?? null }

// Preset-only range modes for callers who don't pick a custom date or row
// count (TelegramScreen folder batch — period applies the same way to all
// selected chats; manual `from_date`/`date_range` lives there too for
// non-preset windows). `last_n`/`between`/`single` are excluded — they
// either need a single chat's URL or counts that mean different things
// across N chats.
export const FOLDER_RANGE_MODES = [
  { id: 'last_week',             label: 'Последняя неделя',  hint: 'За 7 дней до сегодня' },
  ...PERIOD_PRESETS.filter(p => p.id !== 'last_week').map(p => ({ id: p.id, label: p.label, hint: `За ${p.days} дн до сегодня` })),
  { id: 'all',                   label: 'Вся история',       hint: 'Всё что сохранено в БД' },
  { id: 'date_range',            label: 'Диапазон дат',      hint: 'От первой даты; вторая — опционально' },
]

// `Последняя неделя` is the 2nd item — most-common preset for catching up.
// Single message lives on Home (paste t.me/.../id), no longer in the form.
export const FETCH_RANGE_MODES = [
  { id: 'last_n',                label: 'Последние N',       hint: 'Самый быстрый — берёт последние сообщения' },
  { id: 'last_week',             label: 'Последняя неделя',  hint: 'За 7 дней до сегодня' },
  ...PERIOD_PRESETS.filter(p => p.id !== 'last_week').map(p => ({ id: p.id, label: p.label, hint: `За ${p.days} дн до сегодня` })),
  { id: 'date_range',            label: 'Диапазон дат',      hint: 'От первой даты; вторая — опционально' },
  { id: 'between',               label: 'Между двумя URL',   hint: 'Все сообщения между двумя ссылками' },
  { id: 'all',                   label: 'Весь чат',          hint: 'Долго и прожорливо — будь уверен' },
]

export const COPY_RANGE_MODES = [
  { id: 'all',                   label: 'Весь чат',          hint: 'Всё что сохранено в БД' },
  { id: 'last_week',             label: 'Последняя неделя',  hint: 'За 7 дней до сегодня' },
  ...PERIOD_PRESETS.filter(p => p.id !== 'last_week').map(p => ({ id: p.id, label: p.label, hint: `За ${p.days} дн до сегодня` })),
  { id: 'last_n',                label: 'Последние N',       hint: 'Самый свежий хвост' },
  { id: 'date_range',            label: 'Диапазон дат',      hint: 'От первой даты; вторая — опционально' },
]

// Fresh, mode-aware default for the Range state. Pass into useState in the
// container so both call-sites start sane:
//   const [range, setRange] = useState(() => defaultRange('fetch'))
//
// `direction` only matters when mode === 'last_n':
//   'newest' — N freshest messages (default; matches old behaviour)
//   'oldest' — N earliest messages from the chat's start
// The toggle is rendered next to the N input in last_n mode.
//
// `skipDupes` is fetch-only and `last_n`-only: when on (default), the
// runner sends `--since-msgid <maxExternalId>` so Telethon's iter_messages
// returns N messages STRICTLY NEWER than what we already saved. If saved
// = 30 000 and N = 500, you get the 500 newest unseen messages, not the
// 500 newest in the chat (which would be ~all dupes). Off → legacy
// behaviour (last 500 from the whole chat, idempotent UPSERT dedupes
// after the fact but you waste roundtrips).
export function defaultRange(use) {
  const base = {
    lastN: '500', fromDate: '', toDate: '', url1: '', url2: '',
    direction: 'newest',
    // Internal min_id windowing for last_n. Default ON; the user no longer
    // sees a toggle for this (it didn't match user intent — they assumed it
    // controlled re-transcription, not fetch range). See `redoProcessed`
    // below for the actual user-facing knob.
    skipDupes: true,
    // User-facing «парсить заново» toggle. Default OFF — re-fetching a chat
    // skips messages whose voice/photo/PDF was already AI-processed in a
    // previous run (transcribe_status='done' in items table). Set this to
    // true to force a full re-process from scratch — e.g. after a code
    // change in the AI pipeline you want to verify against fresh transcripts.
    redoProcessed: false,
  }
  return use === 'copy'
    ? { ...base, mode: 'all' }
    : { ...base, mode: 'last_n' }
}

/**
 * Props (presentational — no IPC, no estimates):
 *   use                 — 'fetch' | 'copy'
 *   range, onRangeChange — { mode, lastN, fromDate, toDate, url1, url2 }
 *   content, onContentChange — { text, voice, video, photo, docs, comments }
 *   engine, onEngineChange   — 'assemblyai' | 'gemini' (fetch only)
 *   commentsLimit, onCommentsLimitChange — string; '' = «все» (fetch only)
 *   withComments, onWithCommentsChange   — bool (copy only — flat toggle)
 *   topicId, onTopicIdChange — number | null
 *   topics              — [{ id, title, count }] | null (forum chats only)
 *   preview             — pre-analysis result feeding the popover counters
 *                         (fetch only — passed when fresh, null when stale)
 *   hasDiscussion       — true | false | null (drives «Комментарии» state)
 *   commentsCount       — int | null (copy only — disables «с комментариями»
 *                         when 0 with a hint)
 *   children            — slot rendered AFTER the standard rows (Analyze
 *                         button + PreviewLine in fetch, nothing in copy)
 */
export default function TelegramScopeFields({
  use,
  range, onRangeChange,
  content, onContentChange,
  engine, onEngineChange,
  commentsLimit, onCommentsLimitChange,
  withComments, onWithCommentsChange,
  topicId, onTopicIdChange,
  topics,
  // Pre-fetch topic multi-select. Optional — if either prop missing, the
  // row hides. `topicIds` is a Set<number> | array<number> of `top_msg_id`s
  // user wants to fetch; empty Set = «Все темы» (no `reply_to` filter at
  // all, server returns the full chat). Only relevant in fetch flow with
  // a forum chat — copy flow keeps the single-topic filter via topicId.
  topicIds, onTopicIdsChange,
  preview = null,
  mediaEstimate = null,
  mediaEstimateBusy = false,
  hasDiscussion = null,
  commentsCount = null,
  // Optional overrides for callers whose situation isn't pure fetch/copy.
  // TelegramScreen (folder batch) passes a trimmed mode list (presets only —
  // no `last_n`/`between` because counts/URLs don't apply across N chats)
  // and forces engine on (fetch-side need but with copy-style comments
  // toggle). Defaults preserve the original use=fetch|copy semantics.
  rangeModes,
  showEngine: showEngineProp,
  children,
}) {
  const RANGE_MODES = rangeModes || (use === 'copy' ? COPY_RANGE_MODES : FETCH_RANGE_MODES)
  const isForum = (topics || []).length > 1
  const showEngine = showEngineProp != null
    ? (showEngineProp && (content.voice || content.video) && onEngineChange)
    : (use === 'fetch' && (content.voice || content.video))
  const showCommentsLimit = use === 'fetch' && content.comments
  const showCopyCommentsToggle = use === 'copy' && onWithCommentsChange
  const noCommentsAvailable = use === 'copy' && commentsCount === 0

  function patch(p) { onRangeChange({ ...range, ...p }) }

  return (
    <div className="space-y-3">
      {/* ── Range row ───────────────────────────────────────────
          Three deterministic columns: Select (fixed 240px — wide enough
          for the longest label without truncation) · params (1fr,
          mode-specific inputs) · slot (fixed). The Select width never
          changes between modes; the slot (Analyze button in fetch) never
          wraps to a second line because params is the only flexible col. */}
      <RowLabel label="Диапазон">
        <div className="grid items-start gap-2"
             style={{ gridTemplateColumns: '180px minmax(0, 1fr) auto' }}>
          <Select value={range.mode} onChange={m => patch({ mode: m })}
                  options={RANGE_MODES} compact hideHint />
          <div className="min-w-0">
            <RangeParams
              mode={range.mode}
              lastN={range.lastN} setLastN={v => patch({ lastN: v })}
              // Direction toggle is copy-only for now: assemblyEstimate /
              // assemblyFetch read it, but tg_fetch_json.py doesn't accept
              // a `--reverse` flag yet. Adding it would mean a Python-side
              // CLI change and is its own task.
              direction={use === 'copy' ? range.direction : null}
              setDirection={v => patch({ direction: v })}
              fromDate={range.fromDate} setFromDate={v => patch({ fromDate: v })}
              toDate={range.toDate} setToDate={v => patch({ toDate: v })}
              url1={range.url1} setUrl1={v => patch({ url1: v })}
              url2={range.url2} setUrl2={v => patch({ url2: v })}
              // Skip-dupes is meaningful only in fetch + last_n. For copy
              // we don't show the toggle (copy operates on what's already
              // in the DB, dupes don't apply). Pass undefined to hide.
              skipDupes={use === 'fetch' ? !!range.skipDupes : undefined}
              setSkipDupes={v => patch({ skipDupes: v })}
            />
          </div>
          {/* Slot for fetch's [⓲ Анализ] button. Empty in copy mode — but
              the column still exists so layout doesn't shift. */}
          <div className="ml-auto flex items-center gap-1.5">{children}</div>
        </div>
      </RowLabel>

      {/* ── Types row ─── two popovers on one strip: types on the left,
          topics popover on the right for forum chats. Same layout in
          fetch and copy — copy uses single-select inside, fetch uses
          multi-select. Engine select lives nested in the «Голосовые» row
          of the types popover (fetch only). */}
      <RowLabel label="Типы контента">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <TelegramTypesPopover
            content={content}
            onChange={onContentChange}
            preview={preview}
            hasDiscussion={hasDiscussion}
            // Copy-flow has its own flat «с комментариями» toggle — hiding
            // the popover row prevents two controls fighting over the same
            // concept (one downloads, the other formats).
            showComments={use === 'fetch'}
            // Engine is fetch-only; copy mode just formats existing items.
            engine={showEngine ? engine : null}
            onEngineChange={showEngine ? onEngineChange : null}
            mediaEstimate={mediaEstimate}
            estimateBusy={mediaEstimateBusy}
          />
          {isForum && use === 'fetch' && onTopicIdsChange && (
            <TelegramTopicsPopover
              topics={topics}
              selectedIds={topicIds || new Set()}
              onChange={onTopicIdsChange}
            />
          )}
          {isForum && use === 'copy' && onTopicIdChange && (
            <TelegramTopicsPopover
              mode="single"
              topics={topics}
              selectedId={topicId}
              onChange={onTopicIdChange}
            />
          )}
        </div>
      </RowLabel>

      {/* Comments per-post limit. Visible only when «Комментарии» is on
          in fetch mode — controls the Telethon pagination per linked post. */}
      {showCommentsLimit && (
        <RowLabel label="Комментариев на пост">
          <CommentsLimitControl value={commentsLimit} onChange={onCommentsLimitChange} />
        </RowLabel>
      )}

      {/* Copy-only flat toggle. Lives outside the types popover because the
          semantic differs: in copy it shapes the *output text* (comment
          threads inserted under each post), not what we download. */}
      {showCopyCommentsToggle && (
        <RowLabel label=" ">
          <label className={`inline-flex items-center gap-2 select-none ${
            noCommentsAvailable ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
          }`}>
            <Checkbox
              checked={!!withComments && !noCommentsAvailable}
              onChange={onWithCommentsChange}
              size="sm"
              disabled={noCommentsAvailable}
            />
            <span className="text-zinc-300">с комментариями</span>
            <span className="text-zinc-500" style={{ fontSize: '13px' }}>
              {noCommentsAvailable
                ? '— под постами ничего не сохранено'
                : '— после каждого поста добавится тред из обсуждения'}
            </span>
          </label>
        </RowLabel>
      )}

    </div>
  )
}

// ─── Layout helpers ──────────────────────────────────────────────────────

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

// Mode-specific inputs for the Range row. Each branch lives in a slot of
// fixed minimum height so the rest of the row (and especially the slot
// passed via `children`) never jumps when the user switches mode.
//
// `all` and `single` have no extra inputs — the parent's min-h-[34px]
// keeps vertical alignment stable across mode switches.
function RangeParams({
  mode,
  lastN, setLastN, direction, setDirection,
  fromDate, setFromDate, toDate, setToDate,
  url1, setUrl1, url2, setUrl2,
  skipDupes, setSkipDupes,
}) {
  return (
    <div className="flex items-center gap-2 min-h-[34px] flex-wrap">
      {mode === 'last_n' && (
        <>
          {/* Direction lives BETWEEN the range Select (column 1 of the
              parent grid) and the N input — sits flush against the input
              so the eye reads "[range mode] [↔] [N]" as one composite
              control. */}
          {direction != null && (
            <DirectionToggle value={direction} onChange={setDirection} />
          )}
          <input
            type="number"
            value={lastN}
            onChange={e => setLastN(e.target.value)}
            className="bg-zinc-900 border border-zinc-700 rounded-md px-3 py-1.5 w-24 focus:outline-none focus:border-zinc-500"
            style={{ fontSize: '14px' }}
            placeholder="500"
          />
          {/* The «пропускать дубли» pill lived here historically — it is now
              folded into the global «парсить заново» toggle that the form
              renders next to the Analyze / Start fetch buttons. The internal
              skipDupes flag (default ON) still drives min_id-based windowing
              for last_n mode; UI control over it is intentionally removed
              because it confused users (it didn't affect reprocessing of
              already-transcribed media, only fetch trim). */}
        </>
      )}
      {mode === 'date_range' && (
        <>
          <input
            type="text" value={fromDate} onChange={e => setFromDate(e.target.value)}
            placeholder="от 01.01.26"
            className="bg-zinc-900 border border-zinc-700 rounded-md px-3 py-1.5 w-28 focus:outline-none focus:border-zinc-500"
            style={{ fontSize: '14px' }}
          />
          <input
            type="text" value={toDate} onChange={e => setToDate(e.target.value)}
            placeholder="до конца"
            className="bg-zinc-900 border border-zinc-700 rounded-md px-3 py-1.5 w-28 focus:outline-none focus:border-zinc-500"
            style={{ fontSize: '14px' }}
          />
        </>
      )}
      {mode === 'between' && (
        <>
          <input
            type="text"
            value={url1} onChange={e => setUrl1(e.target.value)}
            placeholder="https://t.me/.../100"
            className="bg-zinc-900 border border-zinc-700 rounded-md px-3 py-1.5 flex-1 min-w-0 focus:outline-none focus:border-zinc-500"
            style={{ fontSize: '14px' }}
          />
          <input
            type="text"
            value={url2} onChange={e => setUrl2(e.target.value)}
            placeholder="https://t.me/.../200"
            className="bg-zinc-900 border border-zinc-700 rounded-md px-3 py-1.5 flex-1 min-w-0 focus:outline-none focus:border-zinc-500"
            style={{ fontSize: '14px' }}
          />
        </>
      )}
    </div>
  )
}

function TextField({ value, onChange, placeholder }) {
  return (
    <input
      type="text"
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      className="bg-zinc-800 border border-zinc-700 rounded-md px-3 py-1.5 flex-1 focus:outline-none focus:border-zinc-500 w-full"
    />
  )
}

// Direction toggle for last_n: «from the tail» (N freshest, default) vs
// «from the start» (N earliest). Icon-only — the input N right next to it
// already says "N", and any text on this control would just compete with
// it. The state ("с конца" vs "с начала") is shown in the tooltip on
// hover, not on the button face.
//
// active=true means oldest-first ("с начала") — visually filled so the
// non-default state is unmistakeable. Inactive = newest-first (default,
// matches the legacy Telegram fetch behaviour). Same active-treatment
// pattern as ToolbarButton — kept ad-hoc here because this is a one-off
// inline control, not a row-level action.
function DirectionToggle({ value, onChange }) {
  const isOldest = value === 'oldest'
  const next = isOldest ? 'newest' : 'oldest'
  const title = isOldest
    ? 'Берём N с начала чата (самые старые сообщения). Клик → переключить на «с конца».'
    : 'Берём N с конца чата (самые свежие сообщения). Клик → переключить на «с начала».'
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

// Two controls in one group: pill «все» (default, value = empty/0) and a free
// input for any custom number. Mirrors the YouTube comments LimitControl
// (methodology/design.md::Дискретные пресеты + free input). Empty input = «все».
function CommentsLimitControl({ value, onChange }) {
  const isAll = !value || String(value).trim() === ''
  return (
    <div className="inline-flex items-center gap-1.5">
      <div className="inline-flex rounded-md bg-zinc-900 border border-zinc-800 overflow-hidden">
        <button
          type="button"
          onClick={() => onChange('')}
          title="Без лимита — все комментарии под каждым постом"
          className={`px-2.5 py-1 transition-colors ${
            isAll ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
          }`}
          style={{ fontSize: '14px' }}
        >все</button>
        <input
          type="text"
          inputMode="numeric"
          value={value}
          onChange={e => onChange(e.target.value.replace(/\D+/g, ''))}
          placeholder="своё"
          title="Максимум комментариев на один пост"
          className={`w-24 px-2 py-1 bg-transparent border-l border-zinc-800 outline-none tabular-nums ${
            isAll ? 'text-zinc-500' : 'text-zinc-100'
          }`}
          style={{ fontSize: '14px' }}
        />
      </div>
      <span className="text-zinc-500" style={{ fontSize: '13px' }}>
        {isAll
          ? 'на каждом посту'
          : 'на пост — для крупного канала, чтобы не ждать часы'}
      </span>
    </div>
  )
}
