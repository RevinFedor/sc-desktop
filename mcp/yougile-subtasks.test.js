const assert = require('node:assert/strict')
const test = require('node:test')
const { loadYougileToolBridge } = require('./yougile-tools')

const PARENT_ID = '10000000-0000-4000-8000-000000000001'
const SIBLING_ID = '20000000-0000-4000-8000-000000000001'
const REQUEST_A = '30000000-0000-4000-8000-000000000001'
const REQUEST_B = '30000000-0000-4000-8000-000000000002'

// Models the documented HTTP contract, including whole-array PUT and server
// idempotency. All network calls stay inside this fixture; no live cards.
function fixture() {
  const tasks = new Map([[PARENT_ID, {
    id: PARENT_ID,
    title: 'Parent title must stay unchanged',
    columnId: 'in-progress-column',
    subtasks: [SIBLING_ID],
  }]])
  const createdByKey = new Map()
  const calls = []
  let nextChild = 1
  let loseCreateResponse = false
  let rejectLink = false
  let loseLinkResponse = false
  let placeChildOnBoard = false
  let omitLinkOnReadback = false
  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  })
  const fetchImpl = async (url, options) => {
    const resource = new URL(url).pathname.replace('/api-v2/', '')
    const body = options.body == null ? undefined : JSON.parse(options.body)
    calls.push({ method: options.method, resource, body })
    // Yield to exercise overlapping calls, rather than making every GET/PUT
    // implicitly synchronous in the concurrency regression.
    await Promise.resolve()
    if (options.method === 'POST' && resource === 'tasks') {
      let childId = createdByKey.get(body.idempotencyKey)
      if (!childId) {
        childId = `40000000-0000-4000-8000-${String(nextChild++).padStart(12, '0')}`
        createdByKey.set(body.idempotencyKey, childId)
        tasks.set(childId, {
          id: childId, title: body.title, subtasks: [],
          ...(placeChildOnBoard ? { columnId: 'unexpected-board-column' } : {}),
        })
      }
      if (loseCreateResponse) {
        loseCreateResponse = false
        throw new Error('connection lost after server accepted create')
      }
      return json({ id: childId }, 201)
    }
    const id = resource.replace('tasks/', '')
    const task = tasks.get(id)
    if (!task) return json({ error: 'task not found' }, 404)
    if (options.method === 'GET') return json(task)
    if (options.method === 'PUT') {
      if (rejectLink) {
        rejectLink = false
        return json({ error: 'temporarily unable to link' }, 503)
      }
      tasks.set(id, {
        ...task,
        ...body,
        ...(omitLinkOnReadback ? { subtasks: [SIBLING_ID] } : {}),
      })
      if (loseLinkResponse) {
        loseLinkResponse = false
        throw new Error('connection lost after server accepted link')
      }
      return json({ id })
    }
    throw new Error(`Unexpected fixture request: ${options.method} ${resource}`)
  }
  return {
    tasks, calls, createdByKey, fetchImpl,
    loseNextCreateResponse() { loseCreateResponse = true },
    rejectNextLink() { rejectLink = true },
    loseNextLinkResponse() { loseLinkResponse = true },
    placeChildOnBoard() { placeChildOnBoard = true },
    omitLinkOnReadback() { omitLinkOnReadback = true },
  }
}

async function runWithFixture(run) {
  const previousKey = process.env.YOUGILE_API_KEY
  const previousHost = process.env.YOUGILE_API_HOST_URL
  process.env.YOUGILE_API_KEY = 'fake-subtasks-test-key'
  delete process.env.YOUGILE_API_HOST_URL
  try {
    const api = fixture()
    const bridge = await loadYougileToolBridge({ allowLegacy: false, fetchImpl: api.fetchImpl })
    await run({ api, bridge })
  } finally {
    if (previousKey === undefined) delete process.env.YOUGILE_API_KEY
    else process.env.YOUGILE_API_KEY = previousKey
    if (previousHost === undefined) delete process.env.YOUGILE_API_HOST_URL
    else process.env.YOUGILE_API_HOST_URL = previousHost
  }
}

const argumentsA = { parentId: PARENT_ID, title: 'Child A', requestId: REQUEST_A }
const payload = result => JSON.parse(result.content[0].text)

test('create_subtask creates without column, preserves siblings and parent title/column', async () => {
  await runWithFixture(async ({ api, bridge }) => {
    const result = await bridge.call('yougile_create_subtask', argumentsA)
    const data = payload(result)
    assert.equal(result.isError, undefined)
    assert.equal(data.nestedOnly, true)
    assert.equal(api.tasks.get(data.childId).columnId, undefined)
    const parent = api.tasks.get(PARENT_ID)
    assert.deepEqual(parent.subtasks, [SIBLING_ID, data.childId])
    assert.equal(parent.columnId, 'in-progress-column')
    assert.equal(parent.title, 'Parent title must stay unchanged')
    const created = api.calls.find(call => call.method === 'POST')
    assert.deepEqual(Object.keys(created.body).sort(), ['idempotencyKey', 'title'])
    assert.deepEqual(api.calls.find(call => call.method === 'PUT').body, {
      subtasks: [SIBLING_ID, data.childId],
    })
    assert.equal(api.calls.some(call => call.body?.deleted !== undefined), false)
  })
})

test('create_subtask rejects columnId and undocumented parent linkage fields before network', async () => {
  await runWithFixture(async ({ api, bridge }) => {
    await assert.rejects(
      bridge.call('yougile_create_subtask', { ...argumentsA, columnId: 'in-progress-column' }),
      /Unrecognized key/,
    )
    await assert.rejects(
      bridge.call('yougile_create_subtask', { ...argumentsA, subtasks: [SIBLING_ID] }),
      /Unrecognized key/,
    )
    assert.equal(api.calls.length, 0)
  })
})

test('retry after lost create response uses the same child and links it once', async () => {
  await runWithFixture(async ({ api, bridge }) => {
    api.loseNextCreateResponse()
    const failed = await bridge.call('yougile_create_subtask', argumentsA)
    assert.equal(failed.isError, true)
    assert.equal(payload(failed).stage, 'create_child')
    assert.deepEqual(payload(failed).retry, argumentsA)

    const completed = payload(await bridge.call('yougile_create_subtask', argumentsA))
    const repeated = payload(await bridge.call('yougile_create_subtask', argumentsA))
    assert.equal(completed.success, true)
    assert.equal(repeated.childId, completed.childId)
    assert.equal(api.createdByKey.size, 1)
    assert.equal(api.tasks.get(PARENT_ID).subtasks.filter(id => id === completed.childId).length, 1)
  })
})

test('failed linking exposes created child ID, and retry does not create another child', async () => {
  await runWithFixture(async ({ api, bridge }) => {
    api.rejectNextLink()
    const failed = await bridge.call('yougile_create_subtask', argumentsA)
    const first = payload(failed)
    assert.equal(failed.isError, true)
    assert.equal(first.stage, 'link_child')
    assert.ok(first.childId)
    assert.equal(api.tasks.get(first.childId).columnId, undefined)
    assert.deepEqual(api.tasks.get(PARENT_ID).subtasks, [SIBLING_ID])

    const completed = payload(await bridge.call('yougile_create_subtask', argumentsA))
    assert.equal(completed.childId, first.childId)
    assert.equal(api.createdByKey.size, 1)
  })
})

test('retry after lost link response preserves the confirmed link without a second PUT', async () => {
  await runWithFixture(async ({ api, bridge }) => {
    api.loseNextLinkResponse()
    const failed = await bridge.call('yougile_create_subtask', argumentsA)
    assert.equal(failed.isError, true)
    const completed = payload(await bridge.call('yougile_create_subtask', argumentsA))
    assert.equal(completed.success, true)
    assert.equal(api.createdByKey.size, 1)
    assert.equal(api.calls.filter(call => call.method === 'PUT').length, 1)
  })
})

test('concurrent additions through shared bridge keep both children and existing siblings', async () => {
  await runWithFixture(async ({ api, bridge }) => {
    const results = await Promise.all([
      bridge.call('yougile_create_subtask', argumentsA),
      bridge.call('yougile_create_subtask', { parentId: PARENT_ID, title: 'Child B', requestId: REQUEST_B }),
    ])
    const children = results.map(result => payload(result).childId)
    assert.ok(results.every(result => payload(result).success))
    assert.deepEqual(api.tasks.get(PARENT_ID).subtasks, [SIBLING_ID, ...children])
  })
})

test('deleted parent and deleted idempotency child never trigger restoration or replacement', async () => {
  await runWithFixture(async ({ api, bridge }) => {
    api.tasks.get(PARENT_ID).deleted = true
    const deletedParent = await bridge.call('yougile_create_subtask', argumentsA)
    assert.equal(deletedParent.isError, true)
    assert.equal(api.calls.filter(call => call.method !== 'GET').length, 0)
    delete api.tasks.get(PARENT_ID).deleted

    const original = payload(await bridge.call('yougile_create_subtask', argumentsA))
    api.tasks.get(original.childId).deleted = true
    const deletedChild = await bridge.call('yougile_create_subtask', argumentsA)
    assert.equal(deletedChild.isError, true)
    assert.equal(payload(deletedChild).stage, 'read_child')
    assert.equal(api.createdByKey.size, 1)
    assert.equal(api.tasks.get(original.childId).deleted, true)
    assert.equal(api.calls.some(call => call.body?.deleted !== undefined), false)
  })
})

test('wrong requestId title, unexpected board placement and missing link cannot be reported as success', async () => {
  await runWithFixture(async ({ api, bridge }) => {
    const original = payload(await bridge.call('yougile_create_subtask', argumentsA))
    const conflict = await bridge.call('yougile_create_subtask', { ...argumentsA, title: 'Different' })
    assert.equal(conflict.isError, true)
    assert.equal(api.tasks.get(original.childId).title, 'Child A')

    api.placeChildOnBoard()
    const misplaced = await bridge.call('yougile_create_subtask', {
      parentId: PARENT_ID, title: 'Child B', requestId: REQUEST_B,
    })
    assert.equal(misplaced.isError, true)
    assert.equal(payload(misplaced).stage, 'read_child')
    assert.equal(api.tasks.get(PARENT_ID).subtasks.includes(payload(misplaced).childId), false)
  })
  await runWithFixture(async ({ api, bridge }) => {
    api.omitLinkOnReadback()
    const unlinked = await bridge.call('yougile_create_subtask', argumentsA)
    assert.equal(unlinked.isError, true)
    assert.equal(payload(unlinked).stage, 'verify_link')
  })
})
