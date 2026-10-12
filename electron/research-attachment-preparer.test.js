const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { prepareResearchAttachments } = require('./research-attachment-preparer')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-attachment-worker-'))
test.after(() => fs.rmSync(root, { recursive: true, force: true }))

test('real I/O child preserves selected source lines and snapshots', async () => {
  const source = path.join(root, 'source.md')
  fs.writeFileSync(source, 'first\nsecond\nthird\n')
  const progress = []
  const files = await prepareResearchAttachments({
    libRoot: root, id: 'selected-lines', mode: 'chat', specs: [{ path: source, startLine: 2, endLine: 3 }],
  }, { onProgress: event => progress.push(event) })
  assert.equal(files.length, 1)
  assert.equal(fs.readFileSync(files[0].path, 'utf8'), 'second\nthird')
  assert.ok(progress.some(event => event.path === source && event.operation === 'readFileSync'))
})

test('one child stuck in synchronous I/O does not block another request or the event loop', async () => {
  const worker = path.join(root, 'stalled-child.cjs')
  fs.writeFileSync(worker, `process.on('message',()=>{
    process.send({type:'progress',operation:'openSync',path:'/fixture/blocked.md'});
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
  });`)
  const source = path.join(root, 'normal.md')
  fs.writeFileSync(source, 'independent request')
  let stalled
  const began = new Promise(resolve => {
    stalled = prepareResearchAttachments({ id: 'blocked', specs: [source], mode: 'chat', libRoot: root },
      { workerPath: worker, inactivityMs: 400, onProgress: resolve }).catch(error => error)
  })
  await began
  const heartbeat = await new Promise(resolve => setTimeout(() => resolve('responsive'), 10))
  const other = await prepareResearchAttachments({ id: 'normal', specs: [source], mode: 'chat', libRoot: root })
  assert.equal(heartbeat, 'responsive')
  assert.equal(fs.readFileSync(other[0].path, 'utf8'), 'independent request')
  const error = await stalled
  assert.equal(error.code, 'attachment_preparation_timeout')
  assert.match(error.message, /openSync.*blocked.md/)
  assert.match(error.message, /No browser request was sent/)
})

test('invalid input is reported by the child without creating a snapshot', async () => {
  await assert.rejects(prepareResearchAttachments({
    id: 'invalid', mode: 'chat', libRoot: root, specs: [root],
  }), error => error.code === 'attachment_validation_failed' && /not a file/.test(error.message))
  assert.equal(fs.existsSync(path.join(root, 'research-artifacts', 'invalid')), false)
})
