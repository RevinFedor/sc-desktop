(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.__scYtLearningUtils = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function decodeEntities(value) {
    return String(value || '')
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }

  function cleanCueText(value) {
    return decodeEntities(value)
      .replace(/<[^>]*>/g, '')
      .replace(/[\r\n]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function finalizeCues(raw) {
    const sorted = raw
      .filter(cue => cue && Number.isFinite(cue.startMs) && cue.text)
      .map(cue => ({
        startMs: Math.max(0, Math.round(cue.startMs)),
        endMs: Number.isFinite(cue.endMs) ? Math.max(0, Math.round(cue.endMs)) : null,
        text: cleanCueText(cue.text),
      }))
      .filter(cue => cue.text)
      .sort((a, b) => a.startMs - b.startMs);

    const out = [];
    for (let i = 0; i < sorted.length; i += 1) {
      const cue = sorted[i];
      const nextStart = sorted[i + 1]?.startMs;
      let endMs = cue.endMs;
      if (!Number.isFinite(endMs) || endMs <= cue.startMs) {
        endMs = Number.isFinite(nextStart) ? nextStart : cue.startMs + 3_000;
      }
      if (Number.isFinite(nextStart)) endMs = Math.min(endMs, nextStart + 250);
      endMs = Math.max(cue.startMs + 120, endMs);

      const previous = out[out.length - 1];
      if (previous && previous.text === cue.text && cue.startMs <= previous.endMs + 250) {
        previous.endMs = Math.max(previous.endMs, endMs);
        continue;
      }
      out.push({ ...cue, endMs, index: out.length });
    }
    return out;
  }

  function parseJson3Cues(payload) {
    const events = Array.isArray(payload?.events) ? payload.events : [];
    const raw = [];
    for (const event of events) {
      if (!Array.isArray(event?.segs)) continue;
      const text = cleanCueText(event.segs.map(seg => seg?.utf8 || '').join(''));
      if (!text) continue;
      const startMs = Number(event.tStartMs);
      const durationMs = Number(event.dDurationMs);
      if (!Number.isFinite(startMs)) continue;
      if (event.aAppend && raw.length) {
        const previous = raw[raw.length - 1];
        previous.text = cleanCueText(`${previous.text} ${text}`);
        if (Number.isFinite(durationMs)) previous.endMs = Math.max(previous.endMs || 0, startMs + durationMs);
        continue;
      }
      raw.push({
        startMs,
        endMs: Number.isFinite(durationMs) ? startMs + durationMs : null,
        text,
      });
    }
    return finalizeCues(raw);
  }

  function timestampToMs(value) {
    const parts = String(value || '').trim().replace(',', '.').split(':').map(Number);
    if (parts.some(part => !Number.isFinite(part))) return null;
    if (parts.length === 3) return Math.round(((parts[0] * 60 + parts[1]) * 60 + parts[2]) * 1_000);
    if (parts.length === 2) return Math.round((parts[0] * 60 + parts[1]) * 1_000);
    return null;
  }

  function parseVttCues(text) {
    const lines = String(text || '').replace(/\r/g, '').split('\n');
    const raw = [];
    for (let i = 0; i < lines.length; i += 1) {
      const match = lines[i].match(/^(\d{1,2}:)?\d{2}:\d{2}[.,]\d{3}\s+-->\s+(\d{1,2}:)?\d{2}:\d{2}[.,]\d{3}/);
      if (!match) continue;
      const [left, right] = lines[i].split(/\s+-->\s+/);
      const startMs = timestampToMs(left);
      const endMs = timestampToMs(right.split(/\s+/)[0]);
      const body = [];
      for (i += 1; i < lines.length && lines[i].trim(); i += 1) body.push(lines[i]);
      if (startMs != null) raw.push({ startMs, endMs, text: body.join(' ') });
    }
    return finalizeCues(raw);
  }

  // YouTube automatic captions are emitted as short rolling fragments.
  // Language Reactor combines adjacent ASR events in pairs; doing the same
  // keeps a readable phrase on screen instead of replacing it every ~2 sec.
  function pairAdjacentAsrCues(rawCues) {
    const cues = finalizeCues(rawCues || []);
    const paired = [];
    for (let index = 0; index < cues.length;) {
      const first = cues[index];
      const second = cues[index + 1];
      const contiguous = second && second.startMs - first.endMs <= 20;
      if (contiguous) {
        paired.push({
          startMs: first.startMs,
          endMs: Math.max(first.startMs + 120, second.endMs),
          text: cleanCueText(`${first.text} ${second.text}`),
        });
        index += 2;
      } else {
        paired.push({ startMs: first.startMs, endMs: first.endMs, text: first.text });
        index += 1;
      }
    }
    return paired.map((cue, index) => ({ ...cue, index }));
  }

  function findCueIndex(cues, timeMs) {
    if (!Array.isArray(cues) || !cues.length || !Number.isFinite(timeMs)) return -1;
    let low = 0;
    let high = cues.length - 1;
    let candidate = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (cues[mid].startMs <= timeMs) {
        candidate = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    if (candidate < 0) return -1;
    const cue = cues[candidate];
    return timeMs <= cue.endMs + 120 ? candidate : -1;
  }

  function normalizeTerm(value) {
    return String(value || '')
      .normalize('NFKC')
      .trim()
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}'’-]+$/gu, '')
      .toLocaleLowerCase();
  }

  function segmentWords(text, language) {
    const source = String(text || '');
    try {
      const segmenter = new Intl.Segmenter(language || undefined, { granularity: 'word' });
      return Array.from(segmenter.segment(source)).map(part => ({
        text: part.segment,
        index: part.index,
        word: part.isWordLike === true,
        normalized: part.isWordLike ? normalizeTerm(part.segment) : '',
      }));
    } catch {
      return source.split(/(\s+)/).map((part, index) => ({
        text: part,
        index,
        word: /[\p{L}\p{N}]/u.test(part),
        normalized: normalizeTerm(part),
      }));
    }
  }

  function mergeTextRanges(ranges, textLength) {
    const limit = Math.max(0, Number(textLength) || 0);
    const sorted = (ranges || [])
      .map(range => ({
        start: Math.max(0, Math.min(limit, Math.trunc(Number(range?.start) || 0))),
        end: Math.max(0, Math.min(limit, Math.trunc(Number(range?.end) || 0))),
      }))
      .filter(range => range.end > range.start)
      .sort((a, b) => a.start - b.start || a.end - b.end);
    const merged = [];
    for (const range of sorted) {
      const previous = merged[merged.length - 1];
      if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
      else merged.push({ ...range });
    }
    return merged;
  }

  // Azure Translator returns inclusive UTF-16 character spans such as
  // `0:2-0:1`. Resolve only the target spans aligned to the selected source
  // word so the Russian example can highlight the real contextual equivalent.
  function alignedTargetRanges(sourceText, targetText, term, projection, language) {
    const source = String(sourceText || '');
    const target = String(targetText || '');
    const normalized = normalizeTerm(term);
    if (!source || !target || !normalized || !projection) return [];
    const sourceRanges = segmentWords(source, language)
      .filter(part => part.word && part.normalized === normalized)
      .map(part => ({ start: part.index, end: part.index + part.text.length }));
    if (!sourceRanges.length) return [];

    const targetRanges = [];
    const tokenPattern = /(\d+):(\d+)-(\d+):(\d+)/g;
    let match;
    while ((match = tokenPattern.exec(String(projection))) !== null) {
      const sourceStart = Number(match[1]);
      const sourceEnd = Number(match[2]) + 1;
      const targetStart = Number(match[3]);
      const targetEnd = Number(match[4]) + 1;
      if (![sourceStart, sourceEnd, targetStart, targetEnd].every(Number.isFinite)) continue;
      const overlapsSelectedWord = sourceRanges.some(range => sourceStart < range.end && sourceEnd > range.start);
      if (overlapsSelectedWord) targetRanges.push({ start: targetStart, end: targetEnd });
    }
    return mergeTextRanges(targetRanges, target.length);
  }

  // Alignment is intentionally absent for a few canned Azure translations.
  // In that narrow case, exact dictionary alternatives are a safe fallback;
  // no stemming or fuzzy guessing is used.
  function exactTermRanges(text, terms, language) {
    const source = String(text || '');
    if (!source) return [];
    const normalizedTerms = new Set((terms || []).map(normalizeTerm).filter(Boolean));
    if (!normalizedTerms.size) return [];
    const ranges = segmentWords(source, language)
      .filter(part => part.word && normalizedTerms.has(part.normalized))
      .map(part => ({ start: part.index, end: part.index + part.text.length }));
    return mergeTextRanges(ranges, source.length);
  }

  function examplesForTerm(cues, term, currentIndex, limit = 6, language) {
    const normalized = normalizeTerm(term);
    if (!normalized) return [];
    const matches = [];
    for (let i = 0; i < (cues || []).length; i += 1) {
      const found = segmentWords(cues[i].text, language)
        .some(part => part.word && part.normalized === normalized);
      if (found) matches.push({ ...cues[i], cueIndex: i, distance: Math.abs(i - currentIndex) });
    }
    return matches
      .sort((a, b) => a.distance - b.distance || a.cueIndex - b.cueIndex)
      .slice(0, Math.max(1, limit))
      .sort((a, b) => a.cueIndex - b.cueIndex)
      .map(({ distance, ...cue }) => cue);
  }

  function inclusiveWordRange(anchorIndex, targetIndex) {
    const anchor = Math.max(0, Math.trunc(Number(anchorIndex) || 0));
    const target = Math.max(0, Math.trunc(Number(targetIndex) || 0));
    return { fromWordIndex: Math.min(anchor, target), toWordIndex: Math.max(anchor, target) };
  }

  function cueNavigationDelta(code) {
    if (code === 'KeyA') return -1;
    if (code === 'KeyD') return 1;
    return 0;
  }

  function batchTexts(items, maxItems = 25, maxChars = 5_000) {
    const batches = [];
    let batch = [];
    let chars = 0;
    for (const item of items || []) {
      const text = String(item?.text ?? item ?? '').trim();
      if (!text) continue;
      if (batch.length && (batch.length >= maxItems || chars + text.length > maxChars)) {
        batches.push(batch);
        batch = [];
        chars = 0;
      }
      batch.push(typeof item === 'object' ? { ...item, text } : { text });
      chars += text.length;
    }
    if (batch.length) batches.push(batch);
    return batches;
  }

  return {
    cleanCueText,
    finalizeCues,
    parseJson3Cues,
    parseVttCues,
    pairAdjacentAsrCues,
    findCueIndex,
    normalizeTerm,
    segmentWords,
    alignedTargetRanges,
    exactTermRanges,
    examplesForTerm,
    inclusiveWordRange,
    cueNavigationDelta,
    batchTexts,
    timestampToMs,
  };
});
