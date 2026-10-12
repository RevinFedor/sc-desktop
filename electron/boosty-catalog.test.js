'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-boosty-catalog-test-'))
process.env.SC_DESKTOP_DIR = root
process.env.SC_DESKTOP_DB = ':memory:'
const db = require('./database')
const contract = require('./boosty-catalog-contract')
const store = require('./boosty-catalog-store')
const { buildDocument } = require('./boosty-rag-document')
test.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }) })
let seq = 0
function params(extra = {}) { return contract.normalizeRequest({ handle: `catalog-${++seq}`, auth_mode: 'public', request_id: `catalog-${seq}`, ...extra }) }
function post(id, extra = {}) { return { post_id: id, title: 'Заголовок 👩‍💻', created_at: 1000, publish_time: 1001,
  has_access: false, subscription_level: { id: 12, name: 'Уровень', price: 25, currency_prices: { USD: 25, RUB: 2000 } },
  declared_video_count: 2, content_counters: { ok_video: 2 }, videos: [], ...extra } }
const full = extra => ({ remote_eof: true, catalog_complete: true, checked_at: 2000, stop_reason: 'upstream_isLast_true', fetched: 2, pages: 1,
  tiers: { status: 'available', complete: true, next_id: null, stop_reason: 'upstream_nextId_null', tiers: [{ id: 12, name: 'Уровень', currency_prices: { RUB: 2000 } }] }, ...extra })
function save(p, posts, summary = full(), status = 'done') {
  return store.savePublicCatalog(db, { entity: { author_handle: p.handle, author_id: `author-${p.handle}`, title: 'Автор', posts_count: 999 }, params: p, posts, summary, status })
}

test('public scope is explicit, no credential/media/ASR input; source normalization never emits post/purchase URL', () => {
  assert.throws(() => contract.normalizeRequest({ handle: 'author', request_id: 'r' }), { code: 'BOOSTY_PUBLIC_MODE_REQUIRED' })
  assert.throws(() => params({ handle: 'https://boosty.to/a/posts/uuid' }), { code: 'BOOSTY_AUTHOR_REQUIRED' })
  for (const k of ['download_media', 'thumbnails', 'transcribe', 'index', 'save_video']) assert.throws(() => params({ [k]: true }), { code: 'BOOSTY_METADATA_ONLY_REQUIRED' })
  assert.throws(() => params({ authCookie: 'SECRET' }), { code: 'BOOSTY_METADATA_ONLY_REQUIRED' })
  const p = params({ autoCopy: true, origin: 'ui' })
  assert.equal(p.autoCopy, false)
  assert.equal(p.origin, 'mcp')
  assert.equal(contract.authorHandle('https://boosty.to/Author/'), 'author')
})

test('unknown access/counters/price period and unidentified exposed media stay unknown without signed fields', () => {
  const out = contract.projectPost(post('id', { has_access: null, content_counters_available: false,
    text: 'SECRET BODY', playerUrls: ['SECRET'], videos: [{ kind: 'video', duration_sec: 12.125, external_url: 'SECRET' }] }), 'author')
  assert.equal(out.access_state, 'unknown')
  assert.equal(out.declared_video_count, null)
  assert.equal(out.videos[0].video_id, null)
  assert.equal(out.videos[0].duration_sec, 12.125)
  assert.equal(out.subscription_level.price_period, null)
  assert.equal(out.subscription_level.price_period_provenance, 'not_exposed')
  assert.equal(out.visible_video_count, 1)
  assert.equal(out.identified_video_count, 0)
  assert.ok(!JSON.stringify(out).includes('SECRET'))
})

test('anonymous refresh keeps stable source, paid body, child transcript/audio/account access and RAG hashes intact', () => {
  const p = params()
  const sid = db.upsertBoostyChannel({ author_id: `author-${p.handle}`, handle: p.handle, display_name: 'Автор', meta: { catalog_complete: true, account_marker: 'keep' } })
  db.upsertBoostyCatalog({ source_id: sid, posts: [post('preserved', { has_access: true, text: 'FULL OWN POST TEXT', videos: [
    { video_id: 'child-a', title: 'A', duration_sec: 12, position: 1 }, { video_id: 'child-b', title: 'B', duration_sec: 13, position: 2 }] })] })
  const child = db.listBoostyVideos(sid)[0]
  const filename = path.join(root, 'child.txt')
  fs.writeFileSync(filename, 'Full original transcript')
  db.getDb().prepare("UPDATE items SET transcript_path=?,media_path=?,transcribe_status='done' WHERE id=?").run(filename, '/Volumes/test-external/audio.mp3', child.id)
  const row = db.getDb().prepare('SELECT * FROM items WHERE id=?').get(child.id)
  const original = buildDocument(row, db.getSource(sid), root)
  const saved = save(p, [post('preserved')])
  assert.equal(saved.sourceId, sid)
  const parents = db.listBoostyItems(sid).filter(r => r.type === 'boosty_post')
  assert.equal(parents[0].caption, 'FULL OWN POST TEXT')
  assert.equal(JSON.parse(parents[0].raw_meta_json).access_state, 'accessible')
  assert.equal(JSON.parse(parents[0].raw_meta_json).public_catalog.access_state, 'locked_for_anonymous')
  assert.equal(db.listBoostyVideos(sid).length, 2)
  const after = db.getDb().prepare('SELECT * FROM items WHERE id=?').get(child.id)
  assert.equal(after.transcript_path, row.transcript_path)
  assert.equal(after.media_path, row.media_path)
  assert.equal(after.raw_meta_json, row.raw_meta_json)
  assert.equal(buildDocument(after, db.getSource(sid), root).documentHash, original.documentHash)
  assert.equal(JSON.parse(db.getSource(sid).meta_json).account_marker, 'keep')
  assert.equal(JSON.parse(db.getSource(sid).meta_json).catalog_complete, true)
})

test('complete proof uses actual EOF/scope, not profile total; filtered/cancel/error preserve previous complete', () => {
  const p = params(), initial = save(p, [post('one'), post('two')])
  assert.equal(initial.state.last_complete.posts_count, 2)
  for (const [scope, status] of [[{ limit: 1 }, 'done'], [{ tags: [1] }, 'done'], [{}, 'cancelled'], [{}, 'error']]) {
    const next = contract.normalizeRequest({ ...p, ...scope, request_id: `next-${++seq}` })
    const out = save(next, [post('one')], full({ fetched: 1 }), status)
    assert.equal(out.state.latest.complete_visible_feed, false)
    assert.equal(out.state.last_complete.job_id, initial.state.last_complete.job_id)
  }
  const missing = save(contract.normalizeRequest({ ...p, request_id: 'missing-eof' }), [post('one')], full({ remote_eof: false, stop_reason: 'cursor_missing' }))
  assert.equal(missing.state.latest.complete_visible_feed, false)
  assert.equal(missing.state.latest.stop_reason, 'cursor_missing')
})

test('pagination is exact within the latest pass, revision guarded; known union is explicitly different', () => {
  const p = params(), saved = save(p, [post('one'), post('two'), post('three')])
  let out = store.performRead(db, 'posts', { source_id: saved.sourceId, limit: 1 })
  assert.equal(out.posts[0].post_id, 'one')
  assert.equal(out.total, 3)
  assert.equal(out.next_offset, 1)
  assert.equal(store.performRead(db, 'posts', { source_id: saved.sourceId, offset: 1 }).code, 'BOOSTY_CATALOG_REVISION_CHANGED')
  const second = store.performRead(db, 'posts', { source_id: saved.sourceId, offset: 1, limit: 1, expected_catalog_revision: out.catalog_revision })
  assert.equal(second.posts[0].post_id, 'two')
  save(contract.normalizeRequest({ ...p, request_id: 'partial', limit: 1 }), [post('one')])
  assert.equal(store.performRead(db, 'posts', { source_id: saved.sourceId, offset: 1, expected_catalog_revision: out.catalog_revision }).code, 'BOOSTY_CATALOG_REVISION_CHANGED')
  assert.equal(store.performRead(db, 'posts', { source_id: saved.sourceId }).total, 1)
  assert.equal(store.performRead(db, 'posts', { source_id: saved.sourceId, view: 'known' }).total, 3)
})

test('tiers refresh is separate from posts, preserves historical tier EOF and deleted/archived flags', () => {
  const p = params(), saved = save(p, [post('one')])
  const next = contract.normalizeRequest({ ...p, request_id: 'tiers-refetch', tiers_only: true })
  const partial = save(next, [], full({ tiers: { status: 'unavailable', complete: false, tiers: [], http_status: 403 } }))
  assert.equal(partial.state.latest.job_id, saved.state.latest.job_id)
  assert.equal(partial.state.tiers.status, 'unavailable')
  assert.equal(partial.state.last_complete_tiers.tiers.length, 1)
  assert.equal(store.performRead(db, 'posts', { source_id: saved.sourceId }).total, 1)
  const tier = contract.projectTiers({ status: 'available', complete: true, tiers: [{ id: 9, isArchived: true, deleted: true, period: 'month', currencyPrices: { EUR: 1, SECRET: 'signed' } }] }).tiers[0]
  assert.equal(tier.is_archived, true)
  assert.equal(tier.deleted, true)
  assert.equal(tier.price_period, 'month')
  assert.equal(tier.price_period_provenance, 'upstream_period')
  assert.deepEqual(tier.currency_prices, { EUR: 1 })
})

test('atomic persistence rollback cannot publish a false complete catalogue on DB failure', () => {
  const p = params(), original = save(p, [post('one')]), originalUpsert = db.upsertItem
  let count = 0
  db.upsertItem = row => { if (++count === 2) throw new Error('fixture failure'); return originalUpsert(row) }
  try { assert.throws(() => save(contract.normalizeRequest({ ...p, request_id: 'failed-save' }), [post('new1'), post('new2')])) }
  finally { db.upsertItem = originalUpsert }
  const after = store.performRead(db, 'state', { source_id: original.sourceId })
  assert.equal(after.catalog_revision, original.state.catalog_revision)
  assert.equal(store.performRead(db, 'posts', { source_id: original.sourceId, view: 'known' }).total, 1)
})

test('empty unfiltered feed with explicit EOF is complete without deleting historical items', () => {
  const p = params(), old = save(p, [post('one')])
  const empty = save(contract.normalizeRequest({ ...p, request_id: 'empty' }), [], full({ fetched: 0 }))
  assert.equal(empty.state.latest.complete_visible_feed, true)
  assert.equal(empty.state.latest.posts_count, 0)
  assert.equal(store.performRead(db, 'posts', { source_id: old.sourceId }).total, 0)
  assert.equal(store.performRead(db, 'posts', { source_id: old.sourceId, view: 'known' }).total, 1)
})
