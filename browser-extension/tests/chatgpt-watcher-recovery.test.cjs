const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, apiConversation } = require('./helpers/chatgpt-flow-fixture.cjs');

const sourcePath = process.env.SC_CHATGPT_SOURCE;
const prompt = 'same submitted prompt';
const own = [
  { id: 'own-user', role: 'user', text: prompt },
  { id: 'own-final', role: 'assistant', text: 'OK' },
];
const snapshot = (f, turns = own, conversationId = 'fixture') =>
  f.latestApiTurnSnapshotFromData({ ...apiConversation(turns), conversation_id: conversationId });
function emptyPage(f) {
  f.composer.remove();
  f.history.textContent = '';
  f.document.visibilityState = 'hidden';
}
function watch(f, boundary, read, images = () => [], options = { extended: true }) {
  const done = [], progress = [], probes = [];
  const close = f.startDoneWatcher(value => done.push(value), value => progress.push(value), null,
    images, f.createTerminalProbe(boundary, async () => {
      probes.push(f.clock.now());
      return read();
    }), boundary, options);
  return { done, progress, probes, close };
}

test('RED control: resumed own API final completes with no composer/buttons/messages, without focus or Send', async () => {
  const f = fixture({ sourcePath });
  emptyPage(f);
  const boundary = f.createTurnBoundary(null, true);
  boundary.userId = 'own-user';
  const w = watch(f, boundary, () => snapshot(f));
  await f.clock.advance(10000);
  assert.equal(w.probes.length, 1);
  assert.equal(w.done.length, 1);
  assert.equal(w.done[0].apiFinal.proof_kind, 'explicit_final');
  assert.equal(w.done[0].apiFinal.text, 'OK');
  assert.equal(w.done[0].assistant.id, 'own-final');
  assert.equal(w.done[0].assistant.el, null);
  assert.equal(w.progress.some(p => p.stage === 'submit_failed'), false);
  await f.clock.advance(10000);
  assert.equal(w.done.length, 1);
  w.close();
});

test('newly accepted user turn is also observed when its composer disappears before Stop is seen', async () => {
  const f = fixture({ sourcePath });
  const boundary = f.createTurnBoundary(snapshot(f, []));
  f.turn('user', 'own-user', prompt);
  f.submittedUserElement(boundary);
  emptyPage(f);
  const w = watch(f, boundary, () => snapshot(f));
  await f.clock.advance(4000);
  assert.equal(w.done.length, 1);
  w.close();
});

test('unknown initial submission does not become sent because the buttons are absent', async () => {
  const f = fixture({ sourcePath });
  emptyPage(f);
  const boundary = f.createTurnBoundary(snapshot(f));
  const w = watch(f, boundary, () => snapshot(f));
  await f.clock.advance(122000);
  assert.equal(w.done.length, 0);
  assert.equal(w.progress.filter(p => p.stage === 'submit_failed').length, 1);
  w.close();
});

test('resumed observation keeps failed/429 API pending without DOM and can recover later', async () => {
  const f = fixture({ sourcePath });
  emptyPage(f);
  const boundary = f.createTurnBoundary(null, true);
  boundary.userId = 'own-user';
  let available = false;
  const w = watch(f, boundary, () => {
    if (!available) throw new Error('HTTP 429');
    return snapshot(f);
  });
  await f.clock.advance(130000);
  assert(w.probes.length >= 3);
  assert.equal(w.done.length, 0);
  assert.equal(w.progress.some(p => /submit_failed|provider_incomplete/.test(p.stage)), false);
  available = true;
  await f.clock.advance(4000);
  assert.equal(w.done.length, 1);
  w.close();
});

test('missing idle UI is not proof a stable preamble/tool turn has stopped', async () => {
  const f = fixture({ sourcePath });
  emptyPage(f);
  const boundary = f.createTurnBoundary(null, true);
  boundary.userId = 'own-user';
  const preamble = [own[0], {
    id: 'preamble', role: 'assistant', text: 'Прослежу…', channel: 'commentary', end_turn: true,
    metadata: { is_thinking_preamble_message: true },
  }, { id: 'tool', role: 'tool', text: 'working' }];
  const w = watch(f, boundary, () => snapshot(f, preamble));
  await f.clock.advance(6 * 60000);
  assert(w.probes.length >= 3);
  assert.equal(w.done.length, 0);
  assert.equal(w.progress.some(p => p.stage === 'provider_incomplete'), false);
  w.close();
});

test('same submitted turn rejects old/foreign user finals, then accepts its true final', async () => {
  const f = fixture({ sourcePath });
  emptyPage(f);
  const boundary = f.createTurnBoundary(null, true);
  boundary.userId = 'own-user';
  let turns = [{ id: 'old-user', role: 'user', text: 'old' },
    { id: 'old-final', role: 'assistant', text: 'OLD' }];
  const w = watch(f, boundary, () => snapshot(f, turns));
  await f.clock.advance(4000);
  assert.equal(w.done.length, 0);
  turns = [...own, { id: 'foreign-user', role: 'user', text: 'later' },
    { id: 'foreign-final', role: 'assistant', text: 'FOREIGN' }];
  await f.clock.advance(4000);
  assert.equal(w.done.length, 0);
  turns = own;
  await f.clock.advance(4000);
  assert.equal(w.done.length, 1);
  w.close();
});

test('resumed API identity cannot bind an unrelated latest user just because DOM is absent', async () => {
  const f = fixture({ sourcePath });
  emptyPage(f);
  const boundary = f.createTurnBoundary(null, true, { prompt });
  let turns = [{ id: 'foreign-user', role: 'user', text: 'unrelated question' },
    { id: 'foreign-final', role: 'assistant', text: 'FOREIGN' }];
  const w = watch(f, boundary, () => snapshot(f, turns));
  await f.clock.advance(4000);
  assert.equal(w.done.length, 0);
  assert.equal(boundary.userId, null);
  turns = own;
  await f.clock.advance(4000);
  assert.equal(w.done.length, 1);
  assert.equal(boundary.userId, 'own-user');
  w.close();
});

test('proof from a different conversation is not accepted even with the same user ID', async () => {
  const f = fixture({ sourcePath });
  emptyPage(f);
  const boundary = f.createTurnBoundary(null, true);
  boundary.userId = 'own-user';
  let conversationId = 'another-conversation';
  const w = watch(f, boundary, () => snapshot(f, own, conversationId));
  await f.clock.advance(4000);
  assert.equal(w.done.length, 0);
  conversationId = 'fixture';
  await f.clock.advance(4000);
  assert.equal(w.done.length, 1);
  w.close();
});

test('first API association cannot bind a different conversation from the current stable URL', async () => {
  const f = fixture({ sourcePath });
  emptyPage(f);
  const boundary = f.createTurnBoundary({ user_ids: [] });
  boundary.userId = 'own-user';
  const w = watch(f, boundary, () => snapshot(f, own, 'another-conversation'));
  await f.clock.advance(4000);
  assert.equal(w.done.length, 0);
  assert.equal(boundary.conversationId, null);
  w.close();
});

test('provisional local-chatgpt URL does not block binding after hydration gives its stable conversation', async () => {
  const f = fixture({ sourcePath });
  emptyPage(f);
  f.window.location.href = 'https://chatgpt.com/c/local-chatgpt%3Afixture';
  const boundary = f.createTurnBoundary(null, true, { prompt });
  assert.equal(boundary.conversationId, null);
  f.window.location.href = 'https://chatgpt.com/c/fixture';
  const w = watch(f, boundary, () => snapshot(f));
  await f.clock.advance(4000);
  assert.equal(w.done.length, 1);
  assert.equal(boundary.conversationId, 'fixture');
  w.close();
});

test('Stop present after reload blocks API completion; Stop returning during an in-flight probe also blocks it', async () => {
  const f = fixture({ sourcePath });
  emptyPage(f);
  const boundary = f.createTurnBoundary(null, true);
  boundary.userId = 'own-user';
  f.document.body.appendChild(f.stop);
  let resolveProbe;
  const w = watch(f, boundary, () => new Promise(resolve => { resolveProbe = resolve; }));
  await f.clock.advance(4000);
  assert.equal(w.probes.length, 0);
  f.stop.remove();
  await f.clock.advance(4000);
  assert.equal(w.probes.length, 1);
  f.document.body.appendChild(f.stop);
  f.window.__scResearchTick();
  resolveProbe(snapshot(f));
  await f.clock.flush();
  assert.equal(w.done.length, 0);
  w.close();
});

test('navigation while API probe is pending cannot save a final into the other page', async () => {
  const f = fixture({ sourcePath });
  emptyPage(f);
  const boundary = f.createTurnBoundary(null, true);
  boundary.userId = 'own-user';
  let resolveProbe;
  const w = watch(f, boundary, () => new Promise(resolve => { resolveProbe = resolve; }));
  await f.clock.advance(2000);
  f.window.location.href = 'https://chatgpt.com/c/another-conversation';
  resolveProbe(snapshot(f));
  await f.clock.flush();
  assert.equal(w.done.length, 0);
  w.close();
});

test('empty explicit image final still waits for its decoded own image, without idle buttons', async () => {
  const f = fixture({ sourcePath });
  f.composer.remove();
  const boundary = f.createTurnBoundary(null, true);
  f.turn('user', 'own-user', prompt);
  const answer = f.turn('assistant', 'own-final', '');
  const image = answer.root.appendChild(new f.Element('div', { id: 'image-own' }))
    .appendChild(new f.Element('img', { src: 'blob:own', alt: 'new image' }));
  image.complete = false;
  const w = watch(f, boundary, () => snapshot(f, [own[0], { ...own[1], text: '' }]),
    () => f.collectGeneratedImages([], boundary));
  await f.clock.advance(4000);
  assert.equal(w.done.length, 0);
  image.complete = true;
  await f.clock.advance(4000);
  assert.equal(w.done.length, 1);
  assert.equal(w.done[0].imageCount, 1);
  w.close();
});

test('Temporary Chat keeps independent own DOM proof when no voice/send button exists', async () => {
  const f = fixture({ sourcePath, temporary: true });
  f.composer.remove();
  const boundary = f.createTurnBoundary(null, true);
  const w = watch(f, boundary, () => ({ ready: false, reason: 'conversation_url_pending' }));
  await f.clock.advance(4000);
  assert.equal(w.done.length, 0);
  f.turn('user', 'own-user', prompt);
  f.turn('assistant', 'own-final', 'DOM FINAL');
  await f.clock.advance(4000);
  assert.equal(w.done.length, 1);
  assert.equal(w.done[0].apiFinal.reason, 'temporary_chat_dom_final');
  w.close();
});

test('current Russian voice action is recognized but not required for explicit API proof', () => {
  const f = fixture({ sourcePath });
  f.voice.setAttribute('aria-label', 'Начать голосовой разговор');
  assert.equal(f.findVoiceBtn(), f.voice);
});

function resumedMain({ ack = 'confirmed' } = {}) {
  const f = fixture({ sourcePath });
  emptyPage(f);
  const calls = [], messages = [], disconnects = [];
  f.chrome.runtime.connect = () => ({ disconnect: () => disconnects.push('keepalive') });
  f.chrome.runtime.sendMessage = (message, callback) => {
    messages.push(message);
    callback?.({ ok: true, tabId: 42 });
  };
  f.window.scBridgeFetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    if (url.startsWith('/research-job')) return { ok: true, json: async () => ({
      id: 'new-job', provider: 'chatgpt', status: 'running', prompt,
      options: { mode: 'chat', model: '6-astra', effort: 'pro', autoClose: true }, attachments: [],
    }) };
    if (url === '/research-state' && body?.status === 'done') {
      if (ack === 'lost') throw new Error('terminal ACK lost');
      if (ack === 'failed') return { ok: false, status: 503 };
      return { ok: true, json: async () => ({ status: ack === 'confirmed' ? 'done' : 'running' }) };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  };
  f.setFetch(async (url, init = {}) => {
    assert.equal(init.method || 'GET', 'GET', 'offline provider fixture never sends');
    if (url === '/api/auth/session') return { ok: true, json: async () => ({ accessToken: 'fixture-not-a-secret' }) };
    assert.equal(url, '/backend-api/conversation/fixture');
    return { ok: true, json: async () => ({ ...apiConversation(own), conversation_id: 'fixture' }) };
  });
  return { f, calls, messages, disconnects };
}

test('actual main resumes without composer and writes its full result once before confirmed close', async () => {
  const { f, calls, messages, disconnects } = resumedMain();
  const boot = f.main();
  await f.clock.advance(30000);
  await boot;
  const writes = calls.filter(c => c.url === '/research-state' && c.body?.status === 'done');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].body.result.answer_text, 'OK');
  assert.equal(writes[0].body.result.model, '6-astra');
  assert.equal(messages.filter(m => m.__sc_close_self_tab).length, 1);
  assert.equal(messages.filter(m => m.__sc_focus_self).length, 0);
  assert.equal(disconnects.length, 1);
  assert.equal(calls.some(c => c.body?.stage === 'configuring' || c.body?.stage === 'submitting'), false);
});

for (const ack of ['lost', 'failed', 'unconfirmed']) {
  test(`actual main keeps tab/keepalive if terminal save is ${ack}; retries save, not provider action`, async () => {
    const { f, calls, messages, disconnects } = resumedMain({ ack });
    const boot = f.main();
    await f.clock.advance(30000);
    await boot;
    assert.equal(calls.filter(c => c.url === '/research-state' && c.body?.status === 'done').length, 5);
    assert.equal(messages.filter(m => m.__sc_close_self_tab || m.__sc_focus_self).length, 0);
    assert.equal(disconnects.length, 0);
    assert(calls.some(c => c.url === '/research-log' && c.body?.tag === 'gpt.terminal.giveup'));
    assert.equal(calls.some(c => c.body?.stage === 'submit_failed'), false);
  });
}
