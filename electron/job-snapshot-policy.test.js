const test = require('node:test')
const assert = require('node:assert/strict')
const { boundedTail } = require('./job-snapshot-policy')

test('bounded tail keeps newest full rows under the byte budget', () => {
  const items = Array.from({ length: 120 }, (_, index) => ({
    id: index + 1,
    caption: `${index}:${'я'.repeat(1800)}`,
  }))
  const tail = boundedTail(items, item => item, { maxCount: 120, maxBytes: 64 * 1024 })
  assert.ok(tail.length > 0)
  assert.ok(tail.length < 120)
  assert.equal(tail[0].id, 120)
  assert.equal(tail[0].caption, items[119].caption)
  assert.ok(Buffer.byteLength(JSON.stringify(tail), 'utf8') <= 64 * 1024)
})

test('count cap applies to small rows', () => {
  const items = Array.from({ length: 200 }, (_, index) => ({ id: index + 1 }))
  const tail = boundedTail(items, item => item, { maxCount: 120, maxBytes: 64 * 1024 })
  assert.equal(tail.length, 120)
  assert.equal(tail[0].id, 200)
  assert.equal(tail.at(-1).id, 81)
})
