// ============ MCP Bridge ============
// Connects to local MCP bridge (ws://127.0.0.1:3457).
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

const MCP_WS_URL = 'ws://127.0.0.1:3457';
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
  if (command.action === 'mcp_evaluate_raw' && command.world === 'MAIN'
    && (!Number.isInteger(command.tabId) || command.__implicitTabId)) {
    return { success: false, error: 'MAIN execution requires an explicit tabId' };
  }
  const pageActions = new Set([
    'mcp_evaluate', 'mcp_evaluate_raw', 'mcp_click', 'mcp_fill', 'mcp_act',
    'mcp_snapshot', 'mcp_inspect', 'mcp_get_text', 'mcp_scroll', 'mcp_scroll_element',
    'mcp_hover', 'mcp_wait_for_selector', 'mcp_navigate', 'mcp_reload_tab',
  ]);
  if (pageActions.has(command.action) && globalThis.scMcpNativeDialogs) {
    let explicitTabId = command.tabId;
    if (!Number.isInteger(explicitTabId)) {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!active) return { success: false, error: 'No active tab' };
      explicitTabId = active.id;
    }
    return globalThis.scMcpNativeDialogs.run(explicitTabId, command.action,
      () => handleMcpCommandCore({ ...command, tabId: explicitTabId }));
  }
  return handleMcpCommandCore(command);
}

async function handleMcpCommandCore(command) {
  const { action, tabId } = command;

  if (action === 'mcp_native_browser_info') {
    const ua = navigator.userAgent || '';
    let browser = /YaBrowser\//.test(ua) ? 'yandex' : /Edg\//.test(ua) ? 'edge' : null;
    if (!browser && navigator.brave?.isBrave && await navigator.brave.isBrave()) browser = 'brave';
    if (!browser && /Chrome\//.test(ua)) browser = 'chrome';
    return { success: true, browser, capabilities: { evaluateRawWorlds: ['USER_SCRIPT', 'MAIN'] } };
  }

  // Dialog control never falls back to the active tab or page JS: a modal can
  // block both content-script execution and the response to the original click.
  if (action === 'mcp_read_dialog' || action === 'mcp_handle_dialog' || action === 'mcp_release_dialog_observer') {
    if (!Number.isInteger(tabId)) return { success: false, errorCode: 'DIALOG_ARGUMENTS', error: 'Explicit tabId required' };
    const dialogs = globalThis.scMcpNativeDialogs;
    if (!dialogs) return { success: false, errorCode: 'DIALOG_OBSERVER_UNAVAILABLE', error: 'Native dialog controller not loaded' };
    if (action === 'mcp_release_dialog_observer') return dialogs.release(tabId);
    return action === 'mcp_read_dialog' ? dialogs.read(tabId, command.operationId) : dialogs.handle(command);
  }

  // Window discovery must not depend on whichever window Chrome currently
  // considers "current" for this service worker. OAuth/payment popups are
  // separate top-level windows, each with its own active tab.
  if (action === 'mcp_list_tabs' || action === 'mcp_list_windows') {
    const browserWindows = await chrome.windows.getAll({ populate: true });
    if (action === 'mcp_list_windows') {
      return { success: true, windows: scMcpSerializeWindows(browserWindows) };
    }
    return { success: true, tabs: scMcpFlattenWindows(browserWindows) };
  }

  // Read the extension-owned fallback exporter log. This is intentionally
  // separate from page localStorage/sessionStorage: logger.js mirrors the
  // last 500 structured events here when Native Messaging is unavailable.
  if (action === 'mcp_exporter_logs') {
    const raw = await chrome.storage.local.get({ __aise_buffer: [] });
    const all = Array.isArray(raw.__aise_buffer) ? raw.__aise_buffer : [];
    const requestedLimit = Number(command.limit);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(500, Math.max(1, Math.trunc(requestedLimit)))
      : 200;
    const filtered = command.exportId
      ? all.filter(evt => evt?.exportId === command.exportId)
      : all;
    return {
      success: true,
      events: filtered.slice(-limit),
      totalBuffered: all.length,
      matched: filtered.length,
    };
  }

  // Trigger the exact same per-site export flow as the popup's
  // "Экспортировать" button, but for an explicit tab. The command only
  // acknowledges delivery to the page: AI Studio / Perplexity / Claude run
  // the export asynchronously and report progress in their in-page overlay.
  // `downloadFile` defaults to true for agent callers so the result is a
  // durable artefact instead of silently replacing the user's clipboard.
  if (action === 'mcp_export_conversation') {
    if (!Number.isInteger(tabId)) {
      return { success: false, error: 'tabId is required for conversation export' };
    }

    const tab = await chrome.tabs.get(tabId);
    const url = String(tab?.url || '');
    let site = null;
    try {
      const parsed = new URL(url);
      if (parsed.hostname === 'aistudio.google.com' && /^\/(?:u\/\d+\/)?prompts\//.test(parsed.pathname)) {
        site = 'aistudio';
      } else if (parsed.hostname === 'www.perplexity.ai' && /^\/(?:search|computer\/tasks)\//.test(parsed.pathname)) {
        site = 'perplexity';
      } else if (parsed.hostname === 'claude.ai' && /^\/chat\/[0-9a-f-]+/i.test(parsed.pathname)) {
        site = 'claude';
      } else if ((parsed.hostname === 'chatgpt.com' || parsed.hostname === 'www.chatgpt.com') && /^\/c\//.test(parsed.pathname)) {
        site = 'chatgpt';
      }
    } catch (_) {}

    if (!site) {
      return {
        success: false,
        error: 'Conversation export supports AI Studio, Perplexity, Claude, and ChatGPT chat tabs only',
      };
    }

    const stored = await new Promise(resolve => chrome.storage.sync.get({
      __export: { downloadFile: false },
      __pplx: {},
      __claude: {},
      __chatgpt: {},
    }, resolve));
    const requested = command.settings && typeof command.settings === 'object' && !Array.isArray(command.settings)
      ? command.settings
      : {};
    const downloadFile = typeof command.downloadFile === 'boolean' ? command.downloadFile : true;
    const exportSettings = {
      ...(stored.__export && typeof stored.__export === 'object' ? stored.__export : {}),
      ...(requested.__export && typeof requested.__export === 'object' ? requested.__export : {}),
      downloadFile,
    };

    let settings;
    if (site === 'perplexity') {
      settings = {
        ...(stored.__pplx && typeof stored.__pplx === 'object' ? stored.__pplx : {}),
        ...requested,
        __export: exportSettings,
      };
    } else if (site === 'claude') {
      settings = {
        ...(stored.__claude && typeof stored.__claude === 'object' ? stored.__claude : {}),
        ...requested,
        __export: exportSettings,
      };
    } else if (site === 'chatgpt') {
      settings = {
        ...(stored.__chatgpt && typeof stored.__chatgpt === 'object' ? stored.__chatgpt : {}),
        ...requested,
        __export: exportSettings,
      };
    } else {
      // AI Studio's exporter owns its top-level scrape settings in storage;
      // only this one-shot override is passed inline and never persisted.
      settings = { ...requested, __export: exportSettings };
    }

    let response;
    try {
      response = await chrome.tabs.sendMessage(tabId, { action: 'export', settings }, { frameId: 0 });
    } catch (error) {
      const message = error?.message || String(error);
      return {
        success: false,
        error: /Receiving end does not exist|Could not establish connection/i.test(message)
          ? 'Export content script is not attached. Reload this tab and retry.'
          : message,
      };
    }

    if (response?.success === false) {
      return { success: false, error: response.message || 'Export was rejected by the page' };
    }
    return {
      success: true,
      accepted: response?.accepted === true || response?.success === true,
      site,
      tabId,
      title: tab?.title || '',
      url,
      delivery: downloadFile ? 'download' : 'clipboard',
      note: 'Command accepted by the page; follow the in-page overlay or exporter log for terminal status.',
    };
  }

  if (action === 'mcp_new_window') {
    const created = await chrome.windows.create(scMcpWindowCreateOptions(command));
    if (!Number.isInteger(created?.id)) {
      return { success: false, error: 'Browser did not return a window ID' };
    }
    const createdTabId = created?.tabs?.[0]?.id;
    if (command.url && Number.isInteger(createdTabId) && created.tabs?.[0]?.status !== 'complete') {
      await new Promise(resolve => {
        function listener(updatedTabId, changeInfo) {
          if (updatedTabId === createdTabId && changeInfo.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        }
        chrome.tabs.onUpdated.addListener(listener);
        setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }, 15000);
      });
    }
    const browserWindow = await chrome.windows.get(created.id, { populate: true });
    return { success: true, window: scMcpSerializeWindow(browserWindow) };
  }

  if (action === 'mcp_focus_window') {
    await chrome.windows.update(command.windowId, { focused: true });
    const browserWindow = await chrome.windows.get(command.windowId, { populate: true });
    return { success: true, window: scMcpSerializeWindow(browserWindow) };
  }

  if (action === 'mcp_close_window') {
    await chrome.windows.remove(command.windowId);
    return { success: true, windowId: command.windowId };
  }

  if (action === 'mcp_find_research_tab') {
    const target = String(command.url || '');
    if (!target) return { success: false, error: 'url required' };
    if (typeof scFindResearchTab !== 'function') {
      return { success: false, error: 'research tab registry unavailable' };
    }
    const existing = await scFindResearchTab(chrome, target);
    return {
      success: true,
      tabId: existing?.id ?? null,
      url: existing?.url || target,
      found: !!existing,
    };
  }

  // Resolve target tab
  let targetTabId = tabId;
  if (!targetTabId) {
    // Use the active tab in the current window
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab) return { success: false, error: 'No active tab' };
    targetTabId = activeTab.id;
  }

  // Force-reload расширения по требованию (когда hot-reload spying не успел
  // увидеть mtime-расхождение и юзер хочет применить свежий код прямо сейчас
  // без manual ⟳ в chrome://extensions/). Отправляем ack ДО reload — иначе
  // вызывающая сторона не получит ответа.
  if (action === 'mcp_force_reload') {
    const gate = globalThis.scResearchReloadGate;
    if (!gate?.request) return { success: false, error: 'research-aware reload gate unavailable' };
    const outcome = await gate.request('mcp_force_reload');
    return { success: true, ...outcome };
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
    const target = String(command.url || '');
    if (!target) return { success: false, error: 'url required' };
    const researchId = typeof scResearchIdFromUrl === 'function' ? scResearchIdFromUrl(target) : null;
    let tab = typeof scFindResearchTab === 'function'
      ? await scFindResearchTab(chrome, target)
      : null;
    const reused = !!tab;
    if (!tab) {
      tab = await chrome.tabs.create({
        url: target,
        active: false,
      });
    }
    // Lifecycle ownership becomes visible synchronously, before any
    // debugger/storage/load await. A main-frame failure can happen between
    // tabs.create() resolution and the first durable storage write; the
    // navigation coordinator can still recover the id from the URL.
    let startupTracking = Promise.resolve(null);
    try {
      if (typeof beginResearchTabTracking === 'function') {
        startupTracking = beginResearchTabTracking(RESEARCH_TABS, globalThis.scResearchStartup, {
          researchId,
          tab: { ...tab, reused },
          targetUrl: target,
        });
      } else {
        RESEARCH_TABS.add(tab.id);
      }
    } catch (_) {
      try { RESEARCH_TABS.add(tab.id); } catch {}
    }
    // Set autoDiscardable=false ASAP — до load complete, чтобы Yandex
    // ни секунды не считал её never-active кандидатом на discard.
    try { await chrome.tabs.update(tab.id, { autoDiscardable: false }); } catch (e) {
      console.log('[mcp_open_research_tab] autoDiscardable set failed:', e?.message);
    }
    // Durable identity ДО debugger/load awaits. Если SW reload'нется после
    // tabs.create, повтор команды найдёт тот же tab и не создаст дубль.
    const durableWrites = [startupTracking];
    if (researchId && typeof scRememberResearchTab === 'function') {
      durableWrites.push(scRememberResearchTab(chrome, researchId, tab));
    }
    await Promise.all(durableWrites);
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
    if (tab.status !== 'complete') {
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
    }
    // Visually distinguish MCP-tab: extension's icon as favicon (sites cannot
    // be put into a specific Yandex tab group programmatically, see research).
    try { await markTabAsMcpVisually(tab.id); } catch {}
    return { success: true, tabId: tab.id, url: tab.url || target, researchId, reused };
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
          keepTab: command.keepTab === true || command.keep_tab === true,
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
    const createProperties = {
      url: command.url || 'about:blank',
      active: command.background ? false : true,
    };
    if (Number.isInteger(command.windowId)) createProperties.windowId = command.windowId;
    const tab = await chrome.tabs.create(createProperties);
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
    const currentTab = await chrome.tabs.get(tab.id);
    const browserWindow = await chrome.windows.get(currentTab.windowId);
    return {
      success: true,
      tabId: currentTab.id,
      windowId: currentTab.windowId,
      url: currentTab.url,
      tab: scMcpSerializeTab(currentTab, browserWindow),
    };
  }

  if (action === 'mcp_close_tab') {
    await chrome.tabs.remove(targetTabId);
    return { success: true };
  }

  if (action === 'mcp_focus_tab') {
    const tab = await chrome.tabs.get(targetTabId);
    await chrome.tabs.update(targetTabId, { active: true });
    if (Number.isInteger(tab.windowId)) await chrome.windows.update(tab.windowId, { focused: true });
    const currentTab = await chrome.tabs.get(targetTabId);
    const browserWindow = await chrome.windows.get(currentTab.windowId);
    return {
      success: true,
      tab: scMcpSerializeTab(currentTab, browserWindow),
    };
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
      const subCmd = {
        ...sub,
        tabId: sub.tabId ?? targetTabId,
        __implicitTabId: sub.tabId == null,
      };
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

  // evaluate_raw defaults to USER_SCRIPT; MAIN is explicit and shares page globals.
  // chrome.scripting.executeScript runs in isolated world but is still bound by
  // the page's CSP — `unsafe-eval` is denied on aistudio.google.com / banks /
  // many SPAs, so `new Function(code)` throws.
  // chrome.userScripts.execute() runs in a separate USER_SCRIPT world that is
  // explicitly exempt from page CSP and allows eval — exactly what we need.
  // Requires Chrome 135+ and the "Allow user scripts" toggle in chrome://extensions.
  if (action === 'mcp_evaluate_raw') {
    const world = command.world === undefined ? 'USER_SCRIPT' : command.world;
    if (!['USER_SCRIPT', 'MAIN'].includes(world)) return { success: false, error: 'Unsupported execution world' };
    if (world === 'MAIN' && !Number.isInteger(command.tabId)) {
      return { success: false, error: 'MAIN execution requires an explicit tabId' };
    }
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
        world,
      });
      const first = results && results[0];
      if (!first) return { success: false, error: 'userScripts.execute returned no frames' };
      if (first.error) return { success: false, error: first.error };
      const r = first.result;
      if (!r) return { success: false, error: 'no result from page' };
      if (!r.ok) return { success: false, error: r.error };
      return { success: true, result: r.value, executionWorld: world, documentId: first.documentId };
    } catch (e) {
      const msg = e && e.message || String(e);
      // Detect the specific "toggle disabled" symptom.
      if (/developer mode|user scripts|user-script/i.test(msg)) {
        return { success: false, error: msg + ' — enable "Allow user scripts" in chrome://extensions for this extension' };
      }
      return { success: false, error: msg };
    }
  }

  // ── Ozon catalog/search/favorites ─────────────────────────────────
  //
  // Ozon exposes the page payload through same-origin Composer endpoints.
  // We still drive the real browser profile so cookies, delivery address,
  // favorites, and account state match what the user sees manually. The
  // preferred path is /api/composer-api.bx/page/json/v2?url=<path>, with
  // DOM extraction only as a fallback when the widget shape changes.
  if (action === 'mcp_ozon_favorites' || action === 'mcp_ozon_purchases' || action === 'mcp_ozon_search') {
    const mode =
      action === 'mcp_ozon_favorites' ? 'favorites' :
      action === 'mcp_ozon_purchases' ? 'purchases' :
      'search';
    const hasExplicitTab = ozonHasExplicitTab(command);
    const purchaseSearchQuery = String(command.query || command.q || command.product || command.product_query || command.search || '').trim();
    let startUrl = command.url || '';
    if (!startUrl && hasExplicitTab) {
      try {
        const t = await chrome.tabs.get(targetTabId);
        startUrl = t?.url || '';
      } catch {}
    }
    if (!startUrl) {
      if (mode === 'favorites') {
        startUrl = 'https://www.ozon.ru/my/favorites';
      } else if (mode === 'purchases') {
        startUrl = purchaseSearchQuery
          ? 'https://www.ozon.ru/my/purchases/search?text=' + encodeURIComponent(purchaseSearchQuery)
          : 'https://www.ozon.ru/my/favorites/list?list=4294967294';
      } else {
        const query = String(command.query || command.q || '').trim();
        if (!query) return { success: false, error: 'query or url is required for Ozon search unless an explicit Ozon tabId is provided' };
        startUrl = 'https://www.ozon.ru/search/?text=' + encodeURIComponent(query);
      }
    }
    startUrl = ozonPrepareUrl(startUrl, command, mode, {
      preservePagination: !!command.url || hasExplicitTab,
    });

    const MAX_PAGES_HARD = mode === 'purchases' ? 120 : 30;
    let maxPages;
    const mp = command.max_pages;
    if (mp === 'all' || mp === 0 || mp === '0' || (typeof mp === 'number' && mp < 0)) maxPages = MAX_PAGES_HARD;
    else if (mp == null) maxPages = mode === 'favorites' || mode === 'purchases' ? MAX_PAGES_HARD : 1;
    else maxPages = Math.min(MAX_PAGES_HARD, Math.max(1, parseInt(mp, 10) || 1));

    const photoLimit = command.photo_limit == null
      ? 5
      : Math.max(0, Math.min(20, parseInt(command.photo_limit, 10) || 0));
    const rawResultLimit = command.limit == null ? 100 : command.limit;
    const resultLimit =
      rawResultLimit === 'all' || rawResultLimit === 0 || rawResultLimit === '0'
        ? null
        : Math.max(1, Math.min(500, parseInt(rawResultLimit, 10) || 100));
    const itemQueries = [
      command.query,
      command.q,
      command.product,
      command.product_query,
      command.search,
    ].map(v => String(v || '').trim()).filter(Boolean);
    const hasItemQuery = itemQueries.length > 0;
    function normItemSearchText(s) {
      return String(s || '').toLowerCase().replace(/ё/g, 'е');
    }
    function itemMatchesQuery(item) {
      if (!hasItemQuery) return true;
      const haystack = normItemSearchText([
        item.title,
        item.sku,
        item.id,
        item.url,
        ...(item.labels || []),
        ...(item.raw_texts || []),
      ].join('\n'));
      return itemQueries.some(q => {
        const normalized = normItemSearchText(q);
        if (!normalized) return true;
        if (haystack.includes(normalized)) return true;
        const tokens = normalized.split(/[^a-zа-я0-9]+/i).filter(t => t.length >= 3);
        if (!tokens.length) return false;
        return tokens.every(token => {
          if (haystack.includes(token)) return true;
          return token.length >= 6 && haystack.includes(token.slice(0, 6));
        });
      });
    }

    const useTabTransport = command.transport === 'tab' || command.use_current_tab === true;
    const activeSnapshot = useTabTransport && !hasExplicitTab ? await ozonCaptureActiveTab() : null;
    let workTabId = targetTabId;
    let ownTab = false;
    if (useTabTransport && !hasExplicitTab) {
      workTabId = await ozonOpenBackgroundTab(activeSnapshot, 'ozon catalog');
      ownTab = true;
    }

    async function extractOzon(u) {
      if (!useTabTransport) {
        try {
          const d = await extractOzonCatalogPage({
            mode,
            urlPath: ozonPathForApi(u),
            pageUrl: u,
            origin: 'https://www.ozon.ru',
            direct: true,
            debug: command.debug === true,
            photoLimit,
          });
          d.url = u;
          if (d.api_error) return { error: d.api_error, url: u, api_status: d.api_status, api_url: d.api_url };
          return d;
        } catch (e) {
          return { error: 'direct Ozon fetch failed: ' + (e?.message || e), url: u };
        }
      }
      await ozonNavigateTab(workTabId, u, activeSnapshot);
      let injected;
      try {
        [injected] = await chrome.scripting.executeScript({
          target: { tabId: workTabId },
          world: 'MAIN',
          args: [{
            mode,
            urlPath: ozonPathForApi(u),
            pageUrl: u,
            origin: 'https://www.ozon.ru',
            debug: command.debug === true,
            photoLimit,
          }],
          func: extractOzonCatalogPage,
        });
      } catch (e) {
        return { error: 'MAIN-world inject failed: ' + (e?.message || e), url: u };
      }
      const d = injected?.result;
      if (!d) return { error: 'no result from page (inject returned empty)', url: u };
      d.url = u;
      return d;
    }

    const byId = new Map();
    const seenItemKeys = new Set();
    const pages = [];
    let pageUrl = startUrl;
    let stopReason = 'max_pages';
    let fatalError = null;
    let firstPageData = null;
    const seenPageUrls = new Set();

    try {
      for (let page = 1; page <= maxPages; page++) {
        const pageKey = pageUrl.split('#')[0];
        if (seenPageUrls.has(pageKey)) {
          stopReason = 'same_next_url';
          break;
        }
        seenPageUrls.add(pageKey);
        const d = await extractOzon(pageUrl);
        if (d.error) {
          if (page === 1) { fatalError = d; break; }
          stopReason = 'page_error';
          break;
        }
        if (!firstPageData) firstPageData = d;
        const pageItems = d.items || [];
        const pageRecord = {
          page,
          url: pageUrl,
          api_url: d.api_url,
          count: pageItems.length,
          title: d.title,
          page_type: d.page_info?.pageType || null,
          next_url: null,
          synthesized_next_url: false,
          transport: useTabTransport ? 'tab' : 'direct',
        };
        pages.push(pageRecord);

        let added = 0;
        let newScanned = 0;
        for (const item of pageItems) {
          const key = item.id || item.sku || item.url || item.title;
          if (!key) continue;
          if (!seenItemKeys.has(key)) {
            seenItemKeys.add(key);
            newScanned++;
          }
          if (byId.has(key)) continue;
          if (!itemMatchesQuery(item)) continue;
          if (resultLimit != null && byId.size >= resultLimit) break;
          byId.set(key, item);
          added++;
        }
        if (resultLimit != null && byId.size >= resultLimit) { stopReason = 'limit'; break; }
        if (!pageItems.length) { stopReason = 'empty_page'; break; }
        if (newScanned === 0) { stopReason = 'no_new_results'; break; }
        if (page === maxPages) { stopReason = 'max_pages'; break; }
        const nextUrl =
          d.pagination?.next_url ||
          ((mode === 'favorites' || mode === 'purchases') && ozonCanSynthesizeCursorPage(pageUrl)
            ? ozonBuildCursorPageUrl(pageUrl, pageItems, page + 1)
            : null);
        pageRecord.next_url = nextUrl;
        pageRecord.synthesized_next_url = !!nextUrl && !d.pagination?.next_url;
        if (nextUrl && !seenPageUrls.has(nextUrl.split('#')[0])) {
          pageUrl = nextUrl;
        } else if (mode === 'search') {
          pageUrl = ozonSetPageParam(startUrl, page + 1);
        } else {
          stopReason = 'pagination_end';
          break;
        }
      }

      if (fatalError) return { success: false, error: fatalError.error, url: fatalError.url };

      const items = [...byId.values()].slice(0, resultLimit || undefined);
      const complete = ['empty_page', 'no_new_results', 'pagination_end', 'same_next_url'].includes(stopReason);
      return {
        success: true,
        mode,
        url: startUrl,
        fetched: items.length,
        scanned: seenItemKeys.size,
        complete,
        pages_fetched: pages.length,
        stop_reason: stopReason,
        pages,
        page_info: firstPageData?.page_info || null,
        location: firstPageData?.location || null,
        filters: firstPageData?.filters || null,
        sort: firstPageData?.sort || null,
        catalog: firstPageData?.catalog || null,
        counters: firstPageData?.counters || null,
        ...(command.debug ? { debug: firstPageData?.debug || null } : {}),
        items,
      };
    } finally {
      if (ownTab && command.keep_open !== true) {
        await avitoCloseBackgroundTab(workTabId, activeSnapshot);
      } else if (activeSnapshot) {
        await ozonRestoreActiveTab(activeSnapshot, workTabId);
      }
    }
  }

  // ── Ozon orders/history/detail ───────────────────────────────────
  //
  // The order list page only exposes order cards and detail links. Product
  // names and direct /product/... links live in each orderdetails Composer
  // payload, so history search can optionally enrich order cards with details.
  if (action === 'mcp_ozon_order_detail') {
    const hasExplicitTab = ozonHasExplicitTab(command);
    let detailUrl = command.url || command.detail_url || '';
    const orderId = command.order_id || command.order || command.order_number || command.orderNumber;
    if (!detailUrl && orderId) {
      detailUrl = 'https://www.ozon.ru/my/orderdetails/?order=' + encodeURIComponent(String(orderId));
    }
    if (!detailUrl && hasExplicitTab) {
      try {
        const t = await chrome.tabs.get(targetTabId);
        detailUrl = t?.url || '';
      } catch {}
    }
    if (!detailUrl) {
      return { success: false, error: 'order_id or url is required for Ozon order detail unless an explicit orderdetails tabId is provided' };
    }
    detailUrl = ozonPrepareOrderDetailUrl(detailUrl, command);

    const photoLimit = command.photo_limit == null
      ? 5
      : Math.max(0, Math.min(20, parseInt(command.photo_limit, 10) || 0));
    const useTabTransport = command.transport === 'tab' || command.use_current_tab === true;
    const activeSnapshot = useTabTransport && !hasExplicitTab ? await ozonCaptureActiveTab() : null;
    let workTabId = targetTabId;
    let ownTab = false;
    if (useTabTransport && !hasExplicitTab) {
      workTabId = await ozonOpenBackgroundTab(activeSnapshot, 'ozon order detail');
      ownTab = true;
    }

    try {
      let detail;
      if (!useTabTransport) {
        try {
          detail = await extractOzonOrderDetailPage({
            urlPath: ozonPathForApi(detailUrl),
            pageUrl: detailUrl,
            origin: 'https://www.ozon.ru',
            direct: true,
            photoLimit,
          });
        } catch (e) {
          return { success: false, error: 'direct Ozon fetch failed: ' + (e?.message || e), url: detailUrl };
        }
      } else {
        await ozonNavigateTab(workTabId, detailUrl, activeSnapshot);
        let injected;
        try {
          [injected] = await chrome.scripting.executeScript({
            target: { tabId: workTabId },
            world: 'MAIN',
            args: [{
              urlPath: ozonPathForApi(detailUrl),
              pageUrl: detailUrl,
              origin: 'https://www.ozon.ru',
              photoLimit,
            }],
            func: extractOzonOrderDetailPage,
          });
        } catch (e) {
          return { success: false, error: 'MAIN-world inject failed: ' + (e?.message || e), url: detailUrl };
        }
        detail = injected?.result;
      }
      if (!detail) return { success: false, error: 'no result from page (inject returned empty)', url: detailUrl };
      if (detail.error) return { success: false, error: detail.error, url: detailUrl };
      return {
        success: true,
        transport: useTabTransport ? 'tab' : 'direct',
        url: detailUrl,
        order: detail,
      };
    } finally {
      if (ownTab && command.keep_open !== true) {
        await avitoCloseBackgroundTab(workTabId, activeSnapshot);
      } else if (activeSnapshot) {
        await ozonRestoreActiveTab(activeSnapshot, workTabId);
      }
    }
  }

  if (action === 'mcp_ozon_product_images') {
    const specs = ozonCartSpecsFromCommand(command);
    if (!specs.length) return { success: false, error: 'url/sku/query/items are required' };

    const rawMaxPages = command.max_pages;
    const maxPages =
      rawMaxPages === 'all' || rawMaxPages === 0 || rawMaxPages === '0'
        ? 30
        : Math.max(1, Math.min(30, parseInt(rawMaxPages, 10) || 3));
    const previewPhotoLimit = command.preview_photo_limit == null
      ? 5
      : Math.max(0, Math.min(20, parseInt(command.preview_photo_limit, 10) || 0));
    const photoLimit = command.photo_limit == null
      ? 30
      : Math.max(0, Math.min(80, parseInt(command.photo_limit, 10) || 0));
    const candidateLimit = command.candidate_limit == null
      ? 5
      : Math.max(1, Math.min(30, parseInt(command.candidate_limit, 10) || 5));
    const rawProductLimit = command.limit == null ? 1 : command.limit;
    const productLimit =
      rawProductLimit === 'all' || rawProductLimit === 0 || rawProductLimit === '0'
        ? candidateLimit
        : Math.max(1, Math.min(candidateLimit, parseInt(rawProductLimit, 10) || 1));
    const includeProductPage = command.include_product_page !== false;
    const includeCandidates = command.include_candidates !== false;
    const source = String(command.source || 'purchases').toLowerCase() === 'search' ? 'search' : 'purchases';
    const useTabTransport = command.transport === 'tab' || command.use_tab === true;

    const activeSnapshot = useTabTransport ? await ozonCaptureActiveTab() : null;
    let workTabId = null;
    if (useTabTransport) workTabId = await ozonOpenBackgroundTab(activeSnapshot, 'ozon product images');

    async function readProductImages(product) {
      const pageUrl = product.url || product.product_url || '';
      if (!pageUrl) return { error: 'product url is required for full gallery' };
      if (!useTabTransport) {
        try {
          const d = await extractOzonProductImagesPage({
            urlPath: ozonPathForApi(pageUrl),
            pageUrl,
            origin: 'https://www.ozon.ru',
            direct: true,
            photoLimit,
            debug: command.debug === true,
          });
          if (d.api_error) return { ...d, error: d.api_error };
          return d;
        } catch (e) {
          return { error: 'direct Ozon product image fetch failed: ' + (e?.message || e), url: pageUrl };
        }
      }
      await ozonNavigateTab(workTabId, pageUrl, activeSnapshot);
      let injected;
      try {
        [injected] = await chrome.scripting.executeScript({
          target: { tabId: workTabId },
          world: 'MAIN',
          args: [{
            urlPath: ozonPathForApi(pageUrl),
            pageUrl,
            origin: 'https://www.ozon.ru',
            photoLimit,
            debug: command.debug === true,
          }],
          func: extractOzonProductImagesPage,
        });
      } catch (e) {
        return { error: 'MAIN-world product image inject failed: ' + (e?.message || e), url: pageUrl };
      }
      return injected?.result || { error: 'no result from page (inject returned empty)', url: pageUrl };
    }

    try {
      const results = [];
      for (const spec of specs) {
        let candidates = [];
        if (spec.query || spec.title || spec.sku) {
          candidates = await ozonFindCartCandidates(spec, {
            maxPages,
            photoLimit: previewPhotoLimit,
            source,
          });
        }
        if (spec.url && !candidates.some(c => (c.url || '').split('?')[0] === spec.url.split('?')[0])) {
          candidates.unshift({
            id: spec.sku || (spec.url.match(/-(\d+)\/?(?:\?|$)/) || [])[1] || null,
            sku: spec.sku || (spec.url.match(/-(\d+)\/?(?:\?|$)/) || [])[1] || null,
            title: spec.title || null,
            url: spec.url,
            source_page_url: null,
            images: [],
            available: true,
            label: spec.label,
          });
        }
        if (!spec.url && spec.sku && !candidates.length) {
          const skuUrl = `https://www.ozon.ru/product/${encodeURIComponent(spec.sku)}/`;
          candidates.unshift({
            id: spec.sku,
            sku: spec.sku,
            title: spec.title || null,
            url: skuUrl,
            source_page_url: null,
            images: [],
            available: true,
            label: spec.label,
          });
        }
        const returnedCandidates = candidates.slice(0, candidateLimit).map(ozonCartProductSummary);
        const selected = candidates.slice(0, productLimit);
        const products = [];
        if (includeProductPage) {
          for (const product of selected) {
            const gallery = await readProductImages(product);
            products.push({
              ...ozonCartProductSummary(product),
              visual_hint: spec.visual_hint || null,
              gallery: gallery.error ? null : {
                title: gallery.title || product.title || null,
                product_id: gallery.product_id || product.sku || product.id || null,
                images: gallery.images || [],
                image_count: gallery.image_count ?? (gallery.images || []).length,
                sources: gallery.sources || null,
              },
              error: gallery.error || null,
            });
          }
        }
        results.push({
          request: spec.label,
          query: spec.query || null,
          sku: spec.sku || null,
          url: spec.url || null,
          visual_hint: spec.visual_hint || null,
          found: candidates.length,
          candidates: includeCandidates ? returnedCandidates : undefined,
          products,
        });
      }
      return {
        success: true,
        mode: 'product_images',
        transport: useTabTransport ? 'tab' : 'direct',
        source,
        preview_photo_limit: previewPhotoLimit,
        photo_limit: photoLimit,
        results,
      };
    } finally {
      if (useTabTransport && workTabId) {
        if (command.keep_open === true) {
          await ozonRestoreActiveTab(activeSnapshot, workTabId);
        } else {
          await avitoCloseBackgroundTab(workTabId, activeSnapshot);
        }
      }
    }
  }

  if (action === 'mcp_ozon_cart_prepare') {
    const dryRun = command.dry_run === true;
    if (!dryRun && command.confirm !== true) {
      return {
        success: false,
        error: 'confirm:true is required because ozon_cart_prepare mutates the cart selection and may add products',
      };
    }

    const specs = ozonCartSpecsFromCommand(command);
    if (!specs.length) {
      return { success: false, error: 'queries/query/items are required' };
    }

    const rawMaxPages = command.max_pages;
    const maxPages =
      rawMaxPages === 'all' || rawMaxPages === 0 || rawMaxPages === '0'
        ? 30
        : Math.max(1, Math.min(30, parseInt(rawMaxPages, 10) || 3));
    const photoLimit = command.photo_limit == null
      ? 1
      : Math.max(0, Math.min(5, parseInt(command.photo_limit, 10) || 0));
    const defaultPerSpecLimit = Math.max(1, Math.min(20, parseInt(command.limit_per_query, 10) || 1));
    const hasVisualHints = specs.some(s => s.visual_hint && !s.sku && !s.url);
    const reviewOnly = dryRun || (hasVisualHints && command.visual_confirmed !== true);
    const defaultCandidateLimit = command.candidate_limit == null
      ? (reviewOnly ? 5 : 0)
      : Math.max(0, Math.min(30, parseInt(command.candidate_limit, 10) || 0));

    const picked = [];
    const searches = [];
    for (const spec of specs) {
      const limit = Math.max(1, Math.min(20, parseInt(spec.limit, 10) || defaultPerSpecLimit));
      const candidates = await ozonFindCartCandidates(spec, { maxPages, photoLimit });
      const selected = candidates.slice(0, limit);
      const candidateLimit = spec.candidate_limit == null
        ? defaultCandidateLimit
        : Math.max(0, Math.min(30, parseInt(spec.candidate_limit, 10) || 0));
      searches.push({
        request: spec.label,
        query: spec.query || null,
        sku: spec.sku || null,
        visual_hint: spec.visual_hint || null,
        found: candidates.length,
        candidates: candidateLimit > 0 ? candidates.slice(0, candidateLimit).map(ozonCartProductSummary) : undefined,
        picked: selected.map(ozonCartProductSummary),
      });
      for (const item of selected) picked.push({ ...item, request: spec.label, quantity: spec.quantity || 1 });
    }

    if (reviewOnly) {
      return {
        success: true,
        dry_run: dryRun,
        requires_visual_review: hasVisualHints && command.visual_confirmed !== true,
        note: hasVisualHints && command.visual_confirmed !== true
          ? 'visual_hint was provided without exact sku/url; returning candidates with preview images instead of mutating the cart'
          : null,
        requested: specs.map(s => s.label),
        picked: picked.map(ozonCartProductSummary),
        searches,
      };
    }

    if (!picked.length) {
      return {
        success: false,
        error: 'No matching products found for cart preparation',
        searches,
      };
    }

    const activeSnapshot = await ozonCaptureActiveTab();
    const workTabId = await ozonOpenBackgroundTab(activeSnapshot, 'ozon cart prepare');
    let keepTab = command.keep_open;
    const openCart = command.open_cart !== false;
    if (keepTab == null) keepTab = openCart;
    const focusCart = openCart && command.focus_cart !== false;
    const added = [];
    let cartSelection = null;
    let cartUrl = null;

    try {
      for (const item of picked) {
        const pageUrl = item.source_page_url || item.url;
        if (!pageUrl) {
          added.push({ ...ozonCartProductSummary(item), ok: false, error: 'no source page URL for add-to-cart click' });
          continue;
        }
        await ozonNavigateTab(workTabId, pageUrl, activeSnapshot);
        let injected;
        try {
          [injected] = await chrome.scripting.executeScript({
            target: { tabId: workTabId },
            world: 'MAIN',
            args: [{ sku: item.sku || item.id, title: item.title, url: item.url, quantity: item.quantity || 1 }],
            func: ozonClickAddToCartOnPage,
          });
        } catch (e) {
          added.push({ ...ozonCartProductSummary(item), ok: false, error: 'MAIN-world add click failed: ' + (e?.message || e) });
          continue;
        }
        const result = injected?.result || { ok: false, error: 'empty add click result' };
        added.push({ ...ozonCartProductSummary(item), ...result });
      }

      if (openCart) {
        cartUrl = 'https://www.ozon.ru/cart';
        await ozonNavigateTab(workTabId, cartUrl, activeSnapshot);
        let injected;
        try {
          [injected] = await chrome.scripting.executeScript({
            target: { tabId: workTabId },
            world: 'MAIN',
            args: [
              picked.map(ozonCartProductSummary),
              {
                selectOnlyTargets: command.select_only_targets !== false,
                preserveExistingSelection: command.preserve_existing_selection === true,
              },
            ],
            func: ozonSetCartSelectionOnPage,
          });
        } catch (e) {
          cartSelection = { ok: false, error: 'MAIN-world cart selection failed: ' + (e?.message || e) };
        }
        cartSelection = cartSelection || injected?.result || { ok: false, error: 'empty cart selection result' };
        if (focusCart) {
          try { await chrome.tabs.update(workTabId, { active: true }); } catch {}
        }
      }

      return {
        success: true,
        mode: 'cart_prepare',
        requested: specs.map(s => s.label),
        picked: picked.map(ozonCartProductSummary),
        searches,
        added,
        cart: cartSelection,
        cart_url: cartUrl,
        cart_tab_id: openCart ? workTabId : null,
      };
    } finally {
      if (!keepTab) {
        await avitoCloseBackgroundTab(workTabId, activeSnapshot);
      } else if (!focusCart) {
        await ozonRestoreActiveTab(activeSnapshot, workTabId);
      }
    }
  }

  if (action === 'mcp_ozon_orders') {
    const hasExplicitTab = ozonHasExplicitTab(command);
    let startUrl = command.url || '';
    if (!startUrl && hasExplicitTab) {
      try {
        const t = await chrome.tabs.get(targetTabId);
        startUrl = t?.url || '';
      } catch {}
    }
    if (!startUrl) startUrl = 'https://www.ozon.ru/my/orderlist';
    startUrl = ozonPrepareOrdersUrl(startUrl, command);

    const hasSearchFilters = !!(
      command.query || command.q || command.product || command.product_query ||
      command.search || command.month || command.selected_month ||
      command.date_from || command.date_to
    );
    const MAX_PAGES_HARD = 200;
    let maxPages;
    const mp = command.max_pages;
    if (mp === 'all' || mp === 0 || mp === '0' || (typeof mp === 'number' && mp < 0)) maxPages = MAX_PAGES_HARD;
    else if (mp == null) maxPages = hasSearchFilters ? MAX_PAGES_HARD : 1;
    else maxPages = Math.min(MAX_PAGES_HARD, Math.max(1, parseInt(mp, 10) || 1));

    const photoLimit = command.photo_limit == null
      ? 3
      : Math.max(0, Math.min(20, parseInt(command.photo_limit, 10) || 0));
    const includeDetails = command.include_details === true || command.details === true || hasSearchFilters;
    const rawResultLimit = command.limit == null ? 100 : command.limit;
    const resultLimit =
      rawResultLimit === 'all' || rawResultLimit === 0 || rawResultLimit === '0'
        ? null
        : Math.max(1, Math.min(2000, parseInt(rawResultLimit, 10) || 100));
    const rawDetailLimit = command.detail_limit == null ? (includeDetails ? 1000 : 0) : command.detail_limit;
    const detailLimit =
      rawDetailLimit === 'all' || rawDetailLimit === 0 || rawDetailLimit === '0'
        ? null
        : Math.max(0, Math.min(2000, parseInt(rawDetailLimit, 10) || 0));
    const minResults = Math.max(1, Math.min(2000, parseInt(command.min_results, 10) || 1));
    let stopWhenFound = command.stop_when_found != null
      ? command.stop_when_found !== false
      : !!(command.query || command.q || command.product || command.product_query || command.search);
    const selectedYear = ozonSelectedOrderYear(startUrl, command);

    const useTabTransport = command.transport === 'tab' || command.use_current_tab === true;
    const activeSnapshot = useTabTransport && !hasExplicitTab ? await ozonCaptureActiveTab() : null;
    let workTabId = targetTabId;
    let ownTab = false;
    if (useTabTransport && !hasExplicitTab) {
      workTabId = await ozonOpenBackgroundTab(activeSnapshot, 'ozon orders');
      ownTab = true;
    }

    async function extractOrders(u) {
      if (!useTabTransport) {
        try {
          const d = await extractOzonOrdersPage({
            urlPath: ozonPathForApi(u),
            pageUrl: u,
            origin: 'https://www.ozon.ru',
            direct: true,
            debug: command.debug === true,
            photoLimit,
          });
          d.url = u;
          if (d.api_error) return { error: d.api_error, url: u, api_status: d.api_status, api_url: d.api_url };
          return d;
        } catch (e) {
          return { error: 'direct Ozon fetch failed: ' + (e?.message || e), url: u };
        }
      }
      await ozonNavigateTab(workTabId, u, activeSnapshot);
      let injected;
      try {
        [injected] = await chrome.scripting.executeScript({
          target: { tabId: workTabId },
          world: 'MAIN',
          args: [{
            urlPath: ozonPathForApi(u),
            pageUrl: u,
            origin: 'https://www.ozon.ru',
            debug: command.debug === true,
            photoLimit,
          }],
          func: extractOzonOrdersPage,
        });
      } catch (e) {
        return { error: 'MAIN-world inject failed: ' + (e?.message || e), url: u };
      }
      const d = injected?.result;
      if (!d) return { error: 'no result from page (inject returned empty)', url: u };
      d.url = u;
      return d;
    }

    async function extractOrderDetailFromCurrentOzonPage(detailUrl) {
      if (!useTabTransport) {
        try {
          const detail = await extractOzonOrderDetailPage({
            urlPath: ozonPathForApi(detailUrl),
            pageUrl: detailUrl,
            origin: 'https://www.ozon.ru',
            direct: true,
            photoLimit,
          });
          detail.url = detailUrl;
          return detail;
        } catch (e) {
          return { error: 'direct Ozon fetch failed: ' + (e?.message || e), url: detailUrl };
        }
      }
      let injected;
      try {
        [injected] = await chrome.scripting.executeScript({
          target: { tabId: workTabId },
          world: 'MAIN',
          args: [{
            urlPath: ozonPathForApi(detailUrl),
            pageUrl: detailUrl,
            origin: 'https://www.ozon.ru',
            photoLimit,
          }],
          func: extractOzonOrderDetailPage,
        });
      } catch (e) {
        return { error: 'MAIN-world inject failed: ' + (e?.message || e), url: detailUrl };
      }
      const detail = injected?.result;
      if (!detail) return { error: 'no result from page (inject returned empty)', url: detailUrl };
      detail.url = detailUrl;
      return detail;
    }

    async function enrichOrders(pageOrders, remainingDetailSlots) {
      if (!includeDetails || remainingDetailSlots === 0) return pageOrders;
      const targets = [];
      for (const order of pageOrders) {
        if (!order.detail_url) continue;
        if (remainingDetailSlots != null && targets.length >= remainingDetailSlots) break;
        targets.push(order);
      }
      const out = [...pageOrders];
      const concurrency = Math.max(1, Math.min(6, parseInt(command.detail_concurrency, 10) || 4));
      let cursor = 0;
      async function worker() {
        while (cursor < targets.length) {
          const target = targets[cursor++];
          const idx = out.findIndex(o => o.order_id === target.order_id && o.detail_url === target.detail_url);
          const detail = await extractOrderDetailFromCurrentOzonPage(target.detail_url);
          const merged = {
            ...target,
            detail_error: detail?.error || null,
            detail: detail?.error ? null : detail,
            products: detail?.error ? [] : (detail?.products || []),
          };
          if (idx >= 0) out[idx] = merged;
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
      return out;
    }

    const byId = new Map();
    const returned = [];
    const matched = [];
    const pages = [];
    const seenPageUrls = new Set();
    let detailFetched = 0;
    let scannedOrders = 0;
    let pageUrl = startUrl;
    let stopReason = 'max_pages';
    let fatalError = null;
    let firstPageData = null;

    try {
      for (let page = 1; page <= maxPages; page++) {
        const pageKey = pageUrl.split('#')[0];
        if (seenPageUrls.has(pageKey)) {
          stopReason = 'same_next_url';
          break;
        }
        seenPageUrls.add(pageKey);

        const d = await extractOrders(pageUrl);
        if (d.error) {
          if (page === 1) { fatalError = d; break; }
          stopReason = 'page_error';
          break;
        }
        if (!firstPageData) firstPageData = d;

        const rawOrders = Array.isArray(d.orders) ? d.orders : [];
        const remainingDetailSlots = detailLimit == null ? null : Math.max(0, detailLimit - detailFetched);
        const pageOrders = await enrichOrders(rawOrders, remainingDetailSlots);
        detailFetched += pageOrders.filter(o => o.detail || o.detail_error).length;
        scannedOrders += pageOrders.length;

        pages.push({
          page,
          url: pageUrl,
          api_url: d.api_url,
          count: rawOrders.length,
          next_url: d.pagination?.next_url || null,
          transport: useTabTransport ? 'tab' : 'direct',
          ...(command.debug ? {
            pagination: d.pagination || null,
            debug: d.debug || null,
          } : {}),
        });

        let added = 0;
        for (const order of pageOrders) {
          const key = order.order_id || order.detail_url || `${page}:${order.index}`;
          if (!key || byId.has(key)) continue;
          byId.set(key, order);
          added++;
          const match = ozonOrderMatches(order, command, selectedYear);
          const withMatch = match.filtered ? { ...order, match } : order;
          if (match.matched) {
            if (hasSearchFilters) matched.push(withMatch);
            else returned.push(withMatch);
          }
          if (!hasSearchFilters && resultLimit != null && returned.length >= resultLimit) break;
          if (hasSearchFilters && resultLimit != null && matched.length >= resultLimit) break;
        }

        if (!rawOrders.length) { stopReason = 'empty_page'; break; }
        if (added === 0) { stopReason = 'no_new_results'; break; }
        if (hasSearchFilters && stopWhenFound && matched.length >= minResults) { stopReason = 'found'; break; }
        if (!hasSearchFilters && resultLimit != null && returned.length >= resultLimit) { stopReason = 'limit'; break; }
        if (hasSearchFilters && resultLimit != null && matched.length >= resultLimit) { stopReason = 'limit'; break; }
        if (detailLimit != null && includeDetails && detailFetched >= detailLimit && hasSearchFilters) { stopReason = 'detail_limit'; break; }
        if (page === maxPages) { stopReason = 'max_pages'; break; }
        const nextUrl = d.pagination?.next_url || null;
        if (!nextUrl) { stopReason = 'pagination_end'; break; }
        pageUrl = nextUrl;
      }

      if (fatalError) return { success: false, error: fatalError.error, url: fatalError.url };

      const orders = hasSearchFilters ? matched : returned;
      const complete = ['empty_page', 'no_new_results', 'pagination_end', 'same_next_url'].includes(stopReason);
      return {
        success: true,
        mode: 'orders',
        transport: useTabTransport ? 'tab' : 'direct',
        url: startUrl,
        selected_tab: ozonOrdersTabFromUrl(startUrl),
        selected_year: selectedYear,
        fetched: orders.length,
        scanned_orders: scannedOrders,
        matched: hasSearchFilters ? matched.length : null,
        detail_fetched: detailFetched,
        complete,
        stop_reason: stopReason,
        pages_fetched: pages.length,
        pages,
        filters: firstPageData?.filters || null,
        orders: resultLimit == null ? orders : orders.slice(0, resultLimit),
      };
    } finally {
      if (ownTab && command.keep_open !== true) {
        await avitoCloseBackgroundTab(workTabId, activeSnapshot);
      } else if (activeSnapshot) {
        await ozonRestoreActiveTab(activeSnapshot, workTabId);
      }
    }
  }

  // ── Avito realty search/detail/chat ───────────────────────────────
  //
  // Avito pages are available in the user's real browser profile (cookies,
  // subscriptions, hidden/booked listings). We avoid trying to replay private
  // APIs: search reads schema.org/SSR-rendered DOM, item detail reads the item
  // page DOM, and chat uses stable data-marker attributes.
  if (action === 'mcp_avito_search') {
    const hasExplicitTab = avitoHasExplicitTab(command);
    let startUrl = command.url || command.search_url || '';
    if (!startUrl && hasExplicitTab) {
      try {
        const t = await chrome.tabs.get(targetTabId);
        startUrl = t?.url || '';
      } catch {}
    }
    if (!startUrl) {
      startUrl = avitoBuildSearchUrl(command);
    }
    if (!startUrl) {
      return { success: false, error: 'url/search_url or query/category is required unless an explicit Avito tabId is provided' };
    }
    startUrl = avitoPrepareSearchUrl(startUrl, command);

    const MAX_PAGES_HARD = 20;
    let maxPages;
    const mp = command.max_pages;
    if (mp === 'all' || mp === 0 || mp === '0' || (typeof mp === 'number' && mp < 0)) maxPages = MAX_PAGES_HARD;
    else if (mp == null) maxPages = 1;
    else maxPages = Math.min(MAX_PAGES_HARD, Math.max(1, parseInt(mp, 10) || 1));

    const photoLimit = Math.max(0, Math.min(20, parseInt(command.photo_limit, 10) || 5));
    const detailLimit = Math.max(0, Math.min(15, parseInt(command.detail_limit, 10) || 0));
    const descriptionLimit = Math.max(200, Math.min(8000, parseInt(command.description_limit, 10) || 1800));
    const rawResultLimit = command.limit == null ? 100 : command.limit;
    const resultLimit =
      rawResultLimit === 'all' || rawResultLimit === 0 || rawResultLimit === '0'
        ? null
        : Math.max(1, Math.min(500, parseInt(rawResultLimit, 10) || 100));

    const activeSnapshot = !hasExplicitTab ? await avitoCaptureActiveTab() : null;
    let workTabId = targetTabId;
    let ownTab = false;
    if (!hasExplicitTab) {
      workTabId = await avitoOpenBackgroundTab('avito', activeSnapshot, 'avito search');
      ownTab = true;
    }

    async function navExtractSearch(u) {
      await avitoNavigateTab(workTabId, u, activeSnapshot);
      let injected;
      try {
        [injected] = await chrome.scripting.executeScript({
          target: { tabId: workTabId },
          world: 'MAIN',
          args: [{ photoLimit, descriptionLimit }],
          func: extractAvitoSearchPage,
        });
      } catch (e) {
        return { error: 'MAIN-world inject failed: ' + (e?.message || e), url: u };
      }
      const d = injected?.result;
      if (!d) return { error: 'no result from page (inject returned empty)', url: u };
      d.url = u;
      return d;
    }

    const byId = new Map();
    const pages = [];
    let pageUrl = startUrl;
    let stopReason = 'max_pages';
    let fatalError = null;

    try {
      for (let page = 1; page <= maxPages; page++) {
        const d = await navExtractSearch(pageUrl);
        if (d.error) {
          if (page === 1) { fatalError = d; break; }
          stopReason = 'page_error';
          break;
        }
        pages.push({
          page,
          url: pageUrl,
          count: d.items.length,
          total_count: d.total_count,
          title: d.title,
        });

        let added = 0;
        for (const item of d.items || []) {
          if (resultLimit != null && byId.size >= resultLimit) break;
          const key = item.id || item.url || (item.title + '|' + item.price_text);
          if (!key || byId.has(key)) continue;
          byId.set(key, item);
          added++;
        }
        if (resultLimit != null && byId.size >= resultLimit) { stopReason = 'limit'; break; }
        if (added === 0) { stopReason = 'no_new_results'; break; }
        if (page === maxPages) { stopReason = 'max_pages'; break; }

        const next = d.pagination?.next_url || d.pagination?.pages?.find(p => p.page === page + 1)?.url;
        pageUrl = next || avitoSetPageParam(startUrl, page + 1);
      }

      if (fatalError) return { success: false, error: fatalError.error, url: fatalError.url };

      const items = [...byId.values()].slice(0, resultLimit || undefined);
      if (detailLimit > 0) {
        let detailTabId = workTabId;
        let ownDetailTab = false;
        let detailActiveSnapshot = activeSnapshot;
        if (hasExplicitTab) {
          detailActiveSnapshot = await avitoCaptureActiveTab();
          detailTabId = await avitoOpenBackgroundTab('avito', detailActiveSnapshot, 'avito detail enrichment');
          ownDetailTab = true;
        }
        try {
          for (const item of items.slice(0, detailLimit)) {
            if (!item.url) continue;
            await avitoNavigateTab(detailTabId, item.url, detailActiveSnapshot);
            try {
              const [injected] = await chrome.scripting.executeScript({
                target: { tabId: detailTabId },
                world: 'MAIN',
                args: [{ photoLimit, descriptionLimit }],
                func: extractAvitoItemDetail,
              });
              if (injected?.result && !injected.result.error) item.detail = injected.result;
            } catch (e) {
              item.detail_error = e?.message || String(e);
            }
          }
        } finally {
          if (ownDetailTab) {
            await avitoCloseBackgroundTab(detailTabId, detailActiveSnapshot);
          } else if (detailActiveSnapshot) {
            await avitoRestoreActiveTab(detailActiveSnapshot, detailTabId);
          }
        }
      }

      const firstTotal = pages.find(p => typeof p.total_count === 'number')?.total_count || null;
      const complete = stopReason === 'no_new_results';
      return {
        success: true,
        url: startUrl,
        fetched: items.length,
        total_count: firstTotal,
        remaining: complete || firstTotal == null ? null : Math.max(0, firstTotal - items.length),
        complete,
        pages_fetched: pages.length,
        stop_reason: stopReason,
        pages,
        items,
      };
    } finally {
      if (ownTab) {
        await avitoCloseBackgroundTab(workTabId, activeSnapshot);
      } else if (activeSnapshot) {
        await avitoRestoreActiveTab(activeSnapshot, workTabId);
      }
    }
  }

  if (action === 'mcp_avito_item_detail') {
    const url = command.url || '';
    const photoLimit = Math.max(0, Math.min(50, parseInt(command.photo_limit, 10) || 12));
    const descriptionLimit = Math.max(500, Math.min(20000, parseInt(command.description_limit, 10) || 12000));
    const hasExplicitTab = avitoHasExplicitTab(command);
    if (!url && !hasExplicitTab) {
      return { success: false, error: 'url is required unless an explicit Avito tabId is provided' };
    }
    const activeSnapshot = !hasExplicitTab && url ? await avitoCaptureActiveTab() : null;
    let workTabId = targetTabId;
    let ownTab = false;
    if (!hasExplicitTab && url) {
      workTabId = await avitoOpenBackgroundTab('avito', activeSnapshot, 'avito item detail');
      ownTab = true;
    }
    try {
      if (url) await avitoNavigateTab(workTabId, url, activeSnapshot);
      const [injected] = await chrome.scripting.executeScript({
        target: { tabId: workTabId },
        world: 'MAIN',
        args: [{ photoLimit, descriptionLimit }],
        func: extractAvitoItemDetail,
      });
      const d = injected?.result;
      if (!d) return { success: false, error: 'no result from page' };
      if (d.error) return { success: false, error: d.error, url: d.url };
      return { success: true, detail: d };
    } finally {
      if (ownTab && command.keep_open !== true) {
        await avitoCloseBackgroundTab(workTabId, activeSnapshot);
      } else if (activeSnapshot) {
        await avitoRestoreActiveTab(activeSnapshot, workTabId);
      }
    }
  }

  if (action === 'mcp_avito_messages_list') {
    const hasExplicitTab = avitoHasExplicitTab(command);
    const url = command.url || command.search_url || 'https://www.avito.ru/profile/messenger';
    const activeSnapshot = !hasExplicitTab ? await avitoCaptureActiveTab() : null;
    let workTabId = targetTabId;
    let ownTab = false;
    if (!hasExplicitTab) {
      workTabId = await avitoOpenBackgroundTab('avito', activeSnapshot, 'avito messages list');
      ownTab = true;
    }
    try {
      if (!hasExplicitTab || command.url || command.search_url) {
        await avitoNavigateTab(workTabId, url, activeSnapshot);
      }
      const limit = Math.max(1, Math.min(200, parseInt(command.limit, 10) || 50));
      const maxScrolls = Math.max(0, Math.min(20, parseInt(command.max_scrolls, 10) || 0));
      const [injected] = await chrome.scripting.executeScript({
        target: { tabId: workTabId },
        world: 'MAIN',
        args: [{
          limit,
          maxScrolls,
          query: String(command.query || command.q || command.search || '').trim(),
          unreadOnly: !!command.unread_only,
          useAvitoSearch: command.use_avito_search !== false,
        }],
        func: extractAvitoMessagesList,
      });
      const d = injected?.result;
      if (!d) return { success: false, error: 'no result from page' };
      if (d.error) return { success: false, error: d.error, url: d.url };
      return { success: true, ...d, tabId: workTabId };
    } finally {
      if (ownTab && command.keep_open === true) {
        await avitoRestoreActiveTab(activeSnapshot, workTabId);
      } else if (ownTab) {
        await avitoCloseBackgroundTab(workTabId, activeSnapshot);
      } else if (activeSnapshot) {
        await avitoRestoreActiveTab(activeSnapshot, workTabId);
      }
    }
  }

  if (action === 'mcp_avito_thread_read') {
    const hasExplicitTab = avitoHasExplicitTab(command);
    let url = command.url || command.channel_url || '';
    const channelId = String(command.channel_id || '').trim();
    if (!url && channelId) {
      url = 'https://www.avito.ru/profile/messenger/channel/' + encodeURIComponent(channelId);
    }
    if (!url && !hasExplicitTab) {
      return { success: false, error: 'url/channel_url/channel_id is required unless an explicit Avito messenger tabId is provided' };
    }
    const activeSnapshot = !hasExplicitTab && url ? await avitoCaptureActiveTab() : null;
    let workTabId = targetTabId;
    let ownTab = false;
    if (!hasExplicitTab && url) {
      workTabId = await avitoOpenBackgroundTab('avito', activeSnapshot, 'avito thread read');
      ownTab = true;
    }
    try {
      if (url) await avitoNavigateTab(workTabId, url, activeSnapshot);
      const [injected] = await chrome.scripting.executeScript({
        target: { tabId: workTabId },
        world: 'MAIN',
        args: [{
          limit: Math.max(1, Math.min(300, parseInt(command.limit, 10) || 120)),
        }],
        func: extractAvitoThread,
      });
      const d = injected?.result;
      if (!d) return { success: false, error: 'no result from page' };
      if (d.error) return { success: false, error: d.error, url: d.url };
      return { success: true, ...d, tabId: workTabId };
    } finally {
      if (ownTab && command.keep_open === true) {
        await avitoRestoreActiveTab(activeSnapshot, workTabId);
      } else if (ownTab) {
        await avitoCloseBackgroundTab(workTabId, activeSnapshot);
      } else if (activeSnapshot) {
        await avitoRestoreActiveTab(activeSnapshot, workTabId);
      }
    }
  }

  if (
    action === 'mcp_avito_chat_read' ||
    action === 'mcp_avito_message_draft' ||
    action === 'mcp_avito_message_send'
  ) {
    const url = command.url || '';
    const mode = action === 'mcp_avito_chat_read' ? 'read' : action === 'mcp_avito_message_draft' ? 'draft' : 'send';
    const hasExplicitTab = avitoHasExplicitTab(command);
    if (!url && !hasExplicitTab) {
      return { success: false, error: 'url is required unless an explicit Avito tabId is provided' };
    }
    if (mode === 'send' && !command.confirm) {
      return {
        success: false,
        error: 'confirm:true is required to send Avito messages',
        drafted: false,
      };
    }
    const activeSnapshot = !hasExplicitTab && url ? await avitoCaptureActiveTab() : null;
    let workTabId = targetTabId;
    let ownTab = false;
    if (!hasExplicitTab && url) {
      workTabId = await avitoOpenBackgroundTab('avito', activeSnapshot, 'avito chat');
      ownTab = true;
    }
    try {
      if (url) await avitoNavigateTab(workTabId, url, activeSnapshot);
      const [injected] = await chrome.scripting.executeScript({
        target: { tabId: workTabId },
        world: 'MAIN',
        args: [{
          mode,
          message: String(command.message || ''),
          confirm: !!command.confirm,
          openComposer: command.open_composer !== false,
        }],
        func: avitoChatAction,
      });
      const d = injected?.result;
      if (!d) return { success: false, error: 'no result from page' };
      if (d.error) return { success: false, ...d };
      return { success: true, ...d, tabId: workTabId };
    } finally {
      // For chat actions keep the tab open by default: the user may want to
      // visually inspect the draft/sent thread. Pass keep_open:false to close.
      if (ownTab && command.keep_open === false) {
        await avitoCloseBackgroundTab(workTabId, activeSnapshot);
      } else if (activeSnapshot) {
        await avitoRestoreActiveTab(activeSnapshot, workTabId);
      }
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

function ozonHasExplicitTab(command) {
  return !!command.tabId && (command.__implicitTabId !== true || command.use_current_tab === true);
}

async function ozonCaptureActiveTab() {
  return avitoCaptureActiveTab();
}

async function ozonRestoreActiveTab(snapshot, onlyIfActiveTabId = null) {
  return avitoRestoreActiveTab(snapshot, onlyIfActiveTabId);
}

async function ozonOpenBackgroundTab(activeSnapshot, label) {
  return avitoOpenBackgroundTab('ozon', activeSnapshot, label || 'ozon');
}

async function ozonNavigateTab(tabId, url, activeSnapshot) {
  if (activeSnapshot?.tabId && tabId === activeSnapshot.tabId) {
    throw new Error('refusing to navigate active tab during Ozon background work');
  }
  await avitoRefreshRestoreTarget(activeSnapshot, tabId);
  await chrome.tabs.update(tabId, { url });
  await new Promise(resolve => {
    function l(id, info) {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(l);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(l);
    setTimeout(() => { chrome.tabs.onUpdated.removeListener(l); resolve(); }, 20000);
  });
  await new Promise(r => setTimeout(r, 600));
  await ozonRestoreActiveTab(activeSnapshot, tabId);
}

function ozonSetPageParam(rawUrl, page) {
  const u = new URL(rawUrl, 'https://www.ozon.ru');
  if (page <= 1) u.searchParams.delete('page');
  else u.searchParams.set('page', String(page));
  return u.toString();
}

function ozonBuildCursorPageUrl(rawUrl, items, fallbackPageIndex) {
  const cursorItem = [...(items || [])].reverse().find(item => item?.sku || item?.id);
  const cursor = cursorItem?.sku || cursorItem?.id;
  if (!cursor) return null;
  const u = new URL(rawUrl, 'https://www.ozon.ru');
  const currentIndex = parseInt(u.searchParams.get('layout_page_index') || '', 10);
  const nextIndex = Number.isFinite(currentIndex) && currentIndex > 0
    ? currentIndex + 1
    : Math.max(2, parseInt(fallbackPageIndex, 10) || 2);
  if (!u.searchParams.get('layout_container')) u.searchParams.set('layout_container', 'default');
  u.searchParams.set('layout_page_index', String(nextIndex));
  u.searchParams.set('page', String(cursor));
  return u.toString();
}

function ozonCanSynthesizeCursorPage(rawUrl) {
  try {
    const u = new URL(rawUrl, 'https://www.ozon.ru');
    return /\/my\/favorites\/list\/?$/i.test(u.pathname) && u.searchParams.get('list') === '4294967294';
  } catch {
    return false;
  }
}

function ozonPrepareUrl(rawUrl, command, mode, opts = {}) {
  const u = new URL(rawUrl, 'https://www.ozon.ru');
  if (mode === 'search') {
    const query = command.query || command.q;
    if (query) u.searchParams.set('text', String(query));
    const sortMap = {
      popular: 'score',
      score: 'score',
      relevancy: 'score',
      new: 'new',
      price: 'price',
      cheaper: 'price',
      price_asc: 'price',
      expensive: 'price_desc',
      price_desc: 'price_desc',
      rating: 'rating',
      discount: 'discount',
    };
    if (command.sort || command.sorting) {
      const key = String(command.sort || command.sorting).toLowerCase().trim();
      u.searchParams.set('sorting', sortMap[key] || key);
    }
    const priceMin = command.price_min ?? command.min_price;
    const priceMax = command.price_max ?? command.max_price;
    if (priceMin != null || priceMax != null) {
      const min = priceMin != null ? Number(priceMin) : 0;
      const max = priceMax != null ? Number(priceMax) : 999999999;
      if (Number.isFinite(min) && Number.isFinite(max)) {
        u.searchParams.set('currency_price', `${min.toFixed(3)};${max.toFixed(3)}`);
      }
    }
    if (command.currency_price) u.searchParams.set('currency_price', String(command.currency_price));
    if (command.delivery != null) u.searchParams.set('delivery', String(command.delivery));
  }
  if (mode === 'favorites' && command.category != null) u.searchParams.set('category', String(command.category));
  if (command.in_stock_only === true || command.available_only === true) u.searchParams.set('inStock', 'true');
  if (command.page != null && command.page !== '') {
    if (Number(command.page) <= 1) u.searchParams.delete('page');
    else u.searchParams.set('page', String(command.page));
  } else {
    if (!opts.preservePagination) u.searchParams.delete('page');
  }
  return u.toString();
}

function ozonNormalizeOrdersTab(raw) {
  const s = String(raw || '').toLowerCase().trim();
  if (!s) return null;
  if (['archive', 'completed', 'complete', 'done', 'history', 'finished', 'past', 'завершенные', 'завершённые'].includes(s)) return 'archive';
  if (['active', 'current', 'actual', 'open', 'processing', 'актуальные', 'текущие'].includes(s)) return 'active';
  if (['cancelled', 'canceled', 'cancel', 'отмененные', 'отменённые'].includes(s)) return 'cancelled';
  return s;
}

function ozonPrepareOrdersUrl(rawUrl, command) {
  const u = new URL(rawUrl, 'https://www.ozon.ru');
  if (!/\/my\/orderlist/i.test(u.pathname)) {
    u.pathname = '/my/orderlist';
    u.search = '';
  }
  const selectedTab = ozonNormalizeOrdersTab(command.selected_tab || command.order_tab || command.status || command.state) || ozonOrdersTabFromUrl(u.toString()) || 'archive';
  if (selectedTab) u.searchParams.set('selectedTab', selectedTab);
  const selectedYear = command.selected_year ?? command.year ?? command.y;
  if (selectedYear != null && String(selectedYear).trim()) u.searchParams.set('selectedYear', String(selectedYear).trim());
  if (command.preserve_pagination !== true) {
    [
      'archiveOrdersStart', 'layout_container', 'layout_page_index',
      'load_type', 'offset', 'posting_cursor', 'start_page_id',
    ].forEach(p => u.searchParams.delete(p));
  }
  return u.toString();
}

function ozonPrepareOrderDetailUrl(rawUrl, command) {
  const u = new URL(rawUrl, 'https://www.ozon.ru');
  const orderId = command.order_id || command.order || command.order_number || command.orderNumber || u.searchParams.get('order');
  if (!/\/my\/orderdetails/i.test(u.pathname)) {
    u.pathname = '/my/orderdetails/';
    u.search = '';
  }
  if (orderId) u.searchParams.set('order', String(orderId));
  const selectedTab = ozonNormalizeOrdersTab(command.selected_tab || command.order_tab || command.status || command.state);
  if (selectedTab) u.searchParams.set('selectedTab', selectedTab);
  return u.toString();
}

function ozonOrdersTabFromUrl(rawUrl) {
  try {
    return new URL(rawUrl, 'https://www.ozon.ru').searchParams.get('selectedTab') || null;
  } catch {
    return null;
  }
}

function ozonSelectedOrderYear(rawUrl, command) {
  const y = command.selected_year ?? command.year ?? command.y;
  if (y != null && /^\d{4}$/.test(String(y))) return Number(y);
  try {
    const v = new URL(rawUrl, 'https://www.ozon.ru').searchParams.get('selectedYear');
    if (v && /^\d{4}$/.test(v)) return Number(v);
  } catch {}
  return new Date().getFullYear();
}

function ozonOrderMatches(order, command, fallbackYear) {
  function clean(s) {
    return String(s || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\u2009/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .trim();
  }
  function norm(s) {
    return clean(s).toLowerCase().replace(/ё/g, 'е');
  }
  function uniq(arr) {
    return [...new Set((arr || []).filter(Boolean))];
  }
  const queries = uniq([
    command.query,
    command.q,
    command.product,
    command.product_query,
    command.search,
  ].map(x => clean(x)).filter(Boolean));
  const products = [
    ...(order.products || []),
    ...(order.detail?.products || []),
  ];
  const texts = [
    order.order_id,
    order.status,
    order.subtitle,
    order.order_date_text,
    order.detail?.order_title,
    order.detail?.status,
    order.detail?.address?.title,
    order.detail?.address?.subtitle,
    ...(order.raw_texts || []),
    ...(order.detail?.raw_texts || []),
    ...products.flatMap(p => [
      p.title,
      p.seller,
      p.sku,
      p.id,
      p.url,
      p.price_text,
      ...(p.attributes || []),
      ...(p.raw_texts || []),
    ]),
  ];
  const haystack = norm(texts.join('\n'));
  let queryMatched = true;
  const queryHits = [];
  for (const q of queries) {
    const nq = norm(q);
    const tokens = nq.split(/\s+/).filter(t => t.length > 1);
    const hit = !!nq && (haystack.includes(nq) || (tokens.length > 1 && tokens.every(t => haystack.includes(t))));
    queryMatched = queryMatched && hit;
    queryHits.push({ query: q, matched: hit });
  }

  const dateText = clean([
    order.detail?.order_title,
    order.order_date_text,
    order.status,
    ...(order.raw_texts || []),
  ].join(' '));
  const parsedDate = ozonParseRuOrderDate(dateText, fallbackYear);
  const monthFilter = ozonMonthNumber(command.month ?? command.selected_month);
  const monthMatched = monthFilter ? parsedDate?.month === monthFilter || haystack.includes(ozonMonthName(monthFilter)) : true;
  const from = command.date_from ? String(command.date_from) : null;
  const to = command.date_to ? String(command.date_to) : null;
  const key = parsedDate?.date || null;
  const dateMatched = (!from || (key && key >= from)) && (!to || (key && key <= to));
  const filtered = !!queries.length || !!monthFilter || !!from || !!to;
  return {
    filtered,
    matched: queryMatched && monthMatched && dateMatched,
    queries: queryHits,
    order_date: key,
    month: parsedDate?.month || null,
    month_filter: monthFilter || null,
    date_matched: dateMatched,
  };
}

function ozonMonthNumber(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.max(1, Math.min(12, Math.trunc(raw)));
  const s = String(raw).toLowerCase().replace(/ё/g, 'е').trim();
  if (/^\d+$/.test(s)) return Math.max(1, Math.min(12, Number(s)));
  const months = {
    январь: 1, января: 1,
    февраль: 2, февраля: 2,
    март: 3, марта: 3,
    апрель: 4, апреля: 4,
    май: 5, мая: 5,
    июнь: 6, июня: 6,
    июль: 7, июля: 7,
    август: 8, августа: 8,
    сентябрь: 9, сентября: 9,
    октябрь: 10, октября: 10,
    ноябрь: 11, ноября: 11,
    декабрь: 12, декабря: 12,
  };
  return months[s] || null;
}

function ozonMonthName(month) {
  return [
    '', 'январ', 'феврал', 'март', 'апрел', 'ма', 'июн',
    'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр',
  ][month] || '';
}

function ozonParseRuOrderDate(text, fallbackYear) {
  const clean = String(text || '').replace(/\u00a0/g, ' ').replace(/\u2009/g, ' ').replace(/ё/g, 'е').toLowerCase();
  const months = {
    января: 1, феврал: 2, февраля: 2, марта: 3, апреля: 4, мая: 5, июня: 6,
    июля: 7, августа: 8, сентября: 9, октября: 10, ноября: 11, декабря: 12,
  };
  const m = clean.match(/(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?:\s+(\d{4}))?/i);
  if (!m) return null;
  const day = Number(m[1]);
  const month = months[m[2]];
  const year = m[3] ? Number(m[3]) : (fallbackYear || new Date().getFullYear());
  if (!day || !month || !year) return null;
  return {
    day,
    month,
    year,
    date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}

function ozonCartSpecsFromCommand(command) {
  const specs = [];
  function asArray(v) {
    if (Array.isArray(v)) return v;
    if (v == null) return [];
    return [v];
  }
  function normalizeSpec(raw, fallbackIndex) {
    const obj = typeof raw === 'string' ? { query: raw } : (raw && typeof raw === 'object' ? raw : {});
    const query = String(obj.query || obj.q || obj.product || obj.product_query || obj.search || obj.title || '').trim();
    const sku = String(obj.sku || obj.id || obj.product_id || obj.productId || '').trim();
    const url = String(obj.url || obj.product_url || obj.productUrl || '').trim();
    const label = query || sku || url || `item-${fallbackIndex + 1}`;
    const visualHint = String(obj.visual_hint || obj.visualHint || obj.image_hint || obj.imageHint || obj.looks_like || '').trim();
    const requiredTerms = asArray(obj.required_terms || obj.requiredTerms || obj.must_include)
      .flatMap(v => String(v || '').split(/[,\n]/))
      .map(s => s.trim())
      .filter(Boolean);
    const excludeTerms = asArray(obj.exclude_terms || obj.excludeTerms || obj.forbidden_terms || obj.forbiddenTerms)
      .flatMap(v => String(v || '').split(/[,\n]/))
      .map(s => s.trim())
      .filter(Boolean);
    return {
      query,
      sku,
      url,
      title: String(obj.title || '').trim(),
      label,
      visual_hint: visualHint,
      required_terms: requiredTerms,
      exclude_terms: excludeTerms,
      quantity: Math.max(1, Math.min(20, parseInt(obj.quantity, 10) || 1)),
      limit: obj.limit,
      candidate_limit: obj.candidate_limit || obj.candidateLimit,
    };
  }

  for (const raw of asArray(command.items)) {
    const spec = normalizeSpec(raw, specs.length);
    if (spec.query || spec.sku || spec.url || spec.title) specs.push(spec);
  }
  const directSpec = normalizeSpec({
    url: command.url || command.product_url || command.productUrl,
    sku: command.sku || command.id || command.product_id || command.productId,
    title: command.title,
    visual_hint: command.visual_hint || command.visualHint || command.image_hint || command.imageHint,
  }, specs.length);
  if (!specs.length && (directSpec.url || directSpec.sku || directSpec.title)) specs.push(directSpec);
  for (const q of asArray(command.queries)) {
    const spec = normalizeSpec(q, specs.length);
    if (spec.query) specs.push(spec);
  }
  const single = command.query || command.q || command.product || command.product_query || command.search;
  if (single && !specs.length) {
    const spec = normalizeSpec(String(single), 0);
    const commandVisualHint = String(command.visual_hint || command.visualHint || command.image_hint || command.imageHint || '').trim();
    if (commandVisualHint) spec.visual_hint = commandVisualHint;
    specs.push(spec);
  }
  return specs;
}

function ozonCartProductSummary(item) {
  return {
    request: item.request || item.label || null,
    id: item.id || null,
    sku: item.sku || item.id || null,
    title: item.title || null,
    url: item.url || null,
    source_page_url: item.source_page_url || null,
    price_text: item.price_text || null,
    price_rub: item.price_rub ?? null,
    delivery: item.delivery || null,
    available: item.available !== false,
    images: item.images || [],
  };
}

function ozonCartNormalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\u00a0/g, ' ')
    .replace(/\u2009/g, ' ')
    .replace(/[^a-zа-я0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function ozonCartTextMatches(haystackRaw, needleRaw) {
  const haystack = ozonCartNormalizeText(haystackRaw);
  const needle = ozonCartNormalizeText(needleRaw);
  if (!needle) return true;
  if (haystack.includes(needle)) return true;
  const tokens = needle.split(' ').filter(t => t.length >= 3);
  if (!tokens.length) return false;
  return tokens.every(token => haystack.includes(token) || (token.length >= 6 && haystack.includes(token.slice(0, 6))));
}

function ozonCartCandidateMatches(item, spec) {
  const id = String(item.id || item.sku || '');
  const sku = String(item.sku || item.id || '');
  const url = String(item.url || '');
  if (spec.sku && spec.sku !== id && spec.sku !== sku && !url.includes(spec.sku)) return false;

  const haystack = [
    item.title,
    item.sku,
    item.id,
    item.url,
    ...(item.labels || []),
    ...(item.raw_texts || []),
  ].join('\n');

  const required = [
    ...(spec.required_terms || []),
    ...(!spec.sku && spec.query ? [spec.query] : []),
    ...(!spec.sku && !spec.query && spec.title ? [spec.title] : []),
  ].filter(Boolean);
  if (required.length && !required.every(term => ozonCartTextMatches(haystack, term))) return false;
  if ((spec.exclude_terms || []).some(term => ozonCartTextMatches(haystack, term))) return false;
  return true;
}

async function ozonFindCartCandidates(spec, opts) {
  const maxPages = opts?.maxPages || 3;
  const photoLimit = opts?.photoLimit ?? 1;
  const source = String(opts?.source || opts?.mode || 'purchases').toLowerCase() === 'search' ? 'search' : 'purchases';
  let startUrl = spec.url;
  if (!startUrl) {
    const query = spec.query || spec.title || spec.sku;
    startUrl = source === 'search'
      ? 'https://www.ozon.ru/search/?text=' + encodeURIComponent(query)
      : 'https://www.ozon.ru/my/purchases/search?text=' + encodeURIComponent(query);
  }
  startUrl = ozonPrepareUrl(startUrl, { page: null }, source, { preservePagination: false });
  const seenPageUrls = new Set();
  const seenProducts = new Set();
  const candidates = [];
  let pageUrl = startUrl;
  for (let page = 1; page <= maxPages; page++) {
    const pageKey = pageUrl.split('#')[0];
    if (seenPageUrls.has(pageKey)) break;
    seenPageUrls.add(pageKey);
    let d;
    try {
      d = await extractOzonCatalogPage({
        mode: source,
        urlPath: ozonPathForApi(pageUrl),
        pageUrl,
        origin: 'https://www.ozon.ru',
        direct: true,
        photoLimit,
      });
    } catch {
      break;
    }
    const items = Array.isArray(d?.items) ? d.items : [];
    for (const item of items) {
      const key = item.sku || item.id || item.url || item.title;
      if (!key || seenProducts.has(key)) continue;
      seenProducts.add(key);
      if (!ozonCartCandidateMatches(item, spec)) continue;
      candidates.push({ ...item, source_page_url: pageUrl, label: spec.label });
    }
    const nextUrl = d?.pagination?.next_url || null;
    if (!nextUrl) break;
    pageUrl = nextUrl;
  }
  candidates.sort((a, b) => {
    if ((a.available !== false) !== (b.available !== false)) return a.available === false ? 1 : -1;
    if ((a.price_rub != null) !== (b.price_rub != null)) return a.price_rub == null ? 1 : -1;
    return (a.index ?? 9999) - (b.index ?? 9999);
  });
  return candidates;
}

async function ozonClickAddToCartOnPage(target) {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const clean = s => String(s || '').replace(/\u00a0/g, ' ').replace(/\u2009/g, ' ').replace(/\s+/g, ' ').trim();
  const norm = s => clean(s).toLowerCase().replace(/ё/g, 'е');
  const visible = el => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden' && !el.disabled;
  };
  const cartCount = () => {
    const text = Array.from(document.querySelectorAll('a[href*="/cart"]'))
      .map(a => clean(a.innerText || a.textContent || ''))
      .join('\n');
    const m = text.match(/Корзина\s*(\d+)/i);
    return m ? Number(m[1]) : null;
  };
  const sku = String(target?.sku || target?.id || '').trim();
  const title = clean(target?.title || '');
  const titleNeedle = norm(title).slice(0, 80);
  const beforeCount = cartCount();

  function candidateContainers() {
    const containers = [];
    const anchors = sku
      ? Array.from(document.querySelectorAll(`a[href*="${CSS.escape(sku)}"]`))
      : [];
    if (titleNeedle) {
      for (const a of Array.from(document.querySelectorAll('a'))) {
        if (norm(a.innerText || a.textContent || '').includes(titleNeedle)) anchors.push(a);
      }
    }
    for (const anchor of anchors) {
      let el = anchor;
      for (let depth = 0; el && depth < 9; depth++, el = el.parentElement) {
        const text = norm(el.innerText || '');
        const hasTitle = !titleNeedle || text.includes(titleNeedle) || (sku && text.includes(sku));
        if (hasTitle && el.querySelectorAll?.('button').length) containers.push(el);
      }
    }
    return [...new Set(containers)].sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
  }

  const containers = candidateContainers().slice(0, 1);
  const addTextRe = /в корзин|добав|сегодня|завтра|послезавтра|\d{1,2}\s+(январ|феврал|март|апрел|мая|июн|июл|август|сентябр|октябр|ноябр|декабр)/i;
  const skipTextRe = /каталог|поиск|для бизнеса|пункт ozon|поделиться|избран|отзыв|слабовид|оформлен/i;
  let clickedButton = null;
  for (const container of containers) {
    const buttons = Array.from(container.querySelectorAll('button')).filter(visible);
    clickedButton = buttons.find(btn => {
      const text = clean(btn.innerText || btn.textContent || btn.getAttribute('aria-label') || '');
      if (!text || skipTextRe.test(text)) return false;
      return addTextRe.test(text);
    });
    if (clickedButton) break;
  }

  if (!clickedButton) {
    return {
      ok: true,
      clicked: false,
      status: 'already_in_cart_or_no_add_button',
      before_cart_count: beforeCount,
      after_cart_count: cartCount(),
    };
  }

  const buttonText = clean(clickedButton.innerText || clickedButton.textContent || clickedButton.getAttribute('aria-label') || '');
  clickedButton.click();
  await sleep(3200);
  return {
    ok: true,
    clicked: true,
    status: 'clicked_add_to_cart',
    button_text: buttonText,
    before_cart_count: beforeCount,
    after_cart_count: cartCount(),
  };
}

async function ozonSetCartSelectionOnPage(targets, opts = {}) {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const clean = s => String(s || '').replace(/\u00a0/g, ' ').replace(/\u2009/g, ' ').replace(/\s+/g, ' ').trim();
  const norm = s => clean(s).toLowerCase().replace(/ё/g, 'е');
  const tokenMatch = (haystackRaw, needleRaw) => {
    const haystack = norm(haystackRaw);
    const needle = norm(needleRaw);
    if (!needle) return false;
    if (haystack.includes(needle)) return true;
    const tokens = needle.split(/[^a-zа-я0-9]+/i).filter(t => t.length >= 4);
    if (!tokens.length) return false;
    return tokens.every(t => haystack.includes(t) || (t.length >= 7 && haystack.includes(t.slice(0, 7))));
  };
  const selectOnlyTargets = opts?.selectOnlyTargets !== false;
  const preserveExistingSelection = opts?.preserveExistingSelection === true;
  const normalizedTargets = (targets || []).map(t => ({
    ...t,
    matchTexts: [t.title, t.request, t.sku, t.id].map(clean).filter(Boolean),
  }));

  function rowForInput(input) {
    let best = null;
    for (let el = input.parentElement, depth = 0; el && depth < 10; depth++, el = el.parentElement) {
      const text = clean(el.innerText || '');
      if (!text || /Выбрать все/i.test(text)) continue;
      if (text.length > 20 && /(₽|Постоплата|Купить|Количество|Последний товар)/i.test(text)) {
        best = el;
        break;
      }
    }
    return best;
  }
  function titleFromRowText(text) {
    const lines = clean(text).split(/\n| {2,}/).map(clean).filter(Boolean);
    return lines.find(line =>
      line.length > 15 &&
      !/^(Постоплата|Купить|Количество|Последний товар|0%|Скидка|Итого)/i.test(line) &&
      !/^\d/.test(line) &&
      !/₽/.test(line)
    ) || lines[0] || '';
  }
  function matchingTarget(rowText) {
    return normalizedTargets.find(t => t.matchTexts.some(mt => mt.length >= 3 && tokenMatch(rowText, mt))) || null;
  }

  await sleep(800);
  const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
  const rows = [];
  const changed = [];
  for (const input of checkboxes) {
    const row = rowForInput(input);
    if (!row) continue;
    const rowText = clean(row.innerText || '');
    const target = matchingTarget(rowText);
    const desired = target
      ? true
      : (preserveExistingSelection ? input.checked : (selectOnlyTargets ? false : input.checked));
    rows.push({
      title: titleFromRowText(rowText),
      checked_before: !!input.checked,
      target: target ? (target.title || target.request || target.sku || target.id) : null,
      desired,
    });
    if (input.checked !== desired) {
      const label = input.closest('label') || input;
      label.click();
      changed.push({ title: rows[rows.length - 1].title, to: desired });
      await sleep(250);
    }
  }
  await sleep(900);
  const after = [];
  for (const input of Array.from(document.querySelectorAll('input[type="checkbox"]'))) {
    const row = rowForInput(input);
    if (!row) continue;
    const rowText = clean(row.innerText || '');
    after.push({
      title: titleFromRowText(rowText),
      checked: !!input.checked,
      target: !!matchingTarget(rowText),
    });
  }
  const selectedTargets = after.filter(r => r.checked && r.target).length;
  return {
    ok: true,
    rows_seen: rows.length,
    target_count: normalizedTargets.length,
    selected_targets: selectedTargets,
    changed,
    rows_after: after,
    summary_text: clean(document.body.innerText || '').slice(0, 1200),
  };
}

function ozonPathForApi(rawUrl) {
  const u = new URL(rawUrl, 'https://www.ozon.ru');
  return u.pathname + u.search;
}

async function extractOzonCatalogPage(opts) {
  const mode = opts?.mode || 'catalog';
  const urlPath = opts?.urlPath || (location.pathname + location.search) || '/';
  const origin = opts?.origin || 'https://www.ozon.ru';
  const pageUrl = opts?.pageUrl || new URL(urlPath, origin).toString();
  const photoLimit = opts?.photoLimit ?? 5;
  const hasDocument = typeof document !== 'undefined';

  function cleanText(s) {
    return String(s || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\u2009/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .trim();
  }
  function intFrom(s) {
    const m = String(s || '').match(/[\d\s]+/);
    return m ? Number(m[0].replace(/\s+/g, '')) : null;
  }
  function numFrom(s) {
    const m = String(s || '').replace(',', '.').match(/\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : null;
  }
  function absUrl(href) {
    try { return new URL(href, origin).toString(); } catch { return href || null; }
  }
  function uniq(arr) {
    return [...new Set((arr || []).filter(Boolean))];
  }
  function safeJsonParse(v, fallback = null) {
    if (v == null) return fallback;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return fallback; }
  }
  function collectTexts(root, out = []) {
    if (!root || typeof root !== 'object') return out;
    if (typeof root.text === 'string') out.push(cleanText(root.text));
    if (Array.isArray(root)) {
      for (const x of root) collectTexts(x, out);
    } else {
      for (const x of Object.values(root)) collectTexts(x, out);
    }
    return out.filter(Boolean);
  }
  function firstTextDS(item, id) {
    for (const st of item.mainState || []) {
      if (st.type === 'textDS' && (!id || st.id === id) && st.textDS?.text) {
        return cleanText(st.textDS.text);
      }
    }
    return null;
  }
  function priceFromItem(item) {
    const state = (item.mainState || []).find(x => x.type === 'priceV2' && x.priceV2);
    const pv = state?.priceV2;
    const parts = pv?.price || [];
    const current = parts.find(p => p.textStyle === 'PRICE') || parts[0] || null;
    const original = parts.find(p => /ORIGINAL/i.test(p.textStyle || '')) || parts[1] || null;
    return {
      price_text: cleanText(current?.text || ''),
      price_rub: intFrom(current?.text),
      original_price_text: cleanText(original?.text || ''),
      original_price_rub: intFrom(original?.text),
      discount: cleanText(pv?.discount || ''),
    };
  }
  function ratingFromItem(item) {
    for (const st of item.mainState || []) {
      const autoId = st.labelListV2?.testInfo?.automatizationId || '';
      if (st.type !== 'labelListV2' || !/rating/i.test(autoId)) continue;
      const texts = collectTexts(st.labelListV2);
      const rating = texts.find(t => /^\d+(?:[,.]\d+)?$/.test(t));
      const reviews = texts.find(t => /отзыв|^\d[\d\s]*$/i.test(t) && t !== rating);
      return {
        rating: rating ? numFrom(rating) : null,
        reviews_text: reviews || null,
        reviews_count: intFrom(reviews),
      };
    }
    return { rating: null, reviews_text: null, reviews_count: null };
  }
  function labelsFromItem(item) {
    const labels = [];
    for (const st of item.mainState || []) {
      if (st.type !== 'labelListV2') continue;
      const autoId = st.labelListV2?.testInfo?.automatizationId || '';
      if (/rating/i.test(autoId)) continue;
      labels.push(...collectTexts(st.labelListV2));
    }
    for (const st of item.mainState || []) {
      if (st.type === 'textDS' && st.id !== 'name') {
        const t = cleanText(st.textDS?.text || '');
        if (t) labels.push(t);
      }
    }
    const badge = item.tileImage?.leftBottomBadgeV2?.text;
    if (badge) labels.push(cleanText(badge));
    return uniq(labels).filter(x => !/^\d+(?:[,.]\d+)?$/.test(x) && !/отзыв/i.test(x));
  }
  function imagesFromItem(item) {
    const out = [];
    for (const part of item.tileImage?.items || []) {
      const link = part?.image?.link || part?.image?.url;
      if (link) out.push(link);
    }
    return uniq(out).slice(0, photoLimit).map(src => ({ src }));
  }
  function normalizeItem(item, index) {
    const title = firstTextDS(item, 'name') || collectTexts(item).find(t => t.length > 20 && !/[₽%]|отзыв/i.test(t)) || null;
    const rawUrl = item.action?.link || item.action?.url || '';
    const url = rawUrl ? absUrl(rawUrl) : null;
    const price = priceFromItem(item);
    const rating = ratingFromItem(item);
    const labels = labelsFromItem(item);
    const delivery = cleanText(
      item.multiButton?.ozonButton?.addToCart?.actionButton?.title ||
      labels.find(x => /сегодня|завтра|послезавтра|\d+\s+июл|достав/i.test(x)) ||
      ''
    ) || null;
    const unavailable = labels.some(x => /нет в наличии|похожие/i.test(x)) || !price.price_rub;
    return {
      id: item.id ? String(item.id) : (item.sku ? String(item.sku) : null),
      sku: item.sku ? String(item.sku) : (item.id ? String(item.id) : null),
      index,
      title,
      url,
      ...price,
      ...rating,
      delivery,
      available: !unavailable,
      labels,
      images: imagesFromItem(item),
      raw_texts: uniq(collectTexts(item)).slice(0, 60),
    };
  }
  function extractSort(widgetStates) {
    const key = Object.keys(widgetStates || {}).find(k => /searchResultsSort/i.test(k));
    const state = safeJsonParse(widgetStates?.[key]);
    const options = state?.sortButton?.options || [];
    return {
      selected: options.find(o => o.isSelected)?.name || null,
      options: options.map(o => ({
        name: o.name,
        selected: !!o.isSelected,
        url: o.action?.link ? absUrl(o.action.link) : null,
      })),
    };
  }
  function extractFilters(widgetStates) {
    const key = Object.keys(widgetStates || {}).find(k => /filtersDesktop/i.test(k));
    const state = safeJsonParse(widgetStates?.[key]);
    const filters = [];
    function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (node.type && node.key) {
        const f = { type: node.type, key: node.key };
        if (node.boolFilter?.title) f.title = node.boolFilter.title;
        if (node.checkboxesFilter?.title) {
          f.title = node.checkboxesFilter.title;
          f.options = (node.checkboxesFilter.sections || [])
            .flatMap(s => s.items || [])
            .map(it => ({ key: it.key, title: cleanText(it.title?.text || ''), selected: !!it.isSelected }))
            .filter(x => x.key || x.title);
        }
        if (node.multipleRangesFilter?.rangeFilter) {
          f.title = node.multipleRangesFilter.rangeFilter.title || 'Цена';
          f.min = node.multipleRangesFilter.rangeFilter.minValue ?? null;
          f.max = node.multipleRangesFilter.rangeFilter.maxValue ?? null;
          f.options = (node.multipleRangesFilter.checkboxesFilter?.sections || [])
            .flatMap(s => s.items || [])
            .map(it => ({ key: it.key, title: cleanText(it.title?.text || ''), selected: !!it.isSelected }))
            .filter(x => x.key || x.title);
        }
        if (node.categoryFilter?.title) {
          f.title = node.categoryFilter.title;
          f.categories = (node.categoryFilter.categories || []).map(c => ({
            title: c.title,
            active: !!c.isActive,
            url: c.urlValue ? absUrl(c.urlValue) : null,
          }));
        }
        filters.push(f);
      }
      if (Array.isArray(node)) {
        for (const x of node) walk(x);
      } else {
        for (const x of Object.values(node)) walk(x);
      }
    }
    walk(state);
    return filters;
  }
  function extractCounters(widgetStates, bodyText) {
    const out = {};
    const favoriteKey = Object.keys(widgetStates || {}).find(k => /favoriteCounter/i.test(k));
    const favoriteState = safeJsonParse(widgetStates?.[favoriteKey]);
    const favText = cleanText(JSON.stringify(favoriteState || {})) || cleanText(bodyText);
    const body = cleanText(bodyText);
    const fav = body.match(/Избранное\s+(\d+)/i) || favText.match(/Избранное[^0-9]{0,40}(\d+)/i);
    if (fav) out.favorites = Number(fav[1]);
    const cart = body.match(/Корзина\s+(\d+)/i);
    if (cart) out.cart = Number(cart[1]);
    const orders = body.match(/Заказы\s+(\d+)/i);
    if (orders) out.orders = Number(orders[1]);
    return out;
  }
  function extractPagination(widgetStates) {
    const paginators = [];
    for (const key of Object.keys(widgetStates || {})) {
      if (!/paginator/i.test(key)) continue;
      const state = safeJsonParse(widgetStates[key]);
      if (!state || typeof state !== 'object') continue;
      const nextPath =
        state.nextPage ||
        state.nextUrl ||
        state.nextURL ||
        state.next?.link ||
        state.action?.link ||
        null;
      paginators.push({
        state_id: key,
        layout_container: state.layoutContainer || state.layout_container || null,
        fetch_type: state.fetchType || state.fetch_type || null,
        size: state.size ?? null,
        next_path: nextPath,
        next_url: nextPath ? absUrl(nextPath) : null,
      });
    }
    const preferred =
      paginators.find(p => p.next_url && p.layout_container === 'default') ||
      paginators.find(p => p.next_url && !/recom/i.test(`${p.layout_container || ''} ${p.state_id || ''}`)) ||
      paginators.find(p => p.next_url) ||
      null;
    return {
      next_url: preferred?.next_url || null,
      paginators,
    };
  }
  function domFallbackItems() {
    if (!hasDocument) return [];
    const byUrl = new Map();
    for (const a of Array.from(document.querySelectorAll('a[href*="/product/"]'))) {
      const url = absUrl(a.getAttribute('href') || a.href || '');
      if (!/\/product\/[^/?#]+-\d+\/?/i.test(url || '')) continue;
      if (!url || byUrl.has(url.split('?')[0])) continue;
      const card = a.closest('[data-widget="tileGridDesktop"] [class*="tile-root"], [data-widget="tileGridDesktop"] div') || a.parentElement;
      const text = cleanText(card?.innerText || a.innerText || '');
      const lines = text.split('\n').map(cleanText).filter(Boolean);
      const title = lines.find(x => x.length > 15 && !/[₽%]|отзыв|сегодня|завтра|послезавтра/i.test(x)) || cleanText(a.innerText || '');
      const priceText = lines.find(x => /₽/.test(x)) || null;
      const images = Array.from(card?.querySelectorAll?.('img') || [])
        .map(img => img.currentSrc || img.src)
        .filter(Boolean)
        .slice(0, photoLimit)
        .map(src => ({ src }));
      byUrl.set(url.split('?')[0], {
        id: (url.match(/-(\d+)\/?(\?|$)/) || [])[1] || null,
        sku: (url.match(/-(\d+)\/?(\?|$)/) || [])[1] || null,
        index: byUrl.size,
        title,
        url,
        price_text: priceText,
        price_rub: intFrom(priceText),
        original_price_text: null,
        original_price_rub: null,
        discount: null,
        rating: null,
        reviews_text: null,
        reviews_count: null,
        delivery: lines.find(x => /сегодня|завтра|послезавтра|\d+\s+июл/i.test(x)) || null,
        available: !/нет в наличии/i.test(text),
        labels: lines.filter(x => x && x !== title && x !== priceText).slice(0, 12),
        images,
        raw_texts: lines.slice(0, 60),
      });
    }
    return [...byUrl.values()];
  }

  const apiPath = '/api/composer-api.bx/page/json/v2?url=' + encodeURIComponent(urlPath);
  const apiUrl = opts?.direct ? new URL(apiPath, origin).toString() : apiPath;
  let data = null;
  let apiStatus = null;
  let apiError = null;
  try {
    const response = await fetch(apiUrl, {
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
    apiStatus = response.status;
    const text = await response.text();
    if (!response.ok) throw new Error(`Ozon page/json returned ${response.status}: ${text.slice(0, 200)}`);
    data = JSON.parse(text);
  } catch (e) {
    apiError = e?.message || String(e);
  }

  const widgetStates = data?.widgetStates || {};
  const gridKey = Object.keys(widgetStates).find(k => /tileGridDesktop/i.test(k));
  const grid = safeJsonParse(widgetStates[gridKey]);
  const apiItems = Array.isArray(grid?.items) ? grid.items.map(normalizeItem) : [];
  const items = apiItems.length ? apiItems : domFallbackItems();
  const bodyText = hasDocument ? cleanText(document.body?.innerText || '') : '';
  const pagination = extractPagination(widgetStates);
  return {
    mode,
    url: pageUrl,
    api_url: absUrl(apiUrl),
    api_status: apiStatus,
    api_error: apiError,
    title: data?.seo?.title || (hasDocument ? document.title : null),
    page_info: data?.pageInfo || null,
    location: data?.location?.current || null,
    grid: grid ? {
      state_id: gridKey,
      page: grid.page ?? null,
      columns_count: grid.columnsCount ?? null,
      item_count: apiItems.length,
    } : null,
    counters: extractCounters(widgetStates, bodyText),
    pagination,
    catalog: data?.shared?.catalog || null,
    sort: extractSort(widgetStates),
    filters: extractFilters(widgetStates),
    debug: opts?.debug ? {
      widget_state_count: Object.keys(widgetStates).length,
      widget_keys: Object.keys(widgetStates).slice(0, 120),
      product_like_keys: Object.keys(widgetStates).filter(k => /purchase|product|tile|sku|item|grid|list|catalog/i.test(k)).slice(0, 120),
      product_like_samples: Object.fromEntries(
        Object.keys(widgetStates)
          .filter(k => /purchase|product|tile|sku|item|grid|list|catalog/i.test(k))
          .slice(0, 8)
          .map(k => [k, JSON.stringify(safeJsonParse(widgetStates[k], {})).slice(0, 4000)])
      ),
    } : null,
    items,
  };
}

async function extractOzonProductImagesPage(opts) {
  const urlPath = opts?.urlPath || (location.pathname + location.search) || '/product/';
  const origin = opts?.origin || 'https://www.ozon.ru';
  const pageUrl = opts?.pageUrl || new URL(urlPath, origin).toString();
  const photoLimit = opts?.photoLimit ?? 30;
  const hasDocument = typeof document !== 'undefined';

  function cleanText(s) {
    return String(s || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\u2009/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .trim();
  }
  function absUrl(href) {
    try { return new URL(href, origin).toString(); } catch { return href || null; }
  }
  function safeJsonParse(v, fallback = null) {
    if (v == null) return fallback;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return fallback; }
  }
  function productIdFromUrl(url) {
    return (
      (String(url || '').match(/-(\d+)\/?(?:\?|$)/) || [])[1] ||
      (String(url || '').match(/\/product\/(\d+)\/?(?:\?|$)/) || [])[1] ||
      null
    );
  }
  function looksLikeOzonImage(value) {
    return typeof value === 'string' && /(?:ir\.ozone\.ru|ozone\.ru\/s3|multimedia|\.jpg|\.jpeg|\.png|\.webp)/i.test(value);
  }
  function normalizeImageUrl(src) {
    if (!src) return null;
    const u = absUrl(String(src).replace(/&amp;/g, '&'));
    if (!u || !/^https?:/i.test(u)) return null;
    return u;
  }
  function canonicalImageKey(src) {
    const s = String(src || '').split('?')[0];
    return s.replace(/\/wc\d+\//i, '/').replace(/\/c\d+\//i, '/');
  }
  function collectImages(root, out = [], source = 'composer') {
    if (root == null) return out;
    if (typeof root === 'string') {
      if (looksLikeOzonImage(root)) out.push({ src: normalizeImageUrl(root), source });
      return out;
    }
    if (typeof root !== 'object') return out;
    const direct =
      root.link ||
      root.url ||
      root.src ||
      root.image ||
      root.original ||
      root.big ||
      root.large ||
      root.small ||
      root.preview;
    if (looksLikeOzonImage(direct)) out.push({ src: normalizeImageUrl(direct), source });
    if (Array.isArray(root)) {
      for (const x of root) collectImages(x, out, source);
    } else {
      for (const [key, value] of Object.entries(root)) {
        const childSource = /gallery|image|photo|picture|media/i.test(key) ? `${source}.${key}` : source;
        collectImages(value, out, childSource);
      }
    }
    return out;
  }
  function collectTexts(root, out = []) {
    if (root == null) return out;
    if (typeof root === 'string') {
      const t = cleanText(root);
      if (t) out.push(t);
      return out;
    }
    if (typeof root !== 'object') return out;
    if (typeof root.text === 'string') out.push(cleanText(root.text));
    if (Array.isArray(root)) {
      for (const x of root) collectTexts(x, out);
    } else {
      for (const x of Object.values(root)) collectTexts(x, out);
    }
    return out.filter(Boolean);
  }
  function domImages() {
    if (!hasDocument) return [];
    const selectors = [
      'img[src*="ir.ozone.ru"]',
      'img[src*="multimedia"]',
      'img[src*="ozone.ru/s3"]',
      'meta[property="og:image"]',
    ];
    const out = [];
    for (const el of Array.from(document.querySelectorAll(selectors.join(',')))) {
      const src = el.tagName === 'META'
        ? el.getAttribute('content')
        : (el.currentSrc || el.src || el.getAttribute('src'));
      if (looksLikeOzonImage(src)) out.push({ src: normalizeImageUrl(src), source: 'dom' });
    }
    return out;
  }
  function dedupeImages(items) {
    const seen = new Set();
    const out = [];
    for (const item of items || []) {
      const src = normalizeImageUrl(item?.src || item);
      if (!src) continue;
      const key = canonicalImageKey(src);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ index: out.length, src, source: item?.source || 'unknown' });
      if (out.length >= photoLimit) break;
    }
    return out;
  }

  const apiPath = '/api/composer-api.bx/page/json/v2?url=' + encodeURIComponent(urlPath);
  const apiUrl = opts?.direct ? new URL(apiPath, origin).toString() : apiPath;
  let data = null;
  let apiStatus = null;
  let apiError = null;
  try {
    const response = await fetch(apiUrl, {
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
    apiStatus = response.status;
    const text = await response.text();
    if (!response.ok) throw new Error(`Ozon page/json returned ${response.status}: ${text.slice(0, 200)}`);
    data = JSON.parse(text);
  } catch (e) {
    apiError = e?.message || String(e);
  }

  const widgetStates = data?.widgetStates || {};
  const keys = Object.keys(widgetStates || {});
  const galleryKeys = keys.filter(k => /gallery/i.test(k));
  const preferredKeys = galleryKeys.length
    ? galleryKeys
    : keys.filter(k => /image|photo|picture|media|webProduct|sku|product/i.test(k));
  const images = [];
  const sources = [];
  for (const key of preferredKeys) {
    const parsed = safeJsonParse(widgetStates[key]);
    const before = images.length;
    collectImages(parsed, images, key);
    if (images.length > before) sources.push(key);
  }
  if (!images.length) {
    for (const key of keys) collectImages(safeJsonParse(widgetStates[key]), images, key);
  }
  images.push(...domImages());
  const deduped = dedupeImages(images);

  let title = data?.seo?.title || null;
  if (!title && preferredKeys.length) {
    const texts = [];
    for (const key of preferredKeys.slice(0, 8)) collectTexts(safeJsonParse(widgetStates[key]), texts);
    title = texts.find(t => t.length > 20 && !/[₽%]|отзыв|рейтинг/i.test(t)) || null;
  }
  if (!title && hasDocument) title = document.title || null;

  return {
    url: pageUrl,
    api_url: absUrl(apiUrl),
    api_status: apiStatus,
    api_error: apiError,
    title: cleanText(title || ''),
    product_id: productIdFromUrl(pageUrl),
    image_count: deduped.length,
    images: deduped,
    sources: [...new Set(sources)].slice(0, 20),
    debug: opts?.debug ? {
      widget_state_count: keys.length,
      preferred_keys: preferredKeys.slice(0, 120),
      image_like_samples: Object.fromEntries(
        preferredKeys.slice(0, 8).map(k => [k, JSON.stringify(safeJsonParse(widgetStates[k], {})).slice(0, 2000)])
      ),
    } : null,
  };
}

async function extractOzonOrdersPage(opts) {
  const urlPath = opts?.urlPath || (location.pathname + location.search) || '/my/orderlist';
  const origin = opts?.origin || 'https://www.ozon.ru';
  const pageUrl = opts?.pageUrl || new URL(urlPath, origin).toString();
  const photoLimit = opts?.photoLimit ?? 3;

  function cleanText(s) {
    return String(s || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\u2009/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .trim();
  }
  function intFrom(s) {
    const m = String(s || '').match(/[\d\s]+/);
    return m ? Number(m[0].replace(/\s+/g, '')) : null;
  }
  function absUrl(href) {
    try { return new URL(href, origin).toString(); } catch { return href || null; }
  }
  function uniq(arr) {
    return [...new Set((arr || []).filter(Boolean))];
  }
  function safeJsonParse(v, fallback = null) {
    if (v == null) return fallback;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return fallback; }
  }
  function collectTexts(root, out = []) {
    if (root == null) return out;
    if (typeof root === 'string') {
      const t = cleanText(root);
      if (t) out.push(t);
      return out;
    }
    if (typeof root !== 'object') return out;
    if (typeof root.text === 'string') out.push(cleanText(root.text));
    if (Array.isArray(root)) {
      for (const x of root) collectTexts(x, out);
    } else {
      for (const x of Object.values(root)) collectTexts(x, out);
    }
    return out.filter(Boolean);
  }
  function collectImageUrls(root, out = []) {
    if (!root || typeof root !== 'object') return out;
    for (const [key, value] of Object.entries(root)) {
      if (typeof value === 'string' && /(?:ir\.ozone\.ru|ozone\.ru\/s3|multimedia|\.jpg|\.png|\.webp)/i.test(value)) {
        out.push(value);
      } else if ((key === 'url' || key === 'image' || key === 'src') && typeof value === 'string' && /^https?:/i.test(value)) {
        out.push(value);
      } else if (value && typeof value === 'object') {
        collectImageUrls(value, out);
      }
    }
    return out;
  }
  function findLink(root, re) {
    if (!root || typeof root !== 'object') return null;
    if (typeof root.link === 'string' && (!re || re.test(root.link))) return root.link;
    if (typeof root.url === 'string' && (!re || re.test(root.url))) return root.url;
    if (Array.isArray(root)) {
      for (const x of root) {
        const found = findLink(x, re);
        if (found) return found;
      }
    } else {
      for (const x of Object.values(root)) {
        const found = findLink(x, re);
        if (found) return found;
      }
    }
    return null;
  }
  function priceFromTexts(texts) {
    const priceText = (texts || []).find(t => /₽/.test(t)) || null;
    return {
      price_text: priceText,
      price_rub: intFrom(priceText),
    };
  }
  function normalizePreviewProduct(product, index) {
    const texts = uniq(collectTexts(product)).slice(0, 30);
    const price = priceFromTexts(texts);
    const images = uniq(collectImageUrls(product)).slice(0, photoLimit).map(src => ({ src }));
    return {
      index,
      price_text: price.price_text,
      price_rub: price.price_rub,
      images,
      raw_texts: uniq([price.price_text]).filter(Boolean),
    };
  }
  function normalizeOrder(order, index) {
    const link =
      order?.common?.action?.link ||
      order?.rightBlock?.products?.common?.action?.link ||
      findLink(order, /\/my\/orderdetails/i);
    const detailUrl = link ? absUrl(link) : null;
    let orderId = null;
    try { orderId = detailUrl ? new URL(detailUrl).searchParams.get('order') : null; } catch {}
    if (!orderId) {
      const autoId = order?.common?.testInfo?.automatizationId || '';
      orderId = (String(autoId).match(/orderListTile_([^"\s]+)/) || [])[1] || null;
    }
    const status = cleanText(order?.leftBlock?.textIcon?.text?.text || '');
    const subtitle = cleanText(order?.leftBlock?.subtitle?.text || '');
    const buttons = (order?.leftBlock?.buttons?.items || [])
      .map(b => cleanText(b?.title || b?.text || b?.cell?.title?.text || ''))
      .filter(Boolean);
    const previewProducts = (order?.rightBlock?.products?.products || []).map(normalizePreviewProduct);
    const rawTexts = uniq([
      status,
      subtitle,
      ...buttons,
      ...previewProducts.flatMap(p => [p.price_text, ...(p.raw_texts || [])]),
    ]).filter(Boolean);
    return {
      order_id: orderId,
      index,
      status: status || null,
      order_date_text: status || null,
      subtitle: subtitle || null,
      detail_url: detailUrl,
      preview_products: previewProducts,
      buttons,
      raw_texts: rawTexts,
    };
  }
  function extractPagination(widgetStates) {
    const paginators = [];
    for (const key of Object.keys(widgetStates || {})) {
      if (!/paginator/i.test(key)) continue;
      const state = safeJsonParse(widgetStates[key]);
      if (!state || typeof state !== 'object') continue;
      const nextPath = state.nextPage || state.nextUrl || state.nextURL || state.next?.link || null;
      paginators.push({
        state_id: key,
        layout_container: state.layoutContainer || state.layout_container || null,
        fetch_type: state.fetchType || state.fetch_type || null,
        size: state.size ?? null,
        next_path: nextPath,
        next_url: nextPath ? absUrl(nextPath) : null,
      });
    }
    const preferred =
      paginators.find(p => p.next_url && p.layout_container === 'order-list-desktop') ||
      paginators.find(p => p.next_url && !/recom/i.test(`${p.layout_container || ''} ${p.state_id || ''}`)) ||
      paginators.find(p => p.next_url) ||
      null;
    return { next_url: preferred?.next_url || null, paginators };
  }
  function extractFilters(widgetStates) {
    const key = Object.keys(widgetStates || {}).find(k => /orderFilters/i.test(k));
    const state = safeJsonParse(widgetStates?.[key]);
    const years = (state?.tagButtons || []).map(b => ({
      year: /^\d{4}$/.test(String(b.text || '')) ? Number(b.text) : null,
      title: cleanText(b.text || ''),
      selected: /SELECTED|PRIMARY/i.test(String(b.styleType || '')),
      url: b.common?.action?.link ? absUrl(b.common.action.link) : null,
    })).filter(x => x.year || x.title);
    return { years };
  }

  const apiPath = '/api/composer-api.bx/page/json/v2?url=' + encodeURIComponent(urlPath);
  const apiUrl = opts?.direct ? new URL(apiPath, origin).toString() : apiPath;
  let data = null;
  let apiStatus = null;
  let apiError = null;
  try {
    const response = await fetch(apiUrl, {
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
    apiStatus = response.status;
    const text = await response.text();
    if (!response.ok) throw new Error(`Ozon page/json returned ${response.status}: ${text.slice(0, 200)}`);
    data = JSON.parse(text);
  } catch (e) {
    apiError = e?.message || String(e);
  }

  const widgetStates = data?.widgetStates || {};
  const listKeys = Object.keys(widgetStates).filter(k => /orderList/i.test(k));
  const paginatorKeys = Object.keys(widgetStates).filter(k => /paginator/i.test(k));
  const rawOrders = [];
  for (const key of listKeys) {
    const state = safeJsonParse(widgetStates[key]);
    if (Array.isArray(state?.ordersV2)) rawOrders.push(...state.ordersV2);
    if (Array.isArray(state?.orders)) rawOrders.push(...state.orders);
  }
  const orders = rawOrders.map(normalizeOrder);
  return {
    mode: 'orders',
    url: pageUrl,
    api_url: absUrl(apiUrl),
    api_status: apiStatus,
    api_error: apiError,
    title: data?.seo?.title || (typeof document !== 'undefined' ? document.title : null),
    page_info: data?.pageInfo || null,
    filters: extractFilters(widgetStates),
    pagination: extractPagination(widgetStates),
    debug: opts?.debug ? {
      widget_state_count: Object.keys(widgetStates).length,
      order_list_keys: listKeys,
      paginator_keys: paginatorKeys,
    } : null,
    orders,
  };
}

async function extractOzonOrderDetailPage(opts) {
  const urlPath = opts?.urlPath || (location.pathname + location.search) || '/my/orderdetails/';
  const origin = opts?.origin || 'https://www.ozon.ru';
  const pageUrl = opts?.pageUrl || new URL(urlPath, origin).toString();
  const photoLimit = opts?.photoLimit ?? 5;

  function cleanText(s) {
    return String(s || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\u2009/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .trim();
  }
  function intFrom(s) {
    const m = String(s || '').match(/[\d\s]+/);
    return m ? Number(m[0].replace(/\s+/g, '')) : null;
  }
  function absUrl(href) {
    try { return new URL(href, origin).toString(); } catch { return href || null; }
  }
  function uniq(arr) {
    return [...new Set((arr || []).filter(Boolean))];
  }
  function safeJsonParse(v, fallback = null) {
    if (v == null) return fallback;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return fallback; }
  }
  function collectTexts(root, out = []) {
    if (root == null) return out;
    if (typeof root === 'string') {
      const t = cleanText(root);
      if (t) out.push(t);
      return out;
    }
    if (typeof root !== 'object') return out;
    if (typeof root.text === 'string') out.push(cleanText(root.text));
    if (Array.isArray(root)) {
      for (const x of root) collectTexts(x, out);
    } else {
      for (const x of Object.values(root)) collectTexts(x, out);
    }
    return out.filter(Boolean);
  }
  function collectImageUrls(root, out = []) {
    if (!root || typeof root !== 'object') return out;
    for (const [key, value] of Object.entries(root)) {
      if (typeof value === 'string' && /(?:ir\.ozone\.ru|ozone\.ru\/s3|multimedia|\.jpg|\.png|\.webp)/i.test(value)) {
        out.push(value);
      } else if ((key === 'url' || key === 'image' || key === 'src') && typeof value === 'string' && /^https?:/i.test(value)) {
        out.push(value);
      } else if (value && typeof value === 'object') {
        collectImageUrls(value, out);
      }
    }
    return out;
  }
  function actionFromProduct(product) {
    return (
      product?.title?.common?.action ||
      product?.pictureV2?.common?.action ||
      product?.picture?.common?.action ||
      product?.common?.action ||
      null
    );
  }
  function productIdFromUrl(url) {
    return (String(url || '').match(/-(\d+)\/?(?:\?|$)/) || [])[1] || null;
  }
  function priceFromProduct(product) {
    const parts = product?.price?.price || product?.price || [];
    const arr = Array.isArray(parts) ? parts : [];
    const current = arr.find(p => p.textStyle === 'PRICE') || arr[0] || null;
    const original = arr.find(p => /ORIGINAL/i.test(p.textStyle || '')) || arr[1] || null;
    return {
      price_text: cleanText(current?.text || ''),
      price_rub: intFrom(current?.text),
      original_price_text: cleanText(original?.text || ''),
      original_price_rub: intFrom(original?.text),
    };
  }
  function normalizeProduct(product, ctx, index) {
    const action = actionFromProduct(product);
    const link = action?.link || null;
    const url = link ? absUrl(link) : null;
    const id = action?.id || product?.addToCartButton?.action?.id || productIdFromUrl(url);
    const title = cleanText(product?.title?.name?.text || product?.title?.text || '');
    const attrs = (product?.attributes || [])
      .map(a => cleanText(a?.text || a?.title || ''))
      .filter(Boolean);
    const images = uniq(collectImageUrls(product)).slice(0, photoLimit).map(src => ({ src }));
    const price = priceFromProduct(product);
    return {
      id: id ? String(id) : null,
      sku: id ? String(id) : null,
      index,
      title: title || null,
      url,
      ...price,
      quantity: product?.addToCartButton?.action?.quantity ?? null,
      seller: ctx?.seller || null,
      shipment_id: ctx?.shipment_id || null,
      shipment_status: ctx?.shipment_status || null,
      attributes: attrs,
      images,
      raw_texts: uniq([
        title,
        ...attrs,
        price.price_text,
        price.original_price_text,
        ctx?.seller,
        ctx?.shipment_status,
      ]).filter(Boolean),
    };
  }
  function extractShipmentStatus(shipment) {
    const texts = [];
    for (const part of shipment?.header || []) {
      const t = part?.textIcon?.text?.text || part?.title || part?.text;
      if (t) texts.push(cleanText(t));
    }
    return texts.find(Boolean) || null;
  }
  function extractProductsFromShipment(shipment) {
    const out = [];
    const shipmentId = shipment?.shipmentId || shipment?.shipment_id || null;
    const status = extractShipmentStatus(shipment);
    for (const item of shipment?.items || []) {
      for (const seller of item?.sellers || []) {
        const sellerName = cleanText(seller?.name?.text || seller?.title?.text || seller?.name || '');
        for (const product of seller?.products || []) {
          out.push(normalizeProduct(product, { seller: sellerName, shipment_id: shipmentId, shipment_status: status }, out.length));
        }
      }
    }
    return out;
  }
  function extractOrderTitle(widgetStates) {
    const key = Object.keys(widgetStates || {}).find(k => /titleWithTimer/i.test(k));
    const state = safeJsonParse(widgetStates?.[key]);
    return cleanText(state?.title?.text || state?.text || '');
  }
  function extractTotal(widgetStates) {
    const key = Object.keys(widgetStates || {}).find(k => /orderDoneTotal/i.test(k));
    const state = safeJsonParse(widgetStates?.[key]);
    const totalText = cleanText(state?.total?.right?.price?.text || '');
    const rows = (state?.prices?.elements || []).map(row => ({
      title: cleanText(row?.left?.title?.text || row?.left?.text || ''),
      subtitle: cleanText(row?.left?.subtitle?.text || ''),
      value: cleanText(row?.right?.price?.text || row?.right?.atomPrice?.price?.[0]?.text || row?.right?.text || ''),
    })).filter(x => x.title || x.value);
    return {
      paid_title: cleanText(state?.total?.left?.title?.text || ''),
      paid_subtitle: cleanText(state?.total?.left?.subtitle?.text || ''),
      total_text: totalText || null,
      total_rub: intFrom(totalText),
      rows,
    };
  }
  function extractAddress(widgetStates) {
    const key = Object.keys(widgetStates || {}).find(k => /orderDetailsItem/i.test(k));
    const state = safeJsonParse(widgetStates?.[key]);
    return {
      title: cleanText(state?.cell?.title?.text || ''),
      subtitle: cleanText(state?.cell?.subtitle?.text || ''),
    };
  }

  const apiPath = '/api/composer-api.bx/page/json/v2?url=' + encodeURIComponent(urlPath);
  const apiUrl = opts?.direct ? new URL(apiPath, origin).toString() : apiPath;
  let data = null;
  let apiStatus = null;
  let apiError = null;
  try {
    const response = await fetch(apiUrl, {
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
    apiStatus = response.status;
    const text = await response.text();
    if (!response.ok) throw new Error(`Ozon page/json returned ${response.status}: ${text.slice(0, 200)}`);
    data = JSON.parse(text);
  } catch (e) {
    apiError = e?.message || String(e);
  }
  if (apiError) {
    return { error: apiError, api_status: apiStatus, api_url: absUrl(apiUrl) };
  }

  const widgetStates = data?.widgetStates || {};
  const orderId = (() => {
    try { return new URL(urlPath, origin).searchParams.get('order'); } catch { return null; }
  })();
  const shipments = Object.keys(widgetStates)
    .filter(k => /shipmentWidget/i.test(k))
    .map(k => safeJsonParse(widgetStates[k]))
    .filter(Boolean);
  const products = shipments.flatMap(extractProductsFromShipment);
  const orderTitle = extractOrderTitle(widgetStates);
  const status = products.find(p => p.shipment_status)?.shipment_status || null;
  return {
    mode: 'order_detail',
    order_id: orderId,
    detail_url: pageUrl,
    api_url: absUrl(apiUrl),
    api_status: apiStatus,
    title: data?.seo?.title || (typeof document !== 'undefined' ? document.title : null),
    order_title: orderTitle || null,
    order_date_text: orderTitle || null,
    status,
    total: extractTotal(widgetStates),
    address: extractAddress(widgetStates),
    products,
    raw_texts: uniq([
      orderTitle,
      status,
      extractAddress(widgetStates).title,
      extractAddress(widgetStates).subtitle,
      extractTotal(widgetStates).total_text,
      ...products.flatMap(p => [p.title, p.price_text, p.seller, ...(p.attributes || [])]),
    ]).filter(Boolean).slice(0, 120),
  };
}

function avitoHasExplicitTab(command) {
  return !!command.tabId && (command.__implicitTabId !== true || command.use_current_tab === true);
}

async function avitoCaptureActiveTab() {
  try {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    return active ? { tabId: active.id, windowId: active.windowId, url: active.url } : null;
  } catch {
    return null;
  }
}

async function avitoGetActiveTab(windowId) {
  try {
    const query = { active: true };
    if (windowId != null) query.windowId = windowId;
    else query.currentWindow = true;
    const [active] = await chrome.tabs.query(query);
    return active || null;
  } catch {
    return null;
  }
}

async function avitoIsActiveTab(tabId, windowId) {
  if (!tabId) return false;
  const active = await avitoGetActiveTab(windowId);
  return active?.id === tabId;
}

async function avitoRefreshRestoreTarget(snapshot, workTabId) {
  if (!snapshot?.tabId) return;
  const active = await avitoGetActiveTab(snapshot.windowId);
  // If the user moved to another tab while the MCP job is running, that tab is
  // now the one to preserve. Do not keep dragging them back to the tab that was
  // active when the job started.
  if (active?.id && active.id !== workTabId) {
    snapshot.tabId = active.id;
    snapshot.windowId = active.windowId;
    snapshot.url = active.url;
  }
}

async function avitoRestoreActiveTab(snapshot, onlyIfActiveTabId = null) {
  if (!snapshot?.tabId) return;
  try {
    if (onlyIfActiveTabId != null) {
      const active = await avitoGetActiveTab(snapshot.windowId);
      if (active?.id !== onlyIfActiveTabId) return false;
    }
    await chrome.tabs.get(snapshot.tabId);
    // Keep the user's browser tab selection intact without stealing macOS focus.
    // Chrome docs: tabs.update({active:true}) does not focus the window; calling
    // windows.update({focused:true}) here would pull Yandex Browser above Noted
    // Terminal for background MCP jobs.
    await chrome.tabs.update(snapshot.tabId, { active: true });
    return true;
  } catch {
    return false;
  }
}

async function avitoCloseBackgroundTab(tabId, activeSnapshot) {
  const wasActive = await avitoIsActiveTab(tabId, activeSnapshot?.windowId);
  try { await chrome.tabs.remove(tabId); } catch {}
  if (wasActive) await avitoRestoreActiveTab(activeSnapshot);
}

async function avitoOpenBackgroundTab(provider, activeSnapshot, label) {
  const props = { url: 'about:blank', active: false };
  if (activeSnapshot?.windowId != null) props.windowId = activeSnapshot.windowId;
  const created = await chrome.tabs.create(props);
  if (!created || typeof created.id !== 'number') {
    throw new Error(`failed to open background tab for ${label || 'avito'}`);
  }
  if (activeSnapshot?.tabId && created.id === activeSnapshot.tabId) {
    throw new Error(`refusing to reuse active tab for ${label || 'avito background work'}`);
  }
  try { await chrome.tabs.update(created.id, { autoDiscardable: false }); } catch {}
  try { await markTabAsMcpVisually(created.id, provider || 'avito'); } catch {}
  await avitoRestoreActiveTab(activeSnapshot, created.id);
  return created.id;
}

async function avitoNavigateTab(tabId, url, activeSnapshot) {
  if (activeSnapshot?.tabId && tabId === activeSnapshot.tabId) {
    throw new Error('refusing to navigate active tab during Avito background work');
  }
  await avitoRefreshRestoreTarget(activeSnapshot, tabId);
  await chrome.tabs.update(tabId, { url });
  await new Promise(resolve => {
    function l(id, info) {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(l);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(l);
    setTimeout(() => { chrome.tabs.onUpdated.removeListener(l); resolve(); }, 20000);
  });
  await new Promise(r => setTimeout(r, 700));
  await avitoRestoreActiveTab(activeSnapshot, tabId);
}

function avitoSetPageParam(rawUrl, page) {
  const u = new URL(rawUrl, 'https://www.avito.ru');
  if (page <= 1) u.searchParams.delete('p');
  else u.searchParams.set('p', String(page));
  return u.toString();
}

function avitoBuildSearchUrl(command) {
  const query = String(command.query || command.q || command.search || '').trim();
  const rawCategory = command.category_path || command.category || command.section || '';
  if (!query && !rawCategory) return '';

  const city = avitoCitySlug(command.city || command.region || 'moskva');
  const category = avitoCategoryPath(rawCategory);
  const u = new URL(`https://www.avito.ru/${city}${category ? '/' + category : ''}`);
  if (query) u.searchParams.set('q', query);

  const priceMin = command.price_min ?? command.min_price;
  const priceMax = command.price_max ?? command.max_price;
  if (priceMin !== undefined && priceMin !== null && String(priceMin).trim() !== '') {
    u.searchParams.set('pmin', String(Math.max(0, parseInt(priceMin, 10) || 0)));
  }
  if (priceMax !== undefined && priceMax !== null && String(priceMax).trim() !== '') {
    u.searchParams.set('pmax', String(Math.max(0, parseInt(priceMax, 10) || 0)));
  }

  const sellerType = String(command.seller_type || command.seller || '').toLowerCase().trim();
  if (sellerType && command.user === undefined) {
    if (/^(private|person|owner|user|chast|частн|частник|собственник)/i.test(sellerType)) {
      u.searchParams.set('user', '1');
    } else if (/^(company|business|shop|store|professional|компан|магаз|бизнес|юр)/i.test(sellerType)) {
      u.searchParams.set('user', '2');
    }
  }

  return u.toString();
}

function avitoCitySlug(raw) {
  const v = String(raw || 'moskva').toLowerCase().trim().replace(/ё/g, 'е');
  const aliases = {
    msk: 'moskva',
    moscow: 'moskva',
    москва: 'moskva',
    moskva: 'moskva',
    spb: 'sankt-peterburg',
    питер: 'sankt-peterburg',
    'санкт-петербург': 'sankt-peterburg',
    'санкт петербург': 'sankt-peterburg',
    petersburg: 'sankt-peterburg',
    'st-petersburg': 'sankt-peterburg',
    'saint-petersburg': 'sankt-peterburg',
    ekb: 'ekaterinburg',
    екатеринбург: 'ekaterinburg',
    kazan: 'kazan',
    казань: 'kazan',
    novosibirsk: 'novosibirsk',
    новосибирск: 'novosibirsk',
    nizhniy: 'nizhniy_novgorod',
    'нижний новгород': 'nizhniy_novgorod',
    'nizhny novgorod': 'nizhniy_novgorod',
  };
  if (aliases[v]) return aliases[v];
  return v
    .replace(/[^a-zа-я0-9 _-]+/gi, '')
    .replace(/\s+/g, '_')
    .replace(/-+/g, '-')
    .replace(/^[_-]+|[_-]+$/g, '') || 'moskva';
}

function avitoCategoryPath(raw) {
  const v = String(raw || '').toLowerCase().trim().replace(/ё/g, 'е');
  const aliases = {
    laptop: 'noutbuki',
    laptops: 'noutbuki',
    notebook: 'noutbuki',
    notebooks: 'noutbuki',
    macbook: 'noutbuki',
    ноутбук: 'noutbuki',
    ноутбуки: 'noutbuki',
    noutbuki: 'noutbuki',
    phone: 'telefony',
    phones: 'telefony',
    smartphone: 'telefony',
    smartphones: 'telefony',
    телефон: 'telefony',
    телефоны: 'telefony',
    telefony: 'telefony',
  };
  const mapped = aliases[v] || v;
  return mapped
    .replace(/^https?:\/\/(?:www\.)?avito\.ru\//i, '')
    .replace(/^\/+|\/+$/g, '')
    .split('?')[0]
    .replace(/[^a-z0-9_/-]+/gi, '')
    .replace(/\/{2,}/g, '/');
}

function avitoPrepareSearchUrl(rawUrl, command) {
  const u = new URL(rawUrl, 'https://www.avito.ru');
  if (command.f) u.searchParams.set('f', String(command.f));
  if (command.user !== undefined && command.user !== null) u.searchParams.set('user', String(command.user));
  if (command.localPriority !== undefined && command.localPriority !== null) {
    u.searchParams.set('localPriority', command.localPriority ? '1' : '0');
  }
  const bbox = command.map_bbox || command.map;
  if (bbox) {
    const area = {
      latBottom: Number(bbox.latBottom),
      latTop: Number(bbox.latTop),
      lonLeft: Number(bbox.lonLeft),
      lonRight: Number(bbox.lonRight),
    };
    if (Object.values(area).every(Number.isFinite)) {
      const map = { searchArea: area, zoom: Number(bbox.zoom) || 15 };
      u.searchParams.set('map', btoa(JSON.stringify(map)));
      u.searchParams.set('localPriority', '0');
    }
  }
  if (command.page) {
    if (Number(command.page) <= 1) u.searchParams.delete('p');
    else u.searchParams.set('p', String(Number(command.page)));
  } else {
    u.searchParams.delete('p');
  }
  return u.toString();
}

function extractAvitoSearchPage(opts) {
  const photoLimit = opts?.photoLimit ?? 5;
  const descriptionLimit = opts?.descriptionLimit ?? 1800;

  function cleanText(s) {
    return String(s || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .trim();
  }
  function linesOf(s) {
    return cleanText(s).split('\n').map(x => cleanText(x)).filter(Boolean);
  }
  function intFrom(s) {
    const m = String(s || '').match(/[\d\s]+/);
    return m ? Number(m[0].replace(/\s+/g, '')) : null;
  }
  function absUrl(href) {
    try { return new URL(href, location.origin).toString(); } catch { return href || null; }
  }
  function uniq(arr) {
    return [...new Set((arr || []).filter(Boolean))];
  }
  function parseTitle(title) {
    const t = cleanText(title);
    const rooms = (t.match(/(\d+)\s*[- ]?к\./i) || [])[1];
    const area = (t.match(/([\d,.]+)\s*м²/i) || [])[1];
    const floor = t.match(/(\d+)\s*\/\s*(\d+)\s*эт/i);
    return {
      rooms: rooms ? Number(rooms) : (/студ/i.test(t) ? 0 : null),
      area_m2: area ? Number(area.replace(',', '.')) : null,
      floor: floor ? Number(floor[1]) : null,
      floors_total: floor ? Number(floor[2]) : null,
    };
  }
  function parseConditions(text) {
    const t = cleanText(text);
    const deposit = t.match(/Залог\s*([\d\s]+)\s*₽/i);
    const commission = t.match(/Комиссия:?\s*([\d\s]+)\s*%?/i);
    const utilities = t.match(/(?:Все\s*)?ЖКУ[^·\n]*/i);
    return {
      owner: /(^|\n| )Собственник( |\n|$)/i.test(t) || /Аренда от собственника/i.test(t),
      rosreestr: /Росреестр/i.test(t),
      deposit_rub: deposit ? Number(deposit[1].replace(/\s+/g, '')) : null,
      no_commission: /Без\s+комисси/i.test(t) || /Комиссия:\s*0\s*%/i.test(t),
      commission: commission ? cleanText(commission[0]) : null,
      utilities: utilities ? cleanText(utilities[0]) : null,
      can_children: /Можно с детьми:\s*да/i.test(t) ? true : /Можно с детьми:\s*нет/i.test(t) ? false : null,
      can_pets: /Можно с питомцем:\s*да/i.test(t) ? true : /Можно с питомцем:\s*нет/i.test(t) ? false : null,
    };
  }
  function parseAddress(lines) {
    const addrWords = /(ул\.|улица|пр-т|проспект|пер\.|переулок|ш\.|шоссе|наб\.|набережная|проезд|пр\.|б-р|бульвар|пл\.|площадь|аллея|к\d|с\d|д\.)/i;
    const address = lines.find(l => addrWords.test(l) && !/₽|фото|квартира|Залог|Комисси/i.test(l)) || null;
    const metro = lines.find(l => /(до\s*5|6[–-]10|11[–-]15|16[–-]20|21[–-]30|\d+\s*мин\.)/i.test(l) && !/фото|Залог|Комисси/i.test(l)) || null;
    return { address, metro };
  }
  function parsePublished(lines) {
    return lines.find(l => /(час|дн|недел|сегодня|вчера|\d{1,2}\s+[а-я]+(?:\s+\d{4})?)/i.test(l) && !/₽|м²|мин|фото/i.test(l)) || null;
  }
  function extractCard(card, index) {
    const id = card.getAttribute('data-item-id') || card.id?.replace(/^i/, '') || null;
    const titleEl = card.querySelector('[itemprop="name"]');
    const title = cleanText(titleEl?.textContent || card.querySelector('h2,h3,h5')?.textContent || '');
    const linkEl = titleEl?.closest('a') || card.querySelector('a[itemprop="url"], a[href*="/kvartiry/"]');
    const url = absUrl(linkEl?.getAttribute('href') || linkEl?.href || '');
    const priceMeta = card.querySelector('meta[itemprop="price"], [itemprop="price"][content]');
    const priceText = cleanText(card.querySelector('[itemprop="offers"]')?.textContent || card.querySelector('[class*="price"]')?.textContent || '');
    const price = priceMeta?.getAttribute('content') ? Number(priceMeta.getAttribute('content')) : intFrom(priceText);
    const descMeta = card.querySelector('meta[itemprop="description"]');
    const description = cleanText(descMeta?.getAttribute('content') || '');
    const text = cleanText(card.innerText || '');
    const lines = linesOf(text);
    const imgs = uniq(Array.from(card.querySelectorAll('img[itemprop="image"], img'))
      .map(img => img.currentSrc || img.src)
      .filter(src => /img\.avito\.st|avito\.st\/image/i.test(src)))
      .slice(0, photoLimit);
    const more = text.match(/Ещё\s*(\d+)\s*фото/i);
    const parsed = parseTitle(title);
    const where = parseAddress(lines);
    return {
      id,
      index,
      title,
      url,
      price_rub: price || null,
      price_text: priceText || null,
      ...parsed,
      ...where,
      conditions: parseConditions(text),
      description: description ? description.slice(0, descriptionLimit) : null,
      snippet: text.slice(0, descriptionLimit),
      photo_count_min: more ? Number(more[1]) + 1 : (imgs.length || null),
      photos: imgs,
      published: parsePublished(lines),
      raw_lines: lines.slice(0, 40),
    };
  }

  const cards = Array.from(document.querySelectorAll('[data-marker="item"][data-item-id]'));
  const items = cards.map(extractCard).filter(x => x.id || x.url || x.title);
  const titleText = cleanText(document.querySelector('.page-title-root-NLk0B')?.innerText || document.querySelector('h1')?.parentElement?.innerText || document.title);
  const totalMatch = titleText.match(/(\d[\d\s]{1,})\s*$/);
  const total = totalMatch ? Number(totalMatch[1].replace(/\s+/g, '')) : null;
  const currentPage = Number(new URL(location.href).searchParams.get('p') || '1') || 1;
  const pageMap = new Map();
  for (const a of Array.from(document.querySelectorAll('a[href*="p="]'))) {
    try {
      const u = new URL(a.href, location.origin);
      const p = Number(u.searchParams.get('p'));
      if (p && !pageMap.has(p)) pageMap.set(p, u.toString());
    } catch {}
  }
  const pages = [...pageMap.entries()].sort((a, b) => a[0] - b[0]).map(([page, url]) => ({ page, url }));
  return {
    title: document.title,
    page_title: titleText,
    current_page: currentPage,
    total_count: total,
    items,
    pagination: {
      pages,
      next_url: pageMap.get(currentPage + 1) || null,
      last_page: pages.length ? Math.max(...pages.map(p => p.page)) : null,
    },
  };
}

function extractAvitoItemDetail(opts) {
  const photoLimit = opts?.photoLimit ?? 12;
  const descriptionLimit = opts?.descriptionLimit ?? 12000;

  function cleanText(s) {
    return String(s || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .trim();
  }
  function linesOf(s) {
    return cleanText(s).split('\n').map(x => cleanText(x)).filter(Boolean);
  }
  function uniq(arr) {
    return [...new Set((arr || []).filter(Boolean))];
  }
  function intFrom(s) {
    const m = String(s || '').match(/[\d\s]+/);
    return m ? Number(m[0].replace(/\s+/g, '')) : null;
  }
  function parseTitle(title) {
    const t = cleanText(title);
    const rooms = (t.match(/(\d+)\s*[- ]?к\./i) || [])[1];
    const area = (t.match(/([\d,.]+)\s*м²/i) || [])[1];
    const floor = t.match(/(\d+)\s*\/\s*(\d+)\s*эт/i);
    return {
      rooms: rooms ? Number(rooms) : (/студ/i.test(t) ? 0 : null),
      area_m2: area ? Number(area.replace(',', '.')) : null,
      floor: floor ? Number(floor[1]) : null,
      floors_total: floor ? Number(floor[2]) : null,
    };
  }
  function markLabels(s) {
    const labels = [
      'Количество комнат', 'Общая площадь', 'Площадь кухни', 'Жилая площадь',
      'Этаж', 'Балкон или лоджия', 'Санузел', 'Ремонт', 'Мебель', 'Техника',
      'Интернет и ТВ', 'Залог', 'Комиссия', 'По счётчикам', 'По счетчикам',
      'Другие ЖКУ', 'Количество жильцов', 'Можно с детьми', 'Можно с питомцем',
      'Можно курить', 'Тип дома', 'Год постройки', 'Этажей в доме',
      'Пассажирский лифт', 'Грузовой лифт', 'Парковка',
    ];
    let out = cleanText(s);
    for (const label of labels) {
      out = out.replace(new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:', 'gi'), '\n' + label + ': ');
    }
    return out;
  }
  function parseKeyValues(text) {
    const out = {};
    const prepared = markLabels(text);
    const lines = linesOf(prepared);
    for (const l of lines) {
      const m = l.match(/^([^:]{2,60}):\s*(.+)$/);
      if (!m) continue;
      out[cleanText(m[1])] = cleanText(m[2]);
    }
    return out;
  }
  function parseSections() {
    const out = [];
    for (const node of Array.from(document.querySelectorAll('#bx_item-params'))) {
      const heading = cleanText(node.querySelector('h2')?.textContent || '');
      const text = cleanText(node.innerText || '').replace(heading, '').trim();
      if (!heading && !text) continue;
      out.push({ heading, text, params: parseKeyValues(text) });
    }
    return out;
  }
  function parseConditions(allText, sections) {
    const sectionParams = Object.assign({}, ...sections.map(s => s.params || {}));
    const depositText = sectionParams['Залог'] || (allText.match(/Залог:?\s*([\d\s]+)\s*₽/i) || [])[0] || '';
    const commissionText = sectionParams['Комиссия'] || '';
    return {
      owner: /Аренда от собственника|Собственник|Собственником/i.test(allText),
      rosreestr: /Росреестр/i.test(allText),
      deposit_rub: intFrom(depositText),
      no_commission: /Комиссия:\s*0\s*%|Без\s+комисси/i.test(allText) || commissionText === '0 %',
      commission: commissionText || null,
      counters: sectionParams['По счётчикам'] || sectionParams['По счетчикам'] || null,
      utilities: sectionParams['Другие ЖКУ'] || null,
      residents: sectionParams['Количество жильцов'] || null,
      can_children: sectionParams['Можно с детьми'] || null,
      can_pets: sectionParams['Можно с питомцем'] || null,
      can_smoke: sectionParams['Можно курить'] || null,
    };
  }
  function readAddress() {
    const el = document.querySelector('[itemprop="address"], #item-view-address');
    const lines = linesOf(el?.innerText || '');
    const metros = lines.filter(l => /(до\s*5|6[–-]10|11[–-]15|16[–-]20|21[–-]30|\d+\s*мин\.)/i.test(l));
    return {
      text: cleanText(el?.innerText || ''),
      address: lines.find(l => /Москва|ул\.|улица|пр-т|проспект|пер\.|ш\.|наб\.|проезд|б-р|пл\./i.test(l)) || null,
      metros,
    };
  }
  function readPhotos() {
    const gallery = Array.from(document.images)
      .filter(img => /img\.avito\.st|avito\.st\/image/i.test(img.currentSrc || img.src))
      .filter(img => (img.naturalWidth || 0) >= 90 && (img.naturalHeight || 0) >= 70)
      .map(img => ({
        src: img.currentSrc || img.src,
        alt: img.alt || '',
        width: img.naturalWidth || null,
        height: img.naturalHeight || null,
      }));
    const seen = new Set();
    const deduped = [];
    for (const img of gallery) {
      const key = img.src.split('?')[0];
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(img);
    }
    const og = uniq(Array.from(document.querySelectorAll('meta[property="og:image"]')).map(m => m.content));
    return { photos: deduped.slice(0, photoLimit), og_images: og.slice(0, photoLimit) };
  }
  function readSeller() {
    const sellerName = cleanText(document.querySelector('.js-seller-info-name')?.textContent || document.querySelector('[itemprop="publisher"]')?.textContent || document.querySelector('meta[property="vk:seller_name"]')?.content || '');
    const sellerBlock = cleanText(document.querySelector('.js-seller-info-name')?.closest('div')?.parentElement?.innerText || '');
    const profile = document.querySelector('.js-public-profile-link, a[href*="/user/"][href*="/profile"]')?.href || null;
    const allLines = linesOf(allText);
    const blockLines = linesOf(sellerBlock);
    let contextLines = blockLines;
    if (sellerName) {
      const idx = allLines.map((l, i) => l === sellerName ? i : -1).filter(i => i >= 0).pop();
      if (idx >= 0) contextLines = allLines.slice(idx, idx + 10);
    }
    const context = contextLines.join('\n');
    const ratingLine = contextLines.find(l => /^\d(?:[,.]\d)?$/.test(l));
    const reviewsLine = contextLines.find(l => /\d[\d\s]*\s+отзыв/i.test(l));
    const typeLine = contextLines.find(l => /^(Компания|Частное лицо|Арендодатель|Собственник)(?:$|\s| ·)/i.test(l));
    const kind = /Компания/i.test(typeLine || '') ? 'company'
      : /Частное лицо/i.test(typeLine || '') ? 'private'
      : /Арендодатель/i.test(typeLine || '') ? 'landlord'
      : /Собственник/i.test(typeLine || '') ? 'owner'
      : null;
    const reviewsMatch = reviewsLine?.match(/(\d[\d\s]*)\s+отзыв/i);
    return {
      name: sellerName || null,
      kind,
      rating: ratingLine ? Number(ratingLine.replace(',', '.')) : null,
      review_count: reviewsMatch ? Number(reviewsMatch[1].replace(/\s+/g, '')) : null,
      profile_url: profile,
      raw: (context || sellerBlock).slice(0, 1000) || null,
    };
  }
  function readChatPreview() {
    const root = document.querySelector('messenger-mfe-minimessenger');
    const raw = cleanText(root?.innerText || '');
    return raw ? { raw_text: raw.slice(0, 4000), lines: linesOf(raw).slice(0, 80) } : null;
  }

  const allText = cleanText(document.body?.innerText || '');
  const title = cleanText(document.querySelector('h1[itemprop="name"], h1')?.textContent || document.title);
  const sections = parseSections();
  const priceNode = document.querySelector('[itemprop="price"][content], meta[property="product:price:amount"], [itemprop="price"]');
  const priceText = cleanText(document.querySelector('[itemprop="offers"]')?.innerText || '');
  const price = priceNode?.getAttribute('content') ? Number(priceNode.getAttribute('content')) : intFrom(priceText);
  const descriptionNode = Array.from(document.querySelectorAll('[itemprop="description"]'))
    .sort((a, b) => (b.innerText || b.content || '').length - (a.innerText || a.content || '').length)[0];
  const description = cleanText(descriptionNode?.innerText || descriptionNode?.content || document.querySelector('meta[name="description"]')?.content || '');
  const id = (location.pathname.match(/_(\d+)$/) || location.href.match(/[?&]iid=(\d+)/) || allText.match(/№\s*(\d+)/) || [])[1] || null;
  const address = readAddress();
  const houseLinks = Array.from(document.querySelectorAll('a[href*="/catalog/houses/"]')).map(a => ({
    text: cleanText(a.innerText || a.getAttribute('aria-label') || ''),
    url: a.href,
  }));
  const houseReviews = houseLinks.find(x => /отзыв/i.test(x.text)) || null;
  const houseUrl = houseLinks.find(x => /Узнать больше|\/catalog\/houses\//i.test(x.text + x.url)) || null;
  const photos = readPhotos();
  return {
    url: location.href,
    id,
    title,
    ...parseTitle(title),
    price_rub: price || null,
    price_text: priceText || null,
    address,
    conditions: parseConditions(allText, sections),
    sections,
    description: description.slice(0, descriptionLimit),
    photos: photos.photos,
    og_images: photos.og_images,
    seller: readSeller(),
    house: {
      reviews: houseReviews,
      url: houseUrl,
    },
    chat_preview: readChatPreview(),
    raw_tail: linesOf(allText).slice(-80),
  };
}

async function extractAvitoMessagesList(opts) {
  const limit = opts?.limit || 50;
  const maxScrolls = opts?.maxScrolls || 0;
  const query = String(opts?.query || '').trim();
  const unreadOnly = !!opts?.unreadOnly;
  const useAvitoSearch = opts?.useAvitoSearch !== false;

  function cleanText(s) {
    return String(s || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .trim();
  }
  function linesOf(s) {
    return cleanText(s).split('\n').map(x => cleanText(x)).filter(Boolean);
  }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function norm(s) {
    return cleanText(s).toLowerCase().replace(/ё/g, 'е');
  }
  function channelIdFromUrl(href) {
    try {
      const u = new URL(href, location.origin);
      const m = u.pathname.match(/\/profile\/messenger\/channel\/([^/?#]+)/);
      return m ? decodeURIComponent(m[1]) : null;
    } catch { return null; }
  }
  function textOf(root, selector) {
    return cleanText(root.querySelector(selector)?.innerText || root.querySelector(selector)?.textContent || '');
  }
  function findScrollContainer() {
    const first = document.querySelector('a[href*="/profile/messenger/channel/"]');
    let n = first;
    while (n && n !== document.body) {
      if (n.scrollHeight > n.clientHeight + 80) return n;
      n = n.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }
  function extract() {
    const anchors = Array.from(document.querySelectorAll('a[href*="/profile/messenger/channel/"]'));
    return anchors.map((a, index) => {
      const root = a.querySelector('[data-marker="channels/channel"]') || a;
      const rootClass = String(root.className || '');
      const allClass = Array.from(root.querySelectorAll('*')).map(el => String(el.className || '')).join(' ');
      const raw = cleanText(a.innerText || root.innerText || '');
      const channelId = channelIdFromUrl(a.href);
      const unread = /(?:^|[-_])unread(?:[-_]|$)/i.test(rootClass + ' ' + allClass);
      const datetime = textOf(root, '[data-marker="channels/channel-datetime"]');
      const user = textOf(root, '[data-marker="channels/user-title"]') || linesOf(raw)[0] || null;
      const itemTitle = textOf(root, '[data-marker="channels/item-title"]') || null;
      const itemPrice = textOf(root, '[data-marker="channels/item-price"]') || null;
      const lastMessage = textOf(root, '[data-marker="channels/last-message"]') || null;
      const tags = Array.from(root.querySelectorAll('[data-marker="channels/custom-tag"]'))
        .map(el => cleanText(el.innerText || el.textContent))
        .filter(Boolean);
      const avatar = root.querySelector('[data-marker="avatar/image"], img')?.currentSrc || root.querySelector('[data-marker="avatar/image"], img')?.src || null;
      const haystack = norm([user, itemTitle, itemPrice, lastMessage, tags.join(' '), raw].join('\n'));
      const matchQuery = !query || norm(query).split(/\s+/).filter(Boolean).every(t => haystack.includes(t));
      return {
        index,
        channel_id: channelId,
        url: a.href,
        user,
        item_title: itemTitle,
        item_price: itemPrice,
        last_message: lastMessage,
        datetime,
        unread,
        tags,
        avatar,
        support: /^a2u-/.test(channelId || ''),
        match_query: matchQuery,
        raw_text: raw.slice(0, 1200),
      };
    });
  }

  if (query && useAvitoSearch) {
    const input = document.querySelector('input[placeholder="Поиск по сообщениям"], input[type="search"]');
    if (input) {
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(input, query);
      else input.value = query;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(900);
    }
  }

  const seen = new Map();
  let container = findScrollContainer();
  for (let pass = 0; pass <= maxScrolls; pass++) {
    for (const item of extract()) {
      if (!item.channel_id && !item.url) continue;
      if (unreadOnly && !item.unread) continue;
      if (query && !item.match_query && !useAvitoSearch) continue;
      const key = item.channel_id || item.url;
      if (!seen.has(key)) seen.set(key, item);
      if (seen.size >= limit) break;
    }
    if (seen.size >= limit || pass === maxScrolls) break;
    const before = container.scrollTop;
    container.scrollTop = Math.min(container.scrollTop + Math.max(320, container.clientHeight || 600), container.scrollHeight);
    await sleep(450);
    if (container.scrollTop === before) break;
  }

  const unreadCounterText = cleanText(document.querySelector('[data-marker="header/unread-chats-counter"]')?.innerText || '');
  const unreadCounter = unreadCounterText ? Number(unreadCounterText.replace(/\D+/g, '')) || null : null;
  return {
    url: location.href,
    query: query || null,
    unread_counter: unreadCounter,
    fetched: seen.size,
    channels: [...seen.values()].slice(0, limit),
    note: 'Reading the list does not open threads; opening a thread may mark unread messages as read in Avito.',
  };
}

function extractAvitoThread(opts) {
  const limit = opts?.limit || 120;

  function cleanText(s) {
    return String(s || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .trim();
  }
  function linesOf(s) {
    return cleanText(s).split('\n').map(x => cleanText(x)).filter(Boolean);
  }
  function textOf(selector) {
    return cleanText(document.querySelector(selector)?.innerText || document.querySelector(selector)?.textContent || '');
  }
  const channelId = (() => {
    try {
      const m = new URL(location.href).pathname.match(/\/profile\/messenger\/channel\/([^/?#]+)/);
      return m ? decodeURIComponent(m[1]) : null;
    } catch { return null; }
  })();
  const delimiter = document.querySelector('[data-marker="newMessagesDelimiter"]');
  const delimiterTop = delimiter ? delimiter.getBoundingClientRect().top : null;
  const messageNodes = Array.from(document.querySelectorAll('[data-marker="message"]'));
  const messages = messageNodes.slice(-limit).map((node, index) => {
    const cls = String(node.className || '');
    const text = cleanText(node.querySelector('[data-marker="messageText"]')?.innerText || node.innerText || '');
    const time = cleanText(node.querySelector('time')?.innerText || '');
    const rect = node.getBoundingClientRect();
    return {
      index,
      direction: /right/i.test(cls) ? 'outgoing' : /left/i.test(cls) ? 'incoming' : null,
      text: text.replace(/\n?\d{1,2}:\d{2}$/, '').trim(),
      time,
      read_marker: !!node.querySelector('[data-marker="icon/messenger-statusRead"]'),
      after_unread_delimiter: delimiterTop != null ? rect.top > delimiterTop : null,
      raw_text: cleanText(node.innerText || '').slice(0, 2000),
    };
  });
  const itemLink = document.querySelector('[data-marker="header/itemLink"]');
  const textarea = document.querySelector('[data-marker="reply/input"]');
  const suggestions = Array.from(document.querySelectorAll('[data-marker="suggestMessages/button"]'))
    .map(el => cleanText(el.innerText || el.textContent))
    .filter(Boolean);
  return {
    url: location.href,
    channel_id: channelId,
    user: textOf('[data-marker="header/authorName"]') || null,
    online_status: textOf('[data-marker="header/onlineStatus"]') || null,
    item: {
      title: cleanText(itemLink?.innerText || '') || null,
      url: itemLink?.href || null,
    },
    unread_delimiter_present: !!delimiter,
    messages,
    composer: {
      present: !!textarea,
      value: textarea ? textarea.value : null,
      placeholder: textarea ? textarea.getAttribute('placeholder') : null,
    },
    suggestions,
    raw_text: cleanText(document.querySelector('[data-marker="desktop-messenger"]')?.innerText || document.body.innerText || '').slice(0, 8000),
    side_effect: 'Opening an unread Avito thread can mark it as read.',
  };
}

async function avitoChatAction(opts) {
  const mode = opts?.mode || 'read';
  const message = String(opts?.message || '');
  const confirm = !!opts?.confirm;
  const openComposer = opts?.openComposer !== false;

  function cleanText(s) {
    return String(s || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .trim();
  }
  function linesOf(s) {
    return cleanText(s).split('\n').map(x => cleanText(x)).filter(Boolean);
  }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function clickLike(el) {
    if (!el) return false;
    const target = el.closest('button,a,[role="button"]') || el;
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  }
  async function waitFor(fn, ms) {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const v = fn();
      if (v) return v;
      await sleep(100);
    }
    return fn();
  }
  function readThread() {
    const roots = [];
    const mm = document.querySelector('messenger-mfe-minimessenger');
    if (mm) roots.push(mm);
    const ta = document.querySelector('textarea[data-marker="icebreakers/textarea"]');
    if (ta) {
      let n = ta;
      for (let i = 0; n && i < 8; i++, n = n.parentElement) {
        const text = cleanText(n.innerText || '');
        if (/Доставлено|Сегодня|Вчера|Написать|Здравствуйте|Отправка фото|можно посмотреть/i.test(text)) roots.push(n);
      }
    }
    const raw = cleanText(roots.map(r => r.innerText || '').sort((a, b) => b.length - a.length)[0] || '');
    const textarea = document.querySelector('textarea[data-marker="icebreakers/textarea"]');
    return {
      url: location.href,
      raw_text: raw.slice(0, 6000),
      lines: linesOf(raw).slice(0, 160),
      textarea_value: textarea ? textarea.value : null,
      composer_open: !!textarea,
    };
  }
  async function openChat() {
    let textarea = document.querySelector('textarea[data-marker="icebreakers/textarea"]');
    if (textarea) return textarea;
    if (openComposer) {
      clickLike(document.querySelector('button[data-marker="messenger-button/button"], #bx_contact-button_messenger'));
      textarea = await waitFor(() => document.querySelector('textarea[data-marker="icebreakers/textarea"]'), 4000);
    }
    const expand = document.querySelector('[data-marker="mini-messenger/expand"]');
    if (expand) {
      clickLike(expand);
      await sleep(500);
    }
    return textarea || document.querySelector('textarea[data-marker="icebreakers/textarea"]');
  }
  function setTextareaValue(textarea, value) {
    textarea.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(textarea, value);
    else textarea.value = value;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
  }

  if (mode === 'read') {
    await openChat();
    return { mode, chat: readThread() };
  }

  if (!message.trim()) return { error: 'message is required' };
  if (mode === 'send' && !confirm) {
    return {
      error: 'confirm:true is required to send Avito messages',
      drafted: false,
      chat: readThread(),
    };
  }
  const textarea = await openChat();
  if (!textarea) return { error: 'message textarea not found; Avito may require opening messenger manually', chat: readThread() };
  setTextareaValue(textarea, message);
  await sleep(300);

  if (mode === 'draft') {
    return { mode, drafted: true, chat: readThread() };
  }

  const send = document.querySelector('[data-marker="icebreakers/send-message"], svg[name="send"]');
  if (!send) return { error: 'send button not found after drafting', drafted: true, chat: readThread() };
  clickLike(send);
  await sleep(1500);
  return { mode, sent: true, chat: readThread() };
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
