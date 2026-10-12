const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRound, nextSessionStats } = require('../study-model');
const at = Date.parse('2026-10-04T10:00:00Z');
const minute = 60_000, day = 86_400_000;
function entry(key, { phase = 2, cohort = 'active', due = at, last = at - day, count = 2 } = {}) {
  return { key, sourceText: key, state: 'saved', createdAt: at - 30 * day,
    reviewCount: count, dueAt: new Date(due).toISOString(), lastReviewedAt: last,
    reviewSchedule: { version: 1, card: { state: phase }, queue: { version: 1, cohort } } };
}

test('a due minute repeat precedes 400 older backlog/new words', () => {
  const others = Array.from({ length: 400 }, (_, i) => entry(`other-${i}`,
    i < 200 ? { cohort: 'backlog', due: at - 20 * day } : { cohort: 'new', count: 0 }));
  const failed = entry('failed', { phase: 1, last: at, due: at + minute });
  const entries = [...others, failed];
  const stats = nextSessionStats({}, 'failed', 'forgotten', at);
  stats.failed.nextEligibleAt = at + 10 * minute; // old cached client gate must have no effect
  assert.ok(!buildRound(entries, stats, '', at + minute - 1).includes('failed'));
  assert.equal(buildRound(entries, stats, '', at + minute)[0], 'failed');
  assert.equal(buildRound(entries, {}, '', at + 10 * minute)[0], 'failed', 'reopening uses the same schedule');
});

test('graduation to a day interval keeps the restored word before old debt, also a week later', () => {
  const backlog = Array.from({ length: 400 }, (_, i) => entry(`old-${i}`, { cohort: 'backlog', due: at - 30 * day }));
  const active = entry('restored', { due: at + day, last: at });
  assert.ok(!buildRound([...backlog, active], {}, '', at).includes('restored'));
  assert.equal(buildRound([...backlog, active], {}, '', at + day)[0], 'restored');
  assert.equal(buildRound([...backlog, active], {}, '', at + 8 * day)[0], 'restored');
});

test('400 stale learning steps cannot crowd out a freshly due short repeat', () => {
  const stale = Array.from({ length: 400 }, (_, i) => entry(`stale-${i}`,
    { phase: 1, cohort: 'active', last: at - 2 * day, due: at - 2 * day + 10 * minute }));
  const fresh = entry('fresh', { phase: 1, last: at - minute, due: at });
  assert.equal(buildRound([...stale, fresh], {}, '', at)[0], 'fresh');
  assert.equal(buildRound([...stale, fresh], {}, '', at).length, 401, 'old learning steps stay available as plan reviews');
});

test('a two-minute session does not invent early reviews or silently suspend failed words', () => {
  const waiting = Array.from({ length: 18 }, (_, i) => entry(`waiting-${i}`, { phase: 1, last: at, due: at + 10 * minute }));
  assert.deepEqual(buildRound(waiting, {}, '', at + 2 * minute), []);
  assert.equal(buildRound(waiting, {}, '', at + 10 * minute).length, 18);
  const overdue = waiting.map(x => ({ ...x, forgottenCount: 9 }));
  assert.equal(buildRound(overdue, {}, '', at + 10 * minute).length, 18);
});

test('within each due group time and identity give stable ordering without a full-deck pass', () => {
  const entries = [entry('new', { count: 0, cohort: 'new' }), entry('backlog', { cohort: 'backlog', due: at - 30 * day }),
    entry('active-later', { due: at - minute }), entry('active-earlier', { due: at - 2 * minute }),
    entry('learning', { phase: 1, last: at - minute, due: at })];
  assert.deepEqual(buildRound(entries, {}, '', at), ['learning', 'active-earlier', 'active-later', 'backlog', 'new']);
});
