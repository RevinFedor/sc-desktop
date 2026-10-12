'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const { telegramFolderTools, callTelegramFolderTool } = require('./telegram-folder-tools')
const { normalizeTelegramLiveRequest, telegramFolderMutationInFlight, applyTelegramLiveEvent, createTelegramLiveState } = require('../electron/telegram-live')
const base = { session: 'session_4531193', expected_account_id: '1033012338', title: 'ВУ' }
const chats = [{ chat_id: '3928484154', expected_title: 'АйТи Красавчики: Инсайдеры' }]
const merge = { ...base, operation: 'folder_merge', request_id: 'vu-1', confirm: true, purpose: 'itkras_vu', expected_snapshot_hash: 'a'.repeat(64), chats }
test('three tools: current upstream reader, explicit union, receipt status; no broad replace/delete', () => {
  assert.deepEqual(telegramFolderTools.map(t => t.name), ['telegram_folder_read', 'telegram_folder_merge', 'telegram_folder_merge_status'])
  assert.deepEqual(telegramFolderTools.map(t => t.annotations.readOnlyHint), [true, false, true])
})
test('folder exact CYRILLIC title/session/account and mutation proof are mandatory', () => {
  for (const change of [{ title: 'BY' }, { title: 'VU' }, { title: 'ВУ ' }, { session: null }, { expected_account_id: 2**63 }, { confirm: false }, { purpose: 'generic_edit' }, { request_id: null }, { expected_snapshot_hash: null }]) {
    assert.throws(() => normalizeTelegramLiveRequest({ ...merge, ...change }))
  }
  assert.equal(normalizeTelegramLiveRequest(merge).title.codePointAt(0), 0x0412)
  assert.equal(normalizeTelegramLiveRequest(merge).title.codePointAt(1), 0x0423)
})
test('chat ids preserve raw/marked decimal identities and exact titles, no fake input peers', () => {
  assert.equal(normalizeTelegramLiveRequest({ ...merge, chats: [{ chat_id: '-1003928484154', expected_title: ' Клуб АйТи Красавчиков ' }] }).chats[0].expected_title, ' Клуб АйТи Красавчиков ')
  for (const changed of [[], [{ chat_id: 2**63, expected_title: 'x' }], [{ chat_id: 0, expected_title: 'x' }], [{ chat_id: 2, expected_title: 'x', access_hash: 123 }]]) {
    assert.throws(() => normalizeTelegramLiveRequest({ ...merge, chats: changed }))
  }
})
test('read/current status contain no write confirmation/overwrite fields', () => {
  const read = normalizeTelegramLiveRequest({ ...base, operation: 'folder_read' })
  assert.equal(read.confirm, undefined); assert.equal(read.request_id, undefined)
  const status = normalizeTelegramLiveRequest({ ...merge, operation: 'folder_merge_status' })
  assert.equal(status.confirm, undefined); assert.equal(status.chats, undefined); assert.equal(status.expected_snapshot_hash, undefined)
})
test('union goes through existing Application job route, no local hidden mutation', async () => {
  let sent
  const { operation, ...args } = merge
  const result = await callTelegramFolderTool('telegram_folder_merge', { ...args, wait_ms: 0 }, { start: async (request, wait) => {
    sent = request; assert.equal(wait, 0); return { ok: true, job_id: 'desktop:fixture', result: { state: 'verified', folder_id: 4, sc_refresh_required: true, sc_materialized_verified: false } }
  } })
  assert.equal(sent.operation, operation)
  assert.equal(sent.session, 'session_4531193')
  assert.equal(JSON.parse(result.content[0].text).result.sc_materialized_verified, false)
  await assert.rejects(callTelegramFolderTool('telegram_folder_merge', { ...args, remove_from_other_folders: true }, { start() { throw Error('Must not start') } }), /Unsupported/)
})
test('unknown write outcome never marked successful; original status reader only', async () => {
  let sent
  const result = await callTelegramFolderTool('telegram_folder_merge_status', { ...base, request_id: 'vu-1' }, { start: async request => { sent = request; return { ok: true, result: { state: 'unknown' } } } })
  assert.equal(result.isError, true); assert.equal(sent.operation, 'folder_merge_status'); assert.equal(sent.confirm, undefined)
})
test('folder commit fence works only after the worker durable dispatch marker', () => {
  assert.equal(telegramFolderMutationInFlight({ type: 'tg_live_folder_merge', tg_live: { stage: 'starting' } }), false)
  assert.equal(telegramFolderMutationInFlight({ type: 'tg_live_folder_read', tg_live: { stage: 'dispatching_folder_update' } }), false)
  const job = { type: 'tg_live_folder_merge', params: merge, tg_live: createTelegramLiveState(merge) }
  applyTelegramLiveEvent(job, { type: 'progress', stage: 'dispatching_folder_update', done: 0, total: 1 })
  assert.equal(telegramFolderMutationInFlight(job), true)
})
