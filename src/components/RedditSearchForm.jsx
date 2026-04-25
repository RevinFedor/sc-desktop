import React, {
  forwardRef, useImperativeHandle, useState, useRef,
} from 'react'
import { watchJob } from '../lib/jobs'
import { pushScreen } from '../lib/store'
import { refreshSources } from '../lib/sources'
import RedditBackendControl from './RedditBackendControl'

/**
 * Reddit search form: keyword (+ optional subreddit) → list of posts.
 * Запускается из PasteScreen (платформа = reddit, kind = url-unknown / username).
 *
 * Layout:
 *   query ┃ subreddit (optional) ┃ кнопка
 *   sort + time секторы
 */
const RedditSearchForm = forwardRef(function RedditSearchForm({ initialQuery, onStarted }, ref) {
  const [query, setQuery] = useState(initialQuery || '')
  const [subreddit, setSubreddit] = useState('')
  const [limit, setLimit] = useState(30)
  const [sort, setSort] = useState('relevance')   // relevance | top | new | hot | comments
  const [time, setTime] = useState('year')        // all | year | month | week | day | hour
  const [backend, setBackend] = useState('api')
  const [stage, setStage] = useState('idle')
  const [job, setJob] = useState(null)
  const [err, setErr] = useState(null)
  const navRef = useRef(false)

  useImperativeHandle(ref, () => ({
    async trigger() { await start() },
  }), [query, subreddit, limit, sort, time, backend, stage])

  async function start() {
    if (stage === 'running' || !query.trim()) return
    setStage('running'); setErr(null); setJob(null); navRef.current = false
    try {
      const sub = subreddit.trim()
        .replace(/^https?:\/\/(?:www\.)?reddit\.com\//i, '')
        .replace(/^\/?r\//i, '')
        .replace(/^\/+|\/+$/g, '')
      const id = await window.api.rdSearch({
        query: query.trim(),
        subreddit: sub || undefined,
        limit, sort, time, backend,
      })
      onStarted?.(id)
      const off = watchJob(id, (j) => {
        setJob(j)
        if (j.status === 'done' || j.status === 'error') {
          setStage(j.status)
          if (j.status === 'error') setErr(j.error || 'search failed')
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
      <div className="text-zinc-200 font-medium mb-4">Reddit · поиск постов</div>

      <div className="space-y-3 mb-4">
        <div>
          <label className="block text-xs text-zinc-500 mb-1">Запрос</label>
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="claude code research workflow"
            className="w-full h-9 px-3 rounded-md bg-zinc-900 border border-zinc-800 text-zinc-200 focus:border-zinc-600 focus:outline-none"
            disabled={stage === 'running'}
          />
        </div>

        <div className="flex items-center gap-3">
          <div className="flex-1">
            <label className="block text-xs text-zinc-500 mb-1">Subreddit (опц.)</label>
            <input
              type="text"
              value={subreddit}
              onChange={e => setSubreddit(e.target.value)}
              placeholder="webscraping"
              className="w-full h-9 px-3 rounded-md bg-zinc-900 border border-zinc-800 text-zinc-200 focus:border-zinc-600 focus:outline-none"
              disabled={stage === 'running'}
            />
          </div>
          <div className="w-24">
            <label className="block text-xs text-zinc-500 mb-1">Постов</label>
            <input
              type="number"
              min={5}
              max={250}
              value={limit}
              onChange={e => setLimit(Math.max(5, Math.min(250, parseInt(e.target.value || '0', 10) || 0)))}
              className="w-full h-9 px-3 rounded-md bg-zinc-900 border border-zinc-800 text-zinc-200 focus:border-zinc-600 focus:outline-none"
              disabled={stage === 'running'}
            />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex-1">
            <label className="block text-xs text-zinc-500 mb-1">Сортировка</label>
            <select
              value={sort}
              onChange={e => setSort(e.target.value)}
              className="w-full h-9 px-2 rounded-md bg-zinc-900 border border-zinc-800 text-zinc-200"
              disabled={stage === 'running'}
            >
              <option value="relevance">По релевантности</option>
              <option value="top">Топ</option>
              <option value="new">Новые</option>
              <option value="hot">Горячее</option>
              <option value="comments">Больше комментариев</option>
            </select>
          </div>
          <div className="flex-1">
            <label className="block text-xs text-zinc-500 mb-1">Период</label>
            <select
              value={time}
              onChange={e => setTime(e.target.value)}
              className="w-full h-9 px-2 rounded-md bg-zinc-900 border border-zinc-800 text-zinc-200"
              disabled={stage === 'running'}
            >
              <option value="all">Всё время</option>
              <option value="year">Год</option>
              <option value="month">Месяц</option>
              <option value="week">Неделя</option>
              <option value="day">День</option>
              <option value="hour">Час</option>
            </select>
          </div>
        </div>

        <RedditBackendControl
          value={backend}
          onChange={setBackend}
          disabled={stage === 'running'}
        />
      </div>

      <button
        onClick={start}
        disabled={stage === 'running' || !query.trim()}
        className="h-9 px-4 rounded-md bg-orange-600 hover:bg-orange-500 disabled:bg-zinc-800 disabled:text-zinc-500 text-white font-medium"
      >
        {stage === 'running' ? 'Ищем…' : 'Запустить поиск · Enter'}
      </button>

      {job && stage === 'running' && (
        <div className="mt-4 text-zinc-400 text-sm">
          Найдено постов: {job.items_done || 0}
        </div>
      )}
      {err && (
        <div className="mt-4 text-red-400 text-sm whitespace-pre-wrap">{err}</div>
      )}
    </div>
  )
})

export default RedditSearchForm
