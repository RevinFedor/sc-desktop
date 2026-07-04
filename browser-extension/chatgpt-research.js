// SC Browser Parser — automation через chatgpt.com.
//
// Два entrypoint'а используют один низкоуровневый compose-layer:
//   • ?sc-research=<requestId> — MCP/research job: submit → watcher →
//     extract answer/images/sources → POST /research-state.
//   • ?sc-compose=<requestId> — одноразовый handoff для YouTube +AI:
//     submit prompt и оставить обычный ChatGPT-чат без MCP-badge/sources.
//
// requestId для research живёт в bridge'е (GET /research-job). requestId
// для compose живёт в chrome.storage.local (__sc_chatgpt_compose_job_*).
// query дублируется в #hash на случай если SPA срежет query до document_idle.
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
        sendResponse({ isExporting: popupExportRunning });
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

  async function fetchComposeJob(id) {
    const key = COMPOSE_JOB_PREFIX + id;
    const got = await new Promise(resolve => {
      chrome.storage.local.get(key, resolve);
    });
    const job = got?.[key];
    if (!job || typeof job.prompt !== 'string' || !job.prompt.trim()) {
      throw new Error('compose_job_missing_or_empty: ' + id);
    }
    return job;
  }

  async function removeComposeJob(id) {
    try {
      await new Promise(resolve => {
        chrome.storage.local.remove(COMPOSE_JOB_PREFIX + id, resolve);
      });
    } catch (_) {}
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
      if (e.target === overlay && (overlay.dataset.state === 'success' || overlay.dataset.state === 'error')) {
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
    const card = overlay.firstElementChild;
    if (!card) return;
    card.innerHTML = `
      <div style="font-size:13px;font-weight:700;color:${ok ? '#69db7c' : '#ff8787'};text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px;">
        ${ok ? 'Готово' : 'Экспорт прерван'}
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
    return Array.from(document.querySelectorAll('[data-message-author-role]'));
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
    return turn.querySelector?.('[data-message-author-role]') || turn;
  }

  function extractMessageTextMarkdown(messageEl, role) {
    if (!messageEl) return '';
    if (role === 'assistant') {
      const mds = Array.from(messageEl.querySelectorAll('.markdown'))
        .filter(m => !m.classList.contains('result-thinking'));
      const md = mds[mds.length - 1];
      if (md) return markdownFromDom(md);
    }
    const textContainers = Array.from(messageEl.querySelectorAll('.whitespace-pre-wrap, .prose, .markdown'))
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

  function buildChatGPTExportHeader(turnCount, stats) {
    const title = (document.title || 'ChatGPT').replace(/\s*[-–]\s*ChatGPT\s*$/i, '').trim() || 'ChatGPT chat';
    const exportedAt = new Date().toISOString();
    let md = `# ${title}\n\n`;
    md += `> **Сводка экспорта ChatGPT**  \n`;
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

  async function fetchChatGPTConversationJson() {
    const conversationId = chatgptConversationIdFromLocation();
    if (!conversationId) return null;
    const sessionRes = await fetch('/api/auth/session', { credentials: 'include' });
    if (!sessionRes.ok) throw new Error('ChatGPT session fetch failed: HTTP ' + sessionRes.status);
    const session = await sessionRes.json();
    const accessToken = session?.accessToken;
    if (!accessToken) throw new Error('ChatGPT session has no access token');
    const res = await fetch(`/backend-api/conversation/${encodeURIComponent(conversationId)}`, {
      credentials: 'include',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`ChatGPT conversation API failed: HTTP ${res.status} ${text.slice(0, 120)}`);
    }
    const data = await res.json();
    if (!data?.mapping || !data?.current_node) throw new Error('ChatGPT conversation API returned no mapping/current_node');
    return data;
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

  function apiAttachmentsMarkdown(node) {
    const attachments = node?.message?.metadata?.attachments;
    if (!Array.isArray(attachments) || !attachments.length) return '';
    let md = `\n\n### Вложения\n\n`;
    for (const a of attachments) {
      const name = a.name || a.file_name || a.title || a.id || 'attachment';
      const mime = a.mime_type || a.content_type || a.file_mime_type || '';
      const url = a.url || a.download_url || a.file_url || '';
      md += `- ${name}${mime ? ` (${mime})` : ''}${url ? ` — ${url}` : ''}\n`;
    }
    return md;
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
    const type = msg.content?.content_type || '';
    const text = apiMessageText(node);
    if (type === 'code') {
      return { title: `Code${msg.content?.language ? `: ${msg.content.language}` : ''}`, command: text };
    }
    if (type === 'execution_output') {
      return { title: 'Execution output', text: text || compactJsonSnippet(msg.metadata?.aggregate_result || '') };
    }
    if (role === 'tool') {
      const title = msg.metadata?.command ? `Tool: ${compactText(msg.metadata.command).slice(0, 120)}` : `Tool: ${type || 'activity'}`;
      return { title, text: text || compactJsonSnippet(msg.content || '') };
    }
    if (type === 'model_editable_context') {
      const title = msg.content?.repository ? `Context: ${msg.content.repository}` : 'Context update';
      return { title, text: text || compactJsonSnippet(msg.content || '') };
    }
    return null;
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

  function buildChatGPTApiMarkdown(data, settings, stats) {
    const nodes = chatgptCurrentPathNodes(data)
      .filter(node => node?.message && apiMessageRole(node) !== 'system' && !isHiddenApiMessage(node));
    const turns = [];
    let current = null;

    for (const node of nodes) {
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
        } else if (type === 'text' && (msg.channel === 'final' || msg.end_turn === true)) {
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
      const userAttachments = turn.user ? apiAttachmentsMarkdown(turn.user) : '';
      const userAttachmentCount = turn.user ? apiAttachmentCount(turn.user) : 0;
      const assistantText = turn.assistant.join('\n\n---\n\n').trim();
      const links = dedupeLinks(turn.sources);

      if (userText || userAttachments) {
        stats.user++;
        if (settings.includeImages) stats.images += userAttachmentCount;
        parts.push(`## User\n\n${userText || '_[Пустое сообщение]_'}${settings.includeImages ? userAttachments : ''}`.trim() + '\n');
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
    let markdown = `# ${title}\n\n`;
    markdown += `> **Сводка экспорта ChatGPT**  \n`;
    markdown += `> Источник: ChatGPT backend API  \n`;
    markdown += `> User-сообщений: ${stats.user}; ответов ChatGPT: ${stats.assistant}  \n`;
    markdown += `> Источников: ${stats.sources}; activity-шагов: ${stats.activity}; картинок/вложений: ${stats.images}  \n`;
    markdown += `> URL: ${location.href}  \n`;
    markdown += `> Экспортировано: ${exportedAt}\n\n---\n\n`;
    return { markdown: markdown + parts.join('\n---\n\n') + '\n', turnCount: parts.length, source: 'api' };
  }

  async function runChatGPTPopupExport(rawSettings) {
    if (popupExportRunning) {
      if (!document.getElementById(CHATGPT_EXPORT_OVERLAY_ID)) showChatGPTExportOverlay();
      return { success: false, message: 'Экспорт уже запущен' };
    }
    popupExportRunning = true;
    popupExportCancel = false;
    const settings = normalizeChatGPTExportSettings(rawSettings || {});
    const started = performance.now();
    const stats = { user: 0, assistant: 0, sources: 0, activity: 0, images: 0 };
    const parts = [];

    showChatGPTExportOverlay();
    try {
      assertPopupExportNotCancelled();
      updateChatGPTExportOverlay('Запрашиваю историю ChatGPT...', 'Шаг 1/3: полный JSON диалога');
      let apiBuilt = null;
      try {
        const apiData = await fetchChatGPTConversationJson();
        assertPopupExportNotCancelled();
        if (apiData) apiBuilt = buildChatGPTApiMarkdown(apiData, settings, stats);
      } catch (apiError) {
        log('popup_export.api_fallback', { err: apiError?.message || String(apiError) });
      }

      if (apiBuilt?.markdown && apiBuilt.turnCount > 0) {
        assertPopupExportNotCancelled();
        updateChatGPTExportOverlay('Собираю markdown...', 'Шаг 3/3: упаковка');
        const filename = `chatgpt-${safeFilenamePart(document.title || 'chat')}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.md`;
        const delivery = await deliverMarkdown(apiBuilt.markdown, filename, settings.__export.downloadFile);
        const elapsed = ((performance.now() - started) / 1000).toFixed(1);
        log('popup_export.done', {
          source: apiBuilt.source,
          turns: apiBuilt.turnCount,
          delivery,
          sources: stats.sources,
          activity: stats.activity,
          images: stats.images,
          elapsed,
        });
        showChatGPTExportTerminal('success',
          `Записей: ${apiBuilt.turnCount}; источников: ${stats.sources}; activity-шагов: ${stats.activity}\n` +
          (delivery === 'clipboard'
            ? 'Markdown скопирован в буфер обмена'
            : delivery === 'download-fallback'
              ? `Буфер обмена был недоступен, скачан файл: ${filename}`
          : `Файл: ${filename}`));
        return { success: true, message: 'Экспорт ChatGPT завершён' };
      }
      if (apiBuilt?.markdown) {
        log('popup_export.api_empty_fallback', { turns: apiBuilt.turnCount });
      }

      updateChatGPTExportOverlay('Сканирую сообщения ChatGPT...', 'Шаг 1/3: DOM fallback');
      await waitFor(() => document.querySelector('[data-message-author-role]'), 'ChatGPT messages', 8000, 200);
      const turns = chatgptConversationTurns();
      if (!turns.length) throw new Error('Сообщения ChatGPT не найдены на странице');

      for (let i = 0; i < turns.length; i++) {
        assertPopupExportNotCancelled();
        const turn = turns[i];
        const messageEl = extractMessageRoot(turn);
        const role = messageEl?.getAttribute?.('data-message-author-role') || 'message';
        if (role === 'user') stats.user++;
        if (role === 'assistant') stats.assistant++;
        try { turn.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (_) {}
        updateChatGPTExportOverlay('Извлекаю сообщения...', `Шаг 2/3: ${i + 1}/${turns.length} (${roleLabel(role)})`);
        await sleep(80);

        let md = `## ${roleLabel(role)}\n\n`;
        const text = extractMessageTextMarkdown(messageEl, role);
        const images = settings.includeImages ? extractImagesForExportTurn(turn) : [];
        if (text) md += `${text}\n`;
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
      const markdown = buildChatGPTExportHeader(turns.length, stats) + body + '\n';
      const filename = `chatgpt-${safeFilenamePart(document.title || 'chat')}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.md`;
      const delivery = await deliverMarkdown(markdown, filename, settings.__export.downloadFile);
      const elapsed = ((performance.now() - started) / 1000).toFixed(1);
      log('popup_export.done', {
        turns: turns.length,
        delivery,
        sources: stats.sources,
        activity: stats.activity,
        images: stats.images,
        elapsed,
      });
      showChatGPTExportTerminal('success',
        `Сообщений: ${turns.length}; источников: ${stats.sources}; картинок: ${stats.images}\n` +
        (delivery === 'clipboard'
          ? 'Markdown скопирован в буфер обмена'
          : delivery === 'download-fallback'
            ? `Буфер обмена был недоступен, скачан файл: ${filename}`
            : `Файл: ${filename}`));
      return { success: true, message: 'Экспорт ChatGPT завершён' };
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

  function isDisabled(el) {
    if (!el) return true;
    return !!el.disabled
      || el.hasAttribute('disabled')
      || el.getAttribute('aria-disabled') === 'true'
      || el.closest('[aria-disabled="true"]');
  }

  function composerBusySnapshot() {
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
    const busyNodes = Array.from(root.querySelectorAll(busySelectors)).filter(isVisible);
    const rootText = compactText(root.textContent).slice(0, 500);
    const busyText = /(?:uploading|loading|processing|attaching|загруз|обработ|прикреп|подождите|please wait)/i.test(rootText);
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
      textHead: rootText.slice(0, 160),
    };
  }

  function waitComposerReadyAfterPaste(id, timeoutMs = 120000) {
    const t0 = performance.now();
    return new Promise((resolve, reject) => {
      let done = false;
      let rafPending = false;
      let verifyingReady = false;
      let lastSig = '';
      const observer = new MutationObserver(scheduleCheck);
      const timer = setTimeout(() => {
        const snap = composerBusySnapshot();
        finish(null, new Error('chatgpt_composer_not_ready_after_paste: ' + JSON.stringify({
          sendVisible: snap.sendVisible,
          sendDisabled: snap.sendDisabled,
          composerDisabled: snap.composerDisabled,
          busyCount: snap.busyCount,
          busyText: snap.busyText,
        })));
      }, timeoutMs);

      function cleanup() {
        observer.disconnect();
        document.removeEventListener('input', scheduleCheck, true);
        document.removeEventListener('change', scheduleCheck, true);
        clearTimeout(timer);
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
        };
        log('composer.wait_after_paste', data);
        bridgeLog('gpt.composer.wait_after_paste', data, id, null);
      }
      function verifyReadyNextFrame(firstSnap) {
        if (verifyingReady) return;
        verifyingReady = true;
        requestAnimationFrame(() => {
          verifyingReady = false;
          const snap = composerBusySnapshot();
          if (!snap.ready) {
            emitWaitLog(snap);
            return;
          }
          log('composer.ready_after_paste', { waitedMs: Math.round(performance.now() - t0) });
          bridgeLog('gpt.composer.ready_after_paste', { waitedMs: Math.round(performance.now() - t0) }, id, null);
          finish(firstSnap);
        });
      }
      function checkNow() {
        if (done) return;
        const snap = composerBusySnapshot();
        if (snap.ready) verifyReadyNextFrame(snap);
        else emitWaitLog(snap);
      }
      function scheduleCheck() {
        if (done || rafPending) return;
        rafPending = true;
        requestAnimationFrame(() => {
          rafPending = false;
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
      scheduleCheck();
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
    const btn = await waitEnabledSendButton();
    btn.click();
    if (await waitSubmitAccepted()) return;
    // Fallback: полный pointer-chain.
    const again = findSendBtn();
    if (again) nativeMouseClick(again);
    if (await waitSubmitAccepted()) return;
    throw new Error('chatgpt_submit_failed: send click had no effect');
  }

  function waitEnabledSendButton(timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      let done = false;
      let rafPending = false;
      const observer = new MutationObserver(scheduleCheck);
      const timer = setTimeout(() => finish(null, new Error('timeout: enabled send button (composer non-empty)')), timeoutMs);
      function cleanup() {
        observer.disconnect();
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
        if (b && isVisible(b) && !isDisabled(b)) finish(b);
      }
      function scheduleCheck() {
        if (done || rafPending) return;
        rafPending = true;
        requestAnimationFrame(() => {
          rafPending = false;
          checkNow();
        });
      }
      observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['disabled', 'aria-disabled', 'data-testid', 'class'],
      });
      scheduleCheck();
    });
  }

  function waitSubmitAccepted(timeoutMs = 120000) {
    return new Promise(resolve => {
      let done = false;
      let rafPending = false;
      const observer = new MutationObserver(scheduleCheck);
      const timer = setTimeout(() => finish(false), timeoutMs);
      function cleanup() {
        observer.disconnect();
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
        // Успех: stop появился ИЛИ send исчез/стал неактивным (началась генерация).
        const send = findSendBtn();
        if (findStopBtn() || !send || !isVisible(send) || isDisabled(send)) finish(true);
      }
      function scheduleCheck() {
        if (done || rafPending) return;
        rafPending = true;
        requestAnimationFrame(() => {
          rafPending = false;
          checkNow();
        });
      }
      observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['disabled', 'aria-disabled', 'data-testid', 'class'],
      });
      scheduleCheck();
    });
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
  //   Активность · 2m 20s / «Думал на протяжении X» / Источники · N / ссылки
  //   + activity/tool steps (GitHub fetches, bash/python command snippets).
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
    const out = { links: [], activity_items: [], activity: null, thinking: [], chip_present: false, panel_opened: false };
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
    try {
      const job = await fetchComposeJob(id);
      const effortKey = resolveEffort(job.effort);
      const modelKey = resolveModel(job.model);
      await waitFor(() => findComposer(), 'composer (#prompt-textarea — логин?)', 20000);
      const okModel = await ensureModelSelected(modelKey);
      if (!okModel) throw new Error(`chatgpt_model_select_failed: не удалось выбрать модель ${modelDisplay(modelKey)}`);
      await ensureEffortSelected(effortKey);
      pasteIntoComposer(job.prompt);
      await waitComposerReadyAfterPaste(null);
      await clickSend();
      submitted = true;
      await removeComposeJob(id);
      log('compose.submitted', {
        id,
        model: modelKey,
        effort: effortKey,
        promptLen: job.prompt.length,
      });
    } catch (e) {
      log('compose.flow_err', { id, err: e?.message || String(e) });
    } finally {
      stopKeepAlive();
      if (submitted) await detachFocusEmulation(myTabId);
    }
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

    const composeId = getComposeId();
    if (composeId) {
      await runComposeHandoff(composeId, myTabId);
      return;
    }

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
    const keepTabAfterDone = job.options?.keepTab === true || job.options?.autoClose === false;
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
        await waitComposerReadyAfterPaste(id);
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
