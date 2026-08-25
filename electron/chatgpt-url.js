function chatgptMode(value) {
  return String(value || '').trim().toLowerCase() === 'work' ? 'work' : 'chat'
}

function appendResearchId(rawUrl, id) {
  const u = new URL(rawUrl)
  u.searchParams.set('sc-research', id)
  u.hash = 'sc-research=' + encodeURIComponent(id)
  return u.toString()
}

function normalizeChatgptConversationUrl(raw) {
  const s = String(raw || '').trim()
  if (!s) return ''
  const u = new URL(s)
  if (u.origin !== 'https://chatgpt.com') throw new Error('conversationUrl must be on https://chatgpt.com')
  if (!/^\/c\/[\w-]+\/?$/.test(u.pathname)) throw new Error('conversationUrl must look like https://chatgpt.com/c/<conversation-id>')
  u.hash = ''
  u.searchParams.delete('sc-research')
  return u.toString()
}

function chatgptResearchEntryUrl({ id, mode, conversationUrl = '' }) {
  if (!id) throw new Error('research id required')
  if (conversationUrl) {
    return appendResearchId(normalizeChatgptConversationUrl(conversationUrl), id)
  }
  const u = new URL('https://chatgpt.com/')
  if (chatgptMode(mode) === 'chat') u.searchParams.set('temporary-chat', 'true')
  u.searchParams.set('sc-research', id)
  u.hash = 'sc-research=' + encodeURIComponent(id)
  return u.toString()
}

module.exports = {
  appendResearchId,
  normalizeChatgptConversationUrl,
  chatgptResearchEntryUrl,
}
