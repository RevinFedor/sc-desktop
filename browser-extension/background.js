// SC Browser Parser - Background Service Worker
// Three responsibilities:
//   1) Relay logs from content/popup to native messaging host (legacy).
//   2) Track YouTube → sc-desktop jobs and show a system notification when
//      they finish, regardless of which tab the user is currently on.
//      Tracker state lives in chrome.storage.local (survives SW recycling)
//      and is polled by chrome.alarms (also survives SW going idle).
//   3) MCP Bridge — WS-канал к локальному bridge.js, через который Claude
//      Code управляет браузером (см. mcp-handlers.js + mcp/browser/).
//      Расширение dev-only, никакого прод-стриппинга не нужно.

// MCP-Bridge подключается в SW через importScripts (MV3 разрешает).
// mcp-handlers.js сам вызывает connectMcpBridge() в конце файла.
try { importScripts('english-lexeme.js', 'learning-store.js'); }
catch (e) { console.warn('[SC-BG] learning-store load failed:', e); }
try { importScripts('mcp-window-model.js'); }
catch (e) { console.warn('[SC-BG] mcp-window-model load failed:', e); }
try { importScripts('research-tab-registry.js'); }
catch (e) { console.warn('[SC-BG] research-tab-registry load failed:', e); }
try { importScripts('mcp-handlers.js'); }
catch (e) { console.warn('[SC-BG] mcp-handlers load failed:', e); }
try { importScripts('tab-placement.js'); }
catch (e) { console.warn('[SC-BG] tab-placement load failed:', e); }
try { importScripts('chatgpt-entry-url.js'); }
catch (e) { console.warn('[SC-BG] chatgpt-entry-url load failed:', e); }
try { importScripts('settings.js'); }
catch (e) { console.warn('[SC-BG] settings load failed:', e); }

const NMH_NAME = 'com.fedor.aistudio_exporter';
const SC_BRIDGE = 'http://127.0.0.1:53127';
const TRACKER_KEY = '__sc_tracker_jobs';
const POLL_ALARM = 'sc-yt-poll';
const POLL_PERIOD_MIN = 0.1; // 6 seconds — minimum supported by chrome.alarms
const TRACKER_TTL_MS = 30 * 60 * 1000; // считаем job stale через полчаса
const MAX_RESUME_ATTEMPTS = 3; // awaiting_ai → /yt-resume-ai retry cap до 'error'
const YOUTUBE_SETTINGS_PATH = '/extension-settings/youtube';
const SC_EXTENSION_ID = 'phnlfhkblebijojjnnlbcbklijgcijgf';
const VOCABULARY_SYNC_ALARM = 'sc-vocabulary-sync';

const learningStore = self.__scLearningStore;
const learningMutationActions = new Set([
  'setState', 'saveMachineTranslation', 'editTranslation', 'queueReview', 'undoReview', 'resolveConflict',
]);

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'sc-open-study') return undefined;
  try {
    const pending = chrome.runtime.openOptionsPage();
    pending?.catch?.((error) => {
      console.warn('[SC-BG] open vocabulary page failed:', error?.message || error);
    });
  } catch (error) {
    console.warn('[SC-BG] open vocabulary page failed:', error?.message || error);
  }
  return false;
});

if (learningStore?.MESSAGE_METHODS) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'sc-learning-store') return undefined;
    const action = String(message.action || '');
    if (!learningStore.MESSAGE_METHODS.has(action) || typeof learningStore[action] !== 'function') {
      sendResponse({ ok: false, error: 'Unknown learning-store action' });
      return false;
    }
    Promise.resolve(learningStore[action](message.payload || {}))
      .then((result) => {
        sendResponse({ ok: true, result });
        if (learningMutationActions.has(action)) learningStore.sync().catch(() => {});
      })
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  });

  learningStore.subscribe((detail) => {
    chrome.tabs.query({ url: ['https://www.youtube.com/*', 'https://m.youtube.com/*'] }, (tabs) => {
      for (const tab of tabs || []) {
        if (!tab?.id) continue;
        chrome.tabs.sendMessage(tab.id, { type: 'sc-learning-store-changed', detail }, () => {
          void chrome.runtime.lastError;
        });
      }
    });
  });

  chrome.alarms.create(VOCABULARY_SYNC_ALARM, { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === VOCABULARY_SYNC_ALARM) learningStore.sync().catch(() => {});
  });
  learningStore.migrateLegacy()
    .then(() => learningStore.sync())
    .catch(() => {});
}

function storageSyncGet(defaults) {
  return new Promise(resolve => chrome.storage.sync.get(defaults, resolve));
}

function storageSyncSet(payload) {
  return new Promise(resolve => chrome.storage.sync.set(payload, resolve));
}

function storageLocalGet(defaults) {
  return new Promise(resolve => chrome.storage.local.get(defaults, resolve));
}

function storageLocalSet(payload) {
  return new Promise(resolve => chrome.storage.local.set(payload, resolve));
}

async function clearSentYoutubePendingPatch(sentPatch) {
  if (!sentPatch || !Object.keys(sentPatch).length) return;
  const raw = await storageLocalGet({ __sc_yt_pending_desktop_patch: {} });
  const current = raw.__sc_yt_pending_desktop_patch
    && typeof raw.__sc_yt_pending_desktop_patch === 'object'
    ? { ...raw.__sc_yt_pending_desktop_patch }
    : {};
  for (const [key, value] of Object.entries(sentPatch)) {
    if (current[key] === value) delete current[key];
  }
  await storageLocalSet({ __sc_yt_pending_desktop_patch: current });
}

async function queueYoutubePendingPatch(patch) {
  if (!patch || !Object.keys(patch).length) return;
  const raw = await storageLocalGet({ __sc_yt_pending_desktop_patch: {} });
  const current = raw.__sc_yt_pending_desktop_patch
    && typeof raw.__sc_yt_pending_desktop_patch === 'object'
    ? { ...raw.__sc_yt_pending_desktop_patch }
    : {};
  await storageLocalSet({ __sc_yt_pending_desktop_patch: { ...current, ...patch } });
}

async function persistYoutubeSettingsPatch(rawPatch) {
  const allowedPatch = {};
  for (const [key, value] of Object.entries(rawPatch || {})) {
    if (Object.prototype.hasOwnProperty.call(YOUTUBE_DEFAULT_SETTINGS, key)) allowedPatch[key] = value;
  }
  const current = await loadFreshYoutubeSettings();
  const next = sanitizeYoutubeSettings({ ...current, ...allowedPatch });
  const patch = diffYoutubeSettings(current, next);
  if (!Object.keys(patch).length) return { settings: next, online: true };
  await storageSyncSet({ __yt: next });
  await queueYoutubePendingPatch(patch);
  try {
    const saved = await fetchBridgeJson(YOUTUBE_SETTINGS_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patch }),
    });
    if (!saved?.settings) throw new Error('desktop returned no settings');
    const reconciliation = reconcileYoutubeSettingsPatch(next, patch, saved.settings);
    const canonical = reconciliation.settings;
    await storageSyncSet({ __yt: canonical });
    await clearSentYoutubePendingPatch(reconciliation.confirmedPatch);
    return { settings: canonical, online: true };
  } catch (error) {
    scBgDbg('youtube.settings.patch_queued', {
      keys: Object.keys(patch).sort(),
      err: error?.message || String(error),
    });
    return { settings: next, online: false, error: error?.message || String(error) };
  }
}

async function fetchBridgeJson(path, init = {}, timeoutMs = 1800) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(SC_BRIDGE + path, {
      ...init,
      headers: {
        'X-SC-Extension-Id': SC_EXTENSION_ID,
        ...(init.headers || {}),
      },
      signal: controller.signal,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(data?.error || ('HTTP ' + response.status));
      error.status = response.status;
      error.incompatible = response.status === 409 || data?.incompatible === true;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeChatgptMode(mode) {
  return mode === 'work' ? 'work' : 'chat';
}

// settings.json в desktop — canonical после bootstrap. На первом запуске
// initialized=false означает, что реальные старые настройки пока есть только
// в chrome.storage; сначала загружаем их в desktop, затем читаем canonical.
let youtubeSettingsRefreshPromise = null;
let youtubeSettingsPatchQueue = Promise.resolve();
async function loadFreshYoutubeSettings() {
  if (youtubeSettingsRefreshPromise) return youtubeSettingsRefreshPromise;
  youtubeSettingsRefreshPromise = loadFreshYoutubeSettingsOnce();
  try {
    return await youtubeSettingsRefreshPromise;
  } finally {
    youtubeSettingsRefreshPromise = null;
  }
}

async function loadFreshYoutubeSettingsOnce() {
  const localRaw = await storageSyncGet({ __yt: YOUTUBE_DEFAULT_SETTINGS });
  const pendingRaw = await storageLocalGet({ __sc_yt_pending_desktop_patch: {} });
  const pending = pendingRaw.__sc_yt_pending_desktop_patch
    && typeof pendingRaw.__sc_yt_pending_desktop_patch === 'object'
    ? pendingRaw.__sc_yt_pending_desktop_patch
    : {};
  const local = sanitizeYoutubeSettings({ ...(localRaw.__yt || {}), ...pending });
  let confirmedPending = pending;
  try {
    const remote = await fetchBridgeJson(YOUTUBE_SETTINGS_PATH);
    const schemaVersion = Number(remote?.schemaVersion);
    if (Number.isFinite(schemaVersion) && schemaVersion > YOUTUBE_SETTINGS_SCHEMA_VERSION) {
      const error = new Error(`YouTube settings schema ${schemaVersion} is newer than extension schema ${YOUTUBE_SETTINGS_SCHEMA_VERSION}`);
      error.incompatible = true;
      throw error;
    }
    let merged = local;
    if (remote?.initialized === false) {
      const bootstrap = { ...local };
      if (Array.isArray(remote.dirty_keys) && remote.settings && typeof remote.settings === 'object') {
        for (const key of remote.dirty_keys) {
          if (Object.prototype.hasOwnProperty.call(remote.settings, key)) bootstrap[key] = remote.settings[key];
        }
      }
      const boot = await fetchBridgeJson(YOUTUBE_SETTINGS_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patch: bootstrap }),
      });
      if (boot?.ok !== true || !boot.settings || typeof boot.settings !== 'object') {
        throw new Error('desktop returned no settings after YouTube bootstrap');
      }
      merged = sanitizeYoutubeSettings({ ...bootstrap, ...boot.settings });
    } else if (remote?.initialized === true && remote.settings && typeof remote.settings === 'object') {
      if (Object.keys(pending).length) {
        const saved = await fetchBridgeJson(YOUTUBE_SETTINGS_PATH, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ patch: pending }),
        });
        if (saved?.ok !== true || !saved.settings || typeof saved.settings !== 'object') {
          throw new Error('desktop returned no settings after YouTube patch');
        }
        const reconciliation = reconcileYoutubeSettingsPatch(
          local,
          pending,
          { ...remote.settings, ...saved.settings },
        );
        merged = reconciliation.settings;
        confirmedPending = reconciliation.confirmedPatch;
      } else {
        merged = sanitizeYoutubeSettings({ ...local, ...remote.settings });
      }
    }
    await storageSyncSet({ __yt: merged });
    await clearSentYoutubePendingPatch(confirmedPending);
    return merged;
  } catch (error) {
    scBgDbg('youtube.settings.fallback_local', { err: error?.message || String(error) });
    return local;
  }
}

function mergeYoutubeSettingsIntoJob(job, settings) {
  const y = sanitizeYoutubeSettings(settings || {});
  const mode = normalizeChatgptMode(y.chatgpt_mode);
  return {
    ...job,
    target: normalizeYoutubeAiTarget(y.target || job.target),
    engine: y.engine || job.engine || 'gemini',
    modelTitle: y.model_title || job.modelTitle,
    postModelTitle: y.post_model_title ?? job.postModelTitle,
    systemInstruction: y.system_instruction ?? job.systemInstruction,
    postSystemInstruction: y.post_system_instruction ?? job.postSystemInstruction,
    claudeModel: y.claude_model || job.claudeModel,
    claudeProject: y.claude_project ?? job.claudeProject,
    claudePostProject: y.claude_post_project ?? job.claudePostProject,
    claudeAdaptiveThinking: y.claude_adaptive_thinking !== false,
    chatgptPrompt: y.chatgpt_prompt ?? job.chatgptPrompt,
    chatgptShowInTextField: y.chatgpt_show_in_text_field !== false,
    chatgptMode: mode,
    chatgptModel: y[`chatgpt_${mode}_model`] || y.chatgpt_model || job.chatgptModel || '5.6-sol',
    chatgptEffort: y[`chatgpt_${mode}_effort`] || y.chatgpt_effort || job.chatgptEffort || 'xhigh',
    chatgptSpeed: mode === 'work' ? (y.chatgpt_work_speed || job.chatgptSpeed || 'standard') : null,
  };
}

async function refreshYoutubeJobSettings(job) {
  const settings = await loadFreshYoutubeSettings();
  return mergeYoutubeSettingsIntoJob(job, settings);
}

// Service worker сам является точкой bootstrap: desktop увидит исторические
// chrome.storage настройки без открытия popup и без первого YouTube-клика.
// Только settings I/O — вкладки и окна этот вызов не активирует.
loadFreshYoutubeSettings()
  .then(settings => scBgDbg('youtube.settings.startup_synced', {
    target: settings.target,
    chatgptMode: settings.chatgpt_mode,
  }))
  .catch(error => scBgDbg('youtube.settings.startup_failed', {
    err: error?.message || String(error),
  }));

// ── MCP visual mark (favicon + title prefix) ──────────────────────────
// Yandex.Browser не позволяет программно управлять tab groups (см. research:
// chrome.tabGroups не подключён, chrome.tabs.query.groupId всегда -1, нет
// proprietary API). Поэтому MCP-вкладки помечаются ВИЗУАЛЬНО:
//   1) Favicon заменяется на icon32.png расширения.
//   2) Document title получает префикс "🟢 ".
// SPA (Claude/AI Studio/Perplexity) пере-инжектит favicon и title при
// SPA-роутинге, и сами вкладки делают полный location.reload() через свой
// force-reload watchdog (см. fact-deep-research.md). Чтобы пометка пережила:
//   - MutationObserver в MAIN-world — отбивает изменения link/title в DOM.
//   - chrome.tabs.onUpdated listener в SW — на каждый status='complete' для
//     tabId из MCP_MARKED_TABS пере-инжектит guard'а заново.
//   - Сам список MCP_MARKED_TABS persistится в chrome.storage.local (Yandex'у
//     storage.session не доверять — см. fact-yt-extension-bridge.md).
// MCP_MARKED_KEY теперь = map {tabId → provider}: { "123": "gemini", "456": "claude" }.
// provider определяет title (Gemini parser / Claude parser / Perplexity parser).
const MCP_MARKED_KEY = '__sc_mcp_marked_tabs';

async function getMarkedTabsMap() {
  try {
    const got = await chrome.storage.local.get(MCP_MARKED_KEY);
    const v = got?.[MCP_MARKED_KEY];
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  } catch { return {}; }
}
async function addMarkedTab(tabId, provider) {
  const map = await getMarkedTabsMap();
  map[String(tabId)] = provider;
  await chrome.storage.local.set({ [MCP_MARKED_KEY]: map });
}
async function removeMarkedTab(tabId) {
  const map = await getMarkedTabsMap();
  if (delete map[String(tabId)]) {
    await chrome.storage.local.set({ [MCP_MARKED_KEY]: map });
  }
}

const PROVIDER_TITLES = {
  gemini: 'gemini-parser',
  claude: 'claude-parser',
  perplexity: 'perplexity-parser',
  chatgpt: 'chatgpt-parser',
  yandex: 'yandex-maps',
  avito: 'avito-parser',
  ozon: 'ozon-parser',
};

function providerFromUrl(url) {
  if (!url) return null;
  try {
    const h = new URL(url).hostname;
    if (h === 'aistudio.google.com') return 'gemini';
    if (h === 'claude.ai') return 'claude';
    if (h === 'www.perplexity.ai' || h === 'perplexity.ai') return 'perplexity';
    if (h === 'chatgpt.com' || h === 'www.chatgpt.com') return 'chatgpt';
    if (h === 'yandex.ru' || h.endsWith('.yandex.ru')) return 'yandex';
    if (h === 'avito.ru' || h === 'www.avito.ru') return 'avito';
    if (h === 'ozon.ru' || h === 'www.ozon.ru') return 'ozon';
  } catch {}
  return null;
}

async function injectMcpVisualGuard(tabId, provider) {
  const iconUrl = chrome.runtime.getURL('images/icon32.png');
  const titleText = PROVIDER_TITLES[provider] || 'MCP parser';
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      world: 'MAIN',
      func: (iconHref, fixedTitle) => {
        // Re-инжект ok'ит: если guard уже стоит — обновим иконку/title и выйдем.
        // (Это случай когда provider поменялся — теоретически не бывает, но
        // дёшево.)
        function applyIcon() {
          document.querySelectorAll('link[rel~="icon"], link[rel~="shortcut"]').forEach(l => {
            if (l.dataset.scMcpFavicon !== '1') l.remove();
          });
          let our = document.head.querySelector('link[data-sc-mcp-favicon="1"]');
          if (!our) {
            our = document.createElement('link');
            our.rel = 'icon';
            our.type = 'image/png';
            our.dataset.scMcpFavicon = '1';
            our.href = iconHref;
            document.head.appendChild(our);
          } else if (our.href !== iconHref) {
            our.href = iconHref;
          }
        }
        function applyTitle() {
          if (document.title !== fixedTitle) {
            document.title = fixedTitle;
          }
        }
        applyIcon();
        applyTitle();

        if (window.__scMcpVisualGuard) {
          // Обновили title/icon (см. выше) — выйдем чтобы не плодить MO.
          window.__scMcpFixedTitle = fixedTitle;
          window.__scMcpIconHref = iconHref;
          return;
        }
        window.__scMcpVisualGuard = true;
        window.__scMcpFixedTitle = fixedTitle;
        window.__scMcpIconHref = iconHref;

        // SPA дёргает head/title очень часто (на каждый route). Debounced MO.
        let pendingIcon = null;
        let pendingTitle = null;
        const headObs = new MutationObserver(() => {
          if (pendingIcon) return;
          pendingIcon = setTimeout(() => { pendingIcon = null; applyIcon(); }, 200);
        });
        headObs.observe(document.head, { childList: true, subtree: true, attributes: true, attributeFilter: ['href','rel'] });

        // <title> — отдельный обзёрвер: MO не ловит замену textContent на сам head.
        function watchTitle(el) {
          if (!el) return null;
          const o = new MutationObserver(() => {
            if (pendingTitle) return;
            pendingTitle = setTimeout(() => { pendingTitle = null; applyTitle(); }, 200);
          });
          o.observe(el, { childList: true, characterData: true, subtree: true });
          return o;
        }
        let titleObs = watchTitle(document.querySelector('title'));
        // Бывает <title> удаляется и пересоздаётся (Angular). Слушаем head для
        // повторной привязки.
        new MutationObserver((muts) => {
          for (const m of muts) {
            for (const node of m.addedNodes) {
              if (node.nodeName === 'TITLE') {
                try { titleObs?.disconnect(); } catch {}
                titleObs = watchTitle(node);
                applyTitle();
              }
            }
          }
        }).observe(document.head, { childList: true });
      },
      args: [iconUrl, titleText],
    });
  } catch (e) {
    // Возможно вкладка ещё не дозагрузилась — silent retry на след tab onUpdated.
  }
}

async function markTabAsMcpVisually(tabId, provider) {
  // Auto-detect провайдер из URL вкладки если явно не передан.
  if (!provider) {
    try {
      const t = await chrome.tabs.get(tabId);
      provider = providerFromUrl(t?.url) || 'gemini';
    } catch { provider = 'gemini'; }
  }
  await addMarkedTab(tabId, provider);
  await injectMcpVisualGuard(tabId, provider);
}

// При полном location.reload() (claude-research force-reload, F5, redirect)
// MAIN-world скрипт умирает с страницей. Слушаем onUpdated:
//   - status='loading' с URL'ом (свежий navigation) → инжектим РАНО
//   - status='complete' → re-инжектим (страховка если loading инжект промазал)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  // Реагируем как на loading c новым URL, так и на complete.
  const trigger = (changeInfo.status === 'loading' && changeInfo.url) || changeInfo.status === 'complete';
  if (!trigger) return;
  const map = await getMarkedTabsMap();
  const provider = map[String(tabId)];
  if (!provider) return;
  // На loading может ещё не быть head — даём 150мс на initial parse.
  setTimeout(() => {
    injectMcpVisualGuard(tabId, provider).catch(() => {});
  }, changeInfo.status === 'loading' ? 150 : 0);
});

// При закрытии вкладки — снимаем из persistent list'а.
chrome.tabs.onRemoved.addListener((tabId) => {
  removeMarkedTab(tabId).catch(() => {});
});

let port = null;
let queue = [];
let lastConnectError = null;

function connect() {
  if (port) return port;
  try {
    port = chrome.runtime.connectNative(NMH_NAME);
    console.log('[AISE-BG] connectNative OK', NMH_NAME);
    lastConnectError = null;

    port.onMessage.addListener((msg) => {
      console.log('[AISE-BG] host->ext', msg);
    });

    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      lastConnectError = err ? err.message : 'unknown disconnect';
      console.warn('[AISE-BG] native port disconnected:', lastConnectError);
      port = null;
    });

    if (queue.length) {
      console.log('[AISE-BG] draining queued', queue.length);
      const drain = queue.splice(0);
      for (const m of drain) {
        try { port.postMessage(m); } catch (e) {
          console.warn('[AISE-BG] drain post failed', e?.message);
          queue.unshift(m);
          break;
        }
      }
    }
    return port;
  } catch (e) {
    lastConnectError = e?.message || String(e);
    console.warn('[AISE-BG] connectNative threw:', lastConnectError);
    port = null;
    return null;
  }
}

function sendToHost(evt) {
  // Mirror to chrome.storage.local (last 500 events) — fallback if NMH not installed.
  try {
    chrome.storage.local.get({ __aise_buffer: [] }, (res) => {
      const buf = res.__aise_buffer || [];
      buf.push(evt);
      if (buf.length > 500) buf.splice(0, buf.length - 500);
      chrome.storage.local.set({ __aise_buffer: buf });
    });
  } catch (_) {}

  const p = port || connect();
  if (!p) {
    queue.push(evt);
    if (queue.length > 1000) queue.splice(0, queue.length - 1000);
    return;
  }
  try {
    p.postMessage(evt);
  } catch (e) {
    console.warn('[AISE-BG] postMessage failed, requeue:', e?.message);
    queue.push(evt);
    port = null;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('[AISE-BG] installed');
  connect();
});

connect();

// Main-world click для claude.ai — content-script просит SW выполнить
// .click() на selector в MAIN world через chrome.scripting.executeScript.
// Это обходит CSP claude.ai которая блокирует inline <script>.
// Селектор временно ставит data-sc-mw-click="<id>" на элемент, SW
// querySelector'ит и кликает. Возвращает {ok:true} либо {error}.
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req && req.__sc_main_click === true && req.markId && sender?.tab?.id != null) {
    const tabId = sender.tab.id;
    // singleClickMode: для AI Studio (Angular Material) делаем ТОЛЬКО
    // pointer-chain без дополнительного .click() в конце. На radix-ui
    // (claude.ai) ничего не меняем — там двойной click был безвредным
    // (radix-ui дебаунсит). Angular Material же принимает оба → двойной
    // submit → два параллельных stream'а в один ms-text-chunk
    // → дублированный/перемешанный текст (см. fact-aistudio-mcp.md::Double-click race).
    const singleClickMode = !!req.singleClick;
    chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      world: 'MAIN',
      func: (markId, singleClick) => {
        const el = document.querySelector('[data-sc-mw-click="' + markId + '"]');
        if (!el) return { ok: false, err: 'not found' };
        try {
          // Pointer-chain вместо голого .click() — radix-ui компоненты
          // (Confirm dialog в claude.ai Connectors-flow) слушают
          // pointerdown/pointerup, .click() они тихо игнорируют.
          const r = el.getBoundingClientRect();
          const x = r.x + r.width / 2;
          const y = r.y + r.height / 2;
          const eventOpts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0, pointerType: 'mouse' };
          el.dispatchEvent(new PointerEvent('pointerdown', eventOpts));
          el.dispatchEvent(new MouseEvent('mousedown', eventOpts));
          el.dispatchEvent(new PointerEvent('pointerup', eventOpts));
          el.dispatchEvent(new MouseEvent('mouseup', eventOpts));
          el.dispatchEvent(new MouseEvent('click', eventOpts));
          if (!singleClick) {
            // legacy claude.ai path — двойной клик безвреден на radix-ui.
            try { el.click(); } catch (_) {}
          }
        } catch (e) {
          return { ok: false, err: e?.message || String(e) };
        }
        el.removeAttribute('data-sc-mw-click');
        return { ok: true, singleClick };
      },
      args: [req.markId, singleClickMode],
    }).then(results => {
      sendResponse(results?.[0]?.result || { ok: false, err: 'no result' });
    }).catch(e => {
      sendResponse({ ok: false, err: e?.message || String(e) });
    });
    return true; // async
  }

  // Trusted MOUSE-click через chrome.debugger.dispatchMouseEvent по
  // viewport-координатам. Эмулирует ОС-уровневый клик (isTrusted=true),
  // Angular Material принимает. Используется для close-button paid-key
  // dialog'а, где synthetic events отбрасываются.
  // Caller передаёт {x, y} в CSS px относительно viewport.
  if (req && req.__sc_trusted_click === true && sender?.tab?.id != null && typeof req.x === 'number' && typeof req.y === 'number') {
    const tabId = sender.tab.id;
    const { x, y } = req;
    (async () => {
      try {
        let needDetach = false;
        try {
          await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: '1' });
        } catch {
          await chrome.debugger.attach({ tabId }, '1.3');
          needDetach = true;
        }
        // Mouse pressed + released — это полная цепочка trusted click.
        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
          type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1,
        });
        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0,
        });
        if (needDetach) {
          try { await chrome.debugger.detach({ tabId }); } catch {}
        }
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, err: e?.message || String(e) });
      }
    })();
    return true; // async
  }

  // Настоящий mouseMoved нужен для CSS :hover. Синтетические mouseover /
  // mousemove из content-script вызывают JS-listeners, но не раскрывают
  // hover-only controls вроде ChatGPT «Показать в текстовом поле».
  if (req && req.__sc_trusted_hover === true && sender?.tab?.id != null && typeof req.x === 'number' && typeof req.y === 'number') {
    const tabId = sender.tab.id;
    const { x, y } = req;
    (async () => {
      try {
        let needDetach = false;
        try {
          await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: '1' });
        } catch {
          await chrome.debugger.attach({ tabId }, '1.3');
          needDetach = true;
        }
        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved', x, y, button: 'none', buttons: 0,
        });
        if (needDetach) {
          try { await chrome.debugger.detach({ tabId }); } catch {}
        }
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, err: e?.message || String(e) });
      }
    })();
    return true; // async
  }

  // __sc_usergesture_click: кликнуть элемент по selector ВНУТРИ
  // Runtime.evaluate{userGesture:true}. Это синтезирует transient user-activation
  // ДАЖЕ в hidden/inactive вкладке (в отличие от Input.dispatchMouseEvent, который
  // требует active-таб — CDP issue #89). AI Studio submit требует activation;
  // этот путь даёт её БЕЗ вывода окна на передний план. Доказано: vis:hidden →
  // ua:true, submit без internal-error. Используется trustedClick в aistudio-core.
  // selector помечается caller'ом (data-sc-ug-click) и обычно уникален.
  if (req && req.__sc_usergesture_click === true && sender?.tab?.id != null) {
    const tabId = sender.tab.id;
    const sel = req.selector;
    const pickLast = !!req.pickLast;
    (async () => {
      try {
        let needDetach = false;
        try { await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: '1' }); }
        catch { await chrome.debugger.attach({ tabId }, '1.3'); needDetach = true; }
        const expr = `(function(){
          var els = Array.from(document.querySelectorAll(${JSON.stringify(sel)})).filter(function(b){return b.offsetParent;});
          var el = ${pickLast ? 'els[els.length-1]' : 'els[0]'};
          if(!el) return {clicked:false, reason:'not found', count:els.length};
          el.click();
          return {clicked:true, ua: navigator.userActivation.isActive, txt:(el.textContent||'').slice(0,30)};
        })()`;
        const r = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
          expression: expr, userGesture: true, awaitPromise: true, returnByValue: true,
        });
        if (needDetach) { try { await chrome.debugger.detach({ tabId }); } catch {} }
        sendResponse({ ok: true, result: r?.result?.value, exception: r?.exceptionDetails?.text });
      } catch (e) { sendResponse({ ok: false, err: e?.message || String(e) }); }
    })();
    return true;
  }

  // MAIN-world visibility override — для AI Studio hidden tab.
  // Studio в hidden-вкладке НЕ рендерит ms-text-chunk (внутренняя
  // optimization Angular state-machine). ISO-world override
  // document.visibilityState не помогает потому что Angular живёт в MAIN.
  //
  // Persistent override: устанавливаем defineProperty + регистрируем
  // setInterval 200ms который ре-применяет если Chrome/Studio переопределил
  // обратно. Также монкипатчим document.addEventListener чтобы перехватывать
  // подписки на 'visibilitychange' и заглушать их (Studio не получает
  // событий о смене на hidden). Запоминаем что override уже стоит в
  // window.__sc_vis_overridden — повторный вызов не дублирует interval.
  if (req && req.__sc_main_visibility_override === true && sender?.tab?.id != null) {
    const tabId = sender.tab.id;
    chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      world: 'MAIN',
      func: () => {
        try {
          if (!window.__sc_vis_overridden) {
            window.__sc_vis_overridden = true;
            const apply = () => {
              try {
                Object.defineProperty(document, 'visibilityState', {
                  configurable: true, get: () => 'visible'
                });
                Object.defineProperty(document, 'hidden', {
                  configurable: true, get: () => false
                });
              } catch {}
            };
            apply();
            // Persistent: defineProperty может быть переопределён
            // другим скриптом или native code. Ре-применяем каждые 200мс.
            // setInterval в hidden-tab background-throttled до ~1s, но
            // это всё равно поддерживает override в активном состоянии.
            window.__sc_vis_iv = setInterval(apply, 200);

            // Заглушаем visibilitychange events от Chrome: Studio
            // подписан на visibilitychange чтобы knowing когда вкладка
            // hidden. Перехватываем addEventListener чтобы фильтровать.
            const origAdd = EventTarget.prototype.addEventListener;
            EventTarget.prototype.addEventListener = function(type, listener, options) {
              if (this === document && type === 'visibilitychange') {
                // Сохраняем listener в weakset для anti-throttling, но
                // НЕ регистрируем на реальный visibilitychange — Studio
                // никогда не услышит "hidden".
                return;
              }
              return origAdd.call(this, type, listener, options);
            };
          }
          // Дополнительно: сразу dispatch synthetic visibilitychange,
          // чтобы Studio "увидел" что мы стали visible (если override
          // встал ПОСЛЕ того как Studio проверил initial state).
          // Но из-за фильтра выше — listener'ов нет, событие никуда не дойдёт.
          // Поэтому отправим напрямую: ищем Studio Angular zone'ы и
          // делаем стандартный dispatch — base browser event-loop его
          // увидит, наш фильтр пропустит т.к. это origAdd-обёртка не
          // влияет на existing подписки.
          document.dispatchEvent(new Event('visibilitychange'));
          return { ok: true, visState: document.visibilityState, hidden: document.hidden, persistent: !!window.__sc_vis_iv };
        } catch (e) {
          return { ok: false, err: e?.message || String(e) };
        }
      },
    }).then(results => {
      sendResponse(results?.[0]?.result || { ok: false, err: 'no result' });
    }).catch(e => {
      sendResponse({ ok: false, err: e?.message || String(e) });
    });
    return true; // async
  }

  return undefined; // другие handlers ниже
});

// NB: Early visibility-override через webNavigation.onCommitted отключён.
// Эмпирически проверено — Studio либо не отправляет запрос в hidden tab,
// либо не рендерит результат, и monkey-patch + setInterval не помогают.
// Архитектурное решение лежит вне visibility-обмана (см.
// fact-aistudio-mcp.md::Hidden-tab strategy). Код снят чтобы не плодить
// setInterval на каждой sc-mcp-job вкладке.

// ─── chrome.debugger + Emulation.setFocusEmulationEnabled ────────────
// ДЕТЕРМИНИСТИЧЕСКОЕ решение для hidden-tab rendering AI Studio.
//
// Root cause: AI Studio = Angular + ngZoneRunCoalescing:true. NgZone
// coalesce'ит change detection через requestAnimationFrame. Blink pauses
// rAF в hidden tab → Angular CD не fires → <ms-text-chunk> не рендерится
// (response от backend пришёл, DOM-узлы созданы Angular structural-
// директивой через microtask, но template binding ждёт CD cycle inside
// rAF). Никакой `Object.defineProperty(document, 'visibilityState')`
// не помогает: Blink читает не JS-getter а C++ Page::IsPageVisible()
// для rAF scheduler.
//
// Решение: chrome.debugger.attach + Emulation.setFocusEmulationEnabled.
// Это то же что DevTools' "Emulate a focused page" rendering option.
// Меняет Page::IsPageVisible() → true → rAF тикает на 60Hz → Angular
// CD идёт нормально. Также:
//   - document.visibilityState → "visible"
//   - visibilitychange event никогда не fires
//   - setTimeout/setInterval не throttled
//   - SW alive пока debugger attached (Chrome docs Q4 2025+)
//
// UX cost: yellow banner "Расширение начало отладку этого браузера".
// Прячется флагом --silent-debugger-extension-api (power users) или
// ExtensionInstallForceList policy (enterprise). Для desktop-app
// сценария принимаем как есть.
//
// Альтернативы не работают:
//   - chrome.offscreen: visibilityState всегда hidden + rAF не fires
//   - chrome.windows.create({state:'minimized'}): broken в MV3
//   - Page.setWebLifecycleState({state:'active'}): только frozen-bit
//   - chrome.tabCapture: fallback с red-dot indicator
//
// См. fact-aistudio-mcp.md::chrome.debugger strategy для деталей.
const SC_DEBUGGER_ATTACHED = new Set(); // tabId'ы где attach уже сделан

// Какие вкладки держим под focus-emulation (attach при открытии + авто-reattach
// в onDetach/watchdog). НЕ только aistudio: research-вкладки (chatgpt/claude/
// perplexity, включая быстрый Поиск) страдают от того же render-freeze — при
// длительно-деактивированном браузере Chromium глушит rAF и душит таймеры до
// ~12-30с/tick, MutationObserver-watcher слепнет (живой кейс rm6equid: 48 тиков
// за 577с без смены сигнатуры, done только от ручного клика юзера по вкладке).
const SC_FOCUS_EMULATION_URL = /aistudio\.google\.com|chatgpt\.com|claude\.ai|perplexity\.ai/;

// NET-TAP флаг отладки. true → на attach включаем Network domain и шлём в
// bridge каждый интересный backend-запрос AI Studio. Отладка дала результат:
//   • Pro/Flash  → GenerateContent (одна фаза, промпт в запросе)
//   • Antigravity → CreateInteraction + CreatePrompt (Interactions API, 2 фазы)
//   • DeepResearch → CreateInteraction + GetInteractionStream + CreatePrompt (тот же класс)
// Держим выключенным (Network.enable не бесплатен для CPU); флаг оставлен для
// будущей отладки. См. fact-aistudio-mcp.md::Два класса моделей.
const SC_NETTAP_ENABLED = false;
// Один глобальный listener на debugger-события (Network.*). Регистрируется
// один раз. Фильтрует запросы к AI Studio backend (GenerateContent / agent /
// runtime) и логирует url+статус+method в bridge через /research-log.
let __scNetTapInstalled = false;
const __scNetReq = new Map(); // requestId → {url, method, ts}
function installNetTapListener() {
  if (__scNetTapInstalled) return;
  __scNetTapInstalled = true;
  // Узкий фильтр на endpoint'ы которые НЕСУТ промпт/создают интеракцию —
  // отвечает на вопрос «первый Run уходит пустым?». Маркер ищем в теле.
  const INTERESTING = /GenerateContent|CreateInteraction|CreatePrompt|GetInteractionStream|CreateInteractionStream/i;
  const netLog = (tag, data) => {
    try {
      fetch('http://127.0.0.1:53127/research-log', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tabId: data.tabId ?? null, tag: 'nettap.' + tag, data }),
      }).catch(() => {});
    } catch {}
  };
  // Маркер промпта — задаётся снаружи через __scNetTapPromptMarker (CS ставит
  // уникальную строку в начало промпта). Если маркер есть в body → запрос НЕСЁТ
  // промпт; если нет → пустой/служебный submit.
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (!SC_NETTAP_ENABLED) return;
    const tabId = source?.tabId;
    if (tabId == null || !SC_DEBUGGER_ATTACHED.has(tabId)) return;
    try {
      if (method === 'Network.requestWillBeSent') {
        const url = params?.request?.url || '';
        if (!INTERESTING.test(url)) return;
        const ep = (url.match(/MakerSuiteService\/(\w+)/) || [])[1] || (url.match(/\/(\w+Interaction\w*|GenerateContent|CreatePrompt)/) || [])[1] || 'other';
        __scNetReq.set(params.requestId, { url, ep, method: params?.request?.method, ts: Date.now() });
        const fullPost = params?.request?.postData || '';
        const marker = globalThis.__scNetTapPromptMarker || 'NETMARK';
        netLog('req', {
          tabId, ep, m: params?.request?.method,
          postLen: fullPost.length,
          hasPromptMarker: fullPost.includes(marker),
          postHead: fullPost.slice(0, 200),
        });
      } else if (method === 'Network.responseReceived') {
        const r = __scNetReq.get(params.requestId);
        if (!r) return;
        netLog('resp', { tabId, ep: r.ep, status: params?.response?.status, ms: Date.now() - r.ts });
      } else if (method === 'Network.loadingFailed') {
        const r = __scNetReq.get(params.requestId);
        if (!r) return;
        netLog('fail', { tabId, ep: r.ep, err: params?.errorText });
        __scNetReq.delete(params.requestId);
      }
    } catch {}
  });
  scBgDbg('nettap.listener_installed', {});
}
if (SC_NETTAP_ENABLED) { try { installNetTapListener(); } catch {} }

async function attachFocusEmulation(tabId) {
  if (SC_DEBUGGER_ATTACHED.has(tabId)) {
    scBgDbg('debugger.skip.already_attached', { tabId });
    return { ok: true, alreadyAttached: true };
  }
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    SC_DEBUGGER_ATTACHED.add(tabId);
    scBgDbg('debugger.attach.ok', { tabId });
    // Главная команда: setFocusEmulationEnabled. Page::IsPageVisible()
    // → true для этой Page, rAF unthrottled, document.visibilityState
    // навсегда "visible" пока debugger attached.
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true });
    scBgDbg('debugger.setFocusEmulation.ok', { tabId });
    // Belt-and-braces: ensure не frozen. Не влияет на visibility но
    // защищает от лёгкого SP-throttling если Chrome решит freeze tab.
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Page.setWebLifecycleState', { state: 'active' });
    } catch (_) { /* not critical */ }
    // NET-TAP (отладка paid-key): включаем Network domain на ТОЙ ЖЕ debugger-
    // сессии. Логируем backend-запросы AI Studio (GenerateContent/agent) —
    // url, статус, наличие auth-ответа. Это показывает ДЕТЕРМИНИРОВАННО:
    // окно ключа — это клиентский гейт ДО запроса или реакция на ответ
    // сервера. Включается только если SC_NETTAP_ENABLED (флаг ниже).
    if (SC_NETTAP_ENABLED) {
      try {
        await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {});
        scBgDbg('debugger.network.enabled', { tabId });
      } catch (e) { scBgDbg('debugger.network.enable_fail', { tabId, err: e?.message }); }
    }
    // Persistent log в bridge — чтобы после job-end видеть в production.log.
    try {
      await fetch('http://127.0.0.1:53127/research-log', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tabId, tag: 'aistudio.debugger.attached', data: { tabId } }),
      });
    } catch {}
    return { ok: true };
  } catch (e) {
    const msg = e?.message || String(e);
    scBgDbg('debugger.attach.FAIL', { tabId, err: msg });
    return { ok: false, err: msg };
  }
}

async function detachFocusEmulation(tabId) {
  if (!SC_DEBUGGER_ATTACHED.has(tabId)) {
    return { ok: true, skipped: 'not_attached' };
  }
  try {
    // Сначала disable emulation — корректнее. Если detach падает,
    // не оставляем "висящий" focus override.
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: false });
    } catch {}
    await chrome.debugger.detach({ tabId });
    SC_DEBUGGER_ATTACHED.delete(tabId);
    scBgDbg('debugger.detach.ok', { tabId });
    try {
      await fetch('http://127.0.0.1:53127/research-log', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tabId, tag: 'aistudio.debugger.detached', data: { tabId } }),
      });
    } catch {}
    return { ok: true };
  } catch (e) {
    const msg = e?.message || String(e);
    scBgDbg('debugger.detach.FAIL', { tabId, err: msg });
    // Если detach упал — всё равно убрать из set (вкладка могла быть закрыта).
    SC_DEBUGGER_ATTACHED.delete(tabId);
    return { ok: false, err: msg };
  }
}

// onDetach: юзер мог закрыть DevTools банер вручную ("Cancel" клик), либо
// вкладка была закрыта/discarded, ЛИБО Chrome сам auto-detach при некоторых
// nav-event'ах. Последний случай — реальный bug: AI Studio делает SPA-nav
// new_chat → /prompts/<chatId> в первые секунды после Run, и Chrome может
// решить что debugger session «протух» и снять её. Реакция: re-attach
// сразу, чтобы rAF продолжил тикать.
chrome.debugger.onDetach.addListener(async (source, reason) => {
  if (source?.tabId == null) return;
  const tabId = source.tabId;
  const wasTracked = SC_DEBUGGER_ATTACHED.has(tabId);
  if (wasTracked) {
    SC_DEBUGGER_ATTACHED.delete(tabId);
  }
  scBgDbg('debugger.onDetach', { tabId, reason, wasTracked });
  // Persistent log для post-mortem — без bridge видимости проблему не словить.
  try {
    await fetch('http://127.0.0.1:53127/research-log', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tabId, tag: 'aistudio.debugger.auto_detached', data: { reason, wasTracked } }),
    });
  } catch {}
  // Re-attach пытаемся всегда, кроме случая когда tab уже закрыт.
  // Замечание про reason='canceled_by_user': это НЕ означает что юзер
  // нажал Cancel — Chrome шлёт этот reason и при system-driven cancel:
  // когда новая debugger session attach'ится в той же window, старые
  // получают auto-detach с тем же reason. Поэтому игнорировать reason
  // нельзя — иначе все паралл-job'ы теряют debugger и parseLastTurn
  // ловит demount-DOM с пустыми ms-text-chunk.
  if (wasTracked) {
    // Проверим что вкладка ещё жива на одном из emulation-доменов.
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab && tab.url && SC_FOCUS_EMULATION_URL.test(tab.url)) {
        scBgDbg('debugger.reattach.attempt', { tabId, url: tab.url.slice(0, 100) });
        // Краткая пауза чтобы navigation settle'нулся.
        await new Promise(r => setTimeout(r, 500));
        const r = await attachFocusEmulation(tabId);
        if (!r?.ok) {
          scBgDbg('debugger.reattach.FAIL', { tabId, err: r?.err });
        }
      }
    } catch (e) {
      scBgDbg('debugger.reattach.tab_get_FAIL', { tabId, err: e?.message });
    }
  }
});

// Cleanup при закрытии вкладки — onRemoved fires до того как detach
// автоматически произошёл; снимаем из set чтобы re-attach был возможен
// если юзер откроет новую aistudio в этой же tabId (редкий случай).
chrome.tabs.onRemoved.addListener((tabId) => {
  if (typeof scForgetResearchTabByTabId === 'function') {
    scForgetResearchTabByTabId(chrome, tabId).catch(() => {});
  }
  if (SC_DEBUGGER_ATTACHED.has(tabId)) {
    SC_DEBUGGER_ATTACHED.delete(tabId);
    scBgDbg('debugger.tab_removed', { tabId });
  }
});

// Bridge commands poll: sc-desktop UI кладёт команды (focus_tab/close_tab)
// в queue, мы их выполняем. Polling каждые 2с через chrome.alarms (не
// throttled в hidden state). Альтернатива — websocket, но overkill для
// редких UI-команд.
const SC_BRIDGE_POLL = 'sc-bridge-poll'
chrome.alarms.create(SC_BRIDGE_POLL, { periodInMinutes: 0.05 }) // 3 сек
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== SC_BRIDGE_POLL) return
  try {
    const r = await fetch('http://127.0.0.1:53127/bridge-commands')
    if (!r.ok) return
    const { items } = await r.json()
    if (!Array.isArray(items) || items.length === 0) return
    for (const it of items) {
      try {
        if (it.cmd === 'focus_tab' && it.tabId != null) {
          await chrome.tabs.update(it.tabId, { active: true })
          const tab = await chrome.tabs.get(it.tabId)
          if (tab?.windowId != null) {
            try { await chrome.windows.update(tab.windowId, { focused: true }) } catch {}
          }
          scBgDbg('bridge_cmd.focus_tab', { tabId: it.tabId })
        } else if (it.cmd === 'close_tab' && it.tabId != null) {
          await chrome.tabs.remove(it.tabId)
          scBgDbg('bridge_cmd.close_tab', { tabId: it.tabId })
        } else if (it.cmd === 'open_url' && it.url) {
          // Найти существующую вкладку с этим url (research-чат) и сфокусировать,
          // иначе открыть новую. tabId research-джоба ненадёжен (меняется при
          // reload), url стабилен.
          const existing = await chrome.tabs.query({ url: it.url.split('#')[0] + '*' })
          if (existing && existing[0]) {
            await chrome.tabs.update(existing[0].id, { active: true })
            try { await chrome.windows.update(existing[0].windowId, { focused: true }) } catch {}
            scBgDbg('bridge_cmd.open_url.focused', { tabId: existing[0].id })
          } else {
            const t = await chrome.tabs.create({ url: it.url, active: true })
            scBgDbg('bridge_cmd.open_url.created', { tabId: t.id })
          }
        } else if (it.cmd === 'reload_extension') {
          // Force-reload по запросу из sc-desktop / Claude — обходим
          // hot-reload polling (grace+cooldown) и применяем свежий код сразу.
          scBgDbg('bridge_cmd.reload_extension', { ts: it.ts })
          setTimeout(() => { try { chrome.runtime.reload() } catch {} }, 100)
        } else if (it.cmd === 'boosty_auth' && it.requestId) {
          // Short-lived authenticated handoff for the desktop Boosty worker.
          // The value is posted straight to Electron and never logged or put
          // in chrome.storage. `cookies` + <all_urls> are already in manifest.
          let auth = null
          let error = null
          try {
            const cookies = await chrome.cookies.getAll({ domain: 'boosty.to', name: 'auth' })
            const cookie = (cookies || []).sort((a, b) =>
              Number(b.expirationDate || 0) - Number(a.expirationDate || 0)
            )[0]
            if (cookie?.value) {
              auth = { value: cookie.value, expirationDate: cookie.expirationDate || null }
            } else {
              error = 'В браузере нет cookie авторизации Boosty'
            }
          } catch (e) {
            error = e?.message || String(e)
          }
          const response = await fetch('http://127.0.0.1:53127/boosty-auth-state', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-SC-Extension-Id': chrome.runtime.id,
            },
            body: JSON.stringify({ requestId: it.requestId, auth, error }),
          })
          scBgDbg('bridge_cmd.boosty_auth', {
            ok: response.ok && !!auth,
            status: response.status,
            requestId: String(it.requestId).slice(0, 8),
          })
        }
      } catch (e) {
        scBgDbg('bridge_cmd.fail', { cmd: it.cmd, tabId: it.tabId, err: e?.message })
      }
    }
  } catch (_) { /* bridge down */ }
})

// Watchdog для debugger session'ов: на длинных DR job'ах AI Studio может
// сделать SPA-nav (new_chat → /prompts/<chatId>), что иногда триггерит
// silent auto-detach (onDetach вызывается, мы пытаемся re-attach, но к
// этому моменту Angular уже мог провалиться в "I'll wait for rAF" state).
//
// Решение: каждые 15с проверяем что для каждого tracked tab'а sendCommand
// проходит. Если падает с "is not attached" — пробуем re-attach (но
// чаще onDetach уже его сделал, set пуст). Главное — ловим случай когда
// onDetach почему-то не fires, а session при этом мертва.
const SC_DEBUGGER_WATCHDOG = 'sc-debugger-watchdog';
chrome.alarms.create(SC_DEBUGGER_WATCHDOG, { periodInMinutes: 0.25 }); // 15 сек
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== SC_DEBUGGER_WATCHDOG) return;
  if (SC_DEBUGGER_ATTACHED.size === 0) return;
  const tabs = [...SC_DEBUGGER_ATTACHED];
  for (const tabId of tabs) {
    try {
      // Дешёвая sendCommand: Runtime.evaluate с '1' — если session жива,
      // ответ <16мс. Если session порвалась, Chrome вернёт error.
      const r = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: 'document.visibilityState',
        returnByValue: true,
      });
      const vis = r?.result?.value;
      // Если visibilityState === 'hidden' — emulation slipped, re-apply.
      // НЕ детач'имся, а просто заново посылаем команду.
      if (vis === 'hidden') {
        scBgDbg('debugger.watchdog.vis_hidden_reapply', { tabId });
        try {
          await chrome.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true });
        } catch {}
      }
    } catch (e) {
      const msg = e?.message || String(e);
      scBgDbg('debugger.watchdog.session_dead', { tabId, err: msg });
      // Session порвана — onDetach мог не сработать. Чистим + reattach.
      SC_DEBUGGER_ATTACHED.delete(tabId);
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab?.url && SC_FOCUS_EMULATION_URL.test(tab.url)) {
          await attachFocusEmulation(tabId);
        }
      } catch {}
    }
  }
});

// Handler для CS / mcp-handlers — attach/detach по запросу. Идемпотентно:
// повторный attach на тот же tabId — no-op (вернёт {alreadyAttached:true}).
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req && req.__sc_debugger_attach === true) {
    const tabId = req.tabId ?? sender?.tab?.id;
    if (tabId == null) {
      sendResponse({ ok: false, err: 'no tabId' });
      return false;
    }
    attachFocusEmulation(tabId).then(sendResponse);
    return true; // async
  }
  if (req && req.__sc_debugger_detach === true) {
    const tabId = req.tabId ?? sender?.tab?.id;
    if (tabId == null) {
      sendResponse({ ok: false, err: 'no tabId' });
      return false;
    }
    detachFocusEmulation(tabId).then(sendResponse);
    return true; // async
  }
  return undefined;
});

// Long-lived port для anti-throttling в research content-script'ах +
// SW-driven watchdog через chrome.alarms.
//
// Проблема (детерминированно из dbg-log claude.ai, май 2026):
// Когда research завершился на backend, DOM перестаёт меняться,
// MutationObserver больше не вызывает watcher.tick. `setInterval(500ms)`
// в content-script'е в hidden-вкладке throttled до ~1.5с/tick (обычное
// background throttling). Watcher ждёт quiet >= 3000мс после исчезновения
// Stop, но с throttled-интервалом 2 тика занимают 3 сек — формально хватает,
// НО реально hand-off "DOM перестал меняться" → "interval тикнул" может
// гэпать на 5-60с пока юзер не переключится.
//
// Решение через SW-watchdog. chrome.alarms — privilege-API, **не throttled**.
// Минимум 30с интервал в production. На каждый tick alarm'а отправляем
// `chrome.tabs.sendMessage(tabId, {__sc_research_poke})` всем зарегистрированным
// research-вкладкам. CS на message делает форсированный wrappedTick().
// message-event прокидывается через SW даже в frozen tab, что даёт CS
// доли секунды на обработку — этого хватает чтобы оценить состояние DOM
// и emit terminal-state.
//
// hh-tool docs::fact-extension-runtime.md::v0.8.5 рассказывает что
// document PiP / silent audio / tabs.update(active:true) — НЕ работают.
// chrome.alarms — единственный надёжный способ tick'нуть hidden tab.
const RESEARCH_TABS = new Set();
const RESEARCH_ALARM = 'sc-research-watchdog';
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'sc-research-keepalive') return;
  const tabId = port.sender?.tab?.id;
  if (tabId != null) {
    RESEARCH_TABS.add(tabId);
    // Регистрируем alarm если его ещё нет. periodInMinutes = 0.5 (30с).
    chrome.alarms.get(RESEARCH_ALARM, (existing) => {
      if (!existing) {
        chrome.alarms.create(RESEARCH_ALARM, { periodInMinutes: 0.5 });
        console.log('[scBgDbg][research-watchdog] alarm created tabId=' + tabId);
      } else {
        console.log('[scBgDbg][research-watchdog] alarm reused tabId=' + tabId + ' tabs=' + RESEARCH_TABS.size);
      }
    });
  }
  port.onDisconnect.addListener(() => {
    if (tabId != null) {
      RESEARCH_TABS.delete(tabId);
      console.log('[scBgDbg][research-watchdog] tab unregistered tabId=' + tabId + ' remaining=' + RESEARCH_TABS.size);
      // Если research-вкладок больше нет — снимаем alarm чтоб не тикать впустую.
      if (RESEARCH_TABS.size === 0) {
        chrome.alarms.clear(RESEARCH_ALARM);
        console.log('[scBgDbg][research-watchdog] alarm cleared (no tabs)');
      }
    }
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== RESEARCH_ALARM) return;
  if (RESEARCH_TABS.size === 0) {
    chrome.alarms.clear(RESEARCH_ALARM);
    return;
  }
  for (const tabId of RESEARCH_TABS) {
    chrome.tabs.sendMessage(tabId, { __sc_research_poke: true, ts: Date.now() }, () => {
      // chrome.runtime.lastError — норма если вкладка discarded.
      // Не логируем чтоб не спамить, но если вкладка реально умерла —
      // её disconnect listener уже снял её из RESEARCH_TABS.
      void chrome.runtime.lastError;
    });
  }
});

// ─── Tab lifecycle logging для research-вкладок ──────────────────────
// Когда CS замолчал на N минут, мы должны иметь возможность сверить:
// — discarded ли Chrome'ом вкладку?
// — replaced ли её (crash-restore)?
// — закрыта ли (onRemoved)?
// — был ли реальный reload (onUpdated с status='loading')?
// Эти события не доступны CS'у — только SW. Шлём в bridge log чтобы
// они переживали закрытие tab'а.
async function postLifecycleLog(tag, tabId, data) {
  try {
    await fetch('http://127.0.0.1:53127/research-log', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tabId, tag, data }),
    });
  } catch (_) { /* bridge не запущен */ }
}

// CS-relay для persistent log'а + zerkalo aistudio jobs в bridge.
// CS не может сделать fetch на 127.0.0.1:53127 (CORS / PNA блокирует
// из page-origin'а aistudio.google.com). SW делает fetch как extension
// origin, что прокатывает.
//
// Двойная цель:
//   1. fetch /research-log — persistent log в production.log для post-mortem
//   2. fetch /aistudio-state — патч in-memory mirror'а в bridge'е, который
//      renderer sc-desktop читает через GET /aistudio-jobs для UI MCP-bar'а
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req && req.__sc_log === true) {
    const tabId = sender?.tab?.id ?? req.tabId ?? '-';
    const id = req.id || '-';
    const tag = req.tag || 'unknown';
    const url = req.url || sender?.tab?.url || '';
    const data = req.data;
    // fire-and-forget — не блокируем CS на сетевой ошибке.
    fetch('http://127.0.0.1:53127/research-log', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, tabId, tag, url, data }),
    }).catch(() => {});
    // Для aistudio.* — обновляем зеркало state'а в bridge.
    if (id && id !== '-' && tag.startsWith('aistudio.')) {
      const statePatch = mapAistudioTagToState(tag, data);
      if (statePatch) {
        fetch('http://127.0.0.1:53127/aistudio-state', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id,
            tabId: tabId === '-' ? null : tabId,
            lastTag: tag,
            ...statePatch,
          }),
        }).catch(() => {});
      }
    }
    sendResponse({ ok: true });
    return false; // sync response
  }
  return undefined; // другие handlers
});

// Маппинг тег → state-patch. Возвращаем undefined для тегов которые не
// меняют state (просто debug-маркер).
function mapAistudioTagToState(tag, data) {
  const d = (data && typeof data === 'object') ? data : {};
  // Тег формат aistudio.<phase> или aistudio.core.<phase>.
  // Все ключевые переходы маппим явно.
  if (tag === 'aistudio.runJob.entry') return { status: 'pending', stage: 'boot' };
  if (tag === 'aistudio.job.started')  return { status: 'running', stage: 'started', modelId: d.modelId, promptLen: d.promptLen, promptHead: d.promptHead };
  if (tag === 'aistudio.turnCache.observer_started') return { stage: 'observer_started' };
  if (tag === 'aistudio.core.model.switching') return { stage: 'model_switch', modelId: d.to };
  if (tag === 'aistudio.core.paste.start')     return { stage: 'paste_start' };
  if (tag === 'aistudio.core.paste.done')      return { stage: 'paste_done' };
  if (tag === 'aistudio.core.run.found')       return { stage: 'run_found' };
  if (tag === 'aistudio.core.run.advanced.iso_click')   return { stage: 'running_model' };
  if (tag === 'aistudio.core.run.advanced.main_world')  return { stage: 'running_model' };
  if (tag === 'aistudio.core.run.advanced.kbd_fallback')return { stage: 'running_model' };
  if (tag === 'aistudio.core.run.all_fallbacks_failed') return { stage: 'run_click_failed', error: 'Run button did not advance' };
  if (tag === 'aistudio.core.wait.stop_probe_done') return { stage: 'waiting_response' };
  if (tag === 'aistudio.core.wait.tick') return { stage: 'waiting_response', elapsedSec: d.elapsedSec };
  if (tag === 'aistudio.core.wait.done.stop_disappeared') return { stage: 'completion_detected', elapsedSec: d.elapsedSec };
  if (tag === 'aistudio.core.wait.done.no_stop_short_answer') return { stage: 'completion_detected', elapsedSec: d.elapsedSec };
  if (tag === 'aistudio.core.wait.timeout') return { stage: 'timeout', error: 'timeout waiting for completion' };
  if (tag === 'aistudio.core.parse.entry') return { stage: 'parsing' };
  if (tag === 'aistudio.core.parse.fromCache.ok') return { status: 'done', stage: 'parsed_from_cache', responseTextLen: d.textLen, linkCount: d.linksN };
  if (tag === 'aistudio.core.parse.fail_no_cache') return { status: 'error', stage: 'parse_failed', error: 'no text in DOM or cache' };
  if (tag === 'aistudio.job done' || tag === 'aistudio.job.done') return { status: 'done', stage: 'done', elapsedSec: d.elapsedSec, responseTextLen: d.textLen, linkCount: d.linkCount, responseHead: d.responseHead, responseText: d.responseText, links: d.links };
  if (tag === 'aistudio.job failed' || tag === 'aistudio.job.failed') return { status: 'error', stage: 'failed', error: d.error };
  return undefined; // unknown tag — не шевелим state
}
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!RESEARCH_TABS.has(tabId)) return;
  // Логируем только meaningful changes: status, url, discarded, autoDiscardable.
  const patch = {};
  if (changeInfo.status) patch.status = changeInfo.status;
  if (changeInfo.url) patch.url = changeInfo.url.slice(0, 160);
  if (changeInfo.discarded !== undefined) patch.discarded = changeInfo.discarded;
  if (changeInfo.autoDiscardable !== undefined) patch.autoDiscardable = changeInfo.autoDiscardable;
  if (Object.keys(patch).length === 0) return;
  postLifecycleLog('sw.tab.onUpdated', tabId, patch);
});
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  if (typeof scReplaceResearchTabId === 'function') {
    scReplaceResearchTabId(chrome, removedTabId, addedTabId).catch(() => {});
  }
  if (!RESEARCH_TABS.has(removedTabId)) return;
  postLifecycleLog('sw.tab.onReplaced', removedTabId, { addedTabId });
  // Перенесём tracking на новый id.
  RESEARCH_TABS.delete(removedTabId);
  RESEARCH_TABS.add(addedTabId);
});
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  if (!RESEARCH_TABS.has(tabId)) return;
  postLifecycleLog('sw.tab.onRemoved', tabId, { isWindowClosing: removeInfo.isWindowClosing });
  RESEARCH_TABS.delete(tabId);
});

// Также добавляем hot-reload файлов research'ей в hot-reload poll'е.
// Эти js файлы — части content-script'ов, для них нужно знать mtime
// чтобы расширение перезагружалось при их правке. (Они уже в общей
// mtime-выборке через manifest.json — это достаточно, manifest сам
// упомянет добавление новых js, и bridge возвращает max mtime по
// фиксированному списку. Просим bridge перечитать mtime — нужно
// добавить файлы в этот список. См. electron/browser-bridge.js
// строку с files = [...].)

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  // Ping handler: позволяет content-script'у проверить версию background'а
  // (по полю scBgVersion) и получить ответ без вызова trackJob. Если
  // ответ не приходит — background мёртв ИЛИ старая версия.
  if (req && req.__sc_ping === true) {
    sendResponse({ pong: true, scBgVersion: 'v2-with-ping', ts: Date.now() });
    return false;
  }
  // CS просит сообщить ему его собственный tabId. Используется для recovery:
  // если CS перезагрузился без hash/window.name, он хочет узнать tabId и
  // спросить bridge "есть ли activе research для этого tabId?".
  if (req && req.__sc_get_tab_id === true) {
    sendResponse({ tabId: sender?.tab?.id ?? null });
    return false;
  }
  // Proxy CS→bridge через SW-fetch. Страничный fetch на 127.0.0.1 режется
  // Local Network Access (per-origin диалог; на фоновой вкладке не
  // показывается → молчаливый таймаут, а после «Блокировать» — мгновенный
  // TypeError). SW-fetch идёт от extension-origin с host_permissions и LNA
  // не подвержен. Потребитель — window.scBridgeFetch (research-badge.js).
  if (req && req.__sc_bridge_fetch === true && typeof req.path === 'string') {
    // Path-allowlist: только bridge-эндпоинты research-канала. CS скомпрометированной
    // страницы не должен через нас дёргать произвольные URL.
    if (!req.path.startsWith('/')) { sendResponse({ ok: false, error: 'bad path' }); return false; }
    const init = req.init || {};
    fetch('http://127.0.0.1:53127' + req.path, {
      method: init.method || 'GET',
      headers: init.headers || undefined,
      body: typeof init.body === 'string' ? init.body : undefined,
    }).then(async (r) => {
      const body = await r.text();
      sendResponse({ ok: true, status: r.status, body });
    }).catch((e) => {
      sendResponse({ ok: false, error: (e && e.message) || String(e) });
    });
    return true; // async sendResponse
  }
  // CS (aistudio-mcp) просит вывести СВОЙ таб на передний план. Нужно когда
  // фоновый AI-Studio таб заморозился (Yandex timer/layout throttle) и Angular
  // не бутстрапится — autoDiscardable:false спасает только от discard, НЕ от
  // freeze (доказано JSONL-экспериментом: фоновые запуски падали на
  // studio-ready 30s, foreground-запуск проходил). CS сам chrome.tabs.update
  // вызвать не может — только через SW. Возвращаем prevTabId, чтобы CS потом
  // восстановил прежний активный таб (вспышка окна — только при заморозке).
  if (req && req.__sc_focus_self === true) {
    const tab = sender?.tab;
    if (!tab) { sendResponse({ ok: false, error: 'no sender tab' }); return false; }
    chrome.tabs.query({ active: true, windowId: tab.windowId }, (active) => {
      const prevTabId = (active && active[0]) ? active[0].id : null;
      chrome.tabs.update(tab.id, { active: true }, () => {
        chrome.windows.update(tab.windowId, { focused: true }, () => {
          scBgDbg('focus_self', { tabId: tab.id, prevTabId, windowId: tab.windowId });
          sendResponse({ ok: true, prevTabId, windowId: tab.windowId });
        });
      });
    });
    return true; // async sendResponse
  }
  // Восстановление: активировать ранее активный таб (вернуть фокус юзеру).
  if (req && req.__sc_focus_tab === true && req.tabId != null) {
    chrome.tabs.update(req.tabId, { active: true }, () => {
      const err = chrome.runtime.lastError;
      sendResponse({ ok: !err, error: err?.message });
    });
    return true; // async sendResponse
  }
  if (req && req.__aise_log === true && req.evt) {
    sendToHost(req.evt);
    sendResponse({ ok: true });
    return false;
  }
  if (req && req.__aise_get_buffer === true) {
    chrome.storage.local.get({ __aise_buffer: [] }, (res) => {
      sendResponse({ buffer: res.__aise_buffer || [], queued: queue.length, lastConnectError });
    });
    return true;
  }
  if (req && req.__aise_clear_buffer === true) {
    chrome.storage.local.set({ __aise_buffer: [] }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }
  if (req && req.__aise_ping_host === true) {
    sendToHost({ ts: new Date().toISOString(), level: 'info', tag: 'ping', msg: 'manual ping from popup', ack: true });
    sendResponse({ ok: true, lastConnectError });
    return false;
  }

  if (req && req.__sc_get_fresh_youtube_settings === true) {
    loadFreshYoutubeSettings()
      .then(settings => sendResponse({ ok: true, settings }))
      .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (req?.type === 'sc-youtube-settings-patch') {
    const queued = youtubeSettingsPatchQueue
      .catch(() => {})
      .then(() => persistYoutubeSettingsPatch(req.patch));
    youtubeSettingsPatchQueue = queued;
    queued
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  // ── YouTube job tracker: youtube-content.js шлёт сюда ID job'а сразу
  // после успешного POST /yt-add. Мы кладём его в storage и поднимаем
  // alarm. Когда bridge скажет done — опционально открываем выбранный AI-target
  // в фоне.
  if (req && req.__sc_track_job === true && req.job) {
    // (Удалён misleading diag.storage_session: читал __sc_ext_mtime из
    //  storage.session, куда он НИКОГДА не пишется — hot-reload mtime живёт
    //  в storage.local, а session в Яндексе вообще ненадёжен. См.
    //  fact-yt-extension-bridge.md::Hot-reload.)
    scBgDbg('onMessage.track_job', { videoId: req.job.videoId, target: req.job.target, fromCache: !!req.job.fromCache, hasJob: true, senderTabId: sender?.tab?.id ?? null });
    // Пробрасываем tabId из sender и перед КАЖДЫМ handoff'ом перечитываем
    // desktop canonical settings. Popup мог быть давно закрыт, а режим/model
    // изменены в приложении уже после старта service worker.
    (async () => {
      const base = { ...req.job, tabId: sender?.tab?.id ?? null };
      const enriched = await refreshYoutubeJobSettings(base);
      await trackJob(enriched);
      scBgDbg('onMessage.track_job.DONE', {
        videoId: req.job.videoId,
        target: enriched.target,
        chatgptMode: enriched.chatgptMode || null,
      });
      sendResponse({ ok: true });
    })().catch(e => {
      scBgDbg('onMessage.track_job.THREW', { err: e?.message || String(e), stack: (e?.stack || '').slice(0,200) });
      sendResponse({ ok: false, error: e?.message || String(e) });
    });
    return true;
  }

  // autoscrape (aistudio-autoscrape.js) шлёт нам сигнал когда транскрипт
  // вставлен в textarea Gemini Studio (или упал). Мы по requestId находим
  // соответствующий yt-tab и шлём финальный toast «✓ Вставлено». Без
  // этого юзер видит только «Готово» от sc-desktop, но не знает, что
  // вставка в фоновую вкладку прошла успешно.
  if (req && req.__sc_aistudio_pasted === true && req.requestId) {
    handleAistudioPasted(req.requestId, req.ok !== false, req.error || null)
      .catch(e => console.warn('[SC-BG] aistudio_pasted handler failed', e));
    sendResponse({ ok: true });
    return false;
  }
  if (req && req.__sc_chatgpt_compose_claim === true && req.requestId) {
    claimChatgptComposeTab(req.requestId, sender)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (req && req.__sc_chatgpt_compose_result === true && req.requestId) {
    handleChatgptComposeResult(req.requestId, req, sender)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  // aistudio-mcp.js шлёт __sc_aistudio_mcp_done когда job завершился
  // (status='done' либо 'error'). Снимаем вкладку из busy-set'а чтобы
  // следующий aistudio_run мог её переиспользовать + detach debugger.
  // При ok:true (status='done') — закрываем вкладку (юзер просил: result
  // сохранён в storage/bridge, вкладка больше не нужна). При error
  // оставляем для debug.
  if (req && req.__sc_aistudio_mcp_done === true && req.jobId) {
    const senderTabId = sender?.tab?.id ?? null;
    const jobId = req.jobId;
    const isOk = req.ok === true;
    (async () => {
      try {
        const BUSY_KEY = '__sc_aistudio_mcp_busy_tabs';
        const got = await chrome.storage.local.get(BUSY_KEY);
        const list = Array.isArray(got?.[BUSY_KEY]) ? got[BUSY_KEY] : [];
        const filtered = list.filter(id => id !== senderTabId);
        await chrome.storage.local.set({ [BUSY_KEY]: filtered });
      } catch {}
      // Detach debugger — yellow banner исчезнет, вкладка вернётся к
      // нормальному background-throttling режиму. Если юзер хочет продолжить
      // болтать в этой же вкладке вручную, она будет вести себя обычно.
      if (senderTabId != null) {
        try { await detachFocusEmulation(senderTabId); } catch {}
      }
      // Auto-close ТОЛЬКО на успешный done. На error — НЕ закрываем: для AI
      // Studio мы уже отрабатываем transient-ошибки через retry (1-2 нажатия
      // «Rerun this turn»), и если ПОСЛЕ retry всё равно error — это настоящая
      // поломка страницы (Angular/Gemini сломались, что-то не отобразилось).
      // Такую вкладку оставляем для ручной диагностики (юзер всё равно смотрит
      // логи/страницу при разборе). Уважаем keepTab=true.
      if (isOk && senderTabId != null) {
        let keepTab = false;
        try {
          const r = await fetch('http://127.0.0.1:53127/aistudio-jobs', {
            headers: { Origin: 'chrome-extension://internal' },
          });
          if (r.ok) {
            const data = await r.json();
            const job = (data.jobs || []).find(j => j.jobId === jobId);
            keepTab = !!job?.keepTab;
          }
        } catch (e) {
          // Если bridge недоступен — fallback: закрываем (как было).
        }
        if (!keepTab) {
          setTimeout(() => {
            try { chrome.tabs.remove(senderTabId); } catch {}
          }, 300);
        }
      }
    })();
    sendResponse({ ok: true });
    return false;
  }
  // Generic auto-close для research scripts (claude/perplexity) — они шлют
  // {__sc_close_self_tab:true} после успешного save.
  if (req && req.__sc_close_self_tab === true) {
    const senderTabId = sender?.tab?.id;
    if (senderTabId != null) {
      scBgDbg('close_self_tab', { tabId: senderTabId, reason: req.reason });
      // done → быстро (500мс). error/timeout → 4с, чтобы юзер успел заметить
      // вкладку/ошибку если смотрит на неё. Вкладка закрывается в любом случае
      // (юзер: лишние вкладки не оставлять).
      const isError = req.reason && req.reason !== 'research_done';
      setTimeout(() => {
        try { chrome.tabs.remove(senderTabId); } catch {}
      }, isError ? 4000 : 500);
    }
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

// ─────────── Hot-reload через polling sc-desktop bridge'а ───────────
//
// Manifest-V3 service worker не имеет hmr — поэтому опрашиваем
// `http://127.0.0.1:53127/__ext_version` раз в 2 сек. Если sc-desktop
// вернёт mtime отличный от запомненного — расширение перезагружается.
// На bridge-стороне endpoint возвращает max(mtime) исходников `browser-extension/`.
//
// Зачем: чтобы юзер не нажимал ⟳ в chrome://extensions/ при каждой правке.
// Поллинг работает только если bridge живой (127.0.0.1:53127 reachable)
// — в проде расширение не получит ответа, цикл no-op.
const __SC_RELOAD_POLL_MS = 2000;
// Tracer: первый запуск этого блока после reload расширения.
scBgDbg('sw_boot', { ts: Date.now() }).catch(() => {});
// Hot-reload с защитой от circuit-breaker'а:
//
//   1) Grace period после SW boot — 5 секунд. В первые 5 секунд после
//      старта НЕ reload, даже если mtime отличается. Прошлая итерация
//      могла не успеть записать новое значение в storage до reload'а,
//      и сразу после reload'а мы прочитаем СТАРОЕ `last` ≠ свежее `mt` →
//      опять reload → loop. Grace это разрывает.
//
//   2) Reload cooldown — 30 секунд между chrome.runtime.reload()'ами.
//      Даже если все остальные защиты подведут, browser circuit-breaker
//      срабатывает на ~30 reload'ов за секунду — мы держимся ниже.
//
//   3) Persist last_reload_ts в storage.local — переживает SW respin.
//
// Проверка детерминированности: на каждом poll-tick пишем в bg-лог
// (reload.poll) с текущим mt, last, elapsed_since_boot, last_reload_ts.
// Если что-то пойдёт не так — увидим точное состояние перед reload'ом.

const __SC_BOOT_TS = Date.now();
const __SC_GRACE_PERIOD_MS = 5000;
const __SC_RELOAD_COOLDOWN_MS = 30000;

async function __sc_pollExtVersion() {
  try {
    const r = await fetch('http://127.0.0.1:53127/__ext_version', { method: 'GET' });
    if (!r.ok) return;
    const data = await r.json();
    const mt = data?.mtime;
    if (!mt) return;
    const got = await chrome.storage.local.get(['__sc_ext_mtime', '__sc_last_reload_ts']);
    const last = got?.__sc_ext_mtime ?? null;
    const lastReload = got?.__sc_last_reload_ts ?? 0;
    const sinceBoot = Date.now() - __SC_BOOT_TS;
    const sinceReload = Date.now() - lastReload;

    if (last === null) {
      await chrome.storage.local.set({ __sc_ext_mtime: mt });
      scBgDbg('reload.init', { mtime: mt, sinceBoot }).catch(() => {});
      return;
    }
    if (mt === last) return;

    // mtime изменился. Проверяем защиты по очереди.
    if (sinceBoot < __SC_GRACE_PERIOD_MS) {
      scBgDbg('reload.skip.grace', { mt, last, sinceBoot }).catch(() => {});
      // НЕ обновляем `last` — пусть следующий tick (уже после grace)
      // увидит то же расхождение и сделает reload.
      return;
    }
    if (sinceReload < __SC_RELOAD_COOLDOWN_MS) {
      scBgDbg('reload.skip.cooldown', { mt, last, sinceReload }).catch(() => {});
      return;
    }
    // Все защиты пройдены. Запоминаем НОВОЕ mtime + время reload'а,
    // ПОТОМ перезагружаемся. Если crash до reload'а — следующий
    // tick после respin'а увидит уже обновлённый `last` и не зациклится.
    await chrome.storage.local.set({ __sc_ext_mtime: mt, __sc_last_reload_ts: Date.now() });
    scBgDbg('reload.firing', { from: last, to: mt, sinceBoot, sinceReload }).catch(() => {});
    chrome.runtime.reload();
  } catch (e) {
    // Bridge недоступен или storage упал — silent (в проде ОК).
  }
}
// ── Hot-reload через WebSocket (WXT/CRXJS-pattern) + safety net ────────
// По официальным правилам Chrome 116+, активный WebSocket в SW сбрасывает
// 30-секундный idle-таймер при КАЖДОМ полученном/отправленном сообщении.
// Это даёт hot-reload < 1 секунды без зависимости от chrome.alarms (которые
// в Yandex.Browser могут спать 5+ минут — см. research в /tmp/research-sw-wake.json
// и chat https://claude.ai/chat/3896988f-7d96-43d7-85ce-4630f77039d0).
//
// Архитектура:
//   1. SW подключает WebSocket к sc-desktop bridge (порт 53129 — dev only).
//   2. Каждые 20с шлёт ping — WS-trafic держит SW живым.
//   3. Bridge при изменении mtime шлёт 'reload' — SW делает chrome.runtime.reload().
//   4. chrome.alarms 0.5min (минимум разрешённый Chrome 120+) — safety net
//      на случай когда WS не поднялся.
//   5. Event-driven poll: tabs.onActivated / webNavigation.onCompleted —
//      доп. wake-triggers при user-action.
const __SC_RELOAD_ALARM = 'sc-hot-reload-poll';
const __SC_RELOAD_WS_URL = 'ws://localhost:53129'; // отдельный порт, hot-reload-only
let __sc_reloadWs = null;
let __sc_reloadWsPingTimer = null;

function __sc_connectReloadWs() {
  try {
    __sc_reloadWs = new WebSocket(__SC_RELOAD_WS_URL);
  } catch (e) {
    // bridge не запущен (не dev режим) — пропустим, alarm-fallback покроет
    return;
  }
  __sc_reloadWs.addEventListener('open', () => {
    console.log('[SC-BG] hot-reload WS open');
    // Ping каждые 20 сек — keep-alive по Chrome 116+ semantics.
    if (__sc_reloadWsPingTimer) clearInterval(__sc_reloadWsPingTimer);
    __sc_reloadWsPingTimer = setInterval(() => {
      try {
        if (__sc_reloadWs && __sc_reloadWs.readyState === WebSocket.OPEN) {
          __sc_reloadWs.send('ping');
        } else {
          clearInterval(__sc_reloadWsPingTimer);
          __sc_reloadWsPingTimer = null;
        }
      } catch {}
    }, 20_000);
  });
  __sc_reloadWs.addEventListener('message', (ev) => {
    const data = String(ev.data || '');
    if (data === 'reload' || data.startsWith('reload:')) {
      console.log('[SC-BG] hot-reload triggered via WS');
      chrome.runtime.reload();
    }
  });
  __sc_reloadWs.addEventListener('close', () => {
    __sc_reloadWs = null;
    if (__sc_reloadWsPingTimer) { clearInterval(__sc_reloadWsPingTimer); __sc_reloadWsPingTimer = null; }
    // Backoff reconnect. setTimeout НЕ переживёт SW kill, но при следующем
    // boot'е SW IIFE снова вызовет __sc_connectReloadWs() — поэтому нет
    // нужды в более сложном retry.
    setTimeout(__sc_connectReloadWs, 2000);
  });
  __sc_reloadWs.addEventListener('error', () => {
    try { __sc_reloadWs?.close(); } catch {}
  });
}
__sc_connectReloadWs();

// Safety net через alarms (минимум 0.5 min по Chrome 120+ правилам).
chrome.alarms.create(__SC_RELOAD_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(a => {
  if (a.name !== __SC_RELOAD_ALARM) return;
  // Если WS не поднялся — переподключим. И всё равно делаем HTTP-poll
  // как старый fallback (если bridge не имеет WS-endpoint, например prod app).
  if (!__sc_reloadWs || __sc_reloadWs.readyState !== WebSocket.OPEN) {
    __sc_connectReloadWs();
  }
  __sc_pollExtVersion();
});
__sc_pollExtVersion();

// Дополнительные wake-triggers: на каждое из этих событий проверяем
// (debounced 3 сек чтобы не спамить bridge).
let __sc_lastPollAt = 0;
function __sc_pollDebounced() {
  const now = Date.now();
  if (now - __sc_lastPollAt < 3000) return;
  __sc_lastPollAt = now;
  __sc_pollExtVersion();
}
try { chrome.tabs.onActivated.addListener(() => __sc_pollDebounced()); } catch {}
try { chrome.webNavigation.onCompleted.addListener(() => __sc_pollDebounced()); } catch {}
try { chrome.runtime.onStartup.addListener(() => __sc_pollDebounced()); } catch {}
try { chrome.runtime.onInstalled.addListener(() => __sc_pollDebounced()); } catch {}

async function handleAistudioPasted(requestId, ok, errorMsg) {
  scBgDbg('aistudio.pasted.recv', { requestId, ok, errorMsg });
  // Запись могла быть положена либо openAistudioBackground (Gemini target),
  // либо openClaudeBackground (Claude target). Проверяем оба ключа — какой
  // придёт, той target'е и принадлежит requestId. Имя сигнала
  // `__sc_aistudio_pasted` оставлено по историческим причинам (общий канал
  // финального уведомления), не привязано к Gemini.
  const aiKey = '__sc_aistudio_job_' + requestId;
  const clKey = '__sc_claude_job_' + requestId;
  const got = await new Promise(res => chrome.storage.local.get([aiKey, clKey], res));
  const aiJob = got?.[aiKey] || got?.[clKey];
  const usedKey = got?.[aiKey] ? aiKey : (got?.[clKey] ? clKey : null);
  const targetLabel = usedKey === clKey ? 'Claude' : 'Gemini Studio';
  if (!aiJob) {
    scBgDbg('aistudio.pasted.NO_AIJOB', { requestId, aiKey, clKey });
    return;
  }
  scBgDbg('aistudio.pasted.aiJob', { ytTabId: aiJob.ytTabId, ytVideoId: aiJob.ytVideoId, hasTitle: !!aiJob.ytTitle, target: targetLabel });
  if (aiJob.ytTabId == null || !aiJob.ytVideoId) return;
  if (ok) {
    sendBtnState(aiJob.ytTabId, {
      videoId: aiJob.ytVideoId,
      state: 'pasted',
      title: aiJob.ytTitle || null,
    });
  } else {
    sendBtnState(aiJob.ytTabId, {
      videoId: aiJob.ytVideoId,
      state: 'error',
      error: targetLabel + ': ' + (errorMsg || 'paste failed'),
    });
  }
  // Cleanup storage entry чтобы не копились.
  if (usedKey) try { chrome.storage.local.remove(usedKey); } catch {}
}

async function handleChatgptComposeResult(requestId, result, sender) {
  const senderUrl = sender?.tab?.url || sender?.url || '';
  try {
    const host = new URL(senderUrl).hostname;
    if (host !== 'chatgpt.com' && host !== 'www.chatgpt.com') {
      throw new Error('compose result rejected: unexpected sender');
    }
  } catch (error) {
    if (senderUrl) throw error;
  }

  const key = CHATGPT_COMPOSE_JOB_PREFIX + requestId;
  const got = await new Promise(resolve => chrome.storage.local.get(key, resolve));
  const stored = got?.[key] || {};
  return deliverChatgptComposeResult(requestId, result, stored);
}

async function claimChatgptComposeTab(requestId, sender) {
  const tabId = sender?.tab?.id;
  const senderUrl = sender?.tab?.url || sender?.url || '';
  if (tabId == null) throw new Error('compose claim has no sender tab');
  const host = new URL(senderUrl).hostname;
  if (host !== 'chatgpt.com' && host !== 'www.chatgpt.com') {
    throw new Error('compose claim rejected: unexpected sender');
  }
  const key = CHATGPT_COMPOSE_JOB_PREFIX + requestId;
  const got = await chrome.storage.local.get(key);
  const job = got?.[key];
  if (!job || typeof job !== 'object') throw new Error('compose job not found');
  if (job.tabId !== tabId) {
    await chrome.storage.local.set({ [key]: { ...job, tabId } });
  }
  await ensureChatgptComposeWatchdog();
  return { ok: true, tabId };
}

async function deliverChatgptComposeResult(requestId, result, stored = {}) {
  const key = CHATGPT_COMPOSE_JOB_PREFIX + requestId;
  // Route fields travel in the ACK as well. If SW processed success but its
  // callback was lost, the content-script retries after the storage record
  // has already been removed; the second ACK must remain idempotent.
  const route = {
    ytTabId: result.ytTabId ?? stored.ytTabId ?? null,
    ytVideoId: result.ytVideoId || stored.ytVideoId || null,
    ytTitle: result.ytTitle || stored.ytTitle || null,
  };
  if (route.ytTabId == null || !route.ytVideoId) {
    throw new Error('compose result has no YouTube route');
  }
  const mode = normalizeChatgptMode(result.mode || stored.mode);
  const targetLabel = youtubeAiTargetLabel('chatgpt', mode);
  const ok = result.ok === true;
  const terminalResult = {
    ok,
    error: result.error || null,
    mode,
    model: result.model || stored.model || null,
    effort: result.effort || stored.effort || null,
    speed: result.speed || stored.speed || null,
  };
  // Terminal result становится durable ДО первой доставки в YouTube. Иначе
  // respin SW в узком окне sendMessage потеряет реальную selector/login ошибку
  // и watchdog позднее подменит её общим timeout.
  stored = await markComposeTerminal(requestId, {
    ...stored,
    requestId,
    ytTabId: route.ytTabId,
    ytVideoId: route.ytVideoId,
    ytTitle: route.ytTitle,
    mode,
    model: terminalResult.model,
    effort: terminalResult.effort,
    speed: terminalResult.speed,
    ts: stored.ts || Date.now(),
  }, terminalResult);
  scBgDbg('chatgpt.compose.result', {
    requestId,
    ok,
    mode,
    model: result.model || stored.model || null,
    effort: result.effort || stored.effort || null,
    speed: result.speed || stored.speed || null,
    ytVideoId: route.ytVideoId,
  });
  postLifecycleLog('gpt.compose.result', stored.tabId ?? null, {
    requestId,
    ok,
    mode,
    model: terminalResult.model,
    effort: terminalResult.effort,
    speed: terminalResult.speed,
    ytVideoId: route.ytVideoId,
  }).catch(() => {});

  let delivery;
  if (ok) {
    delivery = await sendBtnState(route.ytTabId, {
      videoId: route.ytVideoId,
      state: 'pasted',
      target: 'chatgpt',
      targetLabel,
      chatgptMode: mode,
      title: `${route.ytTitle || 'YouTube-видео'} — ${targetLabel}: запрос отправлен`,
    });
  } else {
    delivery = await sendBtnState(route.ytTabId, {
      videoId: route.ytVideoId,
      state: 'error',
      target: 'chatgpt',
      targetLabel,
      chatgptMode: mode,
      title: route.ytTitle || null,
      error: `${targetLabel}: ${result.error || 'не удалось отправить запрос'}`,
    });
  }
  if (!delivery?.appliedYoutubeTabIds?.length) {
    scBgDbg('chatgpt.compose.result_delivery_pending', {
      requestId,
      ok,
      ytTabId: route.ytTabId,
      attemptedTabIds: delivery?.attemptedTabIds || [],
    });
    return { ok: false, accepted: ok, targetLabel, error: 'YouTube confirmation delivery pending' };
  }
  try { await chrome.storage.local.remove(key); } catch {}
  clearChatgptComposeWatchdogIfIdle().catch(() => {});
  return { ok: true, accepted: ok, targetLabel };
}

// ─────────── YouTube job tracker ───────────

async function loadTracker() {
  return new Promise(resolve => {
    chrome.storage.local.get({ [TRACKER_KEY]: {} }, raw => resolve(raw[TRACKER_KEY] || {}));
  });
}
async function saveTracker(map) {
  return new Promise(resolve => {
    chrome.storage.local.set({ [TRACKER_KEY]: map }, () => resolve());
  });
}

const AISTUDIO_KICK_URL = 'https://aistudio.google.com/prompts/new_chat';
const CLAUDE_KICK_URL   = 'https://claude.ai/new';

function newRequestId() {
  return 'sc' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function normalizeYoutubeAiTarget(target) {
  if (target === 'claude' || target === 'chatgpt') return target;
  return 'aistudio';
}

function youtubeAiTargetLabel(target, chatgptMode = 'chat') {
  if (target === 'chatgpt') {
    return 'ChatGPT · ' + (normalizeChatgptMode(chatgptMode) === 'work' ? 'Work' : 'Chat');
  }
  if (target === 'claude') return 'Claude';
  return 'Gemini Studio';
}

// Открывает claude.ai в новой вкладке В ФОНЕ. Контракт payload'а:
//   { cachedFilePath, cachedCommentsFilePath, model, project, postProject,
//     adaptiveThinking, ytTabId, ytVideoId, ytTitle }
// Storage-ключ `__sc_claude_job_<requestId>` читается content-script'ом
// claude-autoscrape.js. handleAistudioPasted ищет в обоих ключах
// (aistudio и claude), потому что финальный сигнал общий.
async function openClaudeBackground(payload) {
  const requestId = newRequestId();
  const job = {
    requestId,
    cachedFilePath: payload.cachedFilePath || null,
    cachedCommentsFilePath: payload.cachedCommentsFilePath || null,
    model: payload.model || 'Opus 4.7',
    project: payload.project || '',
    postProject: payload.postProject || '',
    adaptiveThinking: payload.adaptiveThinking !== false,  // default ON
    ytTabId: payload.ytTabId ?? null,
    ytVideoId: payload.ytVideoId || null,
    ytTitle: payload.ytTitle || null,
    ts: Date.now(),
  };
  scBgDbg('openClaude.enter', { requestId, model: job.model, project: job.project, hasCached: !!job.cachedFilePath });
  await new Promise(resolve => {
    chrome.storage.local.set({ ['__sc_claude_job_' + requestId]: job }, resolve);
  });
  scBgDbg('openClaude.storage_set_ok', { requestId });
  await new Promise((resolve, reject) => {
    chrome.tabs.create({
      url: CLAUDE_KICK_URL + '#sc=' + requestId,
      active: false,
    }, tab => {
      if (chrome.runtime.lastError) {
        scBgDbg('openClaude.tabs_create_FAIL', { err: chrome.runtime.lastError.message });
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        scBgDbg('openClaude.tabs_create_OK', { tabId: tab?.id, url: tab?.url });
        resolve();
      }
    });
  });
  return requestId;
}

async function fetchYoutubeArtifactText(filePath) {
  if (!filePath) return '';
  const u = new URL(SC_BRIDGE + '/yt-fetch');
  u.searchParams.set('path', filePath);
  const r = await fetch(u.toString());
  if (!r.ok) {
    let err = null;
    try { err = await r.json(); } catch {}
    throw new Error(err?.error || ('yt-fetch http ' + r.status));
  }
  const data = await r.json();
  return String(data?.text || '');
}

const CHATGPT_COMPOSE_JOB_PREFIX = '__sc_chatgpt_compose_job_';
const CHATGPT_COMPOSE_WATCHDOG_ALARM = 'sc-chatgpt-compose-watchdog';
const CHATGPT_COMPOSE_UNCLAIMED_TTL_MS = 90 * 1000;
const CHATGPT_COMPOSE_SOFT_TTL_MS = 10 * 60 * 1000;
const CHATGPT_COMPOSE_HARD_TTL_MS = 30 * 60 * 1000;

async function listChatgptComposeJobs() {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([key, value]) => key.startsWith(CHATGPT_COMPOSE_JOB_PREFIX) && value && typeof value === 'object')
    .map(([key, job]) => ({ key, requestId: key.slice(CHATGPT_COMPOSE_JOB_PREFIX.length), job }));
}

async function hasChatgptComposeRecordForVideo(videoId) {
  if (!videoId) return false;
  const entries = await listChatgptComposeJobs();
  return entries.some(({ job }) => job.ytVideoId === videoId);
}

async function findChatgptComposeTabByMarker(requestId) {
  const marker = 'sc-compose=' + encodeURIComponent(requestId);
  const tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*', 'https://www.chatgpt.com/*'] });
  return tabs.find(tab => typeof tab.url === 'string' && tab.url.includes(marker)) || null;
}

async function ensureChatgptComposeWatchdog() {
  const existing = await chrome.alarms.get(CHATGPT_COMPOSE_WATCHDOG_ALARM);
  if (!existing) chrome.alarms.create(CHATGPT_COMPOSE_WATCHDOG_ALARM, { periodInMinutes: 0.5 });
}

async function clearChatgptComposeWatchdogIfIdle() {
  const jobs = await listChatgptComposeJobs();
  if (!jobs.length) await chrome.alarms.clear(CHATGPT_COMPOSE_WATCHDOG_ALARM);
}

function composeTerminalResult(job, fallbackError = null) {
  if (job?.terminalResult && typeof job.terminalResult === 'object') return job.terminalResult;
  if (job?.submitAcceptedAt) {
    return {
      ok: true,
      mode: job.acceptedMode || job.mode || 'chat',
      model: job.acceptedModel || job.model || null,
      effort: job.acceptedEffort || job.effort || null,
      speed: job.acceptedSpeed || job.speed || null,
    };
  }
  if (fallbackError) {
    return {
      ok: false,
      error: fallbackError,
      mode: job?.mode || 'chat',
      model: job?.model || null,
      effort: job?.effort || null,
      speed: job?.speed || null,
    };
  }
  return null;
}

async function markComposeTerminal(requestId, job, result) {
  const key = CHATGPT_COMPOSE_JOB_PREFIX + requestId;
  const next = {
    ...job,
    terminalResult: { ...result },
    terminalAt: job?.terminalAt || Date.now(),
  };
  await chrome.storage.local.set({ [key]: next });
  await ensureChatgptComposeWatchdog();
  return next;
}

async function settleChatgptComposeRecord(requestId, job, fallbackError = null) {
  let result = composeTerminalResult(job, fallbackError);
  if (!result) return false;
  if (!job.terminalResult) job = await markComposeTerminal(requestId, job, result);
  const response = await deliverChatgptComposeResult(requestId, result, job);
  if (response?.ok) {
    if (job.tabId != null) detachFocusEmulation(job.tabId).catch(() => {});
    return true;
  }
  return false;
}

async function sweepChatgptComposeJobs() {
  const now = Date.now();
  const entries = await listChatgptComposeJobs();
  for (const { key, requestId, job: storedJob } of entries) {
    let job = storedJob;
    const age = now - Number(job.ts || now);
    let fallbackError = null;
    if (!job.terminalResult && !job.submitAcceptedAt && job.tabId == null) {
      const markedTab = await findChatgptComposeTabByMarker(requestId).catch(() => null);
      if (markedTab?.id != null) {
        job = { ...job, tabId: markedTab.id };
        await chrome.storage.local.set({ [key]: job });
        attachFocusEmulation(markedTab.id).catch(() => {});
        scBgDbg('chatgpt.compose.unclaimed_reconciled', { requestId, tabId: markedTab.id });
      } else if (age >= CHATGPT_COMPOSE_UNCLAIMED_TTL_MS) {
        fallbackError = 'не удалось открыть вкладку ChatGPT';
      }
    }
    if (!job.terminalResult && !job.submitAcceptedAt && job.tabId != null) {
      try { await chrome.tabs.get(job.tabId); }
      catch { fallbackError = 'вкладка ChatGPT закрыта до отправки запроса'; }
    }
    if (!fallbackError && !job.terminalResult && !job.submitAcceptedAt && age >= CHATGPT_COMPOSE_SOFT_TTL_MS) {
      fallbackError = 'таймаут отправки запроса в ChatGPT';
    }
    await settleChatgptComposeRecord(requestId, job, fallbackError);
    if (age >= CHATGPT_COMPOSE_HARD_TTL_MS) {
      const stillThere = await chrome.storage.local.get(key);
      if (stillThere?.[key]) {
        await chrome.storage.local.remove(key);
        if (job.tabId != null) detachFocusEmulation(job.tabId).catch(() => {});
        scBgDbg('chatgpt.compose.hard_ttl_cleanup', { requestId, tabId: job.tabId ?? null });
      }
    }
  }
  await clearChatgptComposeWatchdogIfIdle();
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== CHATGPT_COMPOSE_WATCHDOG_ALARM) return;
  sweepChatgptComposeJobs().catch(error => {
    scBgDbg('chatgpt.compose.watchdog_failed', { err: error?.message || String(error) });
  });
});

chrome.tabs.onRemoved.addListener(tabId => {
  listChatgptComposeJobs().then(async entries => {
    for (const { requestId, job } of entries) {
      if (job.tabId !== tabId) continue;
      const fallbackError = job.submitAcceptedAt
        ? null
        : 'вкладка ChatGPT закрыта до отправки запроса';
      await settleChatgptComposeRecord(requestId, job, fallbackError);
    }
  }).catch(error => {
    scBgDbg('chatgpt.compose.tab_removed_failed', { tabId, err: error?.message || String(error) });
  });
});

// SW мог перезапуститься после Send, но до ACK. Persistent compose-record
// сам восстанавливает watchdog и доставляет terminal result.
listChatgptComposeJobs()
  .then(entries => {
    if (entries.length) {
      ensureChatgptComposeWatchdog();
      sweepChatgptComposeJobs();
    }
  })
  .catch(() => {});

async function createTabAsync(opts) {
  return await new Promise((resolve, reject) => {
    chrome.tabs.create(opts, tab => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(tab);
    });
  });
}

async function createTabBesideSourceAsync(opts, sourceTabId, logContext = {}) {
  if (!Number.isInteger(sourceTabId)) return createTabAsync(opts);

  let sourceTab;
  try {
    sourceTab = await chrome.tabs.get(sourceTabId);
  } catch (error) {
    scBgDbg('tabs.create_beside_source.source_missing', {
      ...logContext,
      sourceTabId,
      err: error?.message || String(error),
    });
    return createTabAsync(opts);
  }

  const positioned = typeof scTabCreateOptionsBesideSource === 'function'
    ? scTabCreateOptionsBesideSource(opts, sourceTab)
    : { ...opts };
  const hasPlacement = Number.isInteger(positioned.windowId) && Number.isInteger(positioned.index);
  if (!hasPlacement) return createTabAsync(opts);

  try {
    const tab = await createTabAsync(positioned);
    const placementData = {
      ...logContext,
      sourceTabId,
      sourceWindowId: sourceTab.windowId,
      sourceIndex: sourceTab.index,
      requestedIndex: positioned.index,
      tabId: tab?.id ?? null,
      tabWindowId: tab?.windowId ?? null,
      tabIndex: tab?.index ?? null,
    };
    scBgDbg('tabs.create_beside_source.OK', placementData);
    postLifecycleLog('sw.tabs.create_beside_source', tab?.id ?? null, placementData).catch(() => {});
    return tab;
  } catch (error) {
    // Между tabs.get и tabs.create исходное окно могло закрыться. Саму
    // возможность открыть ChatGPT не теряем: повторяем без привязки к позиции.
    scBgDbg('tabs.create_beside_source.retry_unplaced', {
      ...logContext,
      sourceTabId,
      sourceWindowId: sourceTab.windowId,
      sourceIndex: sourceTab.index,
      requestedIndex: positioned.index,
      err: error?.message || String(error),
    });
    return createTabAsync(opts);
  }
}

// YouTube → ChatGPT это не MCP/research job. Здесь нужен только reusable
// compose-layer: открыть ChatGPT, выбрать модель/effort, загрузить транскрипт
// отдельным документом, ввести instruction в composer и нажать Send. Ответ
// остаётся в обычном ChatGPT-чате; sources/parser/MCP-badge не запускаются.
async function openChatgptBackground(payload) {
  const transcriptText = await fetchYoutubeArtifactText(payload.cachedFilePath);
  const commentsText = payload.cachedCommentsFilePath
    ? await fetchYoutubeArtifactText(payload.cachedCommentsFilePath)
    : '';
  const composeContent = buildYoutubeChatgptComposeContent(payload, transcriptText, commentsText);
  const requestId = newRequestId();
  const job = {
    requestId,
    prompt: composeContent.prompt,
    document: composeContent.document,
    showInTextField: payload.showInTextField !== false,
    mode: normalizeChatgptMode(payload.mode),
    model: payload.model || '5.6-sol',
    effort: payload.effort || 'xhigh',
    speed: normalizeChatgptMode(payload.mode) === 'work' ? (payload.speed || 'standard') : null,
    ytTabId: payload.ytTabId ?? null,
    ytVideoId: payload.ytVideoId || null,
    ytTitle: payload.ytTitle || null,
    ts: Date.now(),
  };
  scBgDbg('openChatgpt.enter', {
    requestId,
    mode: job.mode,
    model: job.model,
    effort: job.effort,
    speed: job.speed,
    promptLen: job.prompt.length,
    documentChars: job.document.text.length,
    documentName: job.document.name,
    showInTextField: job.showInTextField,
    hasComments: !!commentsText,
  });
  await new Promise(resolve => {
    chrome.storage.local.set({ [CHATGPT_COMPOSE_JOB_PREFIX + requestId]: job }, resolve);
  });
  await ensureChatgptComposeWatchdog();
  let tab;
  try {
    tab = await createTabBesideSourceAsync({
      url: scChatgptComposeEntryUrl(requestId, job.mode),
      active: false,
    }, job.ytTabId, { requestId, feature: 'youtube-chatgpt-compose' });
  } catch (error) {
    await chrome.storage.local.remove(CHATGPT_COMPOSE_JOB_PREFIX + requestId);
    clearChatgptComposeWatchdogIfIdle().catch(() => {});
    throw error;
  }
  if (tab?.id != null) {
    job.tabId = tab.id;
    await new Promise(resolve => {
      chrome.storage.local.set({ [CHATGPT_COMPOSE_JOB_PREFIX + requestId]: job }, resolve);
    });
    attachFocusEmulation(tab.id).catch(e => {
      scBgDbg('openChatgpt.debugger_attach_fail', { requestId, tabId: tab.id, err: e?.message || String(e) });
    });
  }
  scBgDbg('openChatgpt.started', { requestId, tabId: tab?.id ?? null });
  return requestId;
}

// Универсальный диспетчер по target. Принимает «общий» payload (cached*,
// ytTab*) и job-record (где target+специфичные поля каждого target'а
// уже разложены). Если target неизвестен — fallback на aistudio чтобы
// legacy job'ы (без поля target) продолжали работать.
async function openTargetBackground(target, common, job) {
  if (target === 'chatgpt') {
    return openChatgptBackground({
      ...common,
      prompt: job.chatgptPrompt,
      showInTextField: job.chatgptShowInTextField !== false,
      mode: job.chatgptMode,
      model: job.chatgptModel,
      effort: job.chatgptEffort,
      speed: job.chatgptSpeed,
    });
  }
  if (target === 'claude') {
    return openClaudeBackground({
      ...common,
      model: job.claudeModel,
      project: job.claudeProject,
      postProject: job.claudePostProject,
      adaptiveThinking: job.claudeAdaptiveThinking,
    });
  }
  return openAistudioBackground({
    ...common,
    modelTitle: job.modelTitle,
    postModelTitle: job.postModelTitle,
    systemInstruction: job.systemInstruction,
    postSystemInstruction: job.postSystemInstruction,
  });
}

// Открывает Gemini Studio в новой вкладке В ФОНЕ. Payload для autoscrape
// кладётся в chrome.storage.local (sessionStorage чужой вкладки нам не
// доступен; query-string мог бы засветить системную инструкцию в истории).
// active:false делает открытие тихим — фокус остаётся на youtube-вкладке.
async function openAistudioBackground(payload) {
  const requestId = newRequestId();
  const job = {
    requestId,
    cachedFilePath: payload.cachedFilePath || null,
    cachedCommentsFilePath: payload.cachedCommentsFilePath || null,
    modelTitle: payload.modelTitle || 'Gemini 3 Flash Preview',
    // Модель, на которую autoscrape переключит Gemini Studio ПОСЛЕ Run.
    // Пустая строка = не менять (остаётся modelTitle). Идея: первый ответ
    // — быстрая Flash, дальше юзер пишет вопросы — отвечает умная Pro.
    postModelTitle: payload.postModelTitle || '',
    systemInstruction: payload.systemInstruction || '',
    // Пресет «для сброса после Run» — пустая строка означает выбрать
    // `+ Create new instruction` (создать новую инструкцию без текста),
    // т.е. вернуть System Instructions к «пусто». autoscrape применит
    // его последним шагом, чтобы наш sys-prompt не висел над будущими
    // запросами юзера в той же вкладке.
    postSystemInstruction: payload.postSystemInstruction || '',
    // YT-side context: чтобы по __sc_aistudio_pasted (от autoscrape)
    // мы могли отправить toast на правильную вкладку с правильным videoId.
    ytTabId: payload.ytTabId ?? null,
    ytVideoId: payload.ytVideoId || null,
    ytTitle: payload.ytTitle || null,
    ts: Date.now(),
  };
  await new Promise(resolve => {
    chrome.storage.local.set({ ['__sc_aistudio_job_' + requestId]: job }, resolve);
  });
  chrome.tabs.create({
    url: AISTUDIO_KICK_URL + '#sc=' + requestId,
    active: false,        // ФОН: новая вкладка, но юзер остаётся где был
  });
  return requestId;
}

// Шлёт state-update на текущую активную (visible) youtube-вкладку
// + дублирует на исходную (job.tabId) на случай если активная не YT
// или окно сменилось. Дубль безопасен: content-script сам дропает
// event'ы при document.visibilityState !== 'visible' (см.
// youtube-content::onMessage handler), так что скрытая вкладка их
// просто проигнорирует. Активная — отрисует.
async function sendBtnState(originalTabId, payload) {
  const targets = new Set();
  const youtubeTargets = new Set();
  let activeYtTabId = null;
  try {
    const tabs = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
      url: ['*://www.youtube.com/*', '*://m.youtube.com/*'],
    });
    if (tabs[0]?.id != null) {
      targets.add(tabs[0].id);
      youtubeTargets.add(tabs[0].id);
      activeYtTabId = tabs[0].id;
    }
  } catch {}
  if (originalTabId != null) {
    targets.add(originalTabId);
    youtubeTargets.add(originalTabId);
  }
  scBgDbg('sendBtnState.targets', { state: payload.state, vid: payload.videoId, originalTabId, activeYtTabId, targets: [...targets] });
  if (!targets.size) {
    scBgDbg('sendBtnState.NO_TARGETS', { state: payload.state, vid: payload.videoId });
    return {
      attemptedTabIds: [],
      deliveredTabIds: [],
      deliveredYoutubeTabIds: [],
      appliedYoutubeTabIds: [],
    };
  }
  // Дополнительно шлём в AI Studio И claude.ai вкладки — там тоже свои
  // content-script'ы, показывают тот же тост (юзер хочет одинаковую
  // стилистику и факт что вставлено — где бы он ни был).
  if (payload.state === 'pasted' || payload.state === 'done' || payload.state === 'error') {
    try {
      const aiTabs = await chrome.tabs.query({ url: ['*://aistudio.google.com/*', '*://claude.ai/*'] });
      for (const t of aiTabs) if (t.id != null) targets.add(t.id);
    } catch {}
  }
  const results = await Promise.all([...targets].map(tabId => new Promise(resolve => {
    try {
      chrome.tabs.sendMessage(tabId, { __sc_btn_state: true, ...payload }, response => {
        const error = chrome.runtime.lastError;
        if (error) {
          scBgDbg('sendBtnState.DELIVER_FAIL', { tabId, state: payload.state, err: error.message });
          resolve({ tabId, ok: false, applied: false });
        } else {
          const applied = response?.ok === true && !response?.ignored;
          scBgDbg('sendBtnState.DELIVERED', { tabId, state: payload.state, applied });
          resolve({ tabId, ok: true, applied });
        }
      });
    } catch (e) {
      scBgDbg('sendBtnState.THREW', { tabId, err: e?.message || String(e) });
      resolve({ tabId, ok: false, applied: false });
    }
  })));
  const deliveredTabIds = results.filter(item => item.ok).map(item => item.tabId);
  const appliedTabIds = results.filter(item => item.applied).map(item => item.tabId);
  return {
    attemptedTabIds: [...targets],
    deliveredTabIds,
    deliveredYoutubeTabIds: deliveredTabIds.filter(tabId => youtubeTargets.has(tabId)),
    appliedYoutubeTabIds: appliedTabIds.filter(tabId => youtubeTargets.has(tabId)),
  };
}

// Лог в chrome.storage.local — читается из любой вкладки через
// chrome.storage.local.get('__sc_bg_dbg'). MCP не имеет userScripts —
// поэтому не могу прочитать service-worker'овский console.log напрямую,
// а storage'ный вижу через get_text на странице которая мне покажет.
const SC_BG_DBG_KEY = '__sc_bg_dbg';
async function scBgDbg(tag, data) {
  const t = (Date.now() / 1000).toFixed(3);
  const entry = `${t}s [${tag}] ` + (data == null ? '' : (typeof data === 'string' ? data : JSON.stringify(data)));
  try { console.log('[SC-BG-DBG]', entry); } catch {}
  try {
    const got = await new Promise(r => chrome.storage.local.get([SC_BG_DBG_KEY], r));
    const buf = Array.isArray(got[SC_BG_DBG_KEY]) ? got[SC_BG_DBG_KEY] : [];
    buf.push(entry);
    if (buf.length > 200) buf.splice(0, buf.length - 200);
    chrome.storage.local.set({ [SC_BG_DBG_KEY]: buf });
  } catch {}
}

// /yt-status response → state-name на стороне content-script'а. Контракт:
//   yt_stage='searching'      → 'searching'    (🔎 Ищу субтитры…)
//   yt_stage='subs_found'     → 'transcribing' (subs найдены, идёт сохранение)
//   yt_stage='awaiting_ai'    → 'searching'    (между subs_missing и resume —
//                               держим юзера в «ищу/жду», специальной фазы нет)
//   yt_stage='transcribing'   → 'transcribing' с engine (Gemini / AssemblyAI)
//   нет yt_stage              → 'working' (legacy fallback)
function mapStageToBtnState(st) {
  const stage = st.yt_stage || null;
  if (stage === 'transcribing') {
    return { state: 'transcribing', engine: st.yt_engine || 'gemini' };
  }
  if (stage === 'searching' || stage === 'awaiting_ai' || stage === 'subs_found') {
    return { state: 'searching' };
  }
  return { state: 'working' };
}

async function trackJob(job) {
  // job = {
  //   jobId, commentsJobId, url, title, tabId, videoId,
  //   fromCache, cachedFilePath, cachedCommentsFilePath,
  //   autoAistudio, target,
  //   // Gemini-side:
  //   modelTitle, postModelTitle, systemInstruction, postSystemInstruction,
  //   // Claude-side:
  //   claudeModel, claudeProject, claudePostProject, claudeAdaptiveThinking,
  //   // ChatGPT-side:
  //   chatgptPrompt, chatgptShowInTextField, chatgptMode, chatgptModel, chatgptEffort,
  // }
  const map = await loadTracker();
  const target = normalizeYoutubeAiTarget(job.target);
  scBgDbg('trackJob.enter', {
    jobId: job.jobId,
    videoId: job.videoId,
    fromCache: !!job.fromCache,
    autoAistudio: !!job.autoAistudio,
    target,
    chatgptMode: target === 'chatgpt' ? normalizeChatgptMode(job.chatgptMode) : null,
  });

  // fromCache=true → транскрипт уже на диске, поллить нечего. Сразу финал.
  if (job.fromCache) {
    let finalTarget = target;
    let finalChatgptMode = normalizeChatgptMode(job.chatgptMode);
    scBgDbg('trackJob.fromCache', { autoAistudio: !!job.autoAistudio, target });
    if (job.autoAistudio) {
      // job уже получил fresh desktop snapshot в __sc_track_job. Дальше это
      // выбор конкретного видео: смена default во время обработки относится
      // только к следующему клику и не перенаправляет текущий handoff.
      const effectiveJob = job;
      const effectiveTarget = normalizeYoutubeAiTarget(effectiveJob.target);
      finalTarget = effectiveTarget;
      finalChatgptMode = normalizeChatgptMode(effectiveJob.chatgptMode);
      const targetLabel = youtubeAiTargetLabel(effectiveTarget, effectiveJob.chatgptMode);
      sendBtnState(job.tabId, {
        videoId: job.videoId,
        state: 'opening',
        target: effectiveTarget,
        targetLabel,
        chatgptMode: effectiveJob.chatgptMode,
      });
      try {
        const requestId = await openTargetBackground(effectiveTarget, {
          cachedFilePath: job.cachedFilePath,
          cachedCommentsFilePath: job.cachedCommentsFilePath,
          ytTabId: job.tabId, ytVideoId: job.videoId, ytTitle: job.title,
        }, effectiveJob);
        scBgDbg('trackJob.openTarget.OK', {
          target: effectiveTarget,
          targetLabel,
          requestId,
        });
      } catch (e) {
        scBgDbg('trackJob.openTarget.THREW', { target: effectiveTarget, err: e?.message || String(e) });
        sendBtnState(job.tabId, {
          videoId: job.videoId,
          state: 'error',
          target: effectiveTarget,
          targetLabel,
          chatgptMode: effectiveJob.chatgptMode,
          error: 'open ' + targetLabel + ' failed: ' + (e?.message || e),
        });
        return;
      }
      // ChatGPT подтверждает terminal-success отдельным ACK только после
      // принятого Send. До него кнопка остаётся в состоянии «Открываю…».
      if (effectiveTarget === 'chatgpt') return;
    } else {
      scBgDbg('trackJob.SKIP_OPEN', { reason: 'autoAistudio=false' });
    }
    sendBtnState(job.tabId, {
      videoId: job.videoId,
      state: 'done',
      target: finalTarget,
      targetLabel: youtubeAiTargetLabel(finalTarget, finalChatgptMode),
      chatgptMode: finalChatgptMode,
    });
    return;
  }

  // Live job. Кладём в storage и поднимаем alarm — pollTracker дожмёт.
  const key = String(job.jobId);
  map[key] = {
    jobId: job.jobId,
    commentsJobId: job.commentsJobId || null,
    url: job.url,
    videoId: job.videoId || null,
    title: job.title || job.url,
    tabId: job.tabId || null,
    startedAt: Date.now(),
    autoAistudio: !!job.autoAistudio,
    target,
    // Gemini-side
    modelTitle: job.modelTitle || null,
    postModelTitle: job.postModelTitle || '',
    systemInstruction: job.systemInstruction || '',
    postSystemInstruction: job.postSystemInstruction || '',
    // Claude-side
    claudeModel: job.claudeModel || 'Opus 4.7',
    claudeProject: job.claudeProject || '',
    claudePostProject: job.claudePostProject || '',
    claudeAdaptiveThinking: job.claudeAdaptiveThinking !== false,
    // ChatGPT-side
    chatgptPrompt: job.chatgptPrompt || '',
    chatgptShowInTextField: job.chatgptShowInTextField !== false,
    chatgptMode: normalizeChatgptMode(job.chatgptMode),
    chatgptModel: job.chatgptModel || '5.6-sol',
    chatgptEffort: job.chatgptEffort || 'xhigh',
    engine: job.engine || 'gemini',   // для /yt-resume-ai при awaiting_ai
    resumeRequested: false,
    resumeAttempts: 0,
    lastSentState: null,
  };
  await saveTracker(map);

  // Сразу подаём «searching» — bridge принял, sc-desktop сейчас гонит
  // yt-dlp+youtube-transcript-api. Real-time события приходят через
  // long-poll (см. startLongPoll), latency ~0 на смену state'а.
  sendBtnState(job.tabId, {
    videoId: job.videoId,
    state: 'searching',
    target,
    targetLabel: youtubeAiTargetLabel(target, job.chatgptMode),
    chatgptMode: normalizeChatgptMode(job.chatgptMode),
  });

  startLongPoll(job.jobId).catch(() => {});
  // Alarm оставляем как safety-net: если SW убьют посреди long-poll'а,
  // alarm разбудит нас и перезапустит loop. Без него job'ы зависнут
  // когда Chrome подпрыгнет с suspend'а.
  chrome.alarms.get(POLL_ALARM, a => {
    if (!a) chrome.alarms.create(POLL_ALARM, { periodInMinutes: POLL_PERIOD_MIN });
  });
}

// Запоминаем активные long-poll loop'ы, чтобы не плодить дублёров на
// один и тот же jobId при ре-запуске trackJob/onStartup/alarm fallback'е.
const activeLongPolls = new Set();

// Long-poll loop по одному jobId: пока запись в storage жива — фетчим
// /yt-status?wait=25000. Bridge отвечает мгновенно при ЛЮБОМ изменении
// (status/yt_stage/file_path/comments_status), либо через 25 сек если
// ничего не поменялось. Таким образом расширение видит «done» в момент
// когда sc-desktop сохранил файл, а не через 0–6 сек alarm-тика.
async function startLongPoll(jobId) {
  if (activeLongPolls.has(jobId)) return;
  activeLongPolls.add(jobId);
  try {
    while (true) {
      const map = await loadTracker();
      const job = map[String(jobId)];
      if (!job) return;
      if (Date.now() - job.startedAt > TRACKER_TTL_MS) {
        sendBtnState(job.tabId, {
          videoId: job.videoId, state: 'error',
          target: job.target,
          error: 'таймаут (>30 минут без ответа)',
        });
        const m = await loadTracker(); delete m[String(jobId)]; await saveTracker(m);
        return;
      }
      let st;
      try {
        const u = new URL(SC_BRIDGE + '/yt-status');
        u.searchParams.set('id', jobId);
        if (job.commentsJobId) u.searchParams.set('comments_id', job.commentsJobId);
        u.searchParams.set('wait', '25000');
        const r = await fetch(u.toString());
        if (!r.ok) throw new Error('http ' + r.status);
        st = await r.json();
      } catch (e) {
        // sc-desktop недоступен — короткий backoff и повтор.
        await new Promise(res => setTimeout(res, 3000));
        continue;
      }
      const terminal = await processSnapshot(jobId, st);
      if (terminal) return;
    }
  } finally {
    activeLongPolls.delete(jobId);
  }
}

// Обрабатывает один снимок /yt-status. Возвращает true если job'у
// больше не нужно поллить (done/error/таймаут/удалён). Используется
// и long-poll loop'ом, и alarm-fallback'ом.
async function processSnapshot(jobId, st) {
  const map = await loadTracker();
  const key = String(jobId);
  const job = map[key];
  if (!job) return true;

  const transcriptDone = st.status === 'done' && !!st.file_path;
  const commentsExpected = !!job.commentsJobId;
  const commentsDone = !commentsExpected
    ? true
    : st.comments_status === 'done' && !!st.comments_file_path;

  if (st.status === 'error' || st.comments_status === 'error') {
    sendBtnState(job.tabId, {
      videoId: job.videoId, state: 'error',
      target: job.target,
      error: st.error || st.comments_error || 'unknown',
    });
    delete map[key]; await saveTracker(map);
    return true;
  }

  // awaiting_ai → авто-resume через bridge.
  // КРИТИЧНО: латчим resumeRequested ТОЛЬКО при подтверждённом успехе
  // (HTTP ok || 409). Раньше fetch был в пустом `catch {}`, а флаг ставился
  // безусловно следующей строкой — один транзиентный сбой bridge'а (он же
  // «sc-desktop недоступен», штатная ситуация при перезапуске приложения)
  // навсегда блокировал resume: job висел на 'searching' до 30-минутного
  // TRACKER_TTL. awaiting_ai — стабильный статус без живого child, так что
  // tuple long-poll'а не меняется, bridge отвечает только по 25с таймауту,
  // а следующий тик уже видит resumeRequested=true и не ретраит.
  //   ok      → субтитров не было, resume запущен — латчим, готово.
  //   409     → job уже не в awaiting_ai (кто-то resume'нул) — латчим, бессмысленно ретраить.
  //   иначе   → НЕ латчим, следующий long-poll тик (≤25с) ретраит; после
  //             MAX_RESUME_ATTEMPTS отдаём 'error', не ждём 30 минут.
  if (st.status === 'awaiting_ai' && !job.resumeRequested) {
    let ok = false;
    try {
      const r = await fetch(SC_BRIDGE + '/yt-resume-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: job.jobId, engine: job.engine || 'gemini' }),
      });
      ok = r.ok || r.status === 409;
    } catch {}
    if (ok) {
      job.resumeRequested = true;
      map[key] = job;
      await saveTracker(map);
    } else {
      job.resumeAttempts = (job.resumeAttempts || 0) + 1;
      scBgDbg('resume.failed', { jobId: job.jobId, attempt: job.resumeAttempts });
      if (job.resumeAttempts >= MAX_RESUME_ATTEMPTS) {
        sendBtnState(job.tabId, {
          videoId: job.videoId, state: 'error',
          target: job.target,
          error: 'не удалось запустить AI-транскрипцию (sc-desktop недоступен)',
        });
        delete map[key]; await saveTracker(map);
        return true;
      }
      map[key] = job;
      await saveTracker(map);
    }
  }

  // Прогресс — шлём stage, dedup'аем по lastSentState.
  if (!transcriptDone) {
    const stageEvent = mapStageToBtnState(st);
    if (stageEvent && stageEvent.state !== job.lastSentState) {
      sendBtnState(job.tabId, {
        videoId: job.videoId,
        state: stageEvent.state,
        engine: stageEvent.engine || null,
        target: job.target,
        targetLabel: youtubeAiTargetLabel(job.target, job.chatgptMode),
        chatgptMode: normalizeChatgptMode(job.chatgptMode),
      });
      job.lastSentState = stageEvent.state;
      map[key] = job;
      await saveTracker(map);
    }
  }

  if (transcriptDone && commentsDone) {
    let completedTarget = normalizeYoutubeAiTarget(job.aiOpenTarget || job.target);
    let completedChatgptMode = normalizeChatgptMode(job.aiOpenChatgptMode || job.chatgptMode);
    if (job.autoAistudio) {
      // Idempotency-латч ПЕРЕД открытием вкладки. Между open'ом и финальным
      // 'done' SW может быть выгружен и разбужен alarm'ом; тогда он
      // перезапустит long-poll → processSnapshot снова увидит (transcriptDone
      // && commentsDone) и открыл бы ВТОРУЮ вкладку AI. Флаг aiOpenStarted
      // в storage (переживает respin SW) делает второй заход no-op'ом.
      let shouldOpenTarget = !job.aiOpenStarted;
      if (job.aiOpenStarted && completedTarget === 'chatgpt') {
        const composeExists = await hasChatgptComposeRecordForVideo(job.videoId);
        if (!composeExists) {
          // SW мог перезапуститься после latch-save, но до первого compose
          // storage.set. Записи нет — значит вкладка ещё не могла быть открыта,
          // и повтор безопасен.
          shouldOpenTarget = true;
          scBgDbg('tracker.chatgpt_open_latch_recovered', {
            jobId: job.jobId,
            videoId: job.videoId,
          });
        }
      }
      if (shouldOpenTarget) {
        // target/mode/model/effort зафиксированы fresh snapshot'ом в момент
        // __sc_track_job; не перечитываем defaults спустя минуты обработки.
        const effectiveJob = job;
        completedTarget = normalizeYoutubeAiTarget(effectiveJob.target);
        completedChatgptMode = normalizeChatgptMode(effectiveJob.chatgptMode);
        job.aiOpenStarted = true;
        job.aiOpenTarget = completedTarget;
        job.aiOpenChatgptMode = completedChatgptMode;
        map[key] = job;
        await saveTracker(map);

        const targetLabel = youtubeAiTargetLabel(completedTarget, completedChatgptMode);
        sendBtnState(job.tabId, {
          videoId: job.videoId,
          state: 'opening',
          target: completedTarget,
          targetLabel,
          chatgptMode: completedChatgptMode,
        });
        try {
          await openTargetBackground(completedTarget, {
            cachedFilePath: st.file_path,
            cachedCommentsFilePath: commentsExpected ? st.comments_file_path : null,
            ytTabId: job.tabId, ytVideoId: job.videoId, ytTitle: job.title,
          }, effectiveJob);
        } catch (e) {
          sendBtnState(job.tabId, {
            videoId: job.videoId,
            state: 'error',
            target: completedTarget,
            targetLabel,
            chatgptMode: completedChatgptMode,
            error: 'open ' + targetLabel + ' failed',
          });
          // openTargetBackground упал — снимаем латч и удаляем job. storage-
          // запись __sc_aistudio_job_/__sc_claude_job_ пишется ВНУТРИ open'а
          // после tabs.create, так что при throw до неё орфана нет; если же
          // упало после — подчищаем по ytVideoId на всякий случай.
          await cleanupOrphanAiJob(job.videoId);
          delete map[key]; await saveTracker(map);
          return true;
        }
      }
    }
    if (job.autoAistudio && completedTarget === 'chatgpt') {
      scBgDbg('tracker.await_chatgpt_send_ack', {
        jobId: job.jobId,
        videoId: job.videoId,
        mode: completedChatgptMode,
      });
      // Compose payload has its own persistent route. Tracker can stop polling;
      // terminal success/error now comes only from ChatGPT content-script.
      delete map[key]; await saveTracker(map);
      return true;
    }
    sendBtnState(job.tabId, {
      videoId: job.videoId,
      state: 'done',
      target: completedTarget,
      targetLabel: youtubeAiTargetLabel(completedTarget, completedChatgptMode),
      chatgptMode: completedChatgptMode,
    });
    delete map[key]; await saveTracker(map);
    return true;
  }
  return false;
}

// Подчищает осиротевшие __sc_aistudio_job_* / __sc_claude_job_* записи для
// данного videoId — на случай если openTargetBackground успел записать
// payload в storage, но затем упал (или вкладку закрыли до autoscrape).
// Без этого запись висит в storage.local вечно (autoscrape её удаляет
// только когда реально отработал в открытой вкладке).
async function cleanupOrphanAiJob(videoId) {
  if (!videoId) return;
  try {
    const all = await chrome.storage.local.get(null);
    const stale = Object.keys(all).filter(k =>
      (k.startsWith('__sc_aistudio_job_') || k.startsWith('__sc_claude_job_') || k.startsWith(CHATGPT_COMPOSE_JOB_PREFIX)) &&
      all[k] && all[k].ytVideoId === videoId
    );
    if (stale.length) await chrome.storage.local.remove(stale);
  } catch {}
}

// Alarm-fallback. Long-poll работает мгновенно, но если SW заснул и
// проснулся не сам, а по alarm'у — нужен старт цикла для каждого
// pending job'а. Сам alarm НЕ обрабатывает снимки, только пинает loop'ы.
async function pollTracker() {
  const map = await loadTracker();
  const ids = Object.keys(map);
  if (ids.length === 0) {
    chrome.alarms.clear(POLL_ALARM);
    return;
  }
  for (const key of ids) {
    const job = map[key];
    if (!job) continue;
    startLongPoll(job.jobId).catch(() => {});
  }
}

chrome.alarms.onAlarm.addListener(a => {
  if (a.name === POLL_ALARM) pollTracker().catch(e => console.warn('[SC-BG] poll failed', e));
});

// На стартe SW проверяем — есть ли висящие job'ы в storage. Если да —
// (1) поднимаем alarm-fallback и (2) сразу стартуем long-poll loop'ы,
// чтобы не ждать первого alarm-тика. Это покрывает случай когда SW
// заснул, а юзер уже закрыл popup и не общается с background'ом.
chrome.runtime.onStartup.addListener(async () => {
  const map = await loadTracker();
  const ids = Object.keys(map);
  if (!ids.length) return;
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: POLL_PERIOD_MIN });
  for (const k of ids) {
    const j = map[k];
    if (j) startLongPoll(j.jobId).catch(() => {});
  }
});
// Тот же путь при горячей перезагрузке расширения.
loadTracker().then(map => {
  const ids = Object.keys(map);
  if (!ids.length) return;
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: POLL_PERIOD_MIN });
  for (const k of ids) {
    const j = map[k];
    if (j) startLongPoll(j.jobId).catch(() => {});
  }
}).catch(() => {});

console.log('SC Browser Parser background service worker loaded');
