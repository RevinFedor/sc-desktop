const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  MAX_ATTACHMENT_COUNT,
  MAX_ATTACHMENT_SPECS,
  MAX_BUNDLE_BYTES,
  normalizeResearchAttachments,
  materializeResearchAttachments,
  researchAttachmentPackingSummary,
  publicAttachmentMeta,
  researchResultForPersist,
} = require('./research-attachments')

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-research-attachments-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function textSpecs(root, count, ext = '.txt') {
  return Array.from({ length: count }, (_, i) => {
    const file = path.join(root, `part-${String(i + 1).padStart(4, '0')}${ext}`)
    fs.writeFileSync(file, `value-${i + 1}\n`)
    return file
  })
}

function bundledSourceIndexes(files, expectedTotal) {
  const found = []
  for (const file of files) {
    if (!file.bundled_count) continue
    const text = fs.readFileSync(file.path, 'utf8')
    for (const match of text.matchAll(/===== FILE (\d+)\/(\d+):/g)) {
      assert.equal(Number(match[2]), expectedTotal)
      found.push(Number(match[1]))
    }
  }
  return found.sort((a, b) => a - b)
}

test('materializes only the requested one-based line range', (t) => {
  const root = tempDir(t)
  const source = path.join(root, 'example.js')
  fs.writeFileSync(source, ['one', 'two', 'three', 'four'].join('\n'))
  const normalized = normalizeResearchAttachments([{ path: source, startLine: 2, endLine: 3 }])
  const [attachment] = materializeResearchAttachments({ libRoot: root, id: 'range-job', attachments: normalized })

  assert.equal(fs.readFileSync(attachment.path, 'utf8'), 'two\nthree')
  assert.match(attachment.name, /example\.L2-L3\.js$/)
  assert.equal(attachment.line_start, 2)
  assert.equal(attachment.line_end, 3)
  assert.equal(attachment.original_path, source)
})

test('accepts compact lines syntax and clamps an open range to EOF', (t) => {
  const root = tempDir(t)
  const source = path.join(root, 'notes.md')
  fs.writeFileSync(source, 'a\nb\nc\n')
  const normalized = normalizeResearchAttachments([{ path: source, lines: '2-99' }])
  const [attachment] = materializeResearchAttachments({ libRoot: root, id: 'range-eof', attachments: normalized })

  assert.equal(fs.readFileSync(attachment.path, 'utf8'), 'b\nc\n')
  assert.equal(attachment.line_end, 4)
  assert.equal(attachment.source_line_count, 4)
})

test('more than twenty text inputs become several bounded, complete bundles', (t) => {
  const root = tempDir(t)
  const specs = textSpecs(root, MAX_ATTACHMENT_COUNT + 1)
  const normalized = normalizeResearchAttachments(specs)
  const bundles = materializeResearchAttachments({ libRoot: root, id: 'bundle-job', attachments: normalized })
  const summary = researchAttachmentPackingSummary(bundles)

  assert.equal(bundles.length, 3)
  assert.equal(summary.sourceFileCount, 21)
  assert.equal(summary.packedSourceFileCount, 21)
  assert.equal(summary.bundleCount, 3)
  assert.equal(summary.packingComplete, true)
  assert.deepEqual(
    publicAttachmentMeta(bundles[0]),
    {
      index: 0,
      name: bundles[0].name,
      mime: 'text/plain',
      size: bundles[0].size,
      kind: 'file',
      line_start: null,
      line_end: null,
      bundled_count: bundles[0].bundled_count,
      bundle_index: 1,
      bundle_count: 3,
      source_total_count: 21,
    },
  )
  assert.deepEqual(bundledSourceIndexes(bundles, 21), Array.from({ length: 21 }, (_, i) => i + 1))
  assert.ok(bundles.every(bundle => bundle.mime === 'text/plain' && bundle.size <= MAX_BUNDLE_BYTES))
})

test('one hundred thirty small paths become thirteen uploads without caller bundling', (t) => {
  const root = tempDir(t)
  const normalized = normalizeResearchAttachments(textSpecs(root, 130))
  const bundles = materializeResearchAttachments({ libRoot: root, id: 'bundle-130', attachments: normalized })

  assert.equal(bundles.length, 13)
  assert.deepEqual(bundledSourceIndexes(bundles, 130), Array.from({ length: 130 }, (_, i) => i + 1))
  assert.deepEqual(researchAttachmentPackingSummary(bundles), {
    sourceFileCount: 130,
    packedSourceFileCount: 130,
    uploadFileCount: 13,
    bundleCount: 13,
    individualFileCount: 0,
    packingComplete: true,
  })
})

test('six hundred twenty eight paths cap at twenty uploads with no missing source index', (t) => {
  const root = tempDir(t)
  const normalized = normalizeResearchAttachments(textSpecs(root, 628, '.mts'))
  const bundles = materializeResearchAttachments({ libRoot: root, id: 'bundle-628', attachments: normalized })

  assert.equal(bundles.length, MAX_ATTACHMENT_COUNT)
  assert.deepEqual(bundledSourceIndexes(bundles, 628), Array.from({ length: 628 }, (_, i) => i + 1))
  assert.equal(researchAttachmentPackingSummary(bundles).packingComplete, true)
})

test('known binary files stay individual while remaining text is bundled into free slots', (t) => {
  const root = tempDir(t)
  const binary = path.join(root, 'reference.pdf')
  fs.writeFileSync(binary, Buffer.from([0, 1, 2, 3]))
  const normalized = normalizeResearchAttachments([binary, ...textSpecs(root, 25, '.b64')])
  const packed = materializeResearchAttachments({ libRoot: root, id: 'mixed', attachments: normalized })
  const summary = researchAttachmentPackingSummary(packed)

  assert.equal(summary.sourceFileCount, 26)
  assert.equal(summary.uploadFileCount, 4)
  assert.equal(summary.bundleCount, 3)
  assert.equal(summary.individualFileCount, 1)
  assert.equal(summary.packingComplete, true)
  assert.equal(packed.filter(file => file.mime === 'application/pdf').length, 1)
})

test('more than twenty unbundleable files fail before any browser upload', (t) => {
  const root = tempDir(t)
  const specs = Array.from({ length: MAX_ATTACHMENT_COUNT + 1 }, (_, i) => {
    const file = path.join(root, `binary-${i + 1}.pdf`)
    fs.writeFileSync(file, Buffer.from([0, i, 2, 3]))
    return file
  })
  const normalized = normalizeResearchAttachments(specs)

  assert.throws(
    () => materializeResearchAttachments({ libRoot: root, id: 'too-many-binary', attachments: normalized }),
    /21 inputs cannot be text-bundled/,
  )
  assert.equal(fs.existsSync(path.join(root, 'research-artifacts', 'too-many-binary', 'input')), false)
})

test('input path ceiling permits the 628-file audit but remains bounded', () => {
  assert.ok(MAX_ATTACHMENT_SPECS >= 628)
  assert.throws(
    () => normalizeResearchAttachments(Array.from({ length: MAX_ATTACHMENT_SPECS + 1 }, () => '/not/read')),
    new RegExp(`maximum input list is ${MAX_ATTACHMENT_SPECS}`),
  )
})

test('rejects relative paths and binary line ranges', (t) => {
  const root = tempDir(t)
  const binary = path.join(root, 'sample.pdf')
  fs.writeFileSync(binary, Buffer.from([0, 1, 2]))

  assert.throws(() => normalizeResearchAttachments(['relative.txt']), /must be absolute/)
  assert.throws(
    () => normalizeResearchAttachments([{ path: binary, startLine: 1, endLine: 2 }]),
    /line ranges require a supported text file/,
  )
})

test('persists documents separately from image inputs', (t) => {
  const root = tempDir(t)
  const image = path.join(root, 'image.png')
  const text = path.join(root, 'code.py')
  fs.writeFileSync(image, Buffer.from([1, 2, 3]))
  fs.writeFileSync(text, 'print(1)\n')
  const attachments = materializeResearchAttachments({
    libRoot: root,
    id: 'persist-job',
    attachments: normalizeResearchAttachments([image, { path: text, lines: '1' }]),
  })
  const result = researchResultForPersist({ result: { text: 'ok' }, attachments })

  assert.equal(result.input_images.length, 1)
  assert.equal(result.input_files.length, 1)
  assert.equal(result.input_files[0].line_start, 1)
  assert.equal(result.input_files[0].line_end, 1)
})

test('preserves meaningful Unicode attachment names', (t) => {
  const root = tempDir(t)
  const source = path.join(root, 'архитектура-окон-и-вкладок.md')
  fs.writeFileSync(source, '# test\n')
  const [attachment] = materializeResearchAttachments({
    libRoot: root,
    id: 'unicode-name',
    attachments: normalizeResearchAttachments([source]),
  })

  assert.match(attachment.name, /архитектура-окон-и-вкладок\.md$/u)
})
