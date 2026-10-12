(function (root, factory) {
  const api = root?.__scLearningChoicesPopover?.version === 1 ? root.__scLearningChoicesPopover : factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.__scLearningChoicesPopover = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const STYLE_ID = 'sc-shared-choices-style';
  const CSS = `
    .sc-shared-choices[data-shared-choices] { box-sizing:border-box; position:fixed; z-index:2147483001; width:338px; max-width:calc(100vw - 24px); overflow:auto; overscroll-behavior:contain; touch-action:pan-y; padding:11px 13px; border:1px solid #45434d; border-radius:11px; background:#28272d; color:#f4f4f5; box-shadow:0 15px 36px #0008; text-align:left; font:400 13px/1.5 system-ui,sans-serif; white-space:normal; overflow-wrap:anywhere; }
    .sc-shared-choices[data-shared-choices] * { box-sizing:border-box; }
    .sc-shared-choices[data-shared-choices] .sc-choices-heading { display:block; padding-right:28px; color:#d8b4fe; font:650 13px/1.4 system-ui,sans-serif; }
    .sc-shared-choices[data-shared-choices] p { margin:5px 0 0; color:#b3b0bb; font:inherit; }
    .sc-shared-choices[data-shared-choices] button { cursor:pointer; font:inherit; }
    .sc-shared-choices[data-shared-choices] .sc-choices-close { position:absolute; top:5px; right:6px; display:grid; place-items:center; width:30px; height:30px; padding:0; border:0; border-radius:5px; background:transparent; color:#b3b0bb; }
    .sc-shared-choices[data-shared-choices] .sc-choices-close:hover { color:#fff; background:#ffffff0a; }
    .sc-shared-choices[data-shared-choices] svg { display:inline-block; width:14px; height:14px; flex:none; vertical-align:middle; }
    .sc-shared-choices[data-shared-choices] .study-english-alternatives { margin-top:9px; padding-top:8px; border-top:1px solid #45434d; font:400 13px/1.65 system-ui,sans-serif; }
    .sc-shared-choices[data-shared-choices] .study-english-alternative { display:inline; }
    .sc-shared-choices[data-shared-choices] .study-english-alternative-term { display:inline-flex; align-items:center; gap:3px; padding:1px 4px; color:#d4d4d8; font:650 13px/1.5 system-ui,sans-serif; white-space:nowrap; border:1px dotted #62606b; border-radius:4px; background:transparent; vertical-align:baseline; }
    .sc-shared-choices[data-shared-choices] .study-current-english-choice { color:#f3e8ff; background:#7e22ce55; border:1px solid #a78bfa85; }
    .sc-shared-choices[data-shared-choices] .in-dictionary { color:#e9d5ff; background:#7e22ce3d; border:1px solid #a78bfa6b; }
    .sc-shared-choices[data-shared-choices] .study-alternative-link:hover { color:#fff; border-color:#c4b5fd; }
    .sc-shared-choices[data-shared-choices] .study-alternative-nuance { color:#b3b0bb; }
    .sc-shared-choices[data-shared-choices] .study-alternative-separator { color:#77727f; }
    .sc-shared-choices[data-shared-choices] [role=status] { margin-top:7px; }
    .sc-shared-choices[data-shared-choices] .sc-choices-retry { margin-left:6px; padding:2px 5px; background:transparent; color:#d8b4fe; border:1px solid #62606b; border-radius:4px; }
    .sc-shared-choices[data-shared-choices] button:focus-visible { outline:2px solid #a78bfa; outline-offset:2px; }
  `;
  let current = null;
  const icon = (doc, kind) => {
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({ viewBox:'0 0 24 24', fill:'none', stroke:'currentColor', 'stroke-width':'2', 'stroke-linecap':'round', 'stroke-linejoin':'round', 'aria-hidden':'true' })) svg.setAttribute(key, value);
    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', kind === 'close' ? 'm6 6 12 12M18 6 6 18' : kind === 'book'
      ? 'M12 7v14M3 3h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5v17h-5a4 4 0 0 0-4 1 4 4 0 0 0-4-1H3z' : 'M12 5v14M5 12h14');
    svg.append(path); return svg;
  };

  function create(options) {
    current?.close();
    let config = { ...options }, model = {}, closed = false, ownerObserver = null, lastBounds = '';
    const doc = options.owner?.ownerDocument || document, win = doc.defaultView;
    if (!doc.getElementById(STYLE_ID)) {
      const style = doc.createElement('style'); style.id = STYLE_ID; style.textContent = CSS; doc.head.append(style);
    }
    const element = doc.createElement('div');
    element.className = 'sc-shared-choices study-synonym-popover practice-synonyms';
    element.dataset.sharedChoices = '1'; element.setAttribute('role', 'dialog');
    element.style.visibility = 'hidden'; doc.body.append(element);
    const textNode = (tag, text, className) => { const node = doc.createElement(tag); node.textContent = text || ''; if (className) node.className = className; return node; };
    const ownerVisible = () => !config.owner || config.owner.isConnected && config.owner.getClientRects().length > 0
      && win.getComputedStyle(config.owner).visibility !== 'hidden';
    function position() {
      if (closed) return;
      if (!ownerVisible()) { close(); return; }
      const anchor = typeof config.anchor === 'function' ? config.anchor() : config.anchor;
      const rect = anchor?.getBoundingClientRect ? anchor.getBoundingClientRect() : anchor;
      if (anchor?.isConnected === false) { close(); return; }
      if (!rect) return;
      const limit = typeof config.bottomLimit === 'function' ? config.bottomLimit() : config.bottomLimit;
      const bottom = Math.min(win.innerHeight, Number.isFinite(limit) ? limit : win.innerHeight);
      element.style.maxHeight = Math.max(48, Math.min(460, bottom - 24)) + 'px';
      const size = element.getBoundingClientRect();
      const left = Math.max(12, Math.min(win.innerWidth - size.width - 12, rect.left + rect.width / 2 - size.width / 2));
      const below = rect.bottom + 7, above = rect.top - size.height - 7;
      const top = below + size.height <= bottom - 12 ? below : Math.max(12, Math.min(above, bottom - size.height - 12));
      element.style.left = left + 'px'; element.style.top = top + 'px'; element.style.visibility = 'visible';
      const bounds = [left, top, size.width, size.height].join(':');
      if (bounds !== lastBounds) { lastBounds = bounds; win.dispatchEvent(new win.Event('sc-learning-choices-layout')); }
    }
    function render() {
      element.replaceChildren();
      element.setAttribute('aria-label', 'Варианты перевода: ' + (model.title || ''));
      element.append(textNode('strong', model.title, 'sc-choices-heading'));
      const dismiss = textNode('button', '', 'sc-choices-close'); dismiss.type = 'button';
      dismiss.setAttribute('aria-label', 'Закрыть варианты перевода'); dismiss.append(icon(doc, 'close')); dismiss.onclick = () => close(); element.append(dismiss);
      if (model.russianAlternatives) element.append(textNode('p', model.russianAlternatives, 'study-russian-alternatives'));
      if (model.description) element.append(textNode('p', model.description));
      if (model.phase === 'loading' || model.phase === 'error' || model.phase === 'selecting') {
        const status = textNode('div', model.phase === 'selecting' ? 'Выберите последнее русское слово · Esc — отменить'
          : model.phase === 'loading' ? model.loadingText || 'Подбираю варианты…' : model.error || 'Не удалось получить варианты.');
        status.setAttribute('role', 'status'); element.append(status);
        if (model.phase === 'error' && config.onRetry) {
          const retry = textNode('button', 'Повторить', 'sc-choices-retry'); retry.type = 'button'; retry.onclick = () => config.onRetry(); status.append(retry);
        }
      } else {
        const list = textNode('div', '', 'study-english-alternatives'); list.setAttribute('aria-label', 'Английские варианты');
        const choices = [...(model.headwordChoice ? [{ ...model.headwordChoice, current: true }] : []), ...(model.englishAlternatives || [])];
        choices.forEach((choice, index) => {
          if (index) list.append(textNode('span', ' · ', 'study-alternative-separator'));
          const row = textNode('span', '', 'study-english-alternative');
          const saved = !choice.current && !!config.isSaved?.(choice.term), clickable = !choice.current && !!config.onChoice;
          const term = textNode(clickable ? 'button' : 'span', '', 'study-english-alternative-term ' + (choice.current ? 'study-current-english-choice' : 'study-alternative-link ' + (saved ? 'in-dictionary' : 'new-word')));
          if (clickable) {
            term.type = 'button'; term.setAttribute('aria-label', (saved ? 'Открыть карточку: ' : 'Добавить слово: ') + choice.term);
            term.append(icon(doc, saved ? 'book' : 'plus'));
            term.onclick = () => { config.onChoice(choice, term); close(); };
          } else if (choice.current) term.setAttribute('aria-label', 'Текущее английское выражение');
          term.append(doc.createTextNode(choice.term || '')); row.append(term);
          if (choice.nuance) row.append(textNode('span', ' (' + choice.nuance + ')', 'study-alternative-nuance'));
          list.append(row);
        });
        if (choices.length) element.append(list);
        else element.append(textNode('p', 'Других вариантов для этого значения нет.'));
      }
      position();
    }
    function outside(event) {
      const anchor = typeof config.anchor === 'function' ? config.anchor() : config.anchor;
      if (!element.contains(event.target) && !(anchor?.contains ? anchor.contains(event.target) : config.owner?.contains(event.target))) close({ event });
    }
    function keyboard(event) {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); }
    }
    function close({ notify = true, event = null } = {}) {
      if (closed) return; closed = true;
      win.removeEventListener('pointerdown', outside, true); win.removeEventListener('keydown', keyboard, true);
      win.removeEventListener('resize', position); doc.removeEventListener('scroll', position, true);
      win.removeEventListener('sc-study-viewport', position); element.remove();
      ownerObserver?.disconnect();
      win.dispatchEvent(new win.Event('sc-learning-choices-layout'));
      if (current === instance) current = null;
      if (notify) config.onClose?.({ event });
    }
    const instance = { element, position, close, update(next) {
      if (closed) return; config = { ...config, ...next }; model = next.model || model; render();
    }, owns(owner, target) { return !closed && config.owner === owner && element.contains(target); } };
    win.addEventListener('pointerdown', outside, true); win.addEventListener('keydown', keyboard, true);
    win.addEventListener('resize', position); doc.addEventListener('scroll', position, true); win.addEventListener('sc-study-viewport', position);
    current = instance;
    ownerObserver = new win.MutationObserver(() => { if (!ownerVisible()) close(); });
    for (let node = config.owner; node; node = node.parentElement) ownerObserver.observe(node, {
      childList: true, attributes: true, attributeFilter: ['hidden', 'class', 'style'] });
    instance.update(options); return instance;
  }
  return { version: 1, create, contains: (owner, target) => !!current?.owns(owner, target), closeFor: owner => {
    if (current?.owns(owner, current.element)) current.close();
  } };
});
