'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const { once } = require('node:events')
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sc-youtube-library-link-')))
process.env.SC_DESKTOP_DIR = root
process.env.SC_DESKTOP_DB = ':memory:'
process.env.SC_MOBILE_PORT = '0'
const db = require('./database')
const { createYoutubeLibraryLink } = require('./youtube-library-link')
const { chunkTranscript } = require('./youtube-semantic')
const { youtubeSourceRows } = require('../mcp/youtube-source-inventory')
const { startMobileApiServer, TOKEN_PATH } = require('./mobile-api-server')
const { createYoutubeSubtitlesClient } = require('../mcp/youtube-subtitles-client')
const library = createYoutubeLibraryLink({ db, libRoot: root })
const sha = raw => crypto.createHash('sha256').update(raw).digest('hex')
let seq = 0
const cache = new Map(), starts = [], listeners = new Set()
const runner = {
  LIB_ROOT: root,
  lookupYoutubeCache: id => cache.get(id) || null,
  startYoutubeSingle: params => { starts.push(params); return starts.length },
  subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) },
}
let server, base, token, client
const originalCreateServer = http.createServer
http.createServer = (...args) => (server = originalCreateServer(...args))
const facade = startMobileApiServer({ db, jobRunner: runner, readScSettings: () => ({}) })
http.createServer = originalCreateServer
test.before(async () => {
  if (!server.listening) await once(server, 'listening')
  base = `http://127.0.0.1:${server.address().port}`
  token = fs.readFileSync(TOKEN_PATH, 'utf8').trim()
  client = createYoutubeSubtitlesClient({ baseUrl: base, token })
})
test.after(async () => {
  if (server.listening) {
    const closed = once(server, 'close')
    facade.close()
    await closed
  }
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

function fixture({ catalog = true, platform = 'youtube', body = 'A long original transcript about LoRA and EU B2B.' } = {}) {
  const number = ++seq, videoId = `v${String(number).padStart(10, '0')}`
  const channelId = `UC${String(number).padStart(22, '0')}`
  const sourceId = db.upsertSource({ platform, handle: `channel-${number}`, external_id: channelId })
  const url = `https://www.youtube.com/watch?v=${videoId}`
  const itemId = catalog ? db.upsertItem({ source_id: sourceId, external_id: videoId, type: 'video',
    title: 'Actual catalog title', caption: 'Catalog caption', url, duration_seconds: 600, published_at: 123456 }) : null
  const raw = `# Saved title\nchannel: A display name is not an identity\nurl: ${url}\nsource: subs\nlang: ru\n\n${body}`
  const filename = path.join(root, `${videoId}__original.txt`)
  fs.writeFileSync(filename, raw)
  const item = { id: crypto.randomUUID(), externalId: videoId, platform: 'youtube', url, status: 'done', resultFile: filename }
  const args = { source_id: sourceId, expected_channel_id: channelId, expected_result_sha256: sha(raw) }
  return { sourceId, channelId, videoId, itemId, raw, filename, item, args, url }
}
function row(id) { return db.getDb().prepare('SELECT * FROM items WHERE id=?').get(id) }

test('read-only state distinguishes cached text from Library association and does not fabricate RAG readiness', () => {
  const f = fixture()
  const before = row(f.itemId)
  const state = library.inspect(f.item)
  assert.equal(state.result.sha256, sha(f.raw))
  assert.equal(state.associations[0].item_id, f.itemId)
  assert.equal(state.associations[0].channel_id, f.channelId)
  assert.equal(state.associations[0].index_path_eligible, false)
  assert.equal(state.rag_index_started, false)
  assert.deepEqual(row(f.itemId), before)
})

test('exact existing association is repaired atomically: metadata, full FTS text and index eligibility are preserved', () => {
  const f = fixture({ body: `${'original words\n'.repeat(1000)}LoRA TARGET TAIL` })
  assert.equal(db.listYoutubeTranscriptItemsForIndex(f.sourceId).length, 0)
  const linked = library.link(f.item, f.args)
  assert.equal(linked.item_id, f.itemId)
  assert.equal(linked.idempotent, false)
  assert.equal(linked.rag_index_started, false)
  assert.equal(row(f.itemId).title, 'Actual catalog title')
  assert.equal(row(f.itemId).caption, 'Catalog caption')
  assert.equal(row(f.itemId).published_at, 123456)
  assert.equal(row(f.itemId).duration_seconds, 600)
  assert.equal(row(f.itemId).transcribe_engine, 'subs')
  assert.equal(db.listYoutubeTranscriptItemsForIndex(f.sourceId)[0].transcript_path, f.filename)
  assert.equal(youtubeSourceRows(db.getDb()).find(r => r.id === f.sourceId).transcribed_videos, 1)
  assert.equal(db.getDb().prepare("SELECT rowid FROM items_fts WHERE items_fts MATCH 'TARGET'").get().rowid, f.itemId)
  const again = library.link(f.item, f.args)
  assert.equal(again.idempotent, true)
  assert.equal(db.getDb().prepare('SELECT COUNT(*) AS n FROM items WHERE source_id=?').get(f.sourceId).n, 1)
})

test('linked full original reaches actual chunk/vector search and context; embeddings are deliberately synthetic', () => {
  const f = fixture({ body: `${'General transcript sentence. '.repeat(600)}LoRA target at the end.` })
  library.link(f.item, f.args)
  const prepared = chunkTranscript(fs.readFileSync(db.listYoutubeTranscriptItemsForIndex(f.sourceId)[0].transcript_path, 'utf8'))
  db.replaceSemanticChunksForItem({ itemId: f.itemId, sourceId: f.sourceId,
    documentHash: prepared.documentHash, chunks: prepared.chunks })
  const chunks = db.getDb().prepare('SELECT * FROM semantic_chunks WHERE item_id=? ORDER BY chunk_index').all(f.itemId)
  const vector = contains => { const v = new Float32Array(768); v[contains ? 0 : 1] = 1; return v }
  db.bulkUpsertSemanticChunkVectors(chunks.map(c => ({ chunk_id: c.id, source_id: f.sourceId, embedding: vector(c.text.includes('LoRA')) })))
  const hits = db.semanticChunkSearch({ source_id: f.sourceId, query_embedding: vector(true), limit: 1 })
  assert.equal(hits[0].item_id, f.itemId)
  assert.match(hits[0].text, /LoRA target/)
  assert.ok(hits[0].start_char > 10000)
  assert.ok(db.semanticChunkContext({ item_id: f.itemId, chunk_index: hits[0].chunk_index, before: 1, after: 1 }).some(c => c.text.includes('LoRA')))
})

test('wrong hash, source/channel, video URL, platform and absent catalog never mutate or invent an item', () => {
  const f = fixture(), before = row(f.itemId)
  assert.throws(() => library.link(f.item, { ...f.args, expected_result_sha256: '0'.repeat(64) }), { code: 'RESULT_HASH_CHANGED' })
  assert.throws(() => library.link(f.item, { ...f.args, expected_channel_id: `UC${'9'.repeat(22)}` }), { code: 'CATALOG_IDENTITY_MISMATCH' })
  assert.throws(() => library.link({ ...f.item, externalId: 'v9999999999' }, f.args), { code: 'VIDEO_ID_MISMATCH' })
  assert.throws(() => library.link({ ...f.item, platform: 'instagram' }, f.args), { code: 'YOUTUBE_IMPORT_REQUIRED' })
  assert.deepEqual(row(f.itemId), before)
  const absent = fixture({ catalog: false })
  assert.equal(library.linkCached(absent.item).code, 'CATALOG_ITEM_MISSING')
  assert.throws(() => library.link(absent.item, absent.args), { code: 'CATALOG_IDENTITY_MISMATCH' })
  const other = fixture({ platform: 'telegram' })
  assert.equal(library.inspect(other.item).associations.length, 0)
  assert.throws(() => library.link(other.item, other.args), { code: 'CATALOG_IDENTITY_MISMATCH' })
})

test('different or missing existing transcript is preserved rather than silently replaced', () => {
  const f = fixture(), otherFile = path.join(root, 'different-transcript.txt')
  fs.writeFileSync(otherFile, 'a different original')
  db.markItemTranscribed({ source_id: f.sourceId, external_id: f.videoId, transcript_path: otherFile, engine: 'assemblyai' })
  assert.throws(() => library.link(f.item, f.args), { code: 'EXISTING_TRANSCRIPT_CONFLICT' })
  assert.equal(row(f.itemId).transcript_path, otherFile)
  fs.unlinkSync(otherFile)
  assert.throws(() => library.link(f.item, f.args), { code: 'EXISTING_TRANSCRIPT_UNAVAILABLE' })
  assert.equal(row(f.itemId).transcribe_engine, 'assemblyai')
})

test('ambiguous exact catalog matches require explicit selection; display names never pick a source', () => {
  const f = fixture(), extra = fixture({ catalog: false })
  db.upsertItem({ source_id: extra.sourceId, external_id: f.videoId, type: 'video', url: f.url })
  assert.equal(library.linkCached(f.item).code, 'CATALOG_ASSOCIATION_AMBIGUOUS')
  assert.equal(row(f.itemId).transcript_path, null)
  assert.equal(library.link(f.item, f.args).source_id, f.sourceId)
  assert.equal(db.listYoutubeTranscriptItemsForIndex(extra.sourceId).length, 0)
})

test('changed original, no body, mismatched header, symlink and outside-root result are rejected', () => {
  const f = fixture()
  fs.appendFileSync(f.filename, '\nedit')
  assert.throws(() => library.link(f.item, f.args), { code: 'RESULT_HASH_CHANGED' })
  fs.writeFileSync(f.filename, f.raw.replace(f.url, 'https://youtube.com/watch?v=v9999999999'))
  assert.throws(() => library.link(f.item, f.args), { code: 'TRANSCRIPT_IDENTITY_UNVERIFIED' })
  fs.writeFileSync(f.filename, f.raw.split('\n\n')[0] + '\n\n')
  assert.throws(() => library.link(f.item, f.args), { code: 'TRANSCRIPT_CONTENT_INVALID' })
  const alias = path.join(root, 'alias.txt')
  fs.symlinkSync(f.filename, alias)
  assert.throws(() => library.link({ ...f.item, resultFile: alias }, f.args), { code: 'RESULT_SYMLINK' })
  assert.throws(() => library.link({ ...f.item, resultFile: __filename }, f.args), { code: 'RESULT_OUTSIDE_LIBRARY' })
  assert.throws(() => library.link({ ...f.item, status: 'running' }, f.args), { code: 'RESULT_NOT_READY' })
  assert.equal(row(f.itemId).transcript_path, null)
})

test('actual mobile cache-hit -> Library -> MCP status repairs association without a worker, file copy, clipboard or indexing', async () => {
  const f = fixture(), before = starts.length
  cache.set(f.videoId, { file_path: f.filename })
  const out = await client.start({ url: f.url, client_request_id: 'link-cache-existing', wait_ms: 0 })
  assert.equal(out.status, 'done')
  assert.equal(out.text, f.raw)
  assert.equal(out.import.libraryLink.item_id, f.itemId)
  assert.equal(starts.length, before)
  assert.equal(row(f.itemId).transcript_path, f.filename)
  const state = await client.libraryState({ import_id: out.import.id })
  assert.equal(state.result.sha256, sha(f.raw))
  assert.equal(state.associations[0].index_path_eligible, true)
  const again = await client.start({ url: f.url, client_request_id: 'link-cache-existing', wait_ms: 0 })
  assert.equal(again.import.id, out.import.id)
  assert.equal(starts.length, before)
  const linked = await client.linkLibrary({ import_id: out.import.id, ...f.args })
  assert.equal(linked.idempotent, true)
  assert.equal(linked.rag_index_started, false)
  assert.equal(db.getDb().prepare('SELECT COUNT(*) AS n FROM semantic_chunks WHERE item_id=?').get(f.itemId).n, 0)
})

test('completed import with no catalog item stays readable, then explicit link repairs an existing catalog item; GET is read-only', async () => {
  const f = fixture({ catalog: false })
  cache.set(f.videoId, { file_path: f.filename })
  const out = await client.start({ url: f.url, client_request_id: 'unlinked-existing-import', wait_ms: 0 })
  assert.equal(out.status, 'done')
  assert.equal(out.import.libraryLink.code, 'CATALOG_ITEM_MISSING')
  const id = db.upsertItem({ source_id: f.sourceId, external_id: f.videoId, type: 'video', url: f.url })
  const state = await client.libraryState({ import_id: out.import.id })
  assert.equal(state.associations[0].index_path_eligible, false)
  assert.equal(row(id).transcript_path, null)
  assert.equal((await client.linkLibrary({ import_id: out.import.id, ...f.args })).item_id, id)
  assert.equal((await client.status({ import_id: out.import.id, wait_ms: 0 })).text, f.raw)
})

test('new routes require bearer auth, exact hash/channel proof and do not accept arbitrary files/text', async () => {
  const f = fixture({ catalog: false })
  cache.set(f.videoId, { file_path: f.filename })
  const out = await client.start({ url: f.url, client_request_id: 'route-auth', wait_ms: 0 })
  assert.equal((await fetch(`${base}/api/imports/${out.import.id}/library-state`)).status, 401)
  const response = await fetch(`${base}/api/imports/${out.import.id}/link-library`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_path: f.filename, text: f.raw }),
  })
  assert.equal(response.status, 422)
  assert.equal((await response.json()).code, 'LINK_PROOF_REQUIRED')
  const me = await fetch(`${base}/api/me`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
  assert.ok(me.capabilities.includes('youtube_import_library_state'))
  assert.ok(me.capabilities.includes('youtube_import_library_link'))
})

test('cache conflict returns the original and a visible linkage warning, with zero new worker/index jobs', async () => {
  const f = fixture(), original = path.join(root, 'already-saved.txt')
  fs.writeFileSync(original, 'Existing other transcript version')
  db.markItemTranscribed({ source_id: f.sourceId, external_id: f.videoId, transcript_path: original, engine: 'assemblyai' })
  const before = starts.length, oldRow = row(f.itemId)
  cache.set(f.videoId, { file_path: f.filename })
  const out = await client.start({ url: f.url, client_request_id: 'cache-conflict', wait_ms: 0 })
  assert.equal(out.status, 'done')
  assert.equal(out.text, f.raw)
  assert.equal(out.import.libraryLink.code, 'EXISTING_TRANSCRIPT_CONFLICT')
  assert.equal(starts.length, before)
  assert.deepEqual(row(f.itemId), oldRow)
  await assert.rejects(client.linkLibrary({ import_id: out.import.id, ...f.args }), { code: 'EXISTING_TRANSCRIPT_CONFLICT', status: 409 })
})

test('exact link retry after an isolated facade restart remains idempotent; no import replay, file copy or worker', async () => {
  const f = fixture()
  cache.set(f.videoId, { file_path: f.filename })
  const out = await client.start({ url: f.url, client_request_id: 'restart-link', wait_ms: 0 })
  const before = starts.length
  let closed = once(server, 'close')
  facade.close()
  await closed
  let restartedServer
  http.createServer = (...args) => (restartedServer = originalCreateServer(...args))
  const restarted = startMobileApiServer({ db, jobRunner: runner, readScSettings: () => ({}) })
  http.createServer = originalCreateServer
  try {
    if (!restartedServer.listening) await once(restartedServer, 'listening')
    const recoveredClient = createYoutubeSubtitlesClient({ baseUrl: `http://127.0.0.1:${restartedServer.address().port}`, token })
    assert.equal((await recoveredClient.libraryState({ import_id: out.import.id })).associations[0].linked_to_import_result, true)
    assert.equal((await recoveredClient.linkLibrary({ import_id: out.import.id, ...f.args })).idempotent, true)
    assert.equal((await recoveredClient.status({ import_id: out.import.id, wait_ms: 0 })).text, f.raw)
    assert.equal(starts.length, before)
  } finally {
    closed = once(restartedServer, 'close')
    restarted.close()
    await closed
  }
})
