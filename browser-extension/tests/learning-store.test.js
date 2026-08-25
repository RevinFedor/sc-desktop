const test = require('node:test')
const assert = require('node:assert/strict')

const {
  entryKey,
  mergeContexts,
  normalizeEntry,
  normalizeTerm,
} = require('../learning-store')

test('dictionary keys are stable across case and surrounding punctuation', () => {
  assert.equal(normalizeTerm(' “That’s!” '), 'that’s')
  assert.equal(
    entryKey({ kind: 'word', sourceLang: 'EN', targetLang: 'RU', sourceText: 'That’s!' }),
    'word|en|ru|that’s',
  )
})

test('video contexts merge without duplicating the same cue', () => {
  const merged = mergeContexts([
    { id: 41, videoId: 'abcdefghijk', startMs: 1000, sourceText: 'That works.', translation: '' },
  ], [
    { id: 'new-client-id', videoId: 'abcdefghijk', startMs: 1000, sourceText: 'That works.', translation: 'Это работает.' },
    { videoId: 'abcdefghijk', startMs: 2000, sourceText: 'That is enough.' },
  ])
  assert.equal(merged.length, 2)
  assert.equal(merged.find((item) => item.startMs === 1000).translation, 'Это работает.')
})

test('only known and saved are active learning states', () => {
  assert.equal(normalizeEntry({ sourceText: 'known', state: 'known' }).state, 'known')
  assert.equal(normalizeEntry({ sourceText: 'saved', state: 'saved' }).state, 'saved')
  assert.equal(normalizeEntry({ sourceText: 'ignored', state: 'ignored' }).state, 'none')
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
