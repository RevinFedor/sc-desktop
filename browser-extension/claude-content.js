// SC Browser Parser — claude.ai chat export.
// Exports visible Claude chat sessions to a single markdown file. No images/binary files:
// file thumbnails and artifacts are represented as text/metadata.

(function () {
  'use strict';

  const ALLOWED_ACTIONS = new Set(['export', 'getStatus', 'cancel']);
  const OVERLAY_ID = 'sc-claude-export-overlay';
  const CONFIG = {
    POLL_INTERVAL_MS: 120,
    WAIT_TIMEOUT_MS: 8000,
  };

  let isExporting = false;
  let shouldCancel = false;

  const log = (typeof window !== 'undefined' && window.__AISE_LOGGER__) || {
    info: () => {}, log: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    timed: async (_t, _n, fn) => fn(), timer: () => () => 0, domSnapshot: () => {},
    setExportId: () => {}, clearExportId: () => {},
  };

  log.info('claude.boot', 'claude export content script loaded', {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
  });

  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  async function waitFor(predicate, why, timeoutMs = CONFIG.WAIT_TIMEOUT_MS) {
    const started = performance.now();
    let attempts = 0;
    while (performance.now() - started <= timeoutMs) {
      attempts++;
      let value = null;
      try { value = predicate(); } catch (e) {
        log.warn('claude.waitFor', 'predicate threw', { why, error: e?.message });
      }
      if (value) {
        log.debug('claude.waitFor', `${why} — done`, {
          attempts,
          wait_ms: +(performance.now() - started).toFixed(1),
        });
        return value;
      }
      await sleep(CONFIG.POLL_INTERVAL_MS);
    }
    log.warn('claude.waitFor', `${why} — TIMEOUT`, {
      attempts,
      timeoutMs,
    });
    return null;
  }

  function textOf(el) {
    if (!el) return '';
    return String(el.innerText || el.textContent || '')
      .replace(/[\uE000-\uF8FF]/g, '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{4,}/g, '\n\n\n')
      .trim();
  }

  function textOfFileContent(el) {
    if (!el) return '';
    return String(el.textContent || el.innerText || '')
      .replace(/[\uE000-\uF8FF]/g, '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{4,}/g, '\n\n\n')
      .trim();
  }

  function safeFilenamePart(s, max = 70) {
    return String(s || 'claude-chat')
      .replace(/[\uE000-\uF8FF]/g, '')
      .replace(/[\\/:*?"<>|\s]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max) || 'claude-chat';
  }

  function escapeMd(s) {
    return String(s || '').replace(/\|/g, '\\|');
  }

  function normalizeSettings(raw) {
    const s = typeof sanitizeClaudeExportSettings === 'function'
      ? sanitizeClaudeExportSettings(raw || {})
      : { includeReattachedFiles: raw?.includeReattachedFiles !== false };
    s.__export = typeof sanitizeExportSettings === 'function'
      ? sanitizeExportSettings(raw?.__export || {})
      : { downloadFile: !!raw?.__export?.downloadFile };
    return s;
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

  async function readTextFromClipboard() {
    try {
      if (!navigator.clipboard?.readText) return '';
      return await navigator.clipboard.readText();
    } catch (_) {
      return '';
    }
  }

  // ── Overlay ───────────────────────────────────────────────────────────
  function showOverlay() {
    let existing = document.getElementById(OVERLAY_ID);
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.dataset.state = 'progress';
    overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 2147483647;
      background: rgba(0, 0, 0, 0.65); backdrop-filter: blur(8px);
      display: flex; align-items: center; justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    `;

    const card = document.createElement('div');
    card.style.cssText = `
      background: #25262b; padding: 32px 40px; border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
      text-align: center; max-width: 460px; width: 90%;
      border: 1px solid #2c2e33; color: #e9ecef;
    `;
    card.innerHTML = `
      <div id="${OVERLAY_ID}-spinner" style="
        width:50px;height:50px;border:3px solid rgba(102,126,234,0.2);
        border-top:3px solid #667eea;border-radius:50%;
        animation:sc-claude-spin 1s linear infinite;margin:0 auto 20px;"></div>
      <h2 id="${OVERLAY_ID}-title" style="margin:0 0 10px 0;color:#fff;font-size:18px;font-weight:600;">
        Экспортирую Claude...
      </h2>
      <p id="${OVERLAY_ID}-status" style="margin:0;color:#a5a5a5;font-size:13px;line-height:1.5;">
        Сканирую сообщения...
      </p>
      <div style="margin-top:20px;padding-top:18px;border-top:1px solid #2c2e33;">
        <div id="${OVERLAY_ID}-progress" style="color:#667eea;font-size:12px;font-weight:600;margin-bottom:14px;">
          Подключение...
        </div>
        <button id="${OVERLAY_ID}-cancel" style="
          background:transparent;border:1px solid #c92a2a;color:#ff8787;
          padding:7px 14px;border-radius:6px;font-size:12px;
          cursor:pointer;font-weight:500;">Отменить</button>
      </div>
    `;

    if (!document.getElementById('sc-claude-export-style')) {
      const style = document.createElement('style');
      style.id = 'sc-claude-export-style';
      style.textContent = '@keyframes sc-claude-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}';
      document.head.appendChild(style);
    }

    overlay.addEventListener('click', (e) => {
      if (e.target?.closest?.('[data-sc-claude-close]')) {
        e.preventDefault();
        e.stopPropagation();
        hideOverlay();
        return;
      }
      if (e.target !== overlay) return;
      if (overlay.dataset.state === 'success' || overlay.dataset.state === 'error') hideOverlay();
    }, true);
    overlay.addEventListener('wheel', e => e.preventDefault(), { passive: false });
    card.addEventListener('click', e => e.stopPropagation());
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    document.getElementById(`${OVERLAY_ID}-cancel`).onclick = () => {
      shouldCancel = true;
      const btn = document.getElementById(`${OVERLAY_ID}-cancel`);
      if (btn) {
        btn.textContent = 'Отмена...';
        btn.disabled = true;
        btn.style.opacity = '0.7';
        btn.style.cursor = 'not-allowed';
      }
    };
  }

  function updateOverlay(status, progress) {
    const s = document.getElementById(`${OVERLAY_ID}-status`);
    const p = document.getElementById(`${OVERLAY_ID}-progress`);
    if (s && status) s.textContent = status;
    if (p && progress) p.textContent = progress;
  }

  function hideOverlay() {
    const overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) return;
    overlay.style.opacity = '0';
    overlay.style.transition = 'opacity 0.25s ease';
    setTimeout(() => overlay.remove(), 250);
  }

  function showTerminalOverlay(kind, messageText) {
    const overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) return;
    overlay.dataset.state = kind;
    const card = overlay.firstElementChild;
    if (!card) return;
    const ok = kind === 'success';
    card.innerHTML = `
      <div style="font-size:40px;margin-bottom:10px;">${ok ? '✅' : '⚠️'}</div>
      <h2 style="margin:0 0 12px 0;color:${ok ? '#69db7c' : '#ff8787'};font-size:18px;font-weight:600;">
        ${ok ? 'Готово' : 'Экспорт прерван'}
      </h2>
      <p style="margin:0 0 18px 0;color:#e9ecef;font-size:13px;line-height:1.5;text-align:left;white-space:pre-wrap;"></p>
      <button type="button" data-sc-claude-close="1" style="
        background:${ok ? '#2b8a3e' : '#c92a2a'};color:white;border:none;
        padding:8px 20px;border-radius:6px;font-size:13px;
        cursor:pointer;font-weight:500;">Закрыть</button>
    `;
    card.querySelector('p').textContent = messageText;
    card.querySelector('button').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      hideOverlay();
    });
  }

  // ── DOM helpers ───────────────────────────────────────────────────────
  function baseChatScope() {
    return document.querySelector('[data-testid="chat-stale-nav-inert"]') ||
      document.querySelector('#main-content') ||
      document.body;
  }

  function commonAncestor(elements) {
    if (!elements.length) return null;
    let candidate = elements[0];
    while (candidate) {
      if (elements.every(el => candidate.contains(el))) return candidate;
      candidate = candidate.parentElement;
    }
    return null;
  }

  function turnHeadingElements(scope) {
    return Array.from(scope.querySelectorAll('h2.sr-only, h2[class*="sr-only"]'))
      .filter(h => /^(You said|Claude responded):/i.test(textOf(h)) && !hasHiddenAncestor(h));
  }

  function chatScope() {
    const base = baseChatScope();
    const headings = turnHeadingElements(base);
    if (headings.length > 1) {
      const common = commonAncestor(headings);
      if (common && common !== base && common !== document.body && common.tagName !== 'H2') {
        return common;
      }
    }
    return base;
  }

  function isFollowing(a, b) {
    return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  function isBefore(a, b) {
    return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  function uniqueElements(elements) {
    const seen = new Set();
    const out = [];
    for (const el of elements) {
      if (!el || seen.has(el)) continue;
      seen.add(el);
      out.push(el);
    }
    return out;
  }

  function hasHiddenAncestor(el) {
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      if (node.hidden || node.inert) return true;
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return true;
    }
    return false;
  }

  function isVisibleContentElement(el) {
    if (!el || !el.isConnected || hasHiddenAncestor(el)) return false;
    const rects = Array.from(el.getClientRects());
    return rects.some(r => r.width > 0 && r.height > 0);
  }

  function hasLayoutBox(el) {
    if (!el || !el.isConnected) return false;
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      if (node.hidden || node.inert) return false;
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return Array.from(el.getClientRects()).some(r => r.width > 0 && r.height > 0);
  }

  function isComposerNode(el) {
    return !!(
      el.closest('[data-testid="chat-input"]') ||
      el.closest('fieldset') ||
      el.closest('[data-testid="wiggle-controls-actions"]') ||
      el.closest('.sticky.bottom-0')
    );
  }

  function findTurnHeadings() {
    return turnHeadingElements(chatScope());
  }

  function turnRootForHeading(h) {
    return h.closest('div.mb-1.mt-6, div.group.relative') || h.parentElement;
  }

  function elementsForTurn(root, h, nextH, selector, options = {}) {
    const scope = chatScope();
    const direct = root ? Array.from(root.querySelectorAll(selector)) : [];
    const between = Array.from(scope.querySelectorAll(selector)).filter(el => {
      if (isComposerNode(el)) return false;
      if (!isFollowing(h, el)) return false;
      if (nextH && !isBefore(el, nextH)) return false;
      return true;
    });
    return uniqueElements([...direct, ...between]).filter(el => {
      if (isComposerNode(el)) return false;
      if (options.visibleOnly && !isVisibleContentElement(el)) return false;
      return true;
    });
  }

  function stripHeadingPrefix(s, prefix) {
    return String(s || '').replace(new RegExp('^' + prefix + ':\\s*', 'i'), '').trim();
  }

  async function expandShowMoreButtons() {
    for (let pass = 0; pass < 3; pass++) {
      hoverLikeUser(chatScope());
      await sleep(80);
      const buttons = Array.from(chatScope().querySelectorAll('button'))
        .filter(b => /^(show more|показать ещё|показать еще)$/i.test(textOf(b)))
        .filter(hasLayoutBox);
      if (!buttons.length) return pass;
      log.info('claude.expand', 'clicking show-more buttons', { pass, count: buttons.length });
      for (const b of buttons) clickLikeUser(b);
      await waitFor(() => {
        const left = Array.from(chatScope().querySelectorAll('button'))
          .filter(btn => /^(show more|показать ещё|показать еще)$/i.test(textOf(btn)));
        return left.length < buttons.length ? true : null;
      }, 'show-more-collapse', 1200);
      if (shouldCancel) throw new Error('Export cancelled by user');
    }
    return 3;
  }

  function clickLikeUser(el) {
    if (!el) return;
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
    const r = el.getBoundingClientRect();
    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: r.x + r.width / 2,
      clientY: r.y + r.height / 2,
      button: 0,
    };
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      try { el.dispatchEvent(new MouseEvent(type, opts)); } catch (_) {}
    }
  }

  function hoverLikeUser(el) {
    if (!el) return;
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
    const r = el.getBoundingClientRect();
    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: r.x + r.width / 2,
      clientY: r.y + r.height / 2,
      pointerType: 'mouse',
    };
    for (const type of ['pointerover', 'mouseover', 'pointerenter', 'mouseenter']) {
      try {
        const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
        el.dispatchEvent(new Ctor(type, opts));
      } catch (_) {}
    }
  }

  async function mainWorldClick(el, turnTag = 'claude.click') {
    if (!el) return { ok: false, err: 'no element' };
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
    await sleep(80);
    const markId = 'claude-export-' + Math.random().toString(36).slice(2, 10);
    try { el.setAttribute('data-sc-mw-click', markId); } catch (_) {}
    try {
      const resp = await chrome.runtime.sendMessage({
        __sc_main_click: true,
        markId,
        singleClick: true,
      });
      if (resp?.ok) return resp;
      log.warn(turnTag, 'main-world click failed; falling back to synthetic click', {
        err: resp?.err || 'no response',
      });
    } catch (e) {
      log.warn(turnTag, 'main-world click threw; falling back to synthetic click', {
        err: e?.message || String(e),
      });
    } finally {
      try { el.removeAttribute('data-sc-mw-click'); } catch (_) {}
    }
    clickLikeUser(el);
    return { ok: false, fallback: true };
  }

  function isConversationTurnNode(el) {
    return !!el?.closest?.('div.group.relative, div.mb-1.mt-6, [data-testid="user-message"]');
  }

  function openFilePreviewContentElement() {
    const candidates = Array.from(document.querySelectorAll('div.standard-markdown, pre, code, textarea, article, section'))
      .filter(el => !isComposerNode(el))
      .filter(el => !isConversationTurnNode(el))
      .filter(isVisibleContentElement)
      .map(el => {
        const text = textOfFileContent(el);
        const cls = String(el.className || '');
        const standardBonus = /standard-markdown|font-claude-response|prose|whitespace-pre-wrap|font-mono/.test(cls) ? 100000 : 0;
        const scrollBonus = el.scrollHeight > el.clientHeight + 20 ? 30000 : 0;
        const semanticBonus = /^(PRE|CODE|TEXTAREA|ARTICLE|SECTION)$/.test(el.tagName) ? 15000 : 0;
        return { el, text, score: text.length + standardBonus + scrollBonus + semanticBonus };
      })
      .filter(x => x.text.length >= 20)
      .sort((a, b) => b.score - a.score);
    return candidates[0]?.el || null;
  }

  function previewContainerForContent(contentEl) {
    if (!contentEl) return null;
    let candidate = contentEl;
    for (let el = contentEl.parentElement; el && el !== document.body; el = el.parentElement) {
      if (el.querySelector('h2.sr-only, h2[class*="sr-only"], [data-testid="user-message"], [data-testid="chat-input"]')) break;
      const hasViewerControls = Array.from(el.querySelectorAll('button'))
        .some(b => /^(Copy|Download)$/i.test(textOf(b)) || /^(Copy|Download|Open in Drive|Go back|Close)$/i.test(b.getAttribute('aria-label') || ''));
      if (hasViewerControls || textOfFileContent(el).length >= textOfFileContent(candidate).length) {
        candidate = el;
      }
    }
    return candidate;
  }

  function elementSharesAncestor(a, b) {
    if (!a || !b) return false;
    for (let el = a.parentElement; el && el !== document.body; el = el.parentElement) {
      if (el.contains(b)) return true;
    }
    return false;
  }

  function filePreviewCloseButton() {
    const testIdButton = document.querySelector('[data-testid="close-file-preview"]');
    if (testIdButton && isVisibleContentElement(testIdButton)) return testIdButton;
    const contentEl = openFilePreviewContentElement();
    const closeButtons = Array.from(document.querySelectorAll('button[aria-label="Close" i]'))
      .filter(b => isVisibleContentElement(b) && !b.closest(`#${OVERLAY_ID}`));
    if (contentEl) {
      const shared = closeButtons.find(b => elementSharesAncestor(b, contentEl));
      if (shared) return shared;
    }
    return closeButtons[0] || null;
  }

  function filePreviewBackButton() {
    const contentEl = openFilePreviewContentElement();
    const buttons = Array.from(document.querySelectorAll('button[aria-label="Go back" i]'))
      .filter(b => {
        if (!isVisibleContentElement(b)) return false;
        if (contentEl && elementSharesAncestor(b, contentEl)) return true;
        let el = b.parentElement;
        for (let i = 0; el && i < 5; i++, el = el.parentElement) {
          if (
            textOf(el).includes('Pasted content') ||
            el.querySelector('[data-testid="close-file-preview"]') ||
            el.querySelector('div.standard-markdown, pre, code, textarea')
          ) return true;
        }
        return false;
      });
    return buttons[0] || null;
  }

  function filePreviewDismissButton() {
    return filePreviewBackButton() || filePreviewCloseButton();
  }

  function filePreviewPanel() {
    const contentEl = openFilePreviewContentElement();
    const contentPanel = previewContainerForContent(contentEl);
    if (contentPanel) return contentPanel;

    const anchorBtn = filePreviewCloseButton() || filePreviewBackButton();
    if (!anchorBtn) return null;
    let candidate = null;
    for (let el = anchorBtn.parentElement; el && el !== document.body; el = el.parentElement) {
      const hasChatContent = !!el.querySelector(
        'h2.sr-only, h2[class*="sr-only"], [data-testid="user-message"], [data-testid="file-thumbnail"], [data-testid="chat-input"]'
      );
      if (candidate && hasChatContent) break;
      if (textOf(el).length > 20) candidate = el;
    }
    return candidate;
  }

  async function closeFilePreviewIfOpen(turnTag = 'claude.file') {
    const dismissBtn = filePreviewDismissButton();
    if (!dismissBtn) return false;
    log.debug(turnTag, 'closing existing file preview');
    try {
      dismissBtn.click();
    } catch (_) {
      clickLikeUser(dismissBtn);
    }
    await waitFor(() => filePreviewDismissButton() ? null : true, 'file preview close', 900);
    return true;
  }

  function findPreviewContentElement(panel) {
    const openContent = openFilePreviewContentElement();
    if (openContent && (!panel || panel.contains(openContent))) return openContent;
    if (!panel) return null;
    const chromeButtons = [filePreviewCloseButton(), filePreviewBackButton()].filter(Boolean);
    const candidates = Array.from(panel.querySelectorAll('pre, code, textarea, div, article, section'))
      .filter(el => el !== panel && !chromeButtons.some(btn => el.contains(btn)))
      .map(el => {
        const text = textOfFileContent(el);
        const cls = String(el.className || '');
        const scrollBonus = el.scrollHeight > el.clientHeight + 20 ? 100000 : 0;
        const preBonus = /whitespace-pre-wrap|standard-markdown|font-mono|prose|overflow-y-auto/.test(cls) ? 50000 : 0;
        const semanticBonus = /^(PRE|CODE|TEXTAREA|ARTICLE|SECTION)$/.test(el.tagName) ? 25000 : 0;
        return { el, text, score: text.length + scrollBonus + preBonus + semanticBonus };
      })
      .filter(x => x.text.length >= 20)
      .sort((a, b) => b.score - a.score);
    return candidates[0]?.el || null;
  }

  function filePreviewCopyButton(panel) {
    const contentEl = openFilePreviewContentElement();
    const scope = panel || previewContainerForContent(contentEl) || document;
    const buttons = Array.from(scope.querySelectorAll('button'))
      .filter(isVisibleContentElement)
      .filter(b => !b.closest(`#${OVERLAY_ID}`))
      .filter(b => /^(Copy)$/i.test(textOf(b)) || /^(Copy)$/i.test(b.getAttribute('aria-label') || ''))
      .map(b => {
        const r = b.getBoundingClientRect();
        const topBonus = r.y < 80 ? 10000 : 0;
        const rightBonus = r.x > window.innerWidth / 2 ? 5000 : 0;
        return { b, score: topBonus + rightBonus + r.x };
      })
      .sort((a, b) => b.score - a.score);
    return buttons[0]?.b || null;
  }

  async function copyOpenFilePreviewText(panel, title, turnTag, index) {
    const copyBtn = filePreviewCopyButton(panel);
    if (!copyBtn) return '';

    const before = await readTextFromClipboard();
    log.info(turnTag, 'file preview copy button click', {
      index,
      title,
      buttonText: textOf(copyBtn),
      buttonAria: copyBtn.getAttribute('aria-label') || '',
    });
    await mainWorldClick(copyBtn, `${turnTag}.file[${index}].copy`);

    const expected = textOfFileContent(openFilePreviewContentElement());
    const started = performance.now();
    while (performance.now() - started < 900) {
      const after = await readTextFromClipboard();
      const cleaned = textOfFileContent({ textContent: after || '' });
      const matchesExpected = expected &&
        (cleaned === expected || cleaned.includes(expected.slice(0, 120)) || expected.includes(cleaned.slice(0, 120)));
      if (cleaned && cleaned.length >= 20 && (cleaned !== before || matchesExpected)) {
        log.info(turnTag, 'file preview copied from Claude viewer', {
          index,
          title,
          textLen: cleaned.length,
        });
        return cleaned;
      }
      await sleep(120);
    }
    log.warn(turnTag, 'file preview copy button did not update readable clipboard; falling back to DOM', {
      index,
      title,
    });
    return '';
  }

  function readOpenFilePreview(fallbackTitle) {
    const panel = filePreviewPanel();
    if (!panel) return null;
    const contentEl = findPreviewContentElement(panel);
    const fullText = textOfFileContent(contentEl);
    const panelTitle = textOf(panel.querySelector('h1, h2, h3')).replace(/^Go back\s+/i, '').trim();
    const panelText = textOf(panel);
    let meta = '';
    if (fullText && panelText.includes(fullText.slice(0, 80))) {
      meta = panelText.slice(0, panelText.indexOf(fullText.slice(0, 80))).trim();
    } else {
      meta = panelText.split('\n').slice(0, 6).join('\n').trim();
    }
    meta = meta
      .split('\n')
      .map(line => line.replace(/^Go back\s*/i, '').replace(/\s*Close$/i, '').trim())
      .filter(Boolean)
      .filter(line => line !== panelTitle)
      .slice(0, 6)
      .join('\n');

    return {
      panelTitle: panelTitle || '',
      meta,
      text: fullText,
      found: !!fullText,
      source: 'file-preview',
      title: fallbackTitle || panelTitle || 'Attached file',
    };
  }

  // ── Extraction ────────────────────────────────────────────────────────
  function extractFileThumbnailMeta(el) {
    const button = el.querySelector('button') || el;
    const aria = button.getAttribute('aria-label') || '';
    const h = el.querySelector('h3');
    let title = textOf(h);
    let kind = '';

    if (!title && aria) {
      const parts = aria.split(',').map(p => p.trim()).filter(Boolean);
      title = parts[0] || 'Attached file';
      kind = parts.slice(1).join(', ');
    }
    if (!title) {
      const first = textOf(el).split('\n').find(Boolean);
      title = first || 'Attached file';
    }

    let body = textOf(el);
    const compactBody = body.replace(/\s+/g, ' ').trim();
    const compactTitle = title.replace(/\s+/g, ' ').trim();
    if (compactBody === compactTitle || compactBody === `${compactTitle} md` || compactBody === `${compactTitle}md`) {
      body = '';
    }
    if (body.startsWith(title) && body.length < title.length + 20) body = '';

    return {
      title,
      kind: kind || aria || '',
      text: body,
      aria,
      found: false,
    };
  }

  async function extractFileThumbnail(el, turnTag, index) {
    const meta = extractFileThumbnailMeta(el);
    const button = el.querySelector('button') || (el.matches('button') ? el : null);
    if (!button) return meta;

    await closeFilePreviewIfOpen(`${turnTag}.file[${index}]`);
    log.info(turnTag, 'file preview open', {
      index,
      title: meta.title,
      kind: meta.kind,
      aria: meta.aria,
    });
    await mainWorldClick(button, `${turnTag}.file[${index}]`);

    const preview = await waitFor(() => {
      const p = readOpenFilePreview(meta.title);
      return p && (p.text || p.panelTitle || p.meta) ? p : null;
    }, `file preview ${meta.title}`, 1500);

    if (preview) {
      const copiedText = await copyOpenFilePreviewText(filePreviewPanel(), meta.title, turnTag, index);
      if (copiedText) {
        preview.text = copiedText;
        preview.found = true;
        preview.source = 'file-preview-copy';
      }
      await closeFilePreviewIfOpen(`${turnTag}.file[${index}]`);
      const merged = {
        ...meta,
        ...preview,
        title: meta.title || preview.title,
        kind: meta.kind,
        aria: meta.aria,
      };
      log.info(turnTag, 'file preview extracted', {
        index,
        title: merged.title,
        panelTitle: merged.panelTitle,
        textLen: merged.text?.length || 0,
        found: merged.found,
      });
      return merged;
    }

    log.warn(turnTag, 'file preview not extracted; keeping visible metadata', {
      index,
      title: meta.title,
      kind: meta.kind,
    });
    await closeFilePreviewIfOpen(`${turnTag}.file[${index}]`);
    return meta;
  }

  function findArtifactBlocks(root, h, nextH) {
    return elementsForTurn(root, h, nextH, '[class*="group/artifact-block"]', { visibleOnly: true })
      .filter(block => {
        const btn = block.querySelector('button[aria-label^="View "]');
        return btn && isVisibleContentElement(btn);
      });
  }

  function artifactTitle(block) {
    const btn = block.querySelector('button[aria-label^="View "]');
    return (btn?.getAttribute('aria-label') || '')
      .replace(/^View\s+/i, '')
      .trim() || textOf(block).split('\n')[0] || 'Claude artifact';
  }

  async function extractArtifactDocument(block, turnTag) {
    const btn = block.querySelector('button[aria-label^="View "]');
    if (!btn) return null;
    const title = artifactTitle(block);
    if (!isVisibleContentElement(block) || !isVisibleContentElement(btn)) {
      log.info(turnTag, 'artifact skipped: hidden/stale branch', { title });
      return { title, text: '', found: false, skip: true };
    }
    log.info(turnTag, 'artifact open', { title });
    await mainWorldClick(btn, turnTag);

    const mdEl = await waitFor(() => {
      const mds = Array.from(document.querySelectorAll('div.standard-markdown'));
      const artifactMarkdown = mds.find(el => {
        if (!el.closest('[aria-label*="artifact" i]')) return false;
        if (!isVisibleContentElement(el)) return false;
        return textOf(el).length >= 40;
      });
      return artifactMarkdown || openFilePreviewContentElement();
    }, 'artifact/document markdown', 4000);

    let text = mdEl ? textOfFileContent(mdEl) : '';
    const copiedText = await copyOpenFilePreviewText(filePreviewPanel(), title, turnTag, 0);
    if (copiedText) text = copiedText;

    const closeBtn = Array.from(document.querySelectorAll('button')).find(b =>
      (b.getAttribute('aria-label') || '').toLowerCase() === 'close artifact'
    );
    if (closeBtn) clickLikeUser(closeBtn);
    else await closeFilePreviewIfOpen(`${turnTag}.artifact`);

    log.info(turnTag, 'artifact extracted', { title, textLen: text.length, found: !!text });
    return { title, text, found: !!text };
  }

  function extractResearchPanels(root, h, nextH) {
    return elementsForTurn(root, h, nextH, 'button[aria-label*="Open research panel" i]', { visibleOnly: true })
      .map(btn => ({
        label: btn.getAttribute('aria-label') || textOf(btn),
        text: textOf(btn),
      }))
      .filter(x => x.label || x.text);
  }

  function extractStatusButtons(root, h, nextH) {
    return elementsForTurn(root, h, nextH, 'button[class*="group/status"]', { visibleOnly: true })
      .map(textOf)
      .filter(Boolean);
  }

  function statusContainerForButton(btn) {
    let fallback = btn.parentElement || btn;
    for (let el = btn.parentElement, depth = 0; el && el !== document.body && depth < 8; el = el.parentElement, depth++) {
      if (!fallback && textOf(el)) fallback = el;
      if (
        el.querySelector('button[class*="group/status"]') &&
        (el.querySelector('[role="status"]') || el.querySelector('[class*="overflow-hidden"]'))
      ) {
        return el;
      }
    }
    return fallback;
  }

  function cleanStatusDetailText(raw, label) {
    const labelNorm = String(label || '').replace(/\s+/g, ' ').trim();
    return String(raw || '')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .filter(line => line.replace(/\s+/g, ' ').trim() !== labelNorm)
      .filter(line => !/^(show more|show less|показать ещё|показать еще|скрыть|done)$/i.test(line))
      .join('\n')
      .trim();
  }

  async function clickShowMoreInside(scope, turnTag, idx) {
    let clicked = 0;
    for (let pass = 0; pass < 3; pass++) {
      hoverLikeUser(scope);
      await sleep(80);
      const btn = Array.from(scope.querySelectorAll('button'))
        .find(b => /^(show more|показать ещё|показать еще)$/i.test(textOf(b)) && hasLayoutBox(b));
      if (!btn) break;

      const beforeLen = textOf(scope).length;
      log.info(turnTag, 'status show-more click', { idx, pass, beforeLen });
      await mainWorldClick(btn, `${turnTag}.status[${idx}].showMore`);
      clicked++;
      await waitFor(() => {
        if (!btn.isConnected || !/^(show more|показать ещё|показать еще)$/i.test(textOf(btn))) return true;
        return textOf(scope).length > beforeLen + 20 ? true : null;
      }, `status show-more ${idx}`, 700);
    }
    return clicked;
  }

  async function extractStatusPanels(root, h, nextH, turnTag) {
    const buttons = elementsForTurn(root, h, nextH, 'button[class*="group/status"]', { visibleOnly: true });
    const out = [];
    for (let i = 0; i < buttons.length; i++) {
      const btn = buttons[i];
      const label = textOf(btn);
      const container = statusContainerForButton(btn);
      const beforeLen = textOf(container).length;

      if (btn.getAttribute('aria-expanded') !== 'true') {
        log.info(turnTag, 'status expand click', { idx: i, label });
        await mainWorldClick(btn, `${turnTag}.status[${i}]`);
        await waitFor(() => {
          if (btn.getAttribute('aria-expanded') === 'true') return true;
          return textOf(container).length > beforeLen + 20 ? true : null;
        }, `status expand ${i}`, 900);
      }

      await clickShowMoreInside(container, turnTag, i);
      const detail = cleanStatusDetailText(textOf(container), label);
      out.push({ label, text: detail });
      log.info(turnTag, 'status extracted', {
        idx: i,
        label,
        textLen: detail.length,
        expanded: btn.getAttribute('aria-expanded') || '',
      });
    }
    return out.filter(x => x.label || x.text);
  }

  async function extractUserTurn(h, nextH, settings, turnIdx) {
    const root = turnRootForHeading(h);
    const turnTag = `claude.turn[${turnIdx}]`;
    const fileEls = elementsForTurn(root, h, nextH, '[data-testid="file-thumbnail"]', { visibleOnly: true });
    const files = [];
    if (settings.includeReattachedFiles) {
      for (let i = 0; i < fileEls.length; i++) {
        if (shouldCancel) throw new Error('Export cancelled by user');
        files.push(await extractFileThumbnail(fileEls[i], turnTag, i));
      }
    }
    const userMessageEl = elementsForTurn(root, h, nextH, '[data-testid="user-message"]', { visibleOnly: true })[0];
    let text = textOf(userMessageEl);
    if (!text) text = stripHeadingPrefix(textOf(h), 'You said');

    const out = {
      type: 'user',
      text,
      files: settings.includeReattachedFiles ? files : [],
      skippedFiles: settings.includeReattachedFiles ? 0 : fileEls.length,
    };
    log.info(turnTag, 'user extracted', {
      textLen: out.text.length,
      files: fileEls.length,
      fullFiles: files.filter(f => f?.text).length,
      skippedFiles: out.skippedFiles,
      rootClass: root?.className || '',
    });
    return out;
  }

  async function extractClaudeTurn(h, nextH, settings, turnIdx) {
    const root = turnRootForHeading(h);
    const turnTag = `claude.turn[${turnIdx}]`;

    const statuses = await extractStatusPanels(root, h, nextH, turnTag);

    const markdowns = elementsForTurn(root, h, nextH, 'div.standard-markdown', { visibleOnly: true })
      .filter(el => !el.closest('[aria-label*="artifact" i]'))
      .map(textOf)
      .filter(Boolean);
    const texts = [];
    const seenTexts = new Set();
    for (const t of markdowns) {
      if (seenTexts.has(t)) continue;
      seenTexts.add(t);
      texts.push(t);
    }

    const researchPanels = extractResearchPanels(root, h, nextH);
    const fileEls = elementsForTurn(root, h, nextH, '[data-testid="file-thumbnail"]', { visibleOnly: true });
    const files = [];
    if (settings.includeReattachedFiles) {
      for (let i = 0; i < fileEls.length; i++) {
        if (shouldCancel) throw new Error('Export cancelled by user');
        files.push(await extractFileThumbnail(fileEls[i], turnTag, i));
      }
    }
    const artifacts = [];
    for (const block of findArtifactBlocks(root, h, nextH)) {
      if (shouldCancel) throw new Error('Export cancelled by user');
      const doc = await extractArtifactDocument(block, turnTag);
      if (doc?.skip) continue;
      artifacts.push(doc || { title: artifactTitle(block), text: '', found: false });
    }

    log.info(turnTag, 'claude extracted', {
      textBlocks: texts.length,
      textLen: texts.reduce((n, t) => n + t.length, 0),
      researchPanels: researchPanels.length,
      statuses: statuses.length,
      files: fileEls.length,
      fullFiles: files.filter(f => f?.text).length,
      skippedFiles: settings.includeReattachedFiles ? 0 : fileEls.length,
      artifacts: artifacts.length,
      artifactTextLen: artifacts.reduce((n, a) => n + (a?.text?.length || 0), 0),
      rootClass: root?.className || '',
    });

    return {
      type: 'claude',
      text: texts.join('\n\n'),
      researchPanels,
      statuses,
      files,
      skippedFiles: settings.includeReattachedFiles ? 0 : fileEls.length,
      artifacts,
      headingPreview: stripHeadingPrefix(textOf(h), 'Claude responded'),
    };
  }

  function hasTurnContent(turn) {
    if (turn.type === 'user') {
      return !!(turn.text || turn.files.length || turn.skippedFiles);
    }
    return !!(
      turn.text ||
      turn.researchPanels.length ||
      turn.statuses.length ||
      turn.files.length ||
      turn.skippedFiles ||
      turn.artifacts.length
    );
  }

  async function collectConversation(settings) {
    await closeFilePreviewIfOpen('claude.collect');
    await expandShowMoreButtons();

    const scope = chatScope();
    const headings = turnHeadingElements(scope);
    if (!headings.length) {
      throw new Error('Claude messages not found: no "You said" / "Claude responded" headings in DOM');
    }
    const scopeRect = scope.getBoundingClientRect();
    log.info('claude.collect', 'chat scope resolved', {
      headings: headings.length,
      scopeTag: scope.tagName,
      scopeClass: String(scope.className || '').slice(0, 180),
      scopeRect: {
        x: Math.round(scopeRect.x),
        y: Math.round(scopeRect.y),
        w: Math.round(scopeRect.width),
        h: Math.round(scopeRect.height),
      },
      scopedArtifacts: scope.querySelectorAll('[class*="group/artifact-block"]').length,
      allArtifacts: document.querySelectorAll('[class*="group/artifact-block"]').length,
    });

    const turns = [];
    const skipped = [];
    for (let i = 0; i < headings.length; i++) {
      if (shouldCancel) throw new Error('Export cancelled by user');
      const h = headings[i];
      const nextH = headings[i + 1] || null;
      const label = textOf(h);
      updateOverlay('Извлекаю сообщения Claude...', `Шаг 2/3: ${i + 1}/${headings.length}`);
      let turn;
      if (/^You said:/i.test(label)) {
        turn = await extractUserTurn(h, nextH, settings, i);
      } else {
        turn = await extractClaudeTurn(h, nextH, settings, i);
      }
      if (hasTurnContent(turn)) turns.push(turn);
      else {
        skipped.push(i + 1);
        log.error(`claude.turn[${i}]`, 'matched nothing — POSSIBLE DATA LOSS', {
          label,
          rootHtmlSample: (turnRootForHeading(h)?.innerHTML || '').slice(0, 2500),
        });
      }
    }

    if (skipped.length) {
      throw new Error(
        `Пропущено ${skipped.length} из ${headings.length} сообщений Claude ` +
        `(индексы: ${skipped.slice(0, 10).join(', ')}${skipped.length > 10 ? '…' : ''}). ` +
        `Файл НЕ скачан. Обнови вкладку Claude (F5) и повтори экспорт; если повторяется — см. logs/exporter-*.log.`
      );
    }

    return { turns, totalInDom: headings.length };
  }

  function chatTitle() {
    const split = document.querySelector('[data-testid="chat-title-split"]');
    const btn = split?.querySelector('button[aria-label*=", rename chat"]') || split;
    let title = textOf(btn);
    if (!title) title = document.title.replace(/\s+-\s+Claude\s*$/i, '').trim();
    return title || 'Claude chat';
  }

  function statsFor(turns) {
    const stats = {
      user: 0,
      claude: 0,
      files: 0,
      fileDocs: 0,
      skippedFiles: 0,
      researchPanels: 0,
      artifacts: 0,
      artifactDocs: 0,
    };
    for (const t of turns) {
      if (t.type === 'user') {
        stats.user++;
        stats.files += t.files.length;
        stats.fileDocs += t.files.filter(f => f?.text).length;
        stats.skippedFiles += t.skippedFiles;
      } else {
        stats.claude++;
        stats.files += t.files.length;
        stats.fileDocs += t.files.filter(f => f?.text).length;
        stats.skippedFiles += t.skippedFiles;
        stats.researchPanels += t.researchPanels.length;
        stats.artifacts += t.artifacts.length;
        stats.artifactDocs += t.artifacts.filter(a => a?.text).length;
      }
    }
    return stats;
  }

  function renderFile(file, index) {
    let md = `**Файл ${index}:** ${escapeMd(file.title || 'Attached file')}\n`;
    if (file.kind) md += `_${escapeMd(file.kind)}_\n`;
    if (file.panelTitle && file.panelTitle !== file.title) {
      md += `_Панель Claude: ${escapeMd(file.panelTitle)}_\n`;
    }
    if (file.meta) {
      md += `_${escapeMd(file.meta.replace(/\n/g, ' • '))}_\n`;
    }
    if (file.text && file.text !== file.title) {
      md += `\n\`\`\`text\n${file.text}\n\`\`\`\n`;
    } else {
      md += `\n_[Полный файл недоступен в DOM Claude; сохранены видимые метаданные.]_\n`;
    }
    return md;
  }

  function renderMarkdown(turns, totalInDom, title, startedMs) {
    const stats = statsFor(turns);
    const exportSec = ((performance.now() - startedMs) / 1000).toFixed(1);
    let md = `# ${title}\n\n`;
    md += `> **Сводка экспорта Claude**  \n`;
    md += `> Сообщений: **${turns.length} из ${totalInDom}** ✅  \n`;
    md += `> User-turns: ${stats.user}; Claude-turns: ${stats.claude}  \n`;
    md += `> Прикреплённых/перекреплённых файлов: ${stats.files}; полных текстовых preview: ${stats.fileDocs}`;
    if (stats.skippedFiles) md += `; пропущено настройкой: ${stats.skippedFiles}`;
    md += `  \n`;
    md += `> Research-карточек: ${stats.researchPanels}; artifact-карточек: ${stats.artifacts}; полных artifact-документов: ${stats.artifactDocs}  \n`;
    md += `> Картинки/бинарные файлы: не экспортировались  \n`;
    md += `> Длительность экспорта: ${exportSec} сек  \n`;
    md += `> Дата: ${new Date().toLocaleString('ru-RU')}  \n`;
    md += `> URL: ${location.href}\n\n`;
    md += `---\n\n`;

    for (const turn of turns) {
      if (turn.type === 'user') {
        md += `## 👤 User\n\n`;
        if (turn.files.length) {
          md += `### Прикреплённые файлы\n\n`;
          turn.files.forEach((file, idx) => {
            md += renderFile(file, idx + 1) + '\n';
          });
        }
        if (turn.skippedFiles) {
          md += `_[Перекреплённые файлы пропущены настройкой: ${turn.skippedFiles}]_\n\n`;
        }
        if (turn.text) md += `${turn.text}\n\n`;
        else if (!turn.files.length && !turn.skippedFiles) md += `_[Пустой user-turn.]_\n\n`;
      } else {
        md += `## 🤖 Claude\n\n`;
        for (const status of turn.statuses) {
          const label = typeof status === 'string' ? status : status?.label;
          const detail = typeof status === 'string' ? '' : status?.text;
          md += `### Процесс Claude\n\n`;
          if (label) md += `_${label}_\n\n`;
          if (detail && detail !== label) md += `${detail}\n\n`;
        }
        for (const panel of turn.researchPanels) {
          md += `### Research\n\n`;
          md += `_${panel.label || panel.text}_\n\n`;
        }
        if (turn.text) md += `${turn.text}\n\n`;
        if (turn.files.length) {
          md += `### Файлы Claude\n\n`;
          turn.files.forEach((file, idx) => {
            md += renderFile(file, idx + 1) + '\n';
          });
        }
        if (turn.skippedFiles) {
          md += `_[Файловые карточки Claude пропущены настройкой: ${turn.skippedFiles}]_\n\n`;
        }
        for (const art of turn.artifacts) {
          md += `### Artifact: ${art?.title || 'Claude artifact'}\n\n`;
          if (art?.text) md += `${art.text}\n\n`;
          else md += `_[Artifact найден, но полный текст не извлечён из панели Claude.]_\n\n`;
        }
      }
      md += `---\n\n`;
    }
    return md;
  }

  async function exportConversation(rawSettings) {
    if (isExporting) {
      if (!document.getElementById(OVERLAY_ID)) showOverlay();
      return { success: false, message: 'Экспорт уже запущен' };
    }

    const settings = normalizeSettings(rawSettings);
    const exportId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const startedMs = performance.now();
    const totalT = log.timer();

    log.setExportId(exportId);
    log.info('claude.export', 'EXPORT START', {
      exportId,
      url: location.href,
      title: document.title,
      settings,
    });

    showOverlay();
    updateOverlay('Сканирую DOM Claude...', 'Шаг 1/3: подготовка');

    try {
      isExporting = true;
      shouldCancel = false;

      const title = chatTitle();
      const { turns, totalInDom } = await collectConversation(settings);
      if (shouldCancel) throw new Error('Export cancelled by user');

      updateOverlay('Собираю markdown...', 'Шаг 3/3: упаковка');
      const markdown = renderMarkdown(turns, totalInDom, title, startedMs);
      const filename = `${safeFilenamePart(title)}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5)}.md`;

      if (settings.__export.downloadFile) {
        const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } else {
        await copyTextToClipboard(markdown);
      }

      const stats = statsFor(turns);
      log.info('claude.export', 'EXPORT DONE', {
        total_ms: totalT(),
        turns: turns.length,
        totalInDom,
        markdownLen: markdown.length,
        filename,
        delivery: settings.__export.downloadFile ? 'download' : 'clipboard',
        stats,
      });

      showTerminalOverlay('success',
        `Экспортировано ${turns.length} сообщений\n` +
        `Файлов: ${stats.files}; полных preview: ${stats.fileDocs}; research: ${stats.researchPanels}; artifacts: ${stats.artifacts}\n\n` +
        (settings.__export.downloadFile ? `Файл: ${filename}` : 'Markdown скопирован в буфер обмена')
      );
      return {
        success: true,
        message: `Экспортировано ${turns.length} сообщений`,
        filename,
        delivery: settings.__export.downloadFile ? 'download' : 'clipboard',
      };
    } catch (error) {
      log.error('claude.export', 'EXPORT FAILED', {
        error: { name: error?.name, message: error?.message, stack: error?.stack },
        total_ms: totalT(),
      });
      if (/cancel/i.test(error?.message || '')) hideOverlay();
      else showTerminalOverlay('error', error?.message || String(error));
      return { success: false, message: error?.message || String(error) };
    } finally {
      isExporting = false;
      shouldCancel = false;
      log.clearExportId();
    }
  }

  chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    if (req && req.__aise_log === true) return false;

    const senderUrl = sender?.url;
    const isInternal = sender?.id === chrome.runtime.id &&
      (!senderUrl || senderUrl.startsWith(chrome.runtime.getURL('')));
    if (!isInternal) {
      sendResponse?.({ success: false, message: 'Invalid sender' });
      return false;
    }
    if (!req || typeof req.action !== 'string' || !ALLOWED_ACTIONS.has(req.action)) {
      return false;
    }

    log.info('claude.msg', 'received action', { action: req.action });
    if (req.action === 'export') {
      sendResponse({ accepted: true });
      exportConversation(req.settings || {}).catch(err => {
        log.error('claude.export', 'unhandled exportConversation rejection', { error: { message: err?.message } });
      });
      return false;
    }
    if (req.action === 'getStatus') {
      sendResponse({ isExporting, site: 'claude', title: chatTitle() });
      return false;
    }
    shouldCancel = true;
    sendResponse({ success: true });
    return false;
  });
})();
