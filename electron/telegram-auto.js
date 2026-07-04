const AUTO_INITIAL_DELAY_MS = 60 * 1000
const AUTO_INTERVAL_MS = 30 * 60 * 1000
const AUTO_JOB_TIMEOUT_MS = 12 * 60 * 60 * 1000

const TERMINAL_STATUSES = new Set(['done', 'error', 'cancelled', 'interrupted'])
const TELEGRAM_SESSION_JOB_TYPES = new Set([
  'tg_fetch',
  'tg_preview',
  'tg_folder_fetch',
  'tg_folder_refresh',
  'tg_reply_backfill',
  'tg_catchup',
])
const TYPE_ORDER = ['text', 'voice', 'video', 'photo', 'docs', 'comments']
const VALID_TYPES = new Set(TYPE_ORDER)

let timer = null
let running = false
let sessionGuardOff = null
const blockedSessions = new Map()

function yieldToEventLoop() {
  return new Promise(resolve => setImmediate(resolve))
}

function sessionKey(session) {
  return session || '__active__'
}

function sessionLabel(session) {
  return session || 'active'
}

function blockSession(session, reason) {
  const key = sessionKey(session)
  const message = reason || 'Telegram-сессия не авторизована — нужно войти заново.'
  const prev = blockedSessions.get(key)
  blockedSessions.set(key, {
    session: session || null,
    reason: message,
    blocked_at: Date.now(),
  })
  if (!prev) {
    console.warn(`[TelegramAuto] block session=${sessionLabel(session)} reason=${message}`)
  }
}

function clearTelegramAutoSessionBlock(session, reason = 'cleared') {
  const key = sessionKey(session)
  if (!blockedSessions.delete(key)) return false
  console.log(`[TelegramAuto] unblock session=${sessionLabel(session)} reason=${reason}`)
  return true
}

function blockedSession(session) {
  return blockedSessions.get(sessionKey(session)) || null
}

function isTelegramSessionJob(job) {
  return TELEGRAM_SESSION_JOB_TYPES.has(job?.type)
}

function wireSessionGuard(jobRunner) {
  if (sessionGuardOff || !jobRunner?.subscribe) return
  sessionGuardOff = jobRunner.subscribe(job => {
    if (!isTelegramSessionJob(job)) return
    if (!TERMINAL_STATUSES.has(job.status)) return
    const session = job.tg_session || job.params?.tg_session || null
    if (job.error_code === 'session_unauthorized') {
      blockSession(session, job.error)
      return
    }
    if (job.status === 'done') {
      clearTelegramAutoSessionBlock(session, 'successful tg job')
    }
  })
}

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
  wireSessionGuard(jobRunner)
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
    let skippedBlocked = 0
    for (const group of groups.values()) {
      const block = blockedSession(group.session || null)
      if (block) {
        skippedBlocked += group.rows.length
        console.warn(`[TelegramAuto] skip session=${sessionLabel(group.session)} chats=${group.rows.length}: ${block.reason}`)
        continue
      }
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
      if (catchup.error_code === 'session_unauthorized') {
        blockSession(group.session || null, catchup.error)
        continue
      }
      if (catchup.status !== 'done') continue
      pulledSources += targets.length

      const indexCounts = typeof db.semanticIndexCountsForSources === 'function'
        ? db.semanticIndexCountsForSources(sourceIds)
        : new Map()
      const indexRows = group.rows.filter(r => !!r.tg_auto?.index)
      for (const row of indexRows) {
        try {
          const counts = indexCounts.get(Number(row.id))
          if (counts) {
            const indexable = Number(counts.semantic_indexable_count) || 0
            const indexed = Number(counts.semantic_indexed_count) || 0
            if (indexable <= 0 || indexed >= indexable) {
              console.log(`[TelegramAuto] index skip source #${row.id} reason=already-indexed indexed=${indexed}/${indexable}`)
              await yieldToEventLoop()
              continue
            }
          }
          const res = indexJob.start({ sourceId: row.id, limit: null, origin: `telegram-auto:${reason}` })
          if (res && typeof res === 'object' && res.noop) {
            console.log(`[TelegramAuto] index noop source #${row.id} reason=${res.reason}`)
            await yieldToEventLoop()
            continue
          }
          const indexSnap = await waitForJob(indexJob.subscribe, res)
          console.log(`[TelegramAuto] index end source #${row.id} job=${res} status=${indexSnap.status}`)
          if (indexSnap.status === 'done') indexedSources += 1
          await yieldToEventLoop()
        } catch (err) {
          console.error(`[TelegramAuto] index failed source #${row.id}: ${err?.message || err}`)
        }
      }
    }

    console.log(`[TelegramAuto] ${reason}: done pulled=${pulledSources} indexed=${indexedSources} skipped_blocked=${skippedBlocked} total_ms=${Date.now() - started}`)
    return { ok: true, groups: groups.size, sources: rows.length, pulledSources, indexedSources, skippedBlocked }
  } catch (err) {
    console.error(`[TelegramAuto] ${reason}: failed ${err?.message || err}`)
    return { ok: false, error: String(err?.message || err) }
  } finally {
    running = false
  }
}

function startTelegramAutoScheduler(deps) {
  if (timer) return
  wireSessionGuard(deps?.jobRunner)
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
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  if (sessionGuardOff) {
    sessionGuardOff()
    sessionGuardOff = null
  }
}

module.exports = {
  AUTO_INITIAL_DELAY_MS,
  AUTO_INTERVAL_MS,
  runTelegramAutoOnce,
  startTelegramAutoScheduler,
  stopTelegramAutoScheduler,
  clearTelegramAutoSessionBlock,
}
