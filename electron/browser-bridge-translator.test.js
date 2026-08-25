const test = require('node:test')
const assert = require('node:assert/strict')

const { __test } = require('./browser-bridge')

const settingsAccess = {
  readScSettings() {
    return {
      api_keys: { AZURE_TRANSLATOR_KEY: 'test-key' },
      azure_translator: {
        endpoint: 'https://translator.invalid',
        region: 'northeurope',
      },
    }
  },
}

test('Azure request retries one transient transport failure', async () => {
  const originalFetch = global.fetch
  let calls = 0
  global.fetch = async () => {
    calls += 1
    if (calls === 1) {
      const error = new TypeError('fetch failed')
      error.cause = { code: 'ECONNRESET' }
      throw error
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify([{ translations: [{ text: 'Готово' }] }]),
    }
  }

  try {
    const payload = await __test.azureTranslatorRequest(
      settingsAccess,
      '/translate',
      { from: 'en', to: 'ru' },
      [{ Text: 'Ready' }],
    )
    assert.equal(calls, 2)
    assert.equal(payload[0].translations[0].text, 'Готово')
  } finally {
    global.fetch = originalFetch
  }
})

test('timestamped transcript parser keeps millisecond cue boundaries', () => {
  const cues = __test.parseTimestampedTranscript(`
[00:00:41.520] first fragment
[00:00:43.680] second fragment
[00:00:45,680] third fragment
`)

  assert.deepEqual(cues, [
    { startMs: 41520, endMs: 43680, text: 'first fragment' },
    { startMs: 43680, endMs: 45680, text: 'second fragment' },
    { startMs: 45680, endMs: 48680, text: 'third fragment' },
  ])
})

test('vocabulary sync payload keeps the offline learning contract', () => {
  assert.equal(__test.normalizeVocabularyTerm('  That’s   Fine  '), 'that’s fine')
  assert.deepEqual(__test.vocabularySyncPayload({
    sourceText: 'That’s',
    translation: 'Это',
    translationSource: 'manual',
    state: 'known',
    kind: 'word',
    sourceLang: 'en',
    targetLang: 'ru',
    contexts: [{ sourceText: "That's fine." }],
  }), {
    term: 'That’s',
    translation: 'Это',
    translationSource: 'manual',
    state: 'known',
    kind: 'word',
    sourceLang: 'en',
    targetLang: 'ru',
    contexts: [{ sourceText: "That's fine." }],
  })
  assert.equal(__test.vocabularySyncPayload({ sourceText: 'skip', state: '' }).state, 'none')
})
