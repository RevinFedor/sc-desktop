const { performance } = require('node:perf_hooks')

const MAIN_LOOP_INTERVAL_MS = 500
const MAIN_LOOP_GAP_MS = 500
const SLOW_IPC_MS = 150
const RECENT_WINDOW_MS = 5000
const MAX_RECENT_OPS = 24
const JOB_UPDATE_WINDOW_MS = 5000
const JOB_UPDATE_BURST_COUNT = 30
const JOB_UPDATE_BURST_BYTES = 160 * 1024

let installed = false
let opSeq = 1
const activeOps = new Map()
const recentOps = []
const ipcAgg = new Map()

let jobWindow = resetJobWindow()
let jobFlushTimer = null
const SENSITIVE_KEY_RE = /(password|pass|phone|code|token|api[_-]?key|secret|hash)/i

function nowMs() {
  return performance.now()
}

function clip(value, max = 160) {
  const s = String(value == null ? '' : value)
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function summarizeArg(arg) {
  if (arg == null) return String(arg)
  if (typeof arg === 'string') return JSON.stringify(clip(arg, 80))
  if (typeof arg === 'number' || typeof arg === 'boolean') return String(arg)
  if (Array.isArray(arg)) return `array(${arg.length})`
  if (typeof arg === 'object') {
    const keys = Object.keys(arg).slice(0, 8)
    const parts = keys.map(k => {
      const v = arg[k]
      if (SENSITIVE_KEY_RE.test(k)) return `${k}=<redacted>`
      if (v == null) return `${k}=null`
      if (typeof v === 'string') return `${k}=${JSON.stringify(clip(v, 50))}`
      if (typeof v === 'number' || typeof v === 'boolean') return `${k}=${v}`
      if (Array.isArray(v)) return `${k}=array(${v.length})`
      return `${k}=object`
    })
    const suffix = Object.keys(arg).length > keys.length ? ',…' : ''
    return `{${parts.join(',')}${suffix}}`
  }
  return typeof arg
}

function summarizeArgs(args) {
  try { return args.map(summarizeArg).join(' ') || '-' }
  catch { return '-' }
}

function pruneRecent(ts = nowMs()) {
  while (recentOps.length && ts - recentOps[0].end > RECENT_WINDOW_MS) recentOps.shift()
  for (const [channel, row] of ipcAgg) {
    while (row.samples.length && ts - row.samples[0].end > RECENT_WINDOW_MS) row.samples.shift()
    if (!row.samples.length) ipcAgg.delete(channel)
  }
}

function recordCompleted(channel, durationMs, startedAt, argsSummary) {
  const end = nowMs()
  recentOps.push({ channel, durationMs, start: startedAt, end, argsSummary })
  if (recentOps.length > MAX_RECENT_OPS) recentOps.splice(0, recentOps.length - MAX_RECENT_OPS)

  let row = ipcAgg.get(channel)
  if (!row) {
    row = { samples: [] }
    ipcAgg.set(channel, row)
  }
  row.samples.push({ durationMs, end })
  pruneRecent(end)
}

function formatActiveOps(ts = nowMs()) {
  if (!activeOps.size) return 'none'
  return Array.from(activeOps.values()).map(op =>
    `${op.channel}:${Math.round(ts - op.start)}ms:${op.argsSummary}`
  ).join('|')
}

function formatRecentOps(ts = nowMs()) {
  pruneRecent(ts)
  if (!recentOps.length) return 'none'
  return recentOps
    .slice(-8)
    .map(op => `${op.channel}:${Math.round(op.durationMs)}ms:${op.argsSummary}`)
    .join('|')
}

function formatIpcAgg(ts = nowMs()) {
  pruneRecent(ts)
  const rows = []
  for (const [channel, row] of ipcAgg) {
    const n = row.samples.length
    if (!n) continue
    const sum = row.samples.reduce((s, r) => s + r.durationMs, 0)
    const max = row.samples.reduce((m, r) => Math.max(m, r.durationMs), 0)
    rows.push({ channel, n, sum, max })
  }
  if (!rows.length) return 'none'
  return rows
    .sort((a, b) => b.sum - a.sum)
    .slice(0, 8)
    .map(r => `${r.channel}:n=${r.n}:sum=${Math.round(r.sum)}:max=${Math.round(r.max)}`)
    .join('|')
}

function wrapIpcHandle(ipcMain) {
  const original = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel, listener) => {
    return original(channel, async (event, ...args) => {
      const id = opSeq++
      const start = nowMs()
      const argsSummary = summarizeArgs(args)
      activeOps.set(id, { channel, start, argsSummary })
      try {
        return await listener(event, ...args)
      } finally {
        activeOps.delete(id)
        const durationMs = nowMs() - start
        recordCompleted(channel, durationMs, start, argsSummary)
        if (durationMs >= SLOW_IPC_MS) {
          console.log(`[Perf:IpcSlow] channel=${channel} durMs=${durationMs.toFixed(1)} args=${argsSummary}`)
        }
      }
    })
  }
}

function startMainLoopMonitor() {
  let last = nowMs()
  const timer = setInterval(() => {
    const ts = nowMs()
    const gapMs = ts - last - MAIN_LOOP_INTERVAL_MS
    last = ts
    if (gapMs >= MAIN_LOOP_GAP_MS) {
      const mem = process.memoryUsage()
      console.log(`[Perf:MainLoopGap] gapMs=${gapMs.toFixed(1)} activeOps=${formatActiveOps(ts)} ` +
        `recentOps5s=${formatRecentOps(ts)} ipcAgg5s=${formatIpcAgg(ts)} rssMb=${Math.round(mem.rss / 1024 / 1024)}`)
    }
  }, MAIN_LOOP_INTERVAL_MS)
  timer.unref?.()
}

function sanitizeRendererPayload(payload = {}) {
  const out = {}
  for (const [k, v] of Object.entries(payload || {})) {
    if (v == null) continue
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Number(v.toFixed ? v.toFixed(1) : v)
    else if (typeof v === 'boolean') out[k] = v
    else if (typeof v === 'string') out[k] = clip(v, 220)
    else if (Array.isArray(v)) out[k] = clip(v.join(','), 220)
    else if (typeof v === 'object') out[k] = clip(JSON.stringify(v), 220)
  }
  return out
}

function rendererPayloadToString(payload) {
  return Object.entries(sanitizeRendererPayload(payload))
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(' ')
}

function installRendererEventSink(ipcMain) {
  ipcMain.on('diag:rendererEvent', (_evt, payload = {}) => {
    const kind = String(payload.kind || 'Renderer')
    if (!/^[A-Za-z0-9:_-]+$/.test(kind)) return
    const rest = rendererPayloadToString({ ...payload, kind: undefined })
    console.log(`[Perf:${kind}]${rest ? ' ' + rest : ''}`)
  })
}

function resetJobWindow() {
  return {
    started: Date.now(),
    count: 0,
    bytes: 0,
    byType: new Map(),
    byStatus: new Map(),
    bySource: new Map(),
  }
}

function bumpMap(map, key, n = 1) {
  const k = key == null ? 'none' : String(key)
  map.set(k, (map.get(k) || 0) + n)
}

function topMap(map, limit = 6) {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k, v]) => `${k}:${v}`)
    .join(',')
}

function flushJobWindow(reason = 'timer') {
  if (!jobWindow.count) {
    jobWindow = resetJobWindow()
    return
  }
  const elapsedMs = Math.max(1, Date.now() - jobWindow.started)
  if (
    reason === 'threshold' ||
    jobWindow.count >= JOB_UPDATE_BURST_COUNT ||
    jobWindow.bytes >= JOB_UPDATE_BURST_BYTES
  ) {
    console.log(`[Perf:JobUpdateBurst] reason=${reason} count=${jobWindow.count} bytes=${jobWindow.bytes} ` +
      `elapsedMs=${elapsedMs} types=${topMap(jobWindow.byType)} statuses=${topMap(jobWindow.byStatus)} sources=${topMap(jobWindow.bySource)}`)
  }
  jobWindow = resetJobWindow()
}

function scheduleJobFlush() {
  if (jobFlushTimer) return
  jobFlushTimer = setTimeout(() => {
    jobFlushTimer = null
    flushJobWindow('timer')
  }, JOB_UPDATE_WINDOW_MS)
  jobFlushTimer.unref?.()
}

function noteJobUpdate(job, source = 'unknown') {
  if (!job || typeof job !== 'object') return
  let size = 0
  try { size = Buffer.byteLength(JSON.stringify(job), 'utf8') } catch {}
  jobWindow.count += 1
  jobWindow.bytes += size
  bumpMap(jobWindow.byType, job.type || source)
  bumpMap(jobWindow.byStatus, job.status)
  if (job.source_id) bumpMap(jobWindow.bySource, job.source_id)
  scheduleJobFlush()
  if (jobWindow.count >= JOB_UPDATE_BURST_COUNT || jobWindow.bytes >= JOB_UPDATE_BURST_BYTES) {
    flushJobWindow('threshold')
    if (jobFlushTimer) {
      clearTimeout(jobFlushTimer)
      jobFlushTimer = null
    }
  }
}

function install(ipcMain) {
  if (installed) return { noteJobUpdate }
  installed = true
  wrapIpcHandle(ipcMain)
  installRendererEventSink(ipcMain)
  startMainLoopMonitor()
  console.log('[Perf] diagnostics installed')
  return { noteJobUpdate }
}

module.exports = { install, noteJobUpdate }
