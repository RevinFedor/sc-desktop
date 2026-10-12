// SC Browser Parser — automation через chatgpt.com.
//
// Три entrypoint'а используют один низкоуровневый compose-layer:
//   • ?sc-research=<requestId> — MCP/research job: submit → watcher →
//     extract answer/images/sources → POST /research-state.
//     options.readOnlyImport=true превращает этот же tracked flow в импорт
//     уже существующего final: без model picker, composer, paste и Send.
//   • ?sc-compose=<requestId> — одноразовый handoff для YouTube +AI:
//     быстрый режим разворачивает Pasted text в composer; fallback загружает
//     транскрипт как .txt и вводит prompt отдельно. Обычный ChatGPT-чат
//     остаётся без MCP-badge/sources.
//
// requestId для research живёт в bridge'е (GET /research-job). requestId
// для compose живёт в chrome.storage.local (__sc_chatgpt_compose_job_*).
// query дублируется в #hash на случай если SPA срежет query до document_idle.
//
// Flow:
//   1. Дождаться ProseMirror-композера (старый id или текущий semantic marker).
//   2. Выбрать модель и уровень интеллекта (composer-pill → integrated picker).
//      В Chat GPT-6 имеет Instant..Pro; прежний запрос Astra/Pro выбирает
//      ту же версию6, но обязательно уровень Pro. GPT-5.6 Sol сохраняет 5.6
//      и на Pro. Модель выбирается перед effort. В Work также доступны
//      GPT-5.6 Terra и Luna.
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
  const PICKER_REVISION = '2026-10-10-chat-gpt6';
  const UPLOAD_REVISION = '2026-10-10-live-input-preview';
  const COMPOSER_READINESS_REVISION = '2026-10-05-ui-status';
  const WATCHER_REVISION = '2026-10-06-api-observation';
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
  let popupExportRunning = false;
  let popupExportCancel = false;

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
      if (req && req.action === 'getStatus') {
        sendResponse({
          isExporting: popupExportRunning,
          chatgptMode: currentChatgptMode() || 'chat',
        });
        return false;
      }
      if (req && req.action === 'cancel') {
        popupExportCancel = true;
        sendResponse({ success: true });
        return false;
      }
      if (req && req.action === 'export') {
        runChatGPTPopupExport(req.settings || {})
          .then(result => sendResponse(result || { success: true }))
          .catch(error => sendResponse({ success: false, message: error?.message || String(error) }));
        return true;
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
  const COMPOSE_WINDOW_NAME_PREFIX = 'sc-compose:';
  const COMPOSE_JOB_PREFIX = '__sc_chatgpt_compose_job_';
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
  function getComposeId() {
    const u = new URL(location.href);
    const fromHash = (u.hash || '').match(/sc-compose=([\w-]+)/);
    if (fromHash) {
      try { window.name = COMPOSE_WINDOW_NAME_PREFIX + fromHash[1] + ':' + Date.now(); } catch (_) {}
      return fromHash[1];
    }
    const fromQuery = u.searchParams.get('sc-compose');
    if (fromQuery) {
      try { window.name = COMPOSE_WINDOW_NAME_PREFIX + fromQuery + ':' + Date.now(); } catch (_) {}
      return fromQuery;
    }
    try {
      const wn = String(window.name || '');
      if (wn.startsWith(COMPOSE_WINDOW_NAME_PREFIX)) {
        const id = wn.slice(COMPOSE_WINDOW_NAME_PREFIX.length).split(':')[0];
        if (id) {
          log('compose.id_from_window_name', { id });
          return id;
        }
      }
    } catch (_) {}
    return null;
  }

  function normalizeComposeDocument(value) {
    if (!value || typeof value !== 'object') return null;
    const text = typeof value.text === 'string' ? value.text : '';
    if (!text.trim()) return null;
    const rawName = typeof value.name === 'string' ? value.name.trim() : '';
    const name = ((rawName || 'youtube-transcript.txt')
      .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
      .replace(/^[. ]+|[. ]+$/g, '')
      .slice(0, 180)) || 'youtube-transcript.txt';
    const mime = typeof value.mime === 'string' && value.mime.trim()
      ? value.mime.trim()
      : 'text/plain;charset=utf-8';
    return { name, mime, text };
  }

  function normalizeComposeJobPayload(job, id = '') {
    if (!job || typeof job !== 'object') {
      throw new Error('compose_job_missing_or_empty: ' + id);
    }
    const prompt = typeof job.prompt === 'string' ? job.prompt.trim() : '';
    const composeDocument = normalizeComposeDocument(job.document);
    if (!prompt && !composeDocument) {
      throw new Error('compose_job_missing_or_empty: ' + id);
    }
    return {
      ...job,
      prompt,
      document: composeDocument,
      showInTextField: job.showInTextField === true,
    };
  }

  async function fetchComposeJob(id) {
    const key = COMPOSE_JOB_PREFIX + id;
    const got = await new Promise(resolve => {
      chrome.storage.local.get(key, resolve);
    });
    return normalizeComposeJobPayload(got?.[key], id);
  }

  async function removeComposeJob(id) {
    try {
      await new Promise(resolve => {
        chrome.storage.local.remove(COMPOSE_JOB_PREFIX + id, resolve);
      });
    } catch (_) {}
  }

  async function updateComposeJob(id, patch) {
    const key = COMPOSE_JOB_PREFIX + id;
    const current = await fetchComposeJob(id);
    const next = { ...current, ...patch };
    await new Promise(resolve => chrome.storage.local.set({ [key]: next }, resolve));
    return next;
  }

  async function claimComposeTab(id) {
    return await new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ __sc_chatgpt_compose_claim: true, requestId: id }, response => {
          const error = chrome.runtime.lastError;
          resolve(!error && response?.ok === true);
        });
      } catch (_) {
        resolve(false);
      }
    });
  }

  async function reportComposeResult(id, job, result, attempts = 5) {
    const payload = {
      __sc_chatgpt_compose_result: true,
      requestId: id,
      ok: result.ok === true,
      error: result.error || null,
      mode: result.mode || job?.mode || 'chat',
      model: result.model || job?.model || null,
      effort: result.effort || job?.effort || null,
      ytTabId: job?.ytTabId ?? null,
      ytVideoId: job?.ytVideoId || null,
      ytTitle: job?.ytTitle || null,
    };
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const response = await new Promise(resolve => {
        try {
          chrome.runtime.sendMessage(payload, value => {
            const error = chrome.runtime.lastError;
            resolve(error ? { ok: false, error: error.message } : (value || { ok: false }));
          });
        } catch (error) {
          resolve({ ok: false, error: error?.message || String(error) });
        }
      });
      if (response?.ok) {
        log('compose.result_ack', { id, attempt, ok: payload.ok, targetLabel: response.targetLabel || null });
        return true;
      }
      log('compose.result_ack_retry', { id, attempt, ok: payload.ok, err: response?.error || null });
      await sleep(Math.min(1600, 250 * attempt));
    }
    return false;
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
  async function markResearchStartupBoot(id, tabId) {
    if (!id || !Number.isInteger(tabId)) return { ok: false, skipped: true };
    return await new Promise(resolve => {
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value || { ok: false });
      };
      const timer = setTimeout(() => finish({ ok: false, error: 'startup boot acknowledgement timeout' }), 2000);
      try {
        chrome.runtime.sendMessage({
          __sc_research_startup_boot: true,
          researchId: id,
          tabId,
          url: location.href,
          timeStamp: Date.now(),
        }, response => {
          const error = chrome.runtime.lastError;
          finish(error ? { ok: false, error: error.message } : response);
        });
      } catch (error) {
        finish({ ok: false, error: error?.message || String(error) });
      }
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

  // Старые id сохранены для прежнего UI. Новый ChatGPT убрал id у редактора,
  // submit и file inputs; выбираем ровно один видимый редактор его main-формы.
  function findComposer() {
    const legacy = document.getElementById('prompt-textarea');
    if (legacy) return legacy;
    const editors = Array.from(document.querySelectorAll(
      'main [data-composer-markdown][contenteditable="true"][role="textbox"]'
    )).filter(isVisible);
    return editors.length === 1 ? editors[0] : null;
  }
  function findSendBtn() {
    const legacy = document.querySelector('[data-testid="send-button"]')
        || document.getElementById('composer-submit-button');
    if (legacy) return legacy;
    const buttons = Array.from(composerRoot()?.querySelectorAll('button[type="submit"]') || [])
      .filter(b => isVisible(b) && /^(?:отправить|send)(?:\s|$)/i.test(b.getAttribute('aria-label') || ''));
    return buttons.length === 1 ? buttons[0] : null;
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
      .find(b => /голосовой (?:режим|разговор)|voice (?:mode|chat|conversation)/i.test(b.getAttribute('aria-label') || ''));
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
  async function trustedHover(el) {
    if (!el) return { ok: false, err: 'no element' };
    const r = el.getBoundingClientRect();
    const left = Number.isFinite(r.x) ? r.x : r.left;
    const top = Number.isFinite(r.y) ? r.y : r.top;
    const x = left + r.width / 2;
    const y = top + r.height / 2;
    if (![x, y].every(Number.isFinite)) return { ok: false, err: 'invalid coordinates' };
    return await new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ __sc_trusted_hover: true, x, y }, response => {
          const error = chrome.runtime.lastError;
          resolve(error ? { ok: false, err: error.message } : (response || { ok: false, err: 'no response' }));
        });
      } catch (error) {
        resolve({ ok: false, err: error?.message || String(error) });
      }
    });
  }
  async function trustedClick(el) {
    if (!el) return { ok: false, err: 'no element' };
    const r = el.getBoundingClientRect();
    const left = Number.isFinite(r.x) ? r.x : r.left;
    const top = Number.isFinite(r.y) ? r.y : r.top;
    const x = left + r.width / 2;
    const y = top + r.height / 2;
    if (![x, y].every(Number.isFinite)) return { ok: false, err: 'invalid coordinates' };
    return await new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ __sc_trusted_click: true, x, y }, response => {
          const error = chrome.runtime.lastError;
          resolve(error ? { ok: false, err: error.message } : (response || { ok: false, err: 'no response' }));
        });
      } catch (error) {
        resolve({ ok: false, err: error?.message || String(error) });
      }
    });
  }
  function pressEscape() {
    document.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', code:'Escape', keyCode:27, which:27, bubbles:true }));
    document.dispatchEvent(new KeyboardEvent('keyup',   { key:'Escape', code:'Escape', keyCode:27, which:27, bubbles:true }));
  }
  function isVisible(el) {
    if (!el) return false;
    // The modern picker keeps both views laid out. Its inactive view is
    // inert but still has a nonzero rect; those radios are not actionable.
    if (el.closest?.('[inert]')) return false;
    const r = el.getBoundingClientRect();
    return !!(r.width || r.height || el.getClientRects().length);
  }
  function visibleAll(selector) {
    return Array.from(document.querySelectorAll(selector)).filter(isVisible);
  }
  function nodeText(el) {
    return (el?.textContent || '').trim().replace(/\s+/g, ' ');
  }

  const CHATGPT_MODES = Object.freeze(['chat', 'work']);
  const CHATGPT_MODE_CONTROL_SELECTOR = '[role="radio"], [role="tab"], button, [role="button"]';
  function resolveChatgptMode(value) {
    return String(value || '').trim().toLowerCase() === 'work' ? 'work' : 'chat';
  }
  function chatgptModeLabel(mode) {
    return resolveChatgptMode(mode) === 'work' ? 'Work' : 'Chat';
  }
  function isTemporaryChatPage() {
    try {
      if (new URL(window.location?.href || location.href).searchParams.get('temporary-chat') === 'true') return true;
    } catch (_) {}
    try {
      return !!document.querySelector?.(
        '[data-testid="temporary-chat-label"], button[aria-label*="turn off temporary chat" i], button[aria-label*="отключить временный чат" i]',
      );
    } catch (_) {
      return false;
    }
  }
  function normalizeModeControlLabel(value) {
    return String(value || '')
      .normalize('NFKC')
      .replace(/[\s\u00a0]+/g, ' ')
      .replace(/[·•|:—–-]+/g, ' ')
      .trim()
      .toLowerCase()
      .replace(/^(?:chatgpt|режим|mode)\s+/u, '')
      .replace(/\s+(?:режим|mode)$/u, '')
      .trim();
  }
  function modeFromControlText(value) {
    const text = normalizeModeControlLabel(value);
    if (/^(?:work|работа|для работы|рабочие чаты|чаты для работы|чаты работы)$/u.test(text)) return 'work';
    if (/^(?:chat|chats|чат|чаты)$/u.test(text)) return 'chat';
    return null;
  }
  function modeFromControl(el) {
    const labels = [
      el?.getAttribute?.('aria-label'),
      el?.getAttribute?.('title'),
      nodeText(el),
    ];
    for (const label of labels) {
      const mode = modeFromControlText(label);
      if (mode) return mode;
    }
    return null;
  }
  function isModeControlChecked(el) {
    if (!el) return false;
    const dataState = String(el.getAttribute('data-state') || '').toLowerCase();
    return el.getAttribute('aria-checked') === 'true'
      || el.getAttribute('aria-selected') === 'true'
      || el.getAttribute('aria-pressed') === 'true'
      || ['true', 'page'].includes(String(el.getAttribute('aria-current') || '').toLowerCase())
      || ['true', 'active', 'selected', 'checked', 'on'].includes(String(el.getAttribute('data-active') || '').toLowerCase())
      || ['true', 'active', 'selected', 'checked', 'on'].includes(String(el.getAttribute('data-selected') || '').toLowerCase())
      || dataState === 'checked'
      || dataState === 'active'
      || dataState === 'selected'
      || dataState === 'on'
      || /(?:^|\s)(?:active|selected|checked)(?:\s|$)/i.test(el.getAttribute('class') || '');
  }
  function commonAncestor(a, b) {
    const ancestors = new Set();
    for (let el = a; el; el = el.parentElement) ancestors.add(el);
    for (let el = b; el; el = el.parentElement) {
      if (ancestors.has(el)) return el;
    }
    return null;
  }
  function ancestorDistance(el, ancestor) {
    let distance = 0;
    for (let current = el; current && current !== ancestor; current = current.parentElement) distance++;
    return distance;
  }
  function modePairScore(a, b) {
    const groupA = a.el.closest?.('[role="radiogroup"], [role="tablist"], [role="group"]');
    const groupB = b.el.closest?.('[role="radiogroup"], [role="tablist"], [role="group"]');
    if (groupA && groupA === groupB) return 0;
    if (a.el.parentElement && a.el.parentElement === b.el.parentElement) return 10;

    const common = commonAncestor(a.el, b.el);
    if (!common || Math.max(ancestorDistance(a.el, common), ancestorDistance(b.el, common)) > 4) return Infinity;
    const ar = a.el.getBoundingClientRect();
    const br = b.el.getBoundingClientRect();
    const sameRow = Math.abs((ar.top + ar.height / 2) - (br.top + br.height / 2)) <= Math.max(24, ar.height, br.height);
    if (!sameRow) return Infinity;
    return 20 + Math.abs((ar.left + ar.width / 2) - (br.left + br.width / 2)) / 1000;
  }
  function allModeControlCandidates() {
    return visibleAll(CHATGPT_MODE_CONTROL_SELECTOR)
      .map(el => ({ el, mode: modeFromControl(el) }))
      .filter(item => item.mode);
  }
  function chatgptModeControls() {
    const candidates = allModeControlCandidates();
    const pairs = [];
    for (const chat of candidates.filter(item => item.mode === 'chat')) {
      for (const work of candidates.filter(item => item.mode === 'work')) {
        const score = modePairScore(chat, work);
        if (Number.isFinite(score)) pairs.push({ chat, work, score });
      }
    }
    pairs.sort((a, b) => a.score - b.score
      || a.chat.el.getBoundingClientRect().top - b.chat.el.getBoundingClientRect().top);
    const pair = pairs[0];
    return pair ? [pair.chat, pair.work] : [];
  }
  function currentChatgptMode() {
    const controls = chatgptModeControls();
    const selected = controls.find(item => isModeControlChecked(item.el));
    if (selected) return selected.mode;

    // Стандартный tablist иногда кодирует выбор только roving tabindex:
    // активная вкладка имеет 0, соседняя -1.
    const tabbable = controls.filter(item => item.el.getAttribute('tabindex') === '0');
    const untabbable = controls.filter(item => item.el.getAttribute('tabindex') === '-1');
    if (tabbable.length === 1 && untabbable.length >= 1) return tabbable[0].mode;
    return selected?.mode || null;
  }
  function chatgptModeSnapshot() {
    return chatgptModeControls().map(({ el, mode }) => ({
      mode,
      text: nodeText(el),
      ariaLabel: el.getAttribute('aria-label'),
      role: el.getAttribute('role') || el.tagName?.toLowerCase() || null,
      ariaChecked: el.getAttribute('aria-checked'),
      ariaSelected: el.getAttribute('aria-selected'),
      ariaPressed: el.getAttribute('aria-pressed'),
      dataState: el.getAttribute('data-state'),
      top: Math.round(el.getBoundingClientRect().top),
    }));
  }
  function chatgptModeDiagnosticSnapshot() {
    return visibleAll('[role="radio"], [role="tab"], [role="radiogroup"], [role="tablist"], button[aria-pressed], button[data-state]')
      .map(el => ({
        text: nodeText(el).slice(0, 100),
        ariaLabel: String(el.getAttribute('aria-label') || '').slice(0, 100),
        role: el.getAttribute('role') || el.tagName?.toLowerCase() || null,
        ariaChecked: el.getAttribute('aria-checked'),
        ariaSelected: el.getAttribute('aria-selected'),
        ariaPressed: el.getAttribute('aria-pressed'),
        dataState: el.getAttribute('data-state'),
      }))
      .filter(item => item.text || item.ariaLabel)
      .slice(0, 30);
  }
  async function ensureChatgptModeSelected(requestedMode, conversationModeProof = null) {
    const mode = resolveChatgptMode(requestedMode);
    if (isTemporaryChatPage()) {
      const ok = mode === 'chat';
      const data = { mode, temporaryChat: true, reason: ok ? 'temporary_chat_is_chat' : 'work_unavailable_in_temporary_chat' };
      log(ok ? 'mode.temporary_chat' : 'mode.temporary_chat_work_unavailable', data);
      bridgeLog(ok ? 'gpt.mode.temporary_chat' : 'gpt.mode.temporary_chat_work_unavailable', data, getRequestId() || getComposeId(), null);
      return ok;
    }
    // A completed conversation can have only a model/effort picker, with no
    // Chat/Work switch. The bridge supplies the verified mode of a previous
    // successful request to this exact conversation, never the caller's guess.
    if (!chatgptModeControls().length && conversationModeProof
        && chatgptConversationIdFromLocation() === conversationModeProof.conversationId
        && ['chat', 'work'].includes(conversationModeProof.mode)) {
      const ok = conversationModeProof.mode === mode;
      log('mode.saved_conversation', { mode, verifiedMode: conversationModeProof.mode, ok });
      return ok;
    }
    for (let attempt = 1; attempt <= 2; attempt++) {
      let target = null;
      try {
        target = await waitFor(
          () => chatgptModeControls().find(item => item.mode === mode)?.el || null,
          `ChatGPT ${chatgptModeLabel(mode)} toggle`,
          15000,
          200,
        );
      } catch (e) {
        const data = { mode, attempt, err: e?.message, controls: chatgptModeDiagnosticSnapshot() };
        log('mode.controls_not_found', data);
        bridgeLog('gpt.mode.controls_not_found', data, getRequestId() || getComposeId(), null);
        return false;
      }
      const before = currentChatgptMode();
      if (before === mode && isModeControlChecked(target)) {
        log('mode.already_set', { mode, attempt, radios: chatgptModeSnapshot() });
        bridgeLog('gpt.mode.already_set', { mode, attempt, radios: chatgptModeSnapshot() }, getRequestId() || getComposeId(), null);
        return true;
      }
      nativeMouseClick(target);
      try {
        await waitFor(
          () => currentChatgptMode() === mode,
          `ChatGPT ${chatgptModeLabel(mode)} mode verify`,
          5000,
          150,
        );
      } catch (_) {}
      const ok = currentChatgptMode() === mode;
      log(ok ? 'mode.selected' : 'mode.verify_failed', {
        mode,
        attempt,
        before,
        radios: chatgptModeSnapshot(),
      });
      bridgeLog(ok ? 'gpt.mode.selected' : 'gpt.mode.verify_failed', {
        mode,
        attempt,
        before,
        radios: chatgptModeSnapshot(),
      }, getRequestId() || getComposeId(), null);
      if (ok) return true;
      await sleep(300);
    }
    log('mode.select_failed', { mode, radios: chatgptModeSnapshot() });
    bridgeLog('gpt.mode.select_failed', { mode, radios: chatgptModeSnapshot() }, getRequestId() || getComposeId(), null);
    return false;
  }

  // ── Popup export: текущий ChatGPT-чат → markdown ─────────────────────
  const CHATGPT_EXPORT_OVERLAY_ID = 'sc-chatgpt-export-overlay';
  const CHATGPT_EXPORT_DEFAULTS = Object.freeze({
    includeReasoning: true,
    includeSources: true,
    includeSourceActivity: true,
    includeImages: true,
    __export: { downloadFile: false },
  });

  function normalizeChatGPTExportSettings(raw = {}) {
    const cb = (v, fb) => typeof v === 'boolean' ? v : fb;
    return {
      includeReasoning: cb(raw.includeReasoning, CHATGPT_EXPORT_DEFAULTS.includeReasoning),
      includeSources: cb(raw.includeSources, CHATGPT_EXPORT_DEFAULTS.includeSources),
      includeSourceActivity: cb(raw.includeSourceActivity, CHATGPT_EXPORT_DEFAULTS.includeSourceActivity),
      includeImages: cb(raw.includeImages, CHATGPT_EXPORT_DEFAULTS.includeImages),
      __export: {
        downloadFile: cb(raw.__export?.downloadFile, CHATGPT_EXPORT_DEFAULTS.__export.downloadFile),
      },
    };
  }

  function assertPopupExportNotCancelled() {
    if (popupExportCancel) throw new Error('Экспорт отменён');
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function safeFilenamePart(value, fallback = 'chatgpt-chat') {
    return String(value || fallback)
      .replace(/[\uE000-\uF8FF]/g, '')
      .replace(/[\\/:*?"<>|\s]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 70) || fallback;
  }

  async function copyTextToClipboard(text) {
    let primaryError = null;
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (error) {
        primaryError = error;
        log('popup_export.clipboard_writeText_failed', {
          err: error?.message || String(error),
          focused: document.hasFocus(),
          visibility: document.visibilityState,
        });
      }
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
    document.body.appendChild(ta);
    ta.focus({ preventScroll: true });
    ta.select();
    try {
      const ok = document.execCommand('copy');
      if (ok) return true;
      throw new Error(primaryError?.message || 'document.execCommand(copy) returned false');
    } finally {
      ta.remove();
    }
  }

  async function deliverMarkdown(markdown, filename, wantsFile) {
    if (wantsFile) {
      downloadMarkdownFile(markdown, filename);
      return 'download';
    }
    try {
      await copyTextToClipboard(markdown);
      return 'clipboard';
    } catch (error) {
      log('popup_export.clipboard_all_failed_download_fallback', {
        err: error?.message || String(error),
        focused: document.hasFocus(),
        visibility: document.visibilityState,
      });
      downloadMarkdownFile(markdown, filename);
      return 'download-fallback';
    }
  }

  function downloadMarkdownFile(markdown, filename) {
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 1000);
  }

  function showChatGPTExportOverlay() {
    document.getElementById(CHATGPT_EXPORT_OVERLAY_ID)?.remove();
    const overlay = document.createElement('div');
    overlay.id = CHATGPT_EXPORT_OVERLAY_ID;
    overlay.dataset.state = 'progress';
    overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 2147483600;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0,0,0,0.62); color: #e9ecef;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    `;
    const card = document.createElement('div');
    card.style.cssText = `
      width: min(420px, calc(100vw - 40px)); padding: 22px;
      border-radius: 10px; border: 1px solid #343a40; background: #1f2024;
      box-shadow: 0 18px 60px rgba(0,0,0,.35); text-align: left;
    `;
    card.innerHTML = `
      <div style="font-size:13px;font-weight:700;color:#69db7c;text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px;">ChatGPT export</div>
      <div id="${CHATGPT_EXPORT_OVERLAY_ID}-status" style="font-size:16px;font-weight:650;margin-bottom:8px;">Готовлю экспорт...</div>
      <div id="${CHATGPT_EXPORT_OVERLAY_ID}-progress" style="font-size:13px;color:#adb5bd;line-height:1.45;">Сканирую сообщения</div>
      <button type="button" id="${CHATGPT_EXPORT_OVERLAY_ID}-cancel" style="
        margin-top:18px;background:#343a40;color:#e9ecef;border:1px solid #495057;
        border-radius:7px;padding:8px 14px;font-size:13px;cursor:pointer;">Остановить</button>
    `;
    overlay.addEventListener('wheel', e => e.preventDefault(), { passive: false });
    overlay.addEventListener('click', e => {
      if (e.target === overlay && ['success', 'warning', 'error'].includes(overlay.dataset.state)) {
        hideChatGPTExportOverlay();
      }
    });
    card.addEventListener('click', e => e.stopPropagation());
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    document.getElementById(`${CHATGPT_EXPORT_OVERLAY_ID}-cancel`).onclick = () => { popupExportCancel = true; };
  }

  function updateChatGPTExportOverlay(status, progress) {
    const s = document.getElementById(`${CHATGPT_EXPORT_OVERLAY_ID}-status`);
    const p = document.getElementById(`${CHATGPT_EXPORT_OVERLAY_ID}-progress`);
    if (s && status) s.textContent = status;
    if (p && progress) p.textContent = progress;
  }

  function hideChatGPTExportOverlay() {
    const overlay = document.getElementById(CHATGPT_EXPORT_OVERLAY_ID);
    if (!overlay) return;
    overlay.style.opacity = '0';
    overlay.style.transition = 'opacity .2s ease';
    setTimeout(() => overlay.remove(), 220);
  }

  function showChatGPTExportTerminal(kind, message) {
    const overlay = document.getElementById(CHATGPT_EXPORT_OVERLAY_ID);
    if (!overlay) return;
    overlay.dataset.state = kind;
    const ok = kind === 'success';
    const heading = ok ? 'Готово' : kind === 'warning' ? 'Экспорт с пропусками' : 'Экспорт прерван';
    const card = overlay.firstElementChild;
    if (!card) return;
    card.innerHTML = `
      <div style="font-size:13px;font-weight:700;color:${ok ? '#69db7c' : '#ff8787'};text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px;">
        ${heading}
      </div>
      <p style="margin:0 0 18px;color:#e9ecef;font-size:13px;line-height:1.5;white-space:pre-wrap;">${escapeHtml(message)}</p>
      <button type="button" id="${CHATGPT_EXPORT_OVERLAY_ID}-close" style="
        background:${ok ? '#2b8a3e' : '#c92a2a'};color:white;border:none;
        border-radius:7px;padding:8px 16px;font-size:13px;cursor:pointer;">Закрыть</button>
    `;
    document.getElementById(`${CHATGPT_EXPORT_OVERLAY_ID}-close`).onclick = hideChatGPTExportOverlay;
  }

  function chatgptConversationTurns() {
    const turns = Array.from(document.querySelectorAll('[data-testid^="conversation-turn-"]'))
      .filter(t => t.querySelector('[data-message-author-role]'));
    if (turns.length) return turns;
    return conversationMessageElements();
  }

  function roleLabel(role) {
    if (role === 'user') return 'User';
    if (role === 'assistant') return 'ChatGPT';
    if (role === 'tool') return 'Tool';
    return role || 'Message';
  }

  function markdownEscapeInline(value) {
    return String(value || '').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
  }

  function normalizeMarkdownText(value) {
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function markdownFromDom(root) {
    if (!root) return '';
    const ignoredSelector = [
      'button',
      'svg',
      'style',
      'script',
      '[data-testid*="copy"]',
      '[data-testid*="feedback"]',
      '[aria-label*="Copy" i]',
      '[aria-label*="Копировать" i]',
    ].join(',');
    const clone = root.cloneNode(true);
    clone.querySelectorAll(ignoredSelector).forEach(n => n.remove());
    return normalizeMarkdownText(markdownNode(clone, {}));
  }

  function markdownNode(node, ctx) {
    if (!node) return '';
    if (node.nodeType === Node.TEXT_NODE) {
      const raw = node.nodeValue || '';
      return ctx?.pre ? raw : raw.replace(/\s+/g, ' ');
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const el = node;
    const tag = el.tagName.toLowerCase();
    if (tag === 'br') return '\n';
    if (tag === 'pre') {
      const code = el.querySelector('code');
      const cls = code?.className || '';
      const lang = (String(cls).match(/language-([a-z0-9_-]+)/i) || [])[1] || '';
      const text = (code || el).textContent || '';
      return `\n\n\`\`\`${lang}\n${text.replace(/\n+$/g, '')}\n\`\`\`\n\n`;
    }
    if (tag === 'code') {
      if (el.closest('pre')) return el.textContent || '';
      return '`' + String(el.textContent || '').replace(/`/g, '\\`') + '`';
    }
    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag.slice(1));
      return `\n\n${'#'.repeat(level)} ${childrenMarkdown(el, ctx).trim()}\n\n`;
    }
    if (tag === 'strong' || tag === 'b') return `**${childrenMarkdown(el, ctx).trim()}**`;
    if (tag === 'em' || tag === 'i') return `_${childrenMarkdown(el, ctx).trim()}_`;
    if (tag === 'a') {
      const href = el.getAttribute('href') || '';
      const text = childrenMarkdown(el, ctx).trim() || href;
      if (!href) return text;
      return `[${markdownEscapeInline(text)}](${href})`;
    }
    if (tag === 'blockquote') {
      const body = childrenMarkdown(el, ctx).trim().split('\n').map(line => `> ${line}`).join('\n');
      return `\n\n${body}\n\n`;
    }
    if (tag === 'ul' || tag === 'ol') {
      const items = Array.from(el.children).filter(ch => ch.tagName?.toLowerCase() === 'li');
      const lines = items.map((li, idx) => {
        const marker = tag === 'ol' ? `${idx + 1}.` : '-';
        return `${marker} ${childrenMarkdown(li, ctx).trim().replace(/\n+/g, '\n  ')}`;
      });
      return `\n\n${lines.join('\n')}\n\n`;
    }
    if (tag === 'table') {
      const rows = Array.from(el.querySelectorAll('tr')).map(tr =>
        Array.from(tr.children).map(td => normalizeMarkdownText(td.textContent).replace(/\|/g, '\\|'))
      ).filter(r => r.length);
      if (!rows.length) return '';
      const head = rows[0];
      const sep = head.map(() => '---');
      return `\n\n| ${head.join(' | ')} |\n| ${sep.join(' | ')} |\n` +
        rows.slice(1).map(r => `| ${r.join(' | ')} |`).join('\n') + '\n\n';
    }
    if (tag === 'p' || tag === 'div' || tag === 'section' || tag === 'article') {
      const text = childrenMarkdown(el, ctx).trim();
      return text ? `\n\n${text}\n\n` : '';
    }
    return childrenMarkdown(el, ctx);
  }

  function childrenMarkdown(el, ctx) {
    return Array.from(el.childNodes).map(n => markdownNode(n, ctx)).join('');
  }

  function extractMessageRoot(turn) {
    return turn.querySelector?.('[data-message-author-role], [data-chatgpt-search-unit-key]') || turn;
  }

  function exportMessageRole(messageEl) {
    return messageEl?.getAttribute?.('data-message-author-role')
      || messageEl?.getAttribute?.('data-chatgpt-search-unit-key')?.split(':').pop()
      || 'message';
  }

  function extractMessageTextMarkdown(messageEl, role) {
    if (!messageEl) return '';
    if (role === 'assistant') {
      const mds = Array.from(messageEl.querySelectorAll('.markdown, .chatgpt-markdown'))
        .filter(m => !m.classList.contains('result-thinking'));
      const md = mds[mds.length - 1];
      if (md) return markdownFromDom(md);
    }
    const textContainers = Array.from(messageEl.querySelectorAll('.whitespace-pre-wrap, .prose, .markdown, .chatgpt-markdown'))
      .filter(el => !el.classList.contains('result-thinking'));
    if (textContainers.length) return markdownFromDom(textContainers[textContainers.length - 1]);
    return normalizeMarkdownText(messageEl.textContent || '');
  }

  function extractReasoningMarkdownForMessage(messageEl) {
    if (!messageEl) return '';
    const mds = Array.from(messageEl.querySelectorAll('.markdown.result-thinking, .result-thinking.markdown, .result-thinking'));
    const md = mds[mds.length - 1];
    return md ? markdownFromDom(md) : '';
  }

  function extractImagesForExportTurn(turn) {
    const scope = extractMessageRoot(turn);
    const imgs = Array.from(scope.querySelectorAll('img[src]'));
    const seen = new Set();
    const out = [];
    for (const img of imgs) {
      const src = img.currentSrc || img.src || img.getAttribute('src') || '';
      if (!src) continue;
      const likelyContent =
        src.includes('/backend-api/estuary/content') ||
        /^blob:|^data:image\//i.test(src) ||
        (img.naturalWidth >= 48 && img.naturalHeight >= 48);
      if (!likelyContent) continue;
      const key = `${src}|${img.alt || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        src,
        alt: img.alt || 'ChatGPT image',
        width: img.naturalWidth || null,
        height: img.naturalHeight || null,
      });
    }
    return out;
  }

  function renderImagesMarkdown(images) {
    if (!images.length) return '';
    let md = `\n\n### Картинки\n\n`;
    for (const img of images) {
      const size = img.width && img.height ? ` (${img.width}x${img.height})` : '';
      md += `- ![${markdownEscapeInline(img.alt || 'ChatGPT image')}](${img.src})${size}\n`;
    }
    return md;
  }

  function findSourcesChipInTurn(turn) {
    const chips = Array.from(turn.querySelectorAll('button[aria-label]'))
      .filter(b => /^(Источники|Sources)$/i.test(b.getAttribute('aria-label') || ''));
    return chips.find(isVisible) || chips[chips.length - 1] || null;
  }

  async function extractSourcesForExportTurn(turn, turnIndex) {
    const out = { links: [], activity_items: [], activity: null, thinking: [], chip_present: false, panel_opened: false };
    const chip = findSourcesChipInTurn(turn);
    if (!chip) return out;
    out.chip_present = true;
    try { turn.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (_) {}
    await sleep(150);
    try { chip.click(); } catch (_) { nativeMouseClick(chip); }
    let panel;
    try {
      panel = await waitFor(() => findSourcesPanel(), `ChatGPT sources panel for turn ${turnIndex}`, 8000, 250);
    } catch (_) {
      log('popup_export.sources_panel_timeout', { turnIndex });
      return out;
    }
    out.panel_opened = true;
    await sleep(500);

    const seen = new Set();
    const seenActivity = new Set();
    const collect = () => {
      for (const a of panel.querySelectorAll('a[href]')) {
        const link = sourceLinkFromAnchor(a);
        if (!link || seen.has(link.url)) continue;
        seen.add(link.url);
        out.links.push(link);
      }
      collectActivityItems(panel, out.activity_items, seenActivity);
    };
    collect();
    const scroller = [panel, ...panel.querySelectorAll('*')]
      .find(el => el.scrollHeight > el.clientHeight + 40) || panel;
    let idle = 0;
    for (let step = 0; step < 20 && idle < 2; step++) {
      assertPopupExportNotCancelled();
      const before = out.links.length + out.activity_items.length;
      scroller.scrollTop = scroller.scrollTop + Math.max(300, scroller.clientHeight || 300);
      await sleep(300);
      collect();
      const after = out.links.length + out.activity_items.length;
      idle = after === before ? idle + 1 : 0;
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 10 && after === before) break;
    }
    const txt = panel.textContent || '';
    out.thinking = txt.match(/(?:Думал[а]? на протяжении|Thought for)\s+[^\n]{1,30}/g) || [];
    const actM = txt.match(/(?:Активность|Activity)\s*·?\s*(.{1,60})/);
    if (actM) out.activity = cleanActivity(actM[1]);
    try {
      const closeBtn = Array.from(panel.querySelectorAll('button'))
        .find(b => /^(Закрыть|Close)$/i.test(b.getAttribute('aria-label') || ''));
      closeBtn?.click();
    } catch (_) {}
    log('popup_export.sources_done', { turnIndex, links: out.links.length, activity_items: out.activity_items.length });
    return out;
  }

  function renderSourcesMarkdown(src, settings) {
    let md = '';
    if (settings.includeSources && src.links.length) {
      md += `\n\n### Источники\n\n`;
      src.links.forEach((l, idx) => {
        md += `${idx + 1}. ${l.title || l.url} — ${l.url}\n`;
      });
      if (src.activity) md += `\n_Активность: ${src.activity}_\n`;
    }
    if (settings.includeSourceActivity && src.activity_items.length) {
      md += `\n\n### Активность поиска\n\n`;
      for (const item of src.activity_items) {
        md += `- ${item.title || 'Шаг'}\n`;
        if (Array.isArray(item.links) && item.links.length) {
          for (const l of item.links) md += `  - ${l.title || l.url}: ${l.url}\n`;
        }
        if (item.command) md += `\n  \`\`\`text\n${item.command}\n  \`\`\`\n`;
        else if (item.text && item.text !== item.title) md += `  ${item.text}\n`;
      }
    }
    return md;
  }

  function buildChatGPTExportHeader(turnCount, stats, mode) {
    const title = (document.title || 'ChatGPT').replace(/\s*[-–]\s*ChatGPT\s*$/i, '').trim() || 'ChatGPT chat';
    const exportedAt = new Date().toISOString();
    const providerLabel = `ChatGPT · ${chatgptModeLabel(mode)}`;
    let md = `# ${title}\n\n`;
    md += `> **Сводка экспорта ${providerLabel}**  \n`;
    md += `> Режим: ${providerLabel}  \n`;
    md += `> Сообщений: ${turnCount}; User: ${stats.user}; ChatGPT: ${stats.assistant}  \n`;
    md += `> Источников: ${stats.sources}; activity-шагов: ${stats.activity}; картинок: ${stats.images}  \n`;
    md += `> URL: ${location.href}  \n`;
    md += `> Экспортировано: ${exportedAt}\n\n---\n\n`;
    return md;
  }

  function chatgptConversationIdFromLocation() {
    try {
      const parts = location.pathname.split('/').filter(Boolean);
      const cIdx = parts.indexOf('c');
      if (cIdx >= 0 && parts[cIdx + 1]) return parts[cIdx + 1];
      const last = parts[parts.length - 1] || '';
      return /^[0-9a-f-]{16,}$/i.test(last) ? last : '';
    } catch (_) {
      return '';
    }
  }

  async function fetchChatGPTConversationJson(timeoutMs = 30000) {
    const conversationId = chatgptConversationIdFromLocation();
    if (!conversationId) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const accessToken = await chatgptExportAccessToken(controller.signal);
      const res = await fetch(`/backend-api/conversation/${encodeURIComponent(conversationId)}`, {
        credentials: 'include',
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`ChatGPT conversation API failed: HTTP ${res.status} ${text.slice(0, 120)}`);
      }
      const data = await res.json();
      if (!data?.mapping || !data?.current_node) throw new Error('ChatGPT conversation API returned no mapping/current_node');
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  async function chatgptExportAccessToken(signal, fetcher = fetch) {
    const response = await fetcher('/api/auth/session', { credentials: 'include', signal });
    if (!response.ok) throw new Error('ChatGPT session fetch failed: HTTP ' + response.status);
    const session = await response.json();
    if (!session?.accessToken) throw new Error('ChatGPT session has no access token');
    return session.accessToken;
  }

  function chatgptCurrentPathNodes(data) {
    const mapping = data?.mapping || {};
    const out = [];
    const seen = new Set();
    let cur = data?.current_node;
    while (cur && mapping[cur] && !seen.has(cur)) {
      seen.add(cur);
      out.push(mapping[cur]);
      cur = mapping[cur].parent;
    }
    return out.reverse();
  }

  function apiMessageRole(node) {
    return node?.message?.author?.role || '';
  }

  function apiMessageContentType(node) {
    return node?.message?.content?.content_type || '';
  }

  function isHiddenApiMessage(node) {
    return !!node?.message?.metadata?.is_visually_hidden_from_conversation;
  }

  function apiPartsText(parts) {
    if (!Array.isArray(parts)) return '';
    return parts.map(part => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      if (typeof part.text === 'string') return part.text;
      if (typeof part.content === 'string') return part.content;
      if (typeof part.name === 'string' && typeof part.url === 'string') return `${part.name}: ${part.url}`;
      return '';
    }).filter(Boolean).join('\n\n');
  }

  function compactJsonSnippet(value, max = 2400) {
    try {
      return JSON.stringify(value, null, 2).slice(0, max);
    } catch (_) {
      return String(value || '').slice(0, max);
    }
  }

  function apiMessageText(node) {
    const msg = node?.message || {};
    const content = msg.content || {};
    const type = content.content_type || '';
    if (type === 'text' || type === 'multimodal_text') return normalizeMarkdownText(apiPartsText(content.parts));
    if (type === 'code') {
      const lang = content.language || content.response_format_name || '';
      return `\`\`\`${lang}\n${String(content.text || '').replace(/\n+$/g, '')}\n\`\`\``;
    }
    if (type === 'execution_output') {
      const text = content.text || msg.metadata?.aggregate_result?.final_expression_output || '';
      return normalizeMarkdownText(String(text || ''));
    }
    if (type === 'reasoning_recap') {
      if (typeof content.content === 'string') return normalizeMarkdownText(content.content);
      return normalizeMarkdownText(compactJsonSnippet(content.content || ''));
    }
    if (type === 'thoughts') return normalizeMarkdownText(apiThoughtsText(content.thoughts));
    if (type === 'model_editable_context') {
      const bits = [];
      if (content.repository) bits.push(`Repository: ${content.repository}`);
      if (content.repo_summary) bits.push(String(content.repo_summary));
      if (content.model_set_context) bits.push(String(content.model_set_context));
      return normalizeMarkdownText(bits.join('\n\n'));
    }
    return '';
  }

  function apiThoughtsText(thoughts) {
    if (!thoughts || typeof thoughts !== 'object') return '';
    const out = [];
    for (const item of Object.values(thoughts)) {
      if (typeof item === 'string') out.push(item);
      else if (item && typeof item === 'object') {
        if (typeof item.summary === 'string') out.push(item.summary);
        if (typeof item.content === 'string') out.push(item.content);
        if (typeof item.text === 'string') out.push(item.text);
        if (Array.isArray(item.parts)) out.push(apiPartsText(item.parts));
      }
    }
    return out.filter(Boolean).join('\n\n');
  }

  function exportAttachmentName(attachment) {
    return attachment.name || attachment.file_name || attachment.title || attachment.id || 'attachment';
  }

  function exportAttachmentMime(attachment) {
    return String(attachment.mime_type || attachment.content_type || attachment.file_mime_type || '').split(';')[0].toLowerCase();
  }

  function exportAttachmentKey(attachment) {
    return attachment.id || attachment.file_id || attachment.url || attachment.download_url || attachment.file_url || exportAttachmentName(attachment);
  }

  function isExportImageAttachment(attachment) {
    return exportAttachmentMime(attachment).startsWith('image/')
      || /\.(?:png|jpe?g|gif|webp|avif|heic|bmp|svg)$/i.test(exportAttachmentName(attachment));
  }

  function isExportTextAttachment(attachment) {
    if (isExportImageAttachment(attachment)) return false;
    const mime = exportAttachmentMime(attachment);
    return attachment.is_big_paste === true
      || mime.startsWith('text/')
      || /^application\/(?:json|(?:[\w.-]+\+)?xml|javascript|x-yaml|yaml|toml|sql)$/.test(mime)
      || /\.(?:txt|md|markdown|jsonl?|csv|tsv|log|xml|html?|ya?ml|toml|ini|cfg|conf|py|[mc]?js|[cm]?tsx?|jsx|css|scss|sh|sql|srt|vtt|tex|rs|go|c|cpp|h|java|swift)$/i.test(exportAttachmentName(attachment));
  }

  function exportTextFileBlock(text) {
    const longestFence = (String(text).match(/`{3,}/g) || []).reduce((n, fence) => Math.max(n, fence.length), 2);
    const fence = '`'.repeat(longestFence + 1);
    return `${fence}text\n${text}${String(text).endsWith('\n') ? '' : '\n'}${fence}\n`;
  }

  // Pasted text и YouTube transcript — это файлы, их bytes не находятся в
  // conversation mapping. Используем тот же download resolver, который
  // открывает native preview; виртуализированный preview не является полным
  // источником длинного документа. Bearer никогда не уходит на signed CDN URL.
  async function fetchChatGPTTextAttachment(attachment, deps = {}) {
    const fetcher = deps.fetch || fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    const maxBytes = 20 * 1024 * 1024;
    const declaredBytes = Number(attachment.size ?? attachment.file_size_bytes);
    try {
      assertPopupExportNotCancelled();
      if (declaredBytes > maxBytes) throw new Error('Документ превышает защитный предел 20 MiB; текст не обрезан');
      const id = attachment.id || attachment.file_id;
      if (!/^file[-_][a-z0-9_-]+$/i.test(String(id || ''))) throw new Error('У документа нет доступного file ID');
      const token = deps.accessToken || await chatgptExportAccessToken(controller.signal, fetcher);
      const resolver = await fetcher(`/backend-api/files/download/${encodeURIComponent(id)}`, {
        credentials: 'include', headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal, redirect: 'error',
      });
      if (!resolver.ok) throw new Error(`Загрузка документа: HTTP ${resolver.status}`);
      const download = await resolver.json();
      if (attachment.verifyName === true && download.file_name !== exportAttachmentName(attachment)) {
        throw new Error('Download-запись относится к другому документу');
      }
      if (deps.metadataOnly === true) return { ok: true, id, name: download.file_name };
      const url = new URL(download.download_url || download.url || download.file_url || '', location.href);
      const page = new URL(location.href);
      const sameOrigin = url.origin === page.origin;
      const allowedCdn = /(?:^|\.)oaiusercontent\.com$|(?:^|\.)blob\.core\.windows\.net$/i.test(url.hostname);
      if (url.protocol !== 'https:' || url.username || url.password || (!sameOrigin && !allowedCdn)
          || (sameOrigin && !/^\/backend-api\/(?:estuary\/content|files\/)/.test(url.pathname))) {
        throw new Error('Ссылка документа не принадлежит поддерживаемому хранилищу ChatGPT');
      }
      const response = await fetcher(url.href, {
        credentials: sameOrigin ? 'include' : 'omit',
        ...(sameOrigin ? { headers: { Authorization: `Bearer ${token}` } } : {}),
        signal: controller.signal, redirect: 'error',
      });
      if (!response.ok) throw new Error(`Чтение документа: HTTP ${response.status}`);
      if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('Документ превышает защитный предел 20 MiB; текст не обрезан');
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > maxBytes) throw new Error('Документ превышает защитный предел 20 MiB; текст не обрезан');
      const expected = Number(download.file_size_bytes ?? attachment.size);
      if (Number.isFinite(expected) && expected >= 0 && bytes.byteLength !== expected) {
        throw new Error(`Размер документа не совпал: получено ${bytes.byteLength}, ожидалось ${expected}`);
      }
      assertPopupExportNotCancelled();
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch (_) { throw new Error('Документ не является поддерживаемым UTF-8 текстом'); }
      return { ok: true, text, bytes: bytes.byteLength, name: exportAttachmentName(attachment) };
    } finally {
      clearTimeout(timer);
    }
  }

  async function resolveChatGPTExportAttachments(data, deps = {}) {
    const texts = new Map();
    const read = deps.read || fetchChatGPTTextAttachment;
    let bytesRead = 0;
    for (const node of chatgptCurrentPathNodes(data)) {
      if (!node?.message || isHiddenApiMessage(node)) continue;
      for (const attachment of node.message.metadata?.attachments || []) {
        if (!isExportTextAttachment(attachment)) continue;
        const key = exportAttachmentKey(attachment);
        if (texts.has(key)) continue;
        assertPopupExportNotCancelled();
        updateChatGPTExportOverlay('Читаю текст вложений...', `Документ ${texts.size + 1}: ${exportAttachmentName(attachment)}`);
        try {
          const result = await read(attachment);
          if (!result?.ok || typeof result.text !== 'string') throw new Error('Содержимое документа не получено');
          bytesRead += result.bytes || 0;
          if (bytesRead > 100 * 1024 * 1024) throw new Error('Суммарный текст превышает защитный предел 100 MiB; текст не обрезан');
          texts.set(key, result);
          log('popup_export.document_read', { id: attachment.id || null, bytes: result.bytes, chars: result.text.length });
        } catch (error) {
          assertPopupExportNotCancelled();
          const message = error?.message || String(error);
          texts.set(key, { ok: false, name: exportAttachmentName(attachment), error: message });
          log('popup_export.document_failed', { id: attachment.id || null, error: message });
        }
      }
    }
    return texts;
  }

  function domExportDocumentCards(scope) {
    const cards = [];
    for (const button of scope.querySelectorAll('button[aria-label]')) {
      const name = button.getAttribute('aria-label') || '';
      const attachment = { name };
      // Resource-card button carries the exact filename; citations use a
      // sentence such as "Открыть предпросмотр файла ..." and are not inputs.
      if (!name || /^(?:Открыть|Open|Скачать|Download)\s/i.test(name)
          || !isExportTextAttachment(attachment)) continue;
      cards.push({ button, attachment });
    }
    return cards;
  }

  function previewDownloadFileIds(since = 0) {
    const ids = [];
    for (const entry of performance.getEntriesByType('resource')) {
      if (entry.startTime < since) continue;
      const match = new URL(entry.name, location.href).pathname.match(/^\/backend-api\/files\/download\/(file[-_][a-z0-9_-]+)$/i);
      if (match && !ids.includes(match[1])) ids.push(match[1]);
    }
    return ids.reverse();
  }

  async function resolveDOMExportDocument(card, deps = {}) {
    const read = deps.read || fetchChatGPTTextAttachment;
    const since = performance.now();
    if (!deps.downloadIds) nativeMouseClick(card.button);
    let ids = [];
    let freshProof = true;
    try {
      ids = deps.downloadIds ? await deps.downloadIds() : await waitFor(() => {
        assertPopupExportNotCancelled();
        const fresh = previewDownloadFileIds(since);
        return fresh.length ? fresh : null;
      }, 'document preview download response', 5000, 150);
    } catch (error) {
      assertPopupExportNotCancelled();
      // A previously opened preview can be in React's cache. Only provider
      // download routes observed on this page are candidates; filename is
      // verified from their metadata before any file content is read.
      ids = previewDownloadFileIds().slice(0, 20);
      freshProof = false;
    }
    const matches = [];
    for (const id of ids) {
      try {
        const attachment = { ...card.attachment, id, verifyName: true };
        await read(attachment, { metadataOnly: true });
        matches.push(attachment);
        if (freshProof && ids.length === 1) break;
      } catch (error) {
        assertPopupExportNotCancelled();
        if (error?.message !== 'Download-запись относится к другому документу') throw error;
      }
    }
    if (matches.length > 1) throw new Error('Несколько документов имеют одинаковое имя; точный файл в кэше предпросмотра не определён');
    if (!matches.length) throw new Error('Полный файл не найден в download-записи предпросмотра');
    return read(matches[0]);
  }

  function apiAttachmentsMarkdown(node, settings = { includeImages: true }, texts = new Map()) {
    const attachments = node?.message?.metadata?.attachments;
    if (!Array.isArray(attachments) || !attachments.length) return '';
    let md = '';
    for (const a of attachments) {
      if (isExportImageAttachment(a) && !settings.includeImages) continue;
      const name = exportAttachmentName(a);
      const mime = exportAttachmentMime(a);
      const url = a.url || a.download_url || a.file_url || '';
      md += `- ${name}${mime ? ` (${mime})` : ''}${url ? ` — ${url}` : ''}\n`;
      const content = texts.get(exportAttachmentKey(a));
      if (content?.ok) md += `\n${exportTextFileBlock(content.text)}\n`;
      else if (content && !content.ok) md += `\n_[Содержимое вложения не получено: ${markdownEscapeInline(content.error)}.]_\n\n`;
    }
    return md ? `\n\n### Вложения\n\n${md}` : '';
  }

  function apiAttachmentCount(node) {
    const attachments = node?.message?.metadata?.attachments;
    return Array.isArray(attachments) ? attachments.length : 0;
  }

  function collectLinksDeep(value, out, seen, depth = 0) {
    if (!value || depth > 6 || out.length >= 200) return;
    if (Array.isArray(value)) {
      for (const item of value) collectLinksDeep(item, out, seen, depth + 1);
      return;
    }
    if (typeof value !== 'object') return;
    const url = value.url || value.href || value.link_url || value.source_url || value.uri;
    if (typeof url === 'string' && /^https?:\/\//i.test(url) && !seen.has(url)) {
      seen.add(url);
      out.push({
        url,
        title: compactText(value.title || value.name || value.text || value.snippet || url).slice(0, 300),
      });
    }
    for (const [key, child] of Object.entries(value)) {
      if (/token|email|authorization|session/i.test(key)) continue;
      collectLinksDeep(child, out, seen, depth + 1);
    }
  }

  function apiLinksFromMessage(node) {
    const msg = node?.message || {};
    const md = msg.metadata || {};
    const out = [];
    const seen = new Set();
    collectLinksDeep(md.citations, out, seen);
    collectLinksDeep(md.content_references, out, seen);
    collectLinksDeep(md.search_result_groups, out, seen);
    collectLinksDeep(md.story_events, out, seen);
    return out;
  }

  function apiActivityFromMessage(node) {
    const msg = node?.message || {};
    const role = msg.author?.role || '';
    const toolName = String(msg.author?.name || msg.recipient || '').toLowerCase();
    const type = msg.content?.content_type || '';
    const text = apiMessageText(node);
    if (type === 'code') {
      return { title: `Code${msg.content?.language ? `: ${msg.content.language}` : ''}`, command: text };
    }
    if (type === 'execution_output') {
      return { title: 'Execution output', text: text || compactJsonSnippet(msg.metadata?.aggregate_result || '') };
    }
    if (role === 'tool') {
      // Внутренние file-context/spinner записи содержат копию прочитанного
      // файла или пустой transport-payload. Это не пользовательская
      // активность и не должно дублировать attachment в result/history.
      if (/^(?:context_stuff|spinner)$/.test(toolName)
          || /^(?:context_stuff|spinner|tether_browsing_display)$/.test(String(type || '').toLowerCase())) return null;
      if (!text && (type === 'text' || type === 'multimodal_text')) return null;
      const title = msg.metadata?.command ? `Tool: ${compactText(msg.metadata.command).slice(0, 120)}` : `Tool: ${type || 'activity'}`;
      return { title, text: text || compactJsonSnippet(msg.content || '') };
    }
    if (type === 'model_editable_context') {
      const title = msg.content?.repository ? `Context: ${msg.content.repository}` : 'Context update';
      return { title, text: text || compactJsonSnippet(msg.content || '') };
    }
    return null;
  }

  function dedupeSourceLinks(links) {
    const out = [];
    const seen = new Set();
    for (const link of links || []) {
      if (!link?.url || seen.has(link.url)) continue;
      seen.add(link.url);
      out.push(link);
    }
    return out;
  }

  function dedupeActivityItems(items) {
    const out = [];
    const seen = new Set();
    for (const item of items || []) {
      if (!item) continue;
      const key = [item.title || '', item.command || '', item.text || ''].join('\n');
      if (!key.trim() || seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  }

  function isApiTurnTailNode(nodes, index) {
    for (let i = index + 1; i < nodes.length; i++) {
      // A following user starts another turn, so this node was the previous
      // turn's tail. Any other visible node proves that it was not the tail.
      return apiMessageRole(nodes[i]) === 'user';
    }
    return true;
  }

  // Current provider contract: an assistant text result is terminal only
  // when BOTH channel=final and end_turn=true are explicit. end_turn alone is
  // also emitted on real commentary preambles, including Astra tool runs.
  //
  // Older channel-less records retain a narrower compatibility path: the
  // message must be a non-preamble finished assistant addressed to `all`,
  // carry end_turn=true, and be the visible tail of its user turn. A later
  // tool/commentary node invalidates that weaker proof.
  function apiAssistantFinalKind(node, { isTurnTail = false } = {}) {
    const message = node?.message || {};
    const type = apiMessageContentType(node);
    if (apiMessageRole(node) !== 'assistant') return null;
    if (type !== 'text' && type !== 'multimodal_text') return null;
    if (message.metadata?.is_thinking_preamble_message) return null;
    if (message.status === 'in_progress') return null;
    if (message.channel === 'final' && message.end_turn === true) return 'explicit_final';

    const channelMissing = message.channel == null || message.channel === '';
    const recipient = String(message.recipient || 'all').toLowerCase();
    if (channelMissing
        && message.end_turn === true
        && message.status === 'finished_successfully'
        && recipient === 'all'
        && isTurnTail) {
      return 'legacy_tail_final';
    }
    return null;
  }

  // DOM Work-ответа содержит промежуточные commentary-сообщения («Думаю»,
  // «Проверяю…»). Между tool-фазами Stop может кратко исчезнуть, поэтому
  // только его исчезновения недостаточно. Backend conversation API явно
  // помечает настоящий финал channel=final + end_turn=true — используем этот
  // сигнал как terminal proof и одновременно берём полный невиртуализированный
  // текст ответа.
  function latestApiTurnSnapshotFromData(data) {
    if (!data) return { ready: false, reason: 'conversation_url_pending' };
    const nodes = chatgptCurrentPathNodes(data)
      .filter(node => node?.message && !isHiddenApiMessage(node));
    let lastUser = -1;
    for (let i = 0; i < nodes.length; i++) {
      if (apiMessageRole(nodes[i]) === 'user') lastUser = i;
    }
    const turnNodes = nodes.slice(lastUser + 1);
    const finals = turnNodes.map((node, index) => ({
      node,
      kind: apiAssistantFinalKind(node, { isTurnTail: index === turnNodes.length - 1 }),
    })).filter(item => item.kind);
    const final = finals[finals.length - 1] || null;
    const finalNode = final?.node || null;
    const candidateNode = [...turnNodes].reverse().find(node =>
      apiMessageRole(node) === 'assistant'
      && ['text', 'multimodal_text'].includes(apiMessageContentType(node))) || null;
    const candidateMessage = candidateNode?.message || {};
    const tailNode = turnNodes[turnNodes.length - 1] || null;
    const sources = [];
    const activity = [];
    const reasoning = [];
    for (const node of turnNodes) {
      sources.push(...apiLinksFromMessage(node));
      const item = apiActivityFromMessage(node);
      if (item) activity.push(item);
      const message = node.message || {};
      const type = apiMessageContentType(node);
      if (apiMessageRole(node) === 'assistant'
          && (type === 'reasoning_recap' || message.metadata?.is_thinking_preamble_message)) {
        const text = apiMessageText(node);
        if (text) reasoning.push(text);
      }
    }
    return {
      ready: !!finalNode,
      reason: finalNode
        ? (final.kind === 'legacy_tail_final' ? 'api_legacy_final' : 'api_final')
        : 'api_final_pending',
      proof_kind: final?.kind || null,
      text: finalNode ? apiMessageText(finalNode) : '',
      reasoning_text: reasoning.join('\n\n---\n\n').trim(),
      links: dedupeSourceLinks(sources),
      activity_items: dedupeActivityItems(activity),
      title: data.title || document.title,
      message_id: finalNode?.message?.id || finalNode?.id || null,
      candidate_message_id: candidateMessage.id || candidateNode?.id || null,
      candidate_channel: candidateMessage.channel ?? null,
      candidate_end_turn: candidateMessage.end_turn ?? null,
      candidate_preamble: !!candidateMessage.metadata?.is_thinking_preamble_message,
      candidate_status: candidateMessage.status || null,
      tail_message_id: tailNode?.message?.id || tailNode?.id || null,
      tail_role: apiMessageRole(tailNode) || null,
      tail_content_type: apiMessageContentType(tailNode) || null,
      conversation_id: data.conversation_id || null,
      user_text: lastUser >= 0 ? apiMessageText(nodes[lastUser]) : null,
      user_id: nodes[lastUser]?.message?.id || nodes[lastUser]?.id || null,
      user_ids: nodes.filter(node => apiMessageRole(node) === 'user')
        .map(node => node.message?.id || node.id).filter(Boolean),
    };
  }

  async function latestApiTurnSnapshot(timeoutMs) {
    return latestApiTurnSnapshotFromData(await fetchChatGPTConversationJson(timeoutMs));
  }

  function terminalProofForCurrentPage(proof) {
    // Temporary Chat не получает /c/<conversation-id> в URL, поэтому
    // conversation API нельзя адресовать. Этот fallback вызывается только
    // ПОСЛЕ DOM-proof watcher'а: Stop исчез, quiet-window прошёл, в том же
    // assistant-turn есть текст и action «Копировать ответ».
    if (isTemporaryChatPage() && proof?.reason === 'conversation_url_pending') {
      return {
        ...proof,
        ready: true,
        fallback: true,
        reason: 'temporary_chat_dom_final',
      };
    }
    return proof;
  }

  function conversationMessageId(el) {
    return el?.getAttribute('data-message-id')
      || el?.getAttribute('data-chatgpt-selection-message-id')
      || el?.getAttribute('data-chatgpt-search-message-ids')?.split(/\s+/)[0]
      || null;
  }
  function conversationMessageKey(el) {
    return conversationMessageId(el)
      || el?.getAttribute('data-chatgpt-search-unit-key')
      || el?.closest('[data-testid^="conversation-turn-"]')?.getAttribute('data-testid')
      || null;
  }
  function conversationMessageElements(role = null) {
    const legacy = Array.from(document.querySelectorAll(
      role ? `[data-message-author-role="${role}"]` : '[data-message-author-role]'
    ));
    if (legacy.length) return legacy;
    const selector = role
      ? `[data-chatgpt-search-unit-key$=":${role}"]`
      : '[data-chatgpt-search-unit-key]';
    return Array.from(document.querySelectorAll(selector));
  }
  function userMessageElements() {
    return conversationMessageElements('user');
  }
  function createTurnBoundary(apiBaseline = null, resumed = false, { prompt } = {}) {
    const users = userMessageElements();
    const messages = conversationMessageElements();
    const conversationId = apiBaseline?.conversation_id
      || (resumed ? chatgptConversationIdFromLocation() : null);
    return {
      resumed,
      // A provisional local-chatgpt URL can become the real conversation
      // after hydration. Only pin a stable provider identity.
      conversationId: conversationId && !/^local-chatgpt(?::|%3a)/i.test(conversationId)
        ? conversationId : null,
      expectedUserText: typeof prompt === 'string' && prompt.trim() ? prompt.trim() : null,
      previousUsers: new Set(users),
      previousUserKeys: new Set(users.map(conversationMessageKey).filter(Boolean)),
      previousApiUsers: apiBaseline?.user_ids ? new Set(apiBaseline.user_ids) : null,
      previousTail: messages[messages.length - 1] || null,
      previousAssistantKeys: new Set(conversationMessageElements('assistant')
        .map(conversationMessageKey).filter(Boolean)),
      userId: null,
      userKey: null,
      userEl: null,
    };
  }
  function submittedUserElement(boundary) {
    if (!boundary) return null;
    const users = userMessageElements();
    let user;
    if (boundary.userId || boundary.userKey || boundary.userEl) {
      user = users.find(el => (boundary.userId && conversationMessageId(el) === boundary.userId)
        || (!conversationMessageId(el) && (boundary.userKey
          ? conversationMessageKey(el) === boundary.userKey : el === boundary.userEl)));
    } else {
      const tailKey = conversationMessageKey(boundary.previousTail);
      const tail = tailKey ? conversationMessageElements()
        .find(el => conversationMessageKey(el) === tailKey) : boundary.previousTail;
      user = boundary.resumed ? users[users.length - 1] : users.find(el =>
        !boundary.previousUsers.has(el)
        && !boundary.previousUserKeys.has(conversationMessageKey(el))
        && !boundary.previousApiUsers?.has(conversationMessageId(el))
        && (!tail || followsMessage(tail, el)));
    }
    if (user) {
      boundary.userEl = user;
      boundary.userId = conversationMessageId(user) || boundary.userId;
      boundary.userKey = conversationMessageKey(user);
    }
    return user || null;
  }
  function followsMessage(a, b) {
    const position = a?.compareDocumentPosition(b) || 0;
    return !(position & Node.DOCUMENT_POSITION_DISCONNECTED)
      && !!(position & Node.DOCUMENT_POSITION_FOLLOWING);
  }
  function belongsToSubmittedTurn(el, boundary) {
    const user = submittedUserElement(boundary);
    if (!user || !el || !followsMessage(user, el)) return false;
    const nextUser = userMessageElements().find(candidate => followsMessage(user, candidate));
    return !nextUser || followsMessage(el, nextUser);
  }
  function submittedAssistantElement(boundary, accepted = null) {
    const assistants = conversationMessageElements('assistant');
    if (accepted) {
      // Keep the accepted answer through React remounts; never move extraction
      // to another reply that arrived while sources/images were being read.
      return assistants.find(el => (accepted.id && conversationMessageId(el) === accepted.id)
        || (!accepted.id || !conversationMessageId(el))
          && (accepted.key ? conversationMessageKey(el) === accepted.key : el === accepted.el)) || null;
    }
    const own = assistants.filter(el => belongsToSubmittedTurn(el, boundary)
      && (boundary.resumed || !boundary.previousAssistantKeys.has(conversationMessageKey(el))));
    return own[own.length - 1] || null;
  }
  function assistantTarget(el, apiFinal) {
    return {
      id: apiFinal?.message_id || conversationMessageId(el),
      key: conversationMessageKey(el),
      el,
    };
  }
  function apiProofForSubmittedTurn(proof, boundary) {
    const pageConversationId = chatgptConversationIdFromLocation();
    if (proof.conversation_id && pageConversationId
        && !/^local-chatgpt(?::|%3a)/i.test(pageConversationId)
        && proof.conversation_id !== pageConversationId) {
      return { ...proof, ready: false, reason: 'api_not_current_conversation' };
    }
    if (boundary.conversationId && chatgptConversationIdFromLocation() !== boundary.conversationId) {
      return { ...proof, ready: false, reason: 'page_not_submitted_conversation' };
    }
    if (boundary.conversationId && proof.conversation_id
        && proof.conversation_id !== boundary.conversationId) {
      return { ...proof, ready: false, reason: 'api_not_submitted_conversation' };
    }
    if (proof.fallback) return proof;
    if (!proof.user_id) return proof.ready
      ? { ready: true, fallback: true, reason: 'api_turn_unmapped_dom_fallback' } : proof;
    // A resumed job has no pre-Send DOM baseline. Its retained input must
    // match before an unrendered latest API user can become its exact turn.
    if (boundary.resumed && boundary.expectedUserText !== null
        && boundary.expectedUserText !== undefined && proof.user_text !== boundary.expectedUserText) {
      return { ...proof, ready: false, reason: 'api_user_prompt_mismatch' };
    }
    submittedUserElement(boundary);
    if (boundary.userId) {
      if (proof.user_id !== boundary.userId) return { ...proof, ready: false, reason: 'api_user_not_submitted_turn' };
      if (!boundary.conversationId && proof.conversation_id) boundary.conversationId = proof.conversation_id;
      return proof;
    }
    if (!boundary.resumed && (boundary.previousApiUsers?.has(proof.user_id)
        || boundary.previousUserKeys.has(proof.user_id))) {
      return { ...proof, ready: false, reason: 'api_user_precedes_submission' };
    }
    if (proof.user_id && (boundary.resumed
        || (boundary.previousApiUsers && !boundary.previousApiUsers.has(proof.user_id)))) {
      boundary.userId = proof.user_id;
      if (!boundary.conversationId && proof.conversation_id) boundary.conversationId = proof.conversation_id;
      return proof;
    }
    // A failed API baseline does not make an old final new. DOM identity can
    // still prove this turn when the page does not expose API message IDs.
    return proof.ready ? { ready: true, fallback: true, reason: 'api_turn_unmapped_dom_fallback' } : proof;
  }
  function createTerminalProbe(boundary, snapshot = latestApiTurnSnapshot) {
    let failures = 0;
    return async () => {
      try {
        const proof = terminalProofForCurrentPage(await snapshot(8000));
        failures = 0;
        return apiProofForSubmittedTurn(proof, boundary);
      } catch (error) {
        if (++failures < 3) throw error;
        return apiProofForSubmittedTurn({ ready: true, fallback: true, reason: 'api_unavailable_dom_fallback' }, boundary);
      }
    };
  }

  function renderApiSourcesMarkdown(links) {
    if (!links.length) return '';
    let md = `\n\n### Источники\n\n`;
    links.forEach((l, idx) => { md += `${idx + 1}. ${l.title || l.url} — ${l.url}\n`; });
    return md;
  }

  function renderApiActivityMarkdown(items) {
    if (!items.length) return '';
    let md = `\n\n### Активность поиска\n\n`;
    const codeBlock = (value) => {
      const body = String(value || '').replace(/^```[^\n]*\n?|\n?```$/g, '');
      const runs = body.match(/`{3,}/g) || [];
      const maxRun = runs.reduce((max, run) => Math.max(max, run.length), 2);
      const fence = '`'.repeat(Math.max(3, maxRun + 1));
      return `\n  ${fence}text\n${body}\n  ${fence}\n`;
    };
    for (const item of items) {
      md += `- ${item.title || 'Шаг'}\n`;
      if (item.command) {
        md += codeBlock(item.command);
      } else if (item.text) {
        const text = String(item.text);
        md += (text.includes('\n') || text.length > 300)
          ? codeBlock(text)
          : `  ${text}\n`;
      }
    }
    return md;
  }

  function buildChatGPTApiMarkdown(data, settings, stats, mode, attachmentTexts = new Map()) {
    const nodes = chatgptCurrentPathNodes(data)
      .filter(node => node?.message && apiMessageRole(node) !== 'system' && !isHiddenApiMessage(node));
    const turns = [];
    let current = null;

    for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) {
      const node = nodes[nodeIndex];
      assertPopupExportNotCancelled();
      const role = apiMessageRole(node);
      const type = apiMessageContentType(node);
      const msg = node.message;
      if (role === 'user') {
        current = { user: node, assistant: [], reasoning: [], sources: [], activity: [] };
        turns.push(current);
        continue;
      }
      if (!current) {
        current = { user: null, assistant: [], reasoning: [], sources: [], activity: [] };
        turns.push(current);
      }
      if (role === 'assistant') {
        if (type === 'reasoning_recap' || type === 'thoughts' || msg.metadata?.is_thinking_preamble_message) {
          const text = apiMessageText(node);
          if (text) current.reasoning.push(text);
        } else if (apiAssistantFinalKind(node, { isTurnTail: isApiTurnTailNode(nodes, nodeIndex) })) {
          const text = apiMessageText(node);
          if (text) current.assistant.push(text);
        } else if (type === 'code' || type === 'model_editable_context') {
          const item = apiActivityFromMessage(node);
          if (item) current.activity.push(item);
        }
        const links = apiLinksFromMessage(node);
        if (links.length) current.sources.push(...links);
      } else if (role === 'tool') {
        const item = apiActivityFromMessage(node);
        if (item) current.activity.push(item);
      }
    }

    const dedupeLinks = (links) => {
      const seen = new Set();
      const out = [];
      for (const link of links) {
        if (!link?.url || seen.has(link.url)) continue;
        seen.add(link.url);
        out.push(link);
      }
      return out;
    };

    const parts = [];
    for (const turn of turns) {
      assertPopupExportNotCancelled();
      const userText = turn.user ? apiMessageText(turn.user) : '';
      const userAttachments = turn.user ? apiAttachmentsMarkdown(turn.user, settings, attachmentTexts) : '';
      const attachments = turn.user?.message?.metadata?.attachments || [];
      const assistantText = turn.assistant.join('\n\n---\n\n').trim();
      const links = dedupeLinks(turn.sources);

      if (userText || userAttachments) {
        stats.user++;
        if (settings.includeImages) stats.images += attachments.filter(isExportImageAttachment).length;
        stats.documents = (stats.documents || 0) + attachments.filter(a => !isExportImageAttachment(a)).length;
        parts.push(`## User\n\n${userText || '_[Пустое сообщение]_'}${userAttachments}`.trim() + '\n');
      }
      if (assistantText || turn.reasoning.length || links.length || turn.activity.length) {
        stats.assistant++;
        let md = `## ChatGPT\n\n${assistantText || '_[Финальный текст не найден в API-записи.]_'}\n`;
        if (settings.includeReasoning && turn.reasoning.length) {
          md += `\n\n### Рассуждения ChatGPT\n\n${turn.reasoning.join('\n\n---\n\n')}\n`;
        }
        if (settings.includeSources && links.length) {
          stats.sources += links.length;
          md += renderApiSourcesMarkdown(links);
        }
        if (settings.includeSourceActivity && turn.activity.length) {
          stats.activity += turn.activity.length;
          md += renderApiActivityMarkdown(turn.activity);
        }
        parts.push(md.trim() + '\n');
      }
    }

    const title = data.title || document.title || 'ChatGPT chat';
    const exportedAt = new Date().toISOString();
    const providerLabel = `ChatGPT · ${chatgptModeLabel(mode)}`;
    let markdown = `# ${title}\n\n`;
    markdown += `> **Сводка экспорта ${providerLabel}**  \n`;
    markdown += `> Режим: ${providerLabel}  \n`;
    markdown += `> Источник: ChatGPT backend API  \n`;
    markdown += `> User-сообщений: ${stats.user}; ответов ChatGPT: ${stats.assistant}  \n`;
    markdown += `> Источников: ${stats.sources}; activity-шагов: ${stats.activity}; картинок: ${stats.images}; документов: ${stats.documents || 0}  \n`;
    const failedDocuments = [...attachmentTexts.values()].filter(item => !item.ok);
    if (failedDocuments.length) {
      markdown += `> ВНИМАНИЕ: содержимое ${failedDocuments.length} текстовых вложений не удалось получить; подробности рядом с файлами.  \n`;
    }
    markdown += `> URL: ${location.href}  \n`;
    markdown += `> Экспортировано: ${exportedAt}\n\n---\n\n`;
    return { markdown: markdown + parts.join('\n---\n\n') + '\n', turnCount: parts.length, source: 'api',
      failedDocuments: failedDocuments.length, textDocuments: [...attachmentTexts.values()].filter(item => item.ok).length };
  }

  async function runChatGPTPopupExport(rawSettings, deps = {}) {
    if (popupExportRunning) {
      if (!document.getElementById(CHATGPT_EXPORT_OVERLAY_ID)) showChatGPTExportOverlay();
      return { success: false, message: 'Экспорт уже запущен' };
    }
    popupExportRunning = true;
    popupExportCancel = false;
    const settings = normalizeChatGPTExportSettings(rawSettings || {});
    const exportMode = currentChatgptMode() || 'chat';
    const exportProviderLabel = `ChatGPT · ${chatgptModeLabel(exportMode)}`;
    const started = performance.now();
    const stats = { user: 0, assistant: 0, sources: 0, activity: 0, images: 0 };
    const parts = [];

    showChatGPTExportOverlay();
    try {
      assertPopupExportNotCancelled();
      updateChatGPTExportOverlay('Запрашиваю историю ChatGPT...', 'Шаг 1/3: полный JSON диалога');
      let apiBuilt = null;
      let apiData = null;
      try {
        apiData = await (deps.fetchConversation || fetchChatGPTConversationJson)();
        assertPopupExportNotCancelled();
      } catch (apiError) {
        log('popup_export.api_fallback', { err: apiError?.message || String(apiError) });
      }
      if (apiData) {
        const attachmentTexts = await resolveChatGPTExportAttachments(apiData);
        apiBuilt = buildChatGPTApiMarkdown(apiData, settings, stats, exportMode, attachmentTexts);
      }

      if (apiBuilt?.markdown && apiBuilt.turnCount > 0) {
        assertPopupExportNotCancelled();
        updateChatGPTExportOverlay('Собираю markdown...', 'Шаг 3/3: упаковка');
        const filename = `chatgpt-${exportMode}-${safeFilenamePart(document.title || 'chat')}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.md`;
        const delivery = await deliverMarkdown(apiBuilt.markdown, filename, settings.__export.downloadFile);
        const elapsed = ((performance.now() - started) / 1000).toFixed(1);
        log('popup_export.done', {
          source: apiBuilt.source,
          mode: exportMode,
          turns: apiBuilt.turnCount,
          delivery,
          sources: stats.sources,
          activity: stats.activity,
          images: stats.images,
          textDocuments: apiBuilt.textDocuments,
          failedDocuments: apiBuilt.failedDocuments,
          elapsed,
        });
        showChatGPTExportTerminal(apiBuilt.failedDocuments ? 'warning' : 'success',
          `Записей: ${apiBuilt.turnCount}; текстовых документов: ${apiBuilt.textDocuments}; источников: ${stats.sources}\n` +
          (apiBuilt.failedDocuments ? `Не прочитано документов: ${apiBuilt.failedDocuments}. Причины указаны в экспорте.\n` : '') +
          (delivery === 'clipboard'
            ? 'Markdown скопирован в буфер обмена'
            : delivery === 'download-fallback'
              ? `Буфер обмена был недоступен, скачан файл: ${filename}`
          : `Файл: ${filename}`));
        return { success: true, complete: !apiBuilt.failedDocuments,
          message: `Экспорт ${exportProviderLabel} завершён`, chatgptMode: exportMode };
      }
      if (apiBuilt?.markdown) {
        log('popup_export.api_empty_fallback', { turns: apiBuilt.turnCount });
      }

      updateChatGPTExportOverlay('Сканирую сообщения ChatGPT...', 'Шаг 1/3: DOM fallback');
      await waitFor(() => conversationMessageElements().length, 'ChatGPT messages', 8000, 200);
      const turns = chatgptConversationTurns();
      if (!turns.length) throw new Error('Сообщения ChatGPT не найдены на странице');
      let domTextDocuments = 0;
      let domFailedDocuments = 0;

      for (let i = 0; i < turns.length; i++) {
        assertPopupExportNotCancelled();
        const turn = turns[i];
        const messageEl = extractMessageRoot(turn);
        const role = exportMessageRole(messageEl);
        if (role === 'user') stats.user++;
        if (role === 'assistant') stats.assistant++;
        try { turn.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (_) {}
        updateChatGPTExportOverlay('Извлекаю сообщения...', `Шаг 2/3: ${i + 1}/${turns.length} (${roleLabel(role)})`);
        await sleep(80);

        let md = `## ${roleLabel(role)}\n\n`;
        const text = extractMessageTextMarkdown(messageEl, role);
        const images = settings.includeImages ? extractImagesForExportTurn(turn) : [];
        if (text) md += `${text}\n`;
        if (role === 'user') {
          for (const card of domExportDocumentCards(messageEl)) {
            assertPopupExportNotCancelled();
            const key = exportAttachmentName(card.attachment);
            updateChatGPTExportOverlay('Читаю текст вложения...', key);
            try {
              const content = await resolveDOMExportDocument(card);
              md += `\n\n### Вложение: ${markdownEscapeInline(key)}\n\n${exportTextFileBlock(content.text)}`;
              domTextDocuments += 1;
              log('popup_export.document_read', { source: 'dom_preview_download', bytes: content.bytes, chars: content.text.length });
            } catch (error) {
              assertPopupExportNotCancelled();
              domFailedDocuments += 1;
              md += `\n\n### Вложение: ${markdownEscapeInline(key)}\n\n_[Содержимое не получено: ${markdownEscapeInline(error?.message || String(error))}.]_\n`;
              log('popup_export.document_failed', { source: 'dom_preview_download', error: error?.message || String(error) });
            }
          }
        }
        if (settings.includeReasoning && role === 'assistant') {
          const reasoning = extractReasoningMarkdownForMessage(messageEl);
          if (reasoning) md += `\n\n### Рассуждения ChatGPT\n\n${reasoning}\n`;
        }
        if (images.length) {
          stats.images += images.length;
          md += renderImagesMarkdown(images);
        }
        if (role === 'assistant' && (settings.includeSources || settings.includeSourceActivity)) {
          updateChatGPTExportOverlay('Читаю источники ChatGPT...', `Шаг 2/3: ${i + 1}/${turns.length}`);
          const src = await extractSourcesForExportTurn(turn, i + 1);
          stats.sources += src.links.length;
          stats.activity += src.activity_items.length;
          md += renderSourcesMarkdown(src, settings);
        }
        if (!text && !images.length) {
          md += '_[Сообщение найдено, но текст или изображение не извлечены из DOM.]_\n';
        }
        parts.push(md.trim() + '\n');
      }

      updateChatGPTExportOverlay('Собираю markdown...', 'Шаг 3/3: упаковка');
      const body = parts.join('\n---\n\n');
      const warning = domFailedDocuments
        ? `> ВНИМАНИЕ: не прочитано текстовых вложений: ${domFailedDocuments}.\n\n` : '';
      const markdown = buildChatGPTExportHeader(turns.length, stats, exportMode) + warning + body + '\n';
      const filename = `chatgpt-${exportMode}-${safeFilenamePart(document.title || 'chat')}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.md`;
      const delivery = await deliverMarkdown(markdown, filename, settings.__export.downloadFile);
      const elapsed = ((performance.now() - started) / 1000).toFixed(1);
      log('popup_export.done', {
        turns: turns.length,
        mode: exportMode,
        delivery,
        sources: stats.sources,
        activity: stats.activity,
        images: stats.images,
        textDocuments: domTextDocuments,
        failedDocuments: domFailedDocuments,
        elapsed,
      });
      showChatGPTExportTerminal(domFailedDocuments ? 'warning' : 'success',
        `Сообщений: ${turns.length}; текстовых документов: ${domTextDocuments}; источников: ${stats.sources}\n` +
        (domFailedDocuments ? `Не прочитано документов: ${domFailedDocuments}. Причины указаны в экспорте.\n` : '') +
        (delivery === 'clipboard'
          ? 'Markdown скопирован в буфер обмена'
          : delivery === 'download-fallback'
            ? `Буфер обмена был недоступен, скачан файл: ${filename}`
            : `Файл: ${filename}`));
      return { success: true, complete: !domFailedDocuments,
        message: `Экспорт ${exportProviderLabel} завершён`, chatgptMode: exportMode };
    } catch (e) {
      const msg = e?.message || String(e);
      log('popup_export.failed', { err: msg });
      showChatGPTExportTerminal('error', msg);
      return { success: false, message: msg };
    } finally {
      popupExportRunning = false;
      popupExportCancel = false;
    }
  }

  // ── Реестр уровней интеллекта (effort). ЕДИНОЕ место. ──────────────
  // Плоские уровни — menuitemradio прямо в меню композер-pill'а;
  // pro-уровни: верхнеуровневый radio «Pro» включает режим, а стандартный/
  // расширенный выбирается в сабменю. match покрывает RU («Очень высокий») и EN.
  // xhigh — дефолт для reasoning-моделей; GPT-5.5 поддерживает только Instant.
  const EFFORTS = [
    { key: 'low',          match: /^(Low|Light|Низкий|Л[её]гкий)$/i,    sub: false, aliases: ['low', 'light', 'низкий', 'лёгкий', 'легкий'] },
    { key: 'instant',      match: /^(Instant|Мгновенный)(?:\s*\d+(?:\.\d+)?)?$/i, sub: false, aliases: ['instant', 'мгновенный'] },
    { key: 'medium',       match: /^(Medium|Средний)$/i,                 sub: false, aliases: ['medium', 'mid', 'средний'] },
    { key: 'high',         match: /^(High|Высокий)$/i,                   sub: false, aliases: ['high', 'высокий'] },
    { key: 'xhigh',        match: /^(Очень высокий|Very\s*high|Extra\s*high)$/i, sub: false, aliases: ['xhigh', 'x-high', 'extra high', 'очень высокий', 'very high'] },
    { key: 'pro',          match: /^Pro$/i,                              sub: false, aliases: ['pro', 'pro-standard', 'pro стандартный'] },
    { key: 'pro-extended', match: /^(Pro усиленный|Pro расширенный|Pro extended)$/i, sub: true, aliases: ['pro-extended', 'pro-ext', 'extended', 'pro усиленный', 'pro расширенный'] },
    { key: 'max',          match: /^(Max|Максимальный)$/i,               sub: false, aliases: ['max', 'максимальный'] },
    { key: 'ultra',        match: /^(Ultra|Ультра)/i,                    sub: false, aliases: ['ultra', 'ультра'] },
  ];
  const DEFAULT_EFFORT = 'xhigh';
  function resolveEffort(input) {
    if (!input) return DEFAULT_EFFORT;
    const q = String(input).trim().toLowerCase();
    if (q === 'pro-extended' || q === 'pro-ext' || q === 'pro стандартный' || q === 'pro расширенный') return 'pro';
    const hit = EFFORTS.find(e => e.key === q)
             || EFFORTS.find(e => e.aliases.some(a => a === q))
             || EFFORTS.find(e => e.aliases.some(a => q.includes(a) || a.includes(q)));
    return hit ? hit.key : DEFAULT_EFFORT;
  }
  function effortLabel(key) {
    return ({ low: 'Low', instant: 'Instant', medium: 'Medium', high: 'High', xhigh: 'Очень высокий',
              pro: 'Pro стандартный', 'pro-extended': 'Pro усиленный', max: 'Max', ultra: 'Ultra' })[key] || key;
  }
  function effortKeyFromText(text) {
    const label = String(text || '').replace(/\s+/g, ' ').trim();
    return EFFORTS.find(eff => eff.match.test(label))?.key || null;
  }
  const CHAT_EFFORT_SLIDER_KEYS = Object.freeze(['instant', 'medium', 'high', 'xhigh', 'pro']);
  const WORK_EFFORT_SLIDER_KEYS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  function workEffortKeys(modelKey) {
    if (modelKey === '5.5') return WORK_EFFORT_SLIDER_KEYS.slice(0, 4);
    if (modelKey === '6-luna' || modelKey === '5.6-luna') return WORK_EFFORT_SLIDER_KEYS.slice(0, 5);
    return ['6.1-sol', '6-sol', '6-astra', '5.6-sol', '5.6-terra'].includes(modelKey)
      ? WORK_EFFORT_SLIDER_KEYS : null;
  }
  function effortSliderKeys(minValue, maxValue, mode = null, modelKey = null) {
    const min = Number(minValue);
    const max = Number(maxValue);
    if (min !== 0) return null;
    if (mode === 'work') {
      const keys = workEffortKeys(modelKey);
      return keys && keys.length === max - min + 1 ? keys : null;
    }
    if (mode === 'chat') return max === 4 ? CHAT_EFFORT_SLIDER_KEYS : null;
    if (max === 4) return CHAT_EFFORT_SLIDER_KEYS;
    if (max === 5) return WORK_EFFORT_SLIDER_KEYS;
    return null;
  }
  function effortKeyFromSliderValue(value, minValue, maxValue, mode = null, modelKey = null) {
    const keys = effortSliderKeys(minValue, maxValue, mode, modelKey);
    const index = Number(value) - Number(minValue);
    return keys && Number.isInteger(index) ? (keys[index] || null) : null;
  }
  function effortSliderValueForKey(key, minValue, maxValue, mode = null, modelKey = null) {
    const keys = effortSliderKeys(minValue, maxValue, mode, modelKey);
    const index = keys ? keys.indexOf(key) : -1;
    return index >= 0 ? Number(minValue) + index : null;
  }
  function findEffortSlider() {
    return visibleAll('[role="slider"][aria-valuemin][aria-valuemax][aria-valuenow]')
      .find(el => el.getAttribute('role') === 'slider') || null;
  }
  function currentEffortKeyFromSlider(slider = findEffortSlider(), mode = currentChatgptMode(), modelKey = null) {
    if (!slider) return null;
    if (mode === 'work' && !modelKey) {
      modelKey = visibleAll('[role="menuitemradio"][aria-checked="true"]')
        .map(el => modelKeyFromText(nodeText(el))).find(key => key && key !== 'latest')
        || modelKeyFromText(nodeText(findEffortTrigger()));
    }
    return effortKeyFromSliderValue(
      slider.getAttribute('aria-valuenow'),
      slider.getAttribute('aria-valuemin'),
      slider.getAttribute('aria-valuemax'),
      mode,
      modelKey,
    );
  }
  function effortSliderTicks(slider) {
    const control = slider?.closest?.('[role="menuitem"]') || slider?.parentElement;
    if (!control) return [];
    return Array.from(control.querySelectorAll('span'))
      .filter(el => /(?:^|\s)(?:[^\s]*_Tick|Tick-[^\s]+)(?:\s|$)/.test(String(el.className || '')))
      .filter(isVisible)
      .sort((a, b) => a.getBoundingClientRect().x - b.getBoundingClientRect().x);
  }
  async function selectEffortSliderValue(slider, targetValue) {
    const min = Number(slider?.getAttribute('aria-valuemin'));
    const max = Number(slider?.getAttribute('aria-valuemax'));
    const target = Number(targetValue);
    if (![min, max, target].every(Number.isFinite) || target < min || target > max) {
      throw new Error('invalid effort slider target');
    }
    const ticks = effortSliderTicks(slider);
    const expected = max - min + 1;
    if (ticks.length !== expected) {
      throw new Error(`effort slider ticks mismatch: ${ticks.length}/${expected}`);
    }
    const clicked = await trustedClick(ticks[target - min]);
    if (!clicked?.ok) throw new Error('trusted effort slider click failed: ' + (clicked?.err || 'unknown'));
    await sleep(600);
  }

  // ── Реестр моделей. В меню composer-pill'а текущая модель раскрывает
  // сабменю с radio. Реестр намеренно статический: новые доступные в UI модели
  // добавляются отдельно, но DOM-подписи и их порядок не являются контрактом.
  // ChatGPT запоминает выбор per-аккаунт — поэтому модель ВСЕГДА верифицируем,
  // не «скип если дефолт»: прошлый job мог оставить другую модель.
  const MODELS = [
    { key: '6',         label: 'GPT-6', aliases: ['6', 'gpt-6', 'gpt 6'] },
    { key: '6.1-sol',   label: 'GPT-6.1 Sol', aliases: ['6.1-sol', 'gpt-6.1-sol', 'gpt-6.1 sol', '6.1 sol'] },
    { key: '6-sol',     label: 'GPT-6 Sol', aliases: ['6-sol', 'gpt-6-sol', 'gpt-6 sol', '6 sol'] },
    { key: '6-luna',    label: 'GPT-6 Luna', aliases: ['6-luna', 'gpt-6-luna', 'gpt-6 luna', '6 luna'] },
    { key: '6-astra',   label: 'GPT-6 Astra', aliases: ['6-astra', 'gpt-6-astra', 'gpt 6 astra', 'gpt-6 astra', '6 astra', 'astra'] },
    { key: '5.6-terra', label: 'GPT-5.6 Terra', aliases: ['5.6-terra', 'gpt-5.6 terra', 'gpt-5.6-terra', 'terra'] },
    { key: '5.6-luna',  label: 'GPT-5.6 Luna',  aliases: ['5.6-luna', 'gpt-5.6 luna', 'gpt-5.6-luna', 'luna'] },
    { key: '5.6-sol',   label: 'GPT-5.6 Sol',   aliases: ['5.6-sol', 'gpt-5.6 sol', 'gpt-5.6-sol', 'sol', '5.6', 'gpt-5.6', 'gpt5.6', 'gpt 5.6'] },
    { key: '5.5',       label: 'GPT-5.5 Instant', aliases: ['5.5', 'gpt-5.5', 'gpt5.5', 'gpt 5.5', 'gpt-5.5 instant'] },
    { key: 'o3',        label: 'o3 · до 26 августа', aliases: ['o3'] },
  ];
  const DEFAULT_MODEL = '5.6-sol';
  function resolveModel(input) {
    if (!input) return DEFAULT_MODEL;
    const q = String(input).trim().toLowerCase();
    const parsed = modelKeyFromText(q);
    if (parsed) return parsed;
    const hit = MODELS.find(m => m.key === q)
             || MODELS.find(m => m.aliases.includes(q))
             || MODELS.find(m => m.aliases.some(a => q.includes(a)));
    return hit ? hit.key : DEFAULT_MODEL;
  }
  function modelDisplay(key) { return MODELS.find(model => model.key === key)?.label || key; }

  // Современный триггер имеет semantic marker; его textContent включает
  // скрытую измерительную подпись и уже не обязан быть коротким «Pro / High».
  // Старые class/text пути сохраняются для прежнего UI.
  function findEffortTrigger() {
    const pills = Array.from(document.querySelectorAll('button[aria-haspopup="menu"]'))
      .filter(isVisible);
    return pills.find(b => b.getAttribute('data-codex-intelligence-trigger') === 'true'
          || b.getAttribute('data-composer-navigation-target') === 'reasoning')
        || pills.find(b => (b.className || '').includes('__composer-pill'))
        || pills.find(b => {
             const t = nodeText(b);
             return t.length < 30 && /^(Pro|Instant|Low|Medium|High|Max|Ultra|Очень высокий|Very\s*high|Extra\s*high|Auto)/i.test(t);
           });
  }
  function findEffortItem(eff) {
    return visibleAll('[role="menuitemradio"]')
      .find(el => eff.match.test(nodeText(el)));
  }
  // Уровень может быть вложенным пунктом «Усилие → …» либо строкой с
  // текущим значением («Очень высокий») без aria-haspopup. Обе формы
  // раскрываются через aria-expanded и должны считаться одним триггером.
  function findEffortSubTrigger() {
    return visibleAll('[role="menuitem"]')
      .find(el => {
        if (el.getAttribute('role') !== 'menuitem') return false;
        const text = nodeText(el);
        const opensSubmenu = el.getAttribute('aria-haspopup') === 'menu'
          || el.getAttribute('aria-expanded') != null;
        return opensSubmenu && (
          /^(?:Усилие|Effort|Уровень|Level)/i.test(text)
          || !!effortKeyFromText(text)
        );
      }) || null;
  }
  function currentEffortKeyFromOpenMenu(mode = currentChatgptMode(), modelKey = null) {
    const sliderKey = currentEffortKeyFromSlider(findEffortSlider(), mode, modelKey);
    if (sliderKey) return sliderKey;
    const checked = visibleAll('[role="menuitemradio"][aria-checked="true"]')
      .filter(el => el.getAttribute('role') === 'menuitemradio' && el.getAttribute('aria-checked') === 'true')
      .map(el => effortKeyFromText(nodeText(el)))
      .find(Boolean);
    if (checked) return checked;
    const trigger = findEffortSubTrigger();
    const fromTrigger = trigger ? effortKeyFromText(nodeText(trigger)) : null;
    if (fromTrigger) return fromTrigger;
    return effortKeyFromText(nodeText(findEffortTrigger()));
  }
  function findProMainItem() {
    return visibleAll('[role="menuitemradio"]')
      .find(el => /^Pro$/i.test(nodeText(el)));
  }
  function findAnyProDetailItem() {
    return visibleAll('[role="menuitemradio"]')
      .find(el => /^(Pro стандартный|Pro standard|Pro усиленный|Pro расширенный|Pro extended)$/i.test(nodeText(el)));
  }
  function effortMenuSnapshot() {
    const items = visibleAll('[role="menuitemradio"], [role="menuitem"], [role="menuitemcheckbox"]')
      .map(el => ({
        text: nodeText(el),
        role: el.getAttribute('role'),
        checked: el.getAttribute('aria-checked'),
        expanded: el.getAttribute('aria-expanded'),
        ariaLabel: el.getAttribute('aria-label'),
        testid: el.getAttribute('data-testid'),
      }))
      .filter(x => x.text || x.testid || x.ariaLabel);
    const slider = findEffortSlider();
    if (slider) {
      items.push({
        text: currentEffortKeyFromSlider(slider),
        role: 'slider',
        checked: null,
        expanded: null,
        ariaLabel: slider.getAttribute('aria-label'),
        testid: null,
        value: slider.getAttribute('aria-valuenow'),
        min: slider.getAttribute('aria-valuemin'),
        max: slider.getAttribute('aria-valuemax'),
      });
    }
    return items;
  }
  function findProSubTrigger() {
    return visibleAll('[data-testid="composer-intelligence-pro-thinking-effort-trigger"]')[0] || null;
  }
  // В Work три модели одного поколения, поэтому одного номера 5.6 уже
  // недостаточно: Sol, Terra и Luna должны сохраняться как разные ключи.
  function modelKeyFromText(text) {
    const label = String(text || '').replace(/\s+/g, ' ').trim();
    if (/^o3(?:\s|$)/i.test(label)) return 'o3';
    if (/^(?:Последняя|Latest)$/i.test(label)) return 'latest';
    // Read generation AND tier before any broad GPT-6 alias. Labels can
    // concatenate the effort ("GPT-6.1 SolMax") or prefix "Latest •".
    const explicit = label.match(/(?:^|[^\d.])(6\.1|6|5\.6)[\s-]*(Astra|Sol|Terra|Luna)/i);
    if (explicit) return `${explicit[1]}-${explicit[2].toLowerCase()}`;
    const tier = label.match(/\b(Sol|Terra|Luna)\b/i)?.[1]?.toLowerCase() || null;
    const gpt = label.match(/(?:GPT|Model|Модель)[\s-]*(\d+(?:\.\d+)?)(?=\D|$)/i);
    if (gpt?.[1] === '6') return '6';
    if (gpt?.[1] === '5.6') return `5.6-${tier || 'sol'}`;
    if (gpt?.[1] === '5.5') return '5.5';
    if (tier && /(?:^|\D)5\.6(?:\D|$)/.test(label)) return `5.6-${tier}`;
    if (tier && /^(?:Sol|Terra|Luna)$/i.test(label)) return `5.6-${tier}`;
    if (/^6\s*(?:Astra|Pro)$/i.test(label)) return '6-astra';
    const bare = label.match(/^(\d+(?:\.\d+)?)$/);
    if (bare?.[1] === '6') return '6';
    if (bare?.[1] === '5.6') return '5.6-sol';
    return bare?.[1] === '5.5' ? '5.5' : null;
  }
  function modelMenuSnapshot() {
    return visibleAll('[role="menuitem"], [role="menuitemradio"]')
      .map(el => {
        const text = nodeText(el);
        return {
          text,
          modelKey: modelKeyFromText(text),
          role: el.getAttribute('role'),
          checked: el.getAttribute('aria-checked'),
          expanded: el.getAttribute('aria-expanded'),
          hasPopup: el.getAttribute('aria-haspopup'),
        };
      })
      .filter(x => x.text || x.role);
  }
  // Сабменю-триггер модели: обычно role=menuitem. Номер может быть ещё не
  // известен нашему реестру (например, GPT-5.6 Sol), потому что это всего лишь
  // текущая sticky-модель, из которой нужно перейти к запрошенной.
  function findModelSubTrigger() {
    const candidates = visibleAll('[role="menuitem"], button[aria-haspopup="menu"]')
      .filter(el => !!modelKeyFromText(nodeText(el)));
    return candidates.find(el => el.getAttribute('aria-haspopup') === 'menu' || el.hasAttribute('aria-expanded'))
      || candidates[0]
      || null;
  }
  // Пункт модели в раскрытом сабменю — radio. Подпись бывает короткой («5.5»)
  // или полной («GPT-5.5»), поэтому сравниваем разобранный ключ.
  function findModelItem(modelKey, mode = currentChatgptMode()) {
    const rows = visibleAll('[role="menuitemradio"]');
    return rows.find(el => modelKeyFromText(nodeText(el)) === modelKey)
      || (mode === 'chat' && modelKey === '6-astra'
        ? rows.find(el => modelKeyFromText(nodeText(el)) === '6') : null)
      // Chat's Latest exposes Astra only at Pro. This is a candidate row,
      // not final model proof: verifyChatgptSelection checks both axes.
      || (mode === 'chat' && ['6', '6-astra'].includes(modelKey)
        ? rows.find(el => modelKeyFromText(nodeText(el)) === 'latest') : null);
  }
  function modelSelectionMatches(mode, requested, shown, effort = null) {
    if (shown === requested) return true;
    // The new Chat row is a family, not Astra identity at every power level.
    // Accept the legacy Astra request only with Pro in the final pair guard.
    return mode === 'chat' && ((requested === '6-astra' && shown === '6')
      || (requested === '6' && shown === '6-astra')) && (effort == null || effort === 'pro');
  }
  function findModelViewToggle() {
    return visibleAll('[role="menuitem"][aria-label]')
      .find(el => /(?:Выбрать модель|Select model)/i.test(el.getAttribute('aria-label') || '')) || null;
  }
  function currentModelKeyFromOpenMenu(mode = currentChatgptMode()) {
    const selectedRows = visibleAll('[role="menuitemradio"][aria-checked="true"]');
    // Selection state can legitimately live in the inert model-list view.
    // Read that state only within the currently open menu, while clicks
    // still use visibleAll and never target an inactive view.
    for (const menu of visibleAll('[role="menu"]')) {
      selectedRows.push(...Array.from(menu.querySelectorAll?.(
        '[role="menuitemradio"][aria-checked="true"][data-model-selected="true"]'
      ) || []));
    }
    const selectedKeys = new Set(selectedRows
      .filter(el => el.getAttribute('role') === 'menuitemradio' && el.getAttribute('aria-checked') === 'true')
      .map(el => modelKeyFromText(nodeText(el)))
      .filter(Boolean));
    if (selectedKeys.size > 1) return null;
    const checked = [...selectedKeys][0];
    if (checked) {
      if (checked === 'latest' && mode === 'chat'
          && currentEffortKeyFromSlider(findEffortSlider(), 'chat') === 'pro'
          && modelKeyFromText(nodeText(findModelViewToggle())) === '6-astra') return '6-astra';
      return checked;
    }
    const explicit = visibleAll('[role="menuitem"][aria-haspopup="menu"]')
      .find(el => /^(?:Модель|Model)/i.test(nodeText(el)));
    const explicitKey = explicit ? modelKeyFromText(nodeText(explicit)) : null;
    if (explicitKey) return explicitKey;
    const currentView = modelKeyFromText(nodeText(findModelViewToggle()));
    if (currentView) return currentView;
    const trigger = findEffortTrigger();
    const label = trigger?.querySelector?.('[class*="ModelPickerTriggerLabel-"]');
    return modelKeyFromText(nodeText(label || trigger));
  }
  function chatgptSelectionError(mode, modelKey, effortKey) {
    if (mode === 'chat') {
      if (modelKey === '6-astra') {
        return effortKey === 'pro'
          ? null
          : 'chatgpt_selection_unsupported: GPT-6 Astra в Chat доступна только как Pro';
      }
      if (modelKey === '5.5') {
        return effortKey === 'instant'
          ? null
          : 'chatgpt_selection_unsupported: GPT-5.5 в Chat доступна только как Instant';
      }
      if (modelKey === '6' || modelKey === '5.6-sol') {
        return CHAT_EFFORT_SLIDER_KEYS.includes(effortKey)
          ? null
          : `chatgpt_selection_unsupported: ${modelDisplay(modelKey)} не поддерживает effort=${effortKey} в Chat`;
      }
      return `chatgpt_selection_unsupported: модель ${modelDisplay(modelKey)} недоступна в Chat`;
    }
    const supportedEfforts = workEffortKeys(modelKey);
    if (!supportedEfforts) {
      return `chatgpt_selection_unsupported: модель ${modelDisplay(modelKey)} не проверена для Work`;
    }
    return supportedEfforts.includes(effortKey)
      ? null
      : `chatgpt_selection_unsupported: ${modelDisplay(modelKey)} не поддерживает effort=${effortKey} в Work`;
  }
  async function openModelSubmenu(modelKey, mode = currentChatgptMode()) {
    const viewToggle = findModelViewToggle();
    if (viewToggle && viewToggle.getAttribute('aria-expanded') !== 'true') {
      const clicked = await trustedClick(viewToggle);
      if (!clicked?.ok) throw new Error('trusted model-view click failed: ' + (clicked?.err || 'unknown'));
      await sleep(450);
    }
    const direct = findModelItem(modelKey, mode);
    if (direct) return { sub: null, item: direct };
    const sub = await waitFor(() => findModelSubTrigger(), 'model submenu trigger (GPT / o-series)', 8000);
    nativeHover(sub);
    await sleep(700);
    if (!findModelItem(modelKey, mode)) {
      nativeMouseClick(sub);
      await sleep(700);
    }
    const item = await waitFor(() => findModelItem(modelKey, mode), 'model item: ' + modelKey, 8000);
    return { sub, item };
  }

  // Выбор модели — verify-and-retry, та же механика что ensureEffortSelected.
  // Вызывающий flow делает провал фатальным: нельзя молча отправить запрос
  // sticky-моделью, отличающейся от запрошенной.
  async function ensureModelSelected(modelKey, mode = currentChatgptMode()) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await openEffortMenu();
        const current = currentModelKeyFromOpenMenu(mode);
        if (modelSelectionMatches(mode, modelKey, current)) {
          log('model.already_set', { model: modelKey, shown: current });
          bridgeLog('gpt.model.already_set', { model: modelKey }, getRequestId(), null);
          pressEscape(); await sleep(200);
          return true;
        }
        const { sub, item } = await openModelSubmenu(modelKey, mode);
        if (item.getAttribute('aria-checked') === 'true') {
          log('model.already_set', { model: modelKey, shown: modelKeyFromText(nodeText(sub)) });
          bridgeLog('gpt.model.already_set', { model: modelKey }, getRequestId(), null);
          pressEscape(); await sleep(200);
          return true;
        }
        const clicked = await trustedClick(item);
        if (!clicked?.ok) throw new Error('trusted model click failed: ' + (clicked?.err || 'unknown'));
        await sleep(600);
        // Verify через переоткрытие: подпись родителя и checked у visible radio
        // должны указывать на запрошенную модель. Закрытые меню ChatGPT оставляет
        // в DOM, поэтому читаем только visibleAll.
        await openEffortMenu();
        const shown = currentModelKeyFromOpenMenu(mode);
        let checkedItem = findModelItem(modelKey, mode);
        if (!checkedItem && !modelSelectionMatches(mode, modelKey, shown)) {
          try { ({ item: checkedItem } = await openModelSubmenu(modelKey, mode)); } catch (_) {}
        }
        const latestCandidate = mode === 'chat' && ['6', '6-astra'].includes(modelKey) && shown === 'latest';
        const matches = modelSelectionMatches(mode, modelKey, shown);
        const checked = (matches || latestCandidate)
          && (!checkedItem || checkedItem.getAttribute('aria-checked') === 'true');
        const ok = (matches || latestCandidate) && checked;
        const items = ok ? null : modelMenuSnapshot();
        pressEscape(); await sleep(200);
        if (ok) {
          log('model.selected', { model: modelKey, attempt });
          bridgeLog('gpt.model.selected', { model: modelKey, attempt }, getRequestId(), null);
          return true;
        }
        const data = { model: modelKey, attempt, shown, checked, items };
        log('model.verify_failed', data);
        bridgeLog('gpt.model.verify_failed', data, getRequestId(), null);
      } catch (e) {
        const data = { attempt, err: e?.message, items: modelMenuSnapshot() };
        log('model.attempt_threw', data);
        bridgeLog('gpt.model.attempt_threw', data, getRequestId(), null);
        pressEscape(); await sleep(200);
      }
    }
    const data = { model: modelKey, items: modelMenuSnapshot() };
    log('model.select_failed', data);
    bridgeLog('gpt.model.select_failed', data, getRequestId(), null);
    return false;
  }

  async function openEffortMenu() {
    const trigger = await waitFor(() => findEffortTrigger(), 'effort trigger (composer pill)', 15000);
    if (trigger.getAttribute('aria-expanded') !== 'true') {
      nativeMouseClick(trigger);
      await sleep(350);
      if (trigger.getAttribute('aria-expanded') !== 'true') {
        const clicked = await trustedClick(trigger);
        if (!clicked?.ok) throw new Error('trusted effort-picker click failed: ' + (clicked?.err || 'unknown'));
        await sleep(500);
      }
    }
    return trigger;
  }
  async function openEffortControlsMenu() {
    const trigger = await openEffortMenu();
    const openPicker = () => visibleAll('[data-model-picker-view]')
      .find(el => isVisible(el.closest('[role="menu"]')));
    const picker = openPicker();
    if (picker?.getAttribute('data-model-picker-view') === 'advanced') {
      // Selecting even the already checked model returns this two-view picker
      // to its slider. Escape/reopen alone can keep the model list active.
      // Never read/click the inert slider or choose a different model to exit.
      const selected = Array.from(picker.querySelectorAll(
        '[role="menuitemradio"][aria-checked="true"][data-model-selected="true"]'
      )).filter(isVisible);
      if (selected.length !== 1) throw new Error('ambiguous selected model in advanced picker');
      const selectedText = nodeText(selected[0]);
      const clicked = await trustedClick(selected[0]);
      if (!clicked?.ok) throw new Error('trusted effort-view return failed: ' + (clicked?.err || 'unknown'));
      await waitFor(() => openPicker()?.getAttribute('data-model-picker-view') === 'simple',
        'effort slider view after selected model', 4000);
      const data = { from: 'advanced', to: 'simple', selected: selectedText, revision: PICKER_REVISION };
      log('effort.view_return', data);
      bridgeLog('gpt.effort.view_return', data, getRequestId() || getComposeId(), null);
    }
    return trigger;
  }
  async function openEffortItemsMenu(eff) {
    await openEffortControlsMenu();
    const direct = findEffortItem(eff);
    if (direct) return direct;

    const sub = await waitFor(() => findEffortSubTrigger(), 'effort submenu trigger (Усилие / Effort)', 8000);
    nativeHover(sub);
    await sleep(500);
    if (!findEffortItem(eff)) {
      nativeMouseClick(sub);
      await sleep(700);
    }
    return await waitFor(() => findEffortItem(eff), 'effort item: ' + eff.key, 8000);
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
    // GPT-5.6 Chat имеет единый Pro без подуровней. Поддержка старого
    // pro-extended остаётся только для восстановления уже созданных jobs.
    if (!findProSubTrigger()) {
      const top = findProMainItem();
      return {
        ok: eff.key === 'pro' && !!top && top.getAttribute('aria-checked') === 'true',
        changed: false,
      };
    }
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
  // живой probe: после клика Instant pill ещё показывал «Pro»). Вызывающий
  // flow обязан считать false фатальным: sticky-уровень аккаунта может не
  // совпадать с явно выбранным юзером.
  async function ensureEffortSelected(effortKey, mode = currentChatgptMode(), modelKey = null) {
    const eff = EFFORTS.find(e => e.key === effortKey);
    if (!eff) { log('effort.unknown', { effortKey }); return false; }
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await openEffortControlsMenu();
        if (currentEffortKeyFromOpenMenu(mode, modelKey) === eff.key) {
          log('effort.already_set', { effort: eff.key });
          bridgeLog('gpt.effort.already_set', { effort: eff.key }, getRequestId() || getComposeId(), null);
          pressEscape(); await sleep(200);
          return true;
        }
        const slider = findEffortSlider();
        if (slider) {
          const targetValue = effortSliderValueForKey(
            eff.key,
            slider.getAttribute('aria-valuemin'),
            slider.getAttribute('aria-valuemax'),
            mode,
            modelKey,
          );
          if (targetValue == null) {
            throw new Error(`effort ${eff.key} is unavailable on slider ${slider.getAttribute('aria-valuemin')}..${slider.getAttribute('aria-valuemax')}`);
          }
          await selectEffortSliderValue(slider, targetValue);
          await openEffortControlsMenu();
          const afterSlider = findEffortSlider();
          const applied = currentEffortKeyFromSlider(afterSlider, mode, modelKey);
          const sliderItems = applied === eff.key ? null : effortMenuSnapshot();
          pressEscape(); await sleep(200);
          if (applied === eff.key) {
            log('effort.slider.selected', { effort: eff.key, value: targetValue, attempt });
            bridgeLog('gpt.effort.slider.selected', { effort: eff.key, value: targetValue, attempt }, getRequestId() || getComposeId(), null);
            return true;
          }
          const data = { effort: eff.key, targetValue, applied, attempt, items: sliderItems };
          log('effort.slider.verify_failed', data);
          bridgeLog('gpt.effort.slider.verify_failed', data, getRequestId() || getComposeId(), null);
          continue;
        }
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
        const item = await openEffortItemsMenu(eff);
        if (item.getAttribute('aria-checked') === 'true') {
          log('effort.already_set', { effort: eff.key });
          bridgeLog('gpt.effort.already_set', { effort: eff.key }, getRequestId(), null);
          pressEscape(); await sleep(200);
          return true;
        }
        nativeMouseClick(item);
        await sleep(600);
        // verify: меню после select закрыто — переоткрываем и читаем checked.
        const after = await openEffortItemsMenu(eff);
        const ok = after && after.getAttribute('aria-checked') === 'true';
        pressEscape(); await sleep(200);
        if (ok) {
          log('effort.selected', { effort: eff.key, attempt });
          bridgeLog('gpt.effort.selected', { effort: eff.key, attempt }, getRequestId(), null);
          return true;
        }
        const data = { effort: eff.key, attempt, items: effortMenuSnapshot() };
        log('effort.verify_failed', data);
        bridgeLog('gpt.effort.verify_failed', data, getRequestId(), null);
      } catch (e) {
        const data = { effort: eff.key, attempt, err: e?.message, items: effortMenuSnapshot() };
        log('effort.attempt_threw', data);
        bridgeLog('gpt.effort.attempt_threw', data, getRequestId(), null);
        pressEscape(); await sleep(200);
      }
    }
    log('effort.select_failed', { effort: eff.key });
    // В bridge — вкладка умирает на auto-close, DOM-лог недоступен post-mortem.
    bridgeLog('gpt.effort.select_failed', { effort: eff.key }, getRequestId(), null);
    return false;
  }

  async function verifyChatgptSelection(mode, modelKey, effortKey) {
    try {
      const unsupported = chatgptSelectionError(mode, modelKey, effortKey);
      if (unsupported) throw new Error(unsupported);
      await openEffortControlsMenu();
      await waitFor(() => modelSelectionMatches(mode, modelKey, currentModelKeyFromOpenMenu(mode), effortKey)
        && currentEffortKeyFromOpenMenu(mode, modelKey) === effortKey,
      'exact ChatGPT model and effort selection', 8000, 150);
      const data = { mode, model: modelKey, effort: effortKey,
        shownModel: currentModelKeyFromOpenMenu(mode), revision: PICKER_REVISION };
      log('selection.verified', data);
      bridgeLog('gpt.selection.verified', data, getRequestId() || getComposeId(), null);
      return true;
    } catch (error) {
      const data = { mode, model: modelKey, effort: effortKey,
        shownModel: currentModelKeyFromOpenMenu(mode),
        shownEffort: currentEffortKeyFromOpenMenu(mode, modelKey),
        err: error?.message || String(error) };
      log('selection.verify_failed', data);
      bridgeLog('gpt.selection.verify_failed', data, getRequestId() || getComposeId(), null);
      return false;
    } finally {
      pressEscape();
    }
  }

  const SPEEDS = [
    { key: 'standard', match: /^(?:Стандартный|Standard)(?:\s|$)/i, aliases: ['standard', 'default', 'стандартный'] },
    { key: 'fast', match: /^(?:Быстро|Fast)(?:\s|$)/i, aliases: ['fast', 'быстро'] },
  ];
  function resolveSpeed(value) {
    const q = String(value || 'standard').trim().toLowerCase();
    return SPEEDS.find(speed => speed.key === q || speed.aliases.includes(q))?.key || 'standard';
  }
  function speedLabel(key) {
    return key === 'fast' ? 'Быстро' : 'Стандартный';
  }
  function findFastModeToggle() {
    return visibleAll('[role="menuitemcheckbox"]')
      .find(el => {
        const label = el.getAttribute('aria-label') || '';
        return /(?:быстр|fast|стандарт|standard)/i.test(label)
          || !!el.querySelector?.('[data-testid="composer-model-picker-fast-service-tier-icon"]');
      }) || null;
  }
  function speedKeyFromFastModeToggle(toggle) {
    if (!toggle) return null;
    const label = toggle.getAttribute('aria-label') || '';
    // aria-label describes the ACTION, not the current state.
    if (/(?:Включить стандартный|Switch to standard|Use standard)/i.test(label)) return 'fast';
    if (/(?:Включить быстрый|Switch to fast|Use fast)/i.test(label)) return 'standard';
    if (toggle.querySelector?.('[data-testid="composer-model-picker-fast-service-tier-icon"]')) return 'fast';
    return toggle.getAttribute('aria-checked') === 'true' ? 'fast' : 'standard';
  }
  function findSpeedSubTrigger() {
    return visibleAll('[role="menuitem"][aria-haspopup="menu"]')
      .find(el => /^(?:Скорость|Speed)/i.test(nodeText(el))) || null;
  }
  function findSpeedItem(speed) {
    return visibleAll('[role="menuitemradio"]')
      .find(el => speed.match.test(nodeText(el)));
  }
  async function openSpeedItem(speed) {
    await openEffortMenu();
    const sub = await waitFor(() => findSpeedSubTrigger(), 'speed submenu trigger (Скорость / Speed)', 8000);
    nativeHover(sub);
    await sleep(500);
    if (!findSpeedItem(speed)) {
      nativeMouseClick(sub);
      await sleep(700);
    }
    return await waitFor(() => findSpeedItem(speed), 'speed item: ' + speed.key, 8000);
  }
  async function ensureSpeedSelected(speedKey) {
    const speed = SPEEDS.find(item => item.key === resolveSpeed(speedKey));
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await openEffortMenu();
        const fastToggle = findFastModeToggle();
        if (fastToggle) {
          const current = speedKeyFromFastModeToggle(fastToggle);
          if (current === speed.key) {
            log('speed.already_set', { speed: speed.key, picker: 'integrated' });
            bridgeLog('gpt.speed.already_set', { speed: speed.key, picker: 'integrated' }, getRequestId() || getComposeId(), null);
            pressEscape(); await sleep(200);
            return true;
          }
          const clicked = await trustedClick(fastToggle);
          if (!clicked?.ok) throw new Error('trusted speed toggle click failed: ' + (clicked?.err || 'unknown'));
          await sleep(600);
          await openEffortMenu();
          const afterToggle = findFastModeToggle();
          const applied = speedKeyFromFastModeToggle(afterToggle);
          const speedItems = applied === speed.key ? null : effortMenuSnapshot();
          pressEscape(); await sleep(200);
          if (applied === speed.key) {
            log('speed.selected', { speed: speed.key, attempt, picker: 'integrated' });
            bridgeLog('gpt.speed.selected', { speed: speed.key, attempt, picker: 'integrated' }, getRequestId() || getComposeId(), null);
            return true;
          }
          const data = { speed: speed.key, attempt, applied, items: speedItems };
          log('speed.verify_failed', data);
          bridgeLog('gpt.speed.verify_failed', data, getRequestId() || getComposeId(), null);
          continue;
        }
        const item = await openSpeedItem(speed);
        if (item.getAttribute('aria-checked') === 'true') {
          log('speed.already_set', { speed: speed.key });
          bridgeLog('gpt.speed.already_set', { speed: speed.key }, getRequestId() || getComposeId(), null);
          pressEscape(); await sleep(200);
          return true;
        }
        nativeMouseClick(item);
        await sleep(600);
        const after = await openSpeedItem(speed);
        const ok = after.getAttribute('aria-checked') === 'true';
        pressEscape(); await sleep(200);
        if (ok) {
          log('speed.selected', { speed: speed.key, attempt });
          bridgeLog('gpt.speed.selected', { speed: speed.key, attempt }, getRequestId() || getComposeId(), null);
          return true;
        }
      } catch (e) {
        const data = { speed: speed.key, attempt, err: e?.message, items: effortMenuSnapshot() };
        log('speed.attempt_threw', data);
        bridgeLog('gpt.speed.attempt_threw', data, getRequestId() || getComposeId(), null);
        pressEscape(); await sleep(200);
      }
    }
    bridgeLog('gpt.speed.select_failed', { speed: speed.key }, getRequestId() || getComposeId(), null);
    return false;
  }

  // ── Paste + submit ──────────────────────────────────────────────────
  function pasteIntoComposer(text, { append = false } = {}) {
    const ed = findComposer();
    if (!ed) throw new Error('no composer');
    ed.focus();
    if (append) {
      try {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(ed);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      } catch (_) {}
    }
    // ProseMirror принимает синтетический ClipboardEvent с DataTransfer —
    // тот же путь что Lexical у Perplexity (execCommand из isolated world
    // ProseMirror тоже игнорирует).
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    ed.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
  }

  function inlineControlText(el) {
    return compactText([
      nodeText(el),
      el?.getAttribute?.('aria-label'),
      el?.getAttribute?.('title'),
      el?.getAttribute?.('data-testid'),
    ].filter(Boolean).join(' '));
  }

  function isShowInTextFieldLabel(value) {
    const text = compactText(value);
    return /(?:показать|вставить|перенести).{0,32}(?:в текстовом поле|в поле ввода|как текст)/i.test(text)
      || /(?:show|insert|move).{0,32}(?:in (?:the )?text field|in (?:the )?composer|as text|into (?:the )?input|into (?:the )?textarea)/i.test(text);
  }

  function findShowInTextFieldControl() {
    return visibleAll('button, [role="button"], [role="menuitem"], [role="option"]')
      .find(el => isShowInTextFieldLabel(inlineControlText(el))) || null;
  }

  function isPastedTextChipLabel(value) {
    return /(?:pasted text|вставленн(?:ый|ого|ому|ым)? текст|вставка текста)/i.test(compactText(value));
  }

  function isPastedTextTooLongLabel(value) {
    const text = compactText(value);
    return /(?:превышает длину|слишком длин).{0,100}(?:текстов[а-яё]*\s+пол|пол[а-яё]*\s+ввода)/i.test(text)
      || /(?:exceeds? (?:the )?(?:length|character)(?: limit)?|too long).{0,100}(?:text field|composer|input)/i.test(text);
  }

  function findPastedTextChip() {
    const root = composerRoot();
    const candidates = Array.from(root?.querySelectorAll([
      '[data-testid*="attachment"]',
      '[data-testid*="file"]',
      '[class*="attachment"]',
      'button',
      '[role="button"]',
    ].join(',')) || []).filter(isVisible);
    return candidates.find(el => isPastedTextChipLabel(inlineControlText(el))) || null;
  }

  function inlineControlsSnapshot() {
    const nodes = visibleAll('button, [role="button"], [role="menuitem"], [role="option"]');
    const labels = nodes
      .map(el => inlineControlText(el))
      .filter(text => text && text.length <= 100)
      .filter(text => /(?:text|текст|field|input|поле|show|insert|move|показ|встав|перенес|pasted)/i.test(text))
      .slice(0, 12);
    return { interactiveCount: nodes.length, labels };
  }

  function composerContainsInlineText(expectedText) {
    const ed = findComposer();
    if (!ed) return false;
    const expected = compactText(expectedText);
    const actual = compactText(ed.innerText || ed.textContent);
    if (!expected || !actual) return false;
    if (expected.length <= 320) return actual.includes(expected);
    const start = expected.slice(0, 180);
    const end = expected.slice(-180);
    return actual.includes(start)
      && actual.includes(end)
      && actual.length >= Math.min(1200, Math.floor(expected.length * 0.6));
  }

  async function showPastedTextInComposer(id, inlineText, promptText = '', timeoutMs = 45000) {
    const t0 = performance.now();
    let showClicked = false;
    let hoverAttempted = false;
    let hoverOk = false;
    let chipOpened = false;
    let attachmentReadySince = 0;
    let lastState = '';

    while (performance.now() - t0 < timeoutMs) {
      const chip = findPastedTextChip();
      if (composerContainsInlineText(inlineText) && !chip) {
        const result = {
          method: showClicked ? 'show_in_text_field' : 'direct_paste',
          waitedMs: Math.round(performance.now() - t0),
          chars: inlineText.length,
        };
        log('compose.inline_ready', result);
        bridgeLog('gpt.compose.inline_ready', result, id, null);
        return result;
      }

      const chipLabel = chip ? inlineControlText(chip) : '';
      if (chip && isPastedTextTooLongLabel(chipLabel)) {
        if (promptText && !composerContainsInlineText(promptText)) {
          throw new Error('chatgpt_pasted_text_prompt_missing_before_submit');
        }
        const result = {
          method: 'pasted_text_attachment',
          waitedMs: Math.round(performance.now() - t0),
          chars: inlineText.length,
          reason: 'too_long_for_text_field',
        };
        log('compose.pasted_text_attachment_ready', result);
        bridgeLog('gpt.compose.pasted_text_attachment_ready', result, id, null);
        return result;
      }

      const showControl = findShowInTextFieldControl();
      // Current ChatGPT can keep a long paste as a complete document without
      // showing either the old "too long" label or a show-inline action. The
      // document is an existing supported fallback, but accept it only after
      // hover/open was attempted and the composer is stably ready to send.
      if (chip && chipOpened && !showControl
          && (!promptText || composerContainsInlineText(promptText))
          && composerBusySnapshot([promptText]).ready) {
        if (!attachmentReadySince) attachmentReadySince = performance.now();
        if (performance.now() - attachmentReadySince >= 3000) {
          const result = {
            method: 'pasted_text_attachment',
            waitedMs: Math.round(performance.now() - t0),
            chars: inlineText.length,
            reason: 'inline_control_unavailable_after_ready_chip',
          };
          log('compose.pasted_text_attachment_ready', result);
          bridgeLog('gpt.compose.pasted_text_attachment_ready', result, id, null);
          return result;
        }
      } else {
        attachmentReadySince = 0;
      }
      const state = `${showControl ? 1 : 0}|${chip ? 1 : 0}|${showClicked ? 1 : 0}|${hoverAttempted ? 1 : 0}|${hoverOk ? 1 : 0}|${chipOpened ? 1 : 0}`;
      if (state !== lastState) {
        lastState = state;
        const data = {
          waitedMs: Math.round(performance.now() - t0),
          showControl: !!showControl,
          pastedTextChip: !!chip,
          showClicked,
          hoverAttempted,
          hoverOk,
          chipOpened,
        };
        log('compose.inline_wait', data);
        bridgeLog('gpt.compose.inline_wait', data, id, null);
      }

      if (showControl && !showClicked) {
        showClicked = true;
        nativeMouseClick(showControl);
        log('compose.inline_show_clicked', { waitedMs: Math.round(performance.now() - t0) });
        bridgeLog('gpt.compose.inline_show_clicked', {
          waitedMs: Math.round(performance.now() - t0),
        }, id, null);
      } else if (chip && !hoverAttempted) {
        hoverAttempted = true;
        const hovered = await trustedHover(chip);
        hoverOk = hovered?.ok === true;
        if (!hoverOk) nativeHover(chip);
        const data = {
          waitedMs: Math.round(performance.now() - t0),
          ok: hoverOk,
          err: hovered?.err || null,
          controls: inlineControlsSnapshot(),
        };
        log('compose.inline_chip_hovered', data);
        bridgeLog('gpt.compose.inline_chip_hovered', data, id, null);
      } else if (chip) {
        if (!chipOpened && performance.now() - t0 > (hoverOk ? 4000 : 2500)) {
          chipOpened = true;
          nativeMouseClick(chip);
          const data = {
            waitedMs: Math.round(performance.now() - t0),
            controls: inlineControlsSnapshot(),
          };
          log('compose.inline_chip_opened', data);
          bridgeLog('gpt.compose.inline_chip_opened', {
            ...data,
          }, id, null);
        }
      }
      await sleep(250);
    }

    throw new Error('chatgpt_show_in_text_field_failed: control or inline text did not become ready');
  }

  function isDisabled(el) {
    if (!el) return true;
    return !!el.disabled
      || el.hasAttribute('disabled')
      || el.getAttribute('aria-disabled') === 'true'
      || !!el.closest('[aria-disabled="true"]');
  }

  function composerStatusText(root, editor, fileNames = []) {
    if (!root || root === editor) return '';
    // Read status UI, not user data. Cutting the form to 500 chars before
    // removing the prompt made filenames consume its prefix and left words
    // such as "loading error" masquerading as an upload status.
    const statusRoot = root.cloneNode(true);
    for (const field of statusRoot.querySelectorAll('[contenteditable], [role="textbox"], textarea, input')) field.remove();
    const filenameKey = value => compactText(value).replace(/\(\d+\)(?=\.[^.]+$)/, '');
    const names = new Set(fileNames.map(filenameKey).filter(Boolean));
    for (const label of statusRoot.querySelectorAll('*')) {
      if (label.children.length || label.closest('[role="status"], [role="progressbar"], [aria-live], [aria-busy="true"]')) continue;
      if (names.has(filenameKey(label.textContent))) label.remove();
    }
    return compactText(statusRoot.textContent);
  }

  function composerBusySnapshot(_ignoredTexts = [], fileNames = []) {
    const root = composerRoot();
    const ed = findComposer();
    const send = findSendBtn();
    const busySelectors = [
      '[role="progressbar"]',
      '[aria-busy="true"]',
      '[data-testid*="loading" i]',
      '[data-testid*="loader" i]',
      '[data-testid*="progress" i]',
      '[class*="animate-spin"]',
      '[class*="spinner"]',
      '[class*="loading"]',
      'svg[aria-label*="loading" i]',
      'svg[aria-label*="загруз" i]',
    ].join(',');
    const busyNodes = Array.from(root?.querySelectorAll(busySelectors) || []).filter(isVisible);
    const statusText = composerStatusText(root, ed, fileNames);
    const busyTextMatch = statusText.match(/(?:uploading|loading|processing|attaching|загруз|обработ|прикреп|подождите|please wait)/i);
    const busyText = !!busyTextMatch;
    const composerDisabled = isDisabled(ed)
      || ed?.getAttribute('contenteditable') === 'false'
      || ed?.getAttribute('aria-disabled') === 'true';
    const sendVisible = !!send && isVisible(send);
    const sendDisabled = !sendVisible || isDisabled(send);
    return {
      ready: sendVisible && !sendDisabled && !composerDisabled && busyNodes.length === 0 && !busyText,
      sendVisible,
      sendDisabled,
      composerDisabled,
      busyCount: busyNodes.length,
      busyText,
      busyTextToken: busyTextMatch?.[0]?.toLowerCase() || null,
      textHead: statusText.slice(0, 160),
    };
  }

  function waitComposerReadyAfterPaste(id, timeoutMs = 120000, ignoredTexts = [], fileNames = []) {
    const t0 = performance.now();
    return new Promise((resolve, reject) => {
      let done = false;
      let checkPending = false;
      let readyTimer = null;
      let lastSig = '';
      const observer = new MutationObserver(scheduleCheck);
      const poll = setInterval(checkNow, 500);
      const timer = setTimeout(() => {
        const snap = composerBusySnapshot(ignoredTexts, fileNames);
        finish(null, new Error('chatgpt_composer_not_ready_after_paste: ' + JSON.stringify({
          sendVisible: snap.sendVisible,
          sendDisabled: snap.sendDisabled,
          composerDisabled: snap.composerDisabled,
          busyCount: snap.busyCount,
          busyText: snap.busyText,
          busyTextToken: snap.busyTextToken,
          readinessRevision: COMPOSER_READINESS_REVISION,
        })));
      }, timeoutMs);

      function cleanup() {
        observer.disconnect();
        document.removeEventListener('input', scheduleCheck, true);
        document.removeEventListener('change', scheduleCheck, true);
        clearInterval(poll);
        clearTimeout(timer);
        if (readyTimer) clearTimeout(readyTimer);
      }
      function finish(value, error) {
        if (done) return;
        done = true;
        cleanup();
        if (error) reject(error);
        else resolve(value);
      }
      function emitWaitLog(snap) {
        const sig = [
          snap.sendVisible ? 1 : 0,
          snap.sendDisabled ? 1 : 0,
          snap.composerDisabled ? 1 : 0,
          snap.busyCount,
          snap.busyText ? 1 : 0,
        ].join('|');
        if (sig === lastSig) return;
        lastSig = sig;
        const data = {
          waitedMs: Math.round(performance.now() - t0),
          sendVisible: snap.sendVisible,
          sendDisabled: snap.sendDisabled,
          composerDisabled: snap.composerDisabled,
          busyCount: snap.busyCount,
          busyText: snap.busyText,
          busyTextToken: snap.busyTextToken,
          readinessRevision: COMPOSER_READINESS_REVISION,
        };
        log('composer.wait_after_paste', data);
        bridgeLog('gpt.composer.wait_after_paste', data, id, null);
      }
      function verifyReadyAfterQuiet() {
        if (readyTimer) return;
        // Это не guessed wait загрузки: готовность по-прежнему определяется
        // реальными маркерами. Короткое quiet-окно лишь не даёт нажать Send
        // в промежутке между paste-event и первым React-коммитом loader'а.
        readyTimer = setTimeout(() => {
          readyTimer = null;
          const snap = composerBusySnapshot(ignoredTexts, fileNames);
          if (!snap.ready) {
            emitWaitLog(snap);
            return;
          }
          log('composer.ready_after_paste', { waitedMs: Math.round(performance.now() - t0) });
          bridgeLog('gpt.composer.ready_after_paste', { waitedMs: Math.round(performance.now() - t0) }, id, null);
          finish(snap);
        }, 250);
      }
      function checkNow() {
        if (done) return;
        const snap = composerBusySnapshot(ignoredTexts, fileNames);
        if (snap.ready) {
          verifyReadyAfterQuiet();
        } else {
          if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
          emitWaitLog(snap);
        }
      }
      function scheduleCheck() {
        if (done || checkPending) return;
        checkPending = true;
        queueMicrotask(() => {
          checkPending = false;
          checkNow();
        });
      }

      observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['disabled', 'aria-disabled', 'aria-busy', 'data-testid', 'class', 'contenteditable'],
      });
      document.addEventListener('input', scheduleCheck, true);
      document.addEventListener('change', scheduleCheck, true);
      // Initial readiness must not depend on requestAnimationFrame: Chromium
      // may report a healthy Send button while a hidden tab's rAF is frozen.
      checkNow();
    });
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
    const ed = findComposer();
    const form = ed?.closest('form');
    if (form) return form;
    // Some composer layouts have no form. Walk only its branch, stopping
    // before conversation history; body text is never attachment/upload proof.
    let root = ed;
    for (let parent = ed?.parentElement; parent && parent !== document.body
        && parent !== document.documentElement; parent = parent.parentElement) {
      if (parent.querySelector('[data-message-author-role], [data-testid^="conversation-turn-"]')) break;
      root = parent;
    }
    return root;
  }
  function findUploadInputFor(files) {
    const list = Array.isArray(files) ? files : [files];
    const onlyImages = list.length > 0 && list.every(file => String(file?.type || '').startsWith('image/'));
    if (onlyImages) {
      return document.querySelector('#upload-photos')
          || document.querySelector('[data-testid="upload-photos-input"]')
          || document.querySelector('input[type="file"][accept*="image"]')
          || document.querySelector('#upload-files');
    }
    const legacy = document.querySelector('#upload-files');
    if (legacy) return legacy;
    // Первый input в новом UI принимает только photo/video. Текстовые документы
    // должны попасть в общий file input без accept-фильтра, а не в media picker.
    const inputs = Array.from(composerRoot()?.querySelectorAll('input[type="file"]') || [])
      .filter(input => !String(input.getAttribute('accept') || '').trim());
    return inputs.length === 1 ? inputs[0] : null;
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

  function composeDocumentFile(composeDocument) {
    return new File([composeDocument.text], composeDocument.name, {
      type: composeDocument.mime,
    });
  }

  function composerFilePreviewState(files) {
    const root = composerRoot();
    const ed = findComposer();
    const outsideEditor = el => el !== ed && !ed?.contains(el) && !el.contains(ed)
      && !el.matches('input');
    const previewSelector = [
      '[data-testid*="attachment"]:not(input)',
      '[data-testid*="file"]:not(input)',
      '[aria-label*="Удалить"]',
      '[aria-label*="Remove"]',
      '[aria-label*="preview" i]',
    ].join(',');
    const candidates = Array.from(root?.querySelectorAll(previewSelector) || []).filter(outsideEditor);
    const removeNodes = candidates.filter(el => /удалить|remove/i.test(el.getAttribute('aria-label') || ''));
    const removers = removeNodes.filter(el => !removeNodes.some(other => other !== el && other.contains(el)));
    // A card, its remove button and its image are one preview, not three files.
    const cards = candidates.filter(el => !candidates.some(other => other !== el && other.contains(el)));
    const labels = Array.from(root?.querySelectorAll('*') || []).filter(outsideEditor);
    const nameCounts = Object.create(null);
    for (const name of new Set(files.map(file => file.name))) {
      const matches = labels.filter(el => [el.textContent, el.getAttribute('title'), el.getAttribute('alt')]
        .some(text => text?.trim() === name));
      nameCounts[name] = matches.filter(el => !matches.some(child => child !== el && el.contains(child))).length;
    }
    return {
      nameCounts,
      cards,
      removers,
      imageKeys: Array.from(root?.querySelectorAll('img') || []).filter(outsideEditor)
        .map(img => img.currentSrc || img.src).filter(Boolean),
    };
  }

  function composerHasFilePreview(files, baseline, accepted = null) {
    const current = composerFilePreviewState(files);
    const required = new Map();
    for (const file of files) required.set(file.name, (required.get(file.name) || 0) + 1);
    const allNamesAdded = [...required].every(([name, count]) =>
      (current.nameCounts[name] || 0) - (baseline?.nameCounts[name] || 0) >= count);
    const allCardsAdded = ['cards', 'removers'].some(kind => accepted
      ? accepted[kind].filter(card => !baseline?.[kind]?.includes(card) && current[kind].includes(card)).length >= files.length
      : current[kind].length - (baseline?.[kind]?.length || 0) >= files.length);
    const oldImages = new Set(baseline?.imageKeys || []);
    const allImagesAdded = files.every(file => String(file.type || '').startsWith('image/'))
      && current.imageKeys.filter(key => !oldImages.has(key) && (!accepted || accepted.imageKeys.includes(key))).length >= files.length;
    return files.length > 0 && (allNamesAdded || allCardsAdded || allImagesAdded);
  }

  function uploadPreviewDiagnostic(files, baseline, input) {
    const state = composerFilePreviewState(files);
    return {
      revision: UPLOAD_REVISION,
      documentTimeOrigin: performance.timeOrigin,
      inputId: input?.id || null,
      inputConnected: input?.isConnected !== false,
      inputIsCurrent: findUploadInputFor(files) === input,
      inputDisabled: !!input?.disabled || input?.getAttribute('aria-disabled') === 'true',
      inputFileCount: input?.files?.length ?? null,
      pickerExpanded: findEffortTrigger()?.getAttribute('aria-expanded') || null,
      nameCounts: state.nameCounts,
      baselineNameCounts: baseline?.nameCounts || {},
      cards: state.cards.length,
      baselineCards: baseline?.cards?.length || 0,
      removers: state.removers.length,
      baselineRemovers: baseline?.removers?.length || 0,
      images: state.imageKeys.length,
    };
  }

  function waitUploadPreview(id, files, baseline, input, eventPrefix, timeoutMs = 60000) {
    const t0 = performance.now();
    return new Promise(resolve => {
      let done = false, checkPending = false, lastSignature = '';
      const observer = new MutationObserver(() => scheduleCheck('mutation'));
      const fallback = setInterval(() => checkNow('fallback'), 500);
      const deadline = setTimeout(() => finish(false, 'deadline'), timeoutMs);
      function finish(ok, observedBy) {
        if (done) return;
        done = true;
        observer.disconnect();
        clearInterval(fallback);
        clearTimeout(deadline);
        resolve({ ok, observedBy, waitedMs: Math.round(performance.now() - t0),
          ...uploadPreviewDiagnostic(files, baseline, input) });
      }
      function checkNow(observedBy) {
        if (done) return;
        if (composerHasFilePreview(files, baseline)) { finish(true, observedBy); return; }
        const snapshot = uploadPreviewDiagnostic(files, baseline, input);
        const signature = JSON.stringify(snapshot);
        if (signature !== lastSignature) {
          lastSignature = signature;
          const data = { ...snapshot, observedBy, waitedMs: Math.round(performance.now() - t0) };
          log(eventPrefix + '.preview_progress', data);
          bridgeLog('gpt.' + eventPrefix + '.preview_progress', data, id, null);
        }
      }
      function scheduleCheck(observedBy) {
        if (done || checkPending) return;
        checkPending = true;
        queueMicrotask(() => { checkPending = false; checkNow(observedBy); });
      }
      observer.observe(document.body || document.documentElement, {
        subtree: true, childList: true, characterData: true, attributes: true,
        attributeFilter: ['title', 'alt', 'aria-label', 'data-testid', 'class', 'hidden'],
      });
      checkNow('initial');
    });
  }

  async function uploadFiles(id, files, options = {}) {
    if (!files.length) return { files, hasPreview: () => true };
    if (files.length > 20) throw new Error('chatgpt_attachment_limit: maximum 20 files per message');
    const eventPrefix = options.eventPrefix || 'attachments';
    // Awaiting a receiver yields to React. Do not retain that node across the
    // await: reselect and take the preview baseline in the same dispatch frame.
    const inputDeadline = performance.now() + 15000;
    let input;
    do {
      const remaining = inputDeadline - performance.now();
      if (remaining <= 0) throw new Error('timeout: live upload file input');
      await waitFor(() => !!findUploadInputFor(files), 'upload file input', remaining, 250);
      input = findUploadInputFor(files);
    } while (!input || input.isConnected === false);
    const previewBaseline = composerFilePreviewState(files);
    const beforeDispatch = uploadPreviewDiagnostic(files, previewBaseline, input);
    const dt = new DataTransfer();
    for (const file of files) dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    log(eventPrefix + '.change_dispatched', { count: files.length, names: files.map(file => file.name) });
    bridgeLog('gpt.' + eventPrefix + '.change_dispatched', {
      count: files.length,
      names: files.map(file => file.name),
      bytes: files.map(file => file.size),
      mimeTypes: files.map(file => file.type),
      before: beforeDispatch,
      after: uploadPreviewDiagnostic(files, previewBaseline, input),
    }, id, null);

    const receipt = await waitUploadPreview(id, files, previewBaseline, input, eventPrefix);
    const { ok } = receipt;
    log(eventPrefix + '.preview_wait_done', { ...receipt, count: files.length });
    bridgeLog('gpt.' + eventPrefix + '.preview_wait_done', { ...receipt, count: files.length }, id, null);
    if (!ok && options.requirePreview) {
      throw new Error('chatgpt_attachment_preview_missing: ' + files.map(file => file.name).join(', '));
    }
    const acceptedPreview = composerFilePreviewState(files);
    return {
      files,
      hasPreview: () => composerHasFilePreview(files, previewBaseline, acceptedPreview),
    };
  }

  async function uploadAttachments(id, metas) {
    const list = Array.isArray(metas) ? metas : [];
    const files = [];
    for (const meta of list) files.push(await fetchAttachmentFile(id, meta));
    return await uploadFiles(id, files, { requirePreview: true });
  }

  async function clickSend(boundary = createTurnBoundary(), upload = null) {
    // Send-button рендерится только когда composer содержит текст или файл
    // (в idle вместо него кнопка голосового режима).
    const btn = await waitEnabledSendButton();
    if (upload && !upload.hasPreview()) {
      throw new Error('chatgpt_attachment_disappeared_before_submit: ' + upload.files.map(file => file.name).join(', '));
    }
    btn.click();
    if (await waitSubmitAccepted(boundary)) return;
    // Fallback: полный pointer-chain.
    const again = findSendBtn();
    if (again && (!upload || upload.hasPreview())) nativeMouseClick(again);
    if (await waitSubmitAccepted(boundary)) return;
    throw new Error('chatgpt_submit_failed: send click had no effect');
  }

  function waitEnabledSendButton(timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      let done = false;
      let checkPending = false;
      const observer = new MutationObserver(scheduleCheck);
      const poll = setInterval(checkNow, 500);
      const timer = setTimeout(() => finish(null, new Error('timeout: enabled send button (composer non-empty)')), timeoutMs);
      function cleanup() {
        observer.disconnect();
        clearInterval(poll);
        clearTimeout(timer);
      }
      function finish(value, error) {
        if (done) return;
        done = true;
        cleanup();
        if (error) reject(error);
        else resolve(value);
      }
      function checkNow() {
        if (done) return;
        const b = findSendBtn();
        if (b && isVisible(b) && !isDisabled(b) && !findStopBtn()) finish(b);
      }
      function scheduleCheck() {
        if (done || checkPending) return;
        checkPending = true;
        queueMicrotask(() => {
          checkPending = false;
          checkNow();
        });
      }
      observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['disabled', 'aria-disabled', 'data-testid', 'class'],
      });
      checkNow();
    });
  }

  function waitSubmitAccepted(boundary, timeoutMs = 120000) {
    return new Promise(resolve => {
      let done = false;
      let checkPending = false;
      const observer = new MutationObserver(scheduleCheck);
      const poll = setInterval(checkNow, 500);
      const timer = setTimeout(() => finish(false), timeoutMs);
      function cleanup() {
        observer.disconnect();
        clearInterval(poll);
        clearTimeout(timer);
      }
      function finish(value) {
        if (done) return;
        done = true;
        cleanup();
        resolve(value);
      }
      function checkNow() {
        if (done) return;
        // A fast reply may finish before Stop is observed. The new user turn
        // proves submission; an idle/disabled Send on its own does not.
        if (findStopBtn() || submittedUserElement(boundary)) finish(true);
      }
      function scheduleCheck() {
        if (done || checkPending) return;
        checkPending = true;
        queueMicrotask(() => {
          checkPending = false;
          checkNow();
        });
      }
      observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['disabled', 'aria-disabled', 'data-testid', 'class'],
      });
      checkNow();
    });
  }

  // ── Extract: принятый assistant-ответ текущего user-turn ─────────────
  function assistantTurn(el) {
    return el?.closest('[data-turn="assistant"], [data-testid^="conversation-turn-"], [data-content-search-turn-key]') || el;
  }
  function readAnswerText(el) {
    if (!el) return '';
    // У thinking-ответов (xhigh/pro) ДВА .markdown: сводка рассуждений
    // (.result-thinking.markdown) и финальный ответ. Thinking исключаем,
    // берём последний не-thinking (живой DOM: result-thinking идёт первым).
    const mds = Array.from(el.querySelectorAll('.markdown'))
      .filter(m => !m.classList.contains('result-thinking'));
    const md = mds[mds.length - 1];
    // Current ChatGPT renders the answer in a semantic MarkdownRoot without
    // the old .markdown class. Preserve paragraph breaks when layout is live;
    // textContent remains the hidden-tab fallback.
    if (!md) {
      const current = el.querySelector('[data-markdown-text-style="assistant-message"]');
      if (current) return (current.innerText || current.textContent || '').trim();
    }
    // textContent first — innerText в hidden tab пуст (Blink не делает layout
    // для скрытых вкладок, innerText построен на layout). Тот же шрам что в
    // aistudio-core.js::parseLastTurn. Без этого watcher.done никогда не
    // срабатывал в фоновой вкладке: hasAnswer всегда 0.
    return ((md || el).textContent || (md || el).innerText || '').trim();
  }
  function hasFinalAnswerAction(el) {
    if (!el) return false;
    const turn = assistantTurn(el);
    return !!turn.querySelector('[data-testid="copy-turn-action-button"], [aria-label*="Копировать ответ"], [aria-label*="Copy response" i], button[aria-label="Копировать"], button[aria-label="Copy"]');
  }
  // «Думал на протяжении 2m 20s» — кнопка-сводка thinking-блока над ответом.
  function readThinkingLine(el) {
    const m = (assistantTurn(el)?.textContent || '').match(/(?:Думал[а]? на протяжении|Thought for)\s+[^\n]{1,30}/g);
    return m ? m[m.length - 1].trim() : null;
  }
  function readThinkingText(el) {
    if (!el) return '';
    const mds = Array.from(el.querySelectorAll('.markdown.result-thinking, .result-thinking.markdown'));
    const md = mds[mds.length - 1];
    return ((md?.textContent || md?.innerText || '')).trim();
  }

  async function extractAnswerStable(getAssistant) {
    // Ответ стримится прогрессивно; ждём стабилизации длины (2 пробы × 800мс),
    // cap 30с — паттерн perplexity-research.js::extractAnswerText шаг 2.
    const STABLE_REPS = 2, PROBE_MS = 800, MAX_MS = 30000;
    const t0 = performance.now();
    let lastLen = -1, stable = 0, best = '';
    while (performance.now() - t0 < MAX_MS) {
      const txt = readAnswerText(getAssistant());
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

  function collectGeneratedImages(excludeKeys, boundary = null) {
    const exclude = new Set(Array.isArray(excludeKeys) ? excludeKeys : []);
    const out = [];
    const lastUserTurn = lastUserConversationTurn();
    const containers = Array.from(document.querySelectorAll('div[id^="image-"]'));
    for (const c of containers) {
      if (boundary && !belongsToSubmittedTurn(c, boundary)) continue;
      const turn = c.closest('[data-testid^="conversation-turn-"]');
      if (!boundary && lastUserTurn && turn && !(lastUserTurn.compareDocumentPosition(turn) & Node.DOCUMENT_POSITION_FOLLOWING)) {
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
  async function extractGeneratedImagesStable(excludeKeys, boundary) {
    const STABLE_REPS = 2, PROBE_MS = 800, MAX_MS = 30000;
    const t0 = performance.now();
    let stable = 0, lastSig = '', best = [];
    while (performance.now() - t0 < MAX_MS) {
      const cur = collectGeneratedImages(excludeKeys, boundary);
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

  function importProofLogData(proof) {
    return {
      ready: !!proof?.ready,
      reason: proof?.reason || null,
      proofKind: proof?.proof_kind || null,
      messageId: proof?.message_id || null,
      textLen: proof?.text?.length || 0,
      candidateMessageId: proof?.candidate_message_id || null,
      candidateChannel: proof?.candidate_channel ?? null,
      candidateEndTurn: proof?.candidate_end_turn ?? null,
      candidatePreamble: !!proof?.candidate_preamble,
      candidateStatus: proof?.candidate_status || null,
      tailMessageId: proof?.tail_message_id || null,
      tailRole: proof?.tail_role || null,
      tailContentType: proof?.tail_content_type || null,
    };
  }

  // Импорт по URL — это наблюдение уже существующего provider-turn, а не
  // облегчённый research-submit. Он обязан пройти тот же строгий API-final
  // proof, но никогда не открывает picker/composer и не вызывает Send.
  // Зависимости инжектируются только для offline-regression fixtures.
  async function runReadOnlyConversationImport(id, job, myTabId, deps = {}) {
    const options = job?.options || {};
    const snapshot = deps.snapshot || (() => latestApiTurnSnapshot(30000));
    const updateState = deps.updateState || postState;
    const writeTerminal = deps.writeTerminal || postTerminalState;
    const wait = deps.wait || sleep;
    const now = deps.now || (() => Date.now());
    const currentUrl = deps.currentUrl || (() => {
      const conversationId = chatgptConversationIdFromLocation();
      return conversationId
        ? `https://chatgpt.com/c/${encodeURIComponent(conversationId)}`
        : location.href;
    });
    const currentTitle = deps.currentTitle || (() => document.title);
    const getImages = deps.getImages || (() => collectGeneratedImages([], null));
    const stabilizeImages = deps.stabilizeImages || (() => extractGeneratedImagesStable([], null));
    const saveImages = deps.saveImages || (images => persistGeneratedImages(id, images));
    const waitForFinal = options.importWaitForFinal === true;
    const timeoutMs = Math.max(10000, Math.min(1800000,
      Number(options.importTimeoutMs) || 1800000));
    const startedAt = now();

    await updateState(id, {
      status: 'running', stage: 'importing', error: '',
      ...(typeof myTabId === 'number' ? { tabId: myTabId } : {}),
      url: currentUrl(), title: currentTitle(),
    });
    log('import.start', { waitForFinal, timeoutMs, tabId: myTabId });
    bridgeLog('gpt.import.start', { waitForFinal, timeoutMs }, id, myTabId);

    let proof = null;
    let lastProbeError = null;
    let waitingStatePosted = false;
    while (true) {
      try {
        proof = await snapshot();
        lastProbeError = null;
      } catch (error) {
        lastProbeError = error?.message || String(error);
        proof = { ready: false, reason: 'api_probe_failed' };
      }

      const proofData = importProofLogData(proof);
      log(proof?.ready ? 'import.api_final' : 'import.api_pending', proofData);
      bridgeLog(proof?.ready ? 'gpt.import.api_final' : 'gpt.import.api_pending', proofData, id, myTabId);
      if (proof?.ready) break;

      if (!waitForFinal) {
        if (lastProbeError) throw new Error(`chatgpt_import_read_failed: ${lastProbeError}`);
        throw new Error('chatgpt_import_final_pending: current user-turn has no final');
      }
      const elapsed = now() - startedAt;
      if (elapsed >= timeoutMs) {
        throw new Error('chatgpt_import_final_timeout: timed out waiting for the current user-turn final');
      }
      if (!waitingStatePosted) {
        waitingStatePosted = true;
        await updateState(id, {
          status: 'running', stage: 'import_waiting_final',
          url: currentUrl(), title: currentTitle(),
        });
      }
      await wait(Math.min(2000, timeoutMs - elapsed));
    }

    const answerText = String(proof.text || '');
    const initialImages = getImages() || [];
    const generatedImages = (initialImages.length || !answerText.trim())
      ? await stabilizeImages()
      : [];
    const persistedImages = generatedImages.length ? await saveImages(generatedImages) : [];
    const savedImageCount = persistedImages.filter(image => image?.file_path && !image?.error).length;
    if (!answerText.trim() && savedImageCount === 0) {
      throw new Error('chatgpt_import_empty_final: final has no extractable text or generated image');
    }

    const links = Array.isArray(proof.links) ? proof.links : [];
    const allActivityItems = Array.isArray(proof.activity_items) ? proof.activity_items : [];
    const includeActivity = options.importIncludeActivity === true;
    const activityItems = includeActivity ? allActivityItems : [];
    const reasoningText = String(proof.reasoning_text || '').trim();
    let outText = answerText;
    if (options.sources === true && links.length) {
      const block = links.map((link, index) => `${index + 1}. ${link.title || link.url} — ${link.url}`).join('\n');
      outText += `\n\n---\nИсточники (${links.length}):\n${block}`;
    }
    const isClarifying = outText.length > 0 && outText.length < 800 && /\?\s*$/.test(outText);
    const result = {
      url: currentUrl(),
      title: proof.title || currentTitle(),
      text: outText,
      answer_text: answerText,
      images: persistedImages,
      image_count: savedImageCount,
      reasoning_text: reasoningText || null,
      text_kind: savedImageCount ? 'image' : 'answer',
      is_image: savedImageCount > 0,
      is_research: links.length > 0,
      is_clarifying: isClarifying,
      sources: links,
      // API activity may contain complete file/tool payloads and can dwarf the
      // answer. URL import is answer-first: keep it only behind an explicit
      // forensic opt-in and store it once in sources_meta (not duplicated here).
      source_activity: [],
      sources_meta: {
        activity: null,
        activity_items: activityItems,
        activity_count: allActivityItems.length,
        activity_omitted: !includeActivity && allActivityItems.length > 0,
        thinking: reasoningText ? [reasoningText] : [],
        thinking_last: null,
        thinking_text: reasoningText || null,
        chip_present: false,
        panel_opened: false,
        source: 'api',
      },
      read_only_import: true,
      source_message_id: proof.message_id || null,
      final_proof_kind: proof.proof_kind || null,
    };
    const confirmed = await writeTerminal(id, {
      status: 'done', stage: 'done',
      url: result.url, title: result.title, result,
    });
    log('import.done', {
      confirmed, messageId: result.source_message_id,
      textLen: outText.length, images: savedImageCount, links: links.length,
      activity: allActivityItems.length, activityIncluded: includeActivity,
    });
    bridgeLog('gpt.import.done', {
      confirmed, messageId: result.source_message_id,
      textLen: outText.length, images: savedImageCount, links: links.length,
      activity: allActivityItems.length, activityIncluded: includeActivity,
    }, id, myTabId);
    return { confirmed, result, proof };
  }

  // ── Источники (правая панель «Детали рассуждения») ──────────────────
  // Чип «Источники» в action-bar последнего ответа → клик → справа панель:
  //   Активность · 2m 20s / «Думал на протяжении X» / Источники · N / ссылки
  //   + activity/tool steps (GitHub fetches, bash/python command snippets).
  // Парсим ВСЕГДА; в text включается только при options.sources (см. main).
  function findSourcesChip(el) {
    const turn = assistantTurn(el);
    return turn ? findSourcesChipInTurn(turn) : null;
  }
  function findSourcesPanel() {
    return Array.from(document.querySelectorAll('section[aria-label]'))
      .find(s => /рассужден|reasoning/i.test(s.getAttribute('aria-label') || '') && s.offsetParent);
  }
  async function extractSources(el) {
    const out = { links: [], activity_items: [], activity: null, thinking: [], chip_present: false, panel_opened: false };
    const chip = findSourcesChip(el);
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
    const seenActivity = new Set();
    const collect = () => {
      for (const a of panel.querySelectorAll('a[href]')) {
        const href = a.href || '';
        if (!/^https?:/i.test(href)) continue;
        let host = '';
        try { host = new URL(href).hostname.toLowerCase(); } catch (_) {}
        if (host === 'chatgpt.com' || host.endsWith('.chatgpt.com') || host === 'chat.openai.com') continue; // внутренняя навигация
        if (seen.has(href)) continue;
        seen.add(href);
        out.links.push({
          url: href,
          // textContent — innerText пуст в hidden tab (см. readAnswerText).
          title: (a.textContent || '').trim().replace(/\s*\n+\s*/g, ' — ').slice(0, 300),
        });
      }
      collectActivityItems(panel, out.activity_items, seenActivity);
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
    log('sources.scroll_done', { links: out.links.length, activity_items: out.activity_items.length });
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
    log('sources.extracted', { links: out.links.length, activity_items: out.activity_items.length, thinking: out.thinking.length, activity: out.activity });
    return out;
  }

  function collectActivityItems(panel, outItems, seen) {
    const titleNodes = Array.from(panel.querySelectorAll('div.text-token-text-primary'));
    for (const titleEl of titleNodes) {
      const title = compactText(titleEl.textContent).slice(0, 220);
      if (!title || /^(Думал[а]? на протяжении|Thought for)\b/i.test(title)) continue;
      const block = titleEl.closest('.relative.flex.w-full.items-start.gap-2.overflow-clip') ||
        titleEl.closest('[class*="overflow-clip"]') ||
        titleEl.parentElement;
      if (!block || !panel.contains(block)) continue;
      const blockText = compactText(block.textContent).slice(0, 2400);
      if (!blockText) continue;
      const codeTexts = uniqueStrings(Array.from(block.querySelectorAll('pre code, pre, code'))
        .map(el => cleanCodeText(el.textContent))
        .filter(Boolean));
      const command = pickCommandText(codeTexts);
      if (isCodeLanguageTitle(title) && command) continue;
      const links = Array.from(block.querySelectorAll('a[href]'))
        .map(a => sourceLinkFromAnchor(a))
        .filter(Boolean)
        .slice(0, 8);
      const sig = [title, command || '', links.map(l => l.url).join('|'), blockText.slice(0, 160)].join('\n');
      if (seen.has(sig)) continue;
      seen.add(sig);
      const item = { title };
      if (links.length) item.links = links;
      if (command) item.command = command.slice(0, 4000);
      if (blockText && blockText !== title) item.text = blockText;
      outItems.push(item);
      if (outItems.length >= 120) return;
    }
  }

  function sourceLinkFromAnchor(a) {
    const href = a?.href || '';
    if (!/^https?:/i.test(href)) return null;
    let host = '';
    try { host = new URL(href).hostname.toLowerCase(); } catch (_) {}
    if (host === 'chatgpt.com' || host.endsWith('.chatgpt.com') || host === 'chat.openai.com') return null;
    return {
      url: href,
      title: compactText(a.textContent).slice(0, 300),
    };
  }

  function compactText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function cleanCodeText(value) {
    return compactText(value).replace(/^(?:Python|JavaScript|TypeScript|Bash|Shell|JSON)\s+(?=(?:bash|python|node|npm|pnpm|curl|git|rg|sed|cat|sqlite3|jq)\b)/i, '');
  }

  function uniqueStrings(values) {
    const out = [];
    const seen = new Set();
    for (const value of values) {
      if (!value || seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
    return out;
  }

  function pickCommandText(values) {
    return values.find(v => /^(?:bash|python|node|npm|pnpm|curl|git|rg|sed|cat|sqlite3|jq)\b/i.test(v)) || values[0] || '';
  }

  function isCodeLanguageTitle(value) {
    return /^(?:Python|JavaScript|TypeScript|Bash|Shell|JSON|Text|Markdown)$/i.test(String(value || '').trim());
  }

  function cleanActivity(value) {
    const s = String(value || '').trim();
    const time = s.match(/^((?:\d+\s*(?:h|hr|hrs|m|min|mins|s|sec|secs|ч|час|часа|часов|м|мин|сек|с)\s*){1,4})/i);
    return (time ? time[1] : s).trim();
  }

  // ── Done-watcher ─────────────────────────────────────────────────────
  // API observation of an already-submitted turn does not depend on the
  // composer being rendered. Stop/quiet and own-turn DOM proof still guard
  // DOM fallback; a missing idle button is not proof of provider inactivity.
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
  function startDoneWatcher(onDone, onProgress, escalation, getDoneImages, terminalProbe, boundary, options = {}) {
    let stopAppeared = false;
    let lastUrl = location.href;
    const armedAt = Date.now();
    const ARMING_MS = 700;
    const QUIET_WINDOW_MS = 3000;
    // Если stop так и не появился — submit не сработал (paste в пустоту,
    // логин-волл и т.п.). 120с с запасом: Pro-режимы стартуют генерацию
    // мгновенно (stop появляется <1с, живой probe), долгая фаза — само мышление.
    const NO_STOP_FAIL_MS = 120000;
    // После исчезновения Stop backend может на несколько секунд показать
    // commentary/tool хвост раньше настоящего final. Это нормальная eventual
    // consistency, поэтому одного pending-снимка недостаточно. Но если
    // ChatGPT уже вернулся в idle, а один и тот же незавершённый API-хвост
    // не меняется пять минут, provider-turn фактически оборван: новый финал
    // нельзя получить дополнительным polling/WebSocket без нового сообщения.
    const INCOMPLETE_FINAL_GRACE_MS = 5 * 60 * 1000;
    const INCOMPLETE_FINAL_MAX_SAMPLE_GAP_MS = 90 * 1000;
    let lastStopSeenAt = 0;
    let fired = false;
    let terminalProbePending = false;
    let lastTerminalProbeAt = 0;
    let lastTerminalProbeSig = '';
    let pendingFinalSig = '';
    let pendingFinalSince = 0;
    let pendingFinalLastSeenAt = 0;
    let pendingFinalSamples = 0;
    let pendingFinalStagePosted = false;

    const requestDone = (meta) => {
      if (typeof terminalProbe !== 'function') {
        if (!meta.domReady) return false;
        onDone({ ...meta, assistant: assistantTarget(submittedAssistantElement(boundary)) });
        return true;
      }
      const now = Date.now();
      if (terminalProbePending || now - lastTerminalProbeAt < 1500) return false;
      terminalProbePending = true;
      lastTerminalProbeAt = now;
      Promise.resolve()
        .then(() => terminalProbe(meta))
        .then((proof) => {
          terminalProbePending = false;
          // Stop can return while the API request is in flight. Do not commit
          // a candidate (including provider_incomplete) over live generation.
          if (fired || findStopBtn()) return;
          const sig = `${proof?.ready ? 1 : 0}|${proof?.reason || ''}|${proof?.message_id || ''}`;
          if (sig !== lastTerminalProbeSig) {
            lastTerminalProbeSig = sig;
            const data = {
              watcherRevision: WATCHER_REVISION,
              observationReason: meta.observationReason || 'stop_quiet',
              domReady: !!meta.domReady,
              uiIdle: !!meta.uiIdle,
              userId: proof?.user_id || null,
              conversationId: proof?.conversation_id || null,
              ready: !!proof?.ready,
              reason: proof?.reason || null,
              proofKind: proof?.proof_kind || null,
              messageId: proof?.message_id || null,
              textLen: proof?.text?.length || 0,
              candidateMessageId: proof?.candidate_message_id || null,
              candidateChannel: proof?.candidate_channel ?? null,
              candidateEndTurn: proof?.candidate_end_turn ?? null,
              candidatePreamble: !!proof?.candidate_preamble,
              candidateStatus: proof?.candidate_status || null,
              tailMessageId: proof?.tail_message_id || null,
              tailRole: proof?.tail_role || null,
              tailContentType: proof?.tail_content_type || null,
            };
            log(proof?.ready ? 'watcher.api_final' : 'watcher.api_pending', data);
            bridgeLog(proof?.ready ? 'gpt.watcher.api_final' : 'gpt.watcher.api_pending', data, getRequestId(), null);
          }
          if (!proof?.ready) {
            const providerIdle = (meta.stopWasSeen || boundary?.resumed)
              && meta.uiIdle
              && meta.quietPassed
              && !meta.domReady;
            const incompleteTail = proof?.reason === 'api_final_pending'
              && !!proof?.user_id
              && !!proof?.candidate_message_id
              && proof?.candidate_channel === 'commentary'
              && proof?.candidate_preamble === true
              && !!proof?.tail_message_id;
            if (providerIdle && incompleteTail) {
              const pendingSig = [
                proof.user_id,
                proof.candidate_message_id,
                proof.tail_message_id,
                proof.tail_role || '',
                proof.tail_content_type || '',
              ].join('|');
              if (pendingSig !== pendingFinalSig) {
                pendingFinalSig = pendingSig;
                pendingFinalSince = Date.now();
                pendingFinalLastSeenAt = pendingFinalSince;
                pendingFinalSamples = 1;
                const data = {
                  candidateMessageId: proof.candidate_message_id,
                  tailMessageId: proof.tail_message_id,
                  tailRole: proof.tail_role || null,
                  tailContentType: proof.tail_content_type || null,
                };
                log('watcher.api_progress', data);
                bridgeLog('gpt.watcher.api_progress', data, getRequestId(), null);
              } else {
                const now = Date.now();
                // Нельзя назвать хвост стабильным, если API был недоступен
                // слишком долго: за этот разрыв graph мог измениться и снова
                // вернуться к похожей форме. Нужна непрерывная серия proof'ов.
                if (now - pendingFinalLastSeenAt > INCOMPLETE_FINAL_MAX_SAMPLE_GAP_MS) {
                  pendingFinalSince = now;
                  pendingFinalSamples = 1;
                } else {
                  pendingFinalSamples += 1;
                }
                pendingFinalLastSeenAt = now;
              }
              if (!pendingFinalStagePosted) {
                pendingFinalStagePosted = true;
                onProgress({
                  stage: 'waiting_provider_final',
                  url: meta.url,
                  title: meta.title,
                });
              }
              const stableMs = Date.now() - pendingFinalSince;
              if (pendingFinalSamples >= 2 && stableMs >= INCOMPLETE_FINAL_GRACE_MS) {
                const data = {
                  stableMs,
                  samples: pendingFinalSamples,
                  candidateMessageId: proof.candidate_message_id,
                  tailMessageId: proof.tail_message_id,
                  tailRole: proof.tail_role || null,
                  tailContentType: proof.tail_content_type || null,
                };
                log('watcher.provider_incomplete', data);
                bridgeLog('gpt.watcher.provider_incomplete', data, getRequestId(), null);
                fired = true;
                onProgress({
                  stage: 'provider_incomplete',
                  url: meta.url,
                  title: meta.title,
                  providerProof: data,
                });
              }
            }
            return;
          }
          const assistant = submittedAssistantElement(boundary);
          const imageCount = typeof getDoneImages === 'function' ? getDoneImages().length : 0;
          const domReady = !!submittedUserElement(boundary)
            && ((readAnswerText(assistant).length > 0 && hasFinalAnswerAction(assistant)) || imageCount > 0);
          // API failure/Temporary Chat still use DOM, but only a final after
          // this submission. Old Copy/Voice controls cannot finish a new job.
          if (proof.fallback && (!domReady || findStopBtn())) return;
          // Image-only API finals can precede decoded DOM images. Preserve
          // the media wait instead of committing an empty result immediately.
          if (!proof.fallback && !proof.text?.trim() && !domReady) return;
          fired = true;
          onDone({ ...meta, imageCount, assistant: assistantTarget(assistant, proof.fallback ? null : proof), apiFinal: proof });
        })
        .catch((error) => {
          terminalProbePending = false;
          const data = { err: error?.message || String(error), watcherRevision: WATCHER_REVISION,
            observationReason: meta.observationReason || 'stop_quiet' };
          log('watcher.api_probe_failed', data);
          bridgeLog('gpt.watcher.api_probe_failed', data, getRequestId(), null);
        });
      return false;
    };

    let tickN = 0;
    let lastTickSig = null;
    const tick = () => {
      const stop = findStopBtn();
      const send = findSendBtn();
      const voice = findVoiceBtn();
      const now = Date.now();
      if (stop) {
        stopAppeared = true;
        lastStopSeenAt = now;
        // Возобновившийся Stop — самостоятельное доказательство новой
        // provider-активности. Старое окно «хвост не меняется» больше не
        // относится к текущему состоянию.
        pendingFinalSig = '';
        pendingFinalSince = 0;
        pendingFinalLastSeenAt = 0;
        pendingFinalSamples = 0;
        pendingFinalStagePosted = false;
      }
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
        const dbg = { n: tickN, stop: !!stop, send: !!send, voice: !!voice, stopAppeared,
          quiet: quietPassed, vis: document.visibilityState, watcherRevision: WATCHER_REVISION };
        log('watcher.tick', dbg);
        bridgeLog('gpt.watcher.tick', dbg, getRequestId(), null);
      }
      if (!armed) return false;
      const imageCount = typeof getDoneImages === 'function' ? getDoneImages().length : 0;
      const assistant = submittedAssistantElement(boundary);
      const hasAnswer = readAnswerText(assistant).length > 0 && hasFinalAnswerAction(assistant);
      const domReady = hasAnswer || imageCount > 0;
      if (!stopAppeared) {
        // На reload Stop уже закономерно отсутствует. Такой watcher не имеет
        // права задним числом объявлять доказанную исходную отправку
        // submit_failed только потому, что DOM/API ещё не гидратировали user.
        if (!boundary?.resumed
            && now - armedAt > NO_STOP_FAIL_MS
            && !submittedUserElement(boundary)
            && !boundary.userId) {
          onProgress({ stage: 'submit_failed' });
          return true;
        }
        const submitted = boundary?.resumed || boundary?.userId || submittedUserElement(boundary);
        if (submitted || send || voice) {
          if (domReady && !terminalProbePending) {
            log('watcher.done_without_stop', { hasAnswer, imageCount });
            bridgeLog('gpt.watcher.done_without_stop', { hasAnswer, imageCount }, getRequestId(), null);
          }
          return requestDone({
            url: location.href,
            title: document.title,
            imageCount,
            domReady,
            stopWasSeen: false,
            uiIdle: !!(send || voice),
            observationReason: boundary?.resumed ? 'resumed_turn' : submitted ? 'submitted_turn' : 'ui_idle',
            // API final proof is independent of idle UI. Incomplete-provider
            // diagnosis still needs a recognized idle state, not absent DOM.
            quietPassed: !!boundary?.resumed && !!(send || voice),
          });
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
      }
      if (domReady && !terminalProbePending) {
        log('watcher.done', { stop_seen: stopAppeared, hasAnswer, imageCount });
        bridgeLog('gpt.watcher.done', { stop_seen: stopAppeared, hasAnswer, imageCount }, getRequestId(), null);
      }
      return requestDone({
        url: location.href,
        title: document.title,
        imageCount,
        domReady,
        stopWasSeen: stopAppeared,
        quietPassed,
        uiIdle: !!(send || voice),
        observationReason: 'stop_quiet',
      });
    };

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
      queueMicrotask(() => { scheduled = false; wrappedTick(); });
    };
    const mo = new MutationObserver(onMutation);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label', 'disabled', 'data-testid'] });
    const iv = setInterval(() => { try { if (!fired) wrappedTick(); } catch (_) {} }, 2000);
    window.__scResearchTick = () => { try { if (!fired) wrappedTick(); } catch (_) {} };
    const pokeHandler = () => { try { if (!fired) wrappedTick(); } catch (_) {} };
    window.__scResearchPoke = pokeHandler;

    const hardTimer = setTimeout(() => {
      // Pro can legitimately think longer than the old 30-minute transport
      // ceiling. Keep its real completion observer alive; a wall-clock
      // milestone is not a provider failure or permission to duplicate work.
      if (options.extended === true) {
        if (!fired) onProgress({ stage: 'waiting_extended', url: location.href, title: document.title });
        return;
      }
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

  async function detachFocusEmulation(tabId) {
    return await new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ __sc_debugger_detach: true, tabId: tabId ?? undefined }, r => {
          if (chrome.runtime.lastError) {
            log('compose.debugger_detach_fail', { err: chrome.runtime.lastError.message });
            resolve(false);
            return;
          }
          log('compose.debugger_detach', r || {});
          resolve(!!r?.ok);
        });
      } catch (e) {
        log('compose.debugger_detach_throw', { err: e?.message || String(e) });
        resolve(false);
      }
    });
  }

  async function runComposeHandoff(id, myTabId) {
    log('compose.start', { id, tabId: myTabId });
    const stopKeepAlive = startKeepAlivePort();
    let submitted = false;
    let job = null;
    try {
      const claimed = await claimComposeTab(id);
      log('compose.claim', { id, tabId: myTabId, ok: claimed });
      job = await fetchComposeJob(id);
      const mode = resolveChatgptMode(job.mode);
      const effortKey = resolveEffort(job.effort);
      const modelKey = resolveModel(job.model);
      const speedKey = mode === 'work' ? resolveSpeed(job.speed) : null;
      const selectionError = chatgptSelectionError(mode, modelKey, effortKey);
      if (selectionError) throw new Error(selectionError);
      log('compose.payload', {
        id,
        promptLen: job.prompt.length,
        documentName: job.document?.name || null,
        documentChars: job.document?.text.length || 0,
        showInTextField: job.showInTextField,
      });

      // Background уже принял terminal result, но не смог доставить его в
      // YouTube (например, SW перезапустился между сообщениями). После F5
      // повторяем только ACK, а не настройки/paste/Send.
      if (job.terminalResult && typeof job.terminalResult === 'object') {
        submitted = job.terminalResult.ok === true || !!job.submitAcceptedAt;
        const acknowledged = await reportComposeResult(id, job, job.terminalResult);
        if (acknowledged) await removeComposeJob(id);
        return;
      }

      // ACK мог дойти до ChatGPT, но ответ SW потеряться при respin. Метка
      // submitAcceptedAt запрещает повторную отправку после F5/re-inject:
      // повторяем только подтверждение в исходную YouTube-кнопку.
      if (job.submitAcceptedAt) {
        submitted = true;
        const acknowledged = await reportComposeResult(id, job, {
          ok: true,
          mode: job.acceptedMode || mode,
          model: job.acceptedModel || modelKey,
          effort: job.acceptedEffort || effortKey,
          speed: job.acceptedSpeed || speedKey,
        });
        if (acknowledged) await removeComposeJob(id);
        return;
      }

      await waitFor(() => findComposer(), 'composer (editable ChatGPT input)', 20000);
      const okMode = await ensureChatgptModeSelected(mode);
      if (!okMode) throw new Error(`chatgpt_mode_select_failed: не удалось выбрать ChatGPT · ${chatgptModeLabel(mode)}`);
      await waitFor(() => findComposer(), 'composer after Chat/Work selection', 15000);
      const okModel = await ensureModelSelected(modelKey, mode);
      if (!okModel) throw new Error(`chatgpt_model_select_failed: не удалось выбрать модель ${modelDisplay(modelKey)}`);
      const okEffort = await ensureEffortSelected(effortKey, mode, modelKey);
      if (!okEffort) throw new Error(`chatgpt_effort_select_failed: не удалось выбрать интеллект ${effortLabel(effortKey)}`);
      if (mode === 'work') {
        const okSpeed = await ensureSpeedSelected(speedKey);
        if (!okSpeed) throw new Error(`chatgpt_speed_select_failed: не удалось выбрать скорость ${speedLabel(speedKey)}`);
      }
      if (!await verifyChatgptSelection(mode, modelKey, effortKey)) {
        throw new Error('chatgpt_selection_verify_failed: фактическая модель или усилие не совпали с запросом');
      }

      let uploadedDocument = null;
      let documentUpload = null;
      let inlineText = null;
      let requirePastedTextChip = false;
      let delivery = 'prompt_only';
      if (job.document && job.showInTextField) {
        if (typeof buildYoutubeChatgptInlineParts !== 'function') {
          throw new Error('chatgpt_inline_builder_missing');
        }
        const inlineParts = buildYoutubeChatgptInlineParts(job.prompt, job.document.text);
        inlineText = inlineParts.combinedText;
        if (inlineParts.promptText) {
          pasteIntoComposer(inlineParts.promptText);
          await waitFor(
            () => composerContainsInlineText(inlineParts.promptText),
            'ChatGPT prompt in composer before Pasted Text',
            5000,
          );
        }
        const sourcePasteText = (inlineParts.promptText ? '\n\n' : '') + inlineParts.sourceText;
        pasteIntoComposer(sourcePasteText, { append: true });
        const inlineResult = await showPastedTextInComposer(id, inlineText, inlineParts.promptText);
        requirePastedTextChip = inlineResult.method === 'pasted_text_attachment';
        delivery = requirePastedTextChip ? 'pasted_text_attachment' : 'inline';
      } else if (job.document) {
        uploadedDocument = composeDocumentFile(job.document);
        documentUpload = await uploadFiles(id, [uploadedDocument], {
          eventPrefix: 'compose.document',
          requirePreview: true,
        });
        await sleep(800);
        if (job.prompt) pasteIntoComposer(job.prompt);
        delivery = 'file';
      } else if (job.prompt) {
        pasteIntoComposer(job.prompt);
      }
      await waitComposerReadyAfterPaste(id, 120000, [
        inlineText || job.prompt,
        uploadedDocument?.name || '',
      ], uploadedDocument ? [uploadedDocument.name] : []);
      if (uploadedDocument && !documentUpload?.hasPreview()) {
        throw new Error('chatgpt_attachment_disappeared_before_submit: ' + uploadedDocument.name);
      }
      if (requirePastedTextChip && !findPastedTextChip()) {
        throw new Error('chatgpt_pasted_text_attachment_disappeared_before_submit');
      }
      await clickSend(undefined, documentUpload);
      submitted = true;
      job = await updateComposeJob(id, {
        submitAcceptedAt: Date.now(),
        acceptedMode: mode,
        acceptedModel: modelKey,
        acceptedEffort: effortKey,
        acceptedSpeed: speedKey,
      });
      log('compose.submitted', {
        id,
        mode,
        model: modelKey,
        effort: effortKey,
        speed: speedKey,
        promptLen: job.prompt.length,
        documentChars: job.document?.text.length || 0,
        delivery,
      });
      const acknowledged = await reportComposeResult(id, job, {
        ok: true,
        mode,
        model: modelKey,
        effort: effortKey,
        speed: speedKey,
      });
      if (acknowledged) await removeComposeJob(id);
      else log('compose.result_ack_pending', { id, mode, model: modelKey, effort: effortKey });
    } catch (e) {
      const error = e?.message || String(e);
      log('compose.flow_err', { id, err: error });
      if (job && !submitted) {
        const acknowledged = await reportComposeResult(id, job, {
          ok: false,
          error,
          mode: resolveChatgptMode(job.mode),
          model: resolveModel(job.model),
          effort: resolveEffort(job.effort),
          speed: resolveChatgptMode(job.mode) === 'work' ? resolveSpeed(job.speed) : null,
        });
        if (acknowledged) await removeComposeJob(id);
      }
    } finally {
      stopKeepAlive();
      // Compose закончен и после принятого Send, и после ошибки настройки.
      // CDP focus-emulation нужен только пока скрытая вкладка выполняет шаги;
      // не оставляем debugger attached на терминальной ошибке.
      await detachFocusEmulation(myTabId);
    }
  }

  async function main() {
    const myTabId = await getMyTabId();
    const composeId = getComposeId();
    const initialResearchId = composeId ? null : getRequestId();
    const bootInfo = {
      url: location.href, query: location.search || '',
      hasWindowName: !!window.name, windowName: (window.name || '').slice(0, 80),
      visibility: document.visibilityState, tabId: myTabId, pickerRevision: PICKER_REVISION,
      attachmentUploadRevision: UPLOAD_REVISION,
      composerReadinessRevision: COMPOSER_READINESS_REVISION,
      watcherRevision: WATCHER_REVISION,
    };
    log('cs.boot', bootInfo);
    const startupBoot = await markResearchStartupBoot(initialResearchId, myTabId);
    if (!startupBoot?.ok && initialResearchId) {
      log('cs.startup_boot_ack_failed', { err: startupBoot?.error || 'unknown' });
    }
    bridgeLog('cs.boot', bootInfo, null, myTabId);

    if (composeId) {
      await runComposeHandoff(composeId, myTabId);
      return;
    }

    let id = initialResearchId;
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

    if (job.options?.readOnlyImport === true) {
      const keepTabAfterDone = scKeepResearchTabAfterDone(job.options);
      try {
        window.scResearchBadge?.show({
          jobId: id,
          providerLabel: 'ChatGPT · импорт по ссылке',
          modelTitle: 'Только чтение',
          prompt: '',
        });
      } catch {}
      try {
        const imported = await runReadOnlyConversationImport(id, job, myTabId);
        stopHb();
        try { window.scResearchBadge?.hide(); } catch {}
        await detachFocusEmulation(myTabId);
        if (imported.confirmed) {
          stopKeepAlive();
          if (keepTabAfterDone) log('import.keep_tab_open');
          else closeSelfTab('conversation_import_done');
        } else {
          log('import.unconfirmed_keep_tab_open');
        }
      } catch (error) {
        const message = error?.message || String(error);
        log('import.flow_err', { err: message });
        bridgeLog('gpt.import.error', { err: message }, id, myTabId);
        const confirmed = await postTerminalState(id, {
          status: 'error', stage: 'import_failed',
          url: location.href, title: document.title, error: message,
        });
        stopHb();
        if (confirmed) stopKeepAlive();
        try { window.scResearchBadge?.hide(); } catch {}
        await detachFocusEmulation(myTabId);
        // Ошибка импорта оставляет вкладку открытой для ручной проверки.
      }
      return;
    }

    // options.model и options.effort — разные оси: tier модели и уровень
    // рассуждения. Раньше effort фолбэчился на options.model — теперь model
    // занят настоящей моделью, фолбэк убран.
    const mode = resolveChatgptMode(job.options?.mode);
    const effortKey = resolveEffort(job.options?.effort);
    const modelKey = resolveModel(job.options?.model);
    const speedKey = mode === 'work' ? resolveSpeed(job.options?.speed) : null;
    const selectionError = chatgptSelectionError(mode, modelKey, effortKey);
    const wantSourcesInText = !!job.options?.sources;
    const keepTabAfterDone = scKeepResearchTabAfterDone(job.options);
    const attachmentMetas = Array.isArray(job.attachments) ? job.attachments : [];

    // MCP-плашка (общий research-badge.js) — юзер видит «вкладка под job'ом».
    try {
      window.scResearchBadge?.show({
        jobId: id, providerLabel: `ChatGPT · ${chatgptModeLabel(mode)}`,
        modelTitle: modelDisplay(modelKey) + ' · ' + effortLabel(effortKey)
          + (speedKey ? ' · ' + speedLabel(speedKey) : ''),
        prompt: job.prompt || '',
      });
    } catch {}

    // После reload/recovery (status=running) submit уже сделан прошлым CS —
    // только watcher, никакого повторного paste (иначе дубль-сообщение в чате).
    const isReloadRestart = recovered || job.status === 'running';
    const imageBaselineKeys = collectGeneratedImageKeys();
    let apiBaseline = null;
    if (!isReloadRestart) {
      try {
        apiBaseline = await latestApiTurnSnapshot();
      } catch (error) {
        log('api.baseline_failed', { err: error?.message || String(error) });
      }
    }
    let turnBoundary = isReloadRestart ? createTurnBoundary(null, true, { prompt: job.prompt }) : null;

    try {
      if (!isReloadRestart) {
        await waitFor(() => findComposer(), 'composer (editable ChatGPT input)', 20000);
        await postState(id, { status: 'running', stage: 'configuring', error: '',
          ...(typeof myTabId === 'number' ? { tabId: myTabId } : {}) });
        const failConfiguration = async (error) => {
          const ok = await postTerminalState(id, {
            status: 'error', stage: 'configuring',
            url: location.href, title: document.title, error,
          });
          stopHb();
          if (ok) stopKeepAlive(); // не подтвердилось → порт живой, fallback вооружён
          try { window.scResearchBadge?.hide(); } catch {}
        };
        if (selectionError) {
          await failConfiguration(selectionError);
          return;
        }

        // Режим выбирается первым: переключение Chat/Work может пересобрать
        // composer и вернуть sticky-модель/уровень этого режима. После него
        // отдельно верифицируем модель и интеллект. Любое несовпадение fatal:
        // ответ на другом режиме/модели/уровне хуже явной ошибки.
        const okMode = await ensureChatgptModeSelected(mode, job.conversationModeProof);
        if (!okMode) {
          await failConfiguration(`chatgpt_mode_select_failed: не удалось выбрать ChatGPT · ${chatgptModeLabel(mode)}`);
          return;
        }
        await waitFor(() => findComposer(), 'composer after Chat/Work selection', 15000);

        const okModel = await ensureModelSelected(modelKey, mode);
        if (!okModel) {
          await failConfiguration(`chatgpt_model_select_failed: не удалось выбрать модель ${modelDisplay(modelKey)} (ChatGPT помнит модель per-аккаунт — мог ответить прошлой)`);
          return;
        }
        const okEffort = await ensureEffortSelected(effortKey, mode, modelKey);
        if (!okEffort) {
          await failConfiguration(`chatgpt_effort_select_failed: не удалось выбрать интеллект ${effortLabel(effortKey)} (запрос не отправлен с другим sticky-уровнем)`);
          return;
        }
        if (mode === 'work') {
          const okSpeed = await ensureSpeedSelected(speedKey);
          if (!okSpeed) {
            await failConfiguration(`chatgpt_speed_select_failed: не удалось выбрать скорость ${speedLabel(speedKey)} (запрос не отправлен со sticky-настройкой)`);
            return;
          }
        }
        if (!await verifyChatgptSelection(mode, modelKey, effortKey)) {
          await failConfiguration('chatgpt_selection_verify_failed: фактическая модель или усилие не совпали с запросом');
          return;
        }
        let attachmentUpload = null;
        if (attachmentMetas.length) {
          await postState(id, { stage: 'uploading' });
          attachmentUpload = await uploadAttachments(id, attachmentMetas);
          await sleep(800);
        }
        await postState(id, { stage: 'submitting' });
        pasteIntoComposer(job.prompt);
        await waitComposerReadyAfterPaste(id, 120000, [
          job.prompt,
          ...(attachmentUpload?.files || []).map(file => file.name),
        ], (attachmentUpload?.files || []).map(file => file.name));
        // Capture rendered history immediately before Send, after all composer
        // configuration/paste awaits; a missing API baseline still has a DOM boundary.
        turnBoundary = createTurnBoundary(apiBaseline);
        await clickSend(turnBoundary, attachmentUpload);
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
          const apiFinal = final.apiFinal?.ready && !final.apiFinal?.fallback
            ? final.apiFinal
            : null;
          // Hidden tab коммитит DOM ЧАСТИЧНО (тест: 55 символов из полного
          // ответа, стабилизация ложно проходит — замороженный DOM не растёт;
          // чип «Источники» тоже не дорисован). Извлечение валидно только на
          // отрисованной вкладке: фокус-пульс перед extract, restore после.
          if (!apiFinal && document.visibilityState === 'hidden') {
            escalateFocus();
            const tf = performance.now();
            while (document.visibilityState === 'hidden' && performance.now() - tf < 4000) await sleep(200);
            await sleep(800); // дать React дорисовать после unfreeze
          }
          const getAssistant = () => submittedAssistantElement(turnBoundary, final.assistant);
          const text = apiFinal?.text || await extractAnswerStable(getAssistant);
          const generatedImages = final.imageCount > 0
            ? await extractGeneratedImagesStable(imageBaselineKeys, turnBoundary)
            : [];
          const persistedImages = await persistGeneratedImages(id, generatedImages);
          const thinkingLine = readThinkingLine(getAssistant());
          const thinkingText = apiFinal?.reasoning_text || readThinkingText(getAssistant());
          // Источники парсим ВСЕГДА (в result.sources). В text — только по
          // options.sources: дефолтный ответ чистый, источники по параметру.
          const src = apiFinal
            ? {
                links: apiFinal.links || [],
                activity_items: apiFinal.activity_items || [],
                activity: null,
                thinking: thinkingText ? [thinkingText] : [],
                chip_present: false,
                panel_opened: false,
                source: 'api',
              }
            : await extractSources(getAssistant());
          let outText = text || '';
          if (wantSourcesInText && src.links.length) {
            const block = src.links.map((l, i) => `${i + 1}. ${l.title || l.url} — ${l.url}`).join('\n');
            outText += `\n\n---\nИсточники (${src.links.length}):\n${block}`;
            if (src.activity) outText += `\nАктивность: ${src.activity}`;
          }
          const isShort = outText.length > 0 && outText.length < 800;
          const endsWithQuestion = /\?\s*$/.test(outText);
          const isClarifying = isShort && endsWithQuestion;
          log('watcher.final', { textLen: outText.length, images: persistedImages.length, links: src.links.length, activity_items: src.activity_items.length, thinking: thinkingLine });
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
              source_activity: src.activity_items,
              sources_meta: {
                activity: src.activity,
                activity_items: src.activity_items,
                thinking: src.thinking,
                thinking_last: thinkingLine,
                thinking_text: thinkingText || null,
                chip_present: src.chip_present,
                panel_opened: src.panel_opened,
                source: src.source || 'dom',
              },
              effort: effortKey,
              model: modelKey,
              speed: speedKey,
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
            if (keepTabAfterDone) {
              log('done.keep_tab_open');
            } else {
              closeSelfTab('research_done');
            }
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
          if (prog.stage === 'provider_incomplete') {
            const ok = await postTerminalState(id, {
              status: 'error',
              stage: 'provider_incomplete',
              url: prog.url,
              title: prog.title,
              error: 'ChatGPT прекратил генерацию без финального ответа: остался стабильный commentary/tool-хвост. Новый запрос автоматически не отправлялся.',
            });
            try { stopWatcher(); } catch {}
            stopHb();
            if (ok) stopKeepAlive();
            try { window.scResearchBadge?.hide(); } catch {}
            restoreFocus();
            await detachFocusEmulation(myTabId);
            // Разговор сохраняем открытым: пользователь может прочитать
            // промежуточный след и осознанно отправить continuation.
            return;
          }
          await postState(id, { stage: prog.stage, url: prog.url, title: prog.title });
        },
        escalateFocus,
        () => collectGeneratedImages(imageBaselineKeys, turnBoundary),
        createTerminalProbe(turnBoundary),
        turnBoundary,
        { extended: effortKey === 'pro' }
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
