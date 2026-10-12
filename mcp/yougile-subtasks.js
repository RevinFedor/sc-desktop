const crypto = require('node:crypto')

function assertActiveTask(task, id) {
  if (!task || task.id !== id) throw new Error(`YouGile returned no matching task: ${id}`)
  if (task.deleted) throw new Error(`Task is deleted; it will not be restored: ${id}`)
}

function assertNestedChild(task, id, title) {
  assertActiveTask(task, id)
  if (task.columnId != null) {
    throw new Error('Child has a columnId; refusing to treat a board card as a nested-only subtask')
  }
  if (task.title !== title) {
    throw new Error('requestId already belongs to a child with a different title; refusing to rename it')
  }
}

function subtaskIds(task) {
  if (task.subtasks == null) return []
  if (!Array.isArray(task.subtasks) || task.subtasks.some(id => typeof id !== 'string')) {
    throw new Error('Parent subtasks is not an array of task IDs')
  }
  return task.subtasks
}

// One shared MCP process serializes its own additions to the same parent.
// YouGile's documented PUT has no compare-and-swap/append operation, so this
// does not claim to lock independent writers in the web UI or other clients.
function createYougileSubtaskCreator() {
  const parentQueues = new Map()

  return async function createSubtask({ parentId, title, requestId }, { request, scope }) {
    const queueKey = `${scope}:${parentId}`
    const previous = parentQueues.get(queueKey) || Promise.resolve()
    let release
    const current = new Promise(resolve => { release = resolve })
    parentQueues.set(queueKey, current)
    await previous

    let stage = 'read_parent'
    let childId = null
    const idempotencyKey = 'sc-subtask:' + crypto.createHash('sha256')
      .update(JSON.stringify({ parentId, requestId })).digest('hex')
    const taskPath = id => `tasks/${encodeURIComponent(id)}`
    try {
      const parent = await request('GET', taskPath(parentId))
      assertActiveTask(parent, parentId)
      subtaskIds(parent)

      stage = 'create_child'
      // Omitting columnId is essential: giving the parent's column would
      // create a separate board card, even after linking parent.subtasks.
      const created = await request('POST', 'tasks', { title, idempotencyKey })
      childId = typeof created?.id === 'string' && created.id ? created.id : null
      if (!childId || childId === parentId) throw new Error('Create task returned no valid child ID')

      stage = 'read_child'
      assertNestedChild(await request('GET', taskPath(childId)), childId, title)

      stage = 'read_parent_latest'
      const latestParent = await request('GET', taskPath(parentId))
      assertActiveTask(latestParent, parentId)
      const existing = subtaskIds(latestParent)
      const merged = [...new Set([...existing, childId])]
      if (!existing.includes(childId)) {
        stage = 'link_child'
        await request('PUT', taskPath(parentId), { subtasks: merged })
      }

      stage = 'verify_link'
      const verifiedParent = await request('GET', taskPath(parentId))
      assertActiveTask(verifiedParent, parentId)
      const actual = subtaskIds(verifiedParent)
      if (actual.filter(id => id === childId).length !== 1
          || merged.some(id => !actual.includes(id))) {
        throw new Error('Parent read-back did not preserve all children or confirm exactly one new link')
      }
      if (verifiedParent.columnId !== latestParent.columnId
          || verifiedParent.title !== latestParent.title) {
        throw new Error('Parent changed concurrently; verify its current state before proceeding')
      }

      stage = 'verify_child'
      const verifiedChild = await request('GET', taskPath(childId))
      assertNestedChild(verifiedChild, childId, title)
      return {
        success: true,
        parentId,
        childId,
        requestId,
        nestedOnly: true,
        subtask: {
          id: childId,
          title: verifiedChild.title,
          idTaskProject: verifiedChild.idTaskProject ?? null,
        },
      }
    } catch (error) {
      // Never compensate by deleting, moving or restoring user objects.
      // The same requestId replays POST idempotently and resumes linking.
      return {
        success: false,
        parentId,
        childId,
        requestId,
        stage,
        error: String(error.message || error),
        retry: { parentId, title, requestId },
      }
    } finally {
      release()
      if (parentQueues.get(queueKey) === current) parentQueues.delete(queueKey)
    }
  }
}

module.exports = { createYougileSubtaskCreator }
