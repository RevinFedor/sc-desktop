const session = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$', description: 'Exact session file name, e.g. session_4531193. Required; no active account or fuzzy alias fallback.' }
const target = { type: 'string', description: 'Exactly one @username, t.me/username, or signed Telegram peer ID. Positive=user, negative=basic group, -100…=channel/supergroup. Display names, message/invite links and lists are rejected.' }
const requestId = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$', description: 'Stable ID for this one intended message. Reuse unchanged after a timeout. Never invent a new key to retry an unknown delivery.' }
const expectedId = { oneOf: [{ type: 'string', pattern: '^-?[1-9][0-9]*$' }, { type: 'integer' }] }
const toolOperations = {
  telegram_resolve_recipient: 'resolve',
  telegram_send_text: 'send',
  telegram_send_text_status: 'status',
}

const telegramTextTools = [
  {
    name: 'telegram_resolve_recipient',
    description: 'Read-only preflight for one Telegram text message. Verifies the exact session account and resolves one unambiguous peer without sending or joining. Check returned account.id and recipient.peer_id against the user-authorized recipient before telegram_send_text.',
    inputSchema: { type: 'object', properties: { session, target }, required: ['session', 'target'], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'telegram_send_text',
    description:
      'Send at most ONE plain-text Telegram message to ONE explicitly authorized peer. ' +
      'First use telegram_resolve_recipient; pass its verified account/peer IDs and confirm:true. ' +
      'No recipients lists, broadcast, attachments, auto-join, scheduling, splitting or automatic send retries. ' +
      'Owner writing preference: be brief, write your own prose in lowercase, no long dashes, one message, never spam several replies. ' +
      'Preserve case-sensitive URLs/IDs and quoted text; the tool sends text unchanged. ' +
      'For a reply pass reply_to_message_id; forum replies also require topic_id. Parent and topic are verified before send and on read-back. ' +
      'request_id is durable: same exact payload returns its receipt; changed payload is rejected. ' +
      'Unknown ACK must be checked with telegram_send_text_status using the ORIGINAL ID, never retried with a new key. ' +
      'Only delivered:true with Telegram message_id and verified_at proves Telegram read-back; in_progress/unknown is not delivered. ' +
      'FloodWait and write restrictions are returned without retries or bypasses.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: requestId, session, target,
        expected_account_id: { ...expectedId, description: 'Verified account.id from the preflight; stops if the session account changed.' },
        expected_peer_id: { ...expectedId, description: 'Verified signed recipient.peer_id; stops if the username resolves to another peer.' },
        text: { type: 'string', minLength: 1, maxLength: 4096, description: 'Exact plain text. No case normalization, Markdown parsing or splitting. Also checked against live Telegram limit.' },
        confirm: { type: 'boolean', const: true, description: 'Explicitly confirm this user-authorized single message.' },
        reply_to_message_id: { type: 'integer', minimum: 1, maximum: 2147483647, description: 'Exact existing message in the confirmed peer to reply to.' },
        topic_id: { type: 'integer', minimum: 1, maximum: 2147483647, description: 'Exact forum topic root message ID. Requires reply_to_message_id.' },
      },
      required: ['request_id', 'session', 'target', 'expected_account_id', 'expected_peer_id', 'text', 'confirm'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'telegram_send_text_status',
    description: 'Read/reconcile the durable receipt for the original request_id. NEVER sends a message. Known Telegram message IDs are verified with read-back. Missing ACK produces unknown with possible history candidate IDs, not permission to resend. A delivered receipt survives MCP/app restarts.',
    inputSchema: { type: 'object', properties: { request_id: requestId }, required: ['request_id'], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
]

function normalizeTelegramTextArgs(name, args = {}) {
  const tool = telegramTextTools.find(t => t.name === name)
  if (!tool) throw new Error('Unknown Telegram text tool')
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Expected one object')
  const fields = tool.inputSchema.properties
  if (Object.keys(args).some(key => !(key in fields))) throw new Error('Unsupported parameter. This tool sends one plain text to one peer only.')
  for (const key of tool.inputSchema.required) {
    if (args[key] == null) throw new Error(`${key} is required`)
  }
  for (const key of ['session', 'request_id']) {
    if (fields[key] && (typeof args[key] !== 'string' || !new RegExp(fields[key].pattern).test(args[key]))) throw new Error(`Invalid ${key}`)
  }
  if (fields.target && (typeof args.target !== 'string' || !args.target.trim())) throw new Error('One exact target is required')
  if (name === 'telegram_send_text') {
    if (args.confirm !== true) throw new Error('confirm:true is required')
    if (typeof args.text !== 'string' || !args.text.trim() || [...args.text].length > 4096) throw new Error('One nonempty text, maximum 4096 Unicode characters; no splitting')
    for (const key of ['expected_account_id', 'expected_peer_id']) {
      if ((typeof args[key] !== 'string' && !Number.isSafeInteger(args[key])) || !/^-?[1-9][0-9]*$/.test(String(args[key]))) throw new Error(`Invalid ${key}`)
    }
    for (const key of ['reply_to_message_id', 'topic_id']) {
      if (key in args && (!Number.isInteger(args[key]) || args[key] < 1 || args[key] > 2147483647)) throw new Error(`Invalid ${key}`)
    }
    if ('topic_id' in args && !('reply_to_message_id' in args)) throw new Error('topic_id requires reply_to_message_id')
  }
  return { ...args, operation: toolOperations[name] }
}

async function callTelegramTextTool(name, args, runCommand) {
  const request = normalizeTelegramTextArgs(name, args)
  const result = await runCommand(request)
  return {
    ...(result.ok === false && result.state !== 'in_progress' && result.state !== 'prepared' ? { isError: true } : {}),
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  }
}

module.exports = { telegramTextTools, toolOperations, normalizeTelegramTextArgs, callTelegramTextTool }
