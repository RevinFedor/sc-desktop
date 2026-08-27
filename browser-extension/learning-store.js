(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.__scLearningStore = api;
})(typeof self !== 'undefined' ? self : globalThis, function (root) {
  'use strict';

  const DB_NAME = 'sc-learning-v1';
  const DB_VERSION = 2;
  const ENTRIES = 'entries';
  const OUTBOX = 'outbox';
  const META = 'meta';
  const PRACTICE_SESSION_META = 'practiceSessionV1';
  const BRIDGE = 'http://127.0.0.1:53127';
  const EXTENSION_ID = 'phnlfhkblebijojjnnlbcbklijgcijgf';
  const VALID_STATES = new Set(['none', 'saved', 'known']);
  const VALID_EXPRESSION_TYPES = new Set(['phrasal_verb', 'function_phrase', 'idiom']);
  const listeners = new Set();
  const Lexeme = root.__scEnglishLexeme
    || (typeof require === 'function' ? require('./english-lexeme.js') : null);
  const isExtensionOrigin = (() => {
    try { return root.location?.protocol === 'chrome-extension:'; } catch { return false; }
  })();
  const isServiceWorker = typeof document === 'undefined' && isExtensionOrigin;
  let dbPromise = null;
  let syncPromise = null;
  let lexemeMigrationPromise = null;
  let lexemeMigrationComplete = false;
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
    if (Lexeme?.normalizeWord) return Lexeme.normalizeWord(value);
    return normalizeText(value, 500)
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}'’-]+$/gu, '')
      .toLocaleLowerCase('en-US');
  }

  function normalizeState(value) {
    const state = normalizeText(value, 32).toLocaleLowerCase('en-US');
    return VALID_STATES.has(state) ? state : 'none';
  }

  function normalizeExpressionType(value) {
    const type = normalizeText(value, 40).toLocaleLowerCase('en-US');
    return VALID_EXPRESSION_TYPES.has(type) ? type : '';
  }

  function normalizePartsOfSpeech(rawValues, ...fallbacks) {
    const values = [...(Array.isArray(rawValues) ? rawValues : []), ...fallbacks];
    const normalized = values.map((value) => Lexeme?.normalizePartOfSpeech
      ? Lexeme.normalizePartOfSpeech(value)
      : normalizeText(value, 32).toLocaleLowerCase('en-US'));
    return Array.from(new Set(normalized.filter((value) => value && value !== 'unknown' && value !== 'phrase'))).slice(0, 20);
  }

  function entryKey(input) {
    if (Lexeme?.identityKey) return Lexeme.identityKey(input || {});
    const kind = input?.kind === 'phrase' ? 'phrase' : 'word';
    const sourceLang = normalizeText(input?.sourceLang || input?.source_lang || 'auto', 32).toLocaleLowerCase('en-US');
    const targetLang = normalizeText(input?.targetLang || input?.target_lang || 'ru', 32).toLocaleLowerCase('en-US');
    const normalized = normalizeTerm(input?.lemma || input?.normalizedText || input?.normalized_text || input?.sourceText || input?.term);
    return kind === 'phrase'
      ? `${kind}|${sourceLang}|${targetLang}|${normalized}`
      : `${kind}|${sourceLang}|${targetLang}|${normalized}`;
  }

  function canonicalIdentity(input) {
    if (Lexeme?.canonicalIdentity) return Lexeme.canonicalIdentity(input || {});
    const kind = input?.kind === 'phrase' ? 'phrase' : 'word';
    const normalized = normalizeTerm(input?.lemma || input?.normalizedText || input?.sourceText || input?.term);
    return {
      kind,
      sourceLang: normalizeText(input?.sourceLang || 'auto', 32).toLocaleLowerCase('en-US'),
      targetLang: normalizeText(input?.targetLang || 'ru', 32).toLocaleLowerCase('en-US'),
      surface: normalizeText(input?.sourceText || input?.term || normalized, 500),
      normalizedSurface: normalizeTerm(input?.sourceText || input?.term || normalized),
      lemma: normalized,
      partOfSpeech: kind === 'phrase' ? 'phrase' : 'unknown',
      confidence: kind === 'phrase' ? 'high' : 'low',
      provisional: kind !== 'phrase',
    };
  }

  function normalizeObservedForms(rawForms, ...fallbacks) {
    const forms = new Set();
    for (const raw of [...(Array.isArray(rawForms) ? rawForms : []), ...fallbacks]) {
      const normalized = normalizeTerm(typeof raw === 'object' ? raw?.form || raw?.text : raw);
      if (normalized) forms.add(normalized);
    }
    return Array.from(forms).slice(0, 100);
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
      surfaceForm: normalizeText(raw.surfaceForm || raw.surface_form, 500),
      translation: normalizeText(raw.translation || raw.translated_text, 4000),
      meaning: normalizeText(raw.meaning || raw.targetTerm || raw.target_term, 500),
      partOfSpeech: Lexeme?.normalizePartOfSpeech
        ? Lexeme.normalizePartOfSpeech(raw.partOfSpeech || raw.posTag)
        : normalizeText(raw.partOfSpeech || raw.posTag || 'unknown', 32).toLocaleLowerCase('en-US'),
      origin: ['dictionary', 'video', 'manual'].includes(String(raw.origin || '').trim())
        ? String(raw.origin).trim()
        : (videoId ? 'video' : 'manual'),
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
            meaning: context.meaning || previous.meaning,
            origin: context.origin || previous.origin,
            partOfSpeech: context.partOfSpeech !== 'unknown' ? context.partOfSpeech : previous.partOfSpeech,
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
    const originalSourceText = normalizeText(raw?.sourceText || raw?.term || existing?.sourceText, 500);
    const identity = canonicalIdentity({
      ...(existing || {}),
      ...(raw || {}),
      sourceText: originalSourceText,
      context: raw?.context || raw?.contexts?.[0]?.sourceText || existing?.contexts?.[0]?.sourceText || '',
    });
    const kind = identity.kind;
    const expressionType = kind === 'phrase' ? normalizeExpressionType(raw?.expressionType ?? existing?.expressionType) : '';
    const sourceLang = identity.sourceLang;
    const targetLang = identity.targetLang;
    const lemma = normalizeTerm(identity.lemma || originalSourceText);
    let partOfSpeech = kind === 'phrase' ? 'phrase' : (identity.partOfSpeech || existing?.partOfSpeech || 'unknown');
    const sourceText = kind === 'word' || expressionType ? lemma : (originalSourceText || lemma);
    const normalizedText = kind === 'word' ? lemma : normalizeTerm(raw?.normalizedText || sourceText);
    const key = entryKey({ kind, sourceLang, targetLang, lemma, partOfSpeech, sourceText });
    const createdAt = Number(raw?.createdAt || existing?.createdAt || timestamp);
    const updatedAt = Number(raw?.updatedAt || timestamp);
    const translation = Object.prototype.hasOwnProperty.call(raw || {}, 'translation')
      ? normalizeText(raw.translation, 4000)
      : normalizeText(existing?.translation, 4000);
    const contexts = mergeContexts(existing?.contexts, raw?.contexts);
    const partsOfSpeech = kind === 'word'
      ? normalizePartsOfSpeech(
          [...(existing?.partsOfSpeech || []), ...(raw?.partsOfSpeech || [])],
          partOfSpeech,
          ...contexts.map((context) => context.partOfSpeech),
        )
      : [];
    if (kind === 'word' && partOfSpeech === 'unknown' && partsOfSpeech.length) partOfSpeech = partsOfSpeech[0];
    const observedForms = kind === 'word' || expressionType
      ? normalizeObservedForms(
          [...(existing?.observedForms || []), ...(raw?.observedForms || [])],
          identity.normalizedSurface,
          originalSourceText,
          ...contexts.map((context) => context.surfaceForm),
          lemma,
        )
      : [];
    return {
      key,
      identityVersion: 3,
      kind,
      expressionType,
      state: normalizeState(raw?.state ?? existing?.state),
      sourceLang,
      targetLang,
      sourceText: sourceText || existing?.sourceText || normalizedText,
      normalizedText,
      lemma,
      partOfSpeech,
      partsOfSpeech,
      analysisConfidence: Lexeme?.normalizeConfidence
        ? Lexeme.normalizeConfidence(raw?.analysisConfidence || identity.confidence || existing?.analysisConfidence, identity.provisional ? 'low' : 'high')
        : normalizeText(raw?.analysisConfidence || existing?.analysisConfidence || 'low', 16),
      provisional: kind === 'word' && identity.provisional === true,
      observedForms,
      translation,
      translationSource: raw?.translationSource === 'manual'
        ? 'manual'
        : raw?.translationSource === 'machine'
          ? 'machine'
          : (existing?.translationSource || (translation ? 'machine' : '')),
      contexts,
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
      lastPracticedAt: raw?.lastPracticedAt ?? existing?.lastPracticedAt ?? null,
      reviewCount: Math.max(0, Number(raw?.reviewCount ?? existing?.reviewCount
        ?? (Number(raw?.rememberedCount ?? existing?.rememberedCount ?? 0)
          + Number(raw?.forgottenCount ?? existing?.forgottenCount ?? 0))) || 0),
      rememberedCount: Math.max(0, Number(raw?.rememberedCount ?? existing?.rememberedCount ?? 0) || 0),
      forgottenCount: Math.max(0, Number(raw?.forgottenCount ?? existing?.forgottenCount ?? 0) || 0),
      practiceCount: Math.max(0, Number(raw?.practiceCount ?? existing?.practiceCount
        ?? (Number(raw?.practiceRememberedCount ?? existing?.practiceRememberedCount ?? 0)
          + Number(raw?.practiceForgottenCount ?? existing?.practiceForgottenCount ?? 0))) || 0),
      practiceRememberedCount: Math.max(0, Number(raw?.practiceRememberedCount ?? existing?.practiceRememberedCount ?? 0) || 0),
      practiceForgottenCount: Math.max(0, Number(raw?.practiceForgottenCount ?? existing?.practiceForgottenCount ?? 0) || 0),
    };
  }

  function normalizePracticeSession(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const messages = (Array.isArray(raw.messages) ? raw.messages : []).slice(-100).map((message, index) => ({
      id: normalizeText(message?.id || `practice-message-${index}`, 220),
      role: message?.role === 'user' ? 'user' : 'assistant',
      english: normalizeText(message?.english || message?.content, 4000),
      russian: normalizeText(message?.russian, 4000),
      feedbackRussian: normalizeText(message?.feedbackRussian, 2000),
      correctedEnglish: normalizeText(message?.correctedEnglish, 4000),
      usedVocabularyIds: Array.from(new Set(
        (Array.isArray(message?.usedVocabularyIds) ? message.usedVocabularyIds : [])
          .map((value) => normalizeText(value, 220))
          .filter(Boolean),
      )).slice(0, 16),
      createdAt: Number(message?.createdAt) || now(),
    })).filter((message) => message.english);
    const createdAt = Number(raw.createdAt) || now();
    return {
      id: 'current',
      vocabularyKeys: Array.from(new Set(
        (Array.isArray(raw.vocabularyKeys) ? raw.vocabularyKeys : [])
          .map((value) => normalizeText(value, 220))
          .filter(Boolean),
      )).slice(0, 16),
      messages,
      createdAt,
      updatedAt: Number(raw.updatedAt) || now(),
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
          entries.createIndex('lemma', 'lemma', { unique: false });
          entries.createIndex('observedForms', 'observedForms', { unique: false, multiEntry: true });
        } else {
          const entries = request.transaction.objectStore(ENTRIES);
          if (!entries.indexNames.contains('lemma')) entries.createIndex('lemma', 'lemma', { unique: false });
          if (!entries.indexNames.contains('observedForms')) entries.createIndex('observedForms', 'observedForms', { unique: false, multiEntry: true });
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

  async function getAllEntriesRaw() {
    const database = await openDatabase();
    return requestResult(database.transaction(ENTRIES, 'readonly').objectStore(ENTRIES).getAll());
  }

  function entryAttempts(entry) {
    return Number(entry?.reviewCount || 0) + Number(entry?.practiceCount || 0);
  }

  function statePriority(state) {
    return state === 'saved' ? 3 : state === 'known' ? 2 : 1;
  }

  function compatibleEntryForIdentity(entries, identity = {}) {
    const candidates = Array.isArray(entries) ? entries : [];
    if (!candidates.length) return null;
    const partOfSpeech = identity.partOfSpeech || 'unknown';
    const exact = candidates.find((entry) => entry.partOfSpeech === partOfSpeech || entry.partsOfSpeech?.includes(partOfSpeech));
    if (exact) return exact;
    const unclassified = candidates.find((entry) => entry.partOfSpeech === 'unknown');
    if (unclassified) return unclassified;
    return candidates[0];
  }

  function earliestDue(entries, fallback) {
    const dates = entries
      .map((entry) => Date.parse(entry?.dueAt))
      .filter(Number.isFinite);
    return dates.length ? new Date(Math.min(...dates)).toISOString() : fallback;
  }

  function mergeCanonicalEntries(rawEntries, options = {}) {
    const entries = (Array.isArray(rawEntries) ? rawEntries : []).map((entry) => normalizeEntry(entry));
    if (!entries.length) return null;
    const primary = [...entries].sort((a, b) => {
      const manualDelta = Number(b.translationSource === 'manual' && !!b.translation)
        - Number(a.translationSource === 'manual' && !!a.translation);
      return manualDelta
        || entryAttempts(b) - entryAttempts(a)
        || statePriority(b.state) - statePriority(a.state)
        || Number(a.createdAt || 0) - Number(b.createdAt || 0);
    })[0];
    const translationEntry = [...entries]
      .filter((entry) => entry.translation)
      .sort((a, b) => Number(b.translationSource === 'manual') - Number(a.translationSource === 'manual')
        || Number(b.translationUpdatedAt || 0) - Number(a.translationUpdatedAt || 0))[0] || primary;
    const rememberedCount = entries.reduce((sum, entry) => sum + Number(entry.rememberedCount || 0), 0);
    const forgottenCount = entries.reduce((sum, entry) => sum + Number(entry.forgottenCount || 0), 0);
    const practiceRememberedCount = entries.reduce((sum, entry) => sum + Number(entry.practiceRememberedCount || 0), 0);
    const practiceForgottenCount = entries.reduce((sum, entry) => sum + Number(entry.practiceForgottenCount || 0), 0);
    const createdAt = Math.min(...entries.map((entry) => Number(entry.createdAt || now())));
    const updatedAt = Math.max(...entries.map((entry) => Number(entry.updatedAt || 0)), createdAt);
    const merged = normalizeEntry({
      ...primary,
      key: undefined,
      expressionType: entries.find((entry) => entry.expressionType)?.expressionType || '',
      partsOfSpeech: entries.flatMap((entry) => entry.partsOfSpeech || [entry.partOfSpeech]),
      state: entries.reduce((best, entry) => statePriority(entry.state) > statePriority(best) ? entry.state : best, 'none'),
      translation: translationEntry.translation || '',
      translationSource: translationEntry.translationSource || '',
      contexts: entries.flatMap((entry) => entry.contexts || []),
      observedForms: entries.flatMap((entry) => entry.observedForms || []).concat(entries.map((entry) => entry.sourceText)),
      createdAt,
      updatedAt,
      stateUpdatedAt: Math.max(...entries.map((entry) => Number(entry.stateUpdatedAt || 0)), createdAt),
      translationUpdatedAt: Math.max(...entries.map((entry) => Number(entry.translationUpdatedAt || 0)), createdAt),
      remoteUpdatedAt: Math.max(...entries.map((entry) => Number(entry.remoteUpdatedAt || 0)), 0),
      remoteTranslationUpdatedAt: Math.max(...entries.map((entry) => Number(entry.remoteTranslationUpdatedAt || 0)), 0),
      dirty: options.markDirty === true || entries.some((entry) => entry.dirty === true),
      translationDirty: entries.some((entry) => entry.translationDirty === true),
      conflict: [...entries].sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0)).find((entry) => entry.conflict)?.conflict || null,
      dueAt: earliestDue(entries, new Date(createdAt).toISOString()),
      lastReviewedAt: Math.max(...entries.map((entry) => Number(entry.lastReviewedAt || 0)), 0) || null,
      lastPracticedAt: Math.max(...entries.map((entry) => Number(entry.lastPracticedAt || 0)), 0) || null,
      rememberedCount,
      forgottenCount,
      reviewCount: rememberedCount + forgottenCount,
      practiceRememberedCount,
      practiceForgottenCount,
      practiceCount: practiceRememberedCount + practiceForgottenCount,
    });
    return merged;
  }

  async function ensureLexemeMigrationDirect() {
    if (lexemeMigrationComplete) return { migrated: 0, merged: 0, already: true };
    if (lexemeMigrationPromise) return lexemeMigrationPromise;
    lexemeMigrationPromise = (async () => {
      const database = await openDatabase();
      const meta = await requestResult(database.transaction(META, 'readonly').objectStore(META).get('lexemeIdentityMigrationV3'));
      if (meta?.value === true) {
        lexemeMigrationComplete = true;
        return { migrated: 0, merged: 0, already: true };
      }
      const entries = await getAllEntriesRaw();
      const groups = new Map();
      const oldToNew = new Map();
      let migrated = 0;
      for (const raw of entries) {
        const normalized = normalizeEntry(raw);
        if (raw.key !== normalized.key || raw.identityVersion !== 3) migrated += 1;
        if (!groups.has(normalized.key)) groups.set(normalized.key, []);
        groups.get(normalized.key).push(normalized);
        oldToNew.set(raw.key, normalized.key);
      }
      const mergedEntries = Array.from(groups.values(), (group) => mergeCanonicalEntries(group, {
        markDirty: migrated > 0 || group.length > 1,
      })).filter(Boolean);
      const outbox = await requestResult(database.transaction(OUTBOX, 'readonly').objectStore(OUTBOX).getAll());
      await transaction([ENTRIES, OUTBOX, META], 'readwrite', (tx) => {
        const entryStore = tx.objectStore(ENTRIES);
        entryStore.clear();
        for (const entry of mergedEntries) entryStore.put(entry);
        const outboxStore = tx.objectStore(OUTBOX);
        for (const operation of outbox) {
          const nextKey = oldToNew.get(operation.entryKey);
          if (!nextKey) continue;
          const entry = mergedEntries.find((candidate) => candidate.key === nextKey);
          outboxStore.put({
            ...operation,
            entryKey: nextKey,
            term: entry?.sourceText || operation.term,
            lemma: entry?.lemma || '',
            partOfSpeech: entry?.partOfSpeech || 'unknown',
            kind: entry?.kind || 'word',
            sourceLang: entry?.sourceLang || 'auto',
            targetLang: entry?.targetLang || 'ru',
          });
        }
        tx.objectStore(META).put({
          key: 'lexemeIdentityMigrationV3',
          value: true,
          updatedAt: now(),
        });
      });
      if (migrated || mergedEntries.length !== entries.length) {
        notify({ type: 'lexeme-migration-complete', migrated, merged: entries.length - mergedEntries.length });
      }
      lexemeMigrationComplete = true;
      return { migrated, merged: entries.length - mergedEntries.length, already: false };
    })();
    try { return await lexemeMigrationPromise; }
    finally { lexemeMigrationPromise = null; }
  }

  async function getAllEntriesDirect() {
    await ensureLexemeMigrationDirect();
    return getAllEntriesRaw();
  }

  async function getEntryDirect(query) {
    await ensureLexemeMigrationDirect();
    const database = await openDatabase();
    const tx = database.transaction(ENTRIES, 'readonly');
    const store = tx.objectStore(ENTRIES);
    const requestedKey = query?.key || entryKey(query);
    const exact = await requestResult(store.get(requestedKey));
    if (exact) return exact;
    const identity = canonicalIdentity(query || {});
    const normalized = normalizeTerm(identity.normalizedSurface || query?.normalizedText || query?.sourceText || query?.term);
    if (!normalized) return null;
    const matchesByForm = store.indexNames.contains('observedForms')
      ? await requestResult(store.index('observedForms').getAll(normalized))
      : [];
    const matchesByLemma = store.indexNames.contains('lemma')
      ? await requestResult(store.index('lemma').getAll(identity.lemma || normalized))
      : await requestResult(store.index('normalizedText').getAll(normalized));
    const matches = Array.from(new Map([...matchesByForm, ...matchesByLemma].map((entry) => [entry.key, entry])).values());
    const sourceLang = normalizeText(query?.sourceLang || 'auto', 32).toLocaleLowerCase('en-US');
    const targetLang = normalizeText(query?.targetLang || 'ru', 32).toLocaleLowerCase('en-US');
    const compatible = matches.filter((entry) => entry.kind === (query?.kind === 'phrase' ? 'phrase' : 'word')
      && (entry.sourceLang === sourceLang || entry.sourceLang === 'auto' || sourceLang === 'auto')
      && (entry.targetLang === targetLang || !entry.targetLang));
    return compatibleEntryForIdentity(compatible, identity);
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

  async function getEntryByKeyRaw(key) {
    if (!key) return null;
    const database = await openDatabase();
    return requestResult(database.transaction(ENTRIES, 'readonly').objectStore(ENTRIES).get(key));
  }

  async function putEntryDirect(entry, detail = { type: 'entry-changed' }, previousKeys = []) {
    await transaction([ENTRIES], 'readwrite', (tx) => {
      const store = tx.objectStore(ENTRIES);
      for (const key of previousKeys) {
        if (key && key !== entry.key) store.delete(key);
      }
      store.put(entry);
    });
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
    let entry = normalizeEntry({
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
    const previousKeys = [];
    if (existing?.key && existing.key !== entry.key) {
      previousKeys.push(existing.key);
      const target = await getEntryByKeyRaw(entry.key);
      entry = mergeCanonicalEntries([...(target ? [target] : []), existing, entry], { markDirty: options.dirty !== false });
    }
    return putEntryDirect(entry, { type: 'entry-changed' }, previousKeys);
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

  async function refineLexemeDirect(payload) {
    const existing = await getEntryDirect(payload?.from || payload);
    if (!existing || existing.kind !== 'word') return existing || null;
    return upsertEntryDirect({
      ...existing,
      sourceText: payload?.surfaceForm || payload?.sourceText || existing.sourceText,
      lemma: payload?.lemma || existing.lemma,
      partOfSpeech: payload?.partOfSpeech || existing.partOfSpeech,
      analysisConfidence: payload?.analysisConfidence || existing.analysisConfidence,
      observedForms: normalizeObservedForms(
        [...(existing.observedForms || []), ...(payload?.observedForms || [])],
        payload?.surfaceForm,
      ),
      contexts: payload?.contexts || [],
    }, { dirty: true, translationDirty: false, keepConflict: true });
  }

  async function queueReviewDirect(payload) {
    const entry = await getEntryDirect({ key: payload?.key });
    if (!entry || entry.state !== 'saved') throw new Error('Card is not in the dictionary');
    const result = payload?.result === 'forgotten' ? 'forgotten' : 'remembered';
    const mode = payload?.mode === 'practice' ? 'practice' : 'scheduled';
    const reviewedAt = Number(payload?.reviewedAt) || now();
    const rememberedCount = Number(entry.rememberedCount || 0) + (mode === 'scheduled' && result === 'remembered' ? 1 : 0);
    const forgottenCount = Number(entry.forgottenCount || 0) + (mode === 'scheduled' && result === 'forgotten' ? 1 : 0);
    const reviewCount = rememberedCount + forgottenCount;
    const practiceRememberedCount = Number(entry.practiceRememberedCount || 0) + (mode === 'practice' && result === 'remembered' ? 1 : 0);
    const practiceForgottenCount = Number(entry.practiceForgottenCount || 0) + (mode === 'practice' && result === 'forgotten' ? 1 : 0);
    const practiceCount = practiceRememberedCount + practiceForgottenCount;
    const days = result === 'remembered' ? Math.min(30, Math.max(1, 2 ** Math.max(0, rememberedCount - 1))) : 0;
    const dueAt = mode === 'scheduled'
      ? new Date(reviewedAt + (result === 'remembered' ? days * 86_400_000 : 10 * 60_000)).toISOString()
      : entry.dueAt;
    const operation = {
      id: payload?.id || `review:${entry.key}:${reviewedAt}:${Math.random().toString(36).slice(2, 10)}`,
      type: 'review',
      entryKey: entry.key,
      term: entry.sourceText,
      lemma: entry.lemma,
      partOfSpeech: entry.partOfSpeech,
      kind: entry.kind,
      sourceLang: entry.sourceLang,
      targetLang: entry.targetLang,
      remoteId: entry.remoteId || '',
      result,
      mode,
      reviewedAt,
      createdAt: now(),
    };
    const updated = normalizeEntry({
      ...entry,
      rememberedCount,
      forgottenCount,
      reviewCount,
      practiceRememberedCount,
      practiceForgottenCount,
      practiceCount,
      lastReviewedAt: mode === 'scheduled' ? reviewedAt : entry.lastReviewedAt,
      lastPracticedAt: mode === 'practice' ? reviewedAt : entry.lastPracticedAt,
      dueAt,
      updatedAt: now(),
    }, entry);
    await transaction([ENTRIES, OUTBOX], 'readwrite', (tx) => {
      tx.objectStore(ENTRIES).put(updated);
      tx.objectStore(OUTBOX).put(operation);
    });
    notify({ type: 'review-queued', key: entry.key, result, mode });
    return { entry: updated, operation, entryBefore: entry };
  }

  async function undoReviewDirect(payload) {
    const current = await getEntryDirect({ key: payload?.key || payload?.entryBefore?.key });
    const entryBefore = payload?.entryBefore;
    const reviewOperation = payload?.operation;
    if (!current || !entryBefore || entryBefore.key !== current.key) throw new Error('Review snapshot is unavailable');
    const reviewOperationId = String(reviewOperation?.id || '').trim();
    if (!reviewOperationId) throw new Error('Review operation is unavailable');
    const timestamp = now();
    const restored = normalizeEntry({ ...entryBefore, updatedAt: timestamp }, current);
    const undoOperation = {
      id: `undo:${reviewOperationId}:${timestamp}:${Math.random().toString(36).slice(2, 8)}`,
      type: 'undo-review',
      entryKey: current.key,
      term: current.sourceText,
      lemma: current.lemma,
      partOfSpeech: current.partOfSpeech,
      kind: current.kind,
      sourceLang: current.sourceLang,
      targetLang: current.targetLang,
      remoteId: current.remoteId || entryBefore.remoteId || '',
      reviewOperationId,
      createdAt: timestamp,
    };
    await transaction([ENTRIES, OUTBOX], 'readwrite', (tx) => {
      tx.objectStore(ENTRIES).put(restored);
      // Keep the original review operation if it has not synced yet. The
      // server receives review → undo in order, which is correct both before
      // and after an earlier background sync.
      tx.objectStore(OUTBOX).put(undoOperation);
    });
    notify({ type: 'review-undone', key: current.key, reviewOperationId });
    return { entry: restored, operation: undoOperation };
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

  async function getPracticeSessionDirect() {
    const stored = await getMetaDirect(PRACTICE_SESSION_META);
    return normalizePracticeSession(stored?.value);
  }

  async function savePracticeSessionDirect(raw) {
    const session = normalizePracticeSession({ ...(raw || {}), updatedAt: now() });
    if (!session) throw new Error('practice session is required');
    await setMetaDirect(PRACTICE_SESSION_META, session);
    notify({ type: 'practice-session-changed' });
    return session;
  }

  async function clearPracticeSessionDirect() {
    await transaction([META], 'readwrite', (tx) => tx.objectStore(META).delete(PRACTICE_SESSION_META));
    notify({ type: 'practice-session-changed' });
    return true;
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
      kind: remote?.kind,
      expressionType: remote?.expressionType || existing?.expressionType || '',
      state: keepLocalState ? existing.state : remote?.state,
      sourceLang: remote?.sourceLang || existing?.sourceLang || 'auto',
      targetLang: remote?.targetLang || existing?.targetLang || 'ru',
      sourceText: remote?.term,
      normalizedText: normalizeTerm(remote?.lemma || remote?.term),
      lemma: remote?.lemma || existing?.lemma || remote?.term,
      partOfSpeech: remote?.partOfSpeech || existing?.partOfSpeech || 'unknown',
      partsOfSpeech: remote?.partsOfSpeech || existing?.partsOfSpeech || [],
      analysisConfidence: remote?.analysisConfidence || existing?.analysisConfidence || 'low',
      observedForms: remote?.observedForms || existing?.observedForms || [],
      translation: keepLocalTranslation ? existing?.translation : remote?.translation,
      translationSource: keepLocalTranslation ? existing?.translationSource : remote?.translationSource,
      // The Voice API is the source of truth after a sync round. Local dirty
      // contexts were already pushed before this response was produced, so
      // merging the pre-sync copy back here would resurrect examples that a
      // server-side cleanup intentionally removed.
      contexts: Array.isArray(remote?.contexts) ? remote.contexts : existing?.contexts,
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
      lastPracticedAt: remote?.lastPracticedAt,
      reviewCount: remote?.reviewCount,
      rememberedCount: remote?.rememberedCount,
      forgottenCount: remote?.forgottenCount,
      practiceCount: remote?.practiceCount,
      practiceRememberedCount: remote?.practiceRememberedCount,
      practiceForgottenCount: remote?.practiceForgottenCount,
    }, existing);
  }

  async function applySyncResultDirect(result) {
    const existingEntries = await getAllEntriesDirect();
    const byKey = new Map(existingEntries.map((entry) => [entry.key, entry]));
    const byRemoteId = new Map(existingEntries.filter((entry) => entry.remoteId).map((entry) => [entry.remoteId, entry]));
    const byForm = new Map();
    for (const entry of existingEntries) {
      for (const form of normalizeObservedForms(entry.observedForms, entry.sourceText, entry.lemma)) {
        if (!byForm.has(form)) byForm.set(form, []);
        byForm.get(form).push(entry);
      }
    }
    const conflictByKey = new Map((result?.conflicts || []).map((conflict) => [conflict.key, conflict]));
    const syncedKeys = new Set(result?.syncedKeys || []);
    const seenRemoteIds = new Set();
    const matchedLocalKeys = new Set();
    const puts = new Map();
    const deletes = new Set();
    for (const remote of result?.items || []) {
      const remoteKey = entryKey({
        kind: remote?.kind,
        sourceLang: remote?.sourceLang,
        targetLang: remote?.targetLang,
        sourceText: remote?.term,
        lemma: remote?.lemma,
        partOfSpeech: remote?.partOfSpeech,
        analysisConfidence: remote?.analysisConfidence,
      });
      const formCandidates = byForm.get(normalizeTerm(remote?.term)) || [];
      const existing = byRemoteId.get(remote?.id)
        || byKey.get(remoteKey)
        || compatibleEntryForIdentity(formCandidates, {
          partOfSpeech: remote?.partOfSpeech || 'unknown',
          confidence: remote?.analysisConfidence || 'low',
        });
      const conflict = existing ? conflictByKey.get(existing.key) || null : null;
      let merged = remoteToEntry(remote, existing, conflict, !!existing && syncedKeys.has(existing.key));
      const sameKeyLocal = byKey.get(merged.key);
      if (sameKeyLocal && sameKeyLocal.key !== existing?.key) {
        merged = mergeCanonicalEntries([sameKeyLocal, merged], { markDirty: !!conflict });
        matchedLocalKeys.add(sameKeyLocal.key);
      }
      if (existing?.key) {
        matchedLocalKeys.add(existing.key);
        if (existing.key !== merged.key) deletes.add(existing.key);
      }
      puts.set(merged.key, merged);
      byKey.set(merged.key, merged);
      if (remote?.id) seenRemoteIds.add(remote.id);
    }
    for (const key of result?.skippedKeys || []) {
      const existing = byKey.get(key);
      if (existing) puts.set(existing.key, normalizeEntry({ ...existing, dirty: false, translationDirty: false }, existing));
    }
    for (const existing of existingEntries) {
      if (!existing.remoteId || existing.dirty || seenRemoteIds.has(existing.remoteId) || matchedLocalKeys.has(existing.key)) continue;
      puts.set(existing.key, normalizeEntry({
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
      for (const key of deletes) entriesStore.delete(key);
      for (const entry of puts.values()) entriesStore.put(entry);
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
      const reviews = (await getOutboxDirect()).filter((item) => item.type === 'review' || item.type === 'undo-review');
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
    refineLexeme: refineLexemeDirect,
    queueReview: queueReviewDirect,
    undoReview: undoReviewDirect,
    resolveConflict: resolveConflictDirect,
    migrateLegacy: migrateLegacyDirect,
    sync: syncDirect,
    stats: statsDirect,
    getPracticeSession: getPracticeSessionDirect,
    savePracticeSession: savePracticeSessionDirect,
    clearPracticeSession: clearPracticeSessionDirect,
    subscribe,
  };

  const MESSAGE_METHODS = new Set([
    'getEntry', 'listEntries', 'dueEntries', 'setState', 'saveMachineTranslation',
    'editTranslation', 'refineLexeme', 'queueReview', 'undoReview', 'resolveConflict', 'migrateLegacy', 'sync', 'stats',
    'getPracticeSession', 'savePracticeSession', 'clearPracticeSession',
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
      normalizeExpressionType,
      entryKey,
      compatibleEntryForIdentity,
      canonicalIdentity,
      mergeContexts,
      mergeCanonicalEntries,
      normalizeEntry,
      normalizePracticeSession,
      isProxy: true,
    };
  }

  return {
    ...directApi,
    normalizeTerm,
    normalizeExpressionType,
    entryKey,
    compatibleEntryForIdentity,
    canonicalIdentity,
    mergeContexts,
    mergeCanonicalEntries,
    normalizeEntry,
    normalizePracticeSession,
    MESSAGE_METHODS,
    isProxy: false,
    isServiceWorker,
  };
});
