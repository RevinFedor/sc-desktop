/**
 * MCP Content Script — выполняет команды от MCP-моста
 *
 * Инжектируется динамически (НЕ через manifest.json) только в dev-mode.
 * Работает на ЛЮБОМ сайте (не только hh.ru).
 *
 * Команды:
 *   mcp_inspect   — v2: список интерактивных элементов с анкерами a1/a2,
 *                   проходит open shadow roots + same-origin iframes
 *   mcp_act       — v2: click/fill/hover/check по anchor | structured target
 *                   ({role,name}/{text}/{label}/{placeholder}/{testId}/{css}) |
 *                   legacy selector. При N>1 матчах — status:ambiguous (не бьёт).
 *                   Конверт {success,status,message,errorCode?,suggestions?}.
 *   mcp_snapshot  — legacy DOM-snapshot (CSS-path, без анкеров)
 *   mcp_click     — клик; теперь через performAct (anchor/target/selector)
 *   mcp_fill      — заполнить input/textarea; через performAct
 *   mcp_hover     — синтетический hover; через performAct
 *   mcp_evaluate  — выполнить JS
 *   mcp_get_text  — получить текст элемента
 *   mcp_scroll    — прокрутка
 */

// Guard: don't inject twice
if (window.__mcpContentLoaded) {
  // Already loaded — just acknowledge
} else {
  window.__mcpContentLoaded = true;

  // ── Result serializer ─────────────────────────────────────────────
  // Strips DOM nodes / functions / cycles so JSON.stringify doesn't blow up.
  function safeSerialize(v, maxDepth) {
    const limit = typeof maxDepth === 'number' ? maxDepth : 4;
    const seen = new WeakSet();
    function walk(x, depth) {
      if (x === null || x === undefined) return x;
      const t = typeof x;
      if (t === 'string') return x.length > 50000 ? x.slice(0, 50000) + `…[${x.length}]` : x;
      if (t === 'number' || t === 'boolean' || t === 'bigint') return t === 'bigint' ? x.toString() : x;
      if (t === 'function') return `[Function ${x.name || 'anonymous'}]`;
      if (t === 'symbol') return x.toString();
      if (depth >= limit) return Array.isArray(x) ? `[Array(${x.length})]` : `[Object]`;
      if (x instanceof Element) {
        return {
          __dom: true,
          tag: x.tagName.toLowerCase(),
          id: x.id || undefined,
          cls: x.className || undefined,
          text: (x.textContent || '').trim().slice(0, 200),
        };
      }
      if (x instanceof NodeList || x instanceof HTMLCollection) {
        return Array.from(x).slice(0, 100).map(n => walk(n, depth + 1));
      }
      if (x instanceof Map) return { __map: true, entries: Array.from(x.entries()).slice(0, 100).map(([k, v]) => [walk(k, depth + 1), walk(v, depth + 1)]) };
      if (x instanceof Set) return { __set: true, values: Array.from(x).slice(0, 100).map(v => walk(v, depth + 1)) };
      if (Array.isArray(x)) {
        if (seen.has(x)) return '[Circular]';
        seen.add(x);
        return x.slice(0, 500).map(item => walk(item, depth + 1));
      }
      if (t === 'object') {
        if (seen.has(x)) return '[Circular]';
        seen.add(x);
        const out = {};
        let count = 0;
        for (const k of Object.keys(x)) {
          if (count++ >= 100) { out['…'] = `+${Object.keys(x).length - 100} more`; break; }
          try { out[k] = walk(x[k], depth + 1); } catch (e) { out[k] = `[Error: ${e.message}]`; }
        }
        return out;
      }
      return String(x);
    }
    try { return walk(v, 0); } catch (e) { return `[Serialize error: ${e.message}]`; }
  }

  // ── Snapshot Builder ──────────────────────────────────────────────

  function buildSnapshot(fullHtml) {
    if (fullHtml) {
      return document.documentElement.outerHTML;
    }

    const elements = [];
    let uid = 0;

    function getSelector(el) {
      if (el.id) return `#${el.id}`;
      if (el.getAttribute('data-qa')) return `[data-qa="${el.getAttribute('data-qa')}"]`;
      if (el.getAttribute('data-testid')) return `[data-testid="${el.getAttribute('data-testid')}"]`;
      if (el.getAttribute('aria-label')) return `[aria-label="${el.getAttribute('aria-label')}"]`;
      if (el.getAttribute('name')) return `${el.tagName.toLowerCase()}[name="${el.getAttribute('name')}"]`;
      if (el.className && typeof el.className === 'string') {
        const classes = el.className.trim().split(/\s+/).slice(0, 2).join('.');
        if (classes) return `${el.tagName.toLowerCase()}.${classes}`;
      }
      return el.tagName.toLowerCase();
    }

    function getPath(el) {
      const parts = [];
      let current = el;
      for (let i = 0; i < 3 && current && current !== document.body; i++) {
        parts.unshift(getSelector(current));
        current = current.parentElement;
      }
      return parts.join(' > ');
    }

    // Interactive elements
    const interactiveSelectors = [
      'a[href]',
      'button',
      'input',
      'textarea',
      'select',
      '[role="button"]',
      '[role="link"]',
      '[role="tab"]',
      '[role="menuitem"]',
      '[onclick]',
      '[data-qa]',
      '[data-testid]',
    ];

    const seen = new Set();

    for (const sel of interactiveSelectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (seen.has(el)) continue;
        seen.add(el);

        // Skip hidden elements
        if (el.offsetParent === null && el.tagName !== 'INPUT' && el.type !== 'hidden') continue;

        const tag = el.tagName.toLowerCase();
        const text = (el.textContent || '').trim().substring(0, 100);
        const entry = {
          uid: uid++,
          tag,
          selector: getPath(el),
          text: text || undefined,
        };

        if (el.href) entry.href = el.href;
        if (el.type) entry.type = el.type;
        if (el.value) entry.value = el.value.substring(0, 100);
        if (el.placeholder) entry.placeholder = el.placeholder;
        if (el.name) entry.name = el.name;
        if (el.getAttribute('aria-label')) entry.ariaLabel = el.getAttribute('aria-label');
        if (el.getAttribute('data-qa')) entry.dataQa = el.getAttribute('data-qa');
        if (el.getAttribute('data-testid')) entry.dataTestId = el.getAttribute('data-testid');
        if (el.disabled) entry.disabled = true;
        if (el.getAttribute('role')) entry.role = el.getAttribute('role');

        elements.push(entry);
      }
    }

    // Headings for structure context
    for (const el of document.querySelectorAll('h1, h2, h3')) {
      const text = (el.textContent || '').trim().substring(0, 150);
      if (!text) continue;
      elements.push({
        uid: uid++,
        tag: el.tagName.toLowerCase(),
        selector: getPath(el),
        text,
        structural: true,
      });
    }

    const meta = {
      url: window.location.href,
      title: document.title,
      elementCount: elements.length,
    };

    return JSON.stringify({ meta, elements }, null, 2);
  }

  // ══════════════════════════════════════════════════════════════════
  // v2 Page Interaction — anchors, shadow/iframe penetration, structured
  // targets, ambiguity-guarded actions, ActionResult envelopes.
  //
  // Портировано по духу из BrowserPowers (packages/BrowserPowers, ADR-001):
  // три проблемы нашего старого snapshot/click — (1) хрупкий CSS-path,
  // (2) querySelector берёт ПЕРВЫЙ матч молча, (3) голый {success,error}.
  // Здесь: inspect отдаёт анкеры a1/a2 (держим РЕАЛЬНУЮ ссылку на элемент,
  // не селектор → нечего перерезолвить, el.isConnected = детект протухания),
  // scan проходит open shadow roots + same-origin iframes, resolveTarget
  // принимает anchor|role|text|label|placeholder|testId|css, и при N>1
  // матчах действие НЕ выполняется (ambiguous). Каждое действие возвращает
  // конверт {success,status,message,errorCode?,recoverable?,suggestions?}.
  // `error` дублирует message на провалах — backward-compat со старыми
  // MCP-тулзами (`result.error`).
  // ══════════════════════════════════════════════════════════════════

  // anchor-id → реальная ссылка на элемент. Живёт в module-scope этого
  // инжекта → переживает команды на одной странице, сбрасывается сам на
  // навигации (новый документ → скрипт ре-инициализируется). Держим ССЫЛКУ
  // на узел, а не селектор: перерезолвить нечего, а el.isConnected даёт
  // детект «элемент отвалился» бесплатно.
  const __anchorStore = new Map();
  let __anchorEpoch = 0;

  function __norm(s) { return (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim(); }
  // Дедуп точного удвоения: фреймворки (claude.ai и др.) рендерят видимый +
  // sr-only дубль заголовка, textContent склеивает «дикциядикция». Если строка
  // = две одинаковые половины — оставляем одну. Иначе текстовый матч хрупок.
  function __dedupeDouble(s) {
    const n = __norm(s);
    if (n.length >= 4 && n.length % 2 === 0) {
      const h = n.length / 2;
      if (n.slice(0, h) === n.slice(h)) return n.slice(0, h);
    }
    return n;
  }
  function __eqi(a, b) { return __norm(a).toLowerCase() === __norm(b).toLowerCase(); }
  function __inc(a, b) { return __norm(a).toLowerCase().includes(__norm(b).toLowerCase()); }

  function __isInteractable(el) {
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (!tag) return false;
    const role = el.getAttribute('role') || '';
    const type = (el.getAttribute('type') || '').toLowerCase();
    return tag === 'button' || tag === 'a' || tag === 'select' || tag === 'textarea'
      || (tag === 'input' && type !== 'hidden')
      || ['button', 'link', 'checkbox', 'radio', 'textbox', 'combobox', 'listbox',
          'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'switch'].includes(role)
      || el.hasAttribute('onclick') || el.hasAttribute('tabindex')
      || el.getAttribute('contenteditable') === 'true';
  }

  function __visible(el) {
    try {
      const rects = el.getClientRects();
      if ((!rects || rects.length === 0) && el.tagName !== 'OPTION') return false;
      const win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
      const cs = win.getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return false;
      return true;
    } catch (_) { return true; }
  }

  // Рекурсивный обход: light DOM + open shadow roots + same-origin iframes.
  // Возвращает записи {el, where} где where = undefined|'shadow'|'iframe'.
  // depth-guard 12 от патологически вложенных shadow-деревьев.
  function __scanRecords(rootDoc) {
    const out = [];
    const seen = new Set();
    (function walk(root, depth, where) {
      if (!root || depth > 12) return;
      let nodes;
      try { nodes = root.querySelectorAll('*'); } catch (_) { return; }
      for (const el of nodes) {
        if (seen.has(el)) continue;
        seen.add(el);
        if (__isInteractable(el) && __visible(el)) out.push({ el, where });
        if (el.shadowRoot) walk(el.shadowRoot, depth + 1, 'shadow');
        if (el.tagName === 'IFRAME') {
          let doc = null;
          try { doc = el.contentDocument; } catch (_) { doc = null; }
          if (doc) walk(doc, depth + 1, 'iframe');
        }
      }
    })(rootDoc || document, 0, undefined);
    return out;
  }
  function __universe() { return __scanRecords().map(r => r.el); }

  function __role(el) {
    const r = el.getAttribute && el.getAttribute('role');
    if (r) return r;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute && el.getAttribute('type') || '').toLowerCase();
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      return 'textbox';
    }
    return '';
  }

  function __accessibleName(el) {
    if (!el || !el.getAttribute) return '';
    const aria = el.getAttribute('aria-label');
    if (aria) return __norm(aria);
    const lbry = el.getAttribute('aria-labelledby');
    if (lbry) {
      const doc = el.ownerDocument || document;
      const ref = doc.getElementById(lbry);
      if (ref) return __norm(ref.textContent);
    }
    if (el.labels && el.labels.length) return __norm(el.labels[0].textContent);
    const txt = __dedupeDouble(el.textContent);
    if (txt) return txt.slice(0, 120);
    return __norm(el.getAttribute('value') || el.getAttribute('placeholder') || el.getAttribute('title'));
  }

  function __cssPath(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) { try { return '#' + CSS.escape(el.id); } catch (_) { return '#' + el.id; } }
    const parts = [];
    let cur = el, guard = 0;
    const esc = (c) => { try { return CSS.escape(c); } catch (_) { return c; } };
    while (cur && cur.nodeType === 1 && cur.tagName !== 'BODY' && guard < 4) {
      let sel = cur.tagName.toLowerCase();
      if (cur.classList && cur.classList.length) {
        sel += '.' + Array.from(cur.classList).slice(0, 2).map(esc).join('.');
      }
      const parent = cur.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
        if (sibs.length > 1) sel += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
      }
      parts.unshift(sel);
      cur = cur.parentElement;
      guard++;
    }
    return parts.join(' > ');
  }

  // Лучший структурный таргет элемента — по убыванию надёжности (калька
  // BrowserPowers getTarget): role+name > testId > label > placeholder >
  // #id > text > css-path. Смысловой таргет переживает рестайл вёрстки.
  function __target(el) {
    const aria = el.getAttribute && el.getAttribute('aria-label');
    const placeholder = el.getAttribute && el.getAttribute('placeholder');
    const testId = el.getAttribute && (el.getAttribute('data-testid') || el.getAttribute('data-qa'));
    const text = __dedupeDouble(el.textContent).slice(0, 80) || (el.getAttribute && el.getAttribute('value')) || '';
    const tag = el.tagName.toLowerCase();
    const r = __role(el);
    if (r && aria) return { role: r, name: __norm(aria) };
    if (r && text) return { role: r, name: text };
    if (testId) return { testId };
    if (aria) return { label: __norm(aria) };
    if (placeholder) return { placeholder };
    if (el.id) { try { return { css: '#' + CSS.escape(el.id) }; } catch (_) { return { css: '#' + el.id }; } }
    if ((tag === 'button' || tag === 'a') && text) return { text };
    return { css: __cssPath(el) };
  }

  function __metaOf(el, where) {
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    const m = { tag, target: __target(el) };
    const role = __role(el); if (role) m.role = role;
    const name = __accessibleName(el); if (name) m.name = name;
    const type = el.getAttribute && el.getAttribute('type'); if (type) m.type = type;
    const ph = el.getAttribute && el.getAttribute('placeholder'); if (ph) m.placeholder = ph;
    if ((type === 'checkbox' || type === 'radio') && typeof el.checked === 'boolean') m.checked = el.checked;
    m.enabled = !el.disabled;
    if (where) m.where = where; // 'shadow' | 'iframe' — иначе light DOM
    return m;
  }

  function __describe(el) {
    const r = __role(el), n = __accessibleName(el);
    if (r && n) return `${r} "${n}"`;
    const t = __norm(el.textContent).slice(0, 40);
    return t ? `${el.tagName.toLowerCase()} "${t}"` : el.tagName.toLowerCase();
  }

  // ── inspect: список интерактивных элементов с анкерами ──────────────
  function buildInspect(opts) {
    opts = opts || {};
    const limit = opts.limit || 200;
    __anchorStore.clear();
    __anchorEpoch++;
    const records = __scanRecords();
    const anchors = [];
    for (let i = 0; i < records.length && i < limit; i++) {
      const id = 'a' + (i + 1);
      __anchorStore.set(id, records[i].el);
      anchors.push({ anchor: id, ...__metaOf(records[i].el, records[i].where) });
    }
    return {
      url: location.href,
      title: document.title,
      epoch: __anchorEpoch,
      count: anchors.length,
      truncated: records.length > limit ? records.length : undefined,
      anchors,
    };
  }

  // ── resolveTarget: anchor | structured target | legacy selector ─────
  // Возвращает {matches:[el...], via, stale?}. Семантические матчеры
  // проходят весь universe (включая shadow/iframe); css — только light DOM
  // (css не пересекает shadow-границу — для shadow используются анкеры).
  function resolveTarget(spec) {
    if (spec.anchor) {
      const el = __anchorStore.get(spec.anchor);
      if (!el || !el.isConnected) return { matches: [], via: 'anchor', stale: true };
      return { matches: [el], via: 'anchor' };
    }
    const t = spec.target || (spec.selector ? { css: spec.selector } : null);
    if (!t) return { matches: [], via: 'none' };
    if (t.css) { try { return { matches: Array.from(document.querySelectorAll(t.css)), via: 'css' }; } catch (_) { return { matches: [], via: 'css' }; } }
    const u = __universe();
    if (t.testId != null) return { matches: u.filter(el => el.getAttribute && (el.getAttribute('data-testid') === t.testId || el.getAttribute('data-qa') === t.testId)), via: 'testId' };
    if (t.placeholder != null) { const ex = u.filter(el => __eqi(el.getAttribute && el.getAttribute('placeholder'), t.placeholder)); return { matches: ex.length ? ex : u.filter(el => __inc(el.getAttribute && el.getAttribute('placeholder'), t.placeholder)), via: 'placeholder' }; }
    if (t.label != null) return { matches: __byLabel(t.label, u), via: 'label' };
    if (t.role != null) return { matches: __byRoleName(t.role, t.name, u), via: 'role' };
    if (t.text != null) return { matches: __byText(t.text, u), via: 'text' };
    return { matches: [], via: 'none' };
  }
  function __byText(text, u) {
    u = u || __universe();
    const ex = u.filter(el => __eqi(__accessibleName(el), text) || __eqi(__dedupeDouble(el.textContent), text));
    if (ex.length) return ex;
    return u.filter(el => __inc(__accessibleName(el), text) || __inc(__dedupeDouble(el.textContent), text));
  }
  function __byRoleName(role, name, u) {
    u = u || __universe();
    const byRole = u.filter(el => __eqi(__role(el), role));
    if (name == null || name === '') return byRole;
    const ex = byRole.filter(el => __eqi(__accessibleName(el), name));
    return ex.length ? ex : byRole.filter(el => __inc(__accessibleName(el), name));
  }
  function __byLabel(label, u) {
    u = u || __universe();
    const ex = u.filter(el => __eqi(__accessibleName(el), label));
    if (ex.length) return ex;
    const out = [];
    for (const lb of Array.from(document.querySelectorAll('label'))) {
      if (__eqi(lb.textContent, label)) {
        const ctrl = lb.control || (lb.htmlFor && document.getElementById(lb.htmlFor));
        if (ctrl) out.push(ctrl);
      }
    }
    return out.length ? out : u.filter(el => __inc(__accessibleName(el), label));
  }

  // ── ActionResult envelopes (error дублирует message для backward-compat) ─
  function envPerformed(action, message, extra) { return { success: true, status: 'performed', action, message, ...(extra || {}) }; }
  function envAlready(action, message, extra) { return { success: true, status: 'already_in_desired_state', action, message, ...(extra || {}) }; }
  function envAmbiguous(action, matchedCount, candidates) {
    const message = `Found ${matchedCount} matching elements; refused to act to avoid hitting the wrong one`;
    return { success: false, status: 'ambiguous', action, message, error: message, errorCode: 'AMBIGUOUS_TARGET', recoverable: true,
      suggestions: ['Run mcp_inspect and act by anchor (a1, a2…)', 'Refine target with role+name, testId, or a more specific selector'],
      evidence: { matchedCount }, candidates };
  }
  function envBlocked(action, message, code) {
    return { success: false, status: 'blocked', action, message, error: message, errorCode: code || 'NOT_FOUND', recoverable: true,
      suggestions: ['Run mcp_inspect to see available elements and their anchors'] };
  }
  function envStale(action) {
    const message = 'Anchor no longer valid (page changed or element detached)';
    return { success: false, status: 'blocked', action, message, error: message, errorCode: 'ANCHOR_STALE', recoverable: true,
      suggestions: ['Run mcp_inspect again to get fresh anchors'] };
  }

  function __doHover(el) {
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    const init = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, screenX: cx, screenY: cy, pointerType: 'mouse', isPrimary: true };
    el.dispatchEvent(new PointerEvent('pointerover', init));
    el.dispatchEvent(new MouseEvent('mouseover', init));
    el.dispatchEvent(new PointerEvent('pointerenter', init));
    el.dispatchEvent(new MouseEvent('mouseenter', init));
    el.dispatchEvent(new PointerEvent('pointermove', init));
    el.dispatchEvent(new MouseEvent('mousemove', init));
  }
  function __doFill(el, value) {
    if (el.isContentEditable || (el.getAttribute && el.getAttribute('contenteditable') === 'true')) {
      el.focus();
      const sel = window.getSelection(), range = document.createRange();
      range.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(range);
      document.execCommand('insertText', false, value);
      return;
    }
    if (el.tagName === 'SELECT') {
      const opt = Array.from(el.options).find(o => o.value === value || __eqi(o.textContent, value));
      el.value = opt ? opt.value : value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ── performAct: разрешить таргет → guard → выполнить → конверт ───────
  function performAct(spec) {
    const act = spec.do || spec.act || 'click';
    const res = resolveTarget(spec);
    if (res.stale) return envStale(act);
    const matches = (res.matches || []).filter(el => el && el.isConnected);
    if (matches.length === 0) return envBlocked(act, `No element matched ${JSON.stringify(spec.target || spec.selector || spec.anchor || '(empty target)')}`, 'NOT_FOUND');
    if (matches.length > 1) {
      // Зарегистрировать кандидатов как анкеры c1..cN — агент сразу выберет.
      const candidates = matches.slice(0, 8).map((el, i) => { const id = 'c' + (i + 1); __anchorStore.set(id, el); return { anchor: id, ...__metaOf(el) }; });
      return envAmbiguous(act, matches.length, candidates);
    }
    const el = matches[0];
    const targetSummary = res.via + (spec.anchor ? ('=' + spec.anchor) : '');
    try { el.scrollIntoView && el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
    try {
      if (act === 'click') { el.click(); return envPerformed('click', `Clicked ${__describe(el)}`, { targetSummary, evidence: { tag: el.tagName.toLowerCase(), name: __accessibleName(el) } }); }
      if (act === 'hover') { __doHover(el); return envPerformed('hover', `Hovered ${__describe(el)}`, { targetSummary }); }
      if (act === 'fill') {
        const value = spec.value != null ? String(spec.value) : '';
        const cur = ('value' in el) ? el.value : el.textContent;
        if (value !== '' && __eqi(cur, value)) return envAlready('fill', `Field already contains that value`, { targetSummary });
        __doFill(el, value);
        return envPerformed('fill', `Filled ${__describe(el)}`, { targetSummary, evidence: { value: value.slice(0, 80) } });
      }
      if (act === 'check') {
        const desired = spec.checked !== false;
        if (typeof el.checked === 'boolean') {
          if (el.checked === desired) return envAlready('check', `Already ${desired ? 'checked' : 'unchecked'}`, { targetSummary });
          el.click();
          return envPerformed('check', `${desired ? 'Checked' : 'Unchecked'} ${__describe(el)}`, { targetSummary });
        }
        el.click();
        return envPerformed('check', `Clicked (element has no checked state) ${__describe(el)}`, { targetSummary });
      }
      if (act === 'select_option') { __doFill(el, spec.value != null ? String(spec.value) : (spec.label || '')); return envPerformed('select_option', `Selected option in ${__describe(el)}`, { targetSummary }); }
      return envBlocked(act, `Unsupported act "${act}"`, 'UNSUPPORTED');
    } catch (e) {
      return { success: false, status: 'not_performed', action: act, message: e.message, error: e.message, errorCode: 'EXECUTION_ERROR', recoverable: true };
    }
  }

  // ── Command Handler ───────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.action || !message.action.startsWith('mcp_')) return;

    const { action } = message;

    try {
      if (action === 'mcp_snapshot') {
        const snapshot = buildSnapshot(message.fullHtml);
        sendResponse({ success: true, snapshot });
        return;
      }

      // ── v2: inspect → анкеры (shadow/iframe penetration) ────────────
      if (action === 'mcp_inspect') {
        sendResponse({ success: true, ...buildInspect({ limit: message.limit }) });
        return;
      }

      // ── v2: act — anchor|structured target|selector, ambiguity-guarded ─
      if (action === 'mcp_act') {
        sendResponse(performAct(message));
        return;
      }

      // mcp_click / mcp_hover / mcp_fill — теперь проходят через performAct:
      // получают ambiguity-guard + ActionResult-конверт, но принимают и
      // anchor/target, и legacy {selector}. `error` дублирует message →
      // старый MCP-слой (`result.error`/`result.success`) не ломается.
      if (action === 'mcp_click') {
        sendResponse(performAct({ do: 'click', anchor: message.anchor, target: message.target, selector: message.selector }));
        return;
      }

      if (action === 'mcp_hover') {
        // НЕ работает для trusted-only triggers (YouTube inline-preview) —
        // им нужен реальный CDP Input.dispatchMouseEvent.
        const r = performAct({ do: 'hover', anchor: message.anchor, target: message.target, selector: message.selector });
        if (r.success) {
          const el = (resolveTarget({ anchor: message.anchor, target: message.target, selector: message.selector }).matches || [])[0];
          if (el) { const b = el.getBoundingClientRect(); r.rect = { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height }; }
        }
        sendResponse(r);
        return;
      }

      if (action === 'mcp_fill') {
        sendResponse(performAct({ do: 'fill', anchor: message.anchor, target: message.target, selector: message.selector, value: message.value }));
        return;
      }

      if (action === 'mcp_evaluate') {
        // Run in content script context (has full DOM access).
        // For page JS globals, use mode: 'page' (bridges via DOM element).
        if (message.mode === 'page') {
          const resultId = '__mcp_eval_' + Date.now();
          const bridge = document.createElement('div');
          bridge.id = resultId;
          bridge.style.display = 'none';
          document.documentElement.appendChild(bridge);

          const script = document.createElement('script');
          script.textContent = `
            try {
              const __r = (function() { ${message.code} })();
              document.getElementById('${resultId}').setAttribute('data-result', JSON.stringify({result: __r}));
            } catch(e) {
              document.getElementById('${resultId}').setAttribute('data-result', JSON.stringify({error: e.message}));
            }
          `;
          document.documentElement.appendChild(script);
          script.remove();

          const raw = bridge.getAttribute('data-result');
          bridge.remove();

          try {
            const parsed = JSON.parse(raw || '{}');
            if (parsed.error) {
              sendResponse({ success: false, error: parsed.error });
            } else {
              sendResponse({ success: true, result: parsed.result });
            }
          } catch (e) {
            sendResponse({ success: false, error: 'Failed to parse result' });
          }
        } else {
          // Content script context — direct DOM access
          try {
            const fn = new Function(message.code);
            const result = fn();
            sendResponse({ success: true, result });
          } catch (e) {
            sendResponse({ success: false, error: e.message });
          }
        }
        return;
      }

      if (action === 'mcp_get_text') {
        const el = document.querySelector(message.selector || 'body');
        if (!el) {
          sendResponse({ success: false, error: `Element not found: ${message.selector}` });
          return;
        }
        sendResponse({ success: true, text: el.textContent.trim() });
        return;
      }

      if (action === 'mcp_scroll') {
        const pixels = message.amount || 600;
        const y = message.direction === 'up' ? -pixels : pixels;
        window.scrollBy(0, y);
        sendResponse({ success: true });
        return;
      }

      // ── Scroll inside a specific element (virtualized lists) ──────
      if (action === 'mcp_scroll_element') {
        const el = document.querySelector(message.selector);
        if (!el) { sendResponse({ success: false, error: `Element not found: ${message.selector}` }); return; }
        const pixels = message.amount ?? 600;
        const dir = message.direction || 'down';
        if (dir === 'top') el.scrollTop = 0;
        else if (dir === 'bottom') el.scrollTop = el.scrollHeight;
        else el.scrollTop += (dir === 'up' ? -pixels : pixels);
        sendResponse({
          success: true,
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          atTop: el.scrollTop <= 0,
          atBottom: Math.ceil(el.scrollTop + el.clientHeight) >= el.scrollHeight,
        });
        return;
      }

      // ── Get bounding rect of an element (used for screenshots) ────
      if (action === 'mcp_get_element_rect') {
        const el = document.querySelector(message.selector);
        if (!el) { sendResponse({ success: false, error: `Element not found: ${message.selector}` }); return; }
        if (message.scrollIntoView) {
          el.scrollIntoView({ block: 'center', inline: 'center' });
        }
        const r = el.getBoundingClientRect();
        sendResponse({
          success: true,
          rect: { x: r.x, y: r.y, width: r.width, height: r.height },
          dpr: window.devicePixelRatio || 1,
          viewport: { width: window.innerWidth, height: window.innerHeight },
        });
        return;
      }

      // ── Wait for a selector to appear (polling) ───────────────────
      if (action === 'mcp_wait_for_selector') {
        const timeout = message.timeout || 10000;
        const interval = message.interval || 200;
        const visible = !!message.visible;
        const start = Date.now();
        const isVisible = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) return false;
          const s = getComputedStyle(el);
          return s.visibility !== 'hidden' && s.display !== 'none';
        };
        const check = () => {
          const el = document.querySelector(message.selector);
          if (el && (!visible || isVisible(el))) return el;
          return null;
        };
        const poll = () => new Promise((resolve) => {
          (function loop() {
            const el = check();
            if (el) return resolve({ found: true, elapsedMs: Date.now() - start });
            if (Date.now() - start >= timeout) return resolve({ found: false, elapsedMs: Date.now() - start });
            setTimeout(loop, interval);
          })();
        });
        poll().then(r => sendResponse({ success: r.found, ...r }));
        return true; // keep channel open for async sendResponse
      }

      // ── Harvest virtualized list ──────────────────────────────────
      // Scrolls a container from top to bottom, collecting unique items by a
      // dedupe key (innerText hash by default, or a custom attribute).
      if (action === 'mcp_harvest_virtual_list') {
        const container = document.querySelector(message.containerSelector);
        if (!container) { sendResponse({ success: false, error: `Container not found: ${message.containerSelector}` }); return; }
        const itemSelector = message.itemSelector;
        const fields = message.fields || ['textContent'];
        const dedupeAttr = message.dedupeAttr || null;
        const stepPx = message.stepPx || Math.max(200, container.clientHeight - 50);
        const settleMs = message.settleMs || 250;
        const maxSteps = message.maxSteps || 200;
        const maxItems = message.maxItems || 5000;

        const seen = new Map(); // key -> item record

        const extractItem = (el) => {
          const obj = {};
          for (const f of fields) {
            if (f === 'textContent' || f === 'innerText') {
              obj[f] = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500);
            } else if (f === 'outerHTML') {
              obj[f] = el.outerHTML.slice(0, 2000);
            } else {
              obj[f] = el.getAttribute(f) || el[f] || null;
            }
          }
          return obj;
        };

        const dedupeKey = (el, item) => {
          if (dedupeAttr) return el.getAttribute(dedupeAttr);
          const t = item.textContent || item.innerText || el.textContent || '';
          // Stable short hash — order-stable across passes.
          let h = 0; for (let i = 0; i < t.length; i++) { h = ((h << 5) - h + t.charCodeAt(i)) | 0; }
          return String(h) + ':' + t.length;
        };

        const collect = () => {
          const els = container.querySelectorAll(itemSelector);
          for (const el of els) {
            const item = extractItem(el);
            const key = dedupeKey(el, item);
            if (!seen.has(key)) seen.set(key, item);
            if (seen.size >= maxItems) break;
          }
        };

        (async () => {
          // Scroll to top first.
          container.scrollTop = 0;
          await new Promise(r => setTimeout(r, settleMs));
          collect();

          let lastScrollTop = -1;
          for (let step = 0; step < maxSteps; step++) {
            if (seen.size >= maxItems) break;
            container.scrollTop += stepPx;
            await new Promise(r => setTimeout(r, settleMs));
            collect();
            if (container.scrollTop === lastScrollTop) break; // bottom reached
            if (Math.ceil(container.scrollTop + container.clientHeight) >= container.scrollHeight) {
              // One more pass at bottom to catch lazy-rendered tail.
              await new Promise(r => setTimeout(r, settleMs));
              collect();
              break;
            }
            lastScrollTop = container.scrollTop;
          }

          sendResponse({
            success: true,
            items: Array.from(seen.values()),
            count: seen.size,
          });
        })();
        return true; // async sendResponse
      }

      // ── Read localStorage / sessionStorage ────────────────────────
      if (action === 'mcp_get_storage') {
        const type = message.type || 'local';
        const store = type === 'session' ? window.sessionStorage : window.localStorage;
        const out = {};
        try {
          for (let i = 0; i < store.length; i++) {
            const key = store.key(i);
            if (message.keyPrefix && !key.startsWith(message.keyPrefix)) continue;
            out[key] = store.getItem(key);
          }
          sendResponse({ success: true, type, data: out });
        } catch (e) {
          sendResponse({ success: false, error: e.message });
        }
        return;
      }

      sendResponse({ success: false, error: `Unknown MCP action: ${action}` });

    } catch (e) {
      sendResponse({ success: false, error: e.message });
    }
  });

  console.log('[MCP CS] Content script loaded on', window.location.href);
}
