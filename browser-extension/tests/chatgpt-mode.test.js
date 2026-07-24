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
    modelKeyFromText,
    resolveModel,
    modelDisplay,
    normalizeComposeDocument,
    normalizeComposeJobPayload,
    composeDocumentFile,
    composerFilePreviewState,
    composerHasFilePreview,
    isShowInTextFieldLabel,
    isPastedTextChipLabel,
    composerContainsInlineText,
  };
${exportMarker}`);

class FakeFile {
  constructor(parts, name, options = {}) {
    this.parts = parts;
    this.name = name;
    this.type = options.type || '';
  }
}

const documentMock = {
  readyState: 'loading',
  controls: [],
  composer: null,
  addEventListener() {},
  querySelectorAll() { return this.controls; },
  getElementById(id) { return id === 'prompt-textarea' ? this.composer : null; },
};
const context = vm.createContext({
  URL,
  File: FakeFile,
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
  modelKeyFromText,
  resolveModel,
  modelDisplay,
  normalizeComposeDocument,
  normalizeComposeJobPayload,
  composeDocumentFile,
  composerFilePreviewState,
  composerHasFilePreview,
  isShowInTextFieldLabel,
  isPastedTextChipLabel,
  composerContainsInlineText,
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

test('GPT-5.6 model labels distinguish Sol, Terra and Luna', () => {
  assert.equal(modelKeyFromText('GPT-5.6 Sol'), '5.6-sol');
  assert.equal(modelKeyFromText('GPT-5.6 Terra'), '5.6-terra');
  assert.equal(modelKeyFromText('GPT-5.6 Luna'), '5.6-luna');
  assert.equal(modelKeyFromText('Sol'), '5.6-sol');
  assert.equal(modelKeyFromText('Terra'), '5.6-terra');
  assert.equal(modelKeyFromText('Luna'), '5.6-luna');
  assert.equal(modelKeyFromText('GPT-5.5 Instant'), '5.5');
});

test('legacy numeric GPT-5.6 resolves to Sol', () => {
  assert.equal(resolveModel('5.6'), '5.6-sol');
  assert.equal(resolveModel('GPT-5.6 Terra'), '5.6-terra');
  assert.equal(modelDisplay('5.6-luna'), 'GPT-5.6 Luna');
});

test('compose job accepts a document with a separate empty prompt', () => {
  const job = normalizeComposeJobPayload({
    prompt: '   ',
    document: {
      name: 'video.txt',
      mime: 'text/plain',
      text: 'transcript',
    },
  }, 'job-1');

  assert.equal(job.prompt, '');
  assert.equal(job.document.name, 'video.txt');
  assert.equal(job.document.text, 'transcript');
  assert.equal(job.showInTextField, false);
});

test('compose job preserves legacy prompt-only payload and rejects an empty payload', () => {
  const legacy = normalizeComposeJobPayload({ prompt: '  перескажи  ' }, 'legacy');
  assert.equal(legacy.prompt, 'перескажи');
  assert.equal(legacy.document, null);
  assert.throws(
    () => normalizeComposeJobPayload({ prompt: ' ', document: { text: ' ' } }, 'empty'),
    /compose_job_missing_or_empty: empty/,
  );
});

test('compose document normalizes unsafe path separators without logging content', () => {
  const document = normalizeComposeDocument({
    name: '../private\\transcript.txt',
    mime: '',
    text: 'secret transcript',
  });
  assert.equal(document.name, '_private_transcript.txt');
  assert.equal(document.mime, 'text/plain;charset=utf-8');
  assert.equal(document.text, 'secret transcript');
});

test('compose document becomes a UTF-8 text File without merging the prompt', () => {
  const file = composeDocumentFile({
    name: 'video.txt',
    mime: 'text/plain;charset=utf-8',
    text: 'transcript only',
  });
  assert.equal(file.name, 'video.txt');
  assert.equal(file.type, 'text/plain;charset=utf-8');
  assert.equal(file.parts.length, 1);
  assert.equal(file.parts[0], 'transcript only');
});

test('attachment proof requires a new preview, not the permanent upload control', () => {
  const preview = { text: '', candidates: 1, images: 0 };
  const root = {
    get textContent() { return preview.text; },
    querySelectorAll(selector) {
      const count = selector === 'img' ? preview.images : preview.candidates;
      return Array.from({ length: count }, () => ({}));
    },
  };
  documentMock.composer = { closest: () => root };
  const files = [{ name: 'video.txt', type: 'text/plain' }];
  const baseline = composerFilePreviewState(files);

  assert.equal(composerHasFilePreview(files, baseline), false);
  preview.candidates = 2;
  assert.equal(composerHasFilePreview(files, baseline), true);
  preview.candidates = 1;
  preview.text = 'video.txt';
  assert.equal(composerHasFilePreview(files, baseline), true);
  documentMock.composer = null;
});

test('show-in-text-field controls support current Russian and English labels', () => {
  assert.equal(isShowInTextFieldLabel('Показать в текстовом поле'), true);
  assert.equal(isShowInTextFieldLabel('Show in text field'), true);
  assert.equal(isShowInTextFieldLabel('Insert as text'), true);
  assert.equal(isShowInTextFieldLabel('Удалить файл'), false);
  assert.equal(isPastedTextChipLabel('Pasted text'), true);
  assert.equal(isPastedTextChipLabel('Вставленный текст'), true);
});

test('compose job enables inline mode only when explicitly requested', () => {
  const job = normalizeComposeJobPayload({
    prompt: 'перескажи',
    showInTextField: true,
    document: { name: 'video.txt', text: 'transcript' },
  }, 'inline-job');
  assert.equal(job.showInTextField, true);
});

test('inline composer verification requires both beginning and end of long text', () => {
  const expected = `Задача: перескажи\n${'source '.repeat(300)}конец материала`;
  documentMock.composer = {
    innerText: expected,
    textContent: expected,
    closest: () => null,
  };
  assert.equal(composerContainsInlineText(expected), true);
  documentMock.composer.innerText = expected.slice(0, 500);
  assert.equal(composerContainsInlineText(expected), false);
  documentMock.composer = null;
});
