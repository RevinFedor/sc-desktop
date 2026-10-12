'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { Worker } = require('node:worker_threads')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-boosty-worker-test-'))
process.env.SC_DESKTOP_DIR = root
process.env.SC_DESKTOP_DB = path.join(root, 'fixture.db')
process.env.SC_INDEX_WORKER_FIXTURE = '1'
process.env.SC_INDEX_WORKER_FIXTURE_DELAY_MS = '1'
const db = require('./database')
const rag = require('./boosty-rag')
test.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }) })
let jobId = 900
function run(sourceId, onProgress = null) {
  return new Promise((resolve, reject) => {
    const cancelBuffer = new SharedArrayBuffer(4), view = new Int32Array(cancelBuffer), events = []
    const worker = new Worker(path.join(__dirname, 'index-worker.js'), {
      workerData: { operation: 'index', mode: 'boosty', sourceId, jobId: ++jobId, origin: 'synthetic-worker-test',
        requestId: `fixture-${jobId}`, cancelBuffer }, env: { ...process.env },
    })
    let result = null
    worker.on('message', message => {
      events.push(message)
      if (message.type === 'progress') onProgress?.(message, () => { Atomics.store(view, 0, 1); worker.postMessage({ type: 'cancel' }) })
      if (['terminal', 'fatal'].includes(message.type)) result = message
    })
    worker.on('error', reject)
    worker.on('exit', code => {
      if (!result || result.type === 'fatal' || code !== 0) reject(new Error(`Worker failure ${code}: ${JSON.stringify(result)}`))
      else resolve({ result, events })
    })
  })
}

test('real worker_threads fixture cancel → durable staged vectors → resume → atomic current-ready → idempotent no embeddings', async () => {
  const sid = db.upsertSource({ platform: 'boosty', handle: 'worker-fixture', external_id: 'worker-fixture' })
  const id = db.upsertItem({ source_id: sid, external_id: 'child-fixture', type: 'boosty_video', parent_external_id: 'post-fixture', published_at: 100 })
  const file = path.join(root, 'worker.txt')
  fs.writeFileSync(file, 'Full original LoRA 👩‍💻 adapters and their precise explanation.\n'.repeat(3500))
  db.getDb().prepare('UPDATE items SET transcript_path=? WHERE id=?').run(file, id)
  const expectedChunks = rag.document(db, id).chunks.length
  assert.ok(expectedChunks > 100)
  const first = await run(sid, (message, cancel) => { if (message.fragmentsEmbedded >= 100) cancel() })
  assert.equal(first.result.status, 'cancelled')
  assert.equal(db.getDb().prepare('SELECT status FROM jobs WHERE id=?').get(first.result.dbRowId).status, 'cancelled')
  const status = rag.indexStatus(db, { source_id: sid })
  assert.equal(status.ready_interviews, 0)
  // Cancellation is observed between embedding batches. A second in-flight
  // fixture batch can finish before Main handles progress under parallel load;
  // the contract is durable actual stage/no partial publication, not exactly100.
  assert.ok(status.staged >= 100 && status.staged < expectedChunks)
  assert.equal(db.getDb().prepare('SELECT COUNT(*) AS n FROM semantic_chunks WHERE source_id=?').get(sid).n, 0)
  const second = await run(sid)
  assert.equal(second.result.status, 'done')
  assert.equal(second.events.find(event => event.type === 'started').fragmentsTotal, expectedChunks - status.staged)
  assert.equal(second.result.itemsDone, 1)
  assert.equal(rag.indexStatus(db, { source_id: sid }).current_ready, true)
  const third = await run(sid)
  assert.equal(third.result.status, 'done')
  assert.equal(third.events.find(event => event.type === 'started').fragmentsTotal, 0)
  assert.equal(third.events.filter(event => event.type === 'progress').length, 0)
  assert.equal(db.getDb().prepare('SELECT COUNT(*) AS n FROM jobs WHERE type=? AND source_id=?').get('boosty_index', sid).n, 3)
})
