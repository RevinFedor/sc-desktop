const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-tg-analysis-'))
process.env.SC_DESKTOP_DIR = tempRoot

const db = require('./database')

test.after(() => {
  db.close()
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

test('returns the newest valid successful Telegram analysis separately from saved items', () => {
  const sourceId = db.upsertSource({
    platform: 'telegram',
    handle: 'analysis_only_channel',
    display_name: 'Analysis only',
    external_id: '1234567890',
    meta: { kind: 'channel', username: 'analysis_only_channel' },
    is_explicit: true,
  })

  db.recordJob({
    type: 'tg_preview', source_id: sourceId, status: 'done',
    started_at: 100, finished_at: 110,
    params: {
      mode: 'last_n', limit: 50,
      _summary: { items_total: 7, type_counts: { video: 5, text: 2 } },
    },
  })
  // A later failed analysis must not erase the last usable result.
  db.recordJob({
    type: 'tg_preview', source_id: sourceId, status: 'error',
    started_at: 120, finished_at: 130,
    params: { mode: 'last_n', limit: 100 },
    error: 'network error',
  })
  // Nor should a malformed legacy `done` row hide it.
  db.recordJob({
    type: 'tg_preview', source_id: sourceId, status: 'done',
    started_at: 140, finished_at: 150,
    params: { mode: 'last_n', limit: 100 },
  })

  assert.deepEqual(db.itemTypeBreakdown(sourceId), [])
  assert.deepEqual(db.latestTelegramAnalysisForSource(sourceId), {
    job_id: 1,
    analyzed_at: 110,
    items_total: 7,
    type_counts: { video: 5, text: 2 },
    date_min: null,
    date_max: null,
    scope: {
      mode: 'last_n',
      limit: 50,
      date: null,
      date_to: null,
      since_message_id: 0,
    },
  })
})

test('an empty successful analysis is valid and does not resurrect older counts', () => {
  const sourceId = db.upsertSource({
    platform: 'telegram',
    handle: 'empty_analysis_channel',
    display_name: 'Empty analysis',
    external_id: '1234567891',
    meta: { kind: 'channel', username: 'empty_analysis_channel' },
    is_explicit: true,
  })

  db.recordJob({
    type: 'tg_preview', source_id: sourceId, status: 'done',
    started_at: 200, finished_at: 210,
    params: { mode: 'last_n', limit: 20, _summary: { items_total: 0, type_counts: {} } },
  })

  assert.deepEqual(db.latestTelegramAnalysisForSource(sourceId)?.type_counts, {})
  assert.equal(db.latestTelegramAnalysisForSource(sourceId)?.items_total, 0)
})
