// Shared persistence + param-shaping for Telegram fetches. Two consumers:
//   • TelegramConfigForm — restores last-used range/content/engine on mount and
//     persists them on every change.
//   • SourceDetail's «Новый запрос» quick-catch-up segment — reads the same
//     last-used content/engine to launch a sync_new fetch WITHOUT opening the
//     form, so the one-click catch-up fires with exactly the combo the user
//     last configured.
//
// The localStorage blob is the single cross-mount memory of "what the user
// fetches with". Keeping its read/write here means both consumers agree on the
// shape, and adding a persisted field later is a one-place change instead of
// two diverging copies.

import { defaultContent, CONTENT_TYPES } from '../components/TelegramTypesPopover'
import { defaultRange } from '../components/TelegramScopeFields'

export const LAST_USED_KEY = 'tg-config-form-last'
const SAFE_RESTORED_RANGE_MODES = new Set(['last_n', 'last_week', 'date_range'])

export function readLastUsed() {
  try {
    const raw = localStorage.getItem(LAST_USED_KEY)
    if (!raw) return null
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? v : null
  } catch { return null }
}

// Merge persisted range over the canonical default — any field we later add to
// defaultRange() shows up automatically without breaking older stored blobs.
// Only restore safe repeat modes + lastN; URLs, dates, and full-history modes
// stay one-shot per fetch.
export function loadLastUsedRange() {
  const base = defaultRange('fetch')
  const v = readLastUsed()
  if (!v || !v.range) return base
  const next = { ...base }
  if (typeof v.range.mode === 'string' && SAFE_RESTORED_RANGE_MODES.has(v.range.mode)) {
    next.mode = v.range.mode
  }
  if (typeof v.range.lastN === 'string') next.lastN = v.range.lastN
  return next
}

// Restore content types as a strict overlay on defaultContent() so a removed
// type from a stale blob doesn't leak in, and a type added later picks up its
// default until the user toggles it.
export function loadLastUsedContent() {
  const base = defaultContent()
  const v = readLastUsed()
  if (!v || !v.content || typeof v.content !== 'object') return base
  const next = { ...base }
  for (const k of Object.keys(base)) {
    if (typeof v.content[k] === 'boolean') next[k] = v.content[k]
  }
  return next
}

export function loadLastUsedEngine() {
  const v = readLastUsed()
  return (v && (v.engine === 'assemblyai' || v.engine === 'gemini'))
    ? v.engine : 'assemblyai'
}

export function writeLastUsed({ range, content, engine }) {
  try {
    localStorage.setItem(LAST_USED_KEY, JSON.stringify({
      range:   { mode: range.mode, lastN: range.lastN },
      content: { ...content },
      engine,
    }))
  } catch {}
}

// Content map ({text,voice,video,photo,docs,comments}) + engine → the subset of
// tgFetch params that describe WHAT to pull and HOW to process it. Mirrors the
// content branch of TelegramConfigForm.buildFetchParams exactly, so a quick
// catch-up launched from the split button processes media identically to a
// form-submitted fetch. Range/topic params are NOT here — the quick catch-up
// always rides sync_new + sinceMessageId, set by the caller.
export function buildContentParams(content, engine) {
  const out = { process_polls: true }
  if (content.comments) {
    out.include_comments = true
    out.comments_limit = 0   // 0 = all comments per post
  }
  const needsAi = content.voice || content.video || content.photo || content.docs
  if (needsAi) {
    out.transcribe_engine = engine
    out.transcribe_lang = 'ru'
    out.process_voice = !!(content.voice || content.video)
    out.process_photo = !!content.photo
    out.process_docs  = !!content.docs
  }
  return out
}

// Human labels of the currently-selected content types, in form order. Used by
// the Cmd+hover tooltip on the split button to echo "what a quick catch-up
// would pull" without opening the form.
export function lastUsedContentLabels() {
  const content = loadLastUsedContent()
  return CONTENT_TYPES.filter(c => content[c.id]).map(c => c.label)
}
