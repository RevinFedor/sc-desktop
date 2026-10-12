'use strict'
const { normalizeTelegramLiveRequest } = require('../electron/telegram-live')
const stringId = { oneOf: [{ type: 'string', pattern: '^[1-9][0-9]*$' }, { type: 'integer', minimum: 1 }] }
const messageId = { type: 'integer', minimum: 1, maximum: 2147483647 }
const sha = { type: 'string', pattern: '^[a-fA-F0-9]{64}$' }
const common = { session: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' },
  bot: { type: 'string', description: 'Exact @bot username or positive bot peer ID. No name/fuzzy/global-account fallback.' },
  expected_account_id: stringId, expected_peer_id: stringId,
  wait_ms: { type: 'integer', minimum: 0, maximum: 30000 } }
const required = ['session', 'bot', 'expected_account_id', 'expected_peer_id']
const reqId = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' }
const botOperations = { telegram_bot_info: 'bot_info', telegram_bot_messages: 'bot_messages',
  telegram_bot_action: 'bot_action', telegram_bot_action_status: 'bot_action_status',
  telegram_invite_info: 'membership_info', telegram_bot_join: 'bot_join', telegram_bot_join_status: 'bot_join_status' }
function tool(name, description, properties, requiredFields, readonly) {
  return { name, description, inputSchema: { type: 'object', properties: { ...common, ...properties },
    required: [...required, ...requiredFields], additionalProperties: false },
    annotations: { readOnlyHint: readonly, destructiveHint: false, idempotentHint: true, openWorldHint: true } }
}
const telegramBotTools = [
  { name: 'telegram_invite_info', description: 'Read-only exact-account public/invite group preview and current membership. Never imports/joins/pays. request_needed is NOT a submitted request/admin approval. Check actual title/identity/payment flag before a separately authorized telegram_join_chat; keep private invite URLs out of logs/docs/external AI.',
    inputSchema: { type: 'object', properties: { session: common.session,
      expected_account_id: stringId, target: { type: 'string' }, wait_ms: common.wait_ms },
      required: ['session', 'expected_account_id', 'target'], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
  tool('telegram_bot_info', 'Read exact bot-advertised commands/menu through SC Desktop, no Send/click/URL navigation. Fresh account/peer binding; commands are advertisements, not permission to execute them.', {}, [], true),
  tool('telegram_bot_messages', 'Read selected CURRENT incoming bot messages and bounded TL keyboard originals: label/kind/URL/base64 callback bytes/row/column/binding hash. Private invites must not enter public docs/logs/external AI. Continuations pin each message binding hash. Missing/hidden UI keyboard is not guessed.', {
    message_ids: { type: 'array', items: messageId, minItems: 1, maxItems: 100 },
    row_offset: { type: 'integer', minimum: 0, maximum: 10000 }, max_rows: { type: 'integer', minimum: 1, maximum: 100 },
    expected_binding_hashes: { type: 'object', additionalProperties: sha },
  }, ['message_ids'], true),
  tool('telegram_bot_action', 'ONE explicitly authorized read-groups bot command or exact bound button. No invented commands, payments/subscription/settings/logout/OM/2FA/WebView/contact/game actions. URL returns metadata, never opens it. Text uses existing durable random_id sender; callback uses durable at-most-once dispatch. Unknown callback is NEVER resent under this or a new key. ACK is not bot-side effect or membership proof.', {
    request_id: reqId, confirm: { type: 'boolean', const: true }, purpose: { type: 'string', const: 'read_groups' },
    action: { type: 'string', enum: ['command', 'button'] }, command: { type: 'string', pattern: '^/[a-z][a-z0-9_]{0,31}$' },
    command_source_message_id: messageId, expected_command_source_sha256: sha,
    message_id: messageId, row: { type: 'integer', minimum: 0 }, column: { type: 'integer', minimum: 0 },
    expected_binding_hash: sha, expected_action_label: { type: 'string', minLength: 1, maxLength: 1000 },
  }, ['request_id', 'confirm', 'purpose', 'action'], false),
  tool('telegram_bot_action_status', 'Read/reconcile ORIGINAL bot action receipt only. Never clicks/sends. Callback ACK/error/timeout is not verified side effect; unknown remains unknown without a fresh key or repeat.', { request_id: reqId }, ['request_id'], true),
  tool('telegram_bot_join', 'Join ONE positively identified ITKras GROUP from an exact current URL button of this bot; fresh title/account/message/markup binding. No arbitrary target URL, OM/channel/payment/callback/menu resend/admin approval. Durable at-most-once join, current membership read-back required; request_sent is NOT member and cannot fetch or enter ВУ. Existing member never rejoined. Unknown/pending same canonical invite fences new keys/aliases; use original status only.', {
    request_id: reqId, confirm: { type: 'boolean', const: true }, purpose: { type: 'string', const: 'join_itkras' },
    message_id: messageId, row: { type: 'integer', minimum: 0 }, column: { type: 'integer', minimum: 0 },
    expected_binding_hash: sha, expected_action_label: { type: 'string', minLength: 1, maxLength: 1000 },
    expected_chat_title: { type: 'string', minLength: 1, maxLength: 1000 },
  }, ['request_id','confirm','purpose','message_id','row','column','expected_binding_hash','expected_action_label','expected_chat_title'], false),
  tool('telegram_bot_join_status', 'GET-only ORIGINAL bound bot join/request receipt; never imports/joins/clicks or approves. Resolve unknown or pending only with fresh account/invite membership; request_needed is not submitted/admin-approved. Current confirmed membership permits normal SC source registration/fetch/folder operations.', { request_id: reqId }, ['request_id'], true),
]
async function callTelegramBotTool(name, args = {}, client) {
  const descriptor = telegramBotTools.find(t => t.name === name)
  if (!descriptor || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Unknown bot tool/request')
  if (Object.keys(args).some(key => !(key in descriptor.inputSchema.properties))) throw new Error('Unsupported bot parameter')
  for (const key of descriptor.inputSchema.required) if (args[key] == null) throw new Error(`${key} is required`)
  const request = normalizeTelegramLiveRequest({ ...args, operation: botOperations[name] })
  const out = await client.start(request, args.wait_ms ?? 15000)
  return { ...(out.ok === false || out.job?.status === 'error' || ['rejected','unknown','dispatching'].includes(out.result?.state) ? { isError: true } : {}),
    content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
}
module.exports = { telegramBotTools, botOperations, callTelegramBotTool }
