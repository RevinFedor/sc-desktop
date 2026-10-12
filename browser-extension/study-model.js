(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.__scStudyModel = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const SWIPE_THRESHOLD = 56;
  const REVIEW_UNIT_SEPARATOR = '::sense::';
  const MAX_CORE_SENSES = 5;

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

  function availableAt(entry, currentTime = Date.now()) {
    const until = Number(entry?.reviewSchedule?.queue?.skip?.until);
    const due = Number(entry?.reviewCount || 0) ? timestamp(entry?.dueAt, 0) : 0;
    return Math.max(due, Number.isFinite(until) && until > currentTime ? until : 0);
  }
  function isAvailable(entry, currentTime = Date.now()) {
    return isDue(entry, currentTime) && availableAt(entry, currentTime) <= currentTime;
  }

  function reviewUnitKey(entryKey) {
    return String(entryKey || '');
  }

  function meaningParts(value) {
    const parts = [];
    let current = '';
    let depth = 0;
    for (const char of String(value || '')) {
      if (char === '(' || char === '[') depth += 1;
      if (char === ')' || char === ']') depth = Math.max(0, depth - 1);
      if (depth === 0 && (char === ',' || char === '/' || char === ';')) {
        if (current.trim()) parts.push(current.trim());
        current = '';
      } else current += char;
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
  }

  function displaySenseMeaning(meaning) {
    // Slashes in saved sense labels are legacy synonym separators, not IDs.
    return meaningParts(meaning).join(', ');
  }

  function alternativeValues(value) {
    const source = Array.isArray(value) ? value : value == null ? [] : [value];
    return source.flatMap((item) => {
      const text = typeof item === 'object' && item ? item.value || item.text || item.meaning : item;
      return meaningParts(text);
    });
  }

  function sensePresentation(raw = {}) {
    const fullMeaning = displaySenseMeaning(raw.meaning);
    const parts = meaningParts(raw.meaning);
    const shortMeaning = String(raw.shortMeaning || '').trim() || parts[0] || 'Перевод';
    const seen = new Set([shortMeaning.toLocaleLowerCase('ru-RU')]);
    const alternatives = [];
    for (const candidate of [...parts, ...alternativeValues(raw.alternatives)]) {
      const normalized = String(candidate || '').trim();
      const key = normalized.toLocaleLowerCase('ru-RU');
      if (!normalized || seen.has(key)) continue;
      seen.add(key);
      alternatives.push(normalized);
    }
    return { shortMeaning, alternatives, meaning: fullMeaning || shortMeaning };
  }

  function coreSenseRecords(entry, rawSenses) {
    const requested = Array.isArray(entry?.senseCatalog?.coreSenses)
      ? entry.senseCatalog.coreSenses : [];
    if (!requested.length) {
      const explicitlyCore = rawSenses.filter((sense) => sense?.core === true || sense?.isCore === true);
      return (explicitlyCore.length ? explicitlyCore : rawSenses).slice(0, MAX_CORE_SENSES);
    }
    const byIdentity = new Map();
    for (const sense of rawSenses) {
      for (const id of [sense?.id, sense?.senseId, sense?.catalogGroupId]) {
        if (id) byIdentity.set(String(id), sense);
      }
    }
    return requested.map((requestedSense) => {
      if (typeof requestedSense === 'string') return byIdentity.get(requestedSense) || null;
      if (!requestedSense || typeof requestedSense !== 'object') return null;
      const id = requestedSense.senseId || requestedSense.id || requestedSense.catalogGroupId;
      const saved = id ? byIdentity.get(String(id)) : null;
      return saved ? { ...saved, ...requestedSense, id: saved.id || requestedSense.id } : requestedSense;
    }).filter(Boolean).slice(0, MAX_CORE_SENSES);
  }

  function exampleTranslation(context, translated) {
    const saved = String(context?.translation || '');
    const machine = String(translated?.translated_text || '');
    const targetText = context?.origin === 'dictionary' ? saved : machine || saved;
    // Alignment offsets belong to a particular translation. Applying offsets
    // from a loose machine paraphrase to a verified sentence highlights the wrong words.
    const alignment = machine && machine === targetText ? translated?.alignment || '' : '';
    return { targetText, alignment };
  }

  function selectSenseExample(entry, sense) {
    if (!sense) return null;
    if (sense.example && typeof sense.example === 'object' && String(sense.example.sourceText || '').trim()) {
      return sense.example;
    }
    if (typeof sense.example === 'string' && sense.example.trim()) {
      return {
        id: `inline:${String(sense.id || '')}`,
        senseId: String(sense.id || ''),
        meaning: sense.meaning || '',
        partOfSpeech: sense.partOfSpeech || 'unknown',
        sourceText: sense.example.trim(),
        translation: String(sense.exampleTranslation || '').trim(),
        origin: 'dictionary',
      };
    }
    const contexts = (entry?.contexts || []).filter((context) => String(context?.sourceText || '').trim());
    const id = String(sense.id || '');
    const contextIds = new Set(sense.contextIds || []);
    const linked = contexts.filter((context) => {
      // An explicit owner wins over stale contextIds and coincidentally equal translations.
      if (context.senseId) return String(context.senseId) === id;
      return contextIds.has(context.id)
        && !(entry?.senses || []).some((other) => String(other.id || '') !== id && other.contextIds?.includes(context.id));
    });
    if (linked.length) return linked.find((context) => context.origin === 'dictionary') || linked[0];

    // Old records can associate an example by its complete meaning label. Never
    // borrow an unlabelled sentence or one already assigned to another sense.
    const meaningKey = displaySenseMeaning(sense.meaning).toLocaleLowerCase('ru-RU');
    if (!meaningKey) return null;
    const sameMeaning = (entry?.senses || []).filter((item) =>
      displaySenseMeaning(item?.meaning).toLocaleLowerCase('ru-RU') === meaningKey);
    if (sameMeaning.length > 1) return null;
    const byMeaning = contexts.filter((context) => !context.senseId
      && !(entry?.senses || []).some((other) => String(other.id || '') !== id && other.contextIds?.includes(context.id))
      && displaySenseMeaning(context.meaning).toLocaleLowerCase('ru-RU') === meaningKey);
    return byMeaning.find((context) => context.origin === 'dictionary') || byMeaning[0] || null;
  }

  function buildSenseOverview(entry, activeSenseId = '') {
    if (!entry) return { senses: [], activeSense: null, translation: '' };
    const rawSenses = Array.isArray(entry.senses) && entry.senses.length
      ? entry.senses
      : [{ id: 'default', meaning: entry.translation || '', partOfSpeech: entry.partOfSpeech || 'unknown' }];
    const seen = new Set();
    const senses = [];
    coreSenseRecords(entry, rawSenses).forEach((raw, index) => {
      const id = String(raw?.id || `default-${index}`);
      // Distinct IDs can share a Russian label. Display must not merge their
      // knowledge units or hide meanings just because their wording is alike.
      if (seen.has(id)) return;
      seen.add(id);
      const sense = { ...raw, id };
      const presentation = sensePresentation(sense);
      senses.push({
        id,
        catalogGroupId: sense.catalogGroupId || id,
        definitionIds: sense.definitionIds || entry.senseCatalog?.groups?.find(group => group.id === sense.catalogGroupId)?.definitionIds || [],
        meaning: presentation.meaning,
        shortMeaning: presentation.shortMeaning,
        alternatives: presentation.alternatives,
        headwordChoice: sense.headwordChoice?.term ? {
          term: String(sense.headwordChoice.term),
          nuance: String(sense.headwordChoice.nuance || ''),
        } : null,
        englishAlternatives: (Array.isArray(sense.englishAlternatives) ? sense.englishAlternatives : [])
          .filter(value => value?.term && String(value.term).toLocaleLowerCase('en-US') !== String(entry.sourceText || entry.lemma || '').toLocaleLowerCase('en-US'))
          .map(value => ({ term: String(value.term), nuance: String(value.nuance || '') })),
        partOfSpeech: sense.partOfSpeech || 'unknown',
        active: id === String(activeSenseId),
        example: selectSenseExample(entry, sense),
      });
    });
    const support = (entry.senseCatalog?.supportGroups || []).map(group => {
      const currentTerm = String(group.focusEn || entry.sourceText || entry.lemma || '').trim();
      const activeEquivalent = group.activeEquivalent?.en ? {
        term: String(group.activeEquivalent.en), nuance: String(group.activeEquivalent.ru || ''),
      } : null;
      return {
        id: group.id, definitionIds: group.definitionIds || [], parentCoreId: group.parentCoreId, relation: group.relation, support: true,
        shortMeaning: group.shortMeaning, meaning: group.shortMeaning, alternatives: [],
        description: String(group.reason || ''),
        headwordChoice: currentTerm ? { term: currentTerm, nuance: '' } : null,
        englishAlternatives: activeEquivalent && activeEquivalent.term.toLocaleLowerCase('en-US') !== currentTerm.toLocaleLowerCase('en-US')
          ? [activeEquivalent] : [],
        example: { sourceText: group.example, translation: group.exampleTranslation,
          focusEn: group.focusEn, focusRu: group.focusRu, origin: 'dictionary' },
      };
    });
    return {
      senses,
      support,
      activeSense: senses.find((sense) => sense.active) || null,
      translation: senses.map((sense) => sense.shortMeaning).join(' / '),
    };
  }

  function cardDebugText(entry) {
    const word = String(entry?.sourceText || entry?.lemma || '').trim();
    if (!word) return '';
    const { senses, support = [] } = buildSenseOverview(entry);
    const lines = [word];
    if (senses.length) {
      const meanings = senses.map((sense) => [sense.shortMeaning, ...sense.alternatives].join(', '));
      lines.push('', `Переводы: ${meanings.join(' / ')}${support.length
        ? ` | ${support.map((sense) => sense.shortMeaning).join(' / ')}` : ''}`);
    } else if (String(entry?.translation || '').trim()) {
      lines.push('', `Переводы: ${String(entry.translation).trim()}`);
    }
    senses.forEach((sense, index) => {
      lines.push('', `${index + 1}. ${[sense.shortMeaning, ...sense.alternatives].join(', ')}`);
      if (sense.example?.sourceText) {
        lines.push(`EN: ${String(sense.example.sourceText).trim()}`);
        lines.push(`RU: ${String(sense.example.translation || '').trim() || '—'}`);
      }
      const englishChoices = [sense.headwordChoice, ...sense.englishAlternatives].filter(Boolean);
      if (englishChoices.length) {
        lines.push(`Английские варианты: ${englishChoices
          .map((value) => `${value.term}${value.nuance ? ` (${value.nuance})` : ''}`)
          .join(' · ')}`);
      }
    });
    if (support.length) lines.push('', '—');
    support.forEach((sense, index) => {
      lines.push('', `${senses.length + index + 1}. ${sense.shortMeaning}`,
        `EN: ${sense.example.sourceText}`, `RU: ${sense.example.translation}`);
    });
    return lines.join('\n').trim();
  }

  function cardGestureAxis(deltaX, deltaY, canScrollY = false) {
    const x = Math.abs(Number(deltaX) || 0);
    const y = Math.abs(Number(deltaY) || 0);
    if (Math.hypot(x, y) < 6) return null;
    if (y > x * 1.2) {
      if (canScrollY) return 'scroll';
      return deltaY > 0 ? 'partial' : 'vertical';
    }
    return x >= 4 ? 'swipe' : null;
  }

  function catalogueDisplayEntry(entry, catalogue) {
    if (!Array.isArray(catalogue?.groups) || !catalogue.groups.length) return entry;
    const contexts = [];
    const senses = catalogue.groups.map((group, index) => {
      const id = String(group.id || `catalogue-${index}`);
      const contextId = `catalogue:${id}`;
      if (String(group.example || '').trim()) contexts.push({
        id: contextId,
        senseId: id,
        meaning: group.meaning || '',
        partOfSpeech: group.partOfSpeech || 'unknown',
        sourceText: group.example,
        translation: group.exampleTranslation || '',
        focusEn: group.focusEn, focusRu: group.focusRu,
        origin: 'dictionary',
      });
      return {
        id,
        meaning: group.meaning || '',
        shortMeaning: group.shortMeaning || '',
        alternatives: group.alternatives || [],
        headwordChoice: group.headwordChoice || null,
        englishAlternatives: group.englishAlternatives || [],
        core: group.core,
        isCore: group.isCore,
        catalogGroupId: group.id || '',
        definitionIds: group.definitionIds || [],
        partOfSpeech: group.partOfSpeech || 'unknown',
        contextIds: [contextId],
      };
    });
    // A view of the catalogue, not a rewrite of the saved review schedules or
    // the original dialogue context. Missing groups in compact metadata aren't an empty catalogue.
    const canonicalSources = new Set(contexts.map(context => context.sourceText));
    const observed = (entry?.contexts || []).filter(context => context.origin !== 'dictionary'
      && context.sourceText && !canonicalSources.has(context.sourceText));
    return { ...entry, senses, contexts: [...contexts, ...observed], senseCatalog: catalogue };
  }

  function buildReviewUnits(entries) {
    const units = [];
    for (const entry of entries || []) {
      if (entry?.state !== 'saved' || !entry?.key) continue;
      units.push({
        key: reviewUnitKey(entry.key),
        entryKey: entry.key,
        senseId: '',
        sourceText: entry.sourceText || '',
        createdAt: entry.createdAt,
        dueAt: entry.dueAt,
        reviewSchedule: entry.reviewSchedule || null,
        lastReviewedAt: entry.lastReviewedAt,
        lastPracticedAt: entry.lastPracticedAt,
        reviewCount: Number(entry.reviewCount || 0),
        rememberedCount: Number(entry.rememberedCount || 0),
        forgottenCount: Number(entry.forgottenCount || 0),
        partialCount: Number(entry.partialCount || 0),
        practiceCount: Number(entry.practiceCount || 0),
        practiceRememberedCount: Number(entry.practiceRememberedCount || 0),
        practiceForgottenCount: Number(entry.practiceForgottenCount || 0),
        practicePartialCount: Number(entry.practicePartialCount || 0),
      });
    }
    return units;
  }

  function reviewMode(entry, currentTime = Date.now()) {
    return isDue(entry, currentTime) ? 'scheduled' : 'practice';
  }

  function errorWeight(entry, session = {}) {
    const sessionForgotten = Number(session.forgotten || 0);
    const sessionRemembered = Number(session.remembered || 0);
    const sessionPartial = Number(session.partial || 0);
    const forgotten = Number(entry?.forgottenCount || 0) + Number(entry?.practiceForgottenCount || 0);
    const remembered = Number(entry?.rememberedCount || 0) + Number(entry?.practiceRememberedCount || 0);
    const partial = Number(entry?.partialCount || 0) + Number(entry?.practicePartialCount || 0);
    const historyTotal = forgotten + remembered + partial;
    const historyRatio = historyTotal ? (forgotten + partial * .5) / historyTotal : 0;
    return {
      lastForgotten: session.lastResult === 'forgotten' ? 1 : session.lastResult === 'partial' ? .5 : 0,
      sessionRatio: (sessionForgotten + sessionRemembered + sessionPartial)
        ? (sessionForgotten + sessionPartial * .5) / (sessionForgotten + sessionRemembered + sessionPartial)
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

  function previousEntryKey(previousKey) {
    const separatorIndex = String(previousKey || '').indexOf(REVIEW_UNIT_SEPARATOR);
    return separatorIndex >= 0 ? String(previousKey).slice(0, separatorIndex) : '';
  }

  function reviewPriority(unit, currentTime = Date.now()) {
    if (!Number(unit.reviewCount || 0)) return 3;
    const cohort = unit.reviewSchedule?.queue?.cohort;
    // Old clients/snapshots are readable while they await their first sync.
    const old = !cohort && timestamp(unit.lastReviewedAt) < currentTime - 7 * 86_400_000
      && timestamp(unit.dueAt) < currentTime - 7 * 86_400_000;
    if (cohort === 'backlog' || old) return 2;
    const phase = Number(unit.reviewSchedule?.card?.state);
    // An unfinished ten-minute step from days ago is interday work, not a
    // current minute deadline. Otherwise a large learning backlog crowds out
    // the answer just made, even after removing the new-card interleaving.
    const recent = timestamp(unit.lastReviewedAt) >= currentTime - 86_400_000;
    const shortInterval = timestamp(unit.lastReviewedAt) > 0
      && timestamp(unit.dueAt) - timestamp(unit.lastReviewedAt) < 86_400_000;
    return recent && (phase === 1 || phase === 3 || (!unit.reviewSchedule && shortInterval)) ? 0 : 1;
  }

  function buildRound(entries, sessionStats = {}, previousKey = '', currentTime = Date.now()) {
    const round = buildReviewUnits(entries)
      .filter(unit => isAvailable({ ...unit, state: 'saved' }, currentTime))
      .sort((a, b) => reviewPriority(a, currentTime) - reviewPriority(b, currentTime)
        || (reviewPriority(a, currentTime) === 3
          ? timestamp(a.createdAt) - timestamp(b.createdAt)
          : timestamp(a.dueAt) - timestamp(b.dueAt))
        || String(a.key).localeCompare(String(b.key)));
    const previousEntry = previousEntryKey(previousKey) || String(previousKey || '');
    if (round.length > 1 && round[0].entryKey === previousEntry) {
      const replacement = round.findIndex((unit) => unit.entryKey !== previousEntry
        && reviewPriority(unit, currentTime) === reviewPriority(round[0], currentTime));
      if (replacement > 0) [round[0], round[replacement]] = [round[replacement], round[0]];
    }
    return round.map((entry) => entry.key);
  }

  function swipeResult(deltaX, threshold = SWIPE_THRESHOLD) {
    const distance = Number(deltaX) || 0;
    const limit = Math.max(24, Number(threshold) || SWIPE_THRESHOLD);
    if (distance <= -limit) return 'remembered';
    if (distance >= limit) return 'forgotten';
    return null;
  }

  function nextSessionStats(current, key, result, reviewedAt = Date.now()) {
    const previous = current?.[key] || { remembered: 0, forgotten: 0, total: 0, lastResult: '' };
    const successful = result === 'remembered' || result === 'known';
    return {
      ...(current || {}),
      [key]: {
        remembered: Number(previous.remembered || 0) + (successful ? 1 : 0),
        forgotten: Number(previous.forgotten || 0) + (result === 'forgotten' ? 1 : 0),
        partial: Number(previous.partial || 0) + (result === 'partial' ? 1 : 0),
        total: Number(previous.total || 0) + 1,
        lastResult: result,
        lastAt: reviewedAt,
      },
    };
  }

  // A nested word observes the parent's sentence, not the parent's dictionary
  // meaning. Carry provenance but never reuse its sense/catalogue IDs or focus.
  function observedWordContext(example, word, translation = example?.translation || '') {
    if (!example?.sourceText) return null;
    return {
      sourceText: example.sourceText, translation, surfaceForm: word,
      origin: example.videoId || example.origin === 'video' ? 'video' : 'manual',
      ...(example.videoId ? { videoId: example.videoId } : {}),
      ...(example.videoUrl ? { videoUrl: example.videoUrl } : {}),
      ...(example.videoTitle ? { videoTitle: example.videoTitle } : {}),
      ...(Number.isFinite(example.startMs) ? { startMs: example.startMs } : {}),
      ...(Number.isFinite(example.endMs) ? { endMs: example.endMs } : {}),
      ...(example.createdAt ? { createdAt: example.createdAt } : {}),
    };
  }

  return {
    SWIPE_THRESHOLD,
    REVIEW_UNIT_SEPARATOR,
    MAX_CORE_SENSES,
    isDue, availableAt, isAvailable,
    reviewMode,
    reviewUnitKey,
    meaningParts,
    displaySenseMeaning,
    sensePresentation,
    exampleTranslation,
    observedWordContext,
    selectSenseExample,
    buildSenseOverview,
    cardDebugText,
    cardGestureAxis,
    catalogueDisplayEntry,
    buildReviewUnits,
    buildRound,
    reviewPriority,
    swipeResult,
    nextSessionStats,
    errorWeight,
  };
});
