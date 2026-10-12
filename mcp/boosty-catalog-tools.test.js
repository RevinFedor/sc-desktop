'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { boostyCatalogTools, callBoostyCatalogTool } = require('./boosty-catalog-tools')
const { createBoostyCatalogClient } = require('./boosty-catalog-client')

test('catalogue tools are separate from paid media/account/RAG controls and machine results have no copy action', () => {
  assert.equal(boostyCatalogTools.length, 8)
  assert.equal(new Set(boostyCatalogTools.map(t => t.name)).size, 8)
  for (const t of boostyCatalogTools) {
    assert.equal(t.inputSchema.additionalProperties, false)
    assert.equal(t.annotations.destructiveHint, false)
    assert.equal(t.inputSchema.properties.authCookie, undefined)
    assert.equal(t.inputSchema.properties.engine, undefined)
  }
  assert.equal(boostyCatalogTools.find(t => t.name === 'boosty_catalog_start').annotations.readOnlyHint, false)
  assert.equal(boostyCatalogTools.find(t => t.name === 'boosty_catalog_posts').annotations.readOnlyHint, true)
})

test('start returns its generated stable request key and explicit public mode; supplied receipt key is unchanged', async () => {
  const calls = [], client = { start: async p => { calls.push(p); return { ok: true, request_id: p.request_id, job_id: `boosty-catalog:${p.request_id}` } } }
  const out = JSON.parse((await callBoostyCatalogTool('boosty_catalog_start', { handle: 'author' }, client)).content[0].text)
  assert.match(out.request_id, /^boosty-catalog-mcp-/)
  assert.equal(calls[0].auth_mode, 'public')
  await callBoostyCatalogTool('boosty_catalog_start', { handle: 'author', request_id: 'unchanged' }, client)
  assert.equal(calls[1].request_id, 'unchanged')
})

test('transport loss preserves exact recovery key; known validation errors are not delivery unknown', async () => {
  const client = { start: async () => { throw new Error('network unavailable') } }
  const out = JSON.parse((await callBoostyCatalogTool('boosty_catalog_start', { handle: 'author', request_id: 'same-key' }, client)).content[0].text)
  assert.equal(out.request_id, 'same-key')
  assert.equal(out.delivery_unknown, true)
  assert.match(out.recovery, /unchanged/)
  const rejected = { start: async () => { throw Object.assign(new Error('wrong scope'), { code: 'BOOSTY_PUBLIC_MODE_REQUIRED' }) } }
  const known = JSON.parse((await callBoostyCatalogTool('boosty_catalog_start', { handle: 'author' }, rejected)).content[0].text)
  assert.equal(known.delivery_unknown, false)
})

test('client uses protected originless loopback protocol and exact routes, never credentials in URL/body', async () => {
  const requests = []
  const client = createBoostyCatalogClient({ tokenReader: () => 'PRIVATE_FAKE_TOKEN', fetchImpl: async (url, options) => {
    requests.push({ url: String(url), options }); return { ok: true, status: 200, json: async () => ({ ok: true }) }
  } })
  await client.start({ handle: 'author', auth_mode: 'public', request_id: 'r' })
  await client.posts({ source_id: 1, offset: 2, expected_catalog_revision: 'same' })
  await client.refreshTiers({ handle: 'author', auth_mode: 'public', request_id: 'tiers' })
  assert.match(requests[0].url, /\/boosty-catalog\/start$/)
  assert.match(requests[1].url, /\/boosty-catalog\/posts\?/)
  assert.match(requests[2].url, /\/boosty-catalog\/tiers\/refresh$/)
  for (const r of requests) {
    assert.equal(r.options.headers.Authorization, 'Bearer PRIVATE_FAKE_TOKEN')
    assert.equal(r.options.headers.Origin, undefined)
    assert.equal(r.options.redirect, 'error')
    assert.ok(!r.url.includes('PRIVATE_FAKE_TOKEN'))
    assert.ok(!String(r.options.body).includes('PRIVATE_FAKE_TOKEN'))
  }
  assert.throws(() => createBoostyCatalogClient({ baseUrl: 'https://foreign.invalid' }), /loopback/)
})

test('old installed app/update-required is explicit, not a worker or SQL fallback', async () => {
  const client = createBoostyCatalogClient({ tokenReader: () => 'private', fetchImpl: async () => ({ status: 404 }) })
  await assert.rejects(() => client.state({ handle: 'author' }), { code: 'BOOSTY_CATALOG_APP_UPDATE_REQUIRED' })
})
