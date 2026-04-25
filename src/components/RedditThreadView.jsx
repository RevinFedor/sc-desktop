import React, { useEffect, useState, useMemo, useCallback } from 'react'
import { ChevronRight, ChevronDown } from 'lucide-react'
import { useInvalidator } from '../lib/dataBus'

/**
 * Reddit thread view — single post + tree of comments. Loads ALL items at once
 * (тред = ограниченный набор: до 500-1000 узлов). Дерево строится по
 * `parent_external_id` + `depth`. Свёрнутые ветки храним в Set по external_id.
 *
 * Layout:
 *   ┌─ Post header (title, author, score, body) ─────────┐
 *   │                                                     │
 *   │  ▾ comment (depth=1) ↑42 by user                    │
 *   │      body…                                          │
 *   │      ▾ reply (depth=2) ↑12 by other                 │
 *   │          body…                                      │
 *   │      ▸ reply (3 collapsed)                          │
 *   │  ▾ comment (depth=1) ↑21 by ...                     │
 *   └─────────────────────────────────────────────────────┘
 */
export default function RedditThreadView({ sourceId }) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [collapsed, setCollapsed] = useState(() => new Set())
  const itemsVer = useInvalidator(`items:${sourceId}`)

  useEffect(() => {
    let alive = true
    setLoading(true)
    ;(async () => {
      if (!window.api?.itemsList || !sourceId) { setItems([]); setLoading(false); return }
      try {
        // Тред редко больше 1000 узлов — берём всё одним запросом, сортировку делаем сами.
        const rows = await window.api.itemsList({
          source_id: sourceId,
          limit: 5000,
          offset: 0,
          order: 'created_at DESC',
        })
        if (alive) setItems(rows || [])
      } catch (err) {
        console.error('[RedditThreadView] load failed', err)
        if (alive) setItems([])
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [sourceId, itemsVer])

  // Build the tree: ordered list of items respecting parent→child grouping.
  // Sort top-level by score (likes) desc, replies by score desc, then iterate
  // depth-first so render is a flat list with `depth` for indentation.
  const ordered = useMemo(() => {
    if (!items.length) return []
    // index by external_id
    const byEid = new Map()
    for (const it of items) byEid.set(it.external_id, it)
    // children map: parent_external_id → [items]
    const children = new Map()
    let post = null
    for (const it of items) {
      if (it.depth === 0 || !it.parent_external_id) {
        if ((it.depth || 0) === 0 && it.type !== 'comment') post = it
        continue
      }
    }
    for (const it of items) {
      if (!it.parent_external_id) continue
      if (!children.has(it.parent_external_id)) children.set(it.parent_external_id, [])
      children.get(it.parent_external_id).push(it)
    }
    // sort each child list by likes desc
    for (const arr of children.values()) {
      arr.sort((a, b) => (b.likes || 0) - (a.likes || 0))
    }
    // DFS from post
    const out = []
    if (post) out.push({ ...post, _isPost: true })
    function visit(eid) {
      if (collapsed.has(eid)) return
      const kids = children.get(eid) || []
      for (const k of kids) {
        out.push(k)
        visit(k.external_id)
      }
    }
    if (post) visit(post.external_id)
    return out
  }, [items, collapsed])

  const toggleCollapse = useCallback((eid) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(eid)) next.delete(eid); else next.add(eid)
      return next
    })
  }, [])

  // Counts for each subtree (used to show "(N hidden)" on collapsed nodes)
  const subtreeCount = useMemo(() => {
    const map = new Map()
    const childrenMap = new Map()
    for (const it of items) {
      if (!it.parent_external_id) continue
      if (!childrenMap.has(it.parent_external_id)) childrenMap.set(it.parent_external_id, [])
      childrenMap.get(it.parent_external_id).push(it.external_id)
    }
    function count(eid) {
      if (map.has(eid)) return map.get(eid)
      const kids = childrenMap.get(eid) || []
      let n = 0
      for (const k of kids) n += 1 + count(k)
      map.set(eid, n)
      return n
    }
    for (const it of items) count(it.external_id)
    return map
  }, [items])

  if (loading) {
    return <div className="h-full flex items-center justify-center text-zinc-500">Загрузка треда…</div>
  }
  if (!items.length) {
    return <div className="h-full flex items-center justify-center text-zinc-500">Тред пуст</div>
  }

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-3xl mx-auto px-6 py-4">
        {ordered.map((it) => {
          if (it._isPost) {
            return <PostCard key={it.external_id} post={it} commentsTotal={items.filter(x => x.type === 'comment').length} />
          }
          const isCollapsed = collapsed.has(it.external_id)
          const hidden = isCollapsed ? subtreeCount.get(it.external_id) || 0 : 0
          return (
            <CommentRow
              key={it.external_id}
              comment={it}
              collapsed={isCollapsed}
              hiddenCount={hidden}
              onToggle={() => toggleCollapse(it.external_id)}
            />
          )
        })}
      </div>
    </div>
  )
}

// Тело OP сворачивается после этого порога — многокилобайтные посты не должны
// разворачиваться стеной текста над тредом (у комментариев collapse веток
// уже есть, у поста не было).
const POST_EXPAND_LIMIT = 800

function PostCard({ post, commentsTotal }) {
  const created = post.published_at ? new Date(post.published_at * 1000).toLocaleString('ru-RU') : ''
  const [expanded, setExpanded] = useState(false)
  const caption = post.caption || ''
  const isLong = caption.length > POST_EXPAND_LIMIT
  const body = isLong && !expanded ? caption.slice(0, POST_EXPAND_LIMIT) + '…' : caption
  return (
    <div className="border border-zinc-800 rounded-lg p-5 mb-4 bg-zinc-950">
      {post.title && (
        <h2 className="text-zinc-100 text-lg font-semibold mb-2 leading-tight">{post.title}</h2>
      )}
      <div className="flex items-center gap-3 text-xs text-zinc-500 mb-3">
        {post.sender && <span>u/{post.sender}</span>}
        <span>↑ {post.likes || 0}</span>
        <span>💬 {commentsTotal}</span>
        {created && <span>{created}</span>}
        {post.url && (
          <a href="#"
             onClick={(e) => { e.preventDefault(); window.api?.openExternal?.(post.url) }}
             className="text-zinc-500 hover:text-zinc-300 underline">открыть</a>
        )}
      </div>
      {caption && (
        <div className="text-zinc-300 text-sm whitespace-pre-wrap leading-relaxed">{body}</div>
      )}
      {isLong && (
        <button
          onClick={() => setExpanded(v => !v)}
          className="mt-2 inline-flex items-center gap-1 text-zinc-400 hover:text-zinc-200"
          style={{ fontSize: '13px' }}
        >
          {expanded ? <ChevronDown size={14} className="rotate-180" /> : <ChevronDown size={14} />}
          {expanded ? 'Свернуть' : 'Раскрыть'}
        </button>
      )}
    </div>
  )
}

function CommentRow({ comment, collapsed, hiddenCount, onToggle }) {
  const indent = Math.max(0, (comment.depth || 1) - 1)
  // bar colors cycle by depth so deep nesting still readable
  const barColors = ['border-orange-700', 'border-blue-700', 'border-emerald-700', 'border-purple-700', 'border-pink-700']
  const barColor = barColors[(comment.depth || 1) % barColors.length]
  const created = comment.published_at ? new Date(comment.published_at * 1000).toLocaleString('ru-RU') : ''
  return (
    <div
      className="text-sm py-2"
      style={{ paddingLeft: `${indent * 16}px` }}
    >
      <div className={`pl-3 border-l-2 ${barColor}`}>
        <div className="flex items-center gap-2 text-xs text-zinc-500 mb-1">
          <button
            onClick={onToggle}
            className="text-zinc-600 hover:text-zinc-300 w-4 flex items-center justify-center"
            title={collapsed ? 'Развернуть' : 'Свернуть'}
          >
            {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          </button>
          <span className="text-zinc-400">u/{comment.sender || '?'}</span>
          <span>↑ {comment.likes || 0}</span>
          {created && <span>· {created}</span>}
          {collapsed && hiddenCount > 0 && (
            <span className="text-zinc-600">({hiddenCount} скрыто)</span>
          )}
        </div>
        {!collapsed && comment.caption && (
          <div className="text-zinc-300 whitespace-pre-wrap leading-relaxed">{comment.caption}</div>
        )}
      </div>
    </div>
  )
}
