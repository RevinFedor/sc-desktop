const test = require('node:test')
const assert = require('node:assert/strict')

const {
  parseJson3Cues,
  parseVttCues,
  pairAdjacentAsrCues,
  findCueIndex,
  examplesForTerm,
  batchTexts,
  inclusiveWordRange,
  cueNavigationDelta,
  alignedTargetRanges,
  exactTermRanges,
  cueWindowText,
  sentenceForTerm,
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

test('shift-click phrase range works in both directions', () => {
  assert.deepEqual(inclusiveWordRange(2, 7), { fromWordIndex: 2, toWordIndex: 7 })
  assert.deepEqual(inclusiveWordRange(7, 2), { fromWordIndex: 2, toWordIndex: 7 })
})

test('physical A and D navigate cues independently of keyboard layout', () => {
  assert.equal(cueNavigationDelta('KeyA'), -1)
  assert.equal(cueNavigationDelta('KeyD'), 1)
  assert.equal(cueNavigationDelta('KeyF'), 0)
})

test('copy window adds the requested neighboring cues on one side', () => {
  const cues = [
    { text: 'First.' },
    { text: 'Second.' },
    { text: 'Third.' },
    { text: 'Fourth.' },
  ]
  assert.equal(cueWindowText(cues, 2, 0, 'left'), 'Third.')
  assert.equal(cueWindowText(cues, 2, 2, 'left'), 'First. Second. Third.')
  assert.equal(cueWindowText(cues, 1, 2, 'right'), 'Second. Third. Fourth.')
  assert.equal(cueWindowText(cues, 0, 3, 'left'), 'First.')
})

test('single-word handoff keeps the complete sentence containing that word', () => {
  assert.equal(
    sentenceForTerm('The first sentence ends. This word matters here. Another follows.', 'word', 'en'),
    'This word matters here.',
  )
  assert.equal(sentenceForTerm('unfinished subtitle with word', 'word', 'en'), 'unfinished subtitle with word')
})

test('Azure alignment maps the selected English word to its Russian form', () => {
  const source = 'you want it if you want to'
  const target = 'вы хотите этого, если хотите'
  const ranges = alignedTargetRanges(
    source,
    target,
    'want',
    '0:2-0:1 4:7-3:8 9:10-10:14 12:13-17:20 15:17-22:27 19:22-22:27',
    'en',
  )
  assert.deepEqual(ranges.map(range => target.slice(range.start, range.end)), ['хотите', 'хотите'])
})

test('exact Russian dictionary term is a safe fallback when Azure omits alignment', () => {
  const target = 'Это недокументированная функция.'
  const ranges = exactTermRanges(target, ['недокументированная', 'нелегальная'], 'ru')
  assert.deepEqual(ranges.map(range => target.slice(range.start, range.end)), ['недокументированная'])
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
