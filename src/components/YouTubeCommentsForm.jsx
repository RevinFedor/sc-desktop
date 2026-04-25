import React, {
  useEffect, useImperativeHandle, useMemo, useRef, useState, forwardRef,
} from 'react'
import {
  startYoutubeComments, lookupYoutubeCommentsCache, copyCachedYoutubeFile,
  watchJob, useJobs,
} from '../lib/jobs'
import { formatCopyToast } from '../lib/formatTokens'
import Checkbox from './Checkbox'
import { RotateCw, Copy } from 'lucide-react'

// Shared with YouTubeSingleForm (kept inline to avoid pulling its other deps).
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

const SORTS = [
  { id: 'new', label: 'по новизне', hint: 'свежие сверху' },
  { id: 'top', label: 'по топу',    hint: 'самые залайканные' },
]

const DEFAULT_LIMIT = 500

/**
 * Inline YouTube comments form. Mounts open (sort=new, limit=200, replies=off)
 * — there's no point in a folded summary when the user just clicked the
 * `[комментарии]` chip with explicit intent. Auto-copies the resulting .txt
 * to clipboard the moment the job lands, mirroring the single-video form.
 *
 * Cache key is the exact (sort, limit, includeReplies) tuple — different
 * parameter sets produce different files so a 200-top fetch never gets
 * reused for a 500-new request. Cache hit happens before any spawn — pure
 * IPC + clipboard write.
 */
const YouTubeCommentsForm = forwardRef(function YouTubeCommentsForm({ url, onStarted, compact = false }, ref) {
  // 'idle' | 'fetching' | 'done' | 'error'
  // ('cache-hit' is handled by stamping `cache` and going straight to 'done'.)
  const [stage, setStage]   = useState('idle')
  const [job, setJob]       = useState(null)         // live snapshot
  const [cache, setCache]   = useState(null)         // {file_path, parameters, finished_at}
  const [err, setErr]       = useState(null)
  const [copyFlash, setCopyFlash] = useState(null)   // toast text for the copy button
  const [busy, setBusy]     = useState(false)

  const [sort, setSort] = useState('new')
  const [limit, setLimit] = useState(DEFAULT_LIMIT)   // 0 = все, иначе число
  const [includeReplies, setIncludeReplies] = useState(false)

  const videoId = useMemo(() => extractVideoId(url), [url])

  // Re-mount restoration via useJobs(). When the user clicked «получить»,
  // navigated away, and came back, the form rebuilds 'done' state from the
  // most recent matching job in the global store — same shape as the cache
  // hit so the user sees the result + Copy button without re-running.
  const allJobs = useJobs()
  const watchOff = useRef(null)
  useEffect(() => {
    if (!url) return
    if (stage !== 'idle' || job || cache) return
    const match = allJobs
      .filter(j =>
        j.type === 'yt_comments' &&
        j.target === url &&
        j.params?.sort  === sort &&
        Number(j.params?.limit)  === Number(limit) &&
        !!j.params?.includeReplies === !!includeReplies)
      .sort((a, b) => (b.started_at || 0) - (a.started_at || 0))[0]
    if (!match) return
    setJob(match)
    if (match.status === 'done')         setStage('done')
    else if (match.status === 'error')   { setErr(match.error || 'unknown error'); setStage('error') }
    else if (match.status === 'running') {
      setStage('fetching')
      const off = watchJob(match.id, snap => snap && setJob(snap))
      watchOff.current = off
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allJobs])

  useEffect(() => () => { if (watchOff.current) watchOff.current() }, [])

  // Cache lookup whenever the user changes sort/limit/replies. Pure read —
  // doesn't kick a fetch. If a cached file exists for the new tuple we show
  // the same Done panel as a fresh result (with «Из кэша N назад») so the
  // user can copy without re-running. Pre-empts the spawn and is cheap enough
  // to fire on every input change.
  useEffect(() => {
    if (!videoId) return
    let alive = true
    ;(async () => {
      const c = await lookupYoutubeCommentsCache({
        videoId, sort, limit: Number(limit), includeReplies: !!includeReplies,
      })
      if (!alive) return
      // Don't override an active job in flight.
      if (stage === 'fetching') return
      if (c) {
        setCache(c)
        setJob(null)
        setStage('done')
        setErr(null)
      } else {
        // Tuple changed and there's no hit for this combo. Reset done-state
        // (whether it came from a fresh job or a previous cache hit) so the
        // user clicks «получить» for the new one — not silently reuses an
        // old result whose params differ from what's currently selected.
        if (stage === 'done') {
          setCache(null)
          setJob(null)
          setStage('idle')
        }
      }
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId, sort, limit, includeReplies])

  async function kickOff() {
    if (!videoId) {
      setErr('Не удалось распознать ID видео в URL')
      setStage('error')
      return
    }
    setStage('fetching'); setErr(null); setBusy(true); setCache(null)
    try {
      const id = await startYoutubeComments({
        url, sort, limit: Number(limit) || 0, includeReplies: !!includeReplies,
      })
      if (id == null) {
        setErr('Электрон-IPC недоступен')
        setStage('error'); return
      }
      onStarted && onStarted(id)
      const off = watchJob(id, snap => {
        setJob(snap)
        if (snap.status === 'done')      setStage('done')
        else if (snap.status === 'error') { setErr(snap.error || 'Unknown error'); setStage('error') }
        else if (snap.status === 'cancelled') setStage('idle')
      })
      watchOff.current = off
    } finally {
      setBusy(false)
    }
  }

  async function copyAgain() {
    const fp = job?.file_path || cache?.file_path
    if (!fp) return
    const r = await copyCachedYoutubeFile(fp)
    if (r.ok) {
      setCopyFlash(formatCopyToast({ bytes: r.bytes }))
      setTimeout(() => setCopyFlash(null), 2200)
    }
  }

  useImperativeHandle(ref, () => ({
    trigger() {
      if (busy) return true
      if (stage === 'idle')   { kickOff();    return true }
      if (stage === 'error')  { kickOff();    return true }
      if (stage === 'done')   { copyAgain();  return true }
      return true
    },
  }), [stage, busy, job?.file_path, cache?.file_path])

  // Compose header values that swap in once we know the video.
  const yt = job?.yt_comments || null
  const liveTitle   = yt?.title || cache?.parameters?.title || null
  const liveChannel = yt?.channel || cache?.parameters?.channel || null

  // Compact mode: dropped under a video-row that already shows thumbnail +
  // title; we skip our own header and tighten the box. Standalone mode keeps
  // the standalone-form chrome.
  const containerClass = compact
    ? 'rounded-md border border-zinc-800 bg-zinc-950/50 p-3'
    : 'rounded-lg border border-zinc-800 bg-zinc-950 p-6'

  return (
    <div className={containerClass}>
      {!compact && <Header videoId={videoId} url={url} title={liveTitle} channel={liveChannel} />}

      {/* Form row — single line, primary action on the right (free space → button). */}
      <FormRow
        sort={sort}            onSort={setSort}
        limit={limit}          onLimit={setLimit}
        includeReplies={includeReplies}
        onIncludeReplies={setIncludeReplies}
        stage={stage}
        onStart={kickOff}
        busy={busy}
        cacheHit={stage === 'done' && cache && !job}
      />

      {stage === 'fetching' && (
        <FetchingPanel job={job} />
      )}

      {stage === 'done' && (
        <DonePanel
          job={job}
          cache={cache}
          onCopyAgain={copyAgain}
          copyFlash={copyFlash}
        />
      )}

      {stage === 'error' && (
        <ErrorPanel err={err || job?.error} onRetry={kickOff} busy={busy} />
      )}
    </div>
  )
})

export default YouTubeCommentsForm

// ─── Sub-panels ─────────────────────────────────────────────────────────

function Header({ videoId, url, title, channel }) {
  return (
    <div className="flex items-start gap-3 mb-4">
      <Thumbnail videoId={videoId} />
      <div className="flex-1 min-w-0">
        <div className="text-zinc-100 font-medium truncate">
          {title || 'Комментарии к видео'}
        </div>
        <div className="text-zinc-500 truncate" style={{ fontSize: '14px' }}>
          {channel ? <>{channel} · </> : null}
          <code className="text-xs break-all">{url}</code>
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

function FormRow({
  sort, onSort, limit, onLimit, includeReplies, onIncludeReplies,
  stage, onStart, busy, cacheHit,
}) {
  // While fetching we keep the controls visible but greyed out — the user
  // can see what tuple is in flight, can't accidentally change it.
  const disabled = stage === 'fetching'
  const buttonLabel = cacheHit
    ? <span className="inline-flex items-center gap-1.5"><RotateCw size={14} />Перетянуть</span>
    : 'Получить'
  return (
    <div className="flex flex-wrap items-center gap-3 mb-3">
      <Selector
        label="Сортировка"
        value={sort}
        onChange={onSort}
        options={SORTS}
        disabled={disabled}
      />
      <LimitControl value={limit} onChange={onLimit} disabled={disabled} />
      <Checkbox
        checked={includeReplies}
        onChange={onIncludeReplies}
        size="sm"
        label="с ответами"
        disabled={disabled}
      />
      <button
        onClick={onStart}
        disabled={disabled || busy}
        className="ml-auto min-w-[120px] text-center px-3 py-1.5 rounded-md bg-zinc-100 text-zinc-900 hover:bg-white disabled:bg-zinc-800 disabled:text-zinc-500"
      >
        {busy ? '…' : buttonLabel}
      </button>
    </div>
  )
}

function LimitControl({ value, onChange, disabled }) {
  // Three controls in one row: pill `500` (default), text input for any custom
  // number, pill `все` (no limit, value=0). Pills act as quick presets that
  // also clear the input. Typing in the input deactivates both pills. Empty
  // input on blur snaps back to default 500 — no «invisible state» where
  // the user thinks they're getting 500 but actually fired with 0.
  const numeric = Number(value)
  const isDefault = numeric === DEFAULT_LIMIT
  const isAll     = numeric === 0
  const isCustom  = !isDefault && !isAll

  // Local input mirror so the user can clear/edit freely without flicker.
  const [text, setText] = useState(isCustom ? String(numeric) : '')
  // Sync external pill clicks back into the input.
  useEffect(() => {
    if (isCustom) setText(String(numeric))
    else if (text !== '') setText('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  function commitText(raw) {
    const n = parseInt(String(raw).replace(/\D+/g, ''), 10)
    if (Number.isFinite(n) && n > 0) onChange(n)
    else { onChange(DEFAULT_LIMIT); setText('') }
  }

  return (
    <div className="inline-flex items-center gap-1.5">
      <span className="text-zinc-500" style={{ fontSize: '14px' }}>Сколько:</span>
      <div className="inline-flex rounded-md bg-zinc-900 border border-zinc-800 overflow-hidden">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange(DEFAULT_LIMIT)}
          title="Дефолт — 500 комментариев (~20 сек)"
          className={`px-2.5 py-1 transition-colors ${
            isDefault ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
          } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
          style={{ fontSize: '14px' }}
        >500</button>
        <input
          type="text"
          inputMode="numeric"
          disabled={disabled}
          value={text}
          onChange={e => {
            const v = e.target.value
            // Live: keep digits in `text`, push numeric to onChange so the
            // cache-effect re-runs against the typed value. Non-numeric is
            // dropped from the live `value` (stays in `text` until parse).
            const cleaned = v.replace(/\D+/g, '')
            setText(v)
            if (cleaned) onChange(parseInt(cleaned, 10))
            else if (v === '') onChange(DEFAULT_LIMIT)  // empty mid-edit = back to default
          }}
          onBlur={() => commitText(text)}
          onKeyDown={e => { if (e.key === 'Enter') { commitText(text); e.preventDefault() } }}
          placeholder="своё"
          title="Любое число — запрос ровно столько комментариев"
          className={`w-20 px-2 py-1 bg-transparent border-x border-zinc-800 outline-none tabular-nums ${
            isCustom ? 'text-zinc-100' : 'text-zinc-500'
          } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
          style={{ fontSize: '14px' }}
        />
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange(0)}
          title="Без лимита — может занять минуты"
          className={`px-2.5 py-1 transition-colors ${
            isAll ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
          } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
          style={{ fontSize: '14px' }}
        >все</button>
      </div>
    </div>
  )
}

function Selector({ label, value, onChange, options, disabled }) {
  // Compact pill row — no native <select>, mirrors design.md Контролы.
  return (
    <div className="inline-flex items-center gap-1.5">
      <span className="text-zinc-500" style={{ fontSize: '14px' }}>{label}:</span>
      <div className="inline-flex rounded-md bg-zinc-900 border border-zinc-800 overflow-hidden">
        {options.map(o => {
          const active = o.id === value
          return (
            <button
              key={o.id}
              type="button"
              disabled={disabled}
              onClick={() => onChange(o.id)}
              title={o.hint}
              className={
                `px-2.5 py-1 transition-colors ${
                  active
                    ? 'bg-zinc-700 text-zinc-100'
                    : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`
              }
              style={{ fontSize: '14px' }}
            >
              {o.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function FetchingPanel({ job }) {
  const yt = job?.yt_comments || null
  // yt-dlp's `(got/expected)` line — once it reaches the limit the
  // expected number flips to that limit. Render whichever is most informative.
  let detail = 'Подключаюсь к YouTube…'
  if (yt && yt.got != null) {
    const exp = yt.expected
    if (exp != null && exp > 0 && exp < 1_000_000) {
      detail = `Получено ${yt.got.toLocaleString('ru-RU')} из ${exp.toLocaleString('ru-RU')}…`
    } else {
      detail = `Получено ${yt.got.toLocaleString('ru-RU')} комментариев…`
    }
  }
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900 px-4 py-3 mb-3">
      <div className="flex items-center gap-2">
        <Spinner />
        <span className="text-zinc-200 tabular-nums">{detail}</span>
      </div>
    </div>
  )
}

function DonePanel({ job, cache, onCopyAgain, copyFlash }) {
  // Origin: live job (just finished) vs cache hit (rerun for cached tuple).
  const yt = job?.yt_comments || null
  const total   = yt?.count_total   ?? cache?.parameters?.count_total
  const top     = yt?.count_top     ?? cache?.parameters?.count_top
  const replies = yt?.count_replies ?? cache?.parameters?.count_replies
  // Persist source-of-truth for "with replies" comes from the params used
  // to build the file, NOT the current form state — user might have toggled
  // the checkbox after the result landed and the form-side cache effect would
  // have already cleared the result if the new tuple has no hit. So if we're
  // showing this card, params still match.
  const includedReplies = job?.params?.includeReplies
                          ?? cache?.parameters?.include_replies
                          ?? false
  const ago = cache?.finished_at
    ? humanAgo(Math.floor(Date.now() / 1000) - cache.finished_at)
    : null

  // The copy button uses a fixed min-w so the toast text doesn't reflow it.
  const flashing = !!copyFlash
  const buttonLabel = flashing
    ? copyFlash
    : <span className="inline-flex items-center gap-1.5"><Copy size={14} />Скопировать ещё раз</span>

  // Composition tag — most informative form, in priority order:
  //   1) explicit thread/reply counts when replies were included
  //   2) "только верхнеуровневые" when replies were off
  //   3) fallback to total only (shouldn't happen — replies flag is always known)
  let composition = ''
  if (includedReplies && top != null && replies != null && replies > 0) {
    composition = `${Number(top).toLocaleString('ru-RU')} тредов + ${Number(replies).toLocaleString('ru-RU')} ответов`
  } else if (!includedReplies) {
    composition = 'только верхнеуровневые'
  }

  return (
    <div className="rounded-md border border-emerald-800/50 bg-emerald-900/10 px-4 py-3 mb-3 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-emerald-400">✓</span>
          <span className="text-zinc-200">
            {cache && !job ? 'Уже есть в кэше — скопирован в буфер' : 'Готово — текст в буфере'}
          </span>
        </div>
        <div className="text-zinc-400" style={{ fontSize: '14px' }}>
          {[
            total != null ? `${Number(total).toLocaleString('ru-RU')} комментариев` : null,
            composition || null,
            ago ? `Из кэша ${ago}` : null,
          ].filter(Boolean).join(' · ')}
        </div>
      </div>
      <button
        onClick={onCopyAgain}
        disabled={flashing}
        className={`min-w-[210px] px-3 py-1.5 rounded-md transition-colors ${
          flashing
            ? 'bg-emerald-700 text-emerald-50 cursor-default'
            : 'bg-zinc-100 text-zinc-900 hover:bg-white'
        }`}
        style={{ fontSize: '14px' }}
      >
        {buttonLabel}
      </button>
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
      <button
        onClick={onRetry}
        disabled={busy}
        className="px-3 py-1.5 rounded-md bg-zinc-100 text-zinc-900 hover:bg-white disabled:bg-zinc-800 disabled:text-zinc-500"
        style={{ fontSize: '14px' }}
      >
        {busy ? '…' : <span className="inline-flex items-center gap-1.5"><RotateCw size={14} />Повторить</span>}
      </button>
    </div>
  )
}

function Spinner() {
  return (
    <span className="inline-block w-3.5 h-3.5 rounded-full border-2 border-zinc-600 border-t-zinc-200 animate-spin" />
  )
}

function humanAgo(secs) {
  if (secs < 5)         return 'только что'
  if (secs < 60)        return `${secs} сек назад`
  if (secs < 3600)      return `${Math.round(secs / 60)} мин назад`
  if (secs < 86400)     return `${Math.round(secs / 3600)} ч назад`
  if (secs < 604800)    return `${Math.round(secs / 86400)} д назад`
  return `${Math.round(secs / 604800)} нед назад`
}
