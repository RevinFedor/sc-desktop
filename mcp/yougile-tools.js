const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
const { createYougileSubtaskCreator } = require('./yougile-subtasks')

const DEFAULT_SETTINGS_PATH = path.join(os.homedir(), '.config', 'sc', 'settings.json')
const LEGACY_CLAUDE_CONFIG_PATH = path.join(os.homedir(), '.claude.json')
const DEFAULT_YOUGILE_API_BASE_URL = 'https://yougile.com/api-v2/'
const DEFAULT_YOUGILE_DOWNLOAD_DIR = path.join(os.homedir(), '.cache', 'sc-desktop', 'yougile')
const MAX_YOUGILE_UPLOAD_BYTES = 50 * 1024 * 1024
const DEFAULT_MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024
const INLINE_IMAGE_LIMIT_BYTES = 5 * 1024 * 1024
const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return {}
  }
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function resolveYougileApiBaseUrl(options = {}) {
  const raw = nonEmptyString(options.apiBaseUrl)
    || nonEmptyString(process.env.YOUGILE_API_HOST_URL)
    || DEFAULT_YOUGILE_API_BASE_URL
  const parsed = new URL(raw)
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error('YOUGILE_API_HOST_URL must use http or https')
  }
  if (!parsed.pathname.endsWith('/')) parsed.pathname += '/'
  return parsed
}

function requireLocalFile(filePath) {
  if (!nonEmptyString(filePath)) throw new Error('filePath is required')
  if (!path.isAbsolute(filePath)) throw new Error('filePath must be an absolute path')
  const absolutePath = path.resolve(filePath)
  if (!fs.existsSync(absolutePath)) throw new Error(`File does not exist: ${absolutePath}`)
  const stat = fs.statSync(absolutePath)
  if (!stat.isFile()) throw new Error(`Path is not a file: ${absolutePath}`)
  if (stat.size > MAX_YOUGILE_UPLOAD_BYTES) {
    throw new Error(`File exceeds YouGile's 50 MiB upload limit: ${stat.size} bytes`)
  }
  return { absolutePath, stat }
}

async function readYougileResponse(response, action) {
  const raw = await response.text()
  let payload = null
  if (raw) {
    try {
      payload = JSON.parse(raw)
    } catch {
      payload = { raw }
    }
  }
  if (!response.ok) {
    const detail = payload?.error || payload?.message || raw || response.statusText
    throw new Error(`${action} failed (${response.status}): ${detail}`)
  }
  return payload || {}
}

async function uploadYougileFile(filePath, credential, options = {}) {
  const { absolutePath, stat } = requireLocalFile(filePath)
  const apiBaseUrl = resolveYougileApiBaseUrl(options)
  const form = new FormData()
  form.append('file', new Blob([fs.readFileSync(absolutePath)]), path.basename(absolutePath))

  const fetchImpl = options.fetchImpl || fetch
  const response = await fetchImpl(new URL('upload-file', apiBaseUrl), {
    method: 'POST',
    headers: { Authorization: `Bearer ${credential.key}` },
    body: form,
  })
  const payload = await readYougileResponse(response, 'YouGile file upload')
  const relativeUrl = nonEmptyString(payload.url) || nonEmptyString(payload.fileUrl)
  const fullUrl = nonEmptyString(payload.fullUrl)
    || (relativeUrl ? new URL(relativeUrl, apiBaseUrl.origin).href : null)
  if (!relativeUrl || !fullUrl) {
    throw new Error('YouGile file upload returned no file URL')
  }
  return {
    filePath: absolutePath,
    fileName: path.basename(absolutePath),
    size: stat.size,
    url: relativeUrl,
    fullUrl,
  }
}

async function sendYougileTaskFile({ taskId, filePath, caption }, credential, options = {}) {
  const resolvedTaskId = nonEmptyString(taskId)
  if (!resolvedTaskId) throw new Error('taskId is required')
  const uploaded = await uploadYougileFile(filePath, credential, options)
  const marker = `/root/#file:${uploaded.url}`
  const cleanCaption = nonEmptyString(caption)
  const text = cleanCaption ? `${cleanCaption}\n${marker}` : marker
  const apiBaseUrl = resolveYougileApiBaseUrl(options)
  const fetchImpl = options.fetchImpl || fetch
  const response = await fetchImpl(
    new URL(`chats/${encodeURIComponent(resolvedTaskId)}/messages`, apiBaseUrl),
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text, textHtml: '', label: '' }),
    },
  )
  const message = await readYougileResponse(response, 'YouGile task file message')
  return { uploaded, marker, messageId: message.id ?? null }
}

function resolveYougileFileUrl(value, options = {}) {
  let raw = nonEmptyString(value)
  if (!raw) throw new Error('fileUrl is required')
  const marker = '/root/#file:'
  const markerIndex = raw.indexOf(marker)
  if (markerIndex >= 0) raw = raw.slice(markerIndex + marker.length)
  raw = raw.trim().split(/\r?\n/, 1)[0].trim()
  try {
    // Chat messages double-encode non-ASCII filenames and an optional preview
    // query. Decode one transport layer; URL then safely re-encodes the path.
    raw = decodeURIComponent(raw)
  } catch {
    // Keep the original reference when it contains a malformed escape. URL
    // validation below still restricts downloads to YouGile /user-data/.
  }

  const apiBaseUrl = resolveYougileApiBaseUrl(options)
  const resolved = new URL(raw, `${apiBaseUrl.origin}/`)
  if (resolved.origin !== apiBaseUrl.origin || !resolved.pathname.startsWith('/user-data/')) {
    throw new Error(`Only YouGile /user-data/ URLs from ${apiBaseUrl.origin} can be downloaded`)
  }
  return resolved
}

function safeDownloadName(url) {
  let name = 'attachment'
  try {
    name = decodeURIComponent(path.posix.basename(url.pathname)) || name
  } catch {
    name = path.posix.basename(url.pathname) || name
  }
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
}

function inferContentType(fileName, responseType) {
  const declared = nonEmptyString(responseType)?.split(';', 1)[0].toLowerCase()
  if (declared && declared !== 'application/octet-stream') return declared
  const ext = path.extname(fileName).toLowerCase()
  return ({
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.zip': 'application/zip',
  })[ext] || declared || 'application/octet-stream'
}

async function downloadYougileFile({ fileUrl, destinationDir, maxBytes }, credential, options = {}) {
  const resolvedUrl = resolveYougileFileUrl(fileUrl, options)
  const limit = Number.isFinite(maxBytes) ? maxBytes : DEFAULT_MAX_DOWNLOAD_BYTES
  const requestedDir = nonEmptyString(destinationDir)
  if (requestedDir && !path.isAbsolute(requestedDir)) {
    throw new Error('destinationDir must be an absolute path')
  }

  const fileName = safeDownloadName(resolvedUrl)
  const urlHash = crypto.createHash('sha256').update(resolvedUrl.href).digest('hex').slice(0, 16)
  const targetDir = requestedDir
    ? path.resolve(requestedDir)
    : path.join(options.downloadDir || DEFAULT_YOUGILE_DOWNLOAD_DIR, urlHash)
  const targetPath = path.join(targetDir, fileName)
  if (fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) {
    const stat = fs.statSync(targetPath)
    return {
      filePath: targetPath,
      fileName,
      size: stat.size,
      contentType: inferContentType(fileName, null),
      sourceUrl: resolvedUrl.href,
      cached: true,
    }
  }

  const fetchImpl = options.fetchImpl || fetch
  const response = await fetchImpl(resolvedUrl, {
    headers: { Authorization: `Bearer ${credential.key}` },
  })
  if (!response.ok) {
    await readYougileResponse(response, 'YouGile file download')
  }
  const declaredSize = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredSize) && declaredSize > limit) {
    throw new Error(`YouGile file exceeds maxBytes (${declaredSize} > ${limit})`)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > limit) {
    throw new Error(`YouGile file exceeds maxBytes (${bytes.length} > ${limit})`)
  }
  fs.mkdirSync(targetDir, { recursive: true })
  fs.writeFileSync(targetPath, bytes, { flag: 'wx' })
  return {
    filePath: targetPath,
    fileName,
    size: bytes.length,
    contentType: inferContentType(fileName, response.headers.get('content-type')),
    sourceUrl: resolvedUrl.href,
    cached: false,
  }
}

function downloadResultContent(result) {
  const content = [{
    type: 'text',
    text: JSON.stringify(result, null, 2),
  }, {
    type: 'resource_link',
    uri: pathToFileURL(result.filePath).href,
    name: result.fileName,
    title: `YouGile attachment · ${result.fileName}`,
    mimeType: result.contentType,
    size: result.size,
  }]
  if (INLINE_IMAGE_TYPES.has(result.contentType) && result.size <= INLINE_IMAGE_LIMIT_BYTES) {
    content.push({
      type: 'image',
      data: fs.readFileSync(result.filePath).toString('base64'),
      mimeType: result.contentType,
    })
  }
  return content
}

function registerScYougileFileTools(adapter, z, options = {}) {
  adapter.tool(
    'yougile_upload_file',
    'Upload one local file to YouGile and return its /user-data/ URL without posting it to a task.',
    {
      filePath: z.string().describe('Absolute local path to a file, up to 50 MiB.'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async ({ filePath }, context) => {
      const uploaded = await uploadYougileFile(filePath, context.credential, options)
      return { content: [{ type: 'text', text: JSON.stringify(uploaded, null, 2) }] }
    },
  )

  adapter.tool(
    'yougile_send_task_file',
    'Upload one local image or file and attach it to a specific YouGile task chat in one operation.',
    {
      taskId: z.string().describe('Task UUID. The task chat ID is the same UUID.'),
      filePath: z.string().describe('Absolute local path to a file, up to 50 MiB.'),
      caption: z.string().optional().describe('Optional plain-text caption before the attachment.'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async (args, context) => {
      const result = await sendYougileTaskFile(args, context.credential, options)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  adapter.tool(
    'yougile_download_file',
    'Download one YouGile task-chat attachment from a /root/#file:/user-data/... marker or YouGile URL. Returns a local file resource and inlines supported small images.',
    {
      fileUrl: z.string().describe('Attachment marker, /user-data/ path, or full YouGile URL.'),
      destinationDir: z.string().optional().describe('Optional absolute destination directory. Defaults to the SC Desktop cache.'),
      maxBytes: z.number().int().positive().max(2 * 1024 * 1024 * 1024).default(DEFAULT_MAX_DOWNLOAD_BYTES)
        .describe('Safety cap for this download in bytes.'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async (args, context) => {
      const result = await downloadYougileFile(args, context.credential, options)
      return { content: downloadResultContent(result) }
    },
  )
}

function registerScYougileSubtaskTools(adapter, z, options = {}) {
  const createSubtask = createYougileSubtaskCreator()
  adapter.tool(
    'yougile_create_subtask',
    'Create a NEW subtask only inside a parent, like YouGile Create subtask. Never creates a board-column card. Preserves existing children. Use the same requestId when retrying a partial or uncertain result; never replace a deleted task with a new one automatically.',
    {
      parentId: z.string().uuid().describe('UUID of the existing parent task.'),
      title: z.string().min(1).refine(value => value.trim().length > 0, 'title must not be blank')
        .describe('Title of the new subtask.'),
      requestId: z.string().uuid().describe('Generate a UUID once per new subtask; reuse it with the same parentId and title for every retry.'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async (args, { credential }) => {
      const apiBaseUrl = resolveYougileApiBaseUrl(options)
      const scope = crypto.createHash('sha256').update(apiBaseUrl.href + credential.key).digest('hex')
      const request = async (method, resource, body) => {
        const fetchImpl = options.fetchImpl || fetch
        const response = await fetchImpl(new URL(resource, apiBaseUrl), {
          method,
          headers: {
            Authorization: `Bearer ${credential.key}`,
            'Content-Type': 'application/json',
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(30000),
        })
        return readYougileResponse(response, `YouGile ${method} ${resource}`)
      }
      const result = await createSubtask(args, { request, scope })
      return {
        ...(result.success ? {} : { isError: true }),
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      }
    },
    { strict: true },
  )
}

function resolveYougileApiKey(options = {}) {
  const envKey = nonEmptyString(process.env.YOUGILE_API_KEY)
  if (envKey) return { key: envKey, source: 'env' }

  const settingsPath = options.settingsPath || process.env.SC_SETTINGS_PATH || DEFAULT_SETTINGS_PATH
  const settings = readJson(settingsPath)
  const settingsKey = nonEmptyString(settings?.api_keys?.YOUGILE_API_KEY)
    || nonEmptyString(settings?.api?.yougile_api_key)
    || nonEmptyString(settings?.yougile?.api_key)
  if (settingsKey) return { key: settingsKey, source: 'settings' }

  // Transitional fallback: older installations kept the only copy of the key
  // in Claude's standalone YouGile MCP entry. It is intentionally last so the
  // shared SC settings become the canonical source after migration.
  if (options.allowLegacy !== false) {
    const legacyPath = options.legacyConfigPath || LEGACY_CLAUDE_CONFIG_PATH
    const legacy = readJson(legacyPath)
    const legacyKey = nonEmptyString(legacy?.mcpServers?.yougile?.env?.YOUGILE_API_KEY)
    if (legacyKey) return { key: legacyKey, source: 'legacy-claude-config' }
  }

  return { key: null, source: null }
}

async function loadYougileToolBridge(options = {}) {
  const packageJsonPath = require.resolve('@nebelov/yougile-mcp/package.json')
  const packageRoot = path.dirname(packageJsonPath)
  const packageRequire = createRequire(packageJsonPath)
  const { z } = packageRequire('zod')
  const { zodToJsonSchema } = packageRequire('zod-to-json-schema')
  const toolsModuleUrl = pathToFileURL(path.join(packageRoot, 'dist', 'tools', 'index.js')).href

  // The package normally owns an entire MCP process. Capture its public tool
  // registrations instead, so the same 57 schemas and handlers can live in the
  // already-running SC Desktop MCP process.
  const definitions = []
  const registrations = new Map()
  const adapter = {
    tool(name, description, inputShape, annotations, handler, registrationOptions = {}) {
      if (registrations.has(name)) throw new Error(`Duplicate YouGile tool: ${name}`)
      if (name === 'yougile_create_task') {
        description += ' For a NEW child only inside a parent, use yougile_create_subtask instead; linking a column card does not remove it from the board.'
      }
      if (name === 'yougile_update_task') {
        description += ' To detach an existing task from its column WITHOUT deleting the task, pass columnId="-" (not an empty string or null).'
        inputShape = {
          ...inputShape,
          columnId: inputShape.columnId.describe('Move to a column UUID, or "-" to remove only column placement without deleting the task.'),
        }
      }
      const objectSchema = z.object(inputShape || {})
      const schema = registrationOptions.strict ? objectSchema.strict() : objectSchema
      definitions.push({
        name,
        description,
        inputSchema: zodToJsonSchema(schema, {
          target: 'jsonSchema7',
          $refStrategy: 'none',
        }),
        annotations,
      })
      registrations.set(name, { schema, handler })
    },
  }

  const { registerAllTools } = await import(toolsModuleUrl)
  registerAllTools(adapter)
  registerScYougileFileTools(adapter, z, options)
  registerScYougileSubtaskTools(adapter, z, options)

  return {
    tools: definitions,
    has(name) {
      return registrations.has(name)
    },
    async call(name, args = {}) {
      const registration = registrations.get(name)
      if (!registration) throw new Error(`Unknown YouGile tool: ${name}`)

      const credential = resolveYougileApiKey(options)
      if (!credential.key) {
        throw new Error('YOUGILE_API_KEY not found in env or ~/.config/sc/settings.json')
      }
      // The upstream API helper reads this value at request time. Never return
      // or log it; source is exposed separately for diagnostics without value.
      process.env.YOUGILE_API_KEY = credential.key
      const parsed = await registration.schema.parseAsync(args || {})
      return await registration.handler(parsed, { credential })
    },
    credentialSource() {
      return resolveYougileApiKey(options).source
    },
  }
}

module.exports = {
  DEFAULT_SETTINGS_PATH,
  resolveYougileApiKey,
  resolveYougileFileUrl,
  loadYougileToolBridge,
}
