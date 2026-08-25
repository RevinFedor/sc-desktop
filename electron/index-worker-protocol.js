'use strict'

const BATCH_SIZE = 100
const CONTEXT_NEIGHBORS = 5
const RPM_TARGET = 2400
const RPM_WINDOW_MS = 60_000
const TERMINAL_STATUSES = new Set(['done', 'error', 'cancelled'])

function normalizeSourceId(value) {
  const sourceId = Number(value)
  if (!Number.isSafeInteger(sourceId) || sourceId <= 0) {
    throw new Error('sourceId required')
  }
  return sourceId
}

function normalizeLimit(value) {
  if (value == null || value === '') return null
  const limit = Number(value)
  if (!Number.isFinite(limit) || limit <= 0) return null
  return Math.max(1, Math.floor(limit))
}

function normalizeOrigin(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : 'unknown'
}

function normalizeStartRequest({ sourceId, limit, origin } = {}) {
  return {
    sourceId: normalizeSourceId(sourceId),
    limit: normalizeLimit(limit),
    origin: normalizeOrigin(origin),
  }
}

function nonNegativeInt(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback
}

function nullablePositiveInt(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

function createStartingState({ id, sourceId, startedAt = null }) {
  return {
    id,
    dbRowId: null,
    source_id: sourceId,
    phase: 'starting',
    status: 'running',
    items_done: 0,
    items_total: 0,
    initial_indexed: 0,
    error: null,
    started_at: startedAt,
    finished_at: null,
    target: null,
  }
}

function applyWorkerMessage(state, message) {
  if (!state || !message || typeof message !== 'object') {
    throw new Error('invalid index worker message')
  }

  if (message.type === 'started') {
    if (state.phase !== 'starting') throw new Error(`unexpected started message in ${state.phase}`)
    return {
      ...state,
      phase: 'running',
      status: 'running',
      dbRowId: nullablePositiveInt(message.dbRowId),
      items_done: 0,
      items_total: nonNegativeInt(message.itemsTotal),
      initial_indexed: nonNegativeInt(message.initialIndexed),
      started_at: nonNegativeInt(message.startedAt, state.started_at || 0) || state.started_at,
    }
  }

  if (message.type === 'progress') {
    if (state.phase !== 'running') throw new Error(`unexpected progress message in ${state.phase}`)
    const total = Math.max(state.items_total, nonNegativeInt(message.itemsTotal, state.items_total))
    const done = Math.min(total, Math.max(state.items_done, nonNegativeInt(message.itemsDone)))
    return { ...state, items_done: done, items_total: total }
  }

  if (message.type === 'terminal') {
    if (state.phase !== 'running') throw new Error(`unexpected terminal message in ${state.phase}`)
    const status = TERMINAL_STATUSES.has(message.status) ? message.status : 'error'
    const total = Math.max(state.items_total, nonNegativeInt(message.itemsTotal, state.items_total))
    const done = Math.min(total, Math.max(state.items_done, nonNegativeInt(message.itemsDone)))
    return {
      ...state,
      phase: 'terminal',
      status,
      items_done: done,
      items_total: total,
      error: status === 'error' ? errorMessage(message.error || 'index worker failed') : null,
      finished_at: nonNegativeInt(message.finishedAt) || Math.floor(Date.now() / 1000),
      dbRowId: nullablePositiveInt(message.dbRowId) || state.dbRowId,
    }
  }

  throw new Error(`unknown index worker message: ${message.type || '(missing type)'}`)
}

function snapshot(state) {
  const base = state.initial_indexed || 0
  return {
    // Index jobs and subprocess jobs have independent counters. Namespace the
    // public id so two live jobs called "1" cannot overwrite each other in
    // the renderer's shared store.
    id: `index-${state.id}`,
    live_id: state.id,
    db_id: state.dbRowId || null,
    type: 'tg_index',
    source_id: state.source_id,
    status: state.status,
    items_done: base + (state.items_done || 0),
    items_total: base + (state.items_total || 0),
    error: state.error || null,
    started_at: state.started_at,
    finished_at: state.finished_at || null,
    target: state.target || null,
  }
}

function runningStatus(state) {
  const current = snapshot(state)
  return {
    state: 'running',
    done: current.items_done,
    total: current.items_total,
    jobId: current.id,
    dbId: state.dbRowId || null,
  }
}

function matchesJobId(state, value) {
  const namespaced = /^index-(\d+)$/.exec(String(value || ''))
  if (namespaced) return state.id === Number(namespaced[1])
  const numeric = Number(value)
  if (!Number.isSafeInteger(numeric)) return false
  return state.id === numeric || state.dbRowId === numeric
}

function buildEmbeddingText(row, priors = []) {
  const format = (item) => {
    const name = item?.sender ? `${item.sender}: ` : ''
    const caption = String(item?.caption || '').slice(0, 1500)
    return `${name}${caption}`
  }
  return [...priors.map(format), format(row)].join('\n')
}

function rpmWindowState(entries, batchUnits, now = Date.now(), {
  target = RPM_TARGET,
  windowMs = RPM_WINDOW_MS,
} = {}) {
  const cutoff = now - windowMs
  const active = (entries || []).filter(entry => entry && entry.ts >= cutoff)
  const units = active.reduce((sum, entry) => sum + nonNegativeInt(entry.units), 0)
  let waitMs = 0
  if (units + nonNegativeInt(batchUnits) > target && active.length) {
    waitMs = Math.max(500, windowMs - (now - active[0].ts) + 200)
  }
  return { entries: active, units, waitMs }
}

function errorMessage(error) {
  if (error && typeof error.message === 'string' && error.message) return error.message
  return String(error || 'unknown error')
}

module.exports = {
  BATCH_SIZE,
  CONTEXT_NEIGHBORS,
  RPM_TARGET,
  RPM_WINDOW_MS,
  normalizeSourceId,
  normalizeLimit,
  normalizeStartRequest,
  createStartingState,
  applyWorkerMessage,
  snapshot,
  runningStatus,
  matchesJobId,
  buildEmbeddingText,
  rpmWindowState,
  errorMessage,
}
