'use strict'

const rag = require('./boosty-rag')
const { BATCH_SIZE, RPM_TARGET, rpmWindowState, errorMessage } = require('./index-worker-protocol')

async function runBoostyIndex(db, data, runtime) {
  const { post, embedBatch, throwIfCancelled, waitForOrCancel, sleepUnlessCancelled, isCancelled } = runtime
  const startedAt = Math.floor(Date.now() / 1000)
  const orphan = db.findRunningJobForSource('boosty_index', data.sourceId)
  if (orphan) db.updateJob(orphan.id, { status: 'interrupted', finished_at: startedAt })
  const dbRowId = db.recordJob({ type: 'boosty_index', source_id: data.sourceId, status: 'running',
    items_total: 0, started_at: startedAt,
    params: { origin: data.origin, limit: data.limit, item_ids: data.itemIds ?? null,
      request_id: data.requestId ?? null, public_job_id: `index-${data.jobId}`,
      index_version: rag.INDEX_VERSION, unit: 'messages', text_only: true } })
  let itemsDone = 0, itemsTotal = 0, initialIndexed = 0, fragmentsEmbedded = 0, status = 'running', failure = null
  try {
    throwIfCancelled()
    const prepared = rag.prepareIndex(db, { source_id: data.sourceId, limit: data.limit, item_ids: data.itemIds }, throwIfCancelled)
    initialIndexed = prepared.ready.length
    itemsTotal = prepared.pending.length
    db.updateJob(dbRowId, { items_total: initialIndexed + itemsTotal, items_done: initialIndexed })
    post({ type: 'started', dbRowId, itemsTotal, initialIndexed, startedAt, unit: 'messages',
      messagesSelected: prepared.docs.length, fragmentsTotal: prepared.fragments_pending, indexVersion: rag.INDEX_VERSION,
      target: `Boosty · индекс сохранённых текстов · источник #${data.sourceId}` })
    console.log(`[BoostyRag] source #${data.sourceId} current=${initialIndexed} pending=${itemsTotal} missing=${prepared.missing.length} fragments=${prepared.fragments_pending}`)
    const remaining = new Map(prepared.pending.map(entry => [entry.doc.generationId, entry.rows.length]))
    const desired = new Map(prepared.pending.map(entry => [entry.doc.generationId, entry.doc]))
    const publishReady = () => {
      for (const [id, n] of remaining) {
        if (n !== 0) continue
        throwIfCancelled()
        if (!rag.publish(db, desired.get(id))) throw new Error('Boosty generation not complete at publication')
        remaining.delete(id)
        itemsDone++
      }
    }
    publishReady() // A stopped worker may have saved its last vector before publish.
    let requests = []
    const rows = prepared.pending.flatMap(entry => entry.rows)
    for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
      throwIfCancelled()
      const batch = rows.slice(offset, offset + BATCH_SIZE)
      while (true) {
        const state = rpmWindowState(requests, batch.length)
        requests = state.entries
        if (!state.waitMs) break
        console.log(`[BoostyRag] quota backoff source #${data.sourceId}: ${state.units}+${batch.length}/${RPM_TARGET}`)
        await sleepUnlessCancelled(state.waitMs)
      }
      const start = Date.now()
      const vectors = await waitForOrCancel(embedBatch(batch.map(row => row.embedding_text), 'RETRIEVAL_DOCUMENT'))
      requests.push({ ts: start, units: batch.length })
      throwIfCancelled()
      rag.saveBatch(db, batch, vectors)
      for (const row of batch) remaining.set(row.generation_id, remaining.get(row.generation_id) - 1)
      fragmentsEmbedded += batch.length
      publishReady()
      db.updateJob(dbRowId, { items_done: initialIndexed + itemsDone })
      post({ type: 'progress', itemsDone, itemsTotal, fragmentsEmbedded })
      console.log(`[BoostyRag] source #${data.sourceId} fragments=${fragmentsEmbedded}/${rows.length} complete=${initialIndexed + itemsDone}/${initialIndexed + itemsTotal} elapsed_ms=${Date.now() - start}`)
    }
    const final = rag.indexStatus(db, { source_id: data.sourceId })
    if (data.limit == null && data.itemIds == null && !final.current_ready && final.available_interviews + final.available_posts > 0) {
      throw new Error('BOOSTY_ORIGINAL_CHANGED: current saved corpus changed during indexing; resume the remaining current originals')
    }
    status = 'done'
    console.log(`[BoostyRag] source #${data.sourceId} terminal done interviews=${final.ready_interviews}/${final.available_interviews} posts=${final.ready_posts}/${final.available_posts} exceptions=${final.exceptions.length}`)
  } catch (e) {
    status = e.code === 'INDEX_CANCELLED' || isCancelled() ? 'cancelled' : 'error'
    failure = status === 'error' ? errorMessage(e) : null
  }
  const finishedAt = Math.floor(Date.now() / 1000)
  // Durable job counts are COMPLETE documents, not partial fragment work.
  db.updateJob(dbRowId, { status, items_done: initialIndexed + itemsDone,
    error: failure, finished_at: finishedAt })
  return { type: 'terminal', status, itemsDone, itemsTotal, error: failure, finishedAt, dbRowId }
}

module.exports = { runBoostyIndex }
