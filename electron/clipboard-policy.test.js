'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { parse } = require('@babel/parser')

const runnerSource = fs.readFileSync(path.join(__dirname, 'job-runner.js'), 'utf8')
const functions = parse(runnerSource, { sourceType: 'script' }).program.body
  .filter(node => node.type === 'FunctionDeclaration')
function actualFunction(name) {
  const node = functions.find(node => node.id.name === name)
  assert.ok(node, name)
  return runnerSource.slice(node.start, node.end)
}

const handlers = [
  ['YouTube', 'handleYoutubeEvent', 'yt'],
  ['YouTube comments', 'handleYoutubeCommentsEvent', 'yt_comments'],
  ['Rutube', 'handleRutubeEvent', 'rutube'],
  ['TikTok', 'handleTiktokSingleEvent', 'tk'],
  ['Boosty', 'handleBoostyEvent', 'boosty'],
  ['local file', 'handleLocalEvent', 'local'],
]

// Execute the actual saved-event handlers, scheduler and file-copy function.
// Only OS clipboard, file I/O, sound and listener delivery are substituted.
function harness({ env = {}, readError = false, readFile } = {}) {
  const writes = [], reads = [], sounds = [], emissions = [], logs = []
  const context = vm.createContext({
    process: { env, platform: 'darwin' }, Buffer, Date, path,
    console: { log: (...args) => logs.push(args), error: (...args) => logs.push(args) },
    shouldAutoCopy: params => require('./clipboard-policy').shouldAutoCopy(params, env),
    require: name => {
      assert.equal(name, 'electron')
      return { clipboard: { writeText: text => writes.push(text) } }
    },
    dbRead: { request: async (...args) => {
      reads.push(args)
      if (readError) throw new Error('fixture read worker failed')
      if (readFile) return readFile(...args)
      return { parts: 1, text: 'saved transcript', bytes: 16 }
    } },
    fs: { promises: { readFile: async () => 'fallback transcript' } },
    playClipboardSound: () => sounds.push('sound'),
    emit: job => emissions.push(job), emitEvent: () => {},
  })
  vm.runInContext([
    actualFunction('copyFileToClipboard'), actualFunction('scheduleAutoCopy'),
    ...handlers.map(([, name]) => actualFunction(name)),
  ].join('\n'), context)
  return { context, writes, reads, sounds, emissions, logs }
}
const settle = () => new Promise(resolve => setImmediate(resolve))

for (const [label, handler, stateKey] of handlers) {
  test(`${label}: MCP saved result never reads/writes clipboard or announces a copy`, async () => {
    const h = harness()
    const job = { id: 1, status: 'running', params: { origin: 'mcp' } }
    h.context[handler](job, { type: 'saved', file_path: '/fixture/result.txt', chars: 16 })
    await settle()
    assert.equal(job.file_path, '/fixture/result.txt', 'result remains available')
    assert.equal(h.reads.length, 0, 'suppression happens before clipboard-only file I/O')
    assert.deepEqual(h.writes, [])
    assert.deepEqual(h.sounds, [])
    assert.equal(job[stateKey]?.copied_bytes, undefined, 'no false copied feedback')
  })
}

test('MCP and manual jobs can complete concurrently without global clipboard suppression', async () => {
  const h = harness()
  const machine = { id: 1, params: { origin: 'mcp' }, yt: {} }
  const human = { id: 2, params: {}, yt: {} }
  h.context.scheduleAutoCopy(machine, '/fixture/machine.txt', r => { machine.yt.copied_bytes = r.bytes })
  h.context.scheduleAutoCopy(human, '/fixture/human.txt', r => { human.yt.copied_bytes = r.bytes })
  await settle()
  assert.deepEqual(h.writes, ['saved transcript'])
  assert.deepEqual(h.sounds, ['sound'])
  assert.equal(machine.yt.copied_bytes, undefined)
  assert.equal(human.yt.copied_bytes, 16)
  assert.equal(h.reads.length, 1)
})

test('legacy silentAutoCopy machine jobs also leave clipboard untouched', async () => {
  const h = harness()
  h.context.scheduleAutoCopy({ id: 3, params: { silentAutoCopy: true } }, '/fixture/legacy.txt')
  await settle()
  assert.deepEqual(h.writes, [])
  assert.equal(h.reads.length, 0)
})

test('direct jobs in the SC MCP process never auto-copy, even without an origin field', async () => {
  const h = harness({ env: { SC_DESKTOP_MCP: '1' } })
  h.context.scheduleAutoCopy({ id: 4, params: {} }, '/fixture/direct.txt')
  await settle()
  assert.deepEqual(h.writes, [])
  assert.equal(h.reads.length, 0)
})

test('explicit human Copy remains usable on an MCP-produced file', async () => {
  const h = harness({ env: { SC_DESKTOP_MCP: '1' } })
  const result = await h.context.copyFileToClipboard('/fixture/previous-mcp.txt')
  assert.equal(result.ok, true)
  assert.deepEqual(h.writes, ['saved transcript'])
})

test('normal human copy keeps the asynchronous file-read fallback', async () => {
  const h = harness({ readError: true })
  h.context.scheduleAutoCopy({ id: 5, params: { origin: 'client' } }, '/fixture/human.txt')
  await settle()
  assert.deepEqual(h.writes, ['fallback transcript'])
  assert.deepEqual(h.sounds, ['sound'])
})

test('API-owned MCP provenance cannot be overridden by caller clipboard options', () => {
  const { mcpJobParams, shouldAutoCopy } = require('./clipboard-policy')
  const input = { url: 'https://fixture.test', origin: 'client', autoCopy: true }
  const machine = mcpJobParams(input)
  assert.deepEqual(machine, { ...input, origin: 'mcp', autoCopy: false })
  assert.equal(input.origin, 'client', 'does not mutate the original request')
  assert.equal(shouldAutoCopy(machine, {}), false)
  assert.equal(shouldAutoCopy({ origin: ' MCP ', autoCopy: true }, {}), false)
  assert.equal(shouldAutoCopy({ autoCopy: false }, {}), false)
  assert.equal(shouldAutoCopy({ origin: 'client' }, {}), true)
})
