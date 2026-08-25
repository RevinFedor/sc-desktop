// Renderer-side cache for the Telegram folders list. Same pattern as
// `sources.js` — one IPC pull, refreshed when the dataBus 'folders' key
// is invalidated. Kept tiny because the use sites are read-only:
// ActivityPanel needs (id → title) lookup, TelegramScreen renders the tab
// row from its own state.

import { useSyncExternalStore } from 'react'
import { subscribe as busSubscribe, invalidate } from './dataBus'
import { createRefreshCoordinator } from './refreshCoordinator.mjs'

let folders = []
const subs = new Set()
let inited = false

function emit() { subs.forEach(fn => fn()) }
function snapshot() { return folders }

async function pullFolders() {
  if (!window.api?.folderList) return
  try {
    folders = await window.api.folderList() || []
    emit()
  } catch (err) {
    console.error('[folders] refresh failed', err)
  }
}

const refreshCoordinator = createRefreshCoordinator(pullFolders)
let latestRefresh = Promise.resolve()
function refresh() {
  latestRefresh = refreshCoordinator.request()
  return latestRefresh
}

function init() {
  if (inited) return
  inited = true
  refresh()
  busSubscribe('folders', refresh)
}

export function useFolders() {
  init()
  return useSyncExternalStore(
    fn => { subs.add(fn); return () => subs.delete(fn) },
    snapshot,
    snapshot,
  )
}

export function refreshFolders() {
  if (!inited) {
    init()
    return latestRefresh
  }
  invalidate('folders')
  return latestRefresh
}
