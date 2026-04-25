// Smoke-test for items_vec creation + bulkUpsertVectors + hybridSearch.
// Runs under ELECTRON_RUN_AS_NODE=1 so it loads the Electron-built better-sqlite3.
const path = require('path')
process.env.SC_DESKTOP_DB = path.join(require('os').tmpdir(), `db_smoke_${Date.now()}.db`)
const db = require('../electron/database')

const handle = db.getDb()
console.log('OPENED', process.env.SC_DESKTOP_DB)

// Make sure items_vec exists and the dimension matches.
const tbls = handle.prepare("SELECT name FROM sqlite_master WHERE type='table' OR type='virtual table'").all()
console.log('TABLES:', tbls.map(t => t.name).filter(n => /items|vec|fts|sources|jobs|coverage|schema/.test(n)).join(','))
console.log('vec_version:', handle.prepare('SELECT vec_version() v').get().v)

// Insert a fake source + items, write vectors, search.
const sid = db.upsertSource({ platform: 'telegram', handle: 'smoke', display_name: 'Smoke', mark_synced: true })
const items = [
  { source_id: sid, external_id: '1', type: 'text', caption: 'react лоудер для клода',  published_at: 1000 },
  { source_id: sid, external_id: '2', type: 'text', caption: 'спиннер на реакте топ',   published_at: 1100 },
  { source_id: sid, external_id: '3', type: 'text', caption: 'купил квартиру в москве', published_at: 1200 },
]
db.bulkUpsertItems(items)
const ids = items.map(it => handle.prepare('SELECT id FROM items WHERE source_id=? AND external_id=?')
  .get(sid, it.external_id).id)
console.log('item_ids:', ids)

// Use trivial 4-d "embeddings" — just to verify the pipeline. Same vec for #1,#2 (similar), different for #3.
// Dimension mismatch with the real schema (768) would fail — let's switch to 4d for the test.
handle.exec('DROP TABLE IF EXISTS items_vec')
handle.exec('CREATE VIRTUAL TABLE items_vec USING vec0(item_id INTEGER PRIMARY KEY, embedding float[4])')

const v1 = new Float32Array([0.9, 0.1, 0.0, 0.0])
const v2 = new Float32Array([0.85, 0.15, 0.0, 0.0])
const v3 = new Float32Array([0.0, 0.0, 0.9, 0.1])
db.bulkUpsertVectors([
  { item_id: ids[0], embedding: v1 },
  { item_id: ids[1], embedding: v2 },
  { item_id: ids[2], embedding: v3 },
])
console.log('vectorCount:', db.vectorCountForSource(sid))

// Search by a vector close to v1/v2.
const q = new Float32Array([0.88, 0.12, 0.0, 0.0])
const out = db.hybridSearch({ query: 'лоудер', query_embedding: q, source_id: sid, limit: 5 })
console.log('hits:', out.map(r => ({ id: r.id, ext: r.external_id, cap: r.caption, score: r._score?.toFixed(4) })))

// Cleanup test DB
db.close()
require('fs').unlinkSync(process.env.SC_DESKTOP_DB)
console.log('OK')
