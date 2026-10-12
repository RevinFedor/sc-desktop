const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseAst } = require('rollup/parseAst');
const Store = require('../learning-store');
const ReviewScheduler = require('../review-scheduler');
const FSRS = require('../vendor/ts-fsrs-5.4.1');
const source = fs.readFileSync(path.resolve(__dirname, '../learning-store.js'), 'utf8');
const declarations = new Map();
function visit(node) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'FunctionDeclaration') declarations.set(node.id.name, source.slice(node.start, node.end));
  if (node.type === 'VariableDeclarator' && node.id?.name === 'REVIEW_FIELDS') {
    declarations.set('REVIEW_FIELDS', `const REVIEW_FIELDS = ${source.slice(node.init.start, node.init.end)};`);
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value?.type) visit(value);
  }
}
visit(parseAst(source));
const plain = value => JSON.parse(JSON.stringify(value));

// Execute the actual queue/Undo bodies, with a private transactional memory
// sink instead of IndexedDB. No browser, native bridge or live server is used.
function fixture() {
  const at = Date.parse('2026-10-09T10:00:00Z');
  const parameters = FSRS.generatorParameters({ enable_fuzz: false });
  const partial = ReviewScheduler.project({ version: 1, card: plain(FSRS.createEmptyCard(new Date(at))), parameters },
    'partial', at, { id: 'partial', meaningRecall: { assessed: ['one', 'two', 'three'], remembered: ['one', 'two'] } });
  const entry = Store.normalizeEntry({ sourceText: 'retain', sourceLang: 'en', targetLang: 'ru',
    state: 'saved', translation: 'сохранять', reviewCount: 1, partialCount: 1,
    reviewSchedule: partial, dueAt: partial.card.due, lastReviewedAt: at });
  let rows = new Map([[entry.key, entry]]), operations = new Map(), fail = false;
  const mirrors = [];
  const context = vm.createContext({ ReviewScheduler, normalizeEntry: Store.normalizeEntry,
    normalizeText: text => String(text || '').trim(), now: () => at + 1000,
    ENTRIES: 'entries', OUTBOX: 'outbox', getEntryDirect: async () => plain(rows.get(entry.key)),
    transaction: async (_names, _mode, work) => {
      const nextRows = new Map(rows), nextOperations = new Map(operations), callbacks = [];
      let aborted = false;
      work({ abort: () => { aborted = true; }, objectStore: name => {
        const target = name === 'entries' ? nextRows : nextOperations;
        return { put: value => target.set(name === 'entries' ? value.key : value.id, plain(value)),
          get: key => { const request = {}; callbacks.push(() => request.onsuccess({ target: { result: plain(target.get(key)) } })); return request; } };
      } });
      callbacks.forEach(run => run());
      if (fail || aborted) throw new Error('private transaction aborted');
      rows = nextRows; operations = nextOperations;
    }, mirrorNativePending: async payload => mirrors.push(plain(payload)), notify() {} });
  for (const name of ['REVIEW_FIELDS', 'queueReviewDirect', 'undoReviewDirect']) {
    assert.ok(declarations.has(name), `actual source declaration ${name}`);
    vm.runInContext(declarations.get(name), context);
  }
  return { entry, context, read: () => plain(rows.get(entry.key)), outbox: () => [...operations.values()], mirrors,
    fail: () => { fail = true; }, edit: () => {
      const latest = rows.get(entry.key);
      rows.set(entry.key, { ...latest, translation: 'новый ручной перевод', translationSource: 'manual', translationDirty: true });
    } };
}

for (const result of ['remembered', 'forgotten']) for (const mode of ['scheduled', 'practice']) {
  test(`local ${mode} ${result} commits the reset and Undo restores marks without losing a later edit`, async () => {
    const f = fixture();
    const answer = await f.context.queueReviewDirect({ key: f.entry.key, result, mode, id: `full-${mode}-${result}` });
    assert.deepEqual(f.read().reviewSchedule.queue.meaningRecall, {});
    assert.deepEqual(plain(answer.entryBefore), f.entry);
    assert.deepEqual(f.mirrors[0].entries[0].reviewSchedule.queue.meaningRecall, {});
    assert.equal(f.outbox()[0].result, result);
    if (mode === 'practice') {
      assert.deepEqual(f.read().reviewSchedule.card, f.entry.reviewSchedule.card);
      assert.deepEqual(f.read().reviewSchedule.queue.recent, f.entry.reviewSchedule.queue.recent);
      assert.equal(f.read().reviewCount, f.entry.reviewCount);
    }
    f.edit();
    await f.context.undoReviewDirect({ key: f.entry.key, entryBefore: answer.entryBefore, operation: answer.operation });
    assert.deepEqual(f.read().reviewSchedule, f.entry.reviewSchedule);
    assert.equal(f.read().translation, 'новый ручной перевод');
    assert.equal(f.read().translationDirty, true);
    assert.equal(f.outbox().at(-1).type, 'undo-review');
    assert.deepEqual(f.mirrors.at(-1).entries[0].reviewSchedule.queue.meaningRecall, f.entry.reviewSchedule.queue.meaningRecall);
  });
}

test('a failed local review cannot clear marks or enqueue a review/native write', async () => {
  const f = fixture(); f.fail();
  await assert.rejects(f.context.queueReviewDirect({ key: f.entry.key, result: 'remembered' }), /aborted/);
  assert.deepEqual(f.read(), f.entry);
  assert.equal(f.outbox().length, 0);
  assert.equal(f.mirrors.length, 0);
});

test('Partial keeps its selected meanings and updates only the new assessment', async () => {
  const f = fixture();
  await f.context.queueReviewDirect({ key: f.entry.key, result: 'partial', meaningRecall: {
    assessed: ['two', 'three'], remembered: ['three'] } });
  const marks = f.read().reviewSchedule.queue.meaningRecall;
  assert.equal(marks.one.remembered, true);
  assert.equal(marks.two.remembered, false);
  assert.equal(marks.three.remembered, true);
});
