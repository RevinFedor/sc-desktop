// Assembling saved items into a CLI-compatible text blob.
//
// Used by the "📋 Скопировать сохранённое" panel on Source Detail.
// Reads transcript files from disk for voice/video/audio items, splices
// them between text-only rows in chronological order, mirrors the format
// the CLI sc tool already produces so users can paste either output into
// the same downstream prompt without surprise.
//
// Output format (chat reading order):
//
//   --- DD.MM.YY HH:MM Sender ---
//   <body>
//   <blank line>
//
// For voice/video/audio: <body> is the transcript file's text.
// For text/photo/document: <body> is the caption.
//
// Forum chats: when the user picked "Все темы", we insert a one-line
// `## Тема: <title>` whenever the topic switches between consecutive items
// — drops noise on single-topic chats / non-forum chats.

const fs = require('node:fs')

const TYPE_TAG = {
  voice:    '🎤 Голос',
  video:    '🎬 Видео',
  audio:    '🎵 Аудио',
  photo:    '🖼 Фото',
  document: '📎 Doc',
  poll:     '📊 Опрос',
  text:     null,
}

function formatTs(unixSec) {
  if (!unixSec) return '—'
  const d = new Date(unixSec * 1000)
  const pad = n => String(n).padStart(2, '0')
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${String(d.getFullYear()).slice(-2)} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function _bodyFor(row) {
  if (row.type === 'voice' || row.type === 'video' || row.type === 'audio') {
    if (!row.transcript_path) return null
    try {
      return fs.readFileSync(row.transcript_path, 'utf8').trim()
    } catch (err) {
      return `[не удалось прочитать ${row.transcript_path}: ${err.code || err.message}]`
    }
  }
  // text / photo / document / poll — body is caption + optional reactions tail.
  const c = (row.caption || '').trim()
  const rx = _formatReactions(row.reactions)
  if (!c && !rx) return null
  if (!c) return rx        // unlikely but handle gracefully
  return rx ? `${c}\n${rx}` : c
}

// Compact one-line reaction line for the copy blob, e.g. "👍8 ❤️2 🔥1".
// Returns '' for null / empty / parse-error so callers can just concat.
function _formatReactions(raw) {
  if (raw == null) return ''
  let arr = raw
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw) } catch { return '' }
  }
  if (!Array.isArray(arr) || arr.length === 0) return ''
  const parts = []
  for (const r of arr) {
    if (!r) continue
    const e = String(r.e || '')
    const n = Number(r.n) || 0
    if (!e || !n) continue
    parts.push(e.startsWith('custom:') ? `🎴${n}` : `${e}${n}`)
  }
  return parts.length ? `[${parts.join(' ')}]` : ''
}

/**
 * Render a comment thread (flat-with-↳ format, one level of replies).
 * Same shape as YouTube comments output (fact-youtube-comments.md). Returns
 * a list of lines. Empty list if no comments — caller drops the separator.
 *
 * Ordering:
 *   – Top-level threads: NEWEST first (comment_id DESC). The user reads
 *     them like a chat feed — "what's new under this post" is the answer
 *     they want first. Telethon's iter_messages without reverse already
 *     gives DESC, but we sort explicitly so callers from other code paths
 *     (DB read, comments_only catch-up) don't flip the order.
 *   – Replies INSIDE a thread: oldest first (chain order). Flipping a
 *     dialogue to descending breaks readability — "ответ → реплика → ответ"
 *     only makes sense top-down chronologically. So `walk()` keeps natural
 *     order.
 */
function _formatComments(comments) {
  if (!comments || !comments.length) return []
  // Group: top-level (parent_comment_id null) plus a children-by-parent map.
  const childrenOf = new Map()
  const tops = []
  for (const c of comments) {
    if (c.parent_comment_id == null) tops.push(c)
    else {
      const k = c.parent_comment_id
      if (!childrenOf.has(k)) childrenOf.set(k, [])
      childrenOf.get(k).push(c)
    }
  }
  // Newest top-level first. Numeric desc on comment_id matches DESC on date
  // for a single chat (Telegram ids monotonically increase with time).
  tops.sort((a, b) => Number(b.comment_id) - Number(a.comment_id))
  // Replies stay in id-asc order so the dialogue reads top-down.
  for (const arr of childrenOf.values()) {
    arr.sort((a, b) => Number(a.comment_id) - Number(b.comment_id))
  }
  // Some replies in the array might point to a parent that's also a reply
  // (deeper than 1 level). Walk up to find the top-level ancestor so they
  // attach to the visible thread root.
  function findRoot(cid) {
    const byId = new Map(comments.map(c => [c.comment_id, c]))
    let cur = byId.get(cid)
    while (cur && cur.parent_comment_id != null) {
      const next = byId.get(cur.parent_comment_id)
      if (!next) break
      cur = next
    }
    return cur ? cur.comment_id : cid
  }
  // Re-bucket replies whose parent isn't in tops directly.
  const lines = []
  for (const top of tops) {
    const author = top.sender || '(аноним)'
    lines.push(`@${author}`)
    if (top.text) lines.push(top.text)
    // Direct children + descendants attached to this top.
    const descendants = []
    function walk(parentId) {
      const kids = childrenOf.get(parentId) || []
      for (const k of kids) {
        descendants.push(k)
        walk(k.comment_id)
      }
    }
    walk(top.comment_id)
    for (const r of descendants) {
      const ra = r.sender || '(аноним)'
      lines.push(`  ↳ @${ra}`)
      if (r.text) {
        for (const ln of r.text.split('\n')) lines.push(`    ${ln}`)
      }
    }
    lines.push('')
  }
  // Replies whose parent never appeared as a top-level (orphan replies — rare,
  // happens when a reply chain crosses the limit). Hoist them to top-level.
  const seen = new Set()
  for (const t of tops) seen.add(t.comment_id)
  for (const arr of childrenOf.values()) {
    for (const r of arr) {
      if (seen.has(r.comment_id)) continue
      // If its parent isn't seen either, hoist as top-level.
      if (!seen.has(r.parent_comment_id)) {
        const author = r.sender || '(аноним)'
        lines.push(`@${author}`)
        if (r.text) lines.push(r.text)
        lines.push('')
      }
    }
  }
  return lines
}

/**
 * @param {Array}  rows               — output of assemblyFetch (filtered + sorted)
 * @param {object} opts
 * @param {bool}   opts.showTopicHeaders
 * @param {Map<string, Array>} opts.commentsByPostId  — { external_id → [comment, …] }
 * @param {Map<number, {handle, title}>} opts.chatLabelBySourceId
 *        — for folder mode: render `# Чат: <title>` between blocks of
 *        different source_ids. Items are pre-sorted by source_id, then by
 *        published_at, so the boundary is just "did the source_id change".
 * @returns string  ready for clipboard / disk
 */
function assembleText(rows, opts = {}) {
  const showTopicHeaders = !!opts.showTopicHeaders
  const commentsByPostId = opts.commentsByPostId || null
  const chatLabelBySourceId = opts.chatLabelBySourceId || null
  const out = []
  let lastTopicId = null
  let lastSourceId = null

  for (const row of rows) {
    const body = _bodyFor(row)
    if (!body) continue

    if (chatLabelBySourceId && row.source_id !== lastSourceId) {
      const meta = chatLabelBySourceId.get(row.source_id) || {}
      const label = meta.title || (meta.handle ? `@${meta.handle}` : `source#${row.source_id}`)
      // Blank line BEFORE the chat header (except at the very top) so blocks
      // visually separate when pasted into a chat-style downstream prompt.
      if (out.length) out.push('')
      out.push(`# Чат: ${label}`, '')
      lastSourceId = row.source_id
      // Reset topic tracking on chat boundary — topics are per-chat.
      lastTopicId = null
    }

    if (showTopicHeaders) {
      const tid = row.topic_id ?? null
      if (tid !== lastTopicId) {
        const title = row.topic_title || (tid ? `#${tid}` : 'Без темы')
        out.push(`## Тема: ${title}`, '')
        lastTopicId = tid
      }
    }

    const tag = TYPE_TAG[row.type]
    const label = [
      formatTs(row.published_at),
      row.sender || '?',
      tag ? `[${tag}]` : null,
    ].filter(Boolean).join(' ')

    out.push(`--- ${label} ---`, body, '')

    if (commentsByPostId) {
      const cmts = commentsByPostId.get(`${row.source_id}:${String(row.external_id)}`)
        || commentsByPostId.get(String(row.external_id))
        || []
      if (cmts.length > 0) {
        out.push(`--- комментарии (${cmts.length}) ---`)
        for (const ln of _formatComments(cmts)) out.push(ln)
      }
    }
  }
  return out.join('\n')
}

// Render a comment thread on its own (no surrounding message). Used by the
// single-message comments-side-fetch sidecar — the Python script emits raw
// comment rows on `comments` events, job-runner buffers them and flushes
// them through here on close. Same flat-with-↳ format as the inline path.
function formatCommentsBlock(comments) {
  return _formatComments(comments).join('\n')
}

module.exports = { assembleText, formatCommentsBlock }
