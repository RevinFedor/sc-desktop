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
    isTemporaryChatPage,
    ensureChatgptModeSelected,
    modeFromControl,
    isModeControlChecked,
    chatgptModeControls,
    currentChatgptMode,
    modelKeyFromText,
    resolveModel,
    modelDisplay,
    currentModelKeyFromOpenMenu,
    findEffortSubTrigger,
    resolveEffort,
    resolveSpeed,
    speedLabel,
    latestApiTurnSnapshotFromData,
    terminalProofForCurrentPage,
    normalizeComposeDocument,
    normalizeComposeJobPayload,
    composeDocumentFile,
    composerFilePreviewState,
    composerHasFilePreview,
    isShowInTextFieldLabel,
    isPastedTextChipLabel,
    isPastedTextTooLongLabel,
    composerContainsInlineText,
    showPastedTextInComposer,
    trustedHover,
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
  performance,
  document: documentMock,
  window: {},
  location: { href: 'https://chatgpt.com/', hash: '', search: '' },
  chrome: {
    runtime: {
      lastError: null,
      onMessage: { addListener() {} },
      sendMessage(message, callback) {
        this.sentMessages.push(message);
        callback({ ok: true });
      },
      sentMessages: [],
    },
  },
});
vm.runInContext(instrumented, context);

const {
  modeFromControlText,
  isTemporaryChatPage,
  ensureChatgptModeSelected,
  isModeControlChecked,
  chatgptModeControls,
  currentChatgptMode,
  modelKeyFromText,
  resolveModel,
  modelDisplay,
  currentModelKeyFromOpenMenu,
  findEffortSubTrigger,
  resolveEffort,
  resolveSpeed,
  speedLabel,
  latestApiTurnSnapshotFromData,
  terminalProofForCurrentPage,
  normalizeComposeDocument,
  normalizeComposeJobPayload,
  composeDocumentFile,
  composerFilePreviewState,
  composerHasFilePreview,
  isShowInTextFieldLabel,
  isPastedTextChipLabel,
  isPastedTextTooLongLabel,
  composerContainsInlineText,
  showPastedTextInComposer,
  trustedHover,
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

test('temporary chat is already Chat and rejects Work without waiting for a missing toggle', async () => {
  context.window.location = { href: 'https://chatgpt.com/?temporary-chat=true&sc-compose=test' };
  context.location.href = context.window.location.href;
  context.location.search = '?temporary-chat=true&sc-compose=test';
  assert.equal(isTemporaryChatPage(), true);
  assert.equal(await ensureChatgptModeSelected('chat'), true);
  assert.equal(await ensureChatgptModeSelected('work'), false);
  context.window.location = { href: 'https://chatgpt.com/' };
  context.location.href = context.window.location.href;
  context.location.search = '';
});

test('temporary chat accepts the already-proven DOM final when no conversation URL exists', () => {
  context.window.location = { href: 'https://chatgpt.com/?temporary-chat=true' };
  context.location.href = context.window.location.href;
  context.location.search = '?temporary-chat=true';

  const temporary = terminalProofForCurrentPage({ ready: false, reason: 'conversation_url_pending' });
  assert.equal(temporary.ready, true);
  assert.equal(temporary.fallback, true);
  assert.equal(temporary.reason, 'temporary_chat_dom_final');

  context.window.location = { href: 'https://chatgpt.com/' };
  context.location.href = context.window.location.href;
  context.location.search = '';
  const ordinary = terminalProofForCurrentPage({ ready: false, reason: 'conversation_url_pending' });
  assert.equal(ordinary.ready, false);
  assert.equal(ordinary.fallback, undefined);
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
  assert.equal(modelKeyFromText('o3 Доступна до 26 августа'), 'o3');
});

test('current ChatGPT effort submenu uses the Усилие label', () => {
  const effort = control('УсилиеОчень высокий', { role: 'menuitem', 'aria-haspopup': 'menu' });
  documentMock.controls = [effort];
  assert.equal(findEffortSubTrigger(), effort);
});

test('retired Pro detail aliases collapse to the single current Pro option', () => {
  assert.equal(resolveEffort('pro-extended'), 'pro');
  assert.equal(resolveEffort('Pro расширенный'), 'pro');
});

test('Work speed defaults to quota-safer standard mode', () => {
  assert.equal(resolveSpeed(), 'standard');
  assert.equal(resolveSpeed('быстро'), 'fast');
  assert.equal(speedLabel('fast'), 'Быстро');
});

test('API terminal proof ignores commentary and returns only the final channel', () => {
  const userId = 'user';
  const contextId = 'context';
  const commentaryId = 'commentary';
  const finalId = 'final';
  const data = {
    title: 'Work test',
    current_node: finalId,
    mapping: {
      [userId]: {
        id: userId,
        parent: null,
        message: {
          author: { role: 'user' },
          content: { content_type: 'text', parts: ['task'] },
        },
      },
      [contextId]: {
        id: contextId,
        parent: userId,
        message: {
          author: { role: 'tool' },
          content: { content_type: 'context_stuff', parts: ['file contents must not leak'] },
          metadata: {},
        },
      },
      [commentaryId]: {
        id: commentaryId,
        parent: contextId,
        message: {
          author: { role: 'assistant' },
          channel: 'commentary',
          end_turn: false,
          status: 'finished_successfully',
          content: { content_type: 'text', parts: ['Думаю'] },
          metadata: { is_thinking_preamble_message: true },
        },
      },
      [finalId]: {
        id: finalId,
        parent: commentaryId,
        message: {
          author: { role: 'assistant' },
          channel: 'final',
          end_turn: true,
          status: 'finished_successfully',
          content: { content_type: 'text', parts: ['Полный финальный ответ'] },
          metadata: {},
        },
      },
    },
  };

  const snapshot = latestApiTurnSnapshotFromData(data);
  assert.equal(snapshot.ready, true);
  assert.equal(snapshot.message_id, finalId);
  assert.equal(snapshot.text, 'Полный финальный ответ');
  assert.equal(snapshot.reasoning_text, 'Думаю');
  assert.deepEqual(Array.from(snapshot.activity_items), []);
});

test('API terminal proof stays pending while Work has commentary only', () => {
  const data = {
    current_node: 'commentary',
    mapping: {
      user: {
        id: 'user', parent: null,
        message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['task'] } },
      },
      commentary: {
        id: 'commentary', parent: 'user',
        message: {
          author: { role: 'assistant' }, channel: 'commentary', end_turn: false,
          status: 'finished_successfully', content: { content_type: 'text', parts: ['Думаю'] }, metadata: {},
        },
      },
    },
  };
  const snapshot = latestApiTurnSnapshotFromData(data);
  assert.equal(snapshot.ready, false);
  assert.equal(snapshot.text, '');
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
  assert.equal(
    isPastedTextTooLongLabel('Открыть вложение со вставленным текстом. Превышает длину для отображения в текстовом поле'),
    true,
  );
  assert.equal(isPastedTextTooLongLabel('Pasted text. Too long to display in the text field'), true);
  assert.equal(isPastedTextTooLongLabel('Exceeds the length for display in the text field'), true);
  assert.equal(isPastedTextTooLongLabel('Показать в текстовом поле'), false);
});

test('Pasted Text hover uses a real debugger mouse move through background', async () => {
  const result = await trustedHover(control('Pasted text'));
  const message = context.chrome.runtime.sentMessages.at(-1);
  assert.equal(result.ok, true);
  assert.equal(message.__sc_trusted_hover, true);
  assert.equal(message.x, 50);
  assert.equal(message.y, 30);
});

test('oversized Pasted Text becomes a ready attachment without waiting for a missing show button', async () => {
  const prompt = 'Задача:\nперескажи видео';
  const chip = control('Вставленный текст', {
    'aria-label': 'Открыть вложение со вставленным текстом. Превышает длину для отображения в текстовом поле',
  });
  const form = {
    querySelectorAll() { return [chip]; },
  };
  documentMock.composer = {
    innerText: prompt,
    textContent: prompt,
    closest(selector) { return selector === 'form' ? form : null; },
  };

  const result = await showPastedTextInComposer(
    'oversized-job',
    `${prompt}\n\nИсходный материал:\nочень длинный текст`,
    prompt,
  );

  assert.equal(result.method, 'pasted_text_attachment');
  assert.equal(result.reason, 'too_long_for_text_field');
  documentMock.composer = null;
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
