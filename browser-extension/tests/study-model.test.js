const test = require('node:test')
const assert = require('node:assert/strict')

const {
  SWIPE_THRESHOLD,
  buildRound,
  isDue,
  nextSessionStats,
  reviewMode,
  swipeResult,
} = require('../study-model')

const now = Date.parse('2026-08-25T12:00:00.000Z')

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

test('every round contains every saved card and avoids immediate boundary repeats', () => {
  const entries = [card('a'), card('b'), card('c'), card('ignored', { state: 'known' })]
  const keys = buildRound(entries, {}, 'a', now)
  assert.deepEqual(new Set(keys), new Set(['a', 'b', 'c']))
  assert.notEqual(keys[0], 'a')
})

test('forgotten cards gain priority in the next endless round', () => {
  const entries = [card('easy'), card('hard')]
  const stats = nextSessionStats({}, 'hard', 'forgotten')
  assert.equal(buildRound(entries, stats, '', now)[0], 'hard')
})

test('horizontal swipe maps left to remembered and right to forgotten', () => {
  assert.equal(SWIPE_THRESHOLD, 56)
  assert.equal(swipeResult(-56), 'remembered')
  assert.equal(swipeResult(56), 'forgotten')
  assert.equal(swipeResult(-55), null)
  assert.equal(swipeResult(55), null)
})
