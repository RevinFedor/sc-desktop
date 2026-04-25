import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useSources } from '../lib/sources'
import { goHome, pushScreen, setPasteState } from '../lib/store'
import Avatar from './Avatar'
import PlatformLogo from './PlatformLogo'

// ─── Layout-aware search (RU↔EN cross-typing) ────────────────────────────
// Same trick gt-editor does: lets you type "ghekjd" expecting "пулков" or
// "ghbdtn" expecting "привет" without switching keyboard layout. Cheap and
// nice when most sources have RU display_name but you're typing in EN.
const RU_TO_EN = {
  'й':'q','ц':'w','у':'e','к':'r','е':'t','н':'y','г':'u','ш':'i','щ':'o','з':'p','х':'[','ъ':']',
  'ф':'a','ы':'s','в':'d','а':'f','п':'g','р':'h','о':'j','л':'k','д':'l','ж':';','э':"'",
  'я':'z','ч':'x','с':'c','м':'v','и':'b','т':'n','ь':'m','б':',','ю':'.',
}
const EN_TO_RU = Object.fromEntries(Object.entries(RU_TO_EN).map(([k, v]) => [v, k]))
function layoutVariants(text) {
  const lower = text.toLowerCase()
  const toEn = lower.split('').map(c => RU_TO_EN[c] || c).join('')
  const toRu = lower.split('').map(c => EN_TO_RU[c] || c).join('')
  return [lower, toEn, toRu]
}

const PLATFORM_LABEL = {
  telegram:  'Telegram',
  youtube:   'YouTube',
  instagram: 'Instagram',
  tiktok:    'TikTok',
}

const TG_DIALOG_SEARCH_MIN = 2
const TG_DIALOG_SEARCH_LIMIT = 12

/**
 * Quick-Open modal (Cmd+P) — fuzzy search over Library sources, Enter opens.
 * No history stored (caller's choice — same as VS Code's quickopen has no
 * "recent" pin; the user types every time).
 *
 * Tricky parts (replicated from gt-editor's QuickOpen, see fact-navigation
 * + fix-ui-stability there):
 *   1. Phantom-hover block: when the modal opens with the cursor already
 *      sitting over a row, the browser doesn't fire pointerenter for it —
 *      but the next mousemove anywhere would. We block onMouseEnter until
 *      the first real mousemove + then resync selection to whatever is
 *      under the cursor at *that* moment, so keyboard nav stays priority.
 *   2. Selected index resets to 0 on every query change (relevance sorting
 *      makes the top item always the best match).
 *   3. List scrolls to selectedIndex on each ↑/↓.
 */
export default function QuickOpen({ open, onClose }) {
  const sources = useSources()
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [tgDialogs, setTgDialogs] = useState([])
  const [tgSearching, setTgSearching] = useState(false)
  const [tgSearchError, setTgSearchError] = useState(null)

  const inputRef = useRef(null)
  const listRef = useRef(null)
  const mouseBlocked = useRef(false)

  // Reset query + selection on every open.
  useEffect(() => {
    if (!open) return
    setQuery('')
    setSelectedIndex(0)
    mouseBlocked.current = true
    // setTimeout matches gt-editor — gives the overlay one paint to mount
    // before stealing focus, otherwise the global keydown listener that
    // opened us can re-fire on the input mount frame.
    const t = setTimeout(() => inputRef.current?.focus(), 30)
    return () => clearTimeout(t)
  }, [open])

  // Phantom-hover unblock: first real mousemove releases the gate AND
  // re-syncs selection to whatever's under the cursor right now. Same
  // pattern as gt-editor's modalMouseBlocked + elementFromPoint trick.
  useEffect(() => {
    if (!open) return
    function unblock(e) {
      mouseBlocked.current = false
      const el = document.elementFromPoint(e.clientX, e.clientY)
      if (!el) return
      const item = el.closest('[data-quickopen-index]')
      if (item) {
        const idx = Number(item.getAttribute('data-quickopen-index'))
        if (Number.isFinite(idx)) setSelectedIndex(idx)
      }
    }
    window.addEventListener('mousemove', unblock, { once: true })
    return () => window.removeEventListener('mousemove', unblock)
  }, [open])

  // Telegram dialog search walks Telethon dialogs, so it is lazy and debounced.
  // Library results stay local and instant; Telegram-only rows append once the
  // subprocess returns.
  useEffect(() => {
    if (!open) return
    const q = query.trim()
    setTgSearchError(null)
    if (q.length < TG_DIALOG_SEARCH_MIN || !window.api?.tgSearchDialogs) {
      setTgDialogs([])
      setTgSearching(false)
      return
    }
    let alive = true
    const t = setTimeout(async () => {
      setTgSearching(true)
      try {
        const res = await window.api.tgSearchDialogs({ query: q, limit: TG_DIALOG_SEARCH_LIMIT })
        if (!alive) return
        setTgDialogs(Array.isArray(res?.matches) ? res.matches : [])
        setTgSearchError(res?.error || null)
      } catch (err) {
        if (!alive) return
        setTgDialogs([])
        setTgSearchError(String(err && err.message || err))
      } finally {
        if (alive) setTgSearching(false)
      }
    }, 450)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [open, query])

  // Filter + rank. Match by display_name, handle, and platform label.
  // Sources with a query hit at the start of any field rank above ones
  // that hit only in the middle.
  const results = useMemo(() => {
    if (!query.trim()) return sources.slice(0, 30).map(s => ({ kind: 'source', source: s, score: 0 }))
    const variants = layoutVariants(query.trim())
    const scored = []
    for (const s of sources) {
      const bestScore = scoreSource(s, variants)
      if (bestScore !== Infinity) scored.push({ s, score: bestScore })
    }
    const out = scored.map(x => ({ kind: 'source', source: x.s, score: x.score }))
    for (const d of tgDialogs) {
      if (sourceMatchesDialog(sources, d)) continue
      const score = scoreDialog(d, variants)
      if (score === Infinity) continue
      out.push({ kind: 'tg-dialog', dialog: d, score: score + 4 })
    }
    out.sort((a, b) => a.score - b.score || resultWeight(b) - resultWeight(a))
    return out.slice(0, 30)
  }, [sources, query, tgDialogs])

  // Reset highlight whenever the result list changes shape.
  useEffect(() => { setSelectedIndex(0) }, [query])

  // Keep selection visible when navigating off-screen with arrows.
  useEffect(() => {
    if (!open || !listRef.current) return
    const node = listRef.current.querySelector(`[data-quickopen-index="${selectedIndex}"]`)
    if (node) node.scrollIntoView({ block: 'nearest' })
  }, [open, selectedIndex])

  function chooseSource(s) {
    if (!s) return
    onClose()
    pushScreen('source-detail', { sourceId: s.id })
  }

  function chooseTelegramDialog(dialog) {
    if (!dialog) return
    const target = dialog.username ? `@${dialog.username}` : (dialog.title || String(dialog.chat_id || ''))
    if (!target) return
    setPasteState({
      value: target,
      committed: {
        platform: 'telegram',
        kind: dialog.username ? 'username' : 'title',
      },
    })
    onClose()
    goHome()
  }

  function chooseResult(result) {
    if (!result) return
    if (result.kind === 'tg-dialog') {
      chooseTelegramDialog(result.dialog)
    } else {
      chooseSource(result.source)
    }
  }

  function onKey(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex(i => Math.min(i + 1, Math.max(results.length - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      chooseResult(results[selectedIndex])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  if (!open) return null

  return (
    // no-drag: backdrop накрывает и зону titlebar (drag-region геометрический,
    // оверлей его не отменяет) — без класса клик в верхние 40px таскал окно
    // вместо закрытия модалки.
    <div
      className="no-drag fixed inset-0 z-[1100] flex justify-center pt-20 bg-black/50"
      onMouseDown={onClose}
    >
      <div
        className="w-[560px] max-h-[440px] flex flex-col rounded-lg bg-zinc-950 border border-zinc-800 shadow-2xl"
        onMouseDown={e => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={onKey}
          placeholder="Поиск источников по имени, handle, платформе…"
          className="px-4 py-3 bg-transparent border-b border-zinc-800 text-zinc-200 placeholder-zinc-600 focus:outline-none"
          style={{ fontSize: '14px' }}
        />

        <div ref={listRef} className="flex-1 overflow-auto">
          {results.length === 0 ? (
            <div className="px-4 py-6 text-center text-zinc-600 italic" style={{ fontSize: '14px' }}>
              {tgSearching
                ? 'Ищу в Library и Telegram…'
                : sources.length === 0 ? 'Нет источников. Вставьте ссылку или @ник.' : 'Ничего не найдено'}
            </div>
          ) : (
            results.map((result, idx) => (
              <Row
                key={resultKey(result)}
                result={result}
                selected={idx === selectedIndex}
                blockedRef={mouseBlocked}
                onHover={() => setSelectedIndex(idx)}
                onChoose={() => chooseResult(result)}
                index={idx}
              />
            ))
          )}
          {query.trim().length >= TG_DIALOG_SEARCH_MIN && (tgSearching || tgSearchError) && (
            <div className="px-4 py-2 border-t border-zinc-900 flex items-center gap-2 text-xs text-zinc-500">
              {tgSearching && (
                <span className="inline-block w-3 h-3 rounded-full border-2 border-zinc-700 border-t-zinc-300 animate-spin" />
              )}
              <span className="truncate">
                {tgSearching
                  ? 'дополнительно ищу чаты в Telegram…'
                  : tgSearchError === 'no_session'
                    ? 'Telegram-сессия не выбрана'
                    : `Telegram: ${tgSearchError}`}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Row({ result, selected, blockedRef, onHover, onChoose, index }) {
  if (result.kind === 'tg-dialog') {
    return (
      <TelegramDialogRow
        dialog={result.dialog}
        selected={selected}
        blockedRef={blockedRef}
        onHover={onHover}
        onChoose={onChoose}
        index={index}
      />
    )
  }
  return (
    <SourceRow
      source={result.source}
      selected={selected}
      blockedRef={blockedRef}
      onHover={onHover}
      onChoose={onChoose}
      index={index}
    />
  )
}

function SourceRow({ source, selected, blockedRef, onHover, onChoose, index }) {
  const label = source.display_name && source.display_name !== source.handle
    ? source.display_name
    : `@${source.handle}`
  const sub = `${PLATFORM_LABEL[source.platform] || source.platform} · @${source.handle}`
  const unparsed = source.platform === 'telegram' && (source.items_count || 0) === 0
  return (
    <div
      data-quickopen-index={index}
      onMouseDown={(e) => { e.preventDefault(); onChoose() }}
      onMouseEnter={() => { if (!blockedRef.current) onHover() }}
      className={`px-3 py-2 flex items-center gap-3 cursor-pointer ${
        selected ? 'bg-zinc-800' : 'hover:bg-zinc-900/60'
      }`}
    >
      <Avatar source={source} size={22} />
      <div className="min-w-0 flex-1">
        <div className="text-zinc-200 truncate" style={{ fontSize: '14px' }}>
          {label}
        </div>
        <div className="text-zinc-500 truncate flex items-center gap-1.5"
             style={{ fontSize: '12px' }}>
          <PlatformLogo platform={source.platform} size={10} />
          <span>{sub}</span>
        </div>
      </div>
      {unparsed ? (
        <span className={`shrink-0 rounded px-1.5 py-0.5 border ${
          selected
            ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
            : 'border-amber-500/20 bg-amber-500/5 text-amber-300'
        }`} style={{ fontSize: '11px' }}>
          не спаршен
        </span>
      ) : (
        <span className={`shrink-0 tabular-nums ${selected ? 'text-zinc-300' : 'text-zinc-600'}`}
              style={{ fontSize: '12px' }}>
          {source.items_count || 0}
        </span>
      )}
    </div>
  )
}

function TelegramDialogRow({ dialog, selected, blockedRef, onHover, onChoose, index }) {
  const sub = [
    'Telegram',
    telegramKindLabel(dialog.kind),
    'не спаршен',
    dialog.username ? '@' + dialog.username : null,
    dialog.members != null ? `${Number(dialog.members).toLocaleString('ru-RU')} участников` : null,
    dialog.last_message_at ? `последнее: ${formatDialogDate(dialog.last_message_at)}` : null,
  ].filter(Boolean).join(' · ')
  return (
    <div
      data-quickopen-index={index}
      onMouseDown={(e) => { e.preventDefault(); onChoose() }}
      onMouseEnter={() => { if (!blockedRef.current) onHover() }}
      className={`px-3 py-2 flex items-center gap-3 cursor-pointer ${
        selected ? 'bg-zinc-800' : 'hover:bg-zinc-900/60'
      }`}
    >
      <div className="w-[22px] h-[22px] rounded-full bg-sky-500/10 border border-sky-500/20 flex items-center justify-center shrink-0">
        <PlatformLogo platform="telegram" size={13} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-zinc-200 truncate" style={{ fontSize: '14px' }}>
          {dialog.title || ('id ' + dialog.chat_id)}
        </div>
        <div className="text-zinc-500 truncate flex items-center gap-1.5"
             style={{ fontSize: '12px' }}>
          <PlatformLogo platform="telegram" size={10} />
          <span>{sub}</span>
        </div>
      </div>
      <span className={`shrink-0 rounded px-1.5 py-0.5 border ${
        selected
          ? 'border-sky-500/40 bg-sky-500/10 text-sky-200'
          : 'border-sky-500/20 bg-sky-500/5 text-sky-300'
      }`} style={{ fontSize: '11px' }}>
        TG only
      </span>
    </div>
  )
}

function scoreSource(s, variants) {
  const name = (s.display_name || '').toLowerCase()
  const handle = (s.handle || '').toLowerCase()
  const platform = (PLATFORM_LABEL[s.platform] || s.platform).toLowerCase()
  return scoreFields([
    [name, 0, 10],
    [handle, 1, 20],
    [platform, 100, 100],
  ], variants)
}

function scoreDialog(d, variants) {
  const title = (d.title || '').toLowerCase()
  const username = (d.username || '').toLowerCase()
  return scoreFields([
    [title, 0, 10],
    [username, 1, 20],
  ], variants)
}

function scoreFields(fields, variants) {
  let bestScore = Infinity
  for (const v of variants) {
    if (!v) continue
    for (const [field, prefixScore, infixBase] of fields) {
      if (!field) continue
      const idx = field.indexOf(v)
      if (idx === 0) bestScore = Math.min(bestScore, prefixScore)
      else if (idx > 0) bestScore = Math.min(bestScore, infixBase + idx)
    }
  }
  return bestScore
}

function sourceMatchesDialog(sources, dialog) {
  const chatId = dialog?.chat_id != null ? String(dialog.chat_id) : ''
  const username = (dialog?.username || '').toLowerCase()
  const title = (dialog?.title || '').trim().toLowerCase()
  return sources.some(s => {
    if (s.platform !== 'telegram') return false
    if (chatId && String(s.external_id || '') === chatId) return true
    if (username && String(s.handle || '').replace(/^@/, '').toLowerCase() === username) return true
    return title && String(s.display_name || '').trim().toLowerCase() === title
  })
}

function resultWeight(result) {
  if (result.kind === 'tg-dialog') return 0
  return result.source?.items_count || 0
}

function resultKey(result) {
  if (result.kind === 'tg-dialog') {
    const d = result.dialog
    return `tg-dialog:${d.chat_id || d.username || d.title}`
  }
  return `source:${result.source.id}`
}

function telegramKindLabel(kind) {
  if (kind === 'user') return 'личный чат'
  if (kind === 'channel') return 'канал'
  if (kind === 'group' || kind === 'chat') return 'чат'
  if (kind === 'bot') return 'бот'
  return kind || 'диалог'
}

function formatDialogDate(value) {
  const d = new Date(value)
  if (!Number.isFinite(d.getTime())) return null
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' })
}
