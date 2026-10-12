const test = require('node:test');
const assert = require('node:assert/strict');
const createGesture = require('../learning-word-gesture');
function fixture() {
  const selected = [], ranges = [], timers = new Map(); let id = 0;
  const gesture = createGesture({ getText: () => 'one two three', onSelect: part => selected.push(part),
    onRange: range => ranges.push(range),
    setTimer: fn => { timers.set(++id, fn); return id; }, clearTimer: key => timers.delete(key) });
  return { selected, ranges, gesture, flush() { for (const fn of timers.values()) fn(); timers.clear(); } };
}
test('a word in a live sentence opens immediately, so later text renders cannot cancel it', () => {
  const f = fixture(); f.gesture.click({ text: 'one', start: 0, end: 3 }, { immediate: true });
  assert.equal(f.selected[0].word, 'one');
  f.gesture.reset({ keepPending: true }); f.flush(); assert.equal(f.selected.length, 1);
});
test('repainting a nested example preserves the click, but closing its card cancels it', () => {
  for (const connected of [true, false]) {
    const f = fixture(), owner = { isConnected: true };
    f.gesture.click({ text: 'two', start: 4, end: 7, owner });
    f.gesture.reset({ keepPending: true });
    owner.isConnected = connected; f.flush();
    assert.equal(f.selected.length, connected ? 1 : 0);
  }
});
test('double click cancels deferred navigation and the next ordinary click finishes a phrase', () => {
  const f = fixture(), part = { text: 'one', start: 0, end: 3 };
  f.gesture.click(part); f.gesture.click(part, { detail: 2 }); f.gesture.doubleClick(part);
  f.flush(); assert.equal(f.selected.length, 0);
  f.gesture.click({ text: 'three', start: 8, end: 13, entry: { id: 'saved-three', state: 'saved' } });
  assert.equal(f.selected[0].word, 'one two three');
  assert.equal(f.selected[0].kind, 'phrase');
  assert.equal(f.selected[0].entry, null, 'a phrase must not inherit Saved from its final word');
  assert.deepEqual(f.ranges.at(-1), { start: 0, end: 13 }, 'opening the phrase keeps its highlight');
  f.selected[0].clearRange(); assert.equal(f.ranges.at(-1), null);
});
test('two touch clicks with detail=1 start a range without a native dblclick', () => {
  const f = fixture(), one = { text: 'one', start: 0, end: 3 };
  f.gesture.click(one, { pointerType: 'touch', timeStamp: 100, immediate: true });
  const oldSelection = f.selected[0];
  f.gesture.click(one, { pointerType: 'touch', timeStamp: 250, immediate: true });
  oldSelection.clearRange();
  assert.deepEqual(f.ranges.at(-1), { start: 0, end: 3 });
  f.gesture.click({ text: 'three', start: 8, end: 13 }, { pointerType: 'touch', timeStamp: 400, immediate: true });
  assert.equal(f.selected.at(-1).word, 'one two three');
  oldSelection.clearRange(); assert.deepEqual(f.ranges.at(-1), { start: 0, end: 13 });
  f.gesture.click(one, { immediate: true }); assert.equal(f.selected.at(-1).kind, 'word');
  assert.equal(f.ranges.at(-1), null, 'completed range is not a pending anchor');
});
test('a slow second tap is an ordinary word click', () => {
  const f = fixture(), one = { text: 'one', start: 0, end: 3 };
  for (const timeStamp of [100, 650]) f.gesture.click(one, { pointerType: 'touch', timeStamp, immediate: true });
  assert.equal(f.selected.length, 2); assert.equal(f.ranges.at(-1), null);
});
