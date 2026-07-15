import React, { useEffect, useImperativeHandle, useMemo, useState, forwardRef } from 'react'
import {
  startYoutubeSingle, resumeYoutubeAi,
  lookupYoutubeCache, copyCachedYoutubeFile,
  startYoutubeComments, lookupYoutubeCommentsCache,
  watchJob,
} from '../lib/jobs'
import { formatCopyToast } from '../lib/formatTokens'
import Checkbox from './Checkbox'
import { RotateCw, Copy, Mic } from 'lucide-react'

// Extract the 11-char video id from various YouTube URL forms.
function extractVideoId(url) {
  if (!url) return null
  const patterns = [
    /(?:[?&]v=|\/v\/|\/embed\/|\/shorts\/|\/live\/)([0-9A-Za-z_-]{11})/,
    /youtu\.be\/([0-9A-Za-z_-]{11})/,
  ]
  for (const p of patterns) {
    const m = url.match(p)
    if (m) return m[1]
  }
  return null
}

const ENGINES = [
  { id: 'gemini',     label: 'Gemini 2.5 Flash', hint: '⚡ дёшево, чанки 10мин' },
  { id: 'assemblyai', label: 'AssemblyAI',       hint: '🔊 long-form (>2ч)' },
]

/**
 * Inline YouTube single-video form. The flow is mostly automatic:
 *   - mount → check cache → if hit, copy & show "from cache"
 *   - else spawn yt_single_ndjson → race subs APIs
 *   - if subs: file is auto-copied to clipboard, status=done
 *   - if no subs: ask the user to confirm AI transcription
 *
 * The parent (PasteScreen) calls `formRef.current.trigger()` on Enter to
 * advance from whatever state we're in (start fetch, retry, confirm AI).
 */
const YouTubeSingleForm = forwardRef(function YouTubeSingleForm({ url, includeCommentsDefault = false, onStarted }, ref) {
  // Stages: 'idle' | 'cache-hit' | 'searching' | 'subs-found' | 'awaiting-ai' | 'transcribing' | 'done' | 'error'
  const [stage, setStage] = useState('idle')
  const [videoMeta, setVideoMeta] = useState(null)   // {video_id, title, channel, duration_sec}
  const [job, setJob] = useState(null)               // live snapshot
  const [cache, setCache] = useState(null)           // { file_path, finished_at, parameters, cost_usd }
  const [lang, setLang] = useState('ru')
  const [withTs, setWithTs] = useState(false)
  const [engine, setEngine] = useState('gemini')
  const [err, setErr] = useState(null)
  const [toast, setToast] = useState(null)
  const [busy, setBusy] = useState(false)
  // Comments toggle — visible at every stage (idle / cache-hit / done / error).
  // Off by default. When the user clicks the «+ comm» half of the split-chip
  // on PasteScreen, `includeCommentsDefault=true` arrives as a prop and we
  // start with the toggle ON — same behaviour, just pre-flipped. Independent
  // state, independent done-card row, independent Copy-button update.
  const [includeComments, setIncludeComments] = useState(!!includeCommentsDefault)
  // Live commentsJob snapshot, parallel to `job` (the transcript one).
  const [commentsJob, setCommentsJob] = useState(null)
  // Cache hit for the (videoId, new, 500, no-replies) tuple — written once on
  // toggle-on; lets us auto-show «Уже есть» without spawning the comments job.
  const [commentsCache, setCommentsCache] = useState(null)
  const [copyFlash, setCopyFlash] = useState(null)

  const videoId = useMemo(() => extractVideoId(url), [url])

  // On mount: cache lookup → if found, copy & show. Else start subs check.
  // (Form is only mounted after explicit YT video chip click → user intent.)
  useEffect(() => {
    if (!url || !videoId) return
    let alive = true
    setStage('idle'); setErr(null); setJob(null); setCache(null); setVideoMeta(null)

    ;(async () => {
      let nextLang = 'ru'
      let nextEngine = 'gemini'
      try {
        const appSettings = await window.api?.appSettingsGet?.()
        const yt = appSettings?.youtube || {}
        if (typeof yt.preferred_lang === 'string' && yt.preferred_lang) nextLang = yt.preferred_lang
        if (yt.engine === 'gemini' || yt.engine === 'assemblyai') nextEngine = yt.engine
      } catch {}
      if (!alive) return
      setLang(nextLang)
      setEngine(nextEngine)

      const c = await lookupYoutubeCache(videoId)
      if (!alive) return
      if (c) {
        setCache(c)
        setStage('cache-hit')
        const r = await copyCachedYoutubeFile(c.file_path)
        if (alive && r.ok) setToast(`Скопировано из кэша · ${formatBytes(r.bytes)}`)
      } else {
        kickOff({ langOverride: nextLang }) // no cache → start subs check
      }
    })()

    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, videoId])

  async function kickOff({ withCurrentSettings = false, langOverride = lang } = {}) {
    if (!videoId) {
      setErr('Не удалось распознать ID видео в URL')
      setStage('error')
      return
    }
    setStage('searching'); setErr(null); setBusy(true)
    try {
      const id = await startYoutubeSingle({
        url, lang: langOverride, withTs,
      })
      if (id == null) {
        setErr('Электрон-IPC недоступен')
        setStage('error'); return
      }
      onStarted && onStarted(id)
      const off = watchJob(id, snap => {
        setJob(snap)
        if (snap.entity_title || snap.yt?.video_id) {
          setVideoMeta({
            video_id:     snap.yt?.video_id,
            title:        snap.entity_title || snap.yt?.title,
            channel:      snap.yt?.channel,
            duration_sec: snap.yt?.duration_sec,
          })
        }
        // Drive stage from snapshot
        if (snap.status === 'awaiting_ai') {
          setStage('awaiting-ai')
        } else if (snap.status === 'done') {
          setStage('done')
          if (snap.yt?.copied_bytes) {
            setToast(`Готово · скопировано (${formatBytes(snap.yt.copied_bytes)})`)
          }
        } else if (snap.status === 'error') {
          setErr(snap.error || 'Unknown error')
          setStage('error')
        } else if (snap.status === 'cancelled') {
          setStage('idle')
        } else if (snap.yt?.stage === 'transcribing') {
          setStage('transcribing')
        } else if (snap.yt?.stage === 'subs_found') {
          setStage('subs-found')
        } else if (snap.yt?.stage === 'searching') {
          setStage('searching')
        }
      })
      // Detach when this component unmounts via the form's lifecycle.
      // (kickOff is called once per mount; cleanup handled in the effect above.)
      void off
    } finally {
      setBusy(false)
    }
  }

  async function confirmAi() {
    if (!job?.id) return
    setBusy(true); setErr(null)
    try {
      const r = await resumeYoutubeAi(job.id, engine)
      if (r && r.ok === false) {
        setErr(r.error || 'Resume failed')
        setStage('error')
      } else {
        setStage('transcribing')
      }
    } finally {
      setBusy(false)
    }
  }

  // Comments-toggle effect: on (off→on) check cache, else spawn job in parallel.
  // Defaults — sort=new, limit=500, no replies — same as YouTubeCommentsForm
  // (fact-youtube-comments.md::Defaults). User can override later via the
  // standalone form if needed; here we want one click = one Copy.
  const commentsCanonicalUrl = useMemo(
    () => videoId ? `https://www.youtube.com/watch?v=${videoId}` : null,
    [videoId],
  )
  useEffect(() => {
    if (!includeComments || !videoId) return
    if (commentsJob || commentsCache) return        // already running / cached
    let alive = true
    ;(async () => {
      const c = await lookupYoutubeCommentsCache({
        videoId, sort: 'new', limit: 500, includeReplies: false,
      })
      if (!alive) return
      if (c) { setCommentsCache(c); return }
      const id = await startYoutubeComments({
        url: commentsCanonicalUrl, sort: 'new', limit: 500, includeReplies: false,
      })
      if (id == null || !alive) return
      const off = watchJob(id, snap => alive && setCommentsJob(snap))
      void off
    })()
    return () => { alive = false }
  }, [includeComments, videoId])

  // ── Combined-copy logic ──────────────────────────────────────────────
  // Read transcript file + comments file, stitch with a separator so the
  // user gets one chunk for downstream paste. If only one is ready/requested,
  // copy whatever's available — labels prevent silent partial-copy by being
  // explicit ("📋 Скопировать всё" vs "📋 Скопировать транскрипт").
  function commentsFilePath() {
    return commentsJob?.file_path || commentsCache?.file_path || null
  }
  function transcriptFilePath() {
    return cache?.file_path || job?.file_path || null
  }
  const hasTranscript = !!transcriptFilePath()
  const hasComments   = !!commentsFilePath()
  const commentsBusy  = includeComments && !hasComments
  async function copyCombined() {
    const tFp = transcriptFilePath()
    const cFp = commentsFilePath()
    const paths = [tFp, cFp].filter(Boolean)
    if (paths.length === 0) return
    const r = await window.api.copyCombined?.(paths)
    if (r?.ok) {
      setCopyFlash(formatCopyToast({ bytes: r.bytes }))
      setTimeout(() => setCopyFlash(null), 2200)
    }
  }

  async function copyAgain() {
    const fp = cache?.file_path || job?.file_path
    if (!fp) return
    setBusy(true)
    try {
      const r = await copyCachedYoutubeFile(fp)
      if (r.ok) setToast(formatCopyToast({ bytes: r.bytes }))
    } finally {
      setBusy(false)
      setTimeout(() => setToast(null), 2200)
    }
  }

  // Imperative handle for Enter-key from PasteScreen.
  useImperativeHandle(ref, () => ({
    /**
     * Advance whatever state the form is in. Called by the parent's onKeyDown.
     * Returns true if the key was consumed.
     */
    trigger() {
      if (busy) return true
      if (stage === 'awaiting-ai') { confirmAi();  return true }
      if (stage === 'cache-hit')   { copyAgain();  return true }
      if (stage === 'done')        { copyAgain();  return true }
      if (stage === 'error')       { kickOff();    return true }
      if (stage === 'idle')        { kickOff();    return true }
      // 'searching' | 'transcribing' | 'subs-found' — busy, no-op
      return true
    },
  }), [stage, busy, job?.id, engine])

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-6">
      <Header videoMeta={videoMeta} url={url} stage={stage} onStart={() => kickOff()} />

      {stage === 'cache-hit' && cache && (
        <CacheHitPanel
          cache={cache}
          onCopyAgain={includeComments && hasComments ? copyCombined : copyAgain}
          onRetry={() => { setCache(null); kickOff() }}
          busy={busy || commentsBusy}
          copyFlash={copyFlash}
          combinedReady={includeComments && hasComments}
        />
      )}

      {/* Persistent comments toggle — visible at every stage. Off by default;
          turning on kicks a parallel yt_comments fetch (no waiting for the
          transcript to finish). Auto-shows cached results when present. */}
      <CommentsRow
        on={includeComments}
        onToggle={setIncludeComments}
        commentsJob={commentsJob}
        commentsCache={commentsCache}
      />

      {(stage === 'searching' || stage === 'subs-found') && (
        <SearchingPanel stage={stage} job={job} />
      )}

      {stage === 'awaiting-ai' && job?.yt && (
        <AwaitingAiPanel
          yt={job.yt}
          engine={engine}
          setEngine={setEngine}
          onConfirm={confirmAi}
          busy={busy}
        />
      )}

      {stage === 'transcribing' && (
        <TranscribingPanel job={job} />
      )}

      {stage === 'done' && (
        <DonePanel
          job={job}
          onCopyAgain={includeComments && hasComments ? copyCombined : copyAgain}
          busy={busy || commentsBusy}
          copyFlash={copyFlash}
          combinedReady={includeComments && hasComments}
        />
      )}

      {stage === 'error' && (
        <ErrorPanel err={err || job?.error} onRetry={() => kickOff()} busy={busy} />
      )}

      {/* Subtle subtitle-flow tweaks (lang / timestamps) — only useful before
          the first request (cached/done states should not change anything). */}
      {(stage === 'searching' || stage === 'idle' || stage === 'error') && (
        <SettingsRow
          lang={lang} setLang={setLang}
          withTs={withTs} setWithTs={setWithTs}
        />
      )}

      {toast && (
        <div className="text-zinc-400 mt-3" style={{ fontSize: '14px' }}>{toast}</div>
      )}
    </div>
  )
})

export default YouTubeSingleForm

// ─── Sub-panels ─────────────────────────────────────────────────────────

function Header({ videoMeta, url, stage, onStart }) {
  if (!videoMeta) {
    // No metadata yet — show an actionable idle prompt instead of repeating
    // the URL (which is already in the input + Detection row above).
    if (stage === 'idle') {
      return (
        <div className="flex items-center gap-3 mb-4">
          <div className="text-zinc-400">
            Жми <kbd className="px-1.5 py-0.5 bg-zinc-800 rounded text-zinc-200 text-xs">Enter</kbd>,
            чтобы получить транскрипт
          </div>
          <button
            onClick={onStart}
            className="ml-auto px-3 py-1.5 rounded-md bg-zinc-100 text-zinc-900 hover:bg-white"
            style={{ fontSize: '14px' }}
          >Запросить</button>
        </div>
      )
    }
    return (
      <div className="flex items-center gap-3 mb-4">
        <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
        <div className="text-zinc-300">Получаем метаданные…</div>
      </div>
    )
  }
  return (
    <div className="flex items-start gap-3 mb-4">
      <Thumbnail videoId={videoMeta.video_id} />
      <div className="flex-1 min-w-0">
        <div className="text-zinc-100 font-medium truncate">{videoMeta.title || '—'}</div>
        <div className="text-zinc-500 truncate" style={{ fontSize: '14px' }}>
          {videoMeta.channel || '—'}
          {videoMeta.duration_sec ? <> · {fmtDur(videoMeta.duration_sec)}</> : null}
        </div>
      </div>
    </div>
  )
}

function Thumbnail({ videoId }) {
  if (!videoId) {
    return <div className="w-16 h-10 rounded bg-zinc-900 border border-zinc-800 shrink-0" />
  }
  return (
    <img
      src={`https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`}
      alt=""
      className="w-16 h-10 object-cover rounded bg-zinc-900 border border-zinc-800 shrink-0"
      onError={e => { e.currentTarget.style.visibility = 'hidden' }}
    />
  )
}

function CacheHitPanel({ cache, onCopyAgain, onRetry, busy, copyFlash, combinedReady }) {
  // Cache origin can be:
  //   - items-hit (cache.parameters.from_items=true): транскрипт лежит под
  //     каналом, который мы уже фетчили; finished_at = null. Показываем
  //     «уже сохранён в канале X» вместо «из кэша N времени назад».
  //   - jobs-hit (sourceless single-video): finished_at + engine/lang/timestamp
  //     известны, классическое «из кэша N часов назад».
  const fromItems = !!cache.parameters?.from_items
  const fromChannel = cache.parameters?.from_channel
  const ago = cache.finished_at
    ? humanAgo(Math.floor(Date.now() / 1000) - cache.finished_at)
    : null
  const src = cache.parameters?.engine
    ? `AI · ${cache.parameters.engine}`
    : (cache.parameters?.lang ? `субтитры · ${cache.parameters.lang}` : 'субтитры')
  return (
    <div className="rounded-md border border-emerald-800/50 bg-emerald-900/10 px-4 py-3 mb-3 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-emerald-400">✓</span>
          <span className="text-zinc-200">Уже есть транскрипт — скопирован в буфер</span>
        </div>
        <div className="text-zinc-400" style={{ fontSize: '14px' }}>
          {fromItems
            ? <>{fromChannel ? <>Из канала <span className="text-zinc-200">{fromChannel}</span> · </> : null}{src}</>
            : <>Из кэша {ago} · {src}</>}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Btn ghost   onClick={onRetry}     busy={busy}>
          <span className="inline-flex items-center gap-1.5"><RotateCw size={14} />Перетянуть</span>
        </Btn>
        <Btn primary onClick={onCopyAgain} busy={busy}>
          {copyFlash || (
            <span className="inline-flex items-center gap-1.5">
              <Copy size={14} />{combinedReady ? 'Скопировать всё' : 'Скопировать ещё раз'}
            </span>
          )}
        </Btn>
      </div>
    </div>
  )
}

function SearchingPanel({ stage, job }) {
  const detail = (() => {
    if (job?.yt?.stage === 'subs_found') return 'Субтитры найдены — сохраняю…'
    if (stage === 'subs-found')          return 'Субтитры найдены — сохраняю…'
    if (job?.yt?.video_id)               return 'Гонка youtube-transcript-api ⨉ yt-dlp…'
    return 'Загружаю метаданные…'
  })()
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900 px-4 py-3 mb-3">
      <div className="flex items-center gap-2">
        <Spinner />
        <span className="text-zinc-200">{detail}</span>
      </div>
    </div>
  )
}

function AwaitingAiPanel({ yt, engine, setEngine, onConfirm, busy }) {
  const dur = yt.duration_sec
  const cost = yt.est_cost_usd
  return (
    <div className="rounded-md border border-amber-800/50 bg-amber-900/10 px-4 py-3 mb-3">
      {/* Headline row: status + estimate left, primary action right */}
      <div className="flex items-center gap-3 mb-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-amber-400">⚠</span>
            <span className="text-zinc-200">Субтитров нет — нужна AI-транскрибация</span>
          </div>
          <div className="text-zinc-400" style={{ fontSize: '14px' }}>
            Длительность: <span className="text-zinc-200">{fmtDur(dur)}</span>
            {cost != null && (
              <> · оценка: <span className="text-zinc-200">${cost.toFixed(4)}</span></>
            )}
          </div>
        </div>
        <Btn primary onClick={onConfirm} busy={busy}>
          <span className="inline-flex items-center gap-1.5"><Mic size={14} />Транскрибировать</span>
        </Btn>
      </div>

      {/* Engine choice — secondary, full width below the headline */}
      <div className="grid grid-cols-2 gap-2">
        {ENGINES.map(e => (
          <button
            key={e.id}
            type="button"
            onClick={() => setEngine(e.id)}
            className={`text-left px-3 py-2 rounded-md border ${
              engine === e.id
                ? 'bg-zinc-800 border-zinc-500'
                : 'bg-zinc-900 border-zinc-800 hover:border-zinc-600'
            }`}
          >
            <div className="text-zinc-100">{e.label}</div>
            <div className="text-zinc-500" style={{ fontSize: '14px' }}>{e.hint}</div>
          </button>
        ))}
      </div>
    </div>
  )
}

function TranscribingPanel({ job }) {
  const eng = job?.yt?.engine || 'AI'
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900 px-4 py-3 mb-3">
      <div className="flex items-center gap-2 mb-1">
        <Spinner />
        <span className="text-zinc-200">Транскрибация ({eng})…</span>
      </div>
      <div className="text-zinc-500" style={{ fontSize: '14px' }}>
        Скачиваю аудио → отправляю в API. Может занять несколько минут.
      </div>
    </div>
  )
}

function DonePanel({ job, onCopyAgain, busy, copyFlash, combinedReady }) {
  const yt = job?.yt || {}
  const src = yt.kind === 'ai' ? `AI · ${yt.engine || ''}`.trim() : `субтитры · ${yt.lang || ''}`.trim()
  return (
    <div className="rounded-md border border-emerald-800/50 bg-emerald-900/10 px-4 py-3 mb-3 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-emerald-400">✓</span>
          <span className="text-zinc-200">Готово — текст в буфере</span>
        </div>
        <div className="text-zinc-400" style={{ fontSize: '14px' }}>
          {src}
          {yt.chars ? <> · {yt.chars.toLocaleString('ru-RU')} символов</> : null}
          {yt.cost_usd ? <> · ${yt.cost_usd.toFixed(4)}</> : null}
        </div>
      </div>
      <Btn primary onClick={onCopyAgain} busy={busy}>
        {copyFlash || (
          <span className="inline-flex items-center gap-1.5">
            <Copy size={14} />{combinedReady ? 'Скопировать всё' : 'Скопировать ещё раз'}
          </span>
        )}
      </Btn>
    </div>
  )
}

// Persistent toggle row above the stage panels. Three visual states:
//   - off              → just the toggle + grey hint «загрузить также комменты»
//   - on, in flight    → spinner + «получено N из M…»
//   - on, done/cached  → emerald ✓ + count
// Off→on triggers the parent's effect (kicks lookup → spawn). Off→on while
// transcript is still in flight = parallel start, no waiting.
function CommentsRow({ on, onToggle, commentsJob, commentsCache }) {
  const ytc = commentsJob?.yt_comments || null
  const cached = !!commentsCache && !commentsJob
  const running = commentsJob && commentsJob.status === 'running'
  const done    = (commentsJob && commentsJob.status === 'done') || cached
  const failed  = commentsJob && commentsJob.status === 'error'
  const total = ytc?.count_total ?? commentsCache?.parameters?.count_total

  let status = null
  if (failed) {
    status = <span className="text-red-400">✗ {commentsJob?.error || 'не удалось'}</span>
  } else if (done) {
    status = (
      <span className="text-emerald-400">
        ✓ {total != null ? `${Number(total).toLocaleString('ru-RU')} комментариев` : 'готово'}
        {cached && <span className="text-zinc-500"> · из кэша</span>}
      </span>
    )
  } else if (running) {
    const got = ytc?.got
    const exp = ytc?.expected
    status = (
      <span className="inline-flex items-center gap-1.5 text-zinc-300">
        <span className="inline-block w-3 h-3 rounded-full border-2 border-zinc-600 border-t-zinc-200 animate-spin" />
        <span className="tabular-nums">
          {got != null && exp != null && exp > 0 && exp < 1_000_000
            ? `${got.toLocaleString('ru-RU')} из ${exp.toLocaleString('ru-RU')}…`
            : 'тяну комментарии…'}
        </span>
      </span>
    )
  }

  return (
    <div className="flex items-center gap-3 mb-3">
      <label className="inline-flex items-center gap-2 cursor-pointer select-none">
        <Checkbox checked={on} onChange={onToggle} size="sm" />
        <span className="text-zinc-300">+ комментарии</span>
      </label>
      <div className="text-zinc-500 ml-2" style={{ fontSize: '14px' }}>
        {!on
          ? 'дефолт: новые, до 500, без ответов'
          : status || 'запускаю…'}
      </div>
    </div>
  )
}

function ErrorPanel({ err, onRetry, busy }) {
  return (
    <div className="rounded-md border border-red-800/50 bg-red-900/10 px-4 py-3 mb-3 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-red-400">✗</span>
          <span className="text-zinc-200">Ошибка</span>
        </div>
        <div className="text-zinc-400 break-words" style={{ fontSize: '14px' }}>
          {err || 'Неизвестная ошибка'}
        </div>
      </div>
      <Btn primary onClick={onRetry} busy={busy}>
        <span className="inline-flex items-center gap-1.5"><RotateCw size={14} />Повторить</span>
      </Btn>
    </div>
  )
}

function SettingsRow({ lang, setLang, withTs, setWithTs }) {
  return (
    <div className="flex items-center gap-4 mt-3 text-zinc-400" style={{ fontSize: '14px' }}>
      <span className="text-zinc-500 uppercase tracking-wider" style={{ fontSize: '12px' }}>
        Параметры
      </span>
      <div className="flex items-center gap-1">
        <span className="text-zinc-500">Язык:</span>
        <button
          type="button"
          onClick={() => setLang('ru')}
          className={`px-2 py-0.5 rounded ${lang === 'ru' ? 'bg-zinc-700 text-zinc-100' : 'hover:text-zinc-200'}`}
        >ru</button>
        <button
          type="button"
          onClick={() => setLang('en')}
          className={`px-2 py-0.5 rounded ${lang === 'en' ? 'bg-zinc-700 text-zinc-100' : 'hover:text-zinc-200'}`}
        >en</button>
      </div>
      <Checkbox
        checked={withTs}
        onChange={setWithTs}
        size="sm"
        label="с таймкодами"
      />
    </div>
  )
}

// ─── helpers ────────────────────────────────────────────────────────────

function Btn({ children, onClick, busy, primary, ghost }) {
  const base = 'px-3 py-1.5 rounded-md transition-colors min-w-[140px] text-center'
  const styles = ghost
    ? 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
    : primary
      ? 'bg-zinc-100 text-zinc-900 hover:bg-white disabled:bg-zinc-800 disabled:text-zinc-500'
      : 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700'
  return (
    <button onClick={onClick} disabled={busy} className={`${base} ${styles}`}>
      {busy ? '…' : children}
    </button>
  )
}

function Spinner() {
  return (
    <span className="inline-block w-3.5 h-3.5 rounded-full border-2 border-zinc-600 border-t-zinc-200 animate-spin" />
  )
}

function fmtDur(secs) {
  if (!secs) return '—'
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = secs % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatBytes(n) {
  if (n == null) return ''
  if (n < 1024)        return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function humanAgo(secs) {
  if (secs < 5)         return 'только что'
  if (secs < 60)        return `${secs} сек назад`
  if (secs < 3600)      return `${Math.round(secs / 60)} мин назад`
  if (secs < 86400)     return `${Math.round(secs / 3600)} ч назад`
  if (secs < 604800)    return `${Math.round(secs / 86400)} д назад`
  return `${Math.round(secs / 604800)} нед назад`
}
