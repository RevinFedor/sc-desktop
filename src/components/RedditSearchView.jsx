import React, { useEffect, useState, useCallback } from 'react'
import { useInvalidator } from '../lib/dataBus'
import { watchJob } from '../lib/jobs'
import { pushScreen } from '../lib/store'
import { refreshSources } from '../lib/sources'

/**
 * Reddit search-source view — список постов из поиска. Каждая строка — пост
 * с заголовком, score, числом комментов, превью body. Клик → запускает
 * `rdThreadFetch` для этого URL и переходит на новый Thread-source.
 */
export default function RedditSearchView({ sourceId }) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [pendingUrl, setPendingUrl] = useState(null)  // URL поста, для которого сейчас тянем тред
  const itemsVer = useInvalidator(`items:${sourceId}`)

  useEffect(() => {
    let alive = true
    setLoading(true)
    ;(async () => {
      if (!window.api?.itemsList || !sourceId) { setItems([]); setLoading(false); return }
      try {
        const rows = await window.api.itemsList({
          source_id: sourceId,
          limit: 500,
          offset: 0,
          order: 'published_at DESC',
        })
        if (alive) setItems(rows || [])
      } catch (err) {
        console.error('[RedditSearchView] load failed', err)
        if (alive) setItems([])
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [sourceId, itemsVer])

  const onPostClick = useCallback(async (post) => {
    if (!post.url || pendingUrl) return
    setPendingUrl(post.url)
    try {
      const id = await window.api.rdThreadFetch({ url: post.url, maxComments: 200 })
      const off = watchJob(id, async (j) => {
        if (j.status === 'done' && j.source_id) {
          off()
          setPendingUrl(null)
          await refreshSources()
          pushScreen('source-detail', { sourceId: j.source_id })
        }
        if (j.status === 'error') {
          off()
          setPendingUrl(null)
          alert('Ошибка загрузки треда: ' + (j.error || 'unknown'))
        }
      })
    } catch (e) {
      setPendingUrl(null)
      alert('Не удалось запустить fetch: ' + (e?.message || e))
    }
  }, [pendingUrl])

  if (loading) {
    return <div className="h-full flex items-center justify-center text-zinc-500">Загрузка…</div>
  }
  if (!items.length) {
    return <div className="h-full flex items-center justify-center text-zinc-500">Постов не найдено</div>
  }

  // Sort by score desc для приоритезации топовых обсуждений
  const sorted = [...items].sort((a, b) => (b.likes || 0) - (a.likes || 0))

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-4xl mx-auto px-6 py-4">
        <div className="text-zinc-500 text-xs mb-3">
          Найдено постов: {items.length} · клик по строке загрузит дерево комментов отдельным источником
        </div>
        <div className="space-y-2">
          {sorted.map(p => {
            const sub = (() => {
              try { return JSON.parse(p.raw_meta_json || '{}').subreddit || null } catch { return null }
            })()
            const isPending = pendingUrl === p.url
            const created = p.published_at ? new Date(p.published_at * 1000).toLocaleDateString('ru-RU') : ''
            return (
              <button
                key={p.id}
                onClick={() => onPostClick(p)}
                disabled={isPending || !!pendingUrl}
                className={`w-full text-left rounded-md border border-zinc-800 bg-zinc-950 p-3 hover:border-zinc-700 hover:bg-zinc-900 disabled:opacity-50 disabled:cursor-wait`}
              >
                <div className="flex items-start gap-3">
                  <div className="flex flex-col items-center min-w-[3rem] text-zinc-400">
                    <span className="text-orange-500 font-medium">↑ {p.likes || 0}</span>
                    <span className="text-xs text-zinc-600">💬 {p.comments || 0}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-zinc-200 font-medium leading-snug">{p.title || '(без заголовка)'}</div>
                    <div className="text-xs text-zinc-500 mt-1 flex items-center gap-2">
                      {sub && <span className="text-orange-400">{sub}</span>}
                      {p.sender && <span>u/{p.sender}</span>}
                      {created && <span>{created}</span>}
                      {isPending && <span className="text-zinc-300 ml-auto">загружаем тред…</span>}
                    </div>
                    {p.caption && (
                      <div className="text-zinc-400 text-xs mt-2 line-clamp-3 whitespace-pre-wrap">
                        {p.caption.slice(0, 240)}{p.caption.length > 240 ? '…' : ''}
                      </div>
                    )}
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
