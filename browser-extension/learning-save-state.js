// Shared UI observer for the canonical Voice Record save operation. A view
// subscribes to progress; it never owns or cancels the server's preparation.
(function (root, create) {
  if (root) root.__scCreateVocabularySaveObserver = create;
  if (typeof module === 'object' && module.exports) module.exports = create;
})(typeof self !== 'undefined' ? self : globalThis, function createVocabularySaveObserver(request) {
  const keyFor = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');
  const states = new Map(), localJobs = new Map(), listeners = new Set();
  let timer = null, refreshJob = null;
  const pending = state => state?.phase === 'preparing' || state?.phase === 'saving';
  const emit = () => { for (const listener of listeners) { try { listener(); } catch {} } };
  const set = (key, state) => { states.set(key, state); emit(); };
  async function refresh() {
    if (refreshJob) return refreshJob;
    refreshJob = (async () => {
      const observed = new Map(states);
      const result = await request({ action: 'save-status', terms: Array.from(observed, ([key, state]) => pending(state) ? key : null).filter(Boolean) });
      if (result?.ok === false) throw new Error(result.error || 'Статус словаря недоступен');
      let changed = false;
      const reported = new Set();
      for (const operation of result?.operations || []) {
        const key = keyFor(operation.key || operation.term);
        reported.add(key);
        // A previous completed server job must not hide a newly clicked Save
        // whose HTTP request has not reached the server yet.
        if (localJobs.has(key)) continue;
        if (states.get(key) !== observed.get(key)) continue;
        if (JSON.stringify(states.get(key)) !== JSON.stringify(operation)) {
          states.set(key, operation); changed = true;
        }
      }
      for (const [key, previous] of observed) {
        if (!pending(previous) || reported.has(key) || localJobs.has(key) || states.get(key) !== previous) continue;
        if (!Object.prototype.hasOwnProperty.call(result?.settled || {}, key)) continue;
        const item = result.settled[key];
        // A vanished operation is not proof of a successful Save. Reconcile
        // the current record (which may now be archived) instead of replaying it.
        states.set(key, { key, term: previous.term, phase: item ? 'reconciled' : 'error', itemId: item?.itemId,
          generation: result.generation, updatedAt: Date.now(),
          ...(!item ? { error: 'Добавление прервалось. Повторите попытку.' } : {}) });
        changed = true;
      }
      if (changed) emit();
      return result;
    })();
    try { return await refreshJob; } finally { refreshJob = null; }
  }
  function schedule() {
    clearTimeout(timer);
    if (!listeners.size) return;
    timer = setTimeout(async () => {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
        try { await refresh(); } catch {} // The actual Save retains its error.
      }
      schedule();
    }, 1500);
    timer?.unref?.();
  }
  function save(payload) {
    const key = keyFor(payload.word || payload.term);
    if (localJobs.has(key)) return localJobs.get(key);
    set(key, { key, term: payload.word || payload.term, observedForms: payload.observedForms || [], phase: 'preparing', startedAt: Date.now() });
    const job = Promise.resolve().then(async () => {
      try {
        const result = await request({ ...payload, action: 'save' });
        if (!result?.ok || !result.item) throw new Error(result?.error || 'Не удалось сохранить слово');
        set(key, { key, term: result.item.term || payload.word, lemma: result.item.lemma,
          observedForms: result.item.observedForms || payload.observedForms || [], phase: 'ready', itemId: result.item.id, updatedAt: Date.now() });
        return result;
      } catch (error) {
        set(key, { key, term: payload.word || payload.term, phase: 'error', error: error.message, updatedAt: Date.now() });
        throw error;
      } finally { localJobs.delete(key); }
    });
    localJobs.set(key, job);
    return job;
  }
  return {
    keyFor, pending, save, refresh,
    get: (...words) => {
      const keys = new Set(words.map(keyFor).filter(Boolean));
      const matches = Array.from(states.values()).filter(state => [state.key, state.term, state.lemma, ...(state.observedForms || [])]
        .some(value => keys.has(keyFor(value))));
      return matches.find(pending) || matches.sort((a, b) => (b.updatedAt || b.startedAt || 0) - (a.updatedAt || a.startedAt || 0))[0] || null;
    },
    all: () => Array.from(states.values()),
    subscribe(listener) {
      listeners.add(listener); listener();
      void refresh().catch(() => {}); schedule();
      return () => { listeners.delete(listener); if (!listeners.size) clearTimeout(timer); };
    },
  };
});
