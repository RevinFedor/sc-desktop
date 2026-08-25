const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-db-aggregates-'))
process.env.SC_DESKTOP_DIR = tempRoot
process.env.SC_DESKTOP_DB = path.join(tempRoot, 'library.db')

const db = require('./database')

function source(platform, handle) {
  return db.upsertSource({
    platform,
    handle,
    display_name: handle,
    external_id: handle,
    meta: platform === 'telegram' ? { kind: 'channel' } : {},
    is_explicit: true,
    tg_session: platform === 'telegram' ? 'fixture' : null,
  })
}

function item(sourceId, externalId, type, publishedAt, caption = null) {
  return {
    source_id: sourceId,
    external_id: String(externalId),
    type,
    caption,
    published_at: publishedAt,
    has_media: type !== 'text',
  }
}

test.after(() => {
  db.close()
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

test('platform and folder aggregates stay scoped and preserve empty members', () => {
  const a = source('telegram', 'tg-a')
  const b = source('telegram', 'tg-b')
  const c = source('telegram', 'tg-c-empty')
  const yt = source('youtube', 'yt-noise')

  db.bulkUpsertItems([
    item(a, 1, 'text', 10, 'a one'),
    item(a, 2, 'photo', 20, 'a photo'),
    item(b, 1, 'voice', 30, null),
    ...Array.from({ length: 1200 }, (_, index) => item(yt, index + 1, 'video', index + 1, `noise ${index}`)),
  ])

  const folderId = db.upsertFolder({ tg_filter_id: 7, title: 'fixture', tg_session: 'fixture' })
  db.setFolderSources(folderId, [a, b, c])

  const telegram = db.listSources('telegram')
  assert.deepEqual(telegram.map(row => row.id).sort((x, y) => x - y), [a, b, c])
  assert.equal(telegram.find(row => row.id === a).items_count, 2)
  assert.equal(telegram.find(row => row.id === c).items_count, 0)

  const rows = db.listFolderSources(folderId)
  assert.deepEqual(rows.map(row => row.id).sort((x, y) => x - y), [a, b, c])
  assert.equal(rows.find(row => row.id === a).text_n, 1)
  assert.equal(rows.find(row => row.id === a).photo_n, 1)
  assert.equal(rows.find(row => row.id === b).voice_n, 1)
  assert.equal(rows.find(row => row.id === c).items_count, 0)
  assert.equal(rows.some(row => row.id === yt), false)
})

test('folder replacement changes only membership delta and keeps all-history zero', () => {
  const rows = db.listSources('telegram')
  const [a, b, c] = rows.map(row => row.id).sort((x, y) => x - y)
  const folder = db.listFolders('fixture')[0]
  const before = new Map(db.getDb().prepare(
    'SELECT source_id, added_at FROM folder_sources WHERE folder_id = ?'
  ).all(folder.id).map(row => [row.source_id, row.added_at]))

  db.setFolderSources(folder.id, [c, b, a])
  const same = db.getDb().prepare(
    'SELECT source_id, added_at FROM folder_sources WHERE folder_id = ?'
  ).all(folder.id)
  for (const row of same) assert.equal(row.added_at, before.get(row.source_id))

  db.setFolderSources(folder.id, [a, c])
  assert.deepEqual(
    db.listFolderSources(folder.id).map(row => row.id).sort((x, y) => x - y),
    [a, c],
  )

  db.updateFolderParams(folder.id, { default_period_days: 0 })
  assert.equal(db.getFolder(folder.id).default_period_days, 0)
})

test('selected-source semantic counts do not include out-of-scope rows', () => {
  const telegram = db.listSources('telegram')
  const a = telegram.find(row => row.handle === 'tg-a')
  const counts = db.semanticIndexCountsForSources([a.id])
  assert.equal(counts.size, 1)
  assert.equal(counts.get(a.id).semantic_indexable_count, 2)
  assert.equal(counts.has(db.listSources('youtube')[0].id), false)

  const indexes = new Set(db.getDb().prepare(
    "SELECT name FROM sqlite_master WHERE type='index'"
  ).all().map(row => row.name))
  assert.equal(indexes.has('idx_jobs_source_started'), true)
})

test('cursor pagination has no duplicates with equal timestamps and intervening inserts', () => {
  const sourceId = source('telegram', 'cursor-source')
  db.bulkUpsertItems(Array.from({ length: 7 }, (_, index) => (
    item(sourceId, index + 1, 'text', 100, `row ${index + 1}`)
  )))
  const first = db.listItemsPage({ source_id: sourceId, limit: 3, order: 'published_at DESC' })
  assert.equal(first.items.length, 3)
  assert.equal(first.hasMore, true)

  // A new freshest row must not shift/duplicate the already established tail.
  db.bulkUpsertItems([item(sourceId, 99, 'text', 200, 'inserted later')])
  const insertedId = db.getItemsByExternalIds(sourceId, ['99'])[0].id
  const second = db.listItemsPage({
    source_id: sourceId, limit: 3, order: 'published_at DESC', cursor: first.nextCursor,
  })
  const third = db.listItemsPage({
    source_id: sourceId, limit: 3, order: 'published_at DESC', cursor: second.nextCursor,
  })
  const ids = [...first.items, ...second.items, ...third.items].map(row => row.id)
  assert.equal(new Set(ids).size, 7)
  assert.equal(ids.includes(insertedId), false)

  for (let i = 0; i < 7; i++) {
    db.recordJob({
      type: 'tg_fetch', source_id: sourceId, status: 'done',
      started_at: 500, finished_at: 501, params: { n: i },
    })
  }
  const jobs1 = db.listJobsForSourcePage(sourceId, { limit: 4 })
  const jobs2 = db.listJobsForSourcePage(sourceId, { limit: 4, cursor: jobs1.nextCursor })
  const jobIds = [...jobs1.jobs, ...jobs2.jobs].map(row => row.id)
  assert.equal(jobIds.length, 7)
  assert.equal(new Set(jobIds).size, 7)
})
