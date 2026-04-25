// SC Browser Parser — MCP-driven AI Studio runner.
//
// Триггер: вкладка открыта на aistudio.google.com/prompts/new_chat?sc-mcp-job=<jobId>.
// Альтернативный триггер: chrome.runtime.onMessage с __sc_aistudio_mcp_run.
//
// Контракт job-payload'а в chrome.storage.local.__sc_aistudio_mcp_jobs[jobId]:
//   {
//     jobId, prompt, modelId, systemInstruction?, ts,
//     status: 'pending' | 'running' | 'done' | 'error',
//     elapsedSec?, responseText?, error?, tabId, modelTitle,
//   }
//
// Flow:
//   1) ensureModel(modelId)
//   2) ensureVisualizationOff()
//   3) setSystemInstruction(presetName) — опционально
//   4) pastePromptAndRun(prompt)
//   5) waitForCompletion()  ← onProgress пишет elapsedSec в storage
//   6) parseLastTurn() → response.text
//   7) Сохраняем result в storage, шлём __sc_aistudio_mcp_done в SW
//
// Этот файл — content_script, подключается на aistudio.google.com/prompts/*
// ПОСЛЕ aistudio-core.js (порядок в manifest). Конкурирует с autoscrape только
// по триггеру: autoscrape реагирует на #sc=<id>, mcp — на ?sc-mcp-job=<id>.

(function () {
  'use strict';

  const STORAGE_KEY = '__sc_aistudio_mcp_jobs';
  const TAG = '[SC-AIST-MCP]';
  // Persistent log: в console для realtime debug + в bridge /research-log
  // для post-mortem (console умирает при close/reload вкладки, bridge log
  // переживает). currentJobId/currentTabId привязаны к каждому log'у в
  // bridge — без них post-mortem не получится связать события вкладок.
  let __currentJobId = null;
  let __currentTabId = null;
  const log = (msg, data) => {
    try { console.log(TAG, msg, data || ''); } catch {}
    try {
      // Relay через SW: CS не может сделать fetch на 127.0.0.1:53127
      // напрямую из aistudio.google.com origin'а (CORS + Private Network
      // Access блокируют). SW делает fetch как extension origin, что
      // прокатывает. См. background.js::__sc_log handler.
      chrome.runtime.sendMessage({
        __sc_log: true,
        id: __currentJobId || '-',
        tabId: __currentTabId,
        tag: 'aistudio.' + msg,
        url: location.href.slice(0, 160),
        data: (data && typeof data === 'object') ? data : (data == null ? undefined : { v: String(data).slice(0, 200) }),
      }).catch(() => {});
    } catch {}
  };

  // Idempotency-guard. Если этот CS уже запустил job (например после navigate
  // внутри той же вкладки), не пере-запускать.
  if (window.__scAistudioMcpRunning) return;
  window.__scAistudioMcpRunning = false;

  function getJobIdFromUrl() {
    const m = (location.search || '').match(/[?&]sc-mcp-job=([\w-]+)/);
    return m ? m[1] : null;
  }

  async function readJob(jobId) {
    const got = await chrome.storage.local.get(STORAGE_KEY);
    const all = got?.[STORAGE_KEY] || {};
    return all[jobId] || null;
  }

  async function writeJob(jobId, patch) {
    const got = await chrome.storage.local.get(STORAGE_KEY);
    const all = got?.[STORAGE_KEY] || {};
    const prev = all[jobId] || {};
    const next = { ...prev, ...patch, updatedAt: Date.now() };
    all[jobId] = next;
    await chrome.storage.local.set({ [STORAGE_KEY]: all });
    return next;
  }

  function stripJobIdFromUrl() {
    try {
      const u = new URL(location.href);
      u.searchParams.delete('sc-mcp-job');
      history.replaceState(null, '', u.pathname + (u.search ? u.search : '') + u.hash);
    } catch {}
  }

  // Info-плашка «эта вкладка под MCP-job». Реализация вынесена в общий
  // research-badge.js (window.scResearchBadge) — единый источник правды для
  // AI Studio / Perplexity / Claude. Здесь только тонкие делегаторы, чтобы
  // не менять call-site'ы (showMcpBadge/hideMcpBadge) ниже по runJob.
  function showMcpBadge({ jobId, modelTitle, prompt }) {
    try {
      window.scResearchBadge?.show({ jobId, providerLabel: 'AI Studio', modelTitle, prompt });
    } catch {}
  }
  function hideMcpBadge() {
    try { window.scResearchBadge?.hide(); } catch {}
  }

  async function runJob(jobId) {
    // Привязываем persistent log к jobId сразу — все последующие log'и
    // полетят в bridge с этим id. window.__scAistudioJobId — для
    // aistudio-core.js (он живёт в той же window и читает оттуда).
    __currentJobId = jobId;
    try { window.__scAistudioJobId = jobId; } catch {}
    // Escalation-state: если фоновый таб пришлось вывести на передний план
    // ради разморозки Angular — вернём фокус юзеру в finally.
    let __escalatedFocus = false;
    let __prevActiveTabId = null;
    // Просим SW свой tabId — без него post-mortem не свяжет CS-логи с
    // tab-lifecycle событиями.
    try {
      const resp = await chrome.runtime.sendMessage({ __sc_get_tab_id: true });
      __currentTabId = resp?.tabId ?? null;
    } catch {}

    log('runJob.entry', { jobId, href: location.href.slice(0, 200) });

    if (window.__scAistudioMcpRunning) {
      log('already running, skipping', { jobId });
      return;
    }
    window.__scAistudioMcpRunning = true;

    const api = window.scAistudio;
    if (!api) {
      log('scAistudio API missing — aborting job');
      await writeJob(jobId, { status: 'error', error: 'scAistudio API not loaded' });
      window.__scAistudioMcpRunning = false;
      return;
    }

    const job = await readJob(jobId);
    if (!job) {
      log('job not found in storage', { jobId });
      window.__scAistudioMcpRunning = false;
      return;
    }
    if (job.status === 'done' || job.status === 'error') {
      log('job already terminal', { jobId, status: job.status });
      window.__scAistudioMcpRunning = false;
      return;
    }

    await writeJob(jobId, { status: 'running', startedAt: Date.now() });
    // promptHead — короткая шапка для UI mirror'а; полный prompt не светим
    // (длинные могут быть 10 KB+, нагружают bridge state без нужды).
    const promptHead = (job.prompt || '').slice(0, 140);
    log('job.started', { jobId, modelId: job.modelId, promptLen: (job.prompt || '').length, promptHead });

    showMcpBadge({ jobId, modelTitle: job.modelTitle || job.modelId, prompt: job.prompt || '' });

    try {
      // NB: MAIN-world visibility override отключён — детерминированно не
      // работает (Studio либо не отправляет запрос, либо отправляет но не
      // рендерит, override переопределяется обратно). Опытным путём в
      // hidden-tab Studio ВООБЩЕ не материализует ms-text-chunk. Решение
      // — внешний канал (см. fact-aistudio-mcp.md::Hidden-tab strategy).
      // Handler в background.js оставлен для будущих экспериментов.

      // 0b) Включить turnCache MutationObserver ДО paste+run, чтобы он
      //    захватил ВСЕ chunks с момента появления (стрим) и сохранил их
      //    до того как Studio демонтирует контент при переключении
      //    visibilityState=hidden. Это единственный надёжный способ
      //    получить ответ когда вкладка всю жизнь в фоне.
      //    См. fact-yt-extension-bridge.md::Hidden-tab demount в aistudio.
      api.startTurnCacheObserver();
      log('turnCache.observer_started');

      // 1) Дождаться готовности студии (Angular bootstrap).
      //    Escalation: фоновый таб в Yandex замораживается (timer/layout
      //    throttle), и Angular не бутстрапится — studio-ready таймаут на 30с
      //    (доказано JSONL: фоновые запуски падали, foreground проходил).
      //    autoDiscardable:false от этого НЕ спасает (он только против discard).
      //    Поэтому: ждём готовности в фоне ~8с; если не наступила — просим SW
      //    вывести таб на передний план (разморозка), затем ждём ещё.
      //    Прежний активный таб запоминаем и восстановим в finally.
      const studioReady = () => document.querySelector('button.model-selector-card');
      try {
        await api.waitFor(studioReady, 'studio-ready-bg', 8000);
      } catch (bgErr) {
        log('studio_ready.bg_timeout — escalating to foreground', { jobId });
        try {
          const fr = await chrome.runtime.sendMessage({ __sc_focus_self: true });
          if (fr && fr.ok) {
            __escalatedFocus = true;
            __prevActiveTabId = fr.prevTabId ?? null;
            log('studio_ready.foreground_requested', { prevTabId: __prevActiveTabId });
          } else {
            log('studio_ready.foreground_failed', { err: fr?.error });
          }
        } catch (fe) {
          log('studio_ready.foreground_msg_failed', { err: fe?.message });
        }
        // На переднем плане Angular размораживается — добиваем оставшийся бюджет.
        await api.waitFor(studioReady, 'studio-ready', 30000);
      }

      // 2) Set model.
      const model = await api.ensureModel(job.modelId);
      await writeJob(jobId, { modelTitle: model.title, modelId: model.id });

      // 3) Visualization off — только для Deep Research моделей. У Flash/Pro
      //    этого toggle в DOM нет; ensureVisualizationOff с явным флагом
      //    isDeepResearch:false мгновенно вернёт false без открытия Settings.
      await api.ensureVisualizationOff({ isDeepResearch: !!model.isDeepResearch });

      // 4) System instruction — опционально.
      if (job.systemInstruction) {
        await api.setSystemInstruction(job.systemInstruction);
      }

      // 4b) Paid-API-key dialog — reactive-проверка (если окно уже висит на
      //     bootstrap'е). Основная обработка окна агента/DR — в waitForCompletion
      //     (оно всплывает в ответ на Run, не на bootstrap). NET-TAP сейчас
      //     пишет в bridge сетевые запросы — отлаживаем КОГДА именно AI Studio
      //     требует ключ (до запроса / после ответа).
      //     См. fact-aistudio-mcp.md::Paid API key dialog.
      try {
        const linked = await api.ensurePaidKeyLinked();
        if (linked) {
          log('paid_key.handled');
          await writeJob(jobId, { stage: 'paid_key_linked' });
        } else {
          log('paid_key.check_no_dialog');
        }
      } catch (pkErr) {
        log('paid_key.failed', { err: pkErr?.message });
        await writeJob(jobId, { stage: 'paid_key_failed', lastError: String(pkErr?.message || pkErr).slice(0, 300) });
        throw pkErr; // propagate как terminal error job'а
      }

      // 5) Paste + Run.
      await api.pastePromptAndRun(job.prompt);

      // 6) Wait for completion. Двухфазные модели (DR + Antigravity, Interactions
      //    API) — это 5-15 минут multi-step (агент поднимает песочницу, гоняет
      //    инструменты). Им 20 мин timeout. Однофазным Pro/Flash — 5 мин.
      //    Раньше агент получал 5 мин (по isDeepResearch=false) хотя он такой же
      //    долгий как DR — теперь по isInteractionApi.
      const isInteractionApi = !!model.isInteractionApi;
      const completionTimeoutMs = isInteractionApi ? 20 * 60 * 1000 : 5 * 60 * 1000;

      let lastPersistedAt = 0;
      const onProgress = (info) => {
        // Throttle: пишем в storage не чаще раза в 3 секунды чтобы
        // не наспамить chrome.storage write-quota.
        const now = Date.now();
        if (now - lastPersistedAt < 3000) return;
        lastPersistedAt = now;
        writeJob(jobId, { elapsedSec: info.elapsedSec, hasStop: info.hasStop }).catch(() => {});
      };

      // Retry-loop для AI Studio backend errors. Если waitForCompletion
      // вернёт "AI Studio backend error" — кликаем sparkle "Rerun this turn"
      // и ждём заново. Backend errors транзиентны — обычно retry №1 проходит.
      // Limit 2 retries (всего 3 попытки) чтобы не упереться в loop при
      // упавшем AI Studio.
      // Retry-loop оборачивает И waitForCompletion, И parseLastTurn. Antigravity
      // (и cold-start вообще) часто отдаёт error-turn БЕЗ появления Stop и с
      // задержкой рендера — waitForCompletion возвращает no_stop_short_answer как
      // "success", а error всплывает только на parse. Поэтому ловим backend-error
      // на ОБЕИХ стадиях и в обоих случаях делаем rerunLastTurn. Юзер подтвердил:
      // 1й submit Antigravity → error, rerun → ok. См. fact-aistudio-mcp.md::
      // Antigravity cold-start retry.
      const MAX_RETRIES = 2;
      let attempt = 0;
      let elapsedSec = 0;
      let parsed = null;
      while (true) {
        try {
          // На ретрае (attempt>0) даём grace: старый error-turn ещё в DOM пока
          // rerun не заменил его новой генерацией — без grace detectBackendError
          // мгновенно ловит СТАРЫЙ error (см. fact-aistudio-mcp.md::stale-error).
          const r = await api.waitForCompletion({
            timeoutMs: completionTimeoutMs,
            onProgress,
            ignoreStaleErrorMs: attempt > 0 ? 6000 : 0,
            // Antigravity/DR: Run открывает paid-key dialog вместо submit'а;
            // после привязки ключа нужен re-submit с этим prompt'ом.
            promptForResubmit: job.prompt,
          });
          elapsedSec = r.elapsedSec;
          // Parse внутри try: error-turn мог отрендериться уже после
          // waitForCompletion (Antigravity cold-start). parseLastTurn кидает на
          // error-турне — ловим ниже как retryable.
          parsed = await api.parseLastTurn();
          if (!parsed || !parsed.text) {
            // Нет текста — проверяем, не error-turn ли это. Если да → backend
            // error (retryable). Если просто пусто — не-retryable как раньше.
            const be = api.detectBackendError && api.detectBackendError();
            if (be) throw new Error(be);
            throw new Error('completion finished but no response text found');
          }
          break; // успех: есть и completion, и распарсенный текст
        } catch (e) {
          const msg = String(e?.message || '');
          const retryable = /backend error|internal error|Произошла внутренняя ошибка/i.test(msg);
          if (retryable && attempt < MAX_RETRIES) {
            attempt += 1;
            log('runJob.backend_error_retry', { attempt, err: msg.slice(0, 120) });
            await writeJob(jobId, { stage: `retrying-${attempt}`, lastError: msg.slice(0, 200) });
            try {
              // prompt для fallback-resubmit когда нет Rerun-кнопки (Antigravity).
              await api.rerunLastTurn(job.prompt);
            } catch (rrErr) {
              log('runJob.rerun_failed', { err: rrErr?.message });
              throw e; // оригинальная ошибка
            }
            // Дать AI Studio сменить DOM (старый error-turn убрать, Stop поднять).
            await api.sleep(1500);
            continue;
          }
          throw e;
        }
      }

      // Append «Источники» блок в конец responseText. Юзер хочет получать
      // все ссылки одним кусоком — DR/Pro кладут их в ms-search-entry-point
      // (footnotes), Flash — иногда inline. Делаем единый формат вывода.
      let responseText = parsed.text;
      const links = parsed.links || [];
      if (links.length > 0) {
        const linkLines = links.map((l, i) => {
          const label = l.title || l.href;
          return `[${i + 1}] ${label}\n    ${l.href}`;
        }).join('\n');
        responseText = parsed.text + '\n\n---\n\n## Источники\n\n' + linkLines;
      }

      await writeJob(jobId, {
        status: 'done',
        responseText,
        links,
        elapsedSec,
        finishedAt: Date.now(),
      });
      // responseHead — короткая шапка для UI-превью. ПОЛНЫЙ responseText + links
      // тоже шлём в bridge: research-flow читает результат через HTTP
      // (GET /research-status → result.text), а не через MCP-tool. Раньше в
      // bridge уходил только responseHead (600 симв) → result.text обрезался,
      // links терялись (linkCount был, а самих ссылок нет). См.
      // fact-aistudio-mcp.md::Полный текст в bridge.
      const responseHead = responseText.slice(0, 600);
      log('job.done', { jobId, elapsedSec, textLen: responseText.length, linkCount: links.length, responseHead, responseText, links });

      // Уведомить SW — он может triggered'нуть финальный handler (e.g.
      // лог в bridge, push-notification и т.п.).
      try {
        chrome.runtime.sendMessage({ __sc_aistudio_mcp_done: true, jobId, ok: true });
      } catch {}
    } catch (e) {
      const errMsg = e?.message || String(e);
      log('job.failed', { jobId, error: errMsg });
      await writeJob(jobId, {
        status: 'error',
        error: errMsg,
        finishedAt: Date.now(),
      });
      try {
        chrome.runtime.sendMessage({ __sc_aistudio_mcp_done: true, jobId, ok: false, error: errMsg });
      } catch {}
    } finally {
      window.__scAistudioMcpRunning = false;
      hideMcpBadge();
      // Вернуть фокус на прежний активный таб, если мы выводили AI-Studio
      // на передний план ради разморозки. Вспышка окна была только на время
      // bootstrap'а; дальше задача гонится в фоне через turnCache observer.
      if (__escalatedFocus && __prevActiveTabId != null) {
        try {
          await chrome.runtime.sendMessage({ __sc_focus_tab: true, tabId: __prevActiveTabId });
          log('focus.restored', { prevTabId: __prevActiveTabId });
        } catch (re) {
          log('focus.restore_failed', { err: re?.message });
        }
      }
    }
  }

  // ── Triggers ──────────────────────────────────────────────────────────

  // 1. URL query param — основной путь: SW открывает вкладку с этим query.
  const urlJobId = getJobIdFromUrl();
  if (urlJobId) {
    log('URL trigger detected', { jobId: urlJobId });
    stripJobIdFromUrl();
    // Запускаем после небольшой задержки — даём Angular'у время отрендерить
    // model-selector-card, чтобы первая api.ensureModel не упала в timeout
    // зря. waitFor внутри api всё равно ждёт — это просто оптимизация.
    setTimeout(() => runJob(urlJobId), 300);
  }

  // 2. Direct message — для случая когда SW шлёт run в уже открытую вкладку
  //    без новой загрузки (например реюз свежей new_chat вкладки).
  try {
    chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
      if (req && req.__sc_aistudio_mcp_run === true && req.jobId) {
        log('message trigger', { jobId: req.jobId });
        // Async fire-and-forget — sendResponse не нужен.
        runJob(req.jobId);
        try { sendResponse({ ok: true }); } catch {}
        return false;
      }
      return false;
    });
  } catch {}

  log('aistudio-mcp content script ready');
})();
