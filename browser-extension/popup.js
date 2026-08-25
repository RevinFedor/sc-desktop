// SC Browser Parser — Popup
//
// Раньше popup показывал только панель активного сайта. Теперь настройки
// экспорта собраны в tabs (Gemini Studio / Perplexity / Claude / ChatGPT), а YouTube
// flow живёт отдельным блоком ниже. Активный сайт подсвечивается.
// Кнопка «Экспортировать» работает только когда вкладка — AI Studio,
// Perplexity, Claude или ChatGPT (для них нужно указать tab куда слать сообщение). YouTube
// настройки применяются content-script'ом youtube.js на каждой YouTube
// странице независимо от того, открыт ли popup.

// Force-reload hatch — открыв popup с URL'ом `popup.html?reload=1` или
// `?reload=<token>` вызовет chrome.runtime.reload() сразу до инициализации
// остального UI. Используется для programmatic reload расширения (когда
// SW polling не сработал) — Claude / MCP открывает эту страницу через
// chrome.tabs.create или navigate, расширение перезагружается, content-scripts
// перезаливаются на всех YouTube/aistudio/claude вкладках при следующем navigate/F5.
//
// Идемпотентность: после reload расширения popup'у contextInvalid'нется,
// reload-вызов не повторится бесконечно.
const SC_EXTENSION_ID = 'phnlfhkblebijojjnnlbcbklijgcijgf';

(function () {
  try {
    const params = new URLSearchParams(location.search);
    if (params.has('reload')) {
      // Лог в storage чтобы детерминированно подтвердить что reload был
      // вызван (потом content-script на YT-вкладке прочитает из dbg).
      chrome.storage.local.set({ __sc_last_force_reload: Date.now() }, () => {
        chrome.runtime.reload();
      });
    }
  } catch (e) {
    // Тихо — если что-то не так с params, обычный popup всё равно загрузится.
  }
})();

document.addEventListener('DOMContentLoaded', async () => {
  const exportBtn   = document.getElementById('exportBtn');
  const statusDiv   = document.getElementById('status');
  const statusText  = document.getElementById('statusText');
  const btnText     = document.getElementById('btnText');
  const messageDiv  = document.getElementById('message');
  const formatIcon  = document.getElementById('formatIcon');
  const formatText  = document.getElementById('formatText');
  const appTitle    = document.getElementById('appTitle');
  const openVocabulary = document.getElementById('openVocabulary');

  openVocabulary?.addEventListener('click', () => {
    chrome.runtime.openOptionsPage(() => window.close());
  });

  const titleYoutube    = document.getElementById('titleYoutube');

  const exportTabs = {
    aistudio:   document.getElementById('tabAistudio'),
    perplexity: document.getElementById('tabPerplexity'),
    claude:     document.getElementById('tabClaude'),
    chatgpt:    document.getElementById('tabChatgpt'),
  };
  const exportPanels = {
    aistudio:   document.getElementById('settingsAistudio'),
    perplexity: document.getElementById('settingsPerplexity'),
    claude:     document.getElementById('settingsClaude'),
    chatgpt:    document.getElementById('settingsChatgpt'),
  };
  let currentExportTab = 'aistudio';

  const exportInputs = {
    downloadFile: document.getElementById('export_download_file'),
  };

  // ── AI Studio settings inputs ──────────────────────────────────────────
  const aistudioInputs = {
    scrapeImages:            document.getElementById('scrapeImages'),
    scrapeAttachments:       document.getElementById('scrapeAttachments'),
    scrapeAttachmentTitle:   document.getElementById('scrapeAttachmentTitle'),
    scrapeAttachmentSize:    document.getElementById('scrapeAttachmentSize'),
    scrapeAttachmentPreview: document.getElementById('scrapeAttachmentPreview'),
    scrapeReasoning:         document.getElementById('scrapeReasoning'),
  };
  const attachmentsExpand = document.getElementById('attachmentsExpand');
  const attachmentSubs = document.getElementById('attachmentSubs');

  // ── Perplexity settings inputs ─────────────────────────────────────────
  const perplexityInputs = {
    show_sources: document.getElementById('show_sources'),
    show_related: document.getElementById('show_related'),
  };

  // ── Claude export settings inputs ──────────────────────────────────────
  const claudeInputs = {
    includeReattachedFiles: document.getElementById('claude_include_reattached'),
  };

  // ── ChatGPT export settings inputs ────────────────────────────────────
  const chatgptInputs = {
    includeReasoning:      document.getElementById('chatgpt_include_reasoning'),
    includeSources:        document.getElementById('chatgpt_include_sources'),
    includeSourceActivity: document.getElementById('chatgpt_include_source_activity'),
    includeImages:         document.getElementById('chatgpt_include_images'),
  };

  // ── YouTube settings inputs ────────────────────────────────────────────
  // auto_aistudio убран из popup'а: теперь управление copy / copy+AI идёт
  // через split-button на самой YouTube-карточке (см. youtube-content.js
  // makeSplitFabPill). В storage поле остаётся (legacy), но всегда false.
  const ytInputs = {
    with_comments:               document.getElementById('yt_with_comments'),
    // Gemini-side
    system_instruction:          document.getElementById('yt_system_instruction'),
    post_system_instruction:     document.getElementById('yt_post_system_instruction'),
    model_title:                 document.getElementById('yt_model_title'),
    post_model_title:            document.getElementById('yt_post_model_title'),
    // Claude-side
    claude_project:              document.getElementById('yt_claude_project'),
    claude_post_project:         document.getElementById('yt_claude_post_project'),
    claude_model:                document.getElementById('yt_claude_model'),
    claude_adaptive_thinking:    document.getElementById('yt_claude_adaptive_thinking'),
    // ChatGPT-side
    chatgpt_prompt:              document.getElementById('yt_chatgpt_prompt'),
    chatgpt_show_in_text_field:  document.getElementById('yt_chatgpt_show_in_text_field'),
    chatgpt_model:               document.getElementById('yt_chatgpt_model'),
    chatgpt_effort:              document.getElementById('yt_chatgpt_effort'),
    chatgpt_speed:               document.getElementById('yt_chatgpt_speed'),
  };
  const ytChatgptSpeedRow = document.getElementById('yt_chatgpt_speed_row');
  const ytChatgptModeButtons = {
    chat: document.getElementById('yt_chatgpt_mode_chat'),
    work: document.getElementById('yt_chatgpt_mode_work'),
  };
  const ytTargetSelect = document.getElementById('yt_target');
  const ytCards = {
    aistudio: document.getElementById('cardAistudio'),
    claude:   document.getElementById('cardClaude'),
    chatgpt:  document.getElementById('cardChatgpt'),
  };
  let currentTarget = 'aistudio'; // active target (Gemini по умолчанию)
  let currentChatgptMode = 'chat';
  let youtubeState = sanitizeYoutubeSettings(YOUTUBE_DEFAULT_SETTINGS);
  let lastPersistedYoutubeState = youtubeState;
  let pendingDesktopPatch = {};
  let youtubeBridgeIncompatible = false;

  for (const target of YOUTUBE_TARGETS) {
    const opt = document.createElement('option');
    opt.value = target;
    opt.textContent = YOUTUBE_TARGET_LABELS[target] || target;
    ytTargetSelect.appendChild(opt);
  }

  // Заполняем Gemini select'ы. Список — единая константа из settings.js.
  for (const m of YOUTUBE_AVAILABLE_MODELS) {
    const optInit = document.createElement('option');
    optInit.value = m; optInit.textContent = m;
    ytInputs.model_title.appendChild(optInit);

    const optPost = document.createElement('option');
    optPost.value = m; optPost.textContent = m;
    ytInputs.post_model_title.appendChild(optPost);
  }
  // «Не менять» для post-model
  const optNoChange = document.createElement('option');
  optNoChange.value = '';
  optNoChange.textContent = 'Не менять модель';
  ytInputs.post_model_title.insertBefore(optNoChange, ytInputs.post_model_title.firstChild);

  // Заполняем Claude select. Без «Не менять» (Claude не переключает модель
  // mid-chat, только для следующих чатов).
  for (const m of CLAUDE_AVAILABLE_MODELS) {
    const opt = document.createElement('option');
    opt.value = m; opt.textContent = m;
    ytInputs.claude_model.appendChild(opt);
  }
  function replaceChatgptOptions(select, options, value) {
    select.replaceChildren();
    for (const item of options) {
      const opt = document.createElement('option');
      opt.value = item.id; opt.textContent = item.label;
      select.appendChild(opt);
    }
    select.value = value;
  }

  function renderVisibleChatgptPair() {
    const mode = CHATGPT_MODES.includes(currentChatgptMode) ? currentChatgptMode : 'chat';
    const modelKey = `chatgpt_${mode}_model`;
    const effortKey = `chatgpt_${mode}_effort`;
    const models = chatgptModelsForMode(mode);
    const model = models.some(m => m.id === youtubeState[modelKey]) ? youtubeState[modelKey] : '5.6-sol';
    const efforts = chatgptEffortsFor(mode, model);
    const effort = efforts.some(e => e.id === youtubeState[effortKey])
      ? youtubeState[effortKey]
      : defaultChatgptEffort(mode, model);
    replaceChatgptOptions(ytInputs.chatgpt_model, models, model);
    replaceChatgptOptions(ytInputs.chatgpt_effort, efforts, effort);
    ytChatgptSpeedRow.hidden = mode !== 'work';
    if (mode === 'work') {
      replaceChatgptOptions(
        ytInputs.chatgpt_speed,
        CHATGPT_WORK_SPEEDS,
        youtubeState.chatgpt_work_speed || 'standard',
      );
    }
  }

  function saveVisibleChatgptPair() {
    if (!CHATGPT_MODES.includes(currentChatgptMode)) return;
    youtubeState = sanitizeYoutubeSettings({
      ...youtubeState,
      chatgpt_mode: currentChatgptMode,
      [`chatgpt_${currentChatgptMode}_model`]: String(ytInputs.chatgpt_model.value || ''),
      [`chatgpt_${currentChatgptMode}_effort`]: String(ytInputs.chatgpt_effort.value || ''),
      ...(currentChatgptMode === 'work'
        ? { chatgpt_work_speed: String(ytInputs.chatgpt_speed.value || 'standard') }
        : {}),
    });
  }

  function applyChatgptMode(mode, { captureCurrent = true } = {}) {
    const nextMode = CHATGPT_MODES.includes(mode) ? mode : 'chat';
    if (captureCurrent) saveVisibleChatgptPair();
    currentChatgptMode = nextMode;
    youtubeState = sanitizeYoutubeSettings({ ...youtubeState, chatgpt_mode: nextMode });
    for (const [id, btn] of Object.entries(ytChatgptModeButtons)) {
      btn.setAttribute('aria-checked', String(id === nextMode));
    }
    renderVisibleChatgptPair();
  }

  for (const [mode, btn] of Object.entries(ytChatgptModeButtons)) {
    btn.addEventListener('click', () => {
      if (mode === currentChatgptMode) return;
      const previousState = youtubeState;
      applyChatgptMode(mode);
      persistYoutube({ previousState });
    });
  }

  function applyTargetUi(target) {
    currentTarget = YOUTUBE_TARGETS.includes(target) ? target : 'aistudio';
    ytTargetSelect.value = currentTarget;
    for (const [id, card] of Object.entries(ytCards)) {
      const active = id === currentTarget;
      card.hidden = !active;
      card.classList.toggle('active', active);
    }
  }
  ytTargetSelect.addEventListener('change', () => {
    applyTargetUi(ytTargetSelect.value);
    persistYoutube();
    updateFormatHint();
  });

  let currentSite = null; // 'aistudio' | 'perplexity' | 'claude' | 'chatgpt' | 'youtube' | null
  let currentTab = null;

  function storageSetSync(payload) {
    return new Promise(resolve => chrome.storage.sync.set(payload, resolve));
  }

  function storageLocalGet(defaults) {
    return new Promise(resolve => chrome.storage.local.get(defaults, resolve));
  }

  function storageLocalSet(payload) {
    return new Promise(resolve => chrome.storage.local.set(payload, resolve));
  }

  async function savePendingDesktopPatch() {
    await storageLocalSet({ __sc_yt_pending_desktop_patch: { ...pendingDesktopPatch } });
  }

  async function clearSentPendingDesktopPatch(sentPatch) {
    if (!sentPatch || !Object.keys(sentPatch).length) return { ...pendingDesktopPatch };
    const raw = await storageLocalGet({ __sc_yt_pending_desktop_patch: {} });
    const current = raw.__sc_yt_pending_desktop_patch
      && typeof raw.__sc_yt_pending_desktop_patch === 'object'
      ? { ...raw.__sc_yt_pending_desktop_patch }
      : {};
    for (const [key, value] of Object.entries(sentPatch)) {
      if (current[key] === value) delete current[key];
    }
    await storageLocalSet({ __sc_yt_pending_desktop_patch: current });
    return current;
  }

  async function fetchBridgeJson(path, init = {}, timeoutMs = 1800) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch('http://127.0.0.1:53127' + path, {
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

  async function postYoutubeSettingsPatch(patch) {
    const data = await fetchBridgeJson('/extension-settings/youtube', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patch }),
    });
    if (data?.ok !== true || !data.settings || typeof data.settings !== 'object') {
      throw new Error('desktop returned no YouTube settings');
    }
    return sanitizeYoutubeSettings({ ...youtubeState, ...data.settings });
  }

  // Desktop settings are canonical after the first bootstrap. On an older
  // install the desktop block is absent while chrome.storage already contains
  // the user's real values; initialized=false means upload local first.
  async function syncYoutubeSettingsFromBridge(localSettings) {
    try {
      const data = await fetchBridgeJson('/extension-settings/youtube');
      const schemaVersion = Number(data?.schemaVersion);
      if (Number.isFinite(schemaVersion) && schemaVersion > YOUTUBE_SETTINGS_SCHEMA_VERSION) {
        const error = new Error(`YouTube settings schema ${schemaVersion} is newer than extension schema ${YOUTUBE_SETTINGS_SCHEMA_VERSION}`);
        error.incompatible = true;
        throw error;
      }
      if (data?.initialized === false) {
        const bootstrap = { ...localSettings };
        if (Array.isArray(data.dirty_keys) && data.settings && typeof data.settings === 'object') {
          for (const key of data.dirty_keys) {
            if (Object.prototype.hasOwnProperty.call(data.settings, key)) bootstrap[key] = data.settings[key];
          }
        }
        const sentPending = { ...pendingDesktopPatch };
        const bootstrapped = await postYoutubeSettingsPatch(bootstrap);
        const currentPending = await clearSentPendingDesktopPatch(sentPending);
        for (const [key, value] of Object.entries(sentPending)) {
          if (pendingDesktopPatch[key] === value) delete pendingDesktopPatch[key];
        }
        pendingDesktopPatch = { ...pendingDesktopPatch, ...currentPending };
        return sanitizeYoutubeSettings({
          ...localSettings,
          ...bootstrapped,
          ...pendingDesktopPatch,
        });
      }
      if (data?.initialized === true && data.settings && typeof data.settings === 'object') {
        if (Object.keys(pendingDesktopPatch).length) {
          const sentPending = { ...pendingDesktopPatch };
          const synced = await postYoutubeSettingsPatch(sentPending);
          const currentPending = await clearSentPendingDesktopPatch(sentPending);
          for (const [key, value] of Object.entries(sentPending)) {
            if (pendingDesktopPatch[key] === value) delete pendingDesktopPatch[key];
          }
          pendingDesktopPatch = { ...pendingDesktopPatch, ...currentPending };
          return sanitizeYoutubeSettings({
            ...localSettings,
            ...data.settings,
            ...synced,
            ...pendingDesktopPatch,
          });
        }
        return sanitizeYoutubeSettings({ ...localSettings, ...data.settings });
      }
    } catch (error) {
      if (error?.incompatible) youtubeBridgeIncompatible = true;
      console.warn('[SC-Popup] YouTube settings bridge unavailable:', error?.message || String(error));
    }
    // Неподтверждённые desktop-изменения побеждают remote/default и
    // переживают закрытие popup в chrome.storage.local.
    return sanitizeYoutubeSettings({ ...localSettings, ...pendingDesktopPatch });
  }

  function applyExportTab(tab) {
    currentExportTab = ['aistudio', 'perplexity', 'claude', 'chatgpt'].includes(tab) ? tab : 'aistudio';
    for (const [id, btn] of Object.entries(exportTabs)) {
      const active = id === currentExportTab;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', String(active));
    }
    for (const [id, panel] of Object.entries(exportPanels)) {
      panel.hidden = id !== currentExportTab;
    }
    updateFormatHint();
  }

  exportTabs.aistudio.addEventListener('click', () => applyExportTab('aistudio'));
  exportTabs.perplexity.addEventListener('click', () => applyExportTab('perplexity'));
  exportTabs.claude.addEventListener('click', () => applyExportTab('claude'));
  exportTabs.chatgpt.addEventListener('click', () => applyExportTab('chatgpt'));

  function readAistudioSettings() {
    const s = {};
    for (const [k, el] of Object.entries(aistudioInputs)) s[k] = !!el.checked;
    return s;
  }
  function readExportSettings() {
    return {
      downloadFile: !!exportInputs.downloadFile.checked,
    };
  }
  function readPerplexitySettings() {
    const s = {};
    for (const [k, el] of Object.entries(perplexityInputs)) s[k] = !!el.checked;
    return s;
  }
  function readClaudeSettings() {
    return {
      includeReattachedFiles: !!claudeInputs.includeReattachedFiles.checked,
    };
  }
  function readChatGPTSettings() {
    const s = {};
    for (const [k, el] of Object.entries(chatgptInputs)) s[k] = !!el.checked;
    return s;
  }
  function readYoutubeSettings() {
    return sanitizeYoutubeSettings({
      ...youtubeState,
      auto_aistudio:            false, // legacy
      with_comments:            !!ytInputs.with_comments.checked,
      target:                   currentTarget,
      // Gemini-side
      system_instruction:       String(ytInputs.system_instruction.value || ''),
      post_system_instruction:  String(ytInputs.post_system_instruction.value || ''),
      model_title:              String(ytInputs.model_title.value || ''),
      post_model_title:         String(ytInputs.post_model_title.value || ''),
      // Claude-side
      claude_project:           String(ytInputs.claude_project.value || ''),
      claude_post_project:      String(ytInputs.claude_post_project.value || ''),
      claude_model:             String(ytInputs.claude_model.value || ''),
      claude_adaptive_thinking: !!ytInputs.claude_adaptive_thinking.checked,
      // ChatGPT-side
      chatgpt_prompt:           String(ytInputs.chatgpt_prompt.value || ''),
      chatgpt_show_in_text_field: !!ytInputs.chatgpt_show_in_text_field.checked,
      chatgpt_mode:             currentChatgptMode,
      [`chatgpt_${currentChatgptMode}_model`]: String(ytInputs.chatgpt_model.value || ''),
      [`chatgpt_${currentChatgptMode}_effort`]: String(ytInputs.chatgpt_effort.value || ''),
      ...(currentChatgptMode === 'work'
        ? { chatgpt_work_speed: String(ytInputs.chatgpt_speed.value || 'standard') }
        : {}),
    });
  }

  // Format hint depends on site & settings
  function updateFormatHint() {
    const hintSite = (currentSite === 'aistudio' || currentSite === 'perplexity' || currentSite === 'claude' || currentSite === 'chatgpt')
      ? currentSite
      : (currentSite || currentExportTab);
    const exportSettings = readExportSettings();
    if (hintSite === 'aistudio') {
      const s = readAistudioSettings();
      const willCarryBinary = s.scrapeImages || (s.scrapeAttachments && s.scrapeAttachmentPreview);
      if (willCarryBinary) {
        formatIcon.textContent = '🗜️';
        formatText.textContent = 'Если найдутся картинки: скачается ZIP; иначе markdown ' +
          (exportSettings.downloadFile ? 'файлом' : 'в буфер обмена');
      } else {
        formatIcon.textContent = exportSettings.downloadFile ? '📄' : '⧉';
        formatText.textContent = exportSettings.downloadFile
          ? 'Скачается: одиночный markdown-файл'
          : 'Скопируется: markdown в буфер обмена';
      }
    } else if (hintSite === 'perplexity') {
      formatIcon.textContent = exportSettings.downloadFile ? '📄' : '⧉';
      formatText.textContent = exportSettings.downloadFile
        ? 'Скачается: markdown через /rest/thread API'
        : 'Скопируется: markdown через /rest/thread API';
    } else if (hintSite === 'claude') {
      formatIcon.textContent = exportSettings.downloadFile ? '📄' : '⧉';
      const delivery = exportSettings.downloadFile ? 'Скачается' : 'Скопируется';
      formatText.textContent = readClaudeSettings().includeReattachedFiles
        ? `${delivery}: markdown с текстом диалога и файловыми preview`
        : `${delivery}: markdown без файловых карточек Claude`;
    } else if (hintSite === 'chatgpt') {
      formatIcon.textContent = exportSettings.downloadFile ? '📄' : '⧉';
      const delivery = exportSettings.downloadFile ? 'Скачается' : 'Скопируется';
      const s = readChatGPTSettings();
      const extras = [
        s.includeSources ? 'источниками' : '',
        s.includeReasoning ? 'рассуждениями' : '',
        s.includeImages ? 'картинками-ссылками' : '',
      ].filter(Boolean).join(', ');
      formatText.textContent = extras
        ? `${delivery}: markdown с ${extras}`
        : `${delivery}: только текст диалога ChatGPT`;
    } else if (hintSite === 'youtube') {
      formatIcon.textContent = '⬇';
      formatText.textContent = 'Split-кнопка: copy / ai на карточке плеера';
    } else {
      formatIcon.textContent = 'ℹ️';
      formatText.textContent = 'Настройки видны для всех сайтов сразу';
    }
  }

  // Sub-options in AI Studio (Вложения collapsible group)
  function reflectAttachmentsState() {
    const enabled = aistudioInputs.scrapeAttachments.checked;
    for (const k of ['scrapeAttachmentTitle', 'scrapeAttachmentSize', 'scrapeAttachmentPreview']) {
      aistudioInputs[k].disabled = !enabled;
    }
    attachmentSubs.classList.toggle('disabled', !enabled);
    attachmentsExpand.disabled = !enabled;
    if (!enabled) {
      attachmentSubs.classList.add('collapsed');
      attachmentsExpand.classList.remove('expanded');
      attachmentsExpand.setAttribute('aria-expanded', 'false');
    }
  }

  attachmentsExpand.addEventListener('click', () => {
    if (attachmentsExpand.disabled) return;
    const willOpen = attachmentSubs.classList.contains('collapsed');
    attachmentSubs.classList.toggle('collapsed', !willOpen);
    attachmentsExpand.classList.toggle('expanded', willOpen);
    attachmentsExpand.setAttribute('aria-expanded', String(willOpen));
  });

  for (const el of Object.values(exportInputs)) {
    el.addEventListener('change', () => {
      chrome.storage.sync.set({
        __export: sanitizeExportSettings(readExportSettings()),
      });
      updateFormatHint();
    });
  }

  // Live-save AI Studio settings
  for (const el of Object.values(aistudioInputs)) {
    el.addEventListener('change', () => {
      reflectAttachmentsState();
      chrome.storage.sync.set(sanitizeSettings(readAistudioSettings()));
      updateFormatHint();
    });
  }
  // Live-save Perplexity settings (different storage key)
  for (const el of Object.values(perplexityInputs)) {
    el.addEventListener('change', () => {
      chrome.storage.sync.set({
        __pplx: sanitizePerplexitySettings(readPerplexitySettings()),
      });
      updateFormatHint();
    });
  }
  for (const el of Object.values(claudeInputs)) {
    el.addEventListener('change', () => {
      chrome.storage.sync.set({
        __claude: sanitizeClaudeExportSettings(readClaudeSettings()),
      });
      updateFormatHint();
    });
  }
  for (const el of Object.values(chatgptInputs)) {
    el.addEventListener('change', () => {
      chrome.storage.sync.set({
        __chatgpt: sanitizeChatGPTExportSettings(readChatGPTSettings()),
      });
      updateFormatHint();
    });
  }
  // Live-save YouTube settings — input для textarea, change для switch'ей.
  // Debounce ввода в textarea на 300ms чтоб не спамить storage на каждый
  // символ (chrome.storage.sync лимитит на ~120 операций/мин).
  let ytSaveTimer = null;
  let ytPersistRevision = 0;
  function persistYoutube({ syncNow = true, previousState = youtubeState } = {}) {
    const revision = ++ytPersistRevision;
    const previous = previousState;
    const immediate = readYoutubeSettings();
    // Записываем не только отличия от последнего desktop snapshot, а каждое
    // реально изменённое сейчас поле. Иначе быстрый A → B → A оставляет в
    // pending старое B: второй diff относительно desktop-A пустой и не
    // перекрывает промежуточное значение.
    const touchedNow = diffYoutubeSettings(previous, immediate);
    for (const key of Object.keys(touchedNow)) pendingDesktopPatch[key] = immediate[key];
    youtubeState = immediate;
    // Popup может закрыться сразу после клика. Pending local создаётся в тот
    // же event-turn; debounce ниже относится только к bridge POST.
    savePendingDesktopPatch().catch(() => {});
    if (syncNow) storageSetSync({ __yt: immediate }).catch(() => {});
    clearTimeout(ytSaveTimer);
    ytSaveTimer = setTimeout(async () => {
      const next = readYoutubeSettings();
      const changed = diffYoutubeSettings(lastPersistedYoutubeState, next);
      Object.assign(pendingDesktopPatch, changed);
      youtubeState = next;
      await storageSetSync({ __yt: next });
      await savePendingDesktopPatch();
      if (!Object.keys(pendingDesktopPatch).length) return;
      if (youtubeBridgeIncompatible) return;
      const sentPatch = { ...pendingDesktopPatch };
      try {
        const data = await fetchBridgeJson('/extension-settings/youtube', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ patch: sentPatch }),
        });
        if (!data?.settings) throw new Error('desktop returned no settings');
        for (const [key, value] of Object.entries(sentPatch)) {
          if (pendingDesktopPatch[key] === value) delete pendingDesktopPatch[key];
        }
        const currentPending = await clearSentPendingDesktopPatch(sentPatch);
        pendingDesktopPatch = { ...pendingDesktopPatch, ...currentPending };
        lastPersistedYoutubeState = sanitizeYoutubeSettings(data.settings);
        if (revision === ytPersistRevision) {
          const canonical = sanitizeYoutubeSettings({
            ...lastPersistedYoutubeState,
            ...pendingDesktopPatch,
          });
          youtubeState = canonical;
          await storageSetSync({ __yt: canonical });
        }
      } catch (error) {
        if (error?.incompatible) youtubeBridgeIncompatible = true;
        console.warn('[SC-Popup] YouTube settings save to desktop failed:', error?.message || String(error));
        // Пока popup открыт, повторяем. После закрытия pending остаётся в
        // storage.local и будет отправлен перед следующим GET-merge.
        if (!youtubeBridgeIncompatible && revision === ytPersistRevision) setTimeout(() => persistYoutube(), 1800);
      }
    }, 300);
  }
  ytInputs.with_comments.addEventListener('change', () => { persistYoutube(); updateFormatHint(); });
  ytInputs.system_instruction.addEventListener('input', () => { persistYoutube({ syncNow: false }); });
  ytInputs.post_system_instruction.addEventListener('input', () => { persistYoutube({ syncNow: false }); });
  ytInputs.model_title.addEventListener('change', () => { persistYoutube(); });
  ytInputs.post_model_title.addEventListener('change', () => { persistYoutube(); });
  ytInputs.claude_project.addEventListener('input', () => { persistYoutube({ syncNow: false }); });
  ytInputs.claude_post_project.addEventListener('input', () => { persistYoutube({ syncNow: false }); });
  ytInputs.claude_model.addEventListener('change', () => { persistYoutube(); });
  ytInputs.claude_adaptive_thinking.addEventListener('change', () => { persistYoutube(); });
  ytInputs.chatgpt_prompt.addEventListener('input', () => { persistYoutube({ syncNow: false }); });
  ytInputs.chatgpt_show_in_text_field.addEventListener('change', () => { persistYoutube(); });
  ytInputs.chatgpt_model.addEventListener('change', () => {
    const previousState = youtubeState;
    const modelKey = `chatgpt_${currentChatgptMode}_model`;
    const effortKey = `chatgpt_${currentChatgptMode}_effort`;
    const model = String(ytInputs.chatgpt_model.value || '');
    const availableEfforts = chatgptEffortsFor(currentChatgptMode, model);
    const effort = availableEfforts.some(item => item.id === youtubeState[effortKey])
      ? youtubeState[effortKey]
      : defaultChatgptEffort(currentChatgptMode, model);
    youtubeState = sanitizeYoutubeSettings({
      ...youtubeState,
      [modelKey]: model,
      [effortKey]: effort,
    });
    renderVisibleChatgptPair();
    persistYoutube({ previousState });
  });
  ytInputs.chatgpt_effort.addEventListener('change', () => { persistYoutube(); });
  ytInputs.chatgpt_speed.addEventListener('change', () => { persistYoutube(); });

  async function loadSettings() {
    const raw = await new Promise(resolve => chrome.storage.sync.get({
      ...AI_STUDIO_DEFAULT_SETTINGS,
      __export: EXPORT_DEFAULT_SETTINGS,
      __pplx: PERPLEXITY_DEFAULT_SETTINGS,
      __claude: CLAUDE_EXPORT_DEFAULT_SETTINGS,
      __chatgpt: CHATGPT_EXPORT_DEFAULT_SETTINGS,
      __yt: YOUTUBE_DEFAULT_SETTINGS,
    }, resolve));

    const e = sanitizeExportSettings(raw.__export || {});
    exportInputs.downloadFile.checked = e.downloadFile;

    const s = sanitizeSettings(raw);
    for (const [k, el] of Object.entries(aistudioInputs)) el.checked = !!s[k];
    reflectAttachmentsState();

    const p = sanitizePerplexitySettings(raw.__pplx || {});
    for (const [k, el] of Object.entries(perplexityInputs)) el.checked = !!p[k];

    const c = sanitizeClaudeExportSettings(raw.__claude || {});
    claudeInputs.includeReattachedFiles.checked = c.includeReattachedFiles;

    const g = sanitizeChatGPTExportSettings(raw.__chatgpt || {});
    for (const [k, el] of Object.entries(chatgptInputs)) el.checked = !!g[k];

    const pendingRaw = await storageLocalGet({ __sc_yt_pending_desktop_patch: {} });
    pendingDesktopPatch = pendingRaw.__sc_yt_pending_desktop_patch
      && typeof pendingRaw.__sc_yt_pending_desktop_patch === 'object'
      ? pendingRaw.__sc_yt_pending_desktop_patch
      : {};
    const localYoutube = sanitizeYoutubeSettings({
      ...(raw.__yt || {}),
      ...pendingDesktopPatch,
    });
    const y = await syncYoutubeSettingsFromBridge(localYoutube);
    youtubeState = y;
    lastPersistedYoutubeState = y;
    await storageSetSync({ __yt: y });

    ytInputs.with_comments.checked              = y.with_comments;
    ytInputs.system_instruction.value           = y.system_instruction;
    ytInputs.post_system_instruction.value      = y.post_system_instruction;
    ytInputs.model_title.value                  = y.model_title;
    ytInputs.post_model_title.value             = y.post_model_title;
    ytInputs.claude_project.value               = y.claude_project;
    ytInputs.claude_post_project.value          = y.claude_post_project;
    ytInputs.claude_model.value                 = y.claude_model;
    ytInputs.claude_adaptive_thinking.checked   = y.claude_adaptive_thinking;
    ytInputs.chatgpt_prompt.value               = y.chatgpt_prompt;
    ytInputs.chatgpt_show_in_text_field.checked = y.chatgpt_show_in_text_field;
    applyChatgptMode(y.chatgpt_mode, { captureCurrent: false });
    applyTargetUi(y.target);
    applyExportTab(currentExportTab);
    updateFormatHint();
    if (Object.keys(pendingDesktopPatch).length) setTimeout(() => persistYoutube(), 0);
  }

  // ── UI state ───────────────────────────────────────────────────────────
  const showMessage = (type, text) => {
    messageDiv.className = `message ${type}`;
    messageDiv.textContent = text;
    messageDiv.style.display = 'block';
  };

  const updateStatus = (active, text, type = 'default') => {
    statusDiv.className = active ? 'status active' : 'status inactive';
    statusText.textContent = text;
    const iconSpan = statusDiv.querySelector('.status-icon');
    if (type === 'exporting') iconSpan.textContent = '⏳';
    else if (type === 'ready') iconSpan.textContent = '✓';
    else if (type === 'error') iconSpan.textContent = '⚠';
    else iconSpan.textContent = active ? '✓' : '⚠';
  };

  const setLoading = (loading, isExporting = false) => {
    if (loading) {
      if (isExporting) {
        exportBtn.classList.add('stop-mode');
        exportBtn.classList.remove('loading');
        exportBtn.disabled = false;
        btnText.innerHTML = '🛑 Остановить';
      } else {
        exportBtn.classList.add('loading');
        exportBtn.classList.remove('stop-mode');
        exportBtn.disabled = true;
        btnText.innerHTML = '<span class="spinner"></span> Запуск...';
      }
    } else {
      exportBtn.classList.remove('loading', 'stop-mode');
      exportBtn.disabled = false;
      btnText.innerHTML = 'Экспортировать';
    }
  };

  // Подсвечивает активный сайт и при переходе на экспортируемый домен
  // автоматически открывает соответствующий tab настроек.
  function applySite(site) {
    currentSite = site;
    titleYoutube.classList.toggle('active', site === 'youtube');
    exportTabs.aistudio.classList.toggle('site-active', site === 'aistudio');
    exportTabs.perplexity.classList.toggle('site-active', site === 'perplexity');
    exportTabs.claude.classList.toggle('site-active', site === 'claude');
    exportTabs.chatgpt.classList.toggle('site-active', site === 'chatgpt');
    if (site === 'aistudio' || site === 'perplexity' || site === 'claude' || site === 'chatgpt') {
      applyExportTab(site);
    }
    if (site === 'aistudio')        appTitle.textContent = 'Gemini Studio Exporter';
    else if (site === 'perplexity') appTitle.textContent = 'Perplexity Exporter';
    else if (site === 'claude')     appTitle.textContent = 'Claude Exporter';
    else if (site === 'chatgpt')    appTitle.textContent = 'ChatGPT Exporter';
    else if (site === 'youtube')    appTitle.textContent = 'YouTube → sc-desktop';
    else                            appTitle.textContent = 'SC Browser Parser';
    updateFormatHint();
  }

  const checkStatus = async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      currentTab = tab;
      if (!tab || !tab.url) {
        updateStatus(false, 'Не удалось определить страницу');
        applySite(null);
        exportBtn.disabled = true;
        return;
      }

      const site = detectSite(tab.url);
      applySite(site);

      if (!site) {
        updateStatus(false, 'Открой YouTube, Gemini Studio, Perplexity, Claude или ChatGPT', 'error');
        exportBtn.disabled = true;
        return;
      }

      // YouTube не имеет «Экспортировать» в popup — взаимодействие через
      // кнопки на карточках, которые ставит youtube-content.js. Поэтому
      // кнопку дисэйблим и подсказываем, что делать.
      if (site === 'youtube') {
        updateStatus(true, 'YouTube — кнопки появятся прямо на карточках', 'ready');
        exportBtn.disabled = true;
        btnText.innerHTML = 'Действия — на карточках';
        return;
      }

      // Check if export already running in that tab.
      try {
        const response = await chrome.tabs.sendMessage(tab.id, { action: 'getStatus' });
        const chatgptSiteLabel = site === 'chatgpt'
          ? `ChatGPT · ${CHATGPT_MODE_LABELS[response?.chatgptMode] || 'Chat'}`
          : 'ChatGPT';
        if (response && response.isExporting) {
          const runningLabel = site === 'aistudio'
            ? 'Экспорт идёт (Gemini Studio)...'
            : site === 'perplexity'
              ? 'Экспорт идёт (Perplexity)...'
              : site === 'claude'
                ? 'Экспорт идёт (Claude)...'
                : `Экспорт идёт (${chatgptSiteLabel})...`;
          updateStatus(true, runningLabel, 'exporting');
          setLoading(true, true);
        } else {
          const readyLabel = site === 'aistudio'
            ? 'Подключено к Gemini Studio'
            : site === 'perplexity'
              ? 'Подключено к Perplexity'
              : site === 'claude'
                ? 'Подключено к Claude'
                : `Подключено к ${chatgptSiteLabel}`;
          updateStatus(true, readyLabel, 'ready');
          setLoading(false);
        }
      } catch (e) {
        // Content script may not be injected yet (e.g. tab loaded before extension was reloaded).
        const hintLabel = site === 'aistudio'
          ? 'Gemini Studio (обнови страницу если экспорт не запустится)'
          : site === 'perplexity'
            ? 'Perplexity (обнови страницу если экспорт не запустится)'
            : site === 'claude'
              ? 'Claude (обнови страницу если экспорт не запустится)'
              : 'ChatGPT (обнови страницу если экспорт не запустится)';
        updateStatus(true, hintLabel, 'ready');
        setLoading(false);
      }
    } catch (error) {
      console.error('Tab status error:', error);
      updateStatus(false, 'Ошибка проверки страницы', 'error');
      applySite(null);
    }
  };

  exportBtn.addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) throw new Error('Активная вкладка не найдена');
      const site = detectSite(tab.url);
      if (!site || site === 'youtube') {
        showMessage('error', '✗ Экспортировать через popup можно только Gemini Studio / Perplexity / Claude / ChatGPT');
        return;
      }

      if (exportBtn.classList.contains('stop-mode')) {
        await chrome.tabs.sendMessage(tab.id, { action: 'cancel' });
        setLoading(false);
        updateStatus(true, 'Экспорт остановлен', 'ready');
        return;
      }

      setLoading(true);
      messageDiv.style.display = 'none';

      await storageSetSync({
        __export: sanitizeExportSettings(readExportSettings()),
      });

      const settings = site === 'perplexity'
        ? { ...readPerplexitySettings(), __export: readExportSettings() }
        : site === 'claude'
          ? { ...readClaudeSettings(), __export: readExportSettings() }
          : site === 'chatgpt'
            ? { ...readChatGPTSettings(), __export: readExportSettings() }
            : undefined;

      try {
        await chrome.tabs.sendMessage(tab.id, { action: 'export', settings });
      } catch (e) {
        setLoading(false);
        showMessage('error', '✗ Обнови страницу (F5) и повтори');
        return;
      }
      window.close();
    } catch (error) {
      setLoading(false);
      console.error('Export error:', error);
      if (error.message.includes('Could not establish connection')) {
        showMessage('error', '✗ Обнови страницу (F5) и повтори');
      } else {
        showMessage('error', `✗ ${error.message}`);
      }
    }
  });

  await loadSettings();
  await checkStatus();

  chrome.tabs.onActivated.addListener(() => checkStatus());
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'complete') checkStatus();
  });
});
