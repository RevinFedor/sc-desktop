(function exposeResearchStartupRecovery(root) {
  'use strict';

  const STORAGE_KEY = '__sc_research_startup_recovery';
  const ALARM_PREFIX = 'sc-research-startup-retry:';
  const DEFAULT_MAX_RELOADS = 2;
  const DEFAULT_RETRY_DELAYS_MS = Object.freeze([1500, 5000]);
  const DEFAULT_NAVIGATION_SETTLE_MS = 15000;
  const DEFAULT_OFFLINE_RECHECK_MS = 5000;
  const DEFAULT_RETRY_DEADLINE_MS = 2 * 60 * 1000;
  const DEFAULT_STATE_TTL_MS = 24 * 60 * 60 * 1000;
  const RELOAD_GATE_STORAGE_KEY = '__sc_research_safe_reload_pending';
  const RELOAD_GATE_ALARM = 'sc-research-safe-reload';
  const DEFAULT_RELOAD_GATE_RETRY_MS = 15 * 1000;
  const ACTIVE_RESEARCH_STATUSES = new Set(['queued', 'pending', 'running']);
  const RESEARCH_CONTENT_FILES = Object.freeze({
    chatgpt: Object.freeze([
      'settings.js',
      'research-badge.js',
      'research-tab-policy.js',
      'chatgpt-research.js',
    ]),
    claude: Object.freeze([
      'logger.js',
      'settings.js',
      'claude-content.js',
      'research-badge.js',
      'claude-autoscrape.js',
      'research-tab-policy.js',
      'claude-research.js',
    ]),
    perplexity: Object.freeze([
      'logger.js',
      'settings.js',
      'perplexity-content.js',
      'research-badge.js',
      'research-tab-policy.js',
      'perplexity-research.js',
    ]),
  });

  function researchIdFromUrl(rawUrl) {
    try {
      const url = new URL(String(rawUrl || ''));
      const queryId = url.searchParams.get('sc-research');
      if (queryId) return queryId;
      const hashMatch = String(url.hash || '').match(/(?:^#|[&#])sc-research=([\w-]+)/);
      return hashMatch ? decodeURIComponent(hashMatch[1]) : null;
    } catch (_) {
      return null;
    }
  }

  function isChatGptUrl(rawUrl) {
    try {
      const hostname = new URL(String(rawUrl || '')).hostname;
      return hostname === 'chatgpt.com' || hostname === 'www.chatgpt.com';
    } catch (_) {
      return false;
    }
  }

  function alarmNameFor(researchId) {
    return ALARM_PREFIX + researchId;
  }

  function researchIdFromAlarmName(name) {
    return String(name || '').startsWith(ALARM_PREFIX)
      ? String(name).slice(ALARM_PREFIX.length)
      : null;
  }

  function beginResearchTabTracking(trackingSet, coordinator, { researchId, tab, targetUrl }) {
    if (Number.isInteger(tab?.id)) trackingSet?.add?.(tab.id);
    if (!researchId || !Number.isInteger(tab?.id) || typeof coordinator?.register !== 'function') {
      return Promise.resolve(null);
    }
    return coordinator.register({ researchId, tab, targetUrl });
  }

  function researchProviderFromUrl(rawUrl) {
    try {
      const hostname = new URL(String(rawUrl || '')).hostname.toLowerCase();
      if (hostname === 'chatgpt.com' || hostname === 'www.chatgpt.com') return 'chatgpt';
      if (hostname === 'claude.ai' || hostname.endsWith('.claude.ai')) return 'claude';
      if (hostname === 'perplexity.ai' || hostname.endsWith('.perplexity.ai')) return 'perplexity';
    } catch (_) {}
    return null;
  }

  function researchContentFilesForProvider(provider) {
    return [...(RESEARCH_CONTENT_FILES[provider] || [])];
  }

  function activeResearchJobs(jobs) {
    return (Array.isArray(jobs) ? jobs : []).filter(job =>
      job && ACTIVE_RESEARCH_STATUSES.has(String(job.status || '').toLowerCase()));
  }

  // Source edits must not tear down an active research content script. The
  // gate persists a pending reload, proves twice that no external job is
  // active, and only then reloads the extension. If the bridge is uncertain,
  // it defers instead of converting missing state into permission to reload.
  function createResearchAwareReloadGate(options = {}) {
    const chromeApi = options.chromeApi;
    if (!chromeApi?.storage?.local || !chromeApi?.alarms) {
      throw new Error('research-aware reload gate requires storage.local and alarms');
    }
    const now = typeof options.now === 'function' ? options.now : () => Date.now();
    const listJobs = typeof options.listJobs === 'function' ? options.listJobs : async () => [];
    const performReload = typeof options.performReload === 'function'
      ? options.performReload
      : async () => chromeApi.runtime.reload();
    const log = typeof options.log === 'function' ? options.log : async () => {};
    const retryDelayMs = Number(options.retryDelayMs) || DEFAULT_RELOAD_GATE_RETRY_MS;
    let operation = Promise.resolve();

    const serialize = fn => {
      const current = operation.catch(() => {}).then(fn);
      operation = current.catch(() => {});
      return current;
    };
    const readPending = async () => {
      const stored = await chromeApi.storage.local.get({ [RELOAD_GATE_STORAGE_KEY]: null });
      const pending = stored?.[RELOAD_GATE_STORAGE_KEY];
      return pending && typeof pending === 'object' ? pending : null;
    };
    const writePending = async value => {
      await chromeApi.storage.local.set({ [RELOAD_GATE_STORAGE_KEY]: value || null });
    };
    const schedule = async () => {
      await chromeApi.alarms.create(RELOAD_GATE_ALARM, { when: now() + retryDelayMs });
    };
    const defer = async (pending, reason, jobs = [], error = null) => {
      await schedule();
      await log('sw.hot_reload.deferred', {
        source: pending.source,
        requestedAt: pending.requestedAt,
        reason,
        activeCount: jobs.length,
        activeJobs: jobs.slice(0, 20).map(job => ({
          id: job.jobId || job.id || null,
          provider: job.provider || null,
          status: job.status || null,
          stage: job.stage || null,
          tabId: job.tabId ?? null,
        })),
        error: error ? String(error?.message || error).slice(0, 300) : null,
      });
      return { deferred: true, reason, activeCount: jobs.length };
    };
    const inspect = async () => activeResearchJobs(await listJobs());
    const attemptUnlocked = async () => {
      const pending = await readPending();
      if (!pending) return { deferred: false, reason: 'no_pending_reload' };
      let first;
      try {
        first = await inspect();
      } catch (error) {
        return defer(pending, 'job_state_unavailable', [], error);
      }
      if (first.length) return defer(pending, 'active_research', first);

      // Close the check→reload race as far as the current bridge contract
      // permits: a job that appeared during the first await cancels reload.
      let second;
      try {
        second = await inspect();
      } catch (error) {
        return defer(pending, 'job_state_unavailable_recheck', [], error);
      }
      if (second.length) return defer(pending, 'active_research_recheck', second);

      await writePending(null);
      try { await chromeApi.alarms.clear(RELOAD_GATE_ALARM); } catch (_) {}
      await log('sw.hot_reload.applying', {
        source: pending.source,
        requestedAt: pending.requestedAt,
        waitedMs: Math.max(0, now() - Number(pending.requestedAt || now())),
      });
      await performReload();
      return { reloading: true, deferred: false };
    };

    return {
      request(source = 'unknown') {
        return serialize(async () => {
          const existing = await readPending();
          await writePending(existing || { source: String(source), requestedAt: now() });
          return attemptUnlocked();
        });
      },
      handleAlarm(alarm) {
        if ((typeof alarm === 'string' ? alarm : alarm?.name) !== RELOAD_GATE_ALARM) {
          return Promise.resolve({ ignored: true });
        }
        return serialize(attemptUnlocked);
      },
      resume() {
        return serialize(attemptUnlocked);
      },
      readPending,
    };
  }

  // Manifest content scripts are not automatically re-injected into an
  // already loaded page after chrome.runtime.reload(). On every SW boot we
  // ping the script belonging to each durable active research tab. A normal
  // MV3 respin receives a pong and remains untouched; an extension reload has
  // no live receiver, so the exact provider bundle is injected into the same
  // tab and its existing job/window.name recovery path resumes the watcher.
  async function recoverResearchContentScripts(options = {}) {
    const states = Array.isArray(options.states) ? options.states : [];
    const chromeApi = options.chromeApi;
    const getJobState = typeof options.getJobState === 'function'
      ? options.getJobState : async () => ({ found: false });
    const pingTab = typeof options.pingTab === 'function' ? options.pingTab : async () => false;
    const prepareTab = typeof options.prepareTab === 'function' ? options.prepareTab : async () => {};
    const injectFiles = typeof options.injectFiles === 'function' ? options.injectFiles : async () => {};
    const wait = typeof options.wait === 'function'
      ? options.wait : ms => new Promise(resolve => setTimeout(resolve, ms));
    const log = typeof options.log === 'function' ? options.log : async () => {};
    const results = [];

    for (const state of states) {
      const researchId = state?.researchId;
      const tabId = state?.tabId;
      if (!researchId || !Number.isInteger(tabId)) continue;
      let tab;
      try { tab = await chromeApi.tabs.get(tabId); }
      catch (_) { results.push({ researchId, tabId, action: 'tab_missing' }); continue; }
      const provider = researchProviderFromUrl(tab?.url || state.lastUrl || state.targetUrl);
      if (!provider || !RESEARCH_CONTENT_FILES[provider]) {
        results.push({ researchId, tabId, action: 'unsupported_page' });
        continue;
      }
      let job;
      try { job = await getJobState(researchId); }
      catch (error) {
        await log('sw.content_recovery.deferred', { researchId, tabId, provider, reason: 'job_state_unavailable', error: String(error?.message || error).slice(0, 300) });
        results.push({ researchId, tabId, action: 'job_state_unavailable' });
        continue;
      }
      if (!job?.found || !ACTIVE_RESEARCH_STATUSES.has(String(job.status || '').toLowerCase())) {
        results.push({ researchId, tabId, action: 'terminal' });
        continue;
      }
      if (job.provider && job.provider !== provider) {
        await log('sw.content_recovery.rejected', { researchId, tabId, provider, jobProvider: job.provider, reason: 'provider_mismatch' });
        results.push({ researchId, tabId, action: 'provider_mismatch' });
        continue;
      }
      if (tab.discarded) {
        await log('sw.content_recovery.deferred', { researchId, tabId, provider, reason: 'tab_discarded' });
        results.push({ researchId, tabId, action: 'tab_discarded' });
        continue;
      }
      let alive = false;
      try { alive = await pingTab(tabId, provider); } catch (_) {}
      if (!alive) {
        await wait(500);
        try { alive = await pingTab(tabId, provider); } catch (_) {}
      }
      if (alive) {
        results.push({ researchId, tabId, action: 'alive' });
        continue;
      }
      const files = researchContentFilesForProvider(provider);
      try {
        // chrome.runtime.reload() detaches debugger-owned focus emulation.
        // Restore it before the watcher so the recovered hidden tab keeps
        // rendering without stealing OS focus. Failure is logged but does not
        // suppress the content-script recovery itself.
        try { await prepareTab(tabId, provider); }
        catch (error) {
          await log('sw.content_recovery.prepare_failed', {
            researchId, tabId, provider, error: String(error?.message || error).slice(0, 300),
          });
        }
        await injectFiles(tabId, files);
        await log('sw.content_recovery.injected', {
          researchId, tabId, provider, status: job.status, stage: job.stage || null, files: files.length,
        });
        results.push({ researchId, tabId, action: 'injected' });
      } catch (error) {
        await log('sw.content_recovery.failed', { researchId, tabId, provider, error: String(error?.message || error).slice(0, 300) });
        results.push({ researchId, tabId, action: 'inject_failed' });
      }
    }
    return results;
  }

  function createResearchStartupCoordinator(options = {}) {
    const chromeApi = options.chromeApi;
    if (!chromeApi?.storage?.local) throw new Error('research startup coordinator requires chrome.storage.local');
    const now = typeof options.now === 'function' ? options.now : () => Date.now();
    const log = typeof options.log === 'function' ? options.log : async () => {};
    const getJobState = typeof options.getJobState === 'function'
      ? options.getJobState
      : async () => ({ found: false, reason: 'job_state_unavailable' });
    const updateJobState = typeof options.updateJobState === 'function'
      ? options.updateJobState
      : async () => ({ updated: false });
    const reloadTab = typeof options.reloadTab === 'function'
      ? options.reloadTab
      : async (tabId) => chromeApi.tabs.reload(tabId, { bypassCache: true });
    const online = typeof options.isOnline === 'function'
      ? options.isOnline
      : () => typeof navigator === 'undefined' || navigator.onLine !== false;
    const maxReloads = Number.isInteger(options.maxReloads) ? options.maxReloads : DEFAULT_MAX_RELOADS;
    const retryDelaysMs = Array.isArray(options.retryDelaysMs) && options.retryDelaysMs.length
      ? options.retryDelaysMs.map(Number)
      : DEFAULT_RETRY_DELAYS_MS;
    const navigationSettleMs = Number(options.navigationSettleMs) || DEFAULT_NAVIGATION_SETTLE_MS;
    const offlineRecheckMs = Number(options.offlineRecheckMs) || DEFAULT_OFFLINE_RECHECK_MS;
    const retryDeadlineMs = Number(options.retryDeadlineMs) || DEFAULT_RETRY_DEADLINE_MS;
    const stateTtlMs = Number(options.stateTtlMs) || DEFAULT_STATE_TTL_MS;
    let storageLock = Promise.resolve();

    const eventTime = details => Number.isFinite(Number(details?.timeStamp))
      ? Number(details.timeStamp)
      : now();
    const safePhase = state => !!state && (
      state.phase === 'committed'
      || state.phase === 'cs_booted'
      || state.phase === 'protected'
      || Number.isFinite(state.committedAt)
      || Number.isFinite(state.csBootAt)
    );
    const retryDelay = count => retryDelaysMs[Math.min(Math.max(0, count), retryDelaysMs.length - 1)];

    async function readAll() {
      const stored = await chromeApi.storage.local.get({ [STORAGE_KEY]: {} });
      const value = stored?.[STORAGE_KEY];
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    }

    async function writeMutation(mutator) {
      let result;
      storageLock = storageLock.catch(() => {}).then(async () => {
        const states = { ...(await readAll()) };
        result = await mutator(states);
        await chromeApi.storage.local.set({ [STORAGE_KEY]: states });
      });
      await storageLock;
      return result;
    }

    async function readState(researchId) {
      const states = await readAll();
      return states[researchId] ? { ...states[researchId] } : null;
    }

    async function mutateState(researchId, mutator) {
      return writeMutation(async states => {
        const current = states[researchId] ? { ...states[researchId] } : null;
        const result = await mutator(current);
        if (result?.remove) delete states[researchId];
        else if (result?.state) states[researchId] = { ...result.state, updatedAt: now() };
        return result?.value;
      });
    }

    async function resolveResearchId(details = {}) {
      const fromUrl = researchIdFromUrl(details.url);
      if (fromUrl) return fromUrl;
      if (!isChatGptUrl(details.url)) return null;
      if (!Number.isInteger(details.tabId)) return null;
      const states = await readAll();
      return Object.entries(states).find(([, state]) => state?.tabId === details.tabId)?.[0] || null;
    }

    async function createAlarm(researchId, when) {
      await chromeApi.alarms.create(alarmNameFor(researchId), { when: Math.max(now() + 1, Number(when) || now() + 1) });
    }

    async function clearAlarm(researchId) {
      try { await chromeApi.alarms.clear(alarmNameFor(researchId)); } catch (_) {}
    }

    async function publishState(researchId, state, stage, error) {
      try {
        await updateJobState({
          id: researchId,
          tabId: state?.tabId ?? null,
          stage,
          error,
          retryCount: state?.retryCount || 0,
          maxReloads,
        });
      } catch (_) {}
    }

    async function emit(tag, researchId, state, data = {}) {
      try {
        await log(tag, {
          researchId,
          tabId: state?.tabId ?? data.tabId ?? null,
          url: String(data.url || state?.lastUrl || state?.targetUrl || '').slice(0, 240),
          phase: state?.phase || null,
          retryCount: state?.retryCount || 0,
          maxReloads,
          ...data,
        });
      } catch (_) {}
    }

    async function register({ researchId, tab, targetUrl }) {
      if (!researchId || !Number.isInteger(tab?.id)) return null;
      const state = await mutateState(researchId, current => {
        const createdAt = current?.createdAt || now();
        const next = {
          ...(current || {}),
          researchId,
          tabId: tab.id,
          windowId: Number.isInteger(tab.windowId) ? tab.windowId : (current?.windowId ?? null),
          targetUrl: String(targetUrl || current?.targetUrl || tab.url || ''),
          lastUrl: String(tab.url || current?.lastUrl || targetUrl || ''),
          createdAt,
          registeredAt: current?.registeredAt || now(),
          retryCount: Number.isInteger(current?.retryCount) ? current.retryCount : 0,
          phase: current?.phase || 'opening',
        };
        return { state: next, value: next };
      });
      await emit('sw.navigation.registered', researchId, state, { reused: !!tab.reused });
      if (state?.nextRetryAt && !safePhase(state)) await createAlarm(researchId, state.nextRetryAt);
      return state;
    }

    function staleEventReason(state, details) {
      const at = eventTime(details);
      if (Number.isFinite(state?.navigationStartedAt) && at + 1 < state.navigationStartedAt) return 'older_than_active_navigation';
      if (state?.activeDocumentId && details?.documentId && state.activeDocumentId !== details.documentId) return 'different_document';
      if (Number.isFinite(state?.reloadStartedAt) && at + 1 < state.reloadStartedAt) return 'older_than_reload';
      return null;
    }

    async function noteNavigationStarted(details = {}) {
      if (details.frameId !== 0 || !Number.isInteger(details.tabId)) return { ignored: true, reason: 'not_main_frame' };
      const researchId = await resolveResearchId(details);
      if (!researchId || (!isChatGptUrl(details.url) && !await readState(researchId))) {
        return { ignored: true, reason: 'not_research' };
      }
      const at = eventTime(details);
      const state = await mutateState(researchId, current => {
        if (safePhase(current)) return { state: current, value: current };
        const next = {
          ...(current || {}),
          researchId,
          tabId: details.tabId,
          targetUrl: current?.targetUrl || details.url,
          lastUrl: details.url || current?.lastUrl || '',
          createdAt: current?.createdAt || now(),
          phase: current?.phase === 'exhausted' ? 'manual_navigation' : ((current?.retryCount || 0) ? 'retry_navigation' : 'opening'),
          navigationStartedAt: at,
          activeDocumentId: details.documentId || null,
          retryCount: current?.retryCount || 0,
        };
        return { state: next, value: next };
      });
      await emit('sw.navigation.started', researchId, state, {
        url: details.url,
        documentId: details.documentId || null,
        eventAt: at,
      });
      return { researchId, state };
    }

    async function noteNavigationCommitted(details = {}) {
      if (details.frameId !== 0 || !Number.isInteger(details.tabId)) return { ignored: true, reason: 'not_main_frame' };
      if (!isChatGptUrl(details.url)) return { ignored: true, reason: 'not_chatgpt_document' };
      const researchId = await resolveResearchId(details);
      if (!researchId) return { ignored: true, reason: 'not_research' };
      let ignoredReason = null;
      const state = await mutateState(researchId, current => {
        ignoredReason = staleEventReason(current, details);
        if (ignoredReason) return { state: current, value: current };
        const next = {
          ...(current || {}),
          researchId,
          tabId: details.tabId,
          lastUrl: details.url || current?.lastUrl || '',
          phase: 'committed',
          committedAt: eventTime(details),
          committedDocumentId: details.documentId || null,
          nextRetryAt: null,
        };
        return { state: next, value: next };
      });
      if (ignoredReason) {
        await emit('sw.navigation.committed_ignored', researchId, state, { reason: ignoredReason, url: details.url });
        return { ignored: true, reason: ignoredReason, researchId };
      }
      await clearAlarm(researchId);
      await emit('sw.navigation.committed', researchId, state, {
        url: details.url,
        documentId: details.documentId || null,
        eventAt: eventTime(details),
      });
      return { researchId, state };
    }

    async function noteCsBoot({ researchId: explicitId, tabId, url, timeStamp } = {}) {
      const researchId = explicitId || researchIdFromUrl(url) || await resolveResearchId({ tabId, url });
      if (!researchId || !Number.isInteger(tabId)) return { ignored: true, reason: 'not_research' };
      const state = await mutateState(researchId, current => {
        const next = {
          ...(current || {}),
          researchId,
          tabId,
          targetUrl: current?.targetUrl || url || '',
          lastUrl: url || current?.lastUrl || '',
          createdAt: current?.createdAt || now(),
          phase: 'cs_booted',
          csBootAt: Number.isFinite(Number(timeStamp)) ? Number(timeStamp) : now(),
          nextRetryAt: null,
          retryCount: current?.retryCount || 0,
        };
        return { state: next, value: next };
      });
      await clearAlarm(researchId);
      await emit('sw.navigation.cs_boot', researchId, state, { url });
      return { researchId, state };
    }

    async function markExhausted(researchId, state, reason) {
      const exhausted = await mutateState(researchId, current => {
        const next = {
          ...(current || state || {}),
          phase: 'exhausted',
          exhaustedAt: now(),
          exhaustedReason: reason,
          nextRetryAt: null,
        };
        return { state: next, value: next };
      });
      await clearAlarm(researchId);
      const error = `initial_navigation_failed: ${exhausted?.lastError || reason}; automatic reloads exhausted (${exhausted?.retryCount || 0}/${maxReloads}); manual reload remains available`;
      await publishState(researchId, exhausted, 'opening_retry_exhausted', error);
      await emit('sw.navigation.recovery_exhausted', researchId, exhausted, { reason, error });
      return exhausted;
    }

    async function noteNavigationError(details = {}) {
      if (details.frameId !== 0 || !Number.isInteger(details.tabId)) return { ignored: true, reason: 'not_main_frame' };
      const researchId = await resolveResearchId(details);
      if (!researchId || !isChatGptUrl(details.url)) return { ignored: true, reason: 'not_chatgpt_research' };
      const at = eventTime(details);
      const error = String(details.error || 'unknown navigation error').slice(0, 180);
      let decision = null;
      const state = await mutateState(researchId, current => {
        const base = {
          ...(current || {}),
          researchId,
          tabId: details.tabId,
          targetUrl: current?.targetUrl || details.url,
          lastUrl: details.url || current?.lastUrl || '',
          createdAt: current?.createdAt || now(),
          retryCount: current?.retryCount || 0,
        };
        const stale = staleEventReason(base, details);
        const signature = `${details.documentId || details.url || 'unknown'}|${error}`;
        if (safePhase(base)) decision = { eligible: false, reason: 'commit_or_cs_already_observed' };
        else if (stale) decision = { eligible: false, reason: stale };
        else if (/ERR_ABORTED/i.test(error)) decision = { eligible: false, reason: 'aborted_navigation' };
        else if (base.lastErrorSignature === signature && at - Number(base.lastErrorAt || 0) < 30000) {
          decision = { eligible: false, reason: 'duplicate_error' };
        } else {
          const firstErrorAt = base.firstErrorAt || at;
          const retryDeadlineAt = base.retryDeadlineAt || (firstErrorAt + retryDeadlineMs);
          if (base.retryCount >= maxReloads || now() >= retryDeadlineAt) {
            decision = { eligible: false, reason: 'retry_limit' };
            Object.assign(base, {
              phase: 'exhausted', exhaustedAt: now(), exhaustedReason: 'retry_limit', nextRetryAt: null,
              lastError: error, lastErrorAt: at, lastErrorSignature: signature, firstErrorAt, retryDeadlineAt,
            });
          } else {
            const nextRetryAt = Math.min(retryDeadlineAt, now() + retryDelay(base.retryCount));
            decision = { eligible: true, reason: 'initial_main_frame_error', nextRetryAt };
            Object.assign(base, {
              phase: 'retry_wait', nextRetryAt,
              lastError: error, lastErrorAt: at, lastErrorSignature: signature,
              firstErrorAt, retryDeadlineAt,
              activeDocumentId: details.documentId || base.activeDocumentId || null,
            });
          }
        }
        return { state: base, value: base };
      });
      await emit('sw.navigation.error', researchId, state, {
        url: details.url,
        error,
        documentId: details.documentId || null,
        eventAt: at,
        eligible: !!decision?.eligible,
        reason: decision?.reason || 'unknown',
      });
      if (decision?.reason === 'retry_limit') {
        await markExhausted(researchId, state, 'retry_limit');
        return { researchId, eligible: false, exhausted: true };
      }
      if (!decision?.eligible) return { researchId, eligible: false, reason: decision?.reason };
      await createAlarm(researchId, decision.nextRetryAt);
      await publishState(
        researchId,
        state,
        'opening_retry_wait',
        `initial_navigation_failed: ${error}; retry ${state.retryCount + 1}/${maxReloads} scheduled`,
      );
      await emit('sw.navigation.recovery_scheduled', researchId, state, {
        error,
        nextRetryAt: decision.nextRetryAt,
      });
      return { researchId, eligible: true, nextRetryAt: decision.nextRetryAt };
    }

    async function postpone(researchId, state, phase, reason) {
      if (now() >= Number(state?.retryDeadlineAt || 0)) return markExhausted(researchId, state, reason);
      const nextRetryAt = Math.min(state.retryDeadlineAt, now() + offlineRecheckMs);
      const next = await mutateState(researchId, current => {
        const value = { ...(current || state), phase, nextRetryAt };
        return { state: value, value };
      });
      await createAlarm(researchId, nextRetryAt);
      await publishState(
        researchId,
        next,
        phase === 'offline_wait' ? 'opening_waiting_for_network' : 'opening_retry_wait',
        `initial_navigation_failed: ${next.lastError || reason}; waiting (${reason})`,
      );
      await emit('sw.navigation.recovery_postponed', researchId, next, { reason, nextRetryAt });
      return next;
    }

    async function handleReloadFailure(researchId, state, error) {
      if ((state?.retryCount || 0) >= maxReloads) return markExhausted(researchId, state, 'reload_call_failed');
      const nextRetryAt = Math.min(state.retryDeadlineAt, now() + retryDelay(state.retryCount));
      const next = await mutateState(researchId, current => {
        const value = {
          ...(current || state),
          phase: 'retry_wait',
          nextRetryAt,
          lastReloadError: String(error?.message || error).slice(0, 180),
        };
        return { state: value, value };
      });
      await createAlarm(researchId, nextRetryAt);
      await emit('sw.navigation.reload_failed', researchId, next, {
        error: next.lastReloadError,
        nextRetryAt,
      });
      return next;
    }

    async function handleAlarm(alarm) {
      const researchId = researchIdFromAlarmName(typeof alarm === 'string' ? alarm : alarm?.name);
      if (!researchId) return { ignored: true, reason: 'not_startup_alarm' };
      let state = await readState(researchId);
      if (!state) { await clearAlarm(researchId); return { ignored: true, reason: 'missing_state' }; }
      if (safePhase(state)) { await clearAlarm(researchId); return { ignored: true, reason: 'safe_phase' }; }
      if (now() < Number(state.nextRetryAt || 0)) {
        await createAlarm(researchId, state.nextRetryAt);
        return { ignored: true, reason: 'not_due' };
      }
      if (now() >= Number(state.retryDeadlineAt || 0)) {
        await markExhausted(researchId, state, 'retry_deadline');
        return { exhausted: true, reason: 'retry_deadline' };
      }
      if (!online()) {
        await postpone(researchId, state, 'offline_wait', 'network_offline');
        return { postponed: true, reason: 'network_offline' };
      }

      let job;
      try { job = await getJobState(researchId); }
      catch (_) { job = { found: false, reason: 'bridge_unavailable' }; }
      if (!job?.found) {
        await postpone(researchId, state, 'bridge_wait', job?.reason || 'job_state_unavailable');
        return { postponed: true, reason: job?.reason || 'job_state_unavailable' };
      }
      if (job.status !== 'queued') {
        state = await mutateState(researchId, current => {
          const next = {
            ...(current || state),
            phase: 'protected',
            protectedAt: now(),
            protectedReason: `job_${job.status || 'unknown'}_${job.stage || 'none'}`,
            nextRetryAt: null,
          };
          return { state: next, value: next };
        });
        await clearAlarm(researchId);
        await emit('sw.navigation.recovery_suppressed', researchId, state, {
          reason: 'job_not_queued',
          jobStatus: job.status || null,
          jobStage: job.stage || null,
        });
        return { ignored: true, reason: 'job_not_queued' };
      }

      let claim = null;
      state = await mutateState(researchId, current => {
        if (!current || safePhase(current)) return { state: current, value: current };
        if ((current.retryCount || 0) >= maxReloads) {
          claim = { exhausted: true };
          return { state: current, value: current };
        }
        const retryCount = (current.retryCount || 0) + 1;
        const next = {
          ...current,
          phase: 'reloading',
          retryCount,
          reloadStartedAt: now(),
          navigationStartedAt: now(),
          activeDocumentId: null,
          nextRetryAt: now() + navigationSettleMs,
        };
        claim = { tabId: next.tabId, retryCount };
        return { state: next, value: next };
      });
      if (claim?.exhausted) {
        await markExhausted(researchId, state, 'retry_limit');
        return { exhausted: true, reason: 'retry_limit' };
      }
      if (!claim || !Number.isInteger(claim.tabId)) {
        await clearAlarm(researchId);
        return { ignored: true, reason: 'claim_lost_or_tab_missing' };
      }

      await publishState(
        researchId,
        state,
        'opening_retrying',
        `initial_navigation_failed: ${state.lastError || 'navigation error'}; reloading same tab ${claim.retryCount}/${maxReloads}`,
      );
      // publishState crosses the network. A content script may commit and
      // acknowledge cs.boot while that await is in flight. Re-read durable
      // startup proof immediately before the synchronous tabs.reload call.
      const beforeReload = await readState(researchId);
      if (safePhase(beforeReload)
          || beforeReload?.phase !== 'reloading'
          || beforeReload?.retryCount !== claim.retryCount) {
        await clearAlarm(researchId);
        await emit('sw.navigation.recovery_suppressed', researchId, beforeReload, {
          reason: 'startup_proof_after_retry_claim',
        });
        return { ignored: true, reason: 'startup_proof_after_retry_claim' };
      }
      await emit('sw.navigation.reload', researchId, state, {
        tabId: claim.tabId,
        attempt: claim.retryCount,
      });
      try {
        await reloadTab(claim.tabId);
      } catch (error) {
        await handleReloadFailure(researchId, state, error);
        return { reloaded: false, reason: 'reload_call_failed' };
      }
      await createAlarm(researchId, state.nextRetryAt);
      return { reloaded: true, tabId: claim.tabId, attempt: claim.retryCount };
    }

    async function networkOnline() {
      const states = await readAll();
      for (const [researchId, state] of Object.entries(states)) {
        if (!['offline_wait', 'bridge_wait', 'retry_wait'].includes(state?.phase)) continue;
        if (safePhase(state)) continue;
        await mutateState(researchId, current => {
          const next = { ...current, phase: 'retry_wait', nextRetryAt: now() + 1 };
          return { state: next, value: next };
        });
        await createAlarm(researchId, now() + 1);
      }
    }

    async function replaceTab(removedTabId, addedTabId) {
      if (!Number.isInteger(removedTabId) || !Number.isInteger(addedTabId)) return [];
      return writeMutation(async states => {
        const changed = [];
        for (const [researchId, state] of Object.entries(states)) {
          if (state?.tabId !== removedTabId) continue;
          states[researchId] = { ...state, tabId: addedTabId, updatedAt: now() };
          changed.push(researchId);
        }
        return changed;
      });
    }

    async function forgetTab(tabId) {
      if (!Number.isInteger(tabId)) return [];
      const removed = await writeMutation(async states => {
        const ids = [];
        for (const [researchId, state] of Object.entries(states)) {
          if (state?.tabId !== tabId) continue;
          delete states[researchId];
          ids.push(researchId);
        }
        return ids;
      });
      for (const id of removed) await clearAlarm(id);
      return removed;
    }

    async function restore() {
      const states = await readAll();
      const live = [];
      for (const [researchId, state] of Object.entries(states)) {
        if (!state || now() - Number(state.updatedAt || state.createdAt || 0) > stateTtlMs) {
          await mutateState(researchId, () => ({ remove: true }));
          await clearAlarm(researchId);
          continue;
        }
        try {
          const tab = await chromeApi.tabs.get(state.tabId);
          if (!tab) throw new Error('tab missing');
          live.push({ researchId, ...state, tabId: tab.id });
          if (state.nextRetryAt && !safePhase(state)) await createAlarm(researchId, Math.max(now() + 1, state.nextRetryAt));
        } catch (_) {
          await mutateState(researchId, () => ({ remove: true }));
          await clearAlarm(researchId);
        }
      }
      return live;
    }

    return {
      register,
      noteNavigationStarted,
      noteNavigationCommitted,
      noteNavigationError,
      noteCsBoot,
      handleAlarm,
      networkOnline,
      replaceTab,
      forgetTab,
      restore,
      readState,
      alarmNameFor,
    };
  }

  function installDefaultCoordinator(chromeApi) {
    const bridge = 'http://127.0.0.1:53127';
    const getJobState = async researchId => {
      const response = await fetch(`${bridge}/research-status?id=${encodeURIComponent(researchId)}`);
      if (!response.ok) return { found: false, reason: `research_status_http_${response.status}` };
      const job = await response.json();
      return {
        found: true,
        provider: job.provider || null,
        status: job.status,
        stage: job.stage,
        error: job.error || null,
      };
    };
    const updateJobState = async payload => {
      const current = await getJobState(payload.id);
      if (!current.found || current.status !== 'queued') {
        return { updated: false, reason: current.found ? `job_${current.status}` : current.reason };
      }
      const response = await fetch(`${bridge}/research-state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: payload.id,
          provider: 'chatgpt',
          stage: payload.stage,
          tabId: payload.tabId,
          error: payload.error,
        }),
      });
      return { updated: response.ok, status: response.status };
    };
    const log = async (tag, data) => {
      await fetch(`${bridge}/research-log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: data.researchId,
          tabId: data.tabId,
          tag,
          url: data.url,
          data,
        }),
      });
    };
    const coordinator = createResearchStartupCoordinator({ chromeApi, getJobState, updateJobState, log });
    root.scResearchStartup = coordinator;

    chromeApi.webNavigation?.onBeforeNavigate?.addListener(details => {
      coordinator.noteNavigationStarted(details).catch(() => {});
    });
    chromeApi.webNavigation?.onCommitted?.addListener(details => {
      coordinator.noteNavigationCommitted(details).catch(() => {});
    });
    chromeApi.webNavigation?.onErrorOccurred?.addListener(details => {
      coordinator.noteNavigationError(details).catch(() => {});
    });
    chromeApi.alarms?.onAlarm?.addListener(alarm => {
      if (researchIdFromAlarmName(alarm?.name)) coordinator.handleAlarm(alarm).catch(() => {});
    });
    chromeApi.tabs?.onReplaced?.addListener((addedTabId, removedTabId) => {
      coordinator.replaceTab(removedTabId, addedTabId).catch(() => {});
    });
    chromeApi.tabs?.onRemoved?.addListener(tabId => {
      coordinator.forgetTab(tabId).catch(() => {});
    });
    chromeApi.runtime?.onMessage?.addListener((request, sender, sendResponse) => {
      if (request?.__sc_research_startup_boot !== true) return undefined;
      coordinator.noteCsBoot({
        researchId: request.researchId || null,
        tabId: sender?.tab?.id ?? request.tabId ?? null,
        url: request.url || sender?.tab?.url || '',
        timeStamp: request.timeStamp,
      }).then(result => sendResponse({ ok: true, result }))
        .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    });
    try { root.addEventListener?.('online', () => coordinator.networkOnline().catch(() => {})); } catch (_) {}
    const restored = coordinator.restore().catch(() => []);
    root.scResearchStartupRestore = restored;

    if (chromeApi.scripting?.executeScript && chromeApi.tabs?.sendMessage) {
      const pingTab = (tabId, provider) => new Promise(resolve => {
        try {
          chromeApi.tabs.sendMessage(tabId, { __sc_research_content_ping: true, provider }, response => {
            const error = chromeApi.runtime?.lastError;
            resolve(!error && response?.ok === true && response.provider === provider);
          });
        } catch (_) { resolve(false); }
      });
      root.scResearchContentRecovery = restored.then(states => recoverResearchContentScripts({
        states,
        chromeApi,
        getJobState,
        pingTab,
        prepareTab: (tabId, provider) => {
          if (typeof root.scAttachFocusEmulation !== 'function') return Promise.resolve({ ok: false, reason: 'focus_emulation_unavailable' });
          return root.scAttachFocusEmulation(tabId, provider);
        },
        injectFiles: (tabId, files) => chromeApi.scripting.executeScript({ target: { tabId }, files }),
        log,
      })).catch(() => []);
    }

    if (chromeApi.runtime?.reload) {
      const reloadGate = createResearchAwareReloadGate({
        chromeApi,
        listJobs: async () => {
          const response = await fetch(`${bridge}/external-jobs?summary=1`);
          if (!response.ok) throw new Error(`external_jobs_http_${response.status}`);
          const payload = await response.json();
          if (!Array.isArray(payload?.jobs)) throw new Error('external_jobs_invalid_payload');
          // Do not invalidate a native-dialog identity or its suspended click
          // merely because no paid external research is active.
          return [...payload.jobs, ...(root.scMcpNativeDialogs?.activeOperations?.() || [])];
        },
        // Give the MCP/bridge command handler one turn to return its ACK
        // before this service worker destroys its own runtime context.
        performReload: async () => {
          setTimeout(() => { try { chromeApi.runtime.reload(); } catch (_) {} }, 50);
        },
        log,
      });
      root.scResearchReloadGate = reloadGate;
      chromeApi.alarms?.onAlarm?.addListener(alarm => {
        if (alarm?.name === RELOAD_GATE_ALARM) reloadGate.handleAlarm(alarm).catch(() => {});
      });
      reloadGate.resume().catch(() => {});
    }
    return coordinator;
  }

  root.SC_RESEARCH_STARTUP_STORAGE_KEY = STORAGE_KEY;
  root.SC_RESEARCH_STARTUP_ALARM_PREFIX = ALARM_PREFIX;
  root.SC_RESEARCH_RELOAD_GATE_STORAGE_KEY = RELOAD_GATE_STORAGE_KEY;
  root.SC_RESEARCH_RELOAD_GATE_ALARM = RELOAD_GATE_ALARM;
  root.createResearchStartupCoordinator = createResearchStartupCoordinator;
  root.createResearchAwareReloadGate = createResearchAwareReloadGate;
  root.recoverResearchContentScripts = recoverResearchContentScripts;
  root.researchContentFilesForProvider = researchContentFilesForProvider;
  root.beginResearchTabTracking = beginResearchTabTracking;
  if (root.chrome?.storage?.local) installDefaultCoordinator(root.chrome);

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      STORAGE_KEY,
      ALARM_PREFIX,
      DEFAULT_MAX_RELOADS,
      researchIdFromUrl,
      alarmNameFor,
      researchIdFromAlarmName,
      beginResearchTabTracking,
      createResearchStartupCoordinator,
      RELOAD_GATE_STORAGE_KEY,
      RELOAD_GATE_ALARM,
      createResearchAwareReloadGate,
      recoverResearchContentScripts,
      researchContentFilesForProvider,
    };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
