(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.__scPhraseComposition = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const VERSION = 2;
  const MEANING_MODE_INSTRUCTION = 'meaningMode описывает именно это употребление в данном контексте: literal — общий смысл складывается из обычных значений частей; nonliteral — у целого выражения закреплённый или переносный смысл, не равный буквальному переводу частей. Тип phrasal_verb сам по себе не определяет meaningMode. Например walk up the stairs — literal, give up в значении сдаться — nonliteral, from the ground up в значении с нуля — nonliteral.';
  const INSTRUCTION = [
    'Дополнительно верни composition:{meaningMode:"literal|nonliteral",parts:[{en:"часть выделения",ru:"её значение или роль здесь"}],explanation:"как из частей получается смысл"}.',
    MEANING_MODE_INSTRUCTION,
    'Разбирай только выделенный фрагмент, не всё предложение. Для короткой обычной фразы объясни значимые слова по отдельности; длинную собери в 2–6 смысловых частей, а не в перечень каждого слова.',
    'parts должны полностью покрывать исходное выделение в исходном порядке, без добавленных или переставленных английских слов. Части en берутся из исходного выделения, а не из canonicalText.',
    'ru — короткое значение именно здесь. once в never even once — один раз, а не однажды. Служебному слову без прямого русского эквивалента объясни роль, не выдумывай перевод.',
    'explanation — одна короткая русская фраза, обычно до 160 символов: объясни связь, отрицание, усиление или конструкцию; не повторяй общий перевод и не перечисляй части ещё раз.',
    'Например never even once: never — никогда; even — даже; once — один раз. even once — даже один раз; never отрицает и это, поэтому ни единого раза.',
    'Отсутствие фразового глагола не делает выражение дословным. У идиомы честно обозначь закреплённый смысл и разницу с буквальным образом, без придуманной этимологии.',
    'Для недословного фразового глагола сохраняй целую смысловую часть; не выводи give up = сдаться из give = давать и up = вверх. Буквальное сочетание можно разложить на обычное действие и направление. Грамматическую конструкцию тоже можно объединить, если отдельные переводы вводили бы в заблуждение.',
    'Не добавляй длинные определения, список возможных переводов, грамматические термины или Markdown. Контекст помогает выбрать смысл; недостающие слова реплики не объявляй достоверно произнесёнными.',
  ].join(' ');
  const clean = value => typeof value === 'string' ? value.normalize('NFKC').replace(/\s+/g, ' ').trim() : '';
  const boundaryOnly = value => /^[\s.,!?;:"“”‘’()\[\]…—–]*$/u.test(value);

  function normalize(value, selectedText, { requireMeaningMode = false } = {}) {
    if (!value || !Array.isArray(value.parts) || !value.parts.length || value.parts.length > 6) return null;
    const text = clean(selectedText), lower = text.toLocaleLowerCase('en-US');
    const explanation = clean(value.explanation);
    const meaningMode = ['literal', 'nonliteral'].includes(value.meaningMode) ? value.meaningMode : '';
    if (requireMeaningMode && !meaningMode) return null;
    if (!text || !explanation || explanation.length > 320) return null;
    const parts = [];
    let cursor = 0;
    for (const part of value.parts) {
      const en = clean(part?.en), ru = clean(part?.ru);
      if (!en || en.length > 500 || !ru || ru.length > 120) return null;
      const at = lower.indexOf(en.toLocaleLowerCase('en-US'), cursor);
      if (at < cursor || !boundaryOnly(text.slice(cursor, at))) return null;
      const end = at + en.length;
      // A decomposition cannot split a lexical word into invented fragments.
      if ((at > 0 && /[\p{L}\p{N}'’-]/u.test(text[at - 1]) && /[\p{L}\p{N}]/u.test(en[0]))
        || (end < text.length && /[\p{L}\p{N}'’-]/u.test(text[end]) && /[\p{L}\p{N}]/u.test(en.at(-1)))) return null;
      parts.push({ en: text.slice(at, end), ru });
      cursor = end;
    }
    if (!boundaryOnly(text.slice(cursor))) return null;
    return { version: meaningMode ? VERSION : 1, ...(meaningMode ? { meaningMode } : {}), parts, explanation };
  }

  const meaningLabel = value => value?.meaningMode === 'literal' ? 'смысл из частей'
    : value?.meaningMode === 'nonliteral' ? 'недословное значение' : '';
  return { VERSION, INSTRUCTION, MEANING_MODE_INSTRUCTION, normalize, meaningLabel };
});
