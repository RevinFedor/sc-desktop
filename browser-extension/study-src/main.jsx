import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock3,
  CloudOff,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Wifi,
  X,
} from 'lucide-react'
import '../learning-store.js'
import './study.css'

const store = window.__scLearningStore

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
            <span><Clock3 size={13} />{entry.reviewCount ? `${entry.reviewCount} повторений` : 'новая карточка'}</span>
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

function DeckView({ dueEntries, refresh }) {
  const [revealed, setRevealed] = useState(false)
  const current = dueEntries[0] || null

  useEffect(() => setRevealed(false), [current?.key])

  const review = async (result) => {
    if (!current) return
    await store.queueReview({ key: current.key, result })
    setRevealed(false)
    await refresh({ sync: true })
  }

  if (!current) {
    return (
      <section className="deck workspace">
        <div className="deck-empty"><CheckCircle2 size={58} /><h2>На сегодня всё</h2><p>Новые и назначенные карточки появятся здесь автоматически.</p></div>
      </section>
    )
  }

  return (
    <section className="deck workspace" aria-label="Карточки">
      <div className="deck-progress"><span>Осталось карточек</span><strong>{dueEntries.length}</strong></div>
      <div className={`study-card ${revealed ? 'revealed' : ''}`}>
        <div className="study-card-label">{current.kind === 'phrase' ? 'Фраза' : 'Слово'}</div>
        <h2>{current.sourceText}</h2>
        {!revealed ? (
          <button type="button" className="reveal-button" onClick={() => setRevealed(true)}>Показать перевод</button>
        ) : (
          <>
            <div className="study-translation">{current.translation || 'Перевод ещё не заполнен'}</div>
            {!!current.contexts?.[0] && (
              <div className="study-context"><span>{current.contexts[0].sourceText}</span>{current.contexts[0].translation && <small>{current.contexts[0].translation}</small>}</div>
            )}
          </>
        )}
      </div>
      {revealed && (
        <div className="review-actions">
          <button type="button" className="forgotten" onClick={() => review('forgotten')}><X size={20} /><span>Не помню<small>повторить через 10 минут</small></span></button>
          <button type="button" className="remembered" onClick={() => review('remembered')}><Check size={20} /><span>Помню<small>увеличить интервал</small></span></button>
        </div>
      )}
    </section>
  )
}

function App() {
  const [tab, setTab] = useState(() => window.location.hash === '#cards' ? 'cards' : 'dictionary')
  const [entries, setEntries] = useState([])
  const [dueEntries, setDueEntries] = useState([])
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState('')
  const learnedPercent = stats?.total ? Math.round((stats.known / stats.total) * 100) : 0
  const chooseTab = (nextTab) => {
    setTab(nextTab)
    window.history.replaceState(null, '', nextTab === 'cards' ? '#cards' : '#dictionary')
  }

  const readLocal = useCallback(async () => {
    const [nextEntries, nextDue, nextStats] = await Promise.all([
      store.listEntries({}),
      store.dueEntries({ limit: 100 }),
      store.stats({}),
    ])
    setEntries(nextEntries)
    setDueEntries(nextDue)
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
        <button type="button" className={tab === 'cards' ? 'active' : ''} onClick={() => chooseTab('cards')}><Sparkles size={18} />Карточки{dueEntries.length > 0 && <strong>{dueEntries.length}</strong>}</button>
      </nav>
      {error && <div className="error-banner">{error}<button type="button" onClick={() => setError('')}><X size={16} /></button></div>}
      {loading ? <div className="page-loader"><RefreshCw className="spin" /><span>Открываю локальную базу…</span></div> : tab === 'dictionary'
        ? <DictionaryView entries={entries} refresh={refresh} />
        : <DeckView dueEntries={dueEntries} refresh={refresh} />}
    </div>
  )
}

createRoot(document.getElementById('root')).render(<App />)
