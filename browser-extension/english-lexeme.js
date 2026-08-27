(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.__scEnglishLexeme = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const POS_ALIASES = new Map([
    ['NOUN', 'noun'], ['N', 'noun'], ['SUBSTANTIVE', 'noun'],
    ['VERB', 'verb'], ['V', 'verb'], ['AUX', 'verb'], ['MODAL', 'verb'],
    ['ADJ', 'adjective'], ['ADJECTIVE', 'adjective'],
    ['ADV', 'adverb'], ['ADVERB', 'adverb'],
    ['PRON', 'pronoun'], ['PRONOUN', 'pronoun'],
    ['PREP', 'preposition'], ['PREPOSITION', 'preposition'],
    ['CONJ', 'conjunction'], ['CONJUNCTION', 'conjunction'],
    ['DET', 'determiner'], ['DETERMINER', 'determiner'],
    ['NUM', 'number'], ['NUMBER', 'number'],
    ['INTJ', 'interjection'], ['INTERJECTION', 'interjection'],
    ['PART', 'particle'], ['PARTICLE', 'particle'],
    ['OTHER', 'unknown'], ['UNKNOWN', 'unknown'],
  ]);

  const IRREGULAR_VERBS = new Map(Object.entries({
    am: 'be', is: 'be', are: 'be', was: 'be', were: 'be', been: 'be', being: 'be',
    became: 'become', begun: 'begin', began: 'begin', bent: 'bend', bet: 'bet',
    bit: 'bite', bitten: 'bite', blew: 'blow', blown: 'blow', broke: 'break', broken: 'break',
    brought: 'bring', built: 'build', bought: 'buy', caught: 'catch', chose: 'choose', chosen: 'choose',
    came: 'come', cost: 'cost', cut: 'cut', dealt: 'deal', did: 'do', done: 'do', drew: 'draw', drawn: 'draw',
    drank: 'drink', drunk: 'drink', drove: 'drive', driven: 'drive', ate: 'eat', eaten: 'eat',
    fell: 'fall', fallen: 'fall', fed: 'feed', felt: 'feel', fought: 'fight', found: 'find',
    flew: 'fly', flown: 'fly', forgot: 'forget', forgotten: 'forget', forgave: 'forgive', forgiven: 'forgive',
    froze: 'freeze', frozen: 'freeze', got: 'get', gotten: 'get', gave: 'give', given: 'give',
    went: 'go', gone: 'go', grew: 'grow', grown: 'grow', had: 'have', heard: 'hear', held: 'hold',
    kept: 'keep', knew: 'know', known: 'know', led: 'lead', left: 'leave', lent: 'lend',
    let: 'let', lay: 'lie', lain: 'lie', lost: 'lose', made: 'make', meant: 'mean', met: 'meet',
    paid: 'pay', put: 'put', read: 'read', rode: 'ride', ridden: 'ride', rang: 'ring', rung: 'ring',
    rose: 'rise', risen: 'rise', ran: 'run', said: 'say', saw: 'see', seen: 'see', sold: 'sell',
    sent: 'send', shook: 'shake', shaken: 'shake', shot: 'shoot', showed: 'show', shown: 'show',
    shut: 'shut', sang: 'sing', sung: 'sing', sank: 'sink', sunk: 'sink', sat: 'sit', slept: 'sleep',
    spoke: 'speak', spoken: 'speak', spent: 'spend', stood: 'stand', stole: 'steal', stolen: 'steal',
    swam: 'swim', swum: 'swim', took: 'take', taken: 'take', taught: 'teach', tore: 'tear', torn: 'tear',
    told: 'tell', thought: 'think', threw: 'throw', thrown: 'throw', understood: 'understand',
    woke: 'wake', woken: 'wake', wore: 'wear', worn: 'wear', won: 'win', wrote: 'write', written: 'write',
  }));

  const IRREGULAR_NOUNS = new Map(Object.entries({
    children: 'child', feet: 'foot', geese: 'goose', men: 'man', mice: 'mouse', people: 'person',
    teeth: 'tooth', women: 'woman', analyses: 'analysis', bases: 'basis', crises: 'crisis',
    diagnoses: 'diagnosis', hypotheses: 'hypothesis', indices: 'index', matrices: 'matrix',
    theses: 'thesis', vertices: 'vertex', lives: 'life', knives: 'knife', leaves: 'leaf',
    wives: 'wife', wolves: 'wolf', calves: 'calf', halves: 'half', shelves: 'shelf',
  }));

  const IRREGULAR_ADJECTIVES = new Map(Object.entries({
    better: 'good', best: 'good', worse: 'bad', worst: 'bad', farther: 'far', farthest: 'far',
    further: 'far', furthest: 'far', less: 'little', least: 'little',
  }));

  const SILENT_E_VERBS = new Set([
    'age', 'arrive', 'believe', 'breathe', 'care', 'cause', 'change', 'choose', 'close', 'come',
    'compare', 'complete', 'continue', 'create', 'dance', 'decide', 'describe', 'drive', 'encourage',
    'face', 'give', 'hate', 'have', 'hope', 'imagine', 'include', 'invite', 'like', 'live', 'lose',
    'love', 'make', 'manage', 'move', 'notice', 'place', 'prepare', 'provide', 'raise', 'receive',
    'reduce', 'remove', 'require', 'save', 'serve', 'share', 'smile', 'solve', 'take', 'use', 'write',
  ]);
  const SILENT_E_STEMS = new Map(Array.from(SILENT_E_VERBS, (word) => [word.slice(0, -1), word]));
  const DOUBLING_VERBS = new Set(['admit', 'begin', 'chat', 'commit', 'control', 'cut', 'drop', 'fit', 'get', 'hit', 'plan', 'prefer', 'put', 'run', 'set', 'sit', 'stop', 'swim', 'travel']);

  const NON_INFLECTED_ING = new Set([
    'bring', 'ceiling', 'cling', 'darling', 'during', 'evening', 'feeling', 'fling', 'king', 'morning',
    'nothing', 'offspring', 'ring', 'sing', 'something', 'spring', 'sting', 'string', 'swing', 'thing', 'wing', 'wring',
  ]);
  const NON_INFLECTED_ED = new Set(['bed', 'bleed', 'breed', 'feed', 'need', 'red', 'seed', 'speed']);
  const NON_INFLECTED_S = new Set([
    'analysis', 'basis', 'business', 'bus', 'class', 'cross', 'dress', 'glass', 'news', 'process',
    'series', 'species', 'status', 'this', 'thus', 'us', 'yes',
  ]);
  const ADJECTIVE_LY = new Set(['daily', 'early', 'elderly', 'friendly', 'lively', 'lonely', 'lovely', 'silly', 'ugly']);
  const ATTRIBUTIVE_ADJECTIVE_SUFFIX = /(?:ary|ory|al|ial|ical|ive|ous|ful|less|able|ible|ic|ish|ent|ant)$/;

  const AUXILIARIES = new Set([
    'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
    'can', 'could', 'may', 'might', 'must', 'shall', 'should', 'will', 'would',
  ]);
  const DETERMINERS = new Set([
    'a', 'an', 'the', 'this', 'that', 'these', 'those', 'my', 'your', 'his', 'her', 'its', 'our', 'their',
    'each', 'every', 'either', 'neither', 'some', 'any', 'no', 'many', 'few', 'several', 'both',
  ]);
  const PREPOSITIONS = new Set([
    'about', 'above', 'across', 'after', 'against', 'along', 'among', 'around', 'at', 'before', 'behind',
    'below', 'beneath', 'beside', 'between', 'beyond', 'by', 'despite', 'during', 'except', 'for', 'from',
    'in', 'inside', 'into', 'near', 'of', 'off', 'on', 'onto', 'out', 'outside', 'over', 'past', 'through',
    'to', 'toward', 'under', 'until', 'up', 'upon', 'with', 'within', 'without',
  ]);
  const SUBJECT_PRONOUNS = new Set(['i', 'you', 'he', 'she', 'it', 'we', 'they', 'who', 'that', 'this']);
  const UNAMBIGUOUS_SUBJECTS = new Set(['i', 'you', 'he', 'she', 'it', 'we', 'they', 'who']);
  const VERB_FOLLOWERS = new Set(['how', 'that', 'whether', 'what', 'when', 'where', 'which', 'who', 'whom', 'why', 'to']);

  function normalizeText(value, maxLength = 500) {
    return String(value == null ? '' : value)
      .normalize('NFKC')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxLength);
  }

  function normalizeWord(value) {
    return normalizeText(value)
      .replace(/[\u2010\u2011]/g, '-')
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}'’-]+$/gu, '')
      .replace(/[’]/g, "'")
      .toLocaleLowerCase('en-US');
  }

  function normalizePartOfSpeech(value) {
    const tag = normalizeText(value, 40).toUpperCase().replace(/[.\s-]+/g, '_');
    return POS_ALIASES.get(tag) || (['noun', 'verb', 'adjective', 'adverb', 'pronoun', 'preposition', 'conjunction', 'determiner', 'number', 'interjection', 'particle'].includes(tag.toLocaleLowerCase('en-US'))
      ? tag.toLocaleLowerCase('en-US')
      : 'unknown');
  }

  function normalizeConfidence(value, fallback = 'low') {
    const normalized = normalizeText(value, 16).toLocaleLowerCase('en-US');
    return ['high', 'medium', 'low'].includes(normalized) ? normalized : fallback;
  }

  function contextTokens(context) {
    return Array.from(normalizeText(context, 4000).matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu), (match) => ({
      text: normalizeWord(match[0]),
      index: match.index || 0,
    })).filter((token) => token.text);
  }

  function contextWindow(surface, context) {
    const tokens = contextTokens(context);
    const normalized = normalizeWord(surface);
    let index = tokens.findIndex((token) => token.text === normalized);
    if (index < 0) index = 0;
    return {
      previous: tokens[index - 1]?.text || '',
      previous2: tokens[index - 2]?.text || '',
      next: tokens[index + 1]?.text || '',
      next2: tokens[index + 2]?.text || '',
    };
  }

  function explicitParts(options) {
    const raw = [
      options?.partOfSpeech,
      options?.posTag,
      ...(Array.isArray(options?.posCandidates) ? options.posCandidates : []),
    ];
    return Array.from(new Set(raw.map(normalizePartOfSpeech).filter((value) => value !== 'unknown')));
  }

  function inferPartOfSpeech(surface, context, candidates = []) {
    const word = normalizeWord(surface);
    const window = contextWindow(word, context);
    const allowed = new Set(candidates);
    const canUse = (pos) => !allowed.size || allowed.has(pos);

    if (word.endsWith('ly') && !ADJECTIVE_LY.has(word) && canUse('adverb')) {
      return { partOfSpeech: 'adverb', confidence: 'high', reason: 'ly-adverb' };
    }
    if (word.endsWith('ing') && !NON_INFLECTED_ING.has(word)) {
      if (AUXILIARIES.has(window.previous) && canUse('verb')) {
        return { partOfSpeech: 'verb', confidence: 'high', reason: 'auxiliary-before-ing' };
      }
      if (DETERMINERS.has(window.previous) && canUse('noun')) {
        return { partOfSpeech: 'noun', confidence: 'medium', reason: 'determiner-before-ing' };
      }
    }
    if (word.endsWith('ed') && !NON_INFLECTED_ED.has(word)) {
      if ((AUXILIARIES.has(window.previous) || AUXILIARIES.has(window.previous2)) && canUse('verb')) {
        return { partOfSpeech: 'verb', confidence: window.next === 'by' ? 'high' : 'medium', reason: 'auxiliary-before-ed' };
      }
    }
    // "the auxiliary loss" / "a primary model": a common adjective-shaped
    // word between a determiner and the noun it describes. This must run before
    // the broad determiner-before-noun fallback below.
    if (DETERMINERS.has(window.previous)
        && window.next
        && !PREPOSITIONS.has(window.next)
        && !VERB_FOLLOWERS.has(window.next)
        && ATTRIBUTIVE_ADJECTIVE_SUFFIX.test(word)
        && canUse('adjective')) {
      return { partOfSpeech: 'adjective', confidence: 'medium', reason: 'attributive-adjective-shape' };
    }
    if (word.endsWith('s') && !NON_INFLECTED_S.has(word)) {
      if ((SUBJECT_PRONOUNS.has(window.previous) || VERB_FOLLOWERS.has(window.next)) && canUse('verb')) {
        return { partOfSpeech: 'verb', confidence: 'high', reason: 'verb-slot-around-s' };
      }
      if ((DETERMINERS.has(window.previous) || PREPOSITIONS.has(window.previous)) && canUse('noun')) {
        return { partOfSpeech: 'noun', confidence: 'high', reason: 'noun-slot-before-s' };
      }
    }
    if ((window.previous === 'to' || AUXILIARIES.has(window.previous) || UNAMBIGUOUS_SUBJECTS.has(window.previous) || DETERMINERS.has(window.next)) && canUse('verb')) {
      return { partOfSpeech: 'verb', confidence: 'high', reason: 'base-verb-slot' };
    }
    if ((window.next === 'of' || DETERMINERS.has(window.previous) || PREPOSITIONS.has(window.previous)) && canUse('noun')) {
      return { partOfSpeech: 'noun', confidence: 'high', reason: 'base-noun-slot' };
    }
    if (IRREGULAR_VERBS.has(word) && canUse('verb')) {
      const clearVerbSlot = SUBJECT_PRONOUNS.has(window.previous)
        || AUXILIARIES.has(window.previous)
        || VERB_FOLLOWERS.has(window.next);
      return { partOfSpeech: 'verb', confidence: clearVerbSlot ? 'high' : 'medium', reason: 'irregular-verb' };
    }
    if (IRREGULAR_NOUNS.has(word) && canUse('noun')) {
      return { partOfSpeech: 'noun', confidence: 'high', reason: 'irregular-noun' };
    }
    if (IRREGULAR_ADJECTIVES.has(word) && canUse('adjective')) {
      return { partOfSpeech: 'adjective', confidence: 'medium', reason: 'irregular-adjective' };
    }
    if (candidates.length === 1) {
      return { partOfSpeech: candidates[0], confidence: 'high', reason: 'single-dictionary-pos' };
    }
    return { partOfSpeech: 'unknown', confidence: 'low', reason: 'ambiguous-pos' };
  }

  function doubledFinal(stem) {
    if (stem.length < 3) return false;
    const last = stem[stem.length - 1];
    return last === stem[stem.length - 2] && /[b-df-hj-np-tv-z]/.test(last);
  }

  function lemmatizeVerb(surface) {
    const word = normalizeWord(surface);
    if (IRREGULAR_VERBS.has(word)) return { lemma: IRREGULAR_VERBS.get(word), confidence: 'high', reason: 'irregular' };
    if (NON_INFLECTED_ING.has(word) || NON_INFLECTED_ED.has(word)) return { lemma: word, confidence: 'low', reason: 'base-word-ending' };
    if (word.length > 4 && word.endsWith('ies')) return { lemma: `${word.slice(0, -3)}y`, confidence: 'high', reason: 'verb-ies' };
    if (word.length > 4 && word.endsWith('ied')) return { lemma: `${word.slice(0, -3)}y`, confidence: 'high', reason: 'verb-ied' };
    if (word.length > 4 && word.endsWith('ing')) {
      if (word === 'lying') return { lemma: 'lie', confidence: 'high', reason: 'verb-ying' };
      if (word === 'dying') return { lemma: 'die', confidence: 'high', reason: 'verb-ying' };
      if (word === 'tying') return { lemma: 'tie', confidence: 'high', reason: 'verb-ying' };
      let stem = word.slice(0, -3);
      if (doubledFinal(stem)) return { lemma: stem.slice(0, -1), confidence: 'high', reason: 'verb-double-ing' };
      if (SILENT_E_STEMS.has(stem)) return { lemma: SILENT_E_STEMS.get(stem), confidence: 'high', reason: 'verb-silent-e-ing' };
      return { lemma: stem, confidence: stem.length >= 4 ? 'high' : 'medium', reason: 'verb-ing' };
    }
    if (word.length > 3 && word.endsWith('ed')) {
      const minusD = word.slice(0, -1);
      if (SILENT_E_VERBS.has(minusD)) return { lemma: minusD, confidence: 'high', reason: 'verb-silent-e-ed' };
      let stem = word.slice(0, -2);
      if (doubledFinal(stem)) return { lemma: stem.slice(0, -1), confidence: 'high', reason: 'verb-double-ed' };
      if (SILENT_E_STEMS.has(stem)) return { lemma: SILENT_E_STEMS.get(stem), confidence: 'high', reason: 'verb-silent-e-ed' };
      return { lemma: stem, confidence: stem.length >= 4 ? 'high' : 'medium', reason: 'verb-ed' };
    }
    if (word.length > 3 && word.endsWith('oes')) return { lemma: word.slice(0, -2), confidence: 'high', reason: 'verb-oes' };
    if (word.length > 4 && /(?:ches|shes|sses|xes|zes)$/.test(word)) {
      return { lemma: word.slice(0, -2), confidence: 'high', reason: 'verb-es' };
    }
    if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) {
      return { lemma: word.slice(0, -1), confidence: 'high', reason: 'verb-s' };
    }
    return { lemma: word, confidence: 'high', reason: 'base-verb' };
  }

  function lemmatizeNoun(surface) {
    const word = normalizeWord(surface);
    if (IRREGULAR_NOUNS.has(word)) return { lemma: IRREGULAR_NOUNS.get(word), confidence: 'high', reason: 'irregular' };
    if (NON_INFLECTED_S.has(word)) return { lemma: word, confidence: 'high', reason: 'base-noun-s' };
    if (word.length > 4 && word.endsWith('ies')) return { lemma: `${word.slice(0, -3)}y`, confidence: 'high', reason: 'noun-ies' };
    if (word.length > 4 && /(?:ches|shes|sses|xes|zes)$/.test(word)) {
      return { lemma: word.slice(0, -2), confidence: 'high', reason: 'noun-es' };
    }
    if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) {
      return { lemma: word.slice(0, -1), confidence: 'high', reason: 'noun-s' };
    }
    return { lemma: word, confidence: 'high', reason: 'base-noun' };
  }

  function lemmatizeAdjective(surface) {
    const word = normalizeWord(surface);
    if (IRREGULAR_ADJECTIVES.has(word)) return { lemma: IRREGULAR_ADJECTIVES.get(word), confidence: 'high', reason: 'irregular' };
    if (word.length > 5 && word.endsWith('iest')) return { lemma: `${word.slice(0, -4)}y`, confidence: 'high', reason: 'adjective-iest' };
    if (word.length > 4 && word.endsWith('ier')) return { lemma: `${word.slice(0, -3)}y`, confidence: 'high', reason: 'adjective-ier' };
    if (word.length > 5 && word.endsWith('est')) {
      let stem = word.slice(0, -3);
      if (doubledFinal(stem)) stem = stem.slice(0, -1);
      return { lemma: stem, confidence: 'medium', reason: 'adjective-est' };
    }
    if (word.length > 4 && word.endsWith('er')) {
      let stem = word.slice(0, -2);
      if (doubledFinal(stem)) stem = stem.slice(0, -1);
      return { lemma: stem, confidence: 'medium', reason: 'adjective-er' };
    }
    return { lemma: word, confidence: 'high', reason: 'base-adjective' };
  }

  function confidenceRank(value) {
    return value === 'high' ? 3 : value === 'medium' ? 2 : 1;
  }

  function lowerConfidence(a, b) {
    return confidenceRank(a) <= confidenceRank(b) ? a : b;
  }

  function analyzeWord(surface, options = {}) {
    const normalizedSurface = normalizeWord(surface);
    if (!normalizedSurface) {
      return {
        surface: '', normalizedSurface: '', lemma: '', suggestedLemma: '', partOfSpeech: 'unknown',
        confidence: 'low', provisional: true, reason: 'empty',
      };
    }
    const providedLemma = normalizeWord(options.lemma);
    const providedPos = normalizePartOfSpeech(options.partOfSpeech || options.posTag);
    if (providedLemma) {
      const confidence = normalizeConfidence(options.analysisConfidence, providedPos === 'unknown' ? 'medium' : 'high');
      return {
        surface: normalizeText(surface, 500), normalizedSurface, lemma: providedLemma, suggestedLemma: providedLemma,
        partOfSpeech: providedPos, confidence, provisional: confidence !== 'high', reason: 'provided',
      };
    }

    const candidates = explicitParts(options);
    const inferred = providedPos !== 'unknown'
      ? { partOfSpeech: providedPos, confidence: 'high', reason: 'provided-pos' }
      : inferPartOfSpeech(normalizedSurface, options.context || options.sourceText || '', candidates);
    let lemmaResult = { lemma: normalizedSurface, confidence: 'high', reason: 'unchanged' };
    if (inferred.partOfSpeech === 'verb') lemmaResult = lemmatizeVerb(normalizedSurface);
    else if (inferred.partOfSpeech === 'noun') lemmaResult = lemmatizeNoun(normalizedSurface);
    else if (inferred.partOfSpeech === 'adjective') lemmaResult = lemmatizeAdjective(normalizedSurface);
    const confidence = lowerConfidence(inferred.confidence, lemmaResult.confidence);
    const safeToMerge = confidence === 'high' && inferred.partOfSpeech !== 'unknown';
    return {
      surface: normalizeText(surface, 500),
      normalizedSurface,
      lemma: safeToMerge ? lemmaResult.lemma : normalizedSurface,
      suggestedLemma: lemmaResult.lemma,
      partOfSpeech: inferred.partOfSpeech,
      confidence,
      provisional: !safeToMerge,
      reason: `${inferred.reason}:${lemmaResult.reason}`,
    };
  }

  function isEnglishLanguage(value, surface) {
    const language = normalizeText(value || 'auto', 32).toLocaleLowerCase('en-US');
    if (language === 'en' || language.startsWith('en-')) return true;
    return language === 'auto' && /^[a-z][a-z'’-]*$/i.test(normalizeText(surface, 500));
  }

  function canonicalIdentity(input = {}) {
    const kind = input.kind === 'phrase' ? 'phrase' : 'word';
    const sourceLang = normalizeText(input.sourceLang || input.source_lang || 'auto', 32).toLocaleLowerCase('en-US');
    const targetLang = normalizeText(input.targetLang || input.target_lang || 'ru', 32).toLocaleLowerCase('en-US');
    const surface = normalizeText(input.surfaceForm || input.observedForm || input.sourceText || input.term || input.normalizedText || input.lemma, 500);
    if (kind === 'phrase' || !isEnglishLanguage(sourceLang, surface)) {
      const lemma = normalizeWord(input.lemma || input.normalizedText || surface);
      return {
        kind, sourceLang, targetLang, surface, normalizedSurface: normalizeWord(surface), lemma,
        suggestedLemma: lemma, partOfSpeech: kind === 'phrase' ? 'phrase' : normalizePartOfSpeech(input.partOfSpeech),
        confidence: kind === 'phrase' ? 'high' : normalizeConfidence(input.analysisConfidence),
        provisional: kind !== 'phrase' && normalizePartOfSpeech(input.partOfSpeech) === 'unknown',
      };
    }
    return {
      kind, sourceLang, targetLang,
      ...analyzeWord(surface, {
        lemma: input.lemma,
        partOfSpeech: input.partOfSpeech,
        posTag: input.posTag,
        posCandidates: input.posCandidates,
        analysisConfidence: input.analysisConfidence,
        context: input.context || input.contexts?.[0]?.sourceText || '',
      }),
    };
  }

  function identityKey(input = {}) {
    const identity = canonicalIdentity(input);
    if (identity.kind === 'phrase') {
      return `phrase|${identity.sourceLang}|${identity.targetLang}|${identity.lemma}`;
    }
    return `word|${identity.sourceLang}|${identity.targetLang}|${identity.lemma}`;
  }

  function sameLexeme(a, b) {
    return identityKey(a) === identityKey(b);
  }

  function formsForLexeme(input = {}) {
    const requestedParts = Array.from(new Set([
      ...(Array.isArray(input.partsOfSpeech) ? input.partsOfSpeech : []),
      input.partOfSpeech,
    ].map(normalizePartOfSpeech).filter((value) => value !== 'unknown')));
    if (requestedParts.length > 1) {
      const combined = new Set();
      for (const partOfSpeech of requestedParts) {
        for (const form of formsForLexeme({ ...input, partsOfSpeech: [], partOfSpeech })) combined.add(form);
      }
      return Array.from(combined);
    }
    const identity = canonicalIdentity(input);
    const lemma = identity.lemma;
    const forms = new Set([lemma]);
    if (!lemma || identity.kind !== 'word') return Array.from(forms);
    if (identity.partOfSpeech === 'verb') {
      for (const [form, base] of IRREGULAR_VERBS) {
        if (base === lemma) forms.add(form);
      }
      if (/[^aeiou]y$/.test(lemma)) {
        forms.add(`${lemma.slice(0, -1)}ies`);
        forms.add(`${lemma.slice(0, -1)}ied`);
      } else {
        forms.add(/(?:s|x|z|ch|sh|o)$/.test(lemma) ? `${lemma}es` : `${lemma}s`);
        forms.add(lemma.endsWith('e')
          ? `${lemma}d`
          : DOUBLING_VERBS.has(lemma)
            ? `${lemma}${lemma[lemma.length - 1]}ed`
            : `${lemma}ed`);
      }
      if (lemma.endsWith('ie')) forms.add(`${lemma.slice(0, -2)}ying`);
      else if (lemma.endsWith('e') && !lemma.endsWith('ee')) forms.add(`${lemma.slice(0, -1)}ing`);
      else if (DOUBLING_VERBS.has(lemma)) forms.add(`${lemma}${lemma[lemma.length - 1]}ing`);
      else forms.add(`${lemma}ing`);
    } else if (identity.partOfSpeech === 'noun') {
      for (const [form, base] of IRREGULAR_NOUNS) {
        if (base === lemma) forms.add(form);
      }
      if (/[^aeiou]y$/.test(lemma)) forms.add(`${lemma.slice(0, -1)}ies`);
      else forms.add(/(?:s|x|z|ch|sh)$/.test(lemma) ? `${lemma}es` : `${lemma}s`);
    } else if (identity.partOfSpeech === 'adjective') {
      for (const [form, base] of IRREGULAR_ADJECTIVES) {
        if (base === lemma) forms.add(form);
      }
      if (/[^aeiou]y$/.test(lemma)) {
        forms.add(`${lemma.slice(0, -1)}ier`);
        forms.add(`${lemma.slice(0, -1)}iest`);
      }
    }
    return Array.from(forms).map(normalizeWord).filter(Boolean);
  }

  return {
    analyzeWord,
    canonicalIdentity,
    identityKey,
    sameLexeme,
    formsForLexeme,
    normalizeWord,
    normalizePartOfSpeech,
    normalizeConfidence,
  };
});
