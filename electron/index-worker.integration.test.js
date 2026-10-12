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
  assert.equal(done.unit, 'messages')
  assert.equal(done.messages_selected, 240)
  assert.equal(db.semanticChunkIndexStatus(sourceId).done, 240)
  assert.equal(db.vectorCountForSource(sourceId), 0, 'new fragment indexing must not overwrite legacy vectors')
  assert.ok(heartbeats > 0, `expected parent-loop heartbeats, got ${heartbeats}`)
  assert.deepEqual(await indexJob.start({ sourceId, origin: 'unchanged-resume' }), {
    noop: true, reason: 'already-indexed',
  })
})

test('YouTube transcripts are chunked, embedded and searchable by passage', async () => {
  const sourceId = db.upsertSource({
    platform: 'youtube', handle: 'youtube-index-fixture', display_name: 'YouTube fixture',
    external_id: 'UCfixture', meta: {}, is_explicit: true,
  })
  const transcriptPath = path.join(tempRoot, 'fixture-transcript.txt')
  const transcript = Array.from({ length: 180 }, (_, index) => (
    `Part ${index}. The hydraulic control loop coordinates pressure sensors and emergency valves.`
  )).join(' ')
  fs.writeFileSync(
    transcriptPath,
    '# Hydraulic system\nchannel: YouTube fixture\nurl: https://youtube.com/watch?v=fixture0001\nsource: subs\n\n' + transcript,
  )
  db.bulkUpsertItems([{
    source_id: sourceId,
    external_id: 'fixture0001',
    type: 'video',
    title: 'Hydraulic system',
    url: 'https://youtube.com/watch?v=fixture0001',
    duration_seconds: 900,
    published_at: 1_700_000_000,
  }])
  db.markItemTranscribed({
    source_id: sourceId,
    external_id: 'fixture0001',
    transcript_path: transcriptPath,
    engine: 'subs',
    cost_usd: 0,
  })

  const terminal = new Promise(resolve => {
    const off = indexJob.subscribe(job => {
      if (job.source_id !== sourceId || job.type !== 'yt_index') return
      if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') {
        off()
        resolve(job)
      }
    })
  })
  const jobId = await indexJob.start({ sourceId, mode: 'youtube', origin: 'integration-test' })
  assert.equal(jobId, 'index-3')
  const done = await terminal

  assert.equal(done.status, 'done')
  const status = db.semanticChunkIndexStatus(sourceId)
  assert.ok(status.total > 2)
  assert.equal(status.done, status.total)
  const query = new Float32Array(768)
  query[0] = 1
  const hits = db.semanticChunkSearch({ query_embedding: query, source_id: sourceId, limit: 5 })
  assert.ok(hits.length > 0)
  assert.equal(hits[0].external_id, 'fixture0001')
  assert.match(hits[0].text, /hydraulic control loop/i)
})

test('in-flight Telegram cancellation leaves no partial batch vectors and resume completes the saved fragments', async () => {
  const sourceId = db.upsertSource({
    platform: 'telegram', handle: 'index-worker-cancel', display_name: 'cancel fixture',
    external_id: '88002', tg_session: 'fixture', is_explicit: true,
  })
  db.bulkUpsertItems(Array.from({ length: 12 }, (_, index) => ({
    source_id: sourceId, external_id: String(index + 1), type: 'text',
    caption: `cancel fixture ${index}`, published_at: 1_700_000_000 + index,
  })))
  process.env.SC_INDEX_WORKER_FIXTURE_DELAY_MS = '1000'
  const waitTerminal = () => new Promise(resolve => {
    const off = indexJob.subscribe(job => {
      if (job.source_id === sourceId && ['done', 'error', 'cancelled'].includes(job.status)) {
        off()
        resolve(job)
      }
    })
  })
  const cancelled = waitTerminal()
  const jobId = await indexJob.start({ sourceId, origin: 'cancel-test' })
  assert.equal(indexJob.cancelById(jobId), true)
  const terminal = await cancelled
  delete process.env.SC_INDEX_WORKER_FIXTURE_DELAY_MS
  assert.equal(terminal.status, 'cancelled')
  assert.equal(terminal.items_done, 0)
  assert.equal(db.semanticChunkIndexStatus(sourceId).done, 0)
  assert.equal(db.semanticChunkIndexStatus(sourceId).total, 0, 'staged fragments must remain outside the searchable table')

  const resumed = waitTerminal()
  await indexJob.start({ sourceId, origin: 'cancel-resume-test' })
  assert.equal((await resumed).status, 'done')
  assert.equal(db.semanticChunkIndexStatus(sourceId).done, 12)
})

test('partially embedded long messages resume from durable staging after worker cancellation', async () => {
  const sourceId = db.upsertSource({
    platform: 'telegram', handle: 'index-worker-partial', display_name: 'partial fixture',
    external_id: '88003', tg_session: 'fixture', is_explicit: true,
  })
  db.upsertItem({
    source_id: sourceId, external_id: '1', type: 'text', published_at: 1_700_000_000,
    caption: `${'resumable long caption '.repeat(8000)}tail-only-needle`,
  })
  process.env.SC_INDEX_WORKER_FIXTURE_DELAY_MS = '1000'
  const cancelled = new Promise(resolve => {
    const off = indexJob.subscribe(job => {
      if (job.source_id !== sourceId) return
      if (job.status === 'running' && job.fragments_embedded >= 100) indexJob.cancelById(job.id)
      if (job.status === 'cancelled' || job.status === 'error') {
        off()
        resolve(job)
      }
    })
  })
  await indexJob.start({ sourceId, origin: 'partial-cancel' })
  const terminal = await cancelled
  delete process.env.SC_INDEX_WORKER_FIXTURE_DELAY_MS
  assert.equal(terminal.status, 'cancelled')
  assert.equal(terminal.items_done, 0)
  assert.equal(terminal.fragments_embedded, 100)
  assert.equal(db.semanticChunkIndexStatus(sourceId).done, 0)
  const staged = db.getDb().prepare(`
    SELECT COUNT(*) AS n FROM telegram_rag_generation_chunks c
    JOIN telegram_rag_generations g ON g.generation_id = c.generation_id
    WHERE g.source_id = ? AND g.status = 'staging' AND c.embedding IS NOT NULL
  `).get(sourceId).n
  assert.equal(staged, 100)

  const resumed = new Promise(resolve => {
    const off = indexJob.subscribe(job => {
      if (job.source_id === sourceId && ['done', 'error'].includes(job.status)) {
        off()
        resolve(job)
      }
    })
  })
  await indexJob.start({ sourceId, origin: 'partial-resume' })
  const done = await resumed
  assert.equal(done.status, 'done')
  assert.equal(done.items_done, 1)
  assert.ok(done.fragments_embedded < 100, 'resume should reuse the first 100 staged vectors')
  assert.ok(db.semanticChunkIndexStatus(sourceId).done > 100)
})

test('tracked preparation is visible and cancellable before the real worker has prepared any generation', async () => {
  const sourceId = db.upsertSource({
    platform: 'telegram', handle: 'index-worker-tracked-prep', display_name: 'tracked fixture',
    external_id: '88004', tg_session: 'fixture', is_explicit: true,
  })
  db.upsertItem({ source_id: sourceId, external_id: '1', type: 'text', caption: 'never embedded fixture' })
  process.env.SC_INDEX_WORKER_FIXTURE_PREPARE_DELAY_MS = '1000'
  const terminal = new Promise(resolve => {
    const off = indexJob.subscribe(job => {
      if (job.source_id === sourceId && ['error', 'cancelled', 'done'].includes(job.status)) {
        off()
        resolve(job)
      }
    })
  })
  const accepted = indexJob.startTracked({ sourceId, origin: 'tracked-prep-cancel' })
  assert.equal(accepted.phase, 'starting')
  assert.equal(accepted.status, 'running')
  assert.equal(accepted.db_id, null)
  assert.equal(indexJob.currentSnapshot(sourceId).id, accepted.id)
  assert.equal(indexJob.getActiveSnapshot(accepted.id).phase, 'starting')
  assert.equal(indexJob.cancelById(accepted.id), true)
  const done = await terminal
  delete process.env.SC_INDEX_WORKER_FIXTURE_PREPARE_DELAY_MS
  assert.equal(done.status, 'cancelled')
  assert.equal(done.phase, 'terminal')
  assert.equal(db.semanticChunkIndexStatus(sourceId).total, 0)
  assert.equal(db.getDb().prepare('SELECT COUNT(*) AS n FROM telegram_rag_generations WHERE source_id = ?').get(sourceId).n, 0)
})

test('tracked local item selection reaches the actual worker without indexing newer unrequested messages', async () => {
  const sourceId = db.upsertSource({
    platform: 'telegram', handle: 'index-worker-selected-items', display_name: 'selection fixture',
    external_id: '88005', tg_session: 'fixture', is_explicit: true,
  })
  const selectedId = db.upsertItem({
    source_id: sourceId, external_id: '1', type: 'text', caption: 'older explicit target', published_at: 100,
  })
  const excludedId = db.upsertItem({
    source_id: sourceId, external_id: '2', type: 'text', caption: 'newer unrequested target', published_at: 200,
  })
  const terminal = new Promise(resolve => {
    const off = indexJob.subscribe(job => {
      if (job.source_id === sourceId && ['done', 'error', 'cancelled'].includes(job.status)) {
        off()
        resolve(job)
      }
    })
  })
  const accepted = indexJob.startTracked({ sourceId, itemIds: [selectedId], origin: 'selected-items-test' })
  assert.equal(accepted.phase, 'starting')
  const done = await terminal
  assert.equal(done.status, 'done')
  assert.equal(done.id, accepted.id)
  assert.equal(done.items_done, 1)
  assert.equal(done.messages_selected, 1)
  const chunksFor = db.getDb().prepare('SELECT COUNT(*) AS n FROM semantic_chunks WHERE item_id = ?')
  assert.equal(chunksFor.get(selectedId).n, 1)
  assert.equal(chunksFor.get(excludedId).n, 0)
})
