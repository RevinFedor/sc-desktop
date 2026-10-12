const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { fixture } = require('./helpers/chatgpt-flow-fixture.cjs');

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
    chatgptSelectionError,
    currentModelKeyFromOpenMenu,
    findEffortSubTrigger,
    currentEffortKeyFromOpenMenu,
    effortKeyFromSliderValue,
    effortSliderValueForKey,
    resolveEffort,
    resolveSpeed,
    speedLabel,
    speedKeyFromFastModeToggle,
    latestApiTurnSnapshotFromData,
    buildChatGPTApiMarkdown,
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
  chatgptSelectionError,
  currentModelKeyFromOpenMenu,
  findEffortSubTrigger,
  currentEffortKeyFromOpenMenu,
  effortKeyFromSliderValue,
  effortSliderValueForKey,
  resolveEffort,
  resolveSpeed,
  speedLabel,
  speedKeyFromFastModeToggle,
  latestApiTurnSnapshotFromData,
  buildChatGPTApiMarkdown,
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

test('a normal Chat home with an enable-temporary-chat button is still eligible for Work', () => {
  const previousLocation = context.window.location;
  const previousQuery = documentMock.querySelector;
  context.window.location = { href: 'https://chatgpt.com/' };
  context.location.href = context.window.location.href;
  documentMock.querySelector = selector => selector.includes('button[aria-label*="temporary chat"')
    ? control('', { 'aria-label': 'Temporary Chat' }) : null;
  try { assert.equal(isTemporaryChatPage(), false); }
  finally { context.window.location = previousLocation; documentMock.querySelector = previousQuery; }
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

test('a saved conversation without Chat/Work controls reuses its exact server-proven mode', async () => {
  const previous = { ...context.location };
  context.location.href = 'https://chatgpt.com/c/verified-conversation';
  context.location.pathname = '/c/verified-conversation';
  context.location.search = '';
  context.window.location = context.location;
  documentMock.controls = [];
  try {
    const proof = { conversationId: 'verified-conversation', mode: 'chat' };
    assert.equal(await ensureChatgptModeSelected('chat', proof), true);
    assert.equal(await ensureChatgptModeSelected('work', proof), false);
  } finally {
    Object.assign(context.location, previous);
    delete context.location.pathname;
    context.window.location = context.location;
  }
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
  assert.equal(modelKeyFromText('Последняя'), 'latest');
  assert.equal(modelKeyFromText('Latest'), 'latest');
  assert.equal(modelKeyFromText('6 Pro'), '6-astra');
  assert.equal(modelKeyFromText('GPT-6 Astra'), '6-astra');
  assert.equal(modelKeyFromText('GPT-5.6 Sol'), '5.6-sol');
  assert.equal(modelKeyFromText('GPT-5.6 Terra'), '5.6-terra');
  assert.equal(modelKeyFromText('GPT-5.6 Luna'), '5.6-luna');
  assert.equal(modelKeyFromText('5.6 Sol'), '5.6-sol');
  assert.equal(modelKeyFromText('5.6 Terra'), '5.6-terra');
  assert.equal(modelKeyFromText('5.6 Luna'), '5.6-luna');
  assert.equal(modelKeyFromText('5.6 SolОчень высокий'), '5.6-sol');
  assert.equal(modelKeyFromText('Sol'), '5.6-sol');
  assert.equal(modelKeyFromText('Terra'), '5.6-terra');
  assert.equal(modelKeyFromText('Luna'), '5.6-luna');
  assert.equal(modelKeyFromText('GPT-5.5 Instant'), '5.5');
  assert.equal(modelKeyFromText('o3 Доступна до 26 августа'), 'o3');
});

test('current GPT-6 Work labels and Latest with an explicit version preserve exact model identity', () => {
  assert.equal(modelKeyFromText('GPT-6.1 Sol'), '6.1-sol');
  assert.equal(modelKeyFromText('GPT-6 Sol'), '6-sol');
  assert.equal(modelKeyFromText('GPT-6 Luna'), '6-luna');
  assert.equal(modelKeyFromText('Последняя • 6.1 Sol'), '6.1-sol');
  assert.equal(modelKeyFromText('GPT-6.1 SolMax'), '6.1-sol');
  assert.equal(resolveModel('gpt-6.1-sol'), '6.1-sol');
  assert.equal(resolveModel('gpt-6-sol'), '6-sol');
  assert.equal(resolveModel('gpt-6-luna'), '6-luna');
});

test('GPT-6 Chat family is distinct from explicit Astra, Sol, Luna and dynamic Latest', () => {
  assert.equal(modelKeyFromText('GPT-6'), '6');
  assert.equal(modelKeyFromText('6'), '6');
  assert.equal(resolveModel('gpt-6'), '6');
  assert.equal(resolveModel('6'), '6');
  assert.equal(modelDisplay('6'), 'GPT-6');
  for (const effort of ['instant', 'medium', 'high', 'xhigh', 'pro']) {
    assert.equal(chatgptSelectionError('chat', '6', effort), null);
  }
  assert.match(chatgptSelectionError('chat', '6', 'ultra'), /не поддерживает/);
  assert.match(chatgptSelectionError('work', '6', 'xhigh'), /не проверена/);
});

test('five-position Work Luna and four-position Work 5.5 sliders never use the Chat effort map', () => {
  assert.equal(effortKeyFromSliderValue(0, 0, 4, 'work', '6-luna'), 'low');
  assert.equal(effortKeyFromSliderValue(4, 0, 4, 'work', '6-luna'), 'max');
  assert.equal(effortSliderValueForKey('ultra', 0, 4, 'work', '6-luna'), null);
  assert.equal(effortKeyFromSliderValue(3, 0, 3, 'work', '5.5'), 'xhigh');
  assert.equal(effortKeyFromSliderValue(4, 0, 4, 'chat', '5.6-sol'), 'pro');
  assert.equal(effortKeyFromSliderValue(4, 0, 5, 'work', '6.1-sol'), 'max');
  assert.equal(effortKeyFromSliderValue(1, 0, 5, 'work', 'latest'), null);
});

test('Latest is only Astra proof at Chat Pro; Work default never proves an explicit model', () => {
  const latest = control('Latest', { role: 'menuitemradio', 'aria-checked': 'true' });
  const attrs = { role: 'slider', 'aria-valuemin': '0', 'aria-valuemax': '4', 'aria-valuenow': '3' };
  const slider = control('', attrs);
  const version = control('6Pro', { role: 'menuitem', 'aria-label': 'Выбрать модель' });
  documentMock.controls = [latest, slider, version];
  try {
    assert.equal(currentModelKeyFromOpenMenu('chat'), 'latest');
    attrs['aria-valuenow'] = '4';
    assert.equal(currentModelKeyFromOpenMenu('chat'), '6-astra');
    assert.equal(currentModelKeyFromOpenMenu('work'), 'latest');
    version.textContent = '7Pro';
    assert.equal(currentModelKeyFromOpenMenu('chat'), 'latest');
  } finally { documentMock.controls = []; }
});

test('current ChatGPT effort submenu uses the Усилие label', () => {
  const effort = control('УсилиеОчень высокий', { role: 'menuitem', 'aria-haspopup': 'menu' });
  documentMock.controls = [effort];
  assert.equal(findEffortSubTrigger(), effort);
});

test('current ChatGPT root menu recognizes an already checked model and current effort row', () => {
  const effort = control('Очень высокий', { role: 'menuitem', 'aria-expanded': 'false' });
  const model = control('GPT-5.6 Sol', { role: 'menuitemradio', 'aria-checked': 'true' });
  const otherModel = control('GPT-5.5', { role: 'menuitemradio', 'aria-checked': 'false' });
  documentMock.controls = [effort, model, otherModel];

  assert.equal(currentModelKeyFromOpenMenu(), '5.6-sol');
  assert.equal(findEffortSubTrigger(), effort);
  assert.equal(currentEffortKeyFromOpenMenu(), 'xhigh');
});

test('new Chat effort slider maps five positions to Instant through Pro', () => {
  assert.equal(effortKeyFromSliderValue(0, 0, 4), 'instant');
  assert.equal(effortKeyFromSliderValue(1, 0, 4), 'medium');
  assert.equal(effortKeyFromSliderValue(2, 0, 4), 'high');
  assert.equal(effortKeyFromSliderValue(3, 0, 4), 'xhigh');
  assert.equal(effortKeyFromSliderValue(4, 0, 4), 'pro');
  assert.equal(effortSliderValueForKey('xhigh', 0, 4), 3);
  assert.equal(effortSliderValueForKey('low', 0, 4), null);
});

test('new Work effort slider maps six positions to Low through Ultra', () => {
  assert.equal(effortKeyFromSliderValue(0, 0, 5), 'low');
  assert.equal(effortKeyFromSliderValue(1, 0, 5), 'medium');
  assert.equal(effortKeyFromSliderValue(2, 0, 5), 'high');
  assert.equal(effortKeyFromSliderValue(3, 0, 5), 'xhigh');
  assert.equal(effortKeyFromSliderValue(4, 0, 5), 'max');
  assert.equal(effortKeyFromSliderValue(5, 0, 5), 'ultra');
  assert.equal(effortSliderValueForKey('max', 0, 5), 4);
  assert.equal(effortSliderValueForKey('instant', 0, 5), null);
});

test('current effort is read from the slider before legacy menu rows', () => {
  const slider = control('', {
    role: 'slider',
    'aria-valuemin': '0',
    'aria-valuemax': '4',
    'aria-valuenow': '3',
  });
  const staleLegacyRow = control('Высокий', { role: 'menuitem', 'aria-expanded': 'true' });
  documentMock.controls = [staleLegacyRow, slider];

  assert.equal(currentEffortKeyFromOpenMenu(), 'xhigh');
});

test('retired Pro detail aliases collapse to the single current Pro option', () => {
  assert.equal(resolveEffort('pro-extended'), 'pro');
  assert.equal(resolveEffort('Pro расширенный'), 'pro');
});

test('Astra retains Chat Pro while Work generations expose only their supported effort ranges', () => {
  assert.equal(chatgptSelectionError('chat', '6-astra', 'pro'), null);
  assert.match(chatgptSelectionError('chat', '6-astra', 'xhigh'), /только как Pro/);
  assert.equal(chatgptSelectionError('chat', '5.6-sol', 'xhigh'), null);
  assert.equal(chatgptSelectionError('chat', '5.6-sol', 'pro'), null);
  assert.equal(chatgptSelectionError('work', '6-astra', 'max'), null);
  assert.equal(chatgptSelectionError('work', '6.1-sol', 'ultra'), null);
  assert.equal(chatgptSelectionError('work', '6-sol', 'high'), null);
  assert.equal(chatgptSelectionError('work', '6-luna', 'max'), null);
  assert.match(chatgptSelectionError('work', '6-luna', 'ultra'), /не поддерживает/);
  assert.match(chatgptSelectionError('work', '5.6-luna', 'ultra'), /не поддерживает/);
  assert.equal(chatgptSelectionError('work', '5.5', 'xhigh'), null);
  assert.match(chatgptSelectionError('work', '5.5', 'max'), /не поддерживает/);
  assert.match(chatgptSelectionError('chat', '6.1-sol', 'xhigh'), /недоступна в Chat/);
});

test('Work speed defaults to quota-safer standard mode', () => {
  assert.equal(resolveSpeed(), 'standard');
  assert.equal(resolveSpeed('быстро'), 'fast');
  assert.equal(speedLabel('fast'), 'Быстро');
  assert.equal(speedKeyFromFastModeToggle(control('', {
    'aria-label': 'Включить стандартный режим',
    'aria-checked': 'true',
  })), 'fast');
  assert.equal(speedKeyFromFastModeToggle(control('', {
    'aria-label': 'Включить быстрый режим',
    'aria-checked': 'false',
  })), 'standard');
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

test('API terminal proof stays pending for end_turn commentary followed by a tool', () => {
  const data = {
    current_node: 'tool',
    mapping: {
      user: {
        id: 'user', parent: null,
        message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['task'] } },
      },
      commentary: {
        id: 'commentary', parent: 'user',
        message: {
          author: { role: 'assistant' }, channel: 'commentary', end_turn: true,
          status: 'finished_successfully', content: { content_type: 'text', parts: ['Прослежу результат'] },
          metadata: { is_thinking_preamble_message: true },
        },
      },
      tool: {
        id: 'tool', parent: 'commentary',
        message: {
          author: { role: 'tool', name: 'container.exec' },
          status: 'finished_successfully', content: { content_type: 'execution_output', text: 'still working' },
        },
      },
    },
  };
  const snapshot = latestApiTurnSnapshotFromData(data);
  assert.equal(snapshot.ready, false);
  assert.equal(snapshot.text, '');
});

test('API terminal proof requires final plus end_turn for the current provider contract', () => {
  const data = {
    current_node: 'assistant',
    mapping: {
      user: {
        id: 'user', parent: null,
        message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['task'] } },
      },
      assistant: {
        id: 'assistant', parent: 'user',
        message: {
          author: { role: 'assistant' }, channel: 'final', end_turn: false,
          status: 'finished_successfully', content: { content_type: 'text', parts: ['not terminal yet'] }, metadata: {},
        },
      },
    },
  };
  assert.equal(latestApiTurnSnapshotFromData(data).ready, false);
});

test('legacy channel-less final is accepted only as the finished tail of its turn', () => {
  const base = {
    user: {
      id: 'user', parent: null,
      message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['legacy task'] } },
    },
    legacy: {
      id: 'legacy', parent: 'user',
      message: {
        author: { role: 'assistant' }, end_turn: true, status: 'finished_successfully', recipient: 'all',
        content: { content_type: 'text', parts: ['OK'] }, metadata: {},
      },
    },
  };
  const accepted = latestApiTurnSnapshotFromData({ current_node: 'legacy', mapping: base });
  assert.equal(accepted.ready, true);
  assert.equal(accepted.reason, 'api_legacy_final');
  assert.equal(accepted.text, 'OK');

  const withTool = {
    ...base,
    tool: {
      id: 'tool', parent: 'legacy',
      message: {
        author: { role: 'tool', name: 'container.exec' },
        status: 'finished_successfully', content: { content_type: 'execution_output', text: 'continued' },
      },
    },
  };
  assert.equal(latestApiTurnSnapshotFromData({ current_node: 'tool', mapping: withTool }).ready, false);
});

test('API export never promotes commentary end_turn into the assistant answer', () => {
  const data = {
    title: 'Pending turn',
    current_node: 'commentary',
    mapping: {
      user: {
        id: 'user', parent: null,
        message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['task'] } },
      },
      commentary: {
        id: 'commentary', parent: 'user',
        message: {
          author: { role: 'assistant' }, channel: 'commentary', end_turn: true,
          status: 'finished_successfully', content: { content_type: 'text', parts: ['still working'] }, metadata: {},
        },
      },
    },
  };
  const stats = { user: 0, assistant: 0, sources: 0, activity: 0, images: 0 };
  const built = buildChatGPTApiMarkdown(data, {
    includeImages: false, includeReasoning: false, includeSources: false, includeSourceActivity: false,
  }, stats, 'chat');
  assert.doesNotMatch(built.markdown, /## ChatGPT\n\nstill working/);
});

test('legacy numeric GPT-5.6 resolves to Sol', () => {
  assert.equal(resolveModel('gpt-6-astra'), '6-astra');
  assert.equal(resolveModel('Astra'), '6-astra');
  assert.equal(modelDisplay('6-astra'), 'GPT-6 Astra');
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
  const f = fixture();
  f.composer.appendChild(new f.Element('button', { 'data-testid': 'upload-files-button' }));
  const files = [{ name: 'video.txt', type: 'text/plain' }];
  const baseline = f.composerFilePreviewState(files);
  assert.equal(f.composerHasFilePreview(files, baseline), false);
  const preview = f.preview('video.txt');
  assert.equal(f.composerHasFilePreview(files, baseline), true);
  preview.remove();
  f.editor.textContent = 'video.txt';
  assert.equal(f.composerHasFilePreview(files, baseline), false);
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

test('current Pasted Text chip without inline control falls back only after a stable send-ready attachment', async () => {
  const f = fixture();
  const prompt = 'Задача:\nперескажи кратко видео';
  f.editor.textContent = prompt;
  const chip = f.composer.appendChild(new f.Element('button', { 'aria-label': 'Вставленный текст.txt' }));
  f.composer.appendChild(f.send);

  const pending = f.showPastedTextInComposer('video-compose', `${prompt}\n\n${'исходный материал '.repeat(4000)}`, prompt);
  await f.clock.advance(3500);
  assert.equal(f.composer.contains(chip), true);
  await f.clock.advance(6500);
  const result = await pending;
  assert.equal(result.method, 'pasted_text_attachment');
  assert.equal(result.reason, 'inline_control_unavailable_after_ready_chip');
  assert(result.waitedMs >= 7000 && result.waitedMs < 10000);
});

test('the same chip cannot fall back while Send is disabled', async () => {
  const f = fixture();
  const prompt = 'Задача:\nперескажи кратко видео';
  f.editor.textContent = prompt;
  f.composer.appendChild(new f.Element('button', { 'aria-label': 'Вставленный текст.txt' }));
  f.send.setAttribute('disabled', '');
  f.composer.appendChild(f.send);

  const pending = f.showPastedTextInComposer('uploading-video', `${prompt}\n\nисходный материал`, prompt, 9000);
  await f.clock.advance(10000);
  await assert.rejects(pending, /chatgpt_show_in_text_field_failed/);
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
