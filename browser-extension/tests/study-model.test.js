const test = require('node:test')
const assert = require('node:assert/strict')

test('session counters record answers but never override the canonical due time', () => {
  const { nextSessionStats } = require('../study-model')
  const at = Date.now()
  const partial = nextSessionStats({}, 'word', 'partial', at).word
  const forgotten = nextSessionStats({}, 'word', 'forgotten', at).word
  const remembered = nextSessionStats({}, 'word', 'remembered', at).word
  assert.equal(partial.partial, 1)
  assert.equal(partial.remembered, 0)
  assert.equal(partial.forgotten, 0)
  assert.equal(partial.total, 1)
  for (const stats of [partial, forgotten, remembered]) assert.equal(stats.nextEligibleAt, undefined)
})

const {
  MAX_CORE_SENSES,
  SWIPE_THRESHOLD,
  buildReviewUnits,
  buildSenseOverview,
  buildRound,
  cardDebugText,
  cardGestureAxis,
  catalogueDisplayEntry,
  displaySenseMeaning,
  exampleTranslation,
  isDue,
  nextSessionStats,
  reviewMode,
  reviewUnitKey,
  selectSenseExample,
  sensePresentation,
  swipeResult,
} = require('../study-model')

const now = Date.parse('2026-08-25T12:00:00.000Z')

test('English choices preserve their nuance, omit the source word and are not capped at three', () => {
  const terms = [
    { term: 'schedule', nuance: '' }, { term: 'plan', nuance: '' },
    { term: 'intend', nuance: 'намереваться' }, { term: 'arrange', nuance: 'организовать' },
    { term: 'book', nuance: 'бронировать' },
  ]
  const entry = catalogueDisplayEntry({ sourceText: 'schedule' }, {
    groups: [{ id: 'planning', shortMeaning: 'планировать', meaning: 'планировать', englishAlternatives: terms,
      example: 'We scheduled the meeting.', exampleTranslation: 'Мы запланировали встречу.' }],
  })
  assert.deepEqual(buildSenseOverview(entry).senses[0].englishAlternatives, terms.slice(1))
})

test('debug copy contains the whole card in a pasteable text format', () => {
  const entry = catalogueDisplayEntry({ sourceText: 'schedule' }, {
    teachingPriorityVersion: 1,
    groups: [
      { id: 'calendar', shortMeaning: 'расписание', meaning: 'расписание, график', alternatives: ['распорядок'],
        headwordChoice: { term: 'schedule', nuance: 'о плане по времени' },
        englishAlternatives: [{ term: 'timetable', nuance: '' }],
        example: 'The schedule changed.', exampleTranslation: 'Расписание изменилось.' },
      { id: 'planning', shortMeaning: 'планировать', meaning: 'планировать', alternatives: [],
        headwordChoice: { term: 'schedule', nuance: 'назначать конкретное время' },
        englishAlternatives: [{ term: 'plan', nuance: '' }, { term: 'intend', nuance: 'намереваться' }],
        example: 'We schedule every meeting.', exampleTranslation: 'Мы планируем каждую встречу.' },
    ],
    supportGroups: [{ id: 'programme', shortMeaning: 'программа передач', parentCoreId: 'calendar', relation: 'shade',
      reason: 'Отдельное употребление для телевизионной сетки.', focusEn: 'schedule', focusRu: 'программу',
      example: 'Check the TV schedule.', exampleTranslation: 'Посмотри программу телепередач.',
      activeEquivalent: { en: 'TV guide', ru: 'телепрограмма' } }],
  })
  assert.equal(cardDebugText(entry), [
    'schedule',
    '',
    'Переводы: расписание, график, распорядок / планировать | программа передач',
    '',
    '1. расписание, график, распорядок',
    'EN: The schedule changed.',
    'RU: Расписание изменилось.',
    'Английские варианты: schedule (о плане по времени) · timetable',
    '',
    '2. планировать',
    'EN: We schedule every meeting.',
    'RU: Мы планируем каждую встречу.',
    'Английские варианты: schedule (назначать конкретное время) · plan · intend (намереваться)',
    '',
    '—',
    '',
    '3. программа передач',
    'EN: Check the TV schedule.',
    'RU: Посмотри программу телепередач.',
  ].join('\n'))
  assert.doesNotMatch(cardDebugText(entry), /Проще сказать:/)
  assert.deepEqual(buildSenseOverview(entry).support[0], {
    id: 'programme', definitionIds: [], parentCoreId: 'calendar', relation: 'shade', support: true,
    shortMeaning: 'программа передач', meaning: 'программа передач', alternatives: [],
    description: 'Отдельное употребление для телевизионной сетки.',
    headwordChoice: { term: 'schedule', nuance: '' },
    englishAlternatives: [{ term: 'TV guide', nuance: 'телепрограмма' }],
    example: { sourceText: 'Check the TV schedule.', translation: 'Посмотри программу телепередач.',
      focusEn: 'schedule', focusRu: 'программу', origin: 'dictionary' },
  })
})

function card(key, overrides = {}) {
  return {
    key,
    state: 'saved',
    sourceText: key,
    reviewCount: 1,
    rememberedCount: 1,
    forgottenCount: 0,
    practiceRememberedCount: 0,
    practiceForgottenCount: 0,
    dueAt: new Date(now + 86_400_000).toISOString(),
    ...overrides,
  }
}

test('scheduled cards update FSRS while early extra rounds are practice', () => {
  assert.equal(isDue(card('new', { reviewCount: 0 }), now), true)
  assert.equal(reviewMode(card('due', { dueAt: new Date(now - 1).toISOString() }), now), 'scheduled')
  assert.equal(reviewMode(card('early'), now), 'practice')
})

test('due reviews precede new words and future/ignored cards are not included', () => {
  const entries = [
    card('new-a', { reviewCount: 0, rememberedCount: 0 }),
    card('new-b', { reviewCount: 0, rememberedCount: 0 }),
    card('due', { dueAt: new Date(now - 1).toISOString() }),
    card('future'),
    card('ignored', { state: 'known' }),
  ]
  const keys = buildRound(entries, {}, '', now)
  assert.deepEqual(keys, [
    'due',
    'new-a',
    'new-b',
  ])
})

test('a failed card becomes available at the server minute, independent of local session counters', () => {
  const entries = [card('hard', { dueAt: new Date(now + 60_000).toISOString() })]
  const key = 'hard'
  const stats = nextSessionStats({}, key, 'forgotten', now)
  assert.deepEqual(buildRound(entries, stats, '', now + 59_999), [])
  assert.equal(buildRound(entries, stats, '', now + 60_000)[0], key)
})

test('one saved word is one scheduled review unit even when it has many senses', () => {
  const entries = [card('assume', {
    dueAt: new Date(now - 1).toISOString(),
    senses: [
      { id: 'guess', meaning: 'предполагать / считать', reviewCount: 0, dueAt: new Date(now).toISOString() },
      { id: 'take-on', meaning: 'брать на себя', reviewCount: 2, dueAt: new Date(now + 86_400_000).toISOString() },
    ],
  })]
  const units = buildReviewUnits(entries)
  assert.equal(units.length, 1)
  assert.equal(units[0].key, 'assume')
  assert.equal(units[0].entryKey, 'assume')
  assert.equal(units[0].senseId, '')
  assert.equal(units[0].reviewCount, entries[0].reviewCount)
  assert.deepEqual(buildRound(entries, {}, '', now), ['assume'])
  assert.equal(reviewUnitKey('assume', 'ignored-sense'), 'assume')
})

test('each eligible word appears at most once in a round', () => {
  const entries = [
    card('alpha', {
      createdAt: now - 3_000,
      senses: [
        { id: 'a1', meaning: 'alpha one', reviewCount: 0, dueAt: new Date(now).toISOString() },
        { id: 'a2', meaning: 'alpha two', reviewCount: 0, dueAt: new Date(now).toISOString() },
        { id: 'a3', meaning: 'alpha three', reviewCount: 0, dueAt: new Date(now).toISOString() },
      ],
    }),
    card('beta', {
      createdAt: now - 2_000,
      senses: [
        { id: 'b1', meaning: 'beta one', reviewCount: 0, dueAt: new Date(now).toISOString() },
        { id: 'b2', meaning: 'beta two', reviewCount: 0, dueAt: new Date(now).toISOString() },
      ],
    }),
    card('gamma', {
      createdAt: now - 1_000,
      dueAt: new Date(now - 1).toISOString(),
      senses: [
        { id: 'g1', meaning: 'gamma due', reviewCount: 2, dueAt: new Date(now - 1).toISOString() },
      ],
    }),
  ]
  assert.deepEqual(buildRound(entries, {}, '', now), ['gamma'])
  assert.equal(new Set(buildReviewUnits(entries).map((unit) => unit.entryKey)).size, 3)
})

test('known records success while its interval remains owned by the scheduler', () => {
  const key = 'word'
  const stats = nextSessionStats({}, key, 'known', now)
  assert.equal(stats[key].remembered, 1)
  assert.equal(stats[key].nextEligibleAt, undefined)
})

test('horizontal swipe maps left to remembered and right to forgotten', () => {
  assert.equal(SWIPE_THRESHOLD, 56)
  assert.equal(swipeResult(-56), 'remembered')
  assert.equal(swipeResult(56), 'forgotten')
  assert.equal(swipeResult(-55), null)
  assert.equal(swipeResult(55), null)
})

test('overview uses the backend core-sense order, caps it at five and preserves full labels for CSS wrapping', () => {
  const senses = Array.from({ length: 8 }, (_, index) => ({
    id: `sense:noun:значение ${index} / синоним ${index}`,
    meaning: `значение ${index} / синоним ${index}`,
    shortMeaning: `длинное значение ${index}`,
    alternatives: [`вариант ${index}`, `синоним ${index}`],
    partOfSpeech: 'noun',
    contextIds: [`example-${index}`],
    reviewCount: index === 9 ? 0 : 4,
    dueAt: new Date(now + 86_400_000).toISOString(),
  }))
  const entry = card('word', {
    senses,
    contexts: senses.map((sense, index) => ({ id: `example-${index}`, sourceText: `Example ${index}.`, senseId: sense.id })),
    senseCatalog: { coreSenses: senses.slice().reverse().map((sense) => sense.id) },
  })
  const before = structuredClone(entry)
  const units = buildReviewUnits([entry])
  const overview = buildSenseOverview(entry)

  assert.equal(MAX_CORE_SENSES, 5)
  assert.equal(overview.senses.length, 5)
  assert.equal(overview.activeSense, null)
  assert.deepEqual(overview.senses.map(sense => sense.id), senses.slice(3).reverse().map((sense) => sense.id))
  assert.deepEqual(overview.senses[0].alternatives, ['значение 7', 'синоним 7', 'вариант 7'])
  assert.equal(overview.senses[0].example.id, 'example-7')
  assert.equal(overview.translation, senses.slice(3).reverse().map((sense) => sense.shortMeaning).join(' / '))
  assert.ok(overview.translation.includes('длинное значение 7'))
  assert.deepEqual(buildReviewUnits([entry]), units)
  assert.deepEqual(entry, before)
})

test('short meaning falls back to the first synonym and aliases exclude the heading', () => {
  assert.deepEqual(sensePresentation({
    meaning: 'находить, отыскивать / обнаруживать',
    alternatives: ['выяснять', 'находить', { value: 'отыскивать' }],
  }), {
    shortMeaning: 'находить',
    alternatives: ['отыскивать', 'обнаруживать', 'выяснять'],
    meaning: 'находить, отыскивать, обнаруживать',
  })
  assert.deepEqual(sensePresentation({
    shortMeaning: 'считать', meaning: 'считать, полагать', alternatives: ['находить каким-либо'],
  }).alternatives, ['полагать', 'находить каким-либо'])
})

test('active want meaning uses its own example while overview also contains хотеть', () => {
  const entry = card('want', {
    translation: 'требоваться / нуждаться',
    senses: [
      { id: 'desire', meaning: 'хотеть / желать', contextIds: ['desire-example'] },
      { id: 'need', meaning: 'требоваться / нуждаться', contextIds: ['need-example'] },
    ],
    contexts: [
      { id: 'desire-example', senseId: 'desire', sourceText: 'I want a cup of tea.', translation: 'Я хочу чашку чая.' },
      { id: 'need-example', senseId: 'need', sourceText: 'The plants want water.', translation: 'Растения нуждаются в воде.' },
      { id: 'unrelated', sourceText: 'A sentence without a meaning association.' },
    ],
  })
  const overview = buildSenseOverview(entry, 'need')
  assert.equal(overview.translation, 'хотеть / требоваться')
  assert.equal(overview.activeSense.example.id, 'need-example')
  assert.equal(overview.senses[0].example.id, 'desire-example')
})

test('missing choice example stays missing instead of borrowing the current option example', () => {
  const entry = card('choice', {
    translation: 'вариант',
    senses: [
      { id: 'selection', meaning: 'выбор', contextIds: ['missing-example'] },
      { id: 'option', meaning: 'вариант', contextIds: ['option-example'] },
      { id: 'untranslated', meaning: '', contextIds: [] },
    ],
    contexts: [
      { id: 'option-example', senseId: 'option', meaning: 'вариант', sourceText: 'A good choice for a short visit.' },
      { id: 'unlabelled', sourceText: 'You have a choice.' },
    ],
  })
  const overview = buildSenseOverview(entry, 'selection')
  assert.equal(overview.activeSense.example, null)
  assert.equal(overview.senses[1].example.id, 'option-example')
  assert.equal(overview.senses[2].example, null)
  assert.equal(overview.translation, 'выбор / вариант / Перевод')
})

test('explicit example ownership prevents stale IDs and identical translations from reusing another sense', () => {
  const entry = card('word', {
    senses: [
      { id: 'first', meaning: 'вести', contextIds: ['shared', 'first-example'] },
      { id: 'second', meaning: 'вести', contextIds: ['shared', 'first-example'] },
    ],
    contexts: [
      { id: 'shared', meaning: 'вести', sourceText: 'An ambiguously linked example.' },
      { id: 'first-example', senseId: 'first', meaning: 'вести', sourceText: 'The first meaning example.' },
      { id: 'only-label', meaning: 'вести', sourceText: 'Another ambiguous example.' },
    ],
  })
  const overview = buildSenseOverview(entry, 'second')
  assert.equal(overview.senses.length, 2)
  assert.equal(overview.senses[0].example.id, 'first-example')
  assert.equal(overview.activeSense.example, null)
})

test('selects exactly one associated dictionary example ahead of video examples', () => {
  const sense = { id: 'meaning', meaning: 'значение', contextIds: ['video', 'dictionary-a', 'dictionary-b'] }
  const entry = card('word', {
    senses: [sense],
    contexts: [
      { id: 'empty', senseId: 'meaning', origin: 'dictionary', sourceText: '   ' },
      { id: 'video', sourceText: 'A video sentence.', origin: 'video' },
      { id: 'dictionary-a', sourceText: 'A dictionary sentence.', translation: 'Проверенный перевод.', origin: 'dictionary' },
      { id: 'dictionary-b', sourceText: 'A second dictionary sentence.', origin: 'dictionary' },
    ],
  })
  assert.equal(selectSenseExample(entry, sense), entry.contexts[2])
  assert.equal(buildSenseOverview(entry, sense.id).activeSense.example.translation, 'Проверенный перевод.')
})

test('legacy whole-meaning association is allowed but overlapping synonyms do not prove ownership', () => {
  const entry = card('assume', {
    senses: [{ id: 'guess', meaning: 'предполагать / считать' }],
    contexts: [
      { id: 'wrong', senseId: 'different', meaning: 'предполагать / считать', sourceText: 'Already assigned elsewhere.' },
      { id: 'overlap', meaning: 'считать', sourceText: 'Only a synonym matches.' },
      { id: 'exact', meaning: 'предполагать, считать', sourceText: 'The exact legacy meaning matches.' },
    ],
  })
  assert.equal(selectSenseExample(entry, entry.senses[0]).id, 'exact')
  assert.equal(selectSenseExample({ ...entry, contexts: entry.contexts.slice(0, 2) }, entry.senses[0]), null)
  assert.equal(displaySenseMeaning(' хотеть  /  желать, стремиться '), 'хотеть, желать, стремиться')
})

test('legacy entries retain the default review unit without inventing an example', () => {
  const entry = card('legacy', {
    translation: 'перевод',
    contexts: [{ id: 'other', sourceText: 'A sentence from another meaning.', meaning: 'другое значение' }],
  })
  const [unit] = buildReviewUnits([entry])
  const overview = buildSenseOverview(entry)
  assert.equal(unit.senseId, '')
  assert.equal(overview.senses[0].id, 'default')
  assert.equal(overview.senses[0].example, null)
  assert.equal(overview.translation, 'перевод')
  assert.deepEqual(buildSenseOverview(null), { senses: [], activeSense: null, translation: '' })
})

test('gesture ownership separates reading overflowing examples from diagonal card reviews', () => {
  assert.equal(cardGestureAxis(2, 2, true), null)
  assert.equal(cardGestureAxis(8, 28, true), 'scroll')
  assert.equal(cardGestureAxis(-8, -28, true), 'scroll')
  assert.equal(cardGestureAxis(28, 8, true), 'swipe')
  assert.equal(cardGestureAxis(-28, -24, true), 'swipe')
  assert.equal(cardGestureAxis(8, 28, false), 'partial')
  assert.equal(cardGestureAxis(0, 28, false), 'partial')
  assert.equal(cardGestureAxis(0, -28, false), 'vertical')
})

test('a delayed machine paraphrase cannot overwrite a verified dictionary example or its highlighting', () => {
  const context = { origin: 'dictionary', translation: 'Это ближе к тому, что ты хочешь показать.' }
  assert.deepEqual(exampleTranslation(context, undefined), { targetText: context.translation, alignment: '' })
  assert.deepEqual(exampleTranslation(context, {
    translated_text: 'Это уже ближе к тому, что нам нужно.', alignment: '0:3-15:21',
  }), { targetText: context.translation, alignment: '' })
  assert.deepEqual(exampleTranslation(context, {
    translated_text: context.translation, alignment: '0:3-15:21',
  }), { targetText: context.translation, alignment: '0:3-15:21' })
  assert.deepEqual(exampleTranslation({ origin: 'dictionary', translation: '' }, {
    translated_text: 'Непроверенный перевод.', alignment: '0:3-1:9',
  }), { targetText: '', alignment: '' })
  assert.equal(exampleTranslation({ origin: 'video', translation: 'Старый перевод.' }, {
    translated_text: 'Перевод из видео.',
  }).targetText, 'Перевод из видео.')
})

test('catalogue overview uses five backend core groups and their verified examples', () => {
  const entry = card('want', {
    senses: [{ id: 'old', meaning: 'нужно', reviewCount: 3 }],
    contexts: [{ id: 'chat', sourceText: 'The original chat sentence.', translation: 'Исходное предложение из чата.' }],
  })
  const before = structuredClone(entry)
  const catalogue = {
    source: { provider: 'wiktionary', url: 'https://en.wiktionary.org/wiki/want' },
    coreSenses: ['group-11', 'group-4', 'group-2', 'group-8', 'group-1', 'group-0'],
    groups: Array.from({ length: 12 }, (_, index) => ({
      id: `group-${index}`, meaning: `перевод ${index} / синоним ${index}`, shortMeaning: `перевод ${index}`,
      alternatives: [`другой вариант ${index}`], partOfSpeech: 'verb',
      example: index === 11 ? '' : `Verified example ${index}.`, exampleTranslation: `Проверенный перевод ${index}.`,
    })),
  }
  const displayed = catalogueDisplayEntry(entry, catalogue)
  const overview = buildSenseOverview(displayed)
  assert.equal(overview.senses.length, 5)
  assert.deepEqual(overview.senses.map((sense) => sense.shortMeaning), ['перевод 11', 'перевод 4', 'перевод 2', 'перевод 8', 'перевод 1'])
  assert.equal(overview.senses[1].example.translation, 'Проверенный перевод 4.')
  assert.deepEqual(overview.senses[1].alternatives, ['синоним 4', 'другой вариант 4'])
  assert.equal(overview.senses[0].example, null)
  assert.equal(displayed.contexts.some(context => context.id === 'chat'), true,
    'Observed dialogue remains available as a separate example, without replacing any checked meaning example')
  assert.deepEqual(entry, before)
  assert.equal(catalogueDisplayEntry(entry, { source: catalogue.source, validatedAt: now }), entry)
})
