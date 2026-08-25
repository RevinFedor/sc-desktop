const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-index-worker-'))
process.env.SC_DESKTOP_DIR = tempRoot
process.env.SC_DESKTOP_DB = path.join(tempRoot, 'library.db')
process.env.SC_INDEX_WORKER_FIXTURE = '1'

const db = require('./database')
const indexJob = require('./index-job')

test.after(() => {
  db.close()
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

test('index selection, context, embedding and vector writes stay off main', async () => {
  const sourceId = db.upsertSource({
    platform: 'telegram', handle: 'index-worker-fixture', display_name: 'fixture',
    external_id: '88001', meta: { kind: 'channel' }, is_explicit: true,
    tg_session: 'fixture',
  })
  db.bulkUpsertItems(Array.from({ length: 240 }, (_, index) => ({
    source_id: sourceId,
    external_id: String(index + 1),
    type: 'text',
    caption: `message ${index} ${'x'.repeat(200)}`,
    published_at: 1_700_000_000 + index,
    sender: `user-${index % 5}`,
  })))

  const terminal = new Promise(resolve => {
    const off = indexJob.subscribe(job => {
      if (job.source_id !== sourceId) return
      if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') {
        off()
        resolve(job)
      }
    })
  })
  let heartbeats = 0
  const timer = setInterval(() => { heartbeats += 1 }, 1)
  const jobId = await indexJob.start({ sourceId, limit: null, origin: 'integration-test' })
  assert.equal(jobId, 'index-1')
  const done = await terminal
  clearInterval(timer)

  assert.equal(done.status, 'done')
  assert.equal(done.items_done, 240)
  assert.equal(db.vectorCountForSource(sourceId), 240)
  assert.ok(heartbeats > 0, `expected parent-loop heartbeats, got ${heartbeats}`)
})
