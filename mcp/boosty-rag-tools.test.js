'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createBoostyRagClient } = require('./boosty-rag-client')
const { boostyRagTools, callBoostyRagTool } = require('./boosty-rag-tools')

test('MCP client calls public originless bearer Application API only; remote URLs and redirects are not authorised', async () => {
  const calls = []
  const client = createBoostyRagClient({ tokenReader: () => 'a'.repeat(64), fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options }); return { ok: true, status: 200, json: async () => ({ ok: true }) }
  } })
  await client.sources({ limit: 2 }); await client.search({ source_id: 4206, query: 'LoRA' })
  assert.equal(new URL(calls[0].url).pathname, '/boosty-rag/sources')
  assert.equal(calls[1].options.headers.Origin, undefined)
  assert.equal(calls[1].options.redirect, 'error')
  assert.equal(calls[1].options.headers.Authorization, `Bearer ${'a'.repeat(64)}`)
  assert.throws(() => createBoostyRagClient({ baseUrl: 'https://example.com' }), /loopback/)
})

test('missing installed API fails explicitly without importing a DB/worker fallback', async () => {
  const client = createBoostyRagClient({ tokenReader: () => 'a'.repeat(64), fetchImpl: async () => ({ status: 404 }) })
  await assert.rejects(client.sources({}), { code: 'BOOSTY_APP_UPDATE_REQUIRED' })
})

test('ten source tools preserve stable caller request_id; a failed ACK exposes the recovery key', async () => {
  assert.equal(boostyRagTools.length, 10)
  const inputs = []
  const client = { start: async input => { inputs.push(input); throw new Error('unknown response') } }
  const result = await callBoostyRagTool('boosty_index', { source_id: 4206, request_id: 'exact-original-key' }, client)
  assert.equal(inputs[0].request_id, 'exact-original-key')
  assert.equal(JSON.parse(result.content[0].text).request_id, 'exact-original-key')
  assert.equal(result.isError, true)
  const read = boostyRagTools.find(tool => tool.name === 'boosty_original_read')
  assert.equal(read.annotations.readOnlyHint, true)
  assert.equal(read.inputSchema.properties.max_chars.maximum, 16000)
})
