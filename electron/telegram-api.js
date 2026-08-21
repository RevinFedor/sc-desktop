// Один транспорт к Telegram Bot API для всех отправителей приложения:
// уведомления о завершении вкладок Custom Terminal и письма из почты.
// Здесь только вызов и распознавание ошибок; повторы и очередь — на стороне
// конкретного сервиса, потому что у них разные требования к порядку доставки.

function createTelegramApi({ fetchImpl = globalThis.fetch } = {}) {
  return async function telegramApi(method, payload, token) {
    if (!token) {
      const err = new Error('Telegram bot token is not configured')
      err.code = 'telegram_bot_not_configured'
      throw err
    }
    let response
    try {
      response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    } catch (err) {
      err.telegramNetworkError = true
      throw err
    }
    let data = null
    try { data = await response.json() } catch {}
    if (!response.ok || !data?.ok) {
      const err = new Error(data?.description || `HTTP ${response.status}`)
      err.httpStatus = response.status
      err.telegram = data
      err.telegramErrorCode = Number(data?.error_code) || null
      err.retryAfterSec = Number(data?.parameters?.retry_after) || null
      throw err
    }
    return data.result
  }
}

module.exports = { createTelegramApi }
