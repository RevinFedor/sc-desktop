import { useSyncExternalStore } from 'react'

let state = {
  status: 'unknown',
  enabled: false,
  username: null,
  active_tasks: 0,
  allowed_chat_count: 0,
  last_error: null,
}
const subs = new Set()
let unsubMain = null

function emit() { subs.forEach(fn => fn()) }
function snapshot() { return state }

function init() {
  if (unsubMain) return
  if (!window.api?.telegramBotState) return

  window.api.telegramBotState()
    .then(next => {
      if (next) {
        state = next
        emit()
      }
    })
    .catch(() => {})

  unsubMain = window.api.onTelegramBotUpdate?.(next => {
    if (!next) return
    state = next
    emit()
  }) || null
}

export function useTelegramBotState() {
  init()
  return useSyncExternalStore(
    fn => { subs.add(fn); return () => subs.delete(fn) },
    snapshot,
    snapshot,
  )
}
