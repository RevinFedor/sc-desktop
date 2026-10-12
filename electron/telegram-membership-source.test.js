const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-tg-membership-'))
process.env.SC_DESKTOP_DIR = root

const db = require('./database')
const { telegramMembershipSourcePayload } = require('./telegram-live')

test.after(() => {
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

test('joined chat is canonicalized once and leaving preserves the local source', () => {
  const joined = {
    operation: 'join',
    ready_for_fetch: true,
    chat: {
      id: 123456789,
      title: 'Phuket Rentals',
      username: 'phuket_rentals',
      source_kind: 'group',
    },
  }
  const sourceId = db.upsertSource(
    telegramMembershipSourcePayload(joined, 'session_fixture'),
  )
  const first = db.getSource(sourceId)
  assert.equal(first.handle, 'phuket_rentals')
  assert.equal(first.external_id, '123456789')
  assert.equal(first.tg_session, 'session_fixture')
  assert.equal(first.is_explicit, 1)
  assert.equal(JSON.parse(first.meta_json).tg_membership.status, 'member')

  const sameId = db.upsertSource(telegramMembershipSourcePayload({
    ...joined,
    chat: { ...joined.chat, username: null },
  }, 'session_fixture'))
  assert.equal(sameId, sourceId)
  assert.equal(db.listSources('telegram').length, 1)

  const existing = db.getSource(sourceId)
  const leftId = db.upsertSource(telegramMembershipSourcePayload({
    operation: 'leave',
    ready_for_fetch: false,
    chat: joined.chat,
  }, 'session_fixture', existing))
  assert.equal(leftId, sourceId)
  const left = db.getSource(sourceId)
  assert.equal(JSON.parse(left.meta_json).tg_membership.status, 'left')
  assert.equal(left.is_explicit, 1)
})
