'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { stripTranscriptHeader, timestampSeconds, chunkTranscript } = require('./youtube-semantic')

test('stripTranscriptHeader removes the self-describing YouTube file header only', () => {
  const raw = '# Demo\nchannel: Channel\nurl: https://youtube.com/watch?v=123\nsource: subs\n\nActual transcript'
  assert.equal(stripTranscriptHeader(raw), 'Actual transcript')
  assert.equal(stripTranscriptHeader('Paragraph one\n\nParagraph two'), 'Paragraph one\n\nParagraph two')
})

test('timestampSeconds accepts transcript timestamp format', () => {
  assert.equal(timestampSeconds('01:02:03.250'), 3723.25)
  assert.equal(timestampSeconds('00:00:12,5'), 12.5)
  assert.equal(timestampSeconds('bad'), null)
})

test('chunkTranscript creates overlapping bounded chunks with approximate positions', () => {
  const body = Array.from({ length: 220 }, (_, index) => `Sentence ${index} explains a concrete part of the system.`).join(' ')
  const result = chunkTranscript(`# Demo\nurl: https://youtube.com/watch?v=123\n\n${body}`, {
    durationSeconds: 600,
    targetChars: 900,
    overlapChars: 120,
  })
  assert.ok(result.documentHash)
  assert.ok(result.chunks.length > 5)
  assert.equal(result.chunks[0].start_seconds, 0)
  assert.equal(result.chunks[0].position_approximate, true)
  assert.ok(result.chunks.at(-1).end_seconds >= 590)
  assert.ok(result.chunks.every(chunk => chunk.text.length <= 920))
})

test('chunkTranscript preserves exact timestamp anchors when present', () => {
  const raw = [
    '# Demo',
    'url: https://youtube.com/watch?v=123',
    '',
    '[00:00:10.000] First idea and its explanation.',
    '[00:00:25.000] Second idea and its explanation.',
  ].join('\n')
  const result = chunkTranscript(raw, { durationSeconds: 60, targetChars: 600 })
  assert.equal(result.chunks.length, 1)
  assert.equal(result.chunks[0].start_seconds, 10)
  assert.equal(result.chunks[0].position_approximate, false)
})
