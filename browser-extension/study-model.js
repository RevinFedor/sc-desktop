(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.__scStudyModel = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function timestamp(value, fallback = 0) {
    const parsed = typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function isDue(entry, currentTime = Date.now()) {
    if (!entry || entry.state !== 'saved') return false;
    if (Number(entry.reviewCount || 0) === 0) return true;
    const dueAt = timestamp(entry.dueAt, 0);
    return !dueAt || dueAt <= currentTime;
  }

  function reviewMode(entry, currentTime = Date.now()) {
    return isDue(entry, currentTime) ? 'scheduled' : 'practice';
  }

  function errorWeight(entry, session = {}) {
    const sessionForgotten = Number(session.forgotten || 0);
    const sessionRemembered = Number(session.remembered || 0);
    const forgotten = Number(entry?.forgottenCount || 0) + Number(entry?.practiceForgottenCount || 0);
    const remembered = Number(entry?.rememberedCount || 0) + Number(entry?.practiceRememberedCount || 0);
    const historyTotal = forgotten + remembered;
    const historyRatio = historyTotal ? forgotten / historyTotal : 0;
    return {
      lastForgotten: session.lastResult === 'forgotten' ? 1 : 0,
      sessionRatio: (sessionForgotten + sessionRemembered)
        ? sessionForgotten / (sessionForgotten + sessionRemembered)
        : 0,
      sessionForgotten,
      historyRatio,
      attempts: Number(session.total || 0),
    };
  }

  function compareEntries(a, b, sessionStats, currentTime) {
    const aStats = errorWeight(a, sessionStats?.[a.key]);
    const bStats = errorWeight(b, sessionStats?.[b.key]);
    if (aStats.lastForgotten !== bStats.lastForgotten) return bStats.lastForgotten - aStats.lastForgotten;
    if (aStats.sessionRatio !== bStats.sessionRatio) return bStats.sessionRatio - aStats.sessionRatio;
    if (aStats.sessionForgotten !== bStats.sessionForgotten) return bStats.sessionForgotten - aStats.sessionForgotten;
    const aDue = isDue(a, currentTime) ? 1 : 0;
    const bDue = isDue(b, currentTime) ? 1 : 0;
    if (aDue !== bDue) return bDue - aDue;
    if (aStats.historyRatio !== bStats.historyRatio) return bStats.historyRatio - aStats.historyRatio;
    if (aStats.attempts !== bStats.attempts) return aStats.attempts - bStats.attempts;
    const aLast = Math.max(timestamp(a?.lastPracticedAt), timestamp(a?.lastReviewedAt));
    const bLast = Math.max(timestamp(b?.lastPracticedAt), timestamp(b?.lastReviewedAt));
    if (aLast !== bLast) return aLast - bLast;
    return String(a?.sourceText || '').localeCompare(String(b?.sourceText || ''));
  }

  function buildRound(entries, sessionStats = {}, previousKey = '', currentTime = Date.now()) {
    const round = (entries || [])
      .filter((entry) => entry?.state === 'saved' && entry?.key)
      .slice()
      .sort((a, b) => compareEntries(a, b, sessionStats, currentTime));
    if (round.length > 1 && previousKey && round[0].key === previousKey) {
      round.push(round.shift());
    }
    return round.map((entry) => entry.key);
  }

  function swipeResult(deltaX, threshold = 96) {
    const distance = Number(deltaX) || 0;
    const limit = Math.max(24, Number(threshold) || 96);
    if (distance <= -limit) return 'forgotten';
    if (distance >= limit) return 'remembered';
    return null;
  }

  function nextSessionStats(current, key, result) {
    const previous = current?.[key] || { remembered: 0, forgotten: 0, total: 0, lastResult: '' };
    return {
      ...(current || {}),
      [key]: {
        remembered: Number(previous.remembered || 0) + (result === 'remembered' ? 1 : 0),
        forgotten: Number(previous.forgotten || 0) + (result === 'forgotten' ? 1 : 0),
        total: Number(previous.total || 0) + 1,
        lastResult: result,
      },
    };
  }

  return { isDue, reviewMode, buildRound, swipeResult, nextSessionStats, errorWeight };
});
