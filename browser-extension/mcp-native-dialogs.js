// Native JS dialogs live in the browser process, not the page DOM. Never
// override window.confirm or auto-accept: observe Page events on the real tab.
(function (root) {
  function createNativeDialogController(chrome, options = {}) {
    const sessions = new Map();
    const epoch = options.epoch || crypto.randomUUID();
    const timeoutMs = options.timeoutMs || 5000;
    let sequence = 0;
    const log = options.log || (() => {});
    const fail = (errorCode, error, extra = {}) => ({ success: false, errorCode, error, ...extra });
    const copy = d => d ? { ...d } : null;
    const bounded = (promise, why) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(why)), timeoutMs);
      Promise.resolve(promise).then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
    });

    async function ensure(tabId) {
      if (!Number.isInteger(tabId) || tabId < 0) throw new Error('An explicit tabId is required');
      const tab = await chrome.tabs.get(tabId);
      let session = sessions.get(tabId);
      if (session) { await session.ready; return session; }
      const target = (await chrome.debugger.getTargets()).find(t => t.tabId === tabId && t.type === 'page');
      if (!target) throw new Error('No browser debugger target for tab');
      session = { tabId, windowId: tab.windowId, targetId: target.id, url: tab.url,
        owned: false, ready: null, dialog: null, listeners: new Set(), closed: new Map(), operation: null };
      sessions.set(tabId, session);
      session.ready = (async () => {
        // Reuse this extension's existing focus-emulation attachment. A foreign
        // DevTools owner cannot be commandeered by a failed attach + retry.
        try { await bounded(chrome.debugger.sendCommand({ tabId }, 'Page.enable', {}), 'Page.enable timed out'); }
        catch (e) {
          if (!/not attached|not debugging|Debugger is not/i.test(e.message)) throw e;
          await bounded(chrome.debugger.attach({ tabId }, '1.3'), 'debugger attach timed out');
          session.owned = true;
          await bounded(chrome.debugger.sendCommand({ tabId }, 'Page.enable', {}), 'Page.enable timed out');
        }
        log('observe', { tabId, targetId: target.id, owned: session.owned });
      })();
      try { await session.ready; } catch (e) {
        // Keep ownership after an ambiguous enable timeout; never re-attach or
        // claim that a pre-existing modal is absent just because events stalled.
        if (!session.owned) sessions.delete(tabId);
        throw e;
      }
      return session;
    }

    function onEvent(source, method, params = {}) {
      const s = sessions.get(source?.tabId);
      if (!s) return;
      if (method === 'Page.javascriptDialogOpening') {
        s.dialog = { dialogId: `${epoch}:${++sequence}`, tabId: s.tabId, windowId: s.windowId,
          targetId: s.targetId, sessionId: source.sessionId || null, frameId: params.frameId || null,
          type: params.type, text: params.message || '', url: params.url || s.url,
          defaultPrompt: params.defaultPrompt || '', hasBrowserHandler: params.hasBrowserHandler,
          openedAt: Date.now(), source: 'chrome.debugger' };
        log('opened', { tabId: s.tabId, dialogId: s.dialog.dialogId, type: s.dialog.type });
        for (const listener of [...s.listeners]) listener({ kind: 'opened', dialog: copy(s.dialog) });
      } else if (method === 'Page.javascriptDialogClosed' && s.dialog &&
        (source.sessionId || null) === s.dialog.sessionId &&
        (!params.frameId || !s.dialog.frameId || params.frameId === s.dialog.frameId)) {
        const closed = { ...s.dialog, closedAt: Date.now(), accepted: params.result === true,
          userInput: params.userInput || '' };
        s.closed.set(closed.dialogId, closed);
        if (s.closed.size > 8) s.closed.delete(s.closed.keys().next().value);
        s.dialog = null;
        log('closed', { tabId: s.tabId, dialogId: closed.dialogId, accepted: closed.accepted });
        for (const listener of [...s.listeners]) listener({ kind: 'closed', dialog: copy(closed) });
      }
    }

    function forget(tabId, reason) {
      const s = sessions.get(tabId);
      if (!s) return;
      sessions.delete(tabId);
      for (const listener of [...s.listeners]) listener({ kind: 'detached', reason });
    }
    chrome.debugger.onEvent.addListener(onEvent);
    chrome.debugger.onDetach.addListener(source => forget(source?.tabId, 'debugger detached'));
    chrome.tabs.onRemoved.addListener(tabId => forget(tabId, 'tab removed'));

    function operationSnapshot(s) {
      if (!s.operation) return null;
      const { operationId, state, result, error } = s.operation;
      return { operationId, state, ...(state === 'completed' ? { result } : {}), ...(error ? { error } : {}) };
    }
    async function read(tabId, operationId) {
      try {
        const s = await ensure(tabId);
        await s.ready;
        if (operationId && s.operation?.operationId !== operationId)
          return fail('DIALOG_OPERATION_STALE', 'This tab no longer has the requested page operation');
        if (operationId && s.operation?.state === 'pending') {
          try { await bounded(s.operation.promise, 'Original page operation is still pending'); } catch {}
        }
        return { success: true, status: s.dialog ? 'open' : 'none_observed', dialog: copy(s.dialog),
          tabId, windowId: s.windowId, targetId: s.targetId, operation: operationSnapshot(s),
          // Page.enable does not replay dialogs opened BEFORE observation.
          coverage: 'since_observer_attached', revision: '2026-10-05-native-dialogs-r2' };
      } catch (e) { return fail('DIALOG_OBSERVER_UNAVAILABLE', e.message, {
        status: 'unobservable', tabId, coverage: 'unknown', retryPageActionSafe: false,
        message: 'A pre-existing unobserved dialog can block Page.enable. This does not prove no dialog or no side effect.',
      }); }
    }

    async function handle({ tabId, dialogId, accept, promptText }) {
      if (!Number.isInteger(tabId) || typeof dialogId !== 'string' || typeof accept !== 'boolean')
        return fail('DIALOG_ARGUMENTS', 'Explicit tabId, dialogId and boolean accept are required');
      const s = sessions.get(tabId);
      if (!s || !s.dialog || s.dialog.dialogId !== dialogId)
        return fail('DIALOG_STALE', 'Dialog identity is not currently open on this tab; nothing was sent');
      const d = s.dialog;
      if (d.handling) return fail('DIALOG_BUSY', 'A response for this dialog is already in flight');
      if (promptText !== undefined && (d.type !== 'prompt' || !accept || typeof promptText !== 'string'))
        return fail('DIALOG_ARGUMENTS', 'promptText is only allowed when accepting a prompt');
      // Claim BEFORE any await: two concurrent responses for one dialog must
      // not both pass validation and send (the second could close a new modal).
      d.handling = true;
      let commandSent = false;
      let listener;
      const closed = new Promise(resolve => {
        listener = event => {
          if (event.kind === 'detached' || (event.kind === 'closed' && event.dialog.dialogId === dialogId)) resolve(event);
        };
        s.listeners.add(listener);
      });
      try {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        const target = (await chrome.debugger.getTargets()).find(t => t.tabId === tabId && t.type === 'page');
        if (!tab || tab.windowId !== d.windowId || target?.id !== d.targetId || s.dialog !== d)
          return fail('DIALOG_STALE', 'Target changed after dialog read; nothing was sent');
        const debuggee = { tabId, ...(d.sessionId ? { sessionId: d.sessionId } : {}) };
        commandSent = true;
        await bounded(chrome.debugger.sendCommand(debuggee, 'Page.handleJavaScriptDialog', {
          accept, ...(promptText !== undefined ? { promptText } : {}),
        }), 'Dialog command outcome unknown');
        const event = await bounded(closed, 'Dialog close was not confirmed');
        if (event.kind !== 'closed') return fail('DIALOG_OUTCOME_UNKNOWN', event.reason, { dialogId, retrySafe: false });
        // Allow the original page-side operation to resume; do not replay it.
        await Promise.resolve();
        return { success: true, status: 'closed', dialog: event.dialog,
          operation: operationSnapshot(s), verifiedBy: 'Page.javascriptDialogClosed' };
      } catch (e) {
        return fail('DIALOG_OUTCOME_UNKNOWN', e.message, { dialogId, retrySafe: false,
          dialog: copy(s.dialog), operation: operationSnapshot(s) });
      } finally {
        s.listeners.delete(listener);
        if (!commandSent && s.dialog === d) d.handling = false;
      }
    }

    async function run(tabId, action, invoke) {
      const state = await read(tabId);
      if (!state.success) {
        // Added observation must not disable legacy DOM actions when a browser
        // policy/DevTools owner blocks it. Report the missing coverage explicitly.
        const result = await invoke();
        return { ...result, nativeDialogObservation: state };
      }
      const s = sessions.get(tabId);
      if (s.dialog) return fail('NATIVE_DIALOG_OPEN', 'Handle the existing native dialog before page actions', {
        status: 'blocked', dialog: copy(s.dialog), operationStarted: false });
      if (s.operation?.state === 'pending') return fail('PAGE_ACTION_PENDING', 'Previous page action is unresolved; do not repeat it', {
        operation: operationSnapshot(s), operationStarted: false });
      const op = { operationId: `${epoch}:action:${++sequence}`, action, state: 'pending' };
      s.operation = op;
      let listener;
      const opened = new Promise(resolve => {
        listener = event => {
          if (event.kind === 'opened') resolve(fail('NATIVE_DIALOG_OPEN', 'Page action is waiting for a native dialog; do not repeat it', {
            status: 'awaiting_dialog', dialog: event.dialog, operation: operationSnapshot(s), operationStarted: true }));
        };
        s.listeners.add(listener);
      });
      const operation = Promise.resolve().then(invoke).then(result => {
        op.state = 'completed'; op.result = result; return result;
      }, e => { op.state = 'error'; op.error = e.message; return fail('PAGE_ACTION_FAILED', e.message); });
      op.promise = operation;
      try { return await Promise.race([operation, opened]); }
      finally { s.listeners.delete(listener); }
    }
    async function release(tabId) {
      const s = sessions.get(tabId);
      if (!s) return { success: true, status: 'not_observed', tabId };
      if (s.dialog || s.operation?.state === 'pending')
        return fail('DIALOG_BUSY', 'Cannot release while a dialog or original page operation is pending');
      if (s.owned && !root.scIsFocusEmulationAttached?.(tabId)) {
        await chrome.debugger.detach({ tabId });
      }
      forget(tabId, 'observer released');
      return { success: true, status: 'released', tabId };
    }
    const activeOperations = () => [...sessions.values()].filter(s => s.dialog || s.operation?.state === 'pending')
      .map(s => ({ id: s.dialog?.dialogId || s.operation?.operationId,
        provider: 'browser-mcp', status: 'running', stage: s.dialog ? 'native_dialog' : 'page_action', tabId: s.tabId }));
    return { read, handle, run, release, ensure, activeOperations,
      hasAttachment: tabId => sessions.has(tabId), forget };
  }
  root.createScNativeDialogController = createNativeDialogController;
  if (typeof module === 'object' && module.exports) module.exports = { createNativeDialogController };
  if (root.chrome?.debugger) root.scMcpNativeDialogs = createNativeDialogController(root.chrome, {
    log: (event, data) => {
      console.info('[SC MCP Dialog]', event, data);
      try { root.scBgDbg?.('mcp.dialog.' + event, data); } catch {}
      // Persistent diagnostics contain identities/type/outcome, never dialog
      // text, prompt input, cookies or page bodies.
      try { fetch('http://127.0.0.1:53127/research-log', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tabId: data.tabId, tag: 'mcp.dialog.' + event, data }),
        signal: AbortSignal.timeout(3000),
      }).catch(() => {}); } catch {}
    },
  });
})(globalThis);
