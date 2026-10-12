// Saved Messages is deliberately the only destination. Keep album delivery
// explicit while preserving the legacy text -> individual images -> files flow.
const telegramSendSavedMessageTool = {
  name: 'telegram_send_saved_message',
  description:
    'Send text and/or local attachments ONLY to Telegram Saved Messages / Избранное. ' +
    'For an album use album:{paths,mode,caption}; mode is required: photo means ' +
    'Telegram photos (compression/resizing allowed), document means original files ' +
    'without re-encoding. More than 10 files are split into ordered groups of 2–10; ' +
    'the full caption is placed on the first file of EACH group. The account caption ' +
    'limit is checked before any send; overlong captions are rejected, never cut. ' +
    'Legacy images/files are still sent individually; text is a separate first message. ' +
    'Returns message_id, grouped_id, caption, name and bytes per attachment. ' +
    'On a partial/unknown delivery inspect Saved Messages before retrying; do not resend blindly.',
  inputSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string', maxLength: 4096,
        description: 'Plain text, sent as a separate message before attachments. No Markdown/HTML parsing.',
      },
      images: {
        type: 'array', maxItems: 50, items: { type: 'string' },
        description: 'Legacy: local images sent individually as compressed Telegram photos.',
      },
      files: {
        type: 'array', maxItems: 50, items: { type: 'string' },
        description: 'Legacy: local files sent individually as original documents.',
      },
      album: {
        type: 'object',
        properties: {
          paths: { type: 'array', minItems: 2, maxItems: 50, items: { type: 'string', minLength: 1 } },
          mode: { type: 'string', enum: ['photo', 'document'] },
          caption: {
            type: 'string',
            description: 'Exact plain-text caption on the first file of each group. Account-specific limit; no truncation.',
          },
        },
        required: ['paths', 'mode'],
        additionalProperties: false,
        description: 'Ordered album; cannot be combined with legacy images/files. Use two calls for two distinct captions.',
      },
      session: { type: 'string', description: 'Telegram session name or account alias, e.g. session_4531193 or F9922.' },
      profile: { type: 'string', description: 'Alias for session.' },
      silent: { type: 'boolean', default: false, description: 'Send without notification.' },
    },
    anyOf: [{ required: ['text'] }, { required: ['images'] }, { required: ['files'] }, { required: ['album'] }],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}

function normalizeSavedMessageInput(args = {}) {
  const allowed = new Set(Object.keys(telegramSendSavedMessageTool.inputSchema.properties))
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) throw new Error(`Unsupported parameter: ${key}. Only Saved Messages is supported.`)
  }
  const text = String(args.text == null ? '' : args.text)
  const images = Array.isArray(args.images) ? args.images.map(v => String(v || '').trim()).filter(Boolean) : []
  const files = Array.isArray(args.files) ? args.files.map(v => String(v || '').trim()).filter(Boolean) : []
  const textToSend = text.trim() ? text : ''
  if ([...textToSend].length > 4096) throw new Error('Telegram message is too long: maximum is 4096 characters')
  if (images.length > 50) throw new Error('Too many images: maximum is 50')
  if (files.length > 50) throw new Error('Too many files: maximum is 50')

  let album = null
  if (args.album != null) {
    const a = args.album
    if (!a || typeof a !== 'object' || Array.isArray(a)) throw new Error('album must be an object')
    if (Object.keys(a).some(key => !['paths', 'mode', 'caption'].includes(key))) throw new Error('Unknown album parameter')
    if (!['photo', 'document'].includes(a.mode)) throw new Error('album.mode must explicitly be photo or document')
    if (!Array.isArray(a.paths) || a.paths.length < 2 || a.paths.length > 50) throw new Error('album.paths must contain 2–50 files')
    if (a.paths.some(p => typeof p !== 'string' || !p.trim())) throw new Error('Every album path must be a nonempty local file path')
    if (images.length || files.length) throw new Error('album cannot be combined with images/files; use separate calls')
    if (a.caption != null && typeof a.caption !== 'string') throw new Error('album.caption must be plain text')
    album = { paths: [...a.paths], mode: a.mode, caption: a.caption ?? '' }
  }
  if (!textToSend && !images.length && !files.length && !album) throw new Error('text, images, files, or album are required')
  return { text: textToSend, images, files, album, silent: args.silent === true }
}

module.exports = { telegramSendSavedMessageTool, normalizeSavedMessageInput }
