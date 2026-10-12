const test = require('node:test');
const assert = require('node:assert/strict');
const { File } = require('node:buffer');
const { fixture } = require('./helpers/chatgpt-flow-fixture.cjs');

function observedFixture() {
  const observers = [];
  class Observer {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  }
  return { ...fixture({ mutationObserver: Observer }), observers };
}
const inputFile = () => new File(['{"data":"' + 'a'.repeat(35389) + '"}'], '01-core-batch-001.json', { type: 'application/json' });

test('a file input remount in the await gap uses the new live input, not the detached one', async () => {
  const f = observedFixture();
  const old = f.input;
  const replacement = new f.Element('input', { id: 'upload-files', type: 'file' });
  const query = f.document.querySelector;
  let scheduled = false, oldEvents = 0, newEvents = 0;
  old.handlers.change = () => { oldEvents++; };
  replacement.handlers.change = () => { newEvents++; f.preview(inputFile().name); };
  f.document.querySelector = selector => {
    const found = query(selector);
    if (selector === '#upload-files' && !scheduled) {
      scheduled = true;
      queueMicrotask(() => { old.remove(); f.composer.appendChild(replacement); });
    }
    return found;
  };
  const pending = f.uploadFiles('fixture-upload', [inputFile()], { requirePreview: true });
  const checked = pending.then(r => ({ ok: true, r }), error => ({ ok: false, error }));
  await f.clock.advance(61000);
  const result = await checked;
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(oldEvents, 0, 'do not dispatch to an obsolete detached receiver');
  assert.equal(newEvents, 1);
  assert.equal(await replacement.files[0].text(), await inputFile().text());
  assert.equal(result.r.hasPreview(), true);
});

test('a preview DOM mutation resolves the upload before the 500ms fallback tick', async () => {
  const f = observedFixture();
  let done = false;
  const pending = f.uploadFiles('fixture-upload', [inputFile()], { requirePreview: true }).then(r => { done = true; return r; });
  await f.clock.flush();
  f.preview(inputFile().name);
  for (const observer of f.observers) observer.callback([{ type: 'childList' }]);
  await f.clock.flush();
  assert.equal(done, true, 'actual DOM receipt, not periodic polling, drives readiness');
  assert.equal((await pending).hasPreview(), true);
  assert(f.observers.length > 0);
  assert(f.observers.every(observer => observer.disconnected));
});

test('missing preview stays an explicit error and never replays the file change', async () => {
  const f = observedFixture();
  let changes = 0;
  f.input.handlers.change = () => { changes++; };
  const pending = f.uploadFiles('fixture-upload', [inputFile()], { requirePreview: true });
  const rejection = assert.rejects(pending, /chatgpt_attachment_preview_missing/);
  await f.clock.advance(61000);
  await rejection;
  assert.equal(changes, 1);
  assert(f.observers.every(observer => observer.disconnected));
});

test('an old same-name preview does not count as the new upload, even after mutations', async () => {
  const f = observedFixture();
  f.preview(inputFile().name);
  const pending = f.uploadFiles('fixture-upload', [inputFile()], { requirePreview: true });
  const rejection = assert.rejects(pending, /chatgpt_attachment_preview_missing/);
  await f.clock.flush();
  for (const observer of f.observers) observer.callback([{ type: 'attributes' }]);
  await f.clock.advance(61000);
  await rejection;
});
