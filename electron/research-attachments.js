const fs = require('node:fs')
const path = require('node:path')

const MAX_ATTACHMENT_COUNT = 20
const MAX_ATTACHMENT_SPECS = 1000
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
const MAX_TOTAL_ATTACHMENT_BYTES = 100 * 1024 * 1024
const MAX_BUNDLE_BYTES = 20 * 1024 * 1024
const MAX_BUNDLE_PAYLOAD_BYTES = MAX_BUNDLE_BYTES - 4096
const TARGET_BUNDLE_SOURCE_COUNT = 10
const TEXT_SNIFF_BYTES = 64 * 1024

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
  '.lock': 'text/plain',
  '.b64': 'text/plain',
  '.mts': 'text/plain',
  '.cts': 'text/plain',
  '.svg': 'image/svg+xml',
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
  '.hpp', '.sh', '.zsh', '.sql', '.toml', '.log', '.lock', '.b64', '.mts',
  '.cts', '.svg',
])

function fileMime(filePath) {
  return MIME_BY_EXT[path.extname(filePath || '').toLowerCase()] || 'application/octet-stream'
}

function safeFileName(name, fallback = 'attachment') {
  const base = path.basename(String(name || fallback)).normalize('NFC')
    .replace(/[^\p{L}\p{N}\p{M}.\-]+/gu, '_')
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
  if (String(mime || '').startsWith('text/')
    || ['application/json', 'application/x-ndjson', 'application/yaml', 'application/xml', 'application/sql', 'application/toml'].includes(mime)
    || TEXT_EXTENSIONS.has(path.extname(filePath || '').toLowerCase())) return true
  // Unknown source-code extensions are common in repository snapshots. Sniff
  // only application/octet-stream; known PDFs, archives, Office files and
  // raster images remain binary even when their first bytes happen to be ASCII.
  if (mime !== 'application/octet-stream') return false
  let fd = null
  try {
    const size = Math.min(fs.statSync(filePath).size, TEXT_SNIFF_BYTES)
    const sample = Buffer.alloc(size)
    fd = fs.openSync(filePath, 'r')
    fs.readSync(fd, sample, 0, size, 0)
    if (sample.includes(0)) return false
    new TextDecoder('utf-8', { fatal: true }).decode(sample)
    return true
  } catch {
    return false
  } finally {
    if (fd != null) try { fs.closeSync(fd) } catch {}
  }
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

// Structural inspection is safe in the HTTP/main process. File type/size and
// text sniffing stay in normalizeResearchAttachments inside the I/O child.
function inspectResearchAttachmentSpecs(raw) {
  if (!Array.isArray(raw)) throw new Error('attachments must be an array')
  if (raw.length > MAX_ATTACHMENT_SPECS) throw new Error(`too many attachment paths (${raw.length}); maximum input list is ${MAX_ATTACHMENT_SPECS}`)
  let hasDocuments = false
  for (const spec of raw) {
    const name = typeof spec === 'string' ? spec : spec?.path || spec?.file_path
    if (typeof name !== 'string' || !path.isAbsolute(name)) throw new Error(`attachment path must be absolute: ${name || ''}`)
    lineRangeFromSpec(spec)
    const mime = typeof spec?.mime === 'string' && spec.mime.trim() ? spec.mime.trim() : fileMime(name)
    if (!mime.startsWith('image/')) hasDocuments = true
  }
  return { hasDocuments }
}

function rangeName(name, range) {
  if (!range) return name
  const ext = path.extname(name)
  const stem = path.basename(name, ext)
  return `${stem}.L${range.start}-L${range.end == null ? 'end' : range.end}${ext || '.txt'}`
}

function materializeOne(dir, attachment, position, sourceTotal = 1) {
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
    source_indexes: [attachment.index],
    source_total_count: sourceTotal,
  }
}

function bundleEntry(attachment, sourceTotal) {
  const selection = selectedText(attachment)
  const value = typeof selection === 'string' ? selection : selection.value
  const range = attachment.line_range
    ? ` · lines ${attachment.line_range.start}-${selection.actualEnd}`
    : ''
  const sourceIndex = Number.isInteger(attachment.index) ? attachment.index : 0
  const text = `===== FILE ${sourceIndex + 1}/${sourceTotal}: ${attachment.name}${range} =====\n${value}`
  return {
    attachment,
    sourceIndex,
    text,
    bytes: Buffer.byteLength(text, 'utf8'),
  }
}

function tryPackBundleEntries(entries, bundleCount) {
  const bins = Array.from({ length: bundleCount }, (_, index) => ({ index, entries: [], bytes: 0 }))
  const largestFirst = [...entries].sort((a, b) => b.bytes - a.bytes || a.sourceIndex - b.sourceIndex)
  for (const entry of largestFirst) {
    const candidates = bins
      .filter(bin => bin.bytes + (bin.entries.length ? 2 : 0) + entry.bytes <= MAX_BUNDLE_PAYLOAD_BYTES)
      .sort((a, b) => a.bytes - b.bytes || a.entries.length - b.entries.length || a.index - b.index)
    const bin = candidates[0]
    if (!bin) return null
    if (bin.entries.length) bin.bytes += 2
    bin.entries.push(entry)
    bin.bytes += entry.bytes
  }
  if (bins.some(bin => bin.entries.length === 0)) return null
  return bins
    .map(bin => bin.entries.sort((a, b) => a.sourceIndex - b.sourceIndex))
    .sort((a, b) => a[0].sourceIndex - b[0].sourceIndex)
}

function packBundleEntries(entries, maxBundleCount) {
  if (!entries.length) return []
  if (maxBundleCount < 1) {
    throw new Error(`attachment packing needs at least one free browser slot for ${entries.length} text files`)
  }
  const totalPayloadBytes = entries.reduce((sum, entry) => sum + entry.bytes + 2, 0)
  const minByBytes = Math.ceil(totalPayloadBytes / MAX_BUNDLE_PAYLOAD_BYTES)
  if (minByBytes > maxBundleCount) {
    throw new Error(`text attachments need at least ${minByBytes} bundles by size, but only ${maxBundleCount} browser slots remain`)
  }
  const preferredByCount = Math.ceil(entries.length / TARGET_BUNDLE_SOURCE_COUNT)
  const firstCount = Math.max(1, minByBytes, Math.min(preferredByCount, maxBundleCount))
  for (let count = firstCount; count <= maxBundleCount; count++) {
    const packed = tryPackBundleEntries(entries, count)
    if (packed) return packed
  }
  throw new Error(`text attachments cannot be packed into ${maxBundleCount} browser files without exceeding ${MAX_BUNDLE_BYTES} bytes per file`)
}

function materializeBundle(dir, entries, { position, bundleIndex, bundleCount, sourceTotal }) {
  const header = `===== SC FILE BUNDLE ${bundleIndex}/${bundleCount} · ${entries.length}/${sourceTotal} SOURCE FILES =====`
  const text = `${header}\n\n${entries.map(entry => entry.text).join('\n\n')}\n`
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_BUNDLE_BYTES) {
    throw new Error(`auto-bundled attachment ${bundleIndex}/${bundleCount} is too large (${bytes} bytes; limit ${MAX_BUNDLE_BYTES})`)
  }
  const width = String(bundleCount).length
  const name = `${String(position + 1).padStart(2, '0')}-sc-file-bundle-${String(bundleIndex).padStart(width, '0')}-of-${bundleCount}.txt`
  const dest = path.join(dir, name)
  fs.writeFileSync(dest, text, 'utf8')
  const sourceIndexes = entries.map(entry => entry.sourceIndex)
  return {
    index: position,
    path: dest,
    original_path: null,
    name,
    mime: 'text/plain',
    size: bytes,
    kind: 'file',
    artifact_role: 'input',
    bundled_count: entries.length,
    bundled_names: entries.map(entry => entry.attachment.name),
    bundled_source_indexes: sourceIndexes,
    bundle_index: bundleIndex,
    bundle_count: bundleCount,
    source_indexes: sourceIndexes,
    source_total_count: sourceTotal,
    line_range: null,
    line_start: null,
    line_end: null,
    source_line_count: null,
  }
}

function assertPackingComplete(materialized, sourceTotal) {
  if (materialized.length > MAX_ATTACHMENT_COUNT) {
    throw new Error(`attachment packing produced ${materialized.length} browser files; limit is ${MAX_ATTACHMENT_COUNT}`)
  }
  const covered = materialized.flatMap(attachment => Array.isArray(attachment.source_indexes) ? attachment.source_indexes : [])
  const unique = new Set(covered)
  const invalid = covered.filter(index => !Number.isInteger(index) || index < 0 || index >= sourceTotal)
  const missing = Array.from({ length: sourceTotal }, (_, index) => index).filter(index => !unique.has(index))
  if (invalid.length || unique.size !== covered.length || covered.length !== sourceTotal || missing.length) {
    throw new Error(
      `attachment packing incomplete: covered ${unique.size}/${sourceTotal}, duplicates=${covered.length - unique.size}, invalid=${invalid.length}, missing=${missing.slice(0, 20).join(',') || 'none'}`,
    )
  }
}

function researchAttachmentPackingSummary(materialized) {
  const list = Array.isArray(materialized) ? materialized : []
  const covered = list.flatMap(attachment => Array.isArray(attachment.source_indexes) ? attachment.source_indexes : [])
  const unique = new Set(covered)
  const declaredTotals = list.map(attachment => attachment.source_total_count).filter(Number.isFinite)
  const sourceFileCount = declaredTotals.length ? Math.max(...declaredTotals) : covered.length
  const bundleCount = list.filter(attachment => Number.isFinite(attachment.bundle_index)).length
  return {
    sourceFileCount,
    packedSourceFileCount: unique.size,
    uploadFileCount: list.length,
    bundleCount,
    individualFileCount: list.length - bundleCount,
    packingComplete: unique.size === sourceFileCount && covered.length === unique.size,
  }
}

function materializeResearchAttachmentsInDirectory(dir, attachments) {
  const sourceTotal = attachments.length
  if (sourceTotal <= MAX_ATTACHMENT_COUNT) {
    const materialized = attachments.map((attachment, i) => materializeOne(dir, attachment, i, sourceTotal))
    assertPackingComplete(materialized, sourceTotal)
    return materialized.map((attachment, index) => ({ ...attachment, index }))
  }

  const direct = []
  const bundleEntries = []
  for (const attachment of attachments) {
    if (!isTextAttachment(attachment.path, attachment.mime)) {
      direct.push(attachment)
      continue
    }
    const entry = bundleEntry(attachment, sourceTotal)
    if (entry.bytes > MAX_BUNDLE_PAYLOAD_BYTES) direct.push(attachment)
    else bundleEntries.push(entry)
  }
  if (direct.length > MAX_ATTACHMENT_COUNT) {
    throw new Error(`ChatGPT accepts at most ${MAX_ATTACHMENT_COUNT} browser files; ${direct.length} inputs cannot be text-bundled`)
  }
  const groups = packBundleEntries(bundleEntries, MAX_ATTACHMENT_COUNT - direct.length)
  const descriptors = [
    ...direct.map(attachment => ({ type: 'single', sourceIndex: attachment.index, attachment })),
    ...groups.map(entries => ({ type: 'bundle', sourceIndex: entries[0].sourceIndex, entries })),
  ].sort((a, b) => a.sourceIndex - b.sourceIndex)
  let bundleIndex = 0
  const materialized = descriptors.map((descriptor, position) => {
    if (descriptor.type === 'single') return materializeOne(dir, descriptor.attachment, position, sourceTotal)
    bundleIndex++
    return materializeBundle(dir, descriptor.entries, {
      position,
      bundleIndex,
      bundleCount: groups.length,
      sourceTotal,
    })
  })
  assertPackingComplete(materialized, sourceTotal)
  return materialized.map((attachment, index) => ({ ...attachment, index }))
}

function materializeResearchAttachments({ libRoot, id, attachments }) {
  if (!Array.isArray(attachments) || attachments.length === 0) return []
  const dir = path.join(libRoot, 'research-artifacts', safeFileName(id, 'research'), 'input')
  fs.mkdirSync(dir, { recursive: true })
  try {
    return materializeResearchAttachmentsInDirectory(dir, attachments)
  } catch (error) {
    // A rejected preflight must not leave a partial set that could later be
    // mistaken for the complete request. The job id owns this directory.
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
    throw error
  }
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
    bundle_index: attachment.bundle_index ?? null,
    bundle_count: attachment.bundle_count ?? null,
    source_total_count: attachment.source_total_count ?? null,
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
    bundle_index: attachment.bundle_index ?? null,
    bundle_count: attachment.bundle_count ?? null,
    source_total_count: attachment.source_total_count ?? null,
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
  MAX_ATTACHMENT_SPECS,
  MAX_ATTACHMENT_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
  MAX_BUNDLE_BYTES,
  TARGET_BUNDLE_SOURCE_COUNT,
  normalizeResearchAttachments,
  inspectResearchAttachmentSpecs,
  materializeResearchAttachments,
  researchAttachmentPackingSummary,
  publicAttachmentMeta,
  researchInputMeta,
  researchResultForPersist,
}
