const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { fixture } = require('./helpers/chatgpt-flow-fixture.cjs');

const source = fs.readFileSync(path.join(__dirname, '..', 'chatgpt-research.js'), 'utf8');
const marker = "  if (document.readyState === 'loading') {";

// Exercise the real selection functions with independent UI events. Like the
// live picker, both tracks keep their rects; only the inactive one is inert.
function pickerFixture({ initial = 3, version = '6', blockedClick = false, stalledView = false,
  modelLabel = 'Latest', effortOnly = false, initialModel = 'latest' } = {}) {
  const { clock, Element } = fixture();
  const nodes = [], clicks = [], logs = [];
  function node(tag, attrs = {}, text = '', parent = null) {
    const el = new Element(tag, attrs, text);
    Object.defineProperty(el, 'className', { get: () => el.getAttribute('class') || '' });
    const x = nodes.length * 120;
    el.getBoundingClientRect = () => {
      let shown = true;
      for (let p = el; p; p = p.parentElement) if (!p.visible) shown = false;
      return { x, y: 0, width: shown ? 100 : 0, height: shown ? 30 : 0 };
    };
    el.getClientRects = () => el.getBoundingClientRect().width ? [{}] : [];
    nodes.push(el);
    if (parent) parent.appendChild(el);
    return el;
  }
  const body = node('body');
  const composer = node('form', {}, '', body);
  const editor = node('div', { id: 'prompt-textarea', contenteditable: 'true' }, '', composer);
  let sends = 0;
  const send = node('button', { 'data-testid': 'send-button' }, '', composer);
  send.handlers.click = () => sends++;
  const trigger = node('button', { 'aria-haspopup': 'menu', 'aria-expanded': 'false',
    'data-codex-intelligence-trigger': 'true' }, '', composer);
  const menu = node('div', { role: 'menu' }, '', body);
  menu.visible = false;
  const picker = node('div', { 'data-model-picker-view': 'simple' }, '', menu);
  const simple = node('div', {}, '', picker);
  const modelList = node('div', { inert: '' }, '', picker);
  const toggle = node('div', { role: 'menuitem', 'aria-label': 'Выбрать модель',
    'data-model-picker-view-toggle': 'true' }, '', simple);
  const power = node('div', { role: 'menuitem', 'data-reasoning-slider': 'true' }, '', simple);
  const slider = node('span', { role: 'slider', 'aria-hidden': 'true',
    'aria-valuemin': '0', 'aria-valuemax': '4', 'aria-valuenow': String(initial) }, '', power);
  const latest = node('div', { role: 'menuitemradio', 'aria-checked': 'true',
    'data-model-selected': 'true' }, modelLabel, modelList);
  const sol = node('div', { role: 'menuitemradio', 'aria-checked': 'false' }, 'GPT-5.6 Sol', modelList);
  let selected = initialModel === '5.6-sol' ? sol : latest;
  const labels = ['Instant', 'Medium', 'High', 'Extra High', 'Pro'];
  const setValue = value => {
    slider.setAttribute('aria-valuenow', value);
    toggle.textContent = selected === sol ? `5.6 Sol${labels[value]}`
      : effortOnly ? labels[value] : value === 4 ? `${version}Pro` : labels[value];
  };
  const select = row => {
    selected = row;
    for (const item of [latest, sol]) {
      item.setAttribute('aria-checked', String(item === row));
      if (item === row) item.setAttribute('data-model-selected', 'true');
      else item.removeAttribute('data-model-selected');
    }
    setValue(Number(slider.getAttribute('aria-valuenow')));
  };
  select(selected);
  setValue(initial);
  for (let i = 0; i < 5; i++) {
    const tick = node('span', { class: 'Tick-fixture' }, '', power);
    tick.handlers.click = () => setValue(i);
  }
  function setView(view) {
    picker.setAttribute('data-model-picker-view', view);
    if (view === 'simple') { simple.removeAttribute('inert'); modelList.setAttribute('inert', ''); }
    else { simple.setAttribute('inert', ''); modelList.removeAttribute('inert'); }
  }
  const close = () => { menu.visible = false; trigger.setAttribute('aria-expanded', 'false'); };
  trigger.handlers.click = () => { menu.visible = true; trigger.setAttribute('aria-expanded', 'true'); };
  toggle.handlers.click = () => setView('advanced');
  latest.handlers.click = () => { select(latest); if (!stalledView) setView('simple'); };
  sol.handlers.click = () => { select(sol); if (!stalledView) setView('simple'); };
  const document = {
    body, readyState: 'loading', addEventListener() {},
    querySelectorAll: selector => body.querySelectorAll(selector),
    querySelector: selector => body.querySelector(selector),
    getElementById: id => nodes.find(el => el.id === id) || null,
    dispatchEvent(event) { if (event.type === 'keydown' && event.key === 'Escape') close(); },
  };
  class Event { constructor(type, options) { this.type = type; Object.assign(this, options); } }
  const context = vm.createContext({ document, window: {}, URL,
    location: { href: 'https://chatgpt.com/', search: '', hash: '' },
    performance: { now: clock.now }, Date: { now: clock.now },
    setTimeout: clock.setTimeout, setInterval: clock.setInterval,
    clearTimeout: clock.clearTimeout, clearInterval: clock.clearInterval,
    MouseEvent: Event, KeyboardEvent: Event,
    console: { log: (...entry) => logs.push(entry) },
    chrome: { runtime: { lastError: null, onMessage: { addListener() {} },
      sendMessage(message, callback) {
        assert.equal(message.__sc_trusted_click, true, 'configuration must only use the trusted click channel');
        const el = nodes.find(el => {
          const r = el.getBoundingClientRect();
          return r.width && r.x + r.width / 2 === message.x && r.y + r.height / 2 === message.y;
        });
        assert.ok(el, 'trusted target must have a real rect');
        assert.equal(el.closest('[inert]'), null, 'never click an inactive track');
        clicks.push(el);
        if (blockedClick) callback({ ok: false, err: 'click rejected' });
        else { el.click(); callback({ ok: true }); }
      },
    } },
    fetch: async () => ({ ok: true }),
  });
  vm.runInContext(source.replace(marker, `
    globalThis.pickerFlow = { ensureModelSelected, ensureEffortSelected,
      verifyChatgptSelection, findEffortSlider, currentModelKeyFromOpenMenu,
      currentEffortKeyFromOpenMenu };
  ${marker}`), context);
  async function run(promise) { await clock.advance(60000); return promise; }
  return { ...context.pickerFlow, run, menu, picker, latest, sol, slider, toggle, modelList,
    setView, close, clicks, logs, editor, sends: () => sends };
}

test('GPT-6 effort-only picker accepts all five Chat levels without equating Extra High with Astra Pro', async () => {
  for (const [index, effort] of ['instant', 'medium', 'high', 'xhigh', 'pro'].entries()) {
    const f = pickerFixture({ modelLabel: 'GPT-6', effortOnly: true, initial: index });
    assert.equal(await f.run(f.ensureModelSelected('6', 'chat')), true, effort);
    assert.equal(await f.run(f.ensureEffortSelected(effort, 'chat', '6')), true, effort);
    assert.equal(await f.run(f.verifyChatgptSelection('chat', '6', effort)), true, effort);
    if (effort !== 'pro') {
      assert.equal(await f.run(f.verifyChatgptSelection('chat', '6-astra', 'pro')), false);
    }
    assert.equal(f.editor.textContent, '');
    assert.equal(f.sends(), 0);
  }
});

test('sticky Sol/Medium → GPT-6/Extra High changes both axes and verifies the selected radio', async () => {
  const f = pickerFixture({ modelLabel: 'GPT-6', effortOnly: true, initialModel: '5.6-sol', initial: 1 });
  assert.equal(await f.run(f.ensureModelSelected('6', 'chat')), true);
  assert.equal(await f.run(f.ensureEffortSelected('xhigh', 'chat', '6')), true);
  assert.equal(await f.run(f.verifyChatgptSelection('chat', '6', 'xhigh')), true);
  assert.equal(f.latest.getAttribute('aria-checked'), 'true');
  assert.equal(f.sol.getAttribute('aria-checked'), 'false');
  assert.equal(f.slider.getAttribute('aria-valuenow'), '3');
  assert.equal(f.sends(), 0);
});

test('existing Astra/Pro request still selects GPT-6 Pro from the new effort-only picker', async () => {
  const f = pickerFixture({ modelLabel: 'GPT-6', effortOnly: true, initial: 3 });
  assert.equal(await f.run(f.ensureModelSelected('6-astra', 'chat')), true);
  assert.equal(await f.run(f.ensureEffortSelected('pro', 'chat', '6-astra')), true);
  assert.equal(await f.run(f.verifyChatgptSelection('chat', '6-astra', 'pro')), true);
  assert.equal(await f.run(f.verifyChatgptSelection('chat', '6-astra', 'xhigh')), false);
  assert.equal(f.sends(), 0);
});

test('wrong sticky Sol, a future GPT-7, and conflicting selected rows cannot prove GPT-6', async () => {
  for (const options of [
    { modelLabel: 'GPT-6', initialModel: '5.6-sol' },
    { modelLabel: 'GPT-7' },
  ]) {
    const f = pickerFixture({ ...options, effortOnly: true });
    assert.equal(await f.run(f.verifyChatgptSelection('chat', '6', 'xhigh')), false);
    assert.equal(f.sends(), 0);
  }
  const f = pickerFixture({ modelLabel: 'GPT-6', effortOnly: true });
  f.sol.setAttribute('aria-checked', 'true');
  f.sol.setAttribute('data-model-selected', 'true');
  assert.equal(await f.run(f.verifyChatgptSelection('chat', '6', 'xhigh')), false);
  assert.equal(f.sends(), 0);
});

test('Latest/xhigh → select Astra → return from model view → Pro → exact guard, without Send', async () => {
  const f = pickerFixture();
  assert.equal(await f.run(f.ensureModelSelected('6-astra', 'chat')), true);
  assert.equal(f.picker.getAttribute('data-model-picker-view'), 'advanced');
  assert.equal(await f.run(f.ensureEffortSelected('pro', 'chat', '6-astra')), true, JSON.stringify(f.logs));
  assert.equal(f.slider.getAttribute('aria-valuenow'), '4');
  assert.equal(await f.run(f.verifyChatgptSelection('chat', '6-astra', 'pro')), true);
  assert.ok(f.clicks.includes(f.latest), 'the already checked model returns to the effort view');
  assert.equal(f.latest.getAttribute('aria-checked'), 'true');
  assert.equal(f.editor.textContent, '');
  assert.equal(f.sends(), 0);
});

test('already selected Astra Pro accepts the aria-hidden slider thumb, with no model/effort clicks', async () => {
  const f = pickerFixture({ initial: 4 });
  assert.equal(await f.run(f.ensureModelSelected('6-astra', 'chat')), true);
  assert.equal(await f.run(f.ensureEffortSelected('pro', 'chat', '6-astra')), true);
  assert.equal(await f.run(f.verifyChatgptSelection('chat', '6-astra', 'pro')), true);
  assert.equal(f.clicks.length, 0);
  assert.equal(f.sends(), 0);
});

test('the final guard normalizes an advanced view but still rejects a future Latest/7Pro', async () => {
  const f = pickerFixture({ initial: 4, version: '7' });
  f.setView('advanced');
  assert.equal(await f.run(f.verifyChatgptSelection('chat', '6-astra', 'pro')), false);
  assert.equal(f.picker.getAttribute('data-model-picker-view'), 'simple');
  assert.equal(f.slider.getAttribute('aria-valuenow'), '4');
  assert.equal(f.editor.textContent, '');
  assert.equal(f.sends(), 0);
});

test('a rejected trusted view-return never accepts the inert Pro slider', async () => {
  const f = pickerFixture({ initial: 4, blockedClick: true });
  f.setView('advanced');
  assert.equal(await f.run(f.ensureEffortSelected('pro', 'chat', '6-astra')), false);
  assert.equal(f.findEffortSlider(), null);
  assert.equal(f.editor.textContent, '');
  assert.equal(f.sends(), 0);
});

test('a click ACK without the actual simple-view transition is not effort proof', async () => {
  const f = pickerFixture({ initial: 4, stalledView: true });
  f.setView('advanced');
  assert.equal(await f.run(f.ensureEffortSelected('pro', 'chat', '6-astra')), false);
  assert.equal(f.picker.getAttribute('data-model-picker-view'), 'advanced');
  assert.equal(f.sends(), 0);
});

test('legacy flat model/Pro radios still verify without a modern two-view picker', async () => {
  const f = pickerFixture({ initial: 4 });
  f.picker.removeAttribute('data-model-picker-view');
  f.slider.remove();
  f.latest.textContent = 'GPT-6 Astra';
  f.modelList.removeAttribute('inert');
  f.menu.appendChild(new f.latest.constructor('div', { role: 'menuitemradio',
    'aria-checked': 'true' }, 'Pro'));
  assert.equal(await f.run(f.ensureEffortSelected('pro', 'chat', '6-astra')), true);
  assert.equal(await f.run(f.verifyChatgptSelection('chat', '6-astra', 'pro')), true);
  assert.equal(f.clicks.length, 0);
  assert.equal(f.sends(), 0);
});

test('ambiguous selected model rows do not allow a view-return or Pro acceptance', async () => {
  const f = pickerFixture({ initial: 4 });
  f.setView('advanced');
  const duplicate = new f.latest.constructor('div', { role: 'menuitemradio', 'aria-checked': 'true',
    'data-model-selected': 'true' }, 'GPT-5.6 Sol');
  f.modelList.appendChild(duplicate);
  assert.equal(await f.run(f.ensureEffortSelected('pro', 'chat', '6-astra')), false);
  assert.equal(f.clicks.length, 0);
  assert.equal(f.sends(), 0);
});

test('both research and YouTube entrypoints keep the exact guard ahead of upload/paste/Send', () => {
  for (const name of ['main', 'runComposeHandoff']) {
    const start = source.indexOf(`async function ${name}(`);
    const body = source.slice(start, source.indexOf('\n  async function ', start + 1) > 0
      ? source.indexOf('\n  async function ', start + 1) : source.length);
    const guard = body.indexOf('if (!await verifyChatgptSelection(mode, modelKey, effortKey))');
    assert.ok(guard >= 0, `${name}: exact pair guard remains mandatory`);
    assert.ok(body.indexOf('pasteIntoComposer(', guard) > guard, `${name}: paste follows guard`);
    assert.match(body.slice(guard, body.indexOf('pasteIntoComposer(', guard)), /return;|throw new Error/);
  }
});
