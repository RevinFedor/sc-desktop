// Trivial in-memory navigation + recents store.
// Will be replaced with SQLite-backed selectors at Checkpoint 3.

import { useSyncExternalStore } from 'react'
import { getSources } from './sources'

// Restore last screen + history across page reload (Cmd+R / dev hmr full
// reload). Without this any reload kicks the user back to Home — confusing
// when they were mid-flow on a folder tab or a chat detail.
//
// Whitelist of screens safe to restore — we don't want to rehydrate
// half-finished flows like 'tg-config' (mid-fetch state, payload may be
// stale). 'source-detail', 'telegram', 'job-detail' are deterministic
// reads of DB state — re-rendering them is safe.
const RESTORABLE_SCREENS = new Set([
  'telegram', 'source-detail', 'job-detail',
  'tg-settings', 'ig-settings', 'settings', 'notes',
  'aistudio-job',
])
const SCREEN_KEY = 'sc-current-screen'

function loadRestoredScreen() {
  try {
    const raw = localStorage.getItem(SCREEN_KEY)
    if (!raw) return null
    const data = JSON.parse(raw)
    if (!data || !RESTORABLE_SCREENS.has(data?.screen?.name)) return null
    return data
  } catch { return null }
}

const restored = loadRestoredScreen()

const initial = {
  screen: restored?.screen || { name: 'paste', payload: null },
  history: Array.isArray(restored?.history) ? restored.history : [],
  recents: [],            // [{ id, label, kind, target, addedAt }]
  // Paste-screen draft state. Survives navigation away & back so the user
  // returns to the same input + chip pick they had before. Cleared only by
  // explicit clearInput() or by typing/pasting fresh text.
  paste: { value: '', committed: null },
  // Right-side Activity panel — collapsed by default, opened from TitleBar.
  // Closes on any click in the central content area.
  activityOpen: false,
}

let state = initial

// Persist (current screen + history) on every navigation change. Other
// fields are ephemeral — recents will be re-built; paste-draft re-init from
// PasteScreen state on first visit.
function persistScreen() {
  try {
    if (state.screen.name === 'paste' && state.history.length === 0) {
      localStorage.removeItem(SCREEN_KEY)
    } else {
      localStorage.setItem(SCREEN_KEY, JSON.stringify({
        screen:  state.screen,
        history: state.history,
      }))
    }
  } catch {}
}
const subs = new Set()

function emit() {
  // Persist navigation state so reload (Cmd+R / dev hmr) lands the user on
  // the same screen instead of jumping to Home. Cheap — single localStorage
  // write per navigation event, much less frequent than React renders.
  persistScreen()
  subs.forEach(s => s())
}
function subscribe(fn) { subs.add(fn); return () => subs.delete(fn) }

export function useStore(selector = s => s) {
  return useSyncExternalStore(subscribe, () => selector(state), () => selector(state))
}

// Screens whose breadcrumb trail is CANONICAL — derived from what the screen
// shows, not from the click-path that led there. Stacking job-detail on top
// of whatever happened to be open produced nonsense trails like
// «Home › AI Studio Job › Telegram fetch» (clicked from the Activity panel
// while a research page was open). The entity hierarchy is deterministic:
//
//   source-detail → Home › [Telegram] › чат        (platform screen only
//                                                    exists for Telegram)
//   job-detail    → Home › [Telegram] › чат › job  (source resolved from
//                                                    job.source_id / handle;
//                    sourceless one-shots → Home › job — YouTube paste-flow
//                    runs straight from the Home screen)
//   telegram / settings / configs / research → Home › X
//
// Screens NOT listed here keep plain stacking (notes on top of source-detail,
// tg-settings on top of telegram — Home › Telegram › Сессии).
const HOME_ENTRY = { name: 'paste', payload: null }

// Resolve the library source a job belongs to. Mirrors ActivityPanel's
// matching: prefer source_id; tg_* jobs fall back to handle (live tg_fetch
// snapshots may carry only the target). Returns null for one-shot jobs.
function sourceForJob(job) {
  if (!job) return null
  const sources = getSources()
  if (job.source_id != null) {
    return sources.find(s => s.id === job.source_id) || null
  }
  if (String(job.type || '').startsWith('tg_')) {
    const h = String(job.target || '').replace(/^@/, '')
    if (h) return sources.find(s => s.platform === 'telegram' && s.handle === h) || null
  }
  return null
}

// Canonical history for a screen, or null → default stacking behaviour.
function canonicalTrail(name, payload) {
  switch (name) {
    case 'paste':
      return []                                   // home itself — empty trail
    case 'source-detail': {
      const src = getSources().find(s => s.id === payload?.sourceId)
      const platform = payload?.platform || src?.platform
      return platform === 'telegram'
        ? [HOME_ENTRY, { name: 'telegram', payload: null }]
        : [HOME_ENTRY]
    }
    case 'job-detail': {
      const job = payload?.job
      const src = sourceForJob(job)
      if (src) {
        const trail = [HOME_ENTRY]
        if (src.platform === 'telegram') trail.push({ name: 'telegram', payload: null })
        trail.push({ name: 'source-detail', payload: { sourceId: src.id, platform: src.platform } })
        return trail
      }
      // Folder umbrellas / refreshes have no single source but live on the
      // Telegram screen — keep the platform level in the trail.
      if (String(job?.type || '').startsWith('tg_')) {
        return [HOME_ENTRY, { name: 'telegram', payload: null }]
      }
      return [HOME_ENTRY]
    }
    case 'tg-config':
    case 'yt-config':
    case 'ig-config':
    case 'ig-settings':
    case 'telegram':
    case 'settings':
    case 'aistudio-job':
    case 'new-research':
      return [HOME_ENTRY]
    default:
      return null
  }
}

export function pushScreen(name, payload = null) {
  const canonical = canonicalTrail(name, payload)
  if (canonical) {
    state = {
      ...state,
      history: canonical,
      screen: { name, payload },
    }
  } else if (state.screen.name === name) {
    // Same screen type as current → replace, don't stack. Prevents trail
    // from growing when user clicks notes → notes for another source.
    state = {
      ...state,
      screen: { name, payload },
    }
  } else {
    state = {
      ...state,
      history: [...state.history, state.screen],
      screen: { name, payload },
    }
  }
  emit()
}

export function popScreen() {
  if (!state.history.length) return
  const prev = state.history[state.history.length - 1]
  state = {
    ...state,
    history: state.history.slice(0, -1),
    screen: prev,
  }
  emit()
}

export function goHome() {
  state = { ...state, history: [], screen: { name: 'paste', payload: null } }
  emit()
}

/**
 * Jump to a specific point in the breadcrumb trail.
 *   index = -1 → home (clears history, switches to paste).
 *   index ∈ [0, history.length-1] → make history[index] the current screen,
 *   trim everything after it.  Index === history.length is a no-op (= current).
 */
export function navigateTo(index) {
  if (index === -1) return goHome()
  if (!Number.isInteger(index) || index < 0) return
  if (index >= state.history.length) return       // already at or past current
  const target = state.history[index]
  state = {
    ...state,
    history: state.history.slice(0, index),
    screen: target,
  }
  emit()
}

export function setPasteState(patch) {
  state = { ...state, paste: { ...state.paste, ...patch } }
  emit()
}

export function toggleActivity() {
  state = { ...state, activityOpen: !state.activityOpen }
  emit()
}

export function closeActivity() {
  if (!state.activityOpen) return
  state = { ...state, activityOpen: false }
  emit()
}

export function rememberRecent(detection) {
  const id = `${detection.platform || '?'}:${detection.target}`
  const rest = state.recents.filter(r => r.id !== id)
  state = {
    ...state,
    recents: [
      { id, label: detection.target, kind: detection.kind, platform: detection.platform, addedAt: Date.now() },
      ...rest,
    ].slice(0, 12),
  }
  emit()
}
