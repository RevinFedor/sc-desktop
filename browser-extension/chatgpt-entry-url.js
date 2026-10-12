(function exposeScChatgptEntryUrl(root) {
  function scChatgptComposeEntryUrl(requestId, mode, temporaryChat = true) {
    if (!requestId) throw new Error('compose request id required');
    const u = new URL('https://chatgpt.com/');
    if (String(mode || '').trim().toLowerCase() !== 'work' && temporaryChat !== false) {
      u.searchParams.set('temporary-chat', 'true');
    }
    u.searchParams.set('sc-compose', requestId);
    u.hash = 'sc-compose=' + encodeURIComponent(requestId);
    return u.toString();
  }

  root.scChatgptComposeEntryUrl = scChatgptComposeEntryUrl;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { scChatgptComposeEntryUrl };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
