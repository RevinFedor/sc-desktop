'use strict'

const MAX_PEER_ID = 9223372036854775807n
const MAX_MESSAGE_ID = 2147483647n

function positiveTlId(value, max) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) return null
  } else if (typeof value !== 'string') return null
  const text = String(value)
  if (text.length > String(max).length) return null
  if (!/^[1-9]\d*$/.test(text)) return null
  const integer = BigInt(text)
  return integer <= max ? text : null
}

function peerRef(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !['channel', 'chat', 'user'].includes(value.kind)) return null
  const id = positiveTlId(value.id, MAX_PEER_ID)
  return id ? { kind: value.kind, id } : null
}

/**
 * Select a complete forward peer/message pair. The original channel post and
 * a saved-dialog copy belong to different namespaces and must never be mixed.
 * A saved copy is a known message identity, not proof of the ultimate origin.
 */
function telegramForwardProvenance(forward) {
  if (!forward || typeof forward !== 'object' || Array.isArray(forward)) {
    return { key: null, basis: null }
  }
  const originalPeer = peerRef(forward.from_peer)
  const originalMessage = positiveTlId(forward.channel_post, MAX_MESSAGE_ID)
  if (originalPeer?.kind === 'channel' && originalMessage) {
    return { key: `channel:${originalPeer.id}:${originalMessage}`, basis: 'channel_post' }
  }
  const savedPeer = peerRef(forward.saved_from_peer)
  const savedMessage = positiveTlId(forward.saved_from_message_id, MAX_MESSAGE_ID)
  if (savedPeer && savedMessage) {
    return { key: `${savedPeer.kind}:${savedPeer.id}:${savedMessage}`, basis: 'saved_dialog_message' }
  }
  return { key: null, basis: null }
}

module.exports = { telegramForwardProvenance }
