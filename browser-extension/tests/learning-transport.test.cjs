const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parse } = require('@babel/parser');
const createObserver = require('../learning-save-state');
const source = fs.readFileSync(require.resolve('../youtube-learning.js'), 'utf8');
let implementation;
function walk(node) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'FunctionDeclaration' && node.id?.name === 'bridgeJson') implementation = source.slice(node.start, node.end);
  for (const child of Object.values(node)) if (Array.isArray(child)) child.forEach(walk); else if (child?.type) walk(child);
}
walk(parse(source)); assert.ok(implementation);
function transport(fetch) {
  const deadlines = new Map();
  const scope = { BRIDGE: 'http://private-fixture', fetch, AbortController, TypeError, Error,
    setTimeout(callback, ms) { deadlines.set(callback, ms); return callback; }, clearTimeout(callback) { deadlines.delete(callback); } };
  const request = vm.runInNewContext('(' + implementation + ')', scope);
  return { request, deadlines };
}
test('actual caption transport bounds a missing Save reply and reconciles server completion without retrying the write', async () => {
  const calls = []; let completed = false;
  const { request, deadlines } = transport(async (_url, options) => {
    const body = JSON.parse(options.body); calls.push(body.action);
    if (body.action === 'save-status') return { ok: true, json: async () => ({ ok: true, operations: completed
      ? [{ key: 'steal', term: 'steal', phase: 'ready', itemId: 'fixture-id', updatedAt: 99 }] : [] }) };
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  });
  const observer = createObserver(body => request('/learning/catalogue', { method: 'POST', body }));
  const save = observer.save({ word: 'steal' });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(observer.pending(observer.get('steal')), true);
  assert.equal([...deadlines.values()][0], 610000);
  const rejected = assert.rejects(save, /Результат операции пока не подтверждён/);
  [...deadlines.keys()][0](); await rejected;
  assert.equal(observer.pending(observer.get('steal')), false); assert.equal(deadlines.size, 0);
  completed = true; await observer.refresh();
  assert.equal(observer.get('steal').phase, 'ready'); assert.deepEqual(calls, ['save', 'save-status']);
});
test('server errors, empty responses and transport failures remain explicit and clear their deadline', async () => {
  for (const [fetch, expected] of [
    [async () => ({ ok: false, status: 502, json: async () => ({ error: 'Invalid reference-only category: fixture' }) }), /Invalid reference/],
    [async () => ({ ok: true, json: async () => null }), /пустой ответ/],
    [async () => { throw new TypeError('Failed to fetch'); }, /Нет связи с SC Desktop/],
  ]) {
    const h = transport(fetch); await assert.rejects(h.request('/learning/catalogue', { body: { action: 'context-choice' } }), expected);
    assert.equal(h.deadlines.size, 0);
  }
});
