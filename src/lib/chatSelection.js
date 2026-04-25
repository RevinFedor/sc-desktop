// ChatView message multi-select store.
//
// Same shape and semantics as lib/telegramSelection.js (the sidebar's
// chat-selection store), but scoped to message rows inside one open source's
// ChatView. State is { ids: Set<number>, anchor: number|null } and lives
// outside React so the bulk-action bar, the per-row checkboxes and any future
// "selected messages" badge all observe one source of truth.
//
// `anchor` is the last single-toggle target — Shift-click fills the range
// between anchor and the new id using the ordered list of currently visible
// message ids (passed in by ChatView, since the order is "newest first" in the
// DOM but we want a contiguous run regardless of direction).
//
// We keep a single module-level store rather than one-per-source: ChatView
// already resets it whenever the source changes (see clear() call keyed on
// sourceId), exactly like telegramSelection is pruned on sidebar re-render.

import { useSyncExternalStore } from 'react'

let state = { ids: new Set(), anchor: null }
const subs = new Set()

function emit() {
  // New identity each emit so useSyncExternalStore picks up the change.
  state = { ids: new Set(state.ids), anchor: state.anchor }
  for (const fn of subs) fn()
}

function subscribe(fn) { subs.add(fn); return () => subs.delete(fn) }
function getSnapshot() { return state }

function has(id)  { return state.ids.has(id) }
function list()   { return [...state.ids] }
function clear()  {
  if (state.ids.size === 0 && state.anchor == null) return
  state.ids.clear(); state.anchor = null; emit()
}
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
  // Anchor missing → behave like a single add (no range to fill).
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
  // Anchor stays put — repeated Shift-click extends from the same start.
  emit()
}
function pruneTo(visibleSet) {
  let changed = false
  for (const id of [...state.ids]) {
    if (!visibleSet.has(id)) { state.ids.delete(id); changed = true }
  }
  if (state.anchor != null && !visibleSet.has(state.anchor)) {
    state.anchor = null; changed = true
  }
  if (changed) emit()
}

// React hook: reactive ids/size via useSyncExternalStore + the same imperative
// API every caller uses.
export function useChatSelection() {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return {
    ids:    snap.ids,
    anchor: snap.anchor,
    size:   snap.ids.size,
    has, list, clear, replace, toggle, rangeTo, pruneTo,
  }
}

export function getChatSelection() { return state }
