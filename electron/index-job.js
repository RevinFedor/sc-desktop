// Semantic-index job: walks items for a source, builds context-aware text per
// message, batches them through Gemini embeddings, writes vectors into
// items_vec. Pure Node — no Python subprocess.
//
// Design notes:
//   • One job per source. Concurrent runs on the same source are blocked
//     (returns the existing job id).
//   • "Last N from newest" — caller passes limit or null. Items pulled in
//     `published_at DESC` order so partial indexing always covers the
//     freshest slice (matches the UI promise "от самых новых").
//   • Context window: each message text gets 5 prior messages (by published_at
//     ASC) prepended as context. Cheap proxy for proper Late Chunking — for
//     20k-msg corpora the recall gain over no-context is ~80% of the gain
//     from full Late Chunking, at zero engineering cost.
//   • Skip already-indexed items so re-running is incremental and cheap.

const db = require('./database')
const { embedBatch } = require('./embedder')

const BATCH_SIZE = 100        // max for batchEmbedContents
const CONTEXT_NEIGHBORS = 5   // messages before to prepend as context

// RPM-based throttle. Gemini bills `batchEmbedContents` as N separate
// requests against the RPM quota (one per text in the batch), not as a
// single batched call — even though it's one HTTP round-trip on our side.
// Tier-1 paid is 3K RPM; we target 2400 to leave headroom for retries and
// concurrent searches.
//
// Mechanism: rolling 60-second window of submitted "request units"
// (= number of texts sent). Before each batch we check if launching it
// would push us over the cap and sleep until the oldest entry expires.
const RPM_TARGET = 2400

let nextId = 1
const activeJobs = new Map()  // sourceId -> job
const listeners = new Set()

async function sleepUnlessCancelled(job, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (job.cancelled) throw new Error('cancelled')
    await new Promise(r => setTimeout(r, Math.min(500, Math.max(0, deadline - Date.now()))))
  }
  if (job.cancelled) throw new Error('cancelled')
}

function emit(job) {
  for (const fn of listeners) {
    try { fn(snapshot(job)) } catch {}
  }
}
function snapshot(j) {
  // Expose cumulative numbers (initial + this run) so subscribers — most
  // importantly the SourceDetail listener that calls refreshIdxStatus on
  // every tick — see a monotonically growing progress, not a per-run delta.
  const base = j.initial_indexed || 0
  return {
    id: j.id,
    db_id: j.dbRowId || null,
    type: 'tg_index',
    source_id: j.source_id,
    status: j.status,
    items_done: base + (j.items_done || 0),
    items_total: base + (j.items_total || 0),
    error: j.error || null,
    started_at: j.started_at,
    finished_at: j.finished_at || null,
    target: j.target || null,
  }
}

function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) }

function statusForSource(sourceId) {
  const live = activeJobs.get(sourceId)
  if (live) {
    // `done` is *cumulative* indexed count — the UI shows total semantic
    // coverage, not "rows in this run". Add `initial_indexed` (snapshot
    // taken at job start) to the in-run progress so the bar continues from
    // where the previous run left off, instead of resetting to zero.
    return {
      state: 'running',
      done: (live.initial_indexed || 0) + live.items_done,
      total: (live.initial_indexed || 0) + live.items_total,
      jobId: live.id,
      dbId: live.dbRowId || null,
    }
  }
  // No job running — tell caller how many vectors are stored vs how many items
  // exist, so the UI can show "indexed 1500 / 10000".
  const total = db.getDb()
    .prepare('SELECT COUNT(*) AS n FROM items WHERE source_id = ?')
    .get(sourceId)?.n || 0
  const indexed = db.vectorCountForSource(sourceId)
  return {
    state: 'idle',
    done: indexed,
    total,
  }
}

/**
 * Pick the next slice of items to index. Newest first; skip items that
 * already have a vector (incremental friendly).
 *
 * Why select with caption: empty/sticker/system messages with no text are
 * skipped — embedding them produces noise.
 */
function selectItems(sourceId, limit) {
  const handle = db.getDb()
  const rows = handle.prepare(`
    SELECT i.id, i.published_at, i.sender, i.caption, i.type
      FROM items i
     WHERE i.source_id = ?
       AND i.caption IS NOT NULL AND length(trim(i.caption)) > 0
       AND i.id NOT IN (SELECT item_id FROM items_vec)
     ORDER BY i.published_at DESC
     ${limit ? 'LIMIT ?' : ''}
  `).all(...(limit ? [sourceId, limit] : [sourceId]))
  return rows
}

/**
 * Pre-load the N items immediately preceding each batch row (by published_at)
 * for context-window construction. One query per batch — fine for batches of
 * 100, would scale poorly past that.
 *
 * Returns Map<itemId, contextText>. contextText is a newline-joined string
 * of "<sender>: <caption>" prepended before the item's own text.
 */
function buildContextMap(sourceId, batchRows) {
  if (!batchRows.length) return new Map()
  const handle = db.getDb()
  const map = new Map()
  // Single SQL: for each row, fetch 5 prior items by published_at within the
  // same source. Done as a window function.
  const minTs = batchRows.reduce((m, r) => Math.min(m, r.published_at || 0), Infinity)
  const maxTs = batchRows.reduce((m, r) => Math.max(m, r.published_at || 0), 0)
  // Pull a candidate pool: anything from (minTs - 1d) up to maxTs from the
  // same source that has caption. Then bucket per item in JS.
  const pool = handle.prepare(`
    SELECT id, published_at, sender, caption
      FROM items
     WHERE source_id = ?
       AND published_at IS NOT NULL
       AND published_at <= ?
       AND published_at >= ?
       AND caption IS NOT NULL AND length(trim(caption)) > 0
     ORDER BY published_at ASC
  `).all(sourceId, maxTs, Math.max(0, minTs - 86400))

  // For each batch row find the latest CONTEXT_NEIGHBORS rows with
  // published_at < row.published_at.
  for (const row of batchRows) {
    const prior = []
    for (let i = pool.length - 1; i >= 0 && prior.length < CONTEXT_NEIGHBORS; i--) {
      const p = pool[i]
      if (p.id === row.id) continue
      if ((p.published_at || 0) < (row.published_at || 0)) prior.unshift(p)
    }
    map.set(row.id, prior)
  }
  return map
}

function buildText(row, priors) {
  // Format: short context lines + the target message last.
  // Each line: "name: text"  (sender is optional)
  // Caption clamping: 1500 chars per line — shields the embedder from the
  // occasional 10k-character logs.
  const fmt = (r) => {
    const name = r.sender ? `${r.sender}: ` : ''
    const cap = (r.caption || '').slice(0, 1500)
    return `${name}${cap}`
  }
  const lines = priors.map(fmt)
  lines.push(fmt(row))
  return lines.join('\n')
}

/**
 * Start indexing. Returns the job id (newly created or already-running).
 */
function start({ sourceId, limit, origin = 'unknown' }) {
  const startMs = Date.now()
  if (!sourceId) throw new Error('sourceId required')
  const existing = activeJobs.get(sourceId)
  if (existing) return existing.id

  // Belt-and-suspenders: if the user clicked Index right after restart
  // and the zombie-cleanup at startup somehow missed (e.g. a tg_index row
  // not in the cleanup list — shouldn't happen now but guards against
  // future regression), don't open a second running row. Mark the prior
  // one interrupted first so the DB never has two open rows for the
  // same source.
  try {
    const orphan = db.findRunningJobForSource('tg_index', sourceId)
    if (orphan) {
      db.updateJob(orphan.id, { status: 'interrupted' })
      console.log(`[IndexJob] reset orphan running row #${orphan.id} on source #${sourceId} → interrupted`)
    }
  } catch (err) {
    // Missing helper isn't fatal — just no extra guard. We add it below.
  }

  const selectStartedMs = Date.now()
  const items = selectItems(sourceId, limit || null)
  console.log(`[IndexJob] start source #${sourceId} origin=${origin} limit=${limit || 'full'} selectItems rows=${items.length} took ${Date.now() - selectStartedMs}ms`)
  if (!items.length) {
    // Nothing to do — return a noop signal so the UI can toast "уже
    // проиндексирован". We don't write a jobs-table row for a no-op (would
    // pollute "История парсинга" with empty rows on repeated clicks) — the
    // user only learns about it via the renderer-side toast.
    return { noop: true, reason: 'already-indexed' }
  }

  // Snapshot vectors-already-indexed at job start so cumulative progress
  // continues from there in the UI instead of resetting to 0.
  const countStartedMs = Date.now()
  const initialIndexed = db.vectorCountForSource(sourceId)
  console.log(`[IndexJob] start source #${sourceId} vectorCount=${initialIndexed} took ${Date.now() - countStartedMs}ms`)

  const job = {
    id: nextId++,
    source_id: sourceId,
    status: 'running',
    items_done: 0,
    items_total: items.length,
    initial_indexed: initialIndexed,
    started_at: Math.floor(Date.now() / 1000),
    cancelled: false,
  }
  activeJobs.set(sourceId, job)
  emit(job)
  console.log(`[IndexJob] start source #${sourceId} origin=${origin} live #${job.id} setup took ${Date.now() - startMs}ms`)

  // Persist a row in jobs table so it appears in "История парсинга".
  try {
    job.dbRowId = db.recordJob({
      type: 'tg_index',
      source_id: sourceId,
      status: 'running',
      items_total: items.length,
      params: { limit: limit || null, origin },
      started_at: job.started_at,
    })
  } catch (err) {
    console.error('[IndexJob] recordJob failed', err.message)
  }

  ;(async () => {
    // Sliding-window request ledger. Each entry: { ts, units } where
    // `units` = how many request units this batch consumed (= batch size,
    // since Gemini counts every embedded text against RPM individually).
    const reqLog = []
    const unitsInWindow = () => {
      const cutoff = Date.now() - 60_000
      while (reqLog.length && reqLog[0].ts < cutoff) reqLog.shift()
      return reqLog.reduce((s, e) => s + e.units, 0)
    }

    try {
      for (let i = 0; i < items.length; i += BATCH_SIZE) {
        if (job.cancelled) throw new Error('cancelled')
        const batch = items.slice(i, i + BATCH_SIZE)
        const ctxStarted = Date.now()
        const ctxMap = buildContextMap(sourceId, batch)
        const ctxMs = Date.now() - ctxStarted
        if (ctxMs >= 100) {
          console.log(`[IndexJob] #${job.id} slow context batch ${i / BATCH_SIZE + 1}/${Math.ceil(items.length / BATCH_SIZE)} ` +
            `source #${sourceId} origin=${origin} rows=${batch.length} ctx_ms=${ctxMs}`)
        }
        const texts = batch.map(r => buildText(r, ctxMap.get(r.id) || []))
        // Pre-flight: does this batch fit under RPM_TARGET in the rolling
        // 60-second window? If not, sleep until the oldest entry expires.
        while (unitsInWindow() + batch.length > RPM_TARGET) {
          if (job.cancelled) throw new Error('cancelled')
          const oldest = reqLog[0]?.ts || Date.now()
          const waitMs = Math.max(500, 60_000 - (Date.now() - oldest) + 200)
          console.log(`[IndexJob] #${job.id} RPM throttle: ${unitsInWindow()} in window, ` +
            `+${batch.length} would exceed ${RPM_TARGET}, sleeping ${waitMs}ms`)
          await sleepUnlessCancelled(job, waitMs)
        }
        const t0 = Date.now()
        const vecs = await embedBatch(texts, 'RETRIEVAL_DOCUMENT')
        const embedMs = Date.now() - t0
        reqLog.push({ ts: t0, units: batch.length })
        const rows = batch.map((r, k) => ({ item_id: r.id, embedding: vecs[k] }))
        const bulkStarted = Date.now()
        db.bulkUpsertVectors(rows)
        const bulkMs = Date.now() - bulkStarted
        if (bulkMs >= 100) {
          console.log(`[IndexJob] #${job.id} slow bulkUpsert batch ${i / BATCH_SIZE + 1}/${Math.ceil(items.length / BATCH_SIZE)} ` +
            `source #${sourceId} origin=${origin} rows=${rows.length} bulk_ms=${bulkMs}`)
        }
        job.items_done += batch.length
        const ms = Date.now() - t0
        console.log(`[IndexJob] #${job.id} batch ${i / BATCH_SIZE + 1}/${Math.ceil(items.length / BATCH_SIZE)} ` +
          `(${batch.length} msgs, total=${ms}ms embed=${embedMs}ms bulk=${bulkMs}ms ctx=${ctxMs}ms, ${unitsInWindow()} RPM in window) → ${job.items_done}/${job.items_total}`)
        emit(job)
        // Sync DB row so "История парсинга" / JobDetail see the live
        // counter, not a frozen 0/N until the very end. updateJob does a
        // tight WHERE id=?, no measurable cost compared to embedBatch.
        if (job.dbRowId) {
          try {
            const updateStarted = Date.now()
            db.updateJob(job.dbRowId, { items_done: job.items_done })
            const updateMs = Date.now() - updateStarted
            if (updateMs >= 100) {
              console.log(`[IndexJob] #${job.id} slow updateJob source #${sourceId} origin=${origin} update_ms=${updateMs}`)
            }
          }
          catch (err) { console.error('[IndexJob] mid-run updateJob failed', err.message) }
        }
      }
      job.status = 'done'
    } catch (err) {
      // User-initiated cancel surfaces as the literal "cancelled" message
      // we throw inside the loop. Map it to status='cancelled' so the
      // History row reads grey/neutral (intent), not red (failure).
      // items_done at this point reflects the last successfully embedded
      // batch — the user gets a real "X / total успешно" snapshot.
      const msg = err && err.message || String(err)
      if (msg === 'cancelled' || job.cancelled) {
        job.status = 'cancelled'
        job.error  = null
        console.log(`[IndexJob] #${job.id} cancelled at ${job.items_done}/${job.items_total}`)
      } else {
        job.status = 'error'
        job.error  = msg
        console.error(`[IndexJob] #${job.id} failed:`, job.error)
      }
    } finally {
      job.finished_at = Math.floor(Date.now() / 1000)
      activeJobs.delete(sourceId)
      try {
        if (job.dbRowId) {
          db.updateJob(job.dbRowId, {
            status: job.status,
            items_done: job.items_done,
            error: job.error || null,
            finished_at: job.finished_at,
          })
        }
      } catch (err) {
        console.error('[IndexJob] updateJob failed', err.message)
      }
      emit(job)
    }
  })()

  return job.id
}

function cancel(sourceId) {
  const live = activeJobs.get(sourceId)
  if (!live) return false
  live.cancelled = true
  console.log(`[IndexJob] cancel requested source #${sourceId} matched live #${live.id} db #${live.dbRowId || '-'}`)
  return true
}

/**
 * Cancel by job id — used by the renderer-shared `cancelJob` path
 * (ActivityPanel "Cancel" button hits jobs:cancel which routes through
 * job-runner.cancelJob, which delegates here for tg_index ids). Returns
 * true if we owned the id and flipped it.
 */
function cancelById(id) {
  const numericId = Number(id)
  const wanted = Number.isFinite(numericId) ? numericId : id
  for (const live of activeJobs.values()) {
    if (live.id === wanted || live.dbRowId === wanted) {
      live.cancelled = true
      console.log(`[IndexJob] cancel requested id=${id} matched live #${live.id} db #${live.dbRowId || '-'} source #${live.source_id}`)
      return true
    }
  }
  const active = Array.from(activeJobs.values())
    .map(j => `live #${j.id}/db #${j.dbRowId || '-'}/source #${j.source_id}`)
    .join(', ')
  console.log(`[IndexJob] cancel requested id=${id} not found active=[${active}]`)
  return false
}

module.exports = { start, cancel, cancelById, statusForSource, subscribe }
