// SC YouTube learning overlay.
//
// Activation deliberately follows YouTube's own CC button: when the user
// enables captions, this script replaces only their visual renderer with an
// interactive bilingual layer. Turning CC off restores the ordinary player.
(function () {
  'use strict';
  if (window.__scYtLearningInstalled) return;
  window.__scYtLearningInstalled = true;

  const U = window.__scYtLearningUtils;
  if (!U) {
    console.error('[SC-YT-Learning] utils are unavailable');
    return;
  }
  const learningStore = window.__scLearningStore || null;
  const Lexeme = window.__scEnglishLexeme || null;
  const vocabularySaves = window.__scCreateVocabularySaveObserver?.(payload => bridgeJson('/learning/catalogue', { method: 'POST', body: payload }));

  const BRIDGE = 'http://127.0.0.1:53127';
  const ROOT_ID = 'sc-yt-learning-root';
  const WORD_POPOVER_ID = 'sc-yt-word-popover';
  const QUICK_WORD_POPOVER_ID = 'sc-yt-quick-word-popover';
  const MAIN_BRIDGE_ID = 'sc-yt-learning-main-bridge';
  const HIDE_NATIVE_CLASS = 'sc-yt-learning-hide-native';
  const REPLACE_LEGACY_CLASS = 'sc-yt-learning-replace-legacy';
  const WORD_DOUBLE_CLICK_MS = 460;
  // Avoid flicker while crossing words without making the tooltip feel delayed.
  const QUICK_WORD_HOVER_DELAY_MS = 70;
  const SUBTITLE_SAFE_SIDE_INSET = 68;
  const LITERAL_REQUEST_CONCURRENCY = 4;
  // Warm at 10 ready cues, then keep a rolling target of 16 ahead.
  const YOUTUBE_TRANSLATION_INITIAL_AHEAD = 10;
  const YOUTUBE_TRANSLATION_PREFETCH_AHEAD = 16;
  const YOUTUBE_TRANSLATION_PREFETCH_BEHIND = 2;
  const EXTERNAL_LITERAL_PREFETCH_AHEAD = 16;
  const EXTERNAL_LITERAL_INITIAL_AHEAD = 10;
  const YOUTUBE_PLAYER_PAGE = () => location.pathname.startsWith('/watch')
    || location.pathname.startsWith('/live/')
    || location.pathname.startsWith('/shorts/');
  const PLAYER_PAGE = () => Boolean(externalMedia?.anchor?.isConnected && externalMedia?.video?.isConnected)
    || YOUTUBE_PLAYER_PAGE();

  const ICONS = {
    previous: '<svg viewBox="0 0 24 24"><path d="M18 6 9.5 12 18 18V6ZM6 6h2v12H6V6Z"/></svg>',
    replay: '<svg viewBox="0 0 24 24"><path d="M12 5V2L7 6l5 4V7a6 6 0 1 1-5.65 8H4.26A8 8 0 1 0 12 5Z"/></svg>',
    next: '<svg viewBox="0 0 24 24"><path d="m6 6 8.5 6L6 18V6Zm10 0h2v12h-2V6Z"/></svg>',
    swap: '<svg viewBox="0 0 24 24"><path d="m7 7 3-3-3-3v2H3v2h4v2Zm10 10-3 3 3 3v-2h4v-2h-4v-2ZM5 8h14a2 2 0 0 1 2 2v2h-2v-2H5v2l-3-3 3-3v2Zm14 8H5a2 2 0 0 1-2-2v-2h2v2h14v-2l3 3-3 3v-2Z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M6 4h4v16H6V4Zm8 0h4v16h-4V4Z"/></svg>',
    settings: '<svg viewBox="0 0 24 24"><path d="m19.4 13 .1-1-.1-1 2-1.6-2-3.4-2.5 1a8 8 0 0 0-1.7-1L15 3.3h-4L10.6 6a8 8 0 0 0-1.7 1L6.4 6 4.4 9.4l2 1.6-.1 1 .1 1-2 1.6 2 3.4 2.5-1a8 8 0 0 0 1.7 1l.4 2.7h4l.4-2.7a8 8 0 0 0 1.7-1l2.5 1 2-3.4-2-1.6ZM13 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8Z"/></svg>',
    buffer: '<svg viewBox="0 0 24 24"><path d="M4 4h16v4H4V4Zm0 6h16v4H4v-4Zm0 6h10v4H4v-4Zm12 0h4v4h-4v-4Z"/></svg>',
    translation: '<svg viewBox="0 0 24 24"><path d="M3 5h18v14H3V5Zm2 2v10h14V7H5Zm2 2h10v2H7V9Zm0 4h7v2H7v-2Z"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="m6.4 5 5.6 5.6L17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4 6.4 5Z"/></svg>',
    speaker: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4Zm12.5 3a4.5 4.5 0 0 0-2-3.74v7.48A4.5 4.5 0 0 0 16.5 12Zm-2-8.5v2.06a7 7 0 0 1 0 12.88v2.06a9 9 0 0 0 0-17Z"/></svg>',
    copy: '<svg viewBox="0 0 24 24"><path d="M8 7V3h13v13h-4v5H3V7h5Zm2 0h7v7h2V5h-9v2Zm5 2H5v10h10V9Z"/></svg>',
    save: '<svg viewBox="0 0 24 24"><path d="M5 3h12l2 2v16H5V3Zm2 2v14h10V6.2L15.8 5H15v5H8V5H7Zm3 0v3h3V5h-3Zm-1 8h6v4H9v-4Z"/></svg>',
    known: '<svg viewBox="0 0 24 24"><path d="m9.2 16.2-4-4L3.8 13.6 9.2 19 20.6 7.6 19.2 6.2l-10 10Z"/></svg>',
    ignore: '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 2a8 8 0 0 1 5.3 14L6 6.7A8 8 0 0 1 12 4Zm-6.7 4L16 18.7A8 8 0 0 1 5.3 8Z"/></svg>',
    more: '<svg viewBox="0 0 24 24"><path d="M5 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm7 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm7 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M7 4v16l13-8L7 4Z"/></svg>',
    book: '<svg viewBox="0 0 24 24"><path d="M4 4.5A3.5 3.5 0 0 1 7.5 1H11a3 3 0 0 1 3 3v15.2A3.8 3.8 0 0 0 11.5 18H7.2A3.2 3.2 0 0 0 4 21.2V4.5Zm16 0A3.5 3.5 0 0 0 16.5 1H15v18.2a3.8 3.8 0 0 1 2.5-1.2H20V4.5Z"/></svg>',
    left: '<svg viewBox="0 0 24 24"><path d="m14.7 6.3-1.4-1.4L6.2 12l7.1 7.1 1.4-1.4L10 13h8v-2h-8l4.7-4.7Z"/></svg>',
    right: '<svg viewBox="0 0 24 24"><path d="m9.3 6.3 1.4-1.4 7.1 7.1-7.1 7.1-1.4-1.4L14 13H6v-2h8L9.3 6.3Z"/></svg>',
    move: '<svg viewBox="0 0 24 24"><path d="m12 2 4 4h-3v4h-2V6H8l4-4Zm0 20-4-4h3v-4h2v4h3l-4 4ZM4 11h16v2H4v-2Z"/></svg>',
  };

  const PART_OF_SPEECH_LABELS = Object.freeze({
    NOUN: 'сущ.',
    VERB: 'глаг.',
    ADJ: 'прил.',
    ADV: 'нареч.',
    PRON: 'мест.',
    PREP: 'предл.',
    CONJ: 'союз',
    DET: 'опред.',
    MODAL: 'мод.',
    OTHER: 'другое',
  });
  const EXPRESSION_TYPE_LABELS = Object.freeze({
    phrasal_verb: 'Фразовый глагол',
    function_phrase: 'Служебная связка',
    idiom: 'Идиома',
  });

  let settings = sanitizeYoutubeSettings(
    typeof YOUTUBE_DEFAULT_SETTINGS === 'object' ? YOUTUBE_DEFAULT_SETTINGS : {},
  );
  // The same learning surface can be mounted over a local HTML <video> from
  // the extension's Video tab. YouTube remains the default adapter; external
  // media supplies only the player element, stable identity and timed cues.
  let externalMedia = null;
  let root = null;
  let subtitleCard = null;
  let sourceWrap = null;
  let subtitleLines = null;
  let sourceRow = null;
  let translationRow = null;
  let statusRow = null;
  let navRail = null;
  let optionRail = null;
  let settingsPanel = null;
  let settingsButton = null;
  let autoPauseButton = null;
  let activeVideo = null;
  let activeAnchor = null;
  let anchorResizeObserver = null;
  let controlHovered = false;
  let hideControlsTimer = null;
  let syncBusy = false;
  let lastSnapshotAt = 0;
  let lastTrackIdentity = '';
  let loadGeneration = 0;
  let sourceCues = [];
  let cues = [];
  let currentCueIndex = -1;
  let selectedTrack = null;
  let videoMeta = { videoId: '', title: '' };
  let overlayActive = false;
  let translationError = '';
  let literalTranslationError = '';
  let literalGeneration = 0;
  let prefetchGeneration = 0;
  let prefetchRunning = false;
  let prefetchRerunRequested = false;
  let naturalRequestsActive = 0;
  let naturalLastLatencyMs = 0;
  let literalLastLatencyMs = 0;
  let literalLastQueueWaitMs = 0;
  let bufferDiagnosticsFrame = null;
  let lastBufferDiagnosticsSignature = '';
  const bufferDiagnosticsPanels = [];
  let settingsRefreshBusy = false;
  let settingsPersistQueue = Promise.resolve();
  let lastTickAt = 0;
  let lastVideoTimeMs = null;
  let autoPausedCueKey = '';
  let subtitleHovered = false;
  let fullTranslationMetaDown = false;
  let wordPopoverOpen = false;
  let phraseSelectionOpen = false;
  let russianSelection = null, russianClickTimer = null, lastRussianClick = null, hoveredRussianWord = null;
  let phraseSelection = null;
  let phraseSelectionAnchor = null;
  let phraseSelectionFocus = null;
  let lastWordClick = null;
  let hoveredPhraseWord = null;
  let phraseHint = null;
  let phraseHintResizeObserver = null;
  let phraseAnalysis = null;
  let phraseAnalysisGeneration = 0;
  let selectionHandoffGeneration = 0;
  let pausedForSubtitleHover = false;
  let hoverPausedCueKey = '';
  let popoverResizeObserver = null;
  let learningStateRefreshPromise = null;
  let copyCueControl = null;
  let copyCueButton = null;
  let copyCueCountBadge = null;
  let copyNeighborCount = 1;
  let copyFeedbackTimer = null;
  let subtitleDragHandle = null;
  let subtitleDragState = null;
  let subtitleDragPreview = null;
  let subtitleLastPlacement = null;
  let subtitleCardResizeObserver = null;
  let subtitleLayoutFrame = null;
  let subtitleCueLayoutSignature = '';
  let subtitleMeasureContext = null;
  let viewportScrollFrame = null;
  const translationsByText = new Map();
  const translationAlignmentsByText = new Map();
  const pendingTranslationTexts = new Set();
  const literalTranslationsByText = new Map();
  const literalTranslationPromises = new Map();
  const pendingLiteralTexts = new Set();
  const failedLiteralTexts = new Set();
  const literalErrorsByText = new Map();
  const literalRequestQueue = [];
  let literalRequestsActive = 0;
  const snapshotRequests = new Map();
  const wordStates = new Map();
  const wordStateOperations = new Map();
  const wordPopoverHistory = [];
  let pendingWordClickTimer = null;
  const wordFormStates = new Map();
  const quickWordTranslations = new Map();
  const quickTranslationPending = new Set();
  let quickWordHoverTimer = null;
  let quickWordHideTimer = null;
  let quickWordHoverAnchor = null;
  let quickWordPointer = null;
  let quickWordHoverToken = 0;
  let expressionEntries = [];
  let currentExpressionMatches = [];
  let lastLearningStateSignature = '';

  function debugSink(id = 'sc-yt-learning-debug') {
    let sink = document.getElementById(id);
    if (sink) return sink;
    sink = document.createElement('pre');
    sink.id = id;
    sink.style.cssText = 'position:fixed;left:-99999px;top:0;width:0;height:0;visibility:hidden;pointer-events:none;';
    (document.body || document.documentElement).appendChild(sink);
    return sink;
  }

  function log(message, data) {
    try {
      const entry = `${new Date().toISOString()} ${message} ${data ? JSON.stringify(data) : ''}`.trim();
      const sink = debugSink();
      sink.textContent = `${sink.textContent || ''}\n${entry}`.trim().split('\n').slice(-120).join('\n');
      console.log('[SC-YT-Learning]', message, data || '');
    } catch {}
  }

  function logLearningAction(message, data) {
    log(message, data);
    const sink = debugSink('sc-yt-learning-actions');
    const entry = `${new Date().toISOString()} ${message} ${JSON.stringify(data || {})}`;
    sink.textContent = `${sink.textContent || ''}\n${entry}`.trim().split('\n').slice(-120).join('\n');
  }

  function pumpLiteralRequestQueue() {
    reprioritizeLiteralRequestQueue(currentCueIndex);
    while (literalRequestsActive < LITERAL_REQUEST_CONCURRENCY && literalRequestQueue.length) {
      const item = literalRequestQueue.shift();
      if (item.generation !== literalGeneration) {
        item.resolve(false);
        continue;
      }
      literalRequestsActive += 1;
      item.startedAt = performance.now();
      literalLastQueueWaitMs = Math.max(0, item.startedAt - item.queuedAt);
      scheduleBufferDiagnosticsUpdate();
      Promise.resolve()
        .then(item.run)
        .then(item.resolve, item.reject)
        .finally(() => {
          literalRequestsActive = Math.max(0, literalRequestsActive - 1);
          scheduleBufferDiagnosticsUpdate();
          pumpLiteralRequestQueue();
        });
    }
    scheduleBufferDiagnosticsUpdate();
  }

  function literalRequestPriority(index, centerIndex = currentCueIndex) {
    if (!Number.isInteger(index)) return Number.MAX_SAFE_INTEGER;
    if (!Number.isInteger(centerIndex) || centerIndex < 0) return index;
    if (index >= centerIndex) return index - centerIndex;
    return YOUTUBE_TRANSLATION_PREFETCH_AHEAD + 1 + (centerIndex - index);
  }

  function reprioritizeLiteralRequestQueue(centerIndex = currentCueIndex) {
    for (const item of literalRequestQueue) item.priority = literalRequestPriority(item.index, centerIndex);
    literalRequestQueue.sort((left, right) => left.priority - right.priority || left.queuedAt - right.queuedAt);
  }

  function queueLiteralRequest(run, generation, metadata = {}) {
    return new Promise((resolve, reject) => {
      const queuedAt = performance.now();
      literalRequestQueue.push({
        run,
        generation,
        resolve,
        reject,
        index: Number.isInteger(metadata.index) ? metadata.index : -1,
        key: String(metadata.key || ''),
        queuedAt,
        startedAt: 0,
        priority: literalRequestPriority(metadata.index),
      });
      scheduleBufferDiagnosticsUpdate();
      pumpLiteralRequestQueue();
    });
  }

  function resetLiteralTranslationState() {
    literalGeneration += 1;
    literalTranslationsByText.clear();
    pendingLiteralTexts.clear();
    failedLiteralTexts.clear();
    literalErrorsByText.clear();
    literalTranslationPromises.clear();
    for (const item of literalRequestQueue.splice(0)) item.resolve(false);
    literalLastLatencyMs = 0;
    literalLastQueueWaitMs = 0;
    scheduleBufferDiagnosticsUpdate();
  }

  function injectCss() {
    if (document.getElementById('sc-yt-learning-style')) return;
    const style = document.createElement('style');
    style.id = 'sc-yt-learning-style';
    style.textContent = `
      html.${HIDE_NATIVE_CLASS} .ytp-caption-window-container,
      html.${HIDE_NATIVE_CLASS} .caption-window {
        opacity: 0 !important;
        visibility: hidden !important;
      }
      html.${REPLACE_LEGACY_CLASS} #lln-subs-content,
      html.${REPLACE_LEGACY_CLASS} .lln-notifications,
      html.${REPLACE_LEGACY_CLASS} .lln-vv-toggle-in-sidebar,
      html.${REPLACE_LEGACY_CLASS} .lln-vertical-view {
        opacity: 0 !important;
        visibility: hidden !important;
        pointer-events: none !important;
      }
      #${ROOT_ID} {
        position: fixed;
        z-index: 2147482980;
        pointer-events: none;
        font-family: Roboto, Arial, sans-serif;
        color: #fff;
        contain: layout style;
        user-select: none;
        -webkit-user-select: none;
      }
      #${ROOT_ID}[data-active="0"] { display: none !important; }
      #${ROOT_ID} .sc-learning-subtitle-card {
        position: absolute;
        left: 50%;
        transform: translateX(-50%);
        width: min(calc(100% - 136px), 1600px);
        max-width: calc(100% - 136px);
        box-sizing: border-box;
        text-align: center;
        display: flex;
        flex-direction: column;
        align-items: center;
        pointer-events: none;
        filter: drop-shadow(0 2px 3px rgba(0,0,0,.75));
      }
      #${ROOT_ID}[data-position="bottom"] .sc-learning-subtitle-card { bottom: 10%; }
      #${ROOT_ID}[data-position="top"] .sc-learning-subtitle-card { top: 8%; }
      #${ROOT_ID} .sc-learning-source,
      #${ROOT_ID} .sc-learning-translation {
        display: block;
        width: fit-content;
        max-width: 100%;
        box-sizing: border-box;
        margin: 0 auto;
        padding: 5px 12px;
        border-radius: 6px;
        background: rgba(8, 8, 10, .82);
        pointer-events: auto;
        box-decoration-break: clone;
        -webkit-box-decoration-break: clone;
        line-height: 1.32;
        white-space: nowrap;
        transition: background-color 120ms ease, box-shadow 120ms ease;
      }
      #${ROOT_ID} .sc-learning-translation { width:max-content; max-width:none; margin:0; flex-shrink:0; white-space:nowrap; overflow-wrap:normal; }
      #${ROOT_ID} [data-saving="1"], #${WORD_POPOVER_ID} [data-saving="1"] { animation: sc-word-saving 1.4s ease-in-out infinite; }
      @keyframes sc-word-saving { 0%, 100% { background-color: rgba(139,92,246,.14); } 50% { background-color: rgba(139,92,246,.52); } }
      @media (prefers-reduced-motion: reduce) { #${ROOT_ID} [data-saving="1"], #${WORD_POPOVER_ID} [data-saving="1"] { animation: none; background: rgba(139,92,246,.35); } }
      #${ROOT_ID}[data-hover-hold="scheduled"] .sc-learning-subtitle-card:hover .sc-learning-source,
      #${ROOT_ID}[data-hover-hold="scheduled"] .sc-learning-subtitle-card:hover .sc-learning-translation {
        background: rgba(18, 11, 26, .83);
      }
      #${ROOT_ID}[data-hover-hold="active"] .sc-learning-subtitle-card:hover .sc-learning-source,
      #${ROOT_ID}[data-hover-hold="active"] .sc-learning-subtitle-card:hover .sc-learning-translation {
        background: rgba(23, 13, 34, .84);
      }
      #${ROOT_ID} .sc-learning-source-wrap {
        position:relative;
        width:fit-content;
        max-width:100%;
        margin:0 auto;
      }
      #${ROOT_ID} .sc-learning-lines {
        display:flex;
        flex-direction:column;
        align-items:center;
        width:fit-content;
        max-width:100%;
        margin:0 auto;
        pointer-events:auto;
      }
      #${ROOT_ID}[data-translation-mode="never"][data-full-translation-reveal="0"] .sc-learning-lines {
        pointer-events:none;
      }
      #${ROOT_ID} .sc-learning-source-wrap .sc-learning-source { margin:0; }
      #${ROOT_ID} .sc-learning-copy-control {
        position:absolute;
        left:calc(100% + 6px);
        top:50%;
        z-index:4;
        transform:translateY(-50%);
        opacity:.24;
        pointer-events:auto;
        transition:opacity .12s;
      }
      #${ROOT_ID} .sc-learning-copy-control[data-visible="0"] { display:none; }
      #${ROOT_ID} .sc-learning-source-wrap:hover .sc-learning-copy-control,
      #${ROOT_ID} .sc-learning-copy-control:focus-within,
      #${ROOT_ID} .sc-learning-copy-control[data-open="1"] { opacity:.82; }
      #${ROOT_ID} .sc-learning-copy-control:hover { opacity:1; }
      #${ROOT_ID} .sc-learning-copy-launch {
        position:relative;
        width:32px;
        height:32px;
        display:grid;
        place-items:center;
        padding:0;
        border:0;
        border-radius:8px;
        background:rgba(9,9,11,.28);
        color:#e4e4e7;
        cursor:pointer;
      }
      #${ROOT_ID} .sc-learning-copy-launch:hover,
      #${ROOT_ID} .sc-learning-copy-control:focus-within .sc-learning-copy-launch { background:rgba(39,39,42,.96); }
      #${ROOT_ID} .sc-learning-copy-control[data-copied="1"] .sc-learning-copy-launch { color:#86efac; background:rgba(20,83,45,.94); }
      #${ROOT_ID} .sc-learning-copy-launch svg { width:19px; height:19px; fill:currentColor; }
      #${ROOT_ID} .sc-learning-copy-count {
        position:absolute;
        right:-5px;
        top:-6px;
        display:none;
        min-width:17px;
        height:17px;
        place-items:center;
        padding:0 4px;
        border:1px solid rgba(187,247,208,.7);
        border-radius:999px;
        background:#166534;
        color:#dcfce7;
        font:800 10px/1 Roboto,Arial,sans-serif;
        box-sizing:border-box;
      }
      #${ROOT_ID} .sc-learning-copy-control[data-copied="1"] .sc-learning-copy-count { display:grid; }
      #${ROOT_ID} .sc-learning-copy-bridge {
        position:absolute;
        right:-4px;
        bottom:100%;
        z-index:1;
        display:none;
        width:220px;
        height:10px;
        background:transparent;
        pointer-events:auto;
      }
      #${ROOT_ID} .sc-learning-copy-control:hover .sc-learning-copy-bridge,
      #${ROOT_ID} .sc-learning-copy-control:focus-within .sc-learning-copy-bridge,
      #${ROOT_ID} .sc-learning-copy-control[data-open="1"] .sc-learning-copy-bridge { display:block; }
      #${ROOT_ID} .sc-learning-copy-menu {
        position:absolute;
        right:0;
        bottom:calc(100% + 6px);
        display:none;
        align-items:center;
        gap:3px;
        padding:4px;
        border:1px solid rgba(255,255,255,.14);
        border-radius:9px;
        background:rgba(24,24,27,.98);
        box-shadow:0 10px 28px rgba(0,0,0,.42);
        white-space:nowrap;
      }
      #${ROOT_ID} .sc-learning-copy-control:hover .sc-learning-copy-menu,
      #${ROOT_ID} .sc-learning-copy-control:focus-within .sc-learning-copy-menu,
      #${ROOT_ID} .sc-learning-copy-control[data-open="1"] .sc-learning-copy-menu { display:flex; }
      #${ROOT_ID} .sc-learning-copy-menu button {
        width:27px;
        height:27px;
        display:grid;
        place-items:center;
        padding:0;
        border:0;
        border-radius:6px;
        background:transparent;
        color:#a1a1aa;
        cursor:pointer;
        font:700 12px Roboto,Arial,sans-serif;
      }
      #${ROOT_ID} .sc-learning-copy-menu button:hover { color:#fff; background:#3f3f46; }
      #${ROOT_ID} .sc-learning-copy-menu button[data-selected="1"] { color:#e9d5ff; background:rgba(147,51,234,.34); }
      #${ROOT_ID} .sc-learning-copy-menu button svg { width:17px; height:17px; fill:currentColor; }
      #${ROOT_ID} .sc-learning-copy-divider { width:1px; height:18px; margin:0 2px; background:#3f3f46; }
      #${ROOT_ID} .sc-learning-source:empty,
      #${ROOT_ID} .sc-learning-translation:empty { display: none; }
      #${ROOT_ID} .sc-learning-translation[hidden] { display:none; }
      #${ROOT_ID} .sc-learning-source { font-size: var(--sc-learning-source-font-size, 34px); font-weight: 500; }
      #${ROOT_ID} .sc-learning-translation {
        position: relative;
        margin-top: 5px;
        font-size: var(--sc-learning-target-font-size, 25px);
        color: #d4d4d8;
        transition: opacity .12s ease, transform .12s ease;
      }
      #${ROOT_ID}[data-language-order="target_first"] .sc-learning-translation {
        margin-top: 0;
        margin-bottom: 5px;
      }
      #${ROOT_ID} .sc-learning-translation[data-literal-state="translation-pending"],
      #${ROOT_ID} .sc-learning-translation[data-literal-state="pending"] {
        color: transparent;
        min-height: calc(1.32em + 10px);
      }
      #${ROOT_ID} .sc-learning-translation[data-literal-state="translation-pending"]::after,
      #${ROOT_ID} .sc-learning-translation[data-literal-state="pending"]::after {
        content: "Готовлю перевод…";
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #a1a1aa;
        white-space: nowrap;
      }
      #${ROOT_ID} .sc-learning-translation mark {
        color:#fff;
        background:rgba(111,72,151,.85);
        border-radius:3px;
        padding:0;
      }
      #${ROOT_ID}[data-translation-mode="never"] .sc-learning-translation {
        visibility:hidden;
        opacity:0;
        transform:none;
        pointer-events:none;
      }
      #${ROOT_ID}[data-translation-mode="never"][data-full-translation-reveal="1"] .sc-learning-translation {
        visibility:visible;
        opacity:1;
        pointer-events:auto;
      }
      #${ROOT_ID} .sc-learning-word {
        display: inline;
        padding: 0 1px;
        border-radius: 3px;
        cursor: pointer;
        pointer-events: auto;
      }
      #${ROOT_ID} .sc-learning-word:hover,
      #${ROOT_ID} .sc-learning-word:focus-visible {
        color: #d8b4fe;
        background: rgba(147,51,234,.28);
        outline: none;
      }
      #${ROOT_ID} .sc-learning-word[data-active="1"],
      #${ROOT_ID} .sc-learning-translation :is(mark,.sc-learning-ru-word)[data-active="1"] {
        color:#fff;
        background:rgba(111,72,151,.85);
        outline:1px solid rgba(199,176,222,.75);
        outline-offset:1px;
      }
      #${ROOT_ID} .sc-learning-word[data-learning-state="saved"],
      #${ROOT_ID} .sc-learning-translation :is(mark,.sc-learning-ru-word)[data-learning-state="saved"] {
        color: #fff;
        background: rgba(91,59,122,.78);
        box-shadow: inset 0 -2px 0 rgba(187,161,214,.78);
      }
      #${ROOT_ID} .sc-learning-word[data-learning-state="known"],
      #${ROOT_ID} .sc-learning-translation :is(mark,.sc-learning-ru-word)[data-learning-state="known"] {
        color: #fff;
        background: rgba(22,163,74,.5);
        box-shadow: inset 0 -2px 0 rgba(134,239,172,.95);
      }
      #${ROOT_ID} .sc-learning-word[data-learning-state="saved"]:hover:not([data-phrase-selected="1"]):not([data-phrase-preview="1"]),
      #${ROOT_ID} .sc-learning-word[data-learning-state="saved"]:focus-visible:not([data-phrase-selected="1"]):not([data-phrase-preview="1"]),
      #${ROOT_ID} .sc-learning-word[data-learning-state="saved"][data-active="1"]:not([data-phrase-selected="1"]):not([data-phrase-preview="1"]),
      #${ROOT_ID} .sc-learning-translation :is(mark,.sc-learning-ru-word)[data-learning-state="saved"][data-active="1"] { background: rgba(111,72,151,.85); }
      #${ROOT_ID} .sc-learning-word[data-learning-state="known"]:hover:not([data-phrase-selected="1"]):not([data-phrase-preview="1"]),
      #${ROOT_ID} .sc-learning-word[data-learning-state="known"]:focus-visible:not([data-phrase-selected="1"]):not([data-phrase-preview="1"]),
      #${ROOT_ID} .sc-learning-word[data-learning-state="known"][data-active="1"]:not([data-phrase-selected="1"]):not([data-phrase-preview="1"]),
      #${ROOT_ID} .sc-learning-translation :is(mark,.sc-learning-ru-word)[data-learning-state="known"][data-active="1"] { background: rgba(22,163,74,.72); }
      #${ROOT_ID} .sc-learning-word[data-expression-state="saved"],
      #${ROOT_ID} .sc-learning-word[data-expression-state="known"] {
        text-decoration-line:underline;
        text-decoration-thickness:3px;
        text-underline-offset:5px;
        text-decoration-color:#60a5fa;
      }
      #${ROOT_ID} .sc-learning-word[data-expression-state="known"] { text-decoration-color:#4ade80; }
      #${ROOT_ID} .sc-learning-ru-word { cursor:pointer; border-radius:4px; padding:0 1px; }
      #${ROOT_ID} .sc-learning-ru-word:hover { background:#ffffff15; }
      #${ROOT_ID} .sc-learning-ru-word:focus-visible { outline:1px solid #c4b5fd; }
      #${ROOT_ID} .sc-learning-translation .sc-learning-ru-word[data-ru-selected],
      #${ROOT_ID} .sc-learning-source .sc-learning-word[data-ru-match] { background:#224caa !important; color:#fff !important; box-shadow:inset 0 -2px #93c5fd !important; opacity:1 !important; }
      #${ROOT_ID} .sc-learning-word[data-phrase-selected="1"] {
        color:#fff;
        background:rgba(37,99,235,.72);
        box-shadow:inset 0 -2px 0 rgba(147,197,253,.98);
      }
      #${ROOT_ID} .sc-learning-word[data-phrase-preview="1"] {
        color:#eff6ff;
        background:rgba(37,99,235,.28);
        box-shadow:inset 0 -2px 0 rgba(147,197,253,.62);
      }
      #${ROOT_ID} .sc-learning-phrase-hint {
        display:none;
        pointer-events:auto;
        position:absolute;
        left:50%;
        bottom:calc(100% + 6px);
        z-index:5;
        transform:translateX(-50%);
        width:fit-content;
        max-width:100%;
        margin:0;
        padding:5px 10px;
        border:1px solid rgba(147,197,253,.42);
        border-radius:999px;
        background:rgba(9,18,38,.9);
        color:#bfdbfe;
        font-size:12px;
        font-weight:600;
        white-space:nowrap;
        overflow:hidden;
        text-overflow:ellipsis;
      }
      #${ROOT_ID} .sc-learning-phrase-hint[data-visible="1"] { display:block; }
      #${ROOT_ID} .sc-learning-phrase-hint[data-state="error"] { border-color:rgba(248,113,113,.45); color:#fecaca; }
      #${ROOT_ID} .sc-learning-phrase-hint[data-expanded="1"] {
        width:min(620px,100%);
        padding:9px 10px;
        border-radius:11px;
        background:rgba(17,24,39,.97);
        text-align:left;
        white-space:normal;
        overflow:visible;
        text-overflow:clip;
      }
      #${ROOT_ID} .sc-learning-phrase-hint[data-expanded="1"]::after { display:none; }
      #${ROOT_ID} .sc-expression-summary { display:flex; align-items:center; gap:8px; min-width:0; }
      #${ROOT_ID} .sc-expression-summary strong { color:#fff; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      #${ROOT_ID} .sc-expression-summary .sc-expression-translation { margin-left:auto; color:#d8b4fe; font-weight:500; }
      #${ROOT_ID} .sc-expression-translation button { display:inline; appearance:none; margin:0; padding:0; border:0; border-bottom:1px dotted currentColor; background:none; color:inherit; font:inherit; text-align:left; cursor:pointer; }
      #${ROOT_ID} .sc-expression-types { display:flex; flex-wrap:wrap; gap:5px; margin-top:7px; }
      #${ROOT_ID} .sc-expression-type,
      #${ROOT_ID} .sc-expression-actions button { padding:5px 8px; border:1px solid #3f3f46; border-radius:7px; background:#27272a; color:#d4d4d8; font:600 11px Roboto,Arial,sans-serif; cursor:pointer; }
      #${ROOT_ID} .sc-expression-type { border-color:#444; color:#a1a1aa; background:#27272a; cursor:default; }
      #${ROOT_ID} .sc-expression-composition { margin-top:7px; color:#a1a1aa; font-size:13px; line-height:1.45; white-space:normal; overflow-wrap:anywhere; text-align:left; }
      #${ROOT_ID} .sc-expression-composition .sc-expression-part { display:inline-block; margin-right:9px; }
      #${ROOT_ID} .sc-expression-composition strong { color:#e4e4e7; font-weight:600; }
      #${ROOT_ID} .sc-expression-composition p { margin:3px 0 0; color:#c4b5fd; }
      #${ROOT_ID} .sc-expression-types:has(+ .sc-expression-composition) .sc-expression-type { padding:2px 6px; font-size:11px; }
      #${ROOT_ID} .sc-expression-actions { display:flex; align-items:center; gap:6px; margin-top:7px; }
      #${ROOT_ID} .sc-expression-actions button[data-primary="1"] { border-color:#9333ea; color:#f3e8ff; background:rgba(126,34,206,.35); }
      #${ROOT_ID} .sc-expression-actions small { margin-left:auto; color:#64748b; font-weight:500; }
      #${ROOT_ID} .sc-learning-phrase-hint[data-cancellable="1"] { cursor:pointer; }
      #${ROOT_ID} .sc-learning-phrase-hint[data-cancellable="1"]::after {
        content:'Отменить выбор';
        position:absolute;
        inset:0;
        display:grid;
        place-items:center;
        border-radius:inherit;
        background:rgba(69,10,10,.96);
        color:#fecaca;
        opacity:0;
        pointer-events:none;
        transition:opacity .1s ease;
      }
      #${ROOT_ID} .sc-learning-phrase-hint[data-cancellable="1"]:hover::after,
      #${ROOT_ID} .sc-learning-phrase-hint[data-cancellable="1"]:focus-visible::after { opacity:1; }
      #${ROOT_ID} .sc-learning-status {
        display: none;
        pointer-events: auto;
        align-items: center;
        gap: 8px;
        width: fit-content;
        margin: 0 auto 5px;
        padding: 5px 10px;
        border-radius: 999px;
        background: rgba(9,9,11,.86);
        color: #d4d4d8;
        font-size: 13px;
      }
      #${ROOT_ID} .sc-learning-status[data-visible="1"] { display: flex; }
      #${ROOT_ID} .sc-learning-status[data-loading="1"]::before {
        content: '';
        width: 12px;
        height: 12px;
        flex: 0 0 12px;
        border: 2px solid rgba(212,212,216,.32);
        border-top-color: #d8b4fe;
        border-radius: 50%;
        animation: sc-learning-spin .7s linear infinite;
      }
      @keyframes sc-learning-spin { to { transform: rotate(360deg); } }
      #${ROOT_ID} .sc-learning-rail {
        position: absolute;
        top: 50%;
        transform: translateY(-50%);
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 6px;
        border-radius: 12px;
        background: rgba(9,9,11,.76);
        backdrop-filter: blur(8px);
        opacity: 0;
        visibility: hidden;
        pointer-events: auto;
        transition: opacity .12s ease;
      }
      #${ROOT_ID}[data-controls-visible="1"] .sc-learning-rail {
        opacity: 1;
        visibility: visible;
      }
      #${ROOT_ID} .sc-learning-buffer-control {
        position:relative;
        width:34px;
        height:34px;
      }
      #${ROOT_ID} .sc-learning-buffer-control::after {
        content:'';
        position:absolute;
        top:-3px;
        right:-3px;
        width:7px;
        height:7px;
        border:1px solid rgba(9,9,11,.9);
        border-radius:999px;
        background:#71717a;
        box-shadow:0 0 0 2px rgba(9,9,11,.28);
        pointer-events:none;
      }
      #${ROOT_ID} .sc-learning-buffer-control[data-buffer-state="ready"]::after { background:#4ade80; }
      #${ROOT_ID} .sc-learning-buffer-control[data-buffer-state="warming"]::after { background:#c084fc; }
      #${ROOT_ID} .sc-learning-buffer-control[data-buffer-state="empty"]::after { background:#f59e0b; }
      #${ROOT_ID} .sc-learning-buffer-control[data-buffer-state="error"]::after { background:#f87171; }
      #${ROOT_ID} .sc-learning-buffer-diagnostics {
        position:absolute;
        top:50%;
        z-index:12;
        width:248px;
        box-sizing:border-box;
        padding:10px 11px;
        border:1px solid rgba(255,255,255,.14);
        border-radius:11px;
        background:rgba(18,18,20,.97);
        box-shadow:0 16px 42px rgba(0,0,0,.5);
        color:#d4d4d8;
        opacity:0;
        visibility:hidden;
        transform:translateY(-50%);
        transition:opacity .1s ease;
        pointer-events:none;
        font:500 11px/1.35 Roboto,Arial,sans-serif;
      }
      #${ROOT_ID} .sc-learning-buffer-control:hover .sc-learning-buffer-diagnostics,
      #${ROOT_ID} .sc-learning-buffer-control:focus-within .sc-learning-buffer-diagnostics {
        opacity:1;
        visibility:visible;
      }
      #${ROOT_ID}[data-mirrored="0"] .sc-learning-nav .sc-learning-buffer-diagnostics { left:calc(100% + 7px); }
      #${ROOT_ID}[data-mirrored="1"] .sc-learning-nav .sc-learning-buffer-diagnostics { right:calc(100% + 7px); }
      #${ROOT_ID} .sc-learning-buffer-head { display:flex; align-items:center; gap:7px; margin-bottom:8px; }
      #${ROOT_ID} .sc-learning-buffer-head i { width:7px; height:7px; flex:0 0 7px; border-radius:999px; background:#71717a; }
      #${ROOT_ID} .sc-learning-buffer-diagnostics[data-state="ready"] .sc-learning-buffer-head i { background:#4ade80; }
      #${ROOT_ID} .sc-learning-buffer-diagnostics[data-state="warming"] .sc-learning-buffer-head i { background:#c084fc; }
      #${ROOT_ID} .sc-learning-buffer-diagnostics[data-state="empty"] .sc-learning-buffer-head i { background:#f59e0b; }
      #${ROOT_ID} .sc-learning-buffer-diagnostics[data-state="error"] .sc-learning-buffer-head i { background:#f87171; }
      #${ROOT_ID} .sc-learning-buffer-head strong { color:#f4f4f5; font-size:12px; }
      #${ROOT_ID} .sc-learning-buffer-head span { margin-left:auto; color:#c4b5fd; font-variant-numeric:tabular-nums; }
      #${ROOT_ID} .sc-learning-buffer-grid { display:grid; grid-template-columns:auto 1fr; gap:4px 10px; }
      #${ROOT_ID} .sc-learning-buffer-grid dt { color:#71717a; }
      #${ROOT_ID} .sc-learning-buffer-grid dd { margin:0; color:#d4d4d8; text-align:right; font-variant-numeric:tabular-nums; }
      #${ROOT_ID} .sc-learning-buffer-error { display:none; margin-top:7px; padding-top:7px; border-top:1px solid rgba(255,255,255,.08); color:#fca5a5; overflow-wrap:anywhere; }
      #${ROOT_ID} .sc-learning-buffer-error[data-visible="1"] { display:block; }
      #${ROOT_ID}[data-mirrored="0"] .sc-learning-nav { left: 12px; }
      #${ROOT_ID}[data-mirrored="0"] .sc-learning-options { right: 12px; }
      #${ROOT_ID}[data-mirrored="1"] .sc-learning-nav { right: 12px; }
      #${ROOT_ID}[data-mirrored="1"] .sc-learning-options { left: 12px; }
      #${ROOT_ID} .sc-learning-drag-handle {
        position:absolute;
        right:16px;
        z-index:7;
        width:36px;
        height:36px;
        display:grid;
        place-items:center;
        padding:0;
        border:1px solid rgba(255,255,255,.14);
        border-radius:9px;
        background:rgba(9,9,11,.78);
        color:#d4d4d8;
        opacity:.42;
        visibility:visible;
        pointer-events:auto;
        touch-action:none;
        cursor:grab;
        backdrop-filter:blur(8px);
        transition:opacity .12s ease,background .12s ease;
      }
      #${ROOT_ID} .sc-learning-drag-handle[data-visible="0"] { display:none; }
      #${ROOT_ID}:hover .sc-learning-drag-handle,
      #${ROOT_ID}[data-controls-visible="1"] .sc-learning-drag-handle,
      #${ROOT_ID}[data-dragging="1"] .sc-learning-drag-handle { opacity:1; }
      #${ROOT_ID} .sc-learning-drag-handle:hover { background:rgba(39,39,42,.96); color:#fff; }
      #${ROOT_ID}[data-dragging="1"] .sc-learning-drag-handle { cursor:grabbing; color:#d8b4fe; background:rgba(88,28,135,.92); }
      #${ROOT_ID} .sc-learning-drag-handle svg { width:21px; height:21px; fill:currentColor; }
      #${ROOT_ID} .sc-learning-icon-button,
      #${WORD_POPOVER_ID} .sc-learning-icon-button {
        width: 34px;
        height: 34px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        border: 0;
        border-radius: 8px;
        color: #e4e4e7;
        background: transparent;
        cursor: pointer;
      }
      #${ROOT_ID} .sc-learning-icon-button:hover,
      #${WORD_POPOVER_ID} .sc-learning-icon-button:hover { background: rgba(255,255,255,.12); }
      #${ROOT_ID} .sc-learning-icon-button[data-active="1"] { color: #c084fc; background: rgba(147,51,234,.28); }
      #${ROOT_ID} .sc-learning-icon-button svg,
      #${WORD_POPOVER_ID} .sc-learning-icon-button svg { width: 21px; height: 21px; fill: currentColor; }
      #${ROOT_ID} .sc-learning-settings {
        position: absolute;
        top: 50%;
        width: 340px;
        padding: 14px;
        border: 1px solid rgba(255,255,255,.16);
        border-radius: 12px;
        background: rgba(18,18,20,.97);
        box-shadow: 0 14px 40px rgba(0,0,0,.46);
        color: #e4e4e7;
        pointer-events: auto;
      }
      #${ROOT_ID}[data-mirrored="0"] .sc-learning-settings { right: 58px; transform: translateY(-50%); }
      #${ROOT_ID}[data-mirrored="1"] .sc-learning-settings { left: 58px; transform: translateY(-50%); }
      #${ROOT_ID} .sc-learning-settings[hidden] { display: none; }
      #${ROOT_ID} .sc-learning-settings-head { display:flex; align-items:center; gap:8px; margin-bottom:10px; font-size:15px; font-weight:600; }
      #${ROOT_ID} .sc-learning-settings-head button { margin-left:auto; }
      #${ROOT_ID} .sc-learning-setting-row { display:grid; grid-template-columns: minmax(0,1fr) 180px; gap:10px; align-items:center; min-height:38px; font-size:13px; }
      #${ROOT_ID} .sc-learning-setting-row select,
      #${ROOT_ID} .sc-learning-setting-row input[type="text"] {
        width:100%; min-width:0; height:30px; border:1px solid #3f3f46; border-radius:7px;
        background:#27272a; color:#f4f4f5; padding:0 8px; font:inherit;
      }
      #${ROOT_ID} .sc-learning-switch-row { grid-template-columns:minmax(0,1fr) max-content; }
      #${ROOT_ID} .sc-learning-switch { display:inline-flex; justify-content:flex-end; align-items:center; gap:8px; min-height:30px; padding:0; border:0; background:transparent; color:#d4d4d8; font:inherit; cursor:pointer; }
      #${ROOT_ID} .sc-learning-switch:focus-visible { outline:2px solid #a78bfa; outline-offset:3px; border-radius:5px; }
      #${ROOT_ID} .sc-learning-switch-labels { display:inline-grid; text-align:right; font-size:12px; }
      #${ROOT_ID} .sc-learning-switch-labels > span { grid-area:1 / 1; white-space:nowrap; }
      #${ROOT_ID} .sc-learning-switch[aria-checked="true"] [data-switch-caption="off"],
      #${ROOT_ID} .sc-learning-switch[aria-checked="false"] [data-switch-caption="on"] { visibility:hidden; }
      #${ROOT_ID} .sc-learning-switch-track { position:relative; display:block; flex:none; width:36px; height:20px; border-radius:999px; background:#3f3f46; transition:background .12s; }
      #${ROOT_ID} .sc-learning-switch-track::after { content:''; position:absolute; top:2px; left:2px; width:16px; height:16px; border-radius:50%; background:#fff; transition:transform .12s; }
      #${ROOT_ID} .sc-learning-switch[aria-checked="true"] .sc-learning-switch-track { background:#9333ea; }
      #${ROOT_ID} .sc-learning-switch[aria-checked="true"] .sc-learning-switch-track::after { transform:translateX(16px); }
      #${ROOT_ID} .sc-learning-setting-range { display:grid; grid-template-columns:1fr 48px; gap:7px; align-items:center; min-width:0; }
      #${ROOT_ID} .sc-learning-setting-range input[type="range"] { width:100%; min-width:0; accent-color:#9333ea; cursor:ew-resize; }
      #${ROOT_ID} .sc-learning-range-step { width:24px; height:26px; padding:0; border:1px solid #3f3f46; border-radius:6px; background:#27272a; color:#d4d4d8; font:600 17px/1 Roboto,Arial,sans-serif; cursor:pointer; }
      #${ROOT_ID} .sc-learning-range-step:disabled { opacity:.35; cursor:default; }
      #${ROOT_ID} .sc-learning-setting-range output { color:#a1a1aa; text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
      #${ROOT_ID} .sc-learning-width-setting { grid-template-columns:max-content minmax(0,1fr); }
      #${ROOT_ID} .sc-learning-width-setting .sc-learning-setting-range { grid-template-columns:minmax(45px,1fr) max-content; }
      #${QUICK_WORD_POPOVER_ID} {
        position:fixed;
        z-index:2147483002;
        width:max-content;
        min-width:0;
        max-width:min(270px,calc(100vw - 20px));
        box-sizing:border-box;
        padding:8px 10px;
        border:1px solid rgba(255,255,255,.14);
        border-radius:10px;
        background:rgba(24,24,27,.97);
        box-shadow:0 12px 34px rgba(0,0,0,.48);
        color:#e4e4e7;
        pointer-events:none;
        font:600 13px/1.3 Roboto,Arial,sans-serif;
        user-select:none;
        -webkit-user-select:none;
      }
      #${QUICK_WORD_POPOVER_ID} .sc-quick-word-row { display:block; min-height:18px; white-space:normal; text-align:center; }
      #${QUICK_WORD_POPOVER_ID} .sc-quick-word-row + .sc-quick-word-row { margin-top:2px; }
      #${QUICK_WORD_POPOVER_ID} .sc-quick-word-row span { color:#f4f4f5; overflow-wrap:anywhere; }
      #${QUICK_WORD_POPOVER_ID}[data-loading="1"] .sc-quick-word-row span { color:#a1a1aa; font-weight:500; }
      #${WORD_POPOVER_ID} {
        position: fixed;
        z-index: 2147483000;
        display: block;
        box-sizing: border-box;
        width: min(480px, calc(100vw - 24px));
        max-height: min(760px, calc(100vh - 24px));
        overflow: visible;
        padding: 0;
        border: 0;
        background: transparent;
        color: #f4f4f5;
        font-family: Roboto, Arial, sans-serif;
        user-select:none;
        -webkit-user-select:none;
      }
      #${WORD_POPOVER_ID}[hidden] { display:none; }
      #${WORD_POPOVER_ID} .sc-word-panel {
        position:relative;
        z-index:3;
        display:flex;
        flex-direction:column;
        max-height:inherit;
        overflow:auto;
        overscroll-behavior:contain;
        border:1px solid rgba(255,255,255,.14);
        border-radius:14px;
        background:#202022;
        box-shadow:0 20px 58px rgba(0,0,0,.58);
      }
      #${WORD_POPOVER_ID} .sc-word-anchor-tail {
        position:absolute;
        bottom:-11px;
        z-index:2;
        width:22px;
        height:12px;
        pointer-events:none;
        filter:drop-shadow(0 2px 1px rgba(0,0,0,.28));
      }
      #${WORD_POPOVER_ID} .sc-word-anchor-tail svg { display:block; width:100%; height:100%; overflow:visible; }
      #${WORD_POPOVER_ID} .sc-word-head { display:flex; flex:0 0 auto; align-items:flex-start; gap:8px; padding:10px 11px 9px; background:#2b2b2f; }
      #${WORD_POPOVER_ID} .sc-word-expression-links { display:flex; flex-wrap:wrap; gap:5px; padding:7px 11px; border-top:1px solid rgba(255,255,255,.07); background:#242428; }
      #${WORD_POPOVER_ID} .sc-word-expression-links:empty { display:none; }
      #${WORD_POPOVER_ID} .sc-word-expression-links button { padding:5px 8px; border:1px solid rgba(96,165,250,.4); border-radius:999px; background:rgba(37,99,235,.16); color:#bfdbfe; font:600 11px Roboto,Arial,sans-serif; cursor:pointer; }
      #${WORD_POPOVER_ID} .sc-word-expression-links button:hover { background:rgba(37,99,235,.3); color:#fff; }
      #${WORD_POPOVER_ID} .sc-word-title { min-width:0; flex:1; }
      #${WORD_POPOVER_ID} .sc-word-source { color:#e9d5ff; font-size:23px; font-weight:700; overflow-wrap:anywhere; }
      #${WORD_POPOVER_ID} .sc-word-primary { margin-top:3px; color:#fff; font-size:18px; font-weight:600; }
      #${WORD_POPOVER_ID} .sc-word-primary .sc-word-support-meaning { color:#85858f; }
      #${WORD_POPOVER_ID} .sc-word-primary .sc-word-meaning-divider { color:#62626c; padding:0 5px; }
      #${WORD_POPOVER_ID} .sc-word-section { flex:0 0 auto; padding:9px 11px; border-top:1px solid rgba(255,255,255,.09); }
      #${WORD_POPOVER_ID} .sc-word-meanings { flex:0 1 auto; min-height:0; max-height:min(250px,32vh); overflow-y:auto; overscroll-behavior:contain; }
      #${WORD_POPOVER_ID} .sc-word-meanings[data-long="1"] { min-height:min(150px,22vh); }
      #${WORD_POPOVER_ID}[data-compact="1"] .sc-word-meanings[data-long="1"] { min-height:100px; }
      #${WORD_POPOVER_ID} .sc-word-meanings-list { min-height:0; }
      #${WORD_POPOVER_ID} .sc-word-section-title { margin-bottom:6px; color:#a1a1aa; font-size:12px; font-weight:600; letter-spacing:.02em; }
      #${WORD_POPOVER_ID} .sc-word-ai { margin:0 0 8px; padding:8px 9px; border:1px solid rgba(168,85,247,.2); border-radius:8px; background:#27272a; color:#d4d4d8; font-size:12.5px; line-height:1.38; }
      #${WORD_POPOVER_ID} .sc-word-ai[hidden] { display:none; }
      #${WORD_POPOVER_ID} .sc-word-ai-label { margin-right:6px; color:#c4b5fd; font-size:12px; font-weight:750; }
      #${WORD_POPOVER_ID} .sc-word-ai-skeleton { width:100%; height:14px; }
      #${WORD_POPOVER_ID} .sc-word-ai[data-state="error"] { border-color:rgba(255,255,255,.08); color:#71717a; }
      #${WORD_POPOVER_ID} .sc-word-meaning { display:flex; gap:7px; margin:3px 0; font-size:15px; line-height:1.3; }
      #${WORD_POPOVER_ID} .sc-word-meaning-trigger { color:inherit; font:inherit; text-align:left; border:0; border-bottom:1px dotted currentColor; background:none; padding:0; cursor:pointer; }
      #${WORD_POPOVER_ID} .sc-word-english-choices:not([hidden]) { display:flex; flex-direction:column; gap:7px; padding:12px 14px; border-bottom:1px solid #39343f; font-size:14px; }
      #${WORD_POPOVER_ID} .sc-word-choices-title { display:flex; justify-content:space-between; align-items:center; gap:12px; }
      #${WORD_POPOVER_ID} .sc-word-english-choice { text-align:left; color:#c4b5fd; background:#292431; padding:7px 9px; border:0; border-radius:6px; font:inherit; }
      #${WORD_POPOVER_ID} button.sc-word-english-choice { cursor:pointer; }
      #${WORD_POPOVER_ID} .sc-word-examples { flex:1 1 250px; min-height:150px; max-height:min(330px,40vh); overflow-y:auto; overscroll-behavior:contain; }
      #${WORD_POPOVER_ID}[data-compact="1"] .sc-word-examples { min-height:110px; }
      #${WORD_POPOVER_ID} { overscroll-behavior:contain; }
      #${WORD_POPOVER_ID} .sc-word-example { position:relative; display:grid; grid-template-columns:minmax(0,1fr) auto auto; gap:7px; align-items:center; padding:6px 0; border-top:1px solid rgba(255,255,255,.07); }
      #${WORD_POPOVER_ID} .sc-word-example:first-of-type { border-top:0; }
      #${WORD_POPOVER_ID} .sc-word-example-toggle { appearance:none; display:block; min-width:0; width:100%; border:0; padding:0; background:transparent; color:inherit; text-align:left; cursor:pointer; }
      #${WORD_POPOVER_ID} .sc-word-example-toggle:focus-visible { outline:1px solid #a855f7; outline-offset:3px; border-radius:4px; }
      #${WORD_POPOVER_ID} .sc-word-example-text { font-size:15px; line-height:1.45; }
      #${WORD_POPOVER_ID} .sc-word-example-source { display:flex; align-items:center; gap:8px; }
      #${WORD_POPOVER_ID} .sc-word-example-source .sc-word-example-text { flex:1; min-width:0; }
      #${WORD_POPOVER_ID} .sc-word-chevron { flex:0 0 14px; color:#a78bfa; font-size:22px; line-height:1; }
      #${WORD_POPOVER_ID} .sc-word-example-token { display:inline; padding:0; border:0; border-radius:3px; background:none; color:inherit; font:inherit; cursor:pointer; }
      #${WORD_POPOVER_ID} .sc-word-example-token:hover { background:rgba(139,92,246,.3); }
      #${WORD_POPOVER_ID} .sc-word-example-token[data-focus="1"], #${WORD_POPOVER_ID} .sc-word-example-token[data-learning-state="saved"] { background:#5b2890; color:#fff; }
      #${WORD_POPOVER_ID} .sc-word-example-token[data-phrase-selected="1"] { background:#224caa; color:white; box-shadow:inset 0 -2px #93c5fd; }
      #${WORD_POPOVER_ID} .sc-word-example-translation { margin-top:3px; color:#a1a1aa; font-size:13px; }
      #${WORD_POPOVER_ID} .sc-word-example-meaning { margin-bottom:3px; color:#d8b4fe; font-size:12px; font-weight:650; }
      #${WORD_POPOVER_ID} .sc-word-example.support .sc-word-example-meaning { color:#8b8b95; }
      #${WORD_POPOVER_ID} .sc-word-example-play { align-self:center; opacity:.82; }
      #${WORD_POPOVER_ID} .sc-word-video-examples { margin-top:5px; border-top:1px solid rgba(255,255,255,.07); }
      #${WORD_POPOVER_ID} .sc-word-video-examples summary { padding:7px 0 2px; color:#71717a; cursor:pointer; font-size:12px; font-weight:600; list-style:none; }
      #${WORD_POPOVER_ID} .sc-word-video-examples summary::-webkit-details-marker { display:none; }
      #${WORD_POPOVER_ID} .sc-word-video-examples summary::before { content:'›'; display:inline-block; margin-right:6px; transform:rotate(0deg); transition:transform .12s; }
      #${WORD_POPOVER_ID} .sc-word-video-examples[open] summary::before { transform:rotate(90deg); }
      #${WORD_POPOVER_ID} mark { color:#fff; background:rgba(147,51,234,.48); border-radius:3px; padding:0; }
      #${WORD_POPOVER_ID} .sc-example-actions { display:flex; opacity:.42; transition:opacity .1s; }
      #${WORD_POPOVER_ID} .sc-word-example:hover .sc-example-actions { opacity:1; }
      #${WORD_POPOVER_ID} .sc-example-menu { position:absolute; right:4px; top:42px; display:flex; gap:4px; padding:5px; border-radius:8px; background:#3f3f46; box-shadow:0 8px 22px rgba(0,0,0,.4); }
      #${WORD_POPOVER_ID} .sc-example-menu[hidden] { display:none; }
      #${WORD_POPOVER_ID} .sc-example-menu button { border:0; border-radius:6px; padding:6px 8px; background:transparent; color:#f4f4f5; cursor:pointer; font-size:12px; }
      #${WORD_POPOVER_ID} .sc-example-menu button:hover { background:#52525b; }
      #${WORD_POPOVER_ID} .sc-word-footer { display:flex; flex:0 0 auto; justify-content:center; gap:5px; padding:8px 10px 10px; border-top:1px solid rgba(255,255,255,.09); }
      #${WORD_POPOVER_ID} .sc-word-footer button { display:inline-flex; align-items:center; gap:5px; min-width:88px; justify-content:center; border:1px solid #3f3f46; border-radius:8px; padding:6px 8px; background:#27272a; color:#e4e4e7; cursor:pointer; font-size:13px; }
      #${WORD_POPOVER_ID} .sc-word-footer button:hover { background:#3f3f46; }
      #${WORD_POPOVER_ID} .sc-word-footer button[data-active="1"] { border-color:#a855f7; color:#e9d5ff; background:rgba(147,51,234,.2); }
      #${WORD_POPOVER_ID} .sc-word-footer button[data-loading="1"] { cursor:wait; }
      #${WORD_POPOVER_ID} .sc-word-footer button[data-loading="1"] svg { display:none; }
      #${WORD_POPOVER_ID} .sc-word-footer button[data-loading="1"]::before { content:''; width:14px; height:14px; box-sizing:border-box; border:2px solid rgba(233,213,255,.35); border-top-color:#e9d5ff; border-radius:50%; animation:sc-learning-spin .8s linear infinite; }
      #${WORD_POPOVER_ID} .sc-word-footer button[data-error="1"] { border-color:rgba(248,113,113,.65); color:#fecaca; }
      #${WORD_POPOVER_ID} .sc-word-footer .sc-word-context-button { min-width:116px; }
      #${WORD_POPOVER_ID} .sc-word-footer .sc-word-context-button[data-active="1"] { border-color:#3f3f46; color:#a1a1aa; background:#27272a; }
      #${WORD_POPOVER_ID} .sc-word-footer svg { width:18px; height:18px; fill:currentColor; }
      #${WORD_POPOVER_ID} .sc-learning-icon-button { width:30px; height:30px; border-radius:7px; }
      #${WORD_POPOVER_ID} .sc-learning-icon-button svg { width:18px; height:18px; }
      #${WORD_POPOVER_ID} .sc-word-loading { padding:18px 14px; color:#a1a1aa; text-align:center; }
      #${WORD_POPOVER_ID} .sc-word-action-error:not([hidden]) { padding:10px 14px; color:#fda4af; font:400 13px/1.45 Roboto,Arial,sans-serif; white-space:normal; overflow-wrap:anywhere; border-bottom:1px solid #ffffff18; }
      #${WORD_POPOVER_ID} .sc-word-error { color:#fca5a5; }
      #${WORD_POPOVER_ID} .sc-word-primary[data-loading="1"] { width:150px; height:20px; margin-top:5px; }
      #${WORD_POPOVER_ID} .sc-word-skeleton {
        display:block;
        border-radius:5px;
        background:linear-gradient(90deg,rgba(255,255,255,.07),rgba(255,255,255,.15),rgba(255,255,255,.07));
        background-size:220% 100%;
        animation:sc-word-skeleton 1.15s ease-in-out infinite;
      }
      #${WORD_POPOVER_ID} .sc-word-skeleton-row { display:block; padding:7px 0; }
      #${WORD_POPOVER_ID} .sc-word-skeleton-lines { display:grid; gap:6px; }
      #${WORD_POPOVER_ID} .sc-word-skeleton-lines span { height:13px; }
      #${WORD_POPOVER_ID} .sc-word-skeleton-lines span:last-child { width:62%; }
      @keyframes sc-word-skeleton { 0% { background-position:100% 0; } 100% { background-position:-100% 0; } }
    `;
    document.head.appendChild(style);
  }

  function installSafeClick(button, handler) {
    if (typeof scInstallNoPlaybackClick === 'function') {
      scInstallNoPlaybackClick(button, handler);
      return;
    }
    button.addEventListener('pointerdown', event => event.stopPropagation());
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      handler(event);
    });
  }

  function iconButton(icon, label, handler) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sc-learning-icon-button';
    button.innerHTML = ICONS[icon] || '';
    button.title = label;
    button.setAttribute('aria-label', label);
    installSafeClick(button, handler);
    return button;
  }

  function updateCopyNeighborButtons(control) {
    for (const button of control?.querySelectorAll?.('[data-neighbor-count]') || []) {
      const selected = Number(button.dataset.neighborCount) === copyNeighborCount;
      button.dataset.selected = selected ? '1' : '0';
      button.setAttribute('aria-pressed', String(selected));
    }
  }

  async function copyCueWindow(direction = 'current') {
    const count = direction === 'current' ? 0 : copyNeighborCount;
    const side = direction === 'right' ? 'right' : 'left';
    const copiedCues = U.cueWindowItems(cues, currentCueIndex, count, side);
    const text = copiedCues.map(cue => cue.text).join(' ').replace(/\s+/g, ' ').trim();
    if (!text) return;
    const copied = await copyText(text);
    if (!copied || !copyCueControl) return;
    clearTimeout(copyFeedbackTimer);
    copyCueControl.dataset.copied = '1';
    copyCueControl.dataset.copiedCount = String(copiedCues.length);
    if (copyCueCountBadge) copyCueCountBadge.textContent = String(copiedCues.length);
    copyCueButton.title = `Скопировано реплик: ${copiedCues.length}`;
    copyCueButton.setAttribute('aria-label', copyCueButton.title);
    copyFeedbackTimer = setTimeout(() => {
      if (!copyCueControl) return;
      copyCueControl.dataset.copied = '0';
      delete copyCueControl.dataset.copiedCount;
      copyCueButton.title = 'Копировать текущую реплику';
      copyCueButton.setAttribute('aria-label', 'Копировать текущую реплику');
    }, 900);
    log('cue copied', {
      cueIndex: currentCueIndex,
      neighbors: count,
      copiedCues: copiedCues.length,
      direction,
      chars: text.length,
    });
  }

  function buildCueCopyControl() {
    const control = document.createElement('div');
    control.className = 'sc-learning-copy-control';
    control.dataset.visible = '0';
    control.dataset.copied = '0';
    control.dataset.open = '0';
    let closeTimer = null;
    const openMenu = () => {
      if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
      control.dataset.open = '1';
    };
    const scheduleClose = () => {
      if (closeTimer) clearTimeout(closeTimer);
      closeTimer = setTimeout(() => {
        if (!control.matches(':focus-within')) control.dataset.open = '0';
      }, 180);
    };
    control.addEventListener('pointerenter', openMenu);
    control.addEventListener('pointerleave', scheduleClose);
    copyCueButton = document.createElement('button');
    copyCueButton.type = 'button';
    copyCueButton.className = 'sc-learning-copy-launch';
    copyCueButton.innerHTML = `${ICONS.copy}<span class="sc-learning-copy-count" aria-hidden="true"></span>`;
    copyCueCountBadge = copyCueButton.querySelector('.sc-learning-copy-count');
    copyCueButton.title = 'Копировать текущую реплику';
    copyCueButton.setAttribute('aria-label', 'Копировать текущую реплику');
    installSafeClick(copyCueButton, () => { void copyCueWindow('current'); });

    const menu = document.createElement('div');
    menu.className = 'sc-learning-copy-menu';
    menu.setAttribute('aria-label', 'Добавить соседние реплики');
    for (const count of [1, 2, 3]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = String(count);
      button.dataset.neighborCount = String(count);
      button.title = `Добавить ${count} соседн${count === 1 ? 'юю реплику' : 'ие реплики'}`;
      installSafeClick(button, () => {
        copyNeighborCount = count;
        updateCopyNeighborButtons(control);
      });
      menu.appendChild(button);
    }
    const divider = document.createElement('span');
    divider.className = 'sc-learning-copy-divider';
    menu.appendChild(divider);
    for (const direction of ['left', 'right']) {
      const button = document.createElement('button');
      button.type = 'button';
      button.innerHTML = ICONS[direction];
      button.title = direction === 'left'
        ? 'Скопировать с предыдущими репликами'
        : 'Скопировать со следующими репликами';
      button.setAttribute('aria-label', button.title);
      installSafeClick(button, () => { void copyCueWindow(direction); });
      menu.appendChild(button);
    }
    const bridge = document.createElement('div');
    bridge.className = 'sc-learning-copy-bridge';
    bridge.setAttribute('aria-hidden', 'true');
    bridge.addEventListener('pointerenter', openMenu);
    menu.addEventListener('pointerenter', openMenu);
    control.append(copyCueButton, bridge, menu);
    updateCopyNeighborButtons(control);
    return control;
  }

  function playerAnchor() {
    if (externalMedia?.anchor?.isConnected) return externalMedia.anchor;
    if (!PLAYER_PAGE()) return null;
    if (!location.pathname.startsWith('/shorts/')) return document.getElementById('movie_player');
    const reels = Array.from(document.querySelectorAll('ytd-reel-video-renderer'));
    let best = null;
    let bestArea = 0;
    for (const reel of reels) {
      const rect = reel.getBoundingClientRect();
      const w = Math.max(0, Math.min(innerWidth, rect.right) - Math.max(0, rect.left));
      const h = Math.max(0, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top));
      if (w * h > bestArea) { best = reel; bestArea = w * h; }
    }
    return best?.querySelector('#movie_player') || best;
  }

  function playerVideo() {
    if (externalMedia?.video?.isConnected) return externalMedia.video;
    const anchor = playerAnchor();
    const videos = Array.from(anchor?.querySelectorAll('video') || []);
    return videos.find(video => {
      const rect = video.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }) || videos[0] || null;
  }

  function setControlsHovered(on) {
    if (hideControlsTimer) { clearTimeout(hideControlsTimer); hideControlsTimer = null; }
    if (on) {
      controlHovered = true;
      if (root) root.dataset.controlsVisible = '1';
      return;
    }
    hideControlsTimer = setTimeout(() => {
      controlHovered = false;
      if (root) root.dataset.controlsVisible = settingsPanel && !settingsPanel.hidden ? '1' : '0';
    }, 240);
  }

  function bindAnchorHover(anchor) {
    if (!anchor || anchor === activeAnchor) return;
    if (activeAnchor) {
      activeAnchor.removeEventListener('pointerenter', onAnchorEnter);
      activeAnchor.removeEventListener('pointerleave', onAnchorLeave);
    }
    activeAnchor = anchor;
    activeAnchor.addEventListener('pointerenter', onAnchorEnter);
    activeAnchor.addEventListener('pointerleave', onAnchorLeave);
    if (anchorResizeObserver) anchorResizeObserver.disconnect();
    if (typeof ResizeObserver !== 'undefined') {
      anchorResizeObserver = new ResizeObserver(updateGeometry);
      anchorResizeObserver.observe(anchor);
    }
  }
  function onAnchorEnter() { setControlsHovered(true); }
  function onAnchorLeave() { setControlsHovered(false); }

  function updateGeometry() {
    if (!root || !PLAYER_PAGE()) return;
    const anchor = playerAnchor();
    if (!anchor) return;
    bindAnchorHover(anchor);
    const rect = anchor.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    Object.assign(root.style, {
      left: `${Math.round(rect.left)}px`,
      top: `${Math.round(rect.top)}px`,
      width: `${Math.round(rect.width)}px`,
      height: `${Math.round(rect.height)}px`,
    });
    scheduleSubtitleLayout();
  }

  function updateRangeStepButtons(input) {
    for (const button of input?.__scStepButtons || []) {
      button.disabled = Number(button.dataset.direction) < 0
        ? Number(input.value) <= Number(input.min) : Number(input.value) >= Number(input.max);
    }
  }

  function updateSubtitleWidthControl(layout) {
    const input = settingsPanel?.querySelector?.('[data-setting="learning_subtitle_width_px"]');
    const output = settingsPanel?.querySelector?.('[data-setting-output="learning_subtitle_width_px"]');
    if (!input) return;
    const max = Math.max(1, Math.min(2400, Math.floor(layout?.maxWidth || 2400)));
    const min = Math.min(320, max);
    const value = Math.max(min, Math.min(max, Math.round(layout?.width || settings.learning_subtitle_width_px || 1600)));
    input.min = String(min);
    input.max = String(max);
    input.value = String(value);
    updateRangeStepButtons(input);
    const requestedWidth = Math.round(Number(settings.learning_subtitle_width_px) || 1600);
    if (output) output.textContent = layout?.clamped ? `${value}px (макс. ${requestedWidth}px)` : `${value}px`;
  }

  function applySubtitleWidth() {
    if (!root?.isConnected || !subtitleCard?.isConnected) return null;
    const rootRect = root.getBoundingClientRect();
    if (rootRect.width <= 0) return null;
    const requestedWidth = Number(settings.learning_subtitle_width_px) || 1600;
    const layout = U.subtitleWidthLayout({
      rootWidth: rootRect.width,
      requestedWidth,
      sideInset: SUBTITLE_SAFE_SIDE_INSET,
    });
    const width = Math.max(1, Math.floor(layout.width));
    subtitleCard.style.width = `${width}px`;
    root.dataset.subtitleWidth = String(width);
    updateSubtitleWidthControl({ ...layout, width });
    const reservedWidth = Number.parseFloat(translationRow?.style.minWidth || '');
    if (Number.isFinite(reservedWidth) && reservedWidth > width) translationRow.style.minWidth = `${width}px`;
    // Resize limits the visible width only. A new preference is persisted by
    // the slider's change event, never by player/viewport geometry changes.
    return layout;
  }

  function applySubtitleTypography() {
    if (!root) return;
    root.style.setProperty('--sc-learning-source-font-size', `${settings.learning_subtitle_source_font_px}px`);
    const targetPx = Math.round(settings.learning_subtitle_source_font_px * settings.learning_subtitle_target_font_percent) / 100;
    root.style.setProperty('--sc-learning-target-font-size', `${targetPx}px`);
  }

  function measureSourceSubtitleText(text) {
    if (!subtitleMeasureContext) {
      const canvas = document.createElement('canvas');
      subtitleMeasureContext = canvas.getContext('2d');
    }
    const fontSize = Math.max(1, Number(settings.learning_subtitle_source_font_px) || 34);
    if (!subtitleMeasureContext) return String(text || '').length * fontSize * 0.55;
    subtitleMeasureContext.font = `500 ${fontSize}px Roboto, Arial, sans-serif`;
    const wordPadding = U.segmentWords(text, sourceLanguage()).filter(part => part.word).length * 2;
    return subtitleMeasureContext.measureText(String(text || '')).width + wordPadding;
  }

  function reflowCuesForSubtitleLayout({ force = false, render = true } = {}) {
    if (!sourceCues.length || !root?.isConnected || !subtitleCard?.isConnected) return false;
    const cardWidth = subtitleCard.getBoundingClientRect().width
      || Number(root.dataset.subtitleWidth)
      || Number(settings.learning_subtitle_width_px)
      || 1600;
    const contentWidth = Math.max(80, Math.floor(cardWidth - 24));
    const fontSize = Math.max(1, Number(settings.learning_subtitle_source_font_px) || 34);
    const signature = `${contentWidth}:${fontSize}:${sourceCues.length}:${sourceCues[0]?.startMs || 0}:${sourceCues.at(-1)?.endMs || 0}`;
    if (!force && signature === subtitleCueLayoutSignature) return false;
    subtitleCueLayoutSignature = signature;
    const nextCues = U.layoutTimedCuesToFit(sourceCues, {
      maxWidth: contentWidth,
      measureText: measureSourceSubtitleText,
      language: sourceLanguage(),
    });
    const changed = nextCues.length !== cues.length
      || nextCues.some((cue, index) => cue.startMs !== cues[index]?.startMs
        || cue.endMs !== cues[index]?.endMs
        || cue.text !== cues[index]?.text);
    cues = nextCues;
    if (!changed || !render) return changed;
    currentCueIndex = -1;
    const video = playerVideo();
    renderCurrentVideoCue(video, true);
    startTranslationPrefetch();
    return true;
  }

  function scheduleSubtitleLayout() {
    if (subtitleLayoutFrame != null) return;
    subtitleLayoutFrame = requestAnimationFrame(() => {
      subtitleLayoutFrame = null;
      applySubtitleWidth();
      reflowCuesForSubtitleLayout();
      applySubtitlePlacement();
      positionPhraseHint();
    });
  }

  function subtitleOffsets() {
    return subtitleDragPreview || {
      x: Number(settings.learning_subtitle_offset_x) || 0,
      y: Number(settings.learning_subtitle_offset_y) || 0,
    };
  }

  function applySubtitlePlacement() {
    if (!root?.isConnected || !subtitleCard?.isConnected || subtitleCard.style.display === 'none') return null;
    const rootRect = root.getBoundingClientRect();
    const cardRect = subtitleCard.getBoundingClientRect();
    if (rootRect.width <= 0 || rootRect.height <= 0 || cardRect.width <= 0 || cardRect.height <= 0) return null;
    const offsets = subtitleOffsets();
    const placement = U.subtitleCardPlacement({
      rootWidth: rootRect.width,
      rootHeight: rootRect.height,
      cardWidth: cardRect.width,
      cardHeight: cardRect.height,
      position: settings.learning_subtitle_position,
      offsetX: offsets.x,
      offsetY: offsets.y,
      sideInset: SUBTITLE_SAFE_SIDE_INSET,
    });
    subtitleLastPlacement = placement;
    subtitleCard.style.left = `${Math.round(placement.left)}px`;
    subtitleCard.style.top = `${Math.round(placement.top)}px`;
    subtitleCard.style.bottom = 'auto';
    if (subtitleDragHandle) {
      const rightRail = settings.learning_controls_mirrored ? navRail : optionRail;
      const railRect = rightRail?.getBoundingClientRect?.();
      const handleTop = U.obstacleAvoidingTop({
        containerHeight: rootRect.height,
        itemHeight: 36,
        preferredTop: placement.top + cardRect.height / 2 - 18,
        obstacleTop: railRect?.height > 0 ? railRect.top - rootRect.top : NaN,
        obstacleBottom: railRect?.height > 0 ? railRect.bottom - rootRect.top : NaN,
      });
      subtitleDragHandle.style.top = `${Math.round(handleTop)}px`;
    }
    root.dataset.subtitleLeft = String(Math.round(placement.left));
    root.dataset.subtitleTop = String(Math.round(placement.top));
    root.dataset.subtitleOffsetX = placement.offsetX.toFixed(4);
    root.dataset.subtitleOffsetY = placement.offsetY.toFixed(4);
    return placement;
  }

  function beginSubtitleDrag(event) {
    if (event.button !== 0 || !root || !subtitleCard) return;
    event.preventDefault();
    event.stopPropagation();
    const rootRect = root.getBoundingClientRect();
    if (rootRect.width <= 0 || rootRect.height <= 0) return;
    subtitleDragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startOffsetX: Number(settings.learning_subtitle_offset_x) || 0,
      startOffsetY: Number(settings.learning_subtitle_offset_y) || 0,
      rootWidth: rootRect.width,
      rootHeight: rootRect.height,
      moved: false,
    };
    subtitleDragPreview = { x: subtitleDragState.startOffsetX, y: subtitleDragState.startOffsetY };
    root.dataset.dragging = '1';
    try { subtitleDragHandle.setPointerCapture(event.pointerId); } catch {}
    log('subtitle drag start', {
      offsetX: subtitleDragState.startOffsetX,
      offsetY: subtitleDragState.startOffsetY,
    });
  }

  function moveSubtitleDrag(event) {
    if (!subtitleDragState || event.pointerId !== subtitleDragState.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const dx = event.clientX - subtitleDragState.startX;
    const dy = event.clientY - subtitleDragState.startY;
    subtitleDragState.moved = subtitleDragState.moved || Math.abs(dx) + Math.abs(dy) >= 2;
    subtitleDragPreview = {
      x: subtitleDragState.startOffsetX + dx / Math.max(1, subtitleDragState.rootWidth),
      y: subtitleDragState.startOffsetY + dy / Math.max(1, subtitleDragState.rootHeight),
    };
    applySubtitlePlacement();
  }

  function finishSubtitleDrag(event) {
    if (!subtitleDragState || event.pointerId !== subtitleDragState.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const moved = subtitleDragState.moved;
    const placement = subtitleLastPlacement || applySubtitlePlacement();
    try { subtitleDragHandle.releasePointerCapture(event.pointerId); } catch {}
    subtitleDragState = null;
    subtitleDragPreview = null;
    if (root) root.dataset.dragging = '0';
    if (moved && placement) {
      void persistSettingsPatch({
        learning_subtitle_offset_x: placement.offsetX,
        learning_subtitle_offset_y: placement.offsetY,
      });
      log('subtitle drag saved', {
        offsetX: Number(placement.offsetX.toFixed(4)),
        offsetY: Number(placement.offsetY.toFixed(4)),
      });
    } else {
      applySubtitlePlacement();
    }
  }

  function buildSubtitleDragHandle() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sc-learning-drag-handle';
    button.innerHTML = ICONS.move;
    button.dataset.visible = '0';
    button.title = 'Переместить субтитры · двойной клик — сбросить положение';
    button.setAttribute('aria-label', button.title);
    button.addEventListener('pointerdown', beginSubtitleDrag);
    button.addEventListener('pointermove', moveSubtitleDrag);
    button.addEventListener('pointerup', finishSubtitleDrag);
    button.addEventListener('pointercancel', finishSubtitleDrag);
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener('dblclick', event => {
      event.preventDefault();
      event.stopPropagation();
      subtitleDragPreview = null;
      void persistSettingsPatch({ learning_subtitle_offset_x: 0, learning_subtitle_offset_y: 0 });
      log('subtitle drag reset');
    });
    return button;
  }

  function updateFullSubtitleReveal() {
    if (!root) return false;
    const reveal = U.fullSubtitleRevealActive({
      translationMode: settings.learning_translation_mode,
      metaKeyDown: fullTranslationMetaDown,
    });
    root.dataset.fullTranslationReveal = reveal ? '1' : '0';
    if (translationRow) {
      if (settings.learning_translation_mode === 'never' && !reveal) {
        translationRow.setAttribute('aria-hidden', 'true');
      } else {
        translationRow.removeAttribute('aria-hidden');
      }
    }
    if (reveal && currentCueIndex >= 0 && cues[currentCueIndex]) {
      ensureCueTranslation(currentCueIndex);
      renderTranslationForCue(currentCueIndex);
    }
    return reveal;
  }

  function hoverHoldRequested() {
    return subtitleHovered || wordPopoverOpen || phraseSelectionOpen || !!russianSelection;
  }

  function updateHoverHoldState() {
    if (!root) return;
    root.dataset.hoverHold = pausedForSubtitleHover
      ? 'active'
      : (hoverHoldRequested() ? 'scheduled' : 'off');
  }

  function resumeAfterHoverRelease() {
    updateHoverHoldState();
    if (hoverHoldRequested() || !pausedForSubtitleHover) return;
    const video = playerVideo();
    pausedForSubtitleHover = false;
    hoverPausedCueKey = '';
    updateHoverHoldState();
    if (video?.paused && !settings.learning_auto_pause) video.play().catch(() => {});
  }

  function relinquishHoverPauseOwnership() {
    pausedForSubtitleHover = false;
    hoverPausedCueKey = '';
    updateHoverHoldState();
  }

  function settleHoverAfterDismissal() {
    // A fixed popover can cover the previous hover target without Chromium
    // delivering a reliable pointerleave. Once it is gone, the rendered hit
    // target decides whether the subtitle hold is still actually requested.
    // Keep this synchronous: play() must run inside the real click/keyboard
    // activation that dismissed the card, not on a later animation frame.
    subtitleHovered = !!subtitleCard?.isConnected && subtitleCard.matches(':hover');
    updateFullSubtitleReveal();
    resumeAfterHoverRelease();
  }

  function releaseHoverHold({ resume = true } = {}) {
    clearRussianSelection({ resume: false });
    subtitleHovered = false;
    updateFullSubtitleReveal();
    wordPopoverOpen = false;
    phraseSelectionOpen = false;
    const shouldResume = resume && pausedForSubtitleHover;
    const video = playerVideo();
    pausedForSubtitleHover = false;
    hoverPausedCueKey = '';
    updateHoverHoldState();
    if (shouldResume && video?.paused && !settings.learning_auto_pause) video.play().catch(() => {});
  }

  function onSubtitlePointerEnter() {
    subtitleHovered = true;
    updateHoverHoldState();
    updateFullSubtitleReveal();
    if (currentCueIndex >= 0) {
      ensureCueTranslation(currentCueIndex);
      renderTranslationForCue(currentCueIndex);
    }
  }

  function onSubtitlePointerLeave() {
    subtitleHovered = false;
    updateFullSubtitleReveal();
    resumeAfterHoverRelease();
  }

  function translationPrefetchAhead() {
    return externalMedia?.literalPrefetchAhead ?? YOUTUBE_TRANSLATION_PREFETCH_AHEAD;
  }

  function translationInitialAhead() {
    return externalMedia?.literalInitialAhead ?? YOUTUBE_TRANSLATION_INITIAL_AHEAD;
  }

  function currentTranslationBufferSnapshot() {
    return U.translationBufferSnapshot({
      cues,
      currentIndex: currentCueIndex,
      ahead: translationPrefetchAhead(),
      translationMode: settings.learning_translation_mode,
      translationOrder: settings.learning_translation_order,
      literalNeeded: literalTranslationNeeded(),
      naturalReady: new Set(translationsByText.keys()),
      literalReady: new Set(literalTranslationsByText.keys()),
      naturalPending: pendingTranslationTexts,
      literalPending: pendingLiteralTexts,
    });
  }

  function bufferDurationLabel(value) {
    const duration = Math.max(0, Number(value) || 0);
    if (!duration) return '—';
    return duration < 1_000 ? `${Math.round(duration)} мс` : `${(duration / 1_000).toFixed(1)} с`;
  }

  function buildBufferDiagnosticsPanel() {
    const panel = document.createElement('div');
    panel.className = 'sc-learning-buffer-diagnostics';
    panel.dataset.state = 'empty';
    panel.innerHTML = [
      '<div class="sc-learning-buffer-head"><i></i><strong data-buffer-title>Буфер перевода</strong><span data-buffer-ahead>+0</span></div>',
      '<dl class="sc-learning-buffer-grid">',
      '<dt>Реплика</dt><dd data-buffer-cue>—</dd>',
      '<dt>Готово впереди</dt><dd data-buffer-ready>0 / 0</dd>',
      '<dt>Natural / literal</dt><dd data-buffer-layers>0 / 0</dd>',
      '<dt>Сейчас</dt><dd data-buffer-active>Azure 0 · Gemini 0</dd>',
      '<dt>В очереди</dt><dd data-buffer-queued>0</dd>',
      '<dt>Последний ответ</dt><dd data-buffer-latency>—</dd>',
      '</dl>',
      '<div class="sc-learning-buffer-error" data-buffer-error></div>',
    ].join('');
    bufferDiagnosticsPanels.push(panel);
    return panel;
  }

  function buildBufferDiagnosticsControl() {
    const control = document.createElement('div');
    control.className = 'sc-learning-buffer-control';
    control.dataset.bufferState = 'empty';
    control.append(
      iconButton('buffer', 'Дословный буфер', () => {}),
      buildBufferDiagnosticsPanel(),
    );
    return control;
  }

  function scheduleBufferDiagnosticsUpdate() {
    if (bufferDiagnosticsFrame != null || !root?.isConnected) return;
    bufferDiagnosticsFrame = requestAnimationFrame(() => {
      bufferDiagnosticsFrame = null;
      updateBufferDiagnostics();
    });
  }

  function updateBufferDiagnostics() {
    if (!root?.isConnected) return;
    const snapshot = currentTranslationBufferSnapshot();
    const currentText = String(cues[currentCueIndex]?.text || '').trim();
    const currentError = snapshot.stage === 'azure'
      ? translationError
      : snapshot.stage === 'gemini' ? (literalErrorsByText.get(currentText) || '') : '';
    const warmTarget = Math.min(snapshot.targetAhead, translationInitialAhead());
    const state = currentError ? 'error'
      : !snapshot.currentReady ? 'empty'
        : snapshot.readyAhead < warmTarget ? 'warming' : 'ready';
    const title = snapshot.stage === 'captions' ? 'Дорожка субтитров'
        : snapshot.stage === 'azure' ? 'Готовлю Azure'
          : snapshot.stage === 'gemini' ? 'Готовлю дословно'
            : snapshot.literal ? 'Дословный буфер' : 'Буфер перевода';
    const cueLabel = currentCueIndex >= 0 && cues.length
      ? `${currentCueIndex + 1} / ${cues.length}`
      : `0 / ${cues.length}`;
    const latencyParts = [];
    if (naturalLastLatencyMs) latencyParts.push(`Azure ${bufferDurationLabel(naturalLastLatencyMs)}`);
    if (literalLastLatencyMs) latencyParts.push(`Gemini ${bufferDurationLabel(literalLastLatencyMs)}`);
    if (literalLastQueueWaitMs >= 50) latencyParts.push(`ожидание ${bufferDurationLabel(literalLastQueueWaitMs)}`);
    const signature = [
      currentCueIndex,
      state,
      snapshot.stage,
      snapshot.readyAhead,
      snapshot.targetAhead,
      naturalRequestsActive,
      literalRequestsActive,
      literalRequestQueue.length,
      currentError,
    ].join('|');
    if (signature !== lastBufferDiagnosticsSignature) {
      lastBufferDiagnosticsSignature = signature;
      log('translation buffer state', {
        cueIndex: currentCueIndex,
        cues: cues.length,
        state,
        stage: snapshot.stage,
        readyAhead: snapshot.readyAhead,
        targetAhead: snapshot.targetAhead,
        naturalReady: snapshot.naturalReadyInWindow,
        literalReady: snapshot.literalReadyInWindow,
        naturalActive: naturalRequestsActive,
        literalActive: literalRequestsActive,
        literalQueued: literalRequestQueue.length,
        error: currentError || '',
      });
    }
    for (const panel of bufferDiagnosticsPanels) {
      if (!panel.isConnected) continue;
      panel.dataset.state = state;
      const control = panel.closest('.sc-learning-buffer-control');
      if (control) control.dataset.bufferState = state;
      panel.querySelector('[data-buffer-title]').textContent = title;
      panel.querySelector('[data-buffer-ahead]').textContent = snapshot.currentReady ? `+${snapshot.readyAhead}` : '+0';
      panel.querySelector('[data-buffer-cue]').textContent = cueLabel;
      panel.querySelector('[data-buffer-ready]').textContent = `${snapshot.readyAhead} / ${snapshot.targetAhead}`;
      panel.querySelector('[data-buffer-layers]').textContent = `${snapshot.naturalReadyInWindow} / ${snapshot.literalReadyInWindow}`;
      panel.querySelector('[data-buffer-active]').textContent = `Azure ${naturalRequestsActive} · Gemini ${literalRequestsActive}`;
      panel.querySelector('[data-buffer-queued]').textContent = String(literalRequestQueue.length);
      panel.querySelector('[data-buffer-latency]').textContent = latencyParts.join(' · ') || '—';
      const error = panel.querySelector('[data-buffer-error]');
      error.dataset.visible = currentError ? '1' : '0';
      error.textContent = currentError || '';
    }
  }

  function ensureRoot() {
    if (root?.isConnected) return root;
    injectCss();
    root = document.createElement('div');
    root.id = ROOT_ID;
    root.dataset.active = '0';
    root.dataset.controlsVisible = '0';
    root.dataset.hoverHold = 'off';
    root.dataset.fullTranslationReveal = '0';
    root.dataset.dragging = '0';
    bufferDiagnosticsPanels.length = 0;

    subtitleCard = document.createElement('div');
    subtitleCard.className = 'sc-learning-subtitle-card';
    subtitleCard.addEventListener('selectstart', event => event.preventDefault());
    subtitleCard.addEventListener('dragstart', event => event.preventDefault());
    subtitleCard.addEventListener('pointerenter', onSubtitlePointerEnter);
    subtitleCard.addEventListener('pointerleave', onSubtitlePointerLeave);
    statusRow = document.createElement('div');
    statusRow.className = 'sc-learning-status';
    statusRow.dataset.visible = '0';
    phraseHint = document.createElement('div');
    phraseHint.className = 'sc-learning-phrase-hint';
    phraseHint.dataset.visible = '0';
    phraseHint.dataset.cancellable = '0';
    phraseHint.setAttribute('role', 'button');
    phraseHint.tabIndex = -1;
    phraseHint.addEventListener('click', event => {
      if (!phraseSelectionOpen || phraseHint.dataset.cancellable !== '1') return;
      if (event.target.closest?.('button, a')) return;
      event.preventDefault();
      event.stopPropagation();
      clearPhraseSelection();
    });
    phraseHint.addEventListener('keydown', event => {
      if (!phraseSelectionOpen || phraseHint.dataset.cancellable !== '1'
          || event.target !== phraseHint || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      event.stopPropagation();
      clearPhraseSelection();
    });
    translationRow = document.createElement('div');
    translationRow.className = 'sc-learning-translation';
    sourceWrap = document.createElement('div');
    sourceWrap.className = 'sc-learning-source-wrap';
    sourceRow = document.createElement('div');
    sourceRow.className = 'sc-learning-source';
    sourceRow.addEventListener('pointerleave', () => {
      if (phraseSelectionOpen && !phraseSelection) renderPhraseRangeForCurrentCue({ preview: true });
    });
    copyCueControl = buildCueCopyControl();
    sourceWrap.append(sourceRow, copyCueControl);
    subtitleLines = document.createElement('div');
    subtitleLines.className = 'sc-learning-lines';
    // Only the space owned by the two visible lines is a hover bridge. The
    // wide transparent card and the reserved hidden translation stay inert.
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick']) {
      subtitleLines.addEventListener(type, event => {
        if (event.target !== subtitleLines) return;
        event.preventDefault();
        event.stopPropagation();
      });
    }
    subtitleLines.append(sourceWrap, translationRow);
    subtitleCard.append(statusRow, phraseHint, subtitleLines);
    phraseHintResizeObserver?.disconnect();
    if (typeof ResizeObserver !== 'undefined') {
      phraseHintResizeObserver = new ResizeObserver(() => { if (phraseHint?.dataset.visible === '1') requestAnimationFrame(positionPhraseHint); });
      phraseHintResizeObserver.observe(phraseHint);
      phraseHintResizeObserver.observe(subtitleCard);
    }

    navRail = document.createElement('div');
    navRail.className = 'sc-learning-rail sc-learning-nav';
    navRail.append(
      iconButton('previous', 'Предыдущая реплика (A / Ф)', () => seekRelativeCue(-1)),
      iconButton('replay', 'Повторить реплику', () => seekCue(currentCueIndex)),
      iconButton('next', 'Следующая реплика (D / В)', () => seekRelativeCue(1)),
      buildBufferDiagnosticsControl(),
    );

    optionRail = document.createElement('div');
    optionRail.className = 'sc-learning-rail sc-learning-options';
    const swapButton = iconButton('swap', 'Поменять стороны управления', () => {
      persistSettingsPatch({ learning_controls_mirrored: !settings.learning_controls_mirrored });
    });
    autoPauseButton = iconButton('pause', 'Автопауза после каждой реплики', () => {
      persistSettingsPatch({ learning_auto_pause: !settings.learning_auto_pause });
    });
    settingsButton = iconButton('settings', 'Настройки субтитров', () => {
      settingsPanel.hidden = !settingsPanel.hidden;
      root.dataset.controlsVisible = settingsPanel.hidden ? (controlHovered ? '1' : '0') : '1';
    });
    const translationModeButton = iconButton('translation', 'Переключить показ перевода', () => {
      void persistSettingsPatch({
        learning_translation_mode: U.nextTranslationMode(settings.learning_translation_mode),
      });
    });
    optionRail.append(swapButton, autoPauseButton, settingsButton, translationModeButton);

    subtitleDragHandle = buildSubtitleDragHandle();
    settingsPanel = buildSettingsPanel();
    root.append(subtitleCard, navRail, optionRail, subtitleDragHandle, settingsPanel);
    root.addEventListener('pointerenter', () => setControlsHovered(true));
    root.addEventListener('pointerleave', () => setControlsHovered(false));
    document.body.appendChild(root);
    if (typeof ResizeObserver === 'function') {
      subtitleCardResizeObserver?.disconnect();
      subtitleCardResizeObserver = new ResizeObserver(() => requestAnimationFrame(() => applySubtitlePlacement()));
      subtitleCardResizeObserver.observe(subtitleCard);
    }
    updateRootSettings();
    updateGeometry();
    updateBufferDiagnostics();
    return root;
  }

  function buildSettingsPanel() {
    const panel = document.createElement('div');
    panel.className = 'sc-learning-settings';
    panel.hidden = true;
    const head = document.createElement('div');
    head.className = 'sc-learning-settings-head';
    const title = document.createElement('span');
    title.textContent = 'Субтитры SC';
    const close = iconButton('close', 'Закрыть настройки', () => {
      panel.hidden = true;
      root.dataset.controlsVisible = controlHovered ? '1' : '0';
    });
    head.append(title, close);
    panel.appendChild(head);

    const languageOptions = [
      ['ru', 'Русский'], ['en', 'English'], ['de', 'Deutsch'], ['es', 'Español'],
      ['fr', 'Français'], ['it', 'Italiano'], ['pt', 'Português'], ['pl', 'Polski'],
      ['uk', 'Українська'], ['tr', 'Türkçe'], ['zh-Hans', '中文'], ['ja', '日本語'], ['ko', '한국어'],
    ];
    const addSelect = (label, key, options) => {
      const row = document.createElement('label');
      row.className = 'sc-learning-setting-row';
      const text = document.createElement('span');
      text.textContent = label;
      const select = document.createElement('select');
      select.dataset.setting = key;
      for (const [value, caption] of options) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = caption;
        select.appendChild(option);
      }
      select.addEventListener('change', () => persistSettingsPatch({ [key]: select.value }));
      row.append(text, select);
      panel.appendChild(row);
    };
    const addSwitch = (label, key, onValue = true, offValue = false, captions = null) => {
      const row = document.createElement('label');
      row.className = 'sc-learning-setting-row sc-learning-switch-row';
      const text = document.createElement('span');
      text.textContent = label;
      const control = document.createElement('button');
      control.type = 'button';
      control.className = 'sc-learning-switch';
      control.dataset.setting = key;
      control.dataset.settingOn = JSON.stringify(onValue);
      control.setAttribute('role', 'switch');
      control.setAttribute('aria-label', label);
      if (captions) {
        const labels = document.createElement('span');
        labels.className = 'sc-learning-switch-labels';
        labels.setAttribute('aria-hidden', 'true');
        for (const [state, caption] of [['off', captions[0]], ['on', captions[1]]]) {
          const value = document.createElement('span');
          value.dataset.switchCaption = state;
          value.textContent = caption;
          labels.appendChild(value);
        }
        control.appendChild(labels);
      }
      const track = document.createElement('span');
      track.className = 'sc-learning-switch-track';
      track.setAttribute('aria-hidden', 'true');
      control.appendChild(track);
      control.addEventListener('click', () => persistSettingsPatch({ [key]: settings[key] === onValue ? offValue : onValue }));
      control.addEventListener('keydown', event => {
        if (event.key === ' ' || event.key === 'Enter') event.stopPropagation();
      });
      row.append(text, control);
      panel.appendChild(row);
    };
    const addRange = (label, key, options = {}) => {
      const row = document.createElement('label');
      row.className = 'sc-learning-setting-row';
      if (key === 'learning_subtitle_width_px') row.classList.add('sc-learning-width-setting');
      const text = document.createElement('span');
      text.textContent = label;
      const control = document.createElement('span');
      control.className = 'sc-learning-setting-range';
      control.style.gridTemplateColumns = '24px minmax(0,1fr) auto 24px';
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(options.min ?? 320);
      input.max = String(options.max ?? 2400);
      input.step = String(options.step ?? 20);
      input.dataset.setting = key;
      const output = document.createElement('output');
      output.dataset.settingOutput = key;
      output.dataset.settingUnit = options.unit || 'px';
      input.addEventListener('input', () => {
        const value = Number(input.value);
        settings = applyYoutubeSettingsPatch(settings, { [key]: value });
        output.textContent = `${value}${output.dataset.settingUnit}`;
        updateRangeStepButtons(input);
        if (key === 'learning_subtitle_width_px') scheduleSubtitleLayout();
        else {
          applySubtitleTypography();
          scheduleSubtitleLayout();
        }
      });
      input.addEventListener('change', () => persistSettingsPatch({ [key]: Number(input.value) }));
      const stepButton = direction => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'sc-learning-range-step';
        button.textContent = direction < 0 ? '−' : '+';
        button.setAttribute('aria-label', `${direction < 0 ? 'Уменьшить' : 'Увеличить'} ${label}`);
        button.dataset.settingStep = key;
        button.dataset.direction = String(direction);
        button.addEventListener('click', event => {
          event.preventDefault(); event.stopPropagation();
          const value = Math.max(Number(input.min), Math.min(Number(input.max), Math.round((Number(input.value) + direction) * 100) / 100));
          void persistSettingsPatch({ [key]: value });
        });
        return button;
      };
      input.__scStepButtons = [stepButton(-1), stepButton(1)];
      control.append(input.__scStepButtons[0], input, output, input.__scStepButtons[1]);
      row.append(text, control);
      panel.appendChild(row);
    };

    const source = document.createElement('div');
    source.className = 'sc-learning-setting-row';
    source.innerHTML = '<span>Дорожка YouTube</span><span data-source-track style="text-align:right;color:#a1a1aa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>';
    panel.appendChild(source);
    addSelect('Перевод', 'learning_target_lang', languageOptions);
    addSwitch('Порядок строк', 'learning_subtitle_language_order', 'target_first', 'source_first', ['English → Русский', 'Русский → English']);
    addRange('Ширина', 'learning_subtitle_width_px', { min: 320, max: 2400, step: 1 });
    addRange('English · шрифт', 'learning_subtitle_source_font_px', { min: 16, max: 64, step: 1 });
    addRange('Русский · шрифт', 'learning_subtitle_target_font_percent', { min: 20, max: 325, step: 0.01, unit: '%' });
    addSwitch('Показывать перевод', 'learning_translation_mode', 'always', 'never');
    addSwitch('Порядок перевода', 'learning_translation_order', 'source', 'natural', ['Естественный', 'Как в английском']);
    addSwitch('Перевод слова при наведении', 'learning_hover_word_translation');
    addSwitch('Автопауза', 'learning_auto_pause');
    addSwitch('Поменять стороны', 'learning_controls_mirrored');
    addSwitch('Скрывать родные CC', 'learning_hide_native_subtitles');
    return panel;
  }

  function updateRootSettings() {
    if (!root) return;
    root.dataset.position = settings.learning_subtitle_position;
    root.dataset.languageOrder = settings.learning_subtitle_language_order;
    root.dataset.mirrored = settings.learning_controls_mirrored ? '1' : '0';
    root.dataset.translationMode = settings.learning_translation_mode;
    updateFullSubtitleReveal();
    autoPauseButton?.setAttribute('data-active', settings.learning_auto_pause ? '1' : '0');
    settingsButton?.setAttribute('data-active', settingsPanel && !settingsPanel.hidden ? '1' : '0');
    for (const input of settingsPanel?.querySelectorAll('[data-setting]') || []) {
      const key = input.dataset.setting;
      if (input.getAttribute('role') === 'switch') input.setAttribute('aria-checked', String(settings[key] === JSON.parse(input.dataset.settingOn)));
      else if (input.type === 'checkbox') input.checked = !!settings[key];
      else input.value = settings[key];
      if (input.type === 'range') updateRangeStepButtons(input);
      const output = settingsPanel.querySelector(`[data-setting-output="${key}"]`);
      if (output) output.textContent = `${settings[key]}${output.dataset.settingUnit || 'px'}`;
    }
    const source = settingsPanel?.querySelector('[data-source-track]');
    if (source) source.textContent = selectedTrack?.label || selectedTrack?.languageCode || 'Авто';
    if (subtitleCard && subtitleLines && statusRow && phraseHint && sourceWrap && translationRow) {
      subtitleCard.append(statusRow, phraseHint, subtitleLines);
      if (settings.learning_subtitle_language_order === 'target_first') subtitleLines.append(translationRow, sourceWrap);
      else subtitleLines.append(sourceWrap, translationRow);
    }
    applyNativeCaptionVisibility();
    if (!settings.learning_hover_word_translation) hideQuickWordPopover();
    else if (currentCueIndex >= 0 && cues[currentCueIndex]) void prefetchQuickWordTranslations(cues[currentCueIndex]);
    applySubtitleTypography();
    scheduleSubtitleLayout();
    scheduleBufferDiagnosticsUpdate();
  }

  async function persistSettingsPatch(patch) {
    const previousTarget = settings.learning_target_lang;
    const previousTranslationOrder = settings.learning_translation_order;
    const previousTranslationMode = settings.learning_translation_mode;
    settings = applyYoutubeSettingsPatch(settings, patch);
    const settingsSnapshot = { ...settings };
    const patchSnapshot = { ...patch };
    updateRootSettings();
    const write = async () => {
      try { await chrome.storage.sync.set({ __yt: settingsSnapshot }); } catch {}
      try {
        await new Promise(resolve => {
          chrome.runtime.sendMessage({ type: 'sc-youtube-settings-patch', patch: patchSnapshot }, () => {
            const error = chrome.runtime.lastError;
            if (error) log('settings patch queued locally', { error: error.message });
            resolve();
          });
        });
      } catch {}
    };
    const queued = settingsPersistQueue.catch(() => {}).then(write);
    settingsPersistQueue = queued;
    await queued;
    if (previousTarget !== settings.learning_target_lang) {
      translationsByText.clear();
      translationAlignmentsByText.clear();
      resetLiteralTranslationState();
      translationError = '';
      literalTranslationError = '';
      prefetchGeneration += 1;
      prefetchRerunRequested = false;
      naturalLastLatencyMs = 0;
      renderCue(currentCueIndex, true);
      startTranslationPrefetch();
    } else if (previousTranslationOrder !== settings.learning_translation_order) {
      renderTranslationForCue(currentCueIndex);
      if (settings.learning_translation_order === 'source') {
        prefetchLiteralWindow(currentCueIndex);
      }
    }
    if (previousTranslationMode !== settings.learning_translation_mode) {
      prefetchGeneration += 1;
      prefetchRerunRequested = false;
      renderTranslationForCue(currentCueIndex);
      startTranslationPrefetch();
    }
  }

  function requestFreshSettingsFromDesktop(timeoutMs = 4_500) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('settings refresh timeout')), timeoutMs);
      try {
        chrome.runtime.sendMessage({ __sc_get_fresh_youtube_settings: true }, response => {
          clearTimeout(timer);
          const error = chrome.runtime.lastError;
          if (error) { reject(new Error(error.message)); return; }
          if (!response?.ok || !response.settings) {
            reject(new Error(response?.error || 'settings refresh failed'));
            return;
          }
          resolve(response.settings);
        });
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  async function syncSettingsFromDesktop() {
    if (settingsRefreshBusy || !PLAYER_PAGE()) return;
    settingsRefreshBusy = true;
    try {
      const previous = settings;
      const fresh = sanitizeYoutubeSettings({ ...settings, ...await requestFreshSettingsFromDesktop() });
      settings = fresh;
      updateRootSettings();
      if (previous.learning_target_lang !== fresh.learning_target_lang) {
        translationsByText.clear();
        translationAlignmentsByText.clear();
        resetLiteralTranslationState();
        translationError = '';
        literalTranslationError = '';
        prefetchGeneration += 1;
        prefetchRerunRequested = false;
        naturalLastLatencyMs = 0;
        renderCue(currentCueIndex, true);
      }
      if (previous.learning_translation_order !== fresh.learning_translation_order) {
        renderTranslationForCue(currentCueIndex);
        if (fresh.learning_translation_order === 'source') {
          prefetchLiteralWindow(currentCueIndex);
        }
      }
      if (previous.learning_translation_mode !== fresh.learning_translation_mode) {
        prefetchGeneration += 1;
        prefetchRerunRequested = false;
        renderTranslationForCue(currentCueIndex);
        startTranslationPrefetch();
      }
      if (previous.learning_enabled !== fresh.learning_enabled) syncOverlay({ force: true });
    } catch (error) {
      log('settings refresh fallback', { error: error?.message || String(error) });
    } finally {
      settingsRefreshBusy = false;
    }
  }

  function setStatus(text, { loading = false } = {}) {
    if (!statusRow) return;
    statusRow.textContent = text || '';
    statusRow.dataset.visible = text ? '1' : '0';
    statusRow.dataset.loading = text && loading ? '1' : '0';
  }

  function activateOverlay() {
    ensureRoot();
    overlayActive = true;
    root.dataset.active = '1';
    updateGeometry();
    applyNativeCaptionVisibility();
  }

  function deactivateOverlay() {
    hideQuickWordPopover();
    const cleanup = U.overlayDeactivationPlan({
      overlayActive,
      subtitleHovered,
      pausedForSubtitleHover,
      phraseSelectionOpen,
      hasPhraseSelection: !!phraseSelection,
      wordPopoverOpen,
      hasWordPopover: !!document.getElementById(WORD_POPOVER_ID),
    });
    if (cleanup.clearPhrase) clearPhraseSelection({ resume: false });
    if (cleanup.releaseHover) releaseHoverHold({ resume: true });
    overlayActive = false;
    if (root) root.dataset.active = '0';
    document.documentElement.classList.remove(HIDE_NATIVE_CLASS);
    document.documentElement.classList.remove(REPLACE_LEGACY_CLASS);
    if (cleanup.closePopover || pendingWordClickTimer != null) closeWordPopover();
  }

  function applyNativeCaptionVisibility() {
    const shouldHide = overlayActive && settings.learning_hide_native_subtitles;
    document.documentElement.classList.toggle(HIDE_NATIVE_CLASS, shouldHide);
    // Language Reactor may still be installed during migration. Replace its
    // subtitle surface only after our timed cues are ready; on any failure it
    // remains available instead of being hidden by a half-working overlay.
    document.documentElement.classList.toggle(REPLACE_LEGACY_CLASS, overlayActive && cues.length > 0);
  }

  function injectMainBridge() {
    return new Promise((resolve, reject) => {
      const existing = document.getElementById(MAIN_BRIDGE_ID);
      if (existing) { resolve(); return; }
      const script = document.createElement('script');
      script.id = MAIN_BRIDGE_ID;
      script.src = chrome.runtime.getURL('youtube-main-bridge.js');
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('YouTube main-world bridge failed to load'));
      (document.head || document.documentElement).appendChild(script);
    });
  }

  window.addEventListener('message', event => {
    if (event.source !== window) return;
    const message = event.data;
    if (!message || message.source !== 'sc-yt-learning-main') return;
    const pending = snapshotRequests.get(message.requestId);
    if (!pending) return;
    snapshotRequests.delete(message.requestId);
    clearTimeout(pending.timer);
    if (message.payload?.ok) pending.resolve(message.payload);
    else pending.reject(new Error(message.payload?.error || 'caption snapshot failed'));
  });

  async function mainWorldRequest(type, payload = {}) {
    await injectMainBridge();
    const requestId = `scyt-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        snapshotRequests.delete(requestId);
        reject(new Error('caption snapshot timeout'));
      }, 4_000);
      snapshotRequests.set(requestId, { resolve, reject, timer });
      window.postMessage({ source: 'sc-yt-learning-content', type, requestId, ...payload }, '*');
    });
  }

  function captionSnapshot() {
    return mainWorldRequest('caption-snapshot');
  }

  function fetchCaptionInMainWorld(url) {
    return mainWorldRequest('caption-fetch', { url });
  }

  function captionButtonEnabled() {
    if (externalMedia) return true;
    return document.querySelector('.ytp-subtitles-button')?.getAttribute('aria-pressed') === 'true';
  }

  function chooseTrack(snapshot) {
    const tracks = Array.isArray(snapshot?.tracks) ? snapshot.tracks : [];
    const selected = snapshot?.selected;
    if (selected?.baseUrl) return selected;
    if (selected) {
      const byVss = tracks.find(track => selected.vssId && track.vssId === selected.vssId);
      if (byVss) return byVss;
      const byLangKind = tracks.find(track => (
        track.languageCode === selected.languageCode && track.kind === selected.kind
      ));
      if (byLangKind) return byLangKind;
      const byLang = tracks.find(track => track.languageCode === selected.languageCode);
      if (byLang) return byLang;
    }
    return tracks.find(track => !track.kind) || tracks[0] || null;
  }

  function trackIdentity(track, snapshot) {
    return [snapshot?.videoId || '', track?.vssId || '', track?.languageCode || '', track?.kind || '', track?.baseUrl || ''].join('|');
  }

  function parseXmlCues(text) {
    try {
      const doc = new DOMParser().parseFromString(text, 'text/xml');
      const raw = Array.from(doc.querySelectorAll('text')).map(node => {
        const start = Number(node.getAttribute('start')) * 1_000;
        const duration = Number(node.getAttribute('dur')) * 1_000;
        return {
          startMs: start,
          endMs: Number.isFinite(duration) ? start + duration : null,
          text: node.textContent || '',
        };
      });
      return U.finalizeCues(raw);
    } catch { return []; }
  }

  function prepareCaptionCues(rawCues, track) {
    return U.finalizeCues(rawCues || []);
  }

  async function fetchCaptionCues(track) {
    const jsonUrl = new URL(track.baseUrl);
    jsonUrl.searchParams.set('fmt', 'json3');
    let response = await fetchCaptionInMainWorld(jsonUrl.toString());
    if (!response.ok) throw new Error(`YouTube captions HTTP ${response.status}`);
    let text = response.text || '';
    log('caption json response', {
      status: response.status,
      contentType: response.contentType,
      chars: text.length,
      head: text.slice(0, 180),
      languageCode: track.languageCode,
      kind: track.kind,
    });
    let parsed = [];
    try { parsed = U.parseJson3Cues(JSON.parse(text)); } catch {}
    if (!parsed.length && /<transcript|<text[\s>]/i.test(text)) parsed = parseXmlCues(text);
    if (parsed.length) return prepareCaptionCues(parsed, track);

    // An empty timedtext response is YouTube declining script access, not a
    // format mismatch. Trying VTT in that state only adds another round trip.
    if (text.trim()) {
      const vttUrl = new URL(track.baseUrl);
      vttUrl.searchParams.set('fmt', 'vtt');
      response = await fetchCaptionInMainWorld(vttUrl.toString());
      if (!response.ok) throw new Error(`YouTube captions VTT HTTP ${response.status}`);
      text = response.text || '';
      log('caption vtt response', {
        status: response.status,
        contentType: response.contentType,
        chars: text.length,
        head: text.slice(0, 180),
      });
      parsed = U.parseVttCues(text);
      if (!parsed.length) parsed = parseXmlCues(text);
      if (parsed.length) return prepareCaptionCues(parsed, track);
    }

    // Recent YouTube sessions can expose a valid timedtext URL to the player
    // while returning an empty body to script fetches. SC Desktop already has
    // a cookie-aware yt-dlp/transcript-api race for timestamped derivatives;
    // use that as the deterministic fallback without involving paid AI.
    const videoId = videoMeta.videoId || extractVideoIdFromLocation();
    if (!videoId) throw new Error('YouTube returned an empty caption track');
    log('caption direct empty, using local timed fallback', { videoId, languageCode: track.languageCode });
    const fallback = await bridgeJson('/yt-learning-cues', {
      method: 'POST',
      body: {
        videoId,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        lang: track.languageCode || 'en',
        title: videoMeta.title || document.title.replace(/\s+-\s+YouTube\s*$/, ''),
      },
    });
    parsed = prepareCaptionCues(fallback.cues || [], track);
    if (!parsed.length) throw new Error('YouTube returned an empty caption track');
    return parsed;
  }

  async function bridgeJson(path, options = {}) {
    // The catalogue can legitimately take several provider stages. Its server
    // deadline is ten minutes; reads and disconnected transports must not hang.
    const timeoutMs = ['save', 'prepare', 'translation-edit'].includes(options.body?.action) ? 610_000 : 125_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
    const response = await fetch(BRIDGE + path, {
      method: options.method || 'GET',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    let payload = null;
    try { payload = await response.json(); } catch {}
    if (!response.ok || payload?.ok === false) {
      const error = new Error(payload?.error || `SC Desktop HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    if (!payload || typeof payload !== 'object') throw new Error('SC Desktop вернул пустой ответ. Повторите запрос.');
    return payload;
    } catch (error) {
      if (controller.signal.aborted) throw new Error('Не удалось дождаться ответа SC Desktop. Результат операции пока не подтверждён; состояние словаря будет проверено при восстановлении связи.');
      if (error instanceof TypeError) throw new Error('Нет связи с SC Desktop. Проверьте, что приложение запущено; результат операции пока не подтверждён.');
      throw error;
    } finally { clearTimeout(timer); }
  }

  async function loadTrack(track, snapshot) {
    const generation = ++loadGeneration;
    prefetchGeneration += 1;
    prefetchRerunRequested = false;
    naturalLastLatencyMs = 0;
    lastBufferDiagnosticsSignature = '';
    selectedTrack = track;
    videoMeta = {
      videoId: snapshot?.videoId || extractVideoIdFromLocation(),
      title: snapshot?.title || document.title.replace(/\s+-\s+YouTube\s*$/, ''),
    };
    sourceCues = [];
    cues = [];
    subtitleCueLayoutSignature = '';
    currentCueIndex = -1;
    translationsByText.clear();
    translationAlignmentsByText.clear();
    pendingTranslationTexts.clear();
    resetLiteralTranslationState();
    translationError = '';
    literalTranslationError = '';
    scheduleBufferDiagnosticsUpdate();
    subtitleCard.style.display = '';
    sourceRow.replaceChildren();
    if (copyCueControl) copyCueControl.dataset.visible = '0';
    translationRow.textContent = '';
    setStatus('Загружаю дорожку субтитров…', { loading: true });
    updateRootSettings();
    try {
      const loaded = await fetchCaptionCues(track);
      if (generation !== loadGeneration) return;
      sourceCues = loaded;
      reflowCuesForSubtitleLayout({ force: true, render: false });
      setStatus('');
      applyNativeCaptionVisibility();
      activeVideo = playerVideo();
      renderCurrentVideoCue(activeVideo, true);
      log('captions loaded', { videoId: videoMeta.videoId, lang: track.languageCode, cues: cues.length });
      startTranslationPrefetch();
      scheduleBufferDiagnosticsUpdate();
    } catch (error) {
      if (generation !== loadGeneration) return;
      // A YouTube main-world fetch can time out during SPA navigation or tab
      // visibility changes. Keep the same track eligible for the next sync
      // instead of freezing the error forever behind its previous identity.
      lastTrackIdentity = '';
      setStatus(`Не удалось прочитать субтитры: ${error?.message || error}`);
      log('captions failed', { error: error?.message || String(error) });
      scheduleBufferDiagnosticsUpdate();
    }
  }

  function resetTimedMediaState() {
    hideQuickWordPopover();
    loadGeneration += 1;
    prefetchGeneration += 1;
    prefetchRerunRequested = false;
    sourceCues = [];
    cues = [];
    subtitleCueLayoutSignature = '';
    currentCueIndex = -1;
    selectedTrack = null;
    videoMeta = { videoId: '', title: '' };
    translationsByText.clear();
    translationAlignmentsByText.clear();
    pendingTranslationTexts.clear();
    resetLiteralTranslationState();
    translationError = '';
    literalTranslationError = '';
    naturalLastLatencyMs = 0;
    lastBufferDiagnosticsSignature = '';
    autoPausedCueKey = '';
    lastVideoTimeMs = null;
    closeWordPopover({ resume: false });
    clearPhraseSelection({ resume: false });
    scheduleBufferDiagnosticsUpdate();
  }

  function seedExternalTranslations(rawTranslations) {
    for (const item of Array.isArray(rawTranslations) ? rawTranslations : []) {
      const sourceText = String(item?.source_text || item?.sourceText || '').trim();
      if (!sourceText) continue;
      translationsByText.set(sourceText, String(item?.translated_text || item?.translatedText || ''));
      translationAlignmentsByText.set(sourceText, String(item?.alignment || ''));
    }
  }

  async function openExternalMedia(payload = {}) {
    const anchor = payload.anchor;
    const video = payload.video;
    if (!(anchor instanceof Element) || !(video instanceof HTMLVideoElement)) {
      throw new Error('Learning media requires a visible player and HTML video element');
    }
    const prepared = U.finalizeCues(Array.isArray(payload.cues) ? payload.cues : []);
    if (!prepared.length) throw new Error('Timed subtitles are empty');

    resetTimedMediaState();
    externalMedia = {
      anchor,
      video,
      id: String(payload.id || payload.videoId || `local-${Date.now()}`),
      title: String(payload.title || 'Локальное видео'),
      sourceUrl: String(payload.sourceUrl || location.href),
      sourceName: String(payload.sourceName || 'Локальные субтитры'),
      literalPrefetchAhead: Math.max(2, Math.trunc(Number(payload.literalPrefetchAhead) || EXTERNAL_LITERAL_PREFETCH_AHEAD)),
      literalInitialAhead: Math.max(0, Math.trunc(Number(payload.literalInitialAhead) || EXTERNAL_LITERAL_INITIAL_AHEAD)),
      initializingLiteral: true,
    };
    selectedTrack = {
      languageCode: String(payload.languageCode || 'en'),
      label: String(payload.trackLabel || payload.languageCode || 'English'),
      kind: 'external',
    };
    videoMeta = { videoId: externalMedia.id, title: externalMedia.title };
    sourceCues = prepared;
    reflowCuesForSubtitleLayout({ force: true, render: false });
    seedExternalTranslations(payload.translations);
    ensureRoot();
    activateOverlay();
    setStatus('');
    applyNativeCaptionVisibility();
    activeVideo = video;
    renderCurrentVideoCue(video, true);
    startTranslationPrefetch();
    const nextCueIndex = cues.findIndex(cue => cue.startMs >= video.currentTime * 1_000);
    const literalCenterIndex = currentCueIndex >= 0
      ? currentCueIndex
      : nextCueIndex >= 0 ? nextCueIndex : Math.max(0, cues.length - 1);
    if (settings.learning_translation_order === 'source' && literalTranslationNeeded() && literalCenterIndex >= 0) {
      const progress = typeof payload.onLiteralProgress === 'function' ? payload.onLiteralProgress : null;
      const buffered = await prefetchLiteralRange(
        literalCenterIndex,
        externalMedia.literalInitialAhead,
        { onProgress: progress },
      );
      log('external literal buffer ready', {
        videoId: videoMeta.videoId,
        cueIndex: literalCenterIndex,
        ready: buffered.ready,
        total: buffered.total,
      });
    }
    if (externalMedia) externalMedia.initializingLiteral = false;
    if (settings.learning_translation_order === 'source' && literalTranslationNeeded()) {
      void prefetchLiteralWindow(literalCenterIndex);
    }
    renderTranslationForCue(currentCueIndex);
    updateGeometry();
    log('external media opened', { videoId: videoMeta.videoId, cues: cues.length, title: videoMeta.title });
    return { ok: true, cues: cues.length };
  }

  function closeExternalMedia() {
    if (!externalMedia) return false;
    resetTimedMediaState();
    externalMedia = null;
    deactivateOverlay();
    return true;
  }

  async function syncOverlay({ force = false } = {}) {
    if (externalMedia) {
      if (!externalMedia.anchor?.isConnected || !externalMedia.video?.isConnected) {
        closeExternalMedia();
        return;
      }
      activateOverlay();
      updateGeometry();
      return;
    }
    if (syncBusy) return;
    if (!PLAYER_PAGE() || !settings.learning_enabled || !captionButtonEnabled()) {
      deactivateOverlay();
      return;
    }
    activateOverlay();
    const now = Date.now();
    if (!force && cues.length && now - lastSnapshotAt < 4_000) return;
    syncBusy = true;
    try {
      const snapshot = await captionSnapshot();
      lastSnapshotAt = Date.now();
      const track = chooseTrack(snapshot);
      log('caption snapshot', {
        videoId: snapshot.videoId,
        tracks: snapshot.tracks?.map(item => ({
          languageCode: item.languageCode,
          kind: item.kind,
          vssId: item.vssId,
          label: item.label,
          hasBaseUrl: !!item.baseUrl,
        })),
        selected: snapshot.selected ? {
          languageCode: snapshot.selected.languageCode,
          kind: snapshot.selected.kind,
          vssId: snapshot.selected.vssId,
          label: snapshot.selected.label,
          hasBaseUrl: !!snapshot.selected.baseUrl,
        } : null,
      });
      if (!track) {
        sourceCues = [];
        cues = [];
        subtitleCueLayoutSignature = '';
        setStatus('Для этого видео нет доступной дорожки субтитров');
        return;
      }
      const identity = trackIdentity(track, snapshot);
      if (identity !== lastTrackIdentity) {
        lastTrackIdentity = identity;
        await loadTrack(track, snapshot);
      }
    } catch (error) {
      setStatus(`Субтитры недоступны: ${error?.message || error}`);
    } finally {
      syncBusy = false;
    }
  }

  function sourceLanguage() {
    const raw = selectedTrack?.languageCode || 'en';
    return /^[a-z]{2,3}/i.test(raw) ? raw : 'en';
  }

  function literalTranslationNeeded() {
    return sourceLanguage().toLocaleLowerCase('en-US') !== String(settings.learning_target_lang || '').toLocaleLowerCase('en-US');
  }

  function currentMediaUrl() {
    if (externalMedia?.sourceUrl) return externalMedia.sourceUrl;
    return videoMeta.videoId ? `https://www.youtube.com/watch?v=${videoMeta.videoId}` : location.href;
  }

  function currentMediaSourceName() {
    return externalMedia?.sourceName || 'YouTube subtitles';
  }

  async function requestTranslations(batch, generation) {
    const texts = batch.map(item => item.text);
    texts.forEach(text => pendingTranslationTexts.add(text));
    const startedAt = performance.now();
    naturalRequestsActive += 1;
    scheduleBufferDiagnosticsUpdate();
    try {
      if (sourceLanguage().toLowerCase() === settings.learning_target_lang.toLowerCase()) {
        texts.forEach(text => {
          translationsByText.set(text, text);
          translationAlignmentsByText.set(text, '');
        });
        return;
      }
      const payload = await bridgeJson('/translator/translate', {
        method: 'POST',
        body: { texts, from: sourceLanguage(), to: settings.learning_target_lang },
      });
      if (generation !== prefetchGeneration) return;
      for (const item of payload.translations || []) {
        if (!item.source_text) continue;
        translationsByText.set(item.source_text, item.translated_text || '');
        translationAlignmentsByText.set(item.source_text, item.alignment || '');
      }
      translationError = '';
    } catch (error) {
      if (generation === prefetchGeneration) translationError = error?.message || String(error);
    } finally {
      if (generation === prefetchGeneration) naturalLastLatencyMs = Math.max(0, performance.now() - startedAt);
      naturalRequestsActive = Math.max(0, naturalRequestsActive - 1);
      texts.forEach(text => pendingTranslationTexts.delete(text));
      if (generation === prefetchGeneration && currentCueIndex >= 0) {
        renderTranslationForCue(currentCueIndex);
        prefetchLiteralWindow(currentCueIndex);
        refreshOpenPopoverExamples();
      }
      scheduleBufferDiagnosticsUpdate();
    }
  }

  async function startTranslationPrefetch() {
    if (!cues.length) return;
    prefetchRerunRequested = true;
    scheduleBufferDiagnosticsUpdate();
    if (prefetchRunning) return;
    prefetchRunning = true;
    const generation = prefetchGeneration;
    try {
      while (generation === prefetchGeneration && prefetchRerunRequested) {
        prefetchRerunRequested = false;
        const current = Math.max(0, currentCueIndex);
        const order = U.cuePrefetchItems(
          cues,
          current,
          translationPrefetchAhead(),
          YOUTUBE_TRANSLATION_PREFETCH_BEHIND,
        );
        const unique = order
          .filter(({ cue }) => !translationsByText.has(cue.text) && !pendingTranslationTexts.has(cue.text))
          .map(({ cue, index }) => ({ text: cue.text, cueIndex: index }));
        for (const batch of U.batchTexts(unique, 25, 5_000)) {
          if (generation !== prefetchGeneration) return;
          await requestTranslations(batch, generation);
        }
        if (generation === prefetchGeneration && settings.learning_translation_order === 'source') {
          prefetchLiteralWindow(Math.max(0, currentCueIndex));
        }
      }
    } finally {
      prefetchRunning = false;
      scheduleBufferDiagnosticsUpdate();
      if (cues.length && (generation !== prefetchGeneration || prefetchRerunRequested)) {
        prefetchRerunRequested = true;
        void startTranslationPrefetch();
      }
    }
  }

  function ensureCueTranslation(index) {
    const cue = cues[index];
    if (!cue || translationsByText.has(cue.text) || pendingTranslationTexts.has(cue.text)) return;
    requestTranslations([{ text: cue.text, cueIndex: index }], prefetchGeneration);
  }

  async function ensureCueLiteralTranslation(index) {
    const cue = cues[index];
    const naturalTranslation = cue ? translationsByText.get(cue.text) : '';
    if (!cue || !naturalTranslation) return false;
    if (literalTranslationsByText.has(cue.text)) return true;
    if (failedLiteralTexts.has(cue.text)) return false;
    const existing = literalTranslationPromises.get(cue.text);
    if (existing) return existing;
    const generation = literalGeneration;
    pendingLiteralTexts.add(cue.text);
    let request = null;
    request = queueLiteralRequest(async () => {
      const startedAt = performance.now();
      try {
        if (generation !== literalGeneration) return false;
        const payload = await bridgeJson('/learning/catalogue', {
          method: 'POST',
          body: {
            sourceText: cue.text,
            action: 'literal',
            naturalTranslation,
            sourceLang: sourceLanguage(),
            targetLang: settings.learning_target_lang,
          },
        });
        if (payload?.online === false) {
          if (generation !== literalGeneration) return false;
          literalTranslationError = payload.error || 'Voice Record недоступен';
          literalErrorsByText.set(cue.text, literalTranslationError);
          failedLiteralTexts.add(cue.text);
          return false;
        }
        if (generation !== literalGeneration) return false;
        const normalizedLiteral = U.literalSpacingFromReference(
          payload?.literalText,
          naturalTranslation,
          payload?.alignments,
        );
        const literalText = String(normalizedLiteral.literalText || '').replace(/\s+/g, ' ').trim();
        if (!literalText) throw new Error('дословный перевод не получен');
        const alignments = (Array.isArray(normalizedLiteral.alignments) ? normalizedLiteral.alignments : [])
          .map(item => ({
            sourceWordIndex: Number(item?.sourceWordIndex),
            targetStart: Number(item?.targetStart),
            targetEnd: Number(item?.targetEnd),
          }))
          .filter(item => Number.isInteger(item.sourceWordIndex) && item.sourceWordIndex >= 0
            && Number.isInteger(item.targetStart) && Number.isInteger(item.targetEnd)
            && item.targetStart >= 0 && item.targetEnd > item.targetStart && item.targetEnd <= literalText.length);
        literalTranslationsByText.set(cue.text, { literalText, alignments });
        literalTranslationError = '';
        literalErrorsByText.delete(cue.text);
        return true;
      } catch (error) {
        if (generation !== literalGeneration) return false;
        literalTranslationError = error?.message || String(error);
        literalErrorsByText.set(cue.text, literalTranslationError);
        failedLiteralTexts.add(cue.text);
        log('literal subtitle failed', { error: literalTranslationError });
        return false;
      } finally {
        if (generation === literalGeneration) literalLastLatencyMs = Math.max(0, performance.now() - startedAt);
        scheduleBufferDiagnosticsUpdate();
      }
    }, generation, { index, key: cue.text });
    literalTranslationPromises.set(cue.text, request);
    try {
      return await request;
    } finally {
      if (literalTranslationPromises.get(cue.text) === request) {
        literalTranslationPromises.delete(cue.text);
        pendingLiteralTexts.delete(cue.text);
      }
      if (generation === literalGeneration && currentCueIndex === index) renderTranslationForCue(index);
      if (generation === literalGeneration && document.getElementById(WORD_POPOVER_ID)) {
        refreshOpenPopoverExamples();
      }
      scheduleBufferDiagnosticsUpdate();
    }
  }

  async function prefetchLiteralRange(centerIndex, ahead, { onProgress } = {}) {
    if (settings.learning_translation_order !== 'source'
        || !literalTranslationNeeded()
        || !Number.isInteger(centerIndex) || centerIndex < 0) {
      return { ready: 0, done: 0, total: 0 };
    }
    const lookahead = U.cueLookaheadItems(cues, centerIndex, ahead);
    let done = 0;
    onProgress?.({ done, total: lookahead.length });
    await Promise.all(lookahead.map(async ({ index }) => {
      await ensureCueLiteralTranslation(index);
      done += 1;
      onProgress?.({ done, total: lookahead.length });
    }));
    return {
      ready: lookahead.filter(({ cue }) => literalTranslationsByText.has(cue.text)).length,
      done,
      total: lookahead.length,
    };
  }

  function prefetchLiteralWindow(centerIndex = currentCueIndex) {
    if (externalMedia?.initializingLiteral) return Promise.resolve({ ready: 0, done: 0, total: 0 });
    const ahead = translationPrefetchAhead();
    reprioritizeLiteralRequestQueue(centerIndex);
    scheduleBufferDiagnosticsUpdate();
    return prefetchLiteralRange(centerIndex, ahead);
  }

  function registerWordState(entry) {
    if (!entry?.key) return null;
    const state = {
      state: entry.state,
      updatedAt: entry.updatedAt,
      partOfSpeech: entry.partOfSpeech || 'unknown',
      analysisConfidence: entry.analysisConfidence || 'low',
      key: entry.key,
      translation: entry.translation || '',
    };
    wordStates.set(`key:${entry.key}`, state);
    const stateForms = new Set([
      ...(entry.observedForms || [entry.normalizedText]),
      ...(Lexeme?.formsForLexeme?.(entry) || []),
    ]);
    for (const form of stateForms) {
      const normalized = U.normalizeTerm(form);
      if (!normalized) continue;
      const candidates = (wordFormStates.get(normalized) || []).filter(item => item.key !== state.key);
      candidates.push(state);
      candidates.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
      wordFormStates.set(normalized, candidates);
    }
    return state;
  }

  function unregisterWordState(key) {
    if (!key) return;
    wordStates.delete(`key:${key}`);
    for (const [form, candidates] of wordFormStates) {
      const next = candidates.filter(item => item.key !== key);
      if (next.length) wordFormStates.set(form, next);
      else wordFormStates.delete(form);
    }
  }

  function expressionFormsForEntry(entry) {
    const forms = new Set([entry?.sourceText, entry?.lemma, ...(entry?.observedForms || [])].filter(Boolean));
    if (entry?.expressionType === 'phrasal_verb') {
      const words = U.segmentWords(entry.lemma || entry.sourceText || '', 'en').filter(part => part.word);
      if (words.length >= 2) {
        const tail = words.slice(1).map(part => part.normalized).join(' ');
        for (const form of Lexeme?.formsForLexeme?.({ kind: 'word', lemma: words[0].normalized, partOfSpeech: 'verb' }) || []) {
          forms.add(`${form} ${tail}`);
        }
      }
    }
    return Array.from(forms);
  }

  function registerExpressionEntry(entry) {
    if (!entry?.key || !EXPRESSION_TYPE_LABELS[entry.expressionType]) return;
    expressionEntries = expressionEntries.filter(candidate => candidate.key !== entry.key);
    expressionEntries.push({ ...entry, forms: expressionFormsForEntry(entry) });
  }

  function updateWordLearningTitle(word) {
    const labels = [];
    if (word.__scLearningState?.state === 'known') labels.push('Исключено из обучения');
    else if (word.__scLearningState?.state === 'saved') labels.push('Добавлено в словарь');
    if (word.__scExpressionMatch?.entry) {
      labels.push(`${EXPRESSION_TYPE_LABELS[word.__scExpressionMatch.entry.expressionType]}: ${word.__scExpressionMatch.entry.sourceText}`);
    }
    if (labels.length) word.title = labels.join(' · ');
    else word.removeAttribute('title');
  }

  function learningStateForWord(word, cue) {
    const identity = wordIdentity(word, cue);
    const identityKey = learningStore?.entryKey?.(identity) || '';
    const exact = wordStates.get(`key:${identityKey}`);
    if (exact) return { identity, state: exact };
    const candidates = wordFormStates.get(U.normalizeTerm(word)) || [];
    const samePart = candidates.find(item => item.partOfSpeech === identity.partOfSpeech);
    if (samePart) return { identity, state: samePart };
    const unknown = candidates.find(item => item.partOfSpeech === 'unknown');
    if (unknown) return { identity, state: unknown };
    if (identity.analysisConfidence !== 'high' && candidates.length === 1) {
      return { identity, state: candidates[0] };
    }
    return { identity, state: null };
  }

  async function refreshLearningWordStates({ rerender = true } = {}) {
    if (!learningStore) return;
    if (learningStateRefreshPromise) return learningStateRefreshPromise;
    learningStateRefreshPromise = (async () => {
      const entries = await learningStore.listEntries({ states: ['saved', 'known'] });
      wordStates.clear();
      wordFormStates.clear();
      expressionEntries = [];
      for (const entry of entries || []) {
        if (entry?.kind === 'word' && entry.normalizedText) registerWordState(entry);
        else if (entry?.kind === 'phrase' && entry.expressionType) registerExpressionEntry(entry);
      }
      const signature = `${wordStates.size}:${wordFormStates.size}:${expressionEntries.length}`;
      if (signature !== lastLearningStateSignature) {
        lastLearningStateSignature = signature;
        log('learning states refreshed', {
          entries: wordStates.size,
          forms: wordFormStates.size,
          expressions: expressionEntries.length,
        });
      }
      if (rerender && currentCueIndex >= 0) applyCurrentCueLearningMarks();
      const popover = document.getElementById(WORD_POPOVER_ID);
      if (popover?.__scWordRefs) {
        const entry = await learningStore.getEntry(popover.__scWordRefs.query).catch(() => null);
        applyPopoverState(popover.__scWordRefs, entry);
      }
    })().catch((error) => log('learning state refresh failed', { error: error?.message || String(error) }));
    try { return await learningStateRefreshPromise; }
    finally { learningStateRefreshPromise = null; }
  }

  function positionPhraseHint() {
    if (phraseHint?.dataset.visible !== '1' || !subtitleCard?.isConnected) return;
    U.fitFloatingElement(phraseHint, subtitleCard, { margin: 12, gap: 6 });
    const box = phraseHint.getBoundingClientRect();
    const blocked = [navRail, optionRail].some(rail => {
      if (!rail?.isConnected || getComputedStyle(rail).visibility === 'hidden') return false;
      const rect = rail.getBoundingClientRect();
      return rect.width > 0 && rect.left < box.right && rect.right > box.left && rect.top < box.bottom && rect.bottom > box.top;
    });
    if (blocked) U.fitFloatingElement(phraseHint, subtitleCard, { margin: 12, gap: 6, preferBelow: true });
  }

  function updatePhraseHint(text, state = 'ready') {
    if (!phraseHint) return;
    delete phraseHint.dataset.expanded;
    phraseHint.textContent = text || '';
    phraseHint.dataset.visible = text ? '1' : '0';
    phraseHint.dataset.state = state;
    phraseHint.dataset.cancellable = text && phraseSelectionOpen ? '1' : '0';
    phraseHint.setAttribute('role', 'button');
    phraseHint.tabIndex = text && phraseSelectionOpen ? 0 : -1;
    positionPhraseHint();
  }

  function expressionContextForSelection(selection) {
    return cues.slice(selection.fromCueIndex, selection.toCueIndex + 1)
      .map(cue => cue?.text || '')
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function expressionContextTranslation(selection) {
    return cues.slice(selection.fromCueIndex, selection.toCueIndex + 1)
      .map(cue => translationsByText.get(cue?.text) || '')
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function renderExpressionInspector() {
    if (!phraseHint || !phraseAnalysis || !phraseSelectionOpen) return;
    const analysis = phraseAnalysis;
    phraseHint.replaceChildren();
    phraseHint.dataset.visible = '1';
    phraseHint.dataset.expanded = '1';
    phraseHint.dataset.cancellable = '0';
    phraseHint.setAttribute('role', 'group');
    phraseHint.tabIndex = -1;
    phraseHint.dataset.state = analysis.error ? 'error' : analysis.loading ? 'loading' : 'ready';
    const summary = document.createElement('div');
    summary.className = 'sc-expression-summary';
    const title = document.createElement('strong');
    title.textContent = analysis.loading
      ? 'Определяю тип выражения…'
      : (analysis.canonicalText || analysis.selection?.text || 'Выражение');
    const translation = document.createElement('span');
    translation.className = 'sc-expression-translation';
    translation.textContent = analysis.loading
      ? ''
      : analysis.translation || (analysis.error ? analysis.error : 'Перевод недоступен');
    if (!analysis.loading && !analysis.error && analysis.translation) {
      translation.replaceChildren();
      for (const [index, meaning] of analysis.translation.split(/\s*[/;]\s*/u).filter(Boolean).entries()) {
        if (index) translation.appendChild(document.createTextNode(' / '));
        const button = document.createElement('button'); button.type = 'button'; button.textContent = meaning;
        installSafeClick(button, () => void showExpressionEnglishChoices(analysis, meaning, button));
        translation.appendChild(button);
      }
    }
    summary.append(title, translation);
    phraseHint.appendChild(summary);
    if (analysis.loading) { positionPhraseHint(); return; }

    const composition = window.__scPhraseComposition?.normalize(analysis.composition, analysis.selection?.text);
    const types = document.createElement('div');
    types.className = 'sc-expression-types';
    {
      const badge = document.createElement('span');
      badge.className = 'sc-expression-type';
      const meaningLabel = window.__scPhraseComposition?.meaningLabel(analysis) || window.__scPhraseComposition?.meaningLabel(composition);
      badge.textContent = (EXPRESSION_TYPE_LABELS[analysis.expressionType] || 'Обычная фраза') + (meaningLabel ? ' (' + meaningLabel + ')' : '');
      types.appendChild(badge);
    }
    phraseHint.appendChild(types);

    if (composition && settings.learning_ai_explanation) {
      const details = document.createElement('div');
      details.className = 'sc-expression-composition';
      const parts = document.createElement('div');
      for (const [index, part] of composition.parts.entries()) {
        const pair = document.createElement('span');
        pair.className = 'sc-expression-part';
        const english = document.createElement('strong');
        english.textContent = part.en;
        pair.append(english, document.createTextNode(` — ${part.ru}${index + 1 < composition.parts.length ? ' ·' : ''}`));
        parts.appendChild(pair);
      }
      const explanation = document.createElement('p');
      explanation.textContent = composition.explanation;
      details.append(parts, explanation);
      phraseHint.appendChild(details);
    }

    const actions = document.createElement('div');
    actions.className = 'sc-expression-actions';
    const save = document.createElement('button');
    save.type = 'button';
    save.dataset.primary = analysis.entry?.state === 'saved' ? '1' : '0';
    save.textContent = analysis.saving ? 'Сохраняю…' : analysis.error ? 'Повторить' : analysis.entry?.state === 'known'
      ? 'Не учить'
      : analysis.entry?.state === 'saved' ? 'В словаре' : 'В словарь';
    save.disabled = analysis.saving === true;
    if (analysis.error) save.title = analysis.error;
    installSafeClick(save, () => { void saveSelectedExpression(); });
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Закрыть';
    installSafeClick(close, () => clearPhraseSelection());
    const copy = iconButton('copy', 'Копировать', () => copyText(analysis.selection?.text || analysis.canonicalText));
    actions.append(save, close, copy);
    phraseHint.appendChild(actions);
    positionPhraseHint();
  }

  async function saveSelectedExpression() {
    const analysis = phraseAnalysis;
    const selection = analysis?.selection;
    if (!selection || analysis.saving || !learningStore || !vocabularySaves) return;
    const generation = phraseAnalysisGeneration;
    phraseAnalysis = { ...analysis, saving: true };
    logLearningAction('phrase save started', { term: analysis.canonicalText || selection.text, type: analysis.expressionType });
    renderExpressionInspector();
    try {
      const canonicalText = U.normalizeTerm(analysis.canonicalText || selection.text);
      const context = expressionContextForSelection(selection);
      const saved = await vocabularySaves.save({
        word: canonicalText,
        observedForms: [selection.text, canonicalText],
        contexts: [{
          videoId: videoMeta.videoId,
          videoUrl: currentMediaUrl(),
          videoTitle: videoMeta.title,
          startMs: cues[selection.fromCueIndex]?.startMs,
          endMs: cues[selection.toCueIndex]?.endMs,
          sourceText: context,
          surfaceForm: selection.text,
          translation: expressionContextTranslation(selection),
          createdAt: Date.now(),
        }],
      });
      await learningStore.sync({ fresh: true });
      const entry = await learningStore.getEntry({ remoteId: saved.item.id, kind: 'phrase',
        sourceLang: sourceLanguage(), targetLang: settings.learning_target_lang, sourceText: canonicalText });
      if (!entry) throw new Error('Сохранённая фраза не появилась в словаре. Откройте карточку снова.');
      registerExpressionEntry(entry);
      logLearningAction('phrase save completed', { term: canonicalText, key: entry.key, state: entry.state });
      if (generation !== phraseAnalysisGeneration || !phraseSelectionOpen || phraseAnalysis?.selection !== selection) return;
      phraseAnalysis = { ...phraseAnalysis, saving: false, entry, canonicalText: entry.sourceText, expressionType: entry.expressionType };
      applyCurrentCueExpressionMarks();
      renderTranslationForCue(currentCueIndex);
      renderExpressionInspector();
    } catch (error) {
      logLearningAction('phrase save failed', { term: analysis.canonicalText || selection.text, error: error?.message || String(error) });
      if (generation !== phraseAnalysisGeneration || !phraseSelectionOpen || phraseAnalysis?.selection !== selection) return;
      phraseAnalysis = { ...phraseAnalysis, saving: false, error: error?.message || String(error) };
      renderExpressionInspector();
    }
  }

  async function analyzePhraseSelection(selection) {
    const generation = ++phraseAnalysisGeneration;
    phraseAnalysis = { selection, loading: true, expressionType: '', canonicalText: selection.text, translation: '' };
    renderExpressionInspector();
    const context = expressionContextForSelection(selection);
    const contextTranslation = expressionContextTranslation(selection);
    try {
      const result = await bridgeJson('/learning/catalogue', {
        method: 'POST',
        body: {
          selectedText: selection.text,
          action: 'classify',
          context,
          contextTranslation,
          sourceLang: sourceLanguage(),
          targetLang: settings.learning_target_lang,
          meaningModeVersion: 1,
          ...(settings.learning_ai_explanation ? { compositionVersion: 1 } : {}),
        },
      });
      if (generation !== phraseAnalysisGeneration || !phraseSelectionOpen) return;
      const canonicalText = U.normalizeTerm(result?.canonicalText || selection.text);
      const existing = await learningStore?.getEntry({
        kind: 'phrase',
        sourceLang: sourceLanguage(),
        targetLang: settings.learning_target_lang,
        sourceText: canonicalText,
        normalizedText: canonicalText,
        lemma: canonicalText,
      }).catch(() => null);
      if (generation !== phraseAnalysisGeneration || !phraseSelectionOpen || phraseAnalysis?.selection !== selection) return;
      phraseAnalysis = {
        selection,
        loading: false,
        eligible: result?.eligible === true,
        expressionType: existing?.expressionType || (EXPRESSION_TYPE_LABELS[result?.expressionType] ? result.expressionType : ''),
        canonicalText,
        translation: existing?.translation || result?.translation || '',
        confidence: result?.confidence || 'low',
        entry: existing,
        meaningMode: result?.meaningMode || result?.composition?.meaningMode,
        composition: window.__scPhraseComposition?.normalize(result?.composition, selection.text),
        error: result?.online === false ? result.error || 'Voice Record недоступен' : '',
      };
      renderExpressionInspector();
    } catch (error) {
      if (generation !== phraseAnalysisGeneration || !phraseSelectionOpen) return;
      phraseAnalysis = {
        selection,
        loading: false,
        expressionType: '',
        canonicalText: selection.text,
        translation: '',
        confidence: 'low',
        error: error?.message || String(error),
      };
      renderExpressionInspector();
    }
  }

  function openSavedExpression(match) {
    const entry = match?.entry;
    if (!entry) return;
    closeWordPopover({ resume: false });
    clearPhraseSelection({ resume: false, notify: true });
    const anchor = { cueIndex: match.fromCueIndex, wordIndex: match.fromWordIndex };
    const focus = { cueIndex: match.toCueIndex, wordIndex: match.toWordIndex };
    const selection = {
      anchor,
      focus,
      cueIndex: match.fromCueIndex,
      fromCueIndex: match.fromCueIndex,
      toCueIndex: match.toCueIndex,
      fromWordIndex: match.fromWordIndex,
      toWordIndex: match.toWordIndex,
      text: match.form || entry.sourceText,
    };
    phraseSelectionOpen = true;
    phraseSelectionAnchor = anchor;
    phraseSelectionFocus = focus;
    phraseSelection = selection;
    root.dataset.phraseMode = 'selected';
    applyPhraseSelectionDom(selection);
    pauseForPhraseSelection(currentCueIndex);
    phraseAnalysis = {
      selection,
      loading: false,
      eligible: true,
      expressionType: entry.expressionType,
      canonicalText: entry.sourceText,
      translation: entry.translation || '',
      confidence: entry.analysisConfidence || 'high',
      entry,
    };
    renderExpressionInspector();
    void publishPhraseSelection(selection, { updateHint: false });
    if (settings.learning_ai_explanation) {
      const generation = phraseAnalysisGeneration;
      void bridgeJson('/learning/catalogue', { method: 'POST', body: {
        action: 'classify', selectedText: selection.text, context: expressionContextForSelection(selection),
        contextTranslation: expressionContextTranslation(selection), compositionVersion: 1, meaningModeVersion: 1,
        sourceLang: sourceLanguage(), targetLang: settings.learning_target_lang,
      } }).then(result => {
        if (generation !== phraseAnalysisGeneration || !phraseSelectionOpen || phraseAnalysis?.selection !== selection) return;
        const composition = window.__scPhraseComposition?.normalize(result?.composition, selection.text);
        if (composition) { phraseAnalysis = { ...phraseAnalysis, composition }; renderExpressionInspector(); }
      }).catch(error => log('phrase composition failed', { error: error?.message || String(error) }));
    }
  }

  function renderWordExpressionLinks(refs) {
    if (!refs?.expressionLinks) return;
    refs.expressionLinks.replaceChildren();
    const wordIndex = Number(refs.sourceWordIndex);
    const matches = currentExpressionMatches.filter(match => match.wordIndexes.includes(wordIndex));
    for (const match of matches.slice(0, 2)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `${EXPRESSION_TYPE_LABELS[match.entry.expressionType]} · ${match.entry.sourceText}`;
      installSafeClick(button, () => openSavedExpression(match));
      refs.expressionLinks.appendChild(button);
    }
  }

  async function publishPhraseSelection(selection, { updateHint = true } = {}) {
    const generation = ++selectionHandoffGeneration;
    if (updateHint) updatePhraseHint('Готовлю разбор…', 'loading');
    try {
      const result = await bridgeJson('/learning/selection', {
        method: 'POST',
        body: {
          text: selection.text,
          sourceName: currentMediaSourceName(),
          pageUrl: currentMediaUrl(),
          videoId: videoMeta.videoId || extractVideoIdFromLocation(),
          cueStartMs: cues[selection.fromCueIndex]?.startMs ?? null,
        },
      });
      if (generation !== selectionHandoffGeneration || !phraseSelectionOpen) return;
      if (updateHint) {
        updatePhraseHint(
          result?.online === false || result?.armed !== true
            ? 'Voice Record недоступен · ⌥ Space откроет обычный чат'
            : '⌥ Space — разобрать · Esc — отменить',
          result?.online === false || result?.armed !== true ? 'error' : 'ready',
        );
      }
    } catch (error) {
      if (generation !== selectionHandoffGeneration || !phraseSelectionOpen) return;
      if (updateHint) updatePhraseHint('Не удалось подготовить Voice Record · Esc — отменить', 'error');
      log('learning selection handoff failed', { error: error?.message || String(error) });
    }
  }

  async function publishWordSelection(word, cueIndex) {
    const cue = cues[cueIndex];
    if (!cue) return;
    const context = U.sentenceForTerm(cue.text, word, sourceLanguage()) || cue.text;
    try {
      const result = await bridgeJson('/learning/selection', {
        method: 'POST',
        body: {
          text: word,
          word,
          context,
          sourceName: currentMediaSourceName(),
          pageUrl: currentMediaUrl(),
          videoId: videoMeta.videoId || extractVideoIdFromLocation(),
          cueStartMs: cue.startMs ?? null,
        },
      });
      log('word selection handoff', {
        cueIndex,
        word: U.normalizeTerm(word),
        contextChars: context.length,
        armed: result?.armed === true,
        online: result?.online !== false,
      });
    } catch (error) {
      log('word selection handoff failed', { error: error?.message || String(error) });
    }
  }

  function clearNativeTextSelection() {
    try {
      const browserSelection = window.getSelection();
      if (browserSelection?.rangeCount) browserSelection.removeAllRanges();
    } catch {}
  }

  function clearPhraseSelection({ resume = true, keepAnchor = false, notify = true } = {}) {
    window.__scLearningChoicesPopover?.closeFor(phraseHint);
    const hadSelection = phraseSelectionOpen || !!phraseSelection;
    phraseSelectionOpen = false;
    phraseSelection = null;
    phraseSelectionFocus = null;
    if (!keepAnchor) phraseSelectionAnchor = null;
    selectionHandoffGeneration += 1;
    phraseAnalysisGeneration += 1;
    phraseAnalysis = null;
    sourceRow?.querySelectorAll?.('.sc-learning-word[data-word-index]')
      .forEach((word) => {
        delete word.dataset.phraseSelected;
        delete word.dataset.phrasePreview;
      });
    if (hadSelection) clearNativeTextSelection();
    updatePhraseHint('');
    if (root) root.dataset.phraseMode = 'off';
    if (notify && hadSelection) {
      bridgeJson('/learning/selection', { method: 'POST', body: { text: '' } }).catch(() => {});
    }
    if (resume) settleHoverAfterDismissal();
    else updateHoverHoldState();
  }

  function applyPhraseRangeDom(selection, { preview = false } = {}) {
    const words = Array.from(sourceRow?.querySelectorAll?.('.sc-learning-word[data-word-index]') || []);
    const range = U.cueWordRangeForPhrase(
      selection?.anchor,
      selection?.focus,
      currentCueIndex,
      words.length,
    );
    for (const word of words) {
      const index = Number(word.dataset.wordIndex);
      const inside = !!range && index >= range.fromWordIndex && index <= range.toWordIndex;
      if (preview && inside) word.dataset.phrasePreview = '1';
      else delete word.dataset.phrasePreview;
      if (!preview && inside) word.dataset.phraseSelected = '1';
      else delete word.dataset.phraseSelected;
    }
    clearNativeTextSelection();
    return !!range;
  }

  function applyPhraseSelectionDom(selection) {
    return applyPhraseRangeDom(selection, { preview: false });
  }

  function phraseDraftTo(wordIndex, cueIndex) {
    if (!phraseSelectionAnchor || !Number.isInteger(cueIndex) || !Number.isInteger(wordIndex)) return null;
    const focus = { cueIndex, wordIndex };
    const anchorFirst = phraseSelectionAnchor.cueIndex < focus.cueIndex
      || (phraseSelectionAnchor.cueIndex === focus.cueIndex && phraseSelectionAnchor.wordIndex <= focus.wordIndex);
    const start = anchorFirst ? phraseSelectionAnchor : focus;
    const end = anchorFirst ? focus : phraseSelectionAnchor;
    const draft = {
      anchor: { ...phraseSelectionAnchor },
      focus,
      cueIndex: start.cueIndex,
      fromCueIndex: start.cueIndex,
      toCueIndex: end.cueIndex,
      fromWordIndex: start.wordIndex,
      toWordIndex: end.wordIndex,
      text: U.phraseTextAcrossCues(cues, phraseSelectionAnchor, focus, sourceLanguage()),
    };
    return draft.text ? draft : null;
  }

  function renderPhraseRangeForCurrentCue({ preview = !phraseSelection } = {}) {
    const selection = phraseSelection || (phraseSelectionFocus
      ? phraseDraftTo(phraseSelectionFocus.wordIndex, phraseSelectionFocus.cueIndex)
      : null);
    if (!selection) return false;
    return applyPhraseRangeDom(selection, { preview });
  }

  function pauseForPhraseSelection(cueIndex) {
    const video = playerVideo();
    if (video && !video.paused) {
      video.pause();
      pausedForSubtitleHover = true;
      hoverPausedCueKey = `${videoMeta.videoId}:${cues[cueIndex]?.startMs ?? cueIndex}`;
    }
    updateHoverHoldState();
  }

  function previewPhraseTo(wordIndex, cueIndex) {
    if (!phraseSelectionOpen || phraseSelection) return false;
    const draft = phraseDraftTo(wordIndex, cueIndex);
    if (!draft || !applyPhraseRangeDom(draft, { preview: true })) return false;
    phraseSelectionFocus = { cueIndex, wordIndex };
    root.dataset.phraseMode = 'selecting';
    return true;
  }

  function enterPhraseSelectionMode(wordIndex, cueIndex, reason = 'explicit') {
    hideQuickWordPopover();
    closeWordPopover({ resume: false });
    clearPhraseSelection({ resume: false, notify: true });
    phraseSelectionOpen = true;
    phraseSelection = null;
    phraseSelectionAnchor = { cueIndex, wordIndex };
    phraseSelectionFocus = { cueIndex, wordIndex };
    wordPopoverOpen = false;
    root.dataset.phraseMode = 'selecting';
    updatePhraseHint('Выберите второе слово · A / D — соседняя реплика · Esc — отменить', 'ready');
    pauseForPhraseSelection(cueIndex);
    previewPhraseTo(wordIndex, cueIndex);
    log('phrase selection mode', { cueIndex, wordIndex, reason });
    return true;
  }

  function selectPhraseTo(wordIndex, cueIndex) {
    if (!phraseSelectionOpen || !phraseSelectionAnchor) return false;
    closeWordPopover({ resume: false });
    const draft = phraseDraftTo(wordIndex, cueIndex);
    if (!draft) return false;
    if (!applyPhraseSelectionDom(draft)) return false;
    phraseSelection = draft;
    phraseSelectionFocus = { cueIndex, wordIndex };
    phraseSelectionOpen = true;
    wordPopoverOpen = false;
    root.dataset.phraseMode = 'selected';
    pauseForPhraseSelection(cueIndex);
    void publishPhraseSelection(draft, { updateHint: false });
    void analyzePhraseSelection(draft);
    log('phrase selected', {
      fromCueIndex: draft.fromCueIndex,
      toCueIndex: draft.toCueIndex,
      fromWordIndex: draft.fromWordIndex,
      toWordIndex: draft.toWordIndex,
      chars: draft.text.length,
    });
    return true;
  }

  function navigatePhraseCue(delta) {
    if (!phraseSelectionOpen || !phraseSelectionAnchor || !cues.length) return false;
    const targetCueIndex = Math.max(0, Math.min(cues.length - 1, currentCueIndex + delta));
    if (targetCueIndex === currentCueIndex) return true;
    const wordCount = U.segmentWords(cues[targetCueIndex]?.text || '', sourceLanguage())
      .filter(part => part.word).length;
    if (!wordCount) return false;
    const wordIndex = targetCueIndex === phraseSelectionAnchor.cueIndex
      ? phraseSelectionAnchor.wordIndex
      : targetCueIndex > phraseSelectionAnchor.cueIndex ? 0 : wordCount - 1;
    phraseSelection = null;
    phraseSelectionFocus = { cueIndex: targetCueIndex, wordIndex };
    root.dataset.phraseMode = 'selecting';
    updatePhraseHint('Выберите второе слово · A / D — соседняя реплика · Esc — отменить', 'ready');
    closeWordPopover({ resume: false });
    seekCue(targetCueIndex, { play: false });
    pauseForPhraseSelection(targetCueIndex);
    renderPhraseRangeForCurrentCue({ preview: true });
    log('phrase cue navigated', {
      anchorCueIndex: phraseSelectionAnchor.cueIndex,
      cueIndex: targetCueIndex,
      wordIndex,
    });
    return true;
  }

  function renderCue(index, force = false) {
    ensureRoot();
    if (!force && index === currentCueIndex) return;
    const quickAnchorBeforeRender = quickWordHoverAnchor;
    const previousCueIndex = currentCueIndex;
    if (index !== previousCueIndex) clearRussianSelection({ resume: false });
    currentCueIndex = index;
    reprioritizeLiteralRequestQueue(index);
    scheduleBufferDiagnosticsUpdate();
    hoveredPhraseWord = null;
    root.dataset.cueIndex = String(index);
    sourceRow.replaceChildren();
    if (quickAnchorBeforeRender) scheduleHideQuickWordPopover(quickAnchorBeforeRender);
    if (index < 0 || !cues[index]) {
      delete root.dataset.cueStartMs;
      delete root.dataset.cueEndMs;
      sourceRow.textContent = '';
      translationRow.textContent = '';
      subtitleCard.style.display = 'none';
      if (copyCueControl) copyCueControl.dataset.visible = '0';
      if (subtitleDragHandle) subtitleDragHandle.dataset.visible = '0';
      scheduleBufferDiagnosticsUpdate();
      return;
    }
    subtitleCard.style.display = '';
    if (copyCueControl) copyCueControl.dataset.visible = '1';
    if (subtitleDragHandle) subtitleDragHandle.dataset.visible = '1';
    const cue = cues[index];
    root.dataset.cueStartMs = String(cue.startMs);
    root.dataset.cueEndMs = String(cue.endMs);
    const parts = U.segmentWords(cue.text, sourceLanguage());
    let wordIndex = 0;
    for (const part of parts) {
      if (!part.word) {
        sourceRow.appendChild(document.createTextNode(part.text));
        continue;
      }
      const word = document.createElement('span');
      word.className = 'sc-learning-word';
      word.textContent = part.text;
      word.tabIndex = 0;
      word.dataset.normalized = part.normalized;
      word.dataset.wordIndex = String(wordIndex);
      const currentWordIndex = wordIndex;
      wordIndex += 1;
      applyLearningStateToWord(word, cue);
      word.addEventListener('click', event => {
        clearRussianSelection({ resume: false });
        clearTimeout(pendingWordClickTimer); pendingWordClickTimer = null;
        hideQuickWordPopover();
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey) {
          lastWordClick = null;
          enterPhraseSelectionMode(currentWordIndex, index, 'shift-click');
          return;
        }
        if (phraseSelectionOpen && selectPhraseTo(currentWordIndex, index)) return;
        const clickedAt = performance.now();
        const repeatKind = U.classifyRepeatedWordClick(
          lastWordClick,
          index,
          currentWordIndex,
          clickedAt,
          WORD_DOUBLE_CLICK_MS,
        );
        const popoverOpen = !!document.getElementById(WORD_POPOVER_ID);
        logLearningAction('word click received', { term: part.text, cueIndex: index, sourceWordIndex: currentWordIndex,
          detail: event.detail, trusted: event.isTrusted, repeatKind, popoverOpen });
        if (repeatKind === 'quick' || (repeatKind === 'slow' && popoverOpen)) {
          lastWordClick = null;
          if (repeatKind === 'quick') enterPhraseSelectionMode(currentWordIndex, index, 'double-click');
          else closeWordPopover({ resume: true });
          return;
        }
        clearPhraseSelection({ resume: false });
        lastWordClick = { cueIndex: index, wordIndex: currentWordIndex, at: clickedAt };
        const clickedAnchor = fixedAnchorReference(word);
        pendingWordClickTimer = setTimeout(() => {
          pendingWordClickTimer = null;
          void openWordPopover(clickedAnchor, part.text, index, currentWordIndex);
        }, WORD_DOUBLE_CLICK_MS);
      });
      word.addEventListener('pointerenter', event => {
        quickWordPointer = { x: event.clientX, y: event.clientY };
        hoveredPhraseWord = { cueIndex: index, wordIndex: currentWordIndex };
        if (phraseSelectionOpen && !phraseSelection) previewPhraseTo(currentWordIndex, index);
        else scheduleQuickWordPopover(word, part.text, index, currentWordIndex);
      });
      word.addEventListener('pointermove', event => { quickWordPointer = { x: event.clientX, y: event.clientY }; });
      word.addEventListener('pointerleave', () => {
        if (word.isConnected && quickWordHoverAnchor === word) quickWordPointer = null;
        scheduleHideQuickWordPopover(word);
        if (hoveredPhraseWord?.cueIndex === index && hoveredPhraseWord?.wordIndex === currentWordIndex) {
          hoveredPhraseWord = null;
        }
      });
      word.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          hideQuickWordPopover();
          event.preventDefault();
          if (event.shiftKey) {
            lastWordClick = null;
            enterPhraseSelectionMode(currentWordIndex, index, 'shift-key');
            return;
          }
          if (phraseSelectionOpen && selectPhraseTo(currentWordIndex, index)) return;
          clearPhraseSelection({ resume: false });
          lastWordClick = { cueIndex: index, wordIndex: currentWordIndex, at: performance.now() };
          openWordPopover(word, part.text, index, currentWordIndex, { trigger: 'keyboard' });
        }
      });
      sourceRow.appendChild(word);
    }
    if (phraseSelectionOpen) renderPhraseRangeForCurrentCue({ preview: !phraseSelection });
    applyCurrentCueExpressionMarks();
    renderTranslationForCue(index);
    if (quickAnchorBeforeRender && previousCueIndex === index && quickWordPointer) {
      const replacement = document.elementFromPoint(quickWordPointer.x, quickWordPointer.y)?.closest('.sc-learning-word');
      if (replacement && sourceRow.contains(replacement)
          && replacement.dataset.normalized === quickAnchorBeforeRender.dataset.normalized) {
        scheduleQuickWordPopover(replacement, replacement.textContent, index, Number(replacement.dataset.wordIndex));
      }
    }
    if (settings.learning_hover_word_translation) void prefetchQuickWordTranslations(cue);
    void startTranslationPrefetch();
    if (settings.learning_translation_order === 'source') void prefetchLiteralWindow(index);
  }

  function renderCurrentVideoCue(video, force = false) {
    if (!video || !cues.length) {
      renderCue(-1, force);
      return;
    }
    renderCue(U.findCueIndex(cues, video.currentTime * 1_000), force);
  }

  function maybePauseForSubtitleHover(video, timeMs) {
    const cue = currentCueIndex >= 0 ? cues[currentCueIndex] : null;
    if (!hoverHoldRequested() || !cue) return false;
    const key = `${videoMeta.videoId}:${cue.startMs}`;
    const inHoldWindow = timeMs >= cue.endMs - 35 && timeMs <= cue.endMs + 400;
    if (pausedForSubtitleHover && hoverPausedCueKey === key) {
      // A word card or phrase selection pauses immediately, often in the
      // middle of a cue. The resulting timeupdate must not erase ownership of
      // that pause before the user dismisses the interaction.
      if (video.paused || inHoldWindow) return true;
      pausedForSubtitleHover = false;
      hoverPausedCueKey = '';
      updateHoverHoldState();
    }
    if (video.paused || !inHoldWindow) return false;
    video.pause();
    if (timeMs > cue.endMs + 20) {
      video.currentTime = Math.max(cue.startMs, cue.endMs - 15) / 1_000;
    }
    pausedForSubtitleHover = true;
    hoverPausedCueKey = key;
    updateHoverHoldState();
    log('hover hold active', { cueIndex: currentCueIndex, endMs: cue.endMs, timeMs: Math.round(timeMs) });
    return true;
  }

  function onVideoTimelineEvent(event) {
    const video = event.target;
    if (!(video instanceof HTMLVideoElement) || !overlayActive || !cues.length) return;
    activeVideo = video;
    if (maybePauseForSubtitleHover(video, video.currentTime * 1_000)) return;
    renderCurrentVideoCue(video);
  }

  function seekCue(index, { play = true } = {}) {
    if (!Number.isInteger(index) || index < 0 || index >= cues.length) return;
    const video = playerVideo();
    if (!video) return;
    autoPausedCueKey = '';
    pausedForSubtitleHover = false;
    hoverPausedCueKey = '';
    updateHoverHoldState();
    video.currentTime = Math.max(0, cues[index].startMs / 1_000 + 0.015);
    if (play) video.play().catch(() => {});
    renderCue(index, true);
  }

  function seekRelativeCue(delta) {
    if (!cues.length) return;
    closeWordPopover({ resume: false });
    clearPhraseSelection({ resume: false });
    const base = currentCueIndex >= 0 ? currentCueIndex : 0;
    seekCue(Math.max(0, Math.min(cues.length - 1, base + delta)));
  }

  function playbackTick(timestamp) {
    requestAnimationFrame(playbackTick);
    if (timestamp - lastTickAt < 45 || !overlayActive || !cues.length) return;
    lastTickAt = timestamp;
    const video = playerVideo();
    if (!video) return;
    activeVideo = video;
    const timeMs = video.currentTime * 1_000;
    if (Number.isFinite(lastVideoTimeMs) && Math.abs(timeMs - lastVideoTimeMs) > 900) autoPausedCueKey = '';
    lastVideoTimeMs = timeMs;

    const previousCue = currentCueIndex >= 0 ? cues[currentCueIndex] : null;
    if (settings.learning_auto_pause && previousCue && !video.paused) {
      const key = `${videoMeta.videoId}:${previousCue.startMs}`;
      if (timeMs >= previousCue.endMs - 70 && timeMs <= previousCue.endMs + 220 && autoPausedCueKey !== key) {
        autoPausedCueKey = key;
        video.pause();
      }
    }

    if (maybePauseForSubtitleHover(video, timeMs)) return;

    const index = U.findCueIndex(cues, timeMs);
    if (index !== currentCueIndex) {
      renderCue(index);
    }
  }

  function extractVideoIdFromLocation() {
    try {
      const url = new URL(location.href);
      if (url.pathname.startsWith('/watch')) return url.searchParams.get('v') || '';
      if (url.pathname.startsWith('/live/') || url.pathname.startsWith('/shorts/')) {
        return url.pathname.split('/').filter(Boolean)[1] || '';
      }
    } catch {}
    return '';
  }

  function positionPopover(popover, anchor, { force = false } = {}) {
    if (!popover.isConnected || !anchor?.isConnected) return;
    if (!force && popover.__scScrollDetached) {
      const rect = popover.getBoundingClientRect();
      U.fitFloatingElement(popover, { getBoundingClientRect: () => ({ ...rect.toJSON(), bottom: rect.top }) },
        { gap: 0, preferBelow: true, scroll: false });
      return;
    }
    const margin = 12;
    const gap = 8;
    const a = anchor.getBoundingClientRect();
    const viewportMaxHeight = Math.max(120, Math.min(760, innerHeight - margin * 2));
    popover.style.maxHeight = `${Math.floor(viewportMaxHeight)}px`;
    const p = popover.getBoundingClientRect();
    const layout = U.wordPopoverLayout({
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      anchorLeft: a.left,
      anchorTop: a.top,
      anchorWidth: a.width,
      popoverWidth: p.width,
      popoverHeight: p.height,
      margin,
      gap,
      heightLimit: 760,
    });
    popover.style.maxHeight = `${Math.floor(layout.maxHeight)}px`;
    popover.dataset.compact = layout.compact ? '1' : '0';
    popover.dataset.placement = layout.tailVisible ? 'above' : 'viewport';
    popover.dataset.overlapsAnchor = layout.overlapsAnchor ? '1' : '0';
    popover.dataset.anchorCenterX = String(Math.round(a.left + a.width / 2));
    popover.dataset.desiredLeft = String(Math.round(layout.desiredLeft));
    popover.dataset.safeLeft = String(margin);
    popover.dataset.safeRight = String(innerWidth - margin);
    popover.style.left = `${Math.round(layout.left)}px`;
    popover.style.top = `${Math.round(layout.top)}px`;
    const tail = popover.__scWordRefs?.tail;
    if (tail) {
      tail.style.left = `${Math.round(layout.tailLeft)}px`;
      tail.hidden = !layout.tailVisible;
      popover.dataset.tailLeft = String(Math.round(layout.tailLeft));
    }
    const fitted = U.fitFloatingElement(popover, anchor, { margin, gap, scroll: false });
    if (fitted && (Math.abs(fitted.left - layout.left) > 1 || Math.abs(fitted.top - layout.top) > 1)) {
      popover.dataset.placement = 'viewport';
      if (tail) tail.hidden = true;
    }
    const placed = popover.getBoundingClientRect();
    if (tail) {
      tail.style.left = `${Math.round(Math.max(10, Math.min(placed.width - 32, a.left + a.width / 2 - placed.left - 11)))}px`;
      tail.hidden = placed.bottom + gap > a.top + 1;
      popover.dataset.placement = tail.hidden ? 'viewport' : 'above';
    }
    const positionSignature = `${Math.round(placed.left)}:${Math.round(placed.top)}:${Math.round(placed.width)}:${Math.round(placed.height)}:${Math.round(a.left)}`;
    if (popover.__scPositionSignature !== positionSignature) {
      popover.__scPositionSignature = positionSignature;
      log('word popover positioned', {
        anchorLeft: Math.round(a.left),
        anchorCenterX: Math.round(a.left + a.width / 2),
        desiredLeft: Math.round(layout.desiredLeft),
        left: Math.round(placed.left),
        top: Math.round(placed.top),
        width: Math.round(placed.width),
        height: Math.round(placed.height),
        maxHeight: Math.round(layout.maxHeight),
        overlapsAnchor: layout.overlapsAnchor,
        safeLeft: margin,
        safeRight: innerWidth - margin,
      });
    }
  }

  function fixedAnchorReference(anchor) {
    const wordRect = anchor.getBoundingClientRect();
    const sourceRect = sourceRow?.getBoundingClientRect();
    const sourceTop = sourceRect?.height > 0 ? sourceRect.top : wordRect.top;
    const rect = {
      left: wordRect.left,
      right: wordRect.right,
      width: wordRect.width,
      top: sourceTop,
      bottom: sourceRect?.height > 0 ? sourceRect.bottom : wordRect.bottom,
      height: sourceRect?.height > 0 ? sourceRect.height : wordRect.height,
    };
    return {
      isConnected: true,
      getBoundingClientRect() { return rect; },
    };
  }

  function quickTranslationKey(word) {
    return [
      sourceLanguage().toLocaleLowerCase('en-US'),
      String(settings.learning_target_lang || 'ru').toLocaleLowerCase('en-US'),
      U.normalizeTerm(word),
    ].join('|');
  }

  function fixedQuickWordRows(word) {
    const normalized = U.normalizeTerm(word);
    if (normalized === 'the') return [{ value: 'определённый артикль', partOfSpeech: '' }];
    if (normalized === 'a' || normalized === 'an') return [{ value: 'неопределённый артикль', partOfSpeech: '' }];
    return [];
  }

  function quickAlignedFallbacks(word, cueIndex, sourceWordIndex, anchor) {
    const cue = cues[cueIndex];
    const key = quickTranslationKey(word);
    const fallbacks = [...fixedQuickWordRows(word), ...(quickWordTranslations.get(key) || [])];
    const literal = cue ? literalTranslationsByText.get(cue.text) : null;
    if (literal?.literalText && Number.isInteger(sourceWordIndex) && sourceWordIndex >= 0) {
      for (const range of literal.alignments || []) {
        if (Number(range?.sourceWordIndex) !== sourceWordIndex) continue;
        const value = literal.literalText.slice(Number(range.targetStart), Number(range.targetEnd)).trim();
        if (value) fallbacks.push(value);
      }
    }
    const natural = cue ? translationsByText.get(cue.text) || '' : '';
    const projection = cue ? translationAlignmentsByText.get(cue.text) || '' : '';
    if (cue && natural && projection) {
      for (const range of U.alignedTargetRanges(cue.text, natural, word, projection, sourceLanguage())) {
        const value = natural.slice(range.start, range.end).trim();
        if (value) fallbacks.push(value);
      }
    }
    const stored = String(anchor?.__scLearningState?.translation || '').trim();
    if (stored) fallbacks.push(...stored.split(/\s*;\s*/).filter(Boolean));
    return U.quickWordTranslationRows(null, fallbacks, 3, word);
  }

  function positionQuickWordPopover(popover, anchor) {
    if (!popover?.isConnected || !anchor?.isConnected) return;
    const margin = 10;
    const gap = 6;
    const anchorRect = anchor.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const left = U.quickWordPopoverLeft({
      anchorLeft: anchorRect.left,
      anchorWidth: anchorRect.width,
      popoverWidth: popoverRect.width,
      viewportWidth: innerWidth,
      margin,
    });
    const above = anchorRect.top - popoverRect.height - gap;
    const top = above >= margin
      ? above
      : Math.min(innerHeight - popoverRect.height - margin, anchorRect.bottom + gap);
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(Math.max(margin, top))}px`;
    U.fitFloatingElement(popover, anchor, { margin, gap });
  }

  function renderQuickWordPopover(popover = document.getElementById(QUICK_WORD_POPOVER_ID)) {
    const refs = popover?.__scQuickWordRefs;
    if (!popover || !refs) return;
    const fallbackRows = quickAlignedFallbacks(refs.word, refs.cueIndex, refs.sourceWordIndex, refs.anchor);
    const rows = U.quickWordTranslationRows(null, fallbackRows, 1, refs.word);
    refs.rows.replaceChildren();
    const visibleRows = rows.length ? rows : [{ value: 'Перевожу…', partOfSpeech: '' }];
    popover.dataset.loading = rows.length ? '0' : '1';
    for (const row of visibleRows) {
      const line = document.createElement('div');
      line.className = 'sc-quick-word-row';
      const value = document.createElement('span');
      value.textContent = row.value;
      line.appendChild(value);
      refs.rows.appendChild(line);
    }
    positionQuickWordPopover(popover, refs.anchor);
  }

  function showQuickWordPopover(anchor, word, cueIndex, sourceWordIndex) {
    if (!settings.learning_hover_word_translation || !anchor?.isConnected
        || (phraseSelectionOpen && !phraseSelection)) return;
    let popover = document.getElementById(QUICK_WORD_POPOVER_ID);
    let rows = popover?.__scQuickWordRefs?.rows || null;
    if (!popover) {
      popover = document.createElement('div');
      popover.id = QUICK_WORD_POPOVER_ID;
      popover.setAttribute('role', 'tooltip');
      rows = document.createElement('div');
      popover.appendChild(rows);
      document.body.appendChild(popover);
    }
    popover.__scQuickWordRefs = {
      anchor,
      word,
      cueIndex,
      sourceWordIndex,
      key: quickTranslationKey(word),
      rows,
    };
    renderQuickWordPopover(popover);
  }

  function scheduleQuickWordPopover(anchor, word, cueIndex, sourceWordIndex) {
    if (!settings.learning_hover_word_translation || (phraseSelectionOpen && !phraseSelection)) return;
    if (quickWordHideTimer != null) clearTimeout(quickWordHideTimer);
    quickWordHideTimer = null;
    if (quickWordHoverTimer != null) clearTimeout(quickWordHoverTimer);
    quickWordHoverTimer = null;
    quickWordHoverAnchor = anchor;
    const token = ++quickWordHoverToken;
    if (document.getElementById(QUICK_WORD_POPOVER_ID)) {
      showQuickWordPopover(anchor, word, cueIndex, sourceWordIndex);
      return;
    }
    quickWordHoverTimer = setTimeout(() => {
      quickWordHoverTimer = null;
      if (token !== quickWordHoverToken || quickWordHoverAnchor !== anchor
          || !anchor?.isConnected) return;
      const pointerTarget = quickWordPointer && document.elementFromPoint(quickWordPointer.x, quickWordPointer.y);
      if (!anchor.matches(':hover') && !(pointerTarget && (pointerTarget === anchor || anchor.contains(pointerTarget)))) return;
      showQuickWordPopover(anchor, word, cueIndex, sourceWordIndex);
    }, QUICK_WORD_HOVER_DELAY_MS);
  }

  function scheduleHideQuickWordPopover(anchor) {
    if (anchor && quickWordHoverAnchor && quickWordHoverAnchor !== anchor) return;
    if (quickWordHideTimer != null) clearTimeout(quickWordHideTimer);
    quickWordHideTimer = setTimeout(() => {
      quickWordHideTimer = null;
      hideQuickWordPopover(anchor);
    }, 110);
  }

  function hideQuickWordPopover(anchor = null) {
    if (anchor && quickWordHoverAnchor && quickWordHoverAnchor !== anchor) return;
    if (quickWordHoverTimer != null) clearTimeout(quickWordHoverTimer);
    if (quickWordHideTimer != null) clearTimeout(quickWordHideTimer);
    quickWordHoverTimer = null;
    quickWordHideTimer = null;
    quickWordHoverAnchor = null;
    quickWordHoverToken += 1;
    document.getElementById(QUICK_WORD_POPOVER_ID)?.remove();
  }

  async function prefetchQuickWordTranslations(cue) {
    if (!settings.learning_hover_word_translation || !cue
        || sourceLanguage().toLocaleLowerCase('en-US') === String(settings.learning_target_lang || '').toLocaleLowerCase('en-US')) return;
    const unique = [];
    const seen = new Set();
    for (const part of U.segmentWords(cue.text, sourceLanguage())) {
      if (!part.word || seen.has(part.normalized)) continue;
      seen.add(part.normalized);
      const key = quickTranslationKey(part.text);
      const fixedRows = fixedQuickWordRows(part.text);
      if (fixedRows.length) {
        quickWordTranslations.set(key, fixedRows);
        continue;
      }
      if (quickWordTranslations.has(key) || quickTranslationPending.has(key)) continue;
      quickTranslationPending.add(key);
      unique.push({ text: part.normalized || part.text, key });
      if (unique.length >= 25) break;
    }
    if (!unique.length) return;
    try {
      const payload = await bridgeJson('/translator/translate', {
        method: 'POST',
        body: { texts: unique.map(item => item.text), from: sourceLanguage(), to: settings.learning_target_lang },
      });
      for (const item of payload?.translations || []) {
        const key = quickTranslationKey(item.source_text);
        const value = String(item.translated_text || '').trim();
        if (value) quickWordTranslations.set(key, [{ value, partOfSpeech: '' }]);
      }
    } catch {
      // Alignment and stored vocabulary still provide an immediate fallback.
    } finally {
      for (const item of unique) quickTranslationPending.delete(item.key);
      const popover = document.getElementById(QUICK_WORD_POPOVER_ID);
      if (popover) renderQuickWordPopover(popover);
    }
  }

  function closeWordPopover({ resume = true, preserveHistory = false, reason = 'dismiss' } = {}) {
    const pendingClick = pendingWordClickTimer != null;
    clearTimeout(pendingWordClickTimer); pendingWordClickTimer = null;
    if (!preserveHistory) wordPopoverHistory.length = 0;
    popoverResizeObserver?.disconnect();
    popoverResizeObserver = null;
    const popover = document.getElementById(WORD_POPOVER_ID);
    const highlightedCueIndex = popover?.__scWordRefs?.cueIndex;
    if (popover || pendingClick) logLearningAction('word closed', { term: popover?.__scWordRefs?.word || '',
      cueIndex: highlightedCueIndex, reason, pendingClick });
    window.__scLearningChoicesPopover?.closeFor(popover);
    popover?.remove();
    wordPopoverOpen = false;
    applyActiveSourceWordMark();
    if (highlightedCueIndex === currentCueIndex && currentCueIndex >= 0) renderTranslationForCue(currentCueIndex);
    if (resume) settleHoverAfterDismissal();
    else updateHoverHoldState();
  }

  function syncWordPopoverScrollState() {
    const popover = document.getElementById(WORD_POPOVER_ID);
    const refs = popover?.__scWordRefs;
    if (!popover || !refs) return;
    const playerRect = playerAnchor()?.getBoundingClientRect();
    if (!playerRect) {
      popover.hidden = true;
      return;
    }
    const state = U.floatingPopoverScrollState({
      openedScrollX: refs.openedScrollX,
      openedScrollY: refs.openedScrollY,
      currentScrollX: scrollX,
      currentScrollY: scrollY,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      playerRect,
    });
    popover.__scScrollDetached = state.detached;
    popover.dataset.scrollDetached = state.detached ? '1' : '0';
    popover.hidden = !state.playerVisible;
    if (refs.tail) {
      refs.tail.hidden = state.detached || popover.dataset.placement !== 'above';
    }
    if (!state.detached && state.playerVisible) {
      positionPopover(popover, refs.anchor, { force: true });
    } else if (state.playerVisible) {
      positionPopover(popover, refs.anchor);
    }
  }

  function onViewportScroll() {
    hideQuickWordPopover();
    updateGeometry();
    if (viewportScrollFrame != null) return;
    viewportScrollFrame = requestAnimationFrame(() => {
      viewportScrollFrame = null;
      syncWordPopoverScrollState();
    });
  }

  function speak(text) {
    try {
      speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = sourceLanguage();
      if (U?.isDesktopChromiumSpeech?.(navigator.userAgent) && utterance.lang.toLocaleLowerCase().startsWith('en')) {
        const voice = U?.preferredEnglishSpeechVoice?.(speechSynthesis.getVoices(), utterance.lang);
        if (voice) utterance.voice = voice;
        utterance.rate = 0.85;
      }
      speechSynthesis.speak(utterance);
    } catch {}
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch {}
    const area = document.createElement('textarea');
    area.value = text;
    area.style.cssText = 'position:fixed;left:-99999px;top:0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }

  function primaryDictionaryTranslation(payload) {
    return payload?.dictionary?.translations?.[0]?.displayTarget
      || payload?.dictionary?.translations?.[0]?.normalizedTarget
      || payload?.fallback_translation
      || '';
  }

  function dictionaryNormalizedSource(payload, fallback) {
    return payload?.dictionary?.normalizedSource || U.normalizeTerm(fallback);
  }

  function partOfSpeechLabel(value) {
    const tag = String(value || '').trim().toUpperCase();
    return PART_OF_SPEECH_LABELS[tag] || (tag ? tag.toLocaleLowerCase() : '');
  }

  function cueContext(cue, surfaceForm = '', partOfSpeech = 'unknown', meaning = '') {
    if (cue?.origin === 'dictionary') return { sourceText: cue.text, translation: cue.translation || '',
      surfaceForm: U.normalizeTerm(surfaceForm), origin: 'manual', partOfSpeech, meaning };
    const cueIndex = Number.isInteger(cue?.index) ? cue.index : cues.indexOf(cue);
    const sourceText = U.sentenceForCueTerm(cues, cueIndex, surfaceForm, sourceLanguage(), cue?.contextWordIndex);
    if (!U.sentenceIsComplete(sourceText, sourceLanguage())) return null;
    const rawTranslation = cue ? cue.translation || translationsByText.get(cue.text) || '' : '';
    const translationPair = U.parallelSentenceForTerm(
      cue?.text || '',
      rawTranslation,
      surfaceForm,
      sourceLanguage(),
      settings.learning_target_lang,
      cue?.contextWordIndex,
    );
    return {
      videoId: videoMeta.videoId,
      videoUrl: currentMediaUrl(),
      videoTitle: videoMeta.title,
      startMs: cue?.startMs,
      endMs: cue?.endMs,
      sourceText,
      surfaceForm: U.normalizeTerm(surfaceForm),
      translation: translationPair.sourceText === sourceText ? translationPair.translation : '',
      origin: 'video',
      partOfSpeech: Lexeme?.normalizePartOfSpeech?.(partOfSpeech) || partOfSpeech || 'unknown',
      meaning: String(meaning || '').replace(/\s+/g, ' ').trim().slice(0, 500),
    };
  }

  function wordIdentity(word, cue, overrides = {}) {
    const kind = String(word).trim().includes(' ') ? 'phrase' : 'word';
    const identity = Lexeme?.canonicalIdentity?.({
      kind,
      sourceLang: sourceLanguage(),
      targetLang: settings.learning_target_lang,
      sourceText: word,
      context: cue?.text || '',
      ...overrides,
    }) || {
      lemma: U.normalizeTerm(word),
      partOfSpeech: 'unknown',
      confidence: 'low',
      normalizedSurface: U.normalizeTerm(word),
    };
    return {
      kind,
      sourceLang: sourceLanguage(),
      targetLang: settings.learning_target_lang,
      sourceText: word,
      normalizedText: identity.lemma,
      lemma: identity.lemma,
      partOfSpeech: identity.partOfSpeech,
      analysisConfidence: identity.confidence,
      observedForms: [identity.normalizedSurface || U.normalizeTerm(word)],
      context: cue?.text || '',
    };
  }

  function localLearningPayload({ kind, state: nextState, sourceText, normalizedText, translation, cue, contexts = [], contextMeaning = '', toggle = true, identity = null, surfaceForm = '' }) {
    return {
      kind,
      state: nextState,
      toggle,
      sourceText,
      normalizedText,
      ...(identity || {}),
      translation: translation || '',
      translationSource: translation ? 'machine' : '',
      sourceLang: sourceLanguage(),
      targetLang: settings.learning_target_lang,
      contexts: [
        ...(cue ? [cueContext(cue, surfaceForm || sourceText, identity?.partOfSpeech, contextMeaning)].filter(Boolean) : []),
        ...(Array.isArray(contexts) ? contexts : []),
      ],
    };
  }

  async function saveLearning({ kind, state: nextState, sourceText, normalizedText, translation, cue, contexts = [], contextMeaning = '', toggle = true, identity = null, surfaceForm = '' }) {
    if (!learningStore) throw new Error('Локальный словарь недоступен');
    const payload = localLearningPayload({
      kind,
      state: nextState,
      sourceText,
      normalizedText,
      translation,
      cue,
      contexts,
      contextMeaning,
      toggle,
      identity,
      surfaceForm,
    });
    return learningStore.setState({ ...payload, contextAdditions: payload.contexts,
      observedFormAdditions: payload.observedForms || [] });
  }

  function applyLearningStateToWord(word, cue) {
    if (!word) return null;
    const resolved = learningStateForWord(word.textContent, cue);
    word.__scLearningState = resolved.state || null;
    if (resolved.state?.state) {
      word.dataset.learningState = resolved.state.state;
    } else {
      delete word.dataset.learningState;
    }
    updateWordLearningTitle(word);
    const phrasePending = word.__scExampleCue && U.pendingSaveWordIndexes([cue], 0, vocabularySaves?.all(), sourceLanguage())
      .includes(Number(word.dataset.wordIndex));
    word.dataset.saving = phrasePending || vocabularySaves?.pending(vocabularySaves.get(word.textContent, resolved.identity?.lemma, resolved.state?.lemma)) ? '1' : '0';
    return resolved;
  }

  function applyCurrentCueExpressionMarks() {
    currentExpressionMatches = U.expressionMatchesForCue(
      cues,
      currentCueIndex,
      expressionEntries,
      sourceLanguage(),
    );
    const words = Array.from(sourceRow?.querySelectorAll?.('.sc-learning-word[data-word-index]') || []);
    const saving = new Set(U.pendingSaveWordIndexes(cues, currentCueIndex, vocabularySaves?.all(), sourceLanguage()));
    for (const word of words) {
      if (saving.has(Number(word.dataset.wordIndex))) word.dataset.saving = '1';
      delete word.dataset.expressionState;
      delete word.dataset.expressionType;
      word.__scExpressionMatch = null;
    }
    for (const match of currentExpressionMatches) {
      for (const wordIndex of match.wordIndexes) {
        const word = words.find(candidate => Number(candidate.dataset.wordIndex) === wordIndex);
        if (!word) continue;
        word.dataset.expressionState = match.entry?.state || 'saved';
        word.dataset.expressionType = match.entry?.expressionType || '';
        word.__scExpressionMatch = match;
      }
    }
    words.forEach(updateWordLearningTitle);
    const refs = document.getElementById(WORD_POPOVER_ID)?.__scWordRefs;
    if (refs) renderWordExpressionLinks(refs);
  }

  function translationTermsForState(state) {
    return String(state?.translation || '')
      .split(/[,;/|]+/)
      .map(value => value.trim())
      .filter(Boolean);
  }

  function translatedLearningAnnotations(cue, translatedText) {
    const annotations = [];
    const alignment = translationAlignmentsByText.get(cue?.text) || '';
    const sourceWords = Array.from(sourceRow?.querySelectorAll?.('.sc-learning-word[data-word-index]') || []);
    for (const word of sourceRow?.querySelectorAll?.('.sc-learning-word[data-learning-state]') || []) {
      const state = word.__scLearningState;
      let ranges = U.alignedTargetRanges(
        cue.text,
        translatedText,
        word.textContent,
        alignment,
        sourceLanguage(),
      );
      if (!ranges.length) {
        ranges = U.exactTermRanges(
          translatedText,
          translationTermsForState(state),
          settings.learning_target_lang,
        );
      }
      for (const range of ranges) annotations.push({ ...range, state: state?.state || '' });
    }
    for (const match of currentExpressionMatches) {
      let ranges = match.wordIndexes.flatMap((wordIndex) => {
        const word = sourceWords.find(candidate => Number(candidate.dataset.wordIndex) === wordIndex);
        return word ? U.alignedTargetRanges(cue.text, translatedText, word.textContent, alignment, sourceLanguage()) : [];
      });
      if (!ranges.length) {
        ranges = U.exactTermRanges(
          translatedText,
          translationTermsForState(match.entry),
          settings.learning_target_lang,
        );
      }
      for (const range of ranges) annotations.push({ ...range, state: match.entry?.state || '' });
    }
    const refs = document.getElementById(WORD_POPOVER_ID)?.__scWordRefs;
    if (refs?.cueIndex === currentCueIndex) {
      let activeRanges = U.alignedTargetRanges(
        cue.text,
        translatedText,
        refs.word || '',
        alignment,
        sourceLanguage(),
      );
      if (!activeRanges.length && refs.targetTerms?.length) {
        activeRanges = U.exactTermRanges(translatedText, refs.targetTerms, settings.learning_target_lang);
      }
      for (const range of activeRanges) annotations.push({ ...range, active: true });
    }
    return annotations;
  }

  function literalLearningAnnotations(literal) {
    const annotations = [];
    const sourceWords = Array.from(sourceRow?.querySelectorAll?.('.sc-learning-word[data-word-index]') || []);
    const refs = document.getElementById(WORD_POPOVER_ID)?.__scWordRefs;
    for (const word of sourceWords) {
      const sourceWordIndex = Number(word.dataset.wordIndex);
      const state = word.__scLearningState;
      for (const range of literal.alignments || []) {
        if (range.sourceWordIndex !== sourceWordIndex) continue;
        const targetRange = U.snapTextRangeToWords(literal.literalText, range.targetStart, range.targetEnd);
        if (!targetRange) continue;
        annotations.push({ ...targetRange, state: state?.state || '' });
        if (refs?.cueIndex === currentCueIndex && refs.sourceWordIndex === sourceWordIndex) {
          annotations.push({ ...targetRange, active: true });
        }
      }
    }
    for (const match of currentExpressionMatches) {
      for (const sourceWordIndex of match.wordIndexes) {
        for (const range of literal.alignments || []) {
          if (range.sourceWordIndex !== sourceWordIndex) continue;
          const targetRange = U.snapTextRangeToWords(literal.literalText, range.targetStart, range.targetEnd);
          if (targetRange) annotations.push({ ...targetRange, state: match.entry?.state || '' });
        }
      }
    }
    return annotations;
  }

  function clearRussianSelection({ resume = true } = {}) {
    clearTimeout(russianClickTimer); russianClickTimer = null;
    const previous = russianSelection; russianSelection = null;
    previous?.popup?.close({ notify: false });
    applyRussianSelectionMarks();
    if (resume) settleHoverAfterDismissal();
    else updateHoverHoldState();
  }

  function applyRussianSelectionMarks() {
    const selected = russianSelection;
    const sourceParts = U.segmentWords(cues[currentCueIndex]?.text || '', sourceLanguage()).filter(p => p.word);
    for (const word of translationRow?.querySelectorAll('.sc-learning-ru-word') || []) {
      const start = Number(word.dataset.start), end = Number(word.dataset.end);
      word.toggleAttribute('data-ru-selected', !!selected && start >= selected.targetStart && end <= selected.targetEnd);
    }
    for (const word of sourceRow?.querySelectorAll('.sc-learning-word') || []) {
      const part = sourceParts[Number(word.dataset.wordIndex)];
      const matched = !!part && selected?.sourceRanges?.some(range => range.start < part.index + part.text.length && range.end > part.index);
      word.toggleAttribute('data-ru-match', !!matched);
    }
  }

  function openRussianSelection(firstIndex, lastIndex = firstIndex, selecting = false) {
    const text = translationRow?.textContent || '', cue = cues[currentCueIndex];
    if (!cue || !/^en(?:-|$)/i.test(sourceLanguage()) || !/^ru(?:-|$)/i.test(settings.learning_target_lang)
      || translationRow.getAttribute('aria-busy') === 'true') return;
    const parts = U.segmentWords(text, 'ru').filter(p => p.word);
    const first = parts[Math.min(firstIndex, lastIndex)], last = parts[Math.max(firstIndex, lastIndex)];
    if (!first || !last || !window.__scLearningChoicesPopover) return;
    clearRussianSelection({ resume: false });
    closeWordPopover({ resume: false }); clearPhraseSelection({ resume: false }); hideQuickWordPopover();
    const selection = { cueIndex: currentCueIndex, text, firstIndex, selecting,
      targetStart: first.index, targetEnd: last.index + last.text.length, sourceRanges: [], request: 0 };
    russianSelection = selection;
    pauseForPhraseSelection(currentCueIndex);
    const anchor = { contains: node => translationRow.contains(node), getBoundingClientRect: () => {
      const nodes = Array.from(translationRow.querySelectorAll('.sc-learning-ru-word')).filter(node => Number(node.dataset.start) >= selection.targetStart && Number(node.dataset.end) <= selection.targetEnd);
      const rects = nodes.map(node => node.getBoundingClientRect());
      if (!rects.length) return translationRow.getBoundingClientRect();
      const left = Math.min(...rects.map(r => r.left)), right = Math.max(...rects.map(r => r.right));
      const top = Math.min(...rects.map(r => r.top)), bottom = Math.max(...rects.map(r => r.bottom));
      return { left, right, top, bottom, width: right - left, height: bottom - top };
    } };
    const title = text.slice(selection.targetStart, selection.targetEnd);
    const load = async () => {
      const request = ++selection.request;
      selection.popup.update({ model: { title, phase: 'loading', loadingText: 'Разбираю перевод в этой реплике…' } });
      try {
        const result = await bridgeJson('/learning/catalogue', { method: 'POST', body: {
          action: 'context-choice', context: cue.text, contextTranslation: text,
          targetStart: selection.targetStart, targetEnd: selection.targetEnd,
        } });
        if (russianSelection !== selection || request !== selection.request || currentCueIndex !== selection.cueIndex) return;
        if (result.context !== cue.text || result.contextTranslation !== text || result.targetStart !== selection.targetStart
          || result.targetEnd !== selection.targetEnd || !Array.isArray(result.sourceRanges)
          || result.sourceRanges.some(r => !Number.isInteger(r.start) || !Number.isInteger(r.end) || r.start < 0 || r.end <= r.start || r.end > cue.text.length)) {
          throw new Error('Разбор относится к другому выделению. Повторите запрос.');
        }
        selection.sourceRanges = result.sourceRanges; applyRussianSelectionMarks();
        selection.popup.update({ model: { ...result, title, phase: 'ready', description: result.explanation } });
      } catch (error) {
        if (russianSelection === selection && request === selection.request) selection.popup.update({ model: { title, phase: 'error', error: error.message } });
      }
    };
    selection.popup = window.__scLearningChoicesPopover.create({ owner: translationRow, anchor,
      model: { title, phase: selecting ? 'selecting' : 'loading' }, onRetry: load,
      onClose: ({ event } = {}) => {
        if (russianSelection !== selection) return;
        const nativePlayback = !!event && U.dismissalPlaybackOwner({ via: 'outside-pointer', insidePlayer: !!playerAnchor()?.contains(event.target) }) === 'native-player';
        clearRussianSelection({ resume: !nativePlayback });
        if (nativePlayback) relinquishHoverPauseOwnership();
      },
      isSaved: term => ['saved', 'known'].includes(learningStateForWord(term, cue)?.state?.state),
      onChoice: (choice, node) => {
        const fixed = fixedAnchorReference(node); clearRussianSelection({ resume: false });
        void openWordPopover(fixed, choice.term, selection.cueIndex, null, { context: { ...cue, translation: text, origin: 'video' } });
      },
    });
    applyRussianSelectionMarks();
    if (!selecting) void load();
  }

  function russianWordClick(event, index) {
    event.preventDefault(); event.stopPropagation();
    clearTimeout(russianClickTimer); russianClickTimer = null;
    const at = performance.now();
    if (event.shiftKey) { lastRussianClick = null; openRussianSelection(index, index, true); return; }
    if (russianSelection?.selecting) { openRussianSelection(russianSelection.firstIndex, index); lastRussianClick = null; return; }
    const repeated = lastRussianClick?.cueIndex === currentCueIndex && lastRussianClick.index === index && at - lastRussianClick.at < WORD_DOUBLE_CLICK_MS;
    if (repeated) { lastRussianClick = null; openRussianSelection(index, index, true); return; }
    lastRussianClick = { index, at, cueIndex: currentCueIndex };
    const cueIndex = currentCueIndex;
    russianClickTimer = setTimeout(() => { russianClickTimer = null; if (cueIndex === currentCueIndex) openRussianSelection(index); }, WORD_DOUBLE_CLICK_MS);
  }

  function renderAnnotatedTranslation(container, text, annotations) {
    container.replaceChildren();
    if (container === translationRow && /^en(?:-|$)/i.test(sourceLanguage()) && /^ru(?:-|$)/i.test(settings.learning_target_lang)) {
      if (russianSelection && (russianSelection.text !== text || russianSelection.cueIndex !== currentCueIndex)) clearRussianSelection({ resume: false });
      let index = 0;
      for (const part of U.segmentWords(text, 'ru')) {
        if (!part.word) { container.append(document.createTextNode(part.text)); continue; }
        const word = document.createElement('span'), wordIndex = index++;
        word.className = 'sc-learning-ru-word'; word.textContent = part.text; word.tabIndex = 0; word.setAttribute('role', 'button');
        word.dataset.start = part.index; word.dataset.end = part.index + part.text.length;
        const marks = annotations.filter(a => a.start < part.index + part.text.length && a.end > part.index);
        const state = marks.find(a => a.state)?.state;
        if (state) word.dataset.learningState = state;
        if (marks.some(a => a.active)) word.dataset.active = '1';
        word.addEventListener('click', event => russianWordClick(event, wordIndex));
        word.addEventListener('pointerenter', () => { hoveredRussianWord = wordIndex; });
        word.addEventListener('pointerleave', () => { if (hoveredRussianWord === wordIndex) hoveredRussianWord = null; });
        word.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') russianWordClick(event, wordIndex); });
        container.append(word);
      }
      applyRussianSelectionMarks(); russianSelection?.popup?.position(); return;
    }
    for (const segment of U.annotatedTextSegments(text, annotations)) {
      if (!segment.state && !segment.active) {
        container.appendChild(document.createTextNode(segment.text));
        continue;
      }
      const mark = document.createElement('mark');
      mark.textContent = segment.text;
      if (segment.state) mark.dataset.learningState = segment.state;
      if (segment.active) mark.dataset.active = '1';
      container.appendChild(mark);
    }
  }

  function renderPendingTranslation(reserveText, state, cueKey) {
    translationRow.dataset.literalState = state;
    translationRow.setAttribute('aria-busy', 'true');
    translationRow.textContent = reserveText || '…';
    requestAnimationFrame(() => {
      if (translationRow.dataset.literalState !== state || translationRow.dataset.cueKey !== cueKey) return;
      const rect = translationRow.getBoundingClientRect();
      translationRow.style.minWidth = `${Math.ceil(rect.width)}px`;
      translationRow.style.minHeight = `${Math.ceil(rect.height)}px`;
    });
  }

  function renderTranslationForCue(index) {
    if (!translationRow || index !== currentCueIndex || !cues[index]) return;
    const cue = cues[index];
    const sameLanguage = !literalTranslationNeeded();
    translationRow.hidden = sameLanguage;
    if (sameLanguage) {
      delete translationRow.dataset.literalState;
      translationRow.removeAttribute('aria-busy');
      translationRow.replaceChildren();
      scheduleSubtitleLayout();
      return;
    }
    const cueKey = `${cue.startMs}:${cue.endMs}`;
    if (translationRow.dataset.cueKey !== cueKey) {
      translationRow.dataset.cueKey = cueKey;
      translationRow.style.minWidth = '';
      translationRow.style.minHeight = '';
    }
    let translated = translationsByText.get(cue.text);
    if (!translated) {
      ensureCueTranslation(index);
      translated = translationsByText.get(cue.text);
    }
    if (translated) {
      const literal = settings.learning_translation_order === 'source'
        ? literalTranslationsByText.get(cue.text)
        : null;
      if (settings.learning_translation_order === 'source' && !literal && !failedLiteralTexts.has(cue.text)) {
        // Invisible natural text reserves almost the same wrapping geometry as
        // the literal line. The learner never sees one translation replaced by
        // another, and the subtitle card does not collapse while AI responds.
        renderPendingTranslation(translated, 'pending', cueKey);
        prefetchLiteralWindow(index);
      } else {
        translationRow.dataset.literalState = literal ? 'ready' : 'fallback';
        translationRow.removeAttribute('aria-busy');
        renderAnnotatedTranslation(
          translationRow,
          literal?.literalText || translated,
          literal ? literalLearningAnnotations(literal) : translatedLearningAnnotations(cue, translated),
        );
      }
    } else {
      if (pendingTranslationTexts.has(cue.text)) {
        // Reserve space from the source cue before Azure responds. The same
        // loader remains visible through the subsequent literal request.
        renderPendingTranslation(cue.text, 'translation-pending', cueKey);
      } else {
        delete translationRow.dataset.literalState;
        translationRow.removeAttribute('aria-busy');
        translationRow.textContent = translationError ? 'Перевод временно недоступен' : '';
      }
    }
    scheduleSubtitleLayout();
  }

  function applyCurrentCueLearningMarks() {
    const cue = cues[currentCueIndex];
    if (!cue || !sourceRow) return;
    for (const word of sourceRow.querySelectorAll('.sc-learning-word[data-word-index]')) {
      applyLearningStateToWord(word, cue);
    }
    applyCurrentCueExpressionMarks();
    applyActiveSourceWordMark();
    renderTranslationForCue(currentCueIndex);
  }

  function applyActiveSourceWordMark() {
    const refs = document.getElementById(WORD_POPOVER_ID)?.__scWordRefs;
    for (const word of sourceRow?.querySelectorAll?.('.sc-learning-word[data-word-index]') || []) {
      const active = U.sourceWordIsActive({
        currentCueIndex,
        wordIndex: Number(word.dataset.wordIndex),
        popoverCueIndex: refs?.cueIndex,
        popoverWordIndex: refs?.sourceWordIndex,
      });
      if (active) word.dataset.active = '1';
      else delete word.dataset.active;
    }
  }

  function renderExampleSegments(container, segments) {
    container.replaceChildren();
    for (const segment of segments || []) {
      if (!segment.active) container.appendChild(document.createTextNode(segment.text));
      else {
        const mark = document.createElement('mark');
        mark.textContent = segment.text;
        container.appendChild(mark);
      }
    }
  }

  function renderExampleTranslation(container, example, refs, forms) {
    const naturalTranslation = translationsByText.get(example.text) || '';
    const literal = literalTranslationsByText.get(example.text) || null;
    const choice = U.exampleTranslationChoice({
      naturalTranslation,
      literalTranslation: literal,
      translationOrder: settings.learning_translation_order,
      literalFailed: failedLiteralTexts.has(example.text),
    });
    if (choice.state === 'ready' || choice.state === 'fallback') {
      const presentation = U.learningExamplePresentation({
        sourceText: example.text,
        targetText: choice.text,
        sourceTerms: forms,
        targetTerms: refs?.targetTerms || [],
        sourceLanguage: sourceLanguage(),
        targetLanguage: settings.learning_target_lang,
        alignment: choice.literal ? '' : translationAlignmentsByText.get(example.text) || '',
        literalAlignments: choice.literal ? literal?.alignments : [],
      });
      renderExampleSegments(container, presentation.targetSegments);
      return;
    }
    if (choice.state === 'pending') {
      container.classList.add('sc-word-skeleton');
      container.style.cssText = 'height:13px;width:72%;margin-top:7px';
      void ensureCueLiteralTranslation(example.cueIndex);
      return;
    }
    if (translationError) {
      container.classList.add('sc-word-error');
      container.textContent = 'Перевод временно недоступен';
      return;
    }
    container.classList.add('sc-word-skeleton');
    container.style.cssText = 'height:13px;width:72%;margin-top:7px';
    ensureCueTranslation(example.cueIndex);
  }

  function openStudyPage() {
    try { chrome.runtime.sendMessage({ type: 'sc-open-study' }); } catch {}
  }

  function skeletonRow() {
    const row = document.createElement('div');
    row.className = 'sc-word-skeleton-row';
    const lines = document.createElement('span');
    lines.className = 'sc-word-skeleton-lines';
    const first = document.createElement('span');
    first.className = 'sc-word-skeleton';
    const second = document.createElement('span');
    second.className = 'sc-word-skeleton';
    lines.append(first, second);
    row.append(lines);
    return row;
  }

  function setPopoverActionStatus(refs, stateName, { loading = false, error = false, label = '', message = '' } = {}) {
    const button = refs?.stateButtons?.get(stateName);
    if (!button) return;
    button.dataset.loading = loading ? '1' : '0';
    button.dataset.error = error ? '1' : '0';
    button.setAttribute('aria-busy', String(loading));
    if (message) button.title = message;
    else button.removeAttribute('title');
    const text = button.querySelector('span');
    if (text) text.textContent = label || button.dataset.defaultLabel || '';
    if (error && refs.actionError) {
      refs.actionError.textContent = message || 'Не удалось изменить состояние слова. Повторите попытку.';
      refs.actionError.hidden = false;
    }
  }

  function resetPopoverActionStatuses(refs) {
    if (refs?.actionError) { refs.actionError.hidden = true; refs.actionError.textContent = ''; }
    for (const name of refs?.stateButtons?.keys?.() || []) setPopoverActionStatus(refs, name);
  }

  function wordStateOperationKey(refs) {
    return [refs.query?.sourceLang || sourceLanguage(), refs.query?.targetLang || settings.learning_target_lang,
      U.normalizeTerm(refs.word)].join('|');
  }

  function joinWordStateOperation(refs) {
    const operation = wordStateOperations.get(wordStateOperationKey(refs));
    if (!operation) return applySharedSaveStatus(refs);
    operation.views.add(refs);
    refs.busy = true;
    for (const button of refs.stateButtons.values()) button.disabled = true;
    setPopoverActionStatus(refs, operation.stateName, { loading: true, label: operation.label });
    return true;
  }

  function applySharedSaveStatus(refs) {
    if (!vocabularySaves || !refs) return false;
    const operation = vocabularySaves.get(refs.word, refs.query?.lemma);
    if (vocabularySaves.pending(operation)) {
      refs.sharedSaveBusy = true; refs.busy = true;
      for (const button of refs.stateButtons.values()) button.disabled = true;
      setPopoverActionStatus(refs, 'saved', { loading: true, label: operation.phase === 'saving' ? 'Сохраняю…' : 'Проверяю…' });
      return true;
    }
    if (refs.sharedSaveBusy && !wordStateOperations.has(wordStateOperationKey(refs))) {
      refs.sharedSaveBusy = false; refs.busy = false;
      for (const button of refs.stateButtons.values()) button.disabled = false;
      resetPopoverActionStatuses(refs);
    }
    if (operation?.phase === 'error' && !refs.busy) setPopoverActionStatus(refs, 'saved', { error: true, label: 'Повторить', message: operation.error });
    return false;
  }

  function applyPopoverState(refs, entry) {
    if (!refs) return;
    refs.entry = entry || null;
    if (!refs.busy) resetPopoverActionStatuses(refs);
    const state = entry?.state || 'none';
    for (const [name, button] of refs.stateButtons) {
      button.dataset.active = state === name ? '1' : '0';
      button.setAttribute('aria-pressed', String(state === name));
    }
    updatePopoverContextButton(refs);
    updatePopoverSourceTitle(refs);
    applySharedSaveStatus(refs);
  }

  function updatePopoverSourceTitle(refs, displaySource = '') {
    if (!refs?.source) return;
    const surface = String(displaySource || refs.displaySource || refs.word || '').trim();
    const lemma = String(refs.query?.lemma || refs.entry?.lemma || '').trim();
    refs.displaySource = surface;
    refs.source.textContent = lemma && U.normalizeTerm(surface) !== U.normalizeTerm(lemma)
      ? `${surface} (${lemma})`
      : surface;
  }

  function sameCueContext(left, right) {
    return !!left && !!right
      && String(left.videoId || '') === String(right.videoId || '')
      && Number(left.startMs ?? -1) === Number(right.startMs ?? -1)
      && String(left.sourceText || '').trim().toLocaleLowerCase('en-US') === String(right.sourceText || '').trim().toLocaleLowerCase('en-US');
  }

  function storedMeaningGroups(entry) {
    return Array.from(new Set([
      entry?.translation,
      ...(entry?.contexts || []).map((context) => context?.meaning),
    ]
      .map((meaning) => String(meaning || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean))).slice(0, 12);
  }

  function updatePopoverContextButton(refs) {
    if (!refs?.contextButton) return;
    const active = refs.entry?.state === 'saved' || refs.entry?.state === 'known';
    const context = refs.cue ? cueContext(refs.cue, refs.word, refs.query?.partOfSpeech) : null;
    const saved = !!context && (refs.entry?.contexts || []).some(item => sameCueContext(item, context));
    refs.contextButton.hidden = !active || !context;
    refs.contextButton.dataset.active = saved ? '1' : '0';
    refs.contextButton.disabled = refs.busy || saved;
    refs.contextButton.querySelector('span').textContent = saved ? 'Пример добавлен' : 'Добавить пример';
  }

  async function saveCurrentPopoverExample(refs) {
    if (!learningStore || refs.busy || !refs.cue || !refs.entry || refs.entry.state === 'none') return;
    refs.busy = true;
    updatePopoverContextButton(refs);
    try {
      const entry = await saveLearning({
        kind: 'word',
        state: refs.entry.state,
        sourceText: refs.word,
        normalizedText: refs.query.normalizedText,
        translation: refs.entry.translation || refs.canonicalPrimary || refs.primary || '',
        cue: refs.cue,
        contexts: refs.dictionaryContexts || [],
        contextMeaning: refs.contextualMeaning || '',
        toggle: false,
        identity: refs.query,
        surfaceForm: refs.word,
      });
      applyPopoverState(refs, entry);
      registerWordState(entry);
      if (currentCueIndex >= 0) applyCurrentCueLearningMarks();
      void learningStore.sync?.({}).catch(() => {});
    } catch (error) {
      log('word example save failed', { error: error?.message || String(error) });
    } finally {
      refs.busy = false;
      updatePopoverContextButton(refs);
    }
  }

  async function persistCurrentPopoverMeaning(refs) {
    if (!learningStore || refs.busy || !refs.cue || !refs.contextualMeaning || !refs.entry || refs.entry.state === 'none') return;
    const candidate = cueContext(refs.cue, refs.word, refs.query?.partOfSpeech, refs.contextualMeaning);
    if (!candidate) return;
    const existing = (refs.entry.contexts || []).find((context) => sameCueContext(context, candidate));
    if (existing?.meaning === candidate.meaning && existing?.partOfSpeech === candidate.partOfSpeech) return;
    const entry = await saveLearning({
      kind: 'word',
      state: refs.entry.state,
      sourceText: refs.word,
      normalizedText: refs.query.normalizedText,
      translation: refs.entry.translation || refs.canonicalPrimary || refs.primary || '',
      cue: refs.cue,
      contextMeaning: refs.contextualMeaning,
      toggle: false,
      identity: refs.query,
      surfaceForm: refs.word,
    });
    applyPopoverState(refs, entry);
    registerWordState(entry);
    void learningStore.sync?.({}).catch(() => {});
  }

  async function refinePopoverLexeme(refs, overrides = {}) {
    if (!refs?.popover?.isConnected) return null;
    const previous = refs.query;
    const contextualIdentity = wordIdentity(refs.word, refs.cue);
    const stableOverrides = contextualIdentity.analysisConfidence === 'high'
      && contextualIdentity.partOfSpeech !== 'unknown'
      ? {
          ...overrides,
          lemma: contextualIdentity.lemma,
          partOfSpeech: contextualIdentity.partOfSpeech,
          analysisConfidence: 'high',
        }
      : overrides;
    const next = wordIdentity(refs.word, refs.cue, stableOverrides);
    const stored = refs.entry || await learningStore?.getEntry(previous).catch(() => null);
    refs.query = next;
    updatePopoverSourceTitle(refs);
    const storedKey = stored?.key || learningStore?.entryKey?.(previous) || '';
    const nextKey = learningStore?.entryKey?.(next) || '';
    const changed = U.lexemeRefinementNeeded({ storedKey, nextKey, previous, next });
    if (!changed || !learningStore?.refineLexeme) return stored || refs.entry || null;
    const entry = await learningStore.refineLexeme({
      from: stored?.key ? { key: stored.key } : previous,
      ...next,
      surfaceForm: refs.word,
      observedForms: next.observedForms,
      contexts: refs.cue ? [cueContext(refs.cue, refs.word, refs.query?.partOfSpeech)].filter(Boolean) : [],
    }).catch((error) => {
      log('lexeme refinement failed', { error: error?.message || String(error) });
      return null;
    });
    if (entry && refs.popover.isConnected) {
      applyPopoverState(refs, entry);
      if (entry.state === 'saved' || entry.state === 'known') registerWordState(entry);
      applyCurrentCueLearningMarks();
      renderExamples(refs);
    }
    return entry;
  }

  async function saveCheckedPopoverWord(refs) {
    if (!vocabularySaves) throw new Error('Обновите страницу: модуль словаря ещё не загрузился.');
    const context = refs.cue?.origin === 'dictionary' ? { sourceText: refs.cue.text, translation: refs.cue.translation || '',
      surfaceForm: refs.word, origin: 'manual', createdAt: Date.now() }
      : refs.cue ? cueContext(refs.cue, refs.word, refs.query?.partOfSpeech) : null;
    const saved = await vocabularySaves.save({ word: refs.query.lemma || refs.word,
      observedForms: [refs.word], contexts: context ? [context] : [], source: 'youtube-word-card' });
    await learningStore.sync({ fresh: true });
    const entry = await learningStore.getEntry({ remoteId: saved.item.id,
      lemma: saved.item.lemma || saved.item.term, normalizedText: saved.item.lemma || saved.item.term });
    if (!entry) throw new Error('Сохранённая карточка не появилась в словаре. Откройте её снова.');
    applyPopoverState(refs, entry);
    if (entry.senseCatalog?.validatedAt && entry.state !== 'none') {
      try {
        const full = await bridgeJson('/learning/catalogue', { method: 'POST', body: { action: 'read', entryId: saved.item.id } });
        if (refs.popover.isConnected) applyCheckedPopoverCatalogue(refs, full.catalogue, entry.lemma || entry.sourceText);
      } catch (error) { log('saved catalogue display failed', { term: refs.word, error: error.message }); }
    }
    return entry;
  }

  async function togglePopoverState(refs, stateName) {
    if (!learningStore || refs.busy) return;
    if (joinWordStateOperation(refs)) return;
    refs.busy = true;
    let failed = false;
    resetPopoverActionStatuses(refs);
    for (const button of refs.stateButtons.values()) button.disabled = true;
    const needsCheckedCard = (stateName === 'easy' || (stateName === 'saved' && refs.entry?.state !== 'saved'))
      && !refs.entry?.senseCatalog?.validatedAt;
    const operationKey = wordStateOperationKey(refs);
    const operation = { stateName, label: needsCheckedCard ? 'Проверяю…' : 'Сохраняю…', views: new Set([refs]), error: '' };
    wordStateOperations.set(operationKey, operation);
    logLearningAction('word save started', { term: refs.word, action: stateName, operationKey });
    setPopoverActionStatus(refs, stateName, { loading: true, label: operation.label });
    try {
      if (stateName === 'easy') {
        let entry = refs.entry;
        if (!entry || entry.state !== 'saved') {
          entry = needsCheckedCard
            ? await saveCheckedPopoverWord(refs)
            : await saveLearning({
                kind: 'word',
                state: 'saved',
                sourceText: refs.word,
                normalizedText: refs.query.normalizedText,
                translation: refs.canonicalPrimary || refs.primary || refs.entry?.translation || '',
                cue: refs.cue,
                contexts: refs.dictionaryContexts || [],
                contextMeaning: refs.contextualMeaning || '',
                toggle: false,
                identity: refs.query,
                surfaceForm: refs.word,
              });
        }
        if (entry?.state !== 'saved') throw new Error('Состояние слова изменилось. Откройте карточку снова.');
        const reviewed = await learningStore.queueReview({ key: entry.key, result: 'known', mode: 'scheduled' });
        entry = reviewed?.entry || entry;
        applyPopoverState(refs, entry);
        registerWordState(entry);
        void learningStore.sync?.({}).catch(() => {});
        if (currentCueIndex >= 0) applyCurrentCueLearningMarks();
        return;
      }
      if (stateName === 'saved' && needsCheckedCard) {
        const entry = await saveCheckedPopoverWord(refs);
        applyPopoverState(refs, entry);
        registerWordState(entry);
        if (currentCueIndex >= 0) applyCurrentCueLearningMarks();
        return;
      }
      const entry = await saveLearning({
        kind: 'word',
        state: stateName,
        sourceText: refs.word,
        normalizedText: refs.query.normalizedText,
        translation: refs.canonicalPrimary || refs.primary || refs.entry?.translation || '',
        cue: refs.cue,
        contexts: refs.dictionaryContexts || [],
        contextMeaning: refs.contextualMeaning || '',
        toggle: true,
        identity: refs.query,
        surfaceForm: refs.word,
      });
      applyPopoverState(refs, entry);
      if (entry?.state === 'saved' || entry?.state === 'known') {
        registerWordState(entry);
      } else {
        unregisterWordState(entry?.key || learningStore.entryKey(refs.query));
      }
      if (currentCueIndex >= 0) applyCurrentCueLearningMarks();
    } catch (error) {
      failed = true;
      operation.error = error?.message || String(error);
      setPopoverActionStatus(refs, stateName, {
        error: true,
        label: 'Повторить',
        message: error?.message || String(error),
      });
      logLearningAction('word state save failed', { term: refs.word, action: stateName, error: operation.error });
    } finally {
      wordStateOperations.delete(operationKey);
      for (const view of operation.views) {
        view.busy = false;
        for (const button of view.stateButtons.values()) button.disabled = false;
        if (failed) setPopoverActionStatus(view, stateName, { error: true, label: 'Повторить', message: operation.error });
        else {
          applyPopoverState(view, refs.entry);
          if (view !== refs && view.popover.isConnected && refs.senseCatalog) {
            applyCheckedPopoverCatalogue(view, refs.senseCatalog, refs.query.lemma || refs.word);
          }
        }
        updatePopoverContextButton(view);
      }
      if (!failed) logLearningAction('word save completed', { term: refs.word, action: stateName, key: refs.entry?.key, state: refs.entry?.state });
    }
  }

  function createWordPopoverShell(popover, anchor, word, cueIndex, contextOverride = null) {
    const cue = contextOverride || cues[cueIndex];
    const query = wordIdentity(word, cue);
    const tail = document.createElement('div');
    tail.className = 'sc-word-anchor-tail';
    tail.setAttribute('aria-hidden', 'true');
    tail.innerHTML = '<svg viewBox="0 0 22 12" preserveAspectRatio="none"><path d="M0 0H22C17 2 16 5 14 8.5C13 10.7 12 12 11 12C10 12 9 10.7 8 8.5C6 5 5 2 0 0Z" fill="#202022" stroke="rgba(255,255,255,.14)" stroke-width="1"/></svg>';
    const panel = document.createElement('div');
    panel.className = 'sc-word-panel';
    const head = document.createElement('div');
    head.className = 'sc-word-head';
    const titles = document.createElement('div');
    titles.className = 'sc-word-title';
    const source = document.createElement('div');
    source.className = 'sc-word-source';
    source.textContent = word;
    const target = document.createElement('div');
    target.className = 'sc-word-primary sc-word-skeleton';
    target.dataset.loading = '1';
    target.setAttribute('aria-label', 'Перевод загружается');
    titles.append(source, target);
    if (wordPopoverHistory.length) head.appendChild(iconButton('left', 'К предыдущему слову', () => {
      const previous = wordPopoverHistory.pop();
      if (previous) void openWordPopover(previous.anchor, previous.word, previous.cueIndex, previous.sourceWordIndex,
        { context: previous.context, back: true });
    }));
    head.append(
      titles,
      iconButton('book', 'Открыть словарь и карточки', openStudyPage),
      iconButton('speaker', 'Произнести слово', () => speak(word)),
      iconButton('close', 'Закрыть', () => closeWordPopover({ reason: 'close-button' })),
    );
    const expressionLinks = document.createElement('div');
    expressionLinks.className = 'sc-word-expression-links';
    const actionError = document.createElement('div');
    actionError.className = 'sc-word-action-error'; actionError.setAttribute('role', 'status'); actionError.hidden = true;

    const meanings = document.createElement('div');
    meanings.className = 'sc-word-section sc-word-meanings';
    const aiExplanation = document.createElement('div');
    aiExplanation.className = 'sc-word-ai';
    aiExplanation.hidden = settings.learning_ai_explanation !== true;
    aiExplanation.dataset.state = settings.learning_ai_explanation === true ? 'loading' : 'disabled';
    const aiSkeleton = document.createElement('span');
    aiSkeleton.className = 'sc-word-skeleton sc-word-ai-skeleton';
    aiExplanation.appendChild(aiSkeleton);
    const meaningsList = document.createElement('div');
    meaningsList.className = 'sc-word-meanings-list';
    meaningsList.append(skeletonRow(), skeletonRow());
    meanings.append(aiExplanation, meaningsList);

    const examples = document.createElement('div');
    examples.className = 'sc-word-section sc-word-examples';
    const examplesTitle = document.createElement('div');
    examplesTitle.className = 'sc-word-section-title';
    examplesTitle.textContent = 'Примеры: текущее видео';
    examples.append(examplesTitle, skeletonRow(), skeletonRow(), skeletonRow());

    const footer = document.createElement('div');
    footer.className = 'sc-word-footer';
    const stateButtons = new Map();
    const addState = (stateName, icon, label) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.innerHTML = `${ICONS[icon]}<span>${label}</span>`;
      button.dataset.defaultLabel = label;
      button.dataset.active = '0';
      button.setAttribute('aria-pressed', 'false');
      installSafeClick(button, () => togglePopoverState(refs, stateName));
      stateButtons.set(stateName, button);
      footer.appendChild(button);
    };
    const refs = {
      popover,
      anchor,
      word,
      clickedNormalized: U.normalizeTerm(word),
      cueIndex,
      cue,
      contextOverride,
      query,
      tail,
      panel,
      source,
      target,
      meanings,
      meaningsList,
      choicePopup: null,
      aiExplanation,
      examples,
      footer,
      stateButtons,
      primary: '',
      canonicalPrimary: '',
      targetTerms: [],
      expressionLinks,
      actionError,
      entry: null,
      busy: false,
      dictionaryExamples: null,
      dictionaryContexts: [],
      meaningPairs: [],
      aiMeaningPairs: [],
      invalidMeaningValues: [],
      meaningPairsFinalized: false,
      dictionaryPayload: null,
      senseCatalog: null,
      catalogueError: '',
      catalogueErrorCause: null,
      cataloguePromise: null,
      preparedPreview: null,
      preparedExisting: null,
      examplesDictionary: null,
      expandedExamples: new Set(),
      checkedCatalogueApplied: false,
      contextualMeaning: '',
      contextButton: null,
    };
    addState('easy', 'known', 'Знаю');
    addState('saved', 'save', 'В словарь');
    addState('known', 'ignore', 'Не учить');
    const contextButton = document.createElement('button');
    contextButton.type = 'button';
    contextButton.className = 'sc-word-context-button';
    contextButton.innerHTML = `${ICONS.save}<span>Добавить пример</span>`;
    contextButton.hidden = true;
    installSafeClick(contextButton, () => saveCurrentPopoverExample(refs));
    refs.contextButton = contextButton;
    footer.appendChild(contextButton);
    panel.append(head, actionError, expressionLinks, meanings, examples, footer);
    popover.append(tail, panel);
    popover.__scWordRefs = refs;
    return refs;
  }

  function catalogueGroupLabel(group) {
    return String(group?.shortMeaning || group?.preferredTranslation || group?.meaning || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  let showSupportMeanings = true;
  async function refreshStudyPreferences() {
    try {
      const state = await learningStore.getStudyState({}), next = state.preferences.showSupport !== false;
      const changed = next !== showSupportMeanings; showSupportMeanings = next;
      const refs = document.getElementById(WORD_POPOVER_ID)?.__scWordRefs;
      if (changed && refs?.senseCatalog) { renderCatalogueMeaningSummary(refs, refs.senseCatalog); renderExamples(refs); }
    } catch {}
  }

  function catalogueVisibleGroups(catalogue) {
    return [
      ...(catalogue?.groups || []).map(group => ({ ...group, support: false })),
      ...(catalogue?.supportGroups || []).map(group => ({ ...group, support: true })),
    ];
  }

  function renderCatalogueMeaningSummary(refs, catalogue) {
    const core = (catalogue?.groups || []).map(catalogueGroupLabel).filter(Boolean);
    const support = (showSupportMeanings ? catalogue?.supportGroups || [] : []).map(catalogueGroupLabel).filter(Boolean);
    if (!core.length) return false;
    refs.target.classList.remove('sc-word-skeleton', 'sc-word-error');
    refs.target.dataset.loading = '0';
    refs.target.removeAttribute('aria-label');
    refs.target.replaceChildren();
    const append = (values, groups, className = '') => values.forEach((value, index) => {
      if (index) refs.target.appendChild(document.createTextNode(' / '));
      const span = document.createElement('button');
      span.type = 'button';
      span.className = 'sc-word-meaning-trigger ' + className;
      span.textContent = value;
      installSafeClick(span, () => showEnglishChoices(refs, groups[index], false, false, span));
      refs.target.appendChild(span);
    });
    append(core, catalogue.groups || []);
    if (support.length) {
      const divider = document.createElement('span');
      divider.className = 'sc-word-meaning-divider';
      divider.textContent = '│';
      refs.target.appendChild(divider);
      append(support, catalogue.supportGroups || [], 'sc-word-support-meaning');
    }
    refs.targetTerms = [...core, ...support];
    refs.meaningsList.replaceChildren();
    refs.meanings.dataset.long = core.length + support.length > 5 || [...core, ...support].join(' / ').length > 82 ? '1' : '0';
    return true;
  }

  function renderDictionaryContent(refs, payload) {
    if (!refs?.popover?.isConnected) return;
    refs.dictionaryPayload = payload;
    refs.primary = primaryDictionaryTranslation(payload);
    updatePopoverSourceTitle(refs, payload?.dictionary?.displaySource || refs.word);
    const alternatives = payload?.dictionary?.translations || [];
    const catalogueRendered = renderCatalogueMeaningSummary(refs, refs.senseCatalog);
    if (!catalogueRendered) {
      refs.target.classList.remove('sc-word-skeleton');
      refs.target.dataset.loading = '0';
      refs.target.removeAttribute('aria-label');
      refs.target.replaceChildren();
      const quickMeanings = refs.aiMeaningPairs?.length ? refs.aiMeaningPairs : U.dictionaryMeaningPairs(payload?.dictionary);
      if (quickMeanings.length) quickMeanings.forEach((group, index) => {
        if (index) refs.target.appendChild(document.createTextNode(' / '));
        const button = document.createElement('button'); button.type = 'button'; button.className = 'sc-word-meaning-trigger';
        button.textContent = group.label || group.targets.join(', ');
        installSafeClick(button, () => showEnglishChoices(refs, { meaning: button.textContent,
          partOfSpeech: group.partOfSpeech || group.posTag || group.pos || '' }, true, false, button));
        refs.target.appendChild(button);
      });
      else refs.target.textContent = refs.primary || 'Перевод не найден';
      refs.targetTerms = [refs.primary, ...alternatives.map(item => item.displayTarget || item.normalizedTarget || '')]
        .filter(Boolean);
      refs.meaningsList.replaceChildren();
      if (!alternatives.length) {
        const value = document.createElement('div');
        value.className = 'sc-word-meaning';
        value.textContent = refs.primary || 'Дополнительных значений нет.';
        refs.meaningsList.appendChild(value);
      }
    }
    const meaningGroups = refs.meaningPairsFinalized ? refs.aiMeaningPairs
      : refs.aiMeaningPairs?.length ? refs.aiMeaningPairs : U.dictionaryMeaningPairs(payload?.dictionary);
    if (!catalogueRendered) {
      const meaningTextLength = meaningGroups.flatMap(group => group.targets).join(' / ').length;
      refs.meanings.dataset.long = meaningGroups.length > 5 || meaningTextLength > 82 ? '1' : '0';
    }
    renderExamples(refs);
    if (currentCueIndex === refs.cueIndex) renderTranslationForCue(currentCueIndex);
    positionPopover(refs.popover, refs.anchor);
  }

  function expressionChoiceInput(analysis, meaning) {
    return { word: analysis.canonicalText || analysis.selection.text, meaning, partOfSpeech: '',
      context: expressionContextForSelection(analysis.selection), contextTranslation: expressionContextTranslation(analysis.selection) };
  }

  async function showExpressionEnglishChoices(analysis, meaning, anchor, retry = false) {
    if (phraseAnalysis !== analysis || !phraseSelectionOpen || !phraseHint?.isConnected) return;
    const input = expressionChoiceInput(analysis, meaning), key = JSON.stringify(input);
    if (!retry && analysis.choiceKey === key && analysis.choicePopup?.element.isConnected) { analysis.choicePopup.close(); return; }
    analysis.choicePopup?.close();
    const generation = analysis.choiceGeneration = (analysis.choiceGeneration || 0) + 1;
    analysis.choiceKey = key;
    const popup = analysis.choicePopup = window.__scLearningChoicesPopover.create({
      owner: phraseHint, anchor: () => anchor.isConnected ? anchor : phraseHint.querySelector('.sc-expression-translation') || phraseHint,
      model: { title: meaning, phase: 'loading' },
      onClose: () => { analysis.choiceKey = ''; analysis.choiceGeneration++; },
      onRetry: () => void showExpressionEnglishChoices(analysis, meaning, anchor, true),
      isSaved: term => ['saved', 'known'].includes(learningStateForWord(term, null).state?.state),
      onChoice: (choice, node) => void openWordPopover(node, choice.term, -1, -1, { nested: true }),
    });
    try {
      const value = await bridgeJson('/learning/catalogue', { method: 'POST', body: { ...input, action: 'alternatives' } });
      if (phraseAnalysis !== analysis || analysis.choiceGeneration !== generation || analysis.choiceKey !== key) return;
      popup.update({ model: { title: meaning, phase: 'ready', ...value } });
    } catch (error) {
      if (analysis.choiceGeneration === generation && analysis.choiceKey === key) popup.update({ model: { title: meaning, phase: 'error', error: error.message } });
    }
  }

  async function showEnglishChoices(refs, sense, quick = false, retry = false, anchor = null) {
    const meaning = sense.meaning || sense.shortMeaning || '';
    const observed = refs.contextOverride ? { sourceText: refs.contextOverride.text, translation: refs.contextOverride.translation }
      : refs.cue ? cueContext(refs.cue, refs.word) : null;
    const input = { word: refs.query?.lemma || refs.word, meaning, partOfSpeech: sense.partOfSpeech || '',
      context: observed?.sourceText || '', contextTranslation: observed?.translation || '' };
    const key = JSON.stringify(input);
    if (!meaning || !refs.popover.isConnected) return;
    if (!retry && refs.choiceKey === key && refs.choicePopup?.element.isConnected) { refs.choicePopup.close(); return; }
    refs.choicePopup?.close();
    const generation = refs.choiceGeneration = (refs.choiceGeneration || 0) + 1;
    refs.choiceKey = key;
    const title = sense.shortMeaning || meaning;
    const popup = refs.choicePopup = window.__scLearningChoicesPopover.create({
      owner: refs.popover, anchor: () => anchor?.isConnected ? anchor : refs.target,
      model: { title, phase: 'loading' },
      onClose: () => { refs.choiceKey = ''; refs.choiceGeneration++; },
      onRetry: () => void showEnglishChoices(refs, sense, quick, true, anchor),
      isSaved: term => ['saved', 'known'].includes(learningStateForWord(term, refs.cue).state?.state),
      onChoice: (choice, node) => void openWordPopover(node, choice.term, -1, -1, { nested: true }),
    });
    try {
      const result = quick ? await bridgeJson('/learning/catalogue', { method: 'POST', body: { ...input, action: 'alternatives' } })
        : { headwordChoice: sense.headwordChoice || (sense.activeEquivalent ? { term: sense.focusEn || refs.word, nuance: '' } : null),
          englishAlternatives: sense.englishAlternatives || (sense.activeEquivalent ? [{ term: sense.activeEquivalent.en, nuance: sense.activeEquivalent.ru }] : []) };
      if (!refs.popover.isConnected || refs.choiceKey !== key || refs.choiceGeneration !== generation) return;
      popup.update({ model: { title, phase: 'ready', ...result,
        russianAlternatives: !quick && sense.alternatives?.length ? sense.alternatives.join(', ') : '' } });
    } catch (error) {
      if (!refs.popover.isConnected || refs.choiceKey !== key || refs.choiceGeneration !== generation) return;
      popup.update({ model: { title, phase: 'error', error: error.message || 'Не удалось получить варианты.' } });
    }
  }

  function renderAiExplanation(refs, text, { error = false } = {}) {
    if (!refs?.aiExplanation?.isConnected) return;
    refs.aiExplanation.replaceChildren();
    refs.aiExplanation.dataset.state = error ? 'error' : 'ready';
    const label = document.createElement('span');
    label.className = 'sc-word-ai-label';
    label.textContent = error ? 'AI:' : `Контекст ${refs.word}:`;
    const value = document.createElement('span');
    value.textContent = text;
    refs.aiExplanation.append(label, value);
    positionPopover(refs.popover, refs.anchor);
  }

  function meaningPairsFromAi(dictionary, groups) {
    const translations = Array.isArray(dictionary?.translations) ? dictionary.translations : [];
    const byValue = new Map(translations.map((item) => [
      String(item?.normalizedTarget || item?.displayTarget || '').trim().toLocaleLowerCase('ru-RU'),
      item,
    ]));
    return (Array.isArray(groups) ? groups : []).map((group) => {
      const targets = Array.from(new Set((Array.isArray(group?.values) ? group.values : [])
        .map((value) => String(value || '').trim())
        .filter((value) => byValue.has(value.toLocaleLowerCase('ru-RU')))));
      if (!targets.length) return null;
      const first = byValue.get(targets[0].toLocaleLowerCase('ru-RU'));
      return {
        text: dictionary?.normalizedSource || dictionary?.displaySource || '',
        label: String(group?.label || '').trim() || targets.join(' / '),
        translation: first?.normalizedTarget || targets[0],
        targets,
        pos: String(group?.partOfSpeech || first?.posTag || '').toUpperCase(),
        example: String(group?.example || '').trim(),
        exampleTranslation: String(group?.exampleTranslation || '').trim(),
      };
    }).filter(Boolean);
  }

  async function requestAiExplanation(refs, dictionary = null) {
    if (!settings.learning_ai_explanation || !refs?.cue) return null;
    try {
      if (!refs.entry) {
        const stored = await learningStore?.getEntry(refs.query).catch(() => null);
        if (stored && refs.popover.isConnected) applyPopoverState(refs, stored);
      }
      const knownMeanings = storedMeaningGroups(refs.entry);
      const dictionaryTranslations = (dictionary?.translations || []).slice(0, 20).map((item) => ({
        value: item?.normalizedTarget || item?.displayTarget || '',
        partOfSpeech: Lexeme?.normalizePartOfSpeech?.(item?.posTag) || String(item?.posTag || '').toLocaleLowerCase('en-US'),
      })).filter((item) => item.value);
      const payload = await bridgeJson('/learning/catalogue', {
        method: 'POST',
        body: {
          word: refs.word,
          action: 'explain',
          contextOnly: true,
          wordTranslation: refs.primary || '',
          context: refs.cue.text,
          contextTranslation: refs.cue.translation || translationsByText.get(refs.cue.text) || '',
          sourceLang: sourceLanguage(),
          targetLang: settings.learning_target_lang,
          knownMeanings,
          dictionaryTranslations,
        },
      });
      if (!refs.popover.isConnected) return;
      if (!payload?.explanation) throw new Error(payload?.error || 'AI-пояснение недоступно');
      const currentMeanings = Array.isArray(payload.currentMeanings) ? payload.currentMeanings.filter(Boolean) : [];
      refs.contextualMeaning = payload.expressionText
        ? ''
        : String(payload.matchedMeaning || currentMeanings.join(' / ')).trim();
      refs.aiMeaningPairs = meaningPairsFromAi(dictionary, payload.meaningGroups);
      refs.invalidMeaningValues = Array.isArray(payload.invalidValues) ? payload.invalidValues : [];
      if (refs.dictionaryPayload && refs.aiMeaningPairs.length) renderDictionaryContent(refs, refs.dictionaryPayload);
      if (payload?.analysisConfidence === 'high' && payload?.lemma && payload?.partOfSpeech !== 'unknown') {
        await refinePopoverLexeme(refs, {
          lemma: payload.lemma,
          partOfSpeech: payload.partOfSpeech,
          analysisConfidence: payload.analysisConfidence,
        });
      }
      await persistCurrentPopoverMeaning(refs).catch((error) => {
        log('context meaning save failed', { error: error?.message || String(error) });
      });
      renderAiExplanation(refs, payload.explanation);
      return payload;
    } catch (error) {
      if (!refs.popover.isConnected) return;
      log('word AI explanation failed', { error: error?.message || String(error) });
      renderAiExplanation(refs, 'Пояснение сейчас недоступно.', { error: true });
      return null;
    }
  }

  function appendTermExample(container, prefix, term, suffix) {
    container.appendChild(document.createTextNode(String(prefix || '')));
    const mark = document.createElement('mark');
    mark.textContent = String(term || '');
    container.appendChild(mark);
    container.appendChild(document.createTextNode(String(suffix || '')));
  }

  function appendInteractiveExample(container, text, focusTerms, contextTranslation, refs, sourceCue = null) {
    const cue = sourceCue ? { ...sourceCue, text, translation: contextTranslation || '', origin: 'video' }
      : { text, translation: contextTranslation || '', origin: 'dictionary', startMs: -1 };
    const ranges = U.exactTermRanges(text, focusTerms.filter(Boolean), sourceLanguage());
    const buttons = [];
    const gesture = window.__scCreateWordGesture?.({ getText: () => text,
      onRange: range => { for (const { element, start, end } of buttons) element.dataset.phraseSelected = range && start < range.end && end > range.start ? '1' : '0'; },
      onSelect: selected => { if (refs.popover.isConnected) void openWordPopover(selected.anchor, selected.word, -1, -1, { nested: true, context: cue }); },
    });
    let offset = 0, wordIndex = 0;
    for (const part of U.segmentWords(text, sourceLanguage())) {
      const start = offset, end = start + part.text.length; offset = end;
      if (!part.word) { container.appendChild(document.createTextNode(part.text)); continue; }
      const element = document.createElement('button'); element.type = 'button';
      element.className = 'sc-word-example-token'; element.textContent = part.text;
      element.dataset.wordIndex = String(wordIndex++);
      element.dataset.focus = ranges.some(range => start < range.end && end > range.start) ? '1' : '0';
      element.__scExampleCue = cue; applyLearningStateToWord(element, cue);
      const selection = () => ({ ...part, start, end, anchor: fixedAnchorReference(element) });
      element.addEventListener('click', event => { event.stopPropagation(); event.preventDefault();
        if (gesture) gesture.click(selection(), event); else void openWordPopover(element, part.text, -1, -1, { nested: true, context: cue }); });
      element.addEventListener('dblclick', event => { event.stopPropagation(); event.preventDefault(); gesture?.doubleClick(selection()); });
      element.addEventListener('pointerenter', () => gesture?.hover({ start, end }));
      element.addEventListener('keydown', event => { event.stopPropagation(); if (event.key === 'Escape') gesture?.reset(); });
      buttons.push({ element, start, end }); container.appendChild(element);
    }
  }

  function exampleToggle(body, expanded, callback) {
    body.setAttribute('role', 'button'); body.tabIndex = 0;
    body.setAttribute('aria-expanded', String(expanded));
    installSafeClick(body, callback);
    body.addEventListener('keydown', event => {
      if (event.target !== body || !['Enter', ' '].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation(); callback();
    });
  }

  function exampleSourceRow(text, expanded) {
    const row = document.createElement('div'); row.className = 'sc-word-example-source';
    const chevron = document.createElement('span'); chevron.className = 'sc-word-chevron';
    chevron.setAttribute('aria-hidden', 'true'); chevron.textContent = expanded ? '⌄' : '›';
    row.append(chevron, text); return row;
  }

  function normalizedDictionaryExampleRows(payload, pairs) {
    return U.dictionaryExampleRows(payload, pairs, sourceLanguage(), settings.learning_target_lang)
      .map((row) => ({
        ...row,
        partOfSpeech: Lexeme?.normalizePartOfSpeech?.(row.partOfSpeech)
          || String(row.partOfSpeech || '').toLocaleLowerCase('en-US'),
      }));
  }

  function dictionaryRowsToContexts(rows) {
    const timestamp = Date.now();
    return (rows || []).map((row, index) => ({
      videoId: '',
      videoUrl: '',
      videoTitle: 'Словарный пример',
      startMs: -1,
      endMs: null,
      sourceText: row.sourceText,
      surfaceForm: U.normalizeTerm(row.sourceTerm),
      translation: row.targetText,
      meaning: row.label || (row.meanings || []).filter(Boolean).join(' / ') || row.meaning || row.targetTerm,
      origin: 'dictionary',
      partOfSpeech: row.partOfSpeech || 'unknown',
      createdAt: timestamp - index,
    }));
  }

  function appendVideoExampleRow(container, refs, example, forms) {
    const row = document.createElement('div');
    row.className = 'sc-word-example';
    const key = `video:${example.cueIndex}:${example.text}`;
    const expanded = refs.expandedExamples.has(key);
    const body = document.createElement('div');
    body.className = 'sc-word-example-toggle';
    body.setAttribute('aria-expanded', String(expanded));
    const text = document.createElement('div');
    text.className = 'sc-word-example-text';
    appendInteractiveExample(text, example.text, forms, translationsByText.get(example.text), refs, cues[example.cueIndex]);
    body.appendChild(exampleSourceRow(text, expanded));
    if (expanded) {
      const translatedNode = document.createElement('div');
      translatedNode.className = 'sc-word-example-translation';
      renderExampleTranslation(translatedNode, example, refs, forms);
      body.appendChild(translatedNode);
    }
    exampleToggle(body, expanded, () => {
      if (refs.expandedExamples.has(key)) refs.expandedExamples.delete(key);
      else refs.expandedExamples.add(key);
      renderExamples(refs);
    });
    row.appendChild(body);
    const actions = document.createElement('div');
    actions.className = 'sc-example-actions';
    const savePhrase = iconButton('save', 'Сохранить фразу', async () => {
      try {
        await saveLearning({
          kind: 'phrase', state: 'saved', sourceText: example.text,
          normalizedText: U.normalizeTerm(example.text),
          translation: translationsByText.get(example.text) || '', cue: example,
          toggle: false,
        });
        savePhrase.dataset.active = '1';
      } catch (error) {
        log('phrase save failed', { error: error?.message || String(error) });
      }
    });
    learningStore?.getEntry({
      kind: 'phrase', sourceLang: sourceLanguage(), targetLang: settings.learning_target_lang,
      sourceText: example.text, normalizedText: U.normalizeTerm(example.text),
    }).then((entry) => { if (savePhrase.isConnected && entry?.state === 'saved') savePhrase.dataset.active = '1'; }).catch(() => {});
    const more = iconButton('more', 'Ещё', () => { menu.hidden = !menu.hidden; });
    const menu = document.createElement('div');
    menu.className = 'sc-example-menu';
    menu.hidden = true;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Копировать';
    installSafeClick(copy, () => copyText(example.text));
    const save = document.createElement('button');
    save.type = 'button';
    save.textContent = 'Сохранить фразу';
    installSafeClick(save, async () => {
      await saveLearning({
        kind: 'phrase', state: 'saved', sourceText: example.text,
        normalizedText: U.normalizeTerm(example.text),
        translation: translationsByText.get(example.text) || '', cue: example,
        toggle: false,
      });
      menu.hidden = true;
      savePhrase.dataset.active = '1';
    });
    menu.append(copy, save);
    actions.append(savePhrase, more, menu);
    row.appendChild(actions);
    const play = iconButton('play', 'Проиграть реплику', () => seekCue(example.cueIndex));
    play.classList.add('sc-word-example-play');
    row.appendChild(play);
    container.appendChild(row);
  }

  function renderExamples(refs) {
    if (!refs?.popover?.isConnected) return;
    const videoWasOpen = refs.examples.querySelector('.sc-word-video-examples')?.open === true;
    const title = document.createElement('div');
    title.className = 'sc-word-section-title';
    title.textContent = 'Примеры значений';
    refs.examples.replaceChildren(title);
    if (refs.dictionaryExamples === null) {
      refs.examples.append(skeletonRow(), skeletonRow());
    } else if (!refs.dictionaryExamples.length) {
      const empty = document.createElement('div');
      empty.style.color = '#71717a';
      empty.textContent = refs.catalogueError || 'Словарных примеров для этого значения нет.';
      refs.examples.appendChild(empty);
    } else {
      refs.dictionaryExamples.filter(example => showSupportMeanings || !example.support).forEach((example, index) => {
        const row = document.createElement('div');
        row.className = `sc-word-example${example.support ? ' support' : ''}`;
        const exampleIdentity = example.groupId || (Number.isInteger(example.pairIndex) ? example.pairIndex : index);
        const key = `dictionary:${exampleIdentity}:${example.sourceText}`;
        const expanded = refs.expandedExamples.has(key);
        const body = document.createElement('div');
        body.className = 'sc-word-example-toggle';
        body.setAttribute('aria-expanded', String(expanded));
        const meaning = document.createElement('div');
        meaning.className = 'sc-word-example-meaning';
        meaning.textContent = example.label || (example.meanings || []).filter(Boolean).join(' / ') || example.meaning || '';
        const source = document.createElement('div');
        source.className = 'sc-word-example-text';
        appendInteractiveExample(source, example.sourceText, [example.sourceTerm], example.targetText, refs);
        if (meaning.textContent) body.appendChild(meaning);
        body.appendChild(exampleSourceRow(source, expanded));
        if (expanded) {
          const target = document.createElement('div');
          target.className = 'sc-word-example-translation';
          appendTermExample(target, example.targetPrefix, example.targetTerm, example.targetSuffix);
          body.appendChild(target);
        }
        exampleToggle(body, expanded, () => {
          if (refs.expandedExamples.has(key)) refs.expandedExamples.delete(key);
          else refs.expandedExamples.add(key);
          renderExamples(refs);
        });
        const play = iconButton('play', 'Произнести пример', () => speak(example.sourceText));
        play.classList.add('sc-word-example-play');
        row.append(body, play);
        refs.examples.appendChild(row);
      });
    }

    const forms = Array.from(new Set([
      refs.clickedNormalized,
      ...(refs.entry?.observedForms || []),
      ...(Lexeme?.formsForLexeme?.(refs.query) || []),
    ].filter(Boolean)));
    const videoExamples = U.examplesForTerm(cues, forms, refs.cueIndex, 6, sourceLanguage());
    if (videoExamples.length) {
      const details = document.createElement('details');
      details.className = 'sc-word-video-examples';
      details.open = videoWasOpen;
      const summary = document.createElement('summary');
      summary.textContent = `Из текущего видео · ${videoExamples.length}`;
      details.appendChild(summary);
      for (const example of videoExamples) appendVideoExampleRow(details, refs, example, forms);
      refs.examples.appendChild(details);
    }
    positionPopover(refs.popover, refs.anchor);
  }

  async function persistDictionaryContexts(refs) {
    if (!learningStore || !refs?.entry || refs.entry.state === 'none' || !refs.dictionaryContexts?.length) return;
    const missing = refs.dictionaryContexts.filter(context => !(refs.entry.contexts || []).some(item => sameCueContext(item, context)));
    if (!missing.length) return;
    const entry = await saveLearning({
      kind: 'word',
      state: refs.entry.state,
      sourceText: refs.word,
      normalizedText: refs.query.normalizedText,
      translation: refs.entry.translation || refs.canonicalPrimary || refs.primary || '',
      contexts: missing,
      toggle: false,
      identity: refs.query,
      surfaceForm: refs.word,
    });
    applyPopoverState(refs, entry);
    registerWordState(entry);
    void learningStore.sync?.({}).catch(() => {});
  }

  function applyCheckedPopoverCatalogue(refs, catalogue, word) {
    if (!catalogue?.validatedAt || !catalogue.groups?.length) {
      throw new Error('Проверенные примеры ещё не готовы');
    }
    refs.senseCatalog = catalogue;
    refs.checkedCatalogueApplied = true;
    const visibleGroups = catalogueVisibleGroups(catalogue);
    refs.aiMeaningPairs = visibleGroups.map(group => ({
      text: refs.query.lemma || word,
      label: catalogueGroupLabel(group),
      targets: [group.shortMeaning, group.meaning, ...(group.alternatives || [])].filter(Boolean),
      translation: group.shortMeaning || group.meaning,
      pos: String(group.partOfSpeech || 'unknown').toUpperCase(),
      example: group.example,
      exampleTranslation: group.exampleTranslation,
      support: group.support,
      groupId: group.id,
    }));
    refs.meaningPairs = refs.aiMeaningPairs;
    refs.meaningPairsFinalized = true;
    refs.dictionaryExamples = normalizedDictionaryExampleRows(
      { examples: visibleGroups.map(() => ({ examples: [] })) }, refs.aiMeaningPairs,
    ).map(row => ({
      ...row,
      support: refs.aiMeaningPairs[row.pairIndex]?.support === true,
      groupId: refs.aiMeaningPairs[row.pairIndex]?.groupId || '',
    }));
    if (refs.dictionaryExamples.length !== visibleGroups.length) {
      throw new Error('Не все проверенные примеры удалось отобразить');
    }
    refs.dictionaryContexts = visibleGroups.map((group, index) => ({
      videoId: '', videoUrl: '', videoTitle: 'Словарный пример', startMs: -1,
      sourceText: group.example, translation: group.exampleTranslation, surfaceForm: refs.query.lemma || word,
      meaning: group.meaning, senseId: group.id, partOfSpeech: group.partOfSpeech,
      origin: 'dictionary', createdAt: catalogue.validatedAt - index,
    }));
    refs.catalogueError = '';
    refs.catalogueErrorCause = null;
    if (refs.dictionaryPayload) renderDictionaryContent(refs, refs.dictionaryPayload);
    else renderExamples(refs);
    return catalogue;
  }

  async function requestDictionaryExamples(refs, dictionary, preferredPairs = []) {
    if (!refs?.popover?.isConnected) return;
    const checkedLanguage = sourceLanguage().toLowerCase().startsWith('en')
      && settings.learning_target_lang === 'ru';
    const hasCheckedStoredCatalogue = checkedLanguage
      && refs.entry?.state !== 'none'
      && refs.entry?.senseCatalog?.validatedAt;
    if (hasCheckedStoredCatalogue) {
      try {
        const word = refs.query.lemma || refs.clickedNormalized;
        const response = refs.entry.senseCatalog?.groups?.length
          ? { catalogue: refs.entry.senseCatalog }
          : await bridgeJson('/learning/catalogue', {
              method: 'POST', body: { action: 'read', entryId: refs.entry.remoteId },
            });
        if (!refs.popover.isConnected) return;
        return applyCheckedPopoverCatalogue(refs, response.catalogue, word);
      } catch (error) {
        if (!refs.popover.isConnected) return;
        refs.catalogueError = 'Проверка словарных примеров не завершена. Откройте слово ещё раз, чтобы повторить.';
        refs.catalogueErrorCause = error;
        refs.dictionaryExamples = [];
        renderExamples(refs);
        log('verified catalogue failed', { error: error?.message || String(error) });
        return null;
      }
    }
    if (refs.checkedCatalogueApplied) return refs.senseCatalog;
    const pairs = U.mergeDictionaryMeaningPairs(dictionary, preferredPairs, refs.invalidMeaningValues).slice(0, 5);
    refs.meaningPairs = pairs;
    refs.dictionaryExamples = null;
    renderExamples(refs);
    if (!pairs.length) {
      refs.dictionaryExamples = [];
      renderExamples(refs);
      return;
    }
    try {
      const rows = [];
      const usedSourceSentences = new Set();
      for (let offset = 0; offset < pairs.length; offset += 10) {
        const batch = pairs.slice(offset, offset + 10);
        let payload = null;
        try {
          payload = await bridgeJson('/translator/examples', {
            method: 'POST',
            body: { pairs: batch, from: sourceLanguage(), to: settings.learning_target_lang },
          });
        } catch (error) {
          log('dictionary example batch failed', { offset, count: batch.length, error: error?.message || String(error) });
        }
        if (!refs.popover.isConnected) return;
        if (refs.checkedCatalogueApplied) return refs.senseCatalog;
        const fallbackPayload = payload || { examples: batch.map(() => ({ examples: [] })) };
        rows.push(...U.dictionaryExampleRows(
          fallbackPayload,
          batch,
          sourceLanguage(),
          settings.learning_target_lang,
          usedSourceSentences,
        ).map((row) => ({
          ...row,
          partOfSpeech: Lexeme?.normalizePartOfSpeech?.(row.partOfSpeech)
            || String(row.partOfSpeech || '').toLocaleLowerCase('en-US'),
          pairIndex: row.pairIndex + offset,
        })));
      }
      refs.dictionaryExamples = rows.sort((left, right) => left.pairIndex - right.pairIndex);
      const validPairIndexes = new Set(refs.dictionaryExamples.map((row) => row.pairIndex));
      refs.aiMeaningPairs = pairs.filter((pair, index) => validPairIndexes.has(index));
      refs.meaningPairsFinalized = true;
      refs.dictionaryContexts = dictionaryRowsToContexts(refs.dictionaryExamples);
      if (refs.dictionaryPayload) renderDictionaryContent(refs, refs.dictionaryPayload);
      else renderExamples(refs);
      await persistDictionaryContexts(refs);
    } catch (error) {
      if (!refs.popover.isConnected) return;
      if (refs.checkedCatalogueApplied) return refs.senseCatalog;
      refs.dictionaryExamples = normalizedDictionaryExampleRows(
        { examples: pairs.map(() => ({ examples: [] })) },
        pairs,
      );
      const validPairIndexes = new Set(refs.dictionaryExamples.map((row) => row.pairIndex));
      refs.aiMeaningPairs = pairs.filter((pair, index) => validPairIndexes.has(index));
      refs.meaningPairsFinalized = true;
      renderExamples(refs);
      log('dictionary examples failed', { error: error?.message || String(error) });
    }
  }

  function refreshOpenPopoverExamples() {
    const refs = document.getElementById(WORD_POPOVER_ID)?.__scWordRefs;
    if (refs) renderExamples(refs);
  }

  async function openWordPopover(anchor, word, cueIndex, sourceWordIndex = -1, options = {}) {
    clearRussianSelection({ resume: false });
    hideQuickWordPopover();
    // Capture geometry before closing the previous card: closeWordPopover()
    // rerenders the subtitle and disconnects the clicked span.
    const positionAnchor = fixedAnchorReference(anchor);
    const previous = document.getElementById(WORD_POPOVER_ID)?.__scWordRefs;
    if (options.nested && previous) wordPopoverHistory.push({ anchor: fixedAnchorReference(previous.anchor), word: previous.word,
      cueIndex: previous.cueIndex, sourceWordIndex: previous.sourceWordIndex, context: previous.contextOverride });
    closeWordPopover({ resume: false, preserveHistory: options.nested || options.back, reason: 'replace' });
    wordPopoverOpen = true;
    const video = playerVideo();
    if (video && !video.paused) {
      video.pause();
      pausedForSubtitleHover = true;
      hoverPausedCueKey = `${videoMeta.videoId}:${cues[cueIndex]?.startMs ?? cueIndex}`;
    }
    updateHoverHoldState();
    const popover = document.createElement('div');
    popover.id = WORD_POPOVER_ID;
    popover.addEventListener('pointerdown', event => event.stopPropagation());
    popover.addEventListener('selectstart', event => event.preventDefault());
    popover.addEventListener('dragstart', event => event.preventDefault());
    popover.addEventListener('wheel', event => event.stopPropagation(), { passive: true });
    const refs = createWordPopoverShell(popover, positionAnchor, word, cueIndex, options.context);
    refs.sourceWordIndex = sourceWordIndex;
    if (refs.cue && sourceWordIndex >= 0) refs.cue = { ...refs.cue, contextWordIndex: sourceWordIndex };
    refs.openedScrollX = scrollX;
    refs.openedScrollY = scrollY;
    document.body.appendChild(popover);
    joinWordStateOperation(refs);
    logLearningAction('word opened', { term: word, cueIndex, sourceWordIndex,
      trigger: options.trigger || (options.back ? 'back' : options.nested ? 'nested-click' : 'source-click'),
      origin: options.context?.origin || 'subtitle', contextChars: refs.cue?.text?.length || 0, pending: refs.busy });
    applyActiveSourceWordMark();
    renderWordExpressionLinks(refs);
    positionPopover(popover, positionAnchor);
    if (currentCueIndex === cueIndex) renderTranslationForCue(cueIndex);
    ensureCueTranslation(cueIndex);
    void publishWordSelection(word, cueIndex);
    if (typeof ResizeObserver === 'function') {
      popoverResizeObserver = new ResizeObserver(() => {
        requestAnimationFrame(() => positionPopover(popover, positionAnchor));
      });
      popoverResizeObserver.observe(popover);
    }

    requestAnimationFrame(() => renderExamples(refs));
    learningStore?.getEntry(refs.query).then((entry) => {
      if (!popover.isConnected) return;
      applyPopoverState(refs, entry);
      if (entry?.state === 'saved' || entry?.state === 'known') {
        registerWordState(entry);
        applyCurrentCueLearningMarks();
      }
      if (entry?.translation) {
        refs.primary = entry.translation;
        refs.target.classList.remove('sc-word-skeleton');
        refs.target.dataset.loading = '0';
        refs.target.textContent = entry.translation;
      }
    }).catch(() => {});

    try {
      const dictionary = await bridgeJson('/translator/dictionary', {
        method: 'POST',
        body: { text: word, from: sourceLanguage(), to: settings.learning_target_lang },
      });
      if (!popover.isConnected) { logLearningAction('word late lookup ignored', { term: word, cueIndex }); return; }
      renderDictionaryContent(refs, dictionary);
      let examplesDictionary = dictionary?.dictionary || null;
      refs.examplesDictionary = examplesDictionary;
      if (refs.query.kind !== 'phrase') await refinePopoverLexeme(refs, {
        posCandidates: (dictionary?.dictionary?.translations || []).map((item) => item.posTag).filter(Boolean),
      });
      if (refs.query.lemma && refs.query.lemma !== refs.clickedNormalized) {
        const lemmaDictionary = await bridgeJson('/translator/dictionary', {
          method: 'POST',
          body: { text: refs.query.lemma, from: sourceLanguage(), to: settings.learning_target_lang },
        }).catch(() => null);
        refs.canonicalPrimary = primaryDictionaryTranslation(lemmaDictionary);
        if (lemmaDictionary?.dictionary?.translations?.length) {
          examplesDictionary = lemmaDictionary.dictionary;
          refs.examplesDictionary = examplesDictionary;
        }
      }
      const stored = await learningStore?.getEntry(refs.query).catch(() => null);
      if (stored) applyPopoverState(refs, stored);
      const storedTranslation = refs.canonicalPrimary || refs.primary;
      if (stored && stored.state !== 'none' && storedTranslation && storedTranslation !== stored.translation) {
        const updated = await learningStore.saveMachineTranslation({
          ...refs.query,
          state: stored.state,
          translation: storedTranslation,
          contexts: refs.cue ? [cueContext(refs.cue, refs.word, refs.query?.partOfSpeech)].filter(Boolean) : [],
        }).catch(() => null);
        if (updated) applyPopoverState(refs, updated);
      }
      // Fast dictionary examples must not wait for the optional contextual AI
      // explanation. The checked Gemini catalogue starts only after Save.
      const examplesRequest = requestDictionaryExamples(refs, examplesDictionary, []);
      await requestAiExplanation(refs, examplesDictionary);
      void examplesRequest;
    } catch (error) {
      if (!popover.isConnected) return;
      void requestAiExplanation(refs, null);
      refs.dictionaryExamples = [];
      renderExamples(refs);
      refs.target.classList.remove('sc-word-skeleton');
      refs.target.dataset.loading = '0';
      refs.target.classList.add('sc-word-error');
      refs.target.textContent = 'Перевод недоступен';
      const message = document.createElement('div');
      message.className = 'sc-word-error';
      message.textContent = error?.message || String(error);
      refs.meaningsList.replaceChildren(message);
      positionPopover(popover, positionAnchor);
    }
  }

  function resetForNavigation() {
    hideQuickWordPopover();
    const nextVideoId = extractVideoIdFromLocation();
    if (nextVideoId && nextVideoId === videoMeta.videoId) {
      updateGeometry();
      return;
    }
    loadGeneration += 1;
    prefetchGeneration += 1;
    prefetchRerunRequested = false;
    lastTrackIdentity = '';
    lastSnapshotAt = 0;
    sourceCues = [];
    cues = [];
    subtitleCueLayoutSignature = '';
    currentCueIndex = -1;
    selectedTrack = null;
    videoMeta = { videoId: '', title: '' };
    translationsByText.clear();
    translationAlignmentsByText.clear();
    pendingTranslationTexts.clear();
    resetLiteralTranslationState();
    translationError = '';
    literalTranslationError = '';
    naturalLastLatencyMs = 0;
    lastBufferDiagnosticsSignature = '';
    autoPausedCueKey = '';
    lastVideoTimeMs = null;
    closeWordPopover();
    deactivateOverlay();
    scheduleBufferDiagnosticsUpdate();
    setTimeout(() => syncOverlay({ force: true }), 0);
  }

  async function init() {
    injectCss();
    ensureRoot();
    try {
      const raw = await chrome.storage.sync.get({ __yt: YOUTUBE_DEFAULT_SETTINGS });
      settings = sanitizeYoutubeSettings(raw.__yt || {});
    } catch {}
    if (learningStore) {
      await refreshStudyPreferences();
      await refreshLearningWordStates({ rerender: false }).catch(() => {});
      learningStore.subscribe(() => refreshStudyPreferences().then(() => refreshLearningWordStates()).catch(() => {}));
      learningStore.migrateLegacy()
        .then(() => refreshLearningWordStates())
        .then(() => learningStore.sync())
        .catch(() => {});
    }
    if (vocabularySaves) {
      let completed = '';
      vocabularySaves.subscribe(() => {
        for (const word of document.querySelectorAll(`#${ROOT_ID} .sc-learning-word, #${WORD_POPOVER_ID} .sc-word-example-token`)) {
          applyLearningStateToWord(word, word.__scExampleCue || cues[currentCueIndex]);
        }
        applyCurrentCueExpressionMarks();
        const refs = document.getElementById(WORD_POPOVER_ID)?.__scWordRefs;
        if (refs) applySharedSaveStatus(refs);
        if (phraseAnalysis) {
          const pending = vocabularySaves.pending(vocabularySaves.get(phraseAnalysis.canonicalText, phraseAnalysis.selection?.text));
          if (phraseAnalysis.saving !== pending) { phraseAnalysis.saving = pending; renderExpressionInspector(); }
        }
        const revision = vocabularySaves.all().filter(operation => ['ready', 'reconciled'].includes(operation.phase))
          .map(operation => operation.key + ':' + operation.updatedAt).join('|');
        if (revision !== completed) {
          completed = revision;
          void learningStore?.sync({ fresh: true }).then(async () => {
            await refreshLearningWordStates();
            const current = document.getElementById(WORD_POPOVER_ID)?.__scWordRefs;
            if (current) {
              const entry = await learningStore.getEntry(current.query);
              if (!current.popover.isConnected) return;
              applyPopoverState(current, entry);
              if (entry?.senseCatalog?.validatedAt && entry.state !== 'none') {
                const full = await bridgeJson('/learning/catalogue', { method: 'POST', body: { action: 'read', entryId: entry.remoteId || entry.key } });
                if (current.popover.isConnected) applyCheckedPopoverCatalogue(current, full.catalogue, entry.lemma || entry.sourceText);
              }
            }
          }).catch(error => log('save result refresh failed', { error: error.message }));
        }
      });
    }
    await syncSettingsFromDesktop();
    updateRootSettings();
    if (YOUTUBE_PLAYER_PAGE()) {
      await injectMainBridge().catch(error => log('main bridge injection failed', { error: error?.message || error }));
    }
    syncOverlay({ force: true });
    setInterval(() => {
      updateGeometry();
      syncOverlay();
    }, 1_000);
    setInterval(syncSettingsFromDesktop, 2_500);
    requestAnimationFrame(playbackTick);

    window.addEventListener('resize', updateGeometry);
    window.visualViewport?.addEventListener('resize', updateGeometry);
    window.visualViewport?.addEventListener('scroll', updateGeometry);
    window.addEventListener('scroll', onViewportScroll, { passive: true });
    window.addEventListener('yt-navigate-finish', resetForNavigation);
    window.addEventListener('blur', () => {
      fullTranslationMetaDown = false;
      updateFullSubtitleReveal();
      if (settingsPanel) settingsPanel.hidden = true;
      setControlsHovered(false);
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Meta' && !fullTranslationMetaDown) {
        fullTranslationMetaDown = true;
        updateFullSubtitleReveal();
      }
      const editable = event.target?.closest?.('input, textarea, select, [contenteditable="true"]');
      const interactive = event.target?.closest?.('button, a, summary, [role="button"]');
      const spaceAction = U.externalMediaSpaceAction({
        external: !!externalMedia,
        code: event.code,
        modifier: event.metaKey || event.ctrlKey || event.altKey || event.shiftKey,
        editable: !!editable,
        interactive: !!interactive,
        repeat: event.repeat,
        interactionOpen: !!document.getElementById(WORD_POPOVER_ID) || phraseSelectionOpen || !!russianSelection,
      });
      if (spaceAction !== 'ignore') {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (spaceAction === 'toggle') {
          const video = playerVideo();
          if (video) {
            if (video.paused) video.play().catch(() => {});
            else video.pause();
            if (document.activeElement === video) video.blur();
          }
        }
        return;
      }
      if (event.key === 'Shift' && hoveredRussianWord != null && !editable && !event.repeat && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault(); openRussianSelection(hoveredRussianWord, hoveredRussianWord, true); return;
      }
      if (event.key === 'Shift' && hoveredPhraseWord && !phraseSelectionOpen && !editable && !event.repeat
          && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        enterPhraseSelectionMode(
          hoveredPhraseWord.wordIndex,
          hoveredPhraseWord.cueIndex,
          'shift-hover',
        );
        return;
      }
      const cueDelta = U.cueNavigationDelta(event.code);
      if (cueDelta && phraseSelectionOpen && !editable
          && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        navigatePhraseCue(cueDelta);
        return;
      }
      if (cueDelta && overlayActive && cues.length && !editable
          && !event.metaKey && !event.ctrlKey && !event.altKey && !event.repeat) {
        event.preventDefault();
        event.stopPropagation();
        seekRelativeCue(cueDelta);
        return;
      }
      if (event.key === 'Escape') {
        if (document.getElementById(WORD_POPOVER_ID) || pendingWordClickTimer != null) closeWordPopover({ reason: 'escape' });
        else if (phraseSelectionOpen) clearPhraseSelection();
        else if (settingsPanel && !settingsPanel.hidden) {
          settingsPanel.hidden = true;
          root.dataset.controlsVisible = controlHovered ? '1' : '0';
        }
      }
    }, true);
    document.addEventListener('keyup', event => {
      if (event.key !== 'Meta') return;
      fullTranslationMetaDown = false;
      updateFullSubtitleReveal();
    }, true);
    document.addEventListener('pointerdown', event => {
      const player = playerAnchor();
      const inSubtitleGap = event.target === subtitleLines;
      // This hit is direct proof of the hover owner. Removing a fixed word
      // card can momentarily clear :hover before Chromium updates hit testing.
      if (inSubtitleGap) subtitleHovered = true;
      const insidePlayer = !inSubtitleGap && event.target instanceof Node && !!player?.contains(event.target);
      const playbackOwner = U.dismissalPlaybackOwner({ via: 'outside-pointer', insidePlayer });
      const resumeAfterDismissal = !inSubtitleGap && playbackOwner === 'extension';
      let interactionDismissed = false;
      const popover = document.getElementById(WORD_POPOVER_ID);
      if ((popover || pendingWordClickTimer != null) && !popover?.contains(event.target) && !window.__scLearningChoicesPopover?.contains(popover, event.target) && !event.target.closest?.('.sc-learning-word, .sc-learning-ru-word')) {
        closeWordPopover({ resume: resumeAfterDismissal, reason: 'outside-pointer' });
        interactionDismissed = true;
      }
      if (phraseSelectionOpen && !event.target.closest?.('.sc-learning-word, .sc-learning-ru-word') && !phraseHint?.contains?.(event.target) && !window.__scLearningChoicesPopover?.contains(phraseHint, event.target)) {
        clearPhraseSelection({ resume: resumeAfterDismissal });
        interactionDismissed = true;
      }
      if (interactionDismissed && playbackOwner === 'native-player') {
        // The same pointer gesture continues into YouTube's own click handler.
        // Relinquish our pause without calling play(): YouTube must perform the
        // single native play/pause toggle requested by this click.
        relinquishHoverPauseOwnership();
        log('interaction dismissed by player pointer', { playbackOwner });
      }
      if (settingsPanel && !settingsPanel.hidden && !settingsPanel.contains(event.target) && !settingsButton?.contains(event.target)) {
        settingsPanel.hidden = true;
      }
    }, true);
    document.addEventListener('timeupdate', onVideoTimelineEvent, true);
    document.addEventListener('seeked', onVideoTimelineEvent, true);
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync' || !changes.__yt) return;
      const previousTarget = settings.learning_target_lang;
      const previousTranslationOrder = settings.learning_translation_order;
      const previousTranslationMode = settings.learning_translation_mode;
      settings = sanitizeYoutubeSettings(changes.__yt.newValue || {});
      updateRootSettings();
      if (previousTarget !== settings.learning_target_lang) {
        translationsByText.clear();
        translationAlignmentsByText.clear();
        resetLiteralTranslationState();
        prefetchGeneration += 1;
        prefetchRerunRequested = false;
        naturalLastLatencyMs = 0;
        refreshLearningWordStates().catch(() => {});
        startTranslationPrefetch();
      }
      if (previousTranslationOrder !== settings.learning_translation_order) {
        renderTranslationForCue(currentCueIndex);
        if (settings.learning_translation_order === 'source') {
          prefetchLiteralWindow(currentCueIndex);
        }
      }
      if (previousTranslationMode !== settings.learning_translation_mode) {
        prefetchGeneration += 1;
        prefetchRerunRequested = false;
        renderTranslationForCue(currentCueIndex);
        startTranslationPrefetch();
      }
      syncOverlay({ force: true });
    });
  }

  window.__scLearningOverlay = Object.freeze({
    openMedia: openExternalMedia,
    closeMedia: closeExternalMedia,
    state() {
      const buffer = currentTranslationBufferSnapshot();
      return {
        active: overlayActive,
        external: !!externalMedia,
        videoId: videoMeta.videoId,
        title: videoMeta.title,
        cues: cues.length,
        currentCueIndex,
        literalReady: literalTranslationsByText.size,
        literalPending: pendingLiteralTexts.size,
        literalQueued: literalRequestQueue.length,
        literalActive: literalRequestsActive,
        naturalPending: pendingTranslationTexts.size,
        naturalActive: naturalRequestsActive,
        readyAhead: buffer.readyAhead,
        targetAhead: buffer.targetAhead,
        bufferStage: buffer.stage,
        naturalLastLatencyMs,
        literalLastLatencyMs,
        translationError,
        literalTranslationError,
      };
    },
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
