const test = require('node:test')
const assert = require('node:assert/strict')
const { fixture } = require('./helpers/chatgpt-flow-fixture.cjs')

// Staged source permits validation without hot-reloading active user jobs.
const sourcePath = process.env.SC_CHATGPT_SOURCE
test('Pro is still observed after 30 minutes and returns its later final', async () => {
  const f = fixture({ sourcePath })
  const boundary = f.createTurnBoundary(null)
  f.turn('user', 'long-user', 'review')
  f.stop.visible = true
  const done = [], progress = []
  const close = f.startDoneWatcher(value => done.push(value), value => progress.push(value), null,
    () => [], null, boundary, { extended: true })
  await f.clock.advance(31 * 60_000)
  assert.equal(done.length, 0)
  assert.equal(progress.some(value => value.stage === 'timeout'), false)
  assert.equal(progress.some(value => value.stage === 'waiting_extended'), true)
  f.stop.visible = false
  f.turn('assistant', 'long-answer', 'late final')
  await f.clock.advance(5000)
  assert.equal(done.length, 1)
  close()
})

test('ordinary mode retains its existing timeout contract', async () => {
  const f = fixture({ sourcePath })
  const boundary = f.createTurnBoundary(null)
  f.turn('user', 'ordinary-user', 'question')
  f.stop.visible = true
  const progress = []
  const close = f.startDoneWatcher(() => {}, value => progress.push(value), null, () => [], null, boundary)
  await f.clock.advance(31 * 60_000)
  assert.equal(progress.some(value => value.stage === 'timeout'), true)
  close()
})
