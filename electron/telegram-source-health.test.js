const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-tg-health-'))
process.env.SC_DESKTOP_DIR = tempRoot

const db = require('./database')

test.after(() => {
  db.close()
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

test('source health preserves auto metadata and a live entity refreshes a renamed username', () => {
  const id = db.upsertSource({
    platform: 'telegram',
    handle: 'old_name',
    display_name: 'Test channel',
    external_id: '2383492108',
    meta: { kind: 'channel', username: 'old_name' },
    is_explicit: true,
    tg_session: 'session_test',
  })
  db.setTelegramAutoForSources([id], {
    pull: true,
    types: ['text'],
    engine: 'assemblyai',
  })

  assert.deepEqual(
    db.setTelegramSourceUnavailable(id, {
      code: 'telegram_source_unavailable',
      message: 'no longer accessible',
      checked_at: 100,
    }),
    { ok: true, changed: true },
  )

  const sameId = db.upsertSource({
    platform: 'telegram',
    handle: 'old_name',
    display_name: 'Test channel renamed',
    external_id: '2383492108',
    meta: { kind: 'channel', username: 'new_name' },
    tg_session: 'session_test',
  })
  assert.equal(sameId, id)

  let row = db.getSource(id)
  let meta = JSON.parse(row.meta_json)
  assert.equal(row.handle, 'new_name')
  assert.equal(meta.tg_auto.pull, true)
  assert.equal(meta.tg_health.status, 'unavailable')

  assert.deepEqual(db.clearTelegramSourceHealth(id), { ok: true, changed: true })
  row = db.getSource(id)
  meta = JSON.parse(row.meta_json)
  assert.equal(meta.tg_health, undefined)
  assert.equal(meta.tg_auto.pull, true)
  assert.equal(meta.username, 'new_name')
})
