// This process owns only bounded, local attachment I/O. It never starts a
// model or reads application settings. Blocking filesystem access must not
// freeze Electron main, its HTTP server or another session's browser job.
const fs = require('node:fs')
const { normalizeResearchAttachments, materializeResearchAttachments } = require('./research-attachments')

function send(message, callback) {
  if (process.connected) process.send(message, callback || (() => {}))
}
for (const method of ['statSync', 'openSync', 'readFileSync', 'copyFileSync', 'writeFileSync', 'mkdirSync']) {
  const original = fs[method]
  fs[method] = function (...args) {
    if (typeof args[0] === 'string') send({ type: 'progress', operation: method, path: args[0] })
    return original.apply(this, args)
  }
}

process.once('message', input => {
  try {
    const attachments = normalizeResearchAttachments(input.specs)
    if (attachments.some(attachment => attachment.kind !== 'image') && input.mode !== 'chat') {
      throw new Error('document attachments are currently supported only in Chat mode; Work image uploads remain supported')
    }
    const prepared = materializeResearchAttachments({ libRoot: input.libRoot, id: input.id, attachments })
    send({ type: 'done', attachments: prepared }, () => process.disconnect())
  } catch (error) {
    send({ type: 'error', error: String(error.message || error), code: error.code || 'attachment_validation_failed' }, () => process.disconnect())
  }
})
