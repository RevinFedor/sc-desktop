'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-boosty-rag-test-'))
process.env.SC_DESKTOP_DIR = root
process.env.SC_DESKTOP_DB = ':memory:'
const db = require('./database')
const rag = require('./boosty-rag')
const { buildDocument, parseTimedText, INDEX_VERSION, embeddingText } = require('./boosty-rag-document')
test.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }) })
let seq = 1
function source() { const handle = `boosty-fixture-${seq++}`; return db.upsertSource({ platform: 'boosty', handle, display_name: handle, external_id: handle }) }
function item(sourceId, text, { parent = 'post-fixture', date = 1000, type = 'boosty_video', srt = null } = {}) {
  const id = db.upsertItem({ source_id: sourceId, external_id: `fixture-${seq++}`, type,
    title: 'Title is NOT salary/role evidence', caption: type === 'boosty_post' ? text : 'short caption only',
    parent_external_id: type === 'boosty_video' ? parent : null, published_at: date,
    media_path: '/Volumes/unmounted-fixture/audio.mp3', duration_seconds: 999 })
  if (type === 'boosty_video') {
    const filename = path.join(root, `${id}.txt`)
    fs.writeFileSync(filename, `# Fixture\nurl: https://boosty.to/fixture/posts/${parent}\nsource: boosty\n\n${text}`)
    if (srt != null) fs.writeFileSync(filename.replace(/\.txt$/, '.srt'), srt)
    db.getDb().prepare('UPDATE items SET transcript_path=?,transcribe_engine=? WHERE id=?').run(filename, 'assemblyai', id)
  }
  return id
}
function vector(text, needle = 'LoRA') { const v = new Float32Array(768); v[text.includes(needle) ? 0 : 1] = 1; return v }
function index(sourceId, ids = null) {
  const prepared = rag.prepareIndex(db, { source_id: sourceId, item_ids: ids })
  for (const pending of prepared.pending) {
    if (pending.rows.length) rag.saveBatch(db, pending.rows, pending.rows.map(row => vector(row.embedding_text)))
    assert.equal(rag.publish(db, pending.doc), true)
  }
  return prepared
}
const query = args => rag.search(db, { query_embedding: vector('LoRA'), min_cos: 0.5, ...args })

test('attachment is a separate saved child; PDF pages/original hashes, missing/partial and stale edits are truthful', () => {
  const sid = source(), parent = item(sid, 'LoRA author post', { type: 'boosty_post' })
  const original = path.join(root, `asset-${seq++}.pdf`), txt = path.join(root, `asset-${seq++}.txt`)
  fs.writeFileSync(original, 'fixture original binary, not a real parsed PDF')
  fs.writeFileSync(txt, '[PDF page 1]\nОписание.\n\n[PDF page 2]\nLoRA отдельный PDF, не речь интервьюера.')
  const crypto = require('node:crypto'), digest = () => crypto.createHash('sha256').update(fs.readFileSync(original)).digest('hex')
  const id = db.upsertItem({ source_id: sid, external_id: `asset:fixture-${seq++}`, type: 'boosty_asset',
    parent_external_id: db.getDb().prepare('SELECT external_id FROM items WHERE id=?').get(parent).external_id,
    published_at: 1000, title: 'Title not evidence', media_path: original, transcript_path: txt,
    raw_meta: { asset_id: 'test-pdf', original_sha256: digest(), text_sha256: require('./boosty-rag-document').sha(fs.readFileSync(txt)), pages: [{ page: 1 }, { page: 2 }], extraction_state: 'text_extracted_complete' } })
  db.getDb().prepare('UPDATE items SET transcript_path=? WHERE id=?').run(txt, id)
  index(sid, [id])
  const hit = query({ source_id: sid, types: ['asset'] }).results[0]
  assert.equal(hit.item_id, id); assert.equal(hit.type, 'asset'); assert.equal(hit.video_external_id, null)
  assert.equal(hit.provenance.is_fedor_employment_evidence, false)
  assert.deepEqual(hit.matches[0].pdf_pages, [1, 2]); assert.equal(hit.matches[0].timecode, null)
  assert.equal(rag.indexStatus(db, { source_id: sid }).ready_assets, 1)
  const read = rag.readOriginal(db, { item_id: id, expected_document_hash: hit.document_hash })
  assert.match(read.content, /LoRA отдельный PDF/)
  assert.equal(rag.listAssets(db, { source_id: sid }).assets[0].item_id, id)
  fs.writeFileSync(original, 'changed binary original')
  assert.equal(query({ source_id: sid, types: ['asset'] }).returned, 0)
  assert.equal(rag.document(db, id).reason, 'asset_original_changed_since_extraction')
  fs.unlinkSync(original)
  assert.equal(rag.document(db, id).reason, 'asset_original_missing')
  assert.equal(rag.indexStatus(db, { source_id: sid }).missing_assets, 1)
  assert.equal(rag.indexStatus(db, { source_id: sid }).known_interviews, 0)
})

test('full long Unicode TXT tail is indexed, every span is intact; hash-safe pagination reads ALL codepoints', () => {
  const sid = source(), text = `${'Длинный текст 👩‍💻 🇹🇭 e\u0301\n'.repeat(300)}LoRA хвост про адаптеры`
  const id = item(sid, text)
  index(sid)
  const doc = rag.document(db, id)
  assert.ok(doc.chunks.length > 5)
  assert.equal(doc.chunks.at(-1).end_char, doc.text.length)
  for (const chunk of doc.chunks) {
    assert.equal(doc.text.slice(chunk.start_char, chunk.end_char), chunk.text)
    assert.ok(Buffer.byteLength(embeddingText(doc, chunk)) < 1900)
    assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(chunk.text))
  }
  const out = query({ source_id: sid, limit: 1 })
  assert.equal(out.results[0].item_id, id)
  assert.match(out.results[0].matches[0].text, /LoRA хвост/)
  assert.ok(out.results[0].matches[0].start_char > 2000)
  let offset = 0, result = ''
  while (true) {
    const page = rag.readOriginal(db, { item_id: id, expected_document_hash: doc.documentHash, offset, max_chars: 107 })
    result += page.content
    if (!page.truncated) break
    offset = page.next_offset
  }
  assert.equal(result, text)
  assert.throws(() => rag.readOriginal(db, { item_id: id, offset: 10 }), { code: 'BOOSTY_HASH_REQUIRED' })
})

test('exact SRT endpoints and neighboring question/answer retain child identity; no speaker or time-link invention', () => {
  const sid = source()
  const srt = '1\n00:00:10,000 --> 00:00:12,500\nВопрос: что такое LoRA?\n\n2\n00:00:12,500 --> 00:00:20,125\nОтвет: низкоранговые адаптеры, не полное обучение.\n'
  const id = item(sid, 'Вопрос: что такое LoRA? Ответ: низкоранговые адаптеры, не полное обучение.', { srt })
  index(sid)
  const doc = rag.document(db, id), hit = query({ source_id: sid, limit: 1 }).results[0]
  assert.equal(hit.matches[0].start_seconds, 10)
  assert.equal(hit.matches[0].end_seconds, 20.125)
  assert.equal(hit.time_query_url_supported, false)
  assert.equal(hit.provenance.speaker, null)
  const out = rag.context(db, { item_id: id, expected_document_hash: doc.documentHash, chunk_index: 0 })
  assert.equal(out.cues.length, 2)
  assert.match(out.text, /Вопрос.*\nОтвет/s)
  assert.ok(out.cues.every(cue => cue.speaker === null))
  assert.equal(rag.readOriginal(db, { item_id: id, format: 'srt' }).content, srt)
})

test('different TXT tail is preserved FULL and untimed rather than silently lost behind SRT', () => {
  const sid = source(), id = item(sid, 'Субтитр. LoRA дополнительный хвост TXT.', { srt: '1\n00:00:10,000 --> 00:00:20,000\nСубтитр.\n' })
  index(sid)
  const hit = query({ source_id: sid, limit: 1 }).results[0].matches[0]
  assert.match(hit.text, /дополнительный хвост/)
  assert.equal(hit.representation, 'saved_txt_unaligned')
  assert.equal(hit.timecode, null)
  const out = rag.context(db, { item_id: id, expected_document_hash: hit.document_hash, chunk_index: hit.chunk_index })
  assert.equal(out.relation, 'same_saved_text_no_timecode')
})

test('source/date/type/current-profile filtering is BEFORE real vec0 KNN', () => {
  const sid = source(), other = source()
  const wanted = item(sid, 'LoRA eligible interview', { date: 2000 })
  item(sid, 'LoRA excluded old interview', { date: 1000 })
  item(other, 'LoRA wrong source', { date: 2000 })
  const post = item(sid, 'LoRA only author post', { type: 'boosty_post', date: 2000 })
  index(sid); index(other)
  const out = query({ source_id: sid, date_from: 1500, limit: 1, budget: 1 })
  assert.equal(out.results[0].item_id, wanted)
  assert.equal(out.eligible_documents, 1)
  const posts = query({ source_id: sid, types: ['post'], date_from: 1500 })
  assert.equal(posts.results[0].item_id, post)
  assert.equal(posts.results[0].provenance.kind, 'saved_author_post')
  db.getDb().prepare('UPDATE boosty_rag_generations SET index_version=? WHERE item_id=?').run('old-profile', wanted)
  assert.equal(query({ source_id: sid, date_from: 1500 }).returned, 0)
})

test('limit counts unique child interviews or parent posts; bounded candidate exhaustion is explicit', () => {
  const sid = source()
  item(sid, 'LoRA long '.repeat(400), { parent: 'same-post' })
  item(sid, 'LoRA other child', { parent: 'same-post' })
  item(sid, 'LoRA third interview', { parent: 'different-post' })
  index(sid)
  assert.equal(query({ source_id: sid, limit: 3 }).returned, 3)
  assert.equal(query({ source_id: sid, limit: 3, group_by: 'post' }).returned, 2)
  const capped = query({ source_id: sid, limit: 3, budget: 1 })
  assert.equal(capped.returned, 1)
  assert.equal(capped.diagnostics.search_budget_exhausted, true)
  assert.equal(query({ source_ids: [sid], limit: 2 }).returned, 2)
})

test('partial staging is never searchable; cancel/retry reuses staged vectors and publishes only a whole generation', () => {
  const sid = source(), id = item(sid, 'LoRA full transcript '.repeat(400))
  const first = rag.prepareIndex(db, { source_id: sid })
  const pending = first.pending[0], saved = pending.rows.slice(0, 2)
  rag.saveBatch(db, saved, saved.map(row => vector(row.embedding_text)))
  assert.equal(rag.publish(db, pending.doc), false)
  assert.equal(query({ source_id: sid }).returned, 0)
  assert.equal(rag.indexStatus(db, { source_id: sid }).partial, 1)
  const resumed = rag.prepareIndex(db, { source_id: sid })
  assert.equal(resumed.fragments_pending, pending.rows.length - 2)
  index(sid)
  assert.equal(rag.indexStatus(db, { source_id: sid }).ready_interviews, 1)
  assert.equal(rag.prepareIndex(db, { source_id: sid }).pending.length, 0)
  assert.equal(query({ source_id: sid }).results[0].item_id, id)
})

test('edits reject old quote/context/continuation; unchanged inputs reuse vectors after metadata/timing changes', () => {
  const sid = source(), id = item(sid, 'LoRA current original')
  index(sid)
  const old = rag.document(db, id)
  fs.writeFileSync(path.join(root, `${id}.txt`), 'Changed new text without the needle')
  assert.equal(query({ source_id: sid }).returned, 0)
  assert.equal(rag.indexStatus(db, { source_id: sid }).stale, 1)
  assert.throws(() => rag.context(db, { item_id: id, chunk_index: 0, expected_document_hash: old.documentHash }), { code: 'BOOSTY_ORIGINAL_CHANGED' })
  assert.throws(() => rag.readOriginal(db, { item_id: id, offset: 1, expected_document_hash: old.documentHash }), { code: 'BOOSTY_ORIGINAL_CHANGED' })
  index(sid)
  db.getDb().prepare('UPDATE items SET title=? WHERE id=?').run('New title, same embedding input', id)
  const prepared = rag.prepareIndex(db, { source_id: sid })
  assert.equal(prepared.fragments_pending, 0)
  assert.equal(rag.publish(db, prepared.pending[0].doc), true)
})

test('missing originals, unmounted media and locked access are separate; no audio/ASR/network dependency', () => {
  const sid = source(), available = item(sid, 'LoRA saved accessible text'), missing = item(sid, 'deleted')
  fs.unlinkSync(path.join(root, `${missing}.txt`))
  db.getDb().prepare('UPDATE items SET raw_meta_json=? WHERE id=?').run(JSON.stringify({ access_status: 'lost' }), available)
  index(sid)
  const status = rag.indexStatus(db, { source_id: sid })
  assert.equal(status.ready_interviews, 1)
  assert.equal(status.missing_interviews, 1)
  assert.equal(status.current_ready, true)
  assert.equal(status.all_known_texts_covered, false)
  assert.equal(query({ source_id: sid }).results[0].item_id, available)
  assert.throws(() => rag.validateSelection(db, { source_id: source(), item_ids: [available] }), { code: 'BOOSTY_SELECTION_SOURCE_MISMATCH' })
})

test('document changes while worker computes embeddings cannot publish stale text', () => {
  const sid = source(), id = item(sid, 'LoRA original')
  const prepared = rag.prepareIndex(db, { source_id: sid }), pending = prepared.pending[0]
  rag.saveBatch(db, pending.rows, pending.rows.map(row => vector(row.embedding_text)))
  fs.writeFileSync(path.join(root, `${id}.txt`), 'Changed during worker')
  assert.throws(() => rag.publish(db, pending.doc), { code: 'BOOSTY_ORIGINAL_CHANGED' })
  assert.equal(query({ source_id: sid }).returned, 0)
})

test('raw path traversal and escaping symlinks are rejected, not exported', () => {
  const sid = source(), id = item(sid, 'fixture')
  db.getDb().prepare('UPDATE items SET transcript_path=? WHERE id=?').run('../outside.txt', id)
  assert.throws(() => rag.document(db, id), { code: 'BOOSTY_TEXT_PATH_REJECTED' })
  const link = path.join(root, 'escaping.txt')
  fs.symlinkSync('/etc/hosts', link)
  db.getDb().prepare('UPDATE items SET transcript_path=? WHERE id=?').run(link, id)
  assert.throws(() => rag.document(db, id), { code: 'BOOSTY_TEXT_PATH_REJECTED' })
})

test('parser retains milliseconds/multiline text and no fabricated cue for invalid SRT', () => {
  const parsed = parseTimedText('1\n01:00:00,001 --> 01:00:01,999\nLoRA\nдве строки\n')
  assert.equal(parsed.cues[0].start_seconds, 3600.001)
  assert.equal(parsed.text, 'LoRA\nдве строки')
  assert.equal(parseTimedText('invalid SRT').cues.length, 0)
  assert.ok(INDEX_VERSION.includes('gemini-embedding-001'))
})

test('real library post:UUID identity remains intact while canonical Boosty URL uses only UUID', () => {
  const sid = source(), uuid = '1c92e0c7-ea20-46c4-ab9a-6d63f662d3dc'
  const id = item(sid, 'LoRA real identity shape', { parent: `post:${uuid}` })
  const doc = rag.document(db, id)
  assert.equal(doc.postId, `post:${uuid}`)
  assert.equal(doc.postUuid, uuid)
  assert.ok(doc.canonicalUrl.endsWith(`/posts/${uuid}`))
  assert.ok(!doc.canonicalUrl.includes('post%3A'))
})

test('a uniquely equal TXT passage gains only a proven same-version SRT time; changed/repeated wording stays untimed', () => {
  const { timedRange } = require('./boosty-rag-document')
  const words = 'LoRA adapts a model with two low rank matrices instead of training every parameter. It has a lower memory footprint.'
  const timed = words.replaceAll(' ', '\n'), prefix = 'More TXT wording that has no corresponding subtitles. '
  const doc = { text: `${timed}\n\n${prefix}${words}`, cues: [{ cue_index: 0, start_char: 0, end_char: timed.length,
    start_seconds: 123.5, end_seconds: 130.25, text: timed }] }
  const chunk = { text: words, start_char: timed.length + 2 + prefix.length, end_char: doc.text.length }
  const proven = timedRange(doc, chunk)
  assert.equal(proven.first, 0)
  assert.equal(proven.basis, 'unique_exact_non_whitespace_in_same_saved_srt')
  assert.equal(timedRange(doc, { ...chunk, text: words.replace('lower', 'higher') }), null)
  const repeated = { text: `${timed}\n${timed}\n\n${words}`, cues: [
    { cue_index: 0, start_char: 0, end_char: timed.length },
    { cue_index: 1, start_char: timed.length + 1, end_char: timed.length * 2 + 1 },
  ] }
  assert.equal(timedRange(repeated, { text: words, start_char: timed.length * 2 + 3, end_char: repeated.text.length }), null)
})

test('returned identical passages are labelled as duplicate candidates, not two independent interviews', () => {
  const sid = source(), text = 'LoRA low rank adaptation preserves the pretrained model while training only two small matrices and their exact downstream tasks.'
  item(sid, text, { parent: 'first-publication' }); item(sid, text, { parent: 'second-publication' })
  index(sid)
  const out = query({ source_id: sid, limit: 2 })
  assert.equal(out.returned, 2, 'do not silently drop an authorised saved resource')
  assert.equal(out.results[0].matches[0].duplicate_passage_refs[0].item_id, out.results[1].item_id)
  assert.equal(out.diagnostics.unique_resource_ids_are_not_independent_interviews, true)
})
