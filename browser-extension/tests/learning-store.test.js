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
  remoteToEntry,
} = require('../learning-store')

test('authoritative catalogue sync removes stale dictionary contexts without losing saved progress', () => {
  const existing = normalizeEntry({
    kind: 'word', sourceLang: 'en', targetLang: 'ru', sourceText: 'want', lemma: 'want', state: 'saved',
    partOfSpeech: 'verb', analysisConfidence: 'high', forgottenCount: 2,
    contexts: [{ sourceText: 'This is closer to what you want to show.', meaning: 'нуждаться', origin: 'dictionary' }],
  });
  const remote = {
    id: 'remote-want', term: 'want', lemma: 'want', kind: 'word', state: 'saved',
    sourceLang: 'en', targetLang: 'ru', partOfSpeech: 'verb', analysisConfidence: 'high',
    forgottenCount: 2, reviewCount: 2,
    contexts: [{ sourceText: 'I want to sleep.', translation: 'Я хочу спать.', meaning: 'хотеть', senseId: 'want-desire', origin: 'dictionary' }],
    senses: [{ id: 'want-desire', meaning: 'хотеть', forgottenCount: 2, reviewCount: 2 }],
    senseCatalog: { version: 1, validatedAt: 123 },
  };
  const synced = remoteToEntry(remote, existing, null, true);
  assert.deepEqual(synced.contexts.map(c => c.sourceText), ['I want to sleep.']);
  assert.deepEqual(synced.senses.map(s => s.id), ['want-desire']);
  assert.equal(synced.forgottenCount, 2);
  assert.equal(synced.senseCatalog.validatedAt, 123);
});

test('short meanings and alternatives survive remote sync and local normalization', () => {
  const remote = {
    id: 'remote-find', term: 'find', lemma: 'find', kind: 'word', state: 'saved',
    sourceLang: 'en', targetLang: 'ru', partOfSpeech: 'verb',
    contexts: [{
      sourceText: 'I found my keys.', translation: 'Я нашёл ключи.', meaning: 'находить, отыскивать, обнаруживать',
      senseId: 'find-locate', catalogGroupId: 'g1', origin: 'dictionary',
    }],
    senses: [{
      id: 'find-locate', catalogGroupId: 'g1', meaning: 'находить, отыскивать, обнаруживать',
      shortMeaning: 'находить', alternatives: ['отыскивать', 'обнаруживать', 'отыскивать'],
      englishAlternatives: [{ term: 'locate', nuance: 'определять местоположение' }, { term: 'discover', nuance: 'обнаруживать' }],
    }],
    senseCatalog: { version: 1, validatedAt: 123 },
  };
  const synced = remoteToEntry(remote, null, null, true);
  assert.equal(synced.senses[0].shortMeaning, 'находить');
  assert.deepEqual(synced.senses[0].alternatives, ['отыскивать', 'обнаруживать']);

  const reloaded = normalizeEntry(synced);
  assert.equal(reloaded.senses[0].shortMeaning, 'находить');
  assert.deepEqual(reloaded.senses[0].alternatives, ['отыскивать', 'обнаруживать']);
  assert.deepEqual(reloaded.senses[0].englishAlternatives, remote.senses[0].englishAlternatives);
});

test('an observation history cannot evict any checked meaning or its only example', () => {
  const dictionary = Array.from({ length: 120 }, (_, i) => ({
    sourceText: `This is dictionary example ${i}.`, translation: `Это пример ${i}.`,
    meaning: `значение ${i}`, senseId: `sense-${i}`, catalogGroupId: `group-${i}`,
    origin: 'dictionary', createdAt: 1_700_000_000_000,
  }));
  const observations = Array.from({ length: 110 }, (_, i) => ({
    sourceText: `This is video observation ${i}.`, origin: 'video',
    videoId: 'video', startMs: i * 1000, createdAt: 1_800_000_000_000,
  }));
  const merged = mergeContexts(dictionary, observations);
  assert.equal(merged.filter(context => context.catalogGroupId).length, 120);
  assert.equal(merged.filter(context => !context.catalogGroupId).length, 100);
  const synced = remoteToEntry({
    id: 'word', kind: 'word', term: 'word', lemma: 'word', state: 'saved', sourceLang: 'en', targetLang: 'ru',
    contexts: merged, senses: dictionary.map(context => ({ id: context.senseId, meaning: context.meaning, catalogGroupId: context.catalogGroupId })),
    senseCatalog: { version: 1, validatedAt: 123 },
  }, null, null, true);
  assert.equal(synced.senses.filter(sense => sense.catalogGroupId).length, 120);
});

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

test('checked losing keeps its own headword and key through remote sync and local reload', () => {
  const remote = {
    id: 'losing', kind: 'word', term: 'losing', lemma: 'losing', partOfSpeech: 'verb',
    state: 'saved', sourceLang: 'en', targetLang: 'ru', rememberedCount: 2,
    contexts: [{ sourceText: 'They are losing money.', meaning: 'терять', senseId: 'loss', catalogGroupId: 'g1', origin: 'dictionary' }],
    senses: [{ id: 'loss', meaning: 'терять', catalogGroupId: 'g1', rememberedCount: 2 }],
    senseCatalog: { version: 1, validatedAt: 123, source: { word: 'losing' } },
  };
  const synced = remoteToEntry(remote, null, null, true);
  assert.equal(synced.sourceText, 'losing');
  assert.equal(synced.key, 'word|en|ru|losing');
  const reloaded = normalizeEntry({ ...synced, lemma: 'lose' });
  assert.equal(reloaded.lemma, 'losing');
  assert.equal(reloaded.key, synced.key);
  assert.equal(reloaded.rememberedCount, 2);
});

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

test('archive is a retained non-learning state', () => {
  assert.equal(normalizeEntry({ sourceText: 'known', state: 'known' }).state, 'known')
  assert.equal(normalizeEntry({ sourceText: 'saved', state: 'saved' }).state, 'saved')
  assert.equal(normalizeEntry({ sourceText: 'archived', state: 'archived' }).state, 'archived')
  assert.equal(normalizeEntry({ sourceText: 'ignored', state: 'ignored' }).state, 'none')

  const archived = mergeCanonicalEntries([
    normalizeEntry({ sourceText: 'archive-priority', state: 'none' }),
    normalizeEntry({ sourceText: 'archive-priority', state: 'archived' }),
  ])
  assert.equal(archived.state, 'archived')
})

test('archive and restore retain the canonical root schedule through normalization and sync', () => {
  const fsrs = { state: 2, stability: 6.5, difficulty: 4.2, reps: 7, lapses: 2 }
  const saved = {
    sourceText: 'retain', lemma: 'retain', kind: 'word', sourceLang: 'en', targetLang: 'ru',
    state: 'saved', dueAt: '2026-09-20T12:00:00.000Z', lastReviewedAt: 1_780_000_000_000,
    reviewCount: 7, rememberedCount: 5, forgottenCount: 2,
    practiceCount: 3, practiceRememberedCount: 2, practiceForgottenCount: 1, fsrs,
    contexts: [{ sourceText: 'Retain the history.', meaning: 'сохранять', senseId: 'retain', origin: 'dictionary' }],
    senses: [{ id: 'retain', meaning: 'сохранять', reviewCount: 0 }],
  }
  const archived = normalizeEntry({ ...saved, state: 'archived', dirty: true })
  const synced = remoteToEntry({
    ...saved, id: 'v_retain', term: 'retain', state: 'archived', updatedAt: 1_800_000_000_000,
  }, archived, null, true)
  const restored = normalizeEntry({ state: 'saved' }, synced)
  for (const entry of [archived, synced, restored]) {
    assert.deepEqual(entry.fsrs, fsrs)
    assert.equal(entry.reviewCount, 7, 'Root history is not rebuilt from the meaning schedule')
    assert.equal(entry.forgottenCount, 2)
    assert.equal(entry.practiceCount, 3)
    assert.equal(entry.dueAt, saved.dueAt)
    assert.equal(entry.lastReviewedAt, saved.lastReviewedAt)
    assert.equal(entry.contexts[0].sourceText, saved.contexts[0].sourceText)
  }
  assert.equal(synced.state, 'archived')
  assert.equal(synced.dirty, false)
  assert.equal(restored.state, 'saved')
  const nextFsrs = { ...fsrs, stability: 8 }
  assert.deepEqual(remoteToEntry({ ...saved, term: 'retain', fsrs: nextFsrs }, restored, null, true).fsrs, nextFsrs)
})

test('the offline copy keeps the headword nuance alongside every meaning and example', () => {
  const { cardDebugText } = require('../study-model')
  const remote = {
    id: 'v_copy', kind: 'word', term: 'retain', state: 'saved', sourceLang: 'en', targetLang: 'ru',
    contexts: [{ sourceText: 'Retain the history.', translation: 'Сохрани историю.', meaning: 'сохранять', senseId: 'retain', origin: 'dictionary' }],
    senses: [{ id: 'retain', meaning: 'сохранять', headwordChoice: { term: 'retain', nuance: 'продолжать хранить' },
      englishAlternatives: [{ term: 'keep', nuance: 'оставлять' }] }],
  }
  const entry = normalizeEntry(remoteToEntry(remote, null, null, true))
  assert.deepEqual(entry.senses[0].headwordChoice, remote.senses[0].headwordChoice)
  assert.match(cardDebugText(entry), /retain \(продолжать хранить\) · keep \(оставлять\)/)
  assert.match(cardDebugText(entry), /EN: Retain the history\.\nRU: Сохрани историю\./)
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

test('server preferred translation replaces the old offline label without splitting its meaning or schedule', () => {
  const before = normalizeEntry({
    kind: 'word', sourceLang: 'en', targetLang: 'ru', sourceText: 'suddenly', lemma: 'suddenly',
    state: 'saved', translation: 'вдруг', remoteId: 'v_preference',
    contexts: [{ sourceText: 'The call suddenly ended.', translation: 'Звонок вдруг прервался.',
      meaning: 'вдруг', senseId: 'sense-one', catalogGroupId: 'group-one', origin: 'dictionary' }],
    senses: [{ id: 'sense-one', catalogGroupId: 'group-one', shortMeaning: 'вдруг', meaning: 'вдруг', alternatives: ['внезапно'] }],
  })
  const remote = {
    id: 'v_preference', kind: 'word', sourceLang: 'en', targetLang: 'ru', term: 'suddenly', lemma: 'suddenly',
    state: 'saved', translation: 'внезапно', translationSource: 'manual', updatedAt: Date.now(),
    dueAt: '2026-10-01T12:00:00.000Z', reviewCount: 8,
    contexts: before.contexts,
    senses: [{ ...before.senses[0], shortMeaning: 'внезапно', alternatives: ['вдруг'] }],
    senseCatalog: { version: 1, validatedAt: 1789160000000, source: { word: 'suddenly' },
      teachingPriorityVersion: 1, supportGroups: [{ id: 'gray', shortMeaning: 'нежданно', alternatives: ['неожиданно'] }] },
  }
  const synced = remoteToEntry(remote, before, null, true)
  const reloaded = normalizeEntry(synced)
  assert.equal(reloaded.key, before.key)
  assert.equal(reloaded.translation, 'внезапно')
  assert.equal(reloaded.translationSource, 'manual')
  assert.equal(reloaded.senses.length, 1)
  assert.equal(reloaded.senses[0].id, 'sense-one')
  assert.equal(reloaded.senses[0].shortMeaning, 'внезапно')
  assert.deepEqual(reloaded.senses[0].alternatives, ['вдруг'])
  assert.equal(reloaded.contexts[0].translation, 'Звонок вдруг прервался.')
  assert.equal(reloaded.senseCatalog.supportGroups[0].shortMeaning, 'нежданно')
  assert.equal(reloaded.dueAt, remote.dueAt)
  assert.equal(reloaded.reviewCount, 8)
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
    model: 'models/gemini-3.8-flash',
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
  assert.equal(session.model, 'models/gemini-3.8-flash')
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

test('practice keeps dictated reasoning, self-correction paragraphs and pending message identity across reload', () => {
  const reasoning = 'Так, I like work. I love to work. Why whether?\n'.repeat(180)
  const explanation = 'Ты верно исправился.\n\nWhether здесь означает «ли».'
  const session = normalizePracticeSession({ theme: 'technical_interview', draft: 'Следующий вопрос',
    messages: [
      { id: 'attempt-1', role: 'user', english: reasoning, russian: 'Unwanted legacy translation', status: 'failed', error: 'Offline' },
      { id: 'reply-1', role: 'assistant', english: 'How did this help?', feedbackRussian: explanation },
    ],
  })
  assert.equal(session.theme, 'technical_interview')
  assert.equal(session.draft, 'Следующий вопрос')
  assert.equal(session.messages[0].english, reasoning.trim())
  assert.equal(session.messages[0].russian, '')
  assert.equal(session.messages[0].id, 'attempt-1')
  assert.equal(session.messages[0].status, 'failed')
  assert.equal(session.messages[1].feedbackRussian, explanation)
})
