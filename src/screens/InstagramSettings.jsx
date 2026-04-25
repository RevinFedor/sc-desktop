import React, { useEffect, useState } from 'react'
import { Trash2, ChevronDown, ChevronRight } from 'lucide-react'
import PlatformLogo from '../components/PlatformLogo'

/**
 * Instagram settings (per-platform settings screen, opened from
 * LibrarySidebar by clicking the «Instagram» group header).
 *
 * Sections, no fetch UI here — parsing always goes through Home/paste:
 *   1. Backend selectors — two independent radio rows:
 *        • metadata (api default · apify $0.0026/profile reels)
 *        • transcribe (api default · apify $0.001/reel)
 *      Apify token field is shared (only relevant when *either* selector
 *      is set to apify).
 *   2. Расширенное → Cookies-сессии — collapsed by default, only matters
 *      for private profiles you're logged in to.  Login itself is done
 *      via `sc -i --login` in the terminal (Instagram bans programmatic
 *      logins from inside the app).
 */
export default function InstagramSettings() {
  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 overflow-auto px-8 py-6">
        <div className="max-w-3xl">
          <div className="mb-6 flex items-center gap-3">
            <PlatformLogo platform="instagram" size={20} />
            <span className="text-xl font-semibold text-zinc-100">Instagram · настройки</span>
          </div>

          <BackendBlock />
          <AdvancedBlock />
        </div>
      </div>
    </div>
  )
}

// ─── Backend selectors + Apify token ───────────────────────────────────

function BackendBlock() {
  const [settings, setSettings] = useState(null)
  const [editingToken, setEditingToken] = useState(false)
  const [tokenInput, setTokenInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr]   = useState(null)

  async function refresh() {
    setErr(null)
    try {
      const s = await window.api.igGetSettings()
      setSettings(s)
    } catch (e) {
      setErr(String(e?.message || e))
    }
  }

  useEffect(() => { refresh() }, [])

  async function pickBackend(which, backend) {
    setBusy(true); setErr(null)
    try {
      const r = await window.api.igSetBackend({ which, backend })
      if (!r.ok) { setErr(r.error || 'failed'); return }
      setSettings(s => ({ ...s, [`${which}_backend`]: backend }))
    } finally { setBusy(false) }
  }

  async function saveToken() {
    setBusy(true); setErr(null)
    try {
      const r = await window.api.igSetApifyToken(tokenInput)
      if (!r.ok) { setErr(r.error || 'failed'); return }
      setEditingToken(false)
      setTokenInput('')
      refresh()
    } finally { setBusy(false) }
  }

  if (!settings) {
    return (
      <Section title="Backend">
        <div className="text-zinc-500 italic" style={{ fontSize: '14px' }}>Загрузка…</div>
      </Section>
    )
  }

  const apifyAnywhere = settings.metadata_backend === 'apify' || settings.transcribe_backend === 'apify'

  return (
    <Section title="Backend">
      <div className="text-zinc-500 mb-4" style={{ fontSize: '14px' }}>
        Два независимых переключателя. <b>api</b> — встроенный путь через мобильные эндпоинты,
        бесплатно, без логина. <b>Apify</b> — облачный актор, нужен токен,
        полезен когда api тротлит или нужны приватные профили без cookies.
      </div>

      {err && <ErrorBox text={err} />}

      <div className="space-y-4 mb-4">
        <SelectorGroup
          title="Метаданные профиля"
          subtitle="Что использовать при парсинге списка рилсов."
          choices={[
            { id: 'api',   title: 'android-api', subtitle: 'Бесплатно · cookies-free clips/user/' },
            { id: 'apify', title: 'Apify',       subtitle: '~$0.0026 / профиль (reel-scraper)' },
          ]}
          value={settings.metadata_backend}
          onPick={b => pickBackend('metadata', b)}
          disabled={busy}
        />

        <SelectorGroup
          title="Транскрипция рилсов"
          subtitle="Откуда брать видео для скачивания и транскрипции."
          choices={[
            { id: 'api',   title: 'android-api', subtitle: 'Бесплатно · video_url из clips/user/' },
            { id: 'apify', title: 'Apify',       subtitle: '~$0.001 / рилс (apple_yang)' },
          ]}
          value={settings.transcribe_backend}
          onPick={b => pickBackend('transcribe', b)}
          disabled={busy}
        />
      </div>

      <div className={`rounded-md border bg-zinc-950 px-4 py-3 ${
        apifyAnywhere ? 'border-zinc-800' : 'border-zinc-900 opacity-70'
      }`}>
        <div className="flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-zinc-200" style={{ fontSize: '14px' }}>Apify token</div>
            <div className="text-zinc-500 mt-0.5" style={{ fontSize: '14px' }}>
              {settings.apify_token_set
                ? <>● ● ● ● ● ● ● ● <span className="text-emerald-400">сохранён</span>{settings.apify_token_legacy && <span className="text-amber-400 ml-2">· из legacy-файла, пересохрани чтобы перенести</span>}</>
                : apifyAnywhere
                  ? <span className="text-amber-400">не задан — Apify backend не сможет работать</span>
                  : <span className="text-zinc-600">не нужен — оба селектора на api</span>}
            </div>
          </div>
          {!editingToken && (
            <button
              onClick={() => { setEditingToken(true); setTokenInput('') }}
              className="px-3 py-1 rounded-md text-zinc-200 bg-zinc-800 hover:bg-zinc-700"
              style={{ fontSize: '14px' }}
            >{settings.apify_token_set ? 'Изменить' : 'Задать'}</button>
          )}
        </div>
        {editingToken && (
          <div className="mt-3 flex items-center gap-2">
            <input
              autoFocus
              type="password"
              value={tokenInput}
              onChange={e => setTokenInput(e.target.value)}
              placeholder="apify_api_..."
              className="flex-1 bg-zinc-800 border border-zinc-700 rounded-md px-3 py-1.5 focus:outline-none focus:border-zinc-500"
              style={{ fontSize: '14px' }}
              onKeyDown={e => e.key === 'Enter' && saveToken()}
            />
            <button
              onClick={saveToken}
              disabled={busy}
              className="px-3 py-1.5 rounded-md font-medium bg-zinc-100 text-zinc-900 hover:bg-white disabled:bg-zinc-800 disabled:text-zinc-500"
              style={{ fontSize: '14px' }}
            >{busy ? 'Сохраняю…' : 'Сохранить'}</button>
            <button
              onClick={() => { setEditingToken(false); setTokenInput('') }}
              className="px-3 py-1.5 rounded-md text-zinc-400 hover:bg-zinc-800"
              style={{ fontSize: '14px' }}
            >Отмена</button>
          </div>
        )}
      </div>
    </Section>
  )
}

function SelectorGroup({ title, subtitle, choices, value, onPick, disabled }) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950 overflow-hidden">
      <div className="px-4 py-3 border-b border-zinc-900">
        <div className="text-zinc-200" style={{ fontSize: '14px' }}>{title}</div>
        {subtitle && <div className="text-zinc-500 mt-0.5" style={{ fontSize: '13px' }}>{subtitle}</div>}
      </div>
      {choices.map((c, i) => (
        <React.Fragment key={c.id}>
          {i > 0 && <div className="border-t border-zinc-900" />}
          <BackendRow
            checked={value === c.id}
            onPick={() => onPick(c.id)}
            title={c.title}
            subtitle={c.subtitle}
            disabled={disabled}
          />
        </React.Fragment>
      ))}
    </div>
  )
}

function BackendRow({ checked, onPick, title, subtitle, disabled }) {
  return (
    <div
      role="button"
      onClick={disabled ? undefined : onPick}
      className={`px-4 py-2.5 flex items-center gap-3 ${
        disabled ? 'opacity-60 cursor-wait' : 'cursor-pointer hover:bg-zinc-900'
      }`}
    >
      <span
        className={`w-4 h-4 rounded-full border flex items-center justify-center ${
          checked ? 'border-emerald-500' : 'border-zinc-600'
        }`}
      >
        {checked && <span className="w-2 h-2 rounded-full bg-emerald-500" />}
      </span>
      <div className="flex-1">
        <div className="text-zinc-100" style={{ fontSize: '14px' }}>{title}</div>
        <div className="text-zinc-500 mt-0.5" style={{ fontSize: '14px' }}>{subtitle}</div>
      </div>
    </div>
  )
}

// ─── Advanced (collapsed) — cookie sessions for private profiles ───────

function AdvancedBlock() {
  const [open, setOpen] = useState(false)
  return (
    <div className="mb-8">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full text-left text-zinc-400 hover:text-zinc-200 flex items-center gap-2 mb-3"
        style={{ fontSize: '14px' }}
      >
        {open ? <ChevronDown size={16} className="text-zinc-600" /> : <ChevronRight size={16} className="text-zinc-600" />}
        Расширенное · Cookies-сессии
      </button>
      {open && (
        <>
          <div className="text-zinc-500 mb-3" style={{ fontSize: '14px' }}>
            Cookies нужны только если ты хочешь парсить <b>приватный</b> профиль, на
            который у тебя есть подписка. Для публичных reels ничего настраивать не надо
            — backend api работает без логина.
          </div>
          <SessionsInventory />
        </>
      )}
    </div>
  )
}

function SessionsInventory() {
  const [sessions, setSessions] = useState([])
  const [loading, setLoading]   = useState(true)
  const [err, setErr]           = useState(null)
  const [copied, setCopied]     = useState(false)

  async function refresh() {
    setLoading(true); setErr(null)
    try {
      const r = await window.api.igListSessions()
      setSessions(r.sessions || [])
    } catch (e) {
      setErr(String(e?.message || e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { refresh() }, [])

  async function deleteSession(kind) {
    if (!window.confirm(`Удалить файл сессии ${kind}? Cookies будут стёрты с диска.`)) return
    const r = await window.api.igDeleteSession(kind)
    if (!r.ok) { setErr(r.error || 'delete failed'); return }
    refresh()
  }

  function copyLogin() {
    navigator.clipboard.writeText('sc -i --login')
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  return (
    <>
      <div className="text-zinc-500 mb-3" style={{ fontSize: '14px' }}>
        Чтобы добавить сессию — выполни в терминале:
        <button
          onClick={copyLogin}
          className="ml-2 px-2 py-0.5 rounded-md bg-zinc-800 text-zinc-200 hover:bg-zinc-700 font-mono"
          style={{ fontSize: '13px' }}
          title="Скопировать команду"
        >
          {copied ? 'скопировано' : 'sc -i --login'}
        </button>
      </div>

      {err && <ErrorBox text={err} />}

      <div className="rounded-md border border-zinc-800 bg-zinc-950 divide-y divide-zinc-900">
        {loading && (
          <div className="px-4 py-3 text-zinc-500 italic" style={{ fontSize: '14px' }}>Загрузка сессий…</div>
        )}
        {!loading && sessions.length === 0 && (
          <div className="px-4 py-4 text-zinc-500 italic" style={{ fontSize: '14px' }}>
            Сессий нет. Это нормально — публичные профили работают без них.
          </div>
        )}
        {sessions.map(s => (
          <SessionRow key={s.kind} session={s} onDelete={() => deleteSession(s.kind)} />
        ))}
      </div>
    </>
  )
}

function SessionRow({ session, onDelete }) {
  const label = session.kind === 'playwright'
    ? 'Playwright (browser/headed flow)'
    : 'API (mobile cookies)'
  return (
    <div className="px-4 py-3 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-zinc-100" style={{ fontSize: '14px' }}>{label}</span>
          {session.user_id && <span className="text-zinc-500" style={{ fontSize: '14px' }}>· user_id {session.user_id}</span>}
        </div>
        <div className="text-zinc-500 mt-0.5 flex items-center gap-2" style={{ fontSize: '14px' }}>
          {session.authorized
            ? <span className="text-emerald-400">✓ авторизована</span>
            : <span className="text-amber-400">⚠ не авторизована{session.error ? ` · ${session.error}` : ''}</span>}
          <span className="text-zinc-700">·</span>
          <code className="text-zinc-600 truncate">{session.path?.replace(/^.*\//, '')}</code>
        </div>
      </div>
      <button
        onClick={onDelete}
        title="Удалить сессию"
        className="text-zinc-600 hover:text-red-400"
      ><Trash2 size={16} /></button>
    </div>
  )
}

// ─── shared bits ───────────────────────────────────────────────────────

function Section({ title, children }) {
  return (
    <div className="mb-8">
      <div className="text-zinc-300 font-medium mb-3" style={{ fontSize: '15px' }}>{title}</div>
      {children}
    </div>
  )
}

function ErrorBox({ text }) {
  return (
    <div className="mb-3 px-3 py-2 rounded bg-red-950/40 border border-red-900/60 text-red-300" style={{ fontSize: '14px' }}>
      {text}
    </div>
  )
}
