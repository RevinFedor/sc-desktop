// Renderer-side jobs store. Subscribes to main-process updates via preload IPC.

import { useSyncExternalStore } from 'react'

let jobs = []                 // [{ id, type, target, status, items_done, items_total, ... }]
const subs = new Set()
let unsubMain = null

function emit() { subs.forEach(fn => fn()) }
function snapshot() { return jobs }

function init() {
  if (unsubMain) return
  if (!window.api) return  // browser preview without preload

  // Pull initial list
  window.api.jobsList().then(list => {
    jobs = list
    emit()
  }).catch(() => {})

  unsubMain = window.api.onJobUpdate(updated => {
    const idx = jobs.findIndex(j => j.id === updated.id)
    if (idx >= 0) {
      jobs = [...jobs.slice(0, idx), updated, ...jobs.slice(idx + 1)]
    } else {
      jobs = [updated, ...jobs]
    }
    // sort: active first (running / awaiting_ai), then most recent finished
    const isActive = s => s === 'running' || s === 'awaiting_ai'
    jobs.sort((a, b) => {
      if (isActive(a.status) && !isActive(b.status)) return -1
      if (isActive(b.status) && !isActive(a.status)) return 1
      return (b.started_at || 0) - (a.started_at || 0)
    })
    emit()
  })
}

export function useJobs() {
  init()
  return useSyncExternalStore(
    fn => { subs.add(fn); return () => subs.delete(fn) },
    snapshot,
    snapshot,
  )
}

export async function startTelegramFetch(params) {
  if (!window.api) {
    console.warn('preload api missing — running in browser preview?')
    return null
  }
  return await window.api.tgFetch(params)
}

export async function resolveTelegramTitle(text) {
  if (!window.api?.tgResolveTitle) return { matches: [], error: 'no_ipc' }
  return await window.api.tgResolveTitle(text)
}

export async function cancelJob(id) {
  if (!window.api) return
  return await window.api.cancelJob(id)
}

// ─── YouTube single-video transcript ──────────────────────────────────
export async function startYoutubeSingle(params) {
  if (!window.api?.ytSingle) return null
  return await window.api.ytSingle(params)
}
export async function resumeYoutubeAi(jobId, engine) {
  if (!window.api?.ytResumeAi) return null
  return await window.api.ytResumeAi({ jobId, engine })
}
export async function lookupYoutubeCache(videoId) {
  if (!window.api?.ytLookupCache) return null
  return await window.api.ytLookupCache(videoId)
}
export async function copyCachedYoutubeFile(filePath) {
  if (!window.api?.ytCopyCachedFile) return { ok: false }
  return await window.api.ytCopyCachedFile(filePath)
}

// ─── YouTube comments ───────────────────────────────────────────────
export async function startYoutubeComments(params) {
  if (!window.api?.ytComments) return null
  return await window.api.ytComments(params)
}
export async function lookupYoutubeCommentsCache(payload) {
  if (!window.api?.ytLookupCommentsCache) return null
  return await window.api.ytLookupCommentsCache(payload)
}
export async function fetchYoutubeItemsCommentsState(payload) {
  if (!window.api?.ytItemsCommentsState) return []
  return await window.api.ytItemsCommentsState(payload)
}
export async function startYoutubeBatchComments(params) {
  if (!window.api?.ytBatchComments) return null
  return await window.api.ytBatchComments(params)
}

// ─── YouTube channel + batch ──────────────────────────────────────────
export async function lookupYoutubeChannel(payload) {
  if (!window.api?.ytChannelLookup) return null
  return await window.api.ytChannelLookup(payload)
}
export async function startYoutubeChannelFetch(params) {
  if (!window.api?.ytChannelFetch) return null
  return await window.api.ytChannelFetch(params)
}
export async function startYoutubeBatchTranscribe(params) {
  if (!window.api?.ytBatchTranscribe) return null
  return await window.api.ytBatchTranscribe(params)
}
export async function fetchYoutubeItemsState(payload) {
  if (!window.api?.ytItemsState) return []
  return await window.api.ytItemsState(payload)
}
export async function ytSearchFetch(params) {
  if (!window.api?.ytSearchFetch) return { items: [], entity: null }
  return await window.api.ytSearchFetch(params)
}
export async function ytResumeBatch(jobId) {
  if (!window.api?.ytResumeBatch) return { ok: false, error: 'no_ipc' }
  return await window.api.ytResumeBatch({ jobId })
}

// ─── TikTok ───────────────────────────────────────────────────────────
export async function lookupTiktokChannel(payload) {
  if (!window.api?.tkChannelLookup) return null
  return await window.api.tkChannelLookup(payload)
}
export async function startTiktokChannelFetch(params) {
  if (!window.api?.tkChannelFetch) return null
  return await window.api.tkChannelFetch(params)
}
export async function startTiktokSingle(params) {
  if (!window.api?.tkSingle) return null
  return await window.api.tkSingle(params)
}
export async function startTiktokBatchTranscribe(params) {
  if (!window.api?.tkBatchTranscribe) return null
  return await window.api.tkBatchTranscribe(params)
}
export async function lookupTiktokCache(videoId) {
  if (!window.api?.tkLookupCache) return null
  return await window.api.tkLookupCache(videoId)
}
export async function copyCachedTiktokFile(filePath) {
  if (!window.api?.tkCopyCachedFile) return { ok: false }
  return await window.api.tkCopyCachedFile(filePath)
}

// ─── Local file ────────────────────────────────────────────────────────
export async function startLocalTranscribe(params) {
  if (!window.api?.localTranscribe) return null
  return await window.api.localTranscribe(params)
}

// ─── Instagram ────────────────────────────────────────────────────────
export async function startInstagramProfileFetch(params) {
  if (!window.api?.igProfileFetch) return null
  return await window.api.igProfileFetch(params)
}
export async function getInstagramSettings() {
  if (!window.api?.igGetSettings) {
    return { metadata_backend: 'api', transcribe_backend: 'api', apify_token_set: false }
  }
  return await window.api.igGetSettings()
}

/** Subscribe to a specific job's snapshot updates. Auto-fetches initial state.
 *
 * Matching identity: a job has TWO independent integer ids — `id` (in-memory,
 * assigned by job-runner's nextId++) and `db_id` (SQLite jobs.id assigned by
 * AUTOINCREMENT). Callers reach watchJob with whichever one they happened to
 * have: ActivityPanel passes the live id from listJobs(); SourceDetail's
 * «История парсинга» passes the DB id from the jobs table. Match against
 * either so a row clicked from history still receives live updates while the
 * job continues running. */
export function watchJob(id, onChange) {
  if (!window.api) return () => {}
  let alive = true
  window.api.jobDetail(id).then(j => alive && j && onChange(j)).catch(() => {})
  const off = window.api.onJobUpdate(updated => {
    if (!alive || !updated) return
    if (updated.id === id || updated.db_id === id) onChange(updated)
  })
  return () => { alive = false; off && off() }
}
