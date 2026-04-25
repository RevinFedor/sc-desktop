// Global toast store. Single source of truth for transient, context-free
// notifications — the kind that must be seen regardless of which screen the
// user is on (e.g. "session deauthorized", "fetch failed"). Mirrors the
// custom-terminal toast contract but in this project's useSyncExternalStore
// idiom (no zustand here).
//
// Design rule (methodology/переносимый-дизайн.md::Единая форма для уведомлений
// одного домена): one component, one geometry — only icon + border-color vary
// by `type`. Don't fork a second "card" variant for longer text; truncate.
//
// When to use a toast vs progress-in-button (same doc, ::Прогресс на источнике
// клика): toasts are for cross-cutting conditions independent of scroll/hover
// ("what's true about my whole session right now"), NOT for long per-element
// progress (that lives in the element). A deauthorized Telegram session is the
// canonical toast case — it breaks every Telegram op, not one row.

import { useSyncExternalStore } from 'react'

let toasts = []          // [{ id, type, message, actionLabel, onAction, dedupeKey }]
let nextId = 1
const subs = new Set()
const timers = new Map()  // id -> timeout handle

function emit() {
  toasts = [...toasts]   // fresh identity for useSyncExternalStore
  for (const fn of subs) fn()
}

function subscribe(fn) { subs.add(fn); return () => subs.delete(fn) }
function getSnapshot() { return toasts }

/**
 * Show a toast.
 *
 * @param {object} opts
 *   message      — text (required). Long text ellipsis-truncates in the host.
 *   type         — 'error' | 'warning' | 'success' | 'info'. Default 'info'.
 *   duration     — ms before auto-dismiss. 0 / null = persistent (✕ only).
 *                  Errors default to persistent (the user must act on them).
 *   actionLabel  — optional inline action text (e.g. «Настройки»).
 *   onAction     — callback for the action; toast dismisses after it runs.
 *   dedupeKey    — when set, a new toast with the same key replaces/refreshes
 *                  the existing one instead of stacking. Use for conditions
 *                  that can fire repeatedly (every failed fetch of a deauthed
 *                  session) so the corner never piles up duplicates.
 * @returns id
 */
export function showToast({
  message, type = 'info', duration, actionLabel, onAction, dedupeKey,
} = {}) {
  if (!message) return null
  // Persistent unless an explicit positive duration is given. Errors stay
  // until dismissed; transient confirmations pass duration:2500.
  const isPersistent = !(typeof duration === 'number' && duration > 0)

  // Dedupe: drop any prior toast with the same key (and its timer) before
  // inserting the refreshed one — keeps the corner from stacking repeats.
  if (dedupeKey) {
    for (const t of toasts) {
      if (t.dedupeKey === dedupeKey) {
        const h = timers.get(t.id)
        if (h) { clearTimeout(h); timers.delete(t.id) }
      }
    }
    toasts = toasts.filter(t => t.dedupeKey !== dedupeKey)
  }

  const id = nextId++
  toasts = [...toasts, { id, type, message, actionLabel, onAction, dedupeKey }]
  emit()

  if (!isPersistent) {
    const h = setTimeout(() => dismissToast(id), duration)
    timers.set(id, h)
  }
  return id
}

export function dismissToast(id) {
  const h = timers.get(id)
  if (h) { clearTimeout(h); timers.delete(id) }
  toasts = toasts.filter(t => t.id !== id)
  emit()
}

export function useToasts() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
