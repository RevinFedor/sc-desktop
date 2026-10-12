const assert = require('node:assert/strict')
const http = require('node:http')
const test = require('node:test')

const {
  createYoutubeSubtitlesClient,
  normalizeSearchArguments,
  normalizeYoutubeVideoUrl,
  paginateText,
} = require('./youtube-subtitles-client')

const IMPORT_ID = '12345678-1234-4234-8234-123456789abc'

async function startFixtureServer(handler) {
  const server = http.createServer(handler)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(body)
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

test('paginates transcript text without losing the total size', () => {
  assert.deepEqual(paginateText('0123456789', 3, 4), {
    text: '3456',
    offset: 3,
    returned_chars: 4,
    total_chars: 10,
    next_offset: 7,
    truncated: true,
  })
})

test('accepts only supported single-video YouTube URL shapes', () => {
  assert.equal(
    normalizeYoutubeVideoUrl('https://youtu.be/dQw4w9WgXcQ?si=ignored'),
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  )
  assert.equal(
    normalizeYoutubeVideoUrl('https://m.youtube.com/shorts/dQw4w9WgXcQ'),
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  )
  assert.equal(normalizeYoutubeVideoUrl('https://instagram.com/reel/ABC123/'), null)
  assert.equal(normalizeYoutubeVideoUrl('https://youtube.com/@channel'), null)
})

test('normalizes bounded YouTube search arguments', () => {
  assert.deepEqual(
    normalizeSearchArguments({ query: '  Bob McGrew  ', limit: 30, offset: 10 }),
    { query: 'Bob McGrew', limit: 30, offset: 10 },
  )
  assert.throws(() => normalizeSearchArguments({ query: ' ' }), /query is required/)
  assert.throws(() => normalizeSearchArguments({ query: 'Bob', offset: 1001 }), /offset/)
})

test('searches through the authenticated SC Desktop YouTube endpoint', async t => {
  const fixture = await startFixtureServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer fixture-token')
    if (req.method === 'POST' && req.url === '/api/youtube/search') {
      const body = await readJson(req)
      assert.deepEqual(body, { query: 'Bob McGrew agents', limit: 2, offset: 0 })
      return sendJson(res, 200, {
        ok: true,
        query: body.query,
        limit: body.limit,
        offset: body.offset,
        items: [
          { video_id: 'abcdefghijk', title: 'First', url: 'https://www.youtube.com/watch?v=abcdefghijk' },
          { video_id: 'lmnopqrstuv', title: 'Second', url: 'https://www.youtube.com/watch?v=lmnopqrstuv' },
        ],
      })
    }
    return sendJson(res, 404, { ok: false, error: 'not found' })
  })
  t.after(fixture.close)

  const client = createYoutubeSubtitlesClient({ baseUrl: fixture.baseUrl, token: 'fixture-token' })
  const result = await client.search({ query: 'Bob McGrew agents', limit: 2 })
  assert.equal(result.count, 2)
  assert.equal(result.ranking, 'youtube_relevance')
  assert.equal(result.items[0].title, 'First')
})

test('rejects a non-YouTube URL before making a POST request', async () => {
  let fetchCalled = false
  const client = createYoutubeSubtitlesClient({
    token: 'fixture-token',
    fetchImpl: async () => {
      fetchCalled = true
      throw new Error('must not be called')
    },
  })

  await assert.rejects(
    client.start({ url: 'https://www.instagram.com/reel/ABC123/' }),
    /must point to one supported YouTube video/,
  )
  assert.equal(fetchCalled, false)
})

test('starts the existing POST import and returns a finished transcript slice', async t => {
  const seen = []
  const fixture = await startFixtureServer(async (req, res) => {
    seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization })
    if (req.method === 'POST' && req.url === '/api/imports') {
      const body = await readJson(req)
      assert.equal(body.url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')
      assert.equal(body.clientRequestId, 'stable-request')
      return sendJson(res, 200, {
        ok: true,
        import: {
          id: IMPORT_ID,
          platform: 'youtube',
          url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          status: 'done',
        },
      })
    }
    if (req.method === 'GET' && req.url === `/api/imports/${IMPORT_ID}/result`) {
      return sendJson(res, 200, { ok: true, text: '0123456789' })
    }
    return sendJson(res, 404, { ok: false, error: 'not found' })
  })
  t.after(fixture.close)

  const client = createYoutubeSubtitlesClient({ baseUrl: fixture.baseUrl, token: 'fixture-token' })
  const result = await client.start({
    url: 'https://youtu.be/dQw4w9WgXcQ',
    client_request_id: 'stable-request',
    wait_ms: 0,
    offset: 2,
    max_chars: 5,
  })

  assert.equal(result.status, 'done')
  assert.equal(result.subtitles_found, true)
  assert.equal(result.text, '23456')
  assert.equal(result.next_offset, 7)
  assert.equal(seen.length, 2)
  assert.ok(seen.every(request => request.authorization === 'Bearer fixture-token'))
})

test('waits for an active import and never starts AI when direct subtitles are absent', async t => {
  let statusCalls = 0
  const fixture = await startFixtureServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/api/imports') {
      await readJson(req)
      return sendJson(res, 202, {
        ok: true,
        import: {
          id: IMPORT_ID,
          platform: 'youtube',
          url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          status: 'running',
        },
      })
    }
    if (req.method === 'GET' && req.url === `/api/imports/${IMPORT_ID}`) {
      statusCalls += 1
      return sendJson(res, 200, {
        ok: true,
        import: { id: IMPORT_ID, platform: 'youtube', status: 'awaiting_ai' },
      })
    }
    return sendJson(res, 500, { ok: false, error: `unexpected ${req.method} ${req.url}` })
  })
  t.after(fixture.close)

  const client = createYoutubeSubtitlesClient({
    baseUrl: fixture.baseUrl,
    token: 'fixture-token',
    pollIntervalMs: 1,
  })
  const result = await client.start({
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    wait_ms: 100,
  })

  assert.equal(statusCalls, 1)
  assert.equal(result.status, 'subtitles_not_found')
  assert.equal(result.needs_ai, true)
  assert.equal(result.subtitles_found, false)
})

test('status returns a polling instruction while the import is still running', async t => {
  const fixture = await startFixtureServer((req, res) => {
    if (req.method === 'GET' && req.url === `/api/imports/${IMPORT_ID}`) {
      return sendJson(res, 200, {
        ok: true,
        import: { id: IMPORT_ID, platform: 'youtube', status: 'running' },
      })
    }
    return sendJson(res, 404, { ok: false, error: 'not found' })
  })
  t.after(fixture.close)

  const client = createYoutubeSubtitlesClient({ baseUrl: fixture.baseUrl, token: 'fixture-token' })
  const result = await client.status({ import_id: IMPORT_ID, wait_ms: 0 })

  assert.equal(result.status, 'running')
  assert.equal(result.next.tool, 'youtube_subtitles_status')
  assert.equal(result.next.arguments.import_id, IMPORT_ID)
})

test('cancels only through the explicit cancel endpoint', async t => {
  let cancelCalls = 0
  const fixture = await startFixtureServer((req, res) => {
    if (req.method === 'GET' && req.url === `/api/imports/${IMPORT_ID}`) {
      return sendJson(res, 200, {
        ok: true,
        import: { id: IMPORT_ID, platform: 'youtube', status: 'running' },
      })
    }
    if (req.method === 'POST' && req.url === `/api/imports/${IMPORT_ID}/cancel`) {
      cancelCalls += 1
      return sendJson(res, 200, {
        ok: true,
        import: { id: IMPORT_ID, platform: 'youtube', status: 'cancelled' },
      })
    }
    return sendJson(res, 404, { ok: false, error: 'not found' })
  })
  t.after(fixture.close)

  const client = createYoutubeSubtitlesClient({ baseUrl: fixture.baseUrl, token: 'fixture-token' })
  const result = await client.cancel({ import_id: IMPORT_ID })

  assert.equal(cancelCalls, 1)
  assert.equal(result.status, 'cancelled')
})

test('reports an unavailable desktop without exposing its bearer token', async () => {
  const secret = 'do-not-leak-this-token'
  const client = createYoutubeSubtitlesClient({
    baseUrl: 'http://127.0.0.1:1',
    token: secret,
    requestTimeoutMs: 100,
  })

  await assert.rejects(
    client.start({ url: 'https://youtu.be/dQw4w9WgXcQ', wait_ms: 0 }),
    error => {
      assert.match(error.message, /SC Desktop HTTP API is unavailable/)
      assert.doesNotMatch(error.message, new RegExp(secret))
      return true
    },
  )
})
