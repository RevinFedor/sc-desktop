import React, {
  forwardRef, useEffect, useImperativeHandle, useState, useRef,
} from 'react'
import { watchJob } from '../lib/jobs'
import { pushScreen } from '../lib/store'
import { refreshSources } from '../lib/sources'
import RedditBackendControl from './RedditBackendControl'

/**
 * Reddit thread form. Один URL поста → пост + дерево комментов.
 * Layout (single column):
 *   ┌─ заголовок «Тред» + URL ────────────────────────┐
 *   │  поле: количество комментов (default 200)        │
 *   │  кнопка: «Спарсить тред» (Enter)                 │
 *   └──────────────────────────────────────────────────┘
 */
const RedditThreadForm = forwardRef(function RedditThreadForm({ url, onStarted }, ref) {
  const [maxComments, setMaxComments] = useState(200)
  const [backend, setBackend] = useState('api')
  const [stage, setStage] = useState('idle')   // idle | running | done | error
  const [job, setJob] = useState(null)
  const [err, setErr] = useState(null)
  const navRef = useRef(false)

  useEffect(() => {
    let alive = true
    window.api?.appSettingsGet?.().then(settings => {
      const value = settings?.reddit?.backend
      if (alive && ['api', 'auto', 'apify'].includes(value)) setBackend(value)
    }).catch(() => {})
    return () => { alive = false }
  }, [])

  useImperativeHandle(ref, () => ({
    async trigger() { await start() },
  }), [maxComments, backend, stage, url])

  async function start() {
    if (stage === 'running' || !url) return
    setStage('running'); setErr(null); setJob(null); navRef.current = false
    try {
      const id = await window.api.rdThreadFetch({ url, maxComments, backend })
      onStarted?.(id)
      const off = watchJob(id, (j) => {
        setJob(j)
        if ((j.status === 'done' || j.status === 'error')) {
          setStage(j.status)
          if (j.status === 'error') setErr(j.error || 'fetch failed')
          off()
          if (j.status === 'done' && j.source_id && !navRef.current) {
            navRef.current = true
            refreshSources().finally(() => pushScreen('source-detail', { sourceId: j.source_id }))
          }
        }
      })
    } catch (e) {
      setStage('error')
      setErr(e?.message || String(e))
    }
  }

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-6">
      <div className="text-zinc-200 font-medium mb-1">Reddit тред</div>
      <div className="text-zinc-500 text-sm mb-4 truncate">{url}</div>

      <div className="flex items-center gap-3 mb-4">
        <label className="text-zinc-400 text-sm">Комментариев:</label>
        <input
          type="number"
          min={10}
          max={1000}
          step={10}
          value={maxComments}
          onChange={e => setMaxComments(Math.max(10, Math.min(1000, parseInt(e.target.value || '0', 10) || 0)))}
          className="w-24 h-8 px-2 rounded-md bg-zinc-900 border border-zinc-800 text-zinc-200 focus:border-zinc-600 focus:outline-none"
          disabled={stage === 'running'}
        />
        <span className="text-xs text-zinc-500">включая вложенные (BFS, depth до 10)</span>
      </div>

      <div className="mb-4">
        <RedditBackendControl
          value={backend}
          onChange={setBackend}
          disabled={stage === 'running'}
        />
      </div>

      <button
        onClick={start}
        disabled={stage === 'running'}
        className="h-9 px-4 rounded-md bg-orange-600 hover:bg-orange-500 disabled:bg-zinc-800 disabled:text-zinc-500 text-white font-medium"
      >
        {stage === 'running' ? 'Парсим…' : 'Спарсить тред · Enter'}
      </button>

      {job && stage === 'running' && (
        <div className="mt-4 text-zinc-400 text-sm">
          Загружено: {job.items_done || 0}
          {job.entity_title && <span className="text-zinc-500"> · {job.entity_title}</span>}
        </div>
      )}
      {err && (
        <div className="mt-4 text-red-400 text-sm whitespace-pre-wrap">{err}</div>
      )}
    </div>
  )
})

export default RedditThreadForm
