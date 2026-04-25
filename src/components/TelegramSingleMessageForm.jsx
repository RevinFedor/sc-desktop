import React, { useEffect, useImperativeHandle, useState, forwardRef } from 'react'
import { Copy, RotateCw } from 'lucide-react'
import { startTelegramFetch, watchJob, useJobs } from '../lib/jobs'
import { formatCopyToast } from '../lib/formatTokens'
import PlatformLogo from './PlatformLogo'

// Compact russian labels for the inline type breakdown (single-message
// progress strip — limited horizontal space, so 1-2 word forms only).
const TG_SHORT_TYPE = {
  text: 'текст', voice: 'голос', video: 'видео', photo: 'фото',
  audio: 'аудио', sticker: 'стикер', gif: 'gif',
  document: 'док', poll: 'опрос', service: 'системн.', other: 'прочее',
}

/**
 * Inline form for a single Telegram message URL — `https://t.me/<chat>/<id>`
 * or `https://t.me/<chat>/<topic_id>/<id>`. Mirrors the YouTube single-video
 * flow: auto-kick on mount, show progress, surface done/error states without
 * dragging the user through the full TelegramConfigForm range picker.
 *
 * The underlying CLI script supports mode='single' with `--url <link>`, which
 * is what we wire up here.
 */
const TelegramSingleMessageForm = forwardRef(function TelegramSingleMessageForm({ target, includeComments: includeCommentsProp = false, onStarted }, ref) {
  // Stages: 'idle' | 'fetching' | 'done' | 'error'
  const [stage, setStage] = useState('idle')
  const [job, setJob] = useState(null)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState(null)
  // Live "do we want comments" — starts from the prop (which reflects the
  // split-chip click) but the user can also flip it ON post-hoc by clicking
  // «↻ Получить» on the Комментарии row of the done card. Becomes the
  // include_comments flag for the next kickOff().
  const [includeComments, setIncludeComments] = useState(!!includeCommentsProp)
  React.useEffect(() => { setIncludeComments(!!includeCommentsProp) }, [includeCommentsProp])
  // Per-target copy-flash bucket. Each Copy button (message / comments / all)
  // owns a key — we store {key, label} and only show flash on the matching
  // button. Mixing flash across buttons makes user think the wrong one
  // copied.
  const [copyFlash, setCopyFlash] = useState(null)

  // Re-mount restoration: same pattern as LocalFileTranscribeForm. If the
  // user pasted this URL earlier, kicked off a fetch, then went to Activity
  // and came back, we want to show the existing job's state — not spawn
  // a fresh duplicate. Lookup is by (params.url, params.include_comments)
  // — the comments flag is part of the cache tuple because it produces an
  // additional sidecar file, so a "+ comm" run isn't interchangeable with
  // a plain run.
  const allJobs = useJobs()
  const existingJob = React.useMemo(() => {
    if (!target) return null
    return allJobs
      .filter(j => {
        if (j.type !== 'tg_fetch') return false
        if (j.params?.mode !== 'single') return false
        if (j.params?.url !== target) return false
        if (!!j.params?.include_comments !== !!includeComments) return false
        // For include_comments fetches we ALSO need a non-empty result —
        // older buggy runs (Python single-mode used to skip the second pass
        // entirely) have include_comments=true and a sidecar file but
        // comments_collected=0. Restoring those onto a fresh «+ comm» click
        // would freeze the user on a permanent «недоступны» card and they'd
        // never get the actual 80 comments. Treat as not-existing so
        // kickOff() respawns. Done jobs only — running ones are still real
        // work in flight and we want to attach.
        if (includeComments && j.status === 'done') {
          const tc = j.tg_comments || j.params?.tg_comments
          const collected = Number(tc?.comments_collected ?? 0)
          if (collected === 0) return false
        }
        return true
      })
      .sort((a, b) => (b.started_at || 0) - (a.started_at || 0))[0] || null
  }, [target, includeComments, allJobs])

  // Track whether this mount has already fired its kick-off — React StrictMode
  // double-mounts effects in dev, which would otherwise spawn the fetch twice.
  const firedRef = React.useRef(null)
  useEffect(() => {
    if (!target) return
    if (firedRef.current === target) return
    firedRef.current = target
    setStage('idle'); setErr(null); setJob(null); setToast(null)
    // If a prior job for this exact URL is alive in the store, attach to it
    // instead of spawning a new fetch. Re-using "existingJob" avoids dup
    // tg_fetch processes when the user paste-restores from history.
    if (existingJob) {
      setJob(existingJob)
      if (existingJob.status === 'done')      setStage('done')
      else if (existingJob.status === 'error') { setErr(existingJob.error || ''); setStage('error') }
      else if (existingJob.status === 'running') {
        setStage('fetching')
        // Live jobs (numeric id) → subscribe to updates. Historic ones
        // (`db-<rowId>`) are already terminal so we don't need watchJob.
        if (typeof existingJob.id === 'number') {
          const off = watchJob(existingJob.id, snap => {
            setJob(snap)
            if (snap.status === 'done')      setStage('done')
            else if (snap.status === 'error') { setErr(snap.error || ''); setStage('error') }
          })
          return off
        }
      }
      return
    }
    kickOff()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target])

  async function kickOff({ withComments } = {}) {
    let alive = true
    // Caller can force-on (loadComments() click on a plain «сообщение»
    // run); otherwise use the current state.
    const wantComments = withComments ?? includeComments
    setStage('fetching'); setErr(null); setBusy(true)
    try {
      // single-mode needs a chat handle (target field in the script) AND
      // --url for the message link.
      //   - public:  t.me/<handle>/<id>            → target = '@<handle>'
      //   - private: t.me/c/<internal_id>/<id>     → target = '-100<internal_id>'
      //     (Telethon's full chat_id format. iter_dialogs warm-up on the
      //      Python side handles input-entity cache.)
      let handle = ''
      try {
        const priv = target.match(/t\.me\/c\/(\d+)/i)
        if (priv) {
          handle = `-100${priv[1]}`
        } else {
          const m = target.match(/t\.me\/([^/?]+)/i)
          handle = m ? '@' + m[1] : ''
        }
      } catch {}
      if (!handle) { setErr('Не удалось извлечь chat из ссылки'); setStage('error'); return }
      const id = await startTelegramFetch({
        target: handle,
        mode: 'single',
        url:  target,
        // AssemblyAI by default — same default as local files for the
        // same reason (long-form / arbitrary user audio is more robust on
        // AssemblyAI than on Gemini chunked). User can switch via the
        // engine selector below before pressing Enter.
        transcribe_engine: 'assemblyai',
        transcribe_lang:   'ru',
        // Comments side-fetch — split-chip «+ comm» on PasteScreen sets
        // the prop, or post-hoc «↻ Получить» on the Комментарии done-row
        // sets it via loadComments(). job-runner buffers the
        // discussion-thread events into a sidecar .txt and exposes
        // file_path_comments alongside file_path on done.
        include_comments: !!wantComments,
      })
      if (id == null) { setErr('Электрон-IPC недоступен'); setStage('error'); return }
      onStarted && onStarted(id)
      const off = watchJob(id, snap => {
        if (!alive) { off && off(); return }
        setJob(snap)
        if (snap.status === 'done') {
          setStage('done')
          off && off()
        } else if (snap.status === 'error') {
          setErr(snap.error || 'Unknown error')
          setStage('error')
          off && off()
        } else if (snap.status === 'cancelled') {
          setStage('idle')
          off && off()
        }
      })
    } finally {
      setBusy(false)
    }
  }

  // Three Copy targets — kept as separate handlers because each writes a
  // different file (or stitched pair) and produces its own flash. The flash
  // stores `which` so the visual confirm lands on the button you actually
  // clicked, not on whichever button rendered last.
  async function copyMessage() {
    if (!job?.file_path || !window.api?.copyFile) return
    const r = await window.api.copyFile(job.file_path)
    if (r?.ok) flash('message', formatCopyToast({ bytes: r.bytes }))
  }
  async function copyComments() {
    const fp = job?.file_path_comments
    if (!fp || !window.api?.copyFile) return
    const r = await window.api.copyFile(fp)
    if (r?.ok) flash('comments', formatCopyToast({ bytes: r.bytes }))
  }
  async function copyAll() {
    const paths = [job?.file_path, job?.file_path_comments].filter(Boolean)
    if (paths.length === 0 || !window.api?.copyCombined) return
    const r = await window.api.copyCombined(paths)
    if (r?.ok) flash('all', formatCopyToast({ bytes: r.bytes }))
  }
  function flash(which, label) {
    setCopyFlash({ which, label })
    setTimeout(() => setCopyFlash(null), 2200)
  }

  // On-demand comments load. Triggered when the user clicked plain
  // [сообщение] (no comments fetched yet) and now wants them. We flip
  // includeComments=true and re-run kickOff() — it spawns a fresh
  // tg_fetch single-mode with --include-comments. firedRef is reset
  // so the existingJob effect doesn't immediately abort the new run.
  function loadComments() {
    setIncludeComments(true)
    firedRef.current = null
    setStage('idle')
    setJob(null)
    setErr(null)
    // Pass withComments explicitly — the state setter above hasn't flushed
    // by the time this kickOff captures `includeComments`, so don't rely
    // on it.
    kickOff({ withComments: true })
  }

  useImperativeHandle(ref, () => ({
    trigger() {
      // Mirror YouTubeSingleForm: Enter advances whatever stage we're in.
      if (stage === 'error' || stage === 'idle') kickOff()
      // On done — Enter copies the whole thing if both files exist (matches
      // the «Скопировать всё» button user expectation), otherwise the
      // single available file.
      else if (stage === 'done') {
        if (job?.file_path_comments) copyAll()
        else copyMessage()
      }
      // 'fetching' — busy, no-op
    },
  }), [stage, job?.file_path, job?.file_path_comments])

  // Combined-copy lives in the header (right of the title) — keeps the
  // primary done-row uncluttered and matches the «empty space → primary
  // action» rule from methodology/design.md. Only visible when both files
  // exist AND there are actually comments to combine — concatenating an
  // «under this post there are no comments» placeholder onto the message
  // is just noise in the clipboard.
  const commentsCollected = Number(job?.tg_comments?.comments_collected ?? 0)
  const combinedReady = stage === 'done'
    && !!job?.file_path_comments
    && !!job?.file_path
    && commentsCollected > 0
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-6">
      <div className="flex items-start gap-3 mb-4">
        <PlatformLogo platform="telegram" size={32} />
        <div className="flex-1 min-w-0">
          <div className="font-medium truncate">Одно сообщение</div>
          <div className="text-zinc-500 truncate" style={{ fontSize: '14px' }}>
            <code className="text-xs break-all">{target}</code>
          </div>
        </div>
        {combinedReady && (
          <CopyBtn
            label={<span className="inline-flex items-center gap-1.5"><Copy size={14}/>Пост+комм</span>}
            primary
            flashing={copyFlash?.which === 'all'}
            flashLabel={copyFlash?.label}
            onClick={copyAll}
            className="shrink-0 self-start"
          />
        )}
      </div>

      {/* Step indicator: a TG single-message run is two distinct phases
          and the user shouldn't see them as one anonymous spinner.
            1. Fetch metadata via Telethon          (text + has_media)
            2. If voice/audio → download + transcribe via AssemblyAI/Gemini
          We render both rows always (after fetch starts), each with its own
          state: pending · running · done · skipped. */}
      {(stage === 'idle' || stage === 'fetching') && (
        <div className="space-y-2">
          <StepRow
            label="Загружаем сообщение"
            state={
              stage === 'idle' ? 'pending' :
              stage === 'fetching' && !job?.tg_voice?.stage ? 'running' :
              'done'
            }
          />
          {/* Voice step: only visible once we know whether the message has
              audio. The "skipped" state appears for text-only messages so
              the user understands why nothing's happening on this row. */}
          {(() => {
            // First TG event with item data is what tells us whether voice
            // exists. Until then we don't commit to a state for this row.
            const item   = job?.params ? null : null
            const tv     = job?.tg_voice
            const isAudioMsg =
              job?.type_breakdown && (job.type_breakdown.voice || job.type_breakdown.audio)
            // While metadata is still loading, we don't know yet — hide row
            // until either tg_voice info shows up or job moves to done.
            const knowAudio = !!tv || !!isAudioMsg
            if (!knowAudio) return null
            const needTranscribe = !!tv || isAudioMsg
            if (!needTranscribe) {
              return (
                <StepRow
                  label="Транскрибируем голосовое"
                  state="skipped"
                  hint="нет голосового — только текст"
                />
              )
            }
            const eng = tv?.engine || 'assemblyai'
            // AAI emits 'uploading' → 'queued' → 'transcribing' (repeats) →
            // 'completed'; Gemini stays on 'downloading' → 'transcribing'.
            // 'done' is the final synthesised state when transcript landed.
            const state =
              tv?.stage === 'done'         ? 'done' :
              tv?.stage === 'completed'    ? 'done' :
              tv?.stage === 'transcribing' ? 'running' :
              tv?.stage === 'queued'       ? 'running' :
              tv?.stage === 'uploading'    ? 'running' :
              tv?.stage === 'downloading'  ? 'running' :
              tv?.stage === 'error'        ? 'error' :
              stage === 'done'             ? 'done' :
              'pending'
            const subLabel = formatVoiceSubLabel(tv, eng)
            return (
              <StepRow
                label={`Транскрибируем голосовое · ${eng}`}
                state={state}
                hint={subLabel}
              />
            )
          })()}
          {includeComments && (() => {
            // Comments stage: visible only when «+ comm» was clicked. Goes
            // through pending → running (after the message is fetched, the
            // backend kicks the discussion-thread iter) → done. We read
            // job.tg_comments which is set by job-runner from
            // `comments_progress` and the final `done` event's totals.
            const tc = job?.tg_comments || null
            const messageDone = stage === 'fetching'
              ? !!(job?.type_breakdown && Object.keys(job.type_breakdown).length)
              : true
            // After message is fetched, comments pass starts. While job is
            // still running and we haven't seen any tg_comments event yet,
            // show 'pending' (will flip to running on the first
            // comments_progress / comments event).
            let s = 'pending'
            if (stage === 'done')         s = tc ? 'done' : 'skipped'
            else if (tc?.comments_collected != null && stage === 'done') s = 'done'
            else if (tc) s = 'running'
            else if (messageDone)         s = 'running'
            const collected = tc?.comments_collected ?? 0
            const errs      = tc?.comments_post_errors ?? 0
            const hint = s === 'pending'
              ? 'ждём фетч сообщения'
              : s === 'running'
                ? collected
                  ? `получено ${collected.toLocaleString('ru-RU')} комментариев…`
                  : 'обходим обсуждение…'
                : s === 'done'
                  ? errs
                    ? `${collected.toLocaleString('ru-RU')} комментариев · ${errs} пост(ов) без обсуждения`
                    : `${collected.toLocaleString('ru-RU')} комментариев`
                  : null
            return (
              <StepRow
                label="Получаем комментарии"
                state={s}
                hint={hint}
              />
            )
          })()}
        </div>
      )}

      {stage === 'done' && (
        <div className="space-y-2">
          {/* Row 1 — message. Always present on done. */}
          <DoneRow
            kind="ok"
            icon="✓"
            label="Сообщение"
            sub={job?.entity_title || null}
            action={
              <CopyBtn
                label={<span className="inline-flex items-center gap-1.5"><Copy size={14}/>Скопировать</span>}
                flashing={copyFlash?.which === 'message'}
                flashLabel={copyFlash?.label}
                disabled={!job?.file_path}
                onClick={copyMessage}
              />
            }
          />
          {/* Row 2 — comments. Only when the user opted in via «+ comm».
              Three flavours mapped to the sidecar state:
                – data on disk (collected > 0)  → «N комментариев» + 📋
                – sidecar exists but 0 collected → «нет комментариев» + 📋
                  (clicking copies the placeholder, so user gets explicit
                   confirmation the side-fetch ran)
                – no sidecar (rare — only on partial / errored close)  →
                  «не загружены» + [↻ Получить] which spawns a comments-only
                  retry with the same params. */}
          {/* Row 2 — comments. Shown ALWAYS on done so the user can pull
              comments after-the-fact even if they clicked plain
              [сообщение] (left half of the split-chip). The button on the
              row reflects state: «↻ Получить» when comments weren't
              fetched, «📋 Скопировать» when we have them, static
              «нечего копировать» when the post has no discussion. */}
          {(() => {
            // Plain «сообщение» click — comments never requested. Offer to
            // fetch them on demand. No claim about availability yet (we
            // didn't probe), so neutral muted styling — not amber-warning.
            if (!includeComments) {
              return (
                <DoneRow
                  kind="muted"
                  icon="—"
                  label="Комментарии"
                  sub="не загружены"
                  action={
                    <CopyBtn
                      label={<span className="inline-flex items-center gap-1.5"><RotateCw size={14}/>Получить</span>}
                      onClick={loadComments}
                      disabled={busy}
                    />
                  }
                />
              )
            }
            const tc = job?.tg_comments
            const collected = tc?.comments_collected ?? 0
            const hasFile = !!job?.file_path_comments
            // Have data — emerald "✓" + Copy.
            if (hasFile && collected > 0) {
              return (
                <DoneRow
                  kind="ok"
                  icon="✓"
                  label="Комментарии"
                  sub={collected.toLocaleString('ru-RU')}
                  action={
                    <CopyBtn
                      label={<span className="inline-flex items-center gap-1.5"><Copy size={14}/>Скопировать</span>}
                      flashing={copyFlash?.which === 'comments'}
                      flashLabel={copyFlash?.label}
                      onClick={copyComments}
                    />
                  }
                />
              )
            }
            // Sidecar exists but comments thread had zero rows. Two
            // sub-cases:
            //   – channel really has no discussion (has_discussion=false)
            //     → «недоступны», static badge, nothing to retry.
            //   – channel HAS discussion but this post returned 0 — could
            //     be a transient Telethon hiccup (FloodWait, stale entity).
            //     Offer «↻ Получить ещё раз» so the user isn't stuck on
            //     a false zero when «80 комментов» is right there in
            //     Telegram.
            const hasDiscussion = job?.has_discussion === true
                               || job?.params?.has_discussion === true
            if (hasFile && !hasDiscussion) {
              return (
                <DoneRow
                  kind="muted"
                  icon="—"
                  label="Комментарии"
                  sub="недоступны"
                  action={
                    <span className="text-zinc-500 select-none" style={{ fontSize: '14px' }}>
                      нечего копировать
                    </span>
                  }
                />
              )
            }
            if (hasFile && hasDiscussion) {
              return (
                <DoneRow
                  kind="warn"
                  icon="—"
                  label="Комментарии"
                  sub="вернулось 0"
                  action={
                    <CopyBtn
                      label={<span className="inline-flex items-center gap-1.5"><RotateCw size={14}/>Получить ещё раз</span>}
                      onClick={loadComments}
                      disabled={busy}
                    />
                  }
                />
              )
            }
            // No sidecar at all — partial / errored close. Offer a retry
            // (re-runs the whole single-mode fetch with include_comments,
            // which is fine: existing message-row UPSERT is idempotent).
            return (
              <DoneRow
                kind="warn"
                icon="—"
                label="Комментарии"
                sub="не загружены"
                action={
                  <CopyBtn
                    label={<span className="inline-flex items-center gap-1.5"><RotateCw size={14}/>Получить</span>}
                    onClick={() => kickOff()}
                    disabled={busy}
                  />
                }
              />
            )
          })()}
        </div>
      )}
      {toast && (
        <div className="text-zinc-400 mt-3" style={{ fontSize: '14px' }}>{toast}</div>
      )}

      {stage === 'error' && (
        <Panel tone="err">
          <span className="text-red-400">✗</span>
          <span className="text-zinc-200">{err || 'Ошибка'}</span>
          <button
            onClick={() => kickOff()}
            disabled={busy}
            className="ml-auto inline-flex items-center gap-1.5 px-3 py-1 rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-200"
            style={{ fontSize: '14px' }}
          ><RotateCw size={14}/> Повторить</button>
        </Panel>
      )}
    </div>
  )
})

export default TelegramSingleMessageForm

// One row of the multi-step progress block. State drives the leading icon
// + colour:
//   pending  ◯  zinc-600   "ждёт"
//   running  ↻  emerald-500 (spinner)
//   done     ✓  emerald-400
//   skipped  —  zinc-700   (greyed, italic hint)
//   error    ✗  red-400
function StepRow({ label, state, hint }) {
  const Icon = state === 'running' ? <Spinner />
    : state === 'done'    ? <span className="text-emerald-400">✓</span>
    : state === 'error'   ? <span className="text-red-400">✗</span>
    : state === 'skipped' ? <span className="text-zinc-700">—</span>
    :                       <span className="text-zinc-700">○</span>
  const labelCls =
    state === 'pending' ? 'text-zinc-500' :
    state === 'skipped' ? 'text-zinc-600 italic' :
    'text-zinc-200'
  return (
    <div className="flex items-center gap-3 px-4 py-2 rounded-md bg-zinc-900 border border-zinc-800">
      <span className="w-4 h-4 inline-flex items-center justify-center shrink-0">{Icon}</span>
      <span className={labelCls}>{label}</span>
      {hint && <span className="text-zinc-500 ml-2" style={{ fontSize: '13px' }}>· {hint}</span>}
    </div>
  )
}

// One done-row. Mirrors StepRow's geometry (icon · label · sub · action) so
// the loader-rows and the done-rows visually line up — same paddings, same
// borders, same icon column. Tone is per-row (ok = emerald accent, warn =
// amber for «нет / не загружены»).
function DoneRow({ kind = 'ok', icon, label, sub, action }) {
  const cls =
    kind === 'warn'  ? 'border-amber-800/40 bg-amber-900/5'   :
    kind === 'muted' ? 'border-zinc-800 bg-zinc-900/40'       :
                       'border-emerald-800/50 bg-emerald-900/10'
  const iconCls =
    kind === 'warn'  ? 'text-amber-400'   :
    kind === 'muted' ? 'text-zinc-600'    :
                       'text-emerald-400'
  const labelCls = kind === 'muted' ? 'text-zinc-400' : 'text-zinc-200'
  return (
    <div className={`rounded-md border ${cls} px-4 py-2 flex items-center gap-3`}>
      <span className={`w-4 h-4 inline-flex items-center justify-center shrink-0 ${iconCls}`}>{icon}</span>
      <span className={labelCls}>{label}</span>
      {sub && (
        <span className="text-zinc-500" style={{ fontSize: '13px' }}>· {sub}</span>
      )}
      <div className="ml-auto shrink-0">{action}</div>
    </div>
  )
}

// One Copy-button. `flashing=true` flips the green confirm-skin and disables
// click for the flash window so a double-tap doesn't fire a second copy in
// the middle of the toast. `primary=true` is the white-on-zinc tonality used
// by the «default Enter» action; non-primary buttons get the muted-grey
// treatment so the visual hierarchy points at the catch-all action.
function CopyBtn({ label, primary, flashing, flashLabel, disabled, onClick, className = '' }) {
  const baseTone = primary
    ? 'bg-zinc-100 text-zinc-900 hover:bg-white disabled:bg-zinc-800 disabled:text-zinc-500'
    : 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700 disabled:bg-zinc-900 disabled:text-zinc-600'
  const tone = flashing ? 'bg-emerald-700 text-emerald-50 cursor-default' : baseTone
  return (
    <button
      onClick={onClick}
      disabled={disabled || flashing}
      className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-md transition-colors ${tone} ${className}`}
      style={{ fontSize: '14px' }}
    >
      {flashing ? `✓ ${flashLabel}` : label}
    </button>
  )
}

function Panel({ children, tone }) {
  const cls = tone === 'ok'
    ? 'border-emerald-800/50 bg-emerald-900/10'
    : tone === 'err'
      ? 'border-red-800/50 bg-red-900/10'
      : 'border-zinc-800 bg-zinc-900'
  return (
    <div className={`rounded-md border ${cls} px-4 py-3 flex items-center gap-2`}>
      {children}
    </div>
  )
}

function Spinner() {
  return (
    <span className="inline-block w-3.5 h-3.5 rounded-full border-2 border-zinc-600 border-t-zinc-200 animate-spin" />
  )
}

// Hint text under the voice-transcribe row.
//   Gemini → "обрабатывает..." (no fine-grained progress; chunked pipeline
//            does its own internal split silently).
//   AssemblyAI → "Заливаем 12.3 MB..." (uploading) / "В очереди..." / "M:SS / ~22 мин".
//                ETA is audio_duration_sec × 0.2 (rough — AAI universal-2
//                processes ~5x faster than realtime, varies by load).
//                Float audio_duration_sec is ms? — already converted to sec
//                in gemini_utils.transcribe_assemblyai.
function formatVoiceSubLabel(tv, engine) {
  if (!tv) return null
  if (tv.stage === 'error')        return `ошибка: ${tv.error || 'неизвестно'}`
  if (tv.stage === 'downloading')  return 'скачиваем аудио…'
  if (tv.stage === 'uploading')    return 'загружаем аудио на сервер…'
  if (tv.stage === 'queued')       return 'в очереди на сервере…'
  if (tv.stage === 'completed')    return null
  if (tv.stage === 'transcribing') {
    if (engine !== 'assemblyai')   return `${engine} расшифровывает аудио…`
    const el = Number(tv.aai_elapsed_sec || 0)
    const elFmt = mmss(el)
    const dur = Number(tv.aai_audio_dur_sec || 0)
    if (dur > 0) {
      // ETA = audio_duration × 0.2 (AAI universal-2 ~5x realtime).
      const etaSec = Math.max(30, Math.round(dur * 0.2))
      return `расшифровываем · ${elFmt} / ~${humanShort(etaSec)}`
    }
    return `расшифровываем · ${elFmt}`
  }
  return null
}

function mmss(sec) {
  const s = Math.max(0, Math.floor(sec || 0))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${String(r).padStart(2, '0')}`
}

function humanShort(sec) {
  if (sec < 60) return `${sec} сек`
  const m = Math.round(sec / 60)
  if (m < 60) return `${m} мин`
  const h = Math.floor(m / 60)
  const mm = m % 60
  return mm ? `${h} ч ${mm} мин` : `${h} ч`
}
