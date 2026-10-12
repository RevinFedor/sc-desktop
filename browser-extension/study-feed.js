(function (root, factory) {
  const api = factory(root.__scStudyModel || (typeof require === 'function' ? require('./study-model') : null),
    root.__scReviewScheduler || (typeof require === 'function' ? require('./review-scheduler') : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.__scStudyFeed = api;
})(typeof window !== 'undefined' ? window : globalThis, function (Model, Scheduler) {
  'use strict';
  const MINUTE = 60_000, HORIZON = 20 * MINUTE, TRIALS = 32;
  const at = value => typeof value === 'number' ? value : Date.parse(value) || 0;
  const recent = entry => (entry.reviewSchedule?.queue?.recent || []).filter(event => event.id && event.at > 0);
  function cohort(entry, now) {
    return entry.reviewSchedule?.queue?.cohort || (!entry.reviewCount ? 'new'
      : at(entry.lastReviewedAt) < now - 7 * 86_400_000 && at(entry.dueAt) < now - 7 * 86_400_000 ? 'backlog' : 'active');
  }
  function profile(entries, now = Date.now()) {
    if (!Number.isFinite(now)) now = Date.now();
    const events = [...new Map(entries.flatMap(recent).map(event => [event.id, event])).values()]
      .sort((a, b) => a.at - b.at).slice(-96);
    let duration = 20_000, introduction = 20_000, repeat = 20_000, repeats = 0, introductions = 0;
    let probabilities = [0.5, 0.25, 0.25];
    for (const event of events) {
      if (event.durationMs > 0) {
        const ms = Math.max(1_000, Math.min(3_600_000, event.durationMs));
        duration += .2 * (ms - duration);
        if (event.introduction) { introduction += .2 * (ms - introduction); introductions++; }
        else { repeat += .2 * (ms - repeat); repeats++; }
      }
      if (event.result === 'partial' && ![1, 2].includes(event.recallVersion)) continue;
      const grade = event.result === 'forgotten' ? 0 : event.result === 'partial' ? 1 : 2;
      probabilities = probabilities.map((p, index) => .8 * p + .2 * Number(index === grade));
    }
    const confidence = events.length ? 2 ** (-Math.max(0, now - events.at(-1).at) / 86_400_000) : 0;
    const blend = ms => 20_000 + confidence * (ms - 20_000);
    return { introductionMs: blend(introductions ? introduction : duration),
      repeatMs: blend(repeats ? repeat : duration),
      probabilities: probabilities.map((p, i) => [0.5, .25, .25][i] * (1 - confidence) + p * confidence) };
  }
  function progress(entries, now = Date.now()) {
    return entries.filter(entry => entry.state === 'saved' && cohort(entry, now) === 'active')
      .map(entry => ({ ...entry, recent: recent(entry).sort((a, b) => a.at - b.at),
        waitingForSync: entry.reviewSchedule?.pending === true }))
      .sort((a, b) => at(a.dueAt) - at(b.dueAt) || a.key.localeCompare(b.key));
  }
  function forecast(active, candidate, measured, now) {
    const nextDue = Math.min(...active.map(entry => Model.availableAt(entry, now)).filter(due => due > now));
    if (nextDue - now < measured.introductionMs) return { allowed: false, reason: 'imminent' };
    if (active.some(entry => entry.reviewSchedule?.pending)) return { allowed: false, reason: 'sync' };
    const relevant = active.filter(entry => Model.availableAt(entry, now) <= now + HORIZON);
    if ([...relevant, candidate].some(entry => !entry.reviewSchedule?.card || !entry.reviewSchedule?.parameters)) {
      // Legacy online clients can admit a probe, then use the server's returned
      // schedule. Unknown active obligations must not count as free capacity.
      return { allowed: active.length === 0, reason: 'schedule' };
    }
    // A long reading episode must not lock an otherwise empty lesson until
    // tomorrow just because one predicted attempt exceeds the forecast window.
    // One probe creates a real obligation; subsequent admission sees that due.
    if (!relevant.length) return { allowed: true, reason: 'probe' };
    const engines = new Map();
    function engine(schedule) {
      const key = JSON.stringify(schedule.parameters);
      if (!engines.has(key)) engines.set(key, Scheduler.predictor(schedule.parameters));
      return engines.get(key);
    }
    const work = [], extraLateness = [];
    try {
      for (let trial = 0; trial < TRIALS; trial++) {
        const taskFor = entry => {
          let seed = 7919 + trial * 104729;
          for (const char of entry.key) seed = (Math.imul(seed, 31) + char.charCodeAt(0)) >>> 0;
          return { card: { ...entry.reviewSchedule.card }, schedule: entry.reviewSchedule, due: Model.availableAt(entry, now),
            grade() {
              seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
              const r = seed / 4294967296;
              return r < measured.probabilities[0] ? 'forgotten'
                : r < measured.probabilities[0] + measured.probabilities[1] ? 'partial' : 'remembered';
            } };
        };
        function simulate(includeCandidate) {
          const tasks = relevant.map(taskFor);
          let clock = now, busy = 0, lag = 0;
          if (includeCandidate) {
            const task = taskFor(candidate);
            clock += measured.introductionMs; busy += measured.introductionMs;
            task.card = engine(task.schedule)(task.card, clock, task.grade());
            task.due = at(task.card.due); tasks.push(task);
          }
          while (clock < now + HORIZON) {
            tasks.sort((a, b) => a.due - b.due);
            const task = tasks[0];
            if (!task || task.due > now + HORIZON) break;
            const start = Math.max(clock, task.due);
            lag = Math.max(lag, start - task.due);
            clock = start + measured.repeatMs; busy += measured.repeatMs;
            task.card = engine(task.schedule)(task.card, clock, task.grade());
            task.due = at(task.card.due);
            if (busy > HORIZON * .8) break;
          }
          const unfinished = tasks.filter(task => task.due <= now + HORIZON && task.due < clock);
          busy += unfinished.length * measured.repeatMs;
          for (const task of unfinished) lag = Math.max(lag, clock - task.due);
          return { busy, lag };
        }
        const baseline = simulate(false), admitted = simulate(true);
        work.push(admitted.busy);
        // Existing clustered deadlines must not create a ten-minute idle lock
        // when this candidate would not worsen them. Use coupled per-word
        // outcomes to compare the marginal delay, not two unrelated lotteries.
        extraLateness.push(Math.max(0, admitted.lag - baseline.lag));
      }
    } catch { return { allowed: false, reason: 'schedule' }; }
    work.sort((a, b) => a - b); extraLateness.sort((a, b) => a - b);
    const p = Math.ceil(.9 * TRIALS) - 1;
    return { allowed: work[p] <= HORIZON * .8 && extraLateness[p] <= measured.repeatMs,
      reason: 'load', workMs: work[p], extraLatenessMs: extraLateness[p] };
  }

  function plan(entries, now = Date.now()) {
    const saved = entries.filter(entry => entry.state === 'saved');
    const active = saved.filter(entry => cohort(entry, now) === 'active');
    const ordered = Model.buildRound(saved.filter(entry => !entry.reviewSchedule?.pending), {}, '', now);
    const byKey = new Map(saved.map(entry => [entry.key, entry]));
    const due = ordered.filter(key => cohort(byKey.get(key), now) === 'active');
    const nextDue = Math.min(...saved.filter(entry => !entry.reviewSchedule?.pending)
      .map(entry => Model.availableAt(entry, now)).filter(time => time > now));
    if (due.length) return { keys: due, reason: 'review', nextDue };
    const reserve = ordered.filter(key => cohort(byKey.get(key), now) !== 'active');
    const newest = [...active].filter(entry => entry.reviewSchedule?.queue?.introducedFrom)
      .sort((a, b) => (b.reviewSchedule.queue.introducedAt || 0) - (a.reviewSchedule.queue.introducedAt || 0))[0];
    const prefer = newest?.reviewSchedule.queue.introducedFrom === 'backlog' ? 'new' : 'backlog';
    const key = reserve.find(key => cohort(byKey.get(key), now) === prefer) || reserve[0];
    if (!key) return { keys: [], reason: active.some(entry => entry.reviewSchedule?.pending) ? 'sync' : 'waiting', nextDue };
    const measured = profile(saved, now);
    const result = forecast(active, byKey.get(key), measured, now);
    return { keys: result.allowed ? [key] : [], ...result, nextDue, reserveCount: reserve.length };
  }
  return { plan, profile, progress, forecast, cohort };
});
