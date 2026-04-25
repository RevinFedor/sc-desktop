// Telegram-sidebar multi-select store.
//
// State is tiny — { ids: Set<number>, anchor: number|null } — but lives
// outside React so the sidebar, the context-menu, and any future "selected
// chats" badge can all observe the same source of truth without prop-drilling.
// `anchor` is the last «single click / single-toggle target» — shift-click
// fills the range between anchor and the new id using the ordered list of
// currently visible Telegram sources (passed in by the sidebar).

import { useSyncExternalStore } from 'react'

let state = { ids: new Set(), anchor: null }
const subs = new Set()

function emit() {
  // New identity each emit so React useSyncExternalStore picks up changes.
  state = { ids: new Set(state.ids), anchor: state.anchor }
  for (const fn of subs) fn()
}

function subscribe(fn) { subs.add(fn); return () => subs.delete(fn) }
function getSnapshot() { return state }

function has(id)         { return state.ids.has(id) }
function size()          { return state.ids.size }
function list()          { return [...state.ids] }
function clear()         { state.ids.clear(); state.anchor = null; emit() }
function replace(ids) {
  state.ids = new Set(ids)
  state.anchor = ids.length ? ids[ids.length - 1] : null
  emit()
}
function toggle(id) {
  if (state.ids.has(id)) state.ids.delete(id)
  else                   state.ids.add(id)
  state.anchor = id
  emit()
}
function rangeTo(id, orderedIds) {
  if (!Array.isArray(orderedIds) || !orderedIds.length) return
  // Anchor missing → behave like a single toggle (no range to fill).
  if (state.anchor == null) {
    state.ids.add(id)
    state.anchor = id
    emit()
    return
  }
  const a = orderedIds.indexOf(state.anchor)
  const b = orderedIds.indexOf(id)
  if (a === -1 || b === -1) {
    state.ids.add(id)
    state.anchor = id
    emit()
    return
  }
  const [lo, hi] = a < b ? [a, b] : [b, a]
  for (let i = lo; i <= hi; i++) state.ids.add(orderedIds[i])
  // Anchor stays where it was — repeated shift-click extends the range from
  // the same starting point, not from the most recent shift target.
  emit()
}
// Set anchor only — does NOT add the id to the selection set and does NOT
// emit (anchor isn't rendered). Used by plain-click navigation so the NEXT
// shift-click has a starting point even though nothing is visually selected.
function setAnchorOnly(id) {
  state.anchor = id
}
function pruneTo(visibleSet) {
  let changed = false
  for (const id of [...state.ids]) {
    if (!visibleSet.has(id)) {
      state.ids.delete(id)
      changed = true
    }
  }
  if (state.anchor != null && !visibleSet.has(state.anchor)) {
    state.anchor = null
    changed = true
  }
  if (changed) emit()
}

// React hook: returns the same imperative API every caller already uses,
// plus reactive size/ids via useSyncExternalStore.
export function useTelegramSelection() {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return {
    ids:     snap.ids,
    anchor:  snap.anchor,
    size:    snap.ids.size,
    has,
    list,
    clear,
    replace,
    toggle,
    rangeTo,
    pruneTo,
    setAnchorOnly,
  }
}

// Non-hook accessor — for callers that only need a one-shot read.
export function getTelegramSelection() { return state }
