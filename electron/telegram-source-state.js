const TELEGRAM_SOURCE_UNAVAILABLE = 'telegram_source_unavailable'

function sourceMeta(source) {
  if (!source) return {}
  if (source.meta && typeof source.meta === 'object' && !Array.isArray(source.meta)) {
    return source.meta
  }
  try {
    const parsed = JSON.parse(source.meta_json || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Return the stable Telegram peer form for a saved source.
 *
 * Telegram usernames are display aliases and can change.  Telethon accepts
 * marked numeric peer ids: channels/supergroups use -100<id>, basic groups
 * use -<id>, and users use the positive id.  If old metadata has no `kind`,
 * an already-numeric handle is still safe; otherwise we deliberately fall
 * back to the caller's handle instead of guessing the peer type.
 */
function telegramStableTarget(source) {
  if (!source || source.platform !== 'telegram') return null

  const rawExternalId = source.external_id == null
    ? ''
    : String(source.external_id).trim()
  if (!/^-?\d+$/.test(rawExternalId)) return null

  const absoluteId = rawExternalId.startsWith('-100')
    ? rawExternalId.slice(4)
    : rawExternalId.replace(/^-/, '')
  if (!/^\d+$/.test(absoluteId) || !absoluteId) return null

  const kind = String(sourceMeta(source).kind || '').toLowerCase()
  if (kind === 'channel' || kind === 'group') return `-100${absoluteId}`
  if (kind === 'chat') return `-${absoluteId}`
  if (kind === 'user' || kind === 'bot') return absoluteId

  const handle = String(source.handle || '').replace(/^@+/, '').trim()
  return /^-?\d+$/.test(handle) ? handle : null
}

function telegramSourceHealth(source) {
  const value = sourceMeta(source).tg_health
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function isTelegramSourceUnavailable(source) {
  return telegramSourceHealth(source)?.status === 'unavailable'
}

module.exports = {
  TELEGRAM_SOURCE_UNAVAILABLE,
  sourceMeta,
  telegramStableTarget,
  telegramSourceHealth,
  isTelegramSourceUnavailable,
}
