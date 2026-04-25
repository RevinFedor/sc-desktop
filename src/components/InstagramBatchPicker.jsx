import React, { useEffect, useMemo, useState } from 'react'
import Checkbox from './Checkbox'

/**
 * Batch picker for Instagram reels inside a profile source.
 *
 * Loads reel-type items from the items table, lets the user pick a subset
 * and either transcribe (Apify→audio→Gemini) or copy a combined transcript
 * blob if all selected are already done. Mirrors the YouTubeBatchPicker
 * pattern but trimmed: no language/withTs (audio-only), no chip input
 * (reels are addressed by shortcode that already lives in `external_id`).
 *
 * Items in DB are stored with `reel:<shortcode>` external_id; we strip the
 * prefix to send pure shortcodes to the Python script (see
 * ig_batch_transcribe_ndjson.py).
 */
export default function InstagramBatchPicker({ sourceId }) {
  const [items, setItems] = useState([])
  const [loaded, setLoaded] = useState(false)
  const [selected, setSelected] = useState(() => new Set())
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState(null)

  async function reload() {
    if (!sourceId || !window.api) return
    setLoaded(false)
    const rows = await window.api.itemsList({
      source_id: sourceId, limit: 500, offset: 0,
      order: 'published_at DESC',
    })
    // Show only reels in the picker — posts without video can't be transcribed.
    setItems(rows.filter(r => String(r.external_id || '').startsWith('reel:')))
    setLoaded(true)
  }

  useEffect(() => {
    let alive = true
    reload().catch(() => { if (alive) setLoaded(true) })
    if (!window.api?.onJobUpdate) return
    const off = window.api.onJobUpdate(j => {
      if (!alive) return
      // Refresh transcript_path after each batch save (job emits often;
      // gate by status to avoid hammering DB).
      // Refresh on either:
      //  - ig_batch_transcribe (transcript_path appears as reels save), or
      //  - ig_profile_fetch finishing for *this* source (new reels arrive
      //    in the items table → picker should pick them up).
      const refreshable =
        (j.type === 'ig_batch_transcribe' && (j.status === 'running' || j.status === 'done')) ||
        (j.type === 'ig_profile_fetch' && j.source_id === sourceId && (j.status === 'done' || j.status === 'running'))
      if (refreshable) reload()
    })
    return () => { alive = false; off && off() }
  }, [sourceId])

  const transcribedSet = useMemo(() => {
    const s = new Set()
    for (const it of items) if (it.transcript_path) s.add(it.external_id)
    return s
  }, [items])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return items
    return items.filter(it => (it.caption || '').toLowerCase().includes(q))
  }, [items, search])

  const selectionIds = Array.from(selected)
  const selectionCount = selectionIds.length
  const allTranscribed = selectionCount > 0 &&
    selectionIds.every(id => transcribedSet.has(id))
  const newTranscribeCount = selectionIds.filter(id => !transcribedSet.has(id)).length

  function toggle(id) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  function selectAll() {
    setSelected(new Set(filtered.map(it => it.external_id)))
  }

  function clearAll() {
    setSelected(new Set())
  }

  function shortcodesFromIds(ids) {
    return ids.map(id => id.replace(/^reel:/, ''))
  }

  function captionsFor(ids) {
    const byId = new Map(items.map(it => [it.external_id, it]))
    return ids.map(id => (byId.get(id)?.caption || '').replace(/\|\|\|/g, ' '))
  }

  async function transcribeSelected() {
    if (newTranscribeCount === 0 || busy) return
    setBusy(true)
    setToast(null)
    try {
      const ids = selectionIds.filter(id => !transcribedSet.has(id))
      await window.api.igBatchTranscribe({
        source_id:  sourceId,
        shortcodes: shortcodesFromIds(ids),
        captions:   captionsFor(ids),
        engine:     'gemini',
      })
      setToast({ kind: 'started', count: ids.length })
    } catch (e) {
      setToast({ kind: 'error', message: String(e?.message || e) })
    } finally { setBusy(false) }
  }

  async function copySelected() {
    if (selectionCount === 0 || busy) return
    setBusy(true)
    try {
      const r = await window.api.igAssembleBatch({
        source_id:  sourceId,
        shortcodes: shortcodesFromIds(selectionIds),
        action:     'copy',
      })
      if (r.ok) setToast({ kind: 'copied', count: r.count, bytes: r.bytes })
      else      setToast({ kind: 'error', message: r.error || 'copy failed' })
    } finally {
      setBusy(false)
      setTimeout(() => setToast(null), 2500)
    }
  }

  if (!loaded) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 text-zinc-500 italic">
        Загрузка reels…
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 text-zinc-500">
        В этом источнике пока нет reels. Спарси профиль через Library → Instagram.
      </div>
    )
  }

  // Smart-button content & action.
  let primaryLabel, primaryAction
  if (toast?.kind === 'copied') {
    primaryLabel = `Скопировано · ${toast.count} · ${formatBytes(toast.bytes)}`
    primaryAction = null
  } else if (toast?.kind === 'started') {
    primaryLabel = `Запущено · ${toast.count}`
    primaryAction = null
  } else if (selectionCount === 0) {
    primaryLabel = 'Выбери reels'
    primaryAction = null
  } else if (allTranscribed) {
    primaryLabel = `Скопировать (${selectionCount})`
    primaryAction = copySelected
  } else {
    primaryLabel = `Транскрибировать (${newTranscribeCount})`
    primaryAction = transcribeSelected
  }

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950">
      <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-3">
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Поиск по подписи…"
          className="flex-1 bg-zinc-900 border border-zinc-800 rounded-md px-3 py-1.5 focus:outline-none focus:border-zinc-600"
          style={{ fontSize: '14px' }}
        />
        <button
          onClick={selectAll}
          className="text-zinc-400 hover:text-zinc-100"
          style={{ fontSize: '14px' }}
        >Все</button>
        <button
          onClick={clearAll}
          className="text-zinc-500 hover:text-zinc-200"
          style={{ fontSize: '14px' }}
        >Сбросить</button>
      </div>

      <div className="max-h-96 overflow-auto divide-y divide-zinc-900">
        {filtered.map(it => (
          <ReelRow
            key={it.external_id}
            item={it}
            checked={selected.has(it.external_id)}
            transcribed={transcribedSet.has(it.external_id)}
            onToggle={() => toggle(it.external_id)}
          />
        ))}
        {filtered.length === 0 && (
          <div className="px-4 py-3 text-zinc-500 italic" style={{ fontSize: '14px' }}>
            Ничего не найдено
          </div>
        )}
      </div>

      <div className="px-4 py-3 border-t border-zinc-800 flex items-center gap-3">
        <div className="text-zinc-500" style={{ fontSize: '14px' }}>
          выбрано {selectionCount} из {filtered.length}
          {transcribedSet.size > 0 && (
            <span className="text-zinc-600"> · уже транскрибировано {transcribedSet.size}</span>
          )}
          {/* itemsList капится limit:500 — у профиля с 500+ reels хвост
              не попадает в picker, «выбрать все» выберет не всё. */}
          {items.length >= 500 && (
            <span className="text-amber-400/80 ml-2" title="Показаны первые 500 reels из БД">
              · показаны первые 500
            </span>
          )}
        </div>
        <button
          onClick={primaryAction}
          disabled={!primaryAction || busy}
          className="ml-auto px-4 py-2 rounded-md font-medium bg-zinc-100 text-zinc-900 hover:bg-white disabled:bg-zinc-800 disabled:text-zinc-500"
          style={{ minWidth: '210px' }}
        >
          {busy ? '…' : primaryLabel}
        </button>
      </div>

      {toast?.kind === 'error' && (
        <div className="mx-4 mb-3 px-3 py-2 rounded bg-red-950/40 border border-red-900/60 text-red-300" style={{ fontSize: '14px' }}>
          {toast.message}
        </div>
      )}
    </div>
  )
}

function ReelRow({ item, checked, transcribed, onToggle }) {
  const cap = (item.caption || '').trim()
  const dur = fmtDuration(item.duration_seconds)
  const views = formatNum(item.views)
  const date = fmtDate(item.published_at)

  return (
    <label className="px-4 py-2 flex items-center gap-3 cursor-pointer hover:bg-zinc-900">
      <Checkbox checked={checked} onChange={onToggle} />
      <span
        className="text-zinc-500 shrink-0 tabular-nums w-20 whitespace-nowrap"
        style={{ fontSize: '14px' }}
      >{date || '—'}</span>
      <span className="flex-1 truncate text-zinc-200" style={{ fontSize: '14px' }} title={cap}>
        {cap || <span className="text-zinc-600 italic">без подписи</span>}
      </span>
      {transcribed && (
        <span className="text-emerald-400 shrink-0" style={{ fontSize: '13px' }}>✓</span>
      )}
      <span className="text-zinc-500 shrink-0 tabular-nums w-12 text-right" style={{ fontSize: '13px' }}>{dur || '—'}</span>
      <span className="text-zinc-500 shrink-0 tabular-nums w-12 text-right" style={{ fontSize: '13px' }}>{views || '—'}</span>
    </label>
  )
}

function fmtDuration(secs) {
  if (!secs) return null
  secs = Math.round(secs)
  const m = Math.floor(secs / 60)
  const s = secs % 60
  if (m > 0) return `${m}:${String(s).padStart(2, '0')}`
  return `${s}с`
}

// Same convention as YouTubeBatchPicker — Instagram timestamps from
// Apify/Android are precise, but we render month-precision for visual
// parity with YT (where dates *are* approximate). Keeps rows tidy.
function fmtDate(ts) {
  if (!ts) return null
  const d = new Date(ts * 1000)
  if (isNaN(d.getTime())) return null
  return d.toLocaleDateString('ru-RU', { month: 'short', year: '2-digit' }).replace('.', '')
}

function formatNum(n) {
  if (!n) return ''
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}K`
  return String(n)
}

function formatBytes(n) {
  if (n == null) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
