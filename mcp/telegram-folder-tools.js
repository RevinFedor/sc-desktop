'use strict'
const { normalizeTelegramLiveRequest } = require('../electron/telegram-live')
const identity = {
  session: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' },
  expected_account_id: { type: 'string', pattern: '^[1-9][0-9]*$' },
  title: { type: 'string', const: 'ВУ', description: 'Exact CYRILLIC U+0412,U+0423; not a list index.' },
  wait_ms: { type: 'integer', minimum: 0, maximum: 30000 },
}
const chats = { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object',
  properties: { chat_id: { type: 'string', pattern: '^-?[1-9][0-9]*$' },
    expected_title: { type: 'string', minLength: 1, maxLength: 256 } },
  required: ['chat_id', 'expected_title'], additionalProperties: false } }
const requestId = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' }
function tool(name, description, properties, required, readOnly) {
  return { name, description, inputSchema: { type: 'object', properties: { ...identity, ...properties },
    required: ['session', 'expected_account_id', 'title', ...required], additionalProperties: false },
    annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: true, openWorldHint: true } }
}
const telegramFolderTools = [
  tool('telegram_folder_read', 'Fresh account + full upstream Telegram DialogFilters, exact ВУ matches and snapshot SHA. Optional chats are verified by current complete metadata dialog inventory/actual TL entity, not guessed -100 IDs. Deadline is unknown inventory, never absence. Does not create/edit/move/join. Local SC folder_state is a separate materialized projection.', { chats }, [], true),
  tool('telegram_folder_merge', 'Explicit ITKras confirmed-member union into exact ВУ (create if absent). Preserve pinned/excluded peers, flags/title/entities/color, other folders and their order. No removal from other folders. Existing exclusion conflict/stale snapshot/pending membership rejects before write. Durable at-most-once UpdateDialogFilter; lost ACK is GET-only original receipt, never new-key overwrite. After verified upstream read-back explicitly call telegram_refresh_folders for SAME session and verify folder_state; API ACK alone is not success.', {
    chats, request_id: requestId, expected_snapshot_hash: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
    confirm: { type: 'boolean', const: true }, purpose: { type: 'string', const: 'itkras_vu' },
  }, ['chats', 'request_id', 'expected_snapshot_hash', 'confirm', 'purpose'], false),
  tool('telegram_folder_merge_status', 'Read ORIGINAL account/session folder receipt. Unknown dispatch reconciles only through fresh GetDialogFilters, never repeats RPC or guesses admin approval. Verified ID/count means upstream read-back; SC refresh/materialized acceptance remains a separate explicit step.', { request_id: requestId }, ['request_id'], true),
]
async function callTelegramFolderTool(name, args = {}, client) {
  const descriptor = telegramFolderTools.find(t => t.name === name)
  if (!descriptor || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Unknown folder tool/request')
  if (Object.keys(args).some(key => !(key in descriptor.inputSchema.properties))) throw new Error('Unsupported folder parameter')
  for (const key of descriptor.inputSchema.required) if (args[key] == null) throw new Error(`${key} is required`)
  const request = normalizeTelegramLiveRequest({ ...args, operation: name.replace('telegram_', '') })
  const out = await client.start(request, args.wait_ms ?? 15000)
  return { ...(out.ok === false || out.job?.status === 'error' || ['rejected','unknown'].includes(out.result?.state) ? { isError: true } : {}),
    content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
}
module.exports = { telegramFolderTools, callTelegramFolderTool }
