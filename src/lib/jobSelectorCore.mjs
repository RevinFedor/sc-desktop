// Pure selector helpers for the renderer jobs store.
//
// Keep this module React-free so its reference-stability contract can be
// covered with node:test.  useSyncExternalStore treats a fresh array/object as
// a changed snapshot even when it contains the same rows; selectors that
// filter jobs therefore need an equality function that can retain the previous
// reference on unrelated job updates.

export const EMPTY_JOBS = Object.freeze([])

export function sameArrayItems(a, b) {
  if (a === b) return true
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

export function jobsForSource(jobs, sourceId, { activeOnly = false } = {}) {
  if (sourceId == null) return EMPTY_JOBS
  const wanted = Number(sourceId)
  return jobs.filter(job => {
    if (!job || Number(job.source_id) !== wanted) return false
    if (!activeOnly) return true
    return job.status === 'running' || job.status === 'awaiting_ai' || job.status === 'cancelling'
  })
}

export function activeVisibleJobs(jobs, isVisible) {
  return jobs.filter(job => (
    isVisible(job)
    && (job.status === 'running' || job.status === 'awaiting_ai' || job.status === 'cancelling')
  ))
}

export function findJobByIdentity(jobs, jobId) {
  if (jobId == null) return null
  return jobs.find(job => job?.id === jobId)
    || jobs.find(job => job?.db_id === jobId)
    || null
}

/**
 * Memoise a selector by source snapshot + equality.
 *
 * The returned function is deliberately framework-agnostic. React's hook
 * keeps one instance in a ref and calls select(jobs, selector) from
 * getSnapshot(). When an unrelated job changes, `sameArrayItems` lets us
 * return the exact previous array reference and suppress the component render.
 */
export function createSelectionCache(equality = Object.is) {
  let hasValue = false
  let source = null
  let selector = null
  let value

  return {
    select(nextSource, nextSelector) {
      if (hasValue && source === nextSource && selector === nextSelector) return value
      const nextValue = nextSelector(nextSource)
      if (!hasValue || !equality(value, nextValue)) value = nextValue
      source = nextSource
      selector = nextSelector
      hasValue = true
      return value
    },
    reset() {
      hasValue = false
      source = null
      selector = null
      value = undefined
    },
  }
}
