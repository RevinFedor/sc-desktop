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
  let finalUrl = ''
  global.fetch = async (url) => {
    calls += 1
    if (calls === 1) {
      const error = new TypeError('fetch failed')
      error.cause = { code: 'ECONNRESET' }
      throw error
    }
    finalUrl = String(url)
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify([{ translations: [{ text: 'Готово', alignment: { proj: '0:4-0:5' } }] }]),
    }
  }

  try {
    const payload = await __test.azureTranslatorRequest(
      settingsAccess,
      '/translate',
      { from: 'en', to: 'ru', includeAlignment: true },
      [{ Text: 'Ready' }],
    )
    assert.equal(calls, 2)
    assert.equal(payload[0].translations[0].text, 'Готово')
    assert.match(finalUrl, /includeAlignment=true/)
  } finally {
    global.fetch = originalFetch
  }
})

test('dictionary examples request keeps one source-target pair per requested meaning', async () => {
  const originalFetch = global.fetch
  let requestUrl = ''
  let requestBody = null
  global.fetch = async (url, options) => {
    requestUrl = String(url)
    requestBody = JSON.parse(options.body)
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify([
        {
          normalizedSource: 'fine',
          normalizedTarget: 'прекрасно',
          examples: [{ sourcePrefix: 'That is ', sourceTerm: 'fine', sourceSuffix: '.', targetPrefix: 'Это ', targetTerm: 'прекрасно', targetSuffix: '.' }],
        },
      ]),
    }
  }

  try {
    const result = await __test.dictionaryExamples(settingsAccess, [{ text: 'fine', translation: 'прекрасно' }], 'en', 'ru', { cache: false })
    assert.match(requestUrl, /\/dictionary\/examples\?/)
    assert.deepEqual(requestBody, [{ Text: 'fine', Translation: 'прекрасно' }])
    assert.equal(result.examples[0].examples[0].targetTerm, 'прекрасно')
  } finally {
    global.fetch = originalFetch
  }
})

test('learning explanation cache identity includes word and subtitle context', () => {
  const first = __test.normalizeLearningExplanationPayload({
    word: ' want ',
    context: 'I want this.',
    contextTranslation: 'Я хочу это.',
    sourceLang: 'en',
    targetLang: 'ru',
    knownMeanings: ['хотеть / желать'],
  })
  const second = __test.normalizeLearningExplanationPayload({
    word: 'want',
    context: 'They want more.',
    contextTranslation: 'Они хотят больше.',
    sourceLang: 'en',
    targetLang: 'ru',
  })
  assert.equal(first.word, 'want')
  assert.deepEqual(first.knownMeanings, ['хотеть / желать'])
  assert.notEqual(__test.learningExplanationCacheKey(first), __test.learningExplanationCacheKey(second))
  const third = __test.normalizeLearningExplanationPayload({
    word: 'want', context: 'I want this.', sourceLang: 'en', targetLang: 'ru', knownMeanings: ['нуждаться'],
  })
  assert.notEqual(__test.learningExplanationCacheKey(first), __test.learningExplanationCacheKey(third))
})

test('learning explanation bridge preserves more than three semantic groups and their fallback examples', () => {
  const result = __test.normalizeLearningExplanationResult({
    explanation: 'Означает тестировать.',
    meaningGroups: Array.from({ length: 5 }, (_, index) => ({
      values: [`значение ${index + 1}`],
      partOfSpeech: 'verb',
      example: `Complete example ${index + 1}.`,
      exampleTranslation: `Законченный пример ${index + 1}.`,
    })),
    invalidValues: ['ошибка Azure'],
  })
  assert.equal(result.meaningGroups.length, 5)
  assert.equal(result.meaningGroups[4].example, 'Complete example 5.')
  assert.equal(result.meaningGroups[4].exampleTranslation, 'Законченный пример 5.')
  assert.deepEqual(result.invalidValues, ['ошибка Azure'])
})

test('expression classification supports only the three learning categories', () => {
  const first = __test.normalizeLearningExpressionPayload({ selectedText: ' as   of ', context: 'As of today.' })
  const second = __test.normalizeLearningExpressionPayload({ selectedText: 'as of', context: 'As of Monday.' })
  assert.equal(first.selectedText, 'as of')
  assert.notEqual(__test.learningExpressionCacheKey(first), __test.learningExpressionCacheKey(second))
  assert.deepEqual(__test.normalizeLearningExpressionResult({
    expressionType: 'function_phrase', canonicalText: ' As Of ', translation: 'начиная с', confidence: 'high',
  }), {
    eligible: true,
    expressionType: 'function_phrase',
    canonicalText: 'as of',
    translation: 'начиная с',
    confidence: 'high',
    model: 'gemini-3.1-flash-lite',
  })
})

test('literal subtitle cache identity includes both source and natural meaning', () => {
  const first = __test.normalizeLearningLiteralPayload({
    sourceText: 'Finish authentication first.',
    naturalTranslation: 'Сначала завершите аутентификацию.',
    sourceLang: 'en',
    targetLang: 'ru',
  })
  const second = __test.normalizeLearningLiteralPayload({
    sourceText: 'Finish authentication first.',
    naturalTranslation: 'Сначала закончите проверку.',
    sourceLang: 'en',
    targetLang: 'ru',
  })
  assert.notEqual(__test.learningLiteralCacheKey(first), __test.learningLiteralCacheKey(second))
  assert.deepEqual(
    __test.normalizeLiteralAlignments([{ sourceWordIndex: 1, targetStart: 4, targetEnd: 13 }], 'Да, закончите.'),
    [{ sourceWordIndex: 1, targetStart: 4, targetEnd: 13 }],
  )
})

test('literal alignment never highlights fragments across Russian word boundaries', () => {
  const literalText = 'Фрэнк уходит, девушка по имени Афина подходит к нему.'
  assert.deepEqual(
    __test.normalizeLiteralAlignments([
      { sourceWordIndex: 6, targetStart: 35, targetEnd: 40 },
    ], literalText),
    [{ sourceWordIndex: 6, targetStart: 37, targetEnd: 45 }],
  )
  assert.equal(literalText.slice(37, 45), 'подходит')
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

test('learning media parser reads SRT timings and byte ranges used by video seeking', () => {
  assert.deepEqual(__test.parseSrtCues(`
1
00:00:01,250 --> 00:00:03,500
First <i>subtitle</i> line

2
00:00:04.000 --> 00:00:06.125
Second line
continues here
`), [
    { startMs: 1250, endMs: 3500, text: 'First subtitle line' },
    { startMs: 4000, endMs: 6125, text: 'Second line continues here' },
  ])
  assert.deepEqual(__test.parseByteRange('bytes=100-199', 1000), { start: 100, end: 199 })
  assert.deepEqual(__test.parseByteRange('bytes=900-', 1000), { start: 900, end: 999 })
  assert.deepEqual(__test.parseByteRange('bytes=-100', 1000), { start: 900, end: 999 })
  assert.equal(__test.parseByteRange('bytes=1000-', 1000).invalid, true)
})

test('vocabulary sync payload keeps the offline learning contract', () => {
  assert.equal(__test.normalizeVocabularyTerm('  That’s   Fine  '), 'that’s fine')
  assert.deepEqual(__test.vocabularySyncPayload({
    sourceText: 'That’s',
    translation: 'Это',
    translationSource: 'manual',
    state: 'known',
    kind: 'word',
    expressionType: '',
    sourceLang: 'en',
    targetLang: 'ru',
    lemma: 'That’s',
    partOfSpeech: 'unknown',
    partsOfSpeech: [],
    analysisConfidence: 'low',
    observedForms: [],
    contexts: [{ sourceText: "That's fine." }],
  }), {
    term: 'That’s',
    translation: 'Это',
    translationSource: 'manual',
    state: 'known',
    kind: 'word',
    expressionType: '',
    sourceLang: 'en',
    targetLang: 'ru',
    lemma: 'That’s',
    partOfSpeech: 'unknown',
    partsOfSpeech: [],
    analysisConfidence: 'low',
    observedForms: [],
    contexts: [{ sourceText: "That's fine." }],
  })
  assert.equal(__test.vocabularySyncPayload({ sourceText: 'skip', state: '' }).state, 'none')
  assert.equal(__test.vocabularySyncPayload({ sourceText: 'replace', state: 'saved', replaceContexts: true }).replaceContexts, true)
})

test('practice request keeps a bounded bilingual history and vocabulary identity', () => {
  const request = __test.normalizeVocabularyPracticeRequest({
    action: 'turn',
    answer: '  This   is reliable. ',
    vocabulary: [
      { key: 'word|en|ru|reliable', sourceText: ' reliable ', translation: 'надёжный', partOfSpeech: 'adjective' },
      { key: 'word|en|ru|reliable', sourceText: 'duplicate' },
    ],
    history: Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? 'user' : 'assistant', english: ` line ${index} ` })),
  })
  assert.equal(request.action, 'turn')
  assert.equal(request.answer, 'This is reliable.')
  assert.equal(request.vocabulary.length, 1)
  assert.deepEqual(request.vocabulary[0], {
    id: 'word|en|ru|reliable',
    term: 'reliable',
    translation: 'надёжный',
    partOfSpeech: 'adjective',
  })
  assert.equal(request.history.length, 16)
  assert.equal(request.history[0].english, 'line 4')
})
