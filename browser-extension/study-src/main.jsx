import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  BookOpen,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock3,
  CloudOff,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Trash2,
  Volume2,
  Wifi,
  X,
} from 'lucide-react'
import '../learning-store.js'
import '../study-model.js'
import './study.css'

const store = window.__scLearningStore
const StudyModel = window.__scStudyModel

function readYoutubePreferences() {
  if (typeof chrome === 'undefined' || !chrome.storage?.sync) {
    return Promise.resolve({ learning_ai_explanation: true, learning_card_autoplay: false })
  }
  return new Promise((resolve) => {
    chrome.storage.sync.get({ __yt: { learning_ai_explanation: true, learning_card_autoplay: false } }, (raw) => {
      const settings = raw?.__yt && typeof raw.__yt === 'object' ? raw.__yt : {}
      resolve({
        learning_ai_explanation: settings.learning_ai_explanation !== false,
        learning_card_autoplay: settings.learning_card_autoplay === true,
      })
    })
  })
}

function patchYoutubePreferences(patch) {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
    return Promise.resolve({ online: false, settings: patch })
  }
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'sc-youtube-settings-patch', patch }, (response) => {
      const error = chrome.runtime.lastError
      if (error) { reject(new Error(error.message)); return }
      if (!response?.ok) { reject(new Error(response?.error || 'Не удалось сохранить настройку')); return }
      resolve(response)
    })
  })
}

function speakLearningText(text) {
  const value = String(text || '').trim()
  if (!value || typeof speechSynthesis === 'undefined') return false
  try {
    speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(value)
    utterance.lang = 'en-US'
    speechSynthesis.speak(utterance)
    return true
  } catch {
    return false
  }
}

function stateLabel(state) {
  if (state === 'known') return 'Знаю'
  if (state === 'saved') return 'В словаре'
  return 'Без отметки'
}

function formatDue(value) {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return 'новая'
  if (timestamp <= Date.now()) return 'сейчас'
  const minutes = Math.ceil((timestamp - Date.now()) / 60_000)
  if (minutes < 60) return `через ${minutes} мин`
  const hours = Math.ceil(minutes / 60)
  if (hours < 24) return `через ${hours} ч`
  return `через ${Math.ceil(hours / 24)} дн`
}

function StateButton({ active, tone, icon: Icon, children, onClick, disabled }) {
  return (
    <button
      type="button"
      className={`state-button ${tone} ${active ? 'active' : ''}`}
      aria-pressed={active}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon size={17} />
      {children}
    </button>
  )
}

function SyncBadge({ stats, syncing, onSync }) {
  const online = stats?.sync?.online === true
  return (
    <button type="button" className={`sync-badge ${online ? 'online' : 'offline'}`} onClick={onSync} disabled={syncing}>
      {syncing ? <RefreshCw size={16} className="spin" /> : online ? <Wifi size={16} /> : <CloudOff size={16} />}
      <span>{syncing ? 'Синхронизация…' : online ? 'Синхронизировано' : 'Офлайн — изменения сохранены'}</span>
      {stats?.pending > 0 && <strong>{stats.pending}</strong>}
    </button>
  )
}

function AddEntry({ onChanged }) {
  const [open, setOpen] = useState(false)
  const [term, setTerm] = useState('')
  const [translation, setTranslation] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (event) => {
    event.preventDefault()
    if (!term.trim() || busy) return
    setBusy(true)
    try {
      await store.setState({
        kind: term.trim().includes(' ') ? 'phrase' : 'word',
        state: 'saved',
        toggle: false,
        sourceLang: 'en',
        targetLang: 'ru',
        sourceText: term,
        normalizedText: store.normalizeTerm(term),
        translation,
        translationSource: translation ? 'manual' : '',
        contexts: [],
      })
      setTerm('')
      setTranslation('')
      setOpen(false)
      await onChanged({ sync: true })
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return <button type="button" className="primary-button" onClick={() => setOpen(true)}><Plus size={18} />Добавить</button>
  }
  return (
    <form className="add-form" onSubmit={submit}>
      <input autoFocus value={term} onChange={(event) => setTerm(event.target.value)} placeholder="Слово или фраза" />
      <input value={translation} onChange={(event) => setTranslation(event.target.value)} placeholder="Перевод (можно позже)" />
      <button type="submit" className="primary-button" disabled={!term.trim() || busy}><Check size={18} />Сохранить</button>
      <button type="button" className="icon-button" aria-label="Отмена" onClick={() => setOpen(false)}><X size={18} /></button>
    </form>
  )
}

function ConflictBox({ entry, onResolve }) {
  if (!entry.conflict) return null
  return (
    <div className="conflict-box">
      <div><strong>Перевод изменён в двух местах</strong><span>Выберите, какой оставить.</span></div>
      <div className="conflict-values">
        <button type="button" onClick={() => onResolve(entry.key, 'local')}><small>Этот браузер</small>{entry.conflict.localValue || 'пусто'}</button>
        <button type="button" onClick={() => onResolve(entry.key, 'remote')}><small>Общая база</small>{entry.conflict.remoteValue || 'пусто'}</button>
      </div>
    </div>
  )
}

function EntryRow({ entry, onState, onTranslation, onResolve }) {
  const [editing, setEditing] = useState(false)
  const [translation, setTranslation] = useState(entry.translation || '')
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const totalAttempts = Number(entry.reviewCount || 0) + Number(entry.practiceCount || 0)

  useEffect(() => setTranslation(entry.translation || ''), [entry.translation])

  const saveTranslation = async () => {
    setBusy(true)
    try {
      await onTranslation(entry.key, translation)
      setEditing(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <article className={`entry-row state-${entry.state}`} data-entry-key={entry.key}>
      <div className="entry-main">
        <div className="entry-copy">
          <div className="entry-term-line">
            <h3>{entry.sourceText}</h3>
            <span className={`state-dot ${entry.state}`}>{stateLabel(entry.state)}</span>
            {entry.kind === 'phrase' && <span className="kind-pill">фраза</span>}
          </div>
          {editing ? (
            <div className="translation-editor">
              <input value={translation} onChange={(event) => setTranslation(event.target.value)} onKeyDown={(event) => {
                if (event.key === 'Enter') saveTranslation()
                if (event.key === 'Escape') setEditing(false)
              }} />
              <button type="button" className="icon-button success" onClick={saveTranslation} disabled={busy}><Check size={17} /></button>
              <button type="button" className="icon-button" onClick={() => setEditing(false)}><X size={17} /></button>
            </div>
          ) : (
            <button type="button" className={`translation-value ${entry.translation ? '' : 'empty'}`} onClick={() => setEditing(true)}>
              <span>{entry.translation || 'Добавить перевод'}</span><Pencil size={14} />
            </button>
          )}
          <div className="entry-meta">
            <span><Clock3 size={13} />{totalAttempts ? `${totalAttempts} повторений` : 'новая карточка'}</span>
            {entry.state === 'saved' && <span>следующая: {formatDue(entry.dueAt)}</span>}
            {entry.dirty && <span className="pending-label">ждёт синхронизации</span>}
          </div>
        </div>
        <div className="entry-actions">
          <StateButton active={entry.state === 'known'} tone="known" icon={CheckCircle2} onClick={() => onState(entry, 'known')}>Знаю</StateButton>
          <StateButton active={entry.state === 'saved'} tone="saved" icon={BookOpen} onClick={() => onState(entry, 'saved')}>В словарь</StateButton>
          {!!entry.contexts?.length && (
            <button type="button" className="icon-button" aria-label="Показать примеры" onClick={() => setExpanded((value) => !value)}>
              {expanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
            </button>
          )}
        </div>
      </div>
      <ConflictBox entry={entry} onResolve={onResolve} />
      {expanded && (
        <div className="contexts">
          {entry.contexts.slice(0, 8).map((context) => (
            <div className="context-row" key={context.id}>
              <div>{context.sourceText}</div>
              {context.translation && <span>{context.translation}</span>}
              {context.videoUrl && <a href={`${context.videoUrl}${context.startMs >= 0 ? `&t=${Math.floor(context.startMs / 1000)}s` : ''}`} target="_blank" rel="noreferrer">Открыть видео</a>}
            </div>
          ))}
        </div>
      )}
    </article>
  )
}

function DictionaryView({ entries, refresh }) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('en-US')
    return entries.filter((entry) => entry.state !== 'none')
      .filter((entry) => filter === 'all' || entry.state === filter)
      .filter((entry) => !needle
        || entry.sourceText.toLocaleLowerCase('en-US').includes(needle)
        || entry.translation.toLocaleLowerCase('en-US').includes(needle))
  }, [entries, filter, query])

  const setState = async (entry, state) => {
    await store.setState({ ...entry, state, toggle: true })
    await refresh({ sync: true })
  }
  const editTranslation = async (key, translation) => {
    await store.editTranslation({ key, translation })
    await refresh({ sync: true })
  }
  const resolve = async (key, choice) => {
    await store.resolveConflict({ key, choice })
    await refresh({ sync: choice === 'local' })
  }

  return (
    <section className="workspace" aria-label="Словарь">
      <div className="toolbar">
        <label className="search-box"><Search size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Найти слово или перевод" /></label>
        <div className="filters" role="group" aria-label="Фильтр словаря">
          {[['all', 'Все'], ['saved', 'В словаре'], ['known', 'Знаю']].map(([value, label]) => (
            <button type="button" key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>
          ))}
        </div>
        <AddEntry onChanged={refresh} />
      </div>
      <div className="entry-list">
        {visible.map((entry) => <EntryRow key={entry.key} entry={entry} onState={setState} onTranslation={editTranslation} onResolve={resolve} />)}
        {!visible.length && <div className="empty-state"><BookOpen size={38} /><h2>Здесь пока пусто</h2><p>Добавьте слово вручную или нажмите «В словарь» в субтитрах YouTube.</p></div>}
      </div>
    </section>
  )
}

function DeckView({ entries, refresh }) {
  const savedEntries = useMemo(() => entries.filter((entry) => entry.state === 'saved'), [entries])
  const entriesByKey = useMemo(() => new Map(savedEntries.map((entry) => [entry.key, entry])), [savedEntries])
  const initialRound = useMemo(() => StudyModel.buildRound(savedEntries, {}), [])
  const [queue, setQueue] = useState(initialRound)
  const [round, setRound] = useState(1)
  const [roundTotal, setRoundTotal] = useState(initialRound.length)
  const [sessionStats, setSessionStats] = useState({})
  const [revealed, setRevealed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dragX, setDragX] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [exiting, setExiting] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [autoplay, setAutoplay] = useState(false)
  const [lastAction, setLastAction] = useState(null)
  const lastKeyRef = useRef('')
  const dragRef = useRef({ pointerId: null, startX: 0, deltaX: 0 })
  const savedSignature = savedEntries.map((entry) => entry.key).sort().join('\u0000')
  const current = entriesByKey.get(queue[0]) || null
  const currentPosition = current ? Math.max(1, roundTotal - queue.length + 1) : 0
  const currentMode = current ? StudyModel.reviewMode(current) : 'practice'

  useEffect(() => {
    const activeKeys = new Set(savedEntries.map((entry) => entry.key))
    setQueue((previous) => {
      const kept = previous.filter((key) => activeKeys.has(key))
      const queued = new Set(kept)
      const missing = savedEntries.filter((entry) => !queued.has(entry.key)).map((entry) => entry.key)
      if (kept.length || missing.length) {
        const next = [...kept, ...missing]
        if (!previous.length) setRoundTotal(next.length)
        return next
      }
      const next = StudyModel.buildRound(savedEntries, sessionStats, lastKeyRef.current)
      setRoundTotal(next.length)
      return next
    })
  }, [savedSignature])

  useEffect(() => {
    setRevealed(false)
    setDragX(0)
    setDragging(false)
    setExiting('')
    setMenuOpen(false)
  }, [current?.key])

  useEffect(() => {
    let active = true
    readYoutubePreferences().then((preferences) => {
      if (active) setAutoplay(preferences.learning_card_autoplay === true)
    }).catch(() => {})
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (autoplay && current?.sourceText) speakLearningText(current.sourceText)
  }, [autoplay, current?.key])

  useEffect(() => {
    if (!menuOpen) return undefined
    const close = (event) => {
      if (!event.target?.closest?.('.study-card-menu-shell')) setMenuOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [menuOpen])

  const review = useCallback(async (result, { animate = true } = {}) => {
    if (!current || busy) return
    setBusy(true)
    const snapshot = {
      queue: [...queue],
      round,
      roundTotal,
      sessionStats: { ...sessionStats },
      lastKey: lastKeyRef.current,
      entryBefore: current,
    }
    if (animate) {
      setDragging(false)
      setDragX(0)
      setExiting(result)
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    try {
      const mode = StudyModel.reviewMode(current)
      const reviewResult = await store.queueReview({ key: current.key, result, mode })
      setLastAction({
        type: 'review',
        snapshot,
        operation: reviewResult?.operation,
        entryBefore: reviewResult?.entryBefore || current,
      })
      const nextStats = StudyModel.nextSessionStats(sessionStats, current.key, result)
      const remaining = queue.slice(1).filter((key) => entriesByKey.has(key))
      lastKeyRef.current = current.key
      setSessionStats(nextStats)
      if (remaining.length) {
        setQueue(remaining)
      } else {
        const updatedEntries = savedEntries.map((entry) => entry.key === current.key
          ? (reviewResult?.entry || entry)
          : entry)
        const nextRound = StudyModel.buildRound(updatedEntries, nextStats, current.key)
        setRound((value) => value + 1)
        setRoundTotal(nextRound.length)
        setQueue(nextRound)
      }
      setRevealed(false)
      setDragX(0)
      setDragging(false)
      setExiting('')
      refresh({ sync: false }).catch(() => {})
      store.sync({}).catch(() => {})
    } finally {
      setBusy(false)
      setDragX(0)
      setDragging(false)
      setExiting('')
    }
  }, [busy, current, entriesByKey, queue, refresh, round, roundTotal, savedEntries, sessionStats])

  useEffect(() => {
    const onKeyDown = (event) => {
      const target = event.target
      if (target?.closest?.('input, textarea, select, [contenteditable="true"]')) return
      if (event.key === 'Enter' && !revealed && current) {
        event.preventDefault()
        if (!event.repeat) setRevealed(true)
        return
      }
      if (busy || event.repeat || !current) return
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        review('forgotten')
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        review('remembered')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, current, revealed, review])

  const onPointerDown = (event) => {
    if (busy || event.button !== 0) return
    if (event.target.closest('[data-selectable-text], button, a, input, textarea, select')) return
    const selection = window.getSelection?.()
    if (selection && !selection.isCollapsed) return
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, deltaX: 0 }
    try { event.currentTarget.setPointerCapture?.(event.pointerId) } catch {}
    setDragging(true)
    setExiting('')
  }

  const onPointerMove = (event) => {
    if (!dragging || dragRef.current.pointerId !== event.pointerId) return
    const delta = Math.max(-360, Math.min(360, event.clientX - dragRef.current.startX))
    dragRef.current.deltaX = delta
    setDragX(delta)
  }

  const finishPointer = (event, cancelled = false) => {
    if (dragRef.current.pointerId !== event.pointerId) return
    try { event.currentTarget.releasePointerCapture?.(event.pointerId) } catch {}
    const result = cancelled ? null : StudyModel.swipeResult(dragRef.current.deltaX)
    dragRef.current = { pointerId: null, startX: 0, deltaX: 0 }
    setDragging(false)
    if (result) review(result)
    else setDragX(0)
  }

  const restoreDeckSnapshot = (snapshot) => {
    setQueue(snapshot.queue)
    setRound(snapshot.round)
    setRoundTotal(snapshot.roundTotal)
    setSessionStats(snapshot.sessionStats)
    lastKeyRef.current = snapshot.lastKey
    setRevealed(false)
    setDragX(0)
    setDragging(false)
    setExiting('')
  }

  const undoLastAction = async () => {
    if (!lastAction || busy) return
    setBusy(true)
    try {
      if (lastAction.type === 'review') {
        await store.undoReview({
          key: lastAction.entryBefore.key,
          entryBefore: lastAction.entryBefore,
          operation: lastAction.operation,
        })
      } else if (lastAction.type === 'delete') {
        await store.setState({ ...lastAction.entryBefore, state: 'saved', toggle: false })
      }
      restoreDeckSnapshot(lastAction.snapshot)
      setLastAction(null)
      await refresh({ sync: false })
      store.sync({}).catch(() => {})
    } finally {
      setBusy(false)
    }
  }

  const removeCurrent = async () => {
    if (!current || busy) return
    const snapshot = {
      queue: [...queue],
      round,
      roundTotal,
      sessionStats: { ...sessionStats },
      lastKey: lastKeyRef.current,
      entryBefore: current,
    }
    setBusy(true)
    setMenuOpen(false)
    try {
      await store.setState({ ...current, state: 'none', toggle: false })
      setLastAction({ type: 'delete', snapshot, entryBefore: current })
      setQueue((previous) => previous.filter((key) => key !== current.key))
      await refresh({ sync: false })
      store.sync({}).catch(() => {})
    } finally {
      setBusy(false)
    }
  }

  if (!savedEntries.length) {
    return (
      <section className="deck workspace">
        <div className="deck-empty"><BookOpen size={58} /><h2>Добавьте карточки</h2><p>Сохраните слова из YouTube или добавьте их вручную в словаре.</p></div>
      </section>
    )
  }

  if (!current) return <section className="deck workspace"><div className="page-loader"><RefreshCw className="spin" /></div></section>

  const dragProgress = Math.min(1, Math.abs(dragX) / 110)
  const exitX = exiting === 'remembered' ? 28 : exiting === 'forgotten' ? -28 : 0
  const transform = exiting
    ? `translate3d(${exitX}px,0,0)`
    : `translate3d(${dragX}px,0,0) rotate(${dragX / 90}deg)`
  const practiceHint = currentMode === 'scheduled' ? 'обновит интервал' : 'тренировочный ответ'

  return (
    <section className="deck workspace" aria-label="Карточки">
      <div className="deck-progress">
        <span>Круг {round}</span>
        <div className="deck-progress-actions">
          <strong>Карточка {currentPosition} из {roundTotal}</strong>
          <button type="button" className="undo-button" onClick={undoLastAction} disabled={!lastAction || busy} title="Отменить последнее действие">
            <ArrowLeft size={15} />Назад
          </button>
        </div>
      </div>
      <div className="study-card-stage">
        <div className="swipe-zone forgotten" style={{ opacity: dragX < 0 ? dragProgress : 0 }}><ArrowLeft size={22} />Не помню</div>
        <div className="swipe-zone remembered" style={{ opacity: dragX > 0 ? dragProgress : 0 }}>Помню<ArrowRight size={22} /></div>
        <div
          className={`study-card ${revealed ? 'revealed' : ''} ${dragging ? 'dragging' : ''} ${exiting ? `exiting-${exiting}` : ''}`}
          style={{
            transform,
            opacity: exiting ? 0 : 1,
            transition: dragging && !exiting ? 'none' : 'transform 150ms ease, opacity 150ms ease',
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(event) => finishPointer(event)}
          onPointerCancel={(event) => finishPointer(event, true)}
        >
          <button type="button" className="study-card-tool study-card-speak" onClick={() => speakLearningText(current.sourceText)} title="Произнести слово" aria-label="Произнести слово">
            <Volume2 size={19} />
          </button>
          <div className="study-card-menu-shell">
            <button type="button" className="study-card-tool" onClick={() => setMenuOpen((value) => !value)} title="Действия со словом" aria-label="Действия со словом" aria-expanded={menuOpen}>
              <MoreHorizontal size={20} />
            </button>
            {menuOpen && (
              <div className="study-card-menu">
                <button type="button" className="danger" onClick={removeCurrent}><Trash2 size={16} />Удалить из словаря</button>
              </div>
            )}
          </div>
          <div className="study-question-slot"><h2 data-selectable-text>{current.sourceText}</h2></div>
          <div className="study-answer-slot">
            {!revealed ? (
              <button type="button" className="reveal-button" onClick={() => setRevealed(true)}>Показать перевод <kbd>Enter</kbd></button>
            ) : (
              <div className="study-translation" data-selectable-text>{current.translation || 'Перевод ещё не заполнен'}</div>
            )}
          </div>
          <div className={`study-context-slot ${revealed && current.contexts?.[0] ? 'visible' : ''}`}>
            {!!current.contexts?.[0] && (
              <div className="study-context"><span data-selectable-text>{current.contexts[0].sourceText}</span>{current.contexts[0].translation && <small data-selectable-text>{current.contexts[0].translation}</small>}</div>
            )}
          </div>
        </div>
      </div>
      <div className="review-actions">
        <button type="button" className="forgotten" onClick={() => review('forgotten')} disabled={busy}>
          <ArrowLeft size={20} /><span>Не помню<small>{practiceHint}</small></span>
        </button>
        <button type="button" className="remembered" onClick={() => review('remembered')} disabled={busy}>
          <ArrowRight size={20} /><span>Помню<small>{practiceHint}</small></span>
        </button>
      </div>
      <div className="deck-hint">Enter — показать перевод · ← / → — ответить · карточку можно перетащить</div>
    </section>
  )
}

function SettingsView() {
  const [enabled, setEnabled] = useState(true)
  const [autoplay, setAutoplay] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    let active = true
    readYoutubePreferences()
      .then((preferences) => {
        if (!active) return
        setEnabled(preferences.learning_ai_explanation !== false)
        setAutoplay(preferences.learning_card_autoplay === true)
      })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  const toggle = async () => {
    if (saving || loading) return
    const next = !enabled
    setEnabled(next)
    setSaving(true)
    setMessage('')
    try {
      const result = await patchYoutubePreferences({ learning_ai_explanation: next })
      const canonical = result?.settings?.learning_ai_explanation
      if (typeof canonical === 'boolean') setEnabled(canonical)
      setMessage(result?.online === false ? 'Сохранено локально; SC Desktop применит настройку при запуске.' : 'Сохранено')
    } catch (error) {
      setEnabled(!next)
      setMessage(error?.message || String(error))
    } finally {
      setSaving(false)
    }
  }

  const toggleAutoplay = async () => {
    if (saving || loading) return
    const next = !autoplay
    setAutoplay(next)
    setSaving(true)
    setMessage('')
    try {
      const result = await patchYoutubePreferences({ learning_card_autoplay: next })
      const canonical = result?.settings?.learning_card_autoplay
      if (typeof canonical === 'boolean') setAutoplay(canonical)
      setMessage(result?.online === false ? 'Сохранено локально; SC Desktop применит настройку при запуске.' : 'Сохранено')
    } catch (error) {
      setAutoplay(!next)
      setMessage(error?.message || String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="workspace settings-workspace" aria-label="Настройки словаря">
      <div className="settings-card">
        <div className="settings-copy">
          <div className="settings-title"><Sparkles size={19} /><strong>AI-пояснение слова в контексте</strong></div>
          <p>При открытии слова в субтитрах показывать 1–2 коротких предложения о его значении именно в текущей реплике.</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          className={`settings-switch ${enabled ? 'on' : ''}`}
          onClick={toggle}
          disabled={loading || saving}
        ><span /></button>
      </div>
      <div className="settings-card">
        <div className="settings-copy">
          <div className="settings-title"><Volume2 size={19} /><strong>Автопроигрывание карточек</strong></div>
          <p>Произносить английское слово или фразу сразу после появления следующей карточки.</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={autoplay}
          className={`settings-switch ${autoplay ? 'on' : ''}`}
          onClick={toggleAutoplay}
          disabled={loading || saving}
        ><span /></button>
      </div>
      <div className="settings-card compact">
        <div className="settings-copy">
          <strong>Модель</strong>
          <p>Gemini 3.1 Flash‑Lite · без инструментов агента · успешные ответы кэшируются локально на Mac.</p>
        </div>
      </div>
      {message && <div className="settings-message">{message}</div>}
    </section>
  )
}

function App() {
  const [tab, setTab] = useState(() => {
    if (window.location.hash === '#cards') return 'cards'
    if (window.location.hash === '#settings') return 'settings'
    return 'dictionary'
  })
  const [entries, setEntries] = useState([])
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState('')
  const learnedPercent = stats?.total ? Math.round((stats.known / stats.total) * 100) : 0
  const chooseTab = (nextTab) => {
    setTab(nextTab)
    window.history.replaceState(null, '', `#${nextTab}`)
  }

  const readLocal = useCallback(async () => {
    const [nextEntries, nextStats] = await Promise.all([
      store.listEntries({}),
      store.stats({}),
    ])
    setEntries(nextEntries)
    setStats(nextStats)
    setLoading(false)
  }, [])

  const refresh = useCallback(async ({ sync = false } = {}) => {
    await readLocal()
    if (!sync) return
    setSyncing(true)
    try {
      await store.sync({})
      setError('')
    } catch (syncError) {
      setError(syncError?.message || String(syncError))
    } finally {
      setSyncing(false)
      await readLocal()
    }
  }, [readLocal])

  useEffect(() => {
    let active = true
    const unsubscribe = store.subscribe(() => {
      if (active) readLocal().catch(() => {})
    })
    ;(async () => {
      try {
        await store.migrateLegacy({})
        if (!active) return
        await readLocal()
        setSyncing(true)
        await store.sync({})
        if (active) await readLocal()
      } catch (loadError) {
        if (active) setError(loadError?.message || String(loadError))
      } finally {
        if (active) { setLoading(false); setSyncing(false) }
      }
    })()
    return () => { active = false; unsubscribe() }
  }, [readLocal])

  if (!store) return <div className="fatal">Локальный словарь расширения не загрузился.</div>

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><div className="brand-mark"><Sparkles size={22} /></div><div><h1>Словарь / Карточки</h1><p>Работает офлайн и синхронизируется через Voice Record</p></div></div>
        <SyncBadge stats={stats} syncing={syncing} onSync={() => refresh({ sync: true })} />
      </header>
      <div className="summary">
        <div><span>В словаре</span><strong>{stats?.saved || 0}</strong></div>
        <div><span>Знаю</span><strong>{stats?.known || 0}</strong></div>
        <div><span>К повторению</span><strong>{stats?.due || 0}</strong></div>
        <div><span>Освоено</span><strong>{learnedPercent}%</strong></div>
      </div>
      <nav className="tabs" aria-label="Разделы">
        <button type="button" className={tab === 'dictionary' ? 'active' : ''} onClick={() => chooseTab('dictionary')}><BookOpen size={18} />Словарь</button>
        <button type="button" className={tab === 'cards' ? 'active' : ''} onClick={() => chooseTab('cards')}><Sparkles size={18} />Карточки{(stats?.saved || 0) > 0 && <strong>{stats.saved}</strong>}</button>
        <button type="button" className={tab === 'settings' ? 'active' : ''} onClick={() => chooseTab('settings')}><Settings size={18} />Настройки</button>
      </nav>
      {error && <div className="error-banner">{error}<button type="button" onClick={() => setError('')}><X size={16} /></button></div>}
      {loading ? <div className="page-loader"><RefreshCw className="spin" /><span>Открываю локальную базу…</span></div> : tab === 'dictionary'
        ? <DictionaryView entries={entries} refresh={refresh} />
        : tab === 'cards'
          ? <DeckView entries={entries} refresh={refresh} />
          : <SettingsView />}
    </div>
  )
}

createRoot(document.getElementById('root')).render(<App />)
