'use strict'

const { command, runtime } = require('../scripts/telegram-account-login.cjs')
const normalize = value => String(value ?? '').trim().replace(/^@/, '').replace(/\s+/g, ' ').toLocaleLowerCase('ru')
const fail = (code, message) => Object.assign(new Error(message), { code })

function safeMe(me) {
  if (!me || typeof me !== 'object') return null
  const out = Object.fromEntries(['id', 'username', 'first_name', 'last_name', 'last_seen', 'phone_masked'].filter(k => me[k] != null).map(k => [k, me[k]]))
  if (!out.phone_masked && me.phone) out.phone_masked = '••••' + String(me.phone).replace(/\D/g, '').slice(-4)
  return out
}

function inventoryResult(events, active) {
  const done = events.find(e => e.type === 'done') || null
  const errors = events.filter(e => e.type === 'error').map(e => ({ code: e.code || 'session_inventory_failed',
    message: 'Discovery не завершилось; это не отсутствие аккаунта.' }))
  const sessions = events.filter(e => e.type === 'session').map(s => ({ name: s.name, label: s.label || null,
    authorized: s.authorized === true && s.me?.id ? true : s.authorized === false ? false : null,
    authorization_state: s.authorized === true && s.me?.id ? 'authorized' : s.authorized === false ? 'unauthorized' : 'unknown',
    verified_at: s.verified_at || null, me: safeMe(s.me), me_cached: safeMe(s.me_cached),
    ...(s.error_code || s.error ? { error_code: s.error_code || 'session_inventory_network_error' } : {}) }))
  return { active, sessions, done, errors, enumeration_complete: done?.enumeration_complete === true && !errors.length,
    verification_complete: done?.verification_complete === true && !errors.length && sessions.every(s => s.authorized != null),
    login_hint: 'Phone/code/2FA вводятся только локально через telegram_account_login_command; global active не меняется.' }
}

function selectionFields(s) {
  const me = s.me || s.me_cached || {}
  return [s.name, s.label, me.id, me.username, [me.first_name, me.last_name].filter(Boolean).join(' ')].map(normalize).filter(Boolean)
}

function selectAccount(inventory, { account_id, name, session, allowSubstring = false } = {}) {
  const supplied = [account_id != null, name != null, session != null].filter(Boolean).length
  if (supplied !== 1) throw fail('INVALID_ACCOUNT_SELECTOR', 'Укажи ровно один account_id, name или session; не порядковый номер.')
  if (account_id != null && (!Number.isSafeInteger(account_id) || account_id <= 0)) throw fail('INVALID_ACCOUNT_SELECTOR', 'account_id должен быть точным положительным ID.')
  const target = normalize(account_id ?? name ?? session)
  if (!target) throw fail('INVALID_ACCOUNT_SELECTOR', 'Нужен непустой точный селектор аккаунта.')
  let matches = (inventory.sessions || []).filter(s => account_id != null
    ? Number((s.me || s.me_cached)?.id) === account_id
    : session != null ? normalize(s.name) === target : selectionFields(s).includes(target))
  if (!matches.length && allowSubstring && name != null) matches = (inventory.sessions || []).filter(s => selectionFields(s).some(f => f.includes(target)))
  if (!matches.length) {
    const unknown = !inventory.enumeration_complete || !inventory.verification_complete || (inventory.sessions || []).some(s => s.authorized == null)
    return { ok: false, state: unknown ? 'unknown' : 'missing', code: unknown ? 'TELEGRAM_ACCOUNT_DISCOVERY_UNKNOWN' : 'TELEGRAM_ACCOUNT_NOT_FOUND',
      error: unknown ? 'Discovery не подтвердило отсутствие аккаунта. Не выбирай другой аккаунт и не считай timeout отсутствием.' : 'Нужный аккаунт отсутствует; чужой fallback запрещён.', active_changed: false }
  }
  const verified = matches.filter(s => s.authorized === true && s.me?.id && s.verified_at)
  const ids = new Set(matches.map(s => (s.me || s.me_cached)?.id).filter(id => id != null))
  const sameAccount = ids.size === 1 && matches.every(s => (s.me || s.me_cached)?.id != null)
  if (matches.length > 1 && !sameAccount) {
    return { ok: false, state: 'ambiguous', code: 'TELEGRAM_ACCOUNT_AMBIGUOUS',
      error: 'Название неоднозначно. Нужен точный account ID/session, не индекс списка.',
      candidates: matches.map(s => ({ session: s.name, label: s.label, account_id: (s.me || s.me_cached)?.id || null, authorized: s.authorized })), active_changed: false }
  }
  const match = verified.sort((a, b) => a.name.localeCompare(b.name))[0] || matches.find(s => s.authorized == null) || matches[0]
  if (!verified.length) return { ok: false, state: match.authorized === false ? 'unauthorized' : 'unknown',
    code: match.authorized === false ? 'TELEGRAM_ACCOUNT_UNAUTHORIZED' : 'TELEGRAM_ACCOUNT_DISCOVERY_UNKNOWN',
    error: match.authorized === false ? 'Нужный аккаунт не авторизован. Чужой fallback запрещён.' : 'Авторизация нужного аккаунта не подтверждена свежим get_me.',
    session: match.name, account_id: match.me_cached?.id || null, active_changed: false }
  return { ok: true, state: 'authorized', session: match.name, account_id: match.me.id,
    label: match.label, me: match.me, verified_at: match.verified_at, identity_basis: 'fresh_get_me',
    active_changed: false, same_account_sessions: verified.map(s => s.name),
    next: 'Передавай этот session явно в каждом Telegram tool; не изменяй global active.' }
}

function loginCommand({ label, expected_account_id } = {}) {
  runtime() // Code/runtime existence only. Never connect or prompt through MCP.
  return { ok: true, command: command({ label, expectedAccountId: expected_account_id }),
    platform: process.platform, executes_login: false, secrets_input: 'local_tty',
    input_visibility: { phone: 'visible', telegram_code: 'visible', two_factor_password: 'hidden' }, active_changed: false,
    after: 'Пользователь вводит phone/code/2FA локально, затем «готово». Повтори telegram_resolve_account для fresh get_me; до этого аккаунт не подключён.' }
}

const accountTools = [
  { name: 'telegram_account_login_command', description: 'Return ONE supported local interactive login command; NEVER logs in through AI. Phone and Telegram code echo on the user\'s local TTY; only the 2FA password is hidden. Add third/further accounts without overwriting existing sessions or switching global active. After ready, resolve again with fresh get_me; absence never permits another-account fallback.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: { label: { type: 'string', minLength: 1, maxLength: 120 }, expected_account_id: { type: 'integer', minimum: 1 } }, additionalProperties: false } },
  { name: 'telegram_resolve_account', description: 'Read-only bounded fresh account discovery by exact account ID, display/assigned name, or session. Returns proven get_me account_id/session, or missing/unauthorized/unknown/ambiguous. Timeout is NOT absence. Never chooses another account or switches global active. Use resolved session per call; do not use list ordinals.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: { type: 'object', properties: { account_id: { type: 'integer', minimum: 1 }, name: { type: 'string', minLength: 1 }, session: { type: 'string', minLength: 1 } },
      oneOf: [{ required: ['account_id'] }, { required: ['name'] }, { required: ['session'] }], additionalProperties: false } },
]

module.exports = { accountTools, inventoryResult, selectAccount, loginCommand }
