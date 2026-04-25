const AUTO_INITIAL_DELAY_MS = 60 * 1000
const AUTO_INTERVAL_MS = 30 * 60 * 1000
const AUTO_JOB_TIMEOUT_MS = 12 * 60 * 60 * 1000

const TERMINAL_STATUSES = new Set(['done', 'error', 'cancelled', 'interrupted'])
const TYPE_ORDER = ['text', 'voice', 'video', 'photo', 'docs', 'comments']
const VALID_TYPES = new Set(TYPE_ORDER)

let timer = null
let running = false

function cleanTypes(types) {
  const picked = new Set(
    Array.isArray(types)
      ? types.map(String).filter(t => VALID_TYPES.has(t))
      : []
  )
  return TYPE_ORDER.filter(t => picked.has(t))
}

function cleanEngine(engine) {
  return engine === 'gemini' ? 'gemini' : 'assemblyai'
}

function waitForJob(subscribe, jobId, timeoutMs = AUTO_JOB_TIMEOUT_MS) {
  return new Promise(resolve => {
    let done = false
    let off = null
    const finish = (job) => {
      if (done) return
      done = true
      if (timerId) clearTimeout(timerId)
      if (off) off()
      resolve(job)
    }
    const timerId = setTimeout(() => {
      finish({ id: jobId, status: 'timeout' })
    }, timeoutMs)
    timerId.unref?.()
    off = subscribe(job => {
      if (job.id !== jobId) return
      if (TERMINAL_STATUSES.has(job.status)) finish(job)
    })
  })
}

function addToGroup(groups, row) {
  const types = cleanTypes(row.tg_auto?.types)
  if (!types.length) return false
  const engine = cleanEngine(row.tg_auto?.engine)
  const session = row.tg_session || ''
  const key = JSON.stringify({ session, types, engine })
  if (!groups.has(key)) {
    groups.set(key, { session, types, engine, rows: [] })
  }
  groups.get(key).rows.push(row)
  return true
}

async function runTelegramAutoOnce({ db, jobRunner, indexJob, reason = 'timer' }) {
  if (running) {
    console.log(`[TelegramAuto] skip ${reason}: previous run is still active`)
    return { ok: true, skipped: 'running' }
  }
  running = true
  const started = Date.now()
  try {
    const rows = db.listTelegramAutoSources()
    const groups = new Map()
    let skippedNoTypes = 0
    for (const row of rows) {
      if (!addToGroup(groups, row)) skippedNoTypes += 1
    }
    if (!groups.size) {
      console.log(`[TelegramAuto] ${reason}: no enabled sources${skippedNoTypes ? `, skipped_no_types=${skippedNoTypes}` : ''}`)
      return { ok: true, groups: 0, sources: 0 }
    }

    console.log(`[TelegramAuto] ${reason}: groups=${groups.size} sources=${rows.length} skipped_no_types=${skippedNoTypes}`)
    let pulledSources = 0
    let indexedSources = 0
    for (const group of groups.values()) {
      const sourceIds = group.rows.map(r => Number(r.id)).filter(Number.isFinite)
      const targets = group.rows.map(r => r.handle).filter(Boolean)
      const sinces = group.rows.map(r => {
        try { return db.maxExternalId(r.id) || 0 } catch { return 0 }
      })
      if (!targets.length) continue

      console.log(`[TelegramAuto] pull start session=${group.session || 'active'} chats=${targets.length} types=${group.types.join(',')}`)
      const catchupId = jobRunner.startTelegramCatchUp({
        source_ids: sourceIds,
        targets,
        per_source_since: sinces,
        types: group.types,
        engine: group.engine,
        tg_session: group.session || null,
        auto: true,
      })
      const catchup = await waitForJob(jobRunner.subscribe, catchupId)
      console.log(`[TelegramAuto] pull end job=${catchupId} status=${catchup.status}`)
      if (!TERMINAL_STATUSES.has(catchup.status) || catchup.status === 'timeout') continue
      pulledSources += targets.length

      const indexRows = group.rows.filter(r => !!r.tg_auto?.index)
      for (const row of indexRows) {
        try {
          const res = indexJob.start({ sourceId: row.id, limit: null })
          if (res && typeof res === 'object' && res.noop) {
            console.log(`[TelegramAuto] index noop source #${row.id} reason=${res.reason}`)
            continue
          }
          const indexSnap = await waitForJob(indexJob.subscribe, res)
          console.log(`[TelegramAuto] index end source #${row.id} job=${res} status=${indexSnap.status}`)
          if (indexSnap.status === 'done') indexedSources += 1
        } catch (err) {
          console.error(`[TelegramAuto] index failed source #${row.id}: ${err?.message || err}`)
        }
      }
    }

    console.log(`[TelegramAuto] ${reason}: done pulled=${pulledSources} indexed=${indexedSources} total_ms=${Date.now() - started}`)
    return { ok: true, groups: groups.size, sources: rows.length, pulledSources, indexedSources }
  } catch (err) {
    console.error(`[TelegramAuto] ${reason}: failed ${err?.message || err}`)
    return { ok: false, error: String(err?.message || err) }
  } finally {
    running = false
  }
}

function startTelegramAutoScheduler(deps) {
  if (timer) return
  const schedule = (delay, reason) => {
    timer = setTimeout(async () => {
      timer = null
      await runTelegramAutoOnce({ ...deps, reason })
      schedule(AUTO_INTERVAL_MS, 'timer')
    }, delay)
  }
  schedule(AUTO_INITIAL_DELAY_MS, 'startup')
  console.log(`[TelegramAuto] scheduler started initial_ms=${AUTO_INITIAL_DELAY_MS} interval_ms=${AUTO_INTERVAL_MS}`)
}

function stopTelegramAutoScheduler() {
  if (!timer) return
  clearTimeout(timer)
  timer = null
}

module.exports = {
  AUTO_INITIAL_DELAY_MS,
  AUTO_INTERVAL_MS,
  runTelegramAutoOnce,
  startTelegramAutoScheduler,
  stopTelegramAutoScheduler,
}
