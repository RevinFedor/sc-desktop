const test = require('node:test')
const assert = require('node:assert/strict')

const {
  runTelegramAutoOnce,
  stopTelegramAutoScheduler,
} = require('./telegram-auto')

test.afterEach(() => stopTelegramAutoScheduler())

test('auto scheduler skips a persistently unavailable source', async () => {
  let starts = 0
  const db = {
    listTelegramAutoSources: () => [{
      id: 7,
      handle: 'gone_channel',
      tg_session: 'session_test',
      tg_auto: { pull: true, index: false, types: ['text'], engine: 'assemblyai' },
      tg_health: { status: 'unavailable', code: 'telegram_source_unavailable' },
    }],
  }
  const jobRunner = {
    subscribe: () => () => {},
    startTelegramCatchUp: () => { starts += 1; return 1 },
  }

  const result = await runTelegramAutoOnce({
    db,
    jobRunner,
    indexJob: {},
    reason: 'test',
  })

  assert.equal(starts, 0)
  assert.equal(result.groups, 0)
  assert.equal(result.sources, 1)
  assert.equal(result.skippedUnavailable, 1)
})
