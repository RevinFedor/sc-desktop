// SC Browser Parser — research через chatgpt.com.
//
// Триггер: вкладка открыта на chatgpt.com/?sc-research=<requestId> (query;
// дублируется в #hash на случай если SPA срежет query до document_idle).
// requestId — в bridge'е, забираем GET /research-job.
//
// Flow:
//   1. Дождаться #prompt-textarea (ProseMirror contenteditable).
//   2. Выбрать уровень интеллекта (composer-pill → menuitemradio):
//      instant/medium/high/xhigh (default) — плоские пункты;
//      pro/pro-extended — сначала radio «Pro», потом стандартный/расширенный
//      в сабменю composer-intelligence-pro-thinking-effort-trigger.
//      Модель выбирается перед effort: GPT-5.5 / 5.4 / 5.3 / 5.2 / 4.5 / o3.
//   3. Paste prompt (ClipboardEvent + DataTransfer — ProseMirror его принимает,
//      как Lexical у Perplexity).
//   4. Click [data-testid="send-button"].
//   5. Done-watcher: stop-button ([data-testid="stop-button"]) исчез + quiet 3с.
//      Кнопка композера имеет 3 состояния: голосовой режим (пусто) →
//      отправить (есть текст) → остановить (стримит) → голос/отправить (done).
//   6. Extract: последний [data-message-author-role="assistant"] → .markdown,
//      ждём стабилизации длины (стрим рендерится прогрессивно).
//   7. Источники: чип button[aria-label="Источники"] под ответом → click →
//      справа section[aria-label="Детали рассуждения"] (активность, «Думал на
//      протяжении X», ссылки). Парсим ВСЕГДА (result.sources), закрываем панель.
//      В result.text источники включаются ТОЛЬКО при options.sources=true —
//      по умолчанию текст чистый (см. fact-deep-research.md::ChatGPT).
//
// Селекторы предпочитают data-testid (стабильны между локалями); aria-label
// фолбэки покрывают RU + EN. Спарсено с живого chatgpt.com 2026-06 (RU UI).
//
// Anti-throttle: keepalive port + SW poke + rAF-throttled MutationObserver —
// тот же паттерн что perplexity-research.js / claude-research.js.

(function () {
  'use strict';

  const BRIDGE = 'http://127.0.0.1:53127';
  const TAG = '[SC-GR]'; // gpt-research
  const MAX_FLOW_MS = 30 * 60 * 1000;

  function dbgSink() {
    let n = document.getElementById('sc-research-dbg-log');
    if (n && n.isConnected) return n;
    n = document.createElement('pre');
    n.id = 'sc-research-dbg-log';
    n.style.cssText = 'position:fixed;left:-99999px;top:0;width:0;height:0;visibility:hidden;pointer-events:none;';
    (document.body || document.documentElement).appendChild(n);
    return n;
  }
  const log = (tag, data) => {
    try { console.log(TAG, tag, data || ''); } catch {}
    try {
      const t = (performance.now() / 1000).toFixed(3);
      const entry = `${t}s [${tag}] ` + (data == null ? '' : (typeof data === 'string' ? data : JSON.stringify(data)));
      const sink = dbgSink();
      sink.textContent = (sink.textContent || '') + '\n' + entry;
    } catch {}
  };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // SW-driven watchdog: chrome.alarms каждые 30с шлёт {__sc_research_poke},
  // listener форсирует tick в throttled/hidden вкладке. См. fact-deep-research.md.
  try {
    chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
      if (req && req.__sc_research_poke === true) {
        const fn = window.__scResearchPoke;
        if (typeof fn === 'function') {
          try { fn(); } catch (_) {}
          log('poke.handled');
        } else {
          log('poke.no_handler');
        }
        sendResponse({ ok: true });
        return false;
      }
      return undefined;
    });
  } catch (e) {
    log('poke.listener_setup_failed', { err: e?.message });
  }

  // requestId: query (?sc-research=) + дубль в hash. ChatGPT после submit'а
  // pushState'ит на /c/<uuid> без query — persistence через window.name
  // (формат sc-research:<id>:<startTsMs>), как у perplexity.
  const WINDOW_NAME_PREFIX = 'sc-research:';
  let researchStartTs = null;
  function getRequestId() {
    const u = new URL(location.href);
    const fromHash = (u.hash || '').match(/sc-research=([\w-]+)/);
    if (fromHash) {
      researchStartTs = Date.now();
      try { window.name = WINDOW_NAME_PREFIX + fromHash[1] + ':' + researchStartTs; } catch (_) {}
      return fromHash[1];
    }
    const fromQuery = u.searchParams.get('sc-research');
    if (fromQuery) {
      researchStartTs = Date.now();
      try { window.name = WINDOW_NAME_PREFIX + fromQuery + ':' + researchStartTs; } catch (_) {}
      return fromQuery;
    }
    try {
      const wn = String(window.name || '');
      if (wn.startsWith(WINDOW_NAME_PREFIX)) {
        const rest = wn.slice(WINDOW_NAME_PREFIX.length);
        const parts = rest.split(':');
        const id = parts[0];
        const ts = parseInt(parts[1] || '0', 10);
        if (id) {
          researchStartTs = Number.isFinite(ts) && ts > 0 ? ts : Date.now();
          log('main.id_from_window_name', { id, ageMs: Date.now() - researchStartTs });
          return id;
        }
      }
    } catch (_) {}
    return null;
  }

  // bfetch: page→bridge с SW-fallback (см. scBridgeFetch в research-badge.js).
  // LNA-диалог (Chromium 138+) на фоновой вкладке не показывается — page-fetch
  // молча висит до таймаута (этот самый кейс ловили на chatgpt.com), SW-канал живой.
  function bfetch(path, init) {
    if (typeof window.scBridgeFetch === 'function') return window.scBridgeFetch(path, init);
    return fetch(BRIDGE + path, init);
  }

  async function fetchJob(id) {
    const r = await bfetch('/research-job?id=' + encodeURIComponent(id));
    if (!r.ok) throw new Error('fetchJob http ' + r.status);
    return await r.json();
  }
  async function bridgeLog(tag, data, idOrNull, tabIdOrNull) {
    try {
      await bfetch('/research-log', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: idOrNull || null, tabId: tabIdOrNull ?? null, tag, url: location.href, data }),
      });
    } catch (_) { /* fire-and-forget */ }
  }

  function getMyTabId() {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ __sc_get_tab_id: true }, r => {
          if (chrome.runtime.lastError) { resolve(null); return; }
          resolve(r?.tabId ?? null);
        });
      } catch (_) { resolve(null); }
    });
  }
  async function recoverIdByTabId() {
    const tabId = await getMyTabId();
    if (tabId == null) { log('recover.no_tabid'); return null; }
    try {
      const r = await bfetch('/research-by-tab?tabId=' + tabId);
      if (!r.ok) { log('recover.no_active', { tabId, status: r.status }); return null; }
      const data = await r.json();
      if (!data?.id) return null;
      log('recover.hit', { tabId, id: data.id, jobStatus: data.status });
      researchStartTs = data.createdAt || Date.now();
      try { window.name = WINDOW_NAME_PREFIX + data.id + ':' + researchStartTs; } catch (_) {}
      return data.id;
    } catch (e) { log('recover.threw', { err: e?.message }); return null; }
  }

  async function postState(id, patch) {
    try {
      // provider в каждом запросе — bridge respin восстанавливает job по нему.
      const r = await bfetch('/research-state', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, provider: 'chatgpt', ...patch }),
      });
      if (!r.ok) log('postState.http_err', { status: r.status });
    } catch (e) { log('postState.threw', { err: e?.message || String(e) }); }
  }

  // Терминальный (status=done/error) postState С ПОДТВЕРЖДЕНИЕМ. Обычный
  // postState — fire-and-forget (глотает ошибки, ничего не возвращает): для
  // промежуточных stage'ей это ок, но для ФИНАЛА недостаточно. Если финальный
  // POST потерялся (LNA-таймаут, вкладка уже начала рваться), bridge остаётся в
  // running, а teardown снимает оба предохранителя (stopKeepAlive → SW
  // RESEARCH_TABS.delete → onRemoved молчит) → job зомби-running навсегда
  // (живой кейс ryccfz: watcher.done сработал, done-POST не долетел, вкладка
  // закрылась, tab-closed fallback обезоружен). Контракт: POST → читаем
  // echo-snapshot (/research-state отвечает publicSnapshot) → подтверждаем что
  // bridge смерджил нужный status. Ретраи с backoff; первый attempt идёт
  // page-каналом, при сетевом провале scBridgeFetch sticky-переключается на
  // SW-канал (LNA-иммунный) — ровно тот путь, что довезёт потерянный POST.
  // Возвращает true только если bridge подтвердил terminal-state.
  async function postTerminalState(id, patch, attempts = 5) {
    const want = patch.status;
    for (let i = 0; i < attempts; i++) {
      try {
        const r = await bfetch('/research-state', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, provider: 'chatgpt', ...patch }),
        });
        if (r.ok) {
          let snap = null; try { snap = await r.json(); } catch (_) {}
          if (snap && snap.status === want) return true;
          log('postTerminal.unconfirmed', { attempt: i, got: snap?.status || null, want });
        } else {
          log('postTerminal.http_err', { attempt: i, status: r.status });
        }
      } catch (e) {
        log('postTerminal.threw', { attempt: i, err: e?.message || String(e) });
      }
      await sleep(Math.min(2000, 300 * (i + 1)));
    }
    bridgeLog('gpt.terminal.giveup', { id, want, attempts }, id, null);
    return false;
  }

  async function waitFor(predicate, why, timeoutMs = 15000, intervalMs = 200) {
    const t0 = performance.now();
    while (true) {
      let v; try { v = predicate(); } catch (_) { v = null; }
      if (v) return v;
      if (performance.now() - t0 > timeoutMs) throw new Error('timeout: ' + why);
      await sleep(intervalMs);
    }
  }

  // ── Селекторы композера. data-testid стабильны между RU/EN локалями. ──
  function findComposer()  { return document.getElementById('prompt-textarea'); }
  function findSendBtn() {
    return document.querySelector('[data-testid="send-button"]')
        || document.getElementById('composer-submit-button');
  }
  function findStopBtn() {
    const byId = document.querySelector('[data-testid="stop-button"]');
    if (byId) return byId;
    const submit = document.getElementById('composer-submit-button');
    if (submit) {
      const label = submit.getAttribute('aria-label') || submit.getAttribute('data-testid') || '';
      if (/останов|stop|interrupt|cancel|прервать/i.test(label)) return submit;
    }
    return Array.from(document.querySelectorAll('button[aria-label]'))
      .find(b => /^(Остановить|Stop)/i.test(b.getAttribute('aria-label') || ''));
  }
  function findVoiceBtn() {
    return Array.from(document.querySelectorAll('button[aria-label]'))
      .find(b => /голосовой режим|voice mode/i.test(b.getAttribute('aria-label') || ''));
  }

  function nativeMouseClick(el) {
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(t => {
      el.dispatchEvent(new MouseEvent(t, { bubbles:true, cancelable:true, view:window, clientX:x, clientY:y, button:0 }));
    });
  }
  function nativeHover(el) {
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    ['pointerover','pointerenter','pointermove','mouseover','mouseenter','mousemove'].forEach(t => {
      el.dispatchEvent(new MouseEvent(t, { bubbles:true, cancelable:true, view:window, clientX:x, clientY:y }));
    });
  }
  function pressEscape() {
    document.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', code:'Escape', keyCode:27, which:27, bubbles:true }));
    document.dispatchEvent(new KeyboardEvent('keyup',   { key:'Escape', code:'Escape', keyCode:27, which:27, bubbles:true }));
  }
  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return !!(r.width || r.height || el.getClientRects().length);
  }
  function visibleAll(selector) {
    return Array.from(document.querySelectorAll(selector)).filter(isVisible);
  }
  function nodeText(el) {
    return (el?.textContent || '').trim().replace(/\s+/g, ' ');
  }

  // ── Реестр уровней интеллекта (effort). ЕДИНОЕ место. ──────────────
  // Плоские уровни — menuitemradio прямо в меню композер-pill'а;
  // pro-уровни: верхнеуровневый radio «Pro» включает режим, а стандартный/
  // расширенный выбирается в сабменю. match покрывает RU («Очень высокий») и EN.
  // xhigh — дефолт (юзер: «по умолчанию 5.5, режим очень высокий»;
  // «Очень высокий» в вебе = xhigh из Codex CLI).
  const EFFORTS = [
    { key: 'instant',      match: /^Instant$/i,                          sub: false, aliases: ['instant'] },
    { key: 'medium',       match: /^Medium$/i,                           sub: false, aliases: ['medium', 'mid'] },
    { key: 'high',         match: /^High$/i,                             sub: false, aliases: ['high'] },
    { key: 'xhigh',        match: /^(Очень высокий|Extra\s*high)$/i,     sub: false, aliases: ['xhigh', 'x-high', 'extra high', 'очень высокий', 'very high'] },
    { key: 'pro',          match: /^(Pro стандартный|Pro standard)$/i,   sub: true,  aliases: ['pro', 'pro-standard', 'pro стандартный'] },
    { key: 'pro-extended', match: /^(Pro расширенный|Pro extended)$/i,   sub: true,  aliases: ['pro-extended', 'pro-ext', 'extended', 'pro расширенный'] },
  ];
  const DEFAULT_EFFORT = 'xhigh';
  function resolveEffort(input) {
    if (!input) return DEFAULT_EFFORT;
    const q = String(input).trim().toLowerCase();
    const hit = EFFORTS.find(e => e.key === q)
             || EFFORTS.find(e => e.aliases.some(a => a === q))
             || EFFORTS.find(e => e.aliases.some(a => q.includes(a) || a.includes(q)));
    return hit ? hit.key : DEFAULT_EFFORT;
  }
  function effortLabel(key) {
    return ({ instant: 'Instant', medium: 'Medium', high: 'High', xhigh: 'Очень высокий',
              pro: 'Pro стандартный', 'pro-extended': 'Pro расширенный' })[key] || key;
  }

  // ── Реестр моделей. В том же меню composer-pill'а пункт «GPT-5.5»
  // (role=menuitem, текст = ТЕКУЩАЯ модель) раскрывает сабменю с radio:
  // 5.5 / 5.4 / 5.3 / 5.2 / 4.5 / o3 (живой DOM 2026-06). ChatGPT запоминает
  // выбор per-аккаунт — поэтому модель ВСЕГДА верифицируем, не «скип если
  // дефолт»: прошлый job мог оставить o3.
  const MODELS = [
    { key: '5.5', aliases: ['5.5', 'gpt-5.5', 'gpt5.5', 'gpt 5.5'] },
    { key: '5.4', aliases: ['5.4', 'gpt-5.4', 'gpt5.4'] },
    { key: '5.3', aliases: ['5.3', 'gpt-5.3', 'gpt5.3'] },
    { key: '5.2', aliases: ['5.2', 'gpt-5.2', 'gpt5.2'] },
    { key: '4.5', aliases: ['4.5', 'gpt-4.5', 'gpt4.5'] },
    { key: 'o3',  aliases: ['o3', 'gpt-o3'] },
  ];
  const DEFAULT_MODEL = '5.5';
  function resolveModel(input) {
    if (!input) return DEFAULT_MODEL;
    const q = String(input).trim().toLowerCase();
    const hit = MODELS.find(m => m.key === q)
             || MODELS.find(m => m.aliases.includes(q))
             || MODELS.find(m => m.aliases.some(a => q.includes(a)));
    return hit ? hit.key : DEFAULT_MODEL;
  }
  function modelDisplay(key) { return key === 'o3' ? 'o3' : 'GPT-' + key; }

  // Composer-pill — триггер меню интеллекта. Класс __composer-pill +
  // aria-haspopup="menu"; текст = текущий уровень (короткий: Pro / High / …).
  // Фильтр по тексту отсекает сайдбарные haspopup-кнопки («Недавние чаты»).
  function findEffortTrigger() {
    const pills = Array.from(document.querySelectorAll('button[aria-haspopup="menu"]'))
      .filter(isVisible);
    return pills.find(b => (b.className || '').includes('__composer-pill'))
        || pills.find(b => {
             const t = nodeText(b);
             return t.length < 30 && /^(Pro|Instant|Medium|High|Очень высокий|Extra\s*high|Auto)/i.test(t);
           });
  }
  function findEffortItem(eff) {
    return visibleAll('[role="menuitemradio"]')
      .find(el => eff.match.test(nodeText(el)));
  }
  function findProMainItem() {
    return visibleAll('[role="menuitemradio"]')
      .find(el => /^Pro$/i.test(nodeText(el)));
  }
  function findAnyProDetailItem() {
    return visibleAll('[role="menuitemradio"]')
      .find(el => /^(Pro стандартный|Pro standard|Pro расширенный|Pro extended)$/i.test(nodeText(el)));
  }
  function effortMenuSnapshot() {
    return visibleAll('[role="menuitemradio"], [role="menuitem"]')
      .map(el => ({
        text: nodeText(el),
        role: el.getAttribute('role'),
        checked: el.getAttribute('aria-checked'),
        expanded: el.getAttribute('aria-expanded'),
        testid: el.getAttribute('data-testid'),
      }))
      .filter(x => x.text || x.testid);
  }
  function findProSubTrigger() {
    return visibleAll('[data-testid="composer-intelligence-pro-thinking-effort-trigger"]')[0] || null;
  }
  // Сабменю-триггер модели: role=menuitem, текст = текущая модель
  // («GPT-5.5» / «GPT-5.4» / «o3»). testid у него нет — матчим текстом.
  function findModelSubTrigger() {
    return visibleAll('[role="menuitem"]')
      .find(el => /^(GPT-[\d.]+|o3)$/i.test(nodeText(el)));
  }
  // Пункт модели в раскрытом сабменю — radio с КОРОТКИМ текстом («5.5», «o3»).
  // Точный матч: «5.5» не должен ловить «Очень высокий» и пр.
  function findModelItem(modelKey) {
    return visibleAll('[role="menuitemradio"]')
      .find(el => nodeText(el) === modelKey);
  }

  // Выбор модели — verify-and-retry, та же механика что ensureEffortSelected.
  // Не-фатально: при провале продолжаем на текущей модели аккаунта.
  async function ensureModelSelected(modelKey) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await openEffortMenu();
        const sub = await waitFor(() => findModelSubTrigger(), 'model submenu trigger (GPT-x)', 8000);
        // Сабменю-триггер показывает текущую модель — если уже она, готово.
        const curLabel = (sub.textContent || '').trim();
        if (curLabel === modelDisplay(modelKey)) {
          log('model.already_set', { model: modelKey });
          bridgeLog('gpt.model.already_set', { model: modelKey }, getRequestId(), null);
          pressEscape(); await sleep(200);
          return true;
        }
        nativeHover(sub);
        await sleep(700);
        if (!findModelItem(modelKey)) { nativeMouseClick(sub); await sleep(700); }
        const item = await waitFor(() => findModelItem(modelKey), 'model item: ' + modelKey, 8000);
        if (item.getAttribute('aria-checked') === 'true') {
          log('model.already_checked', { model: modelKey });
          pressEscape(); await sleep(200);
          return true;
        }
        nativeMouseClick(item);
        await sleep(600);
        // verify через переоткрытие: сабменю-триггер должен показать новую модель.
        await openEffortMenu();
        const after = findModelSubTrigger();
        const ok = after && (after.textContent || '').trim() === modelDisplay(modelKey);
        pressEscape(); await sleep(200);
        if (ok) {
          log('model.selected', { model: modelKey, attempt });
          bridgeLog('gpt.model.selected', { model: modelKey, attempt }, getRequestId(), null);
          return true;
        }
        log('model.verify_failed', { model: modelKey, attempt, shows: after ? (after.textContent||'').trim() : null });
      } catch (e) {
        log('model.attempt_threw', { attempt, err: e?.message });
        pressEscape(); await sleep(200);
      }
    }
    log('model.select_failed', { model: modelKey });
    bridgeLog('gpt.model.select_failed', { model: modelKey }, getRequestId(), null);
    return false;
  }

  async function openEffortMenu() {
    const trigger = await waitFor(() => findEffortTrigger(), 'effort trigger (composer pill)', 15000);
    if (trigger.getAttribute('aria-expanded') !== 'true') {
      nativeMouseClick(trigger);
      await sleep(500);
      if (trigger.getAttribute('aria-expanded') !== 'true') {
        nativeMouseClick(trigger);
        await sleep(500);
      }
    }
    return trigger;
  }
  async function openProSubmenu() {
    const sub = await waitFor(() => findProSubTrigger(), 'pro submenu trigger', 8000);
    nativeHover(sub);
    await sleep(500);
    if (!findAnyProDetailItem()) {
      nativeMouseClick(sub);
      await sleep(700);
    }
    await waitFor(() => findAnyProDetailItem(), 'pro submenu items', 4000, 150);
    return sub;
  }

  async function ensureProMainSelected(attempt) {
    await openEffortMenu();
    const top = await waitFor(() => findProMainItem(), 'pro main effort item', 8000);
    if (top.getAttribute('aria-checked') === 'true') return { ok: true, changed: false };
    log('effort.pro_top.click', { attempt, checked: top.getAttribute('aria-checked') });
    nativeMouseClick(top);
    await sleep(700);
    await openEffortMenu();
    const after = findProMainItem();
    const ok = !!after && after.getAttribute('aria-checked') === 'true';
    if (ok) {
      bridgeLog('gpt.effort.pro_top.selected', { attempt }, getRequestId(), null);
      return { ok: true, changed: true };
    }
    log('effort.pro_top.verify_failed', { attempt, items: effortMenuSnapshot() });
    bridgeLog('gpt.effort.pro_top.verify_failed', { attempt, items: effortMenuSnapshot() }, getRequestId(), null);
    return { ok: false, changed: false };
  }

  async function ensureProDetailSelected(eff, attempt) {
    await openEffortMenu();
    await openProSubmenu();
    const item = await waitFor(() => findEffortItem(eff), 'pro detail item: ' + eff.key, 8000);
    if (item.getAttribute('aria-checked') === 'true') return { ok: true, changed: false };
    log('effort.pro_detail.click', { effort: eff.key, attempt, checked: item.getAttribute('aria-checked') });
    nativeMouseClick(item);
    await sleep(700);
    await openEffortMenu();
    await openProSubmenu();
    const after = findEffortItem(eff);
    const ok = !!after && after.getAttribute('aria-checked') === 'true';
    if (ok) {
      bridgeLog('gpt.effort.pro_detail.selected', { effort: eff.key, attempt }, getRequestId(), null);
      return { ok: true, changed: true };
    }
    log('effort.pro_detail.verify_failed', { effort: eff.key, attempt, items: effortMenuSnapshot() });
    bridgeLog('gpt.effort.pro_detail.verify_failed', { effort: eff.key, attempt, items: effortMenuSnapshot() }, getRequestId(), null);
    return { ok: false, changed: false };
  }

  // Выбор уровня + verify-and-retry. Меню закрывается на radio-select —
  // verify через ПОВТОРНОЕ открытие и чтение aria-checked (pill-текст лагает,
  // живой probe: после клика Instant pill ещё показывал «Pro»). Не-фатально:
  // при провале логируем effort_select_failed и продолжаем на дефолте аккаунта
  // (лучше research на неточном уровне, чем убитый job).
  async function ensureEffortSelected(effortKey) {
    const eff = EFFORTS.find(e => e.key === effortKey);
    if (!eff) { log('effort.unknown', { effortKey }); return false; }
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        if (eff.sub) {
          const top = await ensureProMainSelected(attempt);
          if (!top.ok) continue;
          const detail = await ensureProDetailSelected(eff, attempt);
          if (!detail.ok) continue;
          pressEscape(); await sleep(200);
          if (!top.changed && !detail.changed) {
            log('effort.already_set', { effort: eff.key });
            bridgeLog('gpt.effort.already_set', { effort: eff.key }, getRequestId(), null);
          } else {
            log('effort.selected', { effort: eff.key, attempt });
            bridgeLog('gpt.effort.selected', { effort: eff.key, attempt }, getRequestId(), null);
          }
          return true;
        }
        await openEffortMenu();
        const item = await waitFor(() => findEffortItem(eff), 'effort item: ' + eff.key, 8000);
        if (item.getAttribute('aria-checked') === 'true') {
          log('effort.already_set', { effort: eff.key });
          bridgeLog('gpt.effort.already_set', { effort: eff.key }, getRequestId(), null);
          pressEscape(); await sleep(200);
          return true;
        }
        nativeMouseClick(item);
        await sleep(600);
        // verify: меню после select закрыто — переоткрываем и читаем checked.
        await openEffortMenu();
        const after = findEffortItem(eff);
        const ok = after && after.getAttribute('aria-checked') === 'true';
        pressEscape(); await sleep(200);
        if (ok) {
          log('effort.selected', { effort: eff.key, attempt });
          bridgeLog('gpt.effort.selected', { effort: eff.key, attempt }, getRequestId(), null);
          return true;
        }
        log('effort.verify_failed', { effort: eff.key, attempt });
      } catch (e) {
        log('effort.attempt_threw', { attempt, err: e?.message });
        pressEscape(); await sleep(200);
      }
    }
    log('effort.select_failed', { effort: eff.key });
    // В bridge — вкладка умирает на auto-close, DOM-лог недоступен post-mortem.
    bridgeLog('gpt.effort.select_failed', { effort: eff.key }, getRequestId(), null);
    return false;
  }

  // ── Paste + submit ──────────────────────────────────────────────────
  function pasteIntoComposer(text) {
    const ed = findComposer();
    if (!ed) throw new Error('no composer');
    ed.focus();
    // ProseMirror принимает синтетический ClipboardEvent с DataTransfer —
    // тот же путь что Lexical у Perplexity (execCommand из isolated world
    // ProseMirror тоже игнорирует).
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    ed.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
  }

  function bytesFromBase64(base64) {
    const bin = atob(base64 || '');
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function arrayBufferToBase64(buf) {
    const bytes = new Uint8Array(buf || new ArrayBuffer(0));
    let s = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(s);
  }
  function contentTypeExt(type) {
    const t = String(type || '').toLowerCase();
    if (t.includes('jpeg') || t.includes('jpg')) return '.jpg';
    if (t.includes('webp')) return '.webp';
    if (t.includes('gif')) return '.gif';
    return '.png';
  }
  function composerRoot() {
    return findComposer()?.closest('form') || document.body;
  }
  function findUploadInputFor(file) {
    const image = String(file?.type || '').startsWith('image/');
    if (image) {
      return document.querySelector('#upload-photos')
          || document.querySelector('[data-testid="upload-photos-input"]')
          || document.querySelector('input[type="file"][accept*="image"]')
          || document.querySelector('#upload-files');
    }
    return document.querySelector('#upload-files') || document.querySelector('input[type="file"]');
  }
  async function fetchAttachmentFile(id, meta) {
    const r = await bfetch('/research-attachment?id=' + encodeURIComponent(id) + '&index=' + encodeURIComponent(meta.index));
    if (!r.ok) throw new Error('attachment fetch http ' + r.status);
    const data = await r.json();
    const bytes = bytesFromBase64(data.base64);
    return new File([bytes], data.name || meta.name || ('attachment-' + meta.index), {
      type: data.mime || meta.mime || 'application/octet-stream',
    });
  }
  async function uploadAttachments(id, metas) {
    const list = Array.isArray(metas) ? metas : [];
    if (!list.length) return [];
    const files = [];
    for (const meta of list) files.push(await fetchAttachmentFile(id, meta));
    const input = await waitFor(() => findUploadInputFor(files[0]), 'upload file input', 15000, 250);
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    log('attachments.change_dispatched', { count: files.length, names: files.map(f => f.name) });
    bridgeLog('gpt.attachments.change_dispatched', { count: files.length, names: files.map(f => f.name) }, id, null);

    // ChatGPT рендерит attachment-preview внутри composer form. Точные
    // testid менялись; для image-flow достаточно дождаться любого локального
    // preview/img или имени файла. Если селектор снова поменяется, не зависаем:
    // через 60с продолжаем, clickSend сам проверит принятие prompt'а.
    const names = files.map(f => f.name).filter(Boolean);
    const ok = await (async () => {
      const t0 = performance.now();
      while (performance.now() - t0 < 60000) {
        const root = composerRoot();
        const txt = root.textContent || '';
        if (names.some(n => txt.includes(n))) return true;
        if (root.querySelector('img, [data-testid*="attachment"], [data-testid*="file"], [aria-label*="Удалить"], [aria-label*="Remove"], [aria-label*="preview" i]')) return true;
        await sleep(500);
      }
      return false;
    })();
    log('attachments.preview_wait_done', { ok, count: files.length });
    bridgeLog('gpt.attachments.preview_wait_done', { ok, count: files.length }, id, null);
    return files;
  }

  async function clickSend() {
    // Send-button рендерится только когда композер непустой (вместо него в
    // idle — кнопка голосового режима). Появление = paste принят.
    const btn = await waitFor(() => findSendBtn(), 'send button (composer non-empty)', 10000);
    btn.click();
    await sleep(1000);
    // Успех: stop появился ИЛИ send исчез (началась генерация).
    if (findStopBtn() || !findSendBtn()) return;
    // Fallback: полный pointer-chain.
    const again = findSendBtn();
    if (again) { nativeMouseClick(again); await sleep(800); }
    if (!findStopBtn() && findSendBtn()) throw new Error('chatgpt_submit_failed: send click had no effect');
  }

  // ── Extract: последний assistant-ответ ──────────────────────────────
  function lastAssistantEl() {
    const all = document.querySelectorAll('[data-message-author-role="assistant"]');
    return all[all.length - 1] || null;
  }
  function readAnswerText() {
    const el = lastAssistantEl();
    if (!el) return '';
    // У thinking-ответов (xhigh/pro) ДВА .markdown: сводка рассуждений
    // (.result-thinking.markdown) и финальный ответ. Thinking исключаем,
    // берём последний не-thinking (живой DOM: result-thinking идёт первым).
    const mds = Array.from(el.querySelectorAll('.markdown'))
      .filter(m => !m.classList.contains('result-thinking'));
    const md = mds[mds.length - 1];
    // textContent first — innerText в hidden tab пуст (Blink не делает layout
    // для скрытых вкладок, innerText построен на layout). Тот же шрам что в
    // aistudio-core.js::parseLastTurn. Без этого watcher.done никогда не
    // срабатывал в фоновой вкладке: hasAnswer всегда 0.
    return ((md || el).textContent || (md || el).innerText || '').trim();
  }
  // «Думал на протяжении 2m 20s» — кнопка-сводка thinking-блока над ответом.
  function readThinkingLine() {
    const m = (document.body.textContent || '').match(/(?:Думал[а]? на протяжении|Thought for)\s+[^\n]{1,30}/g);
    return m ? m[m.length - 1].trim() : null;
  }
  function readThinkingText() {
    const el = lastAssistantEl();
    if (!el) return '';
    const mds = Array.from(el.querySelectorAll('.markdown.result-thinking, .result-thinking.markdown'));
    const md = mds[mds.length - 1];
    return ((md?.textContent || md?.innerText || '')).trim();
  }

  async function extractAnswerStable() {
    // Ответ стримится прогрессивно; ждём стабилизации длины (2 пробы × 800мс),
    // cap 30с — паттерн perplexity-research.js::extractAnswerText шаг 2.
    const STABLE_REPS = 2, PROBE_MS = 800, MAX_MS = 30000;
    const t0 = performance.now();
    let lastLen = -1, stable = 0, best = '';
    while (performance.now() - t0 < MAX_MS) {
      const txt = readAnswerText();
      if (txt) {
        best = txt;
        if (txt.length === lastLen) {
          stable++;
          if (stable >= STABLE_REPS) break;
        } else { stable = 0; lastLen = txt.length; }
      }
      await sleep(PROBE_MS);
    }
    return best;
  }

  function collectGeneratedImages(excludeKeys) {
    const exclude = new Set(Array.isArray(excludeKeys) ? excludeKeys : []);
    const out = [];
    const lastUserTurn = lastUserConversationTurn();
    const containers = Array.from(document.querySelectorAll('div[id^="image-"]'));
    for (const c of containers) {
      const turn = c.closest('[data-testid^="conversation-turn-"]');
      if (lastUserTurn && turn && !(lastUserTurn.compareDocumentPosition(turn) & Node.DOCUMENT_POSITION_FOLLOWING)) {
        continue;
      }
      const imgs = Array.from(c.querySelectorAll('img[src]'));
      const img = imgs.find(x => x.alt && x.src.includes('/backend-api/estuary/content'))
               || imgs.find(x => x.src.includes('/backend-api/estuary/content'))
               || imgs.find(x => /^blob:|^data:image\//i.test(x.src || ''));
      if (!img) continue;
      const key = `${c.id || ''}|${img.src || ''}`;
      if (exclude.has(key)) continue;
      if (!img.complete || !img.naturalWidth || !img.naturalHeight) continue;
      const r = c.getBoundingClientRect();
      out.push({
        key,
        container_id: c.id || null,
        src: img.src,
        alt: img.alt || '',
        width: img.naturalWidth,
        height: img.naturalHeight,
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      });
    }
    return out;
  }
  function collectGeneratedImageKeys() {
    const out = [];
    const lastUserTurn = lastUserConversationTurn();
    const containers = Array.from(document.querySelectorAll('div[id^="image-"]'));
    for (const c of containers) {
      const turn = c.closest('[data-testid^="conversation-turn-"]');
      if (lastUserTurn && turn && !(lastUserTurn.compareDocumentPosition(turn) & Node.DOCUMENT_POSITION_FOLLOWING)) {
        continue;
      }
      const imgs = Array.from(c.querySelectorAll('img[src]'));
      const img = imgs.find(x => x.alt && x.src.includes('/backend-api/estuary/content'))
               || imgs.find(x => x.src.includes('/backend-api/estuary/content'))
               || imgs.find(x => /^blob:|^data:image\//i.test(x.src || ''));
      if (img) out.push(`${c.id || ''}|${img.src || ''}`);
    }
    return out;
  }
  function lastUserConversationTurn() {
    const turns = Array.from(document.querySelectorAll('[data-testid^="conversation-turn-"]'));
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].querySelector('[data-message-author-role="user"]')) return turns[i];
    }
    return null;
  }
  async function extractGeneratedImagesStable(excludeKeys) {
    const STABLE_REPS = 2, PROBE_MS = 800, MAX_MS = 30000;
    const t0 = performance.now();
    let stable = 0, lastSig = '', best = [];
    while (performance.now() - t0 < MAX_MS) {
      const cur = collectGeneratedImages(excludeKeys);
      if (cur.length) {
        const sig = cur.map(x => x.key + ':' + x.width + 'x' + x.height).join('|');
        best = cur;
        if (sig === lastSig) {
          stable++;
          if (stable >= STABLE_REPS) break;
        } else { stable = 0; lastSig = sig; }
      }
      await sleep(PROBE_MS);
    }
    return best;
  }
  async function persistGeneratedImages(id, images) {
    const out = [];
    for (let i = 0; i < (images || []).length; i++) {
      const img = images[i];
      try {
        const r = await fetch(img.src, { credentials: 'include' });
        if (!r.ok) throw new Error('image fetch http ' + r.status);
        const blob = await r.blob();
        const contentType = blob.type || 'image/png';
        const base64 = arrayBufferToBase64(await blob.arrayBuffer());
        const name = `chatgpt-${img.container_id || 'image'}-${i + 1}${contentTypeExt(contentType)}`;
        const savedR = await bfetch('/research-artifact', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, provider: 'chatgpt', kind: 'image', name, contentType, base64 }),
        });
        if (!savedR.ok) throw new Error('artifact save http ' + savedR.status);
        const saved = await savedR.json();
        out.push({
          ...img,
          source_url: img.src,
          file_path: saved.file_path || null,
          file_name: saved.name || name,
          content_type: saved.content_type || contentType,
          bytes: saved.bytes ?? blob.size,
        });
      } catch (e) {
        log('image.persist_failed', { idx: i, err: e?.message || String(e) });
        out.push({ ...img, source_url: img.src, error: e?.message || String(e) });
      }
    }
    return out;
  }

  // ── Источники (правая панель «Детали рассуждения») ──────────────────
  // Чип «Источники» в action-bar последнего ответа → клик → справа панель:
  //   Активность · 2m 20s / «Думал на протяжении X» / Источники · N / ссылки.
  // Парсим ВСЕГДА; в text включается только при options.sources (см. main).
  function findSourcesChip() {
    const chips = Array.from(document.querySelectorAll('button[aria-label]'))
      .filter(b => /^(Источники|Sources)$/i.test(b.getAttribute('aria-label') || '') && b.offsetParent);
    return chips[chips.length - 1] || null;
  }
  function findSourcesPanel() {
    return Array.from(document.querySelectorAll('section[aria-label]'))
      .find(s => /рассужден|reasoning/i.test(s.getAttribute('aria-label') || '') && s.offsetParent);
  }
  async function extractSources() {
    const out = { links: [], activity: null, thinking: [], chip_present: false, panel_opened: false };
    const chip = findSourcesChip();
    if (!chip) { log('sources.no_chip'); return out; }
    out.chip_present = true;
    chip.click();
    let panel;
    try {
      panel = await waitFor(() => findSourcesPanel(), 'sources panel', 8000, 250);
    } catch (_) {
      log('sources.panel_timeout');
      return out;
    }
    out.panel_opened = true;
    await sleep(700); // даём ссылкам дорендериться
    const seen = new Set();
    const collect = () => {
      for (const a of panel.querySelectorAll('a[href]')) {
        const href = a.href || '';
        if (!/^https?:/i.test(href)) continue;
        if (/chatgpt\.com|openai\.com/i.test(href)) continue; // внутренняя навигация
        if (seen.has(href)) continue;
        seen.add(href);
        out.links.push({
          url: href,
          // textContent — innerText пуст в hidden tab (см. readAnswerText).
          title: (a.textContent || '').trim().replace(/\s*\n+\s*/g, ' — ').slice(0, 300),
        });
      }
    };
    collect();
    // Список источников виртуализирован/подгружается при скролле: панель
    // показывала «Источники · 47», а в DOM было 8 <a>. Скроллим scrollable-
    // контейнер панели до дна, собирая новые ссылки на каждом шаге; стоп —
    // два шага подряд без новых ссылок или 20 шагов.
    const scroller = [panel, ...panel.querySelectorAll('*')]
      .find(el => el.scrollHeight > el.clientHeight + 40) || panel;
    let idle = 0;
    for (let step = 0; step < 20 && idle < 2; step++) {
      const before = out.links.length;
      scroller.scrollTop = scroller.scrollTop + Math.max(300, scroller.clientHeight);
      await sleep(400);
      collect();
      idle = out.links.length === before ? idle + 1 : 0;
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 10 && out.links.length === before) break;
    }
    log('sources.scroll_done', { links: out.links.length });
    const txt = panel.textContent || '';
    out.thinking = txt.match(/(?:Думал[а]? на протяжении|Thought for)\s+[^\n]{1,30}/g) || [];
    // textContent склеивает блоки без \n — нежадный матч + жёсткий cap, иначе
    // activity заглатывает весь протокол панели (живой capture: 1000+ симв).
    const actM = txt.match(/(?:Активность|Activity)\s*·?\s*(.{1,60})/);
    if (actM) out.activity = cleanActivity(actM[1]);
    // Закрываем панель — она перекрывает чат и держит layout.
    try {
      const closeBtn = Array.from(panel.querySelectorAll('button'))
        .find(b => /^(Закрыть|Close)$/i.test(b.getAttribute('aria-label') || ''));
      closeBtn?.click();
    } catch (_) {}
    log('sources.extracted', { links: out.links.length, thinking: out.thinking.length, activity: out.activity });
    return out;
  }

  function cleanActivity(value) {
    const s = String(value || '').trim();
    const time = s.match(/^((?:\d+\s*(?:h|hr|hrs|m|min|mins|s|sec|secs|ч|час|часа|часов|м|мин|сек|с)\s*){1,4})/i);
    return (time ? time[1] : s).trim();
  }

  // ── Done-watcher ─────────────────────────────────────────────────────
  // Базовое условие: stop-button исчез И (send ИЛИ voice виден) после quiet 3с.
  // 3 состояния кнопки композера: голос (пусто) → отправить (текст) →
  // остановить (стримит); done возвращает голос/отправить.
  //
  // escalation — render-freeze fallback. В hidden tab ChatGPT НЕ коммитит
  // streamed-токены ответа в DOM (message-узел есть, textContent пуст даже
  // после конца генерации; кнопки композера при этом обновляются). Рендер
  // сообщений завязан на rAF/IntersectionObserver — в скрытой вкладке не
  // тикают. autoDiscardable:false не помогает (это не discard). Живой capture:
  // стоп ушёл на 11с, текст «0 chars» 4+ минуты, при фокусе вкладки —
  // мгновенный done. Решение как в aistudio-mcp.js::studio_ready: один раз
  // __sc_focus_self (кратко на передний план) → React дорисовывает → done →
  // restore фокуса в done-handler'е main().
  function startDoneWatcher(onDone, onProgress, escalation, getDoneImages) {
    let stopAppeared = false;
    let lastUrl = location.href;
    const armedAt = Date.now();
    const ARMING_MS = 700;
    const QUIET_WINDOW_MS = 3000;
    // Если stop так и не появился — submit не сработал (paste в пустоту,
    // логин-волл и т.п.). 120с с запасом: Pro-режимы стартуют генерацию
    // мгновенно (stop появляется <1с, живой probe), долгая фаза — само мышление.
    const NO_STOP_FAIL_MS = 120000;
    let lastStopSeenAt = 0;

    let tickN = 0;
    let lastTickSig = null;
    const tick = () => {
      const stop = findStopBtn();
      const send = findSendBtn();
      const voice = findVoiceBtn();
      const now = Date.now();
      if (stop) { stopAppeared = true; lastStopSeenAt = now; }
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        onProgress({ stage: 'running', url: lastUrl, title: document.title });
      }
      const armed = now - armedAt >= ARMING_MS;
      const sinceStopGone = lastStopSeenAt ? (now - lastStopSeenAt) : 0;
      const quietPassed = stopAppeared && sinceStopGone >= QUIET_WINDOW_MS;
      tickN++;
      const sig = [!!stop, !!send, !!voice, stopAppeared, quietPassed].join(',');
      if (sig !== lastTickSig) {
        lastTickSig = sig;
        const dbg = { n: tickN, stop: !!stop, send: !!send, voice: !!voice, stopAppeared, quiet: quietPassed, vis: document.visibilityState };
        log('watcher.tick', dbg);
        bridgeLog('gpt.watcher.tick', dbg, getRequestId(), null);
      }
      if (!armed) return false;
      const imageCount = typeof getDoneImages === 'function' ? getDoneImages().length : 0;
      const hasAnswer = readAnswerText().length > 0;
      if (!stopAppeared) {
        if ((hasAnswer || imageCount > 0) && (send || voice)) {
          log('watcher.done_without_stop', { hasAnswer, imageCount });
          bridgeLog('gpt.watcher.done_without_stop', { hasAnswer, imageCount }, getRequestId(), null);
          onDone({ url: location.href, title: document.title });
          return true;
        }
        if (now - armedAt > NO_STOP_FAIL_MS) {
          onProgress({ stage: 'submit_failed' });
          return true; // terminal
        }
        return false;
      }
      if (stop) return false;
      if (!quietPassed) return false;
      if (!hasAnswer && imageCount === 0) {
        // Стрим закончился (stop ушёл + quiet), а текста в DOM нет — это
        // hidden-tab render-freeze (см. комментарий над watcher'ом). Просим
        // main() один раз сфокусировать вкладку — React дорисует за <1с.
        if (escalation && quietPassed) escalation();
        return false;
      }
      log('watcher.done', { stop_seen: stopAppeared, hasAnswer, imageCount });
      bridgeLog('gpt.watcher.done', { stop_seen: stopAppeared, hasAnswer, imageCount }, getRequestId(), null);
      onDone({ url: location.href, title: document.title });
      return true;
    };

    let fired = false;
    const wrappedTick = () => {
      if (fired) return true;
      const ok = tick();
      if (ok) fired = true;
      return ok;
    };
    if (wrappedTick()) return () => {};

    let scheduled = false;
    const onMutation = () => {
      if (scheduled || fired) return;
      scheduled = true;
      requestAnimationFrame(() => { scheduled = false; wrappedTick(); });
    };
    const mo = new MutationObserver(onMutation);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label', 'disabled', 'data-testid'] });
    const iv = setInterval(() => { try { if (!fired) wrappedTick(); } catch (_) {} }, 2000);
    window.__scResearchTick = () => { try { if (!fired) wrappedTick(); } catch (_) {} };
    const pokeHandler = () => { try { if (!fired) wrappedTick(); } catch (_) {} };
    window.__scResearchPoke = pokeHandler;

    const hardTimer = setTimeout(() => {
      try { mo.disconnect(); } catch {}
      clearInterval(iv);
      if (!fired) onProgress({ stage: 'timeout', url: location.href });
    }, MAX_FLOW_MS);

    return () => {
      try { mo.disconnect(); } catch {}
      clearInterval(iv);
      clearTimeout(hardTimer);
      if (window.__scResearchPoke === pokeHandler) window.__scResearchPoke = null;
      window.__scResearchTick = null;
    };
  }

  function startKeepAlivePort() {
    try {
      const port = chrome.runtime.connect({ name: 'sc-research-keepalive' });
      return () => { try { port.disconnect(); } catch {} };
    } catch (e) {
      log('keepalive.port_fail', { err: e?.message || String(e) });
      return () => {};
    }
  }

  function closeSelfTab(reason) {
    try { chrome.runtime.sendMessage({ __sc_close_self_tab: true, reason }); } catch {}
  }

  async function main() {
    const myTabId = await getMyTabId();
    const bootInfo = {
      url: location.href, query: location.search || '',
      hasWindowName: !!window.name, windowName: (window.name || '').slice(0, 80),
      visibility: document.visibilityState, tabId: myTabId,
    };
    log('cs.boot', bootInfo);
    bridgeLog('cs.boot', bootInfo, null, myTabId);

    let id = getRequestId();
    let recovered = false;
    if (!id) {
      log('main.no_id_try_recover');
      id = await recoverIdByTabId();
      if (!id) { log('main.no_id_recovery_failed'); return; }
      recovered = true;
      bridgeLog('cs.id_from_recovery', { id }, id, myTabId);
    }
    log('main.start', { id, recovered });

    const stopKeepAlive = startKeepAlivePort();
    const hbIv = setInterval(() => { try { log('hb', new Date().toISOString().slice(11, 19)); } catch (_) {} }, 30000);
    const stopHb = () => clearInterval(hbIv);

    let job;
    try { job = await fetchJob(id); }
    catch (e) {
      log('main.fetchJob_fail', { err: e?.message });
      stopHb(); stopKeepAlive();
      return;
    }
    if (job.status === 'done' || job.status === 'error') {
      log('main.already_terminal', { status: job.status });
      stopHb(); stopKeepAlive();
      return;
    }

    // options.model и options.effort — разные оси: модель (5.5/5.4/…/o3) и
    // уровень интеллекта. Раньше effort фолбэчился на options.model — теперь
    // model занят настоящей моделью, фолбэк убран.
    const effortKey = resolveEffort(job.options?.effort);
    const modelKey = resolveModel(job.options?.model);
    const wantSourcesInText = !!job.options?.sources;
    const attachmentMetas = Array.isArray(job.attachments) ? job.attachments : [];

    // MCP-плашка (общий research-badge.js) — юзер видит «вкладка под job'ом».
    try {
      window.scResearchBadge?.show({
        jobId: id, providerLabel: 'ChatGPT',
        modelTitle: modelDisplay(modelKey) + ' · ' + effortLabel(effortKey),
        prompt: job.prompt || '',
      });
    } catch {}

    // После reload/recovery (status=running) submit уже сделан прошлым CS —
    // только watcher, никакого повторного paste (иначе дубль-сообщение в чате).
    const isReloadRestart = recovered || job.status === 'running';
    const imageBaselineKeys = collectGeneratedImageKeys();

    try {
      await waitFor(() => findComposer(), 'composer (#prompt-textarea — логин?)', 20000);
      if (!isReloadRestart) {
        await postState(id, { status: 'running', stage: 'configuring',
          ...(typeof myTabId === 'number' ? { tabId: myTabId } : {}) });
        // Модель ПЕРЕД уровнем: набор уровней зависит от модели (у o3/4.5
        // другой состав пунктов), выбор модели может сбросить уровень.
        // Модель — fatal: ChatGPT помнит выбор per-аккаунт, и при провале
        // verify job молча ответил бы прошлой sticky-моделью (o3 вместо
        // запрошенной 5.5). Контракт тот же, что у claude/submit-verify:
        // ответ чужой моделью хуже ошибки. Effort — non-fatal (неточный
        // уровень терпим, едет на текущем). Вкладку при error не закрываем.
        const okModel = await ensureModelSelected(modelKey);
        if (!okModel) {
          const ok = await postTerminalState(id, {
            status: 'error', stage: 'configuring',
            url: location.href, title: document.title,
            error: `chatgpt_model_select_failed: не удалось выбрать модель ${modelDisplay(modelKey)} (ChatGPT помнит модель per-аккаунт — мог ответить прошлой)`,
          });
          stopHb();
          if (ok) stopKeepAlive(); // не подтвердилось → порт живой, fallback вооружён
          try { window.scResearchBadge?.hide(); } catch {}
          return;
        }
        await ensureEffortSelected(effortKey);
        if (attachmentMetas.length) {
          await postState(id, { stage: 'uploading' });
          await uploadAttachments(id, attachmentMetas);
          await sleep(800);
        }
        await postState(id, { stage: 'submitting' });
        pasteIntoComposer(job.prompt);
        await sleep(800);
        await clickSend();
        await postState(id, { stage: 'running' });
      } else {
        log('main.skip_submit_after_reload');
        await postState(id, { status: 'running', stage: 'running',
          ...(typeof myTabId === 'number' ? { tabId: myTabId } : {}) });
      }

      // Render-freeze escalation: один focus-pulse на job. Watcher зовёт когда
      // стрим завершён, но DOM-текст пуст (hidden tab не рендерит сообщения).
      let escalated = false;
      let prevActiveTabId = null;
      const escalateFocus = () => {
        if (escalated) return;
        escalated = true;
        log('escalate.focus_self (render-freeze: stream done, DOM text empty)');
        bridgeLog('gpt.escalate.focus_self', null, id, myTabId);
        try {
          chrome.runtime.sendMessage({ __sc_focus_self: true }, fr => {
            if (chrome.runtime.lastError) { log('escalate.failed', { err: chrome.runtime.lastError.message }); return; }
            if (fr?.ok) prevActiveTabId = fr.prevTabId ?? null;
          });
        } catch (e) { log('escalate.threw', { err: e?.message }); }
      };
      const restoreFocus = () => {
        if (!escalated || prevActiveTabId == null) return;
        try { chrome.runtime.sendMessage({ __sc_focus_tab: true, tabId: prevActiveTabId }); } catch (_) {}
      };

      const stopWatcher = startDoneWatcher(
        async (final) => {
          await sleep(500);
          // Hidden tab коммитит DOM ЧАСТИЧНО (тест: 55 символов из полного
          // ответа, стабилизация ложно проходит — замороженный DOM не растёт;
          // чип «Источники» тоже не дорисован). Извлечение валидно только на
          // отрисованной вкладке: фокус-пульс перед extract, restore после.
          if (document.visibilityState === 'hidden') {
            escalateFocus();
            const tf = performance.now();
            while (document.visibilityState === 'hidden' && performance.now() - tf < 4000) await sleep(200);
            await sleep(800); // дать React дорисовать после unfreeze
          }
          const text = await extractAnswerStable();
          const generatedImages = await extractGeneratedImagesStable(imageBaselineKeys);
          const persistedImages = await persistGeneratedImages(id, generatedImages);
          const thinkingLine = readThinkingLine();
          const thinkingText = readThinkingText();
          // Источники парсим ВСЕГДА (в result.sources). В text — только по
          // options.sources: дефолтный ответ чистый, источники по параметру.
          const src = await extractSources();
          let outText = text || '';
          if (wantSourcesInText && src.links.length) {
            const block = src.links.map((l, i) => `${i + 1}. ${l.title || l.url} — ${l.url}`).join('\n');
            outText += `\n\n---\nИсточники (${src.links.length}):\n${block}`;
            if (src.activity) outText += `\nАктивность: ${src.activity}`;
          }
          const isShort = outText.length > 0 && outText.length < 800;
          const endsWithQuestion = /\?\s*$/.test(outText);
          const isClarifying = isShort && endsWithQuestion;
          log('watcher.final', { textLen: outText.length, images: persistedImages.length, links: src.links.length, thinking: thinkingLine });
          const confirmed = await postTerminalState(id, {
            status: 'done', stage: 'done',
            url: final.url, title: final.title,
            result: {
              url: final.url, title: final.title,
              text: outText,
              answer_text: text || '',
              images: persistedImages,
              image_count: persistedImages.length,
              reasoning_text: thinkingText || null,
              text_kind: persistedImages.length ? 'image' : 'answer',
              is_image: persistedImages.length > 0,
              // is_research: ChatGPT ходил в веб (есть источники) — аналог
              // research-маркера claude/perplexity.
              is_research: src.links.length > 0,
              is_clarifying: isClarifying,
              sources: src.links,
              sources_meta: {
                activity: src.activity,
                thinking: src.thinking,
                thinking_last: thinkingLine,
                thinking_text: thinkingText || null,
                chip_present: src.chip_present,
                panel_opened: src.panel_opened,
              },
              effort: effortKey,
              model: modelKey,
            },
          });
          try { stopWatcher(); } catch {}
          stopHb();
          try { window.scResearchBadge?.hide(); } catch {}
          restoreFocus(); // если был focus-pulse — вернуть юзера куда был
          // Закрываем вкладку и снимаем keepalive ТОЛЬКО если bridge подтвердил
          // done. Иначе оставляем порт живым (tab-closed fallback остаётся
          // вооружён) и вкладку открытой (ответ виден, юзер может разобрать
          // вручную) — лучше «лишняя вкладка», чем зомби-running.
          if (confirmed) {
            stopKeepAlive();
            closeSelfTab('research_done');
          } else {
            log('done.unconfirmed_keep_tab_open');
          }
        },
        async (prog) => {
          if (prog.stage === 'timeout') {
            const ok = await postTerminalState(id, { status: 'error', stage: 'timeout', error: 'flow timed out (30min)' });
            stopHb();
            if (ok) stopKeepAlive(); // не подтвердилось → порт живой, fallback вооружён
            try { window.scResearchBadge?.hide(); } catch {}
            restoreFocus();
            return; // настоящая ошибка — вкладку НЕ закрываем (ручной разбор)
          }
          if (prog.stage === 'submit_failed') {
            const ok = await postTerminalState(id, { status: 'error', stage: 'submit_failed', error: 'chatgpt_submit_failed: stop-button never appeared in 120s (paste/login?)' });
            stopHb();
            if (ok) stopKeepAlive();
            try { window.scResearchBadge?.hide(); } catch {}
            return;
          }
          await postState(id, { stage: prog.stage, url: prog.url, title: prog.title });
        },
        escalateFocus,
        () => collectGeneratedImages(imageBaselineKeys)
      );
    } catch (e) {
      const msg = e?.message || String(e);
      log('main.flow_err', { err: msg });
      const ok = await postTerminalState(id, { status: 'error', error: msg });
      stopHb();
      if (ok) stopKeepAlive(); // не подтвердилось → порт живой, fallback вооружён
      try { window.scResearchBadge?.hide(); } catch {}
      // Детерминированных known-ошибок (лимиты/lock) у ChatGPT пока нет —
      // любая ошибка = оставить вкладку для ручного разбора.
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => main().catch(e => log('main.uncaught', { err: e?.message })));
  } else {
    main().catch(e => log('main.uncaught', { err: e?.message }));
  }
})();
