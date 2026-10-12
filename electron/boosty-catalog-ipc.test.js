'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const fs = require('node:fs')
const path = require('node:path')
const { normalizeRequest } = require('./boosty-catalog-contract')

// Evaluate the actual one IPC registration, not Electron app startup. Only
// auth acquisition/account spawn are doubles; no browser/clipboard is used.
const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8')
const start = source.indexOf("ipcMain.handle('boosty:channelFetch'")
const end = source.indexOf("ipcMain.handle('boosty:postPreview'", start)
assert.ok(start > 0 && end > start)
function harness() {
  let handler, authCalls = 0
  const starts = []
  vm.runInNewContext(source.slice(start, end), {
    ipcMain: { handle: (_name, fn) => { handler = fn } },
    jobRunner: { startBoostyChannelFetch: params => {
      if (params.auth_mode === 'public') normalizeRequest(params)
      starts.push(params); return 42
    } },
    require: name => {
      assert.equal(name, './browser-bridge')
      return { requestBoostyAuthCookie: async () => { authCalls++; return { value: 'PRIVATE_FAKE_AUTH', expirationDate: 100 } } }
    },
  })
  return { handler, starts, authCalls: () => authCalls }
}
test('actual Boosty IPC public branch never requests browser auth even without a browser', async () => {
  const h = harness()
  assert.equal(await h.handler(null, { handle: 'author', auth_mode: 'public', request_id: 'public' }), 42)
  assert.equal(h.authCalls(), 0)
  assert.equal(h.starts[0].authCookie, undefined)
})
test('actual account IPC branch remains browser-authenticated and hands secret only to runner', async () => {
  const h = harness()
  assert.equal(await h.handler(null, { url: 'https://boosty.to/author' }), 42)
  assert.equal(h.authCalls(), 1)
  assert.equal(h.starts[0].authCookie, 'PRIVATE_FAKE_AUTH')
})
test('invalid public scope cannot silently fall back to account cookie acquisition', async () => {
  const h = harness()
  await assert.rejects(() => h.handler(null, { handle: 'author', auth_mode: 'public', request_id: 'wrong', download_media: true }), { code: 'BOOSTY_METADATA_ONLY_REQUIRED' })
  assert.equal(h.authCalls(), 0)
  assert.equal(h.starts.length, 0)
})
