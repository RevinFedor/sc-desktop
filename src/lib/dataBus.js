// Tiny invalidation bus for renderer-side data caches.
//
// Why this exists:
//   IPC reads (sourcesList, sourceDetail, itemsList, itemsTopics, itemsTypeBreakdown,
//   senders, …) are per-component useEffects. After a job finishes, the source
//   row counts change — but each component would need its own job:update
//   listener to know when to refetch. We had three already (useSources,
//   SourceDetail.reload, …) and ChatView was missing one — counts went stale.
//
// Pattern: one bus, string keys, one writer (jobInvalidation.js) maps
// job:update events to invalidate(key). Consumers call useInvalidator(key)
// and pass the returned counter into their useEffect deps.
//
// Conventions for keys:
//   'sources'                — global source list (sidebar)
//   'source:<id>'            — single source detail (header / stats / coverage)
//   'items:<id>'             — items list, topics, type breakdown, senders for source <id>
//   'jobs:<id>' / 'jobs:*'   — a single job's history rows / global jobs list
//
// Subscribers can listen to a more specific key OR a wildcard. invalidate()
// notifies the exact key only — for "broad" invalidations call multiple
// invalidate() at the writer site.

const subs = new Map()        // key -> Set<callback>
const counters = new Map()    // key -> int (bumped on invalidate)

export function subscribe(key, fn) {
  let s = subs.get(key)
  if (!s) { s = new Set(); subs.set(key, s) }
  s.add(fn)
  return () => {
    s.delete(fn)
    if (s.size === 0) subs.delete(key)
  }
}

export function invalidate(key) {
  counters.set(key, (counters.get(key) || 0) + 1)
  const s = subs.get(key)
  if (!s) return
  for (const fn of s) {
    try { fn() } catch (err) { console.error('[dataBus] sub threw', err) }
  }
}

/**
 * Bump multiple keys atomically. Same as several invalidate() calls but
 * reads better at the call site:  invalidateMany(['sources', `source:${id}`])
 */
export function invalidateMany(keys) {
  for (const k of keys) invalidate(k)
}

import { useSyncExternalStore } from 'react'

/**
 * React hook — returns an integer that bumps on every invalidate(key).
 * Use it as a useEffect dep:
 *
 *   const ver = useInvalidator(`items:${sourceId}`)
 *   useEffect(() => { refetch() }, [sourceId, ver])
 *
 * Re-rendering the consumer is cheap; the actual refetch only fires when the
 * downstream useEffect runs.
 */
export function useInvalidator(key) {
  return useSyncExternalStore(
    fn => subscribe(key, fn),
    () => counters.get(key) || 0,
    () => 0,
  )
}
