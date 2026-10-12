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

test('learning media language detector distinguishes English, Russian, and mixed subtitles', () => {
  assert.equal(__test.subtitleLanguageFromText('This interview is entirely in English. '.repeat(8)).code, 'en')
  assert.equal(__test.subtitleLanguageFromText('Это собеседование полностью проходит на русском языке. '.repeat(8)).code, 'ru')
  assert.equal(__test.subtitleLanguageFromText(`${'English sentence. '.repeat(8)}${'Русское предложение. '.repeat(8)}`).code, 'mixed')
})

test('Boosty outcome parser keeps explicit offer, rejection, and candidate refusal distinct', () => {
  assert.equal(__test.interviewOutcomeFromDescription('<p>В итоге получил оффер на 8 000$.</p>').code, 'offer')
  assert.equal(__test.interviewOutcomeFromDescription('✅ Прошел').code, 'passed')
  assert.equal(__test.interviewOutcomeFromDescription('✅ Пройдено').code, 'passed')
  assert.equal(__test.interviewOutcomeFromDescription('Компания отказала после финального этапа.').code, 'rejected')
  assert.equal(__test.interviewOutcomeFromDescription('😔 Не пройдено').code, 'rejected')
  assert.equal(__test.interviewOutcomeFromDescription('❌ Отказ').code, 'rejected')
  assert.equal(__test.interviewOutcomeFromDescription('Провалено ❌').code, 'rejected')
  assert.equal(__test.interviewOutcomeFromDescription('Получил оффер, но отказался от оффера сам.').code, 'candidate_declined')
  assert.equal(__test.interviewOutcomeFromDescription('Разбор технического интервью и вопросы команды.').code, 'unknown')
  assert.equal(__test.interviewOutcomeFromDescription('Разобрал свой пройденный System Design.').code, 'unknown')
})

test('Boosty interview details separate chips from non-duplicated notes', () => {
  assert.deepEqual(__test.boostyInterviewDetails(`
🏢 Inworld AI
💵 30,000$
😔 Не прошел ❌
⚠ Principal Engineer
До этого был созвон с командой.
HR — прошел
  `), {
    company: 'Inworld AI',
    compensation: '30,000$',
    role: 'Principal Engineer',
    notes: 'До этого был созвон с командой.\nHR — прошел',
    outcome: {
      code: 'rejected',
      label: 'Отказ',
      evidence: '😔 Не прошел ❌',
      explicit: true,
    },
  })
})

test('learning media library groups child videos by the real Boosty parent and preserves stage order', () => {
  const source = { id: 7, display_name: 'Про гринд в АйТи' }
  const parent = {
    external_id: 'post:order-capital',
    title: 'Order Capital 8,000$',
    caption: '<p>Три этапа. В итоге получил оффер.</p>',
    url: 'https://boosty.test/post',
    published_at: 100,
  }
  const row = (id, externalId, position) => ({
    source,
    parent,
    videoMeta: { position },
    item: {
      id,
      source_id: 7,
      external_id: externalId,
      parent_external_id: parent.external_id,
      title: `Stage ${position}`,
      url: parent.url,
      duration_seconds: 60,
      published_at: 100,
      download_status: 'done',
      transcribe_status: 'done',
    },
    video: id === 2 ? { stat: { size: 123 } } : null,
    subtitles: null,
    audio: null,
  })
  const result = __test.publicLearningMediaLibrary([row(1, 'v1', 2), row(2, 'v2', 1)], 'token')
  assert.equal(result.groups.length, 1)
  assert.deepEqual(result.groups[0].videoIds, [2, 1])
  assert.equal(result.groups[0].downloadedCount, 1)
  assert.equal(result.groups[0].outcome.code, 'offer')
  assert.equal(result.groups[0].description, 'Три этапа. В итоге получил оффер.')
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
  assert.equal(__test.vocabularySyncPayload({ sourceText: 'later', state: 'archived' }).state, 'archived')
  assert.equal(__test.vocabularySyncPayload({ sourceText: 'replace', state: 'saved', replaceContexts: true }).replaceContexts, true)
})

test('Voice discovery prefers the installed vocabulary server over a newer isolated runtime', () => {
  assert.deepEqual(__test.orderVoiceServerCandidates([
    { port: 7995, updatedAt: 300 },
    { port: 7888, updatedAt: 100 },
    { port: 7889, updatedAt: 200 },
  ]).map(candidate => candidate.port), [7888, 7995, 7889])
  assert.deepEqual(__test.orderVoiceServerCandidates([
    { port: 7995, updatedAt: 300 },
    { port: 7889, updatedAt: 200 },
  ]).map(candidate => candidate.port), [7995, 7889])
})

test('practice request keeps a bounded bilingual history and vocabulary identity', () => {
  const request = __test.normalizeVocabularyPracticeRequest({
    action: 'turn',
    theme: 'technical_interview',
    answer: '  This   is reliable. ',
    vocabulary: [
      { key: 'word|en|ru|reliable', sourceText: ' reliable ', translation: 'надёжный', partOfSpeech: 'adjective' },
      { key: 'word|en|ru|reliable', sourceText: 'duplicate' },
    ],
    history: Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? 'user' : 'assistant', english: ` line ${index} ` })),
  })
  assert.equal(request.action, 'turn')
  assert.equal(request.theme, 'technical_interview')
  assert.equal(request.answer, 'This   is reliable.')
  assert.equal(request.vocabulary.length, 1)
  assert.deepEqual(request.vocabulary[0], {
    id: 'word|en|ru|reliable',
    term: 'reliable',
    translation: 'надёжный',
    partOfSpeech: 'adjective',
  })
  assert.equal(request.history.length, 16)
  assert.equal(request.history[0].english, 'line 4')
  assert.equal(__test.normalizeVocabularyPracticeRequest({
    action: 'start',
    theme: 'unsupported',
    vocabulary: [{ id: 'word|en|ru|safe', term: 'safe' }],
  }).theme, 'general')
})

test('practice relay preserves a long bilingual thought process and all explicit questions', () => {
  const answer = 'Так, I like work. I love to work.\n'.repeat(160) + 'Thanks to this or because of this?'
  const payload = { action: 'turn', requestId: 'same-attempt', answer,
    vocabulary: [{ id: 'word|en|ru|work', term: 'work' }],
    history: [{ role: 'assistant', english: 'What helped?', feedbackRussian: 'Первое пояснение.\n\nВторое пояснение.' }],
  }
  const result = __test.normalizeVocabularyPracticeRequest(payload)
  assert.equal(result.answer, answer)
  assert.equal(result.requestId, 'same-attempt')
  assert.equal(result.history[0].feedbackRussian, payload.history[0].feedbackRussian)
  assert.throws(() => __test.normalizeVocabularyPracticeRequest({ ...payload, answer: 'x'.repeat(24001) }), /too long/)
})
