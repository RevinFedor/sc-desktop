'use strict'

const test = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const vm = require('node:vm'), http = require('node:http'), readline = require('node:readline')
const crypto = require('node:crypto'), { EventEmitter, once } = require('node:events')
const { PassThrough } = require('node:stream'), { parse } = require('@babel/parser')
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sc-comments-control-')))
process.env.SC_DESKTOP_DIR = root
process.env.SC_DESKTOP_DB = ':memory:'
process.env.SC_MOBILE_PORT = '0'
const db = require('./database')
const { createYoutubeCommentsControl } = require('./youtube-comments-control')
const { startMobileApiServer, TOKEN_PATH } = require('./mobile-api-server')
const { createYoutubeSubtitlesClient } = require('../mcp/youtube-subtitles-client')
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const sourceText = fs.readFileSync(path.join(__dirname, 'job-runner.js'), 'utf8')
const declarations = parse(sourceText, { sourceType: 'script' }).program.body.filter(n => n.type === 'FunctionDeclaration')
function actual(name) { const node = declarations.find(n => n.id.name === name); assert.ok(node, name); return sourceText.slice(node.start, node.end) }
const jobs = new Map(), children = [], clipboardReads = []
const context = vm.createContext({ jobs, nextId: 1, db, readline, Date, Buffer,
  console: { log() {}, warn() {}, error() {} },
  YT_COMMENTS_SCRIPT: '/fixture/yt_comments_ndjson.py', YT_COMMENTS_DIR: path.join(root, 'transcripts/youtube_comments'),
  WORKER_PYTHON: '/fixture/python', WORKERS_ROOT: root, workerEnv: () => ({}),
  emit() {}, emitEvent() {},
  shouldAutoCopy: params => require('./clipboard-policy').shouldAutoCopy(params, {}),
  copyFileToClipboard: async () => { clipboardReads.push('copy'); return { ok: true, bytes: 4 } },
  spawn: (binary, args) => {
    const child = new EventEmitter()
    child.stdout = new PassThrough(); child.stderr = new PassThrough()
    children.push({ binary, args: Array.from(args), child })
    return child
  },
})
vm.runInContext(['startYoutubeComments', 'attachYoutubeCommentsStreams', 'handleYoutubeCommentsEvent', 'scheduleAutoCopy'].map(actual).join('\n'), context)
const runner = {
  LIB_ROOT: root, listJobs: () => Array.from(jobs.values()),
  getJobDetail: id => jobs.get(Number(id)), startYoutubeComments: context.startYoutubeComments,
  subscribe: () => () => {}, lookupYoutubeCache: () => null,
}
const control = createYoutubeCommentsControl({ db, jobRunner: runner, libRoot: root })
let seq = 0
function scope() {
  const n = ++seq, channel = `UC${String(n).padStart(22, '0')}`
  const sid = db.upsertSource({ platform: 'youtube', handle: `creator-${n}`, external_id: channel, display_name: 'Channel owner, not every commenter' })
  return { source_id: sid, expected_channel_id: channel, video_id: `v${String(n).padStart(10, '0')}`, request_id: `comments-${n}` }
}
async function finish(out, args, rows, report = {}) {
  const job = jobs.get(out.desktop_job_id), filename = job.params._comments_archive_path
  const archive = { version: 1, video_id: args.video_id, video_url: `https://www.youtube.com/watch?v=${args.video_id}`,
    channel_id: args.expected_channel_id, title: 'Speech title cannot be comment evidence',
    params: { sort: 'new', limit: 0, include_replies: true }, comments: rows, raw_comments: rows,
    report: { all_requested: true, producer_finished: true, remote_eof: null, eof_proof: 'not_exposed_by_yt_dlp_cli',
      unique_count: rows.length, warnings: [], missing_parent_ids: [], duplicate_conflicts: [], unidentified_indices: [], ...report } }
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  const raw = JSON.stringify(archive) + '\n'
  fs.writeFileSync(filename, raw)
  const child = job.child
  child.stdout.write(JSON.stringify({ type: 'video', video_id: args.video_id, title: archive.title }) + '\n')
  child.stdout.write(JSON.stringify({ type: 'saved', file_path: path.join(root, 'comments.txt'), count_total: rows.length,
    archive_path: filename, archive_sha256: hash(raw), archive_report: archive.report }) + '\n')
  child.stdout.write(JSON.stringify({ type: 'done' }) + '\n')
  child.stdout.end(); child.emit('close', 0)
  await new Promise(resolve => setImmediate(resolve))
  return { filename, raw, hash: hash(raw) }
}

test.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }) })

test('actual runner keeps machine provenance, ALL/replies, source, archive identity and durable reservation', async () => {
  const args = scope(), out = control.start(args), child = children.at(-1)
  const row = db.getDb().prepare('SELECT * FROM jobs WHERE id=?').get(out.db_job_id)
  assert.equal(row.status, 'running')
  assert.equal(row.source_id, args.source_id)
  assert.equal(jobs.get(out.desktop_job_id).params.origin, 'mcp')
  assert.equal(jobs.get(out.desktop_job_id).params.autoCopy, false)
  assert.equal(child.args[child.args.indexOf('--limit') + 1], '0')
  assert.ok(child.args.includes('--with-replies'))
  assert.ok(child.args.includes('--archive-json'))
  assert.equal(child.args[child.args.indexOf('--expected-channel-id') + 1], args.expected_channel_id)
  assert.equal(children.length, 1)
  assert.equal(control.start(args).db_job_id, out.db_job_id)
  assert.equal(children.length, 1)
  assert.throws(() => control.start({ ...args, video_id: 'v9999999999' }), { code: 'REQUEST_PAYLOAD_MISMATCH' })
  const saved = await finish(out, args, [{ comment_id: 'root', parent_comment_id: null, author: 'Comment writer', text: 'timezone Thailand' }])
  const status = control.status({ request_id: args.request_id })
  assert.equal(status.persisted_status, 'done')
  assert.equal(status.archive.snapshot_hash, saved.hash)
  assert.equal(status.archive.complete, false, 'extractor exit0 is not remote EOF')
  assert.equal(status.items_done, 1)
  assert.equal(db.getDb().prepare('SELECT COUNT(*) AS n FROM jobs WHERE id=?').get(out.db_job_id).n, 1)
  assert.deepEqual(clipboardReads, [])
})

test('no other channel/platform fallback, concurrent producer or misleading legacy TXT completeness', async () => {
  const args = scope()
  assert.throws(() => control.start({ ...args, expected_channel_id: `UC${'z'.repeat(22)}` }), { code: 'CHANNEL_IDENTITY_MISMATCH' })
  const tg = db.upsertSource({ platform: 'telegram', handle: 'not-youtube', external_id: args.expected_channel_id })
  assert.throws(() => control.start({ ...args, source_id: tg }), { code: 'CHANNEL_IDENTITY_MISMATCH' })
  const out = control.start(args)
  assert.throws(() => control.start(scope()), { code: 'COMMENTS_PRODUCER_BUSY' })
  await finish(out, args, [])
  const state = control.state({ ...args, video_ids: [args.video_id] })
  assert.equal(state.videos[0].structured_available, true)
  assert.equal(state.videos[0].complete, false)
  assert.equal(state.videos[0].legacy_completeness, 'not_proven_by_flat_txt')
})

test('full body lexical RAG across three creators preserves author and same-video parent context, not video speech', async () => {
  const selected = []
  for (let i = 0; i < 3; i++) {
    const args = scope(), out = control.start(args)
    const saved = await finish(out, args, [
      { comment_id: 'root', parent_comment_id: null, author: `Questioner-${i}`, author_is_uploader: false, text: 'Age experience CV review?' },
      { comment_id: 'reply', parent_comment_id: 'root', author: `Answerer-${i}`, author_id: 'other-author',
        author_is_uploader: i === 0, published_at: 123, edited_at: null,
        text: `${'Full original 😀 words. '.repeat(1000)}Thailand timezone contract crypto TARGET` },
    ])
    selected.push({ args, out, saved })
  }
  const result = control.search({ source_ids: selected.map(s => s.args.source_id), query: 'Thailand timezone contract crypto', match: 'all' })
  assert.equal(result.results.length, 3)
  assert.equal(result.search_mode, 'literal_full_body')
  assert.equal(result.semantic_embeddings, false)
  assert.equal(result.corpus_complete, false)
  assert.ok(result.results.every(hit => hit.evidence_kind === 'youtube_comment' && hit.author.startsWith('Answerer')))
  assert.equal(result.results.filter(hit => hit.channel_owner_attribution_proven).length, 1)
  const f = selected[0], args = { request_id: f.args.request_id, comment_id: 'reply', expected_snapshot_hash: f.saved.hash }
  let offset = 0, body = ''
  while (true) {
    const page = control.original({ ...args, offset, max_chars: 531 })
    body += page.text
    if (page.next_offset == null) break
    offset = page.next_offset
  }
  assert.equal(body, result.results.find(hit => hit.request_id === args.request_id).text)
  const thread = control.thread(args)
  assert.equal(thread.results.length, 2)
  assert.equal(thread.root_comment_id, 'root')
  assert.ok(thread.results.every(c => c.video_id === f.args.video_id))
  assert.throws(() => control.original({ ...args, expected_snapshot_hash: '0'.repeat(64) }), { code: 'SNAPSHOT_HASH_REQUIRED' })
  assert.equal(control.search({ source_ids: selected.map(s => s.args.source_id), query: 'TARGET', budget: 1 }).search_budget_exhausted, true)
})

test('original archive pages reconstruct EXACT saved JSON; orphan, modified file and false EOF do not become complete', async () => {
  const args = scope(), out = control.start(args)
  const saved = await finish(out, args, [{ comment_id: 'child', parent_comment_id: 'missing', text: 'full 🌍 original', author: null }],
    { remote_eof: true, missing_parent_ids: ['missing'] })
  const params = { request_id: args.request_id, expected_snapshot_hash: saved.hash, comment_id: 'child' }
  assert.equal(control.thread(params).ancestor_stop_reason, 'missing_parent')
  assert.equal(control.status({ request_id: args.request_id }).archive.complete, false)
  let offset = 0, raw = ''
  while (true) {
    const page = control.archive({ ...params, offset, max_chars: 61 }); raw += page.text
    if (page.next_offset == null) break
    offset = page.next_offset
  }
  assert.equal(hash(raw), saved.hash)
  fs.appendFileSync(saved.filename, '\nchanged')
  assert.equal(control.status({ request_id: args.request_id }).archive_error.code, 'ARCHIVE_HASH_CHANGED')
  assert.throws(() => control.original(params), { code: 'ARCHIVE_HASH_CHANGED' })
})

test('recreated controller cannot bind an old process-local job ID or launch a duplicate after unknown outcome', async () => {
  const args = scope(), out = control.start(args), count = children.length
  const restarted = createYoutubeCommentsControl({ db, jobRunner: runner, libRoot: root })
  const status = restarted.status({ request_id: args.request_id })
  assert.equal(status.live, false)
  assert.equal(status.outcome_unknown, true)
  assert.equal(status.status, 'launch_or_completion_unknown')
  assert.equal(restarted.start(args).idempotent, true)
  assert.equal(children.length, count)
  assert.throws(() => restarted.start({ ...args, request_id: `${args.request_id}-new` }), { code: 'COMMENTS_PREVIOUS_OUTCOME_UNKNOWN' })
  assert.equal(children.length, count)
  await finish(out, args, [])
})

test('actual authenticated HTTP/client comments-only routes, saved reader and no changes to subtitle flow', async () => {
  let server
  const create = http.createServer
  http.createServer = (...args) => (server = create(...args))
  const api = startMobileApiServer({ db, jobRunner: runner, readScSettings: () => ({}) })
  http.createServer = create
  try {
    if (!server.listening) await once(server, 'listening')
    const base = `http://127.0.0.1:${server.address().port}`
    const client = createYoutubeSubtitlesClient({ baseUrl: base, token: fs.readFileSync(TOKEN_PATH, 'utf8').trim() })
    assert.equal((await fetch(`${base}/api/youtube/comments/capabilities`)).status, 401)
    assert.equal((await client.commentsCapabilities()).media_download, false)
    const args = scope(), out = await client.commentsStart(args)
    await finish(out, args, [{ comment_id: 'one', parent_comment_id: null, text: 'country CV timezone' }])
    const state = await client.commentsState({ ...args, video_ids: [args.video_id] })
    const snapshot = state.videos[0].snapshot_hash
    const original = await client.commentsOriginal({ request_id: args.request_id, comment_id: 'one', expected_snapshot_hash: snapshot })
    assert.equal(original.text, 'country CV timezone')
    assert.equal((await client.commentsStatus({ request_id: args.request_id })).archive.comments, 1)
    assert.equal((await client.commentsSearch({ source_id: args.source_id, query: 'timezone' })).results.length, 1)
    assert.equal((await client.commentsThread({ request_id: args.request_id, comment_id: 'one', expected_snapshot_hash: snapshot })).results.length, 1)
    await assert.rejects(client.commentsStatus({ request_id: 'never-accepted' }), { code: 'COMMENTS_REQUEST_NOT_FOUND', status: 404 })
    assert.deepEqual(clipboardReads, [])
  } finally {
    const closed = once(server, 'close'); api.close(); await closed
  }
})
