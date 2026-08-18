import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from 'react'
import { ArrowRight, ListVideo, RotateCw, Square } from 'lucide-react'
import { lookupBoostyChannel, startBoostyChannelFetch, useJobs } from '../lib/jobs'
import { pushScreen } from '../lib/store'
import { refreshSources } from '../lib/sources'
import Avatar from './Avatar'

function handleFromUrl(value) {
  try { return new URL(value).pathname.split('/').filter(Boolean)[0] || '' } catch { return '' }
}

const BoostyChannelForm = forwardRef(function BoostyChannelForm({ url, onStarted }, ref) {
  const jobs = useJobs()
  const [source, setSource] = useState(null)
  const [jobId, setJobId] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const handle = handleFromUrl(url)
  const job = useMemo(() => jobs.find(item => item.id === jobId) || null, [jobs, jobId])
  const active = job?.status === 'running'

  useEffect(() => {
    let alive = true
    setJobId(null)
    setError(null)
    setSource(null)
    lookupBoostyChannel({ handle }).then(row => {
      if (alive && row) setSource(row)
    }).catch(() => {})
    return () => { alive = false }
  }, [url, handle])

  useEffect(() => {
    if (!job || job.status === 'running') return
    if (job.status === 'done') {
      refreshSources()
      if (job.source_id) lookupBoostyChannel({ handle }).then(setSource).catch(() => {})
    } else if (job.status === 'error') {
      setError(cleanError(job.error))
    }
  }, [job?.status])

  async function submit() {
    if (!url || active || busy) return
    setBusy(true)
    setError(null)
    try {
      const id = await startBoostyChannelFetch({ target: url, limit: 0, order: 'desc' })
      if (id == null) throw new Error('Boosty IPC недоступен')
      setJobId(id)
      onStarted?.(id)
    } catch (err) {
      setError(cleanError(err?.message || err))
    } finally {
      setBusy(false)
    }
  }

  useImperativeHandle(ref, () => ({ trigger: submit }))

  const progress = job?.boosty_channel || {}
  const loaded = Number(progress.loaded || job?.items_done || source?.items_count || 0)
  const total = Number(progress.remote_total || job?.items_total || 0)
  const percent = total > 0 ? Math.min(100, loaded * 100 / total) : null
  const done = job?.status === 'done'

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
      <div className="flex items-center gap-3">
        <Avatar source={source || { platform: 'boosty', handle }} size={34} />
        <div className="min-w-0 flex-1">
          <div className="text-zinc-100 truncate">{source?.display_name || progress.title || `@${handle}`}</div>
          <div className="text-zinc-500 truncate text-sm">@{source?.handle || progress.author_handle || handle}</div>
        </div>
        {(source || job?.source_id) && (
          <button
            type="button"
            onClick={() => pushScreen('source-detail', { sourceId: source?.id || job.source_id, platform: 'boosty' })}
            className="h-9 px-3 rounded-md border border-zinc-700 text-zinc-300 hover:bg-zinc-800 inline-flex items-center gap-2"
          >Открыть в библиотеке <ArrowRight size={15} /></button>
        )}
      </div>

      {active ? (
        <div className="mt-4 rounded-md border border-zinc-800 bg-zinc-900 px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="w-4 h-4 rounded-full border-2 border-zinc-600 border-t-zinc-100 animate-spin shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-zinc-200">Читаю каталог Boosty</div>
              <div className="text-zinc-500 text-sm mt-0.5">
                {loaded.toLocaleString('ru-RU')}{total ? ` из ${total.toLocaleString('ru-RU')}` : ''} постов
                {progress.oldest_at ? ` · дошёл до ${formatDate(progress.oldest_at)}` : ''}
              </div>
            </div>
            <button
              type="button"
              onClick={() => window.api?.cancelJob?.(job.id)}
              className="h-9 px-3 rounded-md border border-zinc-700 text-zinc-300 hover:bg-zinc-800 inline-flex items-center gap-2"
            ><Square size={14} /> Стоп</button>
          </div>
          <div className="mt-3 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
            <div className={`h-full bg-orange-500 ${percent == null ? 'w-1/3 animate-pulse' : ''}`} style={percent == null ? undefined : { width: `${percent}%` }} />
          </div>
        </div>
      ) : (
        <div className="mt-4 rounded-md border border-zinc-800 bg-zinc-900 px-4 py-3 flex items-center gap-4">
          <div className="flex-1 min-w-0">
            <div className="text-zinc-200">
              {done
                ? `Готово: ${Number(progress.posts_total || loaded).toLocaleString('ru-RU')} постов · ${Number(progress.videos_total || source?.boosty_videos_count || 0).toLocaleString('ru-RU')} видео`
                : source?.items_count
                  ? `В библиотеке уже ${Number(source.items_count).toLocaleString('ru-RU')} постов`
                  : 'Сохранить весь доступный каталог автора'}
            </div>
            <div className="text-zinc-500 text-sm mt-0.5">Без скачивания и транскрибации видео · обычно один API-запрос на 300 постов</div>
          </div>
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="h-10 px-4 rounded-md bg-zinc-100 text-zinc-900 hover:bg-white disabled:bg-zinc-800 disabled:text-zinc-500 inline-flex items-center gap-2 shrink-0"
          >{source?.items_count ? <RotateCw size={16} /> : <ListVideo size={16} />}{busy ? 'Подключаюсь…' : source?.items_count ? 'Обновить весь каталог' : 'Загрузить весь каталог'}</button>
        </div>
      )}
      {error && <div className="mt-3 text-red-300 text-sm break-words">{error}</div>}
    </div>
  )
})

function formatDate(ts) {
  return new Date(Number(ts) * 1000).toLocaleDateString('ru-RU')
}

function cleanError(value) {
  const text = String(value || '').replace(/^Error invoking remote method '[^']+':\s*/i, '').replace(/^Error:\s*/i, '')
  if (/не ответило|timeout/i.test(text)) return 'Расширение браузера не ответило. Откройте Boosty в браузере и повторите.'
  return text || 'Не удалось загрузить каталог Boosty'
}

export default BoostyChannelForm
