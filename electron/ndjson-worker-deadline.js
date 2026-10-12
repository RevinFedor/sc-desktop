'use strict'

function ndjsonWorkerDeadline(child, { timeoutMs, graceMs = 1500, onTimeout = () => {} } = {}) {
  let expired = false, timer = null, escalation = null
  function clear() { clearTimeout(timer); clearTimeout(escalation) }
  if (timeoutMs > 0) timer = setTimeout(() => {
    expired = true
    onTimeout()
    child.kill('SIGTERM')
    escalation = setTimeout(() => { if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL') }, graceMs)
    escalation.unref?.()
  }, timeoutMs)
  child.once('close', clear)
  child.once('error', clear)
  return { expired: () => expired, clear }
}

module.exports = { ndjsonWorkerDeadline }
