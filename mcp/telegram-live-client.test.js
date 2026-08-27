const test = require('node:test')
const assert = require('node:assert/strict')

const { createTelegramLiveClient } = require('./telegram-live-client')

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(body) },
  }
}

test('starts in desktop and waits on the prefixed job id', async () => {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options })
    if (url.endsWith('/telegram-live/start')) {
      return response({ ok: true, job_id: 'desktop:9', desktop_job_id: 9 })
    }
    if (url.includes('/telegram-live/status')) {
      return response({ ok: true, job_id: 'desktop:9', job: { status: 'done' }, result: { hits: 2 } })
    }
    throw new Error(`unexpected ${url}`)
  }
  const client = createTelegramLiveClient({ baseUrl: 'http://unit.test', fetchImpl })
  const out = await client.start({ operation: 'search' }, 1234)
  assert.equal(out.result.hits, 2)
  assert.equal(calls.length, 2)
  assert.match(calls[1].url, /id=desktop%3A9/)
  assert.match(calls[1].url, /wait=1234/)
})

test('never falls back to a hidden local worker when desktop is unavailable', async () => {
  const client = createTelegramLiveClient({
    fetchImpl: async () => { throw new TypeError('fetch failed') },
  })
  await assert.rejects(
    () => client.start({ operation: 'search' }, 0),
    /deliberately do not fall back to a hidden MCP subprocess/,
  )
})

test('save uses the explicit desktop materialisation route', async () => {
  let seen = null
  const client = createTelegramLiveClient({
    baseUrl: 'http://unit.test',
    fetchImpl: async (url, options) => {
      seen = { url, body: JSON.parse(options.body) }
      return response({ ok: true, job_id: 'desktop:12', job: { type: 'tg_fetch', status: 'running' } })
    },
  })
  const out = await client.save({ chat: '2719624138', message_ids: [4992] }, 0)
  assert.equal(out.job_id, 'desktop:12')
  assert.match(seen.url, /telegram-live\/save$/)
  assert.deepEqual(seen.body.message_ids, [4992])
})
