const test = require('node:test');
const assert = require('node:assert/strict');
const { createNativeDialogController } = require('../mcp-native-dialogs.js');

function fixture(extra = {}) {
  const events = [], detach = [], removed = [], sent = [];
  const tabs = new Map([[1, { id: 1, windowId: 10, url: 'http://fixture.test/a' }],
    [2, { id: 2, windowId: 20, url: 'http://fixture.test/b' }]]);
  const emit = (tabId, method, data, sessionId) => events.forEach(f => f({ tabId, ...(sessionId ? { sessionId } : {}) }, method, data));
  const chrome = {
    tabs: { get: async id => { if (!tabs.has(id)) throw new Error('tab missing'); return tabs.get(id); },
      onRemoved: { addListener: f => removed.push(f) } },
    debugger: {
      getTargets: async () => [...tabs.values()].map(t => ({ tabId: t.id, type: 'page', id: 'target-' + t.id })),
      attach: async () => {},
      detach: async () => {},
      sendCommand: async (target, method, args) => {
        sent.push({ target, method, args });
        if (method === 'Page.handleJavaScriptDialog' && !extra.noClose)
          emit(target.tabId, 'Page.javascriptDialogClosed', { result: args.accept, userInput: args.promptText || '' }, target.sessionId);
        return {};
      },
      onEvent: { addListener: f => events.push(f) }, onDetach: { addListener: f => detach.push(f) },
    },
  };
  const c = createNativeDialogController(chrome, { epoch: 'fixture', timeoutMs: 20 });
  const open = (id = 1, type = 'confirm', text = 'Delete?', sessionId) => emit(id,
    'Page.javascriptDialogOpening', { type, message: text, url: tabs.get(id).url, defaultPrompt: 'default' }, sessionId);
  return { c, chrome, tabs, sent, emit, open, detach, removed };
}

test('explicit dialog discovery retains text, type and target/window identities', async () => {
  const f = fixture();
  assert.equal((await f.c.read(1)).status, 'none_observed');
  f.open();
  const { dialog } = await f.c.read(1);
  assert.equal(dialog.text, 'Delete?'); assert.equal(dialog.type, 'confirm');
  assert.equal(dialog.windowId, 10); assert.equal(dialog.targetId, 'target-1');
  assert.equal((await f.c.read(undefined)).success, false);
});

for (const accept of [true, false]) test(`confirm ${accept ? 'accept' : 'cancel'} requires real close proof`, async () => {
  const f = fixture(); await f.c.read(1); f.open();
  const { dialog } = await f.c.read(1);
  const result = await f.c.handle({ tabId: 1, dialogId: dialog.dialogId, accept });
  assert.equal(result.status, 'closed'); assert.equal(result.dialog.accepted, accept);
  assert.equal(result.verifiedBy, 'Page.javascriptDialogClosed');
  assert.equal((await f.c.read(1)).dialog, null);
});

test('prompt text, prompt cancel and alert dismissal use the browser protocol', async () => {
  const f = fixture(); await f.c.read(1);
  f.open(1, 'prompt'); let d = (await f.c.read(1)).dialog;
  let r = await f.c.handle({ tabId: 1, dialogId: d.dialogId, accept: true, promptText: 'Русский текст ✓' });
  assert.equal(r.dialog.userInput, 'Русский текст ✓');
  f.open(1, 'prompt'); d = (await f.c.read(1)).dialog;
  r = await f.c.handle({ tabId: 1, dialogId: d.dialogId, accept: false });
  assert.equal(r.dialog.accepted, false);
  f.open(1, 'alert'); d = (await f.c.read(1)).dialog;
  assert.equal((await f.c.handle({ tabId: 1, dialogId: d.dialogId, accept: true })).success, true);
});

test('wrong tab and stale dialog never send a response to a newer dialog', async () => {
  const f = fixture(); await f.c.read(1); await f.c.read(2); f.open();
  const old = (await f.c.read(1)).dialog;
  assert.equal((await f.c.handle({ tabId: 2, dialogId: old.dialogId, accept: true })).errorCode, 'DIALOG_STALE');
  f.emit(1, 'Page.javascriptDialogClosed', { result: false }); f.open();
  assert.equal((await f.c.handle({ tabId: 1, dialogId: old.dialogId, accept: true })).errorCode, 'DIALOG_STALE');
  assert.equal(f.sent.filter(x => x.method === 'Page.handleJavaScriptDialog').length, 0);
});

test('target/window change and detached identity invalidate handling', async () => {
  const f = fixture(); await f.c.read(1); f.open(); const d = (await f.c.read(1)).dialog;
  f.tabs.get(1).windowId = 22;
  assert.equal((await f.c.handle({ tabId: 1, dialogId: d.dialogId, accept: true })).errorCode, 'DIALOG_STALE');
  f.detach.forEach(h => h({ tabId: 1 }));
  assert.equal((await f.c.handle({ tabId: 1, dialogId: d.dialogId, accept: true })).errorCode, 'DIALOG_STALE');
});

test('command ACK without a close event is unknown, not success or permission to resend', async () => {
  const f = fixture({ noClose: true }); await f.c.read(1); f.open(); const d = (await f.c.read(1)).dialog;
  const r = await f.c.handle({ tabId: 1, dialogId: d.dialogId, accept: true });
  assert.equal(r.errorCode, 'DIALOG_OUTCOME_UNKNOWN'); assert.equal(r.retrySafe, false);
  assert.equal((await f.c.handle({ tabId: 1, dialogId: d.dialogId, accept: true })).errorCode, 'DIALOG_BUSY');
});

test('action that opens a dialog returns promptly and resumes once without replay', async () => {
  const f = fixture(); let count = 0, resume;
  const result = await f.c.run(1, 'click', () => {
    count++; f.open(); return new Promise(r => { resume = r; });
  });
  assert.equal(result.status, 'awaiting_dialog'); assert.equal(count, 1);
  assert.equal((await f.c.run(1, 'click', () => count++)).operationStarted, false);
  await f.c.handle({ tabId: 1, dialogId: result.dialog.dialogId, accept: false });
  assert.equal((await f.c.run(1, 'click', () => count++)).errorCode, 'PAGE_ACTION_PENDING');
  resume({ success: true, value: false }); await Promise.resolve(); await Promise.resolve();
  assert.equal((await f.c.read(1)).operation.state, 'completed'); assert.equal(count, 1);
});

test('same-tab child-frame dialog is addressed through its exact debugger session', async () => {
  const f = fixture(); await f.c.read(1); f.open(1, 'prompt', 'Child', 'child-session');
  const d = (await f.c.read(1)).dialog;
  await f.c.handle({ tabId: 1, dialogId: d.dialogId, accept: true, promptText: 'answer' });
  assert.equal(f.sent.at(-1).target.sessionId, 'child-session');
});

test('exact original operation result is read without repeating the action', async () => {
  const f = fixture(); let resolveAction;
  const action = await f.c.run(1, 'evaluate_raw', () => {
    f.open(); return new Promise(r => { resolveAction = r; });
  });
  await f.c.handle({ tabId: 1, dialogId: action.dialog.dialogId, accept: false });
  const receipt = f.c.read(1, action.operation.operationId);
  resolveAction({ success: true, result: false });
  assert.equal((await receipt).operation.result.result, false);
  assert.equal((await f.c.read(1, 'other-operation')).errorCode, 'DIALOG_OPERATION_STALE');
});

test('observer unavailable preserves legacy page capability with explicit missing coverage', async () => {
  const f = fixture(); let performed = false;
  f.chrome.debugger.sendCommand = async () => { throw new Error('Host access is restricted by policy'); };
  const result = await f.c.run(1, 'read', async () => { performed = true; return { success: true, text: 'legacy page' }; });
  assert.equal(performed, true); assert.equal(result.text, 'legacy page');
  assert.equal(result.nativeDialogObservation.coverage, 'unknown');
  assert.equal(result.nativeDialogObservation.retryPageActionSafe, false);
});

test('release refuses an open dialog and never detaches a borrowed attachment', async () => {
  const f = fixture(); let detaches = 0;
  f.chrome.debugger.detach = async () => { detaches++; };
  await f.c.read(1); f.open();
  assert.equal((await f.c.release(1)).errorCode, 'DIALOG_BUSY');
  const d = (await f.c.read(1)).dialog;
  await f.c.handle({ tabId: 1, dialogId: d.dialogId, accept: false });
  assert.equal((await f.c.release(1)).status, 'released'); assert.equal(detaches, 0);
});

test('concurrent answers for one dialog send at most one command even before target validation returns', async () => {
  const f = fixture(); await f.c.read(1); f.open(); const d = (await f.c.read(1)).dialog;
  const [a, b] = await Promise.all([
    f.c.handle({ tabId: 1, dialogId: d.dialogId, accept: true }),
    f.c.handle({ tabId: 1, dialogId: d.dialogId, accept: false }),
  ]);
  assert.equal(a.status, 'closed'); assert.equal(b.errorCode, 'DIALOG_BUSY');
  assert.equal(f.sent.filter(x => x.method === 'Page.handleJavaScriptDialog').length, 1);
});

test('late close from a different child session/frame does not clear the current dialog', async () => {
  const f = fixture(); await f.c.read(1);
  f.emit(1, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Current', frameId: 'frame-1' }, 'child-1');
  const d = (await f.c.read(1)).dialog;
  f.emit(1, 'Page.javascriptDialogClosed', { result: true, frameId: 'frame-2' }, 'child-2');
  f.emit(1, 'Page.javascriptDialogClosed', { result: true, frameId: 'frame-2' }, 'child-1');
  assert.equal((await f.c.read(1)).dialog.dialogId, d.dialogId);
});

test('owned observer release preserves focus-emulation ownership while ordinary owned release detaches', async () => {
  const f = fixture(); let attached = false, detaches = 0;
  f.chrome.debugger.sendCommand = async () => { if (!attached) throw new Error('Debugger is not attached'); };
  f.chrome.debugger.attach = async () => { attached = true; };
  f.chrome.debugger.detach = async () => { attached = false; detaches++; };
  await f.c.read(1);
  const previous = globalThis.scIsFocusEmulationAttached;
  try {
    globalThis.scIsFocusEmulationAttached = () => true;
    assert.equal((await f.c.release(1)).status, 'released'); assert.equal(detaches, 0);
    attached = false; await f.c.read(2);
    globalThis.scIsFocusEmulationAttached = () => false;
    assert.equal((await f.c.release(2)).status, 'released'); assert.equal(detaches, 1);
  } finally { globalThis.scIsFocusEmulationAttached = previous; }
});

test('real reload gate defers for native dialog and original pending action even with zero external jobs', async () => {
  const { createResearchAwareReloadGate } = require('../research-startup-recovery.js');
  const f = fixture(); let finish, reloads = 0;
  const action = await f.c.run(1, 'click', () => { f.open(); return new Promise(r => { finish = r; }); });
  const stored = {};
  const gate = createResearchAwareReloadGate({
    chromeApi: { storage: { local: { get: async defaults => ({ ...defaults, ...stored }),
      set: async patch => Object.assign(stored, patch) } },
      alarms: { create: async () => {}, clear: async () => {} } },
    listJobs: async () => f.c.activeOperations(), performReload: async () => { reloads++; },
  });
  assert.equal((await gate.request('source_edit')).deferred, true);
  await f.c.handle({ tabId: 1, dialogId: action.dialog.dialogId, accept: false });
  assert.equal((await gate.resume()).deferred, true); assert.equal(reloads, 0);
  finish({ success: true }); await f.c.read(1, action.operation.operationId);
  assert.equal((await gate.resume()).reloading, true); assert.equal(reloads, 1);
});
