import React, { useMemo, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import Checkbox from './Checkbox'

/**
 * Collapsed-by-default list of senders for a chat/group source.
 *
 * Header (always visible):
 *   ОТПРАВИТЕЛИ · 23     ▾
 * Click → expand:
 *   [search ............]   [✓ выбрать все]
 *   ☐ Валерия              45
 *   ☐ Николай              30
 *   …
 *
 * Selection is local state for now. The picker UI is wired up so a future
 * "filter messages by sender" can read `selected` directly without touching
 * this component again.
 */
export default function SendersBlock({ senders }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(() => new Set())

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return senders
    return senders.filter(r => (r.sender || '').toLowerCase().includes(q))
  }, [senders, query])

  const total = senders.length
  const allOn = filtered.length > 0 && filtered.every(r => selected.has(keyOf(r)))
  const someOn = !allOn && filtered.some(r => selected.has(keyOf(r)))

  function toggle(row, next) {
    setSelected(prev => {
      const ns = new Set(prev)
      if (next) ns.add(keyOf(row)); else ns.delete(keyOf(row))
      return ns
    })
  }
  function toggleAllVisible(next) {
    setSelected(prev => {
      const ns = new Set(prev)
      for (const r of filtered) {
        if (next) ns.add(keyOf(r)); else ns.delete(keyOf(r))
      }
      return ns
    })
  }
  function clearAll() {
    setSelected(new Set())
  }

  return (
    <div className="mb-8">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 text-xs uppercase tracking-wider text-zinc-500 hover:text-zinc-300 mb-3"
      >
        <span>Отправители · {total}{total === 10 ? '+' : ''}</span>
        {selected.size > 0 && (
          <span className="text-zinc-400 normal-case tracking-normal">
            · выбрано {selected.size}
          </span>
        )}
        <span className="ml-auto text-zinc-600">{open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</span>
      </button>

      {open && (
        <>
          <div className="flex items-center gap-2 mb-2">
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Поиск по отправителям…"
              className="flex-1 bg-zinc-900 border border-zinc-800 rounded-md px-3 py-1.5 placeholder-zinc-600 focus:outline-none focus:border-zinc-600"
            />
            <Checkbox
              checked={allOn}
              indeterminate={someOn}
              onChange={(next) => toggleAllVisible(next)}
              size="sm"
              label={allOn ? 'снять все' : 'выбрать все'}
            />
            {selected.size > 0 && (
              <button
                onClick={clearAll}
                className="text-zinc-500 hover:text-zinc-200"
                style={{ fontSize: '14px' }}
              >Сбросить</button>
            )}
          </div>

          <div className="rounded-md border border-zinc-800 bg-zinc-950 divide-y divide-zinc-800 max-h-64 overflow-auto">
            {filtered.length === 0 && (
              <div className="px-4 py-3 text-zinc-600 italic">Ничего не найдено</div>
            )}
            {filtered.map(r => {
              const k = keyOf(r)
              const isOn = selected.has(k)
              return (
                <label
                  key={k}
                  className="px-4 py-2 flex items-center gap-3 cursor-pointer hover:bg-zinc-900"
                >
                  <Checkbox
                    checked={isOn}
                    onChange={(next) => toggle(r, next)}
                    size="sm"
                  />
                  <span className="text-zinc-300 truncate flex-1">{r.sender || '(unknown)'}</span>
                  <span className="text-zinc-500 tabular-nums shrink-0">{r.count.toLocaleString()}</span>
                </label>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

function keyOf(r) {
  return r.sender == null ? '__unknown__' : r.sender
}
