import React from 'react'

// Single source of truth for "what is this job doing right now". Used by:
//   • ActivityPanel JobRow      (variant="compact") — one or two short lines
//   • JobDetail TelegramBody    (variant="full")    — labeled rows
//   • SourceDetail History row  (variant="compact") — same as Activity
//
// Phases this component knows how to render (in order of prominence):
//   1. resolve_scanned > 0           → «Поиск чата · просмотрено N диалогов»
//      (pre-entity dialog walk for private-chat title resolution)
//   2. items_done                    → «Сообщения · 84 / 200»
//   3. media_phase[kind]             → «Голосовые · 1/3 · идёт транскрипция (0:12 / ~0:30)»
//                                      «Фото · 5/12 · описание»
//                                      «Документы · 0/1 · загрузка»
//
// We intentionally render *only what's happening* — empty kinds are hidden,
// finished kinds shrink to «✓ N/N». This matches the design rule «long
// operation should indicate which phase is running» (design.md::Detection).
//
// All deterministic strings live in STAGE_LABELS so adding a new sub-stage
// (or renaming one) is one place to change.

// Stage labels are the only place "what is happening" is spelled out for the
// user. Each label must be self-contained — readable without knowing the
// kind. The kind label is a separate column, so saying just «загрузка» feels
// truncated; «скачиваем аудио» / «загружаем аудио на сервер» is unambiguous.
//
// Labels are kind-aware: same backend stage means different things for
// voice/photo/pdf (e.g. "downloading" — voice → audio file, photo → image,
// pdf → document). LABEL_BY_KIND_STAGE handles the disambiguation.
const STAGE_LABELS_GENERIC = {
  downloading:  'скачиваем файл',
  uploading:    'загружаем на сервер',
  queued:       'в очереди на сервере',
  transcribing: 'расшифровываем аудио',
  describing:   'описываем изображение',
  extracting:   'извлекаем текст',
  completed:    'почти готово',
  done:         'готово',
  error:        'ошибка',
}

const STAGE_LABELS_BY_KIND = {
  voice: {
    downloading:  'скачиваем аудио',
    uploading:    'загружаем аудио на сервер',
    queued:       'в очереди на сервере',
    transcribing: 'расшифровываем аудио',
    completed:    'почти готово',
  },
  photo: {
    downloading: 'скачиваем фото',
    describing:  'описываем изображение',
  },
  pdf: {
    downloading: 'скачиваем документ',
    extracting:  'извлекаем текст из PDF',
  },
}

function stageLabel(kind, stage) {
  if (!stage) return 'обрабатывается'
  const byKind = STAGE_LABELS_BY_KIND[kind]
  if (byKind && byKind[stage]) return byKind[stage]
  return STAGE_LABELS_GENERIC[stage] || stage
}

const KIND_LABELS = {
  voice: 'Голосовые',
  photo: 'Фото',
  pdf:   'Документы',
}

// Strip noise from Python-side error chains so the user sees what *actually*
// went wrong, not the Python machinery that wrapped it. Examples:
//   `RuntimeError: AssemblyAI error: language_detection cannot be performed...`
//   → `language_detection cannot be performed...`
//   `ValueError: API_KEY_INVALID` → `API_KEY_INVALID`
// Keeps multi-line messages collapsed; trims trailing punctuation.
const NOISE_PREFIX_RE = /^(?:[A-Za-z]+Error|Exception|AssemblyAI(?: error| exception)?)\s*:\s*/
export function cleanErrorMessage(raw) {
  if (!raw) return ''
  let s = String(raw)
  for (let i = 0; i < 4; i++) {
    const next = s.replace(NOISE_PREFIX_RE, '')
    if (next === s) break
    s = next
  }
  return s.trim()
}

function fmtDuration(sec) {
  if (sec == null || !Number.isFinite(sec)) return null
  const s = Math.max(0, Math.floor(sec))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${String(r).padStart(2, '0')}`
}

// AAI is roughly ~5x realtime; ETA = audio_duration × 0.2. Imperfect (load
// varies) but better than nothing — the user sees a moving target instead
// of a frozen «transcribing…».
function aaiEta(audio_duration_sec) {
  if (!audio_duration_sec || audio_duration_sec <= 0) return null
  return Math.round(audio_duration_sec * 0.2)
}

function MediaKindLine({ kind, slot, variant }) {
  const skipped = slot?.skipped || 0
  if (!slot || (slot.total === 0 && slot.done === 0 && slot.errors === 0 && skipped === 0 && !slot.current)) {
    return null
  }
  const label = KIND_LABELS[kind] || kind
  const total = slot.total
  const done = slot.done
  const errs = slot.errors
  const cur = slot.current

  // Counter shape, examples:
  //   «1 / 3»             — in-flight
  //   «✓ 3/3»             — all clean
  //   «✓ 2/3 · 1 ошиб.»   — partial errors
  //   «✓ 2/3 · 1 пропущ.» — silent video skipped, not an error
  const allFinished = total > 0 && (done + errs + skipped) >= total
  let counter
  const tail = []
  if (errs > 0)    tail.push(`${errs} ошиб.`)
  if (skipped > 0) tail.push(`${skipped} пропущ.`)
  if (allFinished && tail.length === 0) counter = `✓ ${done}/${total}`
  else if (allFinished) counter = `✓ ${done}/${total} · ${tail.join(' · ')}`
  else counter = `${done + errs + skipped}/${total || '?'}`

  // Stage line for the in-flight item. We always surface audio duration when
  // it's available (Telethon hint pre-download, ffprobe post-download, AAI's
  // own probe on `queued`) — a 5-second voice and a 90-minute lecture both
  // pass through `transcribing`, the user needs to know which one this is.
  // Layout: `<stage> · аудио M:SS · <progress>`.
  //   downloading      → `скачиваем аудио · аудио 0:42`
  //   uploading        → `загружаем аудио на сервер · аудио 0:42`
  //   queued           → `в очереди на сервере · аудио 0:42`
  //   transcribing AAI → `расшифровываем аудио · аудио 0:42 · 0:12 / ~0:09`
  //   transcribing Gem → `расшифровываем аудио · аудио 0:42`
  let stageText = null
  if (cur) {
    const parts = [stageLabel(kind, cur.stage)]
    const audio = fmtDuration(cur.audio_duration_sec)
    if (audio) parts.push(`аудио ${audio}`)
    if (cur.stage === 'transcribing' && cur.elapsed_sec != null) {
      const elapsed = fmtDuration(cur.elapsed_sec) || '0:00'
      const eta = fmtDuration(aaiEta(cur.audio_duration_sec))
      parts.push(eta ? `${elapsed} / ~${eta}` : elapsed)
    }
    stageText = parts.join(' · ')
  } else if (allFinished) {
    stageText = errs > 0 ? null : 'готово'
  }

  if (variant === 'compact') {
    return (
      <span className="text-zinc-500 inline-flex items-center gap-1.5 mr-3">
        <span className="text-zinc-400">{label}</span>
        <span className="tabular-nums text-zinc-500">{counter}</span>
        {stageText && <span className="text-zinc-600">· {stageText}</span>}
      </span>
    )
  }
  // full variant — also surfaces errors_log + skipped_log so the user sees
  // *what* failed / *what* was skipped, not just counters.
  const errs_log = Array.isArray(slot.errors_log) ? slot.errors_log : []
  const skip_log = Array.isArray(slot.skipped_log) ? slot.skipped_log : []
  return (
    <div className="py-1">
      <div className="flex items-center gap-2">
        <span className="text-zinc-400 w-28 shrink-0">{label}</span>
        <span className="tabular-nums text-zinc-300">{counter}</span>
        {stageText && <span className="text-zinc-500">· {stageText}</span>}
      </div>
      {errs > 0 && errs_log.length > 0 && (
        <details className="ml-28 mt-1">
          <summary className="text-red-400/80 cursor-pointer hover:text-red-400" style={{ fontSize: '13px' }}>
            показать ошибки ({errs_log.length}{errs > errs_log.length ? `/${errs}` : ''})
          </summary>
          <ul className="mt-1 space-y-0.5" style={{ fontSize: '12px' }}>
            {errs_log.map((e, i) => (
              <li key={i} className="text-zinc-500">
                {e.msg_id && <span className="text-zinc-600 mr-2">msg #{e.msg_id}</span>}
                <span className="text-red-400/90">{cleanErrorMessage(e.message)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {skipped > 0 && skip_log.length > 0 && (
        <details className="ml-28 mt-1">
          <summary className="text-zinc-500 cursor-pointer hover:text-zinc-300" style={{ fontSize: '13px' }}>
            показать пропущенные ({skip_log.length}{skipped > skip_log.length ? `/${skipped}` : ''})
          </summary>
          <ul className="mt-1 space-y-0.5" style={{ fontSize: '12px' }}>
            {skip_log.map((e, i) => (
              <li key={i} className="text-zinc-500">
                {e.msg_id && <span className="text-zinc-600 mr-2">msg #{e.msg_id}</span>}
                <span className="text-zinc-400">{e.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

/**
 * Universal "what is this job doing now" renderer.
 *
 * Props:
 *   job      — snapshot from listJobs/jobDetail (.id, .status, .items_done,
 *              .items_total, .resolve_scanned, .media_phase, …)
 *   variant  — 'compact' (one row, inline-flex) | 'full' (vertical block)
 *
 * Returns null when there's nothing meaningful to render (cheap to mount
 * unconditionally — caller doesn't need to gate).
 */
export default function JobProgress({ job, variant = 'compact' }) {
  if (!job) return null
  const isActive = job.status === 'running' || job.status === 'awaiting_ai'

  // 1. Pre-entity dialog walk
  const stillResolving = isActive && !job.entity_title && !job.items_done
  const showResolve = stillResolving && job.resolve_scanned > 0

  // 2. Items counter — useful both during and after the run, but suppressed
  // for tg_index/tg_reply_backfill/etc. that have their own bodies.
  const showItems = (job.items_done || job.items_total) && !showResolve

  // 3. Media phase — any kind that has activity.
  const mp = job.media_phase || null
  const mpKinds = mp ? ['voice', 'photo', 'pdf'].filter(k => mp[k]) : []

  if (!showResolve && !showItems && mpKinds.length === 0) return null

  if (variant === 'compact') {
    return (
      <div className="text-zinc-500 mt-1 flex items-center flex-wrap gap-y-1" style={{ fontSize: '14px' }}>
        {showResolve && (
          <span className="mr-3">
            <span className="text-zinc-400">Поиск чата</span>
            <span className="ml-1.5 tabular-nums">{job.resolve_scanned.toLocaleString('ru-RU')}</span>
            <span className="text-zinc-600 ml-1">диалогов</span>
          </span>
        )}
        {showItems && !showResolve && (
          <span className="mr-3">
            <span className="text-zinc-400">Сообщения</span>
            <span className="ml-1.5 tabular-nums text-zinc-300">{job.items_done || 0}</span>
            {job.items_total ? <span className="text-zinc-600">/{job.items_total}</span> : null}
          </span>
        )}
        {mpKinds.map(k => (
          <MediaKindLine key={k} kind={k} slot={mp[k]} variant="compact" />
        ))}
      </div>
    )
  }

  // full variant — used inside JobDetail TelegramBody
  return (
    <div>
      {showResolve && (
        <div className="flex items-center gap-2 py-1">
          <span className="text-zinc-400 w-28 shrink-0">Поиск чата</span>
          <span className="tabular-nums text-zinc-300">
            {job.resolve_scanned.toLocaleString('ru-RU')}
          </span>
          <span className="text-zinc-500">· просмотрено диалогов</span>
        </div>
      )}
      {showItems && !showResolve && (
        <div className="flex items-center gap-2 py-1">
          <span className="text-zinc-400 w-28 shrink-0">Сообщения</span>
          <span className="tabular-nums text-zinc-300">
            {(job.items_done || 0).toLocaleString('ru-RU')}
            {job.items_total ? ` / ${job.items_total.toLocaleString('ru-RU')}` : ''}
          </span>
        </div>
      )}
      {mpKinds.map(k => (
        <MediaKindLine key={k} kind={k} slot={mp[k]} variant="full" />
      ))}
    </div>
  )
}
