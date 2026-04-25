// SC Browser Parser — Deep Research на perplexity.ai.
//
// Триггер: вкладка открыта на www.perplexity.ai/?sc-research=<requestId>
// (или /search/* с тем же query — на случай ре-инжекта). requestId — в
// bridge'е, забираем GET /research-job.
//
// Flow:
//   1. Дождаться #ask-input (contenteditable).
//   2. Открыть dropdown "Поиск" (button[aria-haspopup="menu"] с
//      textContent==="Поиск" в idle-состоянии). Кликаем нативным
//      event-блоком потому что Radix радикс ждёт pointerdown→up.
//   3. Если в menu есть [role="menuitemradio"] textContent==="Глубокое
//      исследование" с aria-checked="false" — кликаем. Если уже включён —
//      просто закрываем dropdown.
//   4. Paste prompt в #ask-input.
//   5. Click button[aria-label="Отправить"].
//   6. MutationObserver на смене aria-label: Отправить → Остановить → ...
//      → Отправить (done) [или его исчезновение].
//
// Anti-throttle: chrome.runtime.connect, тот же паттерн что и в
// claude-research.js.

(function () {
  'use strict';

  const BRIDGE = 'http://127.0.0.1:53127';
  const TAG = '[SC-PR]'; // perplexity-research
  const MAX_FLOW_MS = 30 * 60 * 1000;

  function dbgSink() {
    let n = document.getElementById('sc-research-dbg-log');
    if (n && n.isConnected) return n;
    n = document.createElement('pre');
    n.id = 'sc-research-dbg-log';
    n.style.cssText = 'position:fixed;left:-99999px;top:0;width:0;height:0;visibility:hidden;pointer-events:none;';
    (document.body || document.documentElement).appendChild(n);
    return n;
  }
  const log = (tag, data) => {
    try { console.log(TAG, tag, data || ''); } catch {}
    try {
      const t = (performance.now() / 1000).toFixed(3);
      const entry = `${t}s [${tag}] ` + (data == null ? '' : (typeof data === 'string' ? data : JSON.stringify(data)));
      const sink = dbgSink();
      sink.textContent = (sink.textContent || '') + '\n' + entry;
    } catch {}
  };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // SW-driven watchdog. См. claude-research.js — тот же механизм:
  // SW chrome.alarms каждые 30с шлёт {__sc_research_poke}. Listener
  // вызывает window.__scResearchPoke если выставлен. Anti-throttling
  // tick гарантированно срабатывает в hidden tab.
  try {
    chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
      if (req && req.__sc_research_poke === true) {
        const fn = window.__scResearchPoke;
        if (typeof fn === 'function') {
          try { fn(); } catch (_) {}
          log('poke.handled');
        } else {
          log('poke.no_handler');
        }
        sendResponse({ ok: true });
        return false;
      }
      return undefined;
    });
  } catch (e) {
    log('poke.listener_setup_failed', { err: e?.message });
  }

  // requestId жизненный цикл (perplexity):
  //   1. MCP открыл вкладку на perplexity.ai/?sc-research=<id> — query есть.
  //   2. После submit'а perplexity редиректит на /search/<uuid> БЕЗ query.
  //      sc-research маркер теряется навсегда.
  //
  // Persistence через window.name — переживает navigation, pushState,
  // reload. Без него любой повторный инжект CS (например на /search/<uuid>
  // после редиректа) не сможет понять что это «наша» вкладка и активирует
  // НИЧЕГО, watcher умрёт.
  const WINDOW_NAME_PREFIX = 'sc-research:';
  // researchStartTs — реальное время старта research'а (НЕ reload'а текущей
  // страницы). pageLoadTs / performance.timeOrigin сбрасывается на каждом
  // location.reload(), поэтому force-reload-5min нельзя на него опереться.
  // researchStartTs persistит через window.name в формате
  //   sc-research:<id>:<startTsMs>
  // Read раз в getRequestId(), сохраняем туда же.
  let researchStartTs = null;
  function getRequestId() {
    const u = new URL(location.href);
    // 1) Свежий hash или query от MCP-открытой вкладки. Это первый инжект:
    //    запоминаем researchStartTs = Date.now() как момент старта.
    const fromHash = (u.hash || '').match(/sc-research=([\w-]+)/);
    if (fromHash) {
      const id = fromHash[1];
      researchStartTs = Date.now();
      try { window.name = WINDOW_NAME_PREFIX + id + ':' + researchStartTs; } catch (_) {}
      return id;
    }
    const fromQuery = u.searchParams.get('sc-research');
    if (fromQuery) {
      researchStartTs = Date.now();
      try { window.name = WINDOW_NAME_PREFIX + fromQuery + ':' + researchStartTs; } catch (_) {}
      return fromQuery;
    }
    // 2) Fallback: window.name после navigation/reload. Парсим формат
    //    sc-research:<id>:<startTsMs>. Если ts отсутствует (старый формат) —
    //    выставляем сейчас и перезаписываем; force-reload будет считать
    //    от первого reload'а после апдейта.
    try {
      const wn = String(window.name || '');
      if (wn.startsWith(WINDOW_NAME_PREFIX)) {
        const rest = wn.slice(WINDOW_NAME_PREFIX.length);
        const parts = rest.split(':');
        const id = parts[0];
        const ts = parseInt(parts[1] || '0', 10);
        if (id) {
          researchStartTs = Number.isFinite(ts) && ts > 0 ? ts : Date.now();
          if (!Number.isFinite(ts) || ts <= 0) {
            try { window.name = WINDOW_NAME_PREFIX + id + ':' + researchStartTs; } catch (_) {}
          }
          log('main.id_from_window_name', { id, researchStartTs, ageMs: Date.now() - researchStartTs });
          return id;
        }
      }
    } catch (_) {}
    return null;
  }

  // bfetch: page→bridge с SW-fallback (см. scBridgeFetch в research-badge.js).
  // LNA-диалог (Chromium 138+) per-origin: на claude.ai юзер нажал «Блокировать»
  // и канал умер навсегда; на фоновых вкладках диалога вообще не видно. SW-канал
  // от LNA свободен.
  function bfetch(path, init) {
    if (typeof window.scBridgeFetch === 'function') return window.scBridgeFetch(path, init);
    return fetch(BRIDGE + path, init);
  }

  async function fetchJob(id) {
    const r = await bfetch('/research-job?id=' + encodeURIComponent(id));
    if (!r.ok) throw new Error('fetchJob http ' + r.status);
    return await r.json();
  }
  // Persistent log в bridge'е. dbg-sink #sc-research-dbg-log умирает с tab
  // close/reload — для post-mortem непригоден. bridge log переживает всё.
  // Используется для boot/recover/reload-tick событий. См. зеркальный
  // механизм в claude-research.js::bridgeLog.
  async function bridgeLog(tag, data, idOrNull, tabIdOrNull) {
    try {
      await bfetch('/research-log', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: idOrNull || null,
          tabId: tabIdOrNull ?? null,
          tag,
          url: location.href,
          data,
        }),
      });
    } catch (_) { /* fire-and-forget */ }
  }

  // Запросить SW свой tabId. Используется в recovery-flow когда query-param
  // и window.name потеряны (crash-restore / discard). См. claude-research.js
  // — идентичная реализация.
  function getMyTabId() {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ __sc_get_tab_id: true }, r => {
          if (chrome.runtime.lastError) { resolve(null); return; }
          resolve(r?.tabId ?? null);
        });
      } catch (_) { resolve(null); }
    });
  }
  async function recoverIdByTabId() {
    const tabId = await getMyTabId();
    if (tabId == null) { log('recover.no_tabid'); return null; }
    try {
      const r = await bfetch('/research-by-tab?tabId=' + tabId);
      if (!r.ok) { log('recover.no_active', { tabId, status: r.status }); return null; }
      const data = await r.json();
      const recoveredId = data?.id;
      if (!recoveredId) return null;
      log('recover.hit', { tabId, id: recoveredId, jobStatus: data.status, stage: data.stage });
      researchStartTs = data.createdAt || Date.now();
      try { window.name = WINDOW_NAME_PREFIX + recoveredId + ':' + researchStartTs; } catch (_) {}
      return recoveredId;
    } catch (e) { log('recover.threw', { err: e?.message }); return null; }
  }

  async function postState(id, patch) {
    try {
      // provider в каждом запросе — bridge respin восстанавливает job
      // через POST /research-state, ему нужен provider в body.
      const r = await bfetch('/research-state', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, provider: 'perplexity', ...patch }),
      });
      if (!r.ok) log('postState.http_err', { status: r.status, patch });
    } catch (e) { log('postState.threw', { err: e?.message || String(e) }); }
  }

  // Терминальный (status=done/error) postState С ПОДТВЕРЖДЕНИЕМ. Обычный
  // postState — fire-and-forget: для промежуточных stage'ей ок, для ФИНАЛА нет.
  // Если финальный POST потерялся, bridge остаётся в running, а teardown снимает
  // оба предохранителя (stopKeepAlive → SW RESEARCH_TABS.delete → onRemoved
  // молчит) → job зомби-running навсегда. Контракт: POST → читаем echo-snapshot
  // (/research-state отвечает publicSnapshot) → подтверждаем смерженный status.
  // Ретраи с backoff; scBridgeFetch при сетевом провале sticky-переключается на
  // SW-канал (LNA-иммунный). Возвращает true только при подтверждении bridge'ем.
  // См. fact-deep-research.md::Tab-closed fallback + chatgpt-кейс ryccfz.
  async function postTerminalState(id, patch, attempts = 5) {
    const want = patch.status;
    for (let i = 0; i < attempts; i++) {
      try {
        const r = await bfetch('/research-state', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, provider: 'perplexity', ...patch }),
        });
        if (r.ok) {
          let snap = null; try { snap = await r.json(); } catch (_) {}
          if (snap && snap.status === want) return true;
          log('postTerminal.unconfirmed', { attempt: i, got: snap?.status || null, want });
        } else {
          log('postTerminal.http_err', { attempt: i, status: r.status });
        }
      } catch (e) {
        log('postTerminal.threw', { attempt: i, err: e?.message || String(e) });
      }
      await sleep(Math.min(2000, 300 * (i + 1)));
    }
    bridgeLog('pplx.terminal.giveup', { id, want, attempts }, id, null);
    return false;
  }

  async function waitFor(predicate, why, timeoutMs = 15000, intervalMs = 200) {
    const t0 = performance.now();
    while (true) {
      let v; try { v = predicate(); } catch (_) { v = null; }
      if (v) return v;
      if (performance.now() - t0 > timeoutMs) throw new Error('timeout: ' + why);
      await sleep(intervalMs);
    }
  }

  function findComposer()  { return document.getElementById('ask-input'); }
  function findSubmitBtn() { return document.querySelector('button[aria-label="Отправить"]'); }
  // ВАЖНО: реальный aria-label у Stop — "Остановить ответ (Esc)", не голое
  // "Остановить". Точный match не сматчился, watcher думал что Stop вообще
  // не появлялся, и done срабатывал слишком рано — на промежуточном
  // финальном документе который Perplexity показывает ДО реального
  // завершения research'а. Матчим по префиксу.
  function findStopBtn()   {
    return Array.from(document.querySelectorAll('button[aria-label]'))
      .find(b => /^Остановить/i.test(b.getAttribute('aria-label') || ''));
  }

  // Extract content. Двухступенчатая стратегия:
  //   1. Если есть DOM-документ Deep Research (карточка с заголовком +
  //      кнопкой "Скачать") — забираем его. Это финальный артефакт research'а;
  //      обычный последний "answer" в /rest/thread без него малоинформативен.
  //   2. Fallback: rest/thread/<slug> — последний answer (обычные ответы,
  //      clarifying questions).
  function getThreadSlug() {
    const m = location.pathname.match(/^\/(?:search|computer\/tasks)\/([^/?#]+)/);
    return m ? m[1] : null;
  }

  // Селектор задокументирован: H1.font-editorial — это заголовок карточки
  // research-документа; родительский div.prose.dark:prose-invert.max-w-none
  // содержит документ целиком (innerText даёт читабельный plain-text с
  // переносами). На странице может быть несколько таких документов
  // (если research переиспользовал ту же вкладку для последующего вопроса) —
  // берём последний по document order.
  function extractDocumentText() {
    const docs = Array.from(document.querySelectorAll('div.prose.dark\\:prose-invert.max-w-none'))
      .filter(el => el.querySelector('h1.font-editorial'));
    const last = docs[docs.length - 1];
    if (!last) return null;
    const text = (last.innerText || last.textContent || '').trim();
    if (!text || text.length < 100) return null;
    const titleEl = last.querySelector('h1.font-editorial');
    return {
      text,
      title: titleEl ? (titleEl.textContent || '').trim() : null,
    };
  }

  async function fetchThreadLastAnswer() {
    const slug = getThreadSlug();
    if (!slug) return { text: '', kind: 'no_slug' };
    try {
      const params = new URLSearchParams({ version:'2.18', source:'default', from_first:'true', limit:'100' });
      const r = await fetch(`/rest/thread/${encodeURIComponent(slug)}?${params}`, { credentials:'include', headers:{ accept:'application/json' } });
      const data = await r.json();
      if (data.status !== 'success' || !Array.isArray(data.entries)) return { text: '', kind: 'api_error', slug };
      const lastEntry = data.entries[data.entries.length - 1];
      if (!lastEntry) return { text: '', kind: 'no_entries', slug };
      let steps = null;
      if (typeof lastEntry.text === 'string') {
        try { const v = JSON.parse(lastEntry.text); steps = Array.isArray(v) ? v : null; } catch (_) {}
      }
      let copilotAnswer = '';
      let sources = [];
      if (steps) {
        const fin = steps.find(s => s.step_type === 'FINAL');
        if (fin?.content?.answer) {
          try {
            const j = JSON.parse(fin.content.answer);
            copilotAnswer = String(j.answer || '');
            if (Array.isArray(j.web_results)) sources = j.web_results.map(w => ({ name: w.name || w.title || '', url: w.url || '' }));
          } catch (_) { copilotAnswer = String(fin.content.answer || ''); }
        }
      }
      let asiAnswer = '';
      if (lastEntry.plan?.goals) {
        const out = [];
        for (const g of lastEntry.plan.goals) {
          if (typeof g.description === 'string' && g.description.length >= 250) out.push(g.description);
        }
        asiAnswer = out.join('\n\n---\n\n');
      }
      const text = (asiAnswer.length >= copilotAnswer.length && asiAnswer) ? asiAnswer : copilotAnswer;
      return { text, kind: text ? 'thread_answer' : 'empty', slug, sources };
    } catch (e) {
      log('extract.thread_threw', { err: e?.message || String(e) });
      return { text: '', kind: 'fetch_error' };
    }
  }

  // Корень research-документа = .prose-карточка, поднявшись от h1.font-editorial
  // до контейнера с кнопкой "Копировать содержимое" (это и есть шапка карточки).
  // Единый helper — используется и в watcher (documentComplete/hasDocument),
  // и в extractor (docCardStreaming). Function declaration → hoisted, доступен
  // выше по файлу.
  function findDocCardRoot() {
    const h1 = document.querySelector('div.prose.dark\\:prose-invert.max-w-none h1.font-editorial');
    if (!h1) return null;
    let el = h1;
    for (let i = 0; i < 14 && el; i++) {
      if (el.querySelector && el.querySelector('button[aria-label="Копировать содержимое"]')) return el;
      el = el.parentElement;
    }
    return null;
  }
  // Документ-карточка ещё стримит, если внутри её корня крутится спиннер
  // ([class*=animate-spin] — тот самый ◯ у заголовка). Это authoritative-маркер
  // достройки: живой capture показал spin:1 при len:373 (стрим) ⟷ spin:0 при
  // len:24528 (готово). Используется и watcher'ом (documentComplete), и здесь.
  function docCardStreaming() {
    const root = findDocCardRoot();
    return root ? !!root.querySelector('[class*="animate-spin"]') : false;
  }

  async function extractAnswerText() {
    // Шаг 1. Подождать пока Stop button окончательно пропадёт И спиннер карточки
    // погаснет. Perplexity показывает каркас документа ДО завершения генерации
    // (карточка с ◯-спиннером и ~370 симв) — если извлечь сразу, получим
    // обрезанный фрагмент. Реальный конец = Stop (aria-label="Остановить ответ
    // (Esc)") исчез И через 2с не вернулся, И в карточке нет animate-spin.
    const STOP_QUIET_MS = 2500;
    const STOP_WAIT_MAX = 5 * 60 * 1000; // 5 минут максимум
    const t0 = performance.now();
    let lastStopAt = findStopBtn() ? performance.now() : 0;
    while (performance.now() - t0 < STOP_WAIT_MAX) {
      const stop = findStopBtn();
      if (stop || docCardStreaming()) {
        // Активный Stop ИЛИ крутящийся спиннер карточки = ещё стримит.
        lastStopAt = performance.now();
      } else if (performance.now() - lastStopAt >= STOP_QUIET_MS) {
        log('extract.stop_quiet', { elapsedMs: Math.round(performance.now() - t0) });
        break;
      }
      await sleep(500);
    }

    // Шаг 2. Документ может ещё стримить — ждём стабилизации текста.
    const STABLE_REPS = 2;
    const PROBE_MS = 800;
    const STABILIZE_MAX_MS = 30000;
    const t1 = performance.now();
    let lastLen = -1;
    let stable = 0;
    let bestDoc = null;
    while (performance.now() - t1 < STABILIZE_MAX_MS) {
      const doc = extractDocumentText();
      if (doc && doc.text) {
        bestDoc = doc;
        if (doc.text.length === lastLen) {
          stable++;
          if (stable >= STABLE_REPS) {
            log('extract.stable', { len: doc.text.length, elapsedMs: Math.round(performance.now() - t1) });
            return { text: doc.text, kind: 'document', slug: getThreadSlug(), sources: [], doc_title: doc.title };
          }
        } else {
          stable = 0;
          lastLen = doc.text.length;
        }
      }
      await sleep(PROBE_MS);
    }
    if (bestDoc && bestDoc.text) {
      log('extract.max_wait', { len: bestDoc.text.length });
      return { text: bestDoc.text, kind: 'document', slug: getThreadSlug(), sources: [], doc_title: bestDoc.title };
    }
    return await fetchThreadLastAnswer();
  }

  // dropdown trigger — единственный button[aria-haspopup="menu"] с текстом
  // одного из режимов (Поиск, Глубокое исследование, Совет моделей, Учитесь шаг за шагом).
  function findModeTrigger() {
    return Array.from(document.querySelectorAll('button[aria-haspopup="menu"]'))
      .find(b => /^(Поиск|Глубокое исследование|Совет моделей|Учитесь шаг за шагом)$/.test((b.textContent || '').trim()));
  }
  function findMenuItemRadioByLabel(label) {
    // Perplexity иногда выносит mode-пункты в разные секции с РАЗНЫМ role:
    //   - role="menuitemradio" — обычные включаемые модусы (Поиск, Учитесь шаг за шагом)
    //   - role="menuitem"      — Pro/locked feature (Глубокое исследование, Совет моделей)
    // Любая попытка selector только по menuitemradio регрессит на Pro-only фичах.
    // Берём оба, фильтруем по textContent === label.
    return Array.from(document.querySelectorAll('[role="menuitemradio"], [role="menuitem"]'))
      .find(el => (el.textContent || '').trim() === label);
  }

  function nativeMouseClick(el) {
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(t => {
      el.dispatchEvent(new MouseEvent(t, { bubbles:true, cancelable:true, view:window, clientX:x, clientY:y, button:0 }));
    });
  }
  function pressEscape() {
    document.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', code:'Escape', keyCode:27, which:27, bubbles:true }));
  }

  // Детект upsell-модала «Обновитесь для расширенных возможностей исследования».
  // Появляется после клика на menuitem "Глубокое исследование" когда исчерпан
  // дневной free-лимит Pro Deep Research. Возвращает label если modal найден.
  function findUpsellModal() {
    const dlg = document.querySelector('[role="dialog"], [role="alertdialog"]');
    if (!dlg) return null;
    const label = (dlg.getAttribute('aria-label') || '').trim();
    const text = (dlg.textContent || '').trim();
    const haystack = (label + ' ' + text).slice(0, 600);
    if (/обновитесь|upgrade|перейдите\s+на\s+max|расширенный\s+доступ.+глубокому|max\s+for\s+extended/i.test(haystack)) {
      return label || text.slice(0, 200);
    }
    return null;
  }

  // ── Реестр моделей Perplexity ───────────────────────────────────────
  // ЕДИНОЕ место для моделей. Добавить новую = одна строка здесь. Матчинг
  // идёт по `match` (substring, case-insensitive по textContent пункта меню),
  // поэтому ярлык юзера может быть коротким ("gemini", "gpt") — найдём.
  // Модели меняются часто (Perplexity релизит/переименовывает) — поэтому
  // НЕ хардкодим точные строки в логике, только тут.
  //
  // locked-detect НЕ из этого списка, а из DOM: доступные модели рендерятся
  // как role="menuitemradio" (кликабельны), а Max/locked — как role="menuitem"
  // (cм. spec ниже в findModelMenuItem). Список `locked:true` тут — лишь
  // подсказка для дефолт-выбора, реальная проверка в DOM.
  const PPLX_MODELS = [
    { key: 'best',     match: 'Лучший',           aliases: ['best', 'auto', 'лучший', 'лучшая'] },
    { key: 'sonar',    match: 'Sonar 2',          aliases: ['sonar', 'sonar2', 'sonar 2'] },
    { key: 'gpt',      match: 'GPT-5.4',          aliases: ['gpt', 'gpt5', 'gpt-5.4', 'gpt54', 'openai'] },
    { key: 'gpt-max',  match: 'GPT-5.5',          aliases: ['gpt-5.5', 'gpt55'], locked: true },
    { key: 'gemini',   match: 'Gemini 3.1 Pro',   aliases: ['gemini', 'gemini3', 'gemini 3.1 pro', 'gemini-3.1-pro', 'pro'] },
    { key: 'sonnet',   match: 'Claude Sonnet 4.6', aliases: ['sonnet', 'claude', 'claude sonnet', 'claude-sonnet-4.6'] },
    { key: 'opus-max', match: 'Claude Opus 4.8',  aliases: ['opus', 'claude opus'], locked: true },
    { key: 'kimi',     match: 'Kimi K2.6',        aliases: ['kimi', 'kimi k2', 'kimi-k2.6', 'k2'] },
    { key: 'nemotron', match: 'Nemotron 3 Super', aliases: ['nemotron', 'nvidia', 'nemotron 3'] },
  ];
  const PPLX_DEFAULT_MODEL = 'Gemini 3.1 Pro'; // дефолт когда options.model не задан
  // Резолв ярлыка юзера (например "gemini", "GPT-5.4", "kimi") в каноничный
  // match-токен. Сначала точное/substring совпадение по match, потом aliases.
  function resolvePplxModel(input) {
    if (!input) return PPLX_DEFAULT_MODEL;
    const q = String(input).trim().toLowerCase();
    // 1) по match (substring в обе стороны)
    let hit = PPLX_MODELS.find(m => m.match.toLowerCase() === q)
           || PPLX_MODELS.find(m => m.match.toLowerCase().includes(q))
           || PPLX_MODELS.find(m => m.aliases.some(a => a === q))
           || PPLX_MODELS.find(m => m.aliases.some(a => q.includes(a) || a.includes(q)));
    return hit ? hit.match : input; // если не нашли — пробуем как есть (вдруг новая модель)
  }

  // mode: 'deep' (default) → "Глубокое исследование", 'search' → "Поиск".
  // 'deep' = Pro Deep Research (5-25 минут), 'search' = обычный Поиск (до 5 мин).
  const MODE_LABELS = {
    deep: 'Глубокое исследование',
    search: 'Поиск',
  };
  async function ensureModeSelected(mode) {
    const targetLabel = MODE_LABELS[mode] || MODE_LABELS.deep;
    const trigger = findModeTrigger();
    if (!trigger) throw new Error('mode trigger not found');
    const currentLabel = (trigger.textContent || '').trim();
    if (currentLabel === targetLabel) {
      log('mode.already_set', { mode, label: targetLabel });
      return;
    }
    nativeMouseClick(trigger);
    await sleep(400);
    if (trigger.getAttribute('aria-expanded') !== 'true') {
      nativeMouseClick(trigger);
      await sleep(400);
    }
    // 15s вместо 5s: Yandex в hidden tab может рендерить popover medium-slow.
    const item = await waitFor(() => findMenuItemRadioByLabel(targetLabel), 'mode item: ' + targetLabel, 15000);
    nativeMouseClick(item);
    await sleep(800);

    // Daily limit detect (актуально только для 'deep' — Поиск free).
    const upsell = findUpsellModal();
    if (upsell) {
      pressEscape();
      await sleep(200);
      throw new Error('pplx_daily_limit: ' + upsell.slice(0, 200));
    }

    const triggerAfter = findModeTrigger();
    const labelAfter = triggerAfter ? (triggerAfter.textContent || '').trim() : '';
    if (labelAfter !== targetLabel) {
      pressEscape();
      throw new Error('pplx_mode_switch_failed: trigger still shows "' + labelAfter + '"');
    }
    pressEscape();
    await sleep(150);
    log('mode.switched', { mode, label: targetLabel });
  }

  // ── Model selection (GPT-5.4 + Рассуждение toggle) ──────────────────
  // По спецификации юзера: при research-старте всегда GPT-5.4 + Рассуждение
  // включено. Триггер модели — отдельный aria-haspopup="menu" button с
  // aria-label, начинающимся с названия текущей модели (e.g. "GPT-5.4 Thinking").
  // В dropdown'е:
  //   - GPT-5.4 → role="menuitemradio" (click переключает)
  //   - Рассуждение → role="menuitemcheckbox" (click тогglит)
  function findModelTrigger() {
    // Триггер модели — единственный aria-haspopup="menu" button с aria-label,
    // которая НЕ "Действия в потоке" / "Запланировано" / "Добавить файлы или
    // инструменты" / null. Содержит название модели.
    return Array.from(document.querySelectorAll('button[aria-haspopup="menu"]'))
      .find(b => {
        const lbl = (b.getAttribute('aria-label') || '').trim();
        if (!lbl) return false;
        // Совпадение по имени УЖЕ выбранной модели (e.g. "Gemini 3.1 Pro",
        // "Claude Sonnet 4.6 Thinking").
        if (/GPT|Sonar|Gemini|Claude|Лучш|Best|Kimi|Nemotron/i.test(lbl)) return true;
        // ВАЖНО: на свежей странице (модель ещё не выбрана) триггер имеет
        // дефолтный label "Модель"/"Model" — НЕ имя модели. Раньше regex его
        // не ловил → model.trigger_not_found → выбор модели молча скипался,
        // research шёл на дефолте аккаунта (баг: opus/любая не применялась).
        // Спарсено с живой главной 2026-05: aria-label="Модель", text="Модель".
        return /^(Модель|Model)$/i.test(lbl);
      });
  }
  function findModelMenuItem(label) {
    return Array.from(document.querySelectorAll('[role="menuitemradio"], [role="menuitemcheckbox"]'))
      .find(el => (el.textContent || '').trim().startsWith(label));
  }
  // Locked-detect: доступные модели = role="menuitemradio" (кликабельны),
  // Max/locked модели = role="menuitem" (не radio, без aria-checked). Спарсено
  // с живой страницы 2026-05: "GPT-5.5 Max"/"Claude Opus 4.8 Max" → menuitem.
  // Ищем ЛЮБОЙ пункт меню (включая locked) по тексту, чтобы отличить
  // «недоступна» от «нет такой».
  function findAnyModelItemByLabel(label) {
    return Array.from(document.querySelectorAll('[role="menuitemradio"], [role="menuitem"]'))
      .find(el => (el.textContent || '').trim().startsWith(label));
  }
  async function ensureModelSelected({ model, reasoning = true } = {}) {
    // Резолвим ярлык юзера ("gemini"/"gpt"/"Claude Sonnet"/…) в каноничную
    // строку меню через единый реестр PPLX_MODELS.
    const targetLabel = resolvePplxModel(model);
    // Модель задана ЯВНО юзером? Тогда провал выбора фатален (заказал
    // конкретную модель для сравнения → молчаливый ответ дефолтным Gemini
    // = ложь). Если модель НЕ задана (дефолт) — провал терпим, едет на
    // текущей. Тот же контракт fatal-if-explicit, что у claude/chatgpt.
    const modelExplicit = !!model;
    // Триггер модели рендерится позже композера (особенно в hidden tab).
    // Без waitFor одиночная проверка выдавала model.trigger_not_found и модель
    // не выбиралась (баг: оставалась дефолтная аккаунта). Ждём до 8с.
    let trigger;
    try {
      trigger = await waitFor(() => findModelTrigger(), 'model trigger', 8000);
    } catch (e) {
      log('model.trigger_not_found', { target: targetLabel });
      if (modelExplicit) throw new Error('pplx_model_select_failed: триггер модели не найден за 8с (выбрана «' + targetLabel + '»)');
      return;
    }
    nativeMouseClick(trigger);
    await sleep(400);
    if (trigger.getAttribute('aria-expanded') !== 'true') {
      nativeMouseClick(trigger);
      await sleep(400);
    }
    // 1. Модель.
    try {
      // Сначала проверяем, есть ли модель ВООБЩЕ (включая locked-варианты),
      // чтобы отличить «недоступна (Max)» от «нет такой модели в списке».
      const anyItem = await waitFor(() => findAnyModelItemByLabel(targetLabel), 'model item: ' + targetLabel, 8000);
      const isClickable = anyItem.getAttribute('role') === 'menuitemradio';
      if (!isClickable) {
        // Locked / Max-only модель (role="menuitem", не radio). Не кликаем —
        // даём понятную ошибку, чтобы вызвавший (нейронка/юзер) знал почему.
        pressEscape();
        log('model.locked', { model: targetLabel });
        throw new Error('pplx_model_locked: модель "' + targetLabel + '" недоступна на текущем тарифе (Max). Выбери другую.');
      }
      if (anyItem.getAttribute('aria-checked') !== 'true') {
        nativeMouseClick(anyItem);
        await sleep(400);
        log('model.clicked', { model: targetLabel });
        // Перечитываем dropdown после клика — Perplexity может закрыть menu.
        const triggerAfter = findModelTrigger();
        if (triggerAfter && triggerAfter.getAttribute('aria-expanded') !== 'true') {
          nativeMouseClick(triggerAfter);
          await sleep(400);
        }
      } else {
        log('model.already_set', { model: targetLabel });
      }
    } catch (e) {
      // pplx_model_locked — terminal, пробрасываем наверх. Если модель задана
      // ЯВНО и пункт не нашёлся — тоже фатал (заказал конкретную → не получил).
      // Только дефолтная модель терпит провал (едет на текущей аккаунта).
      if (/pplx_model_locked/.test(e?.message || '')) throw e;
      log('model.select_failed', { err: e?.message, target: targetLabel });
      if (modelExplicit) throw new Error('pplx_model_select_failed: модель «' + targetLabel + '» не выбралась (' + (e?.message || 'пункт не найден') + ')');
    }
    // 2. Toggle Рассуждение.
    try {
      const reasoningItem = await waitFor(() => findModelMenuItem('Рассуждение'), 'reasoning toggle', 5000);
      const isOn = reasoningItem.getAttribute('aria-checked') === 'true';
      // Toggle бывает disabled (некоторые модели/режимы не дают менять
      // reasoning — spec показал aria-disabled:true). Не кликаем по disabled.
      if (reasoningItem.getAttribute('aria-disabled') === 'true') {
        log('reasoning.disabled_toggle', { isOn });
      } else if (reasoning && !isOn) {
        nativeMouseClick(reasoningItem);
        await sleep(300);
        log('reasoning.enabled');
      } else if (!reasoning && isOn) {
        nativeMouseClick(reasoningItem);
        await sleep(300);
        log('reasoning.disabled');
      } else {
        log('reasoning.already', { isOn });
      }
    } catch (e) {
      log('reasoning.toggle_failed', { err: e?.message });
    }
    pressEscape();
    await sleep(200);
  }

  function pasteIntoComposer(text) {
    const ed = findComposer();
    if (!ed) throw new Error('no composer');
    ed.focus();
    // Perplexity использует Lexical editor — он не реагирует на
    // execCommand из isolated world. Реальный путь — синтезировать
    // ClipboardEvent('paste') с DataTransfer'ом; Lexical его слушает
    // и корректно вставляет текст.
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
    ed.dispatchEvent(ev);
  }
  async function clickSubmit() {
    // Primary: Enter в composer'е. Самый надёжный путь для contenteditable
    // submit — это keydown Enter. Perplexity (как и большинство LLM-форм)
    // отправляет на Enter без модификаторов.
    const ed = findComposer();
    if (ed) {
      ed.focus();
      ed.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', code:'Enter', keyCode:13, which:13, bubbles:true, cancelable:true }));
      ed.dispatchEvent(new KeyboardEvent('keypress', { key:'Enter', code:'Enter', keyCode:13, which:13, bubbles:true, cancelable:true }));
      ed.dispatchEvent(new KeyboardEvent('keyup', { key:'Enter', code:'Enter', keyCode:13, which:13, bubbles:true, cancelable:true }));
      // Дать React 800мс на обработку и переход в /search/<uuid>.
      await sleep(800);
      // Проверим — submit-button пропал ИЛИ URL сменился? Значит сработало.
      if (!findSubmitBtn() || location.pathname.startsWith('/search/')) return;
    }
    // Fallback: клик на кнопку.
    const b = findSubmitBtn();
    if (!b) throw new Error('no submit button (Отправить)');
    nativeMouseClick(b);
  }

  function startDoneWatcher(onDone, onProgress) {
    let stopAppeared = false;
    let lastUrl = location.href;
    const armedAt = Date.now();
    const ARMING_MS = 700;
    // Quiet-window: Stop должен пропасть и НЕ вернуться ≥ 3с (калька с
    // claude-research.js). Между завершением документа и началом
    // «дополнительного ответа» Perplexity может на пару секунд убрать Stop —
    // без quiet-window watcher словил бы done в этой паузе. 3с покрывает её.
    const QUIET_WINDOW_MS = 3000;
    let lastStopSeenAt = 0;

    // hasDocument: research-карточка СУЩЕСТВУЕТ (h1.font-editorial). НЕ маркер
    // завершения — карточка появляется в DOM ещё на стриме (spinner ◯ крутится,
    // len растёт от ~370 до десятков тысяч). Нужен только чтобы отличить
    // research-flow (есть документ) от обычного ответа (нет документа).
    const hasDocument = () => !!findDocCardRoot();

    // documentComplete: документ ДОСТРОЕН. Детерминированно из живого capture
    // (t=408 стрим: stop:true,spin:1,dl:false,len:373 ⟷ done: spin:0,dl:true,
    // len:24528):
    //   1. Спиннер ◯ внутри карточки ([class*=animate-spin]) исчез — обязательно
    //      (пока крутится — документ пишется).
    //   2. И ЛИБО появилась кнопка "Скачать" (её даёт только завершённый
    //      документ — сильный сигнал, есть у всех research-карточек), ЛИБО текст
    //      стабилен ≥1.5с по времени (time-based, не tick-based — tick идёт до
    //      60/сек через rAF, счётчик тиков сработал бы за 33мс; backstop на
    //      случай документа без "Скачать").
    // Раньше done срабатывал по голому hasDocument() → копировался фрагмент
    // (~370 симв вместо 24500). См. fact-deep-research.md::done-detection.
    const DOC_STABLE_MS = 1500;
    let docLastLen = -1, docLastLenAt = 0;
    const documentComplete = () => {
      const root = findDocCardRoot();
      if (!root) { docLastLen = -1; return false; }
      if (root.querySelector('[class*="animate-spin"]')) { docLastLen = -1; return false; } // ещё стримит
      if (Array.from(root.querySelectorAll('button')).some(b => /Скачать/.test(b.textContent || ''))) return true;
      const len = (root.innerText || '').length;
      const now = Date.now();
      if (len !== docLastLen) { docLastLen = len; docLastLenAt = now; return false; }
      return len > 0 && (now - docLastLenAt) >= DOC_STABLE_MS;
    };

    let tickN = 0;
    let lastTickSig = null;   // последняя сигнатура состояния — лог только на смену
    const tick = () => {
      const submit = findSubmitBtn();
      const stop = findStopBtn();
      const now = Date.now();
      if (stop) { stopAppeared = true; lastStopSeenAt = now; }
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        onProgress({ stage: 'running', url: lastUrl, title: document.title });
      }
      const armed = now - armedAt >= ARMING_MS;
      const doc = hasDocument();
      const docDone = doc && documentComplete();
      const sinceStopGone = lastStopSeenAt ? (now - lastStopSeenAt) : 0;
      const quietPassed = !stopAppeared || sinceStopGone >= QUIET_WINDOW_MS;
      // Лог tick'а ТОЛЬКО при изменении наблюдаемого состояния. MutationObserver
      // на body+subtree+attributes срабатывает сотни раз/сек при стриме ответа —
      // если логировать каждый tick, лог захлёбывается (было n:1056→1136 за 1с).
      // Сигнатура включает docDone/quiet — иначе не видно момента достройки.
      tickN++;
      const sig = [!!submit, !!stop, doc, docDone, armed, quietPassed].join(',');
      if (sig !== lastTickSig) {
        lastTickSig = sig;
        const dbg = { n: tickN, submit: !!submit, stop: !!stop, stopAppeared, doc, docDone, armed, quiet: quietPassed, vis: document.visibilityState };
        log('watcher.tick', dbg);
        bridgeLog('pplx.watcher.tick', dbg, getRequestId(), null);
      }
      if (!armed) return false;
      if (stop) return false;            // композер ещё стримит (Stop активен)
      if (!quietPassed) return false;    // Stop ушёл <3с назад — может вернуться (доп.ответ)
      // Done:
      //   - research-flow (есть документ): ждём ДОСТРОЙКИ карточки
      //     (spinner ушёл + появилась "Скачать"), не просто появления h1.
      //   - обычный ответ (документа нет): submit-button вернулся.
      const isDone = doc ? docDone : !!submit;
      if (isDone) {
        log('watcher.done', { stop_seen: stopAppeared, doc_seen: doc, doc_complete: docDone });
        bridgeLog('pplx.watcher.done', { stop_seen: stopAppeared, doc_seen: doc, doc_complete: docDone }, getRequestId(), null);
        onDone({
          url: location.href, title: document.title,
          stop_seen: stopAppeared,
          doc_seen: doc,
          doc_complete: docDone,
        });
        return true;
      }
      return false;
    };

    // Single-shot guard, см. claude-research.js.
    let fired = false;
    const wrappedTick = () => {
      if (fired) return true;
      const ok = tick();
      if (ok) fired = true;
      return ok;
    };

    if (wrappedTick()) return () => {};

    // rAF-throttle (см. одинаковый комментарий в claude-research.js).
    let scheduled = false;
    const onMutation = () => {
      if (scheduled || fired) return;
      scheduled = true;
      requestAnimationFrame(() => { scheduled = false; wrappedTick(); });
    };
    const mo = new MutationObserver(onMutation);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label', 'disabled'] });
    // 2с (было 20с): в hidden-вкладке done детектился с задержкой до ~20с
    // после готовности ответа — между MutationObserver-тишиной и редким
    // interval'ом. 2с дёшево (тик — пара querySelector). Плюс глобальный
    // window.__scResearchTick переиспользуется reload-loop'ом (он тикает
    // каждые 15с даже под intensive-throttling, доказано pplx.reload.tick).
    const iv = setInterval(() => { try { if (!fired) wrappedTick(); } catch (_) {} }, 2000);
    window.__scResearchTick = () => { try { if (!fired) wrappedTick(); } catch (_) {} };

    // SW-driven watchdog: chrome.alarms в SW каждые 30с шлёт __sc_research_poke.
    // В hidden tab setInterval(20000) может throttle'иться intensive-таймером
    // (Chromium/Yandex), а MutationObserver молчит когда DOM не меняется —
    // тогда done не детектится пока юзер не кликнет на вкладку (визуально:
    // «research завершился только после переключения на вкладку»). alarm НЕ
    // throttled (privilege API), poke даёт гарантированный tick. Этот биндинг
    // ОТСУТСТВОВАЛ → poke.no_handler в логе, watchdog бил впустую. Калька с
    // claude-research.js::startDoneWatcher.
    const pokeHandler = () => {
      try { if (!fired) wrappedTick(); } catch (_) {}
    };
    window.__scResearchPoke = pokeHandler;

    const hardTimer = setTimeout(() => {
      try { mo.disconnect(); } catch {}
      clearInterval(iv);
      if (!fired) onProgress({ stage: 'timeout', url: location.href });
    }, MAX_FLOW_MS);

    return () => {
      try { mo.disconnect(); } catch {}
      clearInterval(iv);
      clearTimeout(hardTimer);
      if (window.__scResearchPoke === pokeHandler) window.__scResearchPoke = null;
      window.__scResearchTick = null;
    };
  }

  function startKeepAlivePort() {
    try {
      const port = chrome.runtime.connect({ name: 'sc-research-keepalive' });
      return () => { try { port.disconnect(); } catch {} };
    } catch (e) {
      log('keepalive.port_fail', { err: e?.message || String(e) });
      return () => {};
    }
  }

  // Force-reload watchdog. ТА ЖЕ проблема что в claude-research.js: Yandex
  // (и Chromium intensive throttling) могут заморозить background tab,
  // MutationObserver перестаёт срабатывать, watcher молчит. Bridge log
  // показывал rsz243mtfmp9eil7w: stage=running в 06:35:53 и сразу
  // stage=done в 06:42:39 (6m 53s) — done пришёл только когда юзер
  // переключился на вкладку. Force-reload каждые 90с с момента старта
  // (после ARM-период) гарантирует что вкладка периодически дёргается
  // и watcher переинжектится.
  //
  // Reload при активном Stop — ТОЛЬКО по ЗАСТОЮ контента (stagnantMs ≥
  // STAGNATION_MS), не по таймеру. Раньше был FORCE_RELOAD_MS=5мин «force
  // despite streaming» — он ломал живой длинный Deep Research: reload →
  // re-inject CS → re-run mode-select → pplx_daily_limit на почти готовом
  // research'е (живой capture rriqxvq3: sonar искал 6.8 мин, reload убил его
  // на t=347s). Длинный research — норма; завис — это когда DOM НЕ растёт.
  //
  // Терминальный маркер у perplexity: h1.font-editorial (research-документ)
  // ИЛИ findSubmitBtn (обычный ответ завершён). Если он виден — research
  // окончен, отменяем reload-iv.
  function startPeriodicReload(id) {
    const PERIOD_MS = 90000;
    const pageLoadTs = performance.timeOrigin;
    const forceReloadFromTs = researchStartTs || pageLoadTs;
    // Не reload'имся пока Stop не появился хоть раз — submit мог не
    // сработать (composer пустой / disabled), тогда reload даст пустой /new.
    let stopEverSeen = false;
    const watchInterval = setInterval(() => {
      if (findStopBtn()) stopEverSeen = true;
    }, 2000);

    // Застой-трекер для force-reload. Дискриминатор «здоровый идущий research»
    // vs «SPA-завис» — ИЗМЕНЕНИЕ контента, не время. Живой capture доказал: Deep
    // Research (sonar) легитимно искал ~6.8 мин со stop:true всё время, карточка
    // появилась только в конце. Старый таймер FORCE_RELOAD_MS=5мин бил по
    // живому research'у → reload → re-inject → re-run mode-select →
    // pplx_daily_limit на 90%-готовом research'е. Теперь reload-despite-streaming
    // только если контент ЗАСТЫЛ. См. fact-deep-research.md::force-reload по застою.
    const STAGNATION_MS = 4 * 60 * 1000; // 4 мин без ЛЮБЫХ изменений = подозрение на завис
    // Сигнатура «живости» страницы. ЛЮБОЕ изменение (рост ИЛИ сжатие) = research
    // жив. Считать только рост нельзя: synthesis-фаза может сокращать видимый
    // статус ("Reading 51 sources" → "Synthesizing"), длина падает, но страница
    // активна — счётчик-по-росту ложно начал бы стагнацию. Сигнатура = длина
    // документа + длина body + наличие Stop: меняется на каждой стадии.
    const livenessSig = () => {
      const root = findDocCardRoot();
      const docLen = root ? (root.innerText || '').length : 0;
      return docLen + ':' + (document.body.innerText || '').length + ':' + (findStopBtn() ? 1 : 0);
    };
    let lastSig = livenessSig();
    let lastProgressAt = Date.now();
    let tickCount = 0;
    const iv = setInterval(() => {
      const elapsed = Date.now() - pageLoadTs;
      const sinceResearchStart = Date.now() - forceReloadFromTs;
      // Обновляем застой-трекер: ЛЮБАЯ смена сигнатуры — research жив, сбрасываем.
      const curSig = livenessSig();
      const curLen = parseInt(curSig, 10) || 0; // doc-длина для логов
      if (curSig !== lastSig) { lastSig = curSig; lastProgressAt = Date.now(); }
      const stagnantMs = Date.now() - lastProgressAt;
      // Диагностический tick: видеть что iv реально fires (а не throttled
      // intensive timer'ом). При следующем pplx-зависе сразу будет видно
      // в bridge log: либо reload.tick идёт — значит throttle ОК, watcher
      // сломан; либо tick'и пропадают — значит вкладка целиком заморожена.
      const tickInfo = {
        elapsedS: Math.round(elapsed/1000),
        sinceResearchStartS: Math.round(sinceResearchStart/1000),
        stopEverSeen,
        hasStop: !!findStopBtn(),
        hasSubmit: !!findSubmitBtn(),
        contentLen: curLen,
        stagnantS: Math.round(stagnantMs/1000),
        visibility: document.visibilityState,
      };
      log('reload.tick', tickInfo);
      // Piggyback: дёрнуть done-watcher из reload-loop'а. reload-iv тикает
      // надёжно даже под intensive-throttling (доказано: pplx.reload.tick идёт
      // каждые 15с в hidden tab), а done-watcher'ский setInterval/MutationObserver
      // могут быть заморожены. Это гарантирует детект done максимум за ~15с
      // после готовности ответа, без ожидания force-reload (90с).
      try { window.__scResearchTick && window.__scResearchTick(); } catch (_) {}
      // Зеркалим в bridge — без этого при следующем зависе невозможно
      // отличить «iv был frozen целиком» от «iv тикал но skip'ал по guard».
      // Шлём каждый 4-й tick (60с) чтобы не флудить production.log.
      tickCount++;
      if (tickCount % 4 === 1) {
        bridgeLog('pplx.reload.tick', tickInfo, id, null);
      }
      if (elapsed < PERIOD_MS) return;
      if (!stopEverSeen) {
        log('reload.skip.research_not_started');
        bridgeLog('pplx.reload.skip.research_not_started', null, id, null);
        return;
      }
      // Если research-документ уже в DOM — research успешно закончен,
      // watcher вот-вот сработает на done. Reload его убьёт.
      const docs = document.querySelectorAll('div.prose.dark\\:prose-invert.max-w-none h1.font-editorial');
      if (docs.length > 0) {
        log('reload.skip.doc_visible');
        clearInterval(iv);
        clearInterval(watchInterval);
        return;
      }
      // Submit вернулся (классический done) — watcher тоже вот-вот fire.
      if (findSubmitBtn() && !findStopBtn()) {
        log('reload.skip.submit_back');
        clearInterval(iv);
        clearInterval(watchInterval);
        return;
      }
      if (findStopBtn()) {
        // Stop активен. Дискриминатор «жив» vs «завис» — ИЗМЕНЕНИЕ контента, не время.
        // Пока сигнатура менялась за последние STAGNATION_MS — research идёт, НЕ трогаем
        // (даже если это уже 10+ минут: длинный Deep Research — норма). Reload тут
        // ломал живой research: re-inject → re-run mode-select → pplx_daily_limit.
        if (stagnantMs < STAGNATION_MS) {
          log('reload.skip.streaming', {
            sinceResearchStartS: Math.round(sinceResearchStart/1000),
            stagnantS: Math.round(stagnantMs/1000),
            contentLen: curLen,
          });
          return;
        }
        // Контент застыл ≥ STAGNATION_MS при активном Stop → вероятный SPA-завис
        // (claude-style: backend закончил, UI не обновил). Только теперь форсим.
        log('reload.force_stagnant', {
          sinceResearchStartS: Math.round(sinceResearchStart/1000),
          stagnantS: Math.round(stagnantMs/1000),
          contentLen: curLen,
        });
        bridgeLog('pplx.reload.force_stagnant', { stagnantS: Math.round(stagnantMs/1000), contentLen: curLen }, id, null);
      }
      const sinceStartS = Math.round((Date.now() - forceReloadFromTs)/1000);
      log('reload.firing', {
        elapsedS: Math.round(elapsed/1000),
        sinceResearchStartS: sinceStartS,
      });
      // Persistent stage в bridge: даже если tab убит после reload, наружу
      // видно сколько раз сработал и в какой момент.
      try {
        postState(id, { stage: 'reloading_t' + sinceStartS + 's_pl' + Math.round(elapsed/1000) + 's' });
      } catch (_) {}
      setTimeout(() => { try { location.reload(); } catch (_) {} }, 200);
    }, 15000);
    return () => { clearInterval(iv); clearInterval(watchInterval); };
  }

  async function main() {
    // Boot log — пишется на КАЖДЫЙ инжект, даже если id не найден. Зеркалится
    // в bridge (production.log), потому что dbg-sink умирает с reload'ом.
    // См. claude-research.js — идентичная диагностика.
    const myTabId = await getMyTabId();
    const bootInfo = {
      url: location.href,
      query: location.search || '',
      hasWindowName: !!window.name,
      windowName: (window.name || '').slice(0, 80),
      visibility: document.visibilityState,
      timeOrigin: performance.timeOrigin,
      tabId: myTabId,
    };
    log('cs.boot', bootInfo);
    bridgeLog('cs.boot', bootInfo, null, myTabId);

    // Self-register реестра моделей в бридж (источник правды — PPLX_MODELS).
    // Нейронка/UI читают GET /pplx-models. fire-and-forget, не блокирует флоу.
    try {
      bfetch('/pplx-models-register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          models: PPLX_MODELS.map(m => ({ name: m.match, locked: !!m.locked, aliases: m.aliases })),
          default: PPLX_DEFAULT_MODEL,
        }),
      }).catch(() => {});
    } catch (_) {}

    let id = getRequestId();
    let recovered = false;
    if (!id) {
      // Нет query-param и нет window.name. Возможно crash-restore / discard /
      // Perplexity SPA-переход. Recovery через tabId — bridge помнит привязку.
      log('main.no_id_try_recover');
      bridgeLog('cs.no_id_try_recover', { hasQuery: !!location.search, hasWindowName: !!window.name }, null, myTabId);
      id = await recoverIdByTabId();
      if (!id) {
        log('main.no_id_recovery_failed');
        bridgeLog('cs.no_id_recovery_failed', null, null, myTabId);
        return;
      }
      recovered = true;
      log('main.id_from_recovery', { id });
      bridgeLog('cs.id_from_recovery', { id }, id, myTabId);
    }
    log('main.start', { id, url: location.href, recovered });

    const stopKeepAlive = startKeepAlivePort();

    // Heartbeat — если вкладка зафрижена браузером, эти log'и перестанут
    // появляться в DOM sink'е, и при диагностике мы это увидим.
    const hbIv = setInterval(() => {
      try { log('hb', new Date().toISOString().slice(11, 19)); } catch (_) {}
    }, 30000);
    // Очищаем когда watcher завершится (done/error/timeout).
    const stopHb = () => clearInterval(hbIv);

    let job;
    try { job = await fetchJob(id); }
    catch (e) {
      log('main.fetchJob_fail', { err: e?.message });
      try { stopHb(); } catch {}
          try { stopKeepAlive(); } catch {}
      return;
    }
    if (job.status === 'done' || job.status === 'error') {
      log('main.already_terminal', { status: job.status });
      try { stopHb(); } catch {}
          try { stopKeepAlive(); } catch {}
      return;
    }

    // MCP-плашка (общий research-badge.js). Тот же зелёный card что на
    // AI Studio — юзер видит «эта вкладка под research-job» на всех
    // провайдерах. Модель резолвится через тот же реестр что и при выборе.
    try {
      const mode = job.options?.mode === 'search' ? 'Быстрый поиск' : 'Deep Research';
      const modelTitle = resolvePplxModel(job.options?.model) + ' · ' + mode;
      window.scResearchBadge?.show({ jobId: id, providerLabel: 'Perplexity', modelTitle, prompt: job.prompt || '' });
    } catch {}

    // stopReload объявлен ДО try чтобы catch'и (которые могут сработать
    // на любом await ниже) могли его дёрнуть. Дефолт — noop.
    let stopReload = () => {};
    try {
      await waitFor(() => findComposer(), 'composer', 15000);
      // tabId в первый postState — чтобы bridge сохранил его в job-record
      // (раньше tabId оставался null → Tab ID:-1 в Истории, нельзя перейти
      // на вкладку). myTabId получен в начале main() через getMyTabId().
      await postState(id, { status: 'running', stage: 'configuring',
        ...(typeof myTabId === 'number' ? { tabId: myTabId } : {}) });
      const mode = job.options?.mode === 'search' ? 'search' : 'deep';
      await ensureModeSelected(mode);
      // Модель — из options (ярлык резолвится через реестр PPLX_MODELS).
      // Дефолт (PPLX_DEFAULT_MODEL = Gemini 3.1 Pro) применяется внутри
      // resolvePplxModel когда options.model не задан. reasoning по умолч.
      // true, можно выключить options.reasoning=false. Полный пропуск выбора
      // модели — options.skipModelSelect=true.
      if (!job.options?.skipModelSelect) {
        await ensureModelSelected({
          model: job.options?.model,
          reasoning: job.options?.reasoning !== false,
        });
      }
      await postState(id, { stage: 'submitting' });
      pasteIntoComposer(job.prompt);
      // Give React time to register composer state + enable submit button.
      // 200мс мало для Lexical editor Perplexity — submit может быть ещё
      // disabled, в DOM кнопки нет.
      await sleep(800);
      await clickSubmit();
      await postState(id, { stage: 'running' });
      // Submit-verify fallback (контракт юзера: «кнопка отправки не сменила
      // состояние → ошибка, не вечный running»). Маркеры успеха: Stop появился
      // ИЛИ ушли с composer-страницы на /search/<uuid> (Perplexity редиректит
      // мгновенно — это тоже подтверждение отправки). Зеркало
      // claude-research.js::startSubmitVerify / chatgpt NO_STOP_FAIL_MS.
      {
        const SUBMIT_VERIFY_MS = 90000;
        const t0 = Date.now();
        const submitted = () => !!findStopBtn() || location.pathname.startsWith('/search/');
        const verifyIv = setInterval(() => {
          try {
            if (submitted()) { clearInterval(verifyIv); log('submit.verified', { afterMs: Date.now() - t0 }); return; }
            if (Date.now() - t0 >= SUBMIT_VERIFY_MS) {
              clearInterval(verifyIv);
              if (submitted()) return;
              log('submit.verify_failed', { afterMs: Date.now() - t0 });
              bridgeLog('pplx.submit.verify_failed', { afterMs: Date.now() - t0 }, id, null);
              // Этот путь ничего не disarm'ит (нет teardown после), но финал
              // должен долететь надёжно — confirmed-with-retry, как все terminal'ы.
              postTerminalState(id, {
                status: 'error', stage: 'submit_failed',
                url: location.href, title: document.title,
                error: 'pplx_submit_failed: кнопка отправки не сменила состояние за 90с — промпт не ушёл',
              });
            }
          } catch (_) {}
        }, 2000);
      }

      // Force-reload watchdog. См. startPeriodicReload comment — fix для
      // Yandex tab-freeze (research молчит пока юзер не активирует tab).
      stopReload = startPeriodicReload(id);

      const stopWatcher = startDoneWatcher(
        async (final) => {
          // Дать Perplexity 800мс на финализацию rest/thread (последний step
          // appears с задержкой после Stop→Submit transition).
          await sleep(800);
          const extracted = await extractAnswerText();

          // Детерминированные флаги для caller'а (см. claude-research.js
          // та же логика):
          //   is_research — для perplexity = (text_kind === 'document').
          //                 thread_answer = обычный ответ или clarifying.
          //   is_clarifying — heuristic на коротком ответе.
          const txt = extracted.text || '';
          const isResearch = extracted.kind === 'document';
          const isShort = txt.length > 0 && txt.length < 800;
          const endsWithQuestion = /\?\s*$/.test(txt);
          const hasClarifyPhrases = /\b(could you (please )?clarify|would you like|which (of these|specific)|what (kind|type|exactly)|do you want me to|should I focus on|are you (interested|looking)|let me know|уточни(те)?|какой именно|что (именно|вы хотите))\b/i.test(txt);
          const isClarifying = !isResearch && isShort && (endsWithQuestion || hasClarifyPhrases);

          log('watcher.done', {
            ...final,
            textLen: txt.length,
            kind: extracted.kind,
            is_research: isResearch,
            is_clarifying: isClarifying,
          });
          const confirmed = await postTerminalState(id, {
            status: 'done',
            stage: 'done',
            url: final.url,
            title: final.title,
            result: {
              url: final.url,
              title: extracted.doc_title || final.title,
              text: extracted.text || '',
              // text_kind:
              //   'document'      — финальный research-документ из DOM (карточка со "Скачать"),
              //                      главный артефакт — то что юзеру реально нужно.
              //   'thread_answer' — fallback: последний answer из /rest/thread (обычные ответы,
              //                      clarifying questions, когда research-документа ещё нет).
              //   'empty'/'no_*'  — ничего полезного не извлеклось.
              text_kind: extracted.kind,
              is_research: isResearch,        // bool: реальный Deep Research vs прямой ответ
              is_clarifying: isClarifying,    // bool: perplexity задал юзеру вопрос
              sources: extracted.sources || [],
              slug: extracted.slug || null,
            },
          });
          try { stopWatcher(); } catch {}
          try { stopReload(); } catch {}
          try { stopHb(); } catch {}
          try { window.scResearchBadge?.hide(); } catch {}
          // Auto-close tab + снятие keepalive ТОЛЬКО если bridge подтвердил done.
          // Иначе порт живой (tab-closed fallback вооружён) + вкладка открыта
          // (результат виден) — лучше «лишняя вкладка», чем зомби-running.
          if (confirmed) {
            try { stopKeepAlive(); } catch {}
            try {
              chrome.runtime.sendMessage({ __sc_close_self_tab: true, reason: 'research_done' });
            } catch {}
          } else {
            log('done.unconfirmed_keep_tab_open');
          }
        },
        async (prog) => {
          if (prog.stage === 'timeout') {
            const ok = await postTerminalState(id, { status: 'error', stage: 'timeout', error: 'flow timed out (30min)' });
            try { stopReload(); } catch {}
            try { stopHb(); } catch {}
            if (ok) { try { stopKeepAlive(); } catch {} } // не подтвердилось → порт живой
            try { window.scResearchBadge?.hide(); } catch {}
            // Timeout = НЕ детерминированная ошибка (что-то реально зависло на
            // странице) → НЕ закрываем, оставляем для ручной диагностики.
            return;
          }
          await postState(id, { stage: prog.stage, url: prog.url, title: prog.title });
        }
      );
    } catch (e) {
      const msg = e?.message || String(e);
      log('main.flow_err', { err: msg });
      const ok = await postTerminalState(id, { status: 'error', error: msg });
      try { stopReload(); } catch {}
      try { stopHb(); } catch {}
      if (ok) { try { stopKeepAlive(); } catch {} } // не подтвердилось → порт живой, fallback вооружён
      try { window.scResearchBadge?.hide(); } catch {}
      // Закрываем вкладку ТОЛЬКО при ДЕТЕРМИНИРОВАННЫХ ошибках — заранее
      // известных условиях, где смотреть на странице нечего:
      //   - pplx_daily_limit  — лимит Deep Research исчерпан (модалка-апселл)
      //   - pplx_model_locked — модель недоступна на тарифе (Max)
      //   - pplx_mode_switch_failed — режим не переключился (UI predictable)
      // Любая ДРУГАЯ ошибка (что-то сломалось/не отобразилось на странице) —
      // НЕ закрываем, оставляем для ручного разбора (юзер смотрит логи+страницу).
      // Закрываем только если bridge подтвердил error — иначе вкладку оставляем
      // открытой (порт живой), чтобы tab-closed fallback не остался единственной
      // защитой при потерянном POST (race onRemoved↔onDisconnect).
      if (ok && /pplx_daily_limit|pplx_model_locked|pplx_mode_switch_failed/.test(msg)) {
        closeSelfTab('research_deterministic');
      }
    }
  }

  // Закрыть свою вкладку через SW. reason='research_done' → быстро; иначе 4с.
  function closeSelfTab(reason) {
    try { chrome.runtime.sendMessage({ __sc_close_self_tab: true, reason }); } catch {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => main().catch(e => log('main.uncaught', { err: e?.message })));
  } else {
    main().catch(e => log('main.uncaught', { err: e?.message }));
  }
})();
