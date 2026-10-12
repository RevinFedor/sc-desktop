const test = require('node:test');
const assert = require('node:assert/strict');
const createObserver = require('../learning-save-state');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('closing and reopening does not cancel Save; duplicates share success and rejection', async () => {
  for (const success of [true, false]) {
    const pending = deferred(); let calls = 0;
    const observer = createObserver(body => body.action === 'save-status' ? { ok: true, operations: [] }
      : (calls++, pending.promise));
    const unsubscribe = observer.subscribe(() => {});
    const first = observer.save({ word: 'Curious' });
    unsubscribe();
    assert.equal(observer.pending(observer.get('curious')), true);
    const second = observer.save({ word: ' curious ' });
    assert.equal(second, first);
    const checked = success ? first : assert.rejects(first, /offline/);
    await Promise.resolve();
    if (success) pending.resolve({ ok: true, item: { id: 'v1', term: 'curious' } }); else pending.reject(new Error('offline'));
    await checked;
    assert.equal(calls, 1);
    assert.equal(observer.pending(observer.get('curious')), false);
    assert.equal(observer.get('curious').phase, success ? 'ready' : 'error');
    assert.equal(observer.get('curious').item, undefined, 'operation state cannot replay a stale saved record');
  }
});

test('missed terminal status reconciles current canonical state after expiry or server restart', async () => {
  for (const state of ['saved', 'archived', null]) {
    let response = { ok: true, generation: 'old', operations: [{ key: 'curious', phase: 'preparing', operationId: 'one' }] };
    const observer = createObserver(body => {
      if (!response.operations.length) assert.deepEqual(body.terms, ['curious']);
      return response;
    });
    await observer.refresh();
    response = { ok: true, generation: 'new', operations: [], settled: { curious: state ? { itemId: 'v1', state } : null } };
    await observer.refresh();
    assert.equal(observer.pending(observer.get('curious')), false);
    assert.equal(observer.get('curious').phase, state ? 'reconciled' : 'error');
    assert.notEqual(observer.get('curious').phase, 'ready', 'missing status never proves Save succeeded');
  }
});

test('a slow status response cannot overwrite a Save that completed meanwhile', async () => {
  const status = deferred();
  const observer = createObserver(body => body.action === 'save-status' ? status.promise
    : Promise.resolve({ ok: true, item: { id: 'v1', term: 'curious' } }));
  const refresh = observer.refresh();
  await observer.save({ word: 'curious' });
  status.resolve({ ok: true, operations: [{ key: 'curious', phase: 'preparing' }] });
  await refresh;
  assert.equal(observer.get('curious').phase, 'ready');
});

test('older remote completion never hides a new local pending Save', async () => {
  const job = deferred();
  const observer = createObserver(body => body.action === 'save-status'
    ? { ok: true, operations: [{ key: 'curious', phase: 'ready', itemId: 'old' }] } : job.promise);
  const saved = observer.save({ word: 'curious' });
  await observer.refresh();
  assert.equal(observer.pending(observer.get('curious')), true);
  job.resolve({ ok: true, item: { id: 'new', term: 'curious' } });
  await saved;
  assert.equal(observer.get('curious').itemId, 'new');
});

test('failed status requests preserve pending and allow recovery on a later snapshot', async () => {
  let response = { ok: true, operations: [{ key: 'word', phase: 'saving' }] };
  const observer = createObserver(() => response);
  await observer.refresh();
  response = { ok: false, error: 'offline' };
  await assert.rejects(observer.refresh(), /offline/);
  assert.equal(observer.pending(observer.get('word')), true);
  response = { ok: true, operations: [{ key: 'word', phase: 'ready', itemId: 'v1' }] };
  await observer.refresh();
  assert.equal(observer.get('word').itemId, 'v1');
});
