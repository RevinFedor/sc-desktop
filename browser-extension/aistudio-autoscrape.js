// SC Browser Parser — Gemini Studio автоскрапинг.
//
// Триггер: вкладка открыта на aistudio.google.com/prompts/new_chat#sc=<id>.
// id — ключ записи в chrome.storage.local, в которой лежит:
//   { requestId, jobId, commentsJobId, modelTitle, systemInstruction, ts }
// Эту запись клал youtube-content.js перед открытием вкладки.
//
// Flow:
//   1. Polling http://127.0.0.1:53127/yt-status?id=<jobId>[&comments_id=<cid>]
//      Пока transcriptReady и (если ждём комменты) commentsReady — крутим
//      polling раз в 2с с экспоненциальным backoff'ом (макс 10с) до 5 минут.
//   2. Выбор модели: ищем button.model-selector-card, читаем .title.
//      Если != settings.modelTitle → открываем dropdown и кликаем нужную.
//   3. System instructions: клик на data-test-system-instructions-card,
//      ждём textarea с placeholder «Optional tone and style…», setValue,
//      Close panel.
//   4. Paste промпта в textarea (placeholder «Start typing…») и жмём Run.
//
// Любая ошибка → red overlay со ссылкой «закрыть». В консоль и в NMH-лог
// идёт detail. Юзер не остаётся «в вакууме».

(function () {
  'use strict';

  const SC_ENDPOINT_BASE = 'http://127.0.0.1:53127';
  const POLL_TIMEOUT_MS  = 5 * 60 * 1000;
  const POLL_BASE_MS     = 2000;
  const POLL_MAX_MS      = 10000;
  const TAG = '[SC-AIST]';

  // ── helpers ────────────────────────────────────────────────────────────

  const log = (msg, data) => {
    try { console.log(TAG, msg, data || ''); } catch {}
    try {
      // logger.js экспонирует window.__AISE_LOGGER__ (а не __aise_log — это
      // старое имя, которого НЕТ; из-за него все autoscrape-логи годами шли
      // только в console и не доходили до NMH-файла → при отладке «просто
      // пусто», ноль следов. Теперь пишем в реальный logger → exporter-*.log).
      const L = (typeof window !== 'undefined') && window.__AISE_LOGGER__;
      if (L && typeof L.info === 'function') L.info('sc-autoscrape', msg, data || undefined);
    } catch {}
  };

  function readJobFromUrl() {
    const m = (location.hash || '').match(/sc=([\w]+)/);
    if (!m) return null;
    return new Promise(resolve => {
      const key = '__sc_aistudio_job_' + m[1];
      try {
        chrome.storage.local.get(key, raw => {
          const job = raw?.[key] || null;
          // НЕ удаляем сразу: background-side handler __sc_aistudio_pasted
          // читает этот же key чтобы найти ytTabId/ytVideoId и отправить
          // финальный toast на YT-вкладку. После done()/fail() background
          // сам подчищает запись. Защита от двойного запуска при F5 —
          // мы сразу же затираем `#sc=…` из location.hash ниже.
          resolve(job);
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

  // Native React/Angular value setter — нужен и для textarea, и для contenteditable.
  function setReactValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ── overlay (single shared) ────────────────────────────────────────────
  //
  // Промежуточные сообщения autoscrape («жду транскрипт…», «вставляю…»).
  // Визуально идентичен тостам из renderToasts: 32px pill, иконка + текст
  // + крест. Стоит в отдельном host'е (#sc-aist-overlay) чуть выше тостов,
  // чтобы не накладываться (top:34 vs top:70 для toast-host).
  function overlayIcon(kind) {
    if (kind === 'err') return '✗';
    if (kind === 'ok')  return '✓';
    return '⏳';
  }

  function makeOverlay(text, kind) {
    const id = 'sc-aist-overlay';
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
    // Иконка слева (как у тостов)
    const ic = document.createElement('span');
    ic.textContent = overlayIcon(kind);
    ic.style.cssText = 'flex: 0 0 auto; line-height: 1;';
    ov.appendChild(ic);
    // Текст с ellipsis (для длинных stage-сообщений)
    const span = document.createElement('span');
    span.textContent = text;
    span.style.cssText = 'flex: 1 1 auto; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;';
    ov.appendChild(span);
    // Крест-закрытие справа (как у тостов)
    const close = document.createElement('button');
    close.textContent = '×';
    close.style.cssText = `
      flex: 0 0 auto;
      background: transparent;
      border: none;
      color: #a5a5a5;
      cursor: pointer;
      font: 16px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      padding: 0 4px;
      margin-left: 2px;
      opacity: 0.7;
      transition: opacity 0.12s;
    `;
    close.addEventListener('mouseenter', () => { close.style.opacity = '1'; });
    close.addEventListener('mouseleave', () => { close.style.opacity = '0.7'; });
    close.onclick = () => ov.remove();
    ov.appendChild(close);
    return ov;
  }
  function setOverlayText(text, kind) { makeOverlay(text, kind); }
  // requestId сюда прокидывается из main() — нужен чтобы background мог
  // найти ytTabId/ytVideoId и отправить финальный toast на YT-вкладку.
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
    setOverlayText('Готово · вставлено в Gemini Studio', 'ok');
    setTimeout(() => document.getElementById('sc-aist-overlay')?.remove(), 4000);
    if (requestId) {
      try {
        chrome.runtime.sendMessage({
          __sc_aistudio_pasted: true,
          requestId, ok: true,
        }, () => {
          // Лог через storage чтобы видеть достиг ли месседж SW.
          const err = chrome.runtime.lastError?.message || null;
          try {
            chrome.storage.local.get(['__sc_ai_dbg'], (raw) => {
              const buf = Array.isArray(raw?.__sc_ai_dbg) ? raw.__sc_ai_dbg : [];
              buf.push(`${(Date.now()/1000).toFixed(3)}s [autoscrape.done.sent] requestId=${requestId} err=${err || 'null'}`);
              if (buf.length > 50) buf.splice(0, buf.length - 50);
              chrome.storage.local.set({ __sc_ai_dbg: buf });
            });
          } catch {}
        });
      } catch (e) {
        log('autoscrape.done.send THREW: ' + (e?.message || e));
      }
    }
  }

  // ── fetch cached file directly ─────────────────────────────────────────

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

  // ── poll backend ───────────────────────────────────────────────────────

  async function pollUntilReady(job) {
    // Cache-hit fast path: транскрипт уже на диске на момент клика.
    // Не polls'им, читаем напрямую.
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

  // ── model selector ─────────────────────────────────────────────────────
  //
  // Делегирует в window.scAistudio.ensureModel — единая точка работы с DOM
  // AI Studio живёт в aistudio-core.js. См. fact-aistudio-mcp.md.
  async function ensureModel(modelTitle) {
    if (!window.scAistudio) throw new Error('scAistudio API not loaded');
    return window.scAistudio.ensureModel(modelTitle);
  }

  // ── system instructions ────────────────────────────────────────────────

  // presetName = НАЗВАНИЕ сохранённого пресета (как в Title-input). Gemini
  // Studio хранит пресеты в LocalStorage и показывает их mat-select'ом в
  // самом верху панели System instructions. Открываем dropdown, ищем option
  // с точным textContent, кликаем. Если такого пресета нет — это explicit
  // user-error (юзер вводил название несуществующего пресета), бросаем.
  //
  // Спец-значение: presetName === '' (пустая строка через post-flow) —
  // выбираем option `+ Create new instruction`, что эквивалентно «сбросить
  // в пустую инструкцию». Используется в resetSystemInstructionAfterRun
  // когда у юзера в popup'е поле «Post-prompt» оставлено пустым.
  //
  // skipIfEmpty=true (legacy для pre-Run flow): пустое имя = skip целиком,
  // ничего не делаем. Так раньше работал основной путь.
  //
  // Делегирует в window.scAistudio.setSystemInstruction.
  async function setSystemInstruction(presetName, opts = {}) {
    if (!window.scAistudio) throw new Error('scAistudio API not loaded');
    return window.scAistudio.setSystemInstruction(presetName, opts);
  }

  // Post-Run сброс. Вызывается после успешного pastePromptAndRun, чтобы
  // наш sys-prompt не оставался активным для будущих сообщений юзера в
  // той же вкладке. Если пресет = '' → выбираем `+ Create new instruction`
  // (пустая инструкция). Если задано имя → переключаем на него.
  //
  // Ошибки тут НЕ валят весь flow (`done` уже отрисуется), но фиксируются
  // в overlay'е как warning. Run уже нажат, видео ушло в Gemini — отказ
  // сброса максимум приведёт к тому, что юзер увидит наш sys-prompt активным
  // и нажмёт сам.
  async function resetSystemInstructionAfterRun(postPresetName) {
    try {
      // Защитимся от ситуации когда панель открыта другим mat-select'ом
      // (run-кнопка фокусом дёргает разные элементы).
      await sleep(400);
      await setSystemInstruction(postPresetName || '', { skipIfEmpty: false });
      log('post-run system-instruction reset done', { to: postPresetName || '+ Create new instruction' });
    } catch (e) {
      log('post-run reset FAILED (non-fatal): ' + (e?.message || e));
      // Не throw — пусть done() сработает.
    }
  }

  // ── paste prompt + run ────────────────────────────────────────────────
  //
  // Делегирует в window.scAistudio.pastePromptAndRun.
  async function pastePromptAndRun(text) {
    if (!window.scAistudio) throw new Error('scAistudio API not loaded');
    return window.scAistudio.pastePromptAndRun(text);
  }

  // ── focus-emulation (debugger) для скрытой вкладки ─────────────────────
  //
  // Вкладка autoscrape открыта `active:false` (фон). В скрытой вкладке Blink
  // ставит rAF на паузу → Angular change-detection заморожен → Stop/Run не
  // переключаются и ms-text-chunk не рендерятся (см.
  // fact-aistudio-mcp.md::Hidden-tab strategy). Без этого waitForCompletion
  // не увидит завершения и вернётся преждевременно → post-run переключение
  // модели снова попадёт в середину генерации.
  //
  // MCP-путь (aistudio-mcp.js) лечит это `attachFocusEmulation` через
  // chrome.debugger. background.js уже умеет attach/detach по сообщению
  // `__sc_debugger_attach`/`__sc_debugger_detach` к ВКЛАДКЕ-ОТПРАВИТЕЛЮ —
  // дёргаем его прямо из CS, без правок background.js. UX-cost — жёлтая
  // полоса «расширение начало отладку» на время генерации; detach в конце
  // её убирает (тот же компромисс что у MCP-флоу).
  function requestFocusAttach() {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ __sc_debugger_attach: true }, (r) => {
          const lerr = chrome.runtime.lastError;
          resolve(!lerr && r && r.ok !== false);
        });
      } catch { resolve(false); }
    });
  }
  function requestFocusDetach() {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ __sc_debugger_detach: true }, () => {
          void chrome.runtime.lastError; resolve(true);
        });
      } catch { resolve(true); }
    });
  }

  // ── wait for completion + retry на backend-error ───────────────────────
  //
  // Делегирует в window.scAistudio.waitForCompletion (Stop→Run transition).
  // При транзиентном "AI Studio backend error" / "permission denied" кликает
  // sparkle «Rerun this turn» и ждёт заново — ровно как aistudio-mcp.js::runJob
  // (MAX_RETRIES=2). Раньше autoscrape вообще не ждал завершения и не
  // ретраил — клик Run и сразу done(), поэтому первый же permission-denied
  // оставался на экране, а юзер чинил вручную нажатием sparkle.
  //
  // Не-DR модели (Flash/Pro для пересказа видео) укладываются в 5 минут.
  // Если когда-нибудь сюда прилетит DR-модель — таймаут можно поднять, но в
  // autoscrape-флоу таких нет (DR идёт через MCP-канал).
  async function waitForCompletionWithRetry() {
    if (!window.scAistudio) throw new Error('scAistudio API not loaded');
    const api = window.scAistudio;
    const TIMEOUT_MS = 5 * 60 * 1000;
    const MAX_RETRIES = 2;
    let attempt = 0;
    while (true) {
      try {
        await api.waitForCompletion({
          timeoutMs: TIMEOUT_MS,
          // На ретрае grace: старый error-turn ещё в DOM пока rerun не заменил
          // его новой генерацией (см. fact-aistudio-mcp.md::stale-error race).
          ignoreStaleErrorMs: attempt > 0 ? 6000 : 0,
          onProgress: (info) => {
            // Лёгкий live-индикатор в overlay'е: «генерация · 12с».
            if (info && info.hasStop) {
              setOverlayText(`Gemini отвечает · ${info.elapsedSec}с…`);
            }
          },
        });
        log('autoscrape.completion_ok', { attempt });
        return;
      } catch (e) {
        const msg = String(e?.message || e);
        const transient = /backend error|permission denied|internal error|Произошла внутренняя ошибка/i.test(msg);
        if (transient && attempt < MAX_RETRIES) {
          attempt += 1;
          log('autoscrape.backend_error_retry', { attempt, err: msg.slice(0, 120) });
          setOverlayText(`Сбой Gemini · повтор ${attempt}/${MAX_RETRIES}…`);
          try {
            await api.rerunLastTurn();
          } catch (rrErr) {
            log('autoscrape.rerun_failed: ' + (rrErr?.message || rrErr));
            throw e; // оригинальная ошибка — sparkle не нашёлся/не нажался
          }
          await sleep(1500); // дать Studio сменить DOM (Stop появится снова)
          continue;
        }
        throw e;
      }
    }
  }

  // ── main ───────────────────────────────────────────────────────────────

  async function main() {
    const job = await readJobFromUrl();
    if (!job) return; // не наш kick — обычное открытие AI Studio
    const requestId = job.requestId;
    // Затираем #sc=<id> в URL'е сразу — F5 не должен пере-запустить flow
    // (мы оставили запись в storage для background'а, но защищаемся от
    // повторного чтения через хэш).
    try { history.replaceState(null, '', location.pathname + location.search); } catch {}

    log('autoscrape job loaded', {
      jobId: job.jobId, commentsJobId: job.commentsJobId,
      hasInstr: !!job.systemInstruction,
      hasPostInstr: typeof job.postSystemInstruction === 'string',
      postModel: job.postModelTitle || '(не менять)',
    });
    setOverlayText('Получено задание · жду транскрипт от sc-desktop…');

    try {
      const data = await pollUntilReady(job);
      const text = data.transcript_text + (data.comments_text ? '\n\n' + data.comments_text : '');

      // Ждём пока Angular полностью отрендерит интерфейс — модельная
      // карточка появляется на ~300-800ms позже body-ready.
      await waitFor(() => document.querySelector('button.model-selector-card'),
                    'studio-ready', 15000);

      await ensureModel(job.modelTitle);
      await setSystemInstruction(job.systemInstruction);

      // Включаем focus-emulation ДО Run — чтобы в скрытой вкладке Angular
      // change-detection ожил и waitForCompletion реально увидел Stop→Run.
      // Если attach не удался (нет debugger-привилегии / prod) — focusOk=false,
      // тогда НЕ делаем рискованный post-run model switch (см. ниже).
      const focusOk = await requestFocusAttach();
      log('autoscrape.focus_attach', { focusOk });

      try {
        await pastePromptAndRun(text);

        // ── Дождаться завершения ПЕРЕД любыми post-Run мутациями ──────────
        //
        // ROOT CAUSE «Failed to generate content: permission denied»: раньше
        // СРАЗУ после Run дёргали resetSystemInstructionAfterRun +
        // ensureModel(Flash→Pro). Но pastePromptAndRun возвращается как только
        // появился Stop — запрос ещё стримится. Переключение модели в
        // dropdown'е посреди in-flight генерации роняет turn с "permission
        // denied"/"internal error". Юзер чинил вручную нажатием sparkle
        // «Rerun this turn» — проходило, потому что модель уже устаканилась.
        //
        // Теперь ждём Stop→Run (с retry через rerunLastTurn на транзиентные
        // backend-error'ы — как MCP-путь), и только ПОТОМ трогаем модель.
        // Если focus-emulation не поднялся — waitForCompletion в замороженной
        // вкладке ненадёжен; делаем «мягкое» ожидание и пропускаем switch.
        if (focusOk) {
          await waitForCompletionWithRetry();
        } else {
          // Fallback без debugger: дать генерации стартовать, не блокируясь
          // на never-обновляющемся Stop. Не идеально, но post-run мутаций
          // ниже мы в этом режиме всё равно не делаем.
          await sleep(2000);
          log('autoscrape.completion_skipped_no_focus');
        }

        // Post-Run сброс System Instructions. Генерация уже завершена —
        // переключение пресета теперь чисто UI-эффект для будущих сообщений.
        // undefined (старые job'ы) — ничего не сбрасываем.
        if (typeof job.postSystemInstruction === 'string') {
          await resetSystemInstructionAfterRun(job.postSystemInstruction);
        }

        // Post-Run смена модели (Flash→Pro для последующих вопросов юзера).
        // ТОЛЬКО если был надёжный сигнал завершения (focusOk) — иначе мы не
        // знаем, дописал ли Flash ответ, и рискуем снова сломать turn. Без
        // focus просто оставляем Flash-модель, юзер сам переключит. Пустая
        // строка postModelTitle = не менять.
        if (focusOk && job.postModelTitle && job.postModelTitle !== job.modelTitle) {
          try {
            await sleep(400);
            await ensureModel(job.postModelTitle);
            log('post-run model switch done', { to: job.postModelTitle });
          } catch (e) {
            log('post-run model switch FAILED (non-fatal): ' + (e?.message || e));
          }
        }

        done(requestId);
      } finally {
        // Снять debugger (убрать жёлтую полосу) независимо от исхода.
        if (focusOk) { await requestFocusDetach(); }
      }
    } catch (e) {
      fail(e.message || String(e), requestId);
    }
  }

  // ── Universal toast renderer (тот же что на YT) ──────────────────────
  //
  // sc-desktop (background) шлёт __sc_btn_state на AI Studio вкладки тоже,
  // чтобы юзер видел финальный «✓ Вставлено / Готово» в той же стилистике
  // что на YT, независимо от того где сейчас фокус. Логика идентична
  // youtube-content::renderToasts.
  const TOAST_HOST_ID_AI = 'sc-ai-toast-host';
  const toastMap = new Map(); // videoId → { state, title, error, engine }
  const toastTimers = new Map();

  function getOrCreateToastHost() {
    let host = document.getElementById(TOAST_HOST_ID_AI);
    if (host && host.isConnected) return host;
    host = document.createElement('div');
    host.id = TOAST_HOST_ID_AI;
    host.style.cssText = `
      position: fixed;
      top: 70px;
      right: 16px;
      z-index: 2147483000;
      display: flex;
      flex-direction: column;
      gap: 8px;
      pointer-events: none;
      max-width: 360px;
    `;
    document.body.appendChild(host);
    // Анимация
    if (!document.getElementById('sc-ai-toast-style')) {
      const s = document.createElement('style');
      s.id = 'sc-ai-toast-style';
      s.textContent = `@keyframes sc-toast-in-ai { from {opacity:0;transform:translateX(20px)} to {opacity:1;transform:translateX(0)} }`;
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
      case 'pasted':       return '🤖✓';      // Gemini Studio paste — отличаем от done
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
          animation: sc-toast-in-ai 0.18s ease-out;
          max-width: 360px;
        `;
        const ic = document.createElement('span');
        ic.dataset.scToastIcon = '1';
        ic.style.cssText = 'flex: 0 0 auto; line-height: 1;';
        const tt = document.createElement('span');
        tt.dataset.scToastTitle = '1';
        tt.style.cssText = `
          flex: 1 1 auto;
          min-width: 0;
          overflow: hidden;
          white-space: nowrap;
          text-overflow: ellipsis;
        `;
        // Крест справа — единый для всех state'ов. Совпадает по позиции/цвету
        // с YT-стороной (youtube-content::renderToasts).
        const cls = document.createElement('button');
        cls.dataset.scToastClose = '1';
        cls.textContent = '×';
        cls.style.cssText = `
          flex: 0 0 auto;
          background: transparent;
          border: none;
          color: #a5a5a5;
          cursor: pointer;
          font: 16px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          padding: 0 4px;
          margin-left: 2px;
          opacity: 0.7;
          transition: opacity 0.12s;
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

  // Подписка ВСЕГДА — независимо от того autoscrape это kick или просто
  // открытая вкладка AI Studio.
  try {
    chrome.runtime.onMessage.addListener((req) => {
      if (!req || req.__sc_btn_state !== true) return;
      const vid = req.videoId;
      if (!vid) return;
      // Промежуточные state'ы не показываем на AI Studio — там autoscrape
      // рисует свой overlay; нам нужен только финал (pasted/done/error).
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
