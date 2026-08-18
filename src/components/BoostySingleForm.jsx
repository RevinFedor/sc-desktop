import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from 'react'
import { Check, Copy, ExternalLink, FolderOpen, Square, Video } from 'lucide-react'
import { previewBoostyPost, startBoostyBatchTranscribe, useJobs } from '../lib/jobs'
import { pushScreen } from '../lib/store'
import PlatformLogo from './PlatformLogo'

const BoostySingleForm = forwardRef(function BoostySingleForm({ url, onStarted }, ref) {
  const jobs = useJobs()
  const [preview, setPreview] = useState(null)
  const [selected, setSelected] = useState(new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [jobId, setJobId] = useState(null)
  const [busy, setBusy] = useState(false)
  const [flash, setFlash] = useState(null)
  const job = useMemo(() => jobs.find(item => item.id === jobId) || null, [jobs, jobId])
  const active = job?.status === 'running'

  useEffect(() => {
    let alive = true
    setPreview(null)
    setSelected(new Set())
    setLoading(true)
    setError(null)
    setJobId(null)
    previewBoostyPost({ url }).then(result => {
      if (!alive) return
      setPreview(result)
      const videos = result?.post?.videos || []
      const initial = result?.selected_video_id
        ? videos.filter(video => String(video.video_id).toLowerCase() === String(result.selected_video_id).toLowerCase())
        : videos
      setSelected(new Set(initial.map(video => String(video.video_id))))
    }).catch(err => {
      if (alive) setError(cleanError(err?.message || err))
    }).finally(() => {
      if (alive) setLoading(false)
    })
    return () => { alive = false }
  }, [url])

  useEffect(() => {
    if (job?.status === 'error') setError(cleanError(job.error))
  }, [job?.status])

  async function submit() {
    if (!preview?.source_id || !selected.size || active || busy) return
    setBusy(true)
    setError(null)
    try {
      const id = await startBoostyBatchTranscribe({
        source_id: preview.source_id,
        video_ids: [...selected],
        mode: 'transcribe',
      })
      if (id == null) throw new Error('Boosty IPC недоступен')
      setJobId(id)
      onStarted?.(id)
    } catch (err) {
      setError(cleanError(err?.message || err))
    } finally {
      setBusy(false)
    }
  }

  async function copySelected() {
    const result = await window.api?.boostyCopyTranscripts?.({
      source_id: preview?.source_id,
      video_ids: [...selected],
    })
    setFlash(result?.ok ? `Скопировано расшифровок: ${result.count}` : (result?.error || 'Нечего копировать'))
    setTimeout(() => setFlash(null), 2400)
  }

  useImperativeHandle(ref, () => ({
    trigger() {
      if (job?.status === 'done') return copySelected()
      return submit()
    },
  }))

  if (loading) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-5 flex items-center gap-3 text-zinc-400">
        <span className="w-4 h-4 rounded-full border-2 border-zinc-700 border-t-zinc-200 animate-spin" />
        Читаю пост и список видео…
      </div>
    )
  }

  if (!preview?.post) {
    return (
      <div className="rounded-lg border border-red-900/60 bg-red-950/20 p-5">
        <div className="text-red-300">{error || 'Не удалось прочитать пост Boosty'}</div>
        <button type="button" onClick={() => window.api?.openUrl?.(url)} className="mt-3 text-zinc-300 hover:text-white inline-flex items-center gap-2 text-sm">
          <ExternalLink size={14} /> Открыть на Boosty
        </button>
      </div>
    )
  }

  const { post, entity } = preview
  const videos = post.videos || []
  const locked = post.has_access !== true
  const batch = job?.boosty_batch || {}
  const done = job?.status === 'done'
  const audioBytes = (batch.log || []).reduce((sum, row) => sum + Number(row.audio_bytes || 0), 0)
  const audioFiles = (batch.log || []).filter(row => row.audio_path).length

  function toggle(videoId) {
    setSelected(prev => {
      const next = new Set(prev)
      const key = String(videoId)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 overflow-hidden">
      <div className="p-4 flex gap-4">
        {post.thumbnail_url ? (
          <img src={post.thumbnail_url} alt="" referrerPolicy="no-referrer" className="w-36 aspect-video rounded-md object-cover bg-zinc-900 shrink-0" />
        ) : (
          <div className="w-36 aspect-video rounded-md bg-zinc-900 flex items-center justify-center shrink-0"><Video size={24} className="text-zinc-700" /></div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-zinc-500 text-sm">
            <PlatformLogo platform="boosty" size={15} />
            <span>{entity?.title || `@${entity?.author_handle}`}</span>
            <span>·</span>
            <span>{formatDate(post.publish_time || post.created_at)}</span>
          </div>
          <div className="mt-1 text-lg font-medium text-zinc-100 line-clamp-2">{post.title}</div>
          <div className="mt-1 text-zinc-500 text-sm">
            {post.video_count > 0 ? `${post.video_count} видео` : 'Видео в посте не найдено'}
            {videos.length ? ` · ${formatDuration(videos.reduce((sum, video) => sum + Number(video.duration_sec || 0), 0))}` : ''}
          </div>
        </div>
        {preview.source_id && (
          <button type="button" onClick={() => pushScreen('source-detail', { sourceId: preview.source_id, platform: 'boosty' })} className="self-start text-zinc-500 hover:text-zinc-200 text-sm shrink-0">
            Автор в библиотеке
          </button>
        )}
      </div>

      {locked ? (
        <div className="border-t border-zinc-800 px-4 py-4 bg-amber-950/10 flex items-center gap-4">
          <div className="flex-1">
            <div className="text-amber-300">Нет доступа к видео этого поста</div>
            <div className="text-zinc-500 text-sm mt-0.5">
              {post.subscription_level?.name ? `Нужен уровень «${post.subscription_level.name}»` : 'Проверьте подписку аккаунта в браузере'}
            </div>
          </div>
          <button type="button" onClick={() => window.api?.openUrl?.(post.canonical_url)} className="h-9 px-3 rounded-md border border-zinc-700 text-zinc-300 hover:bg-zinc-800 inline-flex items-center gap-2">
            <ExternalLink size={14} /> Открыть на Boosty
          </button>
        </div>
      ) : (
        <>
          {videos.length > 0 && (
            <div className="border-t border-zinc-800 divide-y divide-zinc-900">
              {videos.map((video, index) => {
                const checked = selected.has(String(video.video_id))
                return (
                  <button key={video.video_id} type="button" onClick={() => toggle(video.video_id)} className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-zinc-900">
                    <span className={`w-5 h-5 rounded border flex items-center justify-center ${checked ? 'bg-orange-500 border-orange-500 text-white' : 'border-zinc-700'}`}>
                      {checked && <Check size={14} />}
                    </span>
                    <span className="text-zinc-600 tabular-nums text-sm w-5">{index + 1}</span>
                    <span className="flex-1 min-w-0 text-zinc-200 truncate">{video.title && video.title !== 'Видео Boosty' ? video.title : post.title}</span>
                    <span className="text-zinc-500 tabular-nums text-sm">{formatDuration(video.duration_sec)}</span>
                  </button>
                )
              })}
            </div>
          )}

          <div className="border-t border-zinc-800 p-4 bg-zinc-900/50">
            {active ? (
              <div>
                <div className="flex items-center gap-3">
                  <span className="w-4 h-4 rounded-full border-2 border-zinc-600 border-t-zinc-100 animate-spin shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-zinc-200">{batchTitle(batch)}</div>
                    <div className="text-zinc-500 text-sm mt-0.5 truncate">{batchDetails(job)}</div>
                  </div>
                  <button type="button" onClick={() => window.api?.cancelJob?.(job.id)} className="h-9 px-3 rounded-md border border-zinc-700 text-zinc-300 hover:bg-zinc-800 inline-flex items-center gap-2"><Square size={14} /> Стоп</button>
                </div>
                {batch.current?.stage === 'downloading' && (
                  <div className="mt-3 h-1.5 rounded-full overflow-hidden bg-zinc-800">
                    <div className={`h-full bg-orange-500 ${batch.current.percent == null ? 'w-1/3 animate-pulse' : ''}`} style={batch.current.percent == null ? undefined : { width: `${batch.current.percent}%` }} />
                  </div>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-4">
                <div className="flex-1 min-w-0 text-sm text-zinc-500">
                  {done
                    ? `Готово: ${batch.saved || selected.size} из ${job.items_total || selected.size} · ${audioBytes ? `аудио ${formatBytes(audioBytes)} на диске` : audioFiles ? 'аудио на диске' : 'аудио не хранится'}`
                    : `Выбрано ${selected.size} из ${videos.length} · аудио останется на диске · AssemblyAI`}
                </div>
                {done && (
                  <button type="button" onClick={copySelected} className="h-10 px-4 rounded-md bg-zinc-800 text-zinc-100 hover:bg-zinc-700 inline-flex items-center gap-2"><Copy size={15} /> Скопировать</button>
                )}
                {done && (
                  <button type="button" onClick={() => pushScreen('job-detail', { jobId: job.id, job })} className="h-10 px-4 rounded-md bg-zinc-800 text-zinc-100 hover:bg-zinc-700 inline-flex items-center gap-2"><FolderOpen size={15} /> Файлы</button>
                )}
                <button type="button" onClick={submit} disabled={!selected.size || busy} className="h-10 px-4 rounded-md bg-zinc-100 text-zinc-900 hover:bg-white disabled:bg-zinc-800 disabled:text-zinc-500 inline-flex items-center gap-2">
                  {done ? 'Расшифровать снова' : busy ? 'Подключаюсь…' : `Расшифровать${selected.size > 1 ? ` · ${selected.size}` : ''}`}
                </button>
              </div>
            )}
          </div>
        </>
      )}
      {error && <div className="border-t border-red-900/50 px-4 py-3 text-red-300 text-sm">{error}</div>}
      {flash && <div className="border-t border-zinc-800 px-4 py-2 text-emerald-400 text-sm">{flash}</div>}
    </div>
  )
})

function batchTitle(batch) {
  const current = batch.current
  if (!current) return 'Готовлю выбранные видео…'
  if (current.stage === 'downloading') return `Скачиваю аудио · ${current.i} из ${current.n}`
  if (current.stage === 'extracting') return `Собираю аудио · ${current.i} из ${current.n}`
  if (current.stage === 'transcribing') return `Расшифровываю · ${current.i} из ${current.n}`
  return `Читаю видео · ${current.i} из ${current.n}`
}

function batchDetails(job) {
  const current = job?.boosty_batch?.current
  if (!current) return 'Использую авторизацию Boosty из браузера'
  const parts = [current.title]
  if (current.total_bytes) parts.push(`${formatBytes(current.downloaded_bytes || 0)} из ${formatBytes(current.total_bytes)}`)
  else if (current.elapsed_sec) parts.push(`AssemblyAI · ${Math.round(current.elapsed_sec)} сек`)
  return parts.filter(Boolean).join(' · ')
}

function cleanError(value) {
  return String(value || 'Не удалось обработать Boosty')
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
}

function formatDate(value) {
  if (!value) return 'дата не указана'
  return new Date(Number(value) * 1000).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' })
}

function formatDuration(value) {
  const sec = Math.max(0, Math.round(Number(value || 0)))
  if (!sec) return '—'
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

function formatBytes(value) {
  const n = Number(value || 0)
  if (n < 1024) return `${n} Б`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} КБ`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} МБ`
  return `${(n / 1024 ** 3).toFixed(2)} ГБ`
}

export default BoostySingleForm
