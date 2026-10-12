import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Clipboard, ChevronUp, ChevronDown, Save } from 'lucide-react'
import TelegramScopeFields, { defaultRange, presetDaysOf } from './TelegramScopeFields'
import { defaultContent } from './TelegramTypesPopover'
import { useInvalidator } from '../lib/dataBus'

// Inline panel — assembles a slice of saved content into clipboard / .txt.
// The form fields (range / types / topic / «с комментариями») live in
// <TelegramScopeFields>, shared with the «Новый запрос…» fetch form. This
// wrapper owns the DB-side state (live estimate, Save/Copy actions, toast).
//
// Open-state can be controlled externally via the `open` + `onToggle`
// props (used when the trigger lives in the SourceDetail action-row).
// When neither is passed the panel renders its own collapsed header
// button — kept around for any caller that wants the legacy in-flow
// expandable section.
//
// One-shot UX guarantees:
//   • Estimate is debounced ~200 ms and reflects EXACTLY what the action
//     will produce — same SQL filter feeds Copy/Save.
//   • Copy button morphs into a toast (Copied · N · KB) for ~2.2 s on
//     success — matches design.md::Toast в кнопке pattern.

export default function CopySavedPanel({
  sourceId, typeBreakdown, topics: topicsProp, commentsCount = null,
  open: openProp, onToggle,
}) {
  // Topics aren't part of sourceDetail() — fetch lazily on first expand so
  // a non-forum chat doesn't pay for it. ChatView already has the IPC.
  const [fetchedTopics, setFetchedTopics] = useState(null)
  const topics = topicsProp && topicsProp.length ? topicsProp : (fetchedTopics || [])
  // Controlled mode: parent owns open-state, our header button is hidden.
  const isControlled = openProp != null
  const [internalOpen, setInternalOpen] = useState(false)
  const open = isControlled ? openProp : internalOpen
  const setOpen = isControlled
    ? (v) => onToggle?.(typeof v === 'function' ? v(open) : v)
    : setInternalOpen

  // Scope state — same shape as TelegramConfigForm, fed into the shared
  // <TelegramScopeFields>. `defaultContent()` is { text:true, ...:false } —
  // matches the legacy CopySavedPanel default of "только текст".
  const [range, setRange] = useState(() => defaultRange('copy'))
  const [content, setContent] = useState(defaultContent)
  const [topicId, setTopicId] = useState(null)        // null = все темы
  // Append per-post comment threads to each post in the assembled output.
  // Default off — копировать только посты по умолчанию (как и было), комменты
  // явный opt-in. См. methodology/дизайн-принципы.md::Default = безопасный для денег.
  const [withComments, setWithComments] = useState(false)

  // The current items version for this source — re-runs estimate after a
  // fetch finishes, just like ChatView. Same data bus.
  const itemsVer = useInvalidator(`items:${sourceId}`)

  const totalSaved = useMemo(() =>
    (typeBreakdown || []).reduce((s, r) => s + (r.count || 0), 0),
  [typeBreakdown])

  // Lazy-load topics on first expand (skip if parent passed them in).
  useEffect(() => {
    if (!open || topicsProp) return
    if (fetchedTopics !== null) return
    if (!window.api?.itemsTopics) return
    window.api.itemsTopics(sourceId)
      .then(rows => setFetchedTopics(rows || []))
      .catch(() => setFetchedTopics([]))
  }, [open, topicsProp, fetchedTopics, sourceId])

  const scope = useMemo(() => buildScope({
    sourceId, range, content, topicId, withComments,
  }), [sourceId, range, content, topicId, withComments])

  // Estimate: debounced 200 ms; aborted by version bump.
  const [estimate, setEstimate] = useState(null)
  const [estimating, setEstimating] = useState(false)
  const debounceRef = useRef(null)
  useEffect(() => {
    if (!open) return
    if (!window.api?.itemsAssembleEstimate || !scope) return
    setEstimating(true)
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      try {
        const r = await window.api.itemsAssembleEstimate(scope)
        setEstimate(r); setEstimating(false)
      } catch (err) {
        console.error('[Copy-saved] estimate failed', err)
        setEstimating(false)
      }
    }, 200)
    return () => clearTimeout(debounceRef.current)
  }, [open, scope, itemsVer])

  const [busy, setBusy] = useState(null)         // 'copy' | 'save' | null
  const [toast, setToast] = useState(null)
  function flashToast(t) {
    setToast(t); setTimeout(() => setToast(null), 2400)
  }

  async function doCopy() {
    if (busy) return
    setBusy('copy')
    try {
      const r = await window.api.itemsAssembleCopy(scope)
      if (r?.ok) flashToast(
        `✓ Скопировано · ${r.count.toLocaleString('ru-RU')} сообщ. · ~${formatTokens(r.tokens)} токенов · ${formatBytes(r.bytes)}`
      )
      else if (r?.error === 'empty') flashToast('Нет подходящих сообщений')
      else flashToast(`Ошибка: ${r?.error || 'unknown'}`)
    } finally {
      setBusy(null)
    }
  }

  async function doSave() {
    if (busy) return
    setBusy('save')
    try {
      const r = await window.api.itemsAssembleSave({
        scope,
        defaultName: defaultFileName(scope, topics),
      })
      if (r?.ok) flashToast(
        `Сохранено · ${r.count.toLocaleString('ru-RU')} сообщ. · ~${formatTokens(r.tokens)} токенов`
      )
      else if (r?.error === 'cancelled')  { /* silent */ }
      else if (r?.error === 'empty')      flashToast('Нет подходящих сообщений')
      else                    flashToast(`Ошибка: ${r?.error || 'unknown'}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className={isControlled ? '' : 'mb-8'}>
      {!isControlled && (
        <button
          onClick={() => setOpen(o => !o)}
          className="w-full flex items-center gap-2 text-xs uppercase tracking-wider text-zinc-500 hover:text-zinc-300 mb-3"
        >
          <span className="inline-flex items-center gap-1.5"><Clipboard size={14} />Скопировать сохранённое</span>
          <span className="text-zinc-400 normal-case tracking-normal tabular-nums">
            · {totalSaved.toLocaleString('ru-RU')}
          </span>
          <span className="ml-auto text-zinc-600">{open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</span>
        </button>
      )}

      {open && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-6">
          <TelegramScopeFields
            use="copy"
            range={range} onRangeChange={setRange}
            content={content} onContentChange={setContent}
            withComments={withComments} onWithCommentsChange={setWithComments}
            topicId={topicId} onTopicIdChange={setTopicId}
            topics={topics}
            commentsCount={commentsCount}
          />

          {/* ── Estimate + actions ──────────────────────────────────
              Lives in the wrapper because Save/Copy/estimate are all
              copy-flow concerns (the fetch form has its own footer). */}
          <div className="flex items-center gap-3 pt-3 mt-3 border-t border-zinc-800">
            <div className="flex-1 min-w-0 text-zinc-400" style={{ fontSize: '14px' }}>
              {estimating && estimate == null ? (
                <span className="text-zinc-500">Считаю…</span>
              ) : estimate?.count > 0 ? (
                <>
                  <span className="text-zinc-200 font-medium">
                    {estimate.count.toLocaleString('ru-RU')}
                  </span>{' '}
                  <span>сообщ.</span>
                  {estimate.tokens > 0 && (
                    <span className="text-zinc-500">
                      {' '}· ~{formatTokens(estimate.tokens)} токенов
                    </span>
                  )}
                  {estimate.bytes > 0 && (
                    <span className="text-zinc-600"> · {formatBytes(estimate.bytes)}</span>
                  )}
                  {estimate.date_min && estimate.date_max && (
                    <div className="text-zinc-500" style={{ fontSize: '14px' }}>
                      {fmtRange(estimate.date_min, estimate.date_max)}
                    </div>
                  )}
                </>
              ) : (
                <span className="text-zinc-500">Ничего не подходит под фильтр</span>
              )}
            </div>
            <button
              onClick={doSave}
              disabled={!estimate?.count || !!busy}
              title="Сохранить как .txt"
              className={`px-3 py-1.5 rounded-md border ${
                !estimate?.count || busy
                  ? 'border-zinc-800 text-zinc-600 cursor-not-allowed'
                  : 'border-zinc-700 text-zinc-300 hover:border-zinc-500 hover:text-zinc-100'
              }`}
              style={{ fontSize: '14px' }}
            ><span className="inline-flex items-center gap-1"><Save size={14} className="shrink-0" />.txt</span></button>
            <button
              onClick={doCopy}
              disabled={!estimate?.count || !!busy}
              className={`shrink-0 min-w-[180px] px-4 py-1.5 rounded-md ${
                !estimate?.count || busy
                  ? 'bg-zinc-800 text-zinc-600 cursor-not-allowed'
                  : toast
                    ? 'bg-emerald-600 text-white'
                    : 'bg-zinc-100 text-zinc-900 hover:bg-white'
              }`}
              style={{ fontSize: '14px' }}
            >
              {toast || (busy === 'copy' ? 'Готовим…' : <span className="inline-flex items-center justify-center gap-1.5"><Clipboard size={14} />Скопировать</span>)}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Scope build ─────────────────────────────────────────────────────────

// Map renderer-side content keys to the SQL `type` column values used by the
// assemble pipeline. The shared `CONTENT_TYPES` uses `docs` as a label-id for
// compactness, but rows in items.type are stored as `document` (Telethon's
// own term, also what tg_fetch_json.py writes). Fix the seam here so the
// shared scope-fields don't have to care.
const TYPE_ID_TO_DB = { text: 'text', voice: 'voice', video: 'video', photo: 'photo', docs: 'document', poll: 'poll' }

function buildScope({ sourceId, range, content, topicId, withComments }) {
  const types = Object.entries(content || {})
    .filter(([id, on]) => on && TYPE_ID_TO_DB[id])
    .map(([id]) => TYPE_ID_TO_DB[id])

  const scope = {
    source_id: sourceId,
    types,
    topic_id: topicId,
    mode: 'all',
    with_comments: !!withComments,
  }
  if (range.mode === 'last_n') {
    scope.mode = 'last_n'
    scope.limit = Math.max(0, Number(range.lastN) || 0)
    // 'oldest' = N earliest, 'newest' (default) = N freshest. Backend mirrors
    // this in both assemblyEstimate and assemblyFetch.
    scope.direction = range.direction === 'oldest' ? 'oldest' : 'newest'
  } else if (range.mode === 'date_range') {
    // Unified date_range: first date is required, second is optional.
    // Empty second field → mode collapses to from_date (open upper bound).
    const a = parseUserDate(range.fromDate)
    const b = range.toDate ? parseUserDate(range.toDate) : null
    if (a && b) { scope.mode = 'date_range'; scope.date_from = a; scope.date_to = b + 86400 - 1 }
    else if (a) { scope.mode = 'from_date'; scope.date_from = a }
  } else {
    // Period preset (last_day / last_week / …) → resolve days back to a unix
    // ts, hand it to the same `from_date` machinery the manual mode uses.
    // Anything that isn't a preset id falls through with mode='all'.
    const days = presetDaysOf(range.mode)
    if (days != null) {
      scope.mode = 'from_date'
      scope.date_from = Math.floor((Date.now() - days * 86400 * 1000) / 1000)
    }
  }
  return scope
}

// Accept the same family of inputs the Telegram form does (dd.mm.yy /
// dd.mm.yyyy with or without time; ISO).  Returns unix seconds or null.
function parseUserDate(s) {
  const v = (s || '').trim()
  if (!v) return null
  const fmts = [
    /^(\d{1,2})\.(\d{1,2})\.(\d{2})$/,                         // 01.04.26
    /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/,                         // 01.04.2026
    /^(\d{1,2})\.(\d{1,2})\.(\d{2})\s+(\d{1,2}):(\d{2})$/,
    /^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})$/,
    /^(\d{4})-(\d{2})-(\d{2})$/,
    /^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})$/,
  ]
  for (const re of fmts) {
    const m = v.match(re)
    if (!m) continue
    let y, mo, d, h = 0, mi = 0
    if (re.source.startsWith('^(\\d{4})')) {
      y = +m[1]; mo = +m[2] - 1; d = +m[3]
      if (m[4]) { h = +m[4]; mi = +m[5] }
    } else {
      d = +m[1]; mo = +m[2] - 1
      y = +m[3]; if (y < 100) y += 2000
      if (m[4]) { h = +m[4]; mi = +m[5] }
    }
    const dt = new Date(y, mo, d, h, mi, 0)
    return Math.floor(dt.getTime() / 1000)
  }
  return null
}

function formatBytes(n) {
  if (!n) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

// Token counts for chat-prompt context windows. Always shown as ~N — we
// estimate via bytes/3, not a real tokenizer, so don't pretend precision.
//   < 1k         → "812"
//   1k–999.9k    → "1.2k" / "12.4k" / "317.5k"
//   ≥ 1M         → "1.3M"  (Claude 200k / GPT-4o 128k context — context-window
//                  refs help users sanity-check overflow at a glance)
function formatTokens(n) {
  if (!n || n < 1000) return String(n || 0)
  if (n < 1_000_000)  return `${(n / 1000).toFixed(n < 10_000 ? 1 : 1)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

function fmtRange(min, max) {
  const f = ts => new Date(ts * 1000).toLocaleDateString('ru-RU',
    { day: '2-digit', month: '2-digit', year: '2-digit' })
  return min === max ? f(min) : `${f(min)} — ${f(max)}`
}

function defaultFileName(scope, topics) {
  const stamp = new Date().toISOString().slice(0, 10)
  const topic = topics?.find(t => t.id === scope.topic_id)
  const slug = topic ? '_' + (topic.title || `#${topic.id}`).replace(/[^\w.-]+/g, '_').slice(0, 24) : ''
  return `tg_${stamp}${slug}.txt`
}
