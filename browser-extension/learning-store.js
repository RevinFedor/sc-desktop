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
  const PRACTICE_INSERT_PREFIX = 'practiceInsertReceiptV1:';
  const STUDY_STATE_META = 'studyStateV1';
  const BRIDGE = 'http://127.0.0.1:53127';
  const EXTENSION_ID = 'phnlfhkblebijojjnnlbcbklijgcijgf';
  const VALID_STATES = new Set(['none', 'saved', 'known', 'archived']);
  const VALID_EXPRESSION_TYPES = new Set(['phrasal_verb', 'function_phrase', 'idiom']);
  const listeners = new Set();
  const Lexeme = root.__scEnglishLexeme
    || (typeof require === 'function' ? require('./english-lexeme.js') : null);
  const ReviewScheduler = root.__scReviewScheduler
    || (typeof require === 'function' ? require('./review-scheduler.js') : null);
  const StudyState = root.__scStudyState || (typeof require === 'function' ? require('./study-state.js') : null);
  const isExtensionOrigin = (() => {
    try { return root.location?.protocol === 'chrome-extension:'; } catch { return false; }
  })();
  const isNativeStudy = (() => {
    try { return !!root.webkit?.messageHandlers?.studyNative; } catch { return false; }
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

  function catalogueHeadword(input) {
    return input?.senseCatalog?.validatedAt ? normalizeTerm(input.senseCatalog.source?.word) : '';
  }

  function entryKey(input) {
    const checkedWord = catalogueHeadword(input);
    if (checkedWord) return `word|${normalizeText(input.sourceLang || 'en', 32).toLowerCase()}|${normalizeText(input.targetLang || 'ru', 32).toLowerCase()}|${checkedWord}`;
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
    if (Lexeme?.canonicalIdentity) {
      const identity = Lexeme.canonicalIdentity(input || {});
      const checkedWord = catalogueHeadword(input);
      // A verified dictionary headword is not an unanalysed surface form:
      // reducing losing to lose would rename an entry with its own senses.
      return checkedWord ? { ...identity, lemma: checkedWord, confidence: 'high', provisional: false } : identity;
    }
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

  function senseIdFor(meaning, partOfSpeech, fallback = 'default') {
    const normalizedMeaning = normalizeText(meaning, 500).toLocaleLowerCase('ru-RU');
    const normalizedPos = Lexeme?.normalizePartOfSpeech
      ? Lexeme.normalizePartOfSpeech(partOfSpeech)
      : normalizeText(partOfSpeech || 'unknown', 32).toLocaleLowerCase('en-US');
    const value = normalizedMeaning || normalizeText(fallback, 500).toLocaleLowerCase('en-US') || 'default';
    return `sense:${normalizedPos || 'unknown'}:${value}`.slice(0, 700);
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
    const meaning = normalizeText(raw.meaning || raw.targetTerm || raw.target_term, 500);
    const catalogGroupId = normalizeText(raw.catalogGroupId, 200);
    const partOfSpeech = Lexeme?.normalizePartOfSpeech
      ? Lexeme.normalizePartOfSpeech(raw.partOfSpeech || raw.posTag)
      : normalizeText(raw.partOfSpeech || raw.posTag || 'unknown', 32).toLocaleLowerCase('en-US');
    return {
      id: `${videoId}:${startMs}:${sourceText.toLocaleLowerCase('en-US')}${catalogGroupId ? `:${catalogGroupId}` : ''}`,
      catalogGroupId,
      videoId,
      videoUrl: normalizeText(raw.videoUrl || raw.video_url, 2000),
      videoTitle: normalizeText(raw.videoTitle || raw.video_title, 1000),
      startMs,
      endMs: Number.isFinite(Number(endMsRaw)) ? Math.max(startMs, Math.round(Number(endMsRaw))) : null,
      sourceText,
      surfaceForm: normalizeText(raw.surfaceForm || raw.surface_form, 500),
      ...(raw.focusEn && sourceText.includes(raw.focusEn) ? { focusEn: raw.focusEn } : {}),
      ...(raw.focusRu && String(raw.translation || '').includes(raw.focusRu) ? { focusRu: raw.focusRu } : {}),
      translation: normalizeText(raw.translation || raw.translated_text, 4000),
      meaning,
      partOfSpeech,
      senseId: meaning
        ? (normalizeText(raw.senseId, 700) || senseIdFor(meaning, partOfSpeech, 'default'))
        : senseIdFor('', partOfSpeech, 'default'),
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
            senseId: context.senseId || previous.senseId,
            origin: context.origin || previous.origin,
            partOfSpeech: context.partOfSpeech !== 'unknown' ? context.partOfSpeech : previous.partOfSpeech,
            createdAt: Math.min(previous.createdAt, context.createdAt),
          }
        : context);
    }
    const contexts = Array.from(merged.values()).sort((a, b) => b.createdAt - a.createdAt);
    // The observation-history limit cannot remove a checked meaning's only
    // example. Keep the same separation as the canonical vocabulary server.
    return [
      ...contexts.filter(context => context.catalogGroupId),
      ...contexts.filter(context => !context.catalogGroupId).slice(0, 100),
    ];
  }

  function normalizeSenses(rawSenses, contexts, fallback = {}) {
    const checked = fallback.checkedCatalogue === true;
    const source = new Map((Array.isArray(rawSenses) ? rawSenses : []).filter(raw =>
      !checked || (raw?.catalogGroupId && !fallback.supportIds?.includes(raw.catalogGroupId))).map((raw) => [
      normalizeText(raw?.id || raw?.senseId, 700),
      raw,
    ]).filter(([id]) => id));
    const groups = new Map(checked ? [...source.keys()].map(id => [id, []]) : []);
    for (const context of contexts || []) {
      const id = context.senseId || senseIdFor(context.meaning, context.partOfSpeech, context.sourceText);
      // An observed video sentence is not a new dictionary meaning. In
      // particular, a blank meaning cannot inherit the first Russian gloss.
      if (checked && !source.has(id)) continue;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(context);
    }
    if (!groups.size && !checked) {
      const id = senseIdFor(fallback.translation, fallback.partOfSpeech, fallback.sourceText || 'default');
      groups.set(id, []);
    }
    return Array.from(groups, ([id, senseContexts]) => {
      const raw = source.get(id) || {};
      const inheritsExistingSchedule = !!source.get(id) || fallback.inheritSchedule !== false;
      const representative = senseContexts.find((context) => context.meaning) || senseContexts[0] || {};
      const rememberedCount = Math.max(0, Number(raw.rememberedCount ?? (inheritsExistingSchedule ? fallback.rememberedCount : 0) ?? 0) || 0);
      const forgottenCount = Math.max(0, Number(raw.forgottenCount ?? (inheritsExistingSchedule ? fallback.forgottenCount : 0) ?? 0) || 0);
      const partialCount = Math.max(0, Number(raw.partialCount ?? (inheritsExistingSchedule ? fallback.partialCount : 0) ?? 0) || 0);
      const practiceRememberedCount = Math.max(0, Number(raw.practiceRememberedCount ?? (inheritsExistingSchedule ? fallback.practiceRememberedCount : 0) ?? 0) || 0);
      const practiceForgottenCount = Math.max(0, Number(raw.practiceForgottenCount ?? (inheritsExistingSchedule ? fallback.practiceForgottenCount : 0) ?? 0) || 0);
      const practicePartialCount = Math.max(0, Number(raw.practicePartialCount ?? (inheritsExistingSchedule ? fallback.practicePartialCount : 0) ?? 0) || 0);
      return {
        id,
        catalogGroupId: normalizeText(raw.catalogGroupId || representative.catalogGroupId, 200),
        meaning: normalizeText(raw.meaning || representative.meaning || fallback.translation, 500),
        shortMeaning: normalizeText(raw.shortMeaning, 160),
        alternatives: Array.from(new Set(
          (Array.isArray(raw.alternatives) ? raw.alternatives : [])
            .map((value) => normalizeText(typeof value === 'object' ? value?.value || value?.text : value, 160))
            .filter(Boolean),
        )).slice(0, 20),
        headwordChoice: raw.headwordChoice?.term ? {
          term: normalizeText(raw.headwordChoice.term, 160),
          nuance: normalizeText(raw.headwordChoice.nuance, 160),
        } : null,
        englishAlternatives: (Array.isArray(raw.englishAlternatives) ? raw.englishAlternatives : [])
          .map(value => ({ term: normalizeText(value?.term, 160), nuance: normalizeText(value?.nuance, 160) }))
          .filter(value => value.term),
        partOfSpeech: Lexeme?.normalizePartOfSpeech
          ? Lexeme.normalizePartOfSpeech(raw.partOfSpeech || representative.partOfSpeech || fallback.partOfSpeech)
          : normalizeText(raw.partOfSpeech || representative.partOfSpeech || fallback.partOfSpeech || 'unknown', 32),
        contextIds: Array.from(new Set(senseContexts.map((context) => context.id).filter(Boolean))),
        dueAt: raw.dueAt || (inheritsExistingSchedule ? fallback.dueAt : '') || new Date(Number(fallback.createdAt) || now()).toISOString(),
        lastReviewedAt: raw.lastReviewedAt ?? (inheritsExistingSchedule ? fallback.lastReviewedAt : null) ?? null,
        lastPracticedAt: raw.lastPracticedAt ?? (inheritsExistingSchedule ? fallback.lastPracticedAt : null) ?? null,
        reviewCount: Math.max(0, Number(raw.reviewCount ?? (rememberedCount + forgottenCount + partialCount)) || 0),
        rememberedCount,
        forgottenCount,
        partialCount,
        practiceCount: Math.max(0, Number(raw.practiceCount ?? (practiceRememberedCount + practiceForgottenCount + practicePartialCount)) || 0),
        practiceRememberedCount,
        practiceForgottenCount,
        practicePartialCount,
      };
    });
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
    const key = entryKey({ kind, sourceLang, targetLang, lemma, partOfSpeech, sourceText, senseCatalog: raw?.senseCatalog || existing?.senseCatalog });
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
    const rememberedCount = Math.max(0, Number(raw?.rememberedCount ?? existing?.rememberedCount ?? 0) || 0);
    const forgottenCount = Math.max(0, Number(raw?.forgottenCount ?? existing?.forgottenCount ?? 0) || 0);
    const partialCount = Math.max(0, Number(raw?.partialCount ?? existing?.partialCount ?? 0) || 0);
    const practiceRememberedCount = Math.max(0, Number(raw?.practiceRememberedCount ?? existing?.practiceRememberedCount ?? 0) || 0);
    const practiceForgottenCount = Math.max(0, Number(raw?.practiceForgottenCount ?? existing?.practiceForgottenCount ?? 0) || 0);
    const practicePartialCount = Math.max(0, Number(raw?.practicePartialCount ?? existing?.practicePartialCount ?? 0) || 0);
    const dueAt = raw?.dueAt ?? existing?.dueAt ?? new Date(createdAt).toISOString();
    const lastReviewedAt = raw?.lastReviewedAt ?? existing?.lastReviewedAt ?? null;
    const lastPracticedAt = raw?.lastPracticedAt ?? existing?.lastPracticedAt ?? null;
    // State-only changes retain the canonical root schedule supplied by Voice.
    const fsrs = raw?.fsrs === undefined ? existing?.fsrs : raw.fsrs;
    const catalogue = raw?.senseCatalog || existing?.senseCatalog;
    const senseInputs = catalogue?.validatedAt && Array.isArray(raw?.senses)
      ? raw.senses : [...(existing?.senses || []), ...(raw?.senses || [])];
    const senses = normalizeSenses(
      senseInputs,
      contexts,
      {
        sourceText,
        translation,
        partOfSpeech,
        createdAt,
        dueAt,
        lastReviewedAt,
        lastPracticedAt,
        rememberedCount,
        forgottenCount,
        partialCount,
        practiceRememberedCount,
        practiceForgottenCount,
        practicePartialCount,
        inheritSchedule: (raw?.senseVersion ?? existing?.senseVersion) !== 2,
        checkedCatalogue: !!catalogue?.validatedAt && senseInputs.some(sense => sense?.catalogGroupId),
        supportIds: (catalogue?.supportGroups || []).map(group => group.id),
      },
    );
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
      senseVersion: 2,
      senses,
      senseCatalog: raw?.senseCatalog || existing?.senseCatalog || null,
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
      ...(fsrs === undefined ? {} : { fsrs }),
      reviewSchedule: raw?.reviewSchedule === undefined ? existing?.reviewSchedule || null : raw.reviewSchedule,
      dueAt,
      lastReviewedAt,
      lastPracticedAt,
      reviewCount: Math.max(0, Number(raw?.reviewCount ?? existing?.reviewCount
        ?? (rememberedCount + forgottenCount + partialCount)) || 0),
      rememberedCount,
      forgottenCount,
      partialCount,
      practiceCount: Math.max(0, Number(raw?.practiceCount ?? existing?.practiceCount
        ?? (practiceRememberedCount + practiceForgottenCount + practicePartialCount)) || 0),
      practiceRememberedCount,
      practiceForgottenCount,
      practicePartialCount,
    };
  }

  function normalizePracticeSession(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const messages = (Array.isArray(raw.messages) ? raw.messages : []).slice(-100).map((message, index) => ({
      id: normalizeText(message?.id || `practice-message-${index}`, 220),
      role: message?.role === 'user' ? 'user' : 'assistant',
      english: String(message?.english || message?.content || '').trim().slice(0, 24000),
      russian: message?.role === 'user' ? '' : normalizeText(message?.russian, 8000),
      feedbackRussian: String(message?.feedbackRussian || '').trim().slice(0, 12000),
      correctedEnglish: String(message?.correctedEnglish || '').trim().slice(0, 24000),
      usedVocabularyIds: Array.from(new Set(
        (Array.isArray(message?.usedVocabularyIds) ? message.usedVocabularyIds : [])
          .map((value) => normalizeText(value, 220))
          .filter(Boolean),
      )).slice(0, 16),
      createdAt: Number(message?.createdAt) || now(),
      ...(message?.role === 'user' ? {
        status: ['pending', 'failed'].includes(message.status) ? message.status : 'sent',
        error: normalizeText(message.error, 1000),
        ...(['pending', 'failed'].includes(message.status) && message.request && typeof message.request === 'object'
          ? { request: message.request } : {}),
      } : {}),
    })).filter((message) => message.english);
    const createdAt = Number(raw.createdAt) || now();
    return {
      id: 'current',
      theme: raw.theme === 'technical_interview' ? 'technical_interview' : 'general',
      model: normalizeText(raw.model, 120),
      draft: String(raw.draft || '').slice(0, 24000),
      draftEpoch: Number.isSafeInteger(raw.draftEpoch) && raw.draftEpoch >= 0 ? raw.draftEpoch : 0,
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
      try {
        result = work(tx);
        result?.catch?.(error => { try { tx.abort(); } catch {} reject(error); });
      }
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
    return state === 'saved' ? 4 : state === 'known' ? 3 : state === 'archived' ? 2 : 1;
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
    const partialCount = entries.reduce((sum, entry) => sum + Number(entry.partialCount || 0), 0);
    const practiceRememberedCount = entries.reduce((sum, entry) => sum + Number(entry.practiceRememberedCount || 0), 0);
    const practiceForgottenCount = entries.reduce((sum, entry) => sum + Number(entry.practiceForgottenCount || 0), 0);
    const practicePartialCount = entries.reduce((sum, entry) => sum + Number(entry.practicePartialCount || 0), 0);
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
      partialCount,
      reviewCount: rememberedCount + forgottenCount + partialCount,
      practiceRememberedCount,
      practiceForgottenCount,
      practicePartialCount,
      practiceCount: practiceRememberedCount + practiceForgottenCount + practicePartialCount,
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
    return getEntryFromStore(tx.objectStore(ENTRIES), query);
  }

  // Used by reads and atomic state commands. A canonical server ID is not a
  // local lexeme key, and must not rely on a word-only text fallback.
  async function getEntryFromStore(store, query) {
    const remoteId = normalizeText(query?.remoteId, 220);
    if (remoteId) {
      const remote = await requestResult(store.index('remoteId').get(remoteId));
      if (remote) return remote;
    }
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

  async function putLocalEntryDirect(entry, detail = { type: 'entry-changed' }, previousKeys = []) {
    const updated = await putEntryDirect(entry, detail, previousKeys);
    // App Group is a recovery copy of local actions, including metadata edits.
    // Canonical sync uses its own transaction and must not enqueue itself again.
    await mirrorNativePending({ entries: [updated] }).catch(() => {});
    return updated;
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
    return putLocalEntryDirect(entry, { type: 'entry-changed' }, previousKeys);
  }

  async function setStateDirect(payload) {
    await ensureLexemeMigrationDirect();
    const updated = await transaction([ENTRIES], 'readwrite', async tx => {
      const records = tx.objectStore(ENTRIES);
      const existing = await getEntryFromStore(records, payload);
      const requested = normalizeState(payload?.state);
      const state = payload?.toggle !== false && existing?.state === requested ? 'none' : requested;
      const timestamp = now();
      // A stale screen snapshot is not an edit of lexical content or progress.
      // Creation can supply initial content; existing records only accept the
      // state command and explicitly new observations inside this transaction.
      const entry = existing ? { ...existing, state, updatedAt: timestamp,
        stateUpdatedAt: state !== existing.state ? timestamp : existing.stateUpdatedAt,
        dirty: true,
      } : normalizeEntry({ ...payload, state, dirty: true,
        translationDirty: !!normalizeText(payload?.translation, 4000),
        createdAt: timestamp, updatedAt: timestamp, stateUpdatedAt: timestamp });
      if (payload?.contextAdditions?.length) entry.contexts = mergeContexts(payload.contextAdditions, entry.contexts);
      if (payload?.observedFormAdditions?.length) entry.observedForms = normalizeObservedForms(
        [...(entry.observedForms || []), ...payload.observedFormAdditions]);
      records.put(entry);
      return entry;
    });
    notify({ type: 'entry-changed', key: updated.key, state: updated.state });
    await mirrorNativePending({ entries: [updated] }).catch(() => {});
    return updated;
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
    const result = payload?.result === 'forgotten'
      ? 'forgotten'
      : payload?.result === 'known' ? 'known' : payload?.result === 'partial' ? 'partial' : 'remembered';
    const mode = payload?.mode === 'practice' ? 'practice' : 'scheduled';
    const reviewedAt = Number(payload?.reviewedAt) || now();
    const senseId = normalizeText(payload?.senseId, 700);
    const targetSense = senseId ? entry.senses?.find((sense) => sense.id === senseId) : null;
    if (senseId && !targetSense) throw new Error('Sense is not available');
    const successful = result === 'remembered' || result === 'known';
    const rememberedCount = Number(entry.rememberedCount || 0) + (mode === 'scheduled' && successful ? 1 : 0);
    const forgottenCount = Number(entry.forgottenCount || 0) + (mode === 'scheduled' && result === 'forgotten' ? 1 : 0);
    const partialCount = Number(entry.partialCount || 0) + (mode === 'scheduled' && result === 'partial' ? 1 : 0);
    const reviewCount = rememberedCount + forgottenCount + partialCount;
    const practiceRememberedCount = Number(entry.practiceRememberedCount || 0) + (mode === 'practice' && successful ? 1 : 0);
    const practiceForgottenCount = Number(entry.practiceForgottenCount || 0) + (mode === 'practice' && result === 'forgotten' ? 1 : 0);
    const practicePartialCount = Number(entry.practicePartialCount || 0) + (mode === 'practice' && result === 'partial' ? 1 : 0);
    const practiceCount = practiceRememberedCount + practiceForgottenCount + practicePartialCount;
    const senseRememberedCount = Number(targetSense?.rememberedCount || 0) + (mode === 'scheduled' && successful ? 1 : 0);
    const senseForgottenCount = Number(targetSense?.forgottenCount || 0) + (mode === 'scheduled' && result === 'forgotten' ? 1 : 0);
    const sensePartialCount = Number(targetSense?.partialCount || 0) + (mode === 'scheduled' && result === 'partial' ? 1 : 0);
    const sensePracticeRememberedCount = Number(targetSense?.practiceRememberedCount || 0) + (mode === 'practice' && successful ? 1 : 0);
    const sensePracticeForgottenCount = Number(targetSense?.practiceForgottenCount || 0) + (mode === 'practice' && result === 'forgotten' ? 1 : 0);
    const sensePracticePartialCount = Number(targetSense?.practicePartialCount || 0) + (mode === 'practice' && result === 'partial' ? 1 : 0);
    const baseDays = result === 'known' ? 4 : 1;
    const days = successful
      ? Math.min(60, Math.max(baseDays, baseDays * 2 ** Math.max(0, senseRememberedCount - 1)))
      : 0;
    const senseDueAt = mode === 'scheduled'
      ? new Date(reviewedAt + (successful ? days * 86_400_000 : result === 'partial' ? 30 * 60_000 : 10 * 60_000)).toISOString()
      : targetSense?.dueAt;
    const senses = !targetSense ? entry.senses : entry.senses.map((sense) => sense.id !== senseId ? sense : {
      ...sense,
      dueAt: senseDueAt,
      lastReviewedAt: mode === 'scheduled' ? reviewedAt : sense.lastReviewedAt,
      lastPracticedAt: mode === 'practice' ? reviewedAt : sense.lastPracticedAt,
      reviewCount: senseRememberedCount + senseForgottenCount + sensePartialCount,
      rememberedCount: senseRememberedCount,
      forgottenCount: senseForgottenCount,
      partialCount: sensePartialCount,
      practiceCount: sensePracticeRememberedCount + sensePracticeForgottenCount + sensePracticePartialCount,
      practiceRememberedCount: sensePracticeRememberedCount,
      practiceForgottenCount: sensePracticeForgottenCount,
      practicePartialCount: sensePracticePartialCount,
    });
    const dueTimes = senses.map((sense) => Date.parse(sense.dueAt)).filter(Number.isFinite);
    const reviewId = payload?.id || `review:${entry.key}:${reviewedAt}:${Math.random().toString(36).slice(2, 10)}`;
    const observation = { id: reviewId, durationMs: payload?.durationMs, recallVersion: payload?.recallVersion,
      trace: payload?.trace, meaningRecall: payload?.meaningRecall };
    let projectedSchedule = !targetSense && mode === 'scheduled'
      ? ReviewScheduler?.project(entry.reviewSchedule, result, reviewedAt, observation) : null;
    if (!targetSense && mode === 'scheduled' && !projectedSchedule) {
      // Keep the real answer/outbox, but never invent an alternative FSRS due.
      // The canonical server resolves it on sync; pending is not free capacity.
      projectedSchedule = { ...(entry.reviewSchedule || {}), version: 1, pending: true,
        queue: ReviewScheduler?.record(entry.reviewSchedule?.queue, result, reviewedAt, observation)
          || { version: 1, cohort: 'active', introducedAt: reviewedAt } };
    }
    if (!targetSense && mode === 'practice' && entry.reviewSchedule
      && (result === 'remembered' || result === 'forgotten')) {
      projectedSchedule = { ...entry.reviewSchedule,
        queue: { ...(entry.reviewSchedule.queue || {}), meaningRecall: {} } };
    }
    const dueAt = projectedSchedule?.card?.due || (!targetSense ? entry.dueAt
      : dueTimes.length ? new Date(Math.min(...dueTimes)).toISOString() : entry.dueAt);
    const operation = {
      id: reviewId,
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
      senseId,
      reviewedAt,
      ...([1, 2].includes(payload?.recallVersion) ? { recallVersion: payload.recallVersion } : {}),
      ...(payload?.trace ? { trace: payload.trace } : {}),
      ...(payload?.meaningRecall ? { meaningRecall: payload.meaningRecall } : {}),
      ...(Number(payload?.durationMs) > 0 ? { durationMs: Math.min(3_600_000, Number(payload.durationMs)) } : {}),
      createdAt: now(),
    };
    const updated = normalizeEntry({
      ...entry,
      rememberedCount,
      forgottenCount,
      partialCount,
      reviewCount,
      practiceRememberedCount,
      practiceForgottenCount,
      practicePartialCount,
      practiceCount,
      senses,
      lastReviewedAt: mode === 'scheduled' ? reviewedAt : entry.lastReviewedAt,
      lastPracticedAt: mode === 'practice' ? reviewedAt : entry.lastPracticedAt,
      dueAt,
      updatedAt: now(),
      ...(projectedSchedule ? { reviewSchedule: projectedSchedule } : {}),
    }, entry);
    await transaction([ENTRIES, OUTBOX], 'readwrite', (tx) => {
      tx.objectStore(ENTRIES).put(updated);
      tx.objectStore(OUTBOX).put(operation);
    });
    await mirrorNativePending({ entries: [updated], reviews: [operation] }).catch(() => {});
    notify({ type: 'review-queued', key: entry.key, senseId, result, mode });
    return { entry: updated, operation, entryBefore: entry };
  }

  async function queueSkipDirect(payload) {
    const timestamp = now(), key = String(payload?.key || '');
    let entryBefore, updated, operation;
    await transaction([ENTRIES, OUTBOX], 'readwrite', tx => {
      const records = tx.objectStore(ENTRIES);
      records.get(key).onsuccess = event => {
        const entry = event.target.result;
        if (!entry || entry.state !== 'saved') { tx.abort(); return; }
        entryBefore = entry;
        operation = { id: payload?.id || `skip:${timestamp}:${Math.random().toString(36).slice(2)}`, type: 'skip',
          entryKey: key, remoteId: entry.remoteId || '', term: entry.sourceText, lemma: entry.lemma,
          kind: entry.kind, sourceLang: entry.sourceLang, targetLang: entry.targetLang, partOfSpeech: entry.partOfSpeech,
          skippedAt: timestamp, createdAt: timestamp };
        updated = normalizeEntry({ ...entry, reviewSchedule: StudyState.skipSchedule(entry.reviewSchedule, operation),
          updatedAt: Math.max(timestamp, Number(entry.updatedAt || 0) + 1) }, entry);
        records.put(updated); tx.objectStore(OUTBOX).put(operation);
      };
    });
    await mirrorNativePending({ entries: [updated], reviews: [operation] }).catch(() => {});
    notify({ type: 'skip-queued', key });
    return { entry: updated, entryBefore, operation };
  }

  async function undoSkipDirect(payload) {
    const timestamp = now(), operationId = payload?.operation?.id, key = payload?.key;
    let updated;
    const operation = { id: `undo-skip:${timestamp}:${Math.random().toString(36).slice(2)}`, type: 'undo-skip',
      entryKey: key, skipOperationId: operationId, createdAt: timestamp };
    await transaction([ENTRIES, OUTBOX], 'readwrite', tx => {
      const records = tx.objectStore(ENTRIES);
      records.get(key).onsuccess = event => {
        const entry = event.target.result;
        if (!entry || entry.reviewSchedule?.queue?.skip?.operationId !== operationId) { tx.abort(); return; }
        Object.assign(operation, { remoteId: entry.remoteId || '', term: entry.sourceText, lemma: entry.lemma,
          kind: entry.kind, sourceLang: entry.sourceLang, targetLang: entry.targetLang, partOfSpeech: entry.partOfSpeech });
        updated = normalizeEntry({ ...entry,
          reviewSchedule: StudyState.undoSkipSchedule(entry.reviewSchedule, payload.entryBefore?.reviewSchedule, operationId),
          updatedAt: Math.max(timestamp, Number(entry.updatedAt || 0) + 1) }, entry);
        records.put(updated); tx.objectStore(OUTBOX).put(operation);
      };
    });
    await mirrorNativePending({ entries: [updated], reviews: [operation] }).catch(() => {});
    notify({ type: 'skip-undone', key });
    return { entry: updated, operation };
  }

  async function undoReviewDirect(payload) {
    const current = await getEntryDirect({ key: payload?.key || payload?.entryBefore?.key });
    const entryBefore = payload?.entryBefore;
    const reviewOperation = payload?.operation;
    if (!current || !entryBefore || entryBefore.key !== current.key) throw new Error('Review snapshot is unavailable');
    const reviewOperationId = String(reviewOperation?.id || '').trim();
    if (!reviewOperationId) throw new Error('Review operation is unavailable');
    const timestamp = now();
    let restored;
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
      const entries = tx.objectStore(ENTRIES);
      entries.get(current.key).onsuccess = event => {
        const latest = event.target.result;
        if (!latest) { tx.abort(); return; }
        // Read and restore in the same transaction so an intervening label,
        // archive, catalogue or remote metadata update remains authoritative.
        const reviewFields = before => Object.fromEntries(REVIEW_FIELDS
          .filter(field => Object.prototype.hasOwnProperty.call(before || {}, field))
          .map(field => [field, before[field]]));
        const previousSenses = new Map((entryBefore.senses || []).map(sense => [sense.id, sense]));
        restored = normalizeEntry({
          ...latest,
          ...reviewFields(entryBefore),
          senses: (latest.senses || []).map(sense => ({ ...sense, ...reviewFields(previousSenses.get(sense.id)) })),
          updatedAt: Math.max(timestamp, Number(latest.updatedAt || 0) + 1),
        });
        entries.put(restored);
        // Keep an unsynced original: the server receives review → undo in order.
        tx.objectStore(OUTBOX).put(undoOperation);
      };
    });
    await mirrorNativePending({ entries: [restored], reviews: [undoOperation] }).catch(() => {});
    notify({ type: 'review-undone', key: current.key, reviewOperationId });
    return { entry: restored, operation: undoOperation };
  }

  async function dueEntriesDirect(options = {}) {
    const currentTime = Number(options.now) || now();
    const limit = Math.max(1, Math.min(500, Number(options.limit) || 100));
    const entries = await listEntriesDirect({ states: ['saved'] });
    return entries
      .filter(entry => !(Number(entry.reviewSchedule?.queue?.skip?.until) > currentTime))
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

  async function getStudyStateDirect() {
    if (isNativeStudy) {
      const result = await nativeStudyRequest('/vocabulary/study-state');
      return StudyState.normalize(result.state);
    }
    return StudyState.normalize((await getMetaDirect(STUDY_STATE_META))?.value);
  }

  async function studyActionDirect(payload) {
    const action = { ...payload, at: Number(payload?.at) || now(),
      id: payload?.id || globalThis.crypto?.randomUUID?.() || `${now()}-${Math.random()}` };
    let result;
    if (isNativeStudy) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const previous = await getStudyStateDirect();
        result = StudyState.reduce(previous, action);
        if (!result.changed) return result;
        try {
          await nativeStudyRequest('/vocabulary/study-state', { method: 'POST', body: {
            expectedRevision: previous.revision, state: result.state,
            studyEvents: [result.event], preferenceOperations: result.preference ? [result.preference] : [],
          } });
          break;
        } catch (error) { if (error.status !== 409 || attempt === 2) throw error; }
      }
    } else {
      await transaction([META, OUTBOX], 'readwrite', tx => {
        tx.objectStore(META).get(STUDY_STATE_META).onsuccess = event => {
          result = StudyState.reduce(event.target.result?.value, action);
          if (!result.changed) return;
          tx.objectStore(META).put({ key: STUDY_STATE_META, value: result.state, updatedAt: now() });
          tx.objectStore(OUTBOX).put({ id: result.event.id, type: 'study-event', event: result.event, createdAt: action.at });
          if (result.preference) tx.objectStore(OUTBOX).put({ id: result.preference.id, type: 'study-preference', preference: result.preference, createdAt: action.at });
          tx.objectStore(OUTBOX).getAll().onsuccess = event => {
            const traces = event.target.result.filter(row => row.type === 'study-event').sort((a, b) => a.createdAt - b.createdAt);
            for (const row of traces.slice(0, Math.max(0, traces.length - 1000))) tx.objectStore(OUTBOX).delete(row.id);
          };
        };
      });
    }
    if (result.changed) notify({ type: 'study-state-changed' });
    return result;
  }

  async function studySyncPayloadDirect() {
    const rows = (await syncSnapshotDirect()).reviews;
    return { studyStateVersion: 1, studyEvents: rows.filter(row => row.type === 'study-event').map(row => row.event),
      preferenceOperations: rows.filter(row => row.type === 'study-preference').map(row => row.preference) };
  }

  async function applyStudySyncDirect(result) {
    if (isNativeStudy) return;
    const ack = new Set([...(result?.acknowledgedStudyEvents || []), ...(result?.acknowledgedStudyPreferences || [])]);
    await transaction([META, OUTBOX], 'readwrite', tx => {
      tx.objectStore(META).get(STUDY_STATE_META).onsuccess = event => {
        const state = StudyState.mergePreferences(event.target.result?.value, result?.studyPreferences, [...ack]);
        tx.objectStore(META).put({ key: STUDY_STATE_META, value: state, updatedAt: now() });
        for (const id of ack) tx.objectStore(OUTBOX).delete(id);
      };
    });
    notify({ type: 'study-state-changed' });
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

  async function applyPracticeInsertionDirect(payload, { readDraft } = {}) {
    const validString = (value, max, required = true) => typeof value === 'string'
      && value.length <= max && (!required || value.length > 0);
    if (payload?.action !== 'insert' || !Number.isSafeInteger(payload.sessionId) || payload.sessionId <= 0
      || !validString(payload.insertionId, 220) || (payload.takeId !== null && !validString(payload.takeId, 220, false))
      || payload.revision !== 1 || !validString(payload.targetKey, 2048) || !validString(payload.text, 24000)) {
      return { status: 'rejected', reason: 'invalid-insertion' };
    }
    const draftEpoch = payload.draftEpoch ?? 0;
    const editRevision = payload.draftRevision ?? 0, draftSeq = payload.draftSeq ?? payload.seq ?? 0;
    const hasEdit = payload.draftBase !== undefined || payload.draftText !== undefined;
    if (![draftEpoch, editRevision, draftSeq].every(value => Number.isSafeInteger(value) && value >= 0)
      || hasEdit && (!validString(payload.draftBase, 24000, false) || !validString(payload.draftText, 24000, false))) {
      return { status: 'rejected', reason: 'invalid-draft-reconcile' };
    }
    const operation = { action: 'insert', sessionId: payload.sessionId, insertionId: payload.insertionId,
      takeId: payload.takeId, revision: 1, targetKey: payload.targetKey, text: payload.text };
    // Delivery seq/document are intentionally absent: the same immutable insert
    // can be replayed in a recreated page without becoming a second operation.
    const fingerprint = JSON.stringify(operation);
    const key = `${PRACTICE_INSERT_PREFIX}${operation.sessionId}:${operation.insertionId}`;
    let result = { status: 'rejected', reason: 'session-not-current' };
    await transaction([META], 'readwrite', tx => {
      const metadata = tx.objectStore(META);
      let sessionRow, markerRow, sessionLoaded = false, markerLoaded = false;
      metadata.get(PRACTICE_SESSION_META).onsuccess = event => { sessionRow = event.target.result; sessionLoaded = true; apply(); };
      metadata.get(key).onsuccess = event => { markerRow = event.target.result; markerLoaded = true; apply(); };
      function apply() {
        if (!sessionLoaded || !markerLoaded) return;
        try {
          const session = normalizePracticeSession(sessionRow?.value);
          if (!session || session.createdAt !== operation.sessionId) return;
          // The Native renderer supplies a synchronous lease/draft read at the
          // actual write boundary, after any intervening typed edits. RPC-only
          // callers use the current committed IndexedDB draft instead.
          const live = readDraft?.();
          if (readDraft && (!live || live.active !== true || live.sessionId !== operation.sessionId
            || live.targetKey !== operation.targetKey || typeof live.draft !== 'string')) {
            result = { status: 'rejected', reason: 'owner-not-current' }; return;
          }
          const marker = markerRow?.value;
          if (marker) {
            if (marker.fingerprint !== fingerprint || marker.draftEpoch !== draftEpoch) {
              result = { status: 'conflict', reason: 'immutable-insertion-changed' }; return;
            }
            if (marker.draftEpoch !== session.draftEpoch) {
              result = { status: 'duplicate', session, baseDraft: session.draft, receipt: marker.operation,
                draftSeq: marker.draftSeq, draftRevision: marker.draftRevision, draftEpoch: marker.draftEpoch, pastDraftEpoch: true }; return;
            }
          } else if (draftEpoch !== session.draftEpoch) return;
          const baseDraft = live ? live.draft : session.draft;
          const append = draft => draft ? `${draft}\n\n${operation.text}` : operation.text;
          let draft, nextMarker;
          if (!marker) {
            const typed = hasEdit ? mergePracticeDrafts(payload.draftBase, payload.draftText, baseDraft) : baseDraft;
            if (typed === null) { result = { status: 'conflict', reason: 'draft-base-diverged' }; return; }
            draft = append(typed);
            nextMarker = { version: 1, operation, fingerprint, draftEpoch, nativeDraftText: hasEdit ? payload.draftText : baseDraft,
              draftRevision: editRevision, draftSeq };
          } else {
            draft = baseDraft;
            nextMarker = { ...marker };
            if (hasEdit && editRevision > marker.draftRevision) {
              draft = mergePracticeDrafts(append(marker.nativeDraftText), append(payload.draftText), baseDraft);
              if (draft === null) { result = { status: 'conflict', reason: 'draft-base-diverged' }; return; }
              nextMarker.nativeDraftText = payload.draftText;
              nextMarker.draftRevision = editRevision;
              nextMarker.draftSeq = draftSeq;
            } else if (hasEdit && editRevision === marker.draftRevision && payload.draftText !== marker.nativeDraftText) {
              result = { status: 'conflict', reason: 'draft-revision-body-changed' }; return;
            } else if (!hasEdit || editRevision === marker.draftRevision) {
              nextMarker.draftSeq = Math.max(marker.draftSeq, draftSeq);
            }
          }
          if (draft.length > 24000) { result = { status: 'rejected', reason: 'draft-too-long' }; return; }
          const committedAt = now();
          const next = normalizePracticeSession({ ...session, draft, updatedAt: committedAt });
          metadata.put({ key: PRACTICE_SESSION_META, value: next, updatedAt: committedAt });
          metadata.put({ key, value: { ...nextMarker, committedAt }, updatedAt: committedAt });
          result = { status: marker ? 'duplicate' : 'applied', session: next, baseDraft, receipt: operation,
            draftSeq: nextMarker.draftSeq, draftRevision: nextMarker.draftRevision, draftEpoch };
        } catch (error) {
          // A failed put/getter must abort BOTH draft and receipt writes. The
          // caller cannot turn request success into a durable acknowledgement.
          try { tx.abort(); } catch {}
        }
      }
    });
    if (result.status === 'applied') notify({ type: 'practice-session-changed' });
    return result;
  }

  // One contiguous edit from each writer can be merged only when the edits are
  // exact or disjoint in the same baseline. Ambiguous overlap remains unacknowledged.
  function mergePracticeDrafts(base, desired, current) {
    if (current === base || current === desired) return desired;
    if (desired === base) return current;
    const edit = text => {
      let start = 0, suffix = 0;
      while (start < base.length && start < text.length && base[start] === text[start]) start++;
      while (suffix < base.length - start && suffix < text.length - start
        && base[base.length - 1 - suffix] === text[text.length - 1 - suffix]) suffix++;
      return { start, end: base.length - suffix, text: text.slice(start, text.length - suffix) };
    };
    const a = edit(desired), b = edit(current);
    if (!(a.end <= b.start || b.end <= a.start) || a.start === b.start) return null;
    const edits = [a, b].sort((left, right) => right.start - left.start);
    return edits.reduce((draft, change) => draft.slice(0, change.start) + change.text + draft.slice(change.end), base);
  }

  async function clearPracticeSessionDirect() {
    await transaction([META], 'readwrite', tx => {
      const metadata = tx.objectStore(META);
      metadata.get(PRACTICE_SESSION_META).onsuccess = event => {
        const sessionId = event.target.result?.value?.createdAt;
        if (!sessionId) return;
        const prefix = `${PRACTICE_INSERT_PREFIX}${sessionId}:`;
        metadata.getAllKeys().onsuccess = keys => {
          for (const key of keys.target.result) if (typeof key === 'string' && key.startsWith(prefix)) metadata.delete(key);
        };
      };
      metadata.delete(PRACTICE_SESSION_META);
    });
    notify({ type: 'practice-session-changed' });
    return true;
  }

  async function nativeStudyRequest(path, options = {}) {
    const handler = root.webkit?.messageHandlers?.studyNative;
    if (!handler?.postMessage) throw new Error('iOS offline bridge is unavailable');
    // Use the same JSON representation as fetch(), including null for an absent/infinite deadline.
    const message = JSON.parse(JSON.stringify({
      kind: 'request',
      path,
      method: options.method || 'GET',
      ...(options.body === undefined ? {} : { body: options.body }),
    }));
    const payload = await handler.postMessage(message);
    if (!payload || payload.ok === false) {
      const error = new Error(payload?.error || 'iOS offline bridge returned no data');
      error.status = Number(payload?.status) || 0;
      throw error;
    }
    return payload;
  }

  async function mirrorNativePending(body) {
    if (!isNativeStudy) return;
    await nativeStudyRequest('/vocabulary/persist', { method: 'POST', body });
  }

  async function bridgeJson(path, options = {}, timeoutMs = 12_000) {
    if (isNativeStudy) return nativeStudyRequest(path, options);
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
      ...(remote?.fsrs === undefined ? {} : { fsrs: remote.fsrs }),
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
      senses: Array.isArray(remote?.senses) ? remote.senses : existing?.senses,
      senseCatalog: remote?.senseCatalog || null,
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
      reviewSchedule: remote?.reviewSchedule || null,
      lastReviewedAt: remote?.lastReviewedAt,
      lastPracticedAt: remote?.lastPracticedAt,
      reviewCount: remote?.reviewCount,
      rememberedCount: remote?.rememberedCount,
      forgottenCount: remote?.forgottenCount,
      partialCount: remote?.partialCount,
      practiceCount: remote?.practiceCount,
      practiceRememberedCount: remote?.practiceRememberedCount,
      practiceForgottenCount: remote?.practiceForgottenCount,
      practicePartialCount: remote?.practicePartialCount,
    }, existing ? { ...existing, contexts: [], senses: [], senseCatalog: null } : null);
  }

  const REVIEW_FIELDS = ['fsrs', 'reviewSchedule', 'dueAt', 'lastReviewedAt', 'lastPracticedAt', 'reviewCount',
    'rememberedCount', 'forgottenCount', 'partialCount', 'practiceCount',
    'practiceRememberedCount', 'practiceForgottenCount', 'practicePartialCount'];
  const sameValue = (left, right) => JSON.stringify(left) === JSON.stringify(right);

  // Only changes made AFTER the request snapshot are overlaid on the canonical
  // answer. In particular, do not merge every old dictionary example back in.
  function retainChangesAfterSync(merged, existing, sent, hasPendingReview) {
    if (!existing) return merged;
    const changed = fields => fields.some(field => !sameValue(existing[field], sent?.[field]));
    const copy = (target, from, fields) => fields.forEach(field => { target[field] = from[field]; });
    const next = { ...merged };
    if (existing.dirty && changed(['state', 'stateUpdatedAt'])) {
      copy(next, existing, ['state', 'stateUpdatedAt']);
      next.dirty = true;
    }
    if (existing.translationDirty && changed(['translation', 'translationSource', 'translationUpdatedAt'])) {
      copy(next, existing, ['translation', 'translationSource', 'translationUpdatedAt']);
      next.dirty = true;
      next.translationDirty = true;
    }
    const catalogueChanged = changed(['senseCatalog']) && !!existing.senseCatalog?.validatedAt;
    if (catalogueChanged) {
      copy(next, existing, ['senseCatalog', 'senses', 'contexts']);
      next.dirty = existing.dirty;
    } else if (changed(['contexts'])) {
      const before = new Map((sent?.contexts || []).map(context => [context.id, context]));
      const additions = (existing.contexts || []).filter(context => !sameValue(context, before.get(context.id)));
      next.contexts = mergeContexts(next.contexts, additions);
      if (additions.length) next.dirty = true;
    }
    const identityFields = ['kind', 'expressionType', 'sourceLang', 'targetLang', 'sourceText',
      'lemma', 'partOfSpeech', 'partsOfSpeech', 'analysisConfidence'];
    if ((catalogueChanged || !merged.senseCatalog?.validatedAt) && changed(identityFields)) {
      copy(next, existing, identityFields);
      next.dirty = existing.dirty;
    }
    if (changed(['observedForms'])) {
      next.observedForms = normalizeObservedForms([...(next.observedForms || []), ...(existing.observedForms || [])]);
      if (existing.dirty) next.dirty = true;
    }
    if (hasPendingReview) {
      // The outbox still owns these tentative counters/schedules. The next
      // acknowledged round replaces them with the server's FSRS calculation.
      copy(next, existing, REVIEW_FIELDS);
      const localSenses = new Map((existing.senses || []).map(sense => [sense.id, sense]));
      next.senses = (next.senses || []).map(sense => {
        const local = localSenses.get(sense.id);
        if (!local) return sense;
        const result = { ...sense };
        copy(result, local, REVIEW_FIELDS);
        return result;
      });
    }
    return normalizeEntry(next);
  }

  async function syncSnapshotDirect() {
    const snapshot = { entries: [], reviews: [] };
    await transaction([ENTRIES, OUTBOX], 'readonly', tx => {
      tx.objectStore(ENTRIES).getAll().onsuccess = event => { snapshot.entries = event.target.result; };
      tx.objectStore(OUTBOX).getAll().onsuccess = event => { snapshot.reviews = event.target.result; };
    });
    return snapshot;
  }

  async function applySyncResultDirect(result, { online = true, snapshot = { entries: [], reviews: [] } } = {}) {
    // A missing native cache is not a canonical empty dictionary. Legacy cache
    // payloads prove a complete snapshot only with an actual successful-sync time.
    const canonicalSnapshotKnown = online || (typeof result?.canonicalSnapshotKnown === 'boolean'
      ? result.canonicalSnapshotKnown
      : result?.canonicalSnapshotKnown === undefined && typeof result?.lastSyncedAt === 'number'
        && Number.isFinite(result.lastSyncedAt) && result.lastSyncedAt > 0);
    const sentByKey = new Map(snapshot.entries.map(entry => [entry.key, entry]));
    const sentById = new Map(snapshot.entries.filter(entry => entry.remoteId).map(entry => [entry.remoteId, entry]));
    const sentReviews = new Map(snapshot.reviews.map(operation => [operation.id, operation]));
    const conflictByKey = new Map((result?.conflicts || []).map(conflict => [conflict.key, conflict]));
    // Read the latest entries and apply the response inside ONE write transaction.
    // Otherwise a review from another page can land between the read and put.
    await transaction([ENTRIES, OUTBOX, META], 'readwrite', tx => {
      let existingEntries, currentReviews;
      tx.objectStore(ENTRIES).getAll().onsuccess = event => { existingEntries = event.target.result; apply(); };
      tx.objectStore(OUTBOX).getAll().onsuccess = event => { currentReviews = event.target.result; apply(); };
      function apply() {
        if (!existingEntries || !currentReviews) return;
        const currentById = new Map(currentReviews.map(operation => [operation.id, operation]));
        const acknowledged = new Set((online ? result?.acknowledgedReviews || [] : [])
          .filter(id => sentReviews.has(id) && sameValue(sentReviews.get(id), currentById.get(id))));
        const pending = currentReviews.filter(operation => !acknowledged.has(operation.id));
        const pendingKeys = new Set(pending.map(operation => operation.entryKey).filter(Boolean));
        const pendingIds = new Set(pending.map(operation => operation.remoteId).filter(Boolean));
        const hasPending = entry => pendingKeys.has(entry?.key) || pendingIds.has(entry?.remoteId);
        const basis = entry => sentByKey.get(entry?.key) || sentById.get(entry?.remoteId);
        const byKey = new Map(existingEntries.map((entry) => [entry.key, entry]));
        const originalByKey = new Map(byKey);
        const byRemoteId = new Map(existingEntries.filter((entry) => entry.remoteId).map((entry) => [entry.remoteId, entry]));
        const byForm = new Map();
        for (const entry of existingEntries) {
          for (const form of normalizeObservedForms(entry.observedForms, entry.sourceText, entry.lemma)) {
            if (!byForm.has(form)) byForm.set(form, []);
            byForm.get(form).push(entry);
          }
        }
        const syncedKeys = new Set(result?.syncedKeys || []);
        const seenRemoteIds = new Set();
        const matchedLocalKeys = new Set();
        const puts = new Map();
        const deletes = new Set();
        for (const remote of result?.items || []) {
          const remoteKey = entryKey({
            kind: remote?.kind,
            senseCatalog: remote?.senseCatalog,
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
          merged = retainChangesAfterSync(merged, existing, basis(existing), hasPending(existing));
          const sameKeyLocal = byKey.get(merged.key);
          if (sameKeyLocal && sameKeyLocal.key !== existing?.key) {
            merged = mergeCanonicalEntries([sameKeyLocal, merged], { markDirty: !!conflict || sameKeyLocal.dirty || merged.dirty });
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
          if (existing && sameValue(existing, basis(existing))) {
            puts.set(existing.key, normalizeEntry({ ...existing, dirty: false, translationDirty: false }, existing));
          }
        }
        for (const existing of existingEntries) {
          if (!canonicalSnapshotKnown || !existing.remoteId || existing.dirty || hasPending(existing) || !sameValue(existing, basis(existing))
            || seenRemoteIds.has(existing.remoteId) || matchedLocalKeys.has(existing.key)) continue;
          puts.set(existing.key, normalizeEntry({
            ...existing,
            state: 'none',
            remoteId: '',
            remoteUpdatedAt: 0,
            dirty: false,
            translationDirty: false,
          }, existing));
        }
        if (!online && Array.isArray(result?.localEntries)) {
          for (const raw of result.localEntries) {
            const current = originalByKey.get(raw.key);
            // A cached App Group snapshot cannot rewind an edit made while it was
            // being fetched. It can restore a recreated WebKit origin, however.
            if (!current || sameValue(current, basis(current))) {
              const entry = normalizeEntry(raw);
              puts.set(entry.key, entry);
            }
          }
        }
        const entriesStore = tx.objectStore(ENTRIES);
        for (const key of deletes) entriesStore.delete(key);
        for (const entry of puts.values()) entriesStore.put(entry);
        const outbox = tx.objectStore(OUTBOX);
        for (const id of acknowledged) outbox.delete(id);
        tx.objectStore(META).put({
          key: 'syncStatus',
          value: { online, canonicalSnapshotKnown, syncedAt: online ? now() : null, conflicts: conflictByKey.size,
            ...(online ? {} : { cached: true, error: result?.error || 'Voice Record offline' }) },
          updatedAt: now(),
        });
      }
    });
    notify({ type: 'sync-complete', online, conflicts: conflictByKey.size,
      ...(online ? {} : { cached: true, error: result?.error || '' }) });
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

  async function restoreNativeCacheDirect() {
    if (!isNativeStudy) return false;
    const snapshot = await syncSnapshotDirect();
    const cached = await nativeStudyRequest('/vocabulary/cache', { method: 'GET' });
    if (cached?.cached !== true || !Array.isArray(cached.items)) return false;
    await applySyncResultDirect(cached, { online: false, snapshot });
    return true;
  }

  async function syncDirect(options = {}) {
    if (syncPromise) {
      if (!options.fresh) return syncPromise;
      // Completion observers must not accept a request started before commit.
      await syncPromise;
      return syncDirect({ fresh: true });
    }
    syncPromise = (async () => {
      await migrateLegacyDirect();
      await ensureLexemeMigrationDirect();
      const snapshot = await syncSnapshotDirect();
      const entries = snapshot.entries.filter(entry => entry.dirty);
      const reviews = snapshot.reviews.filter(item => ['review', 'undo-review', 'skip', 'undo-skip'].includes(item.type));
      let result;
      try {
        result = await bridgeJson('/vocabulary/sync', { method: 'POST', body: { entries, reviews,
          studyStateVersion: 1,
          studyEvents: snapshot.reviews.filter(row => row.type === 'study-event').map(row => row.event),
          preferenceOperations: snapshot.reviews.filter(row => row.type === 'study-preference').map(row => row.preference),
        } });
      } catch (error) {
        await setMetaDirect('syncStatus', { online: false, syncedAt: null, error: error?.message || String(error) });
        notify({ type: 'sync-complete', online: false, error: error?.message || String(error) });
        return { online: false, error: error?.message || String(error) };
      }
      if (result?.online !== true) {
        if (result?.cached === true && Array.isArray(result.items)) {
          await applySyncResultDirect(result, { online: false, snapshot });
        } else {
          await setMetaDirect('syncStatus', { online: false, syncedAt: null, error: result?.error || 'Voice Record offline' });
          notify({ type: 'sync-complete', online: false, error: result?.error || '' });
        }
        return result;
      }
      await applySyncResultDirect(result, { snapshot });
      await applyStudySyncDirect(result);
      return result;
    })();
    try { return await syncPromise; }
    finally { syncPromise = null; }
  }

  async function resolveConflictDirect(payload) {
    const existing = await getEntryDirect({ key: payload?.key });
    if (!existing?.conflict) return existing || null;
    if (payload?.choice === 'remote') {
      return putLocalEntryDirect(normalizeEntry({
        ...existing,
        translation: existing.conflict.remoteValue,
        translationSource: 'manual',
        translationUpdatedAt: Number(existing.conflict.remoteTranslationUpdatedAt || now()),
        remoteTranslationUpdatedAt: Number(existing.conflict.remoteTranslationUpdatedAt || now()),
        conflict: null,
        // Reconcile the selected translation AND any independent local state
        // edits in the next round. Resolving one field must not clear them.
        dirty: true,
        translationDirty: false,
        updatedAt: now(),
      }, existing));
    }
    return putLocalEntryDirect(normalizeEntry({
      ...existing,
      remoteTranslationUpdatedAt: Number(existing.conflict.remoteTranslationUpdatedAt || existing.remoteTranslationUpdatedAt || 0),
      conflict: null,
      dirty: true,
      translationDirty: true,
      translationUpdatedAt: now(),
      updatedAt: now(),
    }, existing));
  }

  async function statsDirect() {
    const entries = await getAllEntriesDirect();
    const outbox = await getOutboxDirect();
    const syncStatus = (await getMetaDirect('syncStatus'))?.value || { online: false, syncedAt: null };
    return {
      total: entries.filter((entry) => entry.state === 'saved' || entry.state === 'known').length,
      saved: entries.filter((entry) => entry.state === 'saved').length,
      known: entries.filter((entry) => entry.state === 'known').length,
      archived: entries.filter((entry) => entry.state === 'archived').length,
      due: (await dueEntriesDirect()).length,
      pending: entries.filter((entry) => entry.dirty).length + outbox.filter(row => row.type !== 'study-event').length,
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
    restoreNativeCache: restoreNativeCacheDirect,
    queueReview: queueReviewDirect,
    queueSkip: queueSkipDirect, undoSkip: undoSkipDirect,
    undoReview: undoReviewDirect,
    resolveConflict: resolveConflictDirect,
    migrateLegacy: migrateLegacyDirect,
    sync: syncDirect,
    stats: statsDirect,
    getPracticeSession: getPracticeSessionDirect,
    savePracticeSession: savePracticeSessionDirect,
    applyPracticeInsertion: applyPracticeInsertionDirect,
    clearPracticeSession: clearPracticeSessionDirect,
    getStudyState: getStudyStateDirect,
    studyAction: studyActionDirect,
    studySyncPayload: studySyncPayloadDirect,
    applyStudySync: applyStudySyncDirect,
    subscribe,
  };

  const MESSAGE_METHODS = new Set([
    'getEntry', 'listEntries', 'dueEntries', 'setState', 'saveMachineTranslation',
    'editTranslation', 'refineLexeme', 'queueReview', 'undoReview', 'resolveConflict', 'migrateLegacy', 'sync', 'stats',
    'getPracticeSession', 'savePracticeSession', 'clearPracticeSession', 'applyPracticeInsertion',
    'restoreNativeCache', 'queueSkip', 'undoSkip', 'getStudyState', 'studyAction', 'studySyncPayload', 'applyStudySync',
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
    remoteToEntry,
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
