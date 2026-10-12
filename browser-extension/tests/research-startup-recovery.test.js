const test = require('node:test');
const assert = require('node:assert/strict');
const {
  STORAGE_KEY,
  alarmNameFor,
  beginResearchTabTracking,
  createResearchStartupCoordinator,
  RELOAD_GATE_STORAGE_KEY,
  RELOAD_GATE_ALARM,
  createResearchAwareReloadGate,
  recoverResearchContentScripts,
  researchContentFilesForProvider,
} = require('../research-startup-recovery');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function harness(options = {}) {
  let clock = options.now ?? 1000;
  let online = options.online ?? true;
  let job = { found: true, status: options.jobStatus || 'queued', stage: options.jobStage || 'opening' };
  let updateHook = null;
  const storage = {};
  const alarms = new Map();
  const reloads = [];
  const logs = [];
  const stateUpdates = [];
  const tabs = new Map([[42, { id: 42, windowId: 7, url: 'https://chatgpt.com/?sc-research=job-1' }]]);
  const chromeApi = {
    storage: {
      local: {
        async get(defaults = {}) { return { ...clone(defaults), ...clone(storage) }; },
        async set(patch) { Object.assign(storage, clone(patch)); },
      },
    },
    alarms: {
      async create(name, detail) { alarms.set(name, { name, ...detail }); },
      async clear(name) { return alarms.delete(name); },
    },
    tabs: {
      async get(tabId) {
        if (!tabs.has(tabId)) throw new Error('No tab');
        return clone(tabs.get(tabId));
      },
      async reload(tabId) { reloads.push(tabId); },
    },
  };
  const coordinatorOptions = {
    chromeApi,
    now: () => clock,
    isOnline: () => online,
    getJobState: async () => clone(job),
    updateJobState: async value => {
      stateUpdates.push(clone(value));
      if (updateHook) await updateHook(value);
      return { updated: true };
    },
    reloadTab: async tabId => { reloads.push(tabId); },
    log: async (tag, data) => logs.push({ tag, data: clone(data) }),
    retryDelaysMs: [10, 20],
    navigationSettleMs: 50,
    offlineRecheckMs: 20,
    retryDeadlineMs: 200,
  };
  return {
    chromeApi,
    storage,
    alarms,
    reloads,
    logs,
    stateUpdates,
    tabs,
    coordinatorOptions,
    coordinator: createResearchStartupCoordinator(coordinatorOptions),
    now: () => clock,
    advance(ms) { clock += ms; },
    setOnline(value) { online = value; },
    setJob(value) { job = { ...job, ...value }; },
    setUpdateHook(value) { updateHook = value; },
  };
}

async function registerAndStart(h, id = 'job-1', tabId = 42, documentId = 'doc-1') {
  await h.coordinator.register({
    researchId: id,
    tab: { id: tabId, windowId: 7, url: `https://chatgpt.com/?sc-research=${id}` },
    targetUrl: `https://chatgpt.com/?sc-research=${id}`,
  });
  await h.coordinator.noteNavigationStarted({
    tabId, frameId: 0, documentId, timeStamp: h.now(),
    url: `https://chatgpt.com/?sc-research=${id}`,
  });
}

test('initial main-frame failure reloads the same tab once, then commit and CS boot disarm recovery', async () => {
  const h = harness();
  await registerAndStart(h);
  h.advance(1);
  const failed = await h.coordinator.noteNavigationError({
    tabId: 42, frameId: 0, documentId: 'doc-1', timeStamp: h.now(),
    url: 'https://chatgpt.com/?sc-research=job-1', error: 'net::ERR_CONNECTION_RESET',
  });
  assert.equal(failed.eligible, true);
  h.advance(10);
  assert.deepEqual(await h.coordinator.handleAlarm(alarmNameFor('job-1')), {
    reloaded: true, tabId: 42, attempt: 1,
  });
  assert.deepEqual(h.reloads, [42]);

  h.advance(1);
  await h.coordinator.noteNavigationStarted({
    tabId: 42, frameId: 0, documentId: 'doc-2', timeStamp: h.now(),
    url: 'https://chatgpt.com/?sc-research=job-1',
  });
  h.advance(1);
  await h.coordinator.noteNavigationCommitted({
    tabId: 42, frameId: 0, documentId: 'doc-2', timeStamp: h.now(),
    url: 'https://chatgpt.com/?sc-research=job-1',
  });
  await h.coordinator.noteCsBoot({
    researchId: 'job-1', tabId: 42, timeStamp: h.now(),
    url: 'https://chatgpt.com/?sc-research=job-1',
  });
  h.advance(100);
  assert.equal((await h.coordinator.handleAlarm(alarmNameFor('job-1'))).reason, 'safe_phase');
  assert.equal(h.reloads.length, 1);
  assert.equal((await h.coordinator.readState('job-1')).phase, 'cs_booted');
});

test('an error that arrives before handler registration is retained and recovered after registration', async () => {
  const h = harness();
  h.tabs.set(77, { id: 77, windowId: 8, url: 'https://chatgpt.com/?sc-research=early-job' });
  const result = await h.coordinator.noteNavigationError({
    tabId: 77, frameId: 0, documentId: 'early-doc', timeStamp: h.now(),
    url: 'https://chatgpt.com/?sc-research=early-job', error: 'net::ERR_INTERNET_DISCONNECTED',
  });
  assert.equal(result.eligible, true);
  await h.coordinator.register({
    researchId: 'early-job',
    tab: { id: 77, windowId: 8, url: 'https://chatgpt.com/?sc-research=early-job' },
    targetUrl: 'https://chatgpt.com/?sc-research=early-job',
  });
  assert.equal((await h.coordinator.readState('early-job')).lastError, 'net::ERR_INTERNET_DISCONNECTED');
  h.advance(10);
  await h.coordinator.handleAlarm(alarmNameFor('early-job'));
  assert.deepEqual(h.reloads, [77]);
});

test('iframe errors, aborted redirects, stale documents and errors after commit never reload', async () => {
  const h = harness();
  await registerAndStart(h);
  assert.equal((await h.coordinator.noteNavigationCommitted({
    tabId: 42, frameId: 0, documentId: 'blank', timeStamp: h.now(), url: 'about:blank',
  })).reason, 'not_chatgpt_document');
  assert.equal((await h.coordinator.noteNavigationError({
    tabId: 42, frameId: 2, documentId: 'iframe', timeStamp: h.now(),
    url: 'https://chatgpt.com/frame', error: 'net::ERR_FAILED',
  })).reason, 'not_main_frame');
  assert.equal((await h.coordinator.noteNavigationError({
    tabId: 42, frameId: 0, documentId: 'doc-1', timeStamp: h.now(),
    url: 'https://chatgpt.com/?sc-research=job-1', error: 'net::ERR_ABORTED',
  })).reason, 'aborted_navigation');
  assert.equal((await h.coordinator.noteNavigationError({
    tabId: 42, frameId: 0, documentId: 'older-doc', timeStamp: h.now() - 1,
    url: 'https://chatgpt.com/?sc-research=job-1', error: 'net::ERR_FAILED',
  })).reason, 'different_document');

  h.advance(1);
  await h.coordinator.noteNavigationCommitted({
    tabId: 42, frameId: 0, documentId: 'doc-1', timeStamp: h.now(),
    url: 'https://chatgpt.com/?sc-research=job-1',
  });
  h.advance(1);
  assert.equal((await h.coordinator.noteNavigationError({
    tabId: 42, frameId: 0, documentId: 'doc-1', timeStamp: h.now(),
    url: 'https://chatgpt.com/?sc-research=job-1', error: 'net::ERR_CONNECTION_CLOSED',
  })).reason, 'commit_or_cs_already_observed');
  assert.equal(h.alarms.size, 0);
  assert.deepEqual(h.reloads, []);
});

test('retry count survives coordinator recreation, duplicate errors do not spend it, and exhaustion permits later manual recovery', async () => {
  const h = harness();
  await registerAndStart(h);
  h.advance(1);
  const failure = {
    tabId: 42, frameId: 0, documentId: 'doc-1', timeStamp: h.now(),
    url: 'https://chatgpt.com/?sc-research=job-1', error: 'net::ERR_CONNECTION_RESET',
  };
  await h.coordinator.noteNavigationError(failure);
  h.advance(1);
  assert.equal((await h.coordinator.noteNavigationError({ ...failure, timeStamp: h.now() })).reason, 'duplicate_error');

  const afterRestart = createResearchStartupCoordinator(h.coordinatorOptions);
  h.advance(9);
  await afterRestart.handleAlarm(alarmNameFor('job-1'));
  assert.deepEqual(h.reloads, [42]);
  assert.equal((await afterRestart.readState('job-1')).retryCount, 1);

  h.advance(1);
  await afterRestart.noteNavigationStarted({
    tabId: 42, frameId: 0, documentId: 'doc-2', timeStamp: h.now(),
    url: 'https://chatgpt.com/?sc-research=job-1',
  });
  h.advance(1);
  await afterRestart.noteNavigationError({
    tabId: 42, frameId: 0, documentId: 'doc-2', timeStamp: h.now(),
    url: 'https://chatgpt.com/?sc-research=job-1', error: 'net::ERR_CONNECTION_RESET',
  });
  h.advance(20);
  await afterRestart.handleAlarm(alarmNameFor('job-1'));
  assert.deepEqual(h.reloads, [42, 42]);
  assert.equal((await afterRestart.readState('job-1')).retryCount, 2);

  h.advance(1);
  await afterRestart.noteNavigationStarted({
    tabId: 42, frameId: 0, documentId: 'doc-3', timeStamp: h.now(),
    url: 'https://chatgpt.com/?sc-research=job-1',
  });
  h.advance(1);
  const exhausted = await afterRestart.noteNavigationError({
    tabId: 42, frameId: 0, documentId: 'doc-3', timeStamp: h.now(),
    url: 'https://chatgpt.com/?sc-research=job-1', error: 'net::ERR_CONNECTION_RESET',
  });
  assert.equal(exhausted.exhausted, true);
  assert.equal(h.stateUpdates.at(-1).stage, 'opening_retry_exhausted');
  assert.match(h.stateUpdates.at(-1).error, /manual reload remains available/);

  h.advance(30);
  await afterRestart.noteNavigationStarted({
    tabId: 42, frameId: 0, documentId: 'manual-doc', timeStamp: h.now(),
    url: 'https://chatgpt.com/?sc-research=job-1',
  });
  h.advance(1);
  await afterRestart.noteNavigationCommitted({
    tabId: 42, frameId: 0, documentId: 'manual-doc', timeStamp: h.now(),
    url: 'https://chatgpt.com/?sc-research=job-1',
  });
  await afterRestart.noteCsBoot({
    researchId: 'job-1', tabId: 42, timeStamp: h.now(),
    url: 'https://chatgpt.com/?sc-research=job-1',
  });
  assert.equal((await afterRestart.readState('job-1')).phase, 'cs_booted');
  assert.deepEqual(h.reloads, [42, 42]);
});

test('offline time and bridge uncertainty postpone without spending reloads; recovery reloads once when both proofs return', async () => {
  const h = harness({ online: false });
  await registerAndStart(h);
  h.advance(1);
  await h.coordinator.noteNavigationError({
    tabId: 42, frameId: 0, documentId: 'doc-1', timeStamp: h.now(),
    url: 'https://chatgpt.com/?sc-research=job-1', error: 'net::ERR_INTERNET_DISCONNECTED',
  });
  h.advance(10);
  assert.equal((await h.coordinator.handleAlarm(alarmNameFor('job-1'))).reason, 'network_offline');
  assert.equal((await h.coordinator.readState('job-1')).retryCount, 0);
  assert.deepEqual(h.reloads, []);

  h.setOnline(true);
  await h.coordinator.networkOnline();
  h.advance(1);
  await h.coordinator.handleAlarm(alarmNameFor('job-1'));
  assert.deepEqual(h.reloads, [42]);

  const uncertain = harness();
  uncertain.coordinatorOptions.getJobState = async () => ({ found: false, reason: 'bridge_unavailable' });
  uncertain.coordinator = createResearchStartupCoordinator(uncertain.coordinatorOptions);
  await registerAndStart(uncertain);
  uncertain.advance(1);
  await uncertain.coordinator.noteNavigationError({
    tabId: 42, frameId: 0, documentId: 'doc-1', timeStamp: uncertain.now(),
    url: 'https://chatgpt.com/?sc-research=job-1', error: 'net::ERR_FAILED',
  });
  uncertain.advance(10);
  assert.equal((await uncertain.coordinator.handleAlarm(alarmNameFor('job-1'))).reason, 'bridge_unavailable');
  assert.equal((await uncertain.coordinator.readState('job-1')).retryCount, 0);
  assert.deepEqual(uncertain.reloads, []);
});

test('a running bridge job or an observed CS boot protects against a late duplicate reload and send', async () => {
  const h = harness({ jobStatus: 'running', jobStage: 'submitting' });
  await registerAndStart(h);
  h.advance(1);
  await h.coordinator.noteNavigationError({
    tabId: 42, frameId: 0, documentId: 'doc-1', timeStamp: h.now(),
    url: 'https://chatgpt.com/?sc-research=job-1', error: 'net::ERR_FAILED',
  });
  h.advance(10);
  assert.equal((await h.coordinator.handleAlarm(alarmNameFor('job-1'))).reason, 'job_not_queued');
  assert.equal((await h.coordinator.readState('job-1')).phase, 'protected');
  assert.deepEqual(h.reloads, []);

  const booted = harness();
  await registerAndStart(booted);
  await booted.coordinator.noteCsBoot({
    researchId: 'job-1', tabId: 42, timeStamp: booted.now(),
    url: 'https://chatgpt.com/?sc-research=job-1',
  });
  booted.advance(1);
  assert.equal((await booted.coordinator.noteNavigationError({
    tabId: 42, frameId: 0, documentId: 'doc-1', timeStamp: booted.now(),
    url: 'https://chatgpt.com/?sc-research=job-1', error: 'net::ERR_FAILED',
  })).reason, 'commit_or_cs_already_observed');
  assert.deepEqual(booted.reloads, []);
});

test('CS boot arriving while retry state is published cancels the already-claimed reload', async () => {
  const h = harness();
  await registerAndStart(h);
  h.advance(1);
  await h.coordinator.noteNavigationError({
    tabId: 42, frameId: 0, documentId: 'doc-1', timeStamp: h.now(),
    url: 'https://chatgpt.com/?sc-research=job-1', error: 'net::ERR_FAILED',
  });
  h.setUpdateHook(async update => {
    if (update.stage !== 'opening_retrying') return;
    await h.coordinator.noteCsBoot({
      researchId: 'job-1', tabId: 42, timeStamp: h.now(),
      url: 'https://chatgpt.com/?sc-research=job-1',
    });
  });
  h.advance(10);
  const result = await h.coordinator.handleAlarm(alarmNameFor('job-1'));

  assert.equal(result.reason, 'startup_proof_after_retry_claim');
  assert.deepEqual(h.reloads, []);
  assert.equal((await h.coordinator.readState('job-1')).phase, 'cs_booted');
});

test('handler tracking marks the tab synchronously before durable registration awaits', async () => {
  const tracked = new Set();
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const coordinator = {
    register() { return pending; },
  };
  const started = beginResearchTabTracking(tracked, coordinator, {
    researchId: 'job-early',
    tab: { id: 99, windowId: 5, url: 'https://chatgpt.com/?sc-research=job-early' },
    targetUrl: 'https://chatgpt.com/?sc-research=job-early',
  });
  assert.equal(tracked.has(99), true);
  release({ ok: true });
  await started;
});

test('stored startup state can be restored without resetting retry count after a service-worker respin', async () => {
  const h = harness();
  await registerAndStart(h);
  h.advance(1);
  await h.coordinator.noteNavigationError({
    tabId: 42, frameId: 0, documentId: 'doc-1', timeStamp: h.now(),
    url: 'https://chatgpt.com/?sc-research=job-1', error: 'net::ERR_FAILED',
  });
  h.advance(10);
  await h.coordinator.handleAlarm(alarmNameFor('job-1'));
  assert.equal(h.storage[STORAGE_KEY]['job-1'].retryCount, 1);

  const afterRestart = createResearchStartupCoordinator(h.coordinatorOptions);
  const restored = await afterRestart.restore();
  assert.equal(restored.length, 1);
  assert.equal(restored[0].tabId, 42);
  assert.equal(restored[0].retryCount, 1);
});

test('automatic extension reload is deferred while research is active and applied after it finishes', async () => {
  const storage = {};
  const alarms = new Map();
  const logs = [];
  let jobs = [{ jobId: 'live-job', status: 'running', stage: 'waiting_extended', provider: 'chatgpt' }];
  let reloads = 0;
  const chromeApi = {
    storage: { local: {
      async get(defaults = {}) { return { ...clone(defaults), ...clone(storage) }; },
      async set(patch) { Object.assign(storage, clone(patch)); },
    } },
    alarms: {
      async create(name, detail) { alarms.set(name, { name, ...detail }); },
      async clear(name) { return alarms.delete(name); },
    },
  };
  const gate = createResearchAwareReloadGate({
    chromeApi,
    listJobs: async () => clone(jobs),
    performReload: async () => { reloads++; },
    log: async (tag, data) => logs.push({ tag, data: clone(data) }),
    now: () => 1000,
    retryDelayMs: 25,
  });

  const deferred = await gate.request('ws_mtime');
  assert.equal(deferred.deferred, true);
  assert.equal(deferred.reason, 'active_research');
  assert.equal(reloads, 0);
  assert.equal(storage[RELOAD_GATE_STORAGE_KEY].source, 'ws_mtime');
  assert.equal(alarms.has(RELOAD_GATE_ALARM), true);

  jobs = [{ jobId: 'live-job', status: 'done', stage: 'done', provider: 'chatgpt' }];
  const applied = await gate.handleAlarm({ name: RELOAD_GATE_ALARM });
  assert.equal(applied.reloading, true);
  assert.equal(reloads, 1);
  assert.equal(storage[RELOAD_GATE_STORAGE_KEY], null);
  assert(logs.some(item => item.tag === 'sw.hot_reload.deferred'));
  assert(logs.some(item => item.tag === 'sw.hot_reload.applying'));
});

test('reload gate rechecks immediately before reload and fails safe when bridge state is unknown', async () => {
  const storage = {};
  const alarms = new Map();
  let reloads = 0;
  let reads = 0;
  const chromeApi = {
    storage: { local: {
      async get(defaults = {}) { return { ...clone(defaults), ...clone(storage) }; },
      async set(patch) { Object.assign(storage, clone(patch)); },
    } },
    alarms: {
      async create(name, detail) { alarms.set(name, { name, ...detail }); },
      async clear(name) { return alarms.delete(name); },
    },
  };
  const racing = createResearchAwareReloadGate({
    chromeApi,
    listJobs: async () => (++reads === 1 ? [] : [{ jobId: 'late-job', status: 'queued' }]),
    performReload: async () => { reloads++; },
    now: () => 1000,
    retryDelayMs: 25,
  });
  assert.equal((await racing.request('http_mtime')).reason, 'active_research_recheck');
  assert.equal(reloads, 0);

  const unavailable = createResearchAwareReloadGate({
    chromeApi,
    listJobs: async () => { throw new Error('bridge offline'); },
    performReload: async () => { reloads++; },
    now: () => 1000,
    retryDelayMs: 25,
  });
  assert.equal((await unavailable.request('manual')).reason, 'job_state_unavailable');
  assert.equal(reloads, 0);
  assert.equal(alarms.has(RELOAD_GATE_ALARM), true);
});

test('extension boot reinjects the correct research scripts only when an active tab has no live content script', async () => {
  const injected = [];
  const prepared = [];
  const logs = [];
  let pings = 0;
  const chromeApi = {
    tabs: {
      async get(tabId) {
        return { id: tabId, status: 'complete', discarded: false, url: 'https://chatgpt.com/c/abc' };
      },
    },
  };
  const results = await recoverResearchContentScripts({
    states: [{ researchId: 'job-1', tabId: 42 }],
    chromeApi,
    getJobState: async () => ({ found: true, status: 'running', stage: 'waiting_extended', provider: 'chatgpt' }),
    pingTab: async () => { pings++; return false; },
    prepareTab: async (tabId, provider) => prepared.push({ tabId, provider }),
    injectFiles: async (tabId, files) => injected.push({ tabId, files }),
    wait: async () => {},
    log: async (tag, data) => logs.push({ tag, data: clone(data) }),
  });
  assert.equal(pings, 2);
  assert.deepEqual(prepared, [{ tabId: 42, provider: 'chatgpt' }]);
  assert.deepEqual(injected, [{ tabId: 42, files: researchContentFilesForProvider('chatgpt') }]);
  assert.equal(results[0].action, 'injected');
  assert(logs.some(item => item.tag === 'sw.content_recovery.injected'));
});

test('extension boot does not duplicate a live script or inject terminal/provider-mismatched jobs', async () => {
  const injected = [];
  const tabs = new Map([
    [1, { id: 1, status: 'complete', discarded: false, url: 'https://chatgpt.com/c/one' }],
    [2, { id: 2, status: 'complete', discarded: false, url: 'https://chatgpt.com/c/two' }],
    [3, { id: 3, status: 'complete', discarded: false, url: 'https://claude.ai/chat/three' }],
  ]);
  const chromeApi = { tabs: { async get(tabId) { return clone(tabs.get(tabId)); } } };
  const jobs = {
    alive: { found: true, status: 'running', provider: 'chatgpt' },
    done: { found: true, status: 'done', provider: 'chatgpt' },
    mismatch: { found: true, status: 'running', provider: 'perplexity' },
  };
  const results = await recoverResearchContentScripts({
    states: [
      { researchId: 'alive', tabId: 1 },
      { researchId: 'done', tabId: 2 },
      { researchId: 'mismatch', tabId: 3 },
    ],
    chromeApi,
    getJobState: async id => clone(jobs[id]),
    pingTab: async (_tabId, provider) => provider === 'chatgpt',
    injectFiles: async (tabId, files) => injected.push({ tabId, files }),
    wait: async () => {},
  });
  assert.deepEqual(injected, []);
  assert.deepEqual(results.map(item => item.action), ['alive', 'terminal', 'provider_mismatch']);
});
