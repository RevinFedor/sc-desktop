const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  MAX_ATTACHMENT_COUNT,
  normalizeResearchAttachments,
  materializeResearchAttachments,
  researchResultForPersist,
} = require('./research-attachments')

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-research-attachments-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
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

test('more than twenty text inputs become one bounded bundle', (t) => {
  const root = tempDir(t)
  const specs = Array.from({ length: MAX_ATTACHMENT_COUNT + 1 }, (_, i) => {
    const file = path.join(root, `part-${i + 1}.txt`)
    fs.writeFileSync(file, `value-${i + 1}`)
    return file
  })
  const normalized = normalizeResearchAttachments(specs)
  const [bundle] = materializeResearchAttachments({ libRoot: root, id: 'bundle-job', attachments: normalized })
  const text = fs.readFileSync(bundle.path, 'utf8')

  assert.equal(bundle.bundled_count, 21)
  assert.equal(bundle.mime, 'text/plain')
  assert.match(text, /FILE 1\/21: part-1\.txt/)
  assert.match(text, /FILE 21\/21: part-21\.txt/)
  assert.match(text, /value-21/)
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
