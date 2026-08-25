const test = require('node:test')
const assert = require('node:assert/strict')

const {
  parseJson3Cues,
  parseVttCues,
  pairAdjacentAsrCues,
  findCueIndex,
  examplesForTerm,
  batchTexts,
} = require('../youtube-learning-utils')

test('parses JSON3 cues and merges append events', () => {
  const cues = parseJson3Cues({
    events: [
      { tStartMs: 1000, dDurationMs: 900, segs: [{ utf8: 'Hello' }] },
      { tStartMs: 1500, dDurationMs: 900, aAppend: 1, segs: [{ utf8: ' world' }] },
      { tStartMs: 2600, dDurationMs: 700, segs: [{ utf8: 'Next line' }] },
    ],
  })
  assert.equal(cues.length, 2)
  assert.equal(cues[0].text, 'Hello world')
  assert.equal(cues[0].startMs, 1000)
  assert.ok(cues[0].endMs >= 2400)
})

test('parses VTT and finds the active cue', () => {
  const cues = parseVttCues(`WEBVTT

00:00:01.000 --> 00:00:02.500
First line

00:00:03.000 --> 00:00:04.000
Second line
`)
  assert.equal(cues.length, 2)
  assert.equal(findCueIndex(cues, 1800), 0)
  assert.equal(findCueIndex(cues, 2800), -1)
  assert.equal(findCueIndex(cues, 3200), 1)
})

test('current-video examples match whole words and prefer nearby cues', () => {
  const cues = [
    { startMs: 0, endMs: 1000, text: 'A partner can help.' },
    { startMs: 1000, endMs: 2000, text: 'Partnership is different.' },
    { startMs: 2000, endMs: 3000, text: 'My partner agreed.' },
    { startMs: 3000, endMs: 4000, text: 'Another partner arrived.' },
  ]
  const examples = examplesForTerm(cues, 'partner', 2, 2, 'en')
  assert.deepEqual(examples.map(item => item.cueIndex), [2, 3])
})

test('translation batches respect item and character ceilings', () => {
  const items = Array.from({ length: 30 }, (_, index) => ({ index, text: `line-${index}-${'x'.repeat(210)}` }))
  const batches = batchTexts(items, 25, 1000)
  assert.ok(batches.length > 1)
  for (const batch of batches) {
    assert.ok(batch.length <= 25)
    assert.ok(batch.reduce((sum, item) => sum + item.text.length, 0) <= 1000)
  }
})

test('pairs adjacent rolling ASR fragments into longer readable cues', () => {
  const cues = pairAdjacentAsrCues([
    { startMs: 41520, endMs: 43680, text: 'shipped three other models. The training' },
    { startMs: 43680, endMs: 45680, text: 'itself had reportedly already been' },
    { startMs: 45680, endMs: 47840, text: 'underway before that announcement. That' },
    { startMs: 47840, endMs: 50480, text: 'one sentence is what spawned 3 months of' },
  ])

  assert.deepEqual(cues.map(cue => ({ startMs: cue.startMs, endMs: cue.endMs, text: cue.text })), [
    {
      startMs: 41520,
      endMs: 45680,
      text: 'shipped three other models. The training itself had reportedly already been',
    },
    {
      startMs: 45680,
      endMs: 50480,
      text: 'underway before that announcement. That one sentence is what spawned 3 months of',
    },
  ])
})
