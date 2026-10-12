'use strict'

// Reuse the existing visible metadata job; do not run Telethon from an
// embedding worker or update its source while that worker is taking a snapshot.
function createTelegramRagPreparation({ jobRunner, readDb, logger = console }) {
  return async (request, control) => {
    if (control.isCancelled()) throw new Error('index cancelled')
    // Exact saved-item migration/guard repair is deliberately local. It must
    // not start a source-wide metadata job and mutate thousands of unrelated
    // inputs; callers can explicitly fetch/save needed remote messages.
    if (request.itemIds != null) return
    const pending = await readDb('listItemsMissingParent', [request.sourceId, 1])
    if (!pending.length || control.isCancelled()) return
    const source = await readDb('getSource', [request.sourceId])
    if (control.isCancelled()) throw new Error('index cancelled')
    if (!source?.handle || source.platform !== 'telegram' || source.tg_session_conflict || !source.tg_session) {
      logger.warn?.(`[TelegramRag] source #${request.sourceId} has no unambiguous bound Telegram session; indexing saved local input without network preparation`)
      return
    }
    let id
    try {
      id = jobRunner.startTelegramReplyBackfill({
        source_id: request.sourceId, target: source.handle, limit: 5000,
        _runtime_source: source,
      })
      control.onCancel(() => jobRunner.cancelJob(id))
      await new Promise((resolve, reject) => {
        let unsubscribe = () => {}
        const inspect = job => {
          if (!job || Number(job.id) !== Number(id) || !['done', 'error', 'cancelled'].includes(job.status)) return
          unsubscribe()
          if (job.status === 'cancelled' || control.isCancelled()) reject(new Error('index cancelled during reply metadata preparation'))
          else if (job.status === 'error') reject(new Error(job.error || 'reply metadata unavailable'))
          else resolve()
        }
        try {
          unsubscribe = jobRunner.subscribe(inspect)
          inspect(jobRunner.getJobDetail(id))
        } catch (error) { unsubscribe(); reject(error) }
      })
    } catch (error) {
      if (control.isCancelled()) throw error
      // Local semantic indexing must remain usable offline. Missing reply
      // metadata is explicit in the reader, not invented or treated as ready.
      logger.warn?.(`[TelegramRag] reply preparation source #${request.sourceId} unavailable; indexing saved local input: ${error.message}`)
    } finally {
      control.onCancel(() => {})
    }
  }
}

module.exports = { createTelegramRagPreparation }
