const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const { parse } = require('@babel/parser');
const source = fs.readFileSync(require('node:path').resolve(__dirname, '../study-src/main.jsx'), 'utf8');
const functions = parse(source, { sourceType: 'module', plugins: ['jsx'] }).program.body
  .filter(node => node.type === 'FunctionDeclaration' && ['normalizeRemoteTerm', 'remoteEntry', 'createRemoteStore'].includes(node.id.name));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function storeFor(remoteApi) {
  const context = vm.createContext({ remoteApi, Lexeme: null });
  functions.forEach(node => vm.runInContext(source.slice(node.start, node.end), context));
  return context.createRemoteStore();
}
const item = { id: 'v_one', term: 'one', lemma: 'one', state: 'saved', translation: 'один', updatedAt: 1 };

test('a Save completion queues a fresh read instead of adopting the request started before the commit', async () => {
  for (const fails of [false, true]) {
    const old = deferred(), fresh = deferred(); let calls = 0;
    const store = storeFor(() => (++calls === 1 ? old.promise : fresh.promise));
    const initial = store.listEntries().catch(() => []);
    const synced = store.sync();
    if (fails) old.reject(new Error('old request failed')); else old.resolve({ items: [] });
    await initial;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 2);
    fresh.resolve({ items: [item] });
    assert.equal((await synced).items[0].remoteId, item.id);
  }
});

test('state-only PATCH preserves lexical fields and a late GET cannot restore the old state', async () => {
  const old = deferred(); let gets = 0; const patches = [];
  const store = storeFor((path, options) => {
    if (options?.method === 'PATCH') {
      patches.push(options.body);
      return Promise.resolve({ item: { ...item, state: options.body.state, translation: 'свежий ручной перевод', updatedAt: 3 } });
    }
    return ++gets === 1 ? Promise.resolve({ items: [item] }) : old.promise;
  });
  await store.listEntries();
  const sync = store.sync();
  await store.setState({ key: item.id, state: 'archived', toggle: false, translation: 'старое поле карточки', senseCatalog: { version: 1 } });
  old.resolve({ items: [item] });
  const after = (await sync).items[0];
  assert.deepEqual(JSON.parse(JSON.stringify(patches)), [{ state: 'archived' }]);
  assert.equal(after.state, 'archived');
  assert.equal(after.translation, 'свежий ручной перевод');
});
