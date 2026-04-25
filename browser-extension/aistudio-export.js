/***
 * SC Browser Parser — AI Studio export content script.
 * Runs in the AI Studio page context, extracts the conversation, and packages
 * it as Markdown (clipboard) or a ZIP (with image attachments) on the popup's
 * "Export" action. Listens for {action:'export'|'getStatus'|'cancel'} from popup.js.
 */

(function () {
  'use strict';

  // Configuration
  // Phase C: fixed sleeps replaced with DOM polling. These are upper bounds — actual waits
  // are much shorter because we exit as soon as the predicate is true.
  const CONFIG = {
    POLL_INTERVAL_MS: 30,    // how often to recheck DOM
    POLL_TIMEOUT_MS: 5000,   // hard cap per wait — if exceeded, we log and continue
    MENU_TIMEOUT_MS: 1500,   // shorter cap for menu open/close (very fast Angular animations)
    RAWMODE_TIMEOUT_MS: 8000,// raw mode toggle on a long conversation can take a beat
    TURN_TIMEOUT_MS: 2500,   // max wait for one turn to hydrate after scrollIntoView
  };

  // Global state
  let isExporting = false;
  let shouldCancel = false;
  const ALLOWED_ACTIONS = new Set(['export', 'getStatus', 'cancel']);

  // Universal logger (loaded from logger.js into the same content-script context).
  const log = (typeof window !== 'undefined' && window.__AISE_LOGGER__) || {
    info: () => {}, log: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    timed: async (_t, _n, fn) => fn(), timer: () => () => 0, domSnapshot: () => {},
    setExportId: () => {}, clearExportId: () => {},
  };
  log.info('boot', 'content script loaded', {
    url: location.href,
    userAgent: navigator.userAgent,
    visibility: document.visibilityState,
    readyState: document.readyState,
  });

  // Utility function to sleep/wait — instrumented to log every blocking sleep so we can grep them later.
  const sleep = (ms, why) => {
    log.debug('sleep', `sleep ${ms}ms`, { ms, why });
    return new Promise(resolve => setTimeout(resolve, ms));
  };

  // Wait until predicate() returns truthy, polling every POLL_INTERVAL_MS, capped at timeoutMs.
  // Logs both START + END (with actual wait_ms + outcome) so the log gives us per-call statistics.
  // Returns the predicate's truthy value, or null on timeout.
  async function waitFor(predicate, why, timeoutMs) {
    const cap = timeoutMs || CONFIG.POLL_TIMEOUT_MS;
    const startedAt = performance.now();
    let attempts = 0;
    // Fast path: predicate already true (Phase C revealed this is the common case for many waits).
    let value;
    try { value = predicate(); } catch (e) {
      log.warn('waitFor', 'predicate threw on first attempt', { why, error: { message: e?.message } });
    }
    if (value) {
      log.debug('waitFor', `${why} — already true`, { wait_ms: 0, attempts: 1 });
      return value;
    }
    while (true) {
      attempts++;
      if (performance.now() - startedAt > cap) {
        log.warn('waitFor', `${why} — TIMEOUT`, { wait_ms: +(performance.now() - startedAt).toFixed(1), attempts, timeoutMs: cap });
        return null;
      }
      await new Promise(r => setTimeout(r, CONFIG.POLL_INTERVAL_MS));
      try { value = predicate(); } catch (e) {
        log.warn('waitFor', 'predicate threw', { why, attempts, error: { message: e?.message } });
        continue;
      }
      if (value) {
        log.debug('waitFor', `${why} — done`, { wait_ms: +(performance.now() - startedAt).toFixed(1), attempts });
        return value;
      }
    }
  }

  // Create and show loading overlay that blocks user input
  function showLoadingOverlay() {
    // Create overlay container
    const overlay = document.createElement('div');
    overlay.id = 'ai-studio-export-overlay';
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.65);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 999999;
      backdrop-filter: blur(8px);
      pointer-events: all;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
    `;

    // Create loading content
    const content = document.createElement('div');
    content.style.cssText = `
      background: #25262b;
      padding: 40px;
      border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
      text-align: center;
      max-width: 400px;
      width: 90%;
      border: 1px solid #2c2e33;
      color: #e9ecef;
    `;

    // Loading spinner
    const spinner = document.createElement('div');
    spinner.style.cssText = `
      width: 50px;
      height: 50px;
      border: 3px solid rgba(102, 126, 234, 0.2);
      border-top: 3px solid #667eea;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 0 auto 24px;
    `;

    // Add spinner animation to head
    if (!document.querySelector('#ai-studio-export-spinner-style')) {
      const style = document.createElement('style');
      style.id = 'ai-studio-export-spinner-style';
      style.textContent = `
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `;
      document.head.appendChild(style);
    }

    // Title
    const title = document.createElement('h2');
    title.textContent = 'Exporting Conversation...';
    title.style.cssText = `
      margin: 0 0 12px 0;
      color: #fff;
      font-size: 20px;
      font-weight: 600;
    `;

    // Status message
    const message = document.createElement('p');
    message.id = 'ai-studio-export-status';
    message.textContent = 'Initializing export process...';
    message.style.cssText = `
      margin: 0;
      color: #a5a5a5;
      font-size: 14px;
      line-height: 1.6;
    `;

    // Progress indicator
    const progressContainer = document.createElement('div');
    progressContainer.style.cssText = `
      margin-top: 24px;
      padding-top: 24px;
      border-top: 1px solid #2c2e33;
    `;

    const progressText = document.createElement('div');
    progressText.id = 'ai-studio-export-progress';
    progressText.textContent = 'Starting...';
    progressText.style.cssText = `
      color: #667eea;
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 20px;
    `;

    // Cancel button
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel Export';
    cancelBtn.style.cssText = `
      background: transparent;
      border: 1px solid #c92a2a;
      color: #ff8787;
      padding: 8px 16px;
      border-radius: 6px;
      font-size: 13px;
      cursor: pointer;
      transition: all 0.2s;
      font-weight: 500;
    `;
    cancelBtn.onmouseover = () => {
      cancelBtn.style.background = 'rgba(201, 42, 42, 0.1)';
    };
    cancelBtn.onmouseout = () => {
      cancelBtn.style.background = 'transparent';
    };
    cancelBtn.onclick = () => {
      shouldCancel = true;
      cancelBtn.textContent = 'Cancelling...';
      cancelBtn.disabled = true;
      cancelBtn.style.opacity = '0.7';
      cancelBtn.style.cursor = 'not-allowed';
    };

    progressContainer.appendChild(progressText);
    progressContainer.appendChild(cancelBtn);

    // Assemble content
    content.appendChild(spinner);
    content.appendChild(title);
    content.appendChild(message);
    content.appendChild(progressContainer);

    // Assemble overlay
    overlay.appendChild(content);

    // Click on the dimmed area dismisses the overlay ONLY in finished states (success/error).
    // While export is running, only the explicit Cancel button stops it.
    overlay.dataset.state = 'progress';
    overlay.addEventListener('click', (e) => {
      if (e.target !== overlay) return;
      if (overlay.dataset.state === 'success' || overlay.dataset.state === 'error') {
        hideLoadingOverlay();
      }
    });
    overlay.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
    content.addEventListener('click', (e) => e.stopPropagation());

    document.body.appendChild(overlay);

    return overlay;
  }

  // Update loading overlay status
  function updateLoadingStatus(message, progress) {
    const statusEl = document.getElementById('ai-studio-export-status');
    const progressEl = document.getElementById('ai-studio-export-progress');

    if (statusEl) {
      statusEl.textContent = message;
    }

    if (progressEl && progress) {
      progressEl.textContent = progress;
    }
  }

  // Hide and remove loading overlay
  function hideLoadingOverlay() {
    const overlay = document.getElementById('ai-studio-export-overlay');
    if (overlay) {
      overlay.style.opacity = '0';
      overlay.style.transition = 'opacity 0.3s ease';
      setTimeout(() => overlay.remove(), 300);
    }
  }

  // Replace overlay content with an error message and a Close button. Stays open until user dismisses.
  function showErrorInOverlay(errorMessage) {
    const overlay = document.getElementById('ai-studio-export-overlay');
    if (!overlay) return;
    overlay.dataset.state = 'error';
    const content = overlay.firstChild;
    if (!content) return;
    content.innerHTML = '';

    const icon = document.createElement('div');
    icon.style.cssText = 'font-size: 40px; margin-bottom: 12px;';
    icon.textContent = '⚠️';

    const title = document.createElement('h2');
    title.textContent = 'Экспорт прерван';
    title.style.cssText = 'margin: 0 0 12px 0; color: #ff8787; font-size: 18px; font-weight: 600;';

    const message = document.createElement('p');
    message.textContent = errorMessage;
    message.style.cssText = 'margin: 0 0 20px 0; color: #e9ecef; font-size: 13px; line-height: 1.5; text-align: left; white-space: pre-wrap;';

    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Закрыть';
    closeBtn.style.cssText = 'background: #c92a2a; color: white; border: none; padding: 8px 20px; border-radius: 6px; font-size: 13px; cursor: pointer; font-weight: 500;';
    closeBtn.onclick = () => {
      overlay.style.opacity = '0';
      overlay.style.transition = 'opacity 0.3s ease';
      setTimeout(() => overlay.remove(), 300);
    };

    content.appendChild(icon);
    content.appendChild(title);
    content.appendChild(message);
    content.appendChild(closeBtn);
  }

  function showSuccessInOverlay(messageText) {
    const overlay = document.getElementById('ai-studio-export-overlay');
    if (!overlay) return;
    overlay.dataset.state = 'success';
    const content = overlay.firstChild;
    if (!content) return;
    content.innerHTML = '';

    const icon = document.createElement('div');
    icon.style.cssText = 'font-size: 40px; margin-bottom: 12px;';
    icon.textContent = '✅';

    const title = document.createElement('h2');
    title.textContent = 'Готово';
    title.style.cssText = 'margin: 0 0 12px 0; color: #69db7c; font-size: 18px; font-weight: 600;';

    const message = document.createElement('p');
    message.textContent = messageText;
    message.style.cssText = 'margin: 0 0 20px 0; color: #e9ecef; font-size: 13px; line-height: 1.5; white-space: pre-wrap;';

    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Закрыть';
    closeBtn.style.cssText = 'background: #2b8a3e; color: white; border: none; padding: 8px 20px; border-radius: 6px; font-size: 13px; cursor: pointer; font-weight: 500;';
    closeBtn.onclick = hideLoadingOverlay;

    content.appendChild(icon);
    content.appendChild(title);
    content.appendChild(message);
    content.appendChild(closeBtn);
  }

  // Extract user message text from ms-text-chunk element
  function extractUserMessageText(chatTurn) {
    const textChunk = chatTurn.querySelector('ms-text-chunk');
    if (textChunk) {
      return textChunk.innerText.trim();
    }
    return '';
  }

  // Extract model/agent message text from ms-text-chunk element.
  // Research and Deep Research modes nest reasoning text inside ms-thought-chunk or
  // ms-thought-activity-chunk. Those wrappers' inner ms-text-chunk is REASONING, not response —
  // skip it. Take the FIRST ms-text-chunk that is NOT inside either wrapper. If everything is
  // inside a thought-* wrapper, the turn is a pure-reasoning turn and we return '' (caller
  // handles it via the reasoning extractor).
  function extractModelMessageText(chatTurn) {
    const allTextChunks = chatTurn.querySelectorAll('ms-text-chunk');
    for (const tc of allTextChunks) {
      if (tc.closest('ms-thought-chunk')) continue;
      if (tc.closest('ms-thought-activity-chunk')) continue;
      return tc.innerText.trim();
    }
    return '';
  }

  // Convert blob URL to base64
  async function blobUrlToBase64(blobUrl) {
    const t = log.timer();
    try {
      const fetchT = log.timer();
      const response = await fetch(blobUrl);
      const fetchMs = fetchT();
      const blob = await response.blob();
      log.debug('blob', 'fetched blob', { fetch_ms: fetchMs, blob_size: blob.size, blob_type: blob.type, blobUrl: blobUrl.slice(0, 80) });

      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          log.debug('blob', 'base64 conversion done', { total_ms: t(), result_len: reader.result?.length || 0 });
          resolve(reader.result);
        };
        reader.onerror = (e) => {
          log.error('blob', 'FileReader error', { error: { message: String(e) } });
          reject(e);
        };
        reader.readAsDataURL(blob);
      });
    } catch (error) {
      log.error('blob', 'blobUrlToBase64 failed', { error, blobUrl: blobUrl.slice(0, 80), total_ms: t() });
      return null;
    }
  }

  // Extract image from user message
  async function extractUserImage(chatTurn) {
    const imgElement = chatTurn.querySelector('img.loaded-image');
    if (!imgElement) {
      return null;
    }

    const src = imgElement.getAttribute('src');
    const alt = imgElement.getAttribute('alt') || 'image.jpg';

    if (src && src.startsWith('blob:')) {
      const base64Data = await blobUrlToBase64(src);
      return {
        alt: alt,
        base64: base64Data,
        filename: alt
      };
    }

    return null;
  }

  // Extract attachment from user message
  async function extractUserAttachment(chatTurn, settings) {
    const fileChunk = chatTurn.querySelector('ms-file-chunk');
    if (!fileChunk) {
      return null;
    }

    // Get file name/text
    let fileName = 'attachment';
    if (settings.scrapeAttachmentTitle) {
      const nameSpan = fileChunk.querySelector('span');
      fileName = nameSpan ? nameSpan.innerText.trim() : 'attachment';
    }

    // Get file size/tokens info
    let fileInfo = '';
    if (settings.scrapeAttachmentSize) {
      const fileChunkContainer = fileChunk.querySelector('.file-chunk-container');
      if (fileChunkContainer) {
        const lastChild = fileChunkContainer.lastChild;
        if (lastChild) {
          fileInfo = lastChild.innerText || '';
        }
      }
    }

    // Try to get preview image
    let previewBase64 = null;
    if (settings.scrapeAttachmentPreview) {
      const previewImg = fileChunk.querySelector('img');
      if (previewImg) {
        const imgSrc = previewImg.getAttribute('src');
        if (imgSrc) {
          if (imgSrc.startsWith('blob:')) {
            // Handle blob URLs
            previewBase64 = await blobUrlToBase64(imgSrc);
          } else if (imgSrc.startsWith('http://') || imgSrc.startsWith('https://')) {
            // Handle HTTP/HTTPS URLs (e.g., Google Drive links)
            try {
              const response = await fetch(imgSrc);
              const blob = await response.blob();
              previewBase64 = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
              });
            } catch (error) {
              console.error('Error downloading preview image:', error);
            }
          }
        }
      }
    }

    return {
      fileName: fileName,
      fileInfo: fileInfo,
      previewBase64: previewBase64
    };
  }

  // Extract reasoning text from a model/agent turn.
  // Three AI Studio layouts seen so far:
  //  - Deep Research (Apr-2026+): <ms-thought-activity-chunk> wraps reasoning. Inside there's
  //    <ms-activity-panel> header (chevron + "Thoughts" label) and ms-text-chunk with the text.
  //  - Mid-2025 research: <ms-thought-chunk> (own component with built-in panel).
  //  - Pre-research legacy: <.mat-expansion-panel-body><ms-text-chunk> (chevron expand-collapse).
  // In all three the text is ALREADY in DOM (panel is `content collapsed` but rendered). We
  // never click — the previous "fallback chevron click" path was a 5-sec timeout pit on the new
  // layout because `chevron_right` icons appear in every ms-activity-panel header, including
  // tool-activity ones, and the legacy `.mat-expansion-panel-body` never appears.
  async function extractReasoningText(chatTurn, parentTag) {
    const tag = `${parentTag || 'reasoning'}/reasoning`;

    // Deep Research layout (current). thought-activity-chunk is the canonical wrapper now.
    const thoughtActivity = chatTurn.querySelector('ms-thought-activity-chunk');
    if (thoughtActivity) {
      const innerText = thoughtActivity.querySelector('ms-text-chunk');
      const text = (innerText ? innerText.textContent : thoughtActivity.textContent)
        .replace(/^\s+/, '').replace(/\s+$/, '');
      log.debug(tag, 'reasoning extracted from ms-thought-activity-chunk', { text_len: text.length });
      return text;
    }

    // Mid-2025 layout — ms-thought-chunk wraps reasoning text directly.
    const thoughtChunk = chatTurn.querySelector('ms-thought-chunk');
    if (thoughtChunk) {
      const innerText = thoughtChunk.querySelector('ms-text-chunk');
      const text = (innerText ? innerText.textContent : thoughtChunk.textContent)
        .replace(/^\s+/, '').replace(/\s+$/, '');
      log.debug(tag, 'reasoning extracted from ms-thought-chunk', { text_len: text.length });
      return text;
    }

    // Legacy layout: panel already rendered.
    const panel = chatTurn.querySelector('.mat-expansion-panel-body ms-text-chunk');
    if (panel) {
      const text = panel.textContent.replace(/^\s+/, '').replace(/\s+$/, '');
      log.debug(tag, 'reasoning extracted from legacy panel', { text_len: text.length });
      return text;
    }

    log.debug(tag, 'no reasoning wrapper found — turn has no reasoning');
    return null;
  }

  // Get settings from storage
  function getSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(
        { ...AI_STUDIO_DEFAULT_SETTINGS, __export: EXPORT_DEFAULT_SETTINGS },
        (settings) => {
          const s = sanitizeSettings(settings);
          s.__export = sanitizeExportSettings(settings.__export || {});
          resolve(s);
        }
      );
    });
  }

  async function copyTextToClipboard(text) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      return document.execCommand('copy');
    } finally {
      document.body.removeChild(ta);
    }
  }

  // Predicate: this <ms-chat-turn> has rendered its inner content (Angular's lazy/virtual scroll
  // populates these on demand).
  // Why: `[data-turn-role]` is rendered in the SKELETON before hydration — not a hydration
  // signal. Baseline log ("turnRoles:63" with "textChunks:6" right after scan) proved this.
  // Real signals = ms-text-chunk / ms-file-chunk / img.loaded-image / expansion-panel-body /
  // ms-thought-chunk (research reasoning) / ms-tool-activity-chunk (Google Search and other
  // tool-use turns in Deep Research mode).
  function turnHasRenderedContent(chatTurn) {
    return !!(
      chatTurn.querySelector('ms-text-chunk') ||
      chatTurn.querySelector('ms-file-chunk') ||
      chatTurn.querySelector('img.loaded-image') ||
      chatTurn.querySelector('.mat-expansion-panel-body') ||
      chatTurn.querySelector('ms-thought-chunk') ||
      chatTurn.querySelector('ms-thought-activity-chunk') ||
      chatTurn.querySelector('ms-tool-activity-chunk')
    );
  }

  // Extract Google Search / tool-activity data from a Deep Research Agent turn.
  // Structure observed in deep-research-preview-04-2026:
  //   <ms-tool-activity-chunk>
  //     <ms-activity-panel> ... chips with query text ... </ms-activity-panel>
  //     <ms-search-entry-point> ... Google "Search Suggestions" widget ... </ms-search-entry-point>
  //   </ms-tool-activity-chunk>
  // We try to pull human-readable queries; if structure is too opaque, fall back to a count.
  // Always logs innerHTMLSample so we can iterate the extractor without re-running export.
  function extractToolActivity(chatTurn, turnTag) {
    const activity = chatTurn.querySelector('ms-tool-activity-chunk');
    if (!activity) return null;
    const panel = activity.querySelector('ms-activity-panel');
    const searchEntry = activity.querySelector('ms-search-entry-point');

    // Try to pull every chip-like leaf with non-trivial text. Filter UI noise.
    const NOISE = new Set([
      '', 'search', 'check', 'chevron_right', 'chevron_left', 'more_vert',
      'Google Search', 'Google Search Suggestions', 'Display of Suggestions',
      'Display of Suggestions required when using Google Search Suggestions, click for more info',
      'Learn more',
    ]);
    const queries = [];
    const seen = new Set();
    const candidates = activity.querySelectorAll('button, a, span, div');
    for (const el of candidates) {
      // skip if element has element children (we want leaf-ish text nodes)
      if (el.children.length > 0) continue;
      const txt = (el.textContent || '').trim();
      if (!txt) continue;
      if (NOISE.has(txt)) continue;
      // Filter material-icons spans (their textContent is the icon ligature name)
      if (el.classList && el.classList.contains('material-symbols-outlined')) continue;
      if (el.classList && el.classList.contains('material-icons')) continue;
      if (txt.length < 2) continue;
      // Soft de-dupe + cap queries collected per turn
      if (seen.has(txt)) continue;
      seen.add(txt);
      queries.push(txt);
      if (queries.length >= 12) break;
    }

    // Always emit a sample for the first few turns so we can iterate offline.
    log.info(turnTag + '/tool-activity', 'tool-activity snapshot', {
      hasPanel: !!panel,
      hasSearchEntry: !!searchEntry,
      queries,
      queryCount: queries.length,
      innerHTMLSample: activity.innerHTML.slice(0, 3000),
    });

    return { queries };
  }

  // Process a single chat turn
  async function processChatTurn(chatTurn, imageCounter, settings, turnIdx) {
    const turnTag = `turn[${turnIdx}]`;

    // Phase C: replaced fixed sleep(700) with scrollIntoView + waitFor(content rendered).
    // Baseline log showed "textChunks:6" out of "chatTurns:63" before scrolling — Angular
    // virtualizes turn contents. We need the scroll, but we don't need to guess at 700ms.
    // TURN_TIMEOUT_MS is shorter than POLL_TIMEOUT_MS — if a turn truly has no content
    // (rare), don't burn 5 sec per empty turn.
    chatTurn.scrollIntoView({ block: 'center' });
    await waitFor(() => turnHasRenderedContent(chatTurn), `${turnTag}-content-rendered`, CONFIG.TURN_TIMEOUT_MS);

    const turnContainer = chatTurn.querySelector('[data-turn-role]');
    if (!turnContainer) {
      log.warn(turnTag, 'no [data-turn-role] container — skipping turn');
      return null;
    }

    const role = turnContainer.getAttribute('data-turn-role');
    // Snapshot what's in this turn — these counts let us tell apart "Angular not rendered yet"
    // vs "this turn has no images". Any future bug ("turn skipped") becomes obvious from here.
    const snapshot = {
      role,
      textChunkCount: chatTurn.querySelectorAll('ms-text-chunk').length,
      fileChunkCount: chatTurn.querySelectorAll('ms-file-chunk').length,
      imageChunkCount: chatTurn.querySelectorAll('ms-image-chunk').length,
      loadedImageCount: chatTurn.querySelectorAll('img.loaded-image').length,
      chevronCount: Array.from(chatTurn.querySelectorAll('span')).filter(s => s.textContent.trim() === 'chevron_right').length,
      expansionPanelCount: chatTurn.querySelectorAll('.mat-expansion-panel-body').length,
      promptChunkCount: chatTurn.querySelectorAll('ms-prompt-chunk').length,
      thoughtChunkCount: chatTurn.querySelectorAll('ms-thought-chunk').length,
      thoughtActivityChunkCount: chatTurn.querySelectorAll('ms-thought-activity-chunk').length,
      toolActivityChunkCount: chatTurn.querySelectorAll('ms-tool-activity-chunk').length,
      searchEntryCount: chatTurn.querySelectorAll('ms-search-entry-point').length,
      // Full inventory of ms-* tags (any custom chunk type research mode might introduce)
      msChildTagsInOrder: Array.from(chatTurn.querySelectorAll('*'))
        .map(e => e.tagName.toLowerCase())
        .filter(t => t.startsWith('ms-'))
        .slice(0, 50),
    };
    log.debug(turnTag, 'turn snapshot', snapshot);

    if (role === 'User') {
      // Check for image first (if enabled)
      if (settings.scrapeImages) {
        const imageData = await log.timed(turnTag, 'extractUserImage', () => extractUserImage(chatTurn));
        if (imageData) {
          log.info(turnTag, 'matched: user image', {
            hasBase64: !!imageData.base64,
            base64Len: imageData.base64 ? imageData.base64.length : 0,
            filename: imageData.filename,
          });
          return { type: 'user', contentType: 'image', image: imageData };
        }
      } else {
        // Image scraping is OFF, but the turn might still BE an image — emit a placeholder
        // so the message isn't silently dropped from the conversation. Detected via
        // <ms-image-chunk> + <img class="loaded-image"> per DOM analysis.
        const imgEl = chatTurn.querySelector('ms-image-chunk img.loaded-image, img.loaded-image');
        if (imgEl) {
          const altText = imgEl.getAttribute('alt') || 'image';
          log.info(turnTag, 'matched: user image (skipped — placeholder)', { alt: altText });
          return { type: 'user', contentType: 'image-placeholder', alt: altText };
        }
      }

      if (settings.scrapeAttachments) {
        const attachmentData = await log.timed(turnTag, 'extractUserAttachment', () => extractUserAttachment(chatTurn, settings));
        if (attachmentData) {
          log.info(turnTag, 'matched: user attachment', {
            fileName: attachmentData.fileName,
            fileInfo: attachmentData.fileInfo,
            hasPreview: !!attachmentData.previewBase64,
          });
          return { type: 'user', contentType: 'attachment', attachment: attachmentData };
        }
      } else {
        // Same logic for attachments — placeholder if user disabled scraping.
        const fileEl = chatTurn.querySelector('ms-file-chunk');
        if (fileEl) {
          const nameSpan = fileEl.querySelector('span');
          const fileName = nameSpan ? nameSpan.innerText.trim() : 'attachment';
          log.info(turnTag, 'matched: user attachment (skipped — placeholder)', { fileName });
          return { type: 'user', contentType: 'attachment-placeholder', fileName };
        }
      }

      const text = extractUserMessageText(chatTurn);
      if (text) {
        log.info(turnTag, 'matched: user text', { textLen: text.length });
        return { type: 'user', contentType: 'text', text: text };
      }

      // Empty user turn (rare but possible — e.g. message just submitted, model still processing).
      const tcs = chatTurn.querySelectorAll('ms-text-chunk');
      const allEmpty = tcs.length > 0 && Array.from(tcs).every(tc => tc.textContent.trim().length === 0);
      if (allEmpty || (chatTurn.querySelector('ms-prompt-chunk') && tcs.length === 0)) {
        log.warn(turnTag, 'matched: empty user turn (skeleton)', { textChunkCount: tcs.length });
        return { type: 'user', contentType: 'empty-turn' };
      }

      log.error(turnTag, 'user turn matched nothing — POSSIBLE DATA LOSS', {
        innerHTMLSample: chatTurn.innerHTML.slice(0, 3000),
      });
      return null;
    } else if (role === 'Model' || role === 'Agent') {
      // Deep Research Preview (Apr-21-2026) uses role="Agent" for every turn that the model
      // produces (reasoning / tool-use / response). We treat Model and Agent the same way —
      // they only differ in the markdown role label.
      const roleType = role === 'Agent' ? 'agent' : 'model';

      // Tool-activity turns (Google Search etc.) sit alone in their own ms-chat-turn — no
      // ms-text-chunk and no ms-thought-chunk. Check this BEFORE other extractors so we don't
      // misfire on "no text" path.
      const toolActivity = chatTurn.querySelector('ms-tool-activity-chunk');
      if (toolActivity) {
        if (settings.scrapeReasoning) {
          const data = extractToolActivity(chatTurn, turnTag);
          log.info(turnTag, 'matched: tool-activity', { queries: data?.queries?.length || 0, role });
          return { type: roleType, contentType: 'tool-activity', queries: data?.queries || [] };
        }
        log.info(turnTag, 'matched: tool-activity (skipped — reasoning OFF)', { role });
        return { type: roleType, contentType: 'tool-activity-placeholder' };
      }

      if (settings.scrapeReasoning) {
        const reasoningText = await log.timed(turnTag, 'extractReasoningText', () => extractReasoningText(chatTurn, turnTag));
        if (reasoningText) {
          log.info(turnTag, 'matched: model reasoning', { textLen: reasoningText.length, role });
          return { type: roleType, contentType: 'reasoning', text: reasoningText };
        }
      }

      const text = extractModelMessageText(chatTurn);
      if (text) {
        log.info(turnTag, 'matched: model response', { textLen: text.length, role });
        return { type: roleType, contentType: 'response', text: text };
      }

      // Model can also produce images (research mode generates them as ms-image-chunk).
      const modelImg = chatTurn.querySelector('ms-image-chunk img.loaded-image, img.loaded-image');
      if (modelImg) {
        const altText = modelImg.getAttribute('alt') || 'image';
        if (settings.scrapeImages) {
          const src = modelImg.getAttribute('src');
          if (src && src.startsWith('blob:')) {
            const base64 = await log.timed(turnTag, 'model-image blobToBase64', () => blobUrlToBase64(src));
            log.info(turnTag, 'matched: model image', { hasBase64: !!base64, alt: altText, role });
            return { type: roleType, contentType: 'image', image: { alt: altText, base64, filename: altText } };
          }
        }
        log.info(turnTag, 'matched: model image (skipped — placeholder)', { alt: altText, role });
        return { type: roleType, contentType: 'image-placeholder', alt: altText };
      }

      // Distinguish "rerun skeleton / abandoned turn" (legit empty) from real data loss.
      // Rerun skeleton: structure is correct (prompt-chunk + text-chunk) but textContent is "".
      // Real data loss: structure is bizarre (no chunks at all, or unrecognized child tags).
      const allTextChunks = chatTurn.querySelectorAll('ms-text-chunk');
      const allTextChunksEmpty = allTextChunks.length > 0 &&
        Array.from(allTextChunks).every(tc => tc.textContent.trim().length === 0);
      const hasOnlySkeletonChunks =
        chatTurn.querySelector('ms-prompt-chunk') &&
        (allTextChunksEmpty || allTextChunks.length === 0) &&
        !chatTurn.querySelector('ms-image-chunk') &&
        !chatTurn.querySelector('ms-file-chunk') &&
        !chatTurn.querySelector('ms-tool-activity-chunk') &&
        !chatTurn.querySelector('ms-thought-chunk') &&
        !chatTurn.querySelector('ms-thought-activity-chunk');

      if (hasOnlySkeletonChunks) {
        log.warn(turnTag, 'matched: empty model turn (rerun skeleton or abandoned)', {
          textChunkCount: allTextChunks.length,
          allEmpty: allTextChunksEmpty,
          role,
        });
        return { type: roleType, contentType: 'empty-turn' };
      }

      // Deep Research no-op turn: ONLY ms-chat-turn-options (the three-dot menu), no prompt-chunk,
      // no text-chunk, no thought-*, no tool-activity, no image. Observed as abandoned/no-op
      // turn that Angular kept in chat hierarchy without ever hydrating. The virtual-scroll
      // placeholder (`height:100px`+ `<!---->`) stays forever — waitFor times out. Treat as
      // empty-turn placeholder so the gate doesn't tear the export down.
      const msChildren = Array.from(chatTurn.querySelectorAll('*'))
        .map(e => e.tagName.toLowerCase())
        .filter(t => t.startsWith('ms-'));
      const onlyTurnOptions = msChildren.length > 0 &&
        msChildren.every(t => t === 'ms-chat-turn-options');
      if (onlyTurnOptions) {
        log.warn(turnTag, 'matched: no-op turn (only chat-turn-options, no content chunks)', {
          role,
          msChildrenCount: msChildren.length,
        });
        return { type: roleType, contentType: 'empty-turn' };
      }

      log.error(turnTag, 'model turn matched nothing — POSSIBLE DATA LOSS', {
        role,
        innerHTMLSample: chatTurn.innerHTML.slice(0, 3000),
      });
    }

    return null;
  }

  // Check if raw mode is already enabled
  function isRawModeEnabled() {
    return document.body.innerHTML.includes("Show conversation with markdown formatting");
  }

  function getMoreActionsButton() {
    return document.querySelector('button[aria-label="View more actions"]');
  }

  function getRawOutputToggleButton() {
    return document.querySelector('button[aria-label="Toggle viewing raw output"]');
  }

  async function ensureMoreActionsMenuOpen() {
    const moreActionsButton = getMoreActionsButton();
    log.debug('menu', 'getMoreActionsButton', { found: !!moreActionsButton });
    if (!moreActionsButton) {
      throw new Error('Could not find "View more actions" button');
    }

    let rawOutputButton = getRawOutputToggleButton();
    if (rawOutputButton) {
      log.debug('menu', 'menu already open');
      return { moreActionsButton, rawOutputButton };
    }

    moreActionsButton.click();
    // Phase C: poll for the raw-output toggle to appear instead of fixed sleep(140ms).
    rawOutputButton = await waitFor(() => getRawOutputToggleButton(), 'menu-rawOutputBtn-appears', CONFIG.MENU_TIMEOUT_MS);
    if (!rawOutputButton) {
      throw new Error('Could not find "Toggle viewing raw output" button');
    }
    return { moreActionsButton, rawOutputButton };
  }

  async function closeMoreActionsMenuIfOpen() {
    if (!getRawOutputToggleButton()) {
      log.debug('menu', 'menu already closed');
      return;
    }
    const moreActionsButton = getMoreActionsButton();
    if (!moreActionsButton) {
      log.warn('menu', 'menu open but no moreActions button to close it');
      return;
    }
    moreActionsButton.click();
    // Phase C: poll for the raw-output toggle to disappear instead of fixed sleep(140ms).
    await waitFor(() => !getRawOutputToggleButton(), 'menu-rawOutputBtn-gone', CONFIG.MENU_TIMEOUT_MS);
  }

  // Main export function
  async function exportConversation() {
    if (isExporting) {
      log.warn('export', 'export rejected — already in progress');
      return { success: false, message: 'Export already in progress' };
    }

    const exportId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    log.setExportId(exportId);
    const totalTimer = log.timer();
    log.info('export', 'EXPORT START', { exportId, url: location.href });

    try {
      isExporting = true;
      shouldCancel = false;

      // Load settings
      const settings = await log.timed('export', 'getSettings', () => getSettings());
      log.info('export', 'settings loaded', settings);

      // Show loading overlay
      log.timed('export', 'showLoadingOverlay', () => Promise.resolve(showLoadingOverlay()));
      updateLoadingStatus('Enabling raw output mode...', 'Step 1/4: Setup');

      // Step 1: Check initial raw mode state and toggle if needed
      log.info('rawmode', 'STEP 1 START — check raw mode');
      log.domSnapshot('rawmode', 'before-step1', {
        moreActionsBtn: 'button[aria-label="View more actions"]',
        rawOutputBtn: 'button[aria-label="Toggle viewing raw output"]',
      });

      let initialRawModeEnabled = false;
      try {
        const { rawOutputButton } = await log.timed('rawmode', 'ensureMoreActionsMenuOpen', () => ensureMoreActionsMenuOpen());

        // Store the initial state (true = already on, false = currently off)
        initialRawModeEnabled = isRawModeEnabled();
        log.info('rawmode', 'initial raw mode state', { initialRawModeEnabled });

        // Toggle raw mode only if it's not already enabled
        if (!initialRawModeEnabled) {
          log.info('rawmode', 'clicking raw output toggle ON');
          rawOutputButton.click();
          // Phase C: poll for "Show conversation with markdown formatting" to appear
          // (the body text changes only after raw mode is fully enabled). Replaces sleep(3500).
          const ok = await waitFor(() => isRawModeEnabled(), 'rawmode-enabled', CONFIG.RAWMODE_TIMEOUT_MS);
          log.info('rawmode', 'raw mode after toggle', { rawModeAfterToggle: !!ok });
          if (!ok) throw new Error('Failed to enable raw output mode');
        } else {
          log.info('rawmode', 'raw mode already ON, skipping toggle');
        }
      } finally {
        await log.timed('rawmode', 'closeMoreActionsMenuIfOpen', () => closeMoreActionsMenuIfOpen());
      }
      log.info('rawmode', 'STEP 1 DONE');


      if (shouldCancel) throw new Error('Export cancelled by user');

      // Step 2: Find all chat turns
      updateLoadingStatus('Scanning conversation...', 'Step 2/4: Scanning');
      log.info('scan', 'STEP 2 START — querySelectorAll(ms-chat-turn)');
      const scanTimer = log.timer();
      const chatTurns = document.querySelectorAll('ms-chat-turn');
      log.info('scan', 'chat turns found', { count: chatTurns.length, query_ms: scanTimer() });
      log.domSnapshot('scan', 'after-scan', {
        chatTurns: 'ms-chat-turn',
        textChunks: 'ms-text-chunk',
        fileChunks: 'ms-file-chunk',
        loadedImages: 'img.loaded-image',
        turnRoles: '[data-turn-role]',
      });

      if (chatTurns.length === 0) {
        throw new Error('No chat turns found');
      }

      if (shouldCancel) throw new Error('Export cancelled by user');

      // Step 3: Process all chat turns
      updateLoadingStatus('Extracting messages and images...', `Step 3/4: Processing (0/${chatTurns.length})`);
      log.info('process', 'STEP 3 START — process turns', { total: chatTurns.length });
      const step3Timer = log.timer();
      const conversationData = [];
      const images = [];
      let imageCounter = 0;

      // Track turns where we found NOTHING — this is the data-loss signal we surface to the user.
      const skippedTurnIndices = [];

      for (let i = 0; i < chatTurns.length; i++) {
        if (shouldCancel) throw new Error('Export cancelled by user');

        updateLoadingStatus(
          'Extracting messages and images...',
          `Step 3/4: Processing (${i + 1}/${chatTurns.length})`
        );
        const turnTimer = log.timer();
        log.debug('turn', `turn ${i + 1}/${chatTurns.length} START`);
        const turnData = await processChatTurn(chatTurns[i], imageCounter, settings, i);
        log.info('turn', `turn ${i + 1}/${chatTurns.length} END`, {
          duration_ms: turnTimer(),
          contentType: turnData?.contentType || null,
          type: turnData?.type || null,
          textLen: typeof turnData?.text === 'string' ? turnData.text.length : null,
        });

        if (turnData) {
          if (turnData.contentType === 'image') {
            imageCounter++;
            const imageName = `image-${imageCounter}.jpg`;
            images.push({ name: imageName, base64: turnData.image.base64 });
            // Preserve role (user OR model OR agent — research mode lets the model produce images too).
            conversationData.push({ type: turnData.type, contentType: 'image', imageName: imageName });
          } else if (turnData.contentType === 'image-placeholder') {
            conversationData.push({ type: turnData.type, contentType: 'image-placeholder', alt: turnData.alt });
          } else if (turnData.contentType === 'attachment') {
            const attachment = turnData.attachment;
            if (attachment.previewBase64) {
              imageCounter++;
              const previewName = `image-${imageCounter}.jpg`;
              images.push({ name: previewName, base64: attachment.previewBase64 });
              conversationData.push({
                type: 'user',
                contentType: 'attachment',
                fileName: attachment.fileName,
                fileInfo: attachment.fileInfo,
                previewName: previewName,
              });
            } else {
              conversationData.push({
                type: 'user',
                contentType: 'attachment',
                fileName: attachment.fileName,
                fileInfo: attachment.fileInfo,
                previewName: null,
              });
            }
          } else if (turnData.contentType === 'attachment-placeholder') {
            conversationData.push({ type: 'user', contentType: 'attachment-placeholder', fileName: turnData.fileName });
          } else if (turnData.contentType === 'empty-turn') {
            // Skeleton turn (rerun, abandoned). NOT data loss — render as visible marker.
            conversationData.push({ type: turnData.type, contentType: 'empty-turn' });
          } else if (turnData.contentType === 'tool-activity') {
            conversationData.push({ type: turnData.type, contentType: 'tool-activity', queries: turnData.queries });
          } else if (turnData.contentType === 'tool-activity-placeholder') {
            conversationData.push({ type: turnData.type, contentType: 'tool-activity-placeholder' });
          } else {
            conversationData.push(turnData);
          }
        } else {
          // turnData === null = matched nothing AND no recognizable skeleton. Real data loss.
          skippedTurnIndices.push(i + 1); // 1-based for human reading
        }
      }

      log.info('process', 'STEP 3 DONE', {
        duration_ms: step3Timer(),
        turns: conversationData.length,
        images: images.length,
        skipped: skippedTurnIndices.length,
        skippedIndices: skippedTurnIndices,
      });

      // Hard determinism gate: if any turn was matched-nothing, refuse to download.
      // The user explicitly asked: "если что-то пропускается, файл не скачивается".
      if (skippedTurnIndices.length > 0) {
        log.error('export', 'ABORTING — turns were skipped (data loss)', {
          skipped: skippedTurnIndices.length,
          skippedIndices: skippedTurnIndices,
          totalTurns: chatTurns.length,
        });
        throw new Error(
          `Пропущено ${skippedTurnIndices.length} из ${chatTurns.length} сообщений ` +
          `(индексы: ${skippedTurnIndices.slice(0, 10).join(', ')}${skippedTurnIndices.length > 10 ? '…' : ''}). ` +
          `Файл НЕ скачан. Обновите страницу AI Studio (F5), затем повторите экспорт. ` +
          `Если проблема повторяется — пришлите logs/exporter-*.log разработчику.`
        );
      }

      if (shouldCancel) throw new Error('Export cancelled by user');

      // Step 4: Generate Markdown and create ZIP
      updateLoadingStatus('Creating ZIP file...', 'Step 4/4: Packaging');
      log.info('zip', 'STEP 4 START — generate markdown + ZIP');

      // Get conversation title and token size
      const titleElement = document.querySelector('.actions.pointer.mode-title');
      const tokenElement = document.querySelector('.token-container');
      const conversationTitle = titleElement ? titleElement.innerText.trim() : 'Untitled Conversation';
      const tokenSize = tokenElement ? tokenElement.innerText.trim() : 'Unknown';
      log.info('zip', 'metadata', { titleFound: !!titleElement, tokenFound: !!tokenElement, conversationTitle, tokenSize });

      // Compose summary: counts by type, so the user can see at a glance what was captured.
      // 'agent_*' counters apply to Deep Research turns (role="Agent"); 'model_*' to legacy
      // chats (role="Model"). They are tracked separately so the user can see whether they're
      // working with a Deep Research export or a classic one.
      const stats = {
        user_text: 0, user_image: 0, user_image_skipped: 0,
        user_attachment: 0, user_attachment_skipped: 0,
        model_response: 0, model_reasoning: 0, model_image: 0, model_image_skipped: 0,
        agent_response: 0, agent_reasoning: 0, agent_image: 0, agent_image_skipped: 0,
        agent_tool_activity: 0, agent_tool_activity_skipped: 0,
      };
      for (const item of conversationData) {
        if (item.type === 'user') {
          if (item.contentType === 'text') stats.user_text++;
          else if (item.contentType === 'image') stats.user_image++;
          else if (item.contentType === 'image-placeholder') stats.user_image_skipped++;
          else if (item.contentType === 'attachment') stats.user_attachment++;
          else if (item.contentType === 'attachment-placeholder') stats.user_attachment_skipped++;
        } else if (item.type === 'model') {
          if (item.contentType === 'response') stats.model_response++;
          else if (item.contentType === 'reasoning') stats.model_reasoning++;
          else if (item.contentType === 'image') stats.model_image++;
          else if (item.contentType === 'image-placeholder') stats.model_image_skipped++;
        } else if (item.type === 'agent') {
          if (item.contentType === 'response') stats.agent_response++;
          else if (item.contentType === 'reasoning') stats.agent_reasoning++;
          else if (item.contentType === 'image') stats.agent_image++;
          else if (item.contentType === 'image-placeholder') stats.agent_image_skipped++;
          else if (item.contentType === 'tool-activity') stats.agent_tool_activity++;
          else if (item.contentType === 'tool-activity-placeholder') stats.agent_tool_activity_skipped++;
        }
      }
      const totalExported = conversationData.length;
      const totalInDom = chatTurns.length;
      const exportDurationSec = (totalTimer() / 1000).toFixed(1);

      let markdown = `# ${conversationTitle}\n\n`;
      markdown += `> **Сводка экспорта**  \n`;
      markdown += `> Сообщений: **${totalExported} из ${totalInDom}**${totalExported === totalInDom ? ' ✅' : ' ⚠️'}  \n`;
      markdown += `> Размер контекста: ${tokenSize}  \n`;
      markdown += `> Длительность экспорта: ${exportDurationSec} сек  \n`;
      markdown += `> Дата: ${new Date().toLocaleString('ru-RU')}\n>\n`;
      markdown += `> **Что внутри:**  \n`;
      const breakdown = [
        stats.user_text          ? `${stats.user_text} текстовых от User`    : null,
        stats.user_image         ? `${stats.user_image} картинок User`       : null,
        stats.user_image_skipped ? `${stats.user_image_skipped} картинок User _(пропущены настройками)_` : null,
        stats.user_attachment    ? `${stats.user_attachment} вложений User`  : null,
        stats.user_attachment_skipped ? `${stats.user_attachment_skipped} вложений User _(пропущены настройками)_` : null,
        stats.model_response     ? `${stats.model_response} ответов Model`   : null,
        stats.model_reasoning    ? `${stats.model_reasoning} рассуждений Model` : null,
        stats.model_image        ? `${stats.model_image} картинок Model`     : null,
        stats.model_image_skipped ? `${stats.model_image_skipped} картинок Model _(пропущены настройками)_` : null,
        stats.agent_response     ? `${stats.agent_response} ответов Agent`   : null,
        stats.agent_reasoning    ? `${stats.agent_reasoning} рассуждений Agent` : null,
        stats.agent_tool_activity ? `${stats.agent_tool_activity} вызовов инструментов (Google Search и т.п.)` : null,
        stats.agent_tool_activity_skipped ? `${stats.agent_tool_activity_skipped} вызовов инструментов _(пропущены настройками)_` : null,
        stats.agent_image        ? `${stats.agent_image} картинок Agent`     : null,
        stats.agent_image_skipped ? `${stats.agent_image_skipped} картинок Agent _(пропущены настройками)_` : null,
      ].filter(Boolean);
      for (const line of breakdown) markdown += `> • ${line}  \n`;
      markdown += `\n---\n\n`;

      for (const item of conversationData) {
        if (item.type === 'user') {
          if (item.contentType === 'image') {
            markdown += `## 👤 User\n\n`;
            markdown += `**Image Attachment:**\n\n File Name: ${item.imageName}\n\n Image: ![${item.imageName}](${item.imageName})\n\n`;
          } else if (item.contentType === 'image-placeholder') {
            markdown += `## 👤 User\n\n`;
            markdown += `_[Картинка пропущена при экспорте: ${item.alt}]_\n\n`;
          } else if (item.contentType === 'attachment') {
            markdown += `## 👤 User\n\n`;
            markdown += `**File Attachment:** ${item.fileName}\n\n`;
            if (item.fileInfo) {
              markdown += `File Size: _${item.fileInfo}_\n\n`;
            }
            if (item.previewName) {
              markdown += `File Name: ![${item.fileName}](${item.previewName})\n\n`;
            }
          } else if (item.contentType === 'attachment-placeholder') {
            markdown += `## 👤 User\n\n`;
            markdown += `_[Вложение пропущено при экспорте: ${item.fileName}]_\n\n`;
          } else if (item.contentType === 'empty-turn') {
            markdown += `## 👤 User\n\n`;
            markdown += `_[Пустой turn — отправлен без текста или незавершённый.]_\n\n`;
          } else {
            markdown += `## 👤 User\n\n`;
            markdown += `${item.text}\n\n`;
          }
        } else if (item.type === 'model') {
          if (item.contentType === 'reasoning') {
            markdown += `## 🤖 Model (Reasoning)\n\n`;
            markdown += `${item.text}\n\n`;
          } else if (item.contentType === 'image') {
            markdown += `## 🤖 Model\n\n`;
            markdown += `**Generated Image:**\n\n File Name: ${item.imageName}\n\n Image: ![${item.imageName}](${item.imageName})\n\n`;
          } else if (item.contentType === 'image-placeholder') {
            markdown += `## 🤖 Model\n\n`;
            markdown += `_[Картинка от модели пропущена при экспорте: ${item.alt}]_\n\n`;
          } else if (item.contentType === 'empty-turn') {
            markdown += `## 🤖 Model\n\n`;
            markdown += `_[Пустой turn — rerun-скелет или незавершённый ответ.]_\n\n`;
          } else {
            markdown += `## 🤖 Model\n\n`;
            markdown += `${item.text}\n\n`;
          }
        } else if (item.type === 'agent') {
          // Deep Research role="Agent". Same content kinds as Model, plus tool-activity.
          if (item.contentType === 'reasoning') {
            markdown += `## 🤖 Agent (Reasoning)\n\n`;
            markdown += `${item.text}\n\n`;
          } else if (item.contentType === 'tool-activity') {
            markdown += `## 🌐 Google Search\n\n`;
            if (item.queries && item.queries.length) {
              for (const q of item.queries) {
                markdown += `- ${q}\n`;
              }
              markdown += `\n`;
            } else {
              markdown += `_[Google Search вызван — не удалось извлечь queries из DOM.]_\n\n`;
            }
          } else if (item.contentType === 'tool-activity-placeholder') {
            markdown += `## 🌐 Google Search\n\n`;
            markdown += `_[Tool-activity turn пропущен (Reasoning OFF в настройках).]_\n\n`;
          } else if (item.contentType === 'image') {
            markdown += `## 🤖 Agent\n\n`;
            markdown += `**Generated Image:**\n\n File Name: ${item.imageName}\n\n Image: ![${item.imageName}](${item.imageName})\n\n`;
          } else if (item.contentType === 'image-placeholder') {
            markdown += `## 🤖 Agent\n\n`;
            markdown += `_[Картинка от агента пропущена при экспорте: ${item.alt}]_\n\n`;
          } else if (item.contentType === 'empty-turn') {
            markdown += `## 🤖 Agent\n\n`;
            markdown += `_[Пустой turn — rerun-скелет или незавершённый ответ.]_\n\n`;
          } else {
            markdown += `## 🤖 Agent\n\n`;
            markdown += `${item.text}\n\n`;
          }
        }
      }

      // Step 5/6: package. Text-only exports copy to clipboard by default; file download is explicit.
      // ZIP stays mandatory when real images were exported because markdown+assets cannot fit a text clipboard.
      if (shouldCancel) throw new Error('Export cancelled by user');

      const safeTitle = conversationTitle.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'conversation';
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      let downloadBlob, filename;
      const wantsFile = !!settings.__export?.downloadFile;

      if (images.length === 0 && !wantsFile) {
        updateLoadingStatus('Copying markdown...', 'Finalizing...');
        await copyTextToClipboard(markdown);
        filename = `${safeTitle}-${timestamp}.md`;
        log.info('clipboard', 'markdown copied to clipboard', {
          markdownLen: markdown.length,
          filename,
        });
      } else if (images.length === 0) {
        // Explicit single markdown file — no JSZip overhead.
        downloadBlob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
        filename = `${safeTitle}-${timestamp}.md`;
        log.info('download', 'packaging as single .md (no images)', {
          markdownLen: markdown.length,
          blob_bytes: downloadBlob.size,
          filename,
        });
      } else {
        log.info('zip', 'building zip', { markdownLen: markdown.length, imageCount: images.length });
        const zipBuildTimer = log.timer();
        const zip = new JSZip();
        zip.file('conversation.md', markdown);
        for (const image of images) {
          if (image.base64) {
            const base64Data = image.base64.split(',')[1];
            zip.file(image.name, base64Data, { base64: true });
          } else {
            log.warn('zip', 'image without base64 — skipped', { name: image.name });
          }
        }
        downloadBlob = await log.timed('zip', 'generateAsync', () => zip.generateAsync({ type: 'blob' }));
        filename = `${safeTitle}-${timestamp}.zip`;
        log.info('zip', 'zip built', { build_ms: zipBuildTimer(), blob_bytes: downloadBlob.size, filename });
      }

      if (downloadBlob) {
        updateLoadingStatus('Download starting...', 'Finalizing...');
        const url = URL.createObjectURL(downloadBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        log.info('download', 'download triggered');
      }

      // Step 7: Revert raw mode to original state if it was toggled
      if (!initialRawModeEnabled) {
        log.info('rawmode', 'reverting raw mode to original (was OFF)');
        try {
          const { rawOutputButton: rawOutputButtonRevert } = await ensureMoreActionsMenuOpen();
          rawOutputButtonRevert.click();
          // Phase C: poll for raw-mode body text to disappear, instead of fixed sleep(700).
          await waitFor(() => !isRawModeEnabled(), 'rawmode-disabled-after-revert', CONFIG.RAWMODE_TIMEOUT_MS);
          const rawModeAfterRevert = isRawModeEnabled();
          log.info('rawmode', 'raw mode after revert', { rawModeAfterRevert });
          if (rawModeAfterRevert) {
            log.warn('rawmode', 'failed to disable raw output mode after revert');
          }
        } catch (revertError) {
          log.warn('rawmode', 'revert raw mode threw', { error: { name: revertError?.name, message: revertError?.message } });
        } finally {
          await closeMoreActionsMenuIfOpen();
        }
      }

      log.info('export', 'EXPORT DONE', {
        total_ms: totalTimer(),
        messages: conversationData.length,
        images: images.length,
        filename,
        delivery: downloadBlob ? 'download' : 'clipboard',
        format: images.length === 0 ? 'md' : 'zip',
      });

      showSuccessInOverlay(
        `Экспортировано ${conversationData.length} сообщений${images.length ? `, ${images.length} картинок` : ''}\n\n` +
        (downloadBlob ? `Файл: ${filename}` : 'Markdown скопирован в буфер обмена')
      );

      return {
        success: true,
        message: `Exported ${conversationData.length} messages` + (images.length ? ` with ${images.length} images` : ''),
        filename,
        delivery: downloadBlob ? 'download' : 'clipboard'
      };

    } catch (error) {
      log.error('export', 'EXPORT FAILED', { error, total_ms: totalTimer() });
      isExporting = false;
      shouldCancel = false;
      log.clearExportId();
      const isCancel = /cancel/i.test(error?.message || '');
      if (isCancel) {
        // Silent dismiss for explicit cancel — user already knows.
        hideLoadingOverlay();
      } else {
        // CRITICAL: do NOT call hideLoadingOverlay here. We want the error card to stay visible.
        // Note: we deliberately bypass the `finally` cleanup below by returning early — see the
        // comment at the top of `finally` for why.
        showErrorInOverlay(error.message);
      }
      return { success: false, message: error.message, __noFinallyHide: true };
    } finally {
      // ⚠️ This finally runs even after `return` from catch. We must NOT auto-hide the overlay
      // when we're showing an error card — otherwise the user sees nothing.
      // The flag is set on the returned value; we re-read it here via a closure-captured guard.
      // Actually simpler: just check if overlay is in 'error' state.
      const ov = document.getElementById('ai-studio-export-overlay');
      const isErrorState = ov?.dataset.state === 'error';
      isExporting = false;
      shouldCancel = false;
      if (!isErrorState) hideLoadingOverlay();
      log.clearExportId();
    }
  }

  // Listen for messages from popup
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // Skip our own logger relay messages — they're consumed by background, not us.
    if (request && request.__aise_log === true) return false;

    const senderUrl = sender?.url;
    const isInternalMessage = sender?.id === chrome.runtime.id &&
      (!senderUrl || senderUrl.startsWith(chrome.runtime.getURL('')));

    if (!isInternalMessage) {
      log.warn('msg', 'rejected non-internal message', { senderId: sender?.id, senderUrl });
      sendResponse?.({ success: false, message: 'Invalid sender' });
      return false;
    }

    if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.action !== 'string') {
      log.warn('msg', 'invalid request shape', { request });
      sendResponse?.({ success: false, message: 'Invalid request' });
      return false;
    }

    if (!ALLOWED_ACTIONS.has(request.action)) {
      log.warn('msg', 'unsupported action', { action: request.action });
      sendResponse({ success: false, message: 'Unsupported action' });
      return false;
    }

    log.info('msg', 'received action', { action: request.action });

    if (request.action === 'export') {
      // ACK immediately so popup can close without dropping the message.
      // Result is shown in the overlay, errors logged + visible to user.
      sendResponse({ accepted: true });
      exportConversation().catch(err => {
        log.error('export', 'unhandled exportConversation rejection', { error: { message: err?.message } });
      });
      return false;
    }

    if (request.action === 'getStatus') {
      sendResponse({ isExporting });
      return false;
    }

    // cancel
    log.info('msg', 'cancel requested');
    shouldCancel = true;
    sendResponse({ success: true });
    return false;
  });

})();
