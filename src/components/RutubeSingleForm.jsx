import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import { Copy, Mic, RotateCw } from 'lucide-react'
import {
  copyCachedRutubeFile,
  lookupRutubeCache,
  resumeRutubeAi,
  startRutubeSingle,
  watchJob,
} from '../lib/jobs'

const ENGINES = [
  { id: 'gemini', label: 'Gemini 2.5 Flash', hint: 'дешевле для обычных роликов' },
  { id: 'assemblyai', label: 'AssemblyAI', hint: 'стабильнее для длинных записей' },
]

function extractRutubeId(url) {
  const match = String(url || '').match(
    /rutube\.ru\/(?:(?:live\/)?video(?:\/private)?|(?:play\/)?embed)\/([0-9a-z]{32})(?:[/?#]|$)/i,
  )
  return match?.[1]?.toLowerCase() || null
}

function formatBytes(value) {
  const bytes = Number(value || 0)
  if (bytes < 1024) return `${bytes} Б`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`
}

function formatDuration(value) {
  const total = Math.max(0, Math.round(Number(value || 0)))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`
}

const RutubeSingleForm = forwardRef(function RutubeSingleForm({ url, onStarted }, ref) {
  const [stage, setStage] = useState('idle')
  const [job, setJob] = useState(null)
  const [cache, setCache] = useState(null)
  const [engine, setEngine] = useState('gemini')
  const [error, setError] = useState(null)
  const [toast, setToast] = useState(null)
  const [busy, setBusy] = useState(false)
  const watcherRef = useRef(null)
  const videoId = extractRutubeId(url)

  useEffect(() => {
    watcherRef.current?.()
    watcherRef.current = null
    setStage('idle')
    setJob(null)
    setCache(null)
    setError(null)
    setToast(null)
    if (!url || !videoId) return undefined

    let alive = true
    ;(async () => {
      let preferredEngine = 'gemini'
      try {
        const settings = await window.api?.appSettingsGet?.()
        if (settings?.youtube?.engine === 'assemblyai') preferredEngine = 'assemblyai'
      } catch {}
      if (!alive) return
      setEngine(preferredEngine)

      const cached = await lookupRutubeCache(videoId)
      if (!alive) return
      if (cached) {
        setCache(cached)
        setStage('cache-hit')
        const copied = await copyCachedRutubeFile(cached.file_path)
        if (alive && copied?.ok) setToast(`Скопировано из кэша · ${formatBytes(copied.bytes)}`)
        return
      }
      await kickOff()
    })()

    return () => {
      alive = false
      watcherRef.current?.()
      watcherRef.current = null
    }
    // A new URL owns a new form lifecycle. Other values are intentionally
    // captured for that lifecycle so a settings update cannot retarget a job.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, videoId])

  async function kickOff() {
    if (!videoId || busy || stage === 'searching' || stage === 'transcribing') return
    setBusy(true)
    setStage('searching')
    setError(null)
    try {
      const id = await startRutubeSingle({ url, lang: 'ru', withTs: false })
      if (id == null) {
        setError('Electron IPC недоступен')
        setStage('error')
        return
      }
      onStarted?.(id)
      watcherRef.current?.()
      watcherRef.current = watchJob(id, snapshot => {
        setJob(snapshot)
        const rutube = snapshot.rutube || {}
        if (snapshot.status === 'awaiting_ai') {
          setStage('awaiting-ai')
        } else if (snapshot.status === 'done') {
          setStage('done')
          if (rutube.copied_bytes) {
            setToast(`Готово · скопировано ${formatBytes(rutube.copied_bytes)}`)
          }
        } else if (snapshot.status === 'error') {
          setError(snapshot.error || 'Не удалось обработать Rutube')
          setStage('error')
        } else if (snapshot.status === 'cancelled') {
          setStage('idle')
        } else if (['downloading_audio', 'audio_ready', 'transcribing', 'transcribed', 'saving'].includes(rutube.stage)) {
          setStage('transcribing')
        } else if (rutube.stage === 'subs_found') {
          setStage('subs-found')
        } else {
          setStage('searching')
        }
      })
    } finally {
      setBusy(false)
    }
  }

  async function confirmAi() {
    if (!job?.id || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await resumeRutubeAi(job.id, engine)
      if (result?.ok === false) {
        setError(result.error || 'Не удалось продолжить задачу')
        setStage('error')
      } else {
        setStage('transcribing')
      }
    } finally {
      setBusy(false)
    }
  }

  async function copyAgain() {
    const filePath = cache?.file_path || job?.file_path
    if (!filePath || busy) return
    setBusy(true)
    try {
      const result = await copyCachedRutubeFile(filePath)
      if (result?.ok) setToast(`Скопировано · ${formatBytes(result.bytes)}`)
    } finally {
      setBusy(false)
    }
  }

  async function retry() {
    setCache(null)
    setJob(null)
    setError(null)
    setStage('idle')
    await kickOff()
  }

  useImperativeHandle(ref, () => ({
    trigger() {
      if (busy) return true
      if (stage === 'awaiting-ai') confirmAi()
      else if (stage === 'cache-hit' || stage === 'done') copyAgain()
      else if (stage === 'idle' || stage === 'error') retry()
      return true
    },
  }), [busy, stage, job?.id, engine, cache?.file_path])

  const rutube = job?.rutube || {}
  const title = rutube.title || job?.entity_title || cache?.parameters?.title
  const channel = rutube.channel || cache?.parameters?.channel
  const duration = rutube.duration_sec || cache?.parameters?.duration_sec
  const thumbnail = rutube.thumbnail_url || cache?.parameters?.thumbnail_url

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-6">
      <div className="flex items-start gap-3 mb-4">
        {thumbnail ? (
          <img
            src={thumbnail}
            alt=""
            className="w-20 h-12 object-cover rounded bg-zinc-900 border border-zinc-800 shrink-0"
            onError={event => { event.currentTarget.style.visibility = 'hidden' }}
          />
        ) : (
          <div className="w-20 h-12 rounded bg-zinc-900 border border-zinc-800 shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <div className="text-zinc-100 font-medium truncate">
            {title || (stage === 'searching' ? 'Получаем данные Rutube…' : 'Видео Rutube')}
          </div>
          <div className="text-zinc-500 truncate" style={{ fontSize: '14px' }}>
            {channel || 'Rutube'}{duration ? ` · ${formatDuration(duration)}` : ''}
          </div>
        </div>
      </div>

      {(stage === 'searching' || stage === 'subs-found') && (
        <StatusPanel>
          <Spinner />
          <span className="text-zinc-200">
            {stage === 'subs-found' ? 'Субтитры найдены — сохраняем…' : 'Проверяем субтитры Rutube…'}
          </span>
        </StatusPanel>
      )}

      {stage === 'awaiting-ai' && (
        <div className="rounded-md border border-amber-800/50 bg-amber-900/10 px-4 py-3">
          <div className="flex items-center gap-3 mb-3">
            <div className="flex-1 min-w-0">
              <div className="text-zinc-200">Субтитров нет — нужна AI-расшифровка</div>
              <div className="text-zinc-400 mt-1" style={{ fontSize: '14px' }}>
                {rutube.duration_sec ? `Длительность: ${formatDuration(rutube.duration_sec)}` : 'Длительность неизвестна'}
                {rutube.est_cost_usd != null ? ` · оценка: $${Number(rutube.est_cost_usd).toFixed(4)}` : ''}
              </div>
            </div>
            <button
              type="button"
              onClick={confirmAi}
              disabled={busy}
              aria-label="Подтвердить AI-расшифровку Rutube"
              className="px-3 py-2 rounded-md bg-zinc-100 text-zinc-900 hover:bg-white disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              <Mic size={14} />Расшифровать
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {ENGINES.map(option => (
              <button
                key={option.id}
                type="button"
                onClick={() => setEngine(option.id)}
                className={`text-left px-3 py-2 rounded-md border ${
                  engine === option.id
                    ? 'bg-zinc-800 border-zinc-500'
                    : 'bg-zinc-900 border-zinc-800 hover:border-zinc-600'
                }`}
              >
                <div className="text-zinc-100">{option.label}</div>
                <div className="text-zinc-500" style={{ fontSize: '14px' }}>{option.hint}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {stage === 'transcribing' && (
        <StatusPanel>
          <Spinner />
          <div>
            <div className="text-zinc-200">
              {rutube.stage === 'downloading_audio' ? 'Скачиваем аудио…' : `Расшифровываем через ${rutube.engine || engine}…`}
            </div>
            <div className="text-zinc-500 mt-0.5" style={{ fontSize: '14px' }}>
              Это может занять несколько минут.
            </div>
          </div>
        </StatusPanel>
      )}

      {(stage === 'cache-hit' || stage === 'done') && (
        <div className="rounded-md border border-emerald-800/50 bg-emerald-900/10 px-4 py-3 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-zinc-200">
              {stage === 'cache-hit' ? 'Расшифровка уже была готова — текст в буфере' : 'Готово — текст в буфере'}
            </div>
            <div className="text-zinc-400 mt-1" style={{ fontSize: '14px' }}>
              {rutube.kind === 'ai' || cache?.parameters?.engine
                ? `AI · ${rutube.engine || cache?.parameters?.engine}`
                : `субтитры · ${rutube.lang || cache?.parameters?.lang || 'ru'}`}
              {rutube.chars ? ` · ${Number(rutube.chars).toLocaleString('ru-RU')} символов` : ''}
            </div>
          </div>
          {stage === 'cache-hit' && (
            <button
              type="button"
              onClick={retry}
              disabled={busy}
              aria-label="Перепроверить расшифровку Rutube"
              className="px-2.5 py-1.5 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              <RotateCw size={14} />Перепроверить
            </button>
          )}
          <button
            type="button"
            onClick={copyAgain}
            disabled={busy}
            aria-label="Скопировать расшифровку Rutube"
            className="px-3 py-1.5 rounded-md bg-zinc-100 text-zinc-900 hover:bg-white disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            <Copy size={14} />Скопировать ещё раз
          </button>
        </div>
      )}

      {stage === 'error' && (
        <div className="rounded-md border border-red-900/50 bg-red-950/20 px-4 py-3 flex items-center gap-3">
          <div className="text-red-400 flex-1 break-words">{error || 'Не удалось обработать Rutube'}</div>
          <button
            type="button"
            onClick={retry}
            disabled={busy}
            aria-label="Повторить обработку Rutube"
            className="px-3 py-1.5 rounded-md bg-red-900/40 text-red-200 hover:bg-red-900/60 disabled:opacity-50"
          >Повторить</button>
        </div>
      )}

      {stage === 'idle' && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={retry}
            disabled={busy}
            aria-label="Получить расшифровку Rutube"
            className="px-3 py-1.5 rounded-md bg-zinc-100 text-zinc-900 hover:bg-white disabled:opacity-50"
          >Получить расшифровку</button>
        </div>
      )}

      {toast && <div className="text-zinc-400 mt-3" style={{ fontSize: '14px' }}>{toast}</div>}
    </div>
  )
})

function StatusPanel({ children }) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900 px-4 py-3 flex items-center gap-2">
      {children}
    </div>
  )
}

function Spinner() {
  return <span className="inline-block w-4 h-4 rounded-full border-2 border-zinc-700 border-t-zinc-200 animate-spin shrink-0" />
}

export default RutubeSingleForm
