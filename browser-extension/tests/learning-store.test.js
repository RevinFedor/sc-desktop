const test = require('node:test')
const assert = require('node:assert/strict')

const {
  entryKey,
  compatibleEntryForIdentity,
  mergeCanonicalEntries,
  mergeContexts,
  normalizeEntry,
  normalizePracticeSession,
  normalizeExpressionType,
  normalizeTerm,
} = require('../learning-store')

test('same lemma reuses one card across parts of speech', () => {
  const verb = { key: 'sequence-verb', partOfSpeech: 'verb', state: 'saved' }
  assert.equal(compatibleEntryForIdentity([verb], {
    partOfSpeech: 'noun',
    confidence: 'high',
  }), verb)
  assert.equal(compatibleEntryForIdentity([verb], {
    partOfSpeech: 'unknown',
    confidence: 'low',
  }), verb)
})

test('a legacy wrong POS can be refined when its own context proves the requested identity', () => {
  const mislabeledVerb = {
    key: 'sequence-verb',
    sourceLang: 'en',
    targetLang: 'ru',
    sourceText: 'sequence',
    partOfSpeech: 'verb',
    state: 'saved',
    contexts: [{
      surfaceForm: 'sequence',
      sourceText: 'At the start and an end of sequence token at the finish.',
    }],
  }
  assert.equal(compatibleEntryForIdentity([mislabeledVerb], {
    partOfSpeech: 'noun',
    confidence: 'high',
  }), mislabeledVerb)
})

test('dictionary keys are stable across case and surrounding punctuation', () => {
  assert.equal(normalizeTerm(' “That’s!” '), "that's")
  assert.equal(
    entryKey({ kind: 'word', sourceLang: 'EN', targetLang: 'RU', sourceText: 'That’s!' }),
    "word|en|ru|that's",
  )
})

test('inflected forms merge into one lexeme without losing contexts or review counts', () => {
  const merged = mergeCanonicalEntries([
    normalizeEntry({
      sourceText: 'describing', sourceLang: 'en', targetLang: 'ru', state: 'known', rememberedCount: 1,
      contexts: [{ sourceText: 'People are describing you.', surfaceForm: 'describing' }],
    }),
    normalizeEntry({
      sourceText: 'describes', sourceLang: 'en', targetLang: 'ru', state: 'saved', forgottenCount: 2,
      contexts: [{ sourceText: 'She describes the system.', surfaceForm: 'describes' }],
    }),
  ], { markDirty: true })

  assert.equal(merged.key, 'word|en|ru|describe')
  assert.equal(merged.sourceText, 'describe')
  assert.equal(merged.state, 'saved')
  assert.equal(merged.reviewCount, 3)
  assert.equal(merged.contexts.length, 2)
  assert.deepEqual(new Set(merged.observedForms), new Set(['describe', 'describes', 'describing']))
})

test('one lemma keeps noun and verb as metadata inside the same card', () => {
  const merged = mergeCanonicalEntries([
    normalizeEntry({ sourceText: 'measure', lemma: 'measure', partOfSpeech: 'noun', analysisConfidence: 'high' }),
    normalizeEntry({ sourceText: 'measure', lemma: 'measure', partOfSpeech: 'verb', analysisConfidence: 'high' }),
  ])
  assert.equal(merged.key, 'word|auto|ru|measure')
  assert.deepEqual(new Set(merged.partsOfSpeech), new Set(['noun', 'verb']))
})

test('video contexts merge without duplicating the same cue', () => {
  const merged = mergeContexts([
    { id: 41, videoId: 'abcdefghijk', startMs: 1000, sourceText: 'That works.', translation: '', origin: 'video' },
  ], [
    { id: 'new-client-id', videoId: 'abcdefghijk', startMs: 1000, sourceText: 'That works.', translation: 'Это работает.', meaning: 'работает', partOfSpeech: 'verb' },
    { videoId: 'abcdefghijk', startMs: 2000, sourceText: 'That is enough.' },
  ])
  assert.equal(merged.length, 2)
  assert.equal(merged.find((item) => item.startMs === 1000).translation, 'Это работает.')
  assert.equal(merged.find((item) => item.startMs === 1000).meaning, 'работает')
  assert.equal(merged.find((item) => item.startMs === 1000).origin, 'video')
  assert.equal(merged.find((item) => item.startMs === 1000).partOfSpeech, 'verb')
})

test('only known and saved are active learning states', () => {
  assert.equal(normalizeEntry({ sourceText: 'known', state: 'known' }).state, 'known')
  assert.equal(normalizeEntry({ sourceText: 'saved', state: 'saved' }).state, 'saved')
  assert.equal(normalizeEntry({ sourceText: 'ignored', state: 'ignored' }).state, 'none')
})

test('typed expressions keep canonical identity and observed surface forms', () => {
  const entry = normalizeEntry({
    kind: 'phrase',
    expressionType: 'phrasal_verb',
    sourceLang: 'en',
    targetLang: 'ru',
    sourceText: 'gave up',
    lemma: 'give up',
    observedForms: ['gave up'],
    translation: 'сдался',
  })
  assert.equal(normalizeExpressionType('function_phrase'), 'function_phrase')
  assert.equal(normalizeExpressionType('collocation'), '')
  assert.equal(entry.sourceText, 'give up')
  assert.equal(entry.expressionType, 'phrasal_verb')
  assert.ok(entry.observedForms.includes('gave up'))
})

test('legacy entries gain zeroed practice statistics without losing scheduled counts', () => {
  const entry = normalizeEntry({ sourceText: 'repeat', rememberedCount: 2, forgottenCount: 1 })
  assert.equal(entry.reviewCount, 3)
  assert.equal(entry.rememberedCount, 2)
  assert.equal(entry.forgottenCount, 1)
  assert.equal(entry.practiceCount, 0)
  assert.equal(entry.practiceRememberedCount, 0)
  assert.equal(entry.practiceForgottenCount, 0)
})

test('practice session keeps bounded bilingual messages and vocabulary references', () => {
  const session = normalizePracticeSession({
    id: 'ignored-client-id',
    vocabularyKeys: ['one', 'one', 'two'],
    messages: [{
      id: 'm1',
      role: 'assistant',
      english: ' How are you? ',
      russian: ' Как дела? ',
      feedbackRussian: '',
      correctedEnglish: '',
      usedVocabularyIds: ['one', 'one'],
      createdAt: 10,
    }],
    createdAt: 5,
    updatedAt: 8,
  })
  assert.equal(session.id, 'current')
  assert.deepEqual(session.vocabularyKeys, ['one', 'two'])
  assert.deepEqual(session.messages[0], {
    id: 'm1',
    role: 'assistant',
    english: 'How are you?',
    russian: 'Как дела?',
    feedbackRussian: '',
    correctedEnglish: '',
    usedVocabularyIds: ['one'],
    createdAt: 10,
  })
})
