import React, { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import PlatformLogo from '../components/PlatformLogo'

/**
 * Telegram session management. Lists existing *.session files in the CLI
 * tools directory, lets the user pick which one is "active" (= which one
 * tg_fetch_json.py uses). Provides a 3-step login form to add a new session.
 *
 * The session list is refreshed on mount and after any login/delete.
 */
export default function TelegramSettings() {
  const [sessions, setSessions] = useState([])
  const [active, setActive]     = useState(null)
  const [loading, setLoading]   = useState(true)
  const [err, setErr]           = useState(null)
  const [adding, setAdding]     = useState(false)
  // Phone to pre-fill the login form with — set when the user clicks «Войти
  // заново» on a revoked session, so re-login targets the same account.
  const [prefillPhone, setPrefillPhone] = useState('')

  async function refresh() {
    setLoading(true); setErr(null)
    try {
      const r = await window.api.tgListSessions()
      setSessions(r.sessions || [])
      setActive(r.active || null)
    } catch (e) {
      setErr(String(e?.message || e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { refresh() }, [])

  async function pickActive(name) {
    const r = await window.api.tgSetActiveSession(name)
    if (r.ok) setActive(name)
    else setErr(r.error || 'failed to set active')
  }

  async function deleteSession(name) {
    if (!window.confirm(`Удалить сессию «${name}»? Файл будет стёрт с диска.`)) return
    const r = await window.api.tgDeleteSession(name)
    if (!r.ok) { setErr(r.error || 'delete failed'); return }
    if (active === name) setActive(null)
    refresh()
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 overflow-auto px-8 py-6">
        <div className="max-w-3xl">
          <div className="mb-6 flex items-center gap-3">
            <PlatformLogo platform="telegram" size={20} />
            <span className="text-xl font-semibold text-zinc-100">Telegram · сессии</span>
          </div>
          <div className="text-zinc-400 mb-6" style={{ fontSize: '14px' }}>
            Каждая сессия — отдельный аккаунт. Активная используется для всех
            будущих парсингов. Если сессия отозвана Telegram — войдите в неё
            заново тем же номером, старая запись заменится автоматически.
          </div>

          {err && (
            <div className="mb-4 px-3 py-2 rounded bg-red-950/40 border border-red-900/60 text-red-300" style={{ fontSize: '14px' }}>
              {err}
            </div>
          )}

          <div className="rounded-md border border-zinc-800 bg-zinc-950 divide-y divide-zinc-900 mb-6">
            {loading && (
              <div className="px-4 py-3 text-zinc-500 italic" style={{ fontSize: '14px' }}>
                Загрузка сессий…
              </div>
            )}
            {!loading && sessions.length === 0 && (
              <div className="px-4 py-4 text-zinc-500 italic" style={{ fontSize: '14px' }}>
                Сессий пока нет — добавьте первую через «+ Добавить сессию».
              </div>
            )}
            {sessions.map(s => (
              <SessionRow
                key={s.name}
                session={s}
                active={s.name === active}
                onPickActive={() => pickActive(s.name)}
                onDelete={() => deleteSession(s.name)}
                onRelogin={() => {
                  // Pre-fill the login form with the cached phone and open it.
                  const ph = s.me_cached?.phone ? `+${String(s.me_cached.phone).replace(/^\+/, '')}` : ''
                  setPrefillPhone(ph)
                  setAdding(true)
                }}
              />
            ))}
          </div>

          {!adding && (
            <button
              onClick={() => { setPrefillPhone(''); setAdding(true) }}
              className="px-4 py-2 rounded-md text-zinc-200 bg-zinc-800 hover:bg-zinc-700"
            >+ Добавить сессию</button>
          )}

          {adding && (
            <AddSessionForm
              initialPhone={prefillPhone}
              onCancel={() => { setAdding(false); setPrefillPhone('') }}
              onDone={(name) => {
                setAdding(false)
                setPrefillPhone('')
                refresh().then(() => pickActive(name))
              }}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function SessionRow({ session, active, onPickActive, onDelete, onRelogin }) {
  const auth = session.authorized
  // For a live session use `me`; for a revoked one fall back to `me_cached`
  // (last-known identity from the .meta.json sidecar) so the row still tells
  // the user WHICH account died instead of a faceless «session.session».
  const id = session.me || session.me_cached || null
  const fromCache = !auth && !!session.me_cached
  const phone = id?.phone ? `+${String(id.phone).replace(/^\+/, '')}` : null
  const display = id
    ? ((id.first_name || '') + (id.last_name ? ' ' + id.last_name : '')).trim()
    : null
  return (
    <div className="px-4 py-3 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={`font-medium ${auth ? 'text-zinc-100' : 'text-zinc-400'}`}>{display || session.name}</span>
          {id?.username && <span className="text-zinc-500" style={{ fontSize: '14px' }}>· @{id.username}</span>}
          {phone && <span className="text-zinc-600" style={{ fontSize: '14px' }}>· {phone}</span>}
          {fromCache && <span className="text-zinc-600" style={{ fontSize: '13px' }}>· последние данные</span>}
        </div>
        <div className="text-zinc-500 mt-0.5 flex items-center gap-2" style={{ fontSize: '14px' }}>
          <code className="text-zinc-600">{session.name}.session</code>
          <span className="text-zinc-700">·</span>
          {auth
            ? <span className="text-emerald-400">✓ авторизована</span>
            : <span className="text-amber-400">⚠ отозвана Telegram</span>}
        </div>
        {/* Revoked → explain WHY (server-side logout) and WHAT to do. The
            session can't be «сделана активной» — its token is dead server-
            side; the only fix is a fresh login to the same number. */}
        {!auth && (
          <div className="text-zinc-500 mt-1.5 leading-snug" style={{ fontSize: '13px' }}>
            Сессия завершена на стороне Telegram (выход с другого устройства,
            «завершить сеанс» в настройках, либо протухла). Переключить её
            активной нельзя — нужно войти заново
            {phone ? <> по номеру <span className="text-zinc-400">{phone}</span></> : ' по тому же номеру'}.
          </div>
        )}
      </div>
      {active ? (
        <span className="px-3 py-1 rounded-md bg-emerald-900/40 text-emerald-300 border border-emerald-800/60 shrink-0" style={{ fontSize: '14px' }}>
          активная
        </span>
      ) : auth ? (
        <button
          onClick={onPickActive}
          className="px-3 py-1 rounded-md bg-zinc-100 text-zinc-900 hover:bg-white shrink-0"
          style={{ fontSize: '14px' }}
        >
          сделать активной
        </button>
      ) : (
        <button
          onClick={onRelogin}
          className="px-3 py-1 rounded-md bg-amber-500/90 text-zinc-950 hover:bg-amber-400 shrink-0 font-medium"
          style={{ fontSize: '14px' }}
        >
          войти заново
        </button>
      )}
      <button
        onClick={onDelete}
        title="Удалить сессию"
        className="text-zinc-600 hover:text-red-400 shrink-0"
      ><Trash2 size={16} /></button>
    </div>
  )
}

function AddSessionForm({ onCancel, onDone, initialPhone = '' }) {
  // Stage state machine: 'phone' → 'code' → '2fa' → 'done'
  const [stage, setStage] = useState('phone')
  const [phone, setPhone] = useState(initialPhone)   // prefilled on «войти заново»
  const [name,  setName]  = useState('')      // optional override; auto-derived from phone otherwise
  const [hash,  setHash]  = useState('')
  const [sessionName, setSessionName] = useState('')   // final filename, returned by python
  const [code,  setCode]  = useState('')
  const [pw,    setPw]    = useState('')
  const [busy,  setBusy]  = useState(false)
  const [err,   setErr]   = useState(null)

  async function startLogin() {
    if (!phone.trim()) { setErr('Введите номер телефона'); return }
    setBusy(true); setErr(null)
    try {
      const r = await window.api.tgLoginStart({ phone: phone.trim(), name: name.trim() || null })
      if (!r.ok) { setErr(r.error || 'login failed'); return }
      setHash(r.phone_code_hash)
      setSessionName(r.session_name)
      setStage('code')
    } finally { setBusy(false) }
  }

  async function submitCode() {
    if (!code.trim()) { setErr('Введите код'); return }
    setBusy(true); setErr(null)
    try {
      const r = await window.api.tgLoginFinish({
        phone: phone.trim(), hash, code: code.trim(),
        password: pw || undefined, name: sessionName,
      })
      if (r.ok) { onDone(r.session_name); return }
      if (r.twofa) { setStage('2fa'); return }
      setErr(r.error || 'login failed')
    } finally { setBusy(false) }
  }

  return (
    <div className="rounded-md border border-zinc-700 bg-zinc-900 p-5 mt-4">
      <div className="font-medium text-zinc-100 mb-1">
        {initialPhone ? 'Войти заново' : 'Добавить сессию'}
      </div>
      <div className="text-zinc-500 mb-4" style={{ fontSize: '14px' }}>
        {initialPhone
          ? <>Повторный вход в тот же аккаунт. Старая отозванная сессия будет автоматически заменена.</>
          : <>Логин аналогичен официальному Telegram: телефон → SMS-код → пароль (если включён 2FA).</>}
      </div>

      {err && (
        <div className="mb-3 px-3 py-2 rounded bg-red-950/40 border border-red-900/60 text-red-300" style={{ fontSize: '14px' }}>
          {err}
        </div>
      )}

      {stage === 'phone' && (
        <div className="space-y-3">
          <Field label="Телефон (с кодом страны)">
            <input
              autoFocus
              value={phone}
              onChange={e => setPhone(e.target.value)}
              placeholder="+79991234567"
              className="bg-zinc-800 border border-zinc-700 rounded-md px-3 py-1.5 w-64 focus:outline-none focus:border-zinc-500"
              onKeyDown={e => e.key === 'Enter' && startLogin()}
            />
          </Field>
          <Field label="Имя сессии (опционально)" hint="по умолчанию — session_<последние 7 цифр телефона>">
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="my_account"
              className="bg-zinc-800 border border-zinc-700 rounded-md px-3 py-1.5 w-64 focus:outline-none focus:border-zinc-500"
            />
          </Field>
          <div className="flex gap-2">
            <button
              onClick={startLogin}
              disabled={busy}
              className="px-4 py-2 rounded-md font-medium bg-zinc-100 text-zinc-900 hover:bg-white disabled:bg-zinc-800 disabled:text-zinc-500"
            >{busy ? 'Отправка…' : 'Запросить код'}</button>
            <button
              onClick={onCancel}
              className="px-4 py-2 rounded-md text-zinc-400 hover:bg-zinc-800"
            >Отмена</button>
          </div>
        </div>
      )}

      {stage === 'code' && (
        <div className="space-y-3">
          <div className="text-zinc-400" style={{ fontSize: '14px' }}>
            Код отправлен в Telegram на <span className="text-zinc-200">{phone}</span>.
          </div>
          <Field label="Код из Telegram">
            <input
              autoFocus
              value={code}
              onChange={e => setCode(e.target.value)}
              placeholder="12345"
              className="bg-zinc-800 border border-zinc-700 rounded-md px-3 py-1.5 w-32 focus:outline-none focus:border-zinc-500 tracking-widest text-center"
              onKeyDown={e => e.key === 'Enter' && submitCode()}
            />
          </Field>
          <div className="flex gap-2">
            <button
              onClick={submitCode}
              disabled={busy}
              className="px-4 py-2 rounded-md font-medium bg-zinc-100 text-zinc-900 hover:bg-white disabled:bg-zinc-800 disabled:text-zinc-500"
            >{busy ? 'Проверка…' : 'Войти'}</button>
            <button
              onClick={() => setStage('phone')}
              className="px-4 py-2 rounded-md text-zinc-400 hover:bg-zinc-800"
            >Назад</button>
          </div>
        </div>
      )}

      {stage === '2fa' && (
        <div className="space-y-3">
          <div className="text-zinc-400" style={{ fontSize: '14px' }}>
            На аккаунте включена 2FA — введите облачный пароль.
          </div>
          <Field label="Пароль 2FA">
            <input
              autoFocus
              type="password"
              value={pw}
              onChange={e => setPw(e.target.value)}
              className="bg-zinc-800 border border-zinc-700 rounded-md px-3 py-1.5 w-64 focus:outline-none focus:border-zinc-500"
              onKeyDown={e => e.key === 'Enter' && submitCode()}
            />
          </Field>
          <div className="flex gap-2">
            <button
              onClick={submitCode}
              disabled={busy}
              className="px-4 py-2 rounded-md font-medium bg-zinc-100 text-zinc-900 hover:bg-white disabled:bg-zinc-800 disabled:text-zinc-500"
            >{busy ? 'Проверка…' : 'Войти'}</button>
            <button
              onClick={onCancel}
              className="px-4 py-2 rounded-md text-zinc-400 hover:bg-zinc-800"
            >Отмена</button>
          </div>
        </div>
      )}
    </div>
  )
}

function Field({ label, hint, children }) {
  return (
    <div>
      <div className="text-zinc-500 mb-1" style={{ fontSize: '14px' }}>{label}</div>
      {children}
      {hint && <div className="text-zinc-600 mt-1" style={{ fontSize: '13px' }}>{hint}</div>}
    </div>
  )
}
