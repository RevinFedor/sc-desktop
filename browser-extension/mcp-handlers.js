// ============ MCP Bridge ============
// Connects to local MCP bridge (ws://localhost:3457).
// Allows Claude Code to control the browser via MCP tools.
//
// Это расширение (SC Browser Parser) полностью dev-only — никакого
// прод-стриппинга не нужно. Bridge всегда пытается коннектиться при
// старте service worker'а; если bridge не запущен, попытки
// реконнекта продолжаются молча с 5-секундным интервалом.
//
// MV3 SW keep-alive: WebSocket сам по себе не держит SW живым,
// Chrome засыпает через ~30 сек idle. Бридж тогда видит disconnect,
// и при следующем MCP-tool call'е получает «Extension not connected».
// Решение — chrome.alarms-pulse каждые 25 секунд, который дёргает
// chrome API → reset idle-timer'а SW. Стартует только когда WS
// connected; останавливается на close, чтобы не жечь ресурсы при
// мёртвом bridge'е.

const MCP_WS_URL = 'ws://localhost:3457';
const MCP_KEEPALIVE_ALARM = 'sc-mcp-keepalive';
let mcpWs = null;

function startKeepAlive() {
  // 0.42 min ≈ 25s — короче 30s SW-timeout'а Chrome.
  chrome.alarms.create(MCP_KEEPALIVE_ALARM, { periodInMinutes: 0.42 });
}

function stopKeepAlive() {
  chrome.alarms.clear(MCP_KEEPALIVE_ALARM).catch(() => {});
}

// Pulse handler — нужно дёрнуть любой chrome API чтобы reset'нуть idle.
// chrome.runtime.getPlatformInfo cheap, без побочных эффектов.
chrome.alarms.onAlarm.addListener(a => {
  if (a.name !== MCP_KEEPALIVE_ALARM) return;
  chrome.runtime.getPlatformInfo(() => { /* keep-alive ping */ });
});

async function connectMcpBridge() {
  console.log('[SC MCP] connecting to', MCP_WS_URL);

  try {
    mcpWs = new WebSocket(MCP_WS_URL);

    mcpWs.onopen = () => {
      console.log('[SC MCP] connected');
      startKeepAlive();
    };

    mcpWs.onmessage = async (event) => {
      try {
        const command = JSON.parse(event.data);
        const result = await handleMcpCommand(command);
        result.commandId = command.commandId;
        mcpWs.send(JSON.stringify(result));
      } catch (e) {
        console.error('[SC MCP] command error:', e);
        try {
          const parsed = JSON.parse(event.data);
          mcpWs.send(JSON.stringify({
            commandId: parsed.commandId,
            success: false,
            error: e.message,
          }));
        } catch (_) {}
      }
    };

    mcpWs.onclose = () => {
      console.log('[SC MCP] disconnected');
      mcpWs = null;
      stopKeepAlive();
      // Reconnect after 5s (MCP bridge might restart)
      setTimeout(connectMcpBridge, 5000);
    };

    mcpWs.onerror = () => {
      // Silently fail — MCP bridge might not be running
    };

  } catch (e) {
    // MCP bridge not running — that's fine
  }
}

async function handleMcpCommand(command) {
  const { action, tabId } = command;

  // Resolve target tab
  let targetTabId = tabId;
  if (!targetTabId) {
    // Use the active tab in the current window
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab) return { success: false, error: 'No active tab' };
    targetTabId = activeTab.id;
  }

  if (action === 'mcp_list_tabs') {
    const tabs = await chrome.tabs.query({});
    return {
      success: true,
      tabs: tabs.map(t => ({
        id: t.id,
        url: t.url,
        title: t.title,
        active: t.active,
      })),
    };
  }

  // Force-reload расширения по требованию (когда hot-reload spying не успел
  // увидеть mtime-расхождение и юзер хочет применить свежий код прямо сейчас
  // без manual ⟳ в chrome://extensions/). Отправляем ack ДО reload — иначе
  // вызывающая сторона не получит ответа.
  if (action === 'mcp_force_reload') {
    setTimeout(() => { try { chrome.runtime.reload(); } catch {} }, 50);
    return { success: true, reloading: true };
  }

  if (action === 'mcp_navigate') {
    await chrome.tabs.update(targetTabId, { url: command.url });
    // Wait for navigation to complete
    await new Promise(resolve => {
      function listener(updatedTabId, changeInfo) {
        if (updatedTabId === targetTabId && changeInfo.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      }
      chrome.tabs.onUpdated.addListener(listener);
      // Timeout fallback
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, 10000);
    });
    return { success: true };
  }

  // ── Tab management ────────────────────────────────────────────────
  // Открыть вкладку для research'а в фоне БЕЗ риска tab-freeze.
  // Yandex/Chrome замораживают вкладку которая ни разу не была активной —
  // JS execution тротлится до тика/мин, MutationObserver молчит,
  // keep-alive port не помогает (это lifecycle policy уровня браузера,
  // не throttling таймеров). Решение: открыть active:true, дождаться
  // load (CS успел инжектиться), и переключить фокус обратно на ту
  // вкладку которая была активной до этого. Браузер засчитывает
  // research-вкладке "была активна хоть раз" → не замораживает.
  // Открыть/сфокусировать вкладку по url. WS-путь (мгновенный) — в отличие
  // от HTTP /open-url через alarm-poll queue (лаг до 3-6с). Используется
  // кнопкой «В браузере» в JobDetail. Ищет существующую вкладку с этим url
  // (research-чат) и фокусит, иначе создаёт новую.
  if (action === 'mcp_open_url') {
    const target = String(command.url || '');
    if (!target) return { success: false, error: 'url required' };
    const base = target.split('#')[0];
    const existing = await chrome.tabs.query({ url: base + '*' });
    if (existing && existing[0]) {
      await chrome.tabs.update(existing[0].id, { active: true });
      try { await chrome.windows.update(existing[0].windowId, { focused: true }); } catch {}
      return { success: true, tabId: existing[0].id, focused: true };
    }
    const t = await chrome.tabs.create({ url: target, active: true });
    return { success: true, tabId: t.id, focused: false };
  }

  if (action === 'mcp_open_research_tab') {
    // True background open + autoDiscardable:false — никакого focus-flash,
    // но вкладка защищена от freeze/discard. Анти-freeze MutationObserver +
    // long-lived port НЕ помогают если Yandex дискардит layout never-active
    // вкладки целиком — getBoundingClientRect возвращает пустой rect,
    // .click() уходит в пустоту, setInterval/MutationObserver тоже не тикают.
    // autoDiscardable:false говорит браузеру "никогда не дискарди эту вкладку"
    // — это property уровня API, не throttling, работает 100% без UI-эффекта.
    //
    // Раньше был focus-pulse 600мс (открыть active:true, подождать, вернуть
    // фокус на prevActive) — юзер видел флэш. Заменили на autoDiscardable,
    // юзер вообще ничего не видит.
    const tab = await chrome.tabs.create({
      url: command.url,
      active: false,
    });
    // Set autoDiscardable=false ASAP — до load complete, чтобы Yandex
    // ни секунды не считал её never-active кандидатом на discard.
    try { await chrome.tabs.update(tab.id, { autoDiscardable: false }); } catch (e) {
      console.log('[mcp_open_research_tab] autoDiscardable set failed:', e?.message);
    }
    // Focus-emulation через chrome.debugger — тот же фикс что у aistudio
    // (background.js::attachFocusEmulation). autoDiscardable:false спасает
    // только от discard, НЕ от render-freeze: при долгой деактивации ВСЕГО
    // браузера Chromium глушит rAF даже для composer-состояния — watcher
    // слепнет (живой кейс rm6equid: 48 тиков за 577с без единой смены
    // сигнатуры, тики раз в ~12-30с вместо 2с), extraction зависит от
    // focus-pulse, который выдёргивает окно браузера поверх текущего
    // приложения юзера. Emulation держит Page::IsPageVisible()=true →
    // rAF тикает → сообщения рендерятся в фоне, escalation остаётся
    // только dormant-страховкой на случай если attach упал.
    let dbgOk = false, dbgErr = null;
    try {
      if (typeof attachFocusEmulation === 'function') {
        const r = await attachFocusEmulation(tab.id);
        dbgOk = !!r?.ok;
        if (!r?.ok) {
          dbgErr = r?.err || 'unknown';
          console.warn('[mcp_open_research_tab] debugger attach failed:', dbgErr);
        }
      } else {
        dbgErr = 'attachFocusEmulation not defined';
      }
    } catch (e) {
      dbgErr = e?.message || String(e);
      console.warn('[mcp_open_research_tab] debugger attach threw:', dbgErr);
    }
    try {
      fetch('http://127.0.0.1:53127/research-log', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tabId: tab.id, tag: 'research.debugger.attach', data: { tabId: tab.id, ok: dbgOk, err: dbgErr } }),
      }).catch(() => {});
    } catch {}
    // Ждём load — без этого следующие операции на tabId упадут
    // "No response from any frame".
    await new Promise(resolve => {
      function l(id, info) {
        if (id === tab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(l);
          resolve();
        }
      }
      chrome.tabs.onUpdated.addListener(l);
      setTimeout(() => { chrome.tabs.onUpdated.removeListener(l); resolve(); }, 15000);
    });
    // Visually distinguish MCP-tab: extension's icon as favicon (sites cannot
    // be put into a specific Yandex tab group programmatically, see research).
    try { await markTabAsMcpVisually(tab.id); } catch {}
    // В lifecycle-трекинг (background.js::RESEARCH_TABS — общий SW-scope,
    // mcp-handlers.js подключён через importScripts) — СРАЗУ при открытии,
    // не дожидаясь keepalive-порта CS. Иначе зомби-вкладка (CS не стартовал:
    // LNA, расширение протухло) не даёт sw.tab.onRemoved при ручном закрытии,
    // и bridge не может перевести вечно-queued job в error (tab-closed fallback).
    try { RESEARCH_TABS.add(tab.id); } catch {}
    return { success: true, tabId: tab.id, url: tab.url };
  }

  // ── AI Studio job-runner ──────────────────────────────────────────
  //
  // mcp_aistudio_start: открывает (или реюзает) вкладку
  // aistudio.google.com/prompts/new_chat?model=<id>&sc-mcp-job=<jobId>.
  // CS (aistudio-mcp.js) подхватывает jobId из URL, читает payload из
  // chrome.storage.local.__sc_aistudio_mcp_jobs[jobId] и запускает flow.
  // Возвращает {jobId, tabId, modelId} сразу — Claude'у не нужно ждать.
  //
  // KNOWN_MODELS_MCP — короткий справочник для резолва id'ов. Полный список
  // живёт в aistudio-core.js::KNOWN_MODELS — там же синонимы. Здесь
  // ровно та же таблица для cases когда SW решает что открывать ДО того
  // как CS успеет инжектиться.
  if (action === 'mcp_aistudio_start') {
    // KNOWN_MODELS_MCP — зеркало browser-extension/aistudio-core.js::KNOWN_MODELS.
    // alias-листы обязаны совпадать (чтобы SW и CS одинаково резолвили input).
    // При добавлении новой модели правишь ОБА файла.
    // Зеркало aistudio-core.js::KNOWN_MODELS. isInteractionApi — двухфазные
    // модели (DR + Antigravity, Interactions API): большой timeout + paid-key
    // на первом submit + промпт вторым сообщением. См. fact-aistudio-mcp.md::Два класса.
    const KNOWN_MODELS_MCP = [
      { id: 'gemini-3.1-pro-preview',         title: 'Gemini 3.1 Pro Preview',     isDeepResearch: false, isInteractionApi: false, alias: ['gemini-3.1-pro', '3.1-pro', 'pro'] },
      { id: 'gemini-3.5-flash',                title: 'Gemini 3.5 Flash',           isDeepResearch: false, isInteractionApi: false, alias: ['3.5-flash', 'flash'] },
      { id: 'gemini-3-flash-preview',          title: 'Gemini 3 Flash Preview',     isDeepResearch: false, isInteractionApi: false, alias: ['3-flash', '3-flash-preview'] },
      { id: 'gemini-3.1-flash-lite',           title: 'Gemini 3.1 Flash Lite',      isDeepResearch: false, isInteractionApi: false, alias: ['flash-lite', '3.1-flash-lite'] },
      { id: 'deep-research-preview-04-2026',   title: 'Deep Research Preview (Apr-21-2026)',     isDeepResearch: true, isInteractionApi: true, alias: ['deep-research', 'dr', 'deep-research-preview'] },
      { id: 'deep-research-max-preview-04-2026', title: 'Deep Research Max Preview (Apr-21-2026)', isDeepResearch: true, isInteractionApi: true, alias: ['deep-research-max', 'dr-max', 'deep-research-max-preview'] },
      { id: 'antigravity-preview-05-2026',     title: 'Antigravity Agent Preview',  isDeepResearch: false, isAgent: true, isInteractionApi: true, alias: ['antigravity', 'antigravity-agent', 'agent', 'ag'] },
    ];
    function resolveModelMcp(input) {
      if (!input) return KNOWN_MODELS_MCP[0]; // default = Pro Preview
      const s = String(input).toLowerCase().trim();
      for (const m of KNOWN_MODELS_MCP) {
        if (m.id.toLowerCase() === s) return m;
        if (m.title.toLowerCase() === s) return m;
        if ((m.alias || []).some(a => a.toLowerCase() === s)) return m;
      }
      for (const m of KNOWN_MODELS_MCP) {
        if (m.id.toLowerCase().includes(s) || m.title.toLowerCase().includes(s)) return m;
      }
      return null;
    }
    const prompt = String(command.prompt || '').trim();
    if (!prompt) return { success: false, error: 'prompt is required' };
    const model = resolveModelMcp(command.model);
    if (!model) {
      const list = KNOWN_MODELS_MCP.map(m => `${m.title} (${m.id})`).join(', ');
      return { success: false, error: `unknown model "${command.model}". Known: ${list}` };
    }
    const systemInstruction = command.systemInstruction || command.system_instruction || null;

    const jobId = 'aim_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);

    // Сохранить job в storage ДО открытия вкладки — CS на boot'е сразу найдёт.
    // КРИТИЧНО: при параллельных aistudio_run get+set гонятся между job'ами
    // (last-writer-wins). job_A.get → {} → set({A}); job_B.get → {} → set({B})
    // → A потерян. Сериализуем через global promise chain.
    const STORAGE_KEY = '__sc_aistudio_mcp_jobs';
    globalThis.__sc_aistudio_storage_lock = (globalThis.__sc_aistudio_storage_lock || Promise.resolve())
      .then(async () => {
        const existing = await chrome.storage.local.get(STORAGE_KEY);
        const allJobs = existing?.[STORAGE_KEY] || {};
        allJobs[jobId] = {
          jobId,
          prompt,
          modelId: model.id,
          modelTitle: model.title,
          isDeepResearch: model.isDeepResearch,
          systemInstruction,
          status: 'pending',
          createdAt: Date.now(),
        };
        await chrome.storage.local.set({ [STORAGE_KEY]: allJobs });
      })
      .catch(e => console.warn('[mcp_aistudio_start] storage lock failed:', e?.message));
    await globalThis.__sc_aistudio_storage_lock;

    // Открыть вкладку с обоими query-параметрами:
    //   model=<id>  — AI Studio сам выберет модель при загрузке (быстрее,
    //                 чем ensureModel переключающий через dropdown)
    //   sc-mcp-job=<id> — наш триггер для CS
    // autoDiscardable:false — защита от freeze/discard в фоне (то же что
    // мы делаем для research-вкладок).
    const url = `https://aistudio.google.com/prompts/new_chat?model=${encodeURIComponent(model.id)}&sc-mcp-job=${jobId}`;
    const reuseExisting = command.reuse_tab !== false;

    let tab = null;
    if (reuseExisting) {
      // Реюз — ищем существующую вкладку на aistudio.google.com/prompts/new_chat
      // которая НЕ занята другим job'ом. Источник истины — busy-set из storage
      // (вкладки куда мы залили sc-mcp-job; URL `?sc-mcp-job=...` мгновенно
      // стирается content-script'ом, фильтровать по URL ненадёжно).
      const busyKey = '__sc_aistudio_mcp_busy_tabs';
      const busyGot = await chrome.storage.local.get(busyKey);
      const busySet = new Set(busyGot?.[busyKey] || []);
      const tabs = await chrome.tabs.query({ url: 'https://aistudio.google.com/prompts/new_chat*' });
      const reusable = tabs.find(t => !busySet.has(t.id) && !t.url.includes('sc-mcp-job='));
      if (reusable) {
        await chrome.tabs.update(reusable.id, { url });
        tab = reusable;
        // Дождаться load
        await new Promise(resolve => {
          function l(id, info) {
            if (id === reusable.id && info.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(l);
              resolve();
            }
          }
          chrome.tabs.onUpdated.addListener(l);
          setTimeout(() => { chrome.tabs.onUpdated.removeListener(l); resolve(); }, 15000);
        });
      }
    }
    if (!tab) {
      tab = await chrome.tabs.create({
        url,
        active: !!command.focus,
      });
      // autoDiscardable:false — защита от Yandex tab-freeze БЕЗ видимого
      // флэша. Focus-pulse юзеру не нужен — он раздражает (окно
      // переключается на полсекунды), и реальная причина «runBtn.click()
      // не advance'нул» — это не freeze (synchronous DOM-paste работает),
      // а not-trusted synthetic click. Чиним через MAIN-world click
      // (см. aistudio-core.js::mainWorldClick), а не через focus.
      // См. docs/knowledge/fact-deep-research.md::Tab freezing «autoDiscardable работает 100% без UI-эффекта».
      try { await chrome.tabs.update(tab.id, { autoDiscardable: false }); } catch {}
      await new Promise(resolve => {
        function l(id, info) {
          if (id === tab.id && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(l);
            resolve();
          }
        }
        chrome.tabs.onUpdated.addListener(l);
        setTimeout(() => { chrome.tabs.onUpdated.removeListener(l); resolve(); }, 15000);
      });
    } else {
      // Reused вкладке тоже выставим autoDiscardable, дешёвая страховка.
      try { await chrome.tabs.update(tab.id, { autoDiscardable: false }); } catch {}
    }

    // Обновить tabId в job-record'е чтобы get_result мог по нему фокусить.
    const after = await chrome.storage.local.get(STORAGE_KEY);
    const jobs2 = after?.[STORAGE_KEY] || {};
    if (jobs2[jobId]) {
      jobs2[jobId].tabId = tab.id;
      await chrome.storage.local.set({ [STORAGE_KEY]: jobs2 });
    }

    // Пометить вкладку как занятую — следующий aistudio_run не будет её
    // переиспользовать пока CS не пришлёт __sc_aistudio_mcp_done (см.
    // background.js обработчик ниже).
    const BUSY_KEY = '__sc_aistudio_mcp_busy_tabs';
    const busyGot = await chrome.storage.local.get(BUSY_KEY);
    const busyList = Array.isArray(busyGot?.[BUSY_KEY]) ? busyGot[BUSY_KEY] : [];
    if (!busyList.includes(tab.id)) busyList.push(tab.id);
    await chrome.storage.local.set({ [BUSY_KEY]: busyList });

    // Визуально пометить как MCP (favicon + title-prefix + MutationObserver-guard).
    try { await markTabAsMcpVisually(tab.id); } catch {}

    // chrome.debugger.attach + Emulation.setFocusEmulationEnabled.
    // Это ЕДИНСТВЕННОЕ детерминированное решение для hidden-tab rendering
    // AI Studio (см. background.js::attachFocusEmulation comment block).
    // Делаем attach СРАЗУ после открытия вкладки — до того как Angular
    // успел проверить initial visibilityState и провалиться в "I'll do
    // CD when rAF tick'нёт" state. CS пока ещё не начал runJob (он ждёт
    // model-selector-card 30 сек).
    //
    // NB: вызываем НАПРЯМУЮ а не через chrome.runtime.sendMessage, потому
    // что mcp-handlers.js + background.js живут в одном SW global'е
    // (через importScripts) — chrome.runtime.sendMessage не доставляет
    // сообщения отправителю в том же контексте (Chrome design choice).
    try {
      if (typeof attachFocusEmulation === 'function') {
        const r = await attachFocusEmulation(tab.id);
        if (!r?.ok) {
          console.warn('[mcp_aistudio_start] debugger attach failed:', r?.err);
        } else {
          console.log('[mcp_aistudio_start] debugger attached, tabId=', tab.id, r.alreadyAttached ? '(already)' : '(new)');
        }
      } else {
        console.warn('[mcp_aistudio_start] attachFocusEmulation not defined — SW load order issue');
      }
    } catch (e) {
      console.warn('[mcp_aistudio_start] debugger attach threw:', e?.message);
    }

    return {
      success: true,
      jobId,
      tabId: tab.id,
      modelId: model.id,
      modelTitle: model.title,
      isDeepResearch: model.isDeepResearch,
    };
  }

  // mcp_aistudio_get_result: читает job по id из storage и возвращает
  // текущее состояние. Если wait_ms > 0 и status='running'/'pending' —
  // поллит каждые 2 сек до wait_ms прежде чем вернуть.
  if (action === 'mcp_aistudio_get_result') {
    const jobId = command.jobId || command.job_id;
    if (!jobId) return { success: false, error: 'jobId is required' };
    const STORAGE_KEY = '__sc_aistudio_mcp_jobs';
    const waitMs = Number(command.wait_ms || 0);
    const t0 = Date.now();
    const POLL = 2000;
    while (true) {
      const got = await chrome.storage.local.get(STORAGE_KEY);
      const job = got?.[STORAGE_KEY]?.[jobId];
      if (!job) return { success: false, error: 'job not found: ' + jobId };
      const elapsedReal = Math.round((Date.now() - (job.startedAt || job.createdAt || Date.now())) / 1000);
      const out = {
        success: true,
        jobId,
        status: job.status,
        modelId: job.modelId,
        modelTitle: job.modelTitle,
        isDeepResearch: !!job.isDeepResearch,
        elapsedSec: job.elapsedSec ?? elapsedReal,
        responseText: job.responseText || null,
        links: Array.isArray(job.links) ? job.links : [],
        linkCount: Array.isArray(job.links) ? job.links.length : 0,
        error: job.error || null,
        tabId: job.tabId ?? null,
      };
      if (job.status === 'done' || job.status === 'error' || waitMs <= 0) return out;
      if (Date.now() - t0 >= waitMs) return out;
      await new Promise(r => setTimeout(r, POLL));
    }
  }

  // mcp_aistudio_list_jobs: вспомогательный — список всех jobs в storage
  // (для отладки и cleanup'а). Не используется обычным flow'ом.
  if (action === 'mcp_aistudio_list_jobs') {
    const STORAGE_KEY = '__sc_aistudio_mcp_jobs';
    const got = await chrome.storage.local.get(STORAGE_KEY);
    const all = got?.[STORAGE_KEY] || {};
    return { success: true, jobs: Object.values(all) };
  }

  if (action === 'mcp_new_tab') {
    const tab = await chrome.tabs.create({
      url: command.url || 'about:blank',
      active: command.background ? false : true,
    });
    // Ждём load всегда (включая background:true) если задан URL — без этого
    // последующий tool call'у на этот tabId упадёт «No response from any frame»
    // (content-script ещё не инжектился). Background-вкладки Chrome грузит
    // тем же путём что и foreground — load event приходит.
    if (command.url) {
      await new Promise(resolve => {
        function l(id, info) {
          if (id === tab.id && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(l);
            resolve();
          }
        }
        chrome.tabs.onUpdated.addListener(l);
        setTimeout(() => { chrome.tabs.onUpdated.removeListener(l); resolve(); }, 10000);
      });
    }
    return { success: true, tabId: tab.id, url: tab.url };
  }

  if (action === 'mcp_close_tab') {
    await chrome.tabs.remove(targetTabId);
    return { success: true };
  }

  if (action === 'mcp_focus_tab') {
    const tab = await chrome.tabs.get(targetTabId);
    await chrome.tabs.update(targetTabId, { active: true });
    if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
    return { success: true };
  }

  if (action === 'mcp_reload_tab') {
    await chrome.tabs.reload(targetTabId, { bypassCache: !!command.bypassCache });
    if (command.waitForLoad !== false) {
      await new Promise(resolve => {
        function l(id, info) {
          if (id === targetTabId && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(l);
            resolve();
          }
        }
        chrome.tabs.onUpdated.addListener(l);
        setTimeout(() => { chrome.tabs.onUpdated.removeListener(l); resolve(); }, 15000);
      });
    }
    return { success: true };
  }

  // ── Screenshots (no DevTools badge — uses captureVisibleTab) ──────
  if (action === 'mcp_screenshot') {
    // captureVisibleTab works on the active tab of a window. Activate target first.
    const tab = await chrome.tabs.get(targetTabId);
    if (!tab.active) {
      await chrome.tabs.update(targetTabId, { active: true });
      // Tiny delay so the renderer paints the now-active tab.
      await new Promise(r => setTimeout(r, 150));
    }
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: command.format || 'png',
      quality: command.quality ?? 80,
    });
    // dataUrl: "data:image/png;base64,..." — strip prefix for MCP image return.
    const comma = dataUrl.indexOf(',');
    const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
    const mimeType = (dataUrl.match(/^data:([^;]+);/) || [, 'image/png'])[1];
    return { success: true, base64, mimeType };
  }

  // Element screenshot — capture viewport, content script crops in client.
  // Returns crop coords + viewport image; MCP layer handles cropping in pure JS
  // to avoid loading native image libs in the SW.
  if (action === 'mcp_screenshot_element') {
    // Step 1: have content script scroll element into view + get bounding rect.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: targetTabId, allFrames: true },
        files: ['mcp-content.js'],
      });
    } catch (_) {}
    await new Promise(r => setTimeout(r, 100));
    const rect = await chrome.tabs.sendMessage(targetTabId, {
      action: 'mcp_get_element_rect',
      selector: command.selector,
      scrollIntoView: true,
    }, { frameId: 0 });
    if (!rect || !rect.success) return rect || { success: false, error: 'no rect' };

    // Step 2: capture visible viewport.
    const tab = await chrome.tabs.get(targetTabId);
    if (!tab.active) {
      await chrome.tabs.update(targetTabId, { active: true });
      await new Promise(r => setTimeout(r, 200));
    }
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: command.format || 'png',
      quality: command.quality ?? 80,
    });
    const comma = dataUrl.indexOf(',');
    const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
    const mimeType = (dataUrl.match(/^data:([^;]+);/) || [, 'image/png'])[1];
    return {
      success: true,
      base64,
      mimeType,
      crop: rect.rect,             // {x, y, width, height} in CSS px
      devicePixelRatio: rect.dpr,
    };
  }

  // ── Cookies (chrome.cookies API — SW only) ────────────────────────
  if (action === 'mcp_get_cookies') {
    if (!chrome.cookies) {
      return { success: false, error: 'cookies permission missing — production build strips it' };
    }
    const filter = {};
    if (command.domain) filter.domain = command.domain;
    if (command.url) filter.url = command.url;
    if (command.name) filter.name = command.name;
    const cookies = await chrome.cookies.getAll(filter);
    return {
      success: true,
      cookies: cookies.map(c => ({
        name: c.name, value: c.value, domain: c.domain, path: c.path,
        secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite,
        expirationDate: c.expirationDate,
      })),
    };
  }

  // ── Batch action runner ───────────────────────────────────────────
  // Executes a list of MCP actions sequentially in the extension, returning
  // an array of results. Saves N round-trips for scripted scenarios.
  if (action === 'mcp_batch') {
    const results = [];
    for (const sub of command.actions || []) {
      // Fall back to current targetTabId if sub-action doesn't override.
      const subCmd = { ...sub, tabId: sub.tabId ?? targetTabId };
      try {
        const r = await handleMcpCommand(subCmd);
        results.push(r);
        if (sub.delayMs) await new Promise(res => setTimeout(res, sub.delayMs));
        if (r && r.success === false && command.stopOnError) break;
      } catch (e) {
        results.push({ success: false, error: e.message });
        if (command.stopOnError) break;
      }
    }
    return { success: true, results };
  }

  // Evaluate — execute code via chrome.scripting in isolated world
  // CSP blocks new Function/eval on many sites, so we pass a selector-based
  // query language instead. The 'code' is treated as a JS expression that
  // gets evaluated by the func itself using indirect eval via a Blob worker trick,
  // or as a querySelectorAll shorthand.
  if (action === 'mcp_evaluate') {
    try {
      const [{result: val}] = await chrome.scripting.executeScript({
        target: { tabId: targetTabId },
        args: [command.code],
        func: (code) => {
          // Try common patterns directly (CSP-safe, no eval needed)
          const c = code.trim().replace(/^return\s+/, '');

          // document.title
          if (c === 'document.title') return document.title;

          // document.querySelectorAll(...).length
          const qsaLen = c.match(/^document\.querySelectorAll\(['"](.+?)['"]\)\.length$/);
          if (qsaLen) return document.querySelectorAll(qsaLen[1]).length;

          // document.querySelector(...).textContent
          const qsTxt = c.match(/^document\.querySelector\(['"](.+?)['"]\)\.textContent$/);
          if (qsTxt) { const e = document.querySelector(qsTxt[1]); return e ? e.textContent.trim() : null; }

          // document.querySelector(...)?.href
          const qsHref = c.match(/^document\.querySelector\(['"](.+?)['"]\)\?*\.href$/);
          if (qsHref) { const e = document.querySelector(qsHref[1]); return e ? e.href : null; }

          // Generic querySelectorAll with map
          const qsaMap = c.match(/^document\.querySelectorAll\(['"](.+?)['"]\)\.forEach/);
          if (qsaMap) {
            // Can't eval arbitrary code, return elements info instead
            const els = document.querySelectorAll(qsaMap[1]);
            return Array.from(els).slice(0, 50).map(e => ({
              tag: e.tagName.toLowerCase(),
              text: (e.textContent || '').trim().substring(0, 100),
              href: e.href || undefined,
            }));
          }

          // JSON-style commands
          try {
            const cmd = JSON.parse(c);

            // Fill N-th element: {"fill": "select", "index": 1, "value": "июль"}
            if (cmd.fill) {
              const els = document.querySelectorAll(cmd.fill);
              const idx = cmd.index || 0;
              if (idx >= els.length) return { error: `Only ${els.length} elements found for "${cmd.fill}", index ${idx}` };
              const el = els[idx];
              if (el.tagName === 'SELECT') {
                const opt = Array.from(el.options).find(o => o.textContent.trim() === cmd.value || o.value === cmd.value);
                if (opt) el.value = opt.value; else el.value = cmd.value;
                el.dispatchEvent(new Event('change', { bubbles: true }));
              } else if (el.isContentEditable) {
                el.focus();
                const s = window.getSelection(); const r = document.createRange();
                r.selectNodeContents(el); s.removeAllRanges(); s.addRange(r);
                document.execCommand('insertText', false, cmd.value);
              } else {
                const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                if (setter) setter.call(el, cmd.value); else el.value = cmd.value;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              }
              return 'filled';
            }

            // Click N-th element: {"click": "button", "index": 2}
            if (cmd.click) {
              const els = document.querySelectorAll(cmd.click);
              const idx = cmd.index || 0;
              if (idx >= els.length) return { error: `Only ${els.length} elements found for "${cmd.click}", index ${idx}` };
              els[idx].click();
              return 'clicked';
            }

            // Extract: {"selector": "a[href*='/in/']", "extract": ["href", "textContent"]}
            if (cmd.selector) {
              const els = document.querySelectorAll(cmd.selector);
              const fields = cmd.extract || ['textContent', 'href'];
              return Array.from(els).slice(0, cmd.limit || 50).map(e => {
                const obj = {};
                for (const f of fields) {
                  const v = f === 'textContent' ? (e.textContent || '').trim().substring(0, 200) : e[f] || e.getAttribute(f);
                  if (v) obj[f] = v;
                }
                return obj;
              });
            }
          } catch(_) {}

          return { error: 'Use JSON: {"selector":"css","extract":[...]} or {"fill":"css","index":N,"value":"..."} or {"click":"css","index":N}' };
        },
      });
      if (val && val.error) return { success: false, error: val.error };
      return { success: true, result: val };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // ── evaluate_raw via chrome.userScripts (USER_SCRIPT world, bypasses CSP) ──
  // chrome.scripting.executeScript runs in isolated world but is still bound by
  // the page's CSP — `unsafe-eval` is denied on aistudio.google.com / banks /
  // many SPAs, so `new Function(code)` throws.
  // chrome.userScripts.execute() runs in a separate USER_SCRIPT world that is
  // explicitly exempt from page CSP and allows eval — exactly what we need.
  // Requires Chrome 135+ and the "Allow user scripts" toggle in chrome://extensions.
  if (action === 'mcp_evaluate_raw') {
    if (!chrome.userScripts) {
      return { success: false, error: 'chrome.userScripts unavailable. Need Chrome 135+ and "Allow user scripts" toggle enabled in chrome://extensions for this extension.' };
    }
    try {
      const code = command.code;
      const isExpr = !!command.expression;
      const isAsync = !!command.async;
      const maxDepth = typeof command.maxDepth === 'number' ? command.maxDepth : 4;

      // The code we ship to the page. We define safeSerialize inside, then
      // wrap user code, capture the returned value, and return a structured
      // {ok, value|error} object. userScripts evaluates the STRING and returns
      // its last-expression value.
      const userBody = isExpr
        ? (isAsync ? `return (async()=>(${code}))()` : `return (${code})`)
        : (isAsync ? `return (async()=>{${code}})()` : code);

      const wrapped = `
(async () => {
  function safeSerialize(v, limit) {
    const seen = new WeakSet();
    const walk = (x, depth) => {
      if (x === null || x === undefined) return x;
      const t = typeof x;
      if (t === 'string') return x.length > 50000 ? x.slice(0, 50000) + '…[' + x.length + ']' : x;
      if (t === 'number' || t === 'boolean') return x;
      if (t === 'bigint') return x.toString();
      if (t === 'function') return '[Function ' + (x.name || 'anonymous') + ']';
      if (t === 'symbol') return x.toString();
      if (depth >= limit) return Array.isArray(x) ? '[Array(' + x.length + ')]' : '[Object]';
      if (x instanceof Element) return { __dom: true, tag: x.tagName.toLowerCase(), id: x.id || undefined, cls: x.className || undefined, text: (x.textContent || '').trim().slice(0, 200) };
      if (x instanceof NodeList || x instanceof HTMLCollection) return Array.from(x).slice(0, 100).map(n => walk(n, depth + 1));
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
          if (count++ >= 100) { out['…'] = '+' + (Object.keys(x).length - 100) + ' more'; break; }
          try { out[k] = walk(x[k], depth + 1); } catch (e) { out[k] = '[Error: ' + e.message + ']'; }
        }
        return out;
      }
      return String(x);
    };
    try { return walk(v, 0); } catch (e) { return '[Serialize error: ' + e.message + ']'; }
  }
  try {
    const __r = await (async function userCode(){ ${userBody} })();
    return { ok: true, value: safeSerialize(__r, ${maxDepth}) };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
})()`;

      const results = await chrome.userScripts.execute({
        target: { tabId: targetTabId },
        js: [{ code: wrapped }],
        world: 'USER_SCRIPT',
      });
      const first = results && results[0];
      if (!first) return { success: false, error: 'userScripts.execute returned no frames' };
      if (first.error) return { success: false, error: first.error };
      const r = first.result;
      if (!r) return { success: false, error: 'no result from page' };
      if (!r.ok) return { success: false, error: r.error };
      return { success: true, result: r.value };
    } catch (e) {
      const msg = e && e.message || String(e);
      // Detect the specific "toggle disabled" symptom.
      if (/developer mode|user scripts|user-script/i.test(msg)) {
        return { success: false, error: msg + ' — enable "Allow user scripts" in chrome://extensions for this extension' };
      }
      return { success: false, error: msg };
    }
  }

  // ── Yandex Maps search (internal SSR data, no API key, no signature) ──
  //
  // Яндекс.Карты при загрузке /maps/<region>/search/<query>/ встраивают весь
  // результат выдачи в HTML страницы (SSR-state, inline <script>). Каждый item
  // несёт title/address/coordinates/phones/businessLinks(сайт)/socialLinks/
  // ratingData/workingTime/categories/distance — всё что нужно. Нам НЕ нужен
  // ни платный Search API, ни fetch к /maps/api/search (там HMAC-подпись `s` по
  // всему query — реплей хрупок). Мы просто навигируем вкладку на канонический
  // search-URL и читаем встроенный state из MAIN world.
  //
  // Локация детерминирована URL'ом:
  //   yandex.ru/maps/<regionId>/<citySlug>/search/<query>/?ll=lon,lat&spn=..&z=..
  // regionId: 2=СПб, 213=Москва. Можно и просто текст с городом ("осанка спб").
  // В ответе data.bounds = реальная область покрытия, totalResultCount = всего
  // в этой области. Stateless: возвращаем area_covered+total+fetched+remaining,
  // состояние «сколько осталось» держит вызывающая сторона (Claude), не storage.
  //
  // См. docs/knowledge/fact-yandex-maps.md.
  if (action === 'mcp_yandex_search') {
    const query = String(command.query || '').trim();
    if (!query) return { success: false, error: 'query is required' };

    // Сборка канонического search-URL.
    // region: 'spb'|'2' → 2, 'msk'|'moscow'|'213' → 213, либо явный числовой id.
    const REGION_IDS = { spb: 2, 'санкт-петербург': 2, питер: 2, msk: 213, moscow: 213, москва: 213 };
    let regionId = command.regionId;
    if (!regionId && command.region) {
      const rk = String(command.region).toLowerCase().trim();
      regionId = REGION_IDS[rk] || (/^\d+$/.test(rk) ? +rk : null);
    }
    // Если region не распознан — отдаём поиск без region-сегмента (Яндекс сам
    // определит по тексту/контексту карты). citySlug косметический.
    const citySlug = regionId === 213 ? 'moscow' : regionId === 2 ? 'saint-petersburg' : 'moscow';
    let baseUrl;
    if (regionId) {
      baseUrl = `https://yandex.ru/maps/${regionId}/${citySlug}/search/${encodeURIComponent(query)}/`;
    } else {
      baseUrl = `https://yandex.ru/maps/?text=${encodeURIComponent(query)}&mode=search`;
    }
    // Опциональные ll/spn/z для центрирования области поиска.
    // КРИТИЧНО для пагинации: чтобы страницы были консистентны (одна и та же
    // область на page=1,2,3...), область надо ЗАФИКСИРОВАТЬ явными ll+spn. Без
    // них navigate на ?page=N смещает вьюпорт карты → bounds/выдача «плывут»
    // между страницами (проверено: total скачет 69→40, результаты не стыкуются).
    const extra = [];
    if (command.ll) extra.push('ll=' + encodeURIComponent(command.ll));
    if (command.spn) extra.push('spn=' + encodeURIComponent(command.spn));
    if (command.z) extra.push('z=' + encodeURIComponent(command.z));
    const extraQs = extra.join('&');

    // Пагинация. Яндекс листает нумерованными страницами через ?page=N
    // (1-based: page=1 — первая, дефолт). По ~25 орг на страницу. Догрузка
    // скроллом завязана на IntersectionObserver и НЕ будится синтетикой —
    // поэтому листаем навигацией на ?page=N и читаем SSR-state каждой.
    //
    // max_pages: 1 (дефолт) — только первая страница; >1 — авто-листание;
    // 'all'/0/negative — листать до конца (cap MAX_PAGES_HARD на всякий).
    const MAX_PAGES_HARD = 40;
    let maxPages;
    const mp = command.max_pages;
    if (mp === 'all' || mp === 0 || mp === '0' || (typeof mp === 'number' && mp < 0)) maxPages = MAX_PAGES_HARD;
    else if (mp == null) maxPages = 1;
    else maxPages = Math.min(MAX_PAGES_HARD, Math.max(1, parseInt(mp, 10) || 1));

    function buildUrl(page) {
      let u = baseUrl;
      const qs = [];
      if (extraQs) qs.push(extraQs);
      if (page > 1) qs.push('page=' + page);
      if (qs.length) u += (u.includes('?') ? '&' : '?') + qs.join('&');
      return u;
    }

    // Фоновая работа. По умолчанию открываем СОБСТВЕННУЮ фоновую вкладку и
    // листаем страницы в ней — юзер продолжает работать в браузере, его вкладки
    // не трогаются. autoDiscardable:false защищает от Yandex tab-freeze
    // (never-active вкладки замораживаются: throttling таймеров, discard layout)
    // без визуального флэша — то же что делаем для research-вкладок.
    // Если передан явный tabId — работаем в нём (background:false), на случай
    // когда вызывающий хочет видеть процесс или переиспользовать вкладку.
    // ownTab — флаг «эту вкладку мы создали и обязаны закрыть в finally». Ставится
    // в true ТОЛЬКО после успешного create с валидным id. Иначе при сбое create
    // workTabId остался бы = активной вкладке юзера, и finally закрыл бы ЕЁ.
    let workTabId = targetTabId;
    let ownTab = false;
    if (!command.tabId) {
      const created = await chrome.tabs.create({ url: 'about:blank', active: false });
      if (!created || typeof created.id !== 'number') {
        return { success: false, error: 'failed to open background tab for yandex search' };
      }
      workTabId = created.id;
      ownTab = true;
      try { await chrome.tabs.update(workTabId, { autoDiscardable: false }); } catch {}
      // Визуально метим вкладку (favicon + title "yandex-maps") как остальные
      // MCP-вкладки — юзер видит её в таб-баре и не путает с обычным Яндексом.
      // onUpdated-listener в background.js пере-инжектит guard на каждый
      // navigation (about:blank → /maps → ?page=N). onRemoved снимет из map
      // когда finally закроет вкладку. См. fact-browser-tab-marking.md.
      try { await markTabAsMcpVisually(workTabId, 'yandex'); } catch {}
    }

    async function navAndExtract(page) {
      const u = buildUrl(page);
      await chrome.tabs.update(workTabId, { url: u });
      await new Promise(resolve => {
        function l(id, info) {
          if (id === workTabId && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(l);
            resolve();
          }
        }
        chrome.tabs.onUpdated.addListener(l);
        setTimeout(() => { chrome.tabs.onUpdated.removeListener(l); resolve(); }, 15000);
      });
      // Дать Angular дорисовать (SSR-state доступен и без этого, но на всякий).
      await new Promise(r => setTimeout(r, 500));
      let injected;
      try {
        [injected] = await chrome.scripting.executeScript({
          target: { tabId: workTabId },
          world: 'MAIN',
          args: [query],
          func: extractYandexSearch,
        });
      } catch (e) {
        return { error: 'MAIN-world inject failed: ' + (e?.message || e), url: u };
      }
      const d = injected?.result;
      if (!d) return { error: 'no result from page (inject returned empty)', url: u };
      d._url = u;
      return d;
    }

    // Цикл по страницам с дедупом по id. Останов когда:
    //  - страница вернула 0 НОВЫХ (дубли) → выдача исчерпана
    //  - страница вернула < perPage (обычно 25) → последняя страница
    //  - достигнут maxPages
    // total_in_area от Яндекса нестабилен между страницами (релевантностная
    // оценка, не строгий count) — поэтому он СПРАВОЧНЫЙ (берём max наблюдённый),
    // а истина по полноте — флаг complete (дошли до страницы с недобором/дублями).
    const byId = new Map();
    let firstPage = null;
    let totalSeen = 0;
    let perPage = 25;
    let pagesFetched = 0;
    let lastUrl = null;
    let stopReason = 'max_pages';
    let fatalError = null;

    try {
      for (let page = 1; page <= maxPages; page++) {
        const d = await navAndExtract(page);
        if (d.error) {
          // первая страница упала — фатально; на последующих — стоп с тем что есть
          if (page === 1) { fatalError = { error: d.error, url: d.url }; break; }
          stopReason = 'page_error';
          break;
        }
        pagesFetched++;
        lastUrl = d._url;
        if (!firstPage) firstPage = d;
        if (typeof d.total_in_area === 'number') totalSeen = Math.max(totalSeen, d.total_in_area);
        const pageResults = d.results || [];
        if (pageResults.length) perPage = Math.max(perPage, pageResults.length);

        let added = 0;
        for (const r of pageResults) {
          const key = r.id || (r.title + '|' + (r.address || ''));
          if (!byId.has(key)) { byId.set(key, r); added++; }
        }

        // условия останова
        if (added === 0) { stopReason = 'no_new_results'; break; }
        if (pageResults.length < perPage) { stopReason = 'last_page_short'; break; }
        if (page === maxPages) { stopReason = 'max_pages'; break; }
      }
    } finally {
      // Закрываем ТОЛЬКО вкладку, которую сами создали (ownTab). Вкладку
      // вызывающего (явный tabId) не трогаем никогда.
      if (ownTab) { try { await chrome.tabs.remove(workTabId); } catch {} }
    }

    if (fatalError) return { success: false, ...fatalError };

    const results = [...byId.values()];
    const fetched = results.length;
    // total_in_area: справочная оценка Яндекса; не меньше реально собранного.
    const total = Math.max(totalSeen, fetched);
    const complete = stopReason === 'no_new_results' || stopReason === 'last_page_short';
    return {
      success: true,
      url: lastUrl,
      query: firstPage?.query || query,
      corrected_query: firstPage?.corrected_query || null,
      area_covered: firstPage?.area_covered || null,
      total_in_area: total,         // справочно (оценка Яндекса, может занижать/завышать)
      fetched,                       // реально собрано уникальных организаций
      remaining: complete ? 0 : Math.max(0, total - fetched), // 0 если выдача исчерпана
      complete,                      // ИСТИНА по полноте: дошли ли до конца выдачи
      pages_fetched: pagesFetched,
      stop_reason: stopReason,       // no_new_results | last_page_short | max_pages | page_error
      results,
    };
  }

  // Commands that need content script
  const csActions = [
    'mcp_snapshot', 'mcp_inspect', 'mcp_act',
    'mcp_click', 'mcp_fill', 'mcp_get_text', 'mcp_scroll',
    'mcp_scroll_element', 'mcp_wait_for_selector',
    'mcp_harvest_virtual_list', 'mcp_get_storage', 'mcp_get_element_rect',
    'mcp_hover',
  ];
  if (csActions.includes(action)) {
    // Inject mcp-content.js into main frame AND all sub-frames (for modals in iframes)
    try {
      await chrome.scripting.executeScript({
        target: { tabId: targetTabId, allFrames: true },
        files: ['mcp-content.js'],
      });
    } catch (e) {
      console.log('[SC MCP] inject note:', e.message);
    }

    await new Promise(r => setTimeout(r, 100));

    // v2 inspect/act сами проходят shadow/iframe из frame 0 — отдаём ВЕРБАТИМ
    // без multi-frame fallback'а. Иначе structured-конверт (status=ambiguous/
    // blocked + candidates + suggestions) схлопнулся бы в голый {success,error}:
    // fallback ниже считает любой success:false поводом «пробуй другой фрейм»
    // и в конце возвращает только result.error.
    if (action === 'mcp_inspect' || action === 'mcp_act') {
      try {
        return await chrome.tabs.sendMessage(targetTabId, command, { frameId: 0 });
      } catch (e) {
        return { success: false, status: 'blocked', action, error: 'content script not reachable on frame 0: ' + e.message };
      }
    }

    // Try main frame first. Use frameId: 0 explicitly so we don't receive the
    // first-arriving response from a random iframe (sendMessage without frameId
    // broadcasts and resolves with whichever CS replies first).
    let mainFrameError = null; // explicit error from CS — return it if no frame succeeds
    try {
      const result = await chrome.tabs.sendMessage(targetTabId, command, { frameId: 0 });
      if (result && (result.success || result.snapshot || result.text)) {
        return result;
      }
      // If CS responded with an explicit error, remember it but keep trying sub-frames.
      if (result && result.success === false && result.error) {
        mainFrameError = result.error;
      }
      // If main frame returned empty/no elements, try sub-frames
      if (action === 'mcp_snapshot' && result?.snapshot) {
        const parsed = JSON.parse(result.snapshot);
        if (parsed.elements && parsed.elements.length > 5) return result;
      }
    } catch (e) {
      // Main frame failed, will try frames below
    }

    // Try all frames — LinkedIn modals render in iframes
    try {
      const frames = await chrome.webNavigation.getAllFrames({ tabId: targetTabId });
      for (const frame of frames) {
        if (frame.frameId === 0) continue; // skip main frame (already tried)
        try {
          const result = await chrome.tabs.sendMessage(targetTabId, command, { frameId: frame.frameId });
          if (result && (result.success || result.snapshot || result.text)) {
            return result;
          }
        } catch (_) {}
      }
    } catch (e) {
      console.log('[SC MCP] Frame enumeration failed:', e.message);
    }

    if (mainFrameError) return { success: false, error: mainFrameError };
    return { success: false, error: 'No response from any frame' };
  }

  return { success: false, error: `Unknown MCP action: ${action}` };
}

// ── extractYandexSearch — инжектится в MAIN world вкладки yandex.ru/maps ──
//
// Должна быть САМОДОСТАТОЧНОЙ функцией (никаких замыканий на SW-scope) — она
// сериализуется и исполняется в контексте страницы. Возвращает либо
// {query, area_covered, total_in_area, fetched, remaining, has_more, results[]},
// либо {error}.
//
// Стратегия поиска встроенного state (по убыванию надёжности):
//  1) Известные Яндексовые глобалы (window.__INITIAL_STATE__ и т.п.).
//  2) Обход всех inline-<script>, поиск '"totalResultCount"' и извлечение
//     ОХВАТЫВАЮЩЕГО JSON-объекта балансировкой скобок, затем JSON.parse.
function extractYandexSearch(query) {
  // --- 1. найти объект выдачи (есть items[] и totalResultCount) ---
  function looksLikeSerp(o) {
    return o && typeof o === 'object' && Array.isArray(o.items) &&
           (typeof o.totalResultCount === 'number' || typeof o.resultsCount === 'number');
  }
  // рекурсивный поиск serp-объекта внутри произвольного state (ограниченная глубина)
  function deepFind(root, maxDepth) {
    const seen = new WeakSet();
    const stack = [[root, 0]];
    while (stack.length) {
      const [node, d] = stack.pop();
      if (!node || typeof node !== 'object' || seen.has(node) || d > maxDepth) continue;
      seen.add(node);
      if (looksLikeSerp(node)) return node;
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (v && typeof v === 'object') stack.push([v, d + 1]);
      }
    }
    return null;
  }

  let serp = null;
  // 1a. известные глобалы
  const globalCands = [];
  for (const key of Object.keys(window)) {
    if (/INITIAL_STATE|__maps|mapsState|preloaded|__config|store/i.test(key)) {
      try { if (window[key] && typeof window[key] === 'object') globalCands.push(window[key]); } catch {}
    }
  }
  for (const g of globalCands) {
    serp = deepFind(g, 6);
    if (serp) break;
  }

  // 1b. fallback — парсинг inline-script с балансировкой скобок
  if (!serp) {
    const scripts = Array.from(document.querySelectorAll('script'));
    for (const s of scripts) {
      const t = s.textContent || '';
      const anchor = t.indexOf('"totalResultCount"');
      if (anchor < 0) continue;
      // идём влево от anchor ищем '{' который откроет объект; берём ближайший
      // разумный старт: найдём '{' перед '"requestId"'/'"items"' рядом.
      // Надёжнее: расширяем влево до '{' и вправо балансировкой.
      let start = t.lastIndexOf('{', anchor);
      // отлистываем дальше влево пока не найдём { который при балансировке
      // охватит anchor И содержит "items"
      while (start > 0) {
        const obj = balancedSlice(t, start);
        if (obj && obj.includes('"items"') && obj.indexOf('"totalResultCount"') >= 0) {
          try {
            const parsed = JSON.parse(obj);
            if (looksLikeSerp(parsed)) { serp = parsed; break; }
            const nested = deepFind(parsed, 6);
            if (nested) { serp = nested; break; }
          } catch {}
        }
        start = t.lastIndexOf('{', start - 1);
        if (anchor - start > 200000) break; // не уходить слишком далеко
      }
      if (serp) break;
    }
  }

  function balancedSlice(str, openIdx) {
    let depth = 0, inStr = false, esc = false;
    for (let i = openIdx; i < str.length; i++) {
      const ch = str[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
      } else {
        if (ch === '"') inStr = true;
        else if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) return str.slice(openIdx, i + 1); }
      }
    }
    return null;
  }

  if (!serp) return { error: 'embedded searchResult not found on page (DOM/state changed?)' };

  // --- 2. нормализация одного бизнеса ---
  // Сайт в выдаче часто с рекламными хвостами (?yclid=…&utm_…) — отдаём и
  // полные href (sites[]), и «чистый» главный сайт (site) для navigate().
  function cleanUrl(u) {
    try {
      const x = new URL(u);
      // срезаем рекламные/трекинговые query-параметры
      ['yclid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_referrer', 'from', '_openstat']
        .forEach(p => x.searchParams.delete(p));
      const qs = x.searchParams.toString();
      return x.origin + x.pathname.replace(/\/$/, '') + (qs ? '?' + qs : '');
    } catch { return u; }
  }
  function siteOf(o) {
    const out = [];
    (o.urls || []).forEach(u => { if (typeof u === 'string') out.push(u); else if (u && u.href) out.push(u.href); });
    (o.businessLinks || []).forEach(l => { const h = (l.link && l.link.href) || l.href; if (h) out.push(h); });
    return [...new Set(out)];
  }
  // Соцсети раздувают payload (wa.me/viber несут ?text=«Обращение из Яндекс Карт…»
  // на сотни символов; один бизнес даёт 6-10 ссылок). Режем query у мессенджеров
  // (номер в path и так есть) и дедупим по типу — оставляем первую ссылку каждого
  // типа. Это срезало socials с ~40% веса ответа.
  function cleanSocial(href) {
    try {
      const x = new URL(href);
      if (/wa\.me|whatsapp|viber|t\.me|telegram/i.test(x.hostname)) {
        return x.origin + x.pathname; // отбрасываем ?text=…
      }
      return href;
    } catch { return href; }
  }
  function socialsOf(o) {
    const seen = new Set();
    const out = [];
    for (const l of (o.socialLinks || [])) {
      const href = (l.link && l.link.href) || l.href;
      if (!href || !l.type || seen.has(l.type)) continue;
      seen.add(l.type);
      out.push({ type: l.type, href: cleanSocial(href) });
    }
    return out;
  }
  function norm(o) {
    const rawSites = siteOf(o);
    const site = rawSites.length ? cleanUrl(rawSites[0]) : null;
    // sites отдаём ТОЛЬКО если есть вторая, реально отличная от главной ссылка —
    // иначе это дубль site и лишний вес.
    const extraSites = rawSites.slice(1).map(cleanUrl).filter(u => u && u !== site);
    const out = {
      title: o.title || o.shortTitle || null,
      address: o.fullAddress || o.address || null,
      coordinates: o.coordinates || null,                 // [lon, lat]
      phones: (o.phones || []).map(p => p.formatted || p.number).filter(Boolean),
      site,                                               // главный сайт без рекламных хвостов — для navigate()
      socials: socialsOf(o),
      rating: o.ratingData ? {
        score: o.ratingData.ratingValue ?? o.ratingData.score ?? null,
        votes: o.ratingData.ratingCount ?? null,
        reviews: o.ratingData.reviewCount ?? null,
      } : null,
      working_time: o.workingTimeText || null,
      open_now: o.currentWorkingStatus ? o.currentWorkingStatus.text : null,
      categories: (o.categories || []).map(c => c.name).filter(Boolean),
      id: o.id || null,
      seoname: o.seoname || null,
    };
    if (extraSites.length) out.sites = [site, ...extraSites]; // только когда реально >1
    return out;
  }

  const biz = (serp.items || []).filter(x => x.type === 'business').map(norm);
  const total = serp.totalResultCount ?? serp.resultsCount ?? biz.length;
  return {
    query: serp.requestQuery || query,
    corrected_query: serp.requestCorrectedQuery && serp.requestCorrectedQuery !== serp.requestQuery ? serp.requestCorrectedQuery : null,
    area_covered: serp.bounds || serp.requestBounds || null,  // [[lon,lat],[lon,lat]]
    total_in_area: total,
    fetched: biz.length,
    remaining: Math.max(0, total - biz.length),
    has_more: total > biz.length,
    results: biz,
  };
}

// Start MCP bridge connection (will silently fail if not in dev mode)
connectMcpBridge();
