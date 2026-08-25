const test = require('node:test');
const assert = require('node:assert/strict');

const {
  GUARDED_POINTER_EVENTS,
  scInstallNoPlaybackClick,
} = require('../pill-event-guard.js');

class FakeButton {
  constructor() {
    this.listeners = new Map();
    this.captured = [];
  }
  addEventListener(type, listener, options) {
    const list = this.listeners.get(type) || [];
    list.push({ listener, options });
    this.listeners.set(type, list);
  }
  setPointerCapture(pointerId) {
    this.captured.push(pointerId);
  }
  dispatch(type, overrides = {}) {
    const calls = { preventDefault: 0, stopPropagation: 0, stopImmediatePropagation: 0 };
    const event = {
      type,
      pointerId: overrides.pointerId,
      preventDefault() { calls.preventDefault++; },
      stopPropagation() { calls.stopPropagation++; },
      stopImmediatePropagation() { calls.stopImmediatePropagation++; },
    };
    for (const { listener } of this.listeners.get(type) || []) listener(event);
    return calls;
  }
}

test('the whole overlay pointer gesture is absorbed before YouTube can toggle playback', () => {
  const button = new FakeButton();
  scInstallNoPlaybackClick(button, () => {});

  for (const type of GUARDED_POINTER_EVENTS) {
    const calls = button.dispatch(type, type === 'pointerdown' ? { pointerId: 9 } : {});
    assert.equal(calls.preventDefault, 1, type);
    assert.equal(calls.stopPropagation, 1, type);
    assert.equal(calls.stopImmediatePropagation, 1, type);
  }
  assert.deepEqual(button.captured, [9]);
});

test('click runs the AI action once while remaining fully absorbed', () => {
  const button = new FakeButton();
  let clicks = 0;
  scInstallNoPlaybackClick(button, () => { clicks++; });
  scInstallNoPlaybackClick(button, () => { clicks += 100; });

  const calls = button.dispatch('click');
  assert.equal(clicks, 1);
  assert.equal(calls.preventDefault, 1);
  assert.equal(calls.stopPropagation, 1);
  assert.equal(calls.stopImmediatePropagation, 1);
});
