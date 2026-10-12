'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
process.env.SC_DESKTOP_DB = ':memory:'
const db = require('../electron/database')
const { youtubeSourceRows } = require('./youtube-source-inventory')
test.after(() => db.close())
function source(platform, handle) { return db.upsertSource({ platform, handle, external_id: handle }) }
function chunks(sid, external, count, indexed, transcript = null) {
  const id = db.upsertItem({ source_id: sid, external_id: external, type: 'video', transcript_path: transcript })
  if (transcript) db.getDb().prepare('UPDATE items SET transcript_path=? WHERE id=?').run(transcript, id)
  db.replaceSemanticChunksForItem({ itemId: id, sourceId: sid, documentHash: external,
    chunks: Array.from({ length: count }, (_, chunk_index) => ({ chunk_index, start_char: chunk_index * 4,
      end_char: chunk_index * 4 + 4, text: 'test', position_approximate: true })) })
  const rows = db.getDb().prepare('SELECT id FROM semantic_chunks WHERE item_id=? ORDER BY chunk_index').all(id).slice(0, indexed)
  db.bulkUpsertSemanticChunkVectors(rows.map(row => ({ chunk_id: row.id, source_id: sid, embedding: new Float32Array(768).fill(1 / Math.sqrt(768)) })))
}
test('one PK-scoped aggregate preserves channel counts without TG/Boosty vector contamination or per-source vec counts', () => {
  const yt = source('youtube', 'yt-fixture'), empty = source('youtube', 'yt-empty'), tg = source('telegram', 'tg-fixture'), boosty = source('boosty', 'boosty-fixture')
  chunks(yt, 'first', 4, 3, 'fixture.txt'); chunks(yt, 'second', 2, 1, 'fixture2.txt')
  chunks(tg, 'tg', 120, 120); chunks(boosty, 'boosty', 120, 120)
  const rows = youtubeSourceRows(db.getDb())
  assert.equal(rows.length, 2)
  const row = rows.find(row => row.id === yt)
  assert.equal(row.items_total, 2)
  assert.equal(row.transcribed_videos, 2)
  assert.equal(row.fragments_total, 6)
  assert.equal(row.fragments_indexed, 4)
  assert.equal(row.videos_indexed, 2)
  assert.equal(rows.find(row => row.id === empty).fragments_indexed, 0)
  assert.ok(rows.every(row => row.platform === 'youtube'))
})
