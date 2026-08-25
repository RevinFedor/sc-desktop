function resolveTelegramProcessOutcome({
  cancelRequested = false,
  exitCode = null,
  protocolDone = false,
  protocolError = false,
  error = null,
  stderrTail = '',
} = {}) {
  if (cancelRequested) return { status: 'cancelled', error: null, errorCode: null }
  if (exitCode !== 0) {
    return {
      status: 'error',
      error: error || `python exited ${exitCode}: ${String(stderrTail).slice(-200)}`,
      errorCode: null,
    }
  }
  if (protocolError || error) {
    return { status: 'error', error: error || 'Telegram worker reported an error', errorCode: null }
  }
  if (!protocolDone) {
    return {
      status: 'error',
      error: 'Telegram worker exited without a done event',
      errorCode: 'protocol_incomplete',
    }
  }
  return { status: 'done', error: null, errorCode: null }
}

module.exports = { resolveTelegramProcessOutcome }
