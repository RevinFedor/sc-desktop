'use strict'

// Clipboard belongs to the person using the Mac, not to background callers.
// Apply this per operation: an MCP job must not suppress a concurrent UI Copy.
function shouldAutoCopy(params = {}, env = process.env) {
  const origin = String(params?.origin || '').trim().toLowerCase()
  return env.SC_DESKTOP_MCP !== '1'
    && origin !== 'mcp'
    && params?.autoCopy !== false
    // Before origin was passed to the runner, only MCP imports set this flag.
    && params?.silentAutoCopy !== true
}

function mcpJobParams(params = {}) {
  // Machine-only API routes own provenance; caller options cannot enable copy.
  return { ...params, origin: 'mcp', autoCopy: false }
}

module.exports = { shouldAutoCopy, mcpJobParams }
