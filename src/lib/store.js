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
  'telegram', 'youtube', 'instagram', 'reddit', 'tiktok', 'twitter',
  'source-detail', 'job-detail', 'settings', 'notes',
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
  // Ephemeral return point for two-click navigation. This intentionally is
  // not persisted: after a reload we can restore the visible canonical
  // route, but must not pretend that it was opened by a click in this run.
  navigationReturn: null,
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
//   source-detail → Home › платформа › источник
//   job-detail    → Home › платформа › источник › job  (source resolved from
//                                                    job.source_id / handle;
//                    sourceless one-shots → Home › job — YouTube paste-flow
//                    runs straight from the Home screen)
//   platform / settings / configs / research → Home › X
//
// Screens NOT listed here keep plain stacking (notes on top of source-detail).
const HOME_ENTRY = { name: 'paste', payload: null }
const PLATFORM_SCREENS = new Set(['telegram', 'youtube', 'instagram', 'reddit', 'tiktok', 'twitter'])

// A toggle destination is slightly broader than a literal {name, payload}:
// - every settings section belongs to the same open Settings surface, so a
//   chip switch cannot erase the page from which Settings was opened;
// - a platform stays the same destination when its local payload changes;
// - source-detail is identified by sourceId, not by incidental payload fields.
function toggleDestination(name, payload) {
  if (name === 'settings') {
    return { key: 'settings', kind: 'screen', name: 'settings' }
  }
  if (PLATFORM_SCREENS.has(name)) {
    return { key: `platform:${name}`, kind: 'screen', name }
  }
  if (name === 'source-detail' && payload?.sourceId != null) {
    return {
      key: `source-detail:${String(payload.sourceId)}`,
      kind: 'source',
      name,
      sourceId: String(payload.sourceId),
    }
  }
  const payloadKey = JSON.stringify(payload ?? null)
  return { key: `${name}:${payloadKey}`, kind: 'exact', name, payloadKey }
}

function destinationContains(destination, screen) {
  if (!destination || !screen || screen.name !== destination.name) return false
  if (destination.kind === 'screen') return true
  if (destination.kind === 'source') {
    return String(screen.payload?.sourceId) === destination.sourceId
  }
  return JSON.stringify(screen.payload ?? null) === destination.payloadKey
}

function retainedNavigationReturn(nextScreen) {
  const current = state.navigationReturn
  return current && destinationContains(current.destination, nextScreen)
    ? current
    : null
}

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
      return PLATFORM_SCREENS.has(platform)
        ? [HOME_ENTRY, { name: platform, payload: null }]
        : [HOME_ENTRY]
    }
    case 'job-detail': {
      const job = payload?.job
      const src = sourceForJob(job)
      if (src) {
        const trail = [HOME_ENTRY]
        if (PLATFORM_SCREENS.has(src.platform)) trail.push({ name: src.platform, payload: null })
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
    case 'telegram':
    case 'youtube':
    case 'instagram':
    case 'reddit':
    case 'tiktok':
    case 'twitter':
    case 'aistudio-job':
    case 'new-research':
      return [HOME_ENTRY]
    case 'settings': {
      const section = payload?.section || 'main'
      return section === 'main'
        ? [HOME_ENTRY]
        : [HOME_ENTRY, { name: 'settings', payload: { section: 'main' } }]
    }
    default:
      return null
  }
}

export function pushScreen(name, payload = null) {
  const canonical = canonicalTrail(name, payload)
  const nextScreen = { name, payload }
  const navigationReturn = retainedNavigationReturn(nextScreen)
  if (canonical) {
    state = {
      ...state,
      history: canonical,
      screen: nextScreen,
      navigationReturn,
    }
  } else if (state.screen.name === name) {
    // Same screen type as current → replace, don't stack. Prevents trail
    // from growing when user clicks notes → notes for another source.
    state = {
      ...state,
      screen: nextScreen,
      navigationReturn,
    }
  } else {
    state = {
      ...state,
      history: [...state.history, state.screen],
      screen: nextScreen,
      navigationReturn,
    }
  }
  emit()
}

/**
 * Two-click navigation used by persistent destinations such as Library
 * platform buttons, source rows and the global Settings button.
 *
 * First click opens the canonical destination and remembers the complete
 * current route. A second click on that same destination restores both the
 * exact source screen and its breadcrumb history. Settings sections form one
 * destination, so switching settings chips keeps the original return point.
 */
export function toggleScreen(name, payload = null) {
  const destination = toggleDestination(name, payload)
  const activeReturn = state.navigationReturn

  if (
    activeReturn?.destination.key === destination.key
    && destinationContains(destination, state.screen)
  ) {
    state = {
      ...state,
      screen: activeReturn.screen,
      history: activeReturn.history,
      navigationReturn: null,
    }
    emit()
    return
  }

  // The screen may have been restored after reload or reached through a
  // breadcrumb. There is no truthful click-origin to return to in that case.
  if (destinationContains(destination, state.screen)) return

  const returnPoint = {
    screen: state.screen,
    history: state.history,
  }
  const canonical = canonicalTrail(name, payload)
  state = {
    ...state,
    history: canonical || [...state.history, state.screen],
    screen: { name, payload },
    navigationReturn: {
      destination,
      ...returnPoint,
    },
  }
  emit()
}

/**
 * Open a concrete Settings section without losing the screen that launched
 * Settings. Switching chips while already inside Settings is ordinary
 * in-surface navigation; entering from anywhere else starts a two-click
 * toggle that the global gear can close back to the exact origin.
 */
export function openSettings(section = 'main') {
  const payload = { section }
  if (state.screen.name === 'settings') {
    pushScreen('settings', payload)
    return
  }
  toggleScreen('settings', payload)
}

export function popScreen() {
  if (!state.history.length) return
  const prev = state.history[state.history.length - 1]
  state = {
    ...state,
    history: state.history.slice(0, -1),
    screen: prev,
    navigationReturn: retainedNavigationReturn(prev),
  }
  emit()
}

export function goHome() {
  state = {
    ...state,
    history: [],
    screen: { name: 'paste', payload: null },
    navigationReturn: null,
  }
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
    navigationReturn: retainedNavigationReturn(target),
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
