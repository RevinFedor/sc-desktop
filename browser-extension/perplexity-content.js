/***
 * Content script for Perplexity.ai (Search + Computer/Tasks).
 * Approach: same-origin fetch of /rest/thread/<slug> — no DOM scraping.
 *
 * Two modes detected at runtime:
 *   - copilot  (URL: /search/<uuid>)              → answer is JSON.parse(FINAL.content.answer).answer
 *   - asi      (URL: /computer/tasks/<slug>-<id>) → answer is in plan.goals[].description (long ones)
 *
 * Web sources live in JSON.parse(FINAL.content.answer).web_results (both modes).
 */

(function () {
  'use strict';

  const ALLOWED_ACTIONS = new Set(['export', 'getStatus', 'cancel']);
  let isExporting = false;
  let shouldCancel = false;

  // Logger (shared infra with AI Studio content script).
  const log = (typeof window !== 'undefined' && window.__AISE_LOGGER__) || {
    info: () => {}, log: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    timed: async (_t, _n, fn) => fn(), timer: () => () => 0, domSnapshot: () => {},
    setExportId: () => {}, clearExportId: () => {},
  };
  log.info('boot', 'perplexity content script loaded', { url: location.href });

  // ── Visual overlay (so the user actually sees what's happening) ────────
  const OVERLAY_ID = 'pplx-export-overlay';

  function showOverlay() {
    let existing = document.getElementById(OVERLAY_ID);
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
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
        width: 50px; height: 50px;
        border: 3px solid rgba(102, 126, 234, 0.2);
        border-top: 3px solid #667eea;
        border-radius: 50%; animation: pplx-spin 1s linear infinite;
        margin: 0 auto 20px;"></div>
      <h2 id="${OVERLAY_ID}-title" style="margin:0 0 10px 0; color:#fff; font-size:18px; font-weight:600;">
        Экспортирую Perplexity...
      </h2>
      <p id="${OVERLAY_ID}-status" style="margin:0; color:#a5a5a5; font-size:13px; line-height:1.5;">
        Получаю thread по REST API...
      </p>
      <div style="margin-top:20px; padding-top:18px; border-top:1px solid #2c2e33;">
        <div id="${OVERLAY_ID}-progress" style="color:#667eea; font-size:12px; font-weight:600; margin-bottom:14px;">
          Подключение...
        </div>
        <button id="${OVERLAY_ID}-cancel" style="
          background: transparent; border: 1px solid #c92a2a; color: #ff8787;
          padding: 7px 14px; border-radius: 6px; font-size: 12px;
          cursor: pointer; font-weight: 500;">Отменить</button>
      </div>
    `;
    if (!document.querySelector('#pplx-spin-style')) {
      const style = document.createElement('style');
      style.id = 'pplx-spin-style';
      style.textContent = `@keyframes pplx-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`;
      document.head.appendChild(style);
    }
    // Click on the dimmed area (outside the card) is intentionally NOT a close action while
    // export is in progress — accidental click would lose work. Only the Cancel button stops it.
    // The success/error states later swap the card content and rebind overlay click to close.
    overlay.dataset.state = 'progress';
    overlay.addEventListener('click', (e) => {
      // Click landed on the card itself — let it pass through, do nothing.
      if (e.target !== overlay) return;
      // We're in a finished state (success/error) — clicking the dimmed area dismisses.
      if (overlay.dataset.state === 'success' || overlay.dataset.state === 'error') {
        hideOverlay();
      }
    });
    overlay.addEventListener('wheel', e => e.preventDefault(), { passive: false });
    // Stop clicks inside the card from bubbling out (defensive — doesn't matter much here).
    card.addEventListener('click', e => e.stopPropagation());
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    document.getElementById(`${OVERLAY_ID}-cancel`).onclick = () => { shouldCancel = true; };
  }

  function updateOverlay(status, progress) {
    const s = document.getElementById(`${OVERLAY_ID}-status`);
    const p = document.getElementById(`${OVERLAY_ID}-progress`);
    if (s && status) s.textContent = status;
    if (p && progress) p.textContent = progress;
  }

  function hideOverlay() {
    const o = document.getElementById(OVERLAY_ID);
    if (!o) return;
    o.style.opacity = '0';
    o.style.transition = 'opacity 0.25s ease';
    setTimeout(() => o.remove(), 250);
  }

  function showOverlayError(errorMessage) {
    const overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) return showOverlayErrorFresh(errorMessage);
    overlay.dataset.state = 'error';
    const card = overlay.firstElementChild;
    if (!card) return showOverlayErrorFresh(errorMessage);
    card.innerHTML = `
      <div style="font-size:40px; margin-bottom:10px;">⚠️</div>
      <h2 style="margin:0 0 12px 0; color:#ff8787; font-size:18px; font-weight:600;">Экспорт прерван</h2>
      <p style="margin:0 0 18px 0; color:#e9ecef; font-size:13px; line-height:1.5; text-align:left; white-space:pre-wrap;">${escapeHtml(errorMessage)}</p>
      <button id="${OVERLAY_ID}-close-err" style="
        background:#c92a2a; color:white; border:none;
        padding:8px 20px; border-radius:6px; font-size:13px;
        cursor:pointer; font-weight:500;">Закрыть</button>
    `;
    document.getElementById(`${OVERLAY_ID}-close-err`).onclick = hideOverlay;
  }
  function showOverlayErrorFresh(errorMessage) {
    showOverlay();
    showOverlayError(errorMessage);
  }
  function showOverlaySuccess(message) {
    const overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) return;
    overlay.dataset.state = 'success';
    const card = overlay.firstElementChild;
    if (!card) return;
    card.innerHTML = `
      <div style="font-size:40px; margin-bottom:10px;">✅</div>
      <h2 style="margin:0 0 12px 0; color:#69db7c; font-size:18px; font-weight:600;">Готово</h2>
      <p style="margin:0 0 18px 0; color:#e9ecef; font-size:13px; line-height:1.5;">${escapeHtml(message)}</p>
      <button id="${OVERLAY_ID}-close-ok" style="
        background:#2b8a3e; color:white; border:none;
        padding:8px 20px; border-radius:6px; font-size:13px;
        cursor:pointer; font-weight:500;">Закрыть</button>
    `;
    document.getElementById(`${OVERLAY_ID}-close-ok`).onclick = hideOverlay;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // ── URL → slug ──────────────────────────────────────────────────────────
  // /search/3413bb82-6f44-...           → "3413bb82-6f44-..."
  // /computer/tasks/foo-bar-iwIlv_v...  → "foo-bar-iwIlv_v..."
  function getThreadSlug() {
    const m = location.pathname.match(/^\/(?:search|computer\/tasks)\/([^/?#]+)/);
    return m ? m[1] : null;
  }

  // ── Fetch the whole thread (paginated) ─────────────────────────────────
  async function fetchThread(slug) {
    const all = { entries: [], thread_metadata: null };
    let cursor = null;
    let pageNum = 0;

    while (true) {
      pageNum++;
      const params = new URLSearchParams({
        version: '2.18',
        source: 'default',
        from_first: 'true',
        limit: '100',
      });
      if (cursor) params.set('cursor', cursor);
      const url = `/rest/thread/${encodeURIComponent(slug)}?${params}`;

      log.info('fetch', `page ${pageNum} START`, { url });
      const t = log.timer();
      const r = await fetch(url, { credentials: 'include', headers: { accept: 'application/json' } });
      const data = await r.json();
      log.info('fetch', `page ${pageNum} DONE`, { status: r.status, fetch_ms: t(), entries: data.entries?.length, has_next_page: data.has_next_page });

      if (data.status !== 'success') throw new Error(`API returned status="${data.status}"`);
      all.entries.push(...(data.entries || []));
      if (!all.thread_metadata && data.thread_metadata) all.thread_metadata = data.thread_metadata;

      if (!data.has_next_page || !data.next_cursor) break;
      cursor = data.next_cursor;
      if (pageNum > 50) {
        log.error('fetch', 'too many pages, aborting (>50)', {});
        throw new Error('Pagination loop guard tripped (>50 pages)');
      }
    }
    return all;
  }

  // ── Step parsing ───────────────────────────────────────────────────────
  function parseStepsSafe(textField) {
    if (typeof textField !== 'string') return null;
    try {
      const v = JSON.parse(textField);
      return Array.isArray(v) ? v : null;
    } catch (e) {
      log.warn('parse', 'entry.text JSON.parse failed', { error: e?.message, preview: textField.slice(0, 80) });
      return null;
    }
  }

  function getFinalAnswerInner(steps) {
    const fin = (steps || []).find(s => s.step_type === 'FINAL');
    if (!fin?.content?.answer) return null;
    if (typeof fin.content.answer !== 'string') return fin.content.answer;
    try { return JSON.parse(fin.content.answer); }
    catch { return { __raw: fin.content.answer }; }
  }

  // For ASI mode: collect "real" answer chunks from plan.goals where description is long.
  // Heuristic: descriptions ≥250 chars are written by the model as final analysis,
  // shorter ones are status/control phrases ("Loading skill...", "Creating research plan").
  function getAsiAnswerFromPlan(entry, minLen) {
    const cap = minLen || 250;
    const out = [];
    for (const g of entry.plan?.goals || []) {
      if (typeof g.description === 'string' && g.description.length >= cap) {
        out.push(g.description);
      }
    }
    return out;
  }

  // ── Markdown rendering ─────────────────────────────────────────────────

  // Resolve inline `[1]`, `[2]` citations to footnote markers — same numbering as web_results array.
  // Perplexity already uses `[N]` inline; we just append a sources list at the end of each answer.
  function renderSourcesList(webResults) {
    if (!Array.isArray(webResults) || webResults.length === 0) return '';
    let s = '\n\n**Источники:**\n\n';
    webResults.forEach((src, i) => {
      const n = i + 1;
      const name = (src.name || src.title || src.url || 'unnamed').replace(/\s+/g, ' ').trim();
      const url = src.url || '';
      const date = src.timestamp ? src.timestamp.slice(0, 10) : '';
      s += `${n}. [${name}](${url})${date ? ` _(${date})_` : ''}\n`;
    });
    return s;
  }

  function renderRelatedQueries(rqs) {
    if (!Array.isArray(rqs) || rqs.length === 0) return '';
    let s = '\n\n**Связанные вопросы:**\n\n';
    for (const q of rqs) s += `- ${q}\n`;
    return s;
  }

  function safeFilenamePart(s, max) {
    return (s || '').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max || 60);
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

  // ── Main ────────────────────────────────────────────────────────────────

  async function exportConversation(rawSettings) {
    if (isExporting) {
      // Show the overlay anyway so user has a hint that something is going on.
      if (!document.getElementById(OVERLAY_ID)) showOverlay();
      return { success: false, message: 'Экспорт уже запущен' };
    }
    const settings = sanitizePerplexitySettings(rawSettings || {});
    const exportSettings = sanitizeExportSettings(rawSettings?.__export || {});

    const slug = getThreadSlug();
    if (!slug) {
      showOverlayErrorFresh('Не удалось определить ID диалога Perplexity из URL.\n\nОжидаемые URL:\n  • https://www.perplexity.ai/search/<uuid>\n  • https://www.perplexity.ai/computer/tasks/<slug>');
      return { success: false, message: 'Не удалось определить ID диалога Perplexity из URL' };
    }

    const exportId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    log.setExportId(exportId);
    const totalT = log.timer();
    log.info('export', 'EXPORT START', { exportId, url: location.href, slug });

    showOverlay();
    updateOverlay('Получаю thread по REST API...', 'Шаг 1/3: загрузка');

    try {
      isExporting = true;
      shouldCancel = false;

      const data = await log.timed('export', 'fetchThread', () => fetchThread(slug));
      if (shouldCancel) throw new Error('Export cancelled by user');

      const entries = data.entries || [];
      updateOverlay(`Парсю ${entries.length} сообщений...`, `Шаг 2/3: обработка (0/${entries.length})`);
      if (entries.length === 0) throw new Error('Нет сообщений в этом thread');

      const threadTitle = data.thread_metadata?.title || entries[0]?.thread_title || 'perplexity-thread';
      const threadMode = entries[0]?.mode || data.thread_metadata?.mode || 'unknown';
      const skipped = []; // 1-based indices for the determinism gate

      // Build markdown body
      let body = '';
      const stats = { copilot: 0, asi: 0, other: 0, with_sources: 0, total_sources: 0 };

      for (let i = 0; i < entries.length; i++) {
        if (shouldCancel) throw new Error('Export cancelled by user');
        const e = entries[i];
        const turnTag = `entry[${i}]`;
        updateOverlay(`Парсю ${entries.length} сообщений...`, `Шаг 2/3: обработка (${i + 1}/${entries.length})`);

        const query = (e.query_str || '').trim();
        const steps = parseStepsSafe(e.text);
        const finalInner = getFinalAnswerInner(steps);
        const webResults = Array.isArray(finalInner?.web_results) ? finalInner.web_results : [];
        if (webResults.length) { stats.with_sources++; stats.total_sources += webResults.length; }

        // Try both extraction strategies — Perplexity is inconsistent about where it stores
        // the final answer text. Documented findings from baseline logs:
        //   - In SOME copilot threads:  FINAL.answer is the markdown
        //   - In SOME copilot threads:  FINAL.answer is empty, real text in plan.goals[].description
        //   - In ASI (Computer/Tasks):  almost always in plan.goals[].description
        // So we never trust `mode` blindly — we try both and take the longer non-empty one.
        const minLen = settings?.asi_min_chunk_len || 250;
        const finalAnswerStr = typeof finalInner?.answer === 'string' ? finalInner.answer.trim() : '';
        const planLongDescs = getAsiAnswerFromPlan(e, minLen);
        const planAnswer = planLongDescs.join('\n\n---\n\n').trim();

        let answer = '';
        let foundBy = '';
        if (planAnswer.length >= finalAnswerStr.length && planAnswer.length > 0) {
          answer = planAnswer;
          foundBy = `plan.goals[${planLongDescs.length} long, ≥${minLen}ch]`;
        } else if (finalAnswerStr.length > 0) {
          answer = finalAnswerStr;
          foundBy = 'FINAL.answer';
        } else {
          // Last-ditch: lower the bar on plan.goals (some entries have only 200-char summaries).
          const shortDescs = getAsiAnswerFromPlan(e, 200);
          if (shortDescs.length) {
            answer = shortDescs.join('\n\n---\n\n').trim();
            foundBy = `plan.goals[${shortDescs.length} short, ≥200ch]`;
          }
        }
        if (e.mode === 'copilot') stats.copilot++;
        else if (e.mode === 'asi') stats.asi++;
        else { stats.other++; log.warn(turnTag, 'unknown mode', { mode: e.mode, display_model: e.display_model }); }

        log.info(turnTag, 'extracted', {
          mode: e.mode,
          answerLen: answer.length,
          foundBy,
          webResults: webResults.length,
          related: e.related_queries?.length || 0,
        });

        // Determinism gate: if both query and answer are empty, that's data loss.
        if (!query && !answer) {
          skipped.push(i + 1);
          log.error(turnTag, 'matched nothing — POSSIBLE DATA LOSS', {
            mode: e.mode,
            text_len: e.text?.length,
            plan_goals: e.plan?.goals?.length,
          });
          continue;
        }

        // Render this entry
        if (query) {
          body += `## 👤 User\n\n${query}\n\n`;
        }
        if (answer) {
          body += `## 🤖 Perplexity${e.display_model ? ` _(${e.display_model})_` : ''}\n\n${answer}\n`;
        } else if (query) {
          // Query exists but answer is empty — not a parser bug, just an unfinished/aborted turn.
          body += `## 🤖 Perplexity\n\n_[Ответ отсутствует в API. Возможно запрос ещё обрабатывается или был прерван.]_\n\n`;
          log.warn(turnTag, 'no answer extracted but query present', { mode: e.mode, finalAnswerStrLen: finalAnswerStr.length });
        } else {
          body += `## 🤖 Perplexity\n\n_[Ответ не извлечён — ${foundBy || 'нет данных'}]_\n\n`;
        }

        if (settings?.show_sources !== false) body += renderSourcesList(webResults);
        if (settings?.show_related && i === entries.length - 1) body += renderRelatedQueries(e.related_queries);
        body += '\n---\n\n';
      }

      // Hard gate
      if (skipped.length > 0) {
        throw new Error(
          `Пропущено ${skipped.length} из ${entries.length} сообщений (индексы: ${skipped.slice(0, 10).join(', ')}` +
          `${skipped.length > 10 ? '…' : ''}). Файл НЕ скачан. Откройте DevTools → Network, перезагрузите страницу, ` +
          `проверьте что /rest/thread/${slug} отдаёт корректный JSON. Логи в logs/exporter-*.log.`
        );
      }

      // Header summary
      const exportSec = (totalT() / 1000).toFixed(1);
      let header = `# ${threadTitle}\n\n`;
      header += `> **Сводка экспорта Perplexity**  \n`;
      header += `> Сообщений: **${entries.length}** ✅  \n`;
      header += `> Режим: ${threadMode}${entries[0]?.display_model ? ` (${entries[0].display_model})` : ''}  \n`;
      header += `> Источников всего: ${stats.total_sources} (в ${stats.with_sources} ответах)  \n`;
      header += `> Длительность экспорта: ${exportSec} сек  \n`;
      header += `> Дата: ${new Date().toLocaleString('ru-RU')}  \n`;
      header += `> URL: ${location.href}\n\n`;
      header += `---\n\n`;

      const markdown = header + body;
      const filename = `${safeFilenamePart(threadTitle)}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5)}.md`;

      updateOverlay(
        exportSettings.downloadFile ? `Скачиваю файл...` : `Копирую markdown...`,
        `Шаг 3/3: упаковка`
      );

      if (exportSettings.downloadFile) {
        const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } else {
        await copyTextToClipboard(markdown);
      }

      log.info('export', 'EXPORT DONE', {
        total_ms: totalT(),
        entries: entries.length,
        markdownLen: markdown.length,
        filename,
        delivery: exportSettings.downloadFile ? 'download' : 'clipboard',
        stats,
      });

      showOverlaySuccess(
        `Экспортировано ${entries.length} сообщений\nИсточников: ${stats.total_sources}\n\n` +
        (exportSettings.downloadFile ? `Файл: ${filename}` : 'Markdown скопирован в буфер обмена')
      );

      return {
        success: true,
        message: `Экспортировано ${entries.length} сообщений`,
        filename,
        delivery: exportSettings.downloadFile ? 'download' : 'clipboard',
      };
    } catch (error) {
      log.error('export', 'EXPORT FAILED', { error: { message: error?.message, stack: error?.stack }, total_ms: totalT() });
      // Cancellation = silent dismiss (user already knows). Other errors = show in overlay.
      if (/cancel/i.test(error?.message || '')) {
        hideOverlay();
      } else {
        showOverlayError(error.message);
      }
      return { success: false, message: error.message };
    } finally {
      isExporting = false;
      shouldCancel = false;
      log.clearExportId();
    }
  }

  // ── Message handler (popup → us) ───────────────────────────────────────
  chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    if (req && req.__aise_log === true) return false;

    const senderUrl = sender?.url;
    const isInternal = sender?.id === chrome.runtime.id && (!senderUrl || senderUrl.startsWith(chrome.runtime.getURL('')));
    if (!isInternal) {
      sendResponse?.({ success: false, message: 'Invalid sender' });
      return false;
    }
    if (!req || typeof req.action !== 'string' || !ALLOWED_ACTIONS.has(req.action)) {
      sendResponse?.({ success: false, message: 'Unsupported action' });
      return false;
    }
    log.info('msg', 'received action', { action: req.action });

    if (req.action === 'export') {
      // ACK immediately so popup can close without dropping the message.
      // The export then runs asynchronously and reports progress through the overlay.
      sendResponse({ accepted: true });
      // Fire-and-forget: result handled by the overlay, errors logged + shown to user.
      exportConversation(req.settings || {}).catch(err => {
        log.error('export', 'unhandled exportConversation rejection', { error: { message: err?.message } });
      });
      return false;
    }
    if (req.action === 'getStatus') {
      sendResponse({ isExporting, site: 'perplexity', slug: getThreadSlug() });
      return false;
    }
    // cancel
    shouldCancel = true;
    sendResponse({ success: true });
    return false;
  });

})();
