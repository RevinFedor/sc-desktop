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
    chatgpt_model:               document.getElementById('yt_chatgpt_model'),
    chatgpt_effort:              document.getElementById('yt_chatgpt_effort'),
  };
  const ytTargetSelect = document.getElementById('yt_target');
  const ytCards = {
    aistudio: document.getElementById('cardAistudio'),
    claude:   document.getElementById('cardClaude'),
    chatgpt:  document.getElementById('cardChatgpt'),
  };
  let currentTarget = 'aistudio'; // active target (Gemini по умолчанию)

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
  for (const m of CHATGPT_AVAILABLE_MODELS) {
    const opt = document.createElement('option');
    opt.value = m.id; opt.textContent = m.label;
    ytInputs.chatgpt_model.appendChild(opt);
  }
  for (const e of CHATGPT_AVAILABLE_EFFORTS) {
    const opt = document.createElement('option');
    opt.value = e.id; opt.textContent = e.label;
    ytInputs.chatgpt_effort.appendChild(opt);
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
    return {
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
      chatgpt_model:            String(ytInputs.chatgpt_model.value || ''),
      chatgpt_effort:           String(ytInputs.chatgpt_effort.value || ''),
    };
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
  function persistYoutube() {
    clearTimeout(ytSaveTimer);
    ytSaveTimer = setTimeout(() => {
      chrome.storage.sync.set({ __yt: sanitizeYoutubeSettings(readYoutubeSettings()) });
    }, 300);
  }
  ytInputs.with_comments.addEventListener('change', () => { persistYoutube(); updateFormatHint(); });
  ytInputs.system_instruction.addEventListener('input', () => { persistYoutube(); });
  ytInputs.post_system_instruction.addEventListener('input', () => { persistYoutube(); });
  ytInputs.model_title.addEventListener('change', () => { persistYoutube(); });
  ytInputs.post_model_title.addEventListener('change', () => { persistYoutube(); });
  ytInputs.claude_project.addEventListener('input', () => { persistYoutube(); });
  ytInputs.claude_post_project.addEventListener('input', () => { persistYoutube(); });
  ytInputs.claude_model.addEventListener('change', () => { persistYoutube(); });
  ytInputs.claude_adaptive_thinking.addEventListener('change', () => { persistYoutube(); });
  ytInputs.chatgpt_prompt.addEventListener('input', () => { persistYoutube(); });
  ytInputs.chatgpt_model.addEventListener('change', () => { persistYoutube(); });
  ytInputs.chatgpt_effort.addEventListener('change', () => { persistYoutube(); });

  function loadSettings() {
    chrome.storage.sync.get({
      ...AI_STUDIO_DEFAULT_SETTINGS,
      __export: EXPORT_DEFAULT_SETTINGS,
      __pplx: PERPLEXITY_DEFAULT_SETTINGS,
      __claude: CLAUDE_EXPORT_DEFAULT_SETTINGS,
      __chatgpt: CHATGPT_EXPORT_DEFAULT_SETTINGS,
      __yt:   YOUTUBE_DEFAULT_SETTINGS,
    }, (raw) => {
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

      const y = sanitizeYoutubeSettings(raw.__yt || {});
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
      ytInputs.chatgpt_model.value                = y.chatgpt_model;
      ytInputs.chatgpt_effort.value               = y.chatgpt_effort;
      applyTargetUi(y.target);
      applyExportTab(currentExportTab);

      updateFormatHint();
    });
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
        if (response && response.isExporting) {
          const runningLabel = site === 'aistudio'
            ? 'Экспорт идёт (Gemini Studio)...'
            : site === 'perplexity'
              ? 'Экспорт идёт (Perplexity)...'
              : site === 'claude'
                ? 'Экспорт идёт (Claude)...'
                : 'Экспорт идёт (ChatGPT)...';
          updateStatus(true, runningLabel, 'exporting');
          setLoading(true, true);
        } else {
          const readyLabel = site === 'aistudio'
            ? 'Подключено к Gemini Studio'
            : site === 'perplexity'
              ? 'Подключено к Perplexity'
              : site === 'claude'
                ? 'Подключено к Claude'
                : 'Подключено к ChatGPT';
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

  loadSettings();
  await checkStatus();

  chrome.tabs.onActivated.addListener(() => checkStatus());
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'complete') checkStatus();
  });
});
