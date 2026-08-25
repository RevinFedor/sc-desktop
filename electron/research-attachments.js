const fs = require('node:fs')
const path = require('node:path')

const MAX_ATTACHMENT_COUNT = 20
const MAX_ATTACHMENT_SPECS = 200
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
const MAX_TOTAL_ATTACHMENT_BYTES = 100 * 1024 * 1024
const MAX_BUNDLE_BYTES = 20 * 1024 * 1024

const MIME_BY_EXT = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.ts': 'text/plain',
  '.tsx': 'text/plain',
  '.jsx': 'text/javascript',
  '.py': 'text/x-python',
  '.rb': 'text/plain',
  '.go': 'text/plain',
  '.rs': 'text/plain',
  '.java': 'text/plain',
  '.kt': 'text/plain',
  '.swift': 'text/plain',
  '.c': 'text/plain',
  '.cc': 'text/plain',
  '.cpp': 'text/plain',
  '.h': 'text/plain',
  '.hpp': 'text/plain',
  '.sh': 'text/x-shellscript',
  '.zsh': 'text/x-shellscript',
  '.sql': 'application/sql',
  '.toml': 'application/toml',
  '.log': 'text/plain',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
})

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.yaml', '.yml',
  '.xml', '.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.cc', '.cpp', '.h',
  '.hpp', '.sh', '.zsh', '.sql', '.toml', '.log',
])

function fileMime(filePath) {
  return MIME_BY_EXT[path.extname(filePath || '').toLowerCase()] || 'application/octet-stream'
}

function safeFileName(name, fallback = 'attachment') {
  const base = path.basename(String(name || fallback))
    .replace(/[^\w.\-]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return base || fallback
}

function positiveLine(value, label) {
  if (value == null || value === '') return null
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) throw new Error(`${label} must be a positive integer`)
  return n
}

function lineRangeFromSpec(spec) {
  let start = spec && typeof spec === 'object'
    ? (spec.startLine ?? spec.start_line ?? spec.fromLine ?? spec.from_line)
    : null
  let end = spec && typeof spec === 'object'
    ? (spec.endLine ?? spec.end_line ?? spec.toLine ?? spec.to_line)
    : null
  const compact = spec && typeof spec === 'object' ? (spec.lines ?? spec.lineRange ?? spec.line_range) : null
  if (typeof compact === 'string' && compact.trim()) {
    const match = compact.trim().match(/^(\d+)(?:\s*(?:-|\.\.)\s*(\d+))?$/)
    if (!match) throw new Error(`lines must look like "10-30", got: ${compact}`)
    start = start ?? match[1]
    end = end ?? (match[2] || match[1])
  }
  start = positiveLine(start, 'startLine')
  end = positiveLine(end, 'endLine')
  if (start == null && end == null) return null
  if (start == null) start = 1
  if (end != null && end < start) throw new Error(`endLine (${end}) must be >= startLine (${start})`)
  return { start, end }
}

function isTextAttachment(filePath, mime) {
  return String(mime || '').startsWith('text/')
    || ['application/json', 'application/x-ndjson', 'application/yaml', 'application/xml', 'application/sql', 'application/toml'].includes(mime)
    || TEXT_EXTENSIONS.has(path.extname(filePath || '').toLowerCase())
}

function decodeUtf8(buffer, filePath) {
  if (buffer.includes(0)) throw new Error(`line ranges require a text file: ${filePath}`)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    throw new Error(`line ranges require valid UTF-8 text: ${filePath}`)
  }
}

function selectedText(attachment) {
  const buffer = fs.readFileSync(attachment.path)
  const text = decodeUtf8(buffer, attachment.path)
  if (!attachment.line_range) return text
  const lines = text.split(/\r?\n/)
  const start = attachment.line_range.start
  const end = attachment.line_range.end == null ? lines.length : Math.min(attachment.line_range.end, lines.length)
  if (start > lines.length) {
    throw new Error(`startLine ${start} exceeds ${lines.length} lines: ${attachment.path}`)
  }
  const value = lines.slice(start - 1, end).join('\n')
  return {
    value,
    sourceLineCount: lines.length,
    actualEnd: end,
  }
}

function normalizeResearchAttachments(raw) {
  const specs = Array.isArray(raw) ? raw : []
  if (specs.length > MAX_ATTACHMENT_SPECS) {
    throw new Error(`too many attachment paths (${specs.length}); maximum input list is ${MAX_ATTACHMENT_SPECS}`)
  }
  const out = []
  let totalBytes = 0
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]
    const filePath = typeof spec === 'string'
      ? spec
      : (typeof spec?.path === 'string' ? spec.path
        : (typeof spec?.file_path === 'string' ? spec.file_path : ''))
    if (!filePath) throw new Error(`attachment ${i + 1} is missing path`)
    if (!path.isAbsolute(filePath)) throw new Error(`attachment path must be absolute: ${filePath}`)
    const abs = path.resolve(filePath)
    const st = fs.statSync(abs)
    if (!st.isFile()) throw new Error(`attachment is not a file: ${abs}`)
    if (st.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`attachment too large (${st.size} bytes; bridge limit ${MAX_ATTACHMENT_BYTES}): ${abs}`)
    }
    totalBytes += st.size
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new Error(`attachments exceed bridge total limit (${MAX_TOTAL_ATTACHMENT_BYTES} bytes)`)
    }
    const mime = typeof spec?.mime === 'string' && spec.mime.trim() ? spec.mime.trim() : fileMime(abs)
    const lineRange = lineRangeFromSpec(spec)
    if (lineRange && !isTextAttachment(abs, mime)) {
      throw new Error(`line ranges require a supported text file: ${abs}`)
    }
    out.push({
      index: out.length,
      path: abs,
      name: safeFileName(spec?.name || path.basename(abs), `attachment-${i + 1}${path.extname(abs)}`),
      mime,
      size: st.size,
      kind: mime.startsWith('image/') ? 'image' : 'file',
      line_range: lineRange,
    })
  }
  return out
}

function rangeName(name, range) {
  if (!range) return name
  const ext = path.extname(name)
  const stem = path.basename(name, ext)
  return `${stem}.L${range.start}-L${range.end == null ? 'end' : range.end}${ext || '.txt'}`
}

function materializeOne(dir, attachment, position) {
  const requestedName = rangeName(attachment.name, attachment.line_range)
  const ext = path.extname(requestedName) || (attachment.line_range ? '.txt' : '')
  const stem = safeFileName(path.basename(requestedName, ext), `input-${position + 1}`)
  const name = `${String(position + 1).padStart(2, '0')}-${stem}${ext}`
  const dest = path.join(dir, name)
  let sourceLineCount = null
  let actualEnd = attachment.line_range?.end ?? null
  if (attachment.line_range) {
    const selection = selectedText(attachment)
    fs.writeFileSync(dest, selection.value, 'utf8')
    sourceLineCount = selection.sourceLineCount
    actualEnd = selection.actualEnd
  } else {
    fs.copyFileSync(attachment.path, dest)
  }
  const st = fs.statSync(dest)
  if (st.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`materialized attachment too large (${st.size} bytes): ${attachment.path}`)
  }
  return {
    ...attachment,
    original_path: attachment.path,
    path: dest,
    name,
    size: st.size,
    line_start: attachment.line_range?.start ?? null,
    line_end: attachment.line_range ? actualEnd : null,
    source_line_count: sourceLineCount,
    artifact_role: 'input',
  }
}

function materializeBundle(dir, attachments) {
  if (!attachments.every(attachment => isTextAttachment(attachment.path, attachment.mime))) {
    throw new Error(`ChatGPT accepts at most ${MAX_ATTACHMENT_COUNT} files per message; more than ${MAX_ATTACHMENT_COUNT} can be auto-bundled only when every file is text`)
  }
  const chunks = []
  for (let i = 0; i < attachments.length; i++) {
    const attachment = attachments[i]
    const selection = selectedText(attachment)
    const value = typeof selection === 'string' ? selection : selection.value
    const range = attachment.line_range
      ? ` · lines ${attachment.line_range.start}-${selection.actualEnd}`
      : ''
    chunks.push(`===== FILE ${i + 1}/${attachments.length}: ${attachment.name}${range} =====\n${value}`)
  }
  const text = chunks.join('\n\n') + '\n'
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_BUNDLE_BYTES) {
    throw new Error(`auto-bundled attachments are too large (${bytes} bytes; limit ${MAX_BUNDLE_BYTES}); pass narrower line ranges`)
  }
  const name = `01-sc-file-bundle-${attachments.length}.txt`
  const dest = path.join(dir, name)
  fs.writeFileSync(dest, text, 'utf8')
  return [{
    index: 0,
    path: dest,
    original_path: null,
    name,
    mime: 'text/plain',
    size: bytes,
    kind: 'file',
    artifact_role: 'input',
    bundled_count: attachments.length,
    bundled_names: attachments.map(a => a.name),
    line_range: null,
    line_start: null,
    line_end: null,
    source_line_count: null,
  }]
}

function materializeResearchAttachments({ libRoot, id, attachments }) {
  if (!Array.isArray(attachments) || attachments.length === 0) return []
  const dir = path.join(libRoot, 'research-artifacts', safeFileName(id, 'research'), 'input')
  fs.mkdirSync(dir, { recursive: true })
  const materialized = attachments.length > MAX_ATTACHMENT_COUNT
    ? materializeBundle(dir, attachments)
    : attachments.map((attachment, i) => materializeOne(dir, attachment, i))
  return materialized.map((attachment, index) => ({ ...attachment, index }))
}

function publicAttachmentMeta(attachment) {
  return {
    index: attachment.index,
    name: attachment.name,
    mime: attachment.mime,
    size: attachment.size,
    kind: attachment.kind || (String(attachment.mime || '').startsWith('image/') ? 'image' : 'file'),
    line_start: attachment.line_start ?? null,
    line_end: attachment.line_end ?? null,
    bundled_count: attachment.bundled_count ?? null,
  }
}

function researchInputMeta(attachment) {
  if (!attachment?.path) return null
  return {
    file_path: attachment.path,
    original_path: attachment.original_path || null,
    name: attachment.name || path.basename(attachment.path),
    content_type: attachment.mime || fileMime(attachment.path),
    bytes: attachment.size ?? null,
    role: 'input',
    line_start: attachment.line_start ?? null,
    line_end: attachment.line_end ?? null,
    source_line_count: attachment.source_line_count ?? null,
    bundled_count: attachment.bundled_count ?? null,
  }
}

function researchResultForPersist(snapshot) {
  const result = snapshot?.result && typeof snapshot.result === 'object' ? snapshot.result : {}
  const attachments = Array.isArray(snapshot?.attachments) ? snapshot.attachments : []
  const inputImages = attachments
    .filter(attachment => String(attachment?.mime || '').startsWith('image/'))
    .map(researchInputMeta)
    .filter(Boolean)
  const inputFiles = attachments
    .filter(attachment => !String(attachment?.mime || '').startsWith('image/'))
    .map(researchInputMeta)
    .filter(Boolean)
  return {
    ...result,
    ...(inputImages.length ? { input_images: inputImages } : {}),
    ...(inputFiles.length ? { input_files: inputFiles } : {}),
  }
}

module.exports = {
  MAX_ATTACHMENT_COUNT,
  MAX_ATTACHMENT_BYTES,
  normalizeResearchAttachments,
  materializeResearchAttachments,
  publicAttachmentMeta,
  researchInputMeta,
  researchResultForPersist,
}
