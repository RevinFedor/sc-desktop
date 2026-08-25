(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.__scLearningStore = api;
})(typeof self !== 'undefined' ? self : globalThis, function (root) {
  'use strict';

  const DB_NAME = 'sc-learning-v1';
  const DB_VERSION = 1;
  const ENTRIES = 'entries';
  const OUTBOX = 'outbox';
  const META = 'meta';
  const BRIDGE = 'http://127.0.0.1:53127';
  const EXTENSION_ID = 'phnlfhkblebijojjnnlbcbklijgcijgf';
  const VALID_STATES = new Set(['none', 'saved', 'known']);
  const listeners = new Set();
  const isExtensionOrigin = (() => {
    try { return root.location?.protocol === 'chrome-extension:'; } catch { return false; }
  })();
  const isServiceWorker = typeof document === 'undefined' && isExtensionOrigin;
  let dbPromise = null;
  let syncPromise = null;
  let broadcastChannel = null;

  function now() { return Date.now(); }

  function normalizeText(value, maxLength = 4000) {
    return String(value == null ? '' : value)
      .normalize('NFKC')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxLength);
  }

  function normalizeTerm(value) {
    return normalizeText(value, 500)
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}'’-]+$/gu, '')
      .toLocaleLowerCase('en-US');
  }

  function normalizeState(value) {
    const state = normalizeText(value, 32).toLocaleLowerCase('en-US');
    return VALID_STATES.has(state) ? state : 'none';
  }

  function entryKey(input) {
    const kind = input?.kind === 'phrase' ? 'phrase' : 'word';
    const sourceLang = normalizeText(input?.sourceLang || input?.source_lang || 'auto', 32).toLocaleLowerCase('en-US');
    const targetLang = normalizeText(input?.targetLang || input?.target_lang || 'ru', 32).toLocaleLowerCase('en-US');
    const normalized = normalizeTerm(input?.normalizedText || input?.normalized_text || input?.sourceText || input?.term);
    return `${kind}|${sourceLang}|${targetLang}|${normalized}`;
  }

  function normalizeContext(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const sourceText = normalizeText(raw.sourceText || raw.source_text, 4000);
    if (!sourceText) return null;
    const videoId = normalizeText(raw.videoId || raw.video_id, 160);
    const startMsRaw = raw.startMs ?? raw.cue_start_ms;
    const endMsRaw = raw.endMs ?? raw.cue_end_ms;
    const startMs = Number.isFinite(Number(startMsRaw)) ? Math.max(-1, Math.round(Number(startMsRaw))) : -1;
    const createdAtRaw = Number(raw.createdAt ?? raw.created_at);
    return {
      id: `${videoId}:${startMs}:${sourceText.toLocaleLowerCase('en-US')}`,
      videoId,
      videoUrl: normalizeText(raw.videoUrl || raw.video_url, 2000),
      videoTitle: normalizeText(raw.videoTitle || raw.video_title, 1000),
      startMs,
      endMs: Number.isFinite(Number(endMsRaw)) ? Math.max(startMs, Math.round(Number(endMsRaw))) : null,
      sourceText,
      translation: normalizeText(raw.translation || raw.translated_text, 4000),
      createdAt: Number.isFinite(createdAtRaw)
        ? (createdAtRaw < 10_000_000_000 ? Math.round(createdAtRaw * 1000) : Math.round(createdAtRaw))
        : now(),
    };
  }

  function mergeContexts(current, incoming) {
    const merged = new Map();
    for (const raw of [...(Array.isArray(current) ? current : []), ...(Array.isArray(incoming) ? incoming : [])]) {
      const context = normalizeContext(raw);
      if (!context) continue;
      const previous = merged.get(context.id);
      merged.set(context.id, previous
        ? {
            ...previous,
            ...context,
            translation: context.translation || previous.translation,
            createdAt: Math.min(previous.createdAt, context.createdAt),
          }
        : context);
    }
    return Array.from(merged.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 100);
  }

  function normalizeEntry(raw, existing = null) {
    const timestamp = now();
    const sourceText = normalizeText(raw?.sourceText || raw?.term || existing?.sourceText, 500);
    const normalizedText = normalizeTerm(raw?.normalizedText || sourceText || existing?.normalizedText);
    const kind = raw?.kind === 'phrase' ? 'phrase' : (existing?.kind || 'word');
    const sourceLang = normalizeText(raw?.sourceLang || existing?.sourceLang || 'auto', 32).toLocaleLowerCase('en-US');
    const targetLang = normalizeText(raw?.targetLang || existing?.targetLang || 'ru', 32).toLocaleLowerCase('en-US');
    const key = raw?.key || existing?.key || entryKey({ kind, sourceLang, targetLang, normalizedText });
    const createdAt = Number(raw?.createdAt || existing?.createdAt || timestamp);
    const updatedAt = Number(raw?.updatedAt || timestamp);
    const translation = Object.prototype.hasOwnProperty.call(raw || {}, 'translation')
      ? normalizeText(raw.translation, 4000)
      : normalizeText(existing?.translation, 4000);
    return {
      key,
      kind,
      state: normalizeState(raw?.state ?? existing?.state),
      sourceLang,
      targetLang,
      sourceText: sourceText || existing?.sourceText || normalizedText,
      normalizedText,
      translation,
      translationSource: raw?.translationSource === 'manual'
        ? 'manual'
        : raw?.translationSource === 'machine'
          ? 'machine'
          : (existing?.translationSource || (translation ? 'machine' : '')),
      contexts: mergeContexts(existing?.contexts, raw?.contexts),
      createdAt,
      updatedAt,
      stateUpdatedAt: Number(raw?.stateUpdatedAt || existing?.stateUpdatedAt || updatedAt),
      translationUpdatedAt: Number(raw?.translationUpdatedAt || existing?.translationUpdatedAt || updatedAt),
      remoteId: normalizeText(raw?.remoteId || existing?.remoteId, 220),
      remoteUpdatedAt: Number(raw?.remoteUpdatedAt || existing?.remoteUpdatedAt || 0),
      remoteTranslationUpdatedAt: Number(raw?.remoteTranslationUpdatedAt || existing?.remoteTranslationUpdatedAt || 0),
      dirty: raw?.dirty === true || (raw?.dirty !== false && existing?.dirty === true),
      translationDirty: raw?.translationDirty === true || (raw?.translationDirty !== false && existing?.translationDirty === true),
      conflict: raw?.conflict === undefined ? (existing?.conflict || null) : raw.conflict,
      dueAt: raw?.dueAt ?? existing?.dueAt ?? new Date(createdAt).toISOString(),
      lastReviewedAt: raw?.lastReviewedAt ?? existing?.lastReviewedAt ?? null,
      reviewCount: Math.max(0, Number(raw?.reviewCount ?? existing?.reviewCount ?? 0) || 0),
      rememberedCount: Math.max(0, Number(raw?.rememberedCount ?? existing?.rememberedCount ?? 0) || 0),
      forgottenCount: Math.max(0, Number(raw?.forgottenCount ?? existing?.forgottenCount ?? 0) || 0),
    };
  }

  function openDatabase() {
    if (dbPromise) return dbPromise;
    if (!root.indexedDB) return Promise.reject(new Error('IndexedDB is unavailable'));
    dbPromise = new Promise((resolve, reject) => {
      const request = root.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(ENTRIES)) {
          const entries = database.createObjectStore(ENTRIES, { keyPath: 'key' });
          entries.createIndex('state', 'state', { unique: false });
          entries.createIndex('updatedAt', 'updatedAt', { unique: false });
          entries.createIndex('remoteId', 'remoteId', { unique: false });
          entries.createIndex('normalizedText', 'normalizedText', { unique: false });
        }
        if (!database.objectStoreNames.contains(OUTBOX)) {
          const outbox = database.createObjectStore(OUTBOX, { keyPath: 'id' });
          outbox.createIndex('type', 'type', { unique: false });
        }
        if (!database.objectStoreNames.contains(META)) database.createObjectStore(META, { keyPath: 'key' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
      request.onblocked = () => reject(new Error('IndexedDB upgrade is blocked'));
    });
    return dbPromise;
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
    });
  }

  async function transaction(storeNames, mode, work) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(storeNames, mode);
      let result;
      try { result = work(tx); }
      catch (error) { reject(error); return; }
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
  }

  function ensureBroadcastChannel() {
    if (broadcastChannel || !isExtensionOrigin || typeof root.BroadcastChannel !== 'function') return broadcastChannel;
    broadcastChannel = new root.BroadcastChannel('sc-learning-events-v1');
    broadcastChannel.onmessage = (event) => notify(event.data, { broadcast: false });
    return broadcastChannel;
  }

  function notify(detail = { type: 'changed' }, { broadcast = true } = {}) {
    for (const listener of listeners) {
      try { listener(detail); } catch {}
    }
    if (broadcast) {
      try { ensureBroadcastChannel()?.postMessage(detail); } catch {}
    }
  }

  function subscribe(listener) {
    listeners.add(listener);
    ensureBroadcastChannel();
    return () => listeners.delete(listener);
  }

  async function getAllEntriesDirect() {
    const database = await openDatabase();
    return requestResult(database.transaction(ENTRIES, 'readonly').objectStore(ENTRIES).getAll());
  }

  async function getEntryDirect(query) {
    const database = await openDatabase();
    const tx = database.transaction(ENTRIES, 'readonly');
    const store = tx.objectStore(ENTRIES);
    const exact = await requestResult(store.get(query?.key || entryKey(query)));
    if (exact) return exact;
    const normalized = normalizeTerm(query?.normalizedText || query?.sourceText || query?.term);
    if (!normalized) return null;
    const matches = await requestResult(store.index('normalizedText').getAll(normalized));
    const sourceLang = normalizeText(query?.sourceLang || 'auto', 32).toLocaleLowerCase('en-US');
    const targetLang = normalizeText(query?.targetLang || 'ru', 32).toLocaleLowerCase('en-US');
    return matches.find((entry) => entry.kind === (query?.kind === 'phrase' ? 'phrase' : 'word')
      && (entry.sourceLang === sourceLang || entry.sourceLang === 'auto' || sourceLang === 'auto')
      && (entry.targetLang === targetLang || !entry.targetLang)) || matches[0] || null;
  }

  async function listEntriesDirect(options = {}) {
    const items = await getAllEntriesDirect();
    const query = normalizeText(options.query, 500).toLocaleLowerCase('en-US');
    const states = Array.isArray(options.states) ? new Set(options.states.map(normalizeState)) : null;
    return items
      .filter((entry) => (!states || states.has(entry.state))
        && (!query || entry.sourceText.toLocaleLowerCase('en-US').includes(query)
          || entry.translation.toLocaleLowerCase('en-US').includes(query)))
      .sort((a, b) => b.updatedAt - a.updatedAt || a.sourceText.localeCompare(b.sourceText));
  }

  async function putEntryDirect(entry, detail = { type: 'entry-changed' }) {
    await transaction([ENTRIES], 'readwrite', (tx) => tx.objectStore(ENTRIES).put(entry));
    notify({ ...detail, key: entry.key, state: entry.state });
    return entry;
  }

  async function upsertEntryDirect(raw, options = {}) {
    const existing = await getEntryDirect(raw);
    const timestamp = now();
    let translation = Object.prototype.hasOwnProperty.call(raw || {}, 'translation')
      ? normalizeText(raw.translation, 4000)
      : existing?.translation || '';
    let translationSource = raw?.translationSource || existing?.translationSource || (translation ? 'machine' : '');
    if (existing?.translationSource === 'manual' && translationSource === 'machine') {
      translation = existing.translation;
      translationSource = 'manual';
    }
    const stateProvided = Object.prototype.hasOwnProperty.call(raw || {}, 'state');
    const stateChanged = stateProvided && normalizeState(raw.state) !== (existing?.state || 'none');
    const translationProvided = Object.prototype.hasOwnProperty.call(raw || {}, 'translation');
    const translationChanged = translationProvided && (
      translation !== (existing?.translation || '')
      || translationSource !== (existing?.translationSource || '')
    );
    const entry = normalizeEntry({
      ...raw,
      translation,
      translationSource,
      state: stateProvided ? raw.state : (existing?.state || 'none'),
      createdAt: existing?.createdAt || raw?.createdAt || timestamp,
      updatedAt: timestamp,
      stateUpdatedAt: stateChanged ? timestamp : (existing?.stateUpdatedAt || timestamp),
      translationUpdatedAt: translationChanged ? timestamp : (existing?.translationUpdatedAt || timestamp),
      dirty: options.dirty !== false,
      translationDirty: translationChanged
        ? (options.translationDirty === true)
        : (existing?.translationDirty === true),
      conflict: options.keepConflict ? existing?.conflict : null,
    }, existing);
    return putEntryDirect(entry);
  }

  async function setStateDirect(payload) {
    const existing = await getEntryDirect(payload);
    const requested = normalizeState(payload?.state);
    const nextState = payload?.toggle !== false && existing?.state === requested ? 'none' : requested;
    const incomingTranslation = normalizeText(payload?.translation, 4000);
    return upsertEntryDirect({ ...payload, state: nextState }, {
      dirty: true,
      translationDirty: !!incomingTranslation && incomingTranslation !== (existing?.translation || ''),
      keepConflict: true,
    });
  }

  async function saveMachineTranslationDirect(payload) {
    return upsertEntryDirect({ ...payload, translationSource: 'machine' }, {
      dirty: true,
      translationDirty: true,
      keepConflict: true,
    });
  }

  async function editTranslationDirect(payload) {
    const existing = await getEntryDirect(payload);
    if (!existing) throw new Error('Vocabulary entry not found');
    return upsertEntryDirect({
      ...existing,
      translation: normalizeText(payload?.translation, 4000),
      translationSource: 'manual',
    }, { dirty: true, translationDirty: true });
  }

  async function queueReviewDirect(payload) {
    const entry = await getEntryDirect({ key: payload?.key });
    if (!entry || entry.state !== 'saved') throw new Error('Card is not in the dictionary');
    const result = payload?.result === 'forgotten' ? 'forgotten' : 'remembered';
    const reviewedAt = Number(payload?.reviewedAt) || now();
    const rememberedCount = entry.rememberedCount + (result === 'remembered' ? 1 : 0);
    const forgottenCount = entry.forgottenCount + (result === 'forgotten' ? 1 : 0);
    const reviewCount = rememberedCount + forgottenCount;
    const days = result === 'remembered' ? Math.min(30, Math.max(1, 2 ** Math.max(0, rememberedCount - 1))) : 0;
    const dueAt = new Date(reviewedAt + (result === 'remembered' ? days * 86_400_000 : 10 * 60_000)).toISOString();
    const operation = {
      id: payload?.id || `review:${entry.key}:${reviewedAt}:${Math.random().toString(36).slice(2, 10)}`,
      type: 'review',
      entryKey: entry.key,
      term: entry.sourceText,
      remoteId: entry.remoteId || '',
      result,
      reviewedAt,
      createdAt: now(),
    };
    const updated = normalizeEntry({
      ...entry,
      rememberedCount,
      forgottenCount,
      reviewCount,
      lastReviewedAt: reviewedAt,
      dueAt,
      updatedAt: now(),
    }, entry);
    await transaction([ENTRIES, OUTBOX], 'readwrite', (tx) => {
      tx.objectStore(ENTRIES).put(updated);
      tx.objectStore(OUTBOX).put(operation);
    });
    notify({ type: 'review-queued', key: entry.key, result });
    return { entry: updated, operation };
  }

  async function dueEntriesDirect(options = {}) {
    const currentTime = Number(options.now) || now();
    const limit = Math.max(1, Math.min(500, Number(options.limit) || 100));
    const entries = await listEntriesDirect({ states: ['saved'] });
    return entries
      .filter((entry) => entry.reviewCount === 0 || !Number.isFinite(Date.parse(entry.dueAt)) || Date.parse(entry.dueAt) <= currentTime)
      .sort((a, b) => a.reviewCount - b.reviewCount || Date.parse(a.dueAt) - Date.parse(b.dueAt) || a.createdAt - b.createdAt)
      .slice(0, limit);
  }

  async function getOutboxDirect() {
    const database = await openDatabase();
    return requestResult(database.transaction(OUTBOX, 'readonly').objectStore(OUTBOX).getAll());
  }

  async function getMetaDirect(key) {
    const database = await openDatabase();
    return requestResult(database.transaction(META, 'readonly').objectStore(META).get(key));
  }

  async function setMetaDirect(key, value) {
    await transaction([META], 'readwrite', (tx) => tx.objectStore(META).put({ key, value, updatedAt: now() }));
  }

  async function bridgeJson(path, options = {}, timeoutMs = 12_000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(BRIDGE + path, {
        method: options.method || 'GET',
        headers: {
          'X-SC-Extension-Id': EXTENSION_ID,
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.ok === false) throw new Error(payload?.error || `SC Desktop HTTP ${response.status}`);
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  function remoteToEntry(remote, existing, conflict, wasSynced = false) {
    const remoteStateAt = Number(remote?.stateUpdatedAt || remote?.updatedAt || 0);
    const remoteTranslationAt = Number(remote?.translationUpdatedAt || remote?.updatedAt || 0);
    const keepLocalState = !wasSynced && existing?.dirty && Number(existing.stateUpdatedAt || 0) > remoteStateAt;
    const keepLocalTranslation = !!conflict;
    return normalizeEntry({
      ...(existing || {}),
      key: existing?.key || entryKey({
        kind: remote?.kind,
        sourceLang: remote?.sourceLang,
        targetLang: remote?.targetLang,
        sourceText: remote?.term,
      }),
      kind: remote?.kind,
      state: keepLocalState ? existing.state : remote?.state,
      sourceLang: remote?.sourceLang || existing?.sourceLang || 'auto',
      targetLang: remote?.targetLang || existing?.targetLang || 'ru',
      sourceText: remote?.term,
      normalizedText: normalizeTerm(remote?.term),
      translation: keepLocalTranslation ? existing?.translation : remote?.translation,
      translationSource: keepLocalTranslation ? existing?.translationSource : remote?.translationSource,
      contexts: mergeContexts(existing?.contexts, remote?.contexts),
      createdAt: Number(remote?.createdAt || existing?.createdAt || now()),
      updatedAt: Math.max(Number(remote?.updatedAt || 0), Number(existing?.updatedAt || 0)),
      stateUpdatedAt: keepLocalState ? existing.stateUpdatedAt : remoteStateAt,
      translationUpdatedAt: keepLocalTranslation ? existing.translationUpdatedAt : remoteTranslationAt,
      remoteId: remote?.id,
      remoteUpdatedAt: Number(remote?.updatedAt || 0),
      remoteTranslationUpdatedAt: remoteTranslationAt,
      dirty: !!conflict || (!wasSynced && keepLocalState && existing?.dirty === true),
      translationDirty: !!conflict,
      conflict: conflict || null,
      dueAt: remote?.dueAt,
      lastReviewedAt: remote?.lastReviewedAt,
      reviewCount: remote?.reviewCount,
      rememberedCount: remote?.rememberedCount,
      forgottenCount: remote?.forgottenCount,
    }, existing);
  }

  async function applySyncResultDirect(result) {
    const existingEntries = await getAllEntriesDirect();
    const byKey = new Map(existingEntries.map((entry) => [entry.key, entry]));
    const byRemoteId = new Map(existingEntries.filter((entry) => entry.remoteId).map((entry) => [entry.remoteId, entry]));
    const byTerm = new Map();
    for (const entry of existingEntries) {
      if (!byTerm.has(entry.normalizedText)) byTerm.set(entry.normalizedText, entry);
    }
    const conflictByKey = new Map((result?.conflicts || []).map((conflict) => [conflict.key, conflict]));
    const syncedKeys = new Set(result?.syncedKeys || []);
    const seenRemoteIds = new Set();
    const puts = [];
    for (const remote of result?.items || []) {
      const existing = byRemoteId.get(remote?.id) || byTerm.get(normalizeTerm(remote?.term)) || null;
      const conflict = existing ? conflictByKey.get(existing.key) || null : null;
      const merged = remoteToEntry(remote, existing, conflict, !!existing && syncedKeys.has(existing.key));
      puts.push(merged);
      byKey.set(merged.key, merged);
      if (remote?.id) seenRemoteIds.add(remote.id);
    }
    for (const key of result?.skippedKeys || []) {
      const existing = byKey.get(key);
      if (existing) puts.push(normalizeEntry({ ...existing, dirty: false, translationDirty: false }, existing));
    }
    for (const existing of existingEntries) {
      if (!existing.remoteId || existing.dirty || seenRemoteIds.has(existing.remoteId)) continue;
      puts.push(normalizeEntry({
        ...existing,
        state: 'none',
        remoteId: '',
        remoteUpdatedAt: 0,
        dirty: false,
        translationDirty: false,
      }, existing));
    }
    const acknowledged = new Set(result?.acknowledgedReviews || []);
    await transaction([ENTRIES, OUTBOX, META], 'readwrite', (tx) => {
      const entriesStore = tx.objectStore(ENTRIES);
      for (const entry of puts) entriesStore.put(entry);
      const outbox = tx.objectStore(OUTBOX);
      for (const id of acknowledged) outbox.delete(id);
      tx.objectStore(META).put({
        key: 'syncStatus',
        value: { online: true, syncedAt: now(), conflicts: conflictByKey.size },
        updatedAt: now(),
      });
    });
    notify({ type: 'sync-complete', online: true, conflicts: conflictByKey.size });
  }

  async function migrateLegacyDirect() {
    if ((await getMetaDirect('legacyLearningMigrationV1'))?.value === true) return { migrated: 0, already: true };
    let payload;
    try { payload = await bridgeJson('/learning/entries', {}, 4_000); }
    catch { return { migrated: 0, online: false }; }
    let migrated = 0;
    for (const raw of payload?.entries || []) {
      const state = raw.state === 'ignored' ? 'none' : normalizeState(raw.state);
      await upsertEntryDirect({
        kind: raw.kind,
        state,
        sourceLang: raw.source_lang,
        targetLang: raw.target_lang,
        sourceText: raw.source_text,
        normalizedText: raw.normalized_text,
        translation: raw.translation || '',
        translationSource: raw.translation ? 'machine' : '',
        contexts: raw.examples || [],
        createdAt: Number(raw.created_at || 0) * 1000 || now(),
        updatedAt: Number(raw.updated_at || 0) * 1000 || now(),
      }, { dirty: true, translationDirty: !!raw.translation });
      migrated += 1;
    }
    await setMetaDirect('legacyLearningMigrationV1', true);
    return { migrated, online: true };
  }

  async function syncDirect() {
    if (syncPromise) return syncPromise;
    syncPromise = (async () => {
      await migrateLegacyDirect();
      const entries = (await getAllEntriesDirect()).filter((entry) => entry.dirty);
      const reviews = (await getOutboxDirect()).filter((item) => item.type === 'review');
      let result;
      try {
        result = await bridgeJson('/vocabulary/sync', { method: 'POST', body: { entries, reviews } });
      } catch (error) {
        await setMetaDirect('syncStatus', { online: false, syncedAt: null, error: error?.message || String(error) });
        notify({ type: 'sync-complete', online: false, error: error?.message || String(error) });
        return { online: false, error: error?.message || String(error) };
      }
      if (result?.online !== true) {
        await setMetaDirect('syncStatus', { online: false, syncedAt: null, error: result?.error || 'Voice Record offline' });
        notify({ type: 'sync-complete', online: false, error: result?.error || '' });
        return result;
      }
      await applySyncResultDirect(result);
      return result;
    })();
    try { return await syncPromise; }
    finally { syncPromise = null; }
  }

  async function resolveConflictDirect(payload) {
    const existing = await getEntryDirect({ key: payload?.key });
    if (!existing?.conflict) return existing || null;
    if (payload?.choice === 'remote') {
      return putEntryDirect(normalizeEntry({
        ...existing,
        translation: existing.conflict.remoteValue,
        translationSource: 'manual',
        translationUpdatedAt: Number(existing.conflict.remoteTranslationUpdatedAt || now()),
        remoteTranslationUpdatedAt: Number(existing.conflict.remoteTranslationUpdatedAt || now()),
        conflict: null,
        dirty: false,
        translationDirty: false,
      }, existing));
    }
    return putEntryDirect(normalizeEntry({
      ...existing,
      remoteTranslationUpdatedAt: Number(existing.conflict.remoteTranslationUpdatedAt || existing.remoteTranslationUpdatedAt || 0),
      conflict: null,
      dirty: true,
      translationDirty: true,
      translationUpdatedAt: now(),
    }, existing));
  }

  async function statsDirect() {
    const entries = await getAllEntriesDirect();
    const outbox = await getOutboxDirect();
    const syncStatus = (await getMetaDirect('syncStatus'))?.value || { online: false, syncedAt: null };
    return {
      total: entries.filter((entry) => entry.state !== 'none').length,
      saved: entries.filter((entry) => entry.state === 'saved').length,
      known: entries.filter((entry) => entry.state === 'known').length,
      due: (await dueEntriesDirect()).length,
      pending: entries.filter((entry) => entry.dirty).length + outbox.length,
      conflicts: entries.filter((entry) => entry.conflict).length,
      sync: syncStatus,
    };
  }

  const directApi = {
    getEntry: getEntryDirect,
    listEntries: listEntriesDirect,
    dueEntries: dueEntriesDirect,
    setState: setStateDirect,
    saveMachineTranslation: saveMachineTranslationDirect,
    editTranslation: editTranslationDirect,
    queueReview: queueReviewDirect,
    resolveConflict: resolveConflictDirect,
    migrateLegacy: migrateLegacyDirect,
    sync: syncDirect,
    stats: statsDirect,
    subscribe,
  };

  const MESSAGE_METHODS = new Set([
    'getEntry', 'listEntries', 'dueEntries', 'setState', 'saveMachineTranslation',
    'editTranslation', 'queueReview', 'resolveConflict', 'migrateLegacy', 'sync', 'stats',
  ]);

  function sendStoreMessage(action, payload) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type: 'sc-learning-store', action, payload }, (response) => {
          const error = chrome.runtime.lastError;
          if (error) { reject(new Error(error.message)); return; }
          if (!response?.ok) { reject(new Error(response?.error || 'Learning store request failed')); return; }
          resolve(response.result);
        });
      } catch (error) { reject(error); }
    });
  }

  function proxySubscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  if (!isExtensionOrigin && typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
    try {
      chrome.runtime.onMessage.addListener((message) => {
        if (message?.type === 'sc-learning-store-changed') notify(message.detail, { broadcast: false });
      });
    } catch {}
    return {
      ...Object.fromEntries(Array.from(MESSAGE_METHODS).map((method) => [method, (payload) => sendStoreMessage(method, payload)])),
      subscribe: proxySubscribe,
      normalizeTerm,
      entryKey,
      mergeContexts,
      normalizeEntry,
      isProxy: true,
    };
  }

  return {
    ...directApi,
    normalizeTerm,
    entryKey,
    mergeContexts,
    normalizeEntry,
    MESSAGE_METHODS,
    isProxy: false,
    isServiceWorker,
  };
});
