const test = require('node:test')
const assert = require('node:assert/strict')

const Lexeme = require('../english-lexeme')

test('verb inflections share one lemma identity', () => {
  const inputs = [
    { sourceText: 'describe', partOfSpeech: 'VERB' },
    { sourceText: 'describes', context: 'She describes the system.' },
    { sourceText: 'described', partOfSpeech: 'VERB' },
    { sourceText: 'describing', context: 'People are describing you.' },
  ]
  const keys = inputs.map((input) => Lexeme.identityKey({ kind: 'word', sourceLang: 'en', targetLang: 'ru', ...input }))
  assert.deepEqual(new Set(keys), new Set(['word|en|ru|describe']))
})

test('that before third-person verb does not override a decisive following clause', () => {
  const measure = Lexeme.analyzeWord('measures', { context: 'that measures how well the model works' })
  assert.equal(measure.lemma, 'measure')
  assert.equal(measure.partOfSpeech, 'verb')
  assert.equal(measure.confidence, 'high')
})

test('same surface remains separate when the dictionary lemmas are actually different', () => {
  const noun = Lexeme.identityKey({
    kind: 'word', sourceLang: 'en', targetLang: 'ru', sourceText: 'building', partOfSpeech: 'NOUN',
  })
  const verb = Lexeme.identityKey({
    kind: 'word', sourceLang: 'en', targetLang: 'ru', sourceText: 'building', context: 'They are building a house.',
  })
  assert.equal(noun, 'word|en|ru|building')
  assert.equal(verb, 'word|en|ru|build')
  assert.notEqual(noun, verb)
})

test('base-form homograph keeps syntax as sense metadata but shares one card', () => {
  const verb = Lexeme.analyzeWord('measure', { context: 'we need to measure the result' })
  const noun = Lexeme.analyzeWord('measure', { context: 'a measure of traffic' })
  assert.equal(verb.partOfSpeech, 'verb')
  assert.equal(noun.partOfSpeech, 'noun')
  assert.equal(
    Lexeme.identityKey({ kind: 'word', sourceLang: 'en', targetLang: 'ru', sourceText: 'measure', context: 'we need to measure the result' }),
    Lexeme.identityKey({ kind: 'word', sourceLang: 'en', targetLang: 'ru', sourceText: 'measure', context: 'a measure of traffic' }),
  )
})

test('derivational prefixes and related words are not merged', () => {
  const documented = Lexeme.identityKey({ kind: 'word', sourceLang: 'en', targetLang: 'ru', sourceText: 'documented', partOfSpeech: 'adjective' })
  const undocumented = Lexeme.identityKey({ kind: 'word', sourceLang: 'en', targetLang: 'ru', sourceText: 'undocumented', partOfSpeech: 'adjective' })
  assert.notEqual(documented, undocumented)
  assert.match(undocumented, /\|undocumented$/)
})

test('irregular verbs and generated forms remain available offline', () => {
  const went = Lexeme.analyzeWord('went', { context: 'He went home.' })
  assert.equal(went.lemma, 'go')
  assert.equal(went.confidence, 'high')
  assert.deepEqual(
    new Set(Lexeme.formsForLexeme({ kind: 'word', sourceLang: 'en', targetLang: 'ru', lemma: 'describe', partOfSpeech: 'verb' })),
    new Set(['describe', 'describes', 'described', 'describing']),
  )
})

test('ambiguous form stays provisional instead of being merged blindly', () => {
  const finding = Lexeme.analyzeWord('finding')
  assert.equal(finding.lemma, 'finding')
  assert.equal(finding.provisional, true)
})

test('adjective-shaped word before a noun is not mistaken for the noun itself', () => {
  const auxiliary = Lexeme.analyzeWord('auxiliary', {
    context: 'the auxiliary loss evaluates to its difference',
  })
  assert.equal(auxiliary.partOfSpeech, 'adjective')
  assert.equal(auxiliary.lemma, 'auxiliary')

  const measure = Lexeme.analyzeWord('measure', { context: 'a measure of traffic' })
  assert.equal(measure.partOfSpeech, 'noun')
})
