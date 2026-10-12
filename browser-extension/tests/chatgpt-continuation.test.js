const test = require('node:test');
const assert = require('node:assert/strict');
const { File } = require('node:buffer');
const { fixture, apiConversation } = require('./helpers/chatgpt-flow-fixture.cjs');

const oldTurns = [
  { id: 'old-user', role: 'user', text: 'first question' },
  { id: 'old-answer', role: 'assistant', text: 'OLD ANSWER', metadata: { citations: [{ url: 'https://old.example/', title: 'Old source' }] } },
];
const newTurns = [
  ...oldTurns,
  { id: 'new-user', role: 'user', text: 'second question' },
  { id: 'new-answer', role: 'assistant', text: 'NEW ANSWER' },
];
function oldHistory(f) {
  f.turn('user', 'old-user', 'first question');
  return f.turn('assistant', 'old-answer', 'OLD ANSWER', { sources: true, thinking: 'OLD THINKING' });
}
function watch(f, boundary, snapshot, getImages = () => [], options = {}) {
  const done = [], progress = [];
  const stop = f.startDoneWatcher(value => done.push(value), value => progress.push(value), () => {},
    getImages, f.createTerminalProbe(boundary, snapshot), boundary, options);
  return { done, progress, stop };
}

function currentUiTurn(f, role, id, text, { complete = true } = {}) {
  const turn = f.history.appendChild(new f.Element('div', { 'data-content-search-turn-key': `turn-${id}` }));
  const message = turn.appendChild(new f.Element('div', {
    'data-chatgpt-search-unit-key': `turn-${id}:0:${role}`,
    'data-chatgpt-search-message-ids': id,
  }));
  if (role === 'assistant') {
    message.appendChild(new f.Element('div', { 'data-markdown-text-style': 'assistant-message' }, text));
    if (complete) turn.appendChild(new f.Element('button', { 'aria-label': 'Копировать' }));
  } else message.appendChild(new f.Element('div', {}, text));
  return { turn, message };
}

test('current ChatGPT message markers finish only the newly submitted answer when API is rate limited', async () => {
  const f = fixture();
  currentUiTurn(f, 'user', 'old-user', 'old question');
  currentUiTurn(f, 'assistant', 'old-answer', 'OLD ANSWER');
  const boundary = f.createTurnBoundary();
  let calls = 0;
  const watcher = watch(f, boundary, async () => { calls++; throw new Error('HTTP 429'); });
  await f.clock.advance(8000);
  assert(calls >= 3);
  assert.equal(watcher.done.length, 0);

  const user = currentUiTurn(f, 'user', 'new-user', 'new question');
  assert.equal(f.submittedUserElement(boundary), user.message);
  const answer = currentUiTurn(f, 'assistant', 'new-answer', 'NEW ANSWER', { complete: false });
  await f.clock.advance(4000);
  assert.equal(watcher.done.length, 0);
  answer.turn.appendChild(new f.Element('button', { 'aria-label': 'Копировать' }));
  await f.clock.advance(2500);
  assert.equal(watcher.done.length, 1);
  assert.equal(watcher.done[0].apiFinal.fallback, true);
  assert.equal(f.submittedAssistantElement(boundary, watcher.done[0].assistant), answer.message);
  assert.equal(f.readAnswerText(answer.message), 'NEW ANSWER');
  watcher.stop();
});

test('API continuation requires a new user, waits for its final, and excludes old sources', () => {
  const f = fixture();
  oldHistory(f);
  const old = f.latestApiTurnSnapshotFromData(apiConversation(oldTurns));
  const boundary = f.createTurnBoundary(old);
  assert.equal(f.apiProofForSubmittedTurn(old, boundary).ready, false);
  const pending = f.latestApiTurnSnapshotFromData(apiConversation(newTurns.slice(0, -1)));
  assert.equal(f.apiProofForSubmittedTurn(pending, boundary).ready, false);
  const fresh = f.apiProofForSubmittedTurn(f.latestApiTurnSnapshotFromData(apiConversation(newTurns)), boundary);
  assert.equal(fresh.ready, true);
  assert.equal(fresh.text, 'NEW ANSWER');
  assert.deepEqual(Array.from(fresh.links), []);
  assert.equal(fresh.reasoning_text, '');
});

test('failed API baseline still rejects old final and binds API to the new DOM user', () => {
  const f = fixture();
  oldHistory(f);
  const boundary = f.createTurnBoundary(null);
  const old = f.latestApiTurnSnapshotFromData(apiConversation(oldTurns));
  assert.equal(f.apiProofForSubmittedTurn(old, boundary).ready, false);
  f.turn('user', 'new-user', 'second question');
  assert.equal(f.apiProofForSubmittedTurn(old, boundary).ready, false);
  const fresh = f.latestApiTurnSnapshotFromData(apiConversation(newTurns));
  assert.equal(f.apiProofForSubmittedTurn(fresh, boundary).ready, true);
});

test('three failed API probes cannot finish from old Copy/Voice; new DOM final still works', async () => {
  const f = fixture();
  oldHistory(f);
  const boundary = f.createTurnBoundary();
  let calls = 0;
  const watcher = watch(f, boundary, async () => { calls++; throw new Error('API unavailable'); });
  await f.clock.advance(8000);
  assert(calls >= 3);
  assert.equal(watcher.done.length, 0);
  f.turn('user', 'new-user', 'second question');
  await f.clock.advance(2000);
  assert.equal(watcher.done.length, 0);
  const answer = f.turn('assistant', 'new-answer', 'NEW ANSWER');
  await f.clock.advance(2000);
  assert.equal(watcher.done.length, 1);
  assert.equal(watcher.done[0].apiFinal.fallback, true);
  assert.equal(f.submittedAssistantElement(boundary, watcher.done[0].assistant), answer.message);
  assert.equal(f.readAnswerText(answer.message), 'NEW ANSWER');
  watcher.stop();
});

test('a fast answer with no observed Stop proves Send through the new user turn', async () => {
  const f = fixture();
  oldHistory(f);
  const baseline = f.latestApiTurnSnapshotFromData(apiConversation(oldTurns));
  const boundary = f.createTurnBoundary(baseline);
  f.composer.appendChild(f.send);
  let clicks = 0;
  f.send.handlers.click = () => {
    clicks++;
    f.send.remove();
    f.turn('user', 'new-user', 'second question');
    f.turn('assistant', 'new-answer', 'NEW ANSWER');
  };
  await f.clickSend(boundary);
  const watcher = watch(f, boundary, async () => f.latestApiTurnSnapshotFromData(apiConversation(newTurns)));
  await f.clock.advance(2000);
  assert.equal(clicks, 1);
  assert.equal(watcher.done.length, 1);
  assert.equal(watcher.done[0].apiFinal.text, 'NEW ANSWER');
  watcher.stop();
});

test('missing or disabled Send alone does not prove submission', async () => {
  const f = fixture();
  oldHistory(f);
  const result = f.waitSubmitAccepted(f.createTurnBoundary(), 1000);
  f.send.setAttribute('disabled', '');
  f.composer.appendChild(f.send);
  await f.clock.advance(1000);
  assert.equal(await result, false);
});

test('Stop followed by quiet does not extract the old answer while the new one is pending', async () => {
  const f = fixture();
  oldHistory(f);
  const boundary = f.createTurnBoundary(f.latestApiTurnSnapshotFromData(apiConversation(oldTurns)));
  f.turn('user', 'new-user', 'second question');
  f.composer.appendChild(f.stop);
  let turns = newTurns.slice(0, -1);
  const watcher = watch(f, boundary, async () => f.latestApiTurnSnapshotFromData(apiConversation(turns)));
  await f.clock.advance(2000);
  f.stop.remove();
  await f.clock.advance(6000);
  assert.equal(watcher.done.length, 0);
  f.turn('assistant', 'new-answer', 'NEW ANSWER');
  turns = newTurns;
  await f.clock.advance(2000);
  assert.equal(watcher.done.length, 1);
  watcher.stop();
});

test('commentary end_turn and tool activity stay pending until one real final, then emit once', async () => {
  const f = fixture();
  oldHistory(f);
  const baseline = f.latestApiTurnSnapshotFromData(apiConversation(oldTurns));
  const boundary = f.createTurnBoundary(baseline);
  f.turn('user', 'new-user', 'second question');
  const commentaryTurns = [
    ...oldTurns,
    { id: 'new-user', role: 'user', text: 'second question' },
    {
      id: 'preamble', role: 'assistant', text: 'Прослежу результат', channel: 'commentary', end_turn: true,
      status: 'finished_successfully', metadata: { is_thinking_preamble_message: true },
    },
    { id: 'tool', role: 'tool', text: 'still working', content: { content_type: 'execution_output', text: 'still working' } },
  ];
  let turns = commentaryTurns;
  const watcher = watch(f, boundary, async () => f.latestApiTurnSnapshotFromData(apiConversation(turns)));
  await f.clock.advance(6000);
  assert.equal(watcher.done.length, 0);

  turns = [...commentaryTurns, { id: 'new-answer', role: 'assistant', text: 'OK' }];
  await f.clock.advance(2000);
  assert.equal(watcher.done.length, 1);
  assert.equal(watcher.done[0].apiFinal.text, 'OK');
  await f.clock.advance(10000);
  assert.equal(watcher.done.length, 1);
  watcher.stop();
});

test('reload recovery cannot turn an end_turn preamble into a final', async () => {
  const f = fixture();
  oldHistory(f);
  f.turn('user', 'new-user', 'second question');
  f.turn('assistant', 'preamble', 'Прослежу результат');
  const boundary = f.createTurnBoundary(null, true);
  const turns = [
    ...oldTurns,
    { id: 'new-user', role: 'user', text: 'second question' },
    {
      id: 'preamble', role: 'assistant', text: 'Прослежу результат', channel: 'commentary', end_turn: true,
      status: 'finished_successfully', metadata: { is_thinking_preamble_message: true },
    },
    { id: 'tool', role: 'tool', text: 'continued' },
  ];
  const watcher = watch(f, boundary, async () => f.latestApiTurnSnapshotFromData(apiConversation(turns)));
  await f.clock.advance(8000);
  assert.equal(watcher.done.length, 0);
  watcher.stop();
});

test('reload recovery never reclassifies an already sent turn as submit_failed', async () => {
  const f = fixture();
  const boundary = f.createTurnBoundary(null, true);
  const watcher = watch(f, boundary, async () => ({
    ready: false,
    reason: 'conversation_url_pending',
  }), () => [], { extended: true });

  await f.clock.advance(130000);
  assert.equal(watcher.done.length, 0);
  assert.equal(watcher.progress.some(item => item.stage === 'submit_failed'), false);
  watcher.stop();
});

test('stable commentary/tool tail after provider returned idle becomes an explicit incomplete error', async () => {
  const f = fixture();
  f.turn('user', 'new-user', 'second question');
  const boundary = f.createTurnBoundary(null, true);
  const turns = [
    ...oldTurns,
    { id: 'new-user', role: 'user', text: 'second question' },
    {
      id: 'preamble', role: 'assistant', text: 'Проверю результат', channel: 'commentary', end_turn: true,
      status: 'finished_successfully', metadata: { is_thinking_preamble_message: true },
    },
    { id: 'tool', role: 'tool', text: 'tool output', content: { content_type: 'multimodal_text', parts: ['tool output'] } },
  ];
  const watcher = watch(f, boundary,
    async () => f.latestApiTurnSnapshotFromData(apiConversation(turns)),
    () => [], { extended: true });

  await f.clock.advance(5 * 60 * 1000 + 4000);
  assert.equal(watcher.done.length, 0);
  assert.equal(watcher.progress.some(item => item.stage === 'waiting_provider_final'), true);
  assert.equal(watcher.progress.filter(item => item.stage === 'provider_incomplete').length, 1);
  watcher.stop();
});

test('new provider tool activity resets the incomplete-final stability window', async () => {
  const f = fixture();
  f.turn('user', 'new-user', 'second question');
  const boundary = f.createTurnBoundary(null, true);
  const base = [
    ...oldTurns,
    { id: 'new-user', role: 'user', text: 'second question' },
    {
      id: 'preamble', role: 'assistant', text: 'Проверю результат', channel: 'commentary', end_turn: true,
      status: 'finished_successfully', metadata: { is_thinking_preamble_message: true },
    },
  ];
  let turns = [...base, { id: 'tool-1', role: 'tool', text: 'first', content: { content_type: 'multimodal_text', parts: ['first'] } }];
  const watcher = watch(f, boundary,
    async () => f.latestApiTurnSnapshotFromData(apiConversation(turns)),
    () => [], { extended: true });

  await f.clock.advance(4 * 60 * 1000);
  turns = [...base, { id: 'tool-2', role: 'tool', text: 'second', content: { content_type: 'multimodal_text', parts: ['second'] } }];
  await f.clock.advance(4 * 60 * 1000);
  assert.equal(watcher.progress.some(item => item.stage === 'provider_incomplete'), false);
  await f.clock.advance(60 * 1000 + 4000);
  assert.equal(watcher.progress.filter(item => item.stage === 'provider_incomplete').length, 1);
  watcher.stop();
});

test('API can finish the new turn when hidden-page DOM still contains only old messages', async () => {
  const f = fixture();
  oldHistory(f);
  const boundary = f.createTurnBoundary(f.latestApiTurnSnapshotFromData(apiConversation(oldTurns)));
  const watcher = watch(f, boundary, async () => f.latestApiTurnSnapshotFromData(apiConversation(newTurns)));
  await f.clock.advance(2000);
  assert.equal(watcher.done.length, 1);
  assert.equal(watcher.done[0].apiFinal.text, 'NEW ANSWER');
  assert.equal(f.submittedAssistantElement(boundary, watcher.done[0].assistant), null);
  assert.equal(f.readThinkingLine(null), null);
  watcher.stop();
});

test('Temporary Chat retains DOM completion for the new response without conversation API', async () => {
  const f = fixture({ temporary: true });
  oldHistory(f);
  const boundary = f.createTurnBoundary();
  f.turn('user', 'new-user', 'second question');
  f.turn('assistant', 'new-answer', 'NEW ANSWER');
  const watcher = watch(f, boundary, async () => ({ ready: false, reason: 'conversation_url_pending' }));
  await f.clock.advance(2000);
  assert.equal(watcher.done.length, 1);
  assert.equal(watcher.done[0].apiFinal.reason, 'temporary_chat_dom_final');
  watcher.stop();
});

test('remounting old DOM nodes does not manufacture a new user turn', () => {
  const f = fixture();
  oldHistory(f);
  const boundary = f.createTurnBoundary();
  f.history.textContent = '';
  oldHistory(f);
  assert.equal(f.submittedUserElement(boundary), null);
  assert.equal(f.submittedAssistantElement(boundary), null);
});

test('an old user hydrating before the captured assistant is not the submitted user', () => {
  const f = fixture();
  const old = f.turn('assistant', 'old-answer', 'OLD ANSWER');
  const boundary = f.createTurnBoundary();
  const late = f.turn('user', 'old-user', 'first question');
  f.history.insertBefore(late.root, old.root);
  assert.equal(f.submittedUserElement(boundary), null);
  const fresh = f.turn('user', 'new-user', 'second question');
  assert.equal(f.submittedUserElement(boundary), fresh.message);
});

test('DOM without message IDs uses new turn containers and survives API association', () => {
  const f = fixture();
  f.turn('user', 'old-user', 'first question', { domId: false });
  f.turn('assistant', 'old-answer', 'OLD ANSWER', { domId: false });
  const boundary = f.createTurnBoundary(f.latestApiTurnSnapshotFromData(apiConversation(oldTurns)));
  const user = f.turn('user', 'new-user', 'second question', { domId: false });
  const answer = f.turn('assistant', 'new-answer', 'NEW ANSWER', { domId: false });
  const proof = f.apiProofForSubmittedTurn(f.latestApiTurnSnapshotFromData(apiConversation(newTurns)), boundary);
  assert.equal(proof.ready, true);
  assert.equal(f.submittedUserElement(boundary), user.message);
  assert.equal(f.submittedAssistantElement(boundary, f.assistantTarget(answer.message, proof)), answer.message);
});

test('failed baseline plus DOM without API IDs still allows an independently proven new DOM final', async () => {
  const f = fixture();
  f.turn('user', 'old-user', 'first question', { domId: false });
  f.turn('assistant', 'old-answer', 'OLD ANSWER', { domId: false });
  const boundary = f.createTurnBoundary();
  const watcher = watch(f, boundary, async () => f.latestApiTurnSnapshotFromData(apiConversation(oldTurns)));
  await f.clock.advance(2000);
  assert.equal(watcher.done.length, 0);
  f.turn('user', 'new-user', 'second question', { domId: false });
  f.turn('assistant', 'new-answer', 'NEW ANSWER', { domId: false });
  await f.clock.advance(2000);
  assert.equal(watcher.done.length, 1);
  assert.equal(watcher.done[0].apiFinal.fallback, true);
  assert.equal(f.readAnswerText(f.submittedAssistantElement(boundary, watcher.done[0].assistant)), 'NEW ANSWER');
  watcher.stop();
});

test('accepted answer, sources and thinking stay scoped after a later user and DOM remount', async () => {
  const f = fixture();
  oldHistory(f);
  const boundary = f.createTurnBoundary();
  f.turn('user', 'new-user', 'second question');
  const answer = f.turn('assistant', 'new-answer', 'NEW ANSWER');
  const accepted = f.assistantTarget(f.submittedAssistantElement(boundary));
  const remounted = answer.root.appendChild(new f.Element('div', { 'data-message-author-role': 'assistant', 'data-message-id': 'new-answer' }));
  remounted.appendChild(new f.Element('div', { class: 'markdown' }, 'NEW ANSWER'));
  answer.message.remove();
  f.turn('user', 'third-user', 'another question');
  f.turn('assistant', 'third-answer', 'THIRD ANSWER', { sources: true, thinking: 'THIRD THINKING' });
  assert.equal(f.submittedAssistantElement(boundary), remounted);
  assert.equal(f.submittedAssistantElement(boundary, accepted), remounted);
  assert.equal(f.findSourcesChip(remounted), null);
  assert.equal(f.readThinkingLine(remounted), null);
  assert.equal(f.readThinkingText(remounted), '');
  assert.deepEqual(Array.from((await f.extractSources(remounted)).links), []);
  const text = f.extractAnswerStable(() => f.submittedAssistantElement(boundary, accepted));
  await f.clock.advance(1600);
  assert.equal(await text, 'NEW ANSWER');
});

test('current answer keeps its own sources and thinking', () => {
  const f = fixture();
  oldHistory(f);
  const boundary = f.createTurnBoundary();
  f.turn('user', 'new-user', 'second question');
  const answer = f.turn('assistant', 'new-answer', 'NEW ANSWER', { sources: true, thinking: 'NEW THINKING' });
  const own = f.submittedAssistantElement(boundary);
  assert.equal(f.findSourcesChip(own), answer.root.querySelector('[aria-label="Sources"]'));
  assert.equal(f.readThinkingText(own), 'NEW THINKING');
  assert.equal(f.readThinkingLine(own), 'Thought for 10s');
});

test('image-only DOM completion excludes images belonging to old and later user turns', async () => {
  const f = fixture();
  const old = oldHistory(f);
  function image(parent, id) {
    const container = parent.appendChild(new f.Element('div', { id: `image-${id}` }));
    container.appendChild(new f.Element('img', { src: `https://chatgpt.com/backend-api/estuary/content/${id}`, alt: id }));
  }
  image(old.root, 'old');
  const boundary = f.createTurnBoundary();
  f.turn('user', 'new-user', 'draw');
  const answer = f.turn('assistant', 'new-answer', '');
  image(answer.root, 'new');
  const watcher = watch(f, boundary, async () => { throw new Error('API unavailable'); }, () => f.collectGeneratedImages([], boundary));
  await f.clock.advance(6000);
  assert.equal(watcher.done.length, 1);
  assert.equal(watcher.done[0].imageCount, 1);
  f.turn('user', 'third-user', 'another image');
  image(f.turn('assistant', 'third-answer', '').root, 'third');
  assert.equal(f.collectGeneratedImages([], boundary)[0].container_id, 'image-new');
  watcher.stop();
});

test('image-only API final waits for the new decoded image instead of returning an empty result', async () => {
  const f = fixture();
  oldHistory(f);
  const boundary = f.createTurnBoundary(f.latestApiTurnSnapshotFromData(apiConversation(oldTurns)));
  f.turn('user', 'new-user', 'draw');
  const answer = f.turn('assistant', 'new-answer', '');
  const container = answer.root.appendChild(new f.Element('div', { id: 'image-new' }));
  const image = container.appendChild(new f.Element('img', { src: 'blob:generated', alt: 'new image' }));
  image.complete = false;
  const turns = [...newTurns.slice(0, -1), { id: 'new-answer', role: 'assistant', text: '' }];
  const watcher = watch(f, boundary, async () => f.latestApiTurnSnapshotFromData(apiConversation(turns)),
    () => f.collectGeneratedImages([], boundary));
  await f.clock.advance(4000);
  assert.equal(watcher.done.length, 0);
  image.complete = true;
  await f.clock.advance(2000);
  assert.equal(watcher.done.length, 1);
  assert.equal(watcher.done[0].imageCount, 1);
  assert.equal(watcher.done[0].apiFinal.text, '');
  watcher.stop();
});

test('resuming an already submitted job still accepts its current turn', async () => {
  const f = fixture();
  oldHistory(f);
  f.turn('user', 'new-user', 'second question');
  f.turn('assistant', 'new-answer', 'NEW ANSWER');
  const boundary = f.createTurnBoundary(null, true);
  const watcher = watch(f, boundary, async () => f.latestApiTurnSnapshotFromData(apiConversation(newTurns)));
  await f.clock.advance(2000);
  assert.equal(watcher.done.length, 1);
  assert.equal(watcher.done[0].apiFinal.text, 'NEW ANSWER');
  watcher.stop();
});

test('no-form composer excludes old history filenames, upload statuses and previews', () => {
  const f = fixture({ form: false });
  const old = oldHistory(f);
  f.preview('context.txt', old.root);
  old.root.appendChild(new f.Element('span', {}, 'Processing attachment'));
  const files = [{ name: 'context.txt', type: 'text/plain' }];
  assert.equal(f.composerRoot(), f.composer);
  assert.equal(f.composerHasFilePreview(files, f.composerFilePreviewState(files)), false);
  f.editor.textContent = 'Please inspect context.txt';
  assert.equal(f.composerHasFilePreview(files), false);
});

test('same filename under a new job fetches and dispatches the new bytes', async () => {
  const f = fixture({ form: false });
  const old = oldHistory(f);
  f.preview('context.txt', old.root);
  f.setAttachmentData({ name: 'context.txt', mime: 'text/plain', base64: Buffer.from('OLD CONTENT').toString('base64') });
  const oldFile = await f.fetchAttachmentFile('job-old', { index: 0 });
  f.setAttachmentData({ name: 'context.txt', mime: 'text/plain', base64: Buffer.from('NEW CONTENT').toString('base64') });
  const events = [];
  f.input.handlers.input = () => events.push('input');
  f.input.handlers.change = () => {
    events.push('change');
    for (const file of f.input.files) f.preview(file.name);
  };
  const upload = await f.uploadAttachments('job-new', [{ index: 0, name: 'context.txt' }]);
  assert.equal(upload.files[0].name, oldFile.name);
  assert.equal(await oldFile.text(), 'OLD CONTENT');
  assert.equal(await upload.files[0].text(), 'NEW CONTENT');
  assert.equal(await f.input.files[0].text(), 'NEW CONTENT');
  assert.deepEqual(events, ['input', 'change']);
  assert.equal(upload.hasPreview(), true);
  assert(f.requests.some(request => request.url === '/research-attachment?id=job-new&index=0'));
});

test('an ignored upload cannot be validated by an unchanged same-name composer preview', async () => {
  const f = fixture();
  f.preview('context.txt');
  const result = f.uploadAttachments('job-new', [{ index: 0 }]);
  const rejected = assert.rejects(result, /chatgpt_attachment_preview_missing/);
  await f.clock.advance(60000);
  await rejected;
});

test('all requested attachments need new previews, including repeated names', () => {
  const f = fixture();
  const files = [{ name: 'a.txt' }, { name: 'b.txt' }];
  const baseline = f.composerFilePreviewState(files);
  f.preview('a.txt');
  assert.equal(f.composerHasFilePreview(files, baseline), false);
  f.preview('b.txt');
  assert.equal(f.composerHasFilePreview(files, baseline), true);
  const repeated = [{ name: 'a.txt' }, { name: 'a.txt' }];
  const repeatBaseline = f.composerFilePreviewState(repeated);
  f.preview('a.txt');
  assert.equal(f.composerHasFilePreview(repeated, repeatBaseline), false);
  f.preview('a.txt');
  assert.equal(f.composerHasFilePreview(repeated, repeatBaseline), true);
});

test('research retains upload proof and refuses Send if paste removes the requested file', async () => {
  const f = fixture();
  let card;
  f.input.handlers.change = () => { card = f.preview('context.txt'); };
  const upload = await f.uploadAttachments('job-new', [{ index: 0 }]);
  f.editor.handlers.paste = event => {
    f.editor.textContent = event.clipboardData.getData('text/plain');
    card.remove();
    f.composer.appendChild(f.send);
  };
  let clicks = 0;
  f.send.handlers.click = () => { clicks++; };
  f.pasteIntoComposer('Read context.txt');
  const ready = f.waitComposerReadyAfterPaste('job-new', 120000, ['Read context.txt', 'context.txt']);
  await f.clock.advance(250);
  await ready;
  await assert.rejects(f.clickSend(f.createTurnBoundary(), upload), /attachment_disappeared_before_submit/);
  assert.equal(clicks, 0);
});

test('an unrelated new preview cannot replace the accepted unnamed upload preview', async () => {
  const f = fixture();
  f.composer.appendChild(new f.Element('button', { 'data-testid': 'upload-files-button' }));
  let card;
  f.input.handlers.change = () => { card = f.preview(); };
  const upload = await f.uploadAttachments('job-new', [{ index: 0 }]);
  assert.equal(upload.hasPreview(), true);
  card.remove();
  f.preview('Pasted text');
  assert.equal(upload.hasPreview(), false);
});

test('unnamed image attachments retain preview proof through a thumbnail remount', async () => {
  const f = fixture();
  let image;
  f.input.handlers.change = () => { image = f.composer.appendChild(new f.Element('img', { src: 'blob:new-upload' })); };
  const upload = await f.uploadFiles('job-new', [new File(['image bytes'], 'photo.png', { type: 'image/png' })], { requirePreview: true });
  assert.equal(upload.hasPreview(), true);
  image.remove();
  f.composer.appendChild(new f.Element('img', { src: 'blob:new-upload' }));
  assert.equal(upload.hasPreview(), true);
});

test('prompt-only compose handoff still submits with Stop and no research boundary argument', async () => {
  const f = fixture();
  f.composer.appendChild(f.send);
  let clicks = 0;
  f.send.handlers.click = () => { clicks++; f.send.remove(); f.composer.appendChild(f.stop); };
  await f.clickSend();
  assert.equal(clicks, 1);
});

test('read-only conversation import returns the existing final once without touching Send', async () => {
  const f = fixture();
  f.composer.appendChild(f.send);
  let clicks = 0;
  f.send.handlers.click = () => { clicks++; };
  const stateWrites = [];
  const terminalWrites = [];
  const proof = f.latestApiTurnSnapshotFromData(apiConversation(newTurns));
  const imported = await f.runReadOnlyConversationImport('import-job', {
    options: { readOnlyImport: true, sources: false },
  }, 42, {
    snapshot: async () => proof,
    updateState: async (_id, patch) => stateWrites.push(patch),
    writeTerminal: async (_id, patch) => { terminalWrites.push(patch); return true; },
    currentUrl: () => 'https://chatgpt.com/c/imported-conversation',
    currentTitle: () => 'Imported conversation',
    getImages: () => [],
  });

  assert.equal(clicks, 0);
  assert.equal(imported.confirmed, true);
  assert.equal(stateWrites[0].stage, 'importing');
  assert.equal(terminalWrites.length, 1);
  assert.equal(terminalWrites[0].status, 'done');
  assert.equal(terminalWrites[0].result.text, 'NEW ANSWER');
  assert.equal(terminalWrites[0].result.answer_text, 'NEW ANSWER');
  assert.equal(terminalWrites[0].result.read_only_import, true);
  assert.equal(terminalWrites[0].result.source_message_id, 'new-answer');
});

test('read-only import can wait for the same conversation final but never accepts commentary', async () => {
  const f = fixture();
  const pendingTurns = [
    ...oldTurns,
    { id: 'new-user', role: 'user', text: 'second question' },
    {
      id: 'preamble', role: 'assistant', text: 'Прослежу', channel: 'commentary', end_turn: true,
      status: 'finished_successfully', metadata: { is_thinking_preamble_message: true },
    },
    { id: 'tool', role: 'tool', text: 'still working' },
  ];
  let calls = 0;
  let clock = 1000;
  const terminalWrites = [];
  const imported = await f.runReadOnlyConversationImport('import-wait', {
    options: { readOnlyImport: true, importWaitForFinal: true, importTimeoutMs: 10000 },
  }, 42, {
    snapshot: async () => {
      calls++;
      return f.latestApiTurnSnapshotFromData(apiConversation(calls < 3 ? pendingTurns : newTurns));
    },
    updateState: async () => {},
    writeTerminal: async (_id, patch) => { terminalWrites.push(patch); return true; },
    wait: async (ms) => { clock += ms; },
    now: () => clock,
    currentUrl: () => 'https://chatgpt.com/c/imported-conversation',
    currentTitle: () => 'Imported conversation',
    getImages: () => [],
  });
  assert.equal(calls, 3);
  assert.equal(imported.proof.proof_kind, 'explicit_final');
  assert.equal(terminalWrites.length, 1);
  assert.equal(terminalWrites[0].result.text, 'NEW ANSWER');
});

test('read-only import reports a missing final instead of returning an old answer or sending', async () => {
  const f = fixture();
  const pendingTurns = [
    ...oldTurns,
    { id: 'new-user', role: 'user', text: 'unfinished question' },
    {
      id: 'preamble', role: 'assistant', text: 'Прослежу', channel: 'commentary', end_turn: true,
      status: 'finished_successfully', metadata: { is_thinking_preamble_message: true },
    },
  ];
  await assert.rejects(f.runReadOnlyConversationImport('import-pending', {
    options: { readOnlyImport: true, importWaitForFinal: false },
  }, 42, {
    snapshot: async () => f.latestApiTurnSnapshotFromData(apiConversation(pendingTurns)),
    updateState: async () => {},
    writeTerminal: async () => { throw new Error('terminal write must not happen'); },
    currentUrl: () => 'https://chatgpt.com/c/imported-conversation',
    currentTitle: () => 'Imported conversation',
    getImages: () => [],
  }), /current user-turn has no final/);
});

test('read-only image import keeps an empty textual final only with a saved generated image', async () => {
  const f = fixture();
  const turns = [
    { id: 'user', role: 'user', text: 'draw' },
    { id: 'answer', role: 'assistant', text: '' },
  ];
  const terminalWrites = [];
  const imported = await f.runReadOnlyConversationImport('import-image', {
    options: { readOnlyImport: true },
  }, 42, {
    snapshot: async () => f.latestApiTurnSnapshotFromData(apiConversation(turns)),
    updateState: async () => {},
    writeTerminal: async (_id, patch) => { terminalWrites.push(patch); return true; },
    currentUrl: () => 'https://chatgpt.com/c/image-conversation',
    currentTitle: () => 'Image conversation',
    getImages: () => [{ key: 'image-1' }],
    stabilizeImages: async () => [{ key: 'image-1' }],
    saveImages: async () => [{ file_path: '/safe/image.png', name: 'image.png', bytes: 10, content_type: 'image/png' }],
  });
  assert.equal(imported.result.text, '');
  assert.equal(imported.result.is_image, true);
  assert.equal(terminalWrites[0].result.images.length, 1);
});

test('read-only import rejects an explicit final with no extractable text or image', async () => {
  const f = fixture();
  await assert.rejects(f.runReadOnlyConversationImport('import-empty', {
    options: { readOnlyImport: true },
  }, 42, {
    snapshot: async () => ({
      ready: true,
      reason: 'api_final',
      proof_kind: 'explicit_final',
      message_id: 'empty-final',
      text: '',
      links: [],
      activity_items: [],
    }),
    updateState: async () => {},
    writeTerminal: async () => { throw new Error('terminal write must not happen'); },
    currentUrl: () => 'https://chatgpt.com/c/imported-conversation',
    currentTitle: () => 'Imported conversation',
    getImages: () => [],
    stabilizeImages: async () => [],
  }), /final has no extractable text or generated image/);
});

test('read-only import omits heavyweight provider activity unless explicitly requested', async () => {
  const f = fixture();
  const activity = [{ title: 'Tool output', text: 'x'.repeat(20000) }];
  const writes = [];
  const imported = await f.runReadOnlyConversationImport('import-lean', {
    options: { readOnlyImport: true },
  }, 42, {
    snapshot: async () => ({
      ready: true, proof_kind: 'explicit_final', message_id: 'answer',
      text: 'FINAL', links: [], activity_items: activity,
    }),
    updateState: async () => {},
    writeTerminal: async (_id, patch) => { writes.push(patch); return true; },
    currentUrl: () => 'https://chatgpt.com/c/imported-conversation',
    currentTitle: () => 'Imported conversation',
    getImages: () => [],
  });
  assert.deepEqual(Array.from(imported.result.source_activity), []);
  assert.deepEqual(Array.from(imported.result.sources_meta.activity_items), []);
  assert.equal(imported.result.sources_meta.activity_count, 1);
  assert.equal(imported.result.sources_meta.activity_omitted, true);
  assert.ok(JSON.stringify(writes[0]).length < 2000);
});

test('read-only import can retain provider activity once for an explicit forensic request', async () => {
  const f = fixture();
  const activity = [{ title: 'Tool output', text: 'details' }];
  const imported = await f.runReadOnlyConversationImport('import-activity', {
    options: { readOnlyImport: true, importIncludeActivity: true },
  }, 42, {
    snapshot: async () => ({
      ready: true, proof_kind: 'explicit_final', message_id: 'answer',
      text: 'FINAL', links: [], activity_items: activity,
    }),
    updateState: async () => {},
    writeTerminal: async () => true,
    currentUrl: () => 'https://chatgpt.com/c/imported-conversation',
    currentTitle: () => 'Imported conversation',
    getImages: () => [],
  });
  assert.deepEqual(Array.from(imported.result.source_activity), []);
  assert.equal(imported.result.sources_meta.activity_items.length, 1);
  assert.equal(imported.result.sources_meta.activity_count, 1);
  assert.equal(imported.result.sources_meta.activity_omitted, false);
});
