function resolveResearchAutoClose(options = {}, defaultAutoClose = false) {
  const input = options && typeof options === 'object' && !Array.isArray(options) ? options : {}
  if (typeof input.autoClose === 'boolean') return input.autoClose
  if (typeof input.keepTab === 'boolean') return !input.keepTab
  return defaultAutoClose === true
}

function withResearchAutoClose(options = {}, defaultAutoClose = false) {
  const input = options && typeof options === 'object' && !Array.isArray(options) ? options : {}
  return {
    ...input,
    autoClose: resolveResearchAutoClose(input, defaultAutoClose),
  }
}

module.exports = { resolveResearchAutoClose, withResearchAutoClose }
