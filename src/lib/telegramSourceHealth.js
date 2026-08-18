export function telegramSourceHealth(source) {
  try {
    const meta = JSON.parse(source?.meta_json || '{}')
    const health = meta?.tg_health
    return health && typeof health === 'object' && !Array.isArray(health)
      ? health
      : null
  } catch {
    return null
  }
}

export function isTelegramSourceUnavailable(source) {
  return telegramSourceHealth(source)?.status === 'unavailable'
}

export function telegramSourceHealthTitle(source) {
  const health = telegramSourceHealth(source)
  if (!health || health.status !== 'unavailable') return ''
  const reason = health.message || 'Telegram больше не отдаёт этот чат выбранному аккаунту.'
  return `${reason} Автозапросы приостановлены; ручной запрос проверит доступ снова.`
}
