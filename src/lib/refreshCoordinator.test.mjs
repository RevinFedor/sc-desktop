import test from 'node:test'
import assert from 'node:assert/strict'
import { createRefreshCoordinator } from './refreshCoordinator.mjs'

test('concurrent invalidations share one active pull and one trailing pull', async () => {
  let release
  let calls = 0
  const firstGate = new Promise(resolve => { release = resolve })
  const coordinator = createRefreshCoordinator(async () => {
    calls += 1
    if (calls === 1) await firstGate
  })

  const first = coordinator.request()
  const second = coordinator.request()
  const third = coordinator.request()
  assert.strictEqual(second, first)
  assert.strictEqual(third, first)
  release()
  await first
  assert.equal(calls, 2)
})

test('a later request starts a fresh pull after the loop is idle', async () => {
  let calls = 0
  const coordinator = createRefreshCoordinator(async () => { calls += 1 })
  await coordinator.request()
  await coordinator.request()
  assert.equal(calls, 2)
})

test('a rejected pull releases the coordinator and a later retry works', async () => {
  let calls = 0
  const coordinator = createRefreshCoordinator(async () => {
    calls += 1
    if (calls === 1) throw new Error('fixture failure')
  })
  await assert.rejects(coordinator.request(), /fixture failure/)
  await coordinator.request()
  assert.equal(calls, 2)
})
