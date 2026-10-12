const { test } = require('node:test');
const assert = require('node:assert/strict');
const FSRS = require('../vendor/ts-fsrs-5.4.1');
const Scheduler = require('../review-scheduler');
const Feed = require('../study-feed');
const now = Date.parse('2026-10-04T15:00:00Z'), minute = 60_000, day = 86_400_000;
const plain = value => JSON.parse(JSON.stringify(value));
function entry(key, cohort = 'new') {
  const card = plain(FSRS.createEmptyCard(new Date(now)));
  return { key, sourceText: key, state: 'saved', createdAt: now, dueAt: card.due, reviewCount: 0,
    reviewSchedule: { version: 1, card, parameters: FSRS.generatorParameters({ enable_fuzz: false }),
      queue: { version: 1, cohort, introducedAt: null } } };
}
function answer(entry, result, time, durationMs = 5000, id = `${entry.key}:${time}`) {
  const schedule = Scheduler.project(entry.reviewSchedule, result, time, { id, durationMs, recallVersion: 1 });
  Object.assign(entry, { reviewSchedule: schedule, dueAt: schedule.card.due, reviewCount: entry.reviewCount + 1, lastReviewedAt: time });
}
test('automatic admission protects due repeats, preserves future progress and alternates intake sources', () => {
  const fresh = entry('fresh'), old = entry('old', 'backlog'), active = entry('started');
  answer(active, 'forgotten', now);
  const before = JSON.stringify([fresh, old, active]);
  const first = Feed.plan([fresh, old, active], now);
  assert.equal(first.keys[0], 'old');
  assert.equal(JSON.stringify([fresh, old, active]), before, 'forecast never mutates real cards');
  answer(old, 'remembered', now + 5000);
  assert.equal(Feed.plan([fresh, old, active], now + 5000).keys[0], 'fresh');
  assert.equal(Feed.plan([fresh, old, active], now + minute).keys[0], 'started');
  assert.equal(Feed.progress([fresh, old, active], now).length, 2);
  answer(active, 'remembered', now + minute);
  answer(active, 'remembered', now + 11 * minute);
  assert.equal(active.reviewSchedule.card.state, 2);
  assert.ok(Feed.progress([active], now + 11 * minute).some(item => item.key === 'started'));
  assert.deepEqual(Feed.plan(plain([active]), now + 8 * day).keys, ['started']);
});
test('imminent, unknown and unsynced obligations cannot be treated as free capacity', () => {
  const active = entry('active'), fresh = entry('fresh');
  answer(active, 'forgotten', now);
  assert.equal(Feed.plan([active, fresh], now + minute - 1000).reason, 'imminent');
  active.reviewSchedule.pending = true;
  assert.deepEqual(Feed.plan([active, fresh], now).keys, []);
  assert.equal(Feed.plan([active, fresh], now).reason, 'sync');
});
test('tempo comes from measured foreground duration, not elapsed calendar time', () => {
  const item = entry('word');
  answer(item, 'remembered', now, 5000);
  answer(item, 'remembered', now + 10 * minute, 5000);
  const fast = Feed.profile([item], now + 10 * minute);
  assert.ok(fast.repeatMs < 20_000);
  const afterWeek = Feed.profile([item], now + 7 * day);
  assert.ok(afterWeek.repeatMs > fast.repeatMs);
  assert.ok(afterWeek.repeatMs < 20_000);
  assert.equal(item.reviewSchedule.queue.recent.length, 2);
});

test('a long reading episode cannot lock new intake when all obligations are beyond the forecast horizon', () => {
  const active = entry('long-reading'), fresh = entry('fresh');
  answer(active, 'remembered', now, 3_600_000);
  answer(active, 'remembered', now + 10 * minute, 3_600_000);
  assert.equal(active.reviewSchedule.card.state, 2);
  const next = Feed.plan([active, fresh], now + 10 * minute);
  assert.deepEqual(next.keys, ['fresh']);
  assert.equal(next.reason, 'probe');
  active.reviewSchedule.pending = true;
  assert.deepEqual(Feed.plan([active, fresh], now + 10 * minute).keys, [], 'unknown pending obligations are not an empty forecast');
});
test('new intake responds to speed and outcomes, without a session/day card cap', () => {
  const reports = [];
  for (const duration of [5000, 40000]) for (const pattern of [['forgotten'], ['remembered'], ['partial', 'forgotten']]) {
    const entries = Array.from({ length: 500 }, (_, i) => entry(`word-${String(i).padStart(3, '0')}`));
    let time = now, answers = 0, waitingMs = 0, maxDelay = 0, seen = new Set();
    const started = performance.now();
    while (time < now + 30 * minute) {
      const plan = Feed.plan(entries, time);
      if (!plan.keys.length) {
        const delay = Math.min(5000, Math.max(1, plan.nextDue - time));
        waitingMs += delay; time += delay; continue;
      }
      const item = entries.find(item => item.key === plan.keys[0]);
      if (item.reviewCount) maxDelay = Math.max(maxDelay, time - Date.parse(item.dueAt));
      time += duration; seen.add(item.key);
      answer(item, pattern[answers++ % pattern.length], time, duration);
    }
    reports.push({ duration, pattern: pattern.join('/'), introduced: seen.size, answers, waitingMs, maxDelay,
      cpuMs: Math.round(performance.now() - started) });
    assert.ok(answers > 5, 'no five-answer cap');
    assert.ok(seen.size < 500, 'failed learning does not run through the dictionary');
    assert.ok(maxDelay <= duration * 3, 'due short repeats are not crowded out');
  }
  assert.ok(reports[1].introduced > reports[0].introduced, 'successful recall admits more words');
  assert.ok(reports[1].waitingMs < 10 * minute, 'fast successful recall must not spend the session in a forecast-induced idle lock');
  assert.ok(reports[0].introduced > reports[3].introduced, 'a faster pace is not assigned the same pool size');
  console.log(JSON.stringify({ simulations: reports }));
});

test('a logged profile without an explicit clock remains finite with real review history', () => {
  const word = entry('well'); answer(word, 'partial', now, 7000);
  const clock = Date.now; Date.now = () => now + minute;
  try {
    const implicit = Feed.profile([word]);
    assert.deepEqual(implicit, Feed.profile([word], Date.now()));
    assert.deepEqual(Feed.profile([word], NaN), implicit);
    assert.ok([implicit.introductionMs, implicit.repeatMs, ...implicit.probabilities].every(Number.isFinite));
  } finally { Date.now = clock; }
});
