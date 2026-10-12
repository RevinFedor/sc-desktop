// One word gesture for learning text. Delay the single-click navigation so a
// double click inside a popup cannot unmount its own second-click target.
(function (root, create) {
  if (root) root.__scCreateWordGesture = create;
  if (typeof module === 'object' && module.exports) module.exports = create;
})(typeof self !== 'undefined' ? self : globalThis, function createWordGesture({ onSelect, onRange, getText,
  setTimer = setTimeout, clearTimer = clearTimeout, delay = 400 }) {
  let first = null, timer = null, pendingPart = null, lastTap = null, generation = 0, committedRange = null;
  const stopTimer = () => { if (timer != null) clearTimer(timer); timer = null; pendingPart = null; };
  const reset = ({ keepPending = false } = {}) => {
    if (!keepPending || !pendingPart?.owner?.isConnected) stopTimer();
    generation++; first = null; lastTap = null; committedRange = null; onRange?.(null);
  };
  const begin = part => { stopTimer(); generation++; first = part; committedRange = null; onRange?.({ start: part.start, end: part.end }); };
  const select = (part, word, kind, range = null) => {
    first = null; committedRange = range;
    const selectedGeneration = ++generation;
    onRange?.(range);
    onSelect({ ...part, word, kind, entry: kind === 'phrase' ? null : part.entry,
      clearRange: () => {
        // Closing the single-word popup from the first tap must not erase a
        // newer anchor/phrase created by the second tap on the same sentence.
        if (selectedGeneration === generation && committedRange) reset();
      },
    });
  };
  return {
    reset,
    hover(part) { if (first) onRange?.({ start: Math.min(first.start, part.start), end: Math.max(first.end, part.end) }); },
    doubleClick(part) { begin(part); },
    click(part, { detail = 1, shiftKey = false, immediate = false, pointerType = '', timeStamp = Date.now() } = {}) {
      stopTimer();
      const doubleTap = pointerType === 'touch' && lastTap && timeStamp - lastTap.at >= 0 && timeStamp - lastTap.at <= delay
        && lastTap.start === part.start && lastTap.end === part.end;
      lastTap = pointerType === 'touch' && !doubleTap ? { start: part.start, end: part.end, at: timeStamp } : null;
      if (doubleTap) { begin(part); return; }
      if (detail > 1 && pointerType !== 'touch') return;
      if (first) {
        const start = Math.min(first.start, part.start), end = Math.max(first.end, part.end);
        const word = getText().slice(start, end).trim();
        const kind = start === part.start && end === part.end ? 'word' : 'phrase';
        select(part, word, kind, { start, end });
      } else if (shiftKey) begin(part);
      else if (detail === 0 || immediate) select(part, part.text, 'word');
      else {
        pendingPart = part;
        timer = setTimer(() => {
          timer = null; pendingPart = null;
          if (!part.owner || part.owner.isConnected) select(part, part.text, 'word');
        }, delay);
      }
    },
  };
});
