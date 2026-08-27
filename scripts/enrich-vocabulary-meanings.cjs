#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const U = require('../browser-extension/youtube-learning-utils');

const BRIDGE = String(process.env.SC_BRIDGE_URL || 'http://127.0.0.1:53127').replace(/\/$/, '');
const EXTENSION_ID = process.env.SC_EXTENSION_ID || 'phnlfhkblebijojjnnlbcbklijgcijgf';
const APPLY = process.argv.includes('--apply');
const BACKUP_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'sc-desktop', 'vocabulary-migration-backups');

function clean(value, limit = 4000) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function normalizePos(value) {
  const raw = clean(value, 32).toLocaleLowerCase('en-US');
  const aliases = {
    n: 'noun', noun: 'noun', v: 'verb', verb: 'verb', adj: 'adjective', adjective: 'adjective',
    adv: 'adverb', adverb: 'adverb', prep: 'preposition', preposition: 'preposition',
    conj: 'conjunction', conjunction: 'conjunction', pron: 'pronoun', pronoun: 'pronoun',
    det: 'determiner', determiner: 'determiner', part: 'particle', particle: 'particle',
    intj: 'interjection', interjection: 'interjection',
  };
  return aliases[raw] || 'unknown';
}

async function bridgeJson(route, options = {}, timeoutMs = 45_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${BRIDGE}${route}`, {
      method: options.method || 'GET',
      headers: {
        'X-SC-Extension-Id': EXTENSION_ID,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok === false) throw new Error(payload?.error || `HTTP ${response.status}`);
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

async function vocabularyItems() {
  const payload = await bridgeJson('/vocabulary/sync', {
    method: 'POST',
    body: { entries: [], reviews: [] },
  });
  if (payload?.online !== true) throw new Error(payload?.error || 'Voice Record vocabulary is offline');
  return Array.isArray(payload.items) ? payload.items : [];
}

async function dictionaryLookup(text) {
  const payload = await bridgeJson('/translator/dictionary', {
    method: 'POST',
    body: { text, from: 'en', to: 'ru' },
  }, 25_000);
  return payload?.dictionary?.translations?.length ? payload.dictionary : null;
}

function dictionaryTranslations(dictionary) {
  return (Array.isArray(dictionary?.translations) ? dictionary.translations : []).slice(0, 20).map((item) => ({
    value: clean(item?.normalizedTarget || item?.displayTarget, 160),
    partOfSpeech: normalizePos(item?.posTag),
  })).filter((item) => item.value);
}

function selectedVideoContext(item) {
  return (item.contexts || []).find((context) => context.origin === 'video')
    || (item.contexts || [])[0]
    || null;
}

function selectedSurface(item, context) {
  return clean(context?.surfaceForm, 120)
    || (item.observedForms || []).find((form) => clean(form).toLocaleLowerCase('en-US') !== clean(item.lemma || item.term).toLocaleLowerCase('en-US'))
    || clean(item.term, 120);
}

async function analyzeWord(item, dictionary, surface, context) {
  const translations = dictionaryTranslations(dictionary);
  const payload = await bridgeJson('/learning/explain', {
    method: 'POST',
    body: {
      word: surface,
      wordTranslation: item.translation || translations[0]?.value || '',
      context: clean(context?.sourceText || `The word ${surface} appears here.`, 3000),
      contextTranslation: clean(context?.translation, 3000),
      sourceLang: 'en',
      targetLang: 'ru',
      knownMeanings: Array.from(new Set((item.contexts || []).map((entry) => clean(entry?.meaning, 300)).filter(Boolean))),
      dictionaryTranslations: translations,
    },
  }, 55_000);
  if (payload?.online === false) throw new Error(payload?.error || 'learning explanation is offline');
  return payload;
}

function semanticPairs(dictionary, analysis) {
  const translations = Array.isArray(dictionary?.translations) ? dictionary.translations : [];
  const byValue = new Map(translations.map((item) => [
    clean(item?.normalizedTarget || item?.displayTarget, 160).toLocaleLowerCase('ru-RU'),
    item,
  ]));
  const pairs = [];
  const covered = new Set();
  for (const group of Array.isArray(analysis?.meaningGroups) ? analysis.meaningGroups : []) {
    const targets = Array.from(new Set((group?.values || []).map((value) => clean(value, 160)).filter((value) => byValue.has(value.toLocaleLowerCase('ru-RU')))));
    if (!targets.length) continue;
    targets.forEach((target) => covered.add(target.toLocaleLowerCase('ru-RU')));
    const first = byValue.get(targets[0].toLocaleLowerCase('ru-RU'));
    pairs.push({
      text: dictionary?.normalizedSource || dictionary?.displaySource || '',
      translation: first?.normalizedTarget || targets[0],
      targets,
      pos: clean(group?.partOfSpeech || first?.posTag, 32).toUpperCase(),
      example: clean(group?.example, 1000),
      exampleTranslation: clean(group?.exampleTranslation, 1000),
    });
  }

  return U.mergeDictionaryMeaningPairs(dictionary, pairs, analysis?.invalidValues || []);
}

async function fillGeneratedPairExamples(item, pairs, surface, context) {
  for (const pair of pairs) {
    if (U.sentenceIsComplete(pair.example, 'en') && U.sentenceIsComplete(pair.exampleTranslation, 'ru')) continue;
    const payload = await bridgeJson('/learning/explain', {
      method: 'POST',
      body: {
        word: surface,
        wordTranslation: pair.translation || item.translation || '',
        context: clean(context?.sourceText || `The word ${surface} appears here.`, 3000),
        contextTranslation: clean(context?.translation, 3000),
        sourceLang: 'en',
        targetLang: 'ru',
        knownMeanings: [],
        dictionaryTranslations: pair.targets.map((value) => ({ value, partOfSpeech: normalizePos(pair.pos) })),
      },
    }, 55_000);
    const requested = new Set(pair.targets.map((value) => clean(value).toLocaleLowerCase('ru-RU')));
    const group = (payload?.meaningGroups || []).find((candidate) => (
      (candidate?.values || []).some((value) => requested.has(clean(value).toLocaleLowerCase('ru-RU')))
      && U.sentenceIsComplete(candidate?.example, 'en')
      && U.sentenceIsComplete(candidate?.exampleTranslation, 'ru')
    ));
    if (group) {
      pair.example = clean(group.example, 1000);
      pair.exampleTranslation = clean(group.exampleTranslation, 1000);
    }
  }
  return pairs;
}

async function exampleRows(pairs) {
  const rows = [];
  const usedSourceSentences = new Set();
  for (let offset = 0; offset < pairs.length; offset += 10) {
    const batch = pairs.slice(offset, offset + 10);
    let payload = null;
    try {
      payload = await bridgeJson('/translator/examples', {
        method: 'POST',
        body: { pairs: batch, from: 'en', to: 'ru' },
      }, 35_000);
    } catch (error) {
      process.stdout.write(`  Azure examples fallback: ${error.message}\n`);
    }
    const normalized = U.dictionaryExampleRows(
      payload || { examples: batch.map(() => ({ examples: [] })) },
      batch,
      'en',
      'ru',
      usedSourceSentences,
    );
    rows.push(...normalized.map((row) => ({ ...row, pairIndex: row.pairIndex + offset })));
  }
  return rows.sort((left, right) => left.pairIndex - right.pairIndex);
}

function cleanExistingContexts(item) {
  const cleaned = [];
  for (const context of item.contexts || []) {
    if (context.origin === 'dictionary') continue;
    if (!clean(context.meaning, 500)) continue;
    const surface = clean(context.surfaceForm || item.term, 120);
    const pair = U.parallelSentenceForTerm(context.sourceText, context.translation, surface, 'en', 'ru');
    if (!pair.complete || !pair.translation) continue;
    cleaned.push({
      ...context,
      sourceText: pair.sourceText,
      translation: pair.translation,
      surfaceForm: surface,
    });
  }
  return cleaned;
}

function rowsToContexts(rows, pairs) {
  const now = Date.now();
  return rows.map((row, index) => {
    const pair = pairs[row.pairIndex] || {};
    return {
      videoId: '', videoUrl: '', videoTitle: 'Словарный пример', startMs: -1, endMs: null,
      sourceText: row.sourceText,
      surfaceForm: clean(row.sourceTerm || pair.text, 120).toLocaleLowerCase('en-US'),
      translation: row.targetText,
      meaning: (pair.targets || [pair.translation]).filter(Boolean).join(' / '),
      origin: 'dictionary',
      partOfSpeech: normalizePos(pair.pos),
      createdAt: now - index,
    };
  });
}

async function prepareItem(item, index, total) {
  const context = selectedVideoContext(item);
  const surface = selectedSurface(item, context);
  let canonical = clean(item.lemma || item.term, 120).toLocaleLowerCase('en-US');
  let dictionary = await dictionaryLookup(canonical).catch(() => null);
  let analysis = await analyzeWord(item, dictionary, surface, context);

  if (!dictionary && analysis?.analysisConfidence === 'high' && analysis?.lemma) {
    const candidate = clean(analysis.lemma, 120).toLocaleLowerCase('en-US');
    const candidateDictionary = await dictionaryLookup(candidate).catch(() => null);
    if (candidateDictionary) {
      canonical = candidate;
      dictionary = candidateDictionary;
      analysis = await analyzeWord(item, dictionary, surface, context);
    }
  }
  if (!dictionary) throw new Error(`dictionary lookup is empty for ${canonical}`);

  let pairs = await fillGeneratedPairExamples(item, semanticPairs(dictionary, analysis), surface, context);
  if (!pairs.length) throw new Error('no semantic groups');
  let rows = await exampleRows(pairs);
  const covered = new Set(rows.map((row) => row.pairIndex));
  const rejected = pairs.map((pair, pairIndex) => ({ pair, pairIndex })).filter(({ pairIndex }) => !covered.has(pairIndex));
  if (rejected.length) {
    process.stdout.write(`  Rejected provider noise without a valid example: ${rejected.map(({ pair }) => pair.targets.join(' / ')).join('; ')}\n`);
    const remap = new Map();
    pairs = pairs.filter((pair, pairIndex) => {
      if (!covered.has(pairIndex)) return false;
      remap.set(pairIndex, remap.size);
      return true;
    });
    rows = rows.map((row) => ({ ...row, pairIndex: remap.get(row.pairIndex) })).filter((row) => Number.isInteger(row.pairIndex));
  }
  if (!pairs.length) throw new Error('no semantic groups with complete examples');
  const contexts = [...rowsToContexts(rows, pairs), ...cleanExistingContexts(item)];
  if (!contexts.length || contexts.some((entry) => (
    !U.sentenceIsComplete(entry.sourceText, 'en')
    || !U.sentenceIsComplete(entry.translation, 'ru')
    || !U.sentenceContainsTerm(entry.sourceText, entry.surfaceForm || canonical, 'en')
  ))) {
    throw new Error('context validation failed');
  }
  const partsOfSpeech = Array.from(new Set([
    ...(item.partsOfSpeech || []),
    ...pairs.map((pair) => normalizePos(pair.pos)),
  ].filter((pos) => pos && pos !== 'unknown')));
  const firstTranslation = clean(dictionary?.translations?.[0]?.normalizedTarget || dictionary?.translations?.[0]?.displayTarget, 4000);
  process.stdout.write(`[${index + 1}/${total}] ${item.term} → ${canonical}: ${pairs.length} meanings, ${contexts.length} examples\n`);
  return {
    item,
    canonical,
    pairs,
    contexts,
    patch: {
      key: `word|en|ru|${canonical}`,
      remoteId: item.id,
      sourceText: canonical,
      lemma: canonical,
      kind: 'word',
      state: item.state,
      sourceLang: item.sourceLang || 'en',
      targetLang: item.targetLang || 'ru',
      partOfSpeech: normalizePos(analysis?.partOfSpeech || item.partOfSpeech),
      partsOfSpeech,
      analysisConfidence: analysis?.analysisConfidence || item.analysisConfidence || 'low',
      observedForms: Array.from(new Set([...(item.observedForms || []), surface, canonical].map((value) => clean(value, 120).toLocaleLowerCase('en-US')).filter(Boolean))),
      translation: firstTranslation || item.translation,
      translationSource: item.translationSource || 'machine',
      translationDirty: Boolean(firstTranslation && firstTranslation !== item.translation),
      translationUpdatedAt: firstTranslation && firstTranslation !== item.translation ? Date.now() : item.translationUpdatedAt,
      stateUpdatedAt: item.stateUpdatedAt,
      updatedAt: Date.now(),
      remoteTranslationUpdatedAt: item.translationUpdatedAt,
      contexts,
      replaceContexts: true,
      dirty: true,
    },
  };
}

async function applyPrepared(prepared) {
  const result = await bridgeJson('/vocabulary/sync', {
    method: 'POST',
    body: { entries: [prepared.patch], reviews: [] },
  }, 60_000);
  if (result?.online !== true) throw new Error(result?.error || 'sync offline');
  const updated = (result.items || []).find((item) => item.id === prepared.item.id);
  if (!updated) throw new Error('updated item missing from sync response');
  const remoteMeanings = new Set((updated.contexts || []).map((context) => clean(context?.meaning, 500)).filter(Boolean));
  const missingMeanings = prepared.contexts
    .filter((context) => context.origin === 'dictionary')
    .map((context) => clean(context.meaning, 500))
    .filter((meaning) => meaning && !remoteMeanings.has(meaning));
  if (missingMeanings.length) {
    throw new Error(`semantic context replacement mismatch: ${missingMeanings.join('; ')}`);
  }
  return updated;
}

async function main() {
  const allItems = await vocabularyItems();
  const words = allItems.filter((item) => item.state !== 'none' && item.kind === 'word');
  process.stdout.write(`Vocabulary: ${words.length} active words (${APPLY ? 'apply' : 'dry-run'})\n`);
  const prepared = [];
  const failures = [];
  for (let index = 0; index < words.length; index += 1) {
    try {
      prepared.push(await prepareItem(words[index], index, words.length));
    } catch (error) {
      failures.push({ id: words[index].id, term: words[index].term, error: error?.message || String(error) });
      process.stdout.write(`[${index + 1}/${words.length}] ${words[index].term}: FAILED ${error?.message || error}\n`);
    }
  }
  if (failures.length) {
    process.stdout.write(`${JSON.stringify({ ok: false, prepared: prepared.length, failures }, null, 2)}\n`);
    process.exitCode = 2;
    return;
  }
  if (!APPLY) {
    process.stdout.write(`${JSON.stringify({ ok: true, dryRun: true, prepared: prepared.length, meanings: prepared.reduce((sum, entry) => sum + entry.pairs.length, 0) }, null, 2)}\n`);
    return;
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(BACKUP_DIR, `before-meaning-enrichment-${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify({ exportedAt: new Date().toISOString(), items: allItems }, null, 2));
  process.stdout.write(`Backup: ${backupPath}\n`);
  for (let index = 0; index < prepared.length; index += 1) {
    await applyPrepared(prepared[index]);
    process.stdout.write(`Applied [${index + 1}/${prepared.length}] ${prepared[index].item.term}\n`);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, applied: prepared.length, meanings: prepared.reduce((sum, entry) => sum + entry.pairs.length, 0), backupPath }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
