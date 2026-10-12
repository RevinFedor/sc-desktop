'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-boosty-assets-http-'))
process.env.SC_DESKTOP_DIR = root
process.env.SC_DESKTOP_DB = ':memory:'
const db = require('./database')
const rag = require('./boosty-rag')
const { sha } = require('./boosty-rag-document')
const { createBoostyRagApi } = require('./boosty-rag-api')
const { createBoostyRagClient } = require('../mcp/boosty-rag-client')
test.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }) })

test('actual HTTP handler/client→native SQLite/vec asset search→same-hash original/PDF context; no installed-runtime claim', async t => {
  const sid = db.upsertSource({ platform: 'boosty', handle: 'fixture-http', external_id: 'fixture-http' })
  const post = '11111111-1111-4111-8111-111111111111'
  db.upsertItem({ source_id: sid, external_id: 'post:' + post, type: 'boosty_post', caption: 'author body', published_at: 10 })
  const original = path.join(root, 'document.pdf'), txt = path.join(root, 'document.txt')
  fs.writeFileSync(original, 'synthetic fixture binary, PDF upstream/extractor double')
  fs.writeFileSync(txt, '[PDF page 1]\nLoRA и русский текст 👩‍💻.\n\n[PDF page 2]\nПродолжение ответа.')
  const item = db.upsertItem({ source_id: sid, external_id: 'asset:test-document', type: 'boosty_asset',
    parent_external_id: 'post:' + post, media_path: original, published_at: 10,
    raw_meta: { asset_id: 'test-document', original_sha256: sha(fs.readFileSync(original)), text_sha256: sha(fs.readFileSync(txt)), pages: [{ page: 1 }, { page: 2 }], extraction_state: 'text_extracted_complete' } })
  db.getDb().prepare('UPDATE items SET transcript_path=? WHERE id=?').run(txt, item)
  const prepared = rag.prepareIndex(db, { source_id: sid, item_ids: [item] })
  const vector = new Float32Array(768); vector[0] = 1
  for (const entry of prepared.pending) {
    rag.saveBatch(db, entry.rows, entry.rows.map(() => vector))
    assert.equal(rag.publish(db, entry.doc), true)
  }
  const token = 'a'.repeat(64)
  const api = createBoostyRagApi({ token, database: () => db,
    indexJob: { subscribe: () => () => {}, currentSnapshot: () => null },
    read: async (operation, args) => rag.performRead(db, operation, args), embedQuery: async () => vector,
    readBody: async req => { let body = ''; for await (const part of req) body += part; return JSON.parse(body) },
    sendJson: (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) },
  })
  const server = http.createServer((req, res) => {
    api.handle(req, res, new URL(req.url, 'http://127.0.0.1')).catch(error => res.destroy(error))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { api.close(); await new Promise(resolve => server.close(resolve)) })
  const baseUrl = 'http://127.0.0.1:' + server.address().port
  const client = createBoostyRagClient({ baseUrl, tokenReader: () => token })
  assert.equal((await client.assets({ source_id: sid })).assets[0].item_id, item)
  const result = await client.search({ source_id: sid, query: 'LoRA', types: ['asset'], min_cos: .5, limit: 1 })
  const hit = result.results[0]
  assert.equal(hit.item_id, item); assert.equal(hit.asset_external_id, 'test-document'); assert.equal(hit.video_external_id, null)
  const first = await client.original({ item_id: item, expected_document_hash: hit.document_hash, max_chars: 20 })
  const next = await client.original({ item_id: item, expected_document_hash: hit.document_hash, offset: first.next_offset })
  assert.equal(first.content + next.content, fs.readFileSync(txt, 'utf8'))
  const context = await client.context({ item_id: item, expected_document_hash: hit.document_hash, chunk_index: 0 })
  assert.deepEqual(context.anchor.pdf_pages, [1, 2]); assert.equal(context.anchor.timecode, null)
  assert.equal(context.provenance.is_fedor_employment_evidence, false)
  const unauthorized = await fetch(baseUrl + '/boosty-rag/assets?source_id=' + sid)
  assert.equal(unauthorized.status, 401)
  const forged = await fetch(baseUrl + '/boosty-rag/assets?source_id=' + sid, { headers: { Authorization: 'Bearer ' + token, Origin: 'https://boosty.to' } })
  assert.equal(forged.status, 403)
  fs.writeFileSync(txt, 'new revision')
  await assert.rejects(client.original({ item_id: item, expected_document_hash: hit.document_hash }), { code: 'BOOSTY_ORIGINAL_CHANGED' })
  assert.equal(rag.prepareIndex(db, { source_id: sid, item_ids: [item] }).missing[0].reason, 'asset_extraction_text_changed')
})
