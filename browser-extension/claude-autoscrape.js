// SC Browser Parser — claude.ai автоскрапинг.
//
// Триггер: вкладка открыта на claude.ai/new#sc=<requestId> (или
// claude.ai/chat/...#sc=<id> при cache-hit'е, когда background решит
// open в существующем шортcut'е). id — ключ в chrome.storage.local с
// payload'ом от background'а:
//   { requestId, jobId, commentsJobId, model, project, postProject,
//     adaptiveThinking, ytTabId, ytVideoId, ytTitle }
//
// Flow:
//   1. Polling http://127.0.0.1:53127/yt-status?id=<jobId>[&comments_id=<cid>]
//      — то же что в aistudio-autoscrape.
//   2. Если задана project — открываем «+ menu» (Add files button) →
//      hover/click «Add to project» (item с aria-haspopup="menu") → ждём
//      submenu → клик по project с textContent === wanted.
//   3. Открываем model dropdown (`[data-testid="model-selector-dropdown"]`),
//      кликаем radio/button с textContent === settings.claude_model.
//   4. Toggle Adaptive thinking (input role="switch") по флагу
//      adaptiveThinking. Закрываем dropdown (Escape / клик в body).
//   5. Paste промпта в `[data-testid="chat-input"]` — это ProseMirror
//      contenteditable, нужно через `document.execCommand('insertText')`
//      или beforeinput InputEvent.
//   6. Submit. После paste кнопка `[aria-label="Send message"]` появляется
//      в правом-нижнем. Кликаем; fallback Enter.
//
// Любая ошибка → red overlay (тот же стиль что aistudio) + sendMessage
// __sc_aistudio_pasted с ok:false (background маппит на error toast).

(function () {
  'use strict';

  const SC_ENDPOINT_BASE = 'http://127.0.0.1:53127';
  const POLL_TIMEOUT_MS  = 5 * 60 * 1000;
  const POLL_BASE_MS     = 2000;
  const POLL_MAX_MS      = 10000;
  const TAG = '[SC-CLAUDE]';

  // Дублируем log в скрытый DOM-узел #sc-claude-dbg-log — это позволяет
  // MCP browser получать ход выполнения через get_text без userScripts.
  // Идентичный паттерн использует youtube-content.js для своего dbg.
  function _dbgSink() {
    let n = document.getElementById('sc-claude-dbg-log');
    if (n && n.isConnected) return n;
    n = document.createElement('pre');
    n.id = 'sc-claude-dbg-log';
    n.style.cssText = 'position:fixed;left:-99999px;top:0;width:0;height:0;visibility:hidden;pointer-events:none;';
    (document.body || document.documentElement).appendChild(n);
    return n;
  }
  const log = (msg, data) => {
    try { console.log(TAG, msg, data || ''); } catch {}
    try {
      const t = (performance.now() / 1000).toFixed(3);
      const entry = `${t}s [${msg}] ` + (data == null ? '' : (typeof data === 'string' ? data : JSON.stringify(data)));
      const sink = _dbgSink();
      sink.textContent = (sink.textContent || '') + '\n' + entry;
    } catch {}
  };

  function readJobFromUrl() {
    const m = (location.hash || '').match(/sc=([\w]+)/);
    if (!m) return null;
    return new Promise(resolve => {
      const key = '__sc_claude_job_' + m[1];
      try {
        chrome.storage.local.get(key, raw => {
          // НЕ удаляем — background-side handleAistudioPasted читает этот
          // ключ чтобы найти ytTabId/ytVideoId и отправить финальный toast
          // на YT-вкладку (тот же канал что и aistudio, см. handleAistudioPasted).
          resolve(raw?.[key] || null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function waitFor(predicate, why, timeoutMs = 15000, intervalMs = 200) {
    const t0 = performance.now();
    while (true) {
      let v;
      try { v = predicate(); } catch (e) { v = null; }
      if (v) return v;
      if (performance.now() - t0 > timeoutMs) {
        throw new Error('timeout: ' + why);
      }
      await sleep(intervalMs);
    }
  }

  // ── overlay (как у aistudio-autoscrape — 32px pill, иконка + крест) ────
  function overlayIcon(kind) {
    if (kind === 'err') return '✗';
    if (kind === 'ok')  return '✓';
    return '⏳';
  }
  function makeOverlay(text, kind) {
    const id = 'sc-claude-overlay';
    let ov = document.getElementById(id);
    if (!ov) {
      ov = document.createElement('div');
      ov.id = id;
      ov.style.cssText = `
        position: fixed; right: 16px; top: 34px; z-index: 2147483647;
        height: 32px;
        box-sizing: border-box;
        padding: 0 4px 0 12px;
        border-radius: 16px;
        background: rgba(20, 20, 24, 0.94);
        border: 1px solid rgba(102, 126, 234, 0.55);
        color: #e9ecef;
        font: 13px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        box-shadow: 0 4px 12px rgba(0,0,0,0.45);
        backdrop-filter: blur(6px);
        max-width: 360px;
        display: flex;
        align-items: center;
        gap: 8px;
      `;
      document.body.appendChild(ov);
    }
    ov.style.borderColor = kind === 'err' ? '#c92a2a' : kind === 'ok' ? '#2b8a3e' : 'rgba(102, 126, 234, 0.55)';
    ov.innerHTML = '';
    const ic = document.createElement('span');
    ic.textContent = overlayIcon(kind);
    ic.style.cssText = 'flex: 0 0 auto; line-height: 1;';
    ov.appendChild(ic);
    const span = document.createElement('span');
    span.textContent = text;
    span.style.cssText = 'flex: 1 1 auto; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;';
    ov.appendChild(span);
    const close = document.createElement('button');
    close.textContent = '×';
    close.style.cssText = `
      flex: 0 0 auto;
      background: transparent; border: none;
      color: #a5a5a5; cursor: pointer;
      font: 16px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      padding: 0 4px; margin-left: 2px;
      opacity: 0.7; transition: opacity 0.12s;
    `;
    close.addEventListener('mouseenter', () => { close.style.opacity = '1'; });
    close.addEventListener('mouseleave', () => { close.style.opacity = '0.7'; });
    close.onclick = () => ov.remove();
    ov.appendChild(close);
    return ov;
  }
  function setOverlayText(text, kind) { makeOverlay(text, kind); }
  function fail(message, requestId) {
    log('fail: ' + message);
    setOverlayText('Ошибка: ' + message, 'err');
    if (requestId) {
      try {
        chrome.runtime.sendMessage({
          __sc_aistudio_pasted: true,
          requestId, ok: false, error: message,
        });
      } catch {}
    }
  }
  function done(requestId) {
    setOverlayText('Готово · отправлено в Claude', 'ok');
    setTimeout(() => document.getElementById('sc-claude-overlay')?.remove(), 4000);
    if (requestId) {
      try {
        chrome.runtime.sendMessage({
          __sc_aistudio_pasted: true,
          requestId, ok: true,
        });
      } catch {}
    }
  }

  // ── fetch cached file directly (тот же endpoint что aistudio) ──────────
  async function fetchCachedFile(filePath) {
    const u = new URL(SC_ENDPOINT_BASE + '/yt-fetch');
    u.searchParams.set('path', filePath);
    const r = await fetch(u.toString());
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error('cached fetch failed: ' + (e.error || r.status));
    }
    const data = await r.json();
    return data.text;
  }

  async function pollUntilReady(job) {
    if (job.cachedFilePath) {
      setOverlayText('Кэш-хит · читаю файл…');
      const text = await fetchCachedFile(job.cachedFilePath);
      let commentsText = null;
      if (job.cachedCommentsFilePath) {
        commentsText = await fetchCachedFile(job.cachedCommentsFilePath).catch(() => null);
      }
      return { transcript_text: text, comments_text: commentsText };
    }

    const t0 = performance.now();
    let delay = POLL_BASE_MS;
    while (performance.now() - t0 < POLL_TIMEOUT_MS) {
      let r;
      try {
        const u = new URL(SC_ENDPOINT_BASE + '/yt-status');
        u.searchParams.set('id', String(job.jobId));
        if (job.commentsJobId) u.searchParams.set('comments_id', String(job.commentsJobId));
        r = await fetch(u.toString());
      } catch (e) {
        throw new Error('sc-desktop недоступен: ' + (e.message || e));
      }
      if (!r.ok) throw new Error('yt-status HTTP ' + r.status);
      const data = await r.json();
      if (data.error || data.comments_error) {
        throw new Error(data.error || data.comments_error);
      }
      if (data.transcript_text) return data;

      const stage = data.status === 'running' ? 'идёт транскрипция' :
                    data.status === 'done'    ? 'жду комменты'      : data.status;
      setOverlayText(`Ожидание sc-desktop · ${stage}…`);
      await sleep(delay);
      delay = Math.min(POLL_MAX_MS, Math.round(delay * 1.4));
    }
    throw new Error('таймаут ожидания sc-desktop (>5 мин)');
  }

  // ── DOM helpers для claude.ai (Radix submenu trigger через pointerenter) ─

  function nodeText(el) {
    return (el?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  // Открыть «+ menu» и удерживать открытым на всё время manipulation.
  async function openPlusMenu() {
    const btn = await waitFor(
      () => document.querySelector('[aria-label="Add files, connectors, and more"]'),
      'plus-button',
      10000,
    );
    btn.click();
    // Ждём появления dropdown menu (Radix: контейнер с role="menu"
    // или div с z-dropdown'ом и menuitems).
    await waitFor(() => {
      const items = document.querySelectorAll('div[role="menuitem"]');
      return items.length >= 3 ? true : null;
    }, 'plus-menu-opened', 5000);
  }

  // В claude.ai (текущая версия base-ui, ноябрь 2026) submenu trigger
  // открывается **по click**, не по hover. Это противоположно классическому
  // Radix паттерну. Определено детерминированно через MCP browser:
  // mcp__browser__click на trigger → submenu открылся, hover/pointerenter →
  // submenu НЕ открылся.
  //
  // Почему .click() работает: trigger menuitem обрабатывает click как
  // "open submenu" action. Это упрощённое поведение в base-ui v2+.
  // Запасной fallback с pointer events + ArrowRight оставлен на случай
  // ещё одного редизайна.
  async function openSubmenu(menuItemEl) {
    menuItemEl.focus?.();
    menuItemEl.click();
    // Ждём раскрытия — у trigger меняется aria-expanded на true ИЛИ
    // появляются новые menuitem'ы в overlay.
    await waitFor(
      () => menuItemEl.getAttribute('aria-expanded') === 'true' ||
            document.querySelectorAll('div[role="menuitem"]').length > 7,
      'submenu-expanded',
      2000,
    ).catch(() => {});
    // Если click не сработал — пробуем pointer events + ArrowRight как fallback.
    if (menuItemEl.getAttribute('aria-expanded') !== 'true') {
      const opts = { bubbles: true, cancelable: true, view: window };
      const r = menuItemEl.getBoundingClientRect();
      const clientX = r.left + r.width / 2;
      const clientY = r.top + r.height / 2;
      const pe = (type) => new PointerEvent(type, { ...opts, pointerType: 'mouse', clientX, clientY });
      const me = (type) => new MouseEvent(type, { ...opts, clientX, clientY });
      menuItemEl.dispatchEvent(pe('pointerover'));
      menuItemEl.dispatchEvent(me('mouseover'));
      menuItemEl.dispatchEvent(pe('pointerenter'));
      menuItemEl.dispatchEvent(me('mouseenter'));
      const kev = (type) => new KeyboardEvent(type, {
        key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, which: 39,
        bubbles: true, cancelable: true,
      });
      menuItemEl.dispatchEvent(kev('keydown'));
      await sleep(300);
    }
    await sleep(200);
  }

  async function selectProject(projectName) {
    if (!projectName || !projectName.trim()) {
      log('no project — skip');
      return;
    }
    const wanted = projectName.trim();

    await openPlusMenu();

    // Ищем menuitem «Add to project». В текущей версии base-ui (claude.ai
    // 2026-05) у submenu trigger'а НЕ ставится aria-haspopup="menu" —
    // поиск только по textContent. Если в будущих версиях вернут aria —
    // первый запрос отработает.
    const allMenuItems = Array.from(document.querySelectorAll('div[role="menuitem"]'));
    log('selectProject.menuitems', { count: allMenuItems.length, texts: allMenuItems.slice(0, 10).map(el => nodeText(el).slice(0, 30)) });
    const addToProj = allMenuItems.find(el => nodeText(el).startsWith('Add to project'));
    if (!addToProj) throw new Error('«Add to project» не найден в + меню');
    log('selectProject.found_trigger', { id: addToProj.id, hasPopup: addToProj.getAttribute('aria-haspopup'), expanded: addToProj.getAttribute('aria-expanded') });

    await openSubmenu(addToProj);
    log('selectProject.after_openSubmenu', { expanded: addToProj.getAttribute('aria-expanded'), totalItems: document.querySelectorAll('div[role="menuitem"]').length });

    // Submenu items на claude.ai РЕНДЕРЯТСЯ БЕЗ role="menuitem" — это
    // обычные `<div>` внутри submenu-portal'а. Project entries имеют
    // структуру: имя проекта + имя владельца на двух строках (flex без
    // \n в textContent — nodeText склеит).
    //
    // Подход: ищем submenu-контейнер (последний открытый dropdown в overlay'е),
    // обходим его прямых детей, фильтруем по textContent.
    const wantedLower = wanted.toLowerCase();
    const opt = await waitFor(() => {
      // Все z-dropdown'ы на странице. Submenu — это второй (последний)
      // z-dropdown который появился после клика на «Add to project».
      const dropdowns = Array.from(document.querySelectorAll('div.z-dropdown'));
      if (dropdowns.length < 2) return null;
      // Главный dropdown содержит "Add to project" menuitem — это parent.
      // Submenu — тот в котором НЕТ "Add to project".
      let submenu = null;
      for (const dd of dropdowns) {
        const t = nodeText(dd).toLowerCase();
        if (!t.includes('add to project') && t.includes(wantedLower.split(' ')[0])) {
          submenu = dd;
          break;
        }
      }
      if (!submenu) {
        // Fallback: возьмём последний dropdown.
        submenu = dropdowns[dropdowns.length - 1];
      }
      // Идём по всем потомкам submenu, ищем элемент с textContent === имя проекта.
      // Кликабельный элемент — самый глубокий div который содержит ИМЕННО эту
      // строку текста и не содержит ничего дополнительного кроме owner-имени.
      const candidates = submenu.querySelectorAll('div');
      let bestMatch = null;
      for (const div of candidates) {
        const txt = nodeText(div).toLowerCase();
        // Точное совпадение по startsWith означает: первая строка = имя
        // проекта. Например «пересказ ютуб fedor revin» начинается с
        // «пересказ ютуб».
        if (txt.startsWith(wantedLower) && !txt.startsWith('start a new project')) {
          // Лучший кандидат — самый высокий по DOM (родитель owner-блока).
          // Если уже нашли — заменяем только если новый кандидат ВЫШЕ
          // (родитель текущего).
          if (!bestMatch || bestMatch.contains(div)) bestMatch = div;
        }
      }
      return bestMatch;
    }, `project «${wanted}»`, 4000).catch(() => null);
    log('selectProject.option_search', { found: !!opt, optText: opt ? nodeText(opt).slice(0, 60) : null });

    if (!opt) {
      // Соберём доступные имена для error-сообщения.
      const available = Array.from(document.querySelectorAll('div[role="menuitem"]'))
        .map(it => (it.textContent || '').trim().split('\n')[0].trim())
        .filter(t => t && t !== 'Add to project' && t !== 'Start a new project' && !t.startsWith('Add files') && !t.startsWith('Take a'))
        .join(', ');
      // Закроем меню
      document.body.click();
      throw new Error(`проект «${wanted}» не найден. Доступные: ${available || '—'}`);
    }
    log('selectProject.clicking_option', { text: nodeText(opt).slice(0, 60) });
    opt.click();

    // ВАЖНО: клик по project в claude.ai НЕ меняет URL (остаётся /new),
    // вместо этого рядом с input'ом появляется button с
    // aria-label="Project: <имя>" — это и есть chip-индикатор. Ждём его
    // прежде чем paste+submit, иначе сообщение уйдёт без project'а.
    const chip = await waitFor(() => {
      return document.querySelector(`button[aria-label="Project: ${wanted}"]`);
    }, `project-chip «${wanted}»`, 5000).catch(() => null);

    if (!chip) {
      log('selectProject.chip_not_detected', { url: location.href });
      throw new Error(`Не получилось активировать проект «${wanted}» — chip не появился. Проверь имя проекта в popup'е расширения.`);
    } else {
      log('selectProject.chip_appeared', { aria: chip.getAttribute('aria-label') });
    }
    // Закрываем меню если ещё открыто (на всякий случай).
    await sleep(200);
    if (document.querySelector('div[role="menuitem"]')) {
      document.body.click();
      await sleep(100);
    }
  }

  // ── Model selector + Adaptive thinking ─────────────────────────────────

  async function ensureModelAndThinking(modelTitle, adaptiveThinking) {
    const trigger = await waitFor(
      () => document.querySelector('[data-testid="model-selector-dropdown"]'),
      'model-selector-trigger',
      5000,
    );
    const currentTxt = nodeText(trigger);
    // currentTxt = "Opus 4.7Adaptive" если adaptive ON, "Opus 4.7" иначе.
    // Нам нужно знать только начало (имя модели).
    const currentModel = currentTxt.replace(/Adaptive$/, '').trim();

    // Открываем dropdown
    trigger.click();
    await waitFor(() => {
      // model dropdown содержит «More models» как menuitem — это якорь
      return Array.from(document.querySelectorAll('div[role="menuitem"]'))
        .some(el => nodeText(el) === 'More models');
    }, 'model-menu-opened', 5000);

    // Найти все радио-кнопки моделей: top-level menuitems в этом dropdown'е
    // (не submenu-triggers). Имена начинаются с заголовка («Opus 4.7»,
    // «Sonnet 4.6», «Haiku 4.5») и могут содержать description'ы.
    if (currentModel !== modelTitle) {
      const modelItem = Array.from(document.querySelectorAll('div[role="menuitem"]'))
        .find(el => {
          const t = nodeText(el);
          // textContent выглядит как «Opus 4.7Most capable for ambitious work»
          return t.startsWith(modelTitle) && t !== modelTitle + 'Adaptive';
        });
      if (!modelItem) {
        document.body.click();
        throw new Error(`модель «${modelTitle}» не найдена в dropdown'е`);
      }
      modelItem.click();
      // Клик по модели Radix'е закрывает меню — открываем заново для
      // toggle thinking.
      await sleep(300);
      trigger.click();
      await waitFor(() => {
        return Array.from(document.querySelectorAll('div[role="menuitem"]'))
          .some(el => nodeText(el) === 'More models');
      }, 'model-menu-reopened', 3000);
    }

    // Adaptive thinking toggle. Switch может быть либо самим input'ом,
    // либо menuitem'ом обёрткой со switch внутри. Берём checkbox по
    // aria-label.
    const thinkingInput = document.querySelector('input[type="checkbox"][aria-label="Adaptive thinking"], input[type="checkbox"][aria-label*="thinking" i], input[type="checkbox"][aria-label*="Extended" i]');
    if (thinkingInput) {
      const isOn = thinkingInput.checked || thinkingInput.getAttribute('aria-checked') === 'true';
      if (isOn !== !!adaptiveThinking) {
        // Кликаем по обёртке (label/switch-track), чтобы Radix корректно
        // обработал — клик по самому input'у иногда блокируется.
        const sw = thinkingInput.closest('label, [role="switch"], [role="menuitem"]') || thinkingInput;
        sw.click();
        await sleep(150);
      }
    }

    // Закрыть dropdown (клик в body / Escape).
    document.body.click();
    await sleep(200);
  }

  // ── Paste в ProseMirror contenteditable ────────────────────────────────

  function pasteToProseMirror(editor, text) {
    editor.focus();
    // Выделяем всё (для случая если юзер начал печатать) и заменяем.
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('delete', false);
    // Вставляем как plain text — ProseMirror обработает через
    // beforeinput с inputType='insertText'.
    document.execCommand('insertText', false, text);
  }

  async function pastePromptAndSubmit(text) {
    const editor = await waitFor(
      () => document.querySelector('[data-testid="chat-input"]'),
      'chat-input',
      10000,
    );
    pasteToProseMirror(editor, text);
    await sleep(300);

    // Submit button: появляется в правом-нижнем углу, aria-label = «Send message».
    const sendBtn = await waitFor(() => {
      // Иногда называется «Reply to Claude…» — главное aria-label с «Send».
      return document.querySelector('button[aria-label*="Send"]')
          || document.querySelector('button[type="submit"][aria-label*="message" i]');
    }, 'send-button', 8000).catch(() => null);

    if (sendBtn && !sendBtn.disabled) {
      sendBtn.click();
      return;
    }

    // Fallback: Cmd/Ctrl+Enter в editor.
    log('send-button not found, fallback Cmd+Enter');
    editor.focus();
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', ctrlKey: true, bubbles: true }));
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', metaKey: true, bubbles: true }));
  }

  // ── main ───────────────────────────────────────────────────────────────

  async function main() {
    const job = await readJobFromUrl();
    if (!job) return;
    const requestId = job.requestId;
    try { history.replaceState(null, '', location.pathname + location.search); } catch {}

    log('claude-autoscrape job', { jobId: job.jobId, hasProject: !!job.project, model: job.model });
    setOverlayText('Получено задание · жду транскрипт от sc-desktop…');

    try {
      const data = await pollUntilReady(job);
      const text = data.transcript_text + (data.comments_text ? '\n\n' + data.comments_text : '');

      // Ждём готовности UI (textarea появляется ~300-800ms после navigate).
      await waitFor(() => document.querySelector('[data-testid="chat-input"]'),
                    'claude-ready', 15000);

      // 1. Project — ОБЯЗАТЕЛЬНО первым: если selectProject открывает
      // submenu и кликает, claude переходит в `/project/<id>/new`,
      // что заново монтирует chat-input. Selectors остаются те же, но
      // после navigate нужно подождать.
      if (job.project) {
        setOverlayText('Выбираю проект…');
        await selectProject(job.project);
        // Дождёмся новой инициализации UI после возможного navigate.
        await sleep(800);
        await waitFor(() => document.querySelector('[data-testid="chat-input"]'),
                      'claude-ready-after-project', 8000);
      }

      // 2. Model + Adaptive thinking
      setOverlayText('Настройка модели…');
      await ensureModelAndThinking(job.model, job.adaptiveThinking);

      // 3. Paste + Submit
      setOverlayText('Вставляю транскрипт…');
      await pastePromptAndSubmit(text);

      done(requestId);
    } catch (e) {
      fail(e.message || String(e), requestId);
    }
  }

  // ── Universal toast renderer (тот же что на YT/AI Studio) ────────────
  // sc-desktop background шлёт __sc_btn_state на claude.ai вкладки —
  // юзер видит финальный «✓ Готово / ✗ Ошибка» в той же стилистике.
  // Идентичный код как в aistudio-autoscrape::renderToasts.
  const TOAST_HOST_ID_CL = 'sc-claude-toast-host';
  const toastMap = new Map();
  const toastTimers = new Map();

  function getOrCreateToastHost() {
    let host = document.getElementById(TOAST_HOST_ID_CL);
    if (host && host.isConnected) return host;
    host = document.createElement('div');
    host.id = TOAST_HOST_ID_CL;
    host.style.cssText = `
      position: fixed; top: 70px; right: 16px; z-index: 2147483000;
      display: flex; flex-direction: column; gap: 8px;
      pointer-events: none; max-width: 360px;
    `;
    document.body.appendChild(host);
    if (!document.getElementById('sc-claude-toast-style')) {
      const s = document.createElement('style');
      s.id = 'sc-claude-toast-style';
      s.textContent = `@keyframes sc-toast-in-cl { from {opacity:0;transform:translateX(20px)} to {opacity:1;transform:translateX(0)} }`;
      document.head.appendChild(s);
    }
    return host;
  }

  function toastIcon(entry) {
    switch (entry.state) {
      case 'sending':      return '⏳';
      case 'searching':    return '🔎';
      case 'transcribing': return (entry.engine === 'assemblyai') ? '🎙' : '🤖';
      case 'working':      return '⏳';
      case 'opening':      return '🤖';
      case 'done':         return '✓';
      case 'pasted':       return '🤖✓';
      case 'error':        return '✗';
      default:             return '•';
    }
  }

  function renderToasts() {
    const host = getOrCreateToastHost();
    if (!host) return;
    const existing = new Map();
    for (const node of host.querySelectorAll('[data-sc-toast-vid]')) {
      existing.set(node.dataset.scToastVid, node);
    }
    const wantedIds = new Set(toastMap.keys());
    for (const [vid, node] of existing) {
      if (!wantedIds.has(vid)) node.remove();
    }
    for (const [vid, entry] of toastMap) {
      let node = existing.get(vid);
      if (!node) {
        node = document.createElement('div');
        node.dataset.scToastVid = vid;
        node.style.cssText = `
          height: 32px;
          box-sizing: border-box;
          padding: 0 4px 0 12px;
          border-radius: 16px;
          background: rgba(20, 20, 24, 0.94);
          border: 1px solid rgba(102, 126, 234, 0.55);
          color: #e9ecef;
          font: 13px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          box-shadow: 0 4px 12px rgba(0,0,0,0.45);
          backdrop-filter: blur(6px);
          pointer-events: auto;
          display: flex;
          align-items: center;
          gap: 8px;
          animation: sc-toast-in-cl 0.18s ease-out;
          max-width: 360px;
        `;
        const ic = document.createElement('span');
        ic.dataset.scToastIcon = '1';
        ic.style.cssText = 'flex: 0 0 auto; line-height: 1;';
        const tt = document.createElement('span');
        tt.dataset.scToastTitle = '1';
        tt.style.cssText = `flex: 1 1 auto; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;`;
        const cls = document.createElement('button');
        cls.dataset.scToastClose = '1';
        cls.textContent = '×';
        cls.style.cssText = `
          flex: 0 0 auto;
          background: transparent; border: none;
          color: #a5a5a5; cursor: pointer;
          font: 16px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          padding: 0 4px; margin-left: 2px;
          opacity: 0.7; transition: opacity 0.12s;
        `;
        cls.addEventListener('mouseenter', () => { cls.style.opacity = '1'; });
        cls.addEventListener('mouseleave', () => { cls.style.opacity = '0.7'; });
        cls.addEventListener('click', e => {
          e.stopPropagation();
          toastMap.delete(vid);
          const t = toastTimers.get(vid);
          if (t) { clearTimeout(t); toastTimers.delete(vid); }
          renderToasts();
        });
        node.appendChild(ic);
        node.appendChild(tt);
        node.appendChild(cls);
        host.appendChild(node);
      }
      node.querySelector('[data-sc-toast-icon]').textContent = toastIcon(entry);
      node.querySelector('[data-sc-toast-title]').textContent = entry.title || `Видео ${vid}`;
      const errSuffix = entry.state === 'error' && entry.error ? ' — ' + entry.error : '';
      node.title = (entry.title || vid) + errSuffix;
      const borderByState = { done: '#2b8a3e', pasted: '#2b8a3e', error: '#c92a2a' };
      node.style.borderColor = borderByState[entry.state] || 'rgba(102, 126, 234, 0.55)';
    }
  }

  function setToast(videoId, state, opts = {}) {
    if (!videoId) return;
    const prev = toastMap.get(videoId) || {};
    if (state === 'idle') {
      toastMap.delete(videoId);
      const t = toastTimers.get(videoId);
      if (t) { clearTimeout(t); toastTimers.delete(videoId); }
    } else {
      const title = opts.title != null ? opts.title : prev.title;
      const engine = opts.engine != null ? opts.engine : prev.engine;
      toastMap.set(videoId, { state, engine, error: opts.error, title });
      const t = toastTimers.get(videoId);
      if (t) clearTimeout(t);
      if (state === 'done' || state === 'error' || state === 'pasted') {
        const ttl = state === 'error' ? 4000 : (state === 'pasted' ? 4500 : 3000);
        const id = setTimeout(() => {
          toastTimers.delete(videoId);
          toastMap.delete(videoId);
          renderToasts();
        }, ttl);
        toastTimers.set(videoId, id);
      }
    }
    renderToasts();
  }

  try {
    chrome.runtime.onMessage.addListener((req) => {
      if (!req || req.__sc_btn_state !== true) return;
      const vid = req.videoId;
      if (!vid) return;
      const isFinal = (req.state === 'pasted' || req.state === 'done' || req.state === 'error');
      if (!isFinal) return;
      setToast(vid, req.state, { engine: req.engine, error: req.error, title: req.title });
    });
  } catch {}

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main, { once: true });
  } else {
    main();
  }
})();
