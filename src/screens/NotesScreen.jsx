import React, { useEffect, useRef, useState } from 'react'
import { StickyNote } from 'lucide-react'
import { useSources } from '../lib/sources'

/**
 * Per-source notes — plain textarea + Save button.
 * Stored in sources.meta_json.notes (no schema migration needed).
 */
export default function NotesScreen({ payload }) {
  const sourceId = payload?.sourceId
  const sources = useSources()
  const source = sources.find(s => s.id === sourceId)
  const [text, setText]       = useState('')
  const [loaded, setLoaded]   = useState(false)
  const [saving, setSaving]   = useState(false)
  const [savedAt, setSavedAt] = useState(null)
  const initialRef = useRef('')

  useEffect(() => {
    let alive = true
    if (!sourceId || !window.api) return
    window.api.sourceGetNotes(sourceId).then(notes => {
      if (!alive) return
      setText(notes || '')
      initialRef.current = notes || ''
      setLoaded(true)
    })
    return () => { alive = false }
  }, [sourceId])

  const dirty = loaded && text !== initialRef.current

  async function save() {
    if (!sourceId || !dirty) return
    setSaving(true)
    try {
      const r = await window.api.sourceSetNotes(sourceId, text)
      if (r.ok) {
        initialRef.current = text
        setSavedAt(Date.now())
      }
    } finally {
      setSaving(false)
    }
  }

  function onKeyDown(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault()
      save()
    }
  }

  const titleLabel = source
    ? (source.display_name && source.display_name !== source.handle ? source.display_name : '@' + source.handle)
    : 'Источник'

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 flex flex-col overflow-hidden px-8 py-6">
        <div className="mb-4 flex items-center gap-3">
          <span className="text-xl font-semibold text-zinc-100 inline-flex items-center gap-2"><StickyNote size={18} /> Заметки</span>
          <span className="text-zinc-700">·</span>
          <span className="text-zinc-400 truncate">{titleLabel}</span>
          <div className="ml-auto flex items-center gap-3">
            {dirty && <span className="text-amber-400" style={{ fontSize: '14px' }}>не сохранено</span>}
            {!dirty && savedAt && <span className="text-zinc-500" style={{ fontSize: '14px' }}>✓ сохранено</span>}
            <button
              onClick={save}
              disabled={!dirty || saving}
              className="px-4 py-1.5 rounded-md font-medium bg-zinc-100 text-zinc-900 hover:bg-white disabled:bg-zinc-800 disabled:text-zinc-500"
            >
              {saving ? 'Сохраняем…' : 'Сохранить'}
            </button>
          </div>
        </div>

        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Заметки по этому источнику…  Cmd/Ctrl+S для сохранения."
          disabled={!loaded || !sourceId}
          className="flex-1 min-h-0 w-full bg-zinc-950 border border-zinc-800 rounded-md px-4 py-3 text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 resize-none font-mono"
          style={{ fontSize: '14px', lineHeight: '1.6' }}
        />
      </div>
    </div>
  )
}
