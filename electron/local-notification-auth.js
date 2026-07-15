const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const DEFAULT_NOTIFICATION_TOKEN_PATH = path.join(
  process.env.SC_DESKTOP_DIR
    || process.env.MEDIA_INBOX_DIR
    || path.join(os.homedir(), 'Library', 'Application Support', 'sc-desktop'),
  'notification-bridge-token',
)

function getNotificationTokenPath() {
  return process.env.SC_DESKTOP_NOTIFICATION_TOKEN_PATH
    || DEFAULT_NOTIFICATION_TOKEN_PATH
}

function normalizeToken(value) {
  const token = String(value || '').trim()
  return /^[a-f0-9]{64}$/i.test(token) ? token : null
}

function readNotificationToken(tokenPath = getNotificationTokenPath()) {
  try {
    return normalizeToken(fs.readFileSync(tokenPath, 'utf8'))
  } catch (err) {
    if (err?.code === 'ENOENT') return null
    throw err
  }
}

function ensureNotificationToken(tokenPath = getNotificationTokenPath()) {
  const existing = readNotificationToken(tokenPath)
  if (existing) return { token: existing, tokenPath }

  fs.mkdirSync(path.dirname(tokenPath), { recursive: true, mode: 0o700 })
  const token = crypto.randomBytes(32).toString('hex')
  try {
    fs.writeFileSync(tokenPath, `${token}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    try { fs.chmodSync(tokenPath, 0o600) } catch {}
    return { token, tokenPath }
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err
    const racedToken = readNotificationToken(tokenPath)
    if (racedToken) return { token: racedToken, tokenPath }
    throw new Error(`notification token file is invalid: ${tokenPath}`)
  }
}

function matchesBearerToken(authorization, expectedToken) {
  const match = /^Bearer\s+([a-f0-9]{64})$/i.exec(String(authorization || '').trim())
  if (!match || !expectedToken) return false
  const actual = Buffer.from(match[1], 'utf8')
  const expected = Buffer.from(expectedToken, 'utf8')
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
}

module.exports = {
  ensureNotificationToken,
  getNotificationTokenPath,
  matchesBearerToken,
  readNotificationToken,
}
