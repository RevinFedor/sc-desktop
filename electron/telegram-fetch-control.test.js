'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-fetch-control-'))
process.env.SC_DESKTOP_DB = path.join(root, 'library.db')
process.env.SC_DESKTOP_DIR = root
const db = require('./database')
const { createTelegramFetchControl } = require('./telegram-fetch-control')
const { validateTelegramFetchPolicy, checkTelegramMediaStorage } = require('./telegram-fetch-policy')
let calls = 0
const live = new Map()
const runner = {
  startTelegramFetch(params) {
    calls++
    const job = { id: calls, db_id: params._reserved_job_row_id,
      status: 'running', type: 'tg_fetch', params }
    live.set(`db-${params._reserved_job_row_id}`, job)
    live.set(calls, job)
    return calls
  },
  getJobDetail: id => live.get(id),
  listJobs: () => [...live.values()],
}
const control = createTelegramFetchControl({ database: () => db, jobRunner: runner })
test.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }) })

test('durable repeated request/concurrent callers reserve one original job and reject payload changes', async () => {
  const input = { request_id: 'night-fixture', target: '-100123', mode: 'all', full_history: true,
    session: 'fixture', voice_types: ['voice', 'audio'], voice_max_duration_sec: 1200 }
  const [a, b] = await Promise.all([Promise.resolve().then(() => control.start(input)), Promise.resolve().then(() => control.start(input))])
  assert.equal(calls, 1)
  assert.equal(a.job_id, 'fetch:night-fixture')
  assert.equal(a.job.params.origin, 'mcp')
  assert.equal(a.job.params.autoCopy, false)
  assert.equal(a.db_job_id, b.db_job_id)
  assert.equal(b.idempotent, true)
  assert.throws(() => control.start({ ...input, target: '-100999' }), error => error.code === 'FETCH_REQUEST_PAYLOAD_MISMATCH')
  assert.throws(() => control.resume('night-fixture', 'night-resume'), error => error.code === 'FETCH_RESUME_NOT_TERMINAL')
})

test('lost acknowledgement/readback and new controller recover the durable row without another spawn', () => {
  const reset = createTelegramFetchControl({ database: () => db, jobRunner: { ...runner, getJobDetail: () => null } })
  const status = reset.status('night-fixture')
  assert.equal(status.job_id, 'fetch:night-fixture')
  assert.equal(status.completion_is_persisted, false)
  assert.equal(calls, 1)
  assert.throws(() => reset.status('unknown'), error => error.code === 'FETCH_REQUEST_NOT_FOUND')
})

test('confirmed cancellation can resume under a new exact durable key, original identity is retained', () => {
  live.get('db-1').status = 'cancelled'
  db.updateJob(1, { status: 'cancelled' })
  const resumed = control.resume('night-fixture', 'night-resume')
  assert.equal(resumed.job_id, 'fetch:night-resume')
  assert.equal(resumed.job.params.resume_of, 'night-fixture')
  assert.equal(resumed.job.params.origin, 'mcp')
  assert.equal(resumed.job.params.autoCopy, false)
  assert.equal(resumed.resume_mode, 'restart_traversal_reuse_completed_transcripts')
  assert.equal(calls, 2)
  assert.equal(control.status('night-fixture').job.status, 'cancelled')
})

test('policy preserves defaults and rejects misleading full history and unsafe duration/types', () => {
  assert.deepEqual(validateTelegramFetchPolicy({ target: 'old', mode: 'last_n' }), { target: 'old', mode: 'last_n' })
  for (const value of [{ mode: 'all', full_history: true, limit: 500 }, { mode: 'all', full_history: true, sinceMessageId: 1 },
    { voice_max_duration_sec: 0 }, { voice_max_duration_sec: NaN }, { voice_types: ['photo'] }, { media_cache_dir: '/' }]) {
    assert.throws(() => validateTelegramFetchPolicy(value))
  }
  assert.equal(validateTelegramFetchPolicy({ mode: 'all', full_history: true }).skipDupes, false)
  const directory = path.join(root, 'owned-media')
  assert.equal(checkTelegramMediaStorage(directory, 1048576).writable, true)
  assert.throws(() => checkTelegramMediaStorage(directory, Number.MAX_SAFE_INTEGER), error => error.code === 'MEDIA_STORAGE_UNAVAILABLE')
})
