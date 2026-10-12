(function (root, factory) {
  const api = factory(root.FSRS || (typeof require === 'function' ? require('./vendor/ts-fsrs-5.4.1.js') : null),
    root.__scStudyState || (typeof require === 'function' ? require('./study-state.js') : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.__scReviewScheduler = api;
})(typeof self !== 'undefined' ? self : globalThis, function (FSRS, StudyState) {
  'use strict';

  // This is an offline projection of Voice's state and parameters, not a second
  // authoritative schedule. Sync replays the actual answer times on Voice.
  function project(schedule, result, reviewedAt, observation) {
    if (!FSRS || schedule?.version !== 1 || !schedule.card || !schedule.parameters) return null;
    const rating = { forgotten: FSRS.Rating.Again, partial: FSRS.Rating.Hard,
      remembered: FSRS.Rating.Good, known: FSRS.Rating.Easy }[result];
    if (!rating) return null;
    const previousAt = schedule.card.last_review ? new Date(schedule.card.last_review).getTime() : -1;
    const at = new Date(Math.max(Number(reviewedAt), previousAt + 1));
    if (!Number.isFinite(at.getTime())) return null;
    const next = FSRS.fsrs(schedule.parameters).next(schedule.card, at, rating).card;
    const queue = record(schedule.queue, result, reviewedAt, observation);
    const { pending, ...settled } = schedule;
    return { ...settled, card: JSON.parse(JSON.stringify(next)), queue };
  }

  function record(previous, result, at, observation) {
    const queue = previous?.cohort === 'active' ? { ...previous }
      : { ...(previous || {}), version: 1, cohort: 'active', introducedAt: Number(at), introducedFrom: previous?.cohort === 'backlog' ? 'backlog' : 'new' };
    if (queue.skip && queue.skip.at <= Number(at)) delete queue.skip;
    if (!observation?.id) return queue;
    const durationMs = Number(observation.durationMs);
    const recent = (queue.recent || []).filter(item => item.id !== observation.id);
    recent.push({ id: observation.id, result, at: Number(at),
      ...([1, 2].includes(observation.recallVersion) ? { recallVersion: observation.recallVersion } : {}),
      ...(observation.trace ? { trace: observation.trace } : {}),
      ...(observation.meaningRecall ? { rememberedMeanings: [...new Set(observation.meaningRecall.remembered || [])].length } : {}),
      durationMs: durationMs > 0 && Number.isFinite(durationMs) ? Math.min(3_600_000, durationMs) : null,
      introduction: previous?.cohort !== 'active' });
    queue.recent = recent.slice(-12);
    if (result === 'remembered' || result === 'forgotten') queue.meaningRecall = {};
    else if (observation.meaningRecall && StudyState) queue.meaningRecall = StudyState.recall(queue.meaningRecall, observation.meaningRecall, at, observation.id);
    return queue;
  }

  // Forecast callers operate on copies; never write these hypothetical cards.
  function predictor(parameters) {
    if (!FSRS || !parameters) return null;
    const engine = FSRS.fsrs({ ...parameters, enable_fuzz: false });
    return (card, at, result) => engine.next(card, new Date(at),
      { forgotten: FSRS.Rating.Again, partial: FSRS.Rating.Hard, remembered: FSRS.Rating.Good }[result]).card;
  }

  return { project, record, predictor };
});
