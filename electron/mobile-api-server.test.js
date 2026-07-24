const assert = require('node:assert/strict')
const test = require('node:test')

const {
  applyImportFailure,
  classifyUrl,
  firstHttpUrl,
  instagramPathParts,
  isInstagramHost,
  publicRequest,
  reconcilePersistedRequest,
  resolveInstagramShareUrl,
  youtubeCacheTitle,
  youtubeVideoId,
} = require('./mobile-api-server')

test('extracts the first supported URL from pasted text', () => {
  assert.equal(
    firstHttpUrl('look https://www.youtube.com/watch?v=dQw4w9WgXcQ).'),
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  )
})

test('classifies canonical Instagram Reel and Post URLs', () => {
  assert.deepEqual(
    classifyUrl('https://www.instagram.com/reel/ABC_def-12/?igsh=secret'),
    {
      platform: 'instagram',
      url: 'https://www.instagram.com/reel/ABC_def-12/?igsh=secret',
      externalId: 'ABC_def-12',
      mediaKind: 'reel',
    },
  )
  assert.equal(classifyUrl('https://instagram.com/p/Post_123/').mediaKind, 'post')
  assert.equal(classifyUrl('https://instagram.com/some-profile/'), null)
  assert.equal(classifyUrl('https://instagram.com.evil.test/reel/ABC123/'), null)
})

test('classifies supported YouTube single-video URL shapes', () => {
  const id = 'dQw4w9WgXcQ'
  for (const url of [
    `https://youtu.be/${id}?si=secret`,
    `https://www.youtube.com/watch?v=${id}&list=ignored`,
    `https://m.youtube.com/shorts/${id}`,
    `https://youtube.com/live/${id}`,
  ]) {
    assert.equal(youtubeVideoId(url), id)
    assert.equal(classifyUrl(url).externalId, id)
  }
  assert.equal(classifyUrl('https://youtube.com/@channel'), null)
})

test('recognizes only exact Instagram share-link paths', () => {
  assert.equal(instagramPathParts('https://www.instagram.com/share/reel/Token123/').share, true)
  assert.equal(instagramPathParts('https://www.instagram.com/share/p/Token123/').share, true)
  assert.equal(instagramPathParts('https://www.instagram.com/share/profile/Token123/'), null)
  assert.equal(isInstagramHost('sub.instagram.com'), true)
  assert.equal(isInstagramHost('instagram.com.evil.test'), false)
})

test('resolves an Instagram share link through bounded safe redirects', async () => {
  const seen = []
  const resolved = await resolveInstagramShareUrl(
    'https://www.instagram.com/share/reel/ShareToken/',
    async url => {
      seen.push(url)
      return {
        status: 302,
        location: 'https://www.instagram.com/reel/Canonical12/?igsh=secret',
        body: '',
      }
    },
  )
  assert.equal(resolved, 'https://www.instagram.com/reel/Canonical12/?igsh=secret')
  assert.equal(seen.length, 1)
})

test('resolves an Instagram share link from canonical HTML', async () => {
  const resolved = await resolveInstagramShareUrl(
    'https://www.instagram.com/share/p/ShareToken/',
    async () => ({
      status: 200,
      location: null,
      body: '<link rel="canonical" href="https://www.instagram.com/p/CanonicalPost/">',
    }),
  )
  assert.equal(resolved, 'https://www.instagram.com/p/CanonicalPost/')
})

test('rejects an Instagram share redirect outside Instagram', async () => {
  await assert.rejects(
    resolveInstagramShareUrl(
      'https://www.instagram.com/share/reel/ShareToken/',
      async () => ({
        status: 302,
        location: 'https://evil.test/reel/Stolen/',
        body: '',
      }),
    ),
    /outside Instagram/,
  )
})

test('restores a persisted result file instead of marking it interrupted', () => {
  const item = {
    status: 'running',
    stage: 'transcribing',
    progress: 0,
    error: 'stale',
    resultFile: __filename,
    jobId: 1,
    stepIndex: 2,
    stepTotal: 7,
  }
  assert.equal(reconcilePersistedRequest(item), 'restored')
  assert.equal(item.status, 'done')
  assert.equal(item.stage, 'done')
  assert.equal(item.resultReady, undefined)
  assert.equal(item.error, null)
  assert.equal(item.jobId, null)
  assert.equal(item.stepIndex, 7)
})

test('marks only unfinished imports without a result as interrupted', () => {
  const item = {
    status: 'running',
    stage: 'transcribing',
    resultFile: '/definitely/missing/scdesk-result.txt',
    jobId: 1,
  }
  assert.equal(reconcilePersistedRequest(item), 'interrupted')
  assert.equal(item.status, 'error')
  assert.equal(item.stage, 'interrupted')
  assert.equal(item.errorCode, 'interrupted')
  assert.equal(item.jobId, null)
})

test('normalizes the legacy missing-parts Instagram failure', () => {
  const item = {
    platform: 'instagram',
    status: 'error',
    stage: 'error',
    stepIndex: 5,
    error: "transcribe failed: 'parts'",
    jobId: null,
  }

  assert.equal(reconcilePersistedRequest(item), 'normalized')
  assert.equal(item.status, 'error')
  assert.equal(item.stage, 'audio_no_text')
  assert.equal(item.errorCode, 'audio_no_text')
  assert.equal(item.error, 'Аудиодорожка есть, но распознанного текста нет.')
})

test('exposes audio-without-text as a stable mobile terminal outcome', () => {
  const item = {
    id: 'import-1',
    clientRequestId: 'request-1',
    platform: 'instagram',
    url: 'https://www.instagram.com/reel/NoSpeech123/',
    externalId: 'NoSpeech123',
    mediaKind: 'reel',
    status: 'running',
    stage: 'transcribing',
    progress: 4 / 6,
    stepIndex: 5,
    stepTotal: 7,
    createdAt: '2026-07-24T18:53:56.082Z',
    updatedAt: '2026-07-24T18:53:59.118Z',
    jobId: 12,
  }

  applyImportFailure(item, {
    code: 'audio_no_text',
    error: 'Аудиодорожка есть, но распознанного текста нет.',
  })
  const result = publicRequest(item)

  assert.equal(result.status, 'error')
  assert.equal(result.stage, 'audio_no_text')
  assert.equal(result.errorCode, 'audio_no_text')
  assert.equal(result.error, 'Аудиодорожка есть, но распознанного текста нет.')
  assert.equal(result.resultReady, false)
  assert.equal(item.jobId, null)
})

test('reads a persisted YouTube title from either cache shape', () => {
  assert.equal(youtubeCacheTitle({ title: 'Direct title' }), 'Direct title')
  assert.equal(
    youtubeCacheTitle({ parameters_json: JSON.stringify({ title: 'Stored title' }) }),
    'Stored title',
  )
  assert.equal(youtubeCacheTitle({ parameters_json: '{bad-json' }), null)
})
