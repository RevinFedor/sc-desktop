const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'chatgpt-research.js'), 'utf8');
const exportMarker = "  if (document.readyState === 'loading') {";
const instrumented = source.replace(exportMarker, `
  globalThis.__chatgptModeExports = {
    modeFromControlText,
    modeFromControl,
    isModeControlChecked,
    chatgptModeControls,
    currentChatgptMode,
  };
${exportMarker}`);

const documentMock = {
  readyState: 'loading',
  controls: [],
  addEventListener() {},
  querySelectorAll() { return this.controls; },
  getElementById() { return null; },
};
const context = vm.createContext({
  URL,
  document: documentMock,
  window: {},
  chrome: { runtime: { onMessage: { addListener() {} } } },
});
vm.runInContext(instrumented, context);

const {
  modeFromControlText,
  isModeControlChecked,
  chatgptModeControls,
  currentChatgptMode,
} = context.__chatgptModeExports;

function control(text, attributes = {}, parentElement = null, left = 0) {
  return {
    textContent: text,
    tagName: 'BUTTON',
    parentElement,
    getAttribute(name) { return attributes[name] ?? null; },
    getBoundingClientRect() { return { top: 10, left, width: 100, height: 40 }; },
    getClientRects() { return [{}]; },
    closest() { return null; },
  };
}

test('ChatGPT mode labels support current Russian and English naming', () => {
  for (const label of ['Chat', 'Chats', 'Чат', 'Чаты', 'Режим: Чаты']) {
    assert.equal(modeFromControlText(label), 'chat', label);
  }
  for (const label of ['Work', 'Работа', 'Для работы', 'Рабочие чаты', 'Чаты работы', 'Режим: Работа']) {
    assert.equal(modeFromControlText(label), 'work', label);
  }
  assert.equal(modeFromControlText('Новый чат'), null);
});

test('selected mode supports radio, tab and generic toggle state attributes', () => {
  assert.equal(isModeControlChecked(control('Работа', { 'aria-checked': 'true' })), true);
  assert.equal(isModeControlChecked(control('Работа', { 'aria-selected': 'true' })), true);
  assert.equal(isModeControlChecked(control('Работа', { 'aria-pressed': 'true' })), true);
  assert.equal(isModeControlChecked(control('Работа', { 'data-state': 'active' })), true);
  assert.equal(isModeControlChecked(control('Работа', { class: 'foo selected bar' })), true);
});

test('ordinary Russian buttons form one Chat and Work toggle', () => {
  const parent = {};
  const chat = control('Чаты', { 'aria-pressed': 'false' }, parent, 0);
  const work = control('Работа', { 'aria-pressed': 'true' }, parent, 110);
  documentMock.controls = [chat, work];

  assert.deepEqual(Array.from(chatgptModeControls(), item => item.mode), ['chat', 'work']);
  assert.equal(currentChatgptMode(), 'work');
});

test('tablist fallback reads the single tabbable Russian mode', () => {
  const parent = {};
  const chat = control('Чаты', { role: 'tab', tabindex: '0' }, parent, 0);
  const work = control('Работа', { role: 'tab', tabindex: '-1' }, parent, 110);
  documentMock.controls = [chat, work];

  assert.equal(currentChatgptMode(), 'chat');
});
