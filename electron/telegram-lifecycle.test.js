const test = require('node:test')
const assert = require('node:assert/strict')
const { resolveTelegramProcessOutcome } = require('./telegram-lifecycle')

test('done is successful only after an exit-0 process close', () => {
  assert.deepEqual(resolveTelegramProcessOutcome({ exitCode: 0, protocolDone: true }), {
    status: 'done', error: null, errorCode: null,
  })
})

test('non-zero exit wins over an earlier done event', () => {
  const result = resolveTelegramProcessOutcome({ exitCode: 1, protocolDone: true, stderrTail: 'boom' })
  assert.equal(result.status, 'error')
  assert.match(result.error, /python exited 1.*boom/)
})

test('protocol error followed by exit 0 remains an error', () => {
  const result = resolveTelegramProcessOutcome({
    exitCode: 0, protocolDone: true, protocolError: true, error: 'bad event',
  })
  assert.deepEqual(result, { status: 'error', error: 'bad event', errorCode: null })
})

test('exit 0 without done is protocol_incomplete', () => {
  const result = resolveTelegramProcessOutcome({ exitCode: 0, protocolDone: false })
  assert.equal(result.status, 'error')
  assert.equal(result.errorCode, 'protocol_incomplete')
})

test('cancellation wins over exit and protocol outcomes', () => {
  assert.deepEqual(resolveTelegramProcessOutcome({
    cancelRequested: true, exitCode: 1, protocolError: true, error: 'ignored',
  }), { status: 'cancelled', error: null, errorCode: null })
})
