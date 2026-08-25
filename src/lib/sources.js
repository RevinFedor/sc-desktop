// Renderer-side cache for sources list. Refreshes whenever something
// invalidates the 'sources' key on the data bus (driven centrally by
// jobInvalidation.js — no per-component IPC listeners). Manual refresh()
// also bumps the same key.

import { useSyncExternalStore } from 'react'
import { subscribe as busSubscribe, invalidate } from './dataBus'
import { createRefreshCoordinator } from './refreshCoordinator.mjs'

let sources = []
let firstLoadDone = false   // false until the first sourcesList() resolves
const subs = new Set()
let inited = false

function emit() { subs.forEach(fn => fn()) }
function snapshot() { return sources }
export function isLoaded() { return firstLoadDone }

async function pullSources() {
  if (!window.api) return
  try {
    sources = await window.api.sourcesList()
    firstLoadDone = true
    emit()
  } catch (err) {
    console.error('sources refresh failed', err)
  }
}

const refreshCoordinator = createRefreshCoordinator(pullSources)
let latestRefresh = Promise.resolve()

function refresh() {
  latestRefresh = refreshCoordinator.request()
  return latestRefresh
}

function init() {
  if (inited) return
  inited = true
  refresh()
  // Anything bumping 'sources' (jobInvalidation.js on terminal status, or
  // a manual refreshSources()) triggers a re-pull.
  busSubscribe('sources', refresh)
}

// Per-platform filter cache. useSyncExternalStore demands a stable getSnapshot
// — returning a fresh array on every call (e.g. `arr.filter(...)`) makes React
// think state keeps changing and triggers an infinite re-render loop. We
// memoise (sources ref, platform) → filtered array so consecutive calls with
// the same inputs return the same reference. Cleared whenever refresh()
// replaces `sources`.
const filterCache = new Map()   // platform -> { src, out }

export function useSources(platform = null) {
  init()
  const getSnapshot = () => {
    const all = snapshot()
    if (!platform) return all
    const cached = filterCache.get(platform)
    if (cached && cached.src === all) return cached.out
    const out = all.filter(s => s.platform === platform)
    filterCache.set(platform, { src: all, out })
    return out
  }
  return useSyncExternalStore(
    fn => { subs.add(fn); return () => subs.delete(fn) },
    getSnapshot,
    getSnapshot,
  )
}

// Manual refresh button — bumps 'sources' so any listening hook reloads,
// not just useSources. Single source of truth.
export function refreshSources() {
  if (!inited) {
    init()
    return latestRefresh
  }
  // invalidate() notifies the bus synchronously, so its subscriber has already
  // assigned latestRefresh when this function returns. Do not call refresh()
  // a second time — that old pattern issued duplicate full-library queries.
  invalidate('sources')
  return latestRefresh
}

// Non-hook snapshot — for plain-JS modules (store.js canonical breadcrumbs)
// that need to resolve a source's platform outside React render.
export function getSources() { return sources }

// Hook: are we past the first sourcesList() resolve? Used by Sidebar to
// distinguish empty DB ("No sources yet") from "still fetching" (skeleton).
export function useSourcesLoaded() {
  return useSyncExternalStore(
    fn => { subs.add(fn); return () => subs.delete(fn) },
    () => firstLoadDone,
    () => false,
  )
}
