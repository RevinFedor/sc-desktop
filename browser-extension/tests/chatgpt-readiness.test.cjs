const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/chatgpt-flow-fixture.cjs');

function prepared({ prompt = '', names = [] } = {}) {
  const f = fixture();
  f.editor.remove();
  names.forEach(name => f.preview(name));
  f.composer.appendChild(f.editor);
  f.editor.textContent = prompt;
  f.composer.appendChild(f.send);
  return f;
}

test('a long prompt mentioning loading with seven preceding filenames is ready without Send', async () => {
  const prompt = 'Audit Unconfirmed delivery vs loading error, processing and attaching. '.repeat(20);
  const names = Array.from({ length: 7 }, (_, i) => `${i}-context-and-evidence.md`);
  const f = prepared({ prompt, names });
  const ready = f.waitComposerReadyAfterPaste('readiness-only', 120000, [prompt, ...names], names);
  const result = ready.then(value => ({ value }), error => ({ error }));
  await f.clock.advance(120001);
  assert.equal((await result).error, undefined);
  assert.equal((await result).value.busyText, false);
  assert.equal(f.editor.textContent, prompt);
  assert.equal(f.history.children.length, 0);
});

test('rendered data is excluded structurally even after paragraph layout differs from ignored text', () => {
  const f = prepared({ prompt: 'first paragraphloading error in the second paragraph' });
  assert.equal(f.composerBusySnapshot(['first paragraph\n\nloading error in the second paragraph']).ready, true);
});

test('renamed attachment labels containing loading/processing are not upload status', () => {
  const names = ['loading.md', 'processing.log', 'loading'];
  const f = prepared({ prompt: 'Review evidence', names: ['loading(4).md', 'processing(2).log', 'loading'] });
  const snap = f.composerBusySnapshot(['Review evidence', ...names], names);
  assert.equal(snap.busyText, false);
  assert.equal(snap.ready, true);
});

test('a real loading status outside editor still blocks even when the prompt itself is loading', () => {
  const f = prepared({ prompt: 'loading' });
  f.composer.appendChild(new f.Element('span', { role: 'status' }, 'loading'));
  const snap = f.composerBusySnapshot(['loading']);
  assert.equal(snap.busyCount, 0);
  assert.equal(snap.busyText, true);
  assert.equal(snap.ready, false);
});

test('a real status is checked in full, not lost beyond a diagnostic 500-char limit', () => {
  const f = prepared({ prompt: 'Review evidence' });
  f.composer.appendChild(new f.Element('span', { role: 'status' }, 'Preparation detail. '.repeat(80) + 'Processing'));
  assert.equal(f.composerBusySnapshot(['Review evidence']).ready, false);
});

test('busy/disabled controls and in-card processing labels remain blocking', () => {
  const f = prepared({ prompt: 'Review processing.log', names: ['processing.log'] });
  const card = f.composer.children.find(el => el.getAttribute('data-testid') === 'attachment-preview');
  const status = card.appendChild(new f.Element('span', { role: 'status' }, 'Processing'));
  assert.equal(f.composerBusySnapshot([], ['processing.log']).ready, false);
  status.remove();
  const spinner = card.appendChild(new f.Element('div', { role: 'progressbar' }));
  assert.equal(f.composerBusySnapshot([], ['processing.log']).busyCount, 1);
  spinner.remove();
  f.send.setAttribute('disabled', '');
  assert.equal(f.composerBusySnapshot([], ['processing.log']).ready, false);
  f.send.removeAttribute('disabled');
  f.editor.setAttribute('contenteditable', 'false');
  assert.equal(f.composerBusySnapshot([], ['processing.log']).ready, false);
});
