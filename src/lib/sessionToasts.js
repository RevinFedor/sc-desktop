// Bridges structural job errors → global toasts. Mounted once in App.jsx via
// wireSessionToasts(). Kept separate from jobInvalidation.js: that module maps
// job updates to dataBus cache keys (a data concern); this one maps them to
// user-facing notifications (a UX concern). One listener each, no coupling.
//
// Today it handles exactly one code — session_unauthorized — the cross-cutting
// condition the design doc calls a textbook toast case (breaks every Telegram
// op, independent of which screen you're on). New structural codes get a new
// branch here, not a new listener.

import { showToast } from './toast'
import { openSettings } from './store'

let wired = false

export function wireSessionToasts() {
  if (wired) return
  if (!window.api?.onJobUpdate) return
  wired = true

  window.api.onJobUpdate(j => {
    if (!j) return
    const terminal = j.status === 'error' || j.status === 'cancelled' || j.status === 'done'
    if (!terminal) return

    if (j.error_code === 'session_unauthorized') {
      showToast({
        type: 'error',
        message: j.error
          || 'Telegram-сессия не авторизована — нужно войти заново.',
        actionLabel: 'Открыть настройки Telegram',
        onAction: () => openSettings('telegram'),
        // One toast for the condition, not one per failed chat/job. A folder
        // catch-up that fails N children with the same deauth refreshes the
        // single existing toast instead of stacking N copies.
        dedupeKey: 'session_unauthorized',
      })
    }
  })
}
