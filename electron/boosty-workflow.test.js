'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { spawn: realSpawn } = require('node:child_process')
const { EventEmitter, once } = require('node:events')
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sc-boosty-workflow-')))
const usb = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sc-boosty-USB-DOUBLE-')))
process.env.SC_DESKTOP_DIR = root
process.env.SC_DESKTOP_DB = path.join(root, 'library.db')
const db = require('./database')
const rag = require('./boosty-rag')
const safety = require('./boosty-workflow-safety')
const { createBoostyWorkflow } = require('./boosty-workflow')
const { createBoostyWorkflowApi } = require('./boosty-workflow-api')
const { callBoostyWorkflowTool, boostyWorkflowTools } = require('../mcp/boosty-workflow-tools')
const { createBoostyRagClient } = require('../mcp/boosty-rag-client')
const events = new EventEmitter(), jobs = new Map(), calls = [], indexEvents = new EventEmitter()
const parent = '11111111-1111-4111-8111-111111111111'
const ids = ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444']
const url = `https://boosty.to/fixture/posts/${parent}`
const sid = db.upsertSource({ platform: 'boosty', handle: 'fixture', external_id: '12345', display_name: 'Fixture' })
const pid = db.upsertItem({ source_id: sid, external_id: `post:${parent}`, type: 'boosty_post', caption: 'OLD FULL POST must survive teaser', title: 'OLD', url })
const oldMedia = path.join(usb, 'user-old-audio.mp3'); fs.writeFileSync(oldMedia, 'old user media')
const oldChild = db.upsertItem({ source_id: sid, external_id: ids[0], parent_external_id: `post:${parent}`, type: 'boosty_video', title: 'old', url, media_path: oldMedia })
const txtRoot = path.join(root, 'transcripts/boosty'); fs.mkdirSync(txtRoot, { recursive: true })
const oldTxt = path.join(txtRoot, 'old.txt'); fs.writeFileSync(oldTxt, 'old complete transcript')
fs.writeFileSync(oldTxt.replace('.txt', '.srt'), '1\n00:00:00,000 --> 00:00:01,000\nold complete transcript\n')
db.markItemTranscribed({ source_id: sid, external_id: ids[0], transcript_path: oldTxt, engine: 'assemblyai' })
const oldHash = rag.document(db, oldChild).documentHash
const fixturePath = path.join(root, 'fixture.json')
fs.writeFileSync(fixturePath, JSON.stringify({ speech_models: ['universal-2'], entity: { author_handle: 'fixture', author_id: '12345', title: 'Fixture', posts_count: 2 }, posts: [
  { post_id: parent, external_id: `post:${parent}`, canonical_url: url, title: 'Public teaser', text: 'TEASER', has_access: true, video_count: 3,
    videos: ids.map((video_id, i) => ({ video_id, position: i + 1, title: `child ${i}`, duration_sec: 20 })) },
  { post_id: '55555555-5555-4555-8555-555555555555', external_id: 'post:55555555-5555-4555-8555-555555555555', canonical_url: 'https://boosty.to/fixture/posts/55555555-5555-4555-8555-555555555555', title: 'locked', has_access: false, text: '', video_count: 4, videos: [] },
] }))
const python = path.resolve(__dirname, '../.venv/bin/python3'), workers = path.resolve(__dirname, '../python-workers')
const index = {
  currentSnapshot: () => null, getActiveSnapshot: () => null,
  subscribe: fn => { indexEvents.on('job', fn); return () => indexEvents.off('job', fn) }, cancelById() {},
  startTracked(args) {
    const id = `test-index-${calls.length}`; calls.push({ kind: 'index', args })
    queueMicrotask(() => {
      const selected = rag.prepareIndex(db, { source_id: args.sourceId, item_ids: args.itemIds })
      for (const pending of selected.pending) {
        const vectors = pending.rows.map(() => { const vector = new Float32Array(768); vector[0] = 1; return vector })
        if (vectors.length) rag.saveBatch(db, pending.rows, vectors)
        rag.publish(db, pending.doc)
      }
      indexEvents.emit('job', { id, phase: 'terminal', status: 'done' })
    })
    return { id, status: 'running' }
  },
}
let sequence = 1, failDisk = false, failDownload = false, holdDownload = false
function workflow() {
  return createBoostyWorkflow({ db, jobs, allocateId: () => sequence++, libraryRoot: root, python, workersRoot: workers, indexJob: index,
    emit: job => events.emit('job', job), markJobClosed() {}, logger: { log() {} },
    authProvider: async () => ({ value: 'AUTH_DOUBLE_NEVER_EXPORTED', expirationDate: 99999999 }),
    workerEnv: () => ({ ...process.env, SC_DESKTOP_DIR: root, BOOSTY_WORKFLOW_FIXTURE: fixturePath, ASSEMBLYAI_API_KEY: 'TEST_ONLY_KEY', BOOSTY_TEST_FAIL_DOWNLOAD: failDownload ? '1' : '0', BOOSTY_TEST_HOLD_DOWNLOAD: holdDownload ? '1' : '0' }),
    spawn: (exe, argv, opts) => {
      const entry = { kind: 'python', argv, output: '', stderr: '' }; calls.push(entry)
      const child = realSpawn(exe, [path.resolve(__dirname, '../tests/fixtures/replay_boosty_workflow.py'), ...argv], opts)
      child.stdout.on('data', data => { entry.output += data }); child.stderr.on('data', data => { entry.stderr += data }); return child
    },
    // PHYSICAL-DISK DOUBLE, NOT proof of actual external mount readiness.
    probeOverride: async c => {
      if (failDisk) throw Object.assign(new Error('USB double absent'), { code: 'BOOSTY_STORAGE_UNVERIFIED' })
      c.audio_dir = c.audio_dir.replace('/Volumes/SC-TEST-USB', usb)
      c.work_dir = c.work_dir.replace('/Volumes/SC-TEST-USB', usb)
      c.external_mount = usb
      return { ok: true, volume_uuid: 'TEST-USB', roots: { audio_dir: c.audio_dir, work_dir: c.work_dir }, free_bytes: 99 * 1024 ** 3 }
    },
  })
}
let current = workflow()
const token = 'c'.repeat(64)
const api = createBoostyWorkflowApi({ token, workflow: {
  preflight: p => current.preflight(p), start: p => current.start(p), resume: p => current.resume(p), status: id => current.status(id),
  cleanup: p => current.cleanup(p), cancel: id => current.cancel(id), storage: () => ({ ok: true, test_double: true }),
  diarization: p => current.diarization(p),
}, readBody: async req => { let str = ''; for await (const part of req) str += part; return JSON.parse(str) },
sendJson: (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) } })
const server = http.createServer(async (req, res) => { if (!await api.handle(req, res, new URL(req.url, 'http://127.0.0.1'))) { res.writeHead(404); res.end('{}') } })
let base
test.before(async () => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}` })
test.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(usb, { recursive: true, force: true }) })
async function call(route, input, headers = { Authorization: `Bearer ${token}` }) {
  const response = await fetch(`${base}/boosty-workflow/${route}`, { method: input ? 'POST' : 'GET', headers, body: input ? JSON.stringify(input) : undefined })
  return { status: response.status, body: await response.json() }
}
async function finish(id) {
  const value = current.status(id)
  if (['done', 'error', 'cancelled'].includes(value.status)) return value
  return new Promise((resolve, reject) => {
    const fn = j => { if (j.params.workflow_id === id && j.phase === 'terminal') { clearTimeout(timer); events.off('job', fn); resolve(current.status(id)) } }
    const timer = setTimeout(() => { events.off('job', fn); reject(new Error('Isolated test terminal deadline')) }, 15000)
    events.on('job', fn)
  })
}
const profile = { engine: 'assemblyai', release_id: 'TEST_ONLY_APPROVAL', approved_by_user: true, speech_models: ['universal-2'], language_detection: true, speaker_labels: true, estimated_cost_usd: 1, max_cost_usd: 2 }
let plan, startInput

test('HTTP authorization, Origin, no secrets/unknown fields, model-cost HOLD before dispatch', async () => {
  assert.equal((await call('storage', null, {})).status, 401)
  assert.equal((await call('storage', null, { Authorization: `Bearer ${token}`, Origin: 'chrome-extension://forged' })).status, 403)
  assert.equal((await call('preflight', { handle: 'fixture', request_id: 'bad', authCookie: 'NO' })).status, 400)
  const n = calls.length
  assert.equal((await call('start', { request_id: 'no-release', confirm_asr: true })).body.code, 'BOOSTY_ASR_MODEL_COST_RELEASE_REQUIRED')
  assert.equal(calls.length, n)
  assert.equal((await call('capabilities')).body.soniox_adapter, false)
  assert.equal(boostyWorkflowTools.length, 9)
})

test('real HTTP→engine→actual Python account preflight preserves old body/child, exact ledger revision, no media/ASR', async () => {
  const input = { request_id: 'plan1', handle: 'fixture', external_mount: '/Volumes/SC-TEST-USB' }
  const accepted = await call('preflight', input)
  assert.equal(accepted.body.accepted, true)
  plan = await finish(accepted.body.job_id)
  assert.equal(plan.status, 'done', JSON.stringify(plan))
  assert.equal(plan.plan.children.length, 3)
  assert.equal(plan.plan.children.filter(c => c.state === 'missing').length, 2)
  assert.equal(plan.plan.posts.find(p => p.has_access === false).text_state, 'locked')
  assert.equal(rag.document(db, oldChild).documentHash, oldHash)
  assert.equal(db.getItemsByExternalIds(sid, [`post:${parent}`])[0].caption, 'OLD FULL POST must survive teaser')
  assert.ok(!fs.existsSync(path.join(root, 'fixture-paid-submissions.jsonl')))
  current = workflow() // service recreation reads the same durable receipt
  assert.equal((await call('preflight', input)).body.deduplicated, true)
  assert.equal((await call('preflight', { ...input, handle: 'different' })).body.code, 'BOOSTY_REQUEST_ID_CONFLICT')
  const page = (await call(`ledger?job_id=${plan.job_id}&limit=1`)).body
  assert.equal(page.rows.length, 1)
  assert.equal((await call(`ledger?job_id=${plan.job_id}&offset=1&limit=1&expected_revision=WRONG`)).status, 409)
  assert.equal((await call(`ledger?job_id=${plan.job_id}&offset=1&limit=1&expected_revision=${page.revision}`)).body.rows.length, 1)
  assert.ok(!/AUTH_DOUBLE|TEST_ONLY_KEY|signedQuery|playerUrls/.test(JSON.stringify(plan)))
})

test('missing USB refuses start before paid worker; ready child and changed scope refuse replay', async () => {
  startInput = { request_id: 'catch1', plan_id: plan.job_id, expected_plan_hash: plan.plan_hash, confirm_asr: true, asr_profile: profile }
  assert.equal((await call('start', { ...startInput, video_ids: [ids[0]] })).body.code, 'BOOSTY_SELECTION_NOT_MISSING_AUTHORIZED')
  failDisk = true
  assert.equal((await call('start', startInput)).body.code, 'BOOSTY_STORAGE_UNVERIFIED')
  failDisk = false
  assert.ok(!fs.existsSync(path.join(root, 'fixture-paid-submissions.jsonl')))
})

test('MCP→actual HTTP→engine→actual strict Python+receipts→Mac TXT/SRT→real vec publication→same-child original/cues→own cleanup', async () => {
  const client = createBoostyRagClient({ baseUrl: base, tokenReader: () => token })
  const out = await callBoostyWorkflowTool('boosty_catchup_start', startInput, client)
  const accepted = JSON.parse(out.content[0].text)
  assert.equal(accepted.accepted, true, JSON.stringify(accepted))
  const done = await finish(accepted.job_id)
  assert.equal(done.status, 'done', JSON.stringify({ done, workers: calls.filter(c => c.kind === 'python') }))
  assert.equal(done.ledger.filter(c => c.state === 'ready_evicted').length, 2)
  assert.equal(done.coverage.ready_interviews, 3)
  assert.equal(done.coverage.ready_posts, 1)
  assert.equal(done.coverage.missing_posts, 1)
  const paid = fs.readFileSync(path.join(root, 'fixture-paid-submissions.jsonl'), 'utf8').trim().split('\n')
  assert.equal(paid.length, 2)
  for (const c of done.ledger) {
    assert.ok(c.pair.txt.path.startsWith(txtRoot)); assert.ok(c.pair.srt.path.startsWith(txtRoot))
    assert.ok(fs.existsSync(c.pair.txt.path)); assert.ok(fs.existsSync(c.pair.srt.path))
    assert.ok(c.media_manifest.every(m => !fs.existsSync(m.path)))
    assert.equal(rag.readOriginal(db, { item_id: c.item_id, expected_document_hash: c.document_hash }).video_external_id, c.video_id)
    assert.equal(rag.context(db, { item_id: c.item_id, expected_document_hash: c.document_hash, cue_index: 0 }).cues.length, 2)
    const dia = (await call(`diarization?job_id=${done.job_id}&video_id=${c.video_id}&expected_document_hash=${c.document_hash}&limit=1`)).body
    assert.equal(dia.utterances[0].speaker_label, 'A'); assert.equal(dia.utterances[0].role, null)
    assert.equal((await call(`diarization?job_id=${done.job_id}&video_id=${c.video_id}&expected_document_hash=${c.document_hash}&offset=1&expected_diarization_hash=WRONG`)).body.code, 'BOOSTY_DIARIZATION_CHANGED')
  }
  assert.equal(rag.document(db, oldChild).documentHash, oldHash)
  assert.equal(fs.readFileSync(oldMedia, 'utf8'), 'old user media')
  assert.equal(db.getItemsByExternalIds(sid, [ids[0]])[0].media_path, oldMedia)
  current = workflow()
  assert.equal((await call('start', startInput)).body.deduplicated, true)
  assert.equal(fs.readFileSync(path.join(root, 'fixture-paid-submissions.jsonl'), 'utf8').trim().split('\n').length, 2)
  assert.equal((await call('cleanup', { job_id: done.job_id, video_id: done.ledger[0].video_id })).status, 200)
  const all = (await call(`ledger?job_id=${done.job_id}`)).body
  assert.equal(all.rows.length, 3)
  assert.ok(all.rows.find(c => c.video_id === ids[0]).state.startsWith('reused'))
})

test('cleanup refuses changed original, symlink and unexpected own file; old user media unaffected', () => {
  const directory = path.join(usb, 'unit-owned'), owner = { id: 'unique' }
  safety.ownedDirectory(directory, owner)
  fs.writeFileSync(path.join(directory, 'audio.mp3'), 'owned audio')
  const manifest = safety.mediaManifest(directory, owner)
  fs.writeFileSync(path.join(directory, 'audio.mp3'), 'changed audio')
  assert.throws(() => safety.evictManifest(directory, owner, manifest), { code: 'BOOSTY_MEDIA_CHANGED' })
  fs.symlinkSync(oldMedia, path.join(directory, 'escape.mp3'))
  assert.throws(() => safety.mediaManifest(directory, owner), { code: 'BOOSTY_MEDIA_OWNERSHIP_UNVERIFIED' })
  assert.ok(fs.existsSync(oldMedia))
  const proof = safety.verifyPair(oldTxt, txtRoot)
  fs.appendFileSync(oldTxt, ' changed')
  assert.throws(() => safety.sameFile(proof.txt, txtRoot), { code: 'BOOSTY_FILE_CHANGED' })
  fs.writeFileSync(oldTxt, 'old complete transcript')
})

test('download error is terminal/retained; exact resume uses original ownership and finishes only missing child', async () => {
  const newId = '66666666-6666-4666-8666-666666666666'
  const data = JSON.parse(fs.readFileSync(fixturePath, 'utf8'))
  data.posts[0].videos.push({ video_id: newId, title: 'new after failure', position: 4, duration_sec: 20 })
  fs.writeFileSync(fixturePath, JSON.stringify(data))
  const p = (await call('preflight', { request_id: 'plan2', handle: 'fixture', external_mount: '/Volumes/SC-TEST-USB' })).body
  const planned = await finish(p.job_id)
  failDownload = true
  const a = (await call('start', { ...startInput, request_id: 'failed2', plan_id: p.job_id, expected_plan_hash: planned.plan_hash })).body
  const error = await finish(a.job_id)
  assert.equal(error.status, 'error'); assert.equal(error.ledger[0].video_id, newId)
  assert.ok(fs.existsSync(path.join(error.ledger[0].owned_root, '.sc-boosty-owner.json')))
  assert.equal((await call('cleanup', { job_id: a.job_id, video_id: newId })).body.code, 'BOOSTY_INVALID_CLEANUP')
  const n = fs.readFileSync(path.join(root, 'fixture-paid-submissions.jsonl'), 'utf8').trim().split('\n').length
  failDownload = false
  const r = (await call('resume', { job_id: a.job_id, request_id: 'resume2' })).body
  const done = await finish(r.job_id)
  assert.equal(done.status, 'done', JSON.stringify(done))
  assert.equal(done.ledger[0].owner.workflow_id, a.job_id)
  assert.equal(done.ledger[0].owned_root, error.ledger[0].owned_root)
  assert.equal(fs.readFileSync(path.join(root, 'fixture-paid-submissions.jsonl'), 'utf8').trim().split('\n').length, n + 1)
  assert.equal((await call('resume', { job_id: a.job_id, request_id: 'resume2' })).body.deduplicated, true)
})

test('unknown paid submission blocks replacement AND exact resume without another worker, no deletion', async () => {
  const newId = '77777777-7777-4777-8777-777777777777'
  const data = JSON.parse(fs.readFileSync(fixturePath, 'utf8'))
  data.posts[0].videos.push({ video_id: newId, title: 'unknown paid', position: 5, duration_sec: 20 })
  fs.writeFileSync(fixturePath, JSON.stringify(data))
  const p = (await call('preflight', { request_id: 'plan3', handle: 'fixture', external_mount: '/Volumes/SC-TEST-USB' })).body
  const planned = await finish(p.job_id)
  failDownload = true
  const a = (await call('start', { ...startInput, request_id: 'failed3', plan_id: p.job_id, expected_plan_hash: planned.plan_hash })).body
  await finish(a.job_id); failDownload = false
  const paid = path.join(root, 'jobs/boosty-asr-receipts', String(sid), `${newId}.json`)
  fs.mkdirSync(path.dirname(paid), { recursive: true }); fs.writeFileSync(paid, JSON.stringify({ state: 'submit_inflight', identity: { source_id: sid, video_id: newId } }))
  const count = calls.filter(c => c.kind === 'python').length
  assert.equal((await call('start', { ...startInput, request_id: 'replace-unknown', plan_id: p.job_id, expected_plan_hash: planned.plan_hash })).body.code, 'BOOSTY_EXISTING_PAID_RECEIPT')
  const r = (await call('resume', { job_id: a.job_id, request_id: 'resume-unknown' })).body
  const error = await finish(r.job_id)
  assert.equal(error.error_code, 'BOOSTY_ASR_DELIVERY_UNKNOWN')
  assert.equal(calls.filter(c => c.kind === 'python').length, count)
  assert.ok(fs.existsSync(paid)); assert.ok(!error.ledger[0].cleanup)
})

test('actual HTTP cancel waits for own Python exit, retains audio, exact resume reuses it without ready replay', async () => {
  const newId = '88888888-8888-4888-8888-888888888888'
  const data = JSON.parse(fs.readFileSync(fixturePath, 'utf8'))
  data.posts[0].videos.push({ video_id: newId, title: 'cancel after audio', position: 6, duration_sec: 20 })
  fs.writeFileSync(fixturePath, JSON.stringify(data))
  const p = (await call('preflight', { request_id: 'plan4', handle: 'fixture', external_mount: '/Volumes/SC-TEST-USB' })).body
  const planned = await finish(p.job_id)
  holdDownload = true
  const a = (await call('start', { ...startInput, request_id: 'cancel4', plan_id: p.job_id, expected_plan_hash: planned.plan_hash, video_ids: [newId] })).body
  await new Promise((resolve, reject) => {
    const fn = j => { if (j.params.workflow_id === a.job_id && j._workflowState?.ledger[0]?.audio_proof) { clearTimeout(timer); events.off('job', fn); resolve() } }
    const timer = setTimeout(() => { events.off('job', fn); reject(new Error('Fixture download marker missing')) }, 10000)
    events.on('job', fn)
  })
  assert.equal((await call('cancel', { job_id: a.job_id })).body.cancel_requested, true)
  const cancelled = await finish(a.job_id)
  assert.equal(cancelled.status, 'cancelled')
  const audio = cancelled.ledger[0].audio_proof
  assert.ok(fs.existsSync(audio.path)); assert.ok(!cancelled.ledger[0].cleanup)
  holdDownload = false
  const r = (await call('resume', { job_id: a.job_id, request_id: 'resume4' })).body
  const done = await finish(r.job_id)
  assert.equal(done.status, 'done', JSON.stringify(done)); assert.equal(done.ledger[0].state, 'ready_evicted')
  assert.ok(!fs.existsSync(audio.path))
  assert.equal(fs.readFileSync(oldMedia, 'utf8'), 'old user media')
})
