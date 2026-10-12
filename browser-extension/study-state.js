(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.__scStudyState = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';
  const id = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  function normalize(raw) {
    if (raw?.version && raw.version !== 1) throw new Error('Unsupported study state');
    return { version: 1, revision: Number(raw?.revision || 0),
      stream: raw?.stream || '', position: Number(raw?.position || 0),
      current: raw?.current || null, last: { ...(raw?.last || {}) }, waitKey: raw?.waitKey || '',
      preferences: { showSupport: raw?.preferences?.showSupport !== false, maskExampleAnswer: raw?.preferences?.maskExampleAnswer !== false,
        updatedAt: Number(raw?.preferences?.updatedAt || 0), revision: Number(raw?.preferences?.revision || 0) },
      pendingPreference: raw?.pendingPreference || null };
  }
  function reduce(raw, action) {
    const state = normalize(raw), at = Number(action.at) || Date.now();
    let ref = state.current, preference = null;
    if (action.kind === 'show') {
      const previous = state.last[action.wordKey];
      if (state.current?.wordKey === action.wordKey && state.current?.attempt === action.attempt) {
        return { state, ref: state.current, changed: false };
      }
      if (previous?.attempt === action.attempt) ref = previous;
      else {
        if (!state.stream) state.stream = id();
        ref = { stream: state.stream, position: ++state.position, id: id(), at,
          wordKey: action.wordKey, attempt: action.attempt };
        state.last[action.wordKey] = ref;
      }
      state.current = ref; state.waitKey = '';
    } else if (action.kind === 'restore') {
      state.current = ref = action.ref || null; state.waitKey = '';
    } else if (action.kind === 'wait') {
      if (!state.current && state.waitKey === action.waitKey) return { state, ref: null, changed: false };
      state.current = ref = null; state.waitKey = action.waitKey || '';
    } else if (action.kind === 'preference') {
      const field = action.field === 'maskExampleAnswer' ? 'maskExampleAnswer' : 'showSupport';
      preference = { id: `preference:${action.id || id()}`, [field]: action[field] === true, at };
      state.preferences = { ...state.preferences, [field]: preference[field], updatedAt: at };
      state.pendingPreference = preference;
    }
    state.revision++;
    const event = { id: `trace:${action.id || id()}`, at, revision: state.revision, kind: action.kind, client: action.client || 'unknown',
      stream: state.stream, position: state.position, wordKey: action.wordKey || ref?.wordKey || '',
      word: action.word || '', ref, data: action.data || {}, ...(preference ? { preference } : {}) };
    return { state, ref, event, preference, changed: true };
  }
  function mergePreferences(raw, preferences, acknowledged = []) {
    const state = normalize(raw);
    if (state.pendingPreference && !acknowledged.includes(state.pendingPreference.id)) return state;
    if (state.pendingPreference) state.pendingPreference = null;
    if (typeof preferences?.showSupport === 'boolean' && Number(preferences.revision || 0) >= state.preferences.revision) {
      state.preferences = { showSupport: preferences.showSupport, maskExampleAnswer: preferences.maskExampleAnswer !== false, updatedAt: Number(preferences.updatedAt || 0), revision: Number(preferences.revision || 0) };
    }
    return state;
  }
  function distance(newer, older) {
    if (!newer?.stream || newer.stream !== older?.stream || !Number.isSafeInteger(newer.position)
      || !Number.isSafeInteger(older.position) || newer.position <= older.position) return null;
    return newer.position - older.position;
  }
  function history(events, current) {
    const sorted = [...(events || [])].reverse().sort((a, b) => b.at - a.at);
    return sorted.map((event, index) => ({ ...event,
      distance: distance(index ? sorted[index - 1].trace : current, event.trace) }));
  }
  function meaningKey(sense) {
    const definitions = [...new Set(sense?.definitionIds || [])].sort();
    return definitions.length ? `defs:${definitions.join('|')}@group:${sense?.catalogGroupId || sense?.id || ''}` : `group:${sense?.catalogGroupId || sense?.id || ''}`;
  }
  function recall(previous, assessment, at, operationId) {
    if (!Array.isArray(assessment?.assessed) || !Array.isArray(assessment.remembered)) return previous;
    const remembered = new Set(assessment.remembered), next = { ...(previous || {}) };
    for (const key of assessment.assessed.slice(0, 100)) {
      if (typeof key !== 'string' || !key || key.length > 6000) continue;
      next[key] = { remembered: remembered.has(key), at, operationId };
    }
    return next;
  }
  const SKIP_MS = 10 * 60_000;
  function skipSchedule(schedule, operation) {
    const at = Number(operation.skippedAt);
    if (!operation.id || !Number.isFinite(at) || at <= 0) throw new Error('Invalid skip operation');
    return { ...(schedule || { version: 1 }), queue: { ...(schedule?.queue || {}),
      skip: { operationId: operation.id, at, until: at + SKIP_MS } } };
  }
  function undoSkipSchedule(schedule, before, operationId) {
    if (schedule?.queue?.skip?.operationId !== operationId) throw new Error('Слово уже изменилось после пропуска.');
    const queue = { ...schedule.queue };
    if (before?.queue?.skip) queue.skip = before.queue.skip; else delete queue.skip;
    return { ...schedule, queue };
  }
  return { normalize, reduce, mergePreferences, distance, history, meaningKey, recall, SKIP_MS, skipSchedule, undoSkipSchedule };
});
