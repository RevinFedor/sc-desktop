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

  const BRIDGE = 'http://127.0.0.1:53127';
  const ROOT_ID = 'sc-yt-learning-root';
  const WORD_POPOVER_ID = 'sc-yt-word-popover';
  const MAIN_BRIDGE_ID = 'sc-yt-learning-main-bridge';
  const HIDE_NATIVE_CLASS = 'sc-yt-learning-hide-native';
  const REPLACE_LEGACY_CLASS = 'sc-yt-learning-replace-legacy';
  const PLAYER_PAGE = () => location.pathname.startsWith('/watch') || location.pathname.startsWith('/shorts/');

  const ICONS = {
    previous: '<svg viewBox="0 0 24 24"><path d="M18 6 9.5 12 18 18V6ZM6 6h2v12H6V6Z"/></svg>',
    replay: '<svg viewBox="0 0 24 24"><path d="M12 5V2L7 6l5 4V7a6 6 0 1 1-5.65 8H4.26A8 8 0 1 0 12 5Z"/></svg>',
    next: '<svg viewBox="0 0 24 24"><path d="m6 6 8.5 6L6 18V6Zm10 0h2v12h-2V6Z"/></svg>',
    swap: '<svg viewBox="0 0 24 24"><path d="m7 7 3-3-3-3v2H3v2h4v2Zm10 10-3 3 3 3v-2h4v-2h-4v-2ZM5 8h14a2 2 0 0 1 2 2v2h-2v-2H5v2l-3-3 3-3v2Zm14 8H5a2 2 0 0 1-2-2v-2h2v2h14v-2l3 3-3 3v-2Z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M6 4h4v16H6V4Zm8 0h4v16h-4V4Z"/></svg>',
    settings: '<svg viewBox="0 0 24 24"><path d="m19.4 13 .1-1-.1-1 2-1.6-2-3.4-2.5 1a8 8 0 0 0-1.7-1L15 3.3h-4L10.6 6a8 8 0 0 0-1.7 1L6.4 6 4.4 9.4l2 1.6-.1 1 .1 1-2 1.6 2 3.4 2.5-1a8 8 0 0 0 1.7 1l.4 2.7h4l.4-2.7a8 8 0 0 0 1.7-1l2.5 1 2-3.4-2-1.6ZM13 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8Z"/></svg>',
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

  let settings = sanitizeYoutubeSettings(
    typeof YOUTUBE_DEFAULT_SETTINGS === 'object' ? YOUTUBE_DEFAULT_SETTINGS : {},
  );
  let root = null;
  let subtitleCard = null;
  let sourceWrap = null;
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
  let cues = [];
  let currentCueIndex = -1;
  let selectedTrack = null;
  let videoMeta = { videoId: '', title: '' };
  let overlayActive = false;
  let translationError = '';
  let prefetchGeneration = 0;
  let prefetchRunning = false;
  let settingsRefreshBusy = false;
  let lastTickAt = 0;
  let lastVideoTimeMs = null;
  let autoPausedCueKey = '';
  let subtitleHovered = false;
  let wordPopoverOpen = false;
  let phraseSelectionOpen = false;
  let phraseSelection = null;
  let phraseSelectionAnchor = null;
  let phraseHint = null;
  let selectionHandoffGeneration = 0;
  let pausedForSubtitleHover = false;
  let hoverPausedCueKey = '';
  let popoverResizeObserver = null;
  let learningStateRefreshPromise = null;
  let copyCueControl = null;
  let copyCueButton = null;
  let copyNeighborCount = 1;
  let copyFeedbackTimer = null;
  const translationsByText = new Map();
  const translationAlignmentsByText = new Map();
  const pendingTranslationTexts = new Set();
  const snapshotRequests = new Map();
  const wordStates = new Map();

  function debugSink() {
    let sink = document.getElementById('sc-yt-learning-debug');
    if (sink) return sink;
    sink = document.createElement('pre');
    sink.id = 'sc-yt-learning-debug';
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
        width: min(90%, 1120px);
        text-align: center;
        pointer-events: auto;
        filter: drop-shadow(0 2px 3px rgba(0,0,0,.75));
      }
      #${ROOT_ID}[data-position="bottom"] .sc-learning-subtitle-card { bottom: 10%; }
      #${ROOT_ID}[data-position="top"] .sc-learning-subtitle-card { top: 8%; }
      #${ROOT_ID} .sc-learning-source,
      #${ROOT_ID} .sc-learning-translation {
        display: block;
        width: fit-content;
        max-width: 100%;
        margin: 0 auto;
        padding: 5px 12px;
        border-radius: 6px;
        background: rgba(8, 8, 10, .82);
        box-decoration-break: clone;
        -webkit-box-decoration-break: clone;
        line-height: 1.32;
      }
      #${ROOT_ID} .sc-learning-source-wrap {
        position:relative;
        width:fit-content;
        max-width:100%;
        margin:0 auto;
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
      #${ROOT_ID} .sc-learning-copy-control:focus-within { opacity:.82; }
      #${ROOT_ID} .sc-learning-copy-control:hover { opacity:1; }
      #${ROOT_ID} .sc-learning-copy-launch {
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
      #${ROOT_ID} .sc-learning-copy-control:focus-within .sc-learning-copy-menu { display:flex; }
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
      #${ROOT_ID} .sc-learning-source { font-size: clamp(20px, 2.15vw, 34px); font-weight: 500; }
      #${ROOT_ID} .sc-learning-translation {
        margin-top: 5px;
        font-size: clamp(16px, 1.55vw, 25px);
        color: #d4d4d8;
        transition: opacity .12s ease, transform .12s ease;
      }
      #${ROOT_ID} .sc-learning-translation mark {
        color:#fff;
        background:rgba(147,51,234,.5);
        border-radius:3px;
        padding:0;
      }
      #${ROOT_ID}[data-translation-mode="hover"] .sc-learning-translation {
        opacity: 0;
        transform: translateY(4px);
        pointer-events: none;
      }
      #${ROOT_ID}[data-translation-mode="hover"] .sc-learning-subtitle-card:hover .sc-learning-translation,
      #${ROOT_ID}[data-translation-mode="hover"] .sc-learning-subtitle-card:focus-within .sc-learning-translation {
        opacity: 1;
        transform: translateY(0);
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
      #${ROOT_ID} .sc-learning-word[data-learning-state="saved"] {
        color: #fff;
        background: rgba(147,51,234,.56);
        box-shadow: inset 0 -2px 0 rgba(216,180,254,.95);
      }
      #${ROOT_ID} .sc-learning-word[data-learning-state="known"] {
        color: #fff;
        background: rgba(22,163,74,.5);
        box-shadow: inset 0 -2px 0 rgba(134,239,172,.95);
      }
      #${ROOT_ID} .sc-learning-word[data-learning-state="saved"]:hover,
      #${ROOT_ID} .sc-learning-word[data-learning-state="saved"]:focus-visible { background: rgba(147,51,234,.78); }
      #${ROOT_ID} .sc-learning-word[data-learning-state="known"]:hover,
      #${ROOT_ID} .sc-learning-word[data-learning-state="known"]:focus-visible { background: rgba(22,163,74,.72); }
      #${ROOT_ID} .sc-learning-word[data-phrase-selected="1"] {
        color:#fff;
        background:rgba(37,99,235,.72);
        box-shadow:inset 0 -2px 0 rgba(147,197,253,.98);
      }
      #${ROOT_ID} .sc-learning-phrase-hint {
        display:none;
        width:fit-content;
        max-width:100%;
        margin:0 auto 5px;
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
      #${ROOT_ID} .sc-learning-status {
        display: none;
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
      #${ROOT_ID}[data-mirrored="0"] .sc-learning-nav { left: 12px; }
      #${ROOT_ID}[data-mirrored="0"] .sc-learning-options { right: 12px; }
      #${ROOT_ID}[data-mirrored="1"] .sc-learning-nav { right: 12px; }
      #${ROOT_ID}[data-mirrored="1"] .sc-learning-options { left: 12px; }
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
        width: 300px;
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
      #${ROOT_ID} .sc-learning-setting-row { display:grid; grid-template-columns: 1fr 130px; gap:10px; align-items:center; min-height:38px; font-size:13px; }
      #${ROOT_ID} .sc-learning-setting-row select,
      #${ROOT_ID} .sc-learning-setting-row input[type="text"] {
        width:100%; min-width:0; height:30px; border:1px solid #3f3f46; border-radius:7px;
        background:#27272a; color:#f4f4f5; padding:0 8px; font:inherit;
      }
      #${ROOT_ID} .sc-learning-setting-row input[type="checkbox"] { justify-self:end; width:18px; height:18px; accent-color:#9333ea; }
      #${WORD_POPOVER_ID} {
        position: fixed;
        z-index: 2147483000;
        display: flex;
        flex-direction: column;
        box-sizing: border-box;
        width: min(480px, calc(100vw - 24px));
        max-height: min(760px, calc(100vh - 24px));
        overflow: hidden;
        padding: 0;
        border: 1px solid rgba(255,255,255,.14);
        border-radius: 14px;
        background: #202022;
        color: #f4f4f5;
        box-shadow: 0 20px 58px rgba(0,0,0,.58);
        font-family: Roboto, Arial, sans-serif;
        user-select:none;
        -webkit-user-select:none;
      }
      #${WORD_POPOVER_ID} .sc-word-head { display:flex; flex:0 0 auto; align-items:flex-start; gap:8px; padding:10px 11px 9px; background:#2b2b2f; }
      #${WORD_POPOVER_ID} .sc-word-title { min-width:0; flex:1; }
      #${WORD_POPOVER_ID} .sc-word-source { color:#e9d5ff; font-size:23px; font-weight:700; overflow-wrap:anywhere; }
      #${WORD_POPOVER_ID} .sc-word-primary { margin-top:3px; color:#fff; font-size:18px; font-weight:600; }
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
      #${WORD_POPOVER_ID} .sc-word-pos { flex:0 0 54px; color:#71717a; font-style:italic; }
      #${WORD_POPOVER_ID} .sc-word-examples { flex:1 1 250px; min-height:150px; max-height:min(330px,40vh); overflow-y:auto; overscroll-behavior:contain; }
      #${WORD_POPOVER_ID}[data-compact="1"] .sc-word-examples { min-height:110px; }
      #${WORD_POPOVER_ID} { overscroll-behavior:contain; }
      #${WORD_POPOVER_ID} .sc-word-example { position:relative; display:grid; grid-template-columns:30px 1fr auto; gap:7px; align-items:start; padding:6px 0; border-top:1px solid rgba(255,255,255,.07); }
      #${WORD_POPOVER_ID} .sc-word-example:first-of-type { border-top:0; }
      #${WORD_POPOVER_ID} .sc-word-example-text { font-size:15px; line-height:1.45; }
      #${WORD_POPOVER_ID} .sc-word-example-translation { margin-top:3px; color:#a1a1aa; font-size:13px; }
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
      #${WORD_POPOVER_ID} .sc-word-footer svg { width:18px; height:18px; fill:currentColor; }
      #${WORD_POPOVER_ID} .sc-learning-icon-button { width:30px; height:30px; border-radius:7px; }
      #${WORD_POPOVER_ID} .sc-learning-icon-button svg { width:18px; height:18px; }
      #${WORD_POPOVER_ID} .sc-word-loading { padding:18px 14px; color:#a1a1aa; text-align:center; }
      #${WORD_POPOVER_ID} .sc-word-error { color:#fca5a5; }
      #${WORD_POPOVER_ID} .sc-word-primary[data-loading="1"] { width:150px; height:20px; margin-top:5px; }
      #${WORD_POPOVER_ID} .sc-word-skeleton {
        display:block;
        border-radius:5px;
        background:linear-gradient(90deg,rgba(255,255,255,.07),rgba(255,255,255,.15),rgba(255,255,255,.07));
        background-size:220% 100%;
        animation:sc-word-skeleton 1.15s ease-in-out infinite;
      }
      #${WORD_POPOVER_ID} .sc-word-skeleton-row { display:grid; grid-template-columns:30px 1fr; gap:7px; align-items:center; padding:7px 0; }
      #${WORD_POPOVER_ID} .sc-word-skeleton-row span:first-child { width:24px; height:24px; border-radius:999px; }
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
    const text = U.cueWindowText(cues, currentCueIndex, count, side);
    if (!text) return;
    const copied = await copyText(text);
    if (!copied || !copyCueControl) return;
    clearTimeout(copyFeedbackTimer);
    copyCueControl.dataset.copied = '1';
    copyCueButton.title = 'Скопировано';
    copyCueButton.setAttribute('aria-label', 'Скопировано');
    copyFeedbackTimer = setTimeout(() => {
      if (!copyCueControl) return;
      copyCueControl.dataset.copied = '0';
      copyCueButton.title = 'Копировать текущую реплику';
      copyCueButton.setAttribute('aria-label', 'Копировать текущую реплику');
    }, 900);
    log('cue copied', { cueIndex: currentCueIndex, neighbors: count, direction, chars: text.length });
  }

  function buildCueCopyControl() {
    const control = document.createElement('div');
    control.className = 'sc-learning-copy-control';
    control.dataset.visible = '0';
    control.dataset.copied = '0';
    copyCueButton = document.createElement('button');
    copyCueButton.type = 'button';
    copyCueButton.className = 'sc-learning-copy-launch';
    copyCueButton.innerHTML = ICONS.copy;
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
    control.append(copyCueButton, menu);
    updateCopyNeighborButtons(control);
    return control;
  }

  function playerAnchor() {
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
  }

  function hoverHoldRequested() {
    return subtitleHovered || wordPopoverOpen || phraseSelectionOpen;
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

  function releaseHoverHold({ resume = true } = {}) {
    subtitleHovered = false;
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
    if (currentCueIndex >= 0) {
      ensureCueTranslation(currentCueIndex);
      renderCue(currentCueIndex, true);
    }
  }

  function onSubtitlePointerLeave() {
    subtitleHovered = false;
    resumeAfterHoverRelease();
  }

  function ensureRoot() {
    if (root?.isConnected) return root;
    injectCss();
    root = document.createElement('div');
    root.id = ROOT_ID;
    root.dataset.active = '0';
    root.dataset.controlsVisible = '0';
    root.dataset.hoverHold = 'off';

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
    translationRow = document.createElement('div');
    translationRow.className = 'sc-learning-translation';
    sourceWrap = document.createElement('div');
    sourceWrap.className = 'sc-learning-source-wrap';
    sourceRow = document.createElement('div');
    sourceRow.className = 'sc-learning-source';
    copyCueControl = buildCueCopyControl();
    sourceWrap.append(sourceRow, copyCueControl);
    subtitleCard.append(statusRow, phraseHint, sourceWrap, translationRow);

    navRail = document.createElement('div');
    navRail.className = 'sc-learning-rail sc-learning-nav';
    navRail.append(
      iconButton('previous', 'Предыдущая реплика (A / Ф)', () => seekRelativeCue(-1)),
      iconButton('replay', 'Повторить реплику', () => seekCue(currentCueIndex)),
      iconButton('next', 'Следующая реплика (D / В)', () => seekRelativeCue(1)),
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
    optionRail.append(swapButton, autoPauseButton, settingsButton);

    settingsPanel = buildSettingsPanel();
    root.append(subtitleCard, navRail, optionRail, settingsPanel);
    root.addEventListener('pointerenter', () => setControlsHovered(true));
    root.addEventListener('pointerleave', () => setControlsHovered(false));
    document.body.appendChild(root);
    updateRootSettings();
    updateGeometry();
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
    const addCheck = (label, key) => {
      const row = document.createElement('label');
      row.className = 'sc-learning-setting-row';
      const text = document.createElement('span');
      text.textContent = label;
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.setting = key;
      input.addEventListener('change', () => persistSettingsPatch({ [key]: input.checked }));
      row.append(text, input);
      panel.appendChild(row);
    };

    const source = document.createElement('div');
    source.className = 'sc-learning-setting-row';
    source.innerHTML = '<span>Дорожка YouTube</span><span data-source-track style="text-align:right;color:#a1a1aa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>';
    panel.appendChild(source);
    addSelect('Перевод', 'learning_target_lang', languageOptions);
    addSelect('Позиция', 'learning_subtitle_position', [['bottom', 'Снизу'], ['top', 'Сверху']]);
    addSelect('Показывать перевод', 'learning_translation_mode', [['always', 'Всегда'], ['hover', 'При наведении']]);
    addCheck('Автопауза', 'learning_auto_pause');
    addCheck('Поменять стороны', 'learning_controls_mirrored');
    addCheck('Скрывать родные CC', 'learning_hide_native_subtitles');
    return panel;
  }

  function updateRootSettings() {
    if (!root) return;
    root.dataset.position = settings.learning_subtitle_position;
    root.dataset.mirrored = settings.learning_controls_mirrored ? '1' : '0';
    root.dataset.translationMode = settings.learning_translation_mode;
    autoPauseButton?.setAttribute('data-active', settings.learning_auto_pause ? '1' : '0');
    settingsButton?.setAttribute('data-active', settingsPanel && !settingsPanel.hidden ? '1' : '0');
    for (const input of settingsPanel?.querySelectorAll('[data-setting]') || []) {
      const key = input.dataset.setting;
      if (input.type === 'checkbox') input.checked = !!settings[key];
      else input.value = settings[key];
    }
    const source = settingsPanel?.querySelector('[data-source-track]');
    if (source) source.textContent = selectedTrack?.label || selectedTrack?.languageCode || 'Авто';
    applyNativeCaptionVisibility();
  }

  async function persistSettingsPatch(patch) {
    const previousTarget = settings.learning_target_lang;
    settings = sanitizeYoutubeSettings({ ...settings, ...patch });
    updateRootSettings();
    try { await chrome.storage.sync.set({ __yt: settings }); } catch {}
    try {
      chrome.runtime.sendMessage({ type: 'sc-youtube-settings-patch', patch }, () => {
        const error = chrome.runtime.lastError;
        if (error) log('settings patch queued locally', { error: error.message });
      });
    } catch {}
    if (previousTarget !== settings.learning_target_lang) {
      translationsByText.clear();
      translationAlignmentsByText.clear();
      translationError = '';
      prefetchGeneration += 1;
      renderCue(currentCueIndex, true);
      if (settings.learning_translation_mode === 'always') startTranslationPrefetch();
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
        translationError = '';
        prefetchGeneration += 1;
        renderCue(currentCueIndex, true);
      }
      if (previous.learning_translation_mode !== fresh.learning_translation_mode
          && fresh.learning_translation_mode === 'always') {
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
    clearPhraseSelection({ resume: false });
    releaseHoverHold({ resume: true });
    overlayActive = false;
    if (root) root.dataset.active = '0';
    document.documentElement.classList.remove(HIDE_NATIVE_CLASS);
    document.documentElement.classList.remove(REPLACE_LEGACY_CLASS);
    closeWordPopover();
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
    const prepared = U.finalizeCues(rawCues || []);
    return track?.kind === 'asr' ? U.pairAdjacentAsrCues(prepared) : prepared;
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
    const response = await fetch(BRIDGE + path, {
      method: options.method || 'GET',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    let payload = null;
    try { payload = await response.json(); } catch {}
    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.error || `SC Desktop HTTP ${response.status}`);
    }
    return payload;
  }

  async function loadTrack(track, snapshot) {
    const generation = ++loadGeneration;
    selectedTrack = track;
    videoMeta = {
      videoId: snapshot?.videoId || extractVideoIdFromLocation(),
      title: snapshot?.title || document.title.replace(/\s+-\s+YouTube\s*$/, ''),
    };
    cues = [];
    currentCueIndex = -1;
    translationsByText.clear();
    translationAlignmentsByText.clear();
    pendingTranslationTexts.clear();
    translationError = '';
    subtitleCard.style.display = '';
    sourceRow.replaceChildren();
    if (copyCueControl) copyCueControl.dataset.visible = '0';
    translationRow.textContent = '';
    setStatus('Загружаю дорожку субтитров…', { loading: true });
    updateRootSettings();
    try {
      const loaded = await fetchCaptionCues(track);
      if (generation !== loadGeneration) return;
      cues = loaded;
      setStatus('');
      applyNativeCaptionVisibility();
      activeVideo = playerVideo();
      renderCurrentVideoCue(activeVideo, true);
      log('captions loaded', { videoId: videoMeta.videoId, lang: track.languageCode, cues: cues.length });
      if (settings.learning_translation_mode === 'always') startTranslationPrefetch();
    } catch (error) {
      if (generation !== loadGeneration) return;
      // A YouTube main-world fetch can time out during SPA navigation or tab
      // visibility changes. Keep the same track eligible for the next sync
      // instead of freezing the error forever behind its previous identity.
      lastTrackIdentity = '';
      setStatus(`Не удалось прочитать субтитры: ${error?.message || error}`);
      log('captions failed', { error: error?.message || String(error) });
    }
  }

  async function syncOverlay({ force = false } = {}) {
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
        cues = [];
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

  async function requestTranslations(batch, generation) {
    const texts = batch.map(item => item.text);
    texts.forEach(text => pendingTranslationTexts.add(text));
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
      texts.forEach(text => pendingTranslationTexts.delete(text));
      if (generation === prefetchGeneration && currentCueIndex >= 0) {
        renderCue(currentCueIndex, true);
        refreshOpenPopoverExamples();
      }
    }
  }

  async function startTranslationPrefetch() {
    if (!cues.length) return;
    const generation = ++prefetchGeneration;
    if (prefetchRunning) return;
    prefetchRunning = true;
    try {
      const current = Math.max(0, currentCueIndex);
      const start = Math.max(0, current - 8);
      const end = Math.min(cues.length, current + 9);
      const order = cues.slice(start, end)
        .map((cue, offset) => ({ cue, index: start + offset, distance: Math.abs(start + offset - current) }))
        .sort((a, b) => a.distance - b.distance || a.index - b.index);
      const unique = [];
      const seen = new Set();
      for (const { cue, index } of order) {
        if (translationsByText.has(cue.text) || seen.has(cue.text)) continue;
        seen.add(cue.text);
        unique.push({ text: cue.text, cueIndex: index });
      }
      for (const batch of U.batchTexts(unique, 25, 5_000)) {
        if (generation !== prefetchGeneration) return;
        await requestTranslations(batch, generation);
      }
    } finally {
      prefetchRunning = false;
      if (generation !== prefetchGeneration && cues.length && settings.learning_translation_mode === 'always') {
        startTranslationPrefetch();
      }
    }
  }

  function ensureCueTranslation(index) {
    const cue = cues[index];
    if (!cue || translationsByText.has(cue.text) || pendingTranslationTexts.has(cue.text)) return;
    requestTranslations([{ text: cue.text, cueIndex: index }], prefetchGeneration);
  }

  async function refreshLearningWordStates({ rerender = true } = {}) {
    if (!learningStore) return;
    if (learningStateRefreshPromise) return learningStateRefreshPromise;
    learningStateRefreshPromise = (async () => {
      const entries = await learningStore.listEntries({ states: ['saved', 'known'] });
      wordStates.clear();
      for (const entry of entries || []) {
        if (entry?.kind !== 'word' || !entry.normalizedText) continue;
        if (!wordStates.has(entry.normalizedText) || Number(entry.updatedAt) > Number(wordStates.get(entry.normalizedText)?.updatedAt || 0)) {
          wordStates.set(entry.normalizedText, { state: entry.state, updatedAt: entry.updatedAt });
        }
      }
      if (rerender && currentCueIndex >= 0) renderCue(currentCueIndex, true);
      const popover = document.getElementById(WORD_POPOVER_ID);
      if (popover?.__scWordRefs) {
        const entry = await learningStore.getEntry(popover.__scWordRefs.query).catch(() => null);
        applyPopoverState(popover.__scWordRefs, entry);
      }
    })().catch((error) => log('learning state refresh failed', { error: error?.message || String(error) }));
    try { return await learningStateRefreshPromise; }
    finally { learningStateRefreshPromise = null; }
  }

  function updatePhraseHint(text, state = 'ready') {
    if (!phraseHint) return;
    phraseHint.textContent = text || '';
    phraseHint.dataset.visible = text ? '1' : '0';
    phraseHint.dataset.state = state;
  }

  async function publishPhraseSelection(selection) {
    const generation = ++selectionHandoffGeneration;
    updatePhraseHint('Готовлю разбор…', 'loading');
    try {
      const result = await bridgeJson('/learning/selection', {
        method: 'POST',
        body: {
          text: selection.text,
          sourceName: 'YouTube subtitles',
          pageUrl: location.href,
          videoId: videoMeta.videoId || extractVideoIdFromLocation(),
          cueStartMs: cues[selection.cueIndex]?.startMs ?? null,
        },
      });
      if (generation !== selectionHandoffGeneration || !phraseSelectionOpen) return;
      updatePhraseHint(
        result?.online === false || result?.armed !== true
          ? 'Voice Record недоступен · ⌥ Space откроет обычный чат'
          : '⌥ Space — разобрать · Esc — отменить',
        result?.online === false || result?.armed !== true ? 'error' : 'ready',
      );
    } catch (error) {
      if (generation !== selectionHandoffGeneration || !phraseSelectionOpen) return;
      updatePhraseHint('Не удалось подготовить Voice Record · Esc — отменить', 'error');
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
          sourceName: 'YouTube subtitles',
          pageUrl: location.href,
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
    const hadSelection = phraseSelectionOpen || !!phraseSelection;
    phraseSelectionOpen = false;
    phraseSelection = null;
    if (!keepAnchor) phraseSelectionAnchor = null;
    selectionHandoffGeneration += 1;
    sourceRow?.querySelectorAll?.('.sc-learning-word[data-phrase-selected="1"]')
      .forEach((word) => delete word.dataset.phraseSelected);
    clearNativeTextSelection();
    updatePhraseHint('');
    if (notify && hadSelection) {
      bridgeJson('/learning/selection', { method: 'POST', body: { text: '' } }).catch(() => {});
    }
    if (resume) resumeAfterHoverRelease();
    else updateHoverHoldState();
  }

  function applyPhraseSelectionDom(selection) {
    const words = Array.from(sourceRow?.querySelectorAll?.('.sc-learning-word[data-word-index]') || []);
    const first = words.find((word) => Number(word.dataset.wordIndex) === selection.fromWordIndex);
    const last = words.find((word) => Number(word.dataset.wordIndex) === selection.toWordIndex);
    if (!first || !last) return false;
    for (const word of words) {
      const index = Number(word.dataset.wordIndex);
      if (index >= selection.fromWordIndex && index <= selection.toWordIndex) word.dataset.phraseSelected = '1';
      else delete word.dataset.phraseSelected;
    }
    clearNativeTextSelection();
    return true;
  }

  function phraseTextFromDom(selection) {
    const words = Array.from(sourceRow?.querySelectorAll?.('.sc-learning-word[data-word-index]') || []);
    const first = words.find((word) => Number(word.dataset.wordIndex) === selection.fromWordIndex);
    const last = words.find((word) => Number(word.dataset.wordIndex) === selection.toWordIndex);
    if (!first || !last) return '';
    try {
      const range = document.createRange();
      range.setStartBefore(first);
      range.setEndAfter(last);
      const text = range.toString();
      range.detach?.();
      return text;
    } catch {}
    return '';
  }

  function selectPhraseTo(wordIndex, cueIndex) {
    if (!phraseSelectionAnchor || phraseSelectionAnchor.cueIndex !== cueIndex) return false;
    closeWordPopover({ resume: false });
    const { fromWordIndex, toWordIndex } = U.inclusiveWordRange(phraseSelectionAnchor.wordIndex, wordIndex);
    const draft = { cueIndex, fromWordIndex, toWordIndex, text: '' };
    const text = String(phraseTextFromDom(draft)).replace(/\s+/g, ' ').trim();
    if (!text) return false;
    if (!applyPhraseSelectionDom(draft)) return false;
    draft.text = text;
    phraseSelection = draft;
    phraseSelectionOpen = true;
    wordPopoverOpen = false;
    const video = playerVideo();
    if (video && !video.paused) {
      video.pause();
      pausedForSubtitleHover = true;
      hoverPausedCueKey = `${videoMeta.videoId}:${cues[cueIndex]?.startMs ?? cueIndex}`;
    }
    updateHoverHoldState();
    publishPhraseSelection(draft);
    log('phrase selected', { cueIndex, fromWordIndex, toWordIndex, chars: text.length });
    return true;
  }

  function renderCue(index, force = false) {
    ensureRoot();
    if (!force && index === currentCueIndex) return;
    const preservedPhrase = phraseSelectionOpen && phraseSelection?.cueIndex === index
      ? { ...phraseSelection }
      : null;
    if (phraseSelectionOpen && !preservedPhrase) clearPhraseSelection({ resume: false });
    currentCueIndex = index;
    root.dataset.cueIndex = String(index);
    sourceRow.replaceChildren();
    if (index < 0 || !cues[index]) {
      delete root.dataset.cueStartMs;
      delete root.dataset.cueEndMs;
      sourceRow.textContent = '';
      translationRow.textContent = '';
      subtitleCard.style.display = 'none';
      if (copyCueControl) copyCueControl.dataset.visible = '0';
      return;
    }
    subtitleCard.style.display = '';
    if (copyCueControl) copyCueControl.dataset.visible = '1';
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
      const learningState = wordStates.get(part.normalized)?.state || '';
      if (learningState) {
        word.dataset.learningState = learningState;
        word.title = learningState === 'known' ? 'Отмечено: знаю' : 'Добавлено в словарь';
      }
      word.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey && selectPhraseTo(currentWordIndex, index)) return;
        clearPhraseSelection({ resume: false });
        phraseSelectionAnchor = { cueIndex: index, wordIndex: currentWordIndex };
        openWordPopover(word, part.text, index);
      });
      word.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          clearPhraseSelection({ resume: false });
          phraseSelectionAnchor = { cueIndex: index, wordIndex: currentWordIndex };
          openWordPopover(word, part.text, index);
        }
      });
      sourceRow.appendChild(word);
    }
    if (preservedPhrase) applyPhraseSelectionDom(preservedPhrase);
    let translated = translationsByText.get(cue.text);
    if (settings.learning_translation_mode === 'always' && !translated) {
      ensureCueTranslation(index);
      translated = translationsByText.get(cue.text);
    }
    if (translated) {
      const refs = document.getElementById(WORD_POPOVER_ID)?.__scWordRefs;
      if (refs?.cueIndex === index) highlightTargetTerm(translationRow, cue.text, translated, refs);
      else translationRow.textContent = translated;
    } else {
      translationRow.textContent = pendingTranslationTexts.has(cue.text)
        ? 'Перевожу…'
        : (translationError ? 'Перевод временно недоступен' : '');
    }
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
      if (inHoldWindow) return true;
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
    renderCue(currentCueIndex, true);
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
      if (index >= 0 && settings.learning_translation_mode === 'always') startTranslationPrefetch();
    }
  }

  function extractVideoIdFromLocation() {
    try {
      const url = new URL(location.href);
      if (url.pathname.startsWith('/watch')) return url.searchParams.get('v') || '';
      if (url.pathname.startsWith('/shorts/')) return url.pathname.split('/').filter(Boolean)[1] || '';
    } catch {}
    return '';
  }

  function positionPopover(popover, anchor) {
    if (!popover.isConnected || !anchor?.isConnected) return;
    const margin = 12;
    const gap = 8;
    const a = anchor.getBoundingClientRect();
    const player = playerAnchor()?.getBoundingClientRect();
    const playerTopInset = player
      ? Math.min(112, Math.max(72, Math.round(player.height * 0.12)))
      : 0;
    const safeTop = player ? Math.max(margin, player.top + playerTopInset) : margin;
    const safeBottom = player ? Math.min(innerHeight - margin, player.bottom - margin) : innerHeight - margin;
    const safeLeft = player ? Math.max(margin, player.left + margin) : margin;
    const safeRight = player ? Math.min(innerWidth - margin, player.right - margin) : innerWidth - margin;
    const aboveSpace = Math.max(0, a.top - gap - safeTop);
    const belowSpace = Math.max(0, safeBottom - a.bottom - gap);
    // The word card belongs above the whole source subtitle block. Anchoring
    // it to a word on the second line made the card overlap the first line and
    // visually look as if it had opened beside the subtitle.
    const placeAbove = true;
    const fullPlayerHeight = Math.max(120, safeBottom - safeTop);
    const directionalSpace = placeAbove ? aboveSpace : belowSpace;
    const availableHeight = Math.max(120, Math.min(fullPlayerHeight, directionalSpace || fullPlayerHeight));
    popover.style.maxHeight = `${Math.floor(availableHeight)}px`;
    popover.dataset.compact = availableHeight < 470 ? '1' : '0';

    const p = popover.getBoundingClientRect();
    let left = a.left + a.width / 2 - p.width / 2;
    left = Math.max(safeLeft, Math.min(safeRight - p.width, left));
    let top = placeAbove ? a.top - p.height - gap : a.bottom + gap;
    top = Math.max(safeTop, Math.min(safeBottom - p.height, top));
    popover.dataset.placement = placeAbove ? 'above' : 'below';
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
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

  function closeWordPopover({ resume = true } = {}) {
    popoverResizeObserver?.disconnect();
    popoverResizeObserver = null;
    const popover = document.getElementById(WORD_POPOVER_ID);
    const highlightedCueIndex = popover?.__scWordRefs?.cueIndex;
    popover?.remove();
    wordPopoverOpen = false;
    if (highlightedCueIndex === currentCueIndex && currentCueIndex >= 0) renderCue(currentCueIndex, true);
    if (resume) resumeAfterHoverRelease();
    else updateHoverHoldState();
  }

  function speak(text) {
    try {
      speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = sourceLanguage();
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

  function cueContext(cue) {
    return {
      videoId: videoMeta.videoId,
      videoUrl: videoMeta.videoId ? `https://www.youtube.com/watch?v=${videoMeta.videoId}` : location.href,
      videoTitle: videoMeta.title,
      startMs: cue?.startMs,
      endMs: cue?.endMs,
      sourceText: cue?.text || '',
      translation: cue ? translationsByText.get(cue.text) || '' : '',
    };
  }

  function localLearningPayload({ kind, state: nextState, sourceText, normalizedText, translation, cue, toggle = true }) {
    return {
      kind,
      state: nextState,
      toggle,
      sourceText,
      normalizedText,
      translation: translation || '',
      translationSource: translation ? 'machine' : '',
      sourceLang: sourceLanguage(),
      targetLang: settings.learning_target_lang,
      contexts: cue ? [cueContext(cue)] : [],
    };
  }

  async function saveLearning({ kind, state: nextState, sourceText, normalizedText, translation, cue, toggle = true }) {
    if (!learningStore) throw new Error('Локальный словарь недоступен');
    return learningStore.setState(localLearningPayload({
      kind,
      state: nextState,
      sourceText,
      normalizedText,
      translation,
      cue,
      toggle,
    }));
  }

  function highlightTerm(container, text, term) {
    const normalized = U.normalizeTerm(term);
    for (const part of U.segmentWords(text, sourceLanguage())) {
      if (part.word && part.normalized === normalized) {
        const mark = document.createElement('mark');
        mark.textContent = part.text;
        container.appendChild(mark);
      } else {
        container.appendChild(document.createTextNode(part.text));
      }
    }
  }

  function renderRanges(container, text, ranges) {
    container.replaceChildren();
    let cursor = 0;
    for (const range of ranges || []) {
      if (range.start > cursor) container.appendChild(document.createTextNode(text.slice(cursor, range.start)));
      const mark = document.createElement('mark');
      mark.textContent = text.slice(range.start, range.end);
      container.appendChild(mark);
      cursor = range.end;
    }
    if (cursor < text.length) container.appendChild(document.createTextNode(text.slice(cursor)));
  }

  function highlightTargetTerm(container, sourceText, translatedText, refs) {
    const alignment = translationAlignmentsByText.get(sourceText) || '';
    let ranges = U.alignedTargetRanges(
      sourceText,
      translatedText,
      refs?.word || '',
      alignment,
      sourceLanguage(),
    );
    if (!ranges.length && refs?.targetTerms?.length) {
      ranges = U.exactTermRanges(translatedText, refs.targetTerms, settings.learning_target_lang);
    }
    if (ranges.length) renderRanges(container, translatedText, ranges);
    else container.textContent = translatedText;
  }

  function openStudyPage() {
    try { chrome.runtime.sendMessage({ type: 'sc-open-study' }); } catch {}
  }

  function skeletonRow() {
    const row = document.createElement('div');
    row.className = 'sc-word-skeleton-row';
    const circle = document.createElement('span');
    circle.className = 'sc-word-skeleton';
    const lines = document.createElement('span');
    lines.className = 'sc-word-skeleton-lines';
    const first = document.createElement('span');
    first.className = 'sc-word-skeleton';
    const second = document.createElement('span');
    second.className = 'sc-word-skeleton';
    lines.append(first, second);
    row.append(circle, lines);
    return row;
  }

  function applyPopoverState(refs, entry) {
    if (!refs) return;
    refs.entry = entry || null;
    const state = entry?.state || 'none';
    for (const [name, button] of refs.stateButtons) {
      button.dataset.active = state === name ? '1' : '0';
      button.setAttribute('aria-pressed', String(state === name));
    }
  }

  async function togglePopoverState(refs, stateName) {
    if (!learningStore || refs.busy) return;
    refs.busy = true;
    for (const button of refs.stateButtons.values()) button.disabled = true;
    try {
      const entry = await saveLearning({
        kind: 'word',
        state: stateName,
        sourceText: refs.word,
        normalizedText: refs.query.normalizedText,
        translation: refs.primary || refs.entry?.translation || '',
        cue: refs.cue,
        toggle: true,
      });
      applyPopoverState(refs, entry);
      const normalized = refs.clickedNormalized || refs.query.normalizedText;
      if (entry?.state === 'saved' || entry?.state === 'known') {
        wordStates.set(normalized, { state: entry.state, updatedAt: entry.updatedAt });
      } else {
        wordStates.delete(normalized);
      }
      if (currentCueIndex >= 0) renderCue(currentCueIndex, true);
    } catch (error) {
      log('word state save failed', { error: error?.message || String(error) });
    } finally {
      refs.busy = false;
      for (const button of refs.stateButtons.values()) button.disabled = false;
    }
  }

  function createWordPopoverShell(popover, anchor, word, cueIndex) {
    const cue = cues[cueIndex];
    const query = {
      kind: 'word',
      sourceLang: sourceLanguage(),
      targetLang: settings.learning_target_lang,
      sourceText: word,
      normalizedText: U.normalizeTerm(word),
    };
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
    head.append(
      titles,
      iconButton('book', 'Открыть словарь и карточки', openStudyPage),
      iconButton('speaker', 'Произнести слово', () => speak(word)),
      iconButton('close', 'Закрыть', closeWordPopover),
    );

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
      query,
      source,
      target,
      meanings,
      meaningsList,
      aiExplanation,
      examples,
      footer,
      stateButtons,
      primary: '',
      targetTerms: [],
      entry: null,
      busy: false,
    };
    addState('known', 'known', 'Знаю');
    addState('saved', 'save', 'В словарь');
    popover.append(head, meanings, examples, footer);
    popover.__scWordRefs = refs;
    return refs;
  }

  function renderDictionaryContent(refs, payload) {
    if (!refs?.popover?.isConnected) return;
    refs.primary = primaryDictionaryTranslation(payload);
    refs.source.textContent = payload?.dictionary?.displaySource || refs.word;
    refs.target.classList.remove('sc-word-skeleton');
    refs.target.dataset.loading = '0';
    refs.target.removeAttribute('aria-label');
    refs.target.textContent = refs.primary || 'Перевод не найден';
    const alternatives = payload?.dictionary?.translations || [];
    refs.targetTerms = [refs.primary, ...alternatives.map(item => item.displayTarget || item.normalizedTarget || '')]
      .filter(Boolean);
    refs.meaningsList.replaceChildren();
    if (!alternatives.length) {
      const value = document.createElement('div');
      value.className = 'sc-word-meaning';
      value.textContent = refs.primary || 'Дополнительных значений нет.';
      refs.meaningsList.appendChild(value);
    }
    const groupedMeanings = new Map();
    for (const item of alternatives.slice(0, 20)) {
      const key = String(item.posTag || 'OTHER').toUpperCase();
      if (!groupedMeanings.has(key)) groupedMeanings.set(key, []);
      const value = item.displayTarget || item.normalizedTarget || '';
      if (value && !groupedMeanings.get(key).includes(value)) groupedMeanings.get(key).push(value);
    }
    for (const [posTag, values] of groupedMeanings) {
      if (!values.length) continue;
      const row = document.createElement('div');
      row.className = 'sc-word-meaning';
      const pos = document.createElement('span');
      pos.className = 'sc-word-pos';
      pos.textContent = `${partOfSpeechLabel(posTag)}:`;
      pos.title = posTag;
      const value = document.createElement('span');
      value.textContent = values.join(', ');
      row.append(pos, value);
      refs.meaningsList.appendChild(row);
    }
    const meaningTextLength = Array.from(groupedMeanings.values()).flat().join(', ').length;
    refs.meanings.dataset.long = alternatives.length > 5 || meaningTextLength > 82 ? '1' : '0';
    renderExamples(refs);
    if (currentCueIndex === refs.cueIndex) renderCue(currentCueIndex, true);
    positionPopover(refs.popover, refs.anchor);
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

  async function requestAiExplanation(refs) {
    if (!settings.learning_ai_explanation || !refs?.cue) return;
    try {
      const payload = await bridgeJson('/learning/explain', {
        method: 'POST',
        body: {
          word: refs.word,
          wordTranslation: refs.primary || '',
          context: refs.cue.text,
          contextTranslation: translationsByText.get(refs.cue.text) || '',
          sourceLang: sourceLanguage(),
          targetLang: settings.learning_target_lang,
        },
      });
      if (!refs.popover.isConnected) return;
      if (!payload?.explanation) throw new Error(payload?.error || 'AI-пояснение недоступно');
      renderAiExplanation(refs, payload.explanation);
    } catch (error) {
      if (!refs.popover.isConnected) return;
      log('word AI explanation failed', { error: error?.message || String(error) });
      renderAiExplanation(refs, 'Пояснение сейчас недоступно.', { error: true });
    }
  }

  function renderExamples(refs) {
    if (!refs?.popover?.isConnected) return;
    const title = document.createElement('div');
    title.className = 'sc-word-section-title';
    title.textContent = 'Примеры: текущее видео';
    refs.examples.replaceChildren(title);
    const examples = U.examplesForTerm(cues, refs.word, refs.cueIndex, 6, sourceLanguage());
    if (!examples.length) {
      const empty = document.createElement('div');
      empty.style.color = '#71717a';
      empty.textContent = 'Других реплик с этим словом нет.';
      refs.examples.appendChild(empty);
    }
    for (const example of examples) {
      const row = document.createElement('div');
      row.className = 'sc-word-example';
      row.appendChild(iconButton('play', 'Проиграть реплику', () => seekCue(example.cueIndex)));
      const body = document.createElement('div');
      const text = document.createElement('div');
      text.className = 'sc-word-example-text';
      highlightTerm(text, example.text, refs.word);
      body.appendChild(text);
      const translated = translationsByText.get(example.text);
      const translatedNode = document.createElement('div');
      translatedNode.className = 'sc-word-example-translation';
      if (translated) {
        highlightTargetTerm(translatedNode, example.text, translated, refs);
      } else if (translationError) {
        translatedNode.classList.add('sc-word-error');
        translatedNode.textContent = 'Перевод временно недоступен';
      } else {
        translatedNode.classList.add('sc-word-skeleton');
        translatedNode.style.cssText = 'height:13px;width:72%;margin-top:7px';
        ensureCueTranslation(example.cueIndex);
      }
      body.appendChild(translatedNode);
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
      refs.examples.appendChild(row);
    }
    positionPopover(refs.popover, refs.anchor);
  }

  function refreshOpenPopoverExamples() {
    const refs = document.getElementById(WORD_POPOVER_ID)?.__scWordRefs;
    if (refs) renderExamples(refs);
  }

  async function openWordPopover(anchor, word, cueIndex) {
    closeWordPopover({ resume: false });
    wordPopoverOpen = true;
    const video = playerVideo();
    if (video && !video.paused) {
      video.pause();
      pausedForSubtitleHover = true;
      hoverPausedCueKey = `${videoMeta.videoId}:${cues[cueIndex]?.startMs ?? cueIndex}`;
    }
    updateHoverHoldState();
    const positionAnchor = fixedAnchorReference(anchor);
    const popover = document.createElement('div');
    popover.id = WORD_POPOVER_ID;
    popover.addEventListener('pointerdown', event => event.stopPropagation());
    popover.addEventListener('selectstart', event => event.preventDefault());
    popover.addEventListener('dragstart', event => event.preventDefault());
    popover.addEventListener('wheel', event => event.stopPropagation(), { passive: true });
    const refs = createWordPopoverShell(popover, positionAnchor, word, cueIndex);
    document.body.appendChild(popover);
    positionPopover(popover, positionAnchor);
    if (currentCueIndex === cueIndex) renderCue(cueIndex, true);
    ensureCueTranslation(cueIndex);
    void publishWordSelection(word, cueIndex);
    void requestAiExplanation(refs);
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
      if (!popover.isConnected) return;
      renderDictionaryContent(refs, dictionary);
      const stored = await learningStore?.getEntry(refs.query).catch(() => null);
      if (stored) applyPopoverState(refs, stored);
      if (stored && stored.state !== 'none' && refs.primary && refs.primary !== stored.translation) {
        const updated = await learningStore.saveMachineTranslation({
          ...refs.query,
          state: stored.state,
          translation: refs.primary,
          contexts: refs.cue ? [cueContext(refs.cue)] : [],
        }).catch(() => null);
        if (updated) applyPopoverState(refs, updated);
      }
    } catch (error) {
      if (!popover.isConnected) return;
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
    const nextVideoId = extractVideoIdFromLocation();
    if (nextVideoId && nextVideoId === videoMeta.videoId) {
      updateGeometry();
      return;
    }
    loadGeneration += 1;
    prefetchGeneration += 1;
    lastTrackIdentity = '';
    lastSnapshotAt = 0;
    cues = [];
    currentCueIndex = -1;
    selectedTrack = null;
    videoMeta = { videoId: '', title: '' };
    translationsByText.clear();
    translationAlignmentsByText.clear();
    pendingTranslationTexts.clear();
    translationError = '';
    autoPausedCueKey = '';
    lastVideoTimeMs = null;
    closeWordPopover();
    deactivateOverlay();
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
      await refreshLearningWordStates({ rerender: false }).catch(() => {});
      learningStore.subscribe(() => refreshLearningWordStates().catch(() => {}));
      learningStore.migrateLegacy()
        .then(() => refreshLearningWordStates())
        .then(() => learningStore.sync())
        .catch(() => {});
    }
    await syncSettingsFromDesktop();
    updateRootSettings();
    await injectMainBridge().catch(error => log('main bridge injection failed', { error: error?.message || error }));
    syncOverlay({ force: true });
    setInterval(() => {
      updateGeometry();
      syncOverlay();
    }, 1_000);
    setInterval(syncSettingsFromDesktop, 2_500);
    requestAnimationFrame(playbackTick);

    window.addEventListener('resize', updateGeometry);
    window.addEventListener('scroll', updateGeometry, { passive: true });
    window.addEventListener('yt-navigate-finish', resetForNavigation);
    window.addEventListener('blur', () => {
      if (settingsPanel) settingsPanel.hidden = true;
      setControlsHovered(false);
    });
    document.addEventListener('keydown', event => {
      const editable = event.target?.closest?.('input, textarea, select, [contenteditable="true"]');
      const cueDelta = U.cueNavigationDelta(event.code);
      if (cueDelta && overlayActive && cues.length && !editable
          && !event.metaKey && !event.ctrlKey && !event.altKey && !event.repeat) {
        event.preventDefault();
        event.stopPropagation();
        seekRelativeCue(cueDelta);
        return;
      }
      if (event.key === 'Escape') {
        if (document.getElementById(WORD_POPOVER_ID)) closeWordPopover();
        else if (phraseSelectionOpen) clearPhraseSelection();
        else if (settingsPanel && !settingsPanel.hidden) {
          settingsPanel.hidden = true;
          root.dataset.controlsVisible = controlHovered ? '1' : '0';
        }
      }
    }, true);
    document.addEventListener('pointerdown', event => {
      const popover = document.getElementById(WORD_POPOVER_ID);
      if (popover && !popover.contains(event.target) && !event.target.closest?.('.sc-learning-word')) closeWordPopover();
      if (phraseSelectionOpen && !event.target.closest?.('.sc-learning-word') && !phraseHint?.contains?.(event.target)) {
        clearPhraseSelection();
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
      settings = sanitizeYoutubeSettings(changes.__yt.newValue || {});
      updateRootSettings();
      if (previousTarget !== settings.learning_target_lang) {
        translationsByText.clear();
        translationAlignmentsByText.clear();
        prefetchGeneration += 1;
        refreshLearningWordStates().catch(() => {});
        if (settings.learning_translation_mode === 'always') startTranslationPrefetch();
      }
      syncOverlay({ force: true });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
