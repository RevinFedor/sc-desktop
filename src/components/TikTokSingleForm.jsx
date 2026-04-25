import React, { useEffect, useImperativeHandle, useState, forwardRef } from 'react'
import {
  startTiktokSingle, lookupTiktokCache, copyCachedTiktokFile,
  watchJob,
} from '../lib/jobs'

// Extract numeric video id from a TikTok URL (or short link).
function extractTiktokId(url) {
  if (!url) return null
  const m = url.match(/tiktok\.com\/@[\w.-]+\/video\/(\d+)/i)
  if (m) return m[1]
  return null
}

const ENGINES = [
  { id: 'gemini',     label: 'Gemini 2.5 Flash' },
  { id: 'assemblyai', label: 'AssemblyAI' },
]

function formatBytes(n) {
  if (n == null) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/**
 * Inline TikTok single-video form. Flow:
 *   - mount → check cache → if hit, copy + show "from cache"
 *   - else: idle, "Транскрибировать" button (engine select)
 *   - click → spawn tk_single_ndjson → show progress → auto-copy on save
 *
 * Unlike YouTube there's no subs/AI fork — every video goes through Gemini.
 */
const TikTokSingleForm = forwardRef(function TikTokSingleForm({ url, onStarted }, ref) {
  // Stages: 'idle' | 'cache-hit' | 'starting' | 'running' | 'done' | 'error'
  const [stage, setStage] = useState('idle')
  const [job, setJob] = useState(null)
  const [cache, setCache] = useState(null)
  const [engine, setEngine] = useState('gemini')
  const [err, setErr] = useState(null)
  const [toast, setToast] = useState(null)

  // For TikTok we can't extract video_id from short URLs without resolving them
  // first (Python side does that). Cache-lookup needs the numeric id, so for
  // short URLs we just skip cache and let the script run.
  useEffect(() => {
    if (!url) return
    let alive = true
    setStage('idle'); setErr(null); setJob(null); setCache(null); setToast(null)

    const vid = extractTiktokId(url)
    if (!vid) return

    ;(async () => {
      const c = await lookupTiktokCache(vid)
      if (!alive) return
      if (c) {
        setCache(c)
        setStage('cache-hit')
        const r = await copyCachedTiktokFile(c.file_path)
        if (alive && r.ok) setToast(`Скопировано из кэша · ${formatBytes(r.bytes)}`)
      }
    })()

    return () => { alive = false }
  }, [url])

  async function kickOff() {
    if (!url) return
    setStage('starting'); setErr(null)
    const id = await startTiktokSingle({ url, engine })
    if (id == null) { setErr('IPC недоступен'); setStage('error'); return }
    onStarted && onStarted(id)
    const off = watchJob(id, snap => {
      setJob(snap)
      if (snap.status === 'running') setStage('running')
      if (snap.status === 'done') {
        setStage('done')
        if (snap.tk?.copied_bytes) {
          setToast(`Готово · ${formatBytes(snap.tk.copied_bytes)} скопировано`)
        }
        off()
      }
      if (snap.status === 'error' || snap.status === 'cancelled') {
        setErr(snap.error || snap.status)
        setStage('error')
        off()
      }
    })
  }

  useImperativeHandle(ref, () => ({
    trigger() {
      if (stage === 'idle' || stage === 'error') return kickOff()
    },
  }), [stage, url, engine])

  if (stage === 'cache-hit' && cache) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-950 px-6 py-5">
        <div className="flex items-center gap-3">
          <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
          <span className="text-zinc-200 font-medium">Из кэша</span>
          {cache.parameters?.title && (
            <span className="text-zinc-400 truncate" style={{ fontSize: '14px' }}>
              · {cache.parameters.title}
            </span>
          )}
        </div>
        {toast && <div className="text-zinc-500 mt-2" style={{ fontSize: '14px' }}>{toast}</div>}
      </div>
    )
  }

  if (stage === 'running' || stage === 'starting') {
    const tk = job?.tk || {}
    const stageMap = {
      fetching_meta: 'Получение метаданных…',
      downloading:   'Скачиваем аудио…',
      downloaded:    'Скачано, готовим к транскрипции…',
      transcribing:  'Транскрибируем…',
      transcribed:   'Готово, сохраняем…',
    }
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-950 px-6 py-5">
        <div className="flex items-center gap-3 mb-2">
          <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <span className="text-zinc-200 font-medium">
            {stageMap[tk.stage] || 'Запускаем…'}
          </span>
        </div>
        {tk.title && (
          <div className="text-zinc-400 truncate" style={{ fontSize: '14px' }}>
            {tk.title}
          </div>
        )}
        {tk.duration_sec > 0 && (
          <div className="text-zinc-500 mt-1 tabular-nums" style={{ fontSize: '14px' }}>
            {tk.duration_sec}с · {tk.channel || ''}
          </div>
        )}
      </div>
    )
  }

  if (stage === 'done') {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-950 px-6 py-5">
        <div className="flex items-center gap-3">
          <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
          <span className="text-zinc-200 font-medium">Готово</span>
          {job?.tk?.cost_usd ? (
            <span className="text-zinc-500 tabular-nums" style={{ fontSize: '14px' }}>
              · ${job.tk.cost_usd.toFixed(4)}
            </span>
          ) : null}
        </div>
        {toast && <div className="text-zinc-500 mt-2" style={{ fontSize: '14px' }}>{toast}</div>}
      </div>
    )
  }

  if (stage === 'error') {
    return (
      <div className="rounded-lg border border-zinc-800 bg-red-950/20 border-red-900/50 px-6 py-5 text-red-400">
        {err || 'Ошибка'}
        <button
          onClick={kickOff}
          className="ml-3 px-2 py-1 rounded text-xs bg-red-900/40 hover:bg-red-900/60"
        >Повторить</button>
      </div>
    )
  }

  // Idle — show controls
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 px-6 py-5">
      <div className="text-zinc-400 mb-3" style={{ fontSize: '14px' }}>
        Транскрипция через AI (на TikTok нет субтитров)
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-zinc-500" style={{ fontSize: '14px' }}>Движок</span>
          <select
            value={engine}
            onChange={e => setEngine(e.target.value)}
            className="bg-zinc-900 border border-zinc-700 rounded-md px-2 py-1 text-zinc-200 focus:outline-none focus:border-zinc-500"
            style={{ fontSize: '14px' }}
          >
            {ENGINES.map(en => <option key={en.id} value={en.id}>{en.label}</option>)}
          </select>
        </div>
        <button
          onClick={kickOff}
          className="ml-auto px-4 py-2 rounded-md font-medium bg-zinc-100 text-zinc-900 hover:bg-white"
        >Транскрибировать</button>
      </div>
    </div>
  )
})

export default TikTokSingleForm
