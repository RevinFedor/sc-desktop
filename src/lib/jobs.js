// Renderer-side jobs store. Subscribes to main-process updates via preload IPC.

import { useCallback, useRef, useSyncExternalStore } from 'react'
import { createSelectionCache, findJobByIdentity } from './jobSelectorCore.mjs'

let jobs = []                 // [{ id, type, target, status, items_done, items_total, ... }]
const subs = new Set()
let unsubMain = null

function emit() { subs.forEach(fn => fn()) }
function snapshot() { return jobs }
function subscribe(fn) { subs.add(fn); return () => subs.delete(fn) }

const isActiveStatus = status => (
  status === 'running' || status === 'awaiting_ai' || status === 'cancelling'
)

function sortJobs(list) {
  list.sort((a, b) => {
    if (isActiveStatus(a.status) && !isActiveStatus(b.status)) return -1
    if (isActiveStatus(b.status) && !isActiveStatus(a.status)) return 1
    return (b.started_at || 0) - (a.started_at || 0)
  })
  return list
}

function upsertJob(updated) {
  const idx = jobs.findIndex(job => job.id === updated.id)
  if (idx < 0) {
    jobs = sortJobs([updated, ...jobs])
    return
  }
  const previous = jobs[idx]
  const rankChanged = isActiveStatus(previous.status) !== isActiveStatus(updated.status)
    || previous.started_at !== updated.started_at
  jobs = [...jobs.slice(0, idx), updated, ...jobs.slice(idx + 1)]
  if (rankChanged) sortJobs(jobs)
}

function init() {
  if (unsubMain) return
  if (!window.api) return  // browser preview without preload

  // Subscribe before hydration. A fast job can emit while jobsList() is in
  // flight; overlay those updates onto the initial DB snapshot instead of
  // letting the older response roll live progress backwards.
  let hydrating = true
  const duringHydration = new Map()
  unsubMain = window.api.onJobUpdate(updated => {
    if (hydrating) duringHydration.set(`${typeof updated.id}:${String(updated.id)}`, updated)
    upsertJob(updated)
    emit()
  })

  window.api.jobsList().then(list => {
    const merged = Array.isArray(list) ? [...list] : []
    for (const updated of duringHydration.values()) {
      const idx = merged.findIndex(job => job.id === updated.id)
      if (idx >= 0) merged[idx] = updated
      else merged.push(updated)
    }
    hydrating = false
    duringHydration.clear()
    jobs = sortJobs(merged)
    emit()
  }).catch(() => {
    hydrating = false
    duringHydration.clear()
  })
}

export function useJobs() {
  return useJobsSelector(value => value)
}

/**
 * Subscribe to a projection of the jobs list.
 *
 * Unlike `useJobs().filter(...)`, an unrelated job update does not re-render
 * the component when `equality` says that its selected projection is
 * unchanged. This is load-bearing for large Telegram lists: a hidden child
 * fetch must not wake TelegramScreen, ChatView, LibrarySidebar and every
 * closed popover four times per second.
 */
export function useJobsSelector(selector, equality = Object.is) {
  init()
  const selectorRef = useRef(selector)
  selectorRef.current = selector
  const equalityRef = useRef(equality)
  equalityRef.current = equality
  const cacheRef = useRef(null)
  if (cacheRef.current == null) {
    cacheRef.current = createSelectionCache((a, b) => equalityRef.current(a, b))
  }
  const getSelectedSnapshot = useCallback(
    () => cacheRef.current.select(snapshot(), selectorRef.current),
    [],
  )
  return useSyncExternalStore(
    subscribe,
    getSelectedSnapshot,
    getSelectedSnapshot,
  )
}

export function useJob(jobId) {
  return useJobsSelector(
    list => findJobByIdentity(list, jobId),
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

export async function cancelJob(id, options = {}) {
  if (!window.api) return
  return await window.api.cancelJob({ id, ...options })
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
export async function copyYoutubeWithTimestamps(params) {
  if (!window.api?.ytCopyWithTimestamps) return { ok: false, error: 'no_ipc' }
  return await window.api.ytCopyWithTimestamps(params)
}

// ─── Rutube single-video transcript ──────────────────────────────────
export async function startRutubeSingle(params) {
  if (!window.api?.rutubeSingle) return null
  return await window.api.rutubeSingle(params)
}
export async function resumeRutubeAi(jobId, engine) {
  if (!window.api?.rutubeResumeAi) return null
  return await window.api.rutubeResumeAi({ jobId, engine })
}
export async function lookupRutubeCache(videoId) {
  if (!window.api?.rutubeLookupCache) return null
  return await window.api.rutubeLookupCache(videoId)
}
export async function copyCachedRutubeFile(filePath) {
  if (!window.api?.rutubeCopyCachedFile) return { ok: false }
  return await window.api.rutubeCopyCachedFile(filePath)
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

// ─── Boosty single video ──────────────────────────────────────────────
export async function startBoostySingle(params) {
  if (!window.api?.boostySingle) return null
  return await window.api.boostySingle(params)
}
export async function lookupBoostyChannel(payload) {
  if (!window.api?.boostyChannelLookup) return null
  return await window.api.boostyChannelLookup(payload)
}
export async function startBoostyChannelFetch(params) {
  if (!window.api?.boostyChannelFetch) return null
  return await window.api.boostyChannelFetch(params)
}
export async function previewBoostyPost(params) {
  if (!window.api?.boostyPostPreview) return null
  return await window.api.boostyPostPreview(params)
}
export async function startBoostyBatchTranscribe(params) {
  if (!window.api?.boostyBatchTranscribe) return null
  return await window.api.boostyBatchTranscribe(params)
}

// ─── Instagram ────────────────────────────────────────────────────────
export async function startInstagramProfileFetch(params) {
  if (!window.api?.igProfileFetch) return null
  return await window.api.igProfileFetch(params)
}
export async function lookupInstagramReel(payload) {
  if (!window.api?.igLookupReel) return null
  return await window.api.igLookupReel(payload)
}
export async function startInstagramBatchTranscribe(params) {
  if (!window.api?.igBatchTranscribe) return null
  return await window.api.igBatchTranscribe(params)
}
const instagramSettingsInflight = new Map()
export async function getInstagramSettings(options = {}) {
  if (!window.api?.igGetSettings) {
    return { metadata_backend: 'api', transcribe_backend: 'api', apify_token_set: false }
  }
  const key = `${options.validateToken === true ? 'validate' : 'basic'}:${options.force === true ? 'force' : 'cached'}`
  if (instagramSettingsInflight.has(key)) return instagramSettingsInflight.get(key)
  const promise = window.api.igGetSettings(options).finally(() => {
    if (instagramSettingsInflight.get(key) === promise) instagramSettingsInflight.delete(key)
  })
  instagramSettingsInflight.set(key, promise)
  return promise
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
