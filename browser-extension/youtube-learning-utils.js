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

  // Legacy pairwise assembly remains available to older consumers. The
  // interactive overlay now packs original timed fragments by measured width.
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

  function splitTextToMeasuredWidth(text, maxWidth, measureText, language = 'en') {
    const source = cleanCueText(text);
    const limit = Math.max(1, Number(maxWidth) || 1);
    const measure = typeof measureText === 'function'
      ? value => Math.max(0, Number(measureText(value)) || 0)
      : value => String(value || '').length;
    if (!source || measure(source) <= limit) return source ? [source] : [];

    const sentenceUnits = sentenceSegments(source, language).map(part => part.text).filter(Boolean);
    const units = sentenceUnits.length > 1 ? sentenceUnits : [source];
    const chunks = [];
    let pending = '';
    const flush = () => {
      const value = cleanCueText(pending);
      if (value) chunks.push(value);
      pending = '';
    };
    const appendWordUnits = (value) => {
      for (const match of String(value || '').matchAll(/\S+(?:\s+|$)/g)) {
        const token = match[0].trim();
        if (!token) continue;
        const candidate = pending ? `${pending} ${token}` : token;
        if (pending && measure(candidate) > limit) flush();
        pending = pending ? `${pending} ${token}` : token;
      }
    };

    for (const unit of units) {
      if (measure(unit) > limit) {
        flush();
        appendWordUnits(unit);
        flush();
        continue;
      }
      const candidate = pending ? `${pending} ${unit}` : unit;
      if (pending && measure(candidate) > limit) flush();
      pending = pending ? `${pending} ${unit}` : unit;
    }
    flush();
    return chunks.length ? chunks : [source];
  }

  function splitTimedCuesToFit(rawCues, options = {}) {
    const cues = finalizeCues(rawCues || []);
    const maxWidth = Math.max(1, Number(options.maxWidth) || 1);
    const measureText = typeof options.measureText === 'function'
      ? options.measureText
      : value => String(value || '').length;
    const language = options.language || 'en';
    const result = [];
    for (const cue of cues) {
      const chunks = splitTextToMeasuredWidth(cue.text, maxWidth, measureText, language);
      if (chunks.length <= 1) {
        result.push({ ...cue, sourceCueIndex: cue.index });
        continue;
      }
      const startMs = Number(cue.startMs);
      const endMs = Math.max(startMs + chunks.length, Number(cue.endMs));
      const durationMs = endMs - startMs;
      const weights = chunks.map(chunk => Math.max(1, measureText(chunk)));
      const totalWeight = weights.reduce((sum, value) => sum + value, 0);
      let elapsedWeight = 0;
      let chunkStart = startMs;
      chunks.forEach((chunk, index) => {
        elapsedWeight += weights[index];
        const remaining = chunks.length - index - 1;
        const proportionalEnd = index === chunks.length - 1
          ? endMs
          : Math.round(startMs + durationMs * elapsedWeight / totalWeight);
        const chunkEnd = index === chunks.length - 1
          ? endMs
          : Math.max(chunkStart + 1, Math.min(endMs - remaining, proportionalEnd));
        result.push({
          ...cue,
          startMs: chunkStart,
          endMs: chunkEnd,
          text: chunk,
          sourceCueIndex: cue.index,
        });
        chunkStart = chunkEnd;
      });
    }
    return result.map((cue, index) => ({ ...cue, index }));
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

  // Display lines follow the available width, not the source track's fragment
  // count. Preserve original cue boundaries in the timing map; only a cut
  // inside a source cue needs the same kind of estimated timing as splitting.
  function layoutTimedCuesToFit(rawCues, options = {}) {
    const source = finalizeCues(rawCues || []);
    const maxWidth = Math.max(1, Number(options.maxWidth) || 1);
    const maxGapMs = 20;
    const runs = [];
    for (const cue of source) {
      const run = runs.at(-1);
      if (run && cue.startMs - run.at(-1).endMs <= maxGapMs) run.push(cue);
      else runs.push([cue]);
    }
    const result = [];
    for (const run of runs) {
      let cursor = 0;
      const spans = run.map(cue => {
        const start = cursor;
        cursor += cue.text.replace(/\s/g, '').length;
        return { cue, start, end: cursor };
      });
      const chunks = splitTextToMeasuredWidth(run.map(cue => cue.text).join(' '), maxWidth,
        options.measureText, options.language || 'en');
      let from = 0, spanIndex = 0;
      const mapped = chunks.map(text => {
        const to = from + text.replace(/\s/g, '').length;
        while (spanIndex + 1 < spans.length && spans[spanIndex].end <= from) spanIndex++;
        const first = spans[spanIndex];
        let lastIndex = spanIndex;
        while (lastIndex + 1 < spans.length && spans[lastIndex].end < to) lastIndex++;
        const last = spans[lastIndex];
        const time = (span, offset) => Math.round(span.cue.startMs
          + (span.cue.endMs - span.cue.startMs) * (offset - span.start) / (span.end - span.start));
        const value = { text, startMs: time(first, from), endMs: time(last, to),
          sourceCueIndex: first.cue.index, sourceCueEndIndex: last.cue.index };
        from = to;
        return value;
      });
      mapped.forEach((cue, index) => {
        const next = mapped[index + 1];
        if (next && next.startMs > cue.startMs) cue.endMs = Math.min(cue.endMs, next.startMs);
        cue.endMs = Math.max(cue.startMs + 1, cue.endMs);
        result.push({ ...cue, index: result.length });
      });
    }
    return result;
  }

  function normalizeTerm(value) {
    return String(value || '')
      .normalize('NFKC')
      .replace(/[\u2010\u2011]/g, '-')
      .trim()
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}'’-]+$/gu, '')
      .toLocaleLowerCase();
  }

  function mergeHyphenatedWordParts(parts) {
    const merged = [];
    for (let index = 0; index < parts.length;) {
      const first = parts[index];
      if (!first?.word) {
        merged.push(first);
        index += 1;
        continue;
      }
      let text = first.text;
      let cursor = index + 1;
      while (cursor + 1 < parts.length) {
        const joiner = parts[cursor];
        const next = parts[cursor + 1];
        const adjacent = joiner?.index === first.index + text.length
          && next?.index === joiner.index + joiner.text.length;
        if (!adjacent || joiner.word || !/^[\-\u2010\u2011]$/.test(joiner.text) || !next?.word) break;
        text += `${joiner.text}${next.text}`;
        cursor += 2;
      }
      merged.push({
        ...first,
        text,
        normalized: normalizeTerm(text),
      });
      index = cursor;
    }
    return merged;
  }

  function segmentWords(text, language) {
    const source = String(text || '');
    try {
      const segmenter = new Intl.Segmenter(language || undefined, { granularity: 'word' });
      return mergeHyphenatedWordParts(Array.from(segmenter.segment(source)).map(part => ({
        text: part.segment,
        index: part.index,
        word: part.isWordLike === true,
        normalized: part.isWordLike ? normalizeTerm(part.segment) : '',
      })));
    } catch {
      let offset = 0;
      return mergeHyphenatedWordParts(source.split(/(\s+)/).map((part) => {
        const result = {
          text: part,
          index: offset,
          word: /[\p{L}\p{N}]/u.test(part),
          normalized: normalizeTerm(part),
        };
        offset += part.length;
        return result;
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
    const sourceWords = segmentWords(source, language).filter(part => part.word);
    const rawTerms = Array.isArray(terms) ? terms : [terms];
    const ranges = [];
    for (const rawTerm of rawTerms) {
      const termWords = segmentWords(String(rawTerm || ''), language)
        .filter(part => part.word)
        .map(part => part.normalized);
      if (!termWords.length) continue;
      for (let index = 0; index <= sourceWords.length - termWords.length; index += 1) {
        const matches = termWords.every((term, offset) => sourceWords[index + offset]?.normalized === term);
        if (!matches) continue;
        const first = sourceWords[index];
        const last = sourceWords[index + termWords.length - 1];
        ranges.push({ start: first.index, end: last.index + last.text.length });
      }
    }
    return mergeTextRanges(ranges, source.length);
  }

  function snapTextRangeToWords(text, start, end) {
    const source = String(text || '');
    const from = Math.max(0, Math.min(source.length, Math.trunc(Number(start) || 0)));
    const to = Math.max(0, Math.min(source.length, Math.trunc(Number(end) || 0)));
    if (to <= from) return null;
    const words = Array.from(source.matchAll(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu), match => ({
      start: match.index,
      end: match.index + match[0].length,
    })).filter(word => word.start < to && word.end > from);
    if (!words.length) return null;
    let first = words[0];
    const last = words[words.length - 1];
    if (from > first.start && words.length > 1) first = words[1];
    return first ? { start: first.start, end: last.end } : null;
  }

  function literalSpacingFromReference(literalText, referenceText, rawAlignments = []) {
    const literal = cleanCueText(literalText);
    const reference = cleanCueText(referenceText);
    const compact = value => String(value || '').replace(/\s+/gu, '').toLocaleLowerCase();
    if (!literal || !reference || compact(literal) !== compact(reference)) {
      return { literalText: literal, alignments: Array.isArray(rawAlignments) ? rawAlignments : [] };
    }
    const countNonSpaceBefore = (value, boundary) => {
      let count = 0;
      const limit = Math.max(0, Math.min(value.length, Math.trunc(Number(boundary) || 0)));
      for (let index = 0; index < limit; index += 1) {
        if (!/\s/u.test(value[index])) count += 1;
      }
      return count;
    };
    const referenceBoundary = (compactCount, skipFollowingSpace) => {
      let count = 0;
      for (let index = 0; index <= reference.length; index += 1) {
        if (count === compactCount) {
          if (!skipFollowingSpace) return index;
          let cursor = index;
          while (cursor < reference.length && /\s/u.test(reference[cursor])) cursor += 1;
          return cursor;
        }
        if (index < reference.length && !/\s/u.test(reference[index])) count += 1;
      }
      return reference.length;
    };
    const alignments = (Array.isArray(rawAlignments) ? rawAlignments : []).map(item => {
      const sourceWordIndex = Number(item?.sourceWordIndex);
      const rawStart = Number(item?.targetStart);
      const rawEnd = Number(item?.targetEnd);
      if (!Number.isInteger(rawStart) || !Number.isInteger(rawEnd)) return item;
      return {
        ...item,
        sourceWordIndex,
        targetStart: referenceBoundary(countNonSpaceBefore(literal, rawStart), true),
        targetEnd: referenceBoundary(countNonSpaceBefore(literal, rawEnd), false),
      };
    });
    return { literalText: reference, alignments };
  }

  function examplesForTerm(cues, term, currentIndex, limit = 6, language) {
    const normalizedTerms = new Set((Array.isArray(term) ? term : [term]).map(normalizeTerm).filter(Boolean));
    if (!normalizedTerms.size) return [];
    const matches = [];
    for (let i = 0; i < (cues || []).length; i += 1) {
      const found = segmentWords(cues[i].text, language)
        .some(part => part.word && normalizedTerms.has(part.normalized));
      if (found) matches.push({ ...cues[i], cueIndex: i, distance: Math.abs(i - currentIndex) });
    }
    return matches
      .sort((a, b) => a.distance - b.distance || a.cueIndex - b.cueIndex)
      .slice(0, Math.max(1, limit))
      .sort((a, b) => a.cueIndex - b.cueIndex)
      .map(({ distance, ...cue }) => cue);
  }

  function expressionMatchesForCue(cues, currentCueIndex, expressions, language, windowRadius = 4) {
    const list = Array.isArray(cues) ? cues : [];
    const cueIndex = Math.trunc(Number(currentCueIndex));
    if (!Number.isInteger(cueIndex) || cueIndex < 0 || cueIndex >= list.length) return [];
    const radius = Math.max(1, Math.min(12, Math.trunc(Number(windowRadius) || 4)));
    const fromCue = Math.max(0, cueIndex - radius);
    const toCue = Math.min(list.length - 1, cueIndex + radius);
    const tokens = [];
    for (let index = fromCue; index <= toCue; index += 1) {
      let wordIndex = 0;
      for (const part of segmentWords(list[index]?.text || '', language)) {
        if (!part.word) continue;
        tokens.push({ cueIndex: index, wordIndex, normalized: part.normalized, text: part.text });
        wordIndex += 1;
      }
    }
    const candidates = [];
    const seen = new Set();
    for (const expression of expressions || []) {
      const forms = Array.from(new Set([
        expression?.sourceText,
        expression?.lemma,
        ...(expression?.observedForms || []),
        ...(expression?.forms || []),
      ].map(value => String(value || '').trim()).filter(Boolean)));
      for (const form of forms) {
        const formTokens = segmentWords(form, language).filter(part => part.word).map(part => part.normalized);
        if (formTokens.length < 2) continue;
        for (let start = 0; start <= tokens.length - formTokens.length; start += 1) {
          if (!formTokens.every((token, offset) => tokens[start + offset]?.normalized === token)) continue;
          const matchedTokens = tokens.slice(start, start + formTokens.length);
          const currentTokens = matchedTokens.filter(token => token.cueIndex === cueIndex);
          if (!currentTokens.length) continue;
          const key = `${expression?.key || form}:${start}:${formTokens.length}`;
          if (seen.has(key)) continue;
          seen.add(key);
          candidates.push({
            key: expression?.key || form,
            entry: expression,
            form,
            tokenLength: formTokens.length,
            fromCueIndex: matchedTokens[0].cueIndex,
            toCueIndex: matchedTokens[matchedTokens.length - 1].cueIndex,
            fromWordIndex: matchedTokens[0].wordIndex,
            toWordIndex: matchedTokens[matchedTokens.length - 1].wordIndex,
            wordIndexes: currentTokens.map(token => token.wordIndex),
            matchedText: matchedTokens.map(token => token.text).join(' '),
          });
        }
      }
    }
    const claimed = new Set();
    const selected = [];
    for (const candidate of candidates.sort((left, right) => right.tokenLength - left.tokenLength)) {
      if (candidate.wordIndexes.some(index => claimed.has(index))) continue;
      candidate.wordIndexes.forEach(index => claimed.add(index));
      selected.push(candidate);
    }
    return selected;
  }

  function pendingSaveWordIndexes(cues, cueIndex, operations, language) {
    const indexes = new Set();
    for (const operation of operations || []) {
      if (!['preparing', 'saving'].includes(operation?.phase)) continue;
      // Match each operation separately: overlapping simultaneous saves must
      // keep the union of their components, rather than claim each other's words.
      const expression = { ...operation, sourceText: operation.term || operation.key };
      for (const match of expressionMatchesForCue(cues, cueIndex, [expression], language)) {
        for (const index of match.wordIndexes) indexes.add(index);
      }
    }
    return Array.from(indexes);
  }

  function sentenceSegments(text, language = 'en') {
    const source = cleanCueText(text);
    if (!source) return [];
    try {
      const segmenter = new Intl.Segmenter(language || undefined, { granularity: 'sentence' });
      return Array.from(segmenter.segment(source), part => ({
        text: part.segment.trim(),
        index: part.index,
        end: part.index + part.segment.length,
      })).filter(part => part.text);
    } catch {
      const parts = [];
      const pattern = /[^.!?]+(?:[.!?]+(?:[\"'”’»\)\]]+)?|$)/g;
      let match;
      while ((match = pattern.exec(source)) !== null) {
        const textPart = match[0].trim();
        if (textPart) parts.push({ text: textPart, index: match.index, end: match.index + match[0].length });
        if (!match[0]) break;
      }
      return parts;
    }
  }

  function sentenceIsComplete(text, language = 'en') {
    const source = cleanCueText(text);
    if (!source || /^(?:\.{3}|…)|(?:\.{3}|…)$/.test(source)) return false;
    const parts = sentenceSegments(source, language);
    return parts.length === 1 && /[.!?](?:[\"'”’»\)\]]+)?$/.test(parts[0].text);
  }

  function sentenceDetailsForTerm(text, term, language = 'en', sourceWordIndex) {
    const source = cleanCueText(text);
    const normalized = normalizeTerm(term);
    if (!source || !normalized) return { text: source, ordinal: 0, complete: sentenceIsComplete(source, language) };
    const parts = sentenceSegments(source, language);
    const indexed = Number.isInteger(sourceWordIndex)
      ? segmentWords(source, language).filter(part => part.word)[sourceWordIndex] : null;
    const ordinal = indexed?.normalized === normalized
      ? parts.findIndex(part => part.index <= indexed.index && part.end > indexed.index)
      : parts.findIndex(part => segmentWords(part.text, language)
        .some(word => word.word && word.normalized === normalized));
    const selected = ordinal >= 0 ? parts[ordinal].text : source;
    return { text: selected.trim(), ordinal: Math.max(0, ordinal), complete: sentenceIsComplete(selected, language) };
  }

  function sentenceForTerm(text, term, language = 'en') {
    return sentenceDetailsForTerm(text, term, language).text;
  }

  function termFamilyForms(term) {
    const base = normalizeTerm(term);
    if (!base) return new Set();
    const lemmas = new Set([base]);
    if (base.endsWith('ed') && base.length > 4) {
      lemmas.add(base.slice(0, -2));
      lemmas.add(base.slice(0, -1));
    }
    if (base.endsWith('ing') && base.length > 5) {
      const stem = base.slice(0, -3);
      lemmas.add(stem);
      lemmas.add(`${stem}e`);
      if (stem.length > 2 && stem.at(-1) === stem.at(-2)) lemmas.add(stem.slice(0, -1));
    }
    const forms = new Set([base]);
    for (const lemma of lemmas) {
      if (!lemma) continue;
      forms.add(lemma);
      forms.add(`${lemma}s`);
      forms.add(`${lemma}ed`);
      forms.add(`${lemma}ing`);
      if (lemma.endsWith('e')) {
        forms.add(`${lemma}d`);
        forms.add(`${lemma.slice(0, -1)}ing`);
      }
      const last = lemma.at(-1);
      if (last && /[b-df-hj-np-tv-z]/.test(last)) {
        forms.add(`${lemma}${last}ed`);
        forms.add(`${lemma}${last}ing`);
      }
    }
    const irregular = { make: ['made'], find: ['found'], care: ['cared'], wrap: ['wrapped', 'wrapping'] };
    for (const form of irregular[base] || []) forms.add(form);
    return forms;
  }

  function sentenceContainsTerm(text, term, language = 'en') {
    const forms = termFamilyForms(term);
    return forms.size > 0 && segmentWords(text, language)
      .some((part) => part.word && forms.has(part.normalized));
  }

  function sentenceForCueTerm(cues, cueIndex, term, language = 'en', sourceWordIndex) {
    const list = Array.isArray(cues) ? cues : [];
    const selectedIndex = Math.trunc(Number(cueIndex));
    const selectedCue = list[selectedIndex];
    const normalized = normalizeTerm(term);
    if (!selectedCue || !normalized) return sentenceForTerm(selectedCue?.text || '', term, language);
    const chunks = [];
    const offsets = [];
    let cursor = 0;
    for (let index = 0; index < list.length; index += 1) {
      const text = cleanCueText(list[index]?.text || '');
      if (!text) continue;
      if (chunks.length) cursor += 1;
      offsets[index] = cursor;
      chunks.push(text);
      cursor += text.length;
    }
    const joined = chunks.join(' ');
    const selectedText = cleanCueText(selectedCue.text);
    const words = segmentWords(selectedText, language).filter(part => part.word);
    const indexed = Number.isInteger(sourceWordIndex) ? words[sourceWordIndex] : null;
    const localTerm = indexed?.normalized === normalized ? indexed : words.find(part => part.normalized === normalized);
    const selectedOffset = offsets[selectedIndex];
    if (!joined || !localTerm || !Number.isFinite(selectedOffset)) return sentenceForTerm(selectedText, term, language);
    const absoluteTermIndex = selectedOffset + localTerm.index;
    const sentence = sentenceSegments(joined, language)
      .find(part => part.index <= absoluteTermIndex && part.end >= absoluteTermIndex + localTerm.text.length);
    return sentence?.text?.trim() || sentenceForTerm(selectedText, term, language);
  }

  function parallelSentenceForTerm(sourceText, targetText, term, sourceLanguage = 'en', targetLanguage = 'ru', sourceWordIndex) {
    const source = sentenceDetailsForTerm(sourceText, term, sourceLanguage, sourceWordIndex);
    const targetParts = sentenceSegments(targetText, targetLanguage);
    const target = targetParts[source.ordinal]?.text || '';
    return {
      sourceText: source.text,
      translation: sentenceIsComplete(target, targetLanguage) ? target : '',
      complete: source.complete,
    };
  }

  function textAroundExactTerm(sentence, rawTerm, language) {
    const source = cleanCueText(sentence);
    const forms = termFamilyForms(rawTerm);
    const match = segmentWords(source, language).find(part => part.word && forms.has(part.normalized));
    if (!match) return { prefix: source, term: '', suffix: '' };
    return {
      prefix: source.slice(0, match.index),
      term: source.slice(match.index, match.index + match.text.length),
      suffix: source.slice(match.index + match.text.length),
    };
  }

  function dictionaryExampleRows(payload, pairs, sourceLanguage = 'en', targetLanguage = 'ru', usedSourceSentences = new Set()) {
    const results = Array.isArray(payload?.examples) ? payload.examples : [];
    const usedSources = usedSourceSentences instanceof Set ? usedSourceSentences : new Set();
    const rows = [];
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      const pair = pairs?.[index] || {};
      let selected = null;
      for (const example of Array.isArray(result?.examples) ? result.examples : []) {
        const fullSource = `${example?.sourcePrefix || ''}${example?.sourceTerm || ''}${example?.sourceSuffix || ''}`.trim();
        const fullTarget = `${example?.targetPrefix || ''}${example?.targetTerm || ''}${example?.targetSuffix || ''}`.trim();
        const sourceDetails = sentenceDetailsForTerm(fullSource, example?.sourceTerm || result?.normalizedSource || pair.text, sourceLanguage);
        const targetDetails = sentenceDetailsForTerm(fullTarget, example?.targetTerm || result?.normalizedTarget || pair.translation, targetLanguage);
        if (!sourceDetails.complete || !targetDetails.complete) continue;
        if (!sentenceContainsTerm(sourceDetails.text, example?.sourceTerm || result?.normalizedSource || pair.text, sourceLanguage)) continue;
        if (usedSources.has(sourceDetails.text.toLocaleLowerCase('en-US'))) continue;
        selected = {
          source: sourceDetails.text,
          target: targetDetails.text,
          sourceTerm: example?.sourceTerm || result?.normalizedSource || pair.text,
          targetTerm: example?.targetTerm || result?.normalizedTarget || pair.translation,
        };
        break;
      }
      if (!selected) {
        const source = cleanCueText(pair?.example || '');
        const target = cleanCueText(pair?.exampleTranslation || '');
        if (sentenceIsComplete(source, sourceLanguage) && sentenceIsComplete(target, targetLanguage)) {
          if (!usedSources.has(source.toLocaleLowerCase('en-US'))) {
            selected = { source, target, sourceTerm: pair.text, targetTerm: pair.translation };
          }
        }
      }
      if (!selected) continue;
      usedSources.add(selected.source.toLocaleLowerCase('en-US'));
      const sourceParts = textAroundExactTerm(selected.source, selected.sourceTerm, sourceLanguage);
      const targetParts = textAroundExactTerm(selected.target, selected.targetTerm, targetLanguage);
      if (!sourceParts.term) continue;
      rows.push({
        pairIndex: index,
        label: pair.label || '',
        sourceText: selected.source,
        targetText: selected.target,
        sourcePrefix: sourceParts.prefix,
        sourceTerm: sourceParts.term,
        sourceSuffix: sourceParts.suffix,
        targetPrefix: targetParts.prefix,
        targetTerm: targetParts.term,
        targetSuffix: targetParts.suffix,
        meaning: result?.normalizedTarget || pair.translation || selected.targetTerm,
        meanings: pair.targets || [result?.normalizedTarget || pair.translation || selected.targetTerm].filter(Boolean),
        partOfSpeech: pair.pos || '',
      });
    }
    return rows;
  }

  function inclusiveWordRange(anchorIndex, targetIndex) {
    const anchor = Math.max(0, Math.trunc(Number(anchorIndex) || 0));
    const target = Math.max(0, Math.trunc(Number(targetIndex) || 0));
    return { fromWordIndex: Math.min(anchor, target), toWordIndex: Math.max(anchor, target) };
  }

  function comparePhrasePoints(left, right) {
    const cueDelta = Math.trunc(Number(left?.cueIndex) || 0) - Math.trunc(Number(right?.cueIndex) || 0);
    if (cueDelta) return cueDelta;
    return Math.trunc(Number(left?.wordIndex) || 0) - Math.trunc(Number(right?.wordIndex) || 0);
  }

  function cueWordRangeForPhrase(anchor, focus, cueIndex, wordCount) {
    const count = Math.max(0, Math.trunc(Number(wordCount) || 0));
    const currentCue = Math.trunc(Number(cueIndex));
    if (!anchor || !focus || !count || !Number.isInteger(currentCue)) return null;
    const [start, end] = comparePhrasePoints(anchor, focus) <= 0
      ? [anchor, focus]
      : [focus, anchor];
    if (currentCue < start.cueIndex || currentCue > end.cueIndex) return null;
    const clampWord = value => Math.max(0, Math.min(count - 1, Math.trunc(Number(value) || 0)));
    if (start.cueIndex === end.cueIndex) {
      return {
        fromWordIndex: clampWord(start.wordIndex),
        toWordIndex: clampWord(end.wordIndex),
      };
    }
    if (currentCue === start.cueIndex) {
      return { fromWordIndex: clampWord(start.wordIndex), toWordIndex: count - 1 };
    }
    if (currentCue === end.cueIndex) {
      return { fromWordIndex: 0, toWordIndex: clampWord(end.wordIndex) };
    }
    return { fromWordIndex: 0, toWordIndex: count - 1 };
  }

  function phraseTextAcrossCues(cues, anchor, focus, language) {
    const list = Array.isArray(cues) ? cues : [];
    if (!anchor || !focus || !list.length) return '';
    const [start, end] = comparePhrasePoints(anchor, focus) <= 0
      ? [anchor, focus]
      : [focus, anchor];
    const firstCue = Math.max(0, Math.min(list.length - 1, Math.trunc(Number(start.cueIndex) || 0)));
    const lastCue = Math.max(0, Math.min(list.length - 1, Math.trunc(Number(end.cueIndex) || 0)));
    if (firstCue > lastCue) return '';
    const chunks = [];
    for (let cueIndex = firstCue; cueIndex <= lastCue; cueIndex += 1) {
      const text = String(list[cueIndex]?.text || '');
      const words = segmentWords(text, language).filter(part => part.word);
      const range = cueWordRangeForPhrase(start, end, cueIndex, words.length);
      if (!range) continue;
      const first = words[range.fromWordIndex];
      const last = words[range.toWordIndex];
      if (!first || !last) continue;
      const startOffset = cueIndex === firstCue ? first.index : 0;
      const endOffset = cueIndex === lastCue ? last.index + last.text.length : text.length;
      chunks.push(text.slice(startOffset, endOffset).trim());
    }
    return chunks.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }

  function annotatedTextSegments(text, annotations) {
    const source = String(text || '');
    if (!source) return [];
    const normalized = (annotations || [])
      .map(item => ({
        start: Math.max(0, Math.min(source.length, Math.trunc(Number(item?.start) || 0))),
        end: Math.max(0, Math.min(source.length, Math.trunc(Number(item?.end) || 0))),
        state: item?.state === 'saved' || item?.state === 'known' ? item.state : '',
        active: item?.active === true,
      }))
      .filter(item => item.end > item.start && (item.state || item.active));
    if (!normalized.length) return [{ start: 0, end: source.length, text: source, state: '', active: false }];
    const boundaries = Array.from(new Set([0, source.length, ...normalized.flatMap(item => [item.start, item.end])]))
      .sort((a, b) => a - b);
    const segments = [];
    for (let index = 0; index < boundaries.length - 1; index += 1) {
      const start = boundaries[index];
      const end = boundaries[index + 1];
      if (end <= start) continue;
      const covering = normalized.filter(item => item.start < end && item.end > start);
      const active = covering.some(item => item.active);
      const state = covering.some(item => item.state === 'saved')
        ? 'saved'
        : covering.some(item => item.state === 'known') ? 'known' : '';
      const previous = segments[segments.length - 1];
      if (previous && previous.state === state && previous.active === active) {
        previous.end = end;
        previous.text += source.slice(start, end);
      } else {
        segments.push({ start, end, text: source.slice(start, end), state, active });
      }
    }
    return segments;
  }

  function cueNavigationDelta(code) {
    if (code === 'KeyA' || code === 'BracketLeft') return -1;
    if (code === 'KeyD' || code === 'BracketRight') return 1;
    return 0;
  }

  function dictionaryMeaningPairs(dictionary, limit = Infinity) {
    const source = normalizeTerm(dictionary?.normalizedSource || dictionary?.displaySource || '');
    const translations = Array.isArray(dictionary?.translations) ? dictionary.translations : [];
    const clusters = [];
    const targetSeen = new Set();
    for (const translation of translations) {
      const target = String(translation?.normalizedTarget || translation?.displayTarget || '').trim();
      const normalizedTarget = normalizeTerm(target);
      if (!target || targetSeen.has(normalizedTarget)) continue;
      targetSeen.add(normalizedTarget);
      const concepts = new Set((translation?.backTranslations || [])
        .map(item => normalizeTerm(item?.normalizedText || item?.displayText || ''))
        .filter(value => value && value !== source));
      const pos = String(translation?.posTag || '').toUpperCase();
      let cluster = null;
      for (const candidate of clusters) {
        if (candidate.pos && pos && candidate.pos !== pos) continue;
        const intersection = Array.from(concepts).filter(value => candidate.concepts.has(value)).length;
        const unionSize = new Set([...concepts, ...candidate.concepts]).size;
        if (intersection >= 2 || (intersection >= 1 && unionSize <= 4)) {
          cluster = candidate;
          break;
        }
      }
      if (cluster) {
        for (const concept of concepts) cluster.concepts.add(concept);
        cluster.targets.push(target);
        continue;
      }
      clusters.push({
        text: dictionary?.normalizedSource || dictionary?.displaySource || source,
        translation: target,
        targets: [target],
        pos,
        concepts,
      });
    }
    const bounded = Number.isFinite(Number(limit))
      ? clusters.slice(0, Math.max(1, Number(limit)))
      : clusters;
    return bounded.map(({ concepts, ...pair }) => ({ ...pair, label: pair.targets.join(' / ') }));
  }

  function quickWordTranslationRows(payload, fallbacks = [], limit = 3, sourceText = '') {
    const rows = [];
    const seen = new Set();
    const normalizedSource = normalizeTerm(sourceText);
    let sourceEcho = null;
    const push = (value, partOfSpeech = '') => {
      const text = String(value || '').replace(/\s+/g, ' ').trim();
      const key = text.toLocaleLowerCase('ru-RU');
      if (!text || seen.has(key)) return;
      if (normalizedSource && normalizeTerm(text) === normalizedSource) {
        sourceEcho ||= { value: text, partOfSpeech: String(partOfSpeech || '').trim() };
        return;
      }
      seen.add(key);
      rows.push({ value: text, partOfSpeech: String(partOfSpeech || '').trim() });
    };
    for (const item of Array.isArray(payload?.dictionary?.translations) ? payload.dictionary.translations : []) {
      push(item?.displayTarget || item?.normalizedTarget, item?.posTag);
    }
    push(payload?.fallback_translation, '');
    for (const fallback of Array.isArray(fallbacks) ? fallbacks : [fallbacks]) {
      if (fallback && typeof fallback === 'object') {
        push(fallback.value || fallback.translation, fallback.partOfSpeech || fallback.pos);
      } else {
        push(fallback, '');
      }
    }
    if (!rows.length && sourceEcho) rows.push(sourceEcho);
    return rows.slice(0, Math.max(1, Math.min(3, Math.trunc(Number(limit) || 3))));
  }

  function quickWordPopoverLeft(input = {}) {
    const margin = Math.max(0, Number(input.margin) || 0);
    const viewportWidth = Math.max(1, Number(input.viewportWidth) || 1);
    const popoverWidth = Math.max(0, Number(input.popoverWidth) || 0);
    const anchorLeft = Number(input.anchorLeft) || 0;
    const anchorWidth = Math.max(0, Number(input.anchorWidth) || 0);
    const centered = anchorLeft + anchorWidth / 2 - popoverWidth / 2;
    const maxLeft = Math.max(margin, viewportWidth - popoverWidth - margin);
    return Math.max(margin, Math.min(maxLeft, centered));
  }

  function mergeDictionaryMeaningPairs(dictionary, preferredPairs = [], invalidValues = []) {
    const invalid = new Set((Array.isArray(invalidValues) ? invalidValues : []).map((value) => normalizeTerm(value)).filter(Boolean));
    const merged = (Array.isArray(preferredPairs) ? preferredPairs : []).map((pair) => ({
      ...pair,
      targets: Array.from(new Set((pair?.targets || [pair?.translation]).filter(Boolean))),
    }));
    const covered = new Set(merged.flatMap((pair) => pair.targets).map((target) => normalizeTerm(target)));
    for (const fallback of dictionaryMeaningPairs(dictionary)) {
      const uncovered = fallback.targets.filter((target) => !covered.has(normalizeTerm(target)) && !invalid.has(normalizeTerm(target)));
      if (!uncovered.length) continue;
      const overlapping = merged.find((pair) => pair.targets.some((target) => fallback.targets.includes(target)));
      if (overlapping) overlapping.targets = Array.from(new Set([...overlapping.targets, ...uncovered]));
      else merged.push({ ...fallback, label: fallback.label || uncovered.join(' / '), targets: uncovered });
      uncovered.forEach((target) => covered.add(normalizeTerm(target)));
    }
    return merged;
  }

  function classifyRepeatedWordClick(previous, cueIndex, wordIndex, clickedAt, thresholdMs = 460) {
    const same = previous?.cueIndex === cueIndex && previous?.wordIndex === wordIndex;
    if (!same) return 'different';
    return Number(clickedAt) - Number(previous?.at || 0) <= thresholdMs ? 'quick' : 'slow';
  }

  function dismissalPlaybackOwner({ via = 'explicit', insidePlayer = false } = {}) {
    return via === 'outside-pointer' && insidePlayer ? 'native-player' : 'extension';
  }

  function overlayDeactivationPlan(state = {}) {
    const clearPhrase = state.phraseSelectionOpen === true || state.hasPhraseSelection === true;
    const closePopover = state.wordPopoverOpen === true || state.hasWordPopover === true;
    const releaseHover = state.overlayActive === true
      || state.subtitleHovered === true
      || state.pausedForSubtitleHover === true
      || clearPhrase
      || closePopover;
    return { clearPhrase, closePopover, releaseHover };
  }

  function lexemeRefinementNeeded({ storedKey = '', nextKey = '', previous = {}, next = {} } = {}) {
    return storedKey !== nextKey
      || previous.analysisConfidence !== next.analysisConfidence
      || previous.partOfSpeech !== next.partOfSpeech;
  }

  function sourceWordIsActive({ currentCueIndex, wordIndex, popoverCueIndex, popoverWordIndex } = {}) {
    return Number.isInteger(currentCueIndex)
      && Number.isInteger(wordIndex)
      && currentCueIndex === popoverCueIndex
      && wordIndex === popoverWordIndex;
  }

  function cueWindowItems(cues, currentIndex, neighborCount = 0, direction = 'left') {
    const list = Array.isArray(cues) ? cues : [];
    const index = Math.trunc(Number(currentIndex));
    if (!Number.isInteger(index) || index < 0 || index >= list.length) return [];
    const count = Math.max(0, Math.min(10, Math.trunc(Number(neighborCount) || 0)));
    const from = direction === 'right' ? index : Math.max(0, index - count);
    const to = direction === 'right' ? Math.min(list.length - 1, index + count) : index;
    return list.slice(from, to + 1)
      .map(cue => ({ ...cue, text: cleanCueText(cue?.text || '') }))
      .filter(cue => cue.text);
  }

  function cueWindowText(cues, currentIndex, neighborCount = 0, direction = 'left') {
    return cueWindowItems(cues, currentIndex, neighborCount, direction)
      .map(cue => cue.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function subtitleCardPlacement(input = {}) {
    const rootWidth = Math.max(1, Number(input.rootWidth) || 1);
    const rootHeight = Math.max(1, Number(input.rootHeight) || 1);
    const cardWidth = Math.max(0, Math.min(rootWidth, Number(input.cardWidth) || 0));
    const cardHeight = Math.max(0, Math.min(rootHeight, Number(input.cardHeight) || 0));
    const sideInset = Math.max(0, Number(input.sideInset) || 12);
    const verticalInset = Math.max(0, Number(input.verticalInset) || 12);
    const rawOffsetX = Math.max(-1, Math.min(1, Number(input.offsetX) || 0));
    const rawOffsetY = Math.max(-1, Math.min(1, Number(input.offsetY) || 0));
    const baseTop = input.position === 'top'
      ? rootHeight * 0.08
      : rootHeight - cardHeight - rootHeight * 0.10;
    const minCenter = sideInset + cardWidth / 2;
    const maxCenter = rootWidth - sideInset - cardWidth / 2;
    const desiredCenter = rootWidth * (0.5 + rawOffsetX);
    const left = minCenter <= maxCenter
      ? Math.max(minCenter, Math.min(maxCenter, desiredCenter))
      : rootWidth / 2;
    const maxTop = Math.max(verticalInset, rootHeight - cardHeight - verticalInset);
    const top = Math.max(verticalInset, Math.min(maxTop, baseTop + rawOffsetY * rootHeight));
    return {
      left,
      top,
      offsetX: (left - rootWidth * 0.5) / rootWidth,
      offsetY: (top - baseTop) / rootHeight,
      baseTop,
    };
  }

  function subtitleWidthLayout(input = {}) {
    const rootWidth = Math.max(1, Number(input.rootWidth) || 1);
    const sideInset = Math.max(0, Number(input.sideInset) || 68);
    const requestedWidth = Math.max(1, Number(input.requestedWidth) || 1600);
    const maxWidth = Math.max(1, rootWidth - sideInset * 2);
    const width = Math.min(requestedWidth, maxWidth);
    return {
      width,
      maxWidth,
      sideInset,
      clamped: width < requestedWidth,
    };
  }

  function obstacleAvoidingTop(input = {}) {
    const containerHeight = Math.max(1, Number(input.containerHeight) || 1);
    const itemHeight = Math.max(1, Number(input.itemHeight) || 1);
    const inset = Math.max(0, Number(input.inset) || 12);
    const gap = Math.max(0, Number(input.gap) || 8);
    const minTop = inset;
    const maxTop = Math.max(minTop, containerHeight - itemHeight - inset);
    const preferred = Math.max(minTop, Math.min(maxTop, Number(input.preferredTop) || 0));
    const obstacleTop = Number(input.obstacleTop);
    const obstacleBottom = Number(input.obstacleBottom);
    if (!Number.isFinite(obstacleTop) || !Number.isFinite(obstacleBottom)
        || preferred + itemHeight + gap <= obstacleTop || preferred >= obstacleBottom + gap) {
      return preferred;
    }
    const above = obstacleTop - gap - itemHeight;
    const below = obstacleBottom + gap;
    const candidates = [above, below].filter(top => top >= minTop && top <= maxTop);
    if (!candidates.length) return preferred;
    return candidates.sort((left, right) => Math.abs(left - preferred) - Math.abs(right - preferred))[0];
  }

  function fitFloatingElement(panel, anchor, { margin = 12, gap = 8, heightLimit = 760, preferBelow = false, scroll = true, bottomLimit } = {}) {
    if (!panel?.isConnected || !anchor?.getBoundingClientRect) return null;
    const win = panel.ownerDocument.defaultView, viewport = win.visualViewport;
    const bounds = { left: viewport?.offsetLeft || 0, top: viewport?.offsetTop || 0,
      right: (viewport?.offsetLeft || 0) + Math.min(win.innerWidth, viewport?.width || win.innerWidth),
      bottom: (viewport?.offsetTop || 0) + Math.min(win.innerHeight, viewport?.height || win.innerHeight) };
    if (Number.isFinite(bottomLimit)) bounds.bottom = Math.min(bounds.bottom, bottomLimit);
    // An inline panel also has to fit ancestors which actually clip its paint.
    for (let node = panel.parentElement; node && node !== panel.ownerDocument.documentElement; node = node.parentElement) {
      const style = win.getComputedStyle(node), rect = node.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      const sx = node.offsetWidth ? rect.width / node.offsetWidth : 1, sy = node.offsetHeight ? rect.height / node.offsetHeight : 1;
      const left = rect.left + (node.clientLeft || 0) * sx, top = rect.top + (node.clientTop || 0) * sy;
      if (/hidden|clip|auto|scroll/.test(style.overflowX)) { bounds.left = Math.max(bounds.left, left); bounds.right = Math.min(bounds.right, left + node.clientWidth * sx); }
      if (/hidden|clip|auto|scroll/.test(style.overflowY)) { bounds.top = Math.max(bounds.top, top); bounds.bottom = Math.min(bounds.bottom, top + node.clientHeight * sy); }
    }
    const parent = panel.offsetParent;
    const parentRect = parent?.getBoundingClientRect();
    const fixed = win.getComputedStyle(panel).position === 'fixed' && (!parent || parent === panel.ownerDocument.body);
    const scaleX = !fixed && parent?.offsetWidth ? parentRect.width / parent.offsetWidth : 1;
    const scaleY = !fixed && parent?.offsetHeight ? parentRect.height / parent.offsetHeight : 1;
    const inset = Math.max(0, Math.min(margin, (bounds.right - bounds.left - 1) / 2, (bounds.bottom - bounds.top - 1) / 2));
    panel.style.boxSizing = 'border-box'; panel.style.minHeight = '0';
    panel.style.maxWidth = `${Math.max(1, (bounds.right - bounds.left - 2 * inset) / (scaleX || 1))}px`;
    panel.style.maxHeight = `${Math.max(1, Math.min(heightLimit, (bounds.bottom - bounds.top - 2 * inset) / (scaleY || 1)))}px`;
    if (scroll) { panel.style.overflowY = 'auto'; panel.style.overscrollBehavior = 'contain'; }
    panel.style.transform = 'none'; panel.style.bottom = 'auto'; panel.style.right = 'auto';
    const box = panel.getBoundingClientRect(), a = anchor.getBoundingClientRect();
    if (!box.width || !box.height) return null;
    const left = Math.max(bounds.left + inset, Math.min(bounds.right - inset - box.width, a.left + a.width / 2 - box.width / 2));
    const above = a.top - gap - box.height, below = a.bottom + gap;
    const fits = top => top >= bounds.top + inset && top + box.height <= bounds.bottom - inset;
    const preferred = preferBelow ? below : above, alternate = preferBelow ? above : below;
    const desired = fits(preferred) ? preferred : fits(alternate) ? alternate : preferred;
    const top = Math.max(bounds.top + inset, Math.min(bounds.bottom - inset - box.height, desired));
    const originX = fixed ? 0 : (parentRect?.left || 0) + (parent?.clientLeft || 0) * scaleX;
    const originY = fixed ? 0 : (parentRect?.top || 0) + (parent?.clientTop || 0) * scaleY;
    panel.style.left = `${(left - originX) / (scaleX || 1) + (fixed ? 0 : parent?.scrollLeft || 0)}px`;
    panel.style.top = `${(top - originY) / (scaleY || 1) + (fixed ? 0 : parent?.scrollTop || 0)}px`;
    return { left, top, width: box.width, height: box.height, bounds };
  }

  function wordPopoverLayout(input = {}) {
    const viewportWidth = Math.max(1, Number(input.viewportWidth) || 1);
    const viewportHeight = Math.max(1, Number(input.viewportHeight) || 1);
    const margin = Math.max(0, Number(input.margin) || 12);
    const gap = Math.max(0, Number(input.gap) || 8);
    const heightLimit = Math.max(1, Number(input.heightLimit) || 760);
    const maxHeight = Math.max(1, Math.min(heightLimit, viewportHeight - margin * 2));
    const width = Math.max(1, Math.min(viewportWidth - margin * 2, Number(input.popoverWidth) || 1));
    const height = Math.max(1, Math.min(maxHeight, Number(input.popoverHeight) || 1));
    const anchorLeft = Number(input.anchorLeft) || 0;
    const anchorTop = Number(input.anchorTop) || 0;
    const anchorWidth = Math.max(0, Number(input.anchorWidth) || 0);
    const anchorCenterX = anchorLeft + anchorWidth / 2;
    const desiredLeft = anchorCenterX - width / 2;
    const left = Math.max(margin, Math.min(viewportWidth - margin - width, desiredLeft));
    const desiredTop = anchorTop - gap - height;
    const top = Math.max(margin, Math.min(viewportHeight - margin - height, desiredTop));
    const overlapsAnchor = top + height + gap > anchorTop + 1;
    const tailLeft = Math.max(10, Math.min(width - 32, anchorCenterX - left - 11));
    return {
      left,
      top,
      width,
      height,
      maxHeight,
      desiredLeft,
      desiredTop,
      tailLeft,
      tailVisible: !overlapsAnchor,
      overlapsAnchor,
      compact: maxHeight < 470,
    };
  }

  function floatingPopoverScrollState(input = {}) {
    const openedScrollX = Number(input.openedScrollX) || 0;
    const openedScrollY = Number(input.openedScrollY) || 0;
    const currentScrollX = Number(input.currentScrollX) || 0;
    const currentScrollY = Number(input.currentScrollY) || 0;
    const threshold = Math.max(0, Number(input.detachThreshold) || 2);
    const detached = Math.abs(currentScrollX - openedScrollX) > threshold
      || Math.abs(currentScrollY - openedScrollY) > threshold;
    const viewportWidth = Math.max(1, Number(input.viewportWidth) || 1);
    const viewportHeight = Math.max(1, Number(input.viewportHeight) || 1);
    const rect = input.playerRect || {};
    const left = Number(rect.left) || 0;
    const top = Number(rect.top) || 0;
    const width = Math.max(0, Number(rect.width) || 0);
    const height = Math.max(0, Number(rect.height) || 0);
    const right = Number.isFinite(Number(rect.right)) ? Number(rect.right) : left + width;
    const bottom = Number.isFinite(Number(rect.bottom)) ? Number(rect.bottom) : top + height;
    const visibleWidth = Math.max(0, Math.min(viewportWidth, right) - Math.max(0, left));
    const visibleHeight = Math.max(0, Math.min(viewportHeight, bottom) - Math.max(0, top));
    const verticalRatio = height > 0 ? visibleHeight / height : 0;
    const minVisiblePixels = Math.max(1, Number(input.minVisiblePixels) || 48);
    const minVerticalRatio = Math.max(0, Math.min(1, Number(input.minVerticalRatio) || 0.12));
    return {
      detached,
      playerVisible: visibleWidth > 0
        && visibleHeight >= Math.min(height, minVisiblePixels)
        && verticalRatio >= minVerticalRatio,
      visibleWidth,
      visibleHeight,
      verticalRatio,
    };
  }

  function exampleTranslationChoice(input = {}) {
    const natural = String(input.naturalTranslation || '').trim();
    const literal = String(input.literalTranslation?.literalText || '').trim();
    if (input.translationOrder !== 'source') {
      return { state: natural ? 'ready' : 'missing', text: natural, literal: false };
    }
    if (literal) return { state: 'ready', text: literal, literal: true };
    if (input.literalFailed && natural) {
      return { state: 'fallback', text: natural, literal: false };
    }
    return { state: natural ? 'pending' : 'missing', text: '', literal: false };
  }

  function literalTargetRangesForTerms(sourceText, alignments, terms, language) {
    const normalizedTerms = new Set(
      (Array.isArray(terms) ? terms : [terms]).map(normalizeTerm).filter(Boolean),
    );
    if (!normalizedTerms.size) return [];
    const sourceWordIndexes = new Set();
    let sourceWordIndex = 0;
    for (const part of segmentWords(sourceText, language)) {
      if (!part.word) continue;
      if (normalizedTerms.has(part.normalized)) sourceWordIndexes.add(sourceWordIndex);
      sourceWordIndex += 1;
    }
    const seen = new Set();
    return (alignments || [])
      .map(item => ({
        sourceWordIndex: Number(item?.sourceWordIndex),
        start: Number(item?.targetStart),
        end: Number(item?.targetEnd),
      }))
      .filter((item) => {
        if (!sourceWordIndexes.has(item.sourceWordIndex)
            || !Number.isInteger(item.start) || !Number.isInteger(item.end)
            || item.start < 0 || item.end <= item.start) return false;
        const key = `${item.start}:${item.end}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((left, right) => left.start - right.start || left.end - right.end);
  }

  function learningExamplePresentation(input = {}) {
    const sourceText = String(input.sourceText || '');
    const targetText = String(input.targetText || '');
    const sourceTerms = Array.isArray(input.sourceTerms) ? input.sourceTerms : [input.sourceTerms];
    const targetTerms = Array.isArray(input.targetTerms) ? input.targetTerms : [input.targetTerms];
    const sourceRanges = exactTermRanges(sourceText, sourceTerms, input.sourceLanguage || 'en');
    let targetRanges = [];
    if (Array.isArray(input.literalAlignments) && input.literalAlignments.length) {
      targetRanges = literalTargetRangesForTerms(
        sourceText,
        input.literalAlignments,
        sourceTerms,
        input.sourceLanguage || 'en',
      ).map(range => snapTextRangeToWords(targetText, range.start, range.end)).filter(Boolean);
    } else if (input.alignment) {
      targetRanges = mergeTextRanges(
        sourceTerms.flatMap(term => alignedTargetRanges(
          sourceText,
          targetText,
          term,
          input.alignment,
          input.sourceLanguage || 'en',
        )),
        targetText.length,
      );
    }
    if (!targetRanges.length) {
      targetRanges = exactTermRanges(targetText, targetTerms, input.targetLanguage || 'ru');
    }
    return {
      sourceText,
      targetText,
      sourceSegments: annotatedTextSegments(sourceText, sourceRanges.map(range => ({ ...range, active: true }))),
      targetSegments: annotatedTextSegments(targetText, targetRanges.map(range => ({ ...range, active: true }))),
    };
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

  function cueLookaheadItems(cues, currentIndex, ahead = 2) {
    const items = Array.isArray(cues) ? cues : [];
    const current = Math.trunc(Number(currentIndex));
    if (!Number.isInteger(current) || current < 0 || current >= items.length) return [];
    const last = Math.min(items.length - 1, current + Math.max(0, Math.trunc(Number(ahead) || 0)));
    const seen = new Set();
    const result = [];
    for (let index = current; index <= last; index += 1) {
      const cue = items[index];
      const text = String(cue?.text || '').trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      result.push({ cue, index });
    }
    return result;
  }

  function cuePrefetchItems(cues, currentIndex, ahead = 16, behind = 2) {
    const items = Array.isArray(cues) ? cues : [];
    const current = Math.trunc(Number(currentIndex));
    if (!Number.isInteger(current) || current < 0 || current >= items.length) return [];
    const first = Math.max(0, current - Math.max(0, Math.trunc(Number(behind) || 0)));
    const last = Math.min(items.length - 1, current + Math.max(0, Math.trunc(Number(ahead) || 0)));
    const order = [];
    for (let index = current; index <= last; index += 1) order.push(index);
    for (let index = current - 1; index >= first; index -= 1) order.push(index);
    const seen = new Set();
    const result = [];
    for (const index of order) {
      const cue = items[index];
      const text = String(cue?.text || '').trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      result.push({ cue, index });
    }
    return result;
  }

  function fullSubtitleRevealActive(input = {}) {
    return input.translationMode === 'never'
      && input.metaKeyDown === true;
  }

  function nextTranslationMode(mode) {
    return mode === 'always' ? 'never' : 'always';
  }

  function translationBufferSnapshot(input = {}) {
    const cues = Array.isArray(input.cues) ? input.cues : [];
    const currentIndex = Math.trunc(Number(input.currentIndex));
    const ahead = Math.max(0, Math.trunc(Number(input.ahead) || 0));
    const mode = input.translationMode === 'always' ? 'always' : 'never';
    const literal = input.translationOrder === 'source' && input.literalNeeded !== false;
    const naturalReady = input.naturalReady instanceof Set
      ? input.naturalReady
      : new Set(Array.isArray(input.naturalReady) ? input.naturalReady : []);
    const literalReady = input.literalReady instanceof Set
      ? input.literalReady
      : new Set(Array.isArray(input.literalReady) ? input.literalReady : []);
    const naturalPending = input.naturalPending instanceof Set
      ? input.naturalPending
      : new Set(Array.isArray(input.naturalPending) ? input.naturalPending : []);
    const literalPending = input.literalPending instanceof Set
      ? input.literalPending
      : new Set(Array.isArray(input.literalPending) ? input.literalPending : []);
    const validCurrent = Number.isInteger(currentIndex) && currentIndex >= 0 && currentIndex < cues.length;
    const currentText = validCurrent ? String(cues[currentIndex]?.text || '').trim() : '';
    const readySet = literal ? literalReady : naturalReady;
    const currentReady = !!currentText && readySet.has(currentText);
    const targetAhead = validCurrent ? Math.min(ahead, Math.max(0, cues.length - currentIndex - 1)) : 0;
    let readyAhead = 0;
    if (currentReady) {
      for (let index = currentIndex + 1; index <= currentIndex + targetAhead; index += 1) {
        const text = String(cues[index]?.text || '').trim();
        if (!text || !readySet.has(text)) break;
        readyAhead += 1;
      }
    }
    const window = validCurrent ? cues.slice(currentIndex, currentIndex + targetAhead + 1) : [];
    const naturalReadyInWindow = window.filter((cue) => naturalReady.has(String(cue?.text || '').trim())).length;
    const literalReadyInWindow = window.filter((cue) => literalReady.has(String(cue?.text || '').trim())).length;
    const naturalPendingInWindow = window.filter((cue) => naturalPending.has(String(cue?.text || '').trim())).length;
    const literalPendingInWindow = window.filter((cue) => literalPending.has(String(cue?.text || '').trim())).length;
    let stage = 'captions';
    if (!validCurrent) stage = 'captions';
    else if (!naturalReady.has(currentText)) stage = 'azure';
    else if (literal && !literalReady.has(currentText)) stage = 'gemini';
    else stage = 'ready';
    return {
      mode,
      literal,
      stage,
      currentReady,
      readyAhead,
      targetAhead,
      naturalReadyInWindow,
      literalReadyInWindow,
      naturalPendingInWindow,
      literalPendingInWindow,
    };
  }

  function subtitleClipboardText(cues) {
    const lines = [];
    for (const cue of Array.isArray(cues) ? cues : []) {
      const text = cleanCueText(cue?.text || '');
      if (!text || lines[lines.length - 1] === text) continue;
      lines.push(text);
    }
    return lines.join('\n');
  }

  function externalMediaSpaceAction(input = {}) {
    if (!input.external || input.code !== 'Space' || input.modifier || input.editable || input.interactive) {
      return 'ignore';
    }
    if (input.repeat || input.interactionOpen) return 'block';
    return 'toggle';
  }

  function isDesktopChromiumSpeech(userAgent) {
    const value = String(userAgent || '');
    return /(Chrome|Chromium|Edg)\/[\d.]+/i.test(value)
      && !/(Android|iPhone|iPad|iPod)/i.test(value);
  }

  function preferredEnglishSpeechVoice(voices, language = 'en-US') {
    const requested = String(language || 'en-US').replace('_', '-').toLocaleLowerCase('en-US');
    const english = (Array.isArray(voices) ? voices : []).filter((voice) => (
      String(voice?.lang || '').replace('_', '-').toLocaleLowerCase('en-US').startsWith('en-')
    ));
    if (!english.length) return null;
    const exact = english.filter((voice) => (
      String(voice?.lang || '').replace('_', '-').toLocaleLowerCase('en-US') === requested
    ));
    const candidates = exact.length ? exact : english;
    const preferredNames = [
      /(^|\s)(ava|zoe)(\s|$)/i,
      /(^|\s)(samantha|саманта)(\s|$)/i,
      /(^|\s)(allison|susan|tom|alex)(\s|$)/i,
    ];
    for (const pattern of preferredNames) {
      const match = candidates.find((voice) => pattern.test(String(voice?.name || '')));
      if (match) return match;
    }
    return candidates.find((voice) => voice?.localService !== false) || candidates[0] || null;
  }

  function shouldAutoplayCard(previousKey, nextKey) {
    return Boolean(previousKey && nextKey && previousKey !== nextKey);
  }

  return {
    cleanCueText,
    finalizeCues,
    parseJson3Cues,
    parseVttCues,
    pairAdjacentAsrCues,
    splitTimedCuesToFit,
    layoutTimedCuesToFit,
    findCueIndex,
    normalizeTerm,
    segmentWords,
    alignedTargetRanges,
    exactTermRanges,
    snapTextRangeToWords,
    literalSpacingFromReference,
    examplesForTerm,
    expressionMatchesForCue,
    pendingSaveWordIndexes,
    sentenceIsComplete,
    sentenceContainsTerm,
    sentenceForTerm,
    sentenceForCueTerm,
    parallelSentenceForTerm,
    dictionaryExampleRows,
    inclusiveWordRange,
    cueWordRangeForPhrase,
    phraseTextAcrossCues,
    annotatedTextSegments,
    cueNavigationDelta,
    dictionaryMeaningPairs,
    quickWordTranslationRows,
    quickWordPopoverLeft,
    mergeDictionaryMeaningPairs,
    classifyRepeatedWordClick,
    dismissalPlaybackOwner,
    overlayDeactivationPlan,
    lexemeRefinementNeeded,
    sourceWordIsActive,
    cueWindowItems,
    cueWindowText,
    subtitleCardPlacement,
    subtitleWidthLayout,
    obstacleAvoidingTop,
    wordPopoverLayout, fitFloatingElement,
    floatingPopoverScrollState,
    exampleTranslationChoice,
    literalTargetRangesForTerms,
    learningExamplePresentation,
    batchTexts,
    cueLookaheadItems,
    cuePrefetchItems,
    fullSubtitleRevealActive,
    nextTranslationMode,
    translationBufferSnapshot,
    subtitleClipboardText,
    externalMediaSpaceAction,
    isDesktopChromiumSpeech,
    preferredEnglishSpeechVoice,
    shouldAutoplayCard,
    timestampToMs,
  };
});
