const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const server = require('../vendor/ts-fsrs-5.4.1');
const projection = require('../review-scheduler');
const parameters = server.generatorParameters({ enable_fuzz: false });
const ratings = { forgotten: server.Rating.Again, partial: server.Rating.Hard,
  remembered: server.Rating.Good, known: server.Rating.Easy };
const plain = value => JSON.parse(JSON.stringify(value));

test('offline projection matches Voice FSRS across learning, relearning, days and reloads', () => {
  let at = Date.parse('2026-10-04T10:00:00Z');
  let card = server.createEmptyCard(new Date(at));
  let schedule = { version: 1, card: plain(card), parameters,
    queue: { version: 1, cohort: 'new', introducedAt: null } };
  const results = ['forgotten', 'partial', 'remembered', 'remembered', 'remembered', 'forgotten',
    'remembered', 'known', 'partial', 'remembered'];
  for (let i = 0; i < 80; i++) {
    const result = results[i % results.length];
    const next = server.fsrs(parameters).next(card, new Date(at), ratings[result]).card;
    schedule = plain(projection.project(plain(schedule), result, at));
    assert.deepEqual(schedule.card, plain(next), `answer ${i}: ${result}`);
    assert.equal(schedule.queue.cohort, 'active');
    assert.equal(schedule.queue.introducedAt, Date.parse('2026-10-04T10:00:00Z'));
    card = next;
    at = new Date(next.due).getTime() + (i % 3) * 60_000;
  }
});

test('the browser/worker build supplies the same scheduler without Node globals', () => {
  const context = vm.createContext({});
  for (const file of ['vendor/ts-fsrs-5.4.1.js', 'review-scheduler.js']) {
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'), context);
  }
  const at = Date.parse('2026-10-04T10:00:00Z');
  const schedule = { version: 1, card: plain(server.createEmptyCard(new Date(at))), parameters };
  for (const result of Object.keys(ratings)) {
    assert.deepEqual(plain(context.__scReviewScheduler.project(schedule, result, at)), projection.project(schedule, result, at));
  }
});

test('a legacy snapshot without canonical FSRS state cannot pretend to be an exact projection', () => {
  assert.equal(projection.project(null, 'forgotten', Date.now()), null);
  assert.equal(projection.project({ version: 2 }, 'remembered', Date.now()), null);
});

for (const result of ['remembered', 'forgotten']) {
  test(`${result} clears all partial annotations while preserving the partial history and exact FSRS card`, () => {
    const at = Date.parse('2026-10-09T10:00:00Z');
    const partial = projection.project({ version: 1, card: plain(server.createEmptyCard(new Date(at))), parameters },
      'partial', at, { id: 'partial-two', meaningRecall: {
        assessed: ['one', 'two', 'three', 'hidden-support'], remembered: ['one', 'two', 'hidden-support'] } });
    const before = plain(partial);
    const full = projection.project(partial, result, at + 1000, { id: `full-${result}`,
      meaningRecall: { assessed: ['one'], remembered: ['one'] } });
    assert.deepEqual(full.queue.meaningRecall, {});
    assert.deepEqual(full.queue.recent[0], before.queue.recent[0]);
    assert.equal(full.queue.recent[0].rememberedMeanings, 3);
    assert.deepEqual(partial, before, 'the Undo snapshot remains intact');
    assert.deepEqual(full.card, plain(server.fsrs(parameters).next(partial.card, new Date(at + 1000), ratings[result]).card));
    const context = vm.createContext({});
    for (const file of ['vendor/ts-fsrs-5.4.1.js', 'study-state.js', 'review-scheduler.js']) {
      vm.runInContext(fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'), context);
    }
    assert.deepEqual(plain(context.__scReviewScheduler.project(plain(partial), result, at + 1000,
      { id: `full-${result}`, meaningRecall: { assessed: ['one'], remembered: ['one'] } })), full);
    const nextPartial = projection.project(full, 'partial', at + 2000, {
      id: 'new-partial', meaningRecall: { assessed: ['one', 'two', 'three'], remembered: ['three'] } });
    assert.deepEqual(Object.keys(nextPartial.queue.meaningRecall).sort(), ['one', 'three', 'two']);
    assert.equal(nextPartial.queue.meaningRecall.three.remembered, true);
    assert.equal(nextPartial.queue.meaningRecall.one.remembered, false);
  });
}
