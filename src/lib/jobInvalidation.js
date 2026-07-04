// Single global listener that translates IPC `job:update` events into
// dataBus invalidation keys. Call wireJobInvalidation() exactly once at app
// startup (App.jsx). Adding a new job type? Just add a case here — every
// hook subscribed to the matching key auto-refetches.
//
// Granularity matters: a tg_fetch on 5 000 messages emits ~50 page updates.
// If every one of those bumped 'sources' / 'source:<id>' / 'items:<id>',
// SourceDetail and ChatView would refetch + re-render 50× — visible as
// scroll jitter and choked DB I/O. So:
//
//   terminal (done/error/cancelled) → bump everything; saved counts and
//                                     coverage just landed.
//   progressing (running)           → bump only 'jobs:<id>' so the active
//                                     row in "История парсинга" can flip
//                                     its status / items_done. Sidebar &
//                                     items list deliberately don't move
//                                     while a fetch is mid-flight.
//
// And we throttle the progressing path to once per ~750 ms per job — even
// on a fast network the user can't read counters that change 5×/sec, and
// we save the DB the round-trips.

import { invalidateMany } from './dataBus'

let wired = false
const lastProgressBump = new Map()  // jobId -> ms

export function wireJobInvalidation() {
  if (wired) return
  if (!window.api?.onJobUpdate) return
  wired = true

  window.api.onJobUpdate(j => {
    if (!j) return
    const terminal = j.status === 'done' || j.status === 'error' || j.status === 'cancelled'
    const progressing = j.status === 'running' || j.status === 'awaiting_ai'
    if (!terminal && !progressing) return

    if (terminal) {
      lastProgressBump.delete(j.id)
      // Child tg_fetch jobs inside tg_catchup/tg_folder_fetch can finish dozens
      // of times in one batch. Refreshing the global sources list on each child
      // is a main-process DB storm; the umbrella job will bump `sources` once at
      // the end. Keep source-specific keys for the currently open SourceDetail.
      const insideUmbrella = !!j.params?._folder_umbrella_id
      const keys = insideUmbrella ? [] : ['sources']
      if (j.source_id) {
        keys.push(`source:${j.source_id}`, `items:${j.source_id}`, `jobs:${j.source_id}`)
      }
      // Folder-umbrella close → refresh folders list (last_fetched_at moved).
      if (j.type === 'tg_folder_fetch') keys.push('folders')
      if (keys.length) invalidateMany(keys)
      return
    }

    // progressing — only the per-source jobs list, throttled.
    if (!j.source_id) return
    const now = Date.now()
    const prev = lastProgressBump.get(j.id) || 0
    if (now - prev < 750) return
    lastProgressBump.set(j.id, now)
    invalidateMany([`jobs:${j.source_id}`])
  })
}
