// SC Browser Parser — Deep Research на claude.ai.
//
// Триггер: вкладка открыта на claude.ai/new#sc-research=<requestId>.
// requestId — в bridge'е (in-memory), забираем через GET /research-job.
//
// Flow:
//   1. fetch http://127.0.0.1:53127/research-job?id=<id> → { provider, prompt, options }
//   2. Включаем Research toggle в «+» меню (если ещё не включён).
//      Если выскочит Confirm dialog (Enable connectors) — жмём Confirm.
//   3. Paste prompt в ProseMirror chat-input → click "Send message".
//   4. MutationObserver на смене aria-label у submit-button:
//      Send → Stop (research пошёл) → Stop → Send (done).
//      MutationObserver НЕ тротлится Chrome'ом в фоновых вкладках,
//      см. hh-tool docs::fact-extension-runtime.md::v0.8.5.
//   5. На done — извлекаем URL/title/первую research-card → POST /research-state.
//
// Anti-throttling:
//   - chrome.runtime.connect({name:'sc-research-keepalive'}) — long-lived
//     port обходит intensive throttling (1/мин после 5 мин фонового).
//     Обычный 1/сек throttling нас не убивает потому что MutationObserver
//     immune к таймерам — детектор стабилен в фоне.
//
// Лог в DOM-узле #sc-research-dbg-log — MCP без userScripts может его
// прочитать через get_text.

(function () {
  'use strict';

  const BRIDGE = 'http://127.0.0.1:53127';
  const TAG = '[SC-CR]'; // claude-research
  const MAX_FLOW_MS = 30 * 60 * 1000; // 30 min cap

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

  // SW-driven watchdog. SW alarm каждые 30с шлёт {__sc_research_poke}.
  // setInterval в hidden tab throttled, MutationObserver молчит когда DOM
  // не меняется — poke даёт нам гарантированный tick раз в 30с.
  // window.__scResearchPoke выставляется внутри startDoneWatcher.
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

  async function waitFor(predicate, why, timeoutMs = 15000, intervalMs = 200) {
    const t0 = performance.now();
    while (true) {
      let v; try { v = predicate(); } catch (_) { v = null; }
      if (v) return v;
      if (performance.now() - t0 > timeoutMs) throw new Error('timeout: ' + why);
      await sleep(intervalMs);
    }
  }

  // requestId жизненный цикл:
  //   1. MCP открыл вкладку на claude.ai/new#sc-research=<id> — hash есть.
  //   2. claude.ai после создания чата делает history.pushState на
  //      /chat/<uuid> БЕЗ hash. URL теряет sc-research-маркер.
  //   3. Periodic reload (или любая навигация) сбрасывает hash безвозвратно.
  //
  // Без persistence main() после первого reload'а возвращает null и не
  // переподнимает watcher/keepalive — research уходит в зомби-state
  // (DOM есть, никто его не смотрит, MCP-wait висит до hard-cap).
  //
  // Persistence: window.name. Это string в window object, переживает
  // location.reload(), history.pushState/popstate, любую same-origin
  // навигацию. НЕ переживает закрытие вкладки или открытие новой —
  // что нам и нужно. chrome.storage.local требует async + ключ по tabId,
  // которого у CS нет напрямую; window.name проще и точнее.
  // window.name format: "sc-research:<id>:<researchStartTsMs>"
  // researchStartTsMs — Date.now() в момент первого старта research'а.
  // Переживает reload, нужен для force-reload счётчика 5min (без него
  // каждый reload обнуляет performance.timeOrigin и порог не достигается).
  const WINDOW_NAME_PREFIX = 'sc-research:';
  // ResearchStart timestamp (ms). Заполняется в getRequestId. null если ещё нет.
  let researchStartTs = null;
  function getRequestId() {
    // 1) Свежий hash от MCP-открытой вкладки.
    const m = (location.hash || '').match(/sc-research=([\w-]+)/);
    if (m) {
      const id = m[1];
      researchStartTs = Date.now();
      try { window.name = WINDOW_NAME_PREFIX + id + ':' + researchStartTs; } catch (_) {}
      return id;
    }
    // 2) Fallback: window.name после reload / pushState.
    try {
      const wn = String(window.name || '');
      if (wn.startsWith(WINDOW_NAME_PREFIX)) {
        const rest = wn.slice(WINDOW_NAME_PREFIX.length);
        const parts = rest.split(':');
        const id = parts[0];
        const ts = parseInt(parts[1] || '0', 10);
        if (id) {
          researchStartTs = Number.isFinite(ts) && ts > 0 ? ts : Date.now();
          // Backfill timestamp если был старый формат без него.
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

  // Все запросы к bridge — через scBridgeFetch (research-badge.js): page-fetch
  // с fallback на SW-fetch. Страничный канал на claude.ai БЫЛ убит юзерским
  // «Блокировать» в LNA-диалоге (permissions 'local-network-access'='denied',
  // fetch падал TypeError за 12мс) → job вечно queued. SW-канал LNA не трогает.
  function bfetch(path, init) {
    if (typeof window.scBridgeFetch === 'function') return window.scBridgeFetch(path, init);
    return fetch(BRIDGE + path, init);
  }

  async function fetchJob(id) {
    const r = await bfetch('/research-job?id=' + encodeURIComponent(id));
    if (!r.ok) throw new Error('fetchJob http ' + r.status);
    return await r.json();
  }

  // Persistent log в bridge'е. CS pipeline бывает крашится / reload'ится,
  // local dbg-sink (#sc-research-dbg-log) тогда исчезает. bridge log
  // переживает tab close — нужен для post-mortem.
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

  async function postState(id, patch) {
    try {
      // provider всегда в payload — это нужно bridge'у чтобы recreate
      // job при respin'е (bridge RAM-only терял state). Без провайдера
      // bridge не знает что за platform у CS, и вернёт 404.
      const r = await bfetch('/research-state', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, provider: 'claude', ...patch }),
      });
      if (!r.ok) log('postState.http_err', { status: r.status, patch });
    } catch (e) {
      log('postState.threw', { err: e?.message || String(e) });
    }
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
          body: JSON.stringify({ id, provider: 'claude', ...patch }),
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
    bridgeLog('claude.terminal.giveup', { id, want, attempts }, id, null);
    return false;
  }

  // ── Selectors ──────────────────────────────────────────────────────
  // Сняты вручную через mcp__browser__ на claude.ai (см. процесс
  // разработки). Если Anthropic поменяет DOM — менять здесь. См. также
  // docs/knowledge/fact-claude-research.md (если/когда заведём).

  function findComposer()    { return document.querySelector('[data-testid="chat-input"]'); }
  function findAddMenuBtn()  { return document.querySelector('button[aria-label="Add files, connectors, and more"]'); }
  function findSendBtn()     { return document.querySelector('button[aria-label="Send message"]'); }
  function findStopBtn()     { return document.querySelector('button[aria-label="Stop response"]'); }
  function findResearchPanelBtn() {
    return Array.from(document.querySelectorAll('button[aria-label]'))
      .find(b => /Open research panel/i.test(b.getAttribute('aria-label') || ''));
  }
  // Defence-in-depth: action-bar-copy появляется ПОСЛЕ КАЖДОГО завершённого
  // ответа (включая research). Если Antropic уберёт "Open research panel"
  // карточку при редизайне, этот сигнал останется. Он менее специфичен
  // (срабатывает на любом ответе), но в нашем flow Send→Stop→Send гарантирует
  // что это именно НАШ ответ, а не предыдущий — мы стартуем с пустого чата.
  function findActionBarCopy() {
    return document.querySelector('[data-testid="action-bar-copy"]');
  }

  // Извлечь текст финального ассистент-ответа.
  // Структура (май 2026):
  //   [data-testid="user-message"]  ← последнее юзер-сообщение
  //   ...turn-wrappers...
  //     div.standard-markdown.grid-cols-1.grid  ← assistant text (markdown rendered)
  // Берём последний `div.standard-markdown`, идущий ПОСЛЕ последнего
  // user-message по document order. Если кейс «Claude задал уточняющий
  // вопрос» — это всё равно один и тот же блок, последний в чате.
  // Возвращает {text, kind:'answer'|'research_card_only'}. research_card_only
  // означает: панель Open research panel есть, а текстового блока ещё нет
  // (Claude в режиме research показывает только карточку без summary).
  function extractAnswerText() {
    const users = document.querySelectorAll('[data-testid="user-message"]');
    const lastUser = users[users.length - 1] || null;
    const allMarkdowns = Array.from(document.querySelectorAll('div.standard-markdown'));
    // Из main thread'а исключаем artifact-pane markdown — она по DOM-order
    // тоже "after lastUser", но это содержимое отдельной side-panel'и, не
    // основного ответа. Возьмём только то что вне any artifact-pane.
    let candidates = allMarkdowns.filter(el => !el.closest('[aria-label*="artifact" i]'));
    if (lastUser) {
      candidates = candidates.filter(el =>
        (lastUser.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
      );
    }
    const last = candidates[candidates.length - 1];
    if (last) {
      const text = (last.innerText || last.textContent || '').trim();
      if (text) return { text, kind: 'answer' };
    }
    // Fallback: research-card есть, текста ещё нет.
    return { text: '', kind: 'research_card_only' };
  }

  // Найти artifact-card (Document attachment под summary в research-ответе).
  // Возвращает {viewBtn, title} или null. viewBtn — внутренний <button
  // aria-label="View ..."> которым открывается side-pane.
  function findArtifactCard() {
    const blocks = Array.from(document.querySelectorAll('[class*="group/artifact-block"]'));
    for (const block of blocks) {
      const btn = block.querySelector('button[aria-label^="View"]');
      if (btn) {
        const titleEl = block.querySelector('.font-tiempos, [class*="font-bold"]') || block;
        return {
          viewBtn: btn,
          title: (btn.getAttribute('aria-label') || '').replace(/^View\s+/, '').trim(),
        };
      }
    }
    return null;
  }

  // Открыть artifact-pane, прочитать его .standard-markdown целиком, закрыть.
  // claude.ai иногда рендерит документ как 29K-char standalone artifact, а в
  // main thread'е оставляет только summary-card на 800-1500 chars. Без этого
  // юзер получит «teaser» вместо полного ответа.
  async function extractArtifactDocument() {
    const card = findArtifactCard();
    if (!card) return null;
    try {
      // ── Open ─────────────────────────────────────────────
      ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(t => {
        const r = card.viewBtn.getBoundingClientRect();
        card.viewBtn.dispatchEvent(new MouseEvent(t, {
          bubbles:true, cancelable:true, view:window,
          clientX:r.x+r.width/2, clientY:r.y+r.height/2, button:0,
        }));
      });
      // ── Wait ─────────────────────────────────────────────
      // Документ — это .standard-markdown ВНУТРИ artifact-pane (любой
      // ancestor с aria-label*="artifact"), длиной >= 200 chars.
      const deadline = Date.now() + 8000;
      let mdEl = null;
      while (Date.now() < deadline) {
        const mds = Array.from(document.querySelectorAll('div.standard-markdown'));
        mdEl = mds.find(el => {
          if (!el.closest('[aria-label*="artifact" i]')) return false;
          const txt = el.innerText || '';
          return txt.length >= 200;
        });
        if (mdEl) break;
        await sleep(150);
      }
      const text = mdEl ? (mdEl.innerText || mdEl.textContent || '').trim() : '';
      log('artifact.extracted', { found: !!mdEl, len: text.length, title: card.title });
      // ── Close ────────────────────────────────────────────
      const closeBtn = Array.from(document.querySelectorAll('button')).find(b =>
        (b.getAttribute('aria-label') || '').toLowerCase() === 'close artifact'
      );
      if (closeBtn) {
        ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(t => {
          const r = closeBtn.getBoundingClientRect();
          closeBtn.dispatchEvent(new MouseEvent(t, {
            bubbles:true, cancelable:true, view:window,
            clientX:r.x+r.width/2, clientY:r.y+r.height/2, button:0,
          }));
        });
      }
      if (!mdEl) return null;
      return { text, title: card.title };
    } catch (e) {
      log('artifact.extract_err', { err: e?.message });
      return null;
    }
  }
  function findConfirmInDialog() {
    const dlg = document.querySelector('[role="dialog"], [role="alertdialog"]');
    if (!dlg) return null;
    return Array.from(dlg.querySelectorAll('button')).find(b => /^Confirm$/i.test((b.textContent || '').trim()));
  }

  // claude.ai требует РАЗНЫЕ способы клика на разные элементы:
  //   - radix popover trigger ('+' menu) → pointer chain (pointerdown/up)
  //   - menu items (Research checkbox) → pointer chain
  //   - Send message button → pointer chain (это обычный submit-button)
  //   - Confirm в "Enable connectors" dialog → MAIN-world .click() (этот
  //     dialog режет dispatched chain как «ненастоящий», нужен trusted-like)
  //
  // Поэтому nativeMouseClick — это alias для pointer chain (default safe),
  // а mainWorldClick — отдельный helper для Confirm-dialog'а.
  function nativeMouseClick(el) {
    if (!el) return;
    nativeMousePointerChain(el);
  }

  // Клик в MAIN world через chrome.scripting.executeScript в background SW.
  // Inline <script> CSP claude.ai режет (script-src 'self' nonce-...), но
  // chrome.scripting.executeScript — это extension API, CSP его не касается.
  // Content-script ставит data-attr на элемент, SW делает executeScript
  // в MAIN world который .click()'ает по этому селектору. Async.
  let __mwcCounter = 0;
  async function mainWorldClick(el) {
    if (!el) return false;
    try {
      const mark = 'sc-mw-' + (++__mwcCounter);
      el.setAttribute('data-sc-mw-click', mark);
      const resp = await new Promise(resolve => {
        chrome.runtime.sendMessage({ __sc_main_click: true, markId: mark }, r => {
          if (chrome.runtime.lastError) resolve({ ok: false, err: chrome.runtime.lastError.message });
          else resolve(r || { ok: false, err: 'no response' });
        });
      });
      if (!resp?.ok) {
        log('mwc.fail', { err: resp?.err });
        nativeMousePointerChain(el);
        return false;
      }
      return true;
    } catch (e) {
      log('mwc.err', { err: e?.message });
      nativeMousePointerChain(el);
      return false;
    }
  }
  // Pointer-chain для radix trigger'ов (popover open/close). Они слушают
  // pointerdown, не click — простой .click() не сработает.
  function nativeMousePointerChain(el) {
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

  // ── Реестр моделей claude.ai (снят с живого DOM 2026-06) ──────────────
  // Верхние 4 — radio прямо в model-меню; more:true — в submenu «More models».
  // efforts — какие радио есть в Effort-подменю у этой модели (data-testid
  // effort-option-<key> стабильны и locale-independent). toggle:
  //   'thinking'      — switch «Thinking» внутри effort-подменю
  //   'extended'      — switch «Extended» внутри effort-подменю (Opus 4.6)
  //   'extended-main' — switch «Extended» прямо в ГЛАВНОМ меню (Haiku: у неё
  //                     вообще нет Effort-подменю)
  //   null            — нет тумблера (Fable 5, Opus 3)
  // match — против textContent радио. ВАЖНО: верхние радио склеивают имя с
  // описанием без пробела («Opus 4.8For complex tasks»), \b между «8» и «F»
  // НЕ существует (оба word-chars) — поэтому anchored prefix БЕЗ \b.
  const CLAUDE_MODELS = {
    'fable-5':    { display: 'Fable 5',    match: /^Fable\s*5/i,     more: false, efforts: ['low','medium','high','extra','max'], toggle: null },
    'opus-4.8':   { display: 'Opus 4.8',   match: /^Opus\s*4\.8/i,   more: false, efforts: ['low','medium','high','extra','max'], toggle: 'thinking' },
    'sonnet-4.6': { display: 'Sonnet 4.6', match: /^Sonnet\s*4\.6/i, more: false, efforts: ['low','medium','high','max'],         toggle: 'thinking' },
    'haiku-4.5':  { display: 'Haiku 4.5',  match: /^Haiku\s*4\.5/i,  more: false, efforts: [],                                    toggle: 'extended-main' },
    'opus-4.7':   { display: 'Opus 4.7',   match: /^Opus\s*4\.7/i,   more: true,  efforts: ['low','medium','high','extra','max'], toggle: 'thinking' },
    'opus-4.6':   { display: 'Opus 4.6',   match: /^Opus\s*4\.6/i,   more: true,  efforts: ['low','medium','high','max'],         toggle: 'extended' },
    'opus-3':     { display: 'Opus 3',     match: /^Opus\s*3(?!\d|\.)/i, more: true, efforts: [],                                 toggle: null },
  };
  const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'extra', 'max'];

  function resolveModel(raw) {
    if (!raw) return null;
    const s = String(raw).toLowerCase().trim().replace(/\s+/g, '-');
    if (CLAUDE_MODELS[s]) return s;
    return ({
      'fable': 'fable-5', 'fable5': 'fable-5',
      'opus': 'opus-4.8', 'opus4.8': 'opus-4.8',
      'sonnet': 'sonnet-4.6', 'sonnet4.6': 'sonnet-4.6',
      'haiku': 'haiku-4.5', 'haiku4.5': 'haiku-4.5',
      'opus4.7': 'opus-4.7',
      'opus4.6': 'opus-4.6',
      'opus3': 'opus-3',
    })[s] || null;
  }
  function resolveEffort(raw) {
    if (!raw) return null;
    const s = String(raw).toLowerCase().trim();
    return CLAUDE_EFFORTS.includes(s) ? s : null;
  }

  // Базовые меню base-ui НЕ удаляются из DOM при закрытии — закрытые
  // инстансы лежат рядом с открытым (живой пробой видели 4 [role=menu]
  // одновременно). Любой поиск item'ов ОБЯЗАН фильтровать по видимости,
  // иначе матчится stale-узел из прошлого открытия. rect>0 недостаточно:
  // скрытие может быть visibility:hidden / aria-hidden у предка — проверяем всё.
  function isVis(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    try {
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return false;
      if (el.closest('[aria-hidden="true"], [inert], [hidden]')) return false;
    } catch (_) {}
    return true;
  }
  function visibleAll(sel, root) {
    return Array.from((root || document).querySelectorAll(sel)).filter(isVis);
  }
  function hoverEl(el) {
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    ['pointerover','pointerenter','pointermove','mouseover','mouseenter','mousemove'].forEach(t =>
      el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y })));
  }

  // Текущая модель из aria-label триггера: «Model: Opus 4.6 Medium» —
  // собственная декларация claude.ai (имя + label уровня). Для skip/verify.
  function currentModelLabel() {
    const trig = document.querySelector('[data-testid="model-selector-dropdown"]');
    return ((trig && trig.getAttribute('aria-label')) || '').replace(/^Model:\s*/i, '').trim();
  }

  async function openModelMenu() {
    const trig = document.querySelector('[data-testid="model-selector-dropdown"]');
    if (!trig) throw new Error('no model-selector-dropdown');
    if (trig.getAttribute('aria-expanded') !== 'true') {
      nativeMousePointerChain(trig);
      await sleep(350);
      if (trig.getAttribute('aria-expanded') !== 'true') {
        nativeMousePointerChain(trig);
        await sleep(450);
      }
    }
    return trig;
  }

  async function closeAllMenus() {
    for (let i = 0; i < 3; i++) {
      if (!visibleAll('[role="menu"]').length) return;
      pressEscape();
      await sleep(250);
    }
  }

  // jobId для bridgeLog из ensure*-функций (выставляется в main()).
  let currentJobId = null;

  // ── Выбор модели: verify-and-retry ×2 ─────────────────────────────────
  // Состояние модели у claude.ai sticky per-account → проверяем КАЖДЫЙ run,
  // «skip если дефолт» недопустим (шрам chatgpt). Verify — по aria-label
  // триггера (после клика радио меню закрывается само).
  async function ensureModelSelected(modelKey) {
    const model = CLAUDE_MODELS[modelKey];
    if (!model) { log('model.unknown', { modelKey }); return false; }
    if (currentModelLabel().startsWith(model.display)) {
      log('model.already', { modelKey, label: currentModelLabel() });
      return true;
    }
    const findRadio = () => visibleAll('[role="menuitemradio"]')
      .filter(el => !(el.getAttribute('data-testid') || '').startsWith('effort-option'))
      .find(el => model.match.test((el.textContent || '').trim()));
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await openModelMenu();
        let radio = findRadio();
        if (!radio && model.more) {
          // Tier-2 модели живут в submenu «More models» — открывается hover'ом,
          // click — fallback (как pro-submenu в chatgpt).
          const moreItem = visibleAll('[role="menuitem"]').find(el => /more models/i.test(el.textContent || ''));
          if (moreItem) {
            hoverEl(moreItem);
            await sleep(700);
            radio = findRadio();
            if (!radio) {
              nativeMousePointerChain(moreItem);
              await sleep(500);
              radio = findRadio();
            }
          }
        }
        if (!radio) { log('model.radio_not_found', { modelKey, attempt }); await closeAllMenus(); continue; }
        if (radio.getAttribute('aria-checked') === 'true') {
          await closeAllMenus();
          log('model.already_checked', { modelKey });
          return true;
        }
        nativeMousePointerChain(radio);
        await sleep(600); // клик по радио закрывает меню
        const ok = await waitFor(() => currentModelLabel().startsWith(model.display) || null, 'model label update', 2500, 200).catch(() => null);
        await closeAllMenus();
        if (ok) {
          log('model.selected', { modelKey, label: currentModelLabel() });
          bridgeLog('claude.model.selected', { modelKey, label: currentModelLabel() }, currentJobId, null);
          return true;
        }
        log('model.verify_mismatch', { modelKey, attempt, label: currentModelLabel() });
      } catch (e) {
        log('model.attempt_err', { attempt, err: e?.message });
        await closeAllMenus();
      }
    }
    log('model.select_failed', { modelKey, label: currentModelLabel() });
    bridgeLog('claude.model.select_failed', { modelKey, label: currentModelLabel() }, currentJobId, null);
    return false;
  }

  // Открыть Effort-подменю (hover по trigger'у, click — fallback). Возвращает
  // trigger или null если Effort-подменю у текущей модели нет (Haiku, Opus 3).
  async function openEffortSubmenu() {
    await openModelMenu();
    const trig = visibleAll('[data-testid="effort-menu-trigger"]')[0];
    if (!trig) return null;
    hoverEl(trig);
    try {
      await waitFor(() => visibleAll('[data-testid^="effort-option-"]').length ? true : null, 'effort submenu', 1500, 150);
    } catch (_) {
      nativeMousePointerChain(trig);
      await waitFor(() => visibleAll('[data-testid^="effort-option-"]').length ? true : null, 'effort submenu (click)', 2000, 150);
    }
    return trig;
  }

  // ── Уровень Effort: verify-and-retry через aria-checked ───────────────
  // Non-fatal: если уровень не выставился — research всё равно поедет на
  // текущем (sticky) уровне, факт пишем в bridge-log.
  async function ensureEffortSelected(modelKey, effortKey) {
    const model = modelKey ? CLAUDE_MODELS[modelKey] : null;
    if (model && !model.efforts.length) {
      log('effort.not_applicable', { modelKey, effortKey });
      return false;
    }
    if (model && !model.efforts.includes(effortKey)) {
      // Реестр говорит «у модели нет такого уровня» (например extra у Sonnet).
      // Не прерываем — DOM правее реестра, радио просто не найдётся.
      log('effort.unsupported_for_model', { modelKey, effortKey, known: model.efforts });
    }
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const trig = await openEffortSubmenu();
        if (!trig) { log('effort.no_menu', { modelKey, attempt }); await closeAllMenus(); return false; }
        const radio = visibleAll(`[data-testid="effort-option-${effortKey}"]`)[0];
        if (!radio) {
          log('effort.option_missing', { effortKey, present: visibleAll('[data-testid^="effort-option-"]').map(el => el.getAttribute('data-testid')) });
          await closeAllMenus();
          bridgeLog('claude.effort.option_missing', { modelKey, effortKey }, currentJobId, null);
          return false;
        }
        if (radio.getAttribute('aria-checked') === 'true') {
          await closeAllMenus();
          log('effort.selected', { effortKey, attempt });
          bridgeLog('claude.effort.selected', { effortKey, modelKey }, currentJobId, null);
          return true;
        }
        nativeMousePointerChain(radio);
        await sleep(500); // клик закрывает меню; следующий виток откроет и проверит
      } catch (e) {
        log('effort.attempt_err', { attempt, err: e?.message });
        await closeAllMenus();
      }
    }
    // Финальная проверка после двух кликов.
    try {
      const trig = await openEffortSubmenu();
      const radio = trig && visibleAll(`[data-testid="effort-option-${effortKey}"]`)[0];
      const ok = !!radio && radio.getAttribute('aria-checked') === 'true';
      await closeAllMenus();
      if (ok) {
        log('effort.selected', { effortKey, final: true });
        bridgeLog('claude.effort.selected', { effortKey, modelKey }, currentJobId, null);
        return true;
      }
    } catch (_) { await closeAllMenus(); }
    log('effort.select_failed', { effortKey });
    bridgeLog('claude.effort.select_failed', { effortKey, modelKey }, currentJobId, null);
    return false;
  }

  // ── Тумблер Thinking/Extended ─────────────────────────────────────────
  // Независим от уровня: «может быть Max, но Thinking выключен». Где живёт:
  // у Haiku — switch прямо в главном меню; у остальных — внутри Effort-подменю.
  // Ищем generic: главное меню → если switch'а нет, открываем Effort-подменю.
  // Switch-click НЕ закрывает меню → verify на месте.
  async function ensureThinkingToggle(modelKey, want) {
    const model = modelKey ? CLAUDE_MODELS[modelKey] : null;
    if (model && !model.toggle) {
      log('thinking.not_applicable', { modelKey, want });
      return false;
    }
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await openModelMenu();
        let sw = visibleAll('button[role="switch"]')[0];
        if (!sw) {
          const trig = await openEffortSubmenu();
          if (trig) sw = visibleAll('button[role="switch"]')[0];
        }
        if (!sw) { log('thinking.switch_missing', { modelKey, attempt }); await closeAllMenus(); continue; }
        const cur = sw.getAttribute('aria-checked') === 'true';
        if (cur === want) {
          await closeAllMenus();
          log('thinking.set', { want, already: true, label: sw.getAttribute('aria-label') });
          return true;
        }
        nativeMousePointerChain(sw);
        await sleep(350);
        const after = visibleAll('button[role="switch"]')[0];
        const now = after ? after.getAttribute('aria-checked') === 'true' : null;
        await closeAllMenus();
        if (now === want) {
          log('thinking.set', { want, label: (after && after.getAttribute('aria-label')) || null });
          bridgeLog('claude.thinking.set', { want, modelKey }, currentJobId, null);
          return true;
        }
        log('thinking.verify_mismatch', { want, now, attempt });
      } catch (e) {
        log('thinking.attempt_err', { attempt, err: e?.message });
        await closeAllMenus();
      }
    }
    log('thinking.set_failed', { want, modelKey });
    bridgeLog('claude.thinking.set_failed', { want, modelKey }, currentJobId, null);
    return false;
  }

  // ── «+»-меню: Research toggle + Web search всегда включён ─────────────
  // researchOn=true → чекбокс Research включаем (фатально если пункта нет:
  // без него режим не запустить). researchOn=false → выключаем если липко
  // остался включённым (обычный вопрос модели). Web search — ВСЕГДА on
  // (юзер: «ситуации когда захочу отключить — не представляю»), non-fatal.
  async function ensurePlusMenuConfig(researchOn) {
    const trigger = findAddMenuBtn();
    if (!trigger) throw new Error('no "Add files, connectors, and more" button');
    nativeMousePointerChain(trigger);
    await sleep(300);
    if (trigger.getAttribute('aria-expanded') !== 'true') {
      log('menu.not_opened', { again: true });
      nativeMousePointerChain(trigger);
      await sleep(400);
    }
    await waitFor(() => visibleAll('[role="menuitemcheckbox"]').length ? true : null, 'plus menu items', 5000);
    const RESEARCH_RE = /^(Research|Исследование)$/i;
    const WEB_RE = /^(Web search|Веб-поиск|Поиск в интернете)$/i;
    // У ВКЛЮЧЁННОГО пункта textContent содержит глиф-чекмарк Anthropicons
    // (PUA-символ, в логах невидим) — строгий `$`-anchor не матчился, и
    // item_missing показывал present=["Web search"] при «не найден». Тот же
    // шрам что «Confirm⏎»: текст кнопок claude.ai дополняется глифами.
    // Нормализуем: оставляем только буквы/цифры/пробелы.
    const norm = (s) => String(s || '').replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
    const find = (re) => visibleAll('[role="menuitemcheckbox"]').find(n => re.test(norm(n.textContent)));

    // Чекбокс-клик в base-ui НЕ закрывает меню (старый flow кликал Research
    // и потом явно жал Escape) — оба пункта обрабатываем за одно открытие.
    const setChecked = async (re, want, fatalIfMissing, name) => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        let el = find(re);
        if (!el && attempt === 1) { await sleep(400); el = find(re); } // поздний рендер пункта
        if (!el) {
          // Диагностика: что вообще видно в меню (для post-mortem «пункт не нашёлся»).
          const present = visibleAll('[role="menuitemcheckbox"]').map(n => (n.textContent || '').trim().slice(0, 30));
          log('plusmenu.item_missing', { name, present });
          bridgeLog('claude.plusmenu.item_missing', { name, present }, currentJobId, null);
          if (fatalIfMissing) throw new Error(`"${name}" item not found in plus-menu`);
          return null;
        }
        const cur = el.getAttribute('aria-checked') === 'true';
        if (cur === want) return true;
        nativeMousePointerChain(el);
        await sleep(350);
      }
      const el = find(re);
      return el ? (el.getAttribute('aria-checked') === 'true') === want : false;
    };

    const researchOk = await setChecked(RESEARCH_RE, !!researchOn, !!researchOn, 'Research');
    const webOk = await setChecked(WEB_RE, true, false, 'Web search');

    pressEscape();
    await sleep(150);
    log('plusmenu.configured', { researchOn, researchOk, webOk });
    bridgeLog('claude.plusmenu', { researchOn, researchOk, webOk }, currentJobId, null);
  }

  // ── Paste prompt в ProseMirror ────────────────────────────────────
  function pasteIntoComposer(text) {
    const ed = findComposer();
    if (!ed) throw new Error('no composer');
    ed.focus();
    // ProseMirror корректно ловит beforeinput с insertText.
    // execCommand устарел, но прокатывает; fallback на InputEvent.
    if (!document.execCommand('insertText', false, text)) {
      ed.dispatchEvent(new InputEvent('beforeinput', { inputType:'insertText', data:text, bubbles:true }));
    }
  }

  async function clickSend() {
    const send = findSendBtn();
    if (!send) throw new Error('no Send button');
    // Send-button требует MAIN-world .click() — pointer chain не пробивает
    // CSP claude.ai. Делаем через chrome.scripting.executeScript в SW.
    return await mainWorldClick(send);
  }

  // ── Submit-verify fallback ──────────────────────────────────────────
  // Контракт (юзер, явно): после отправки кнопка Send ОБЯЗАНА смениться на
  // Stop — если состояние не сменилось, отдавать ошибку, а не висеть 30 минут
  // в running. Реальный кейс: вкладка открылась «пустой» (paste/click не
  // сработал), Stop не появился, copy-маркера нет → watcher тикал до hard-cap,
  // юзер видел зомби в «Запущенные MCP». Маркеры успеха: Stop появился ИЛИ
  // наше user-message встало в DOM (короткие ответы успевают завершиться
  // раньше, чем мы увидим Stop). Зеркало chatgpt-research.js::NO_STOP_FAIL_MS.
  function startSubmitVerify(id, onFail) {
    const VERIFY_MS = 90000;
    const t0 = Date.now();
    const submitted = () =>
      !!findStopBtn() || document.querySelectorAll('[data-testid="user-message"]').length > 0;
    const iv = setInterval(() => {
      try {
        if (submitted()) {
          clearInterval(iv);
          log('submit.verified', { afterMs: Date.now() - t0 });
          return;
        }
        if (Date.now() - t0 >= VERIFY_MS) {
          clearInterval(iv);
          // Double-check прямо перед error — терминальный done мог проскочить.
          if (submitted()) return;
          log('submit.verify_failed', { afterMs: Date.now() - t0 });
          bridgeLog('claude.submit.verify_failed', { afterMs: Date.now() - t0 }, id, null);
          // onFail (stopAllRef) глушит watcher+reload+keepalive — то есть
          // обезоруживает и tab-closed fallback. Поэтому рвём всё ТОЛЬКО после
          // подтверждения error bridge'ем; иначе оставляем циклы живыми (watcher
          // ещё может поймать настоящий done, порт держит fallback вооружённым).
          postTerminalState(id, {
            status: 'error',
            stage: 'submit_failed',
            url: location.href,
            title: document.title,
            error: 'claude_submit_failed: кнопка отправки не сменилась на Stop за 90с — промпт не ушёл',
          }).then((ok) => {
            if (ok && typeof onFail === 'function') { try { onFail(); } catch (_) {} }
          });
        }
      } catch (_) {}
    }, 2000);
    return () => clearInterval(iv);
  }

  // ── Stopped/error detector (terminal-state, отдельно от done) ─────
  //
  // claude.ai может прервать research с ошибкой (например clarifying
  // question не ответили, connectors не включены). Этот случай выглядит
  // так: research-panel в DOM есть, но её aria-label начинается с
  // "Stopped: " — например:
  //   "Stopped: No response on which connectors to enable during research. Open research panel."
  // Кнопка disabled, никаких "N sources" в label не будет.
  //
  // Без этого детекта watcher уходит в hard-cap 30min, плюс
  // startPeriodicReload каждые 90с дёргает location.reload() (research
  // официально остановлен, но `stopEverSeen=true` и `findStopBtn()` == null
  // → reload триггерится). После reload — новый watcher, новый hard-cap,
  // снова 90с — цикл навсегда. См. fact-deep-research.md::Stopped detector.
  function findStoppedErrorPanel() {
    // panel может быть и в .panels[0] от findResearchPanelBtn, но строгий
    // селектор для terminal-error: aria-label начинается с "Stopped:".
    const panels = document.querySelectorAll('button[aria-label]');
    for (const p of panels) {
      const label = p.getAttribute('aria-label') || '';
      if (/^Stopped:/i.test(label)) return { el: p, label };
    }
    return null;
  }

  // ── Done detector ──────────────────────────────────────────────────
  // На submit'е Send → Stop. На завершении Stop пропадает; Send-кнопка
  // в DOM может НЕ вернуться (claude.ai после короткого ответа держит
  // композер свёрнутым). Terminal-маркер один из двух:
  //   - [data-testid="action-bar-copy"] (есть у любого завершённого
  //     ответа, claude.ai стабильно держит этот testid)
  //   - [aria-label*="Open research panel"] (специфично для research)
  //
  // Action-bar появляется ТОЛЬКО когда стрим завершён — никаких ложных
  // срабатываний на полу-готовом ответе. Поэтому `stopAppeared` мы не
  // требуем как обязательное предусловие — короткие ответы (2+2)
  // успевают завершиться раньше чем mutation-observer увидит Stop'у.
  //
  // MutationObserver immune к Chrome timer throttling.
  function startDoneWatcher(onDone, onProgress, opts) {
    // opts.isReloadRestart=true → CS заинжектился ПОСЛЕ reload (force-reload
    // в startPeriodicReload после 5 мин). Reload может произойти посередине
    // research'а когда в DOM ещё видна 210-сим preamble Claude'а + action-bar-copy
    // от неё. Watcher с дефолтом stopAppeared=false мгновенно срабатывает по
    // case 2 (copyBtn && !panelSeen → done) и эмитит false-done с preamble.
    //
    // Защита: для reload-restart считаем что Stop УЖЕ когда-то появлялся
    // (мы это знаем — research реально идёт по bridge.status=running). Это
    // активирует quiet-window (3с после исчезновения Stop) и ждёт реального
    // финала, а не сразу хапает preamble-copy.
    const isReloadRestart = !!(opts && opts.isReloadRestart);
    // expectResearch=false (options.research:false — обычный чат-запрос):
    // research-panel не появится никогда, ждать её 60с после каждого ответа
    // бессмысленно — копи-маркер принимаем сразу после quiet-window.
    const expectResearch = !(opts && opts.expectResearch === false);
    let stopAppeared = isReloadRestart;
    let lastUrl = location.href;
    const armedAt = Date.now();
    const ARMING_MS = 700;

    // Хитрость в Claude research-flow:
    //
    //   1. Submit → Claude рендерит короткое сообщение "Launching research..."
    //      в ОБЫЧНОМ message-блоке. Это сообщение завершается, появляется
    //      action-bar-copy у него.
    //   2. Stop button дёргается (есть → нет → есть).
    //   3. Только ПОСЛЕ этого появляется research-карточка с label
    //      "Setting up my research space..." → "Searching..." → ... →
    //      финальная "TITLE: N sources. Open research panel."
    //
    // Если детектить done по «action-bar-copy + нет Stop» — словим
    // ложный done в момент (1)+(2). Поэтому:
    //
    //   - Дожидаемся появления research-card (panel button) ИЛИ
    //     истечения NO_PANEL_GRACE_MS после первого ухода Stop.
    //   - Если panel так и не появился (обычный ответ без research'а) —
    //     done только при quiet window и наличии copy.
    //   - Если panel появился — игнорим copy, ждём panel.aria-label
    //     содержащий "N sources" + quiet window.
    //
    // Это убирает ложный done на старте research'а.
    const QUIET_WINDOW_MS = 3000;
    const NO_PANEL_GRACE_MS = 60000; // ждём панель до 60с после первого ухода Stop
    // Для isReloadRestart: устанавливаем lastStopSeenAt = armedAt чтобы
    // quiet-window (3с) был НЕ пройден до тех пор пока реально не пройдёт
    // 3с от armed-момента ИЛИ пока не появится новый Stop (тогда
    // lastStopSeenAt обновится естественно). Без этого sinceStopGone =
    // now - 0 = огромное, quietPassed=true мгновенно → false-done.
    let lastStopSeenAt = isReloadRestart ? armedAt : 0;
    let firstStopGoneAt = 0;
    let panelSeen = false;

    const isFinalPanelLabel = (label) => {
      // Финальная карточка research'а имеет шаблон
      // "<topic>: N sources. Open research panel." (EN) или
      // "<topic>: N источников. ..." (RU).
      //
      // ПРОМЕЖУТОЧНЫЙ label во время сбора источников:
      // "<topic>: N sources and counting.... Open research panel."
      // — count есть, но research НЕ завершён, Stop button ещё активен.
      // Исключаем "and counting" / "и считает".
      if (/and\s+counting/i.test(label)) return false;
      if (/и\s+считает/i.test(label)) return false;
      return /\b\d+\s+(source|sources|источник|источника|источников)\b/i.test(label);
    };

    let lastSig = '';
    const tick = () => {
      // Terminal-error: «Stopped: …» panel. Детектится отдельно от done —
      // это hard fail, не успешный финал. Без него watcher уходит в
      // hard-cap 30min плюс reload-цикл (см. fact-deep-research.md).
      const stoppedErr = findStoppedErrorPanel();
      if (stoppedErr) {
        log('watcher.stopped_detected', { label: stoppedErr.label.slice(0, 200) });
        onDone({
          url: location.href, title: document.title,
          panel_aria_label: stoppedErr.label,
          marker: 'stopped',
          stop_seen: stopAppeared,
          terminal_error: true,           // флаг для main() → POST error, не done
        });
        return true;
      }

      const send = findSendBtn();
      const stop = findStopBtn();
      const panel = findResearchPanelBtn();
      const copyBtn = findActionBarCopy();
      const panelLabel = panel ? (panel.getAttribute('aria-label') || '') : '';

      const now = Date.now();
      if (stop) { stopAppeared = true; lastStopSeenAt = now; }
      // Запомнить момент когда Stop ПЕРВЫЙ раз пропал (после того как был).
      // Точка отсчёта для NO_PANEL_GRACE.
      if (stopAppeared && !stop && firstStopGoneAt === 0) {
        firstStopGoneAt = now;
      }
      if (panel) panelSeen = true;

      if (location.href !== lastUrl) {
        lastUrl = location.href;
        onProgress({ stage: 'running', url: lastUrl, title: document.title });
      }

      const sinceStopGone = lastStopSeenAt ? (now - lastStopSeenAt) : 0;
      const sinceFirstStopGone = firstStopGoneAt ? (now - firstStopGoneAt) : 0;
      const sig = `send=${!!send}/stop=${!!stop}/copy=${!!copyBtn}/panel=${!!panel}/panelSeen=${panelSeen}/stopApp=${stopAppeared}/quiet=${stop?0:sinceStopGone}/finalPanel=${panel?isFinalPanelLabel(panelLabel):false}`;
      if (sig !== lastSig) {
        lastSig = sig;
        log('watcher.tick', sig + (panel ? ' label=' + panelLabel.slice(0,60) : ''));
      }

      if (now - armedAt < ARMING_MS) return false;
      if (stop) return false;

      // Quiet window — последний раз видели Stop ≥ QUIET_WINDOW_MS назад.
      const quietPassed = !stopAppeared || sinceStopGone >= QUIET_WINDOW_MS;
      if (!quietPassed) return false;

      // Случай 1: research-panel КОГДА-ЛИБО появлялась → это research-flow,
      // ждём финальный label с "N sources" (текущая panel может быть
      // промежуточной "Setting up..." без числа).
      if (panelSeen) {
        if (!panel || !isFinalPanelLabel(panelLabel)) return false;
        onDone({
          url: location.href, title: document.title,
          panel_aria_label: panelLabel,
          marker: 'panel',
          stop_seen: stopAppeared,
        });
        return true;
      }

      // Случай 2: research-panel ещё не появилась. Ждём NO_PANEL_GRACE_MS
      // после первого ухода Stop — panel может появиться с задержкой.
      // Если grace истёк и panel так и нет — это обычный ответ без research'а.
      // При expectResearch=false панели не будет по построению — grace skip.
      if (expectResearch && firstStopGoneAt && sinceFirstStopGone < NO_PANEL_GRACE_MS) {
        return false;
      }

      // Grace истёк или Stop ни разу не появлялся (короткий sync-ответ) →
      // обычный ответ.
      if (copyBtn) {
        onDone({
          url: location.href, title: document.title,
          panel_aria_label: '',
          marker: 'copy',
          stop_seen: stopAppeared,
        });
        return true;
      }
      return false;
    };

    // Single-shot guard: tick() возвращает true когда done detected. После
    // первого done — onDone больше не должен вызываться (он triggering POST
    // /research-state, на terminal-state расширение должно молчать).
    let fired = false;
    const wrappedTick = () => {
      if (fired) return true;
      const ok = tick();
      if (ok) fired = true;
      return ok;
    };

    if (wrappedTick()) return () => {};

    // MutationObserver immune к Chrome timer throttling, но на активном research'е
    // claude.ai генерит сотни мутаций в секунду. Гоним wrappedTick() через rAF-флаг —
    // максимум один tick на frame. Это держит CPU ниже 1% даже при busy DOM.
    let scheduled = false;
    const onMutation = () => {
      if (scheduled || fired) return;
      scheduled = true;
      requestAnimationFrame(() => { scheduled = false; wrappedTick(); });
    };
    const mo = new MutationObserver(onMutation);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label', 'disabled'] });

    // Quiet-window периодический tick: мутации после Stop пропали могут
    // прекратиться (Claude перешёл к рендерингу карточки и больше не
    // меняет DOM), но quiet window требует проверки времени. Тикaем
    // каждую 1с — мало для CPU, достаточно для 3-сек window.
    const iv = setInterval(() => { try { if (!fired) wrappedTick(); } catch (_) {} }, 1000);

    // SW-driven watchdog: chrome.alarms в SW каждые 30с шлёт нам
    // __sc_research_poke. setInterval в hidden tab может throttle'иться
    // до 1.5+ сек/tick — alarm НЕ throttled (privilege API). Подвешиваем
    // poke-handler в window чтобы CS-message-listener (вверху file'а) мог
    // его дёрнуть без капторования замыкания.
    const pokeHandler = () => {
      try { if (!fired) wrappedTick(); } catch (_) {}
    };
    window.__scResearchPoke = pokeHandler;

    // Hard cap.
    const hardTimer = setTimeout(() => {
      try { mo.disconnect(); } catch {}
      clearInterval(iv);
      log('watcher.hard_cap');
      if (!fired) onProgress({ stage: 'timeout', url: location.href });
    }, MAX_FLOW_MS);

    return () => {
      try { mo.disconnect(); } catch {}
      clearInterval(iv);
      clearTimeout(hardTimer);
      if (window.__scResearchPoke === pokeHandler) window.__scResearchPoke = null;
    };
  }

  // ── Confirm-dialog auto-clicker ─────────────────────────────────────
  // Claude.ai показывает диалог "Enable connectors for Claude to use in
  // research" → Confirm. Появляется ПОСЛЕ submit'а (не после toggle
  // Research), и только при ПЕРВОМ research'е в сессии браузера.
  // Anthropic держит диалог МАКСИМУМ ~30с — если не подтвердить, research
  // отменяется с "No response on which connectors to enable during research".
  // Это уже наблюдалось в логах.
  //
  // Observer'а на document.body НЕ ХВАТАЕТ — Claude рендерит диалог в
  // portal который может быть прямым потомком <html>. Вешаем на
  // documentElement + дополнительно опрашиваем каждые 500мс в течение
  // 60с (диалог обычно появляется через 2-10с после submit'а).
  function startConfirmAutoClicker(onClicked, onGiveUp) {
    // Confirm-dialog "Enable connectors for Claude to use in research"
    // появляется НЕ только в начале — claude.ai может показывать его
    // повторно через минуты после старта (например когда research зашёл
    // на новый коннектор-resource). Поэтому clicker должен оставаться
    // активным всё research-время, а не одноразово выключаться.
    //
    // Verify-and-retry: после mainWorldClick ok=true ждём VERIFY_MS,
    // проверяем что dialog исчез. Если нет — это была неудача (клик
    // был принят SW но не сработал в DOM — radix-ui игнорирует или
    // dialog заново появился). После MAX_FAIL подряд неудач — даём
    // terminal_error через onGiveUp, чтобы main flow перевёл job в
    // status='error' и MCP-wait разлочился. Без этого юзер сидит вечно.
    const VERIFY_MS = 1500;
    const MAX_FAIL = 5;
    let clicked = false;        // true пока текущий dialog ещё в DOM после клика
    let inflight = false;       // true пока mainWorldClick + verify в полёте
    let totalClicks = 0;
    let consecutiveFails = 0;
    let givenUp = false;
    const tryClick = () => {
      if (givenUp) return false;
      const dlg = document.querySelector('[role="dialog"], [role="alertdialog"]');
      if (!dlg) {
        // Dialog исчез — снимаем clicked, чтобы следующее появление было
        // воспринято как "новый dialog" и кликалось снова. Также сбрасываем
        // счётчик неудач — последний клик-то сработал, dialog ушёл.
        if (clicked) {
          clicked = false;
          consecutiveFails = 0;
          log('confirm.dialog_gone');
        }
        return false;
      }
      if (clicked || inflight) return true;
      const btn = Array.from(dlg.querySelectorAll('button')).find(b => {
        // claude.ai добавил keyboard-hint в кнопку: textContent теперь
        // "Confirm⏎" (Confirm + U+23CE), иногда с \n. Строгий /^Confirm$/
        // это НЕ матчил → кликер видел диалог, но не находил кнопку и тихо
        // ничего не жал (ноль confirm.* в логе). Нормализуем: убираем все
        // не-буквенные хвосты (hint-символы, \n, пробелы) и матчим первое
        // слово. Доказано на живом DOM 2026-05: trimmed="Confirm⏎".
        // Берём первое «слово» (последовательность букв) и сравниваем целиком.
        // \b в JS не Unicode-aware (ломается после кириллицы), поэтому не
        // полагаемся на него — извлекаем первый токен букв и матчим ===.
        const first = ((b.textContent || '').match(/\p{L}+/u) || [''])[0].toLowerCase();
        return first === 'confirm' || first === 'подтвердить' || first === 'ok';
      });
      if (!btn) return false;
      totalClicks += 1;
      log('confirm.click', { text: (btn.textContent||'').trim(), n: totalClicks });
      inflight = true;
      clicked = true;
      mainWorldClick(btn).then(ok => {
        if (!ok) {
          inflight = false;
          clicked = false;
          consecutiveFails += 1;
          log('confirm.retry_needed', { n: totalClicks, fails: consecutiveFails });
          if (consecutiveFails >= MAX_FAIL) {
            givenUp = true;
            log('confirm.give_up', { n: totalClicks });
            if (typeof onGiveUp === 'function') { try { onGiveUp(); } catch (_) {} }
          }
          return;
        }
        // SW сказал ok=true. Ждём VERIFY_MS, проверяем что dialog
        // действительно исчез. Если ещё там — клик не сработал по факту.
        setTimeout(() => {
          inflight = false;
          const still = document.querySelector('[role="dialog"], [role="alertdialog"]');
          if (still) {
            clicked = false;
            consecutiveFails += 1;
            log('confirm.click_ineffective', { n: totalClicks, fails: consecutiveFails });
            if (consecutiveFails >= MAX_FAIL) {
              givenUp = true;
              log('confirm.give_up', { n: totalClicks });
              if (typeof onGiveUp === 'function') { try { onGiveUp(); } catch (_) {} }
            }
          } else {
            consecutiveFails = 0;
            clicked = false;
            log('confirm.click_effective', { n: totalClicks });
          }
        }, VERIFY_MS);
      });
      if (typeof onClicked === 'function') { try { onClicked(); } catch (_) {} }
      return true;
    };
    tryClick();
    const mo = new MutationObserver(() => { try { tryClick(); } catch (_) {} });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    const iv = setInterval(() => { try { tryClick(); } catch (_) {} }, 500);
    return () => {
      try { mo.disconnect(); } catch {}
      clearInterval(iv);
    };
  }

  // ── Periodic reload: claude.ai SPA баг — research-progress перестаёт
  // обновляться через какое-то время; финальная карточка может не
  // отрендериться. Юзер подтвердил что F5 фиксит. Перезагружаем страницу
  // каждые 90с пока в panel-label не появится "N sources" (финальный
  // маркер), но не чаще чем раз в 60с после последнего reload'а.
  //
  // После reload'а content-script инжектируется заново (claude.ai/*
  // matched в manifest). Job-state идентифицируется через #hash —
  // requestId переживает reload. CS повторно делает fetch /research-job,
  // видит status='running' (а не queued/done) → НЕ нажимает submit
  // повторно, а сразу стартует watcher на уже существующем чате.
  //
  // Это требует чтобы CS отделял два сценария:
  //   - первый вход (status=queued) → submit pipeline
  //   - reload-restart (status=running) → только watcher
  function startPeriodicReload(id) {
    const PERIOD_MS = 90000;
    // pageLoadTs обнуляется на каждый reload, поэтому force-reload-5min
    // НЕ должен использовать его как точку отсчёта. researchStartTs хранится
    // в window.name persistent через reload — он реальный timestamp начала
    // research'а. Если researchStartTs не выставлен (corner-case) — fall
    // back на pageLoadTs.
    const pageLoadTs = performance.timeOrigin;
    const forceReloadFromTs = researchStartTs || pageLoadTs;
    // Не reload'имся пока research реально не стартовал — Stop button должен
    // был появиться хоть раз. Если submit не сработал и Stop не появился,
    // reload бессмысленен (попадём в /new с пустым чатом без шанса досабмитить).
    let stopEverSeen = false;
    const watchInterval = setInterval(() => {
      if (findStopBtn() || findResearchPanelBtn()) stopEverSeen = true;
    }, 2000);

    // Force-reload порог: после FORCE_RELOAD_MS reload срабатывает
    // ДАЖЕ если Stop button активный. Это нужно потому что claude.ai
    // SPA-bug: backend research завершился (~9 мин), но UI продолжает
    // показывать Stop button или флапает между состояниями. Без
    // force-reload watcher никогда не задетектит финал — Stop активный
    // блокирует quiet window. F5 решает мгновенно.
    //
    // 5 минут — это меньше чем минимальное время research'а (обычно 8-15
    // мин), поэтому ни один здоровый research не страдает: force-reload
    // в нём всё равно увидит Stop активный (валидный stream) на момент
    // 5min и сделает reload — это убьёт текущий стрим. Это компромисс:
    // потеря в-стриме редкая, выигрыш — детерминированный финиш зависших.
    const FORCE_RELOAD_MS = 5 * 60 * 1000;
    const iv = setInterval(() => {
      const elapsed = Date.now() - pageLoadTs;
      if (elapsed < PERIOD_MS) return;
      if (!stopEverSeen) {
        log('reload.skip.research_not_started');
        return;
      }
      // Если research terminal'но обломан ("Stopped: ..."), reload
      // только усугубит проблему: SPA восстановит ту же panel, reload
      // повторится через 90с и так навсегда. Watcher уже отправил
      // status='error', нам тут нечего делать.
      const stopped = findStoppedErrorPanel();
      if (stopped) {
        log('reload.skip.stopped_terminal', { label: stopped.label.slice(0, 120) });
        clearInterval(iv);
        clearInterval(watchInterval);
        return;
      }
      const panel = findResearchPanelBtn();
      const label = panel ? (panel.getAttribute('aria-label') || '') : '';
      // ИСКЛЮЧАЕМ "and counting" — это промежуточная стадия со счётчиком
      // sources, research ещё идёт. Финал = N sources БЕЗ "and counting".
      // Без exclude reload-iv останавливается на промежуточной 281 sources
      // and counting, и больше никогда не fire'ит даже при SPA-зависе.
      const hasNumberedSources = /\b\d+\s+(source|sources|источник|источника|источников)\b/i.test(label);
      const isIntermediate = /and\s+counting/i.test(label) || /и\s+считает/i.test(label);
      if (panel && hasNumberedSources && !isIntermediate) {
        log('reload.skip.final_visible', { label: label.slice(0, 80) });
        clearInterval(iv);
        clearInterval(watchInterval);
        return;
      }
      if (findStopBtn()) {
        // До FORCE_RELOAD_MS (от начала research'а, а не page-load!) —
        // уважаем streaming. После — считаем что Stop остался показан
        // из-за SPA-bug, всё равно reload. researchStartTs persists через
        // reload в window.name, поэтому счётчик не сбрасывается.
        const sinceResearchStart = Date.now() - forceReloadFromTs;
        if (sinceResearchStart < FORCE_RELOAD_MS) {
          log('reload.skip.streaming', {
            elapsed: Math.round(elapsed/1000) + 's',
            sinceResearchStart: Math.round(sinceResearchStart/1000) + 's',
          });
          return;
        }
        log('reload.force_despite_streaming', {
          elapsed: Math.round(elapsed/1000) + 's',
          sinceResearchStart: Math.round(sinceResearchStart/1000) + 's',
        });
      }
      const sinceStartS = Math.round((Date.now() - forceReloadFromTs)/1000);
      log('reload.firing', {
        elapsed: Math.round(elapsed/1000) + 's',
        sinceResearchStart: sinceStartS + 's',
        label: label.slice(0, 80),
      });
      // Сохраняем в bridge ДО reload — CS dbg-log умирает с tab. Bridge log
      // persistent. Если research зависнет — будем знать сколько раз reload-iv
      // fire'нул и почему.
      try {
        // Fire-and-forget: не await, иначе reload может задержаться.
        postState(id, { stage: 'reloading_t' + sinceStartS + 's_pl' + Math.round(elapsed/1000) + 's' });
      } catch (_) {}
      // Небольшая пауза чтобы fetch успел улететь до того как страница reload'ится.
      setTimeout(() => { try { location.reload(); } catch (_) {} }, 200);
    }, 15000);
    return () => { clearInterval(iv); clearInterval(watchInterval); };
  }

  // ── Anti-throttle: long-lived port в SW ────────────────────────────
  // Любая порт-связь содержит exemption от intensive throttling (после
  // 5 мин фоновой работы вкладки). Сам факт связи имеет значение, мы
  // ничего по ней не шлём. Закрываем когда research завершится.
  function startKeepAlivePort() {
    try {
      const port = chrome.runtime.connect({ name: 'sc-research-keepalive' });
      return () => { try { port.disconnect(); } catch {} };
    } catch (e) {
      log('keepalive.port_fail', { err: e?.message || String(e) });
      return () => {};
    }
  }

  // ── Main ──────────────────────────────────────────────────────────
  // Узнать свой tabId через SW. CS API не даёт прямой доступ, sendMessage
  // c sender.tab.id — единственный способ.
  function getMyTabId() {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ __sc_get_tab_id: true }, r => {
          // chrome.runtime.lastError — SW мог быть idle, ответа нет → null.
          if (chrome.runtime.lastError) { resolve(null); return; }
          resolve(r?.tabId ?? null);
        });
      } catch (_) { resolve(null); }
    });
  }
  async function recoverIdByTabId() {
    const tabId = await getMyTabId();
    if (tabId == null) {
      log('recover.no_tabid');
      return null;
    }
    try {
      const r = await bfetch('/research-by-tab?tabId=' + tabId);
      if (!r.ok) {
        log('recover.no_active', { tabId, status: r.status });
        return null;
      }
      const data = await r.json();
      const recoveredId = data?.id;
      if (!recoveredId) return null;
      log('recover.hit', { tabId, id: recoveredId, jobStatus: data.status, stage: data.stage });
      researchStartTs = data.createdAt || Date.now();
      try { window.name = WINDOW_NAME_PREFIX + recoveredId + ':' + researchStartTs; } catch (_) {}
      return recoveredId;
    } catch (e) {
      log('recover.threw', { err: e?.message });
      return null;
    }
  }

  async function main() {
    // Boot log — пишется на КАЖДЫЙ инжект, даже если id не найден.
    // Без него мы не отличаем "CS не запустился" от "CS запустился и вышел молча".
    // На основе этого лога диагностируется crash-restore сценарий (когда
    // page reload произошёл не через CS, hash и window.name пустые).
    const myTabId = await getMyTabId();
    const bootInfo = {
      url: location.href,
      hash: location.hash || '',
      hasWindowName: !!window.name,
      windowName: (window.name || '').slice(0, 80),
      visibility: document.visibilityState,
      timeOrigin: performance.timeOrigin,
      tabId: myTabId,
    };
    log('cs.boot', bootInfo);
    bridgeLog('cs.boot', bootInfo, null, myTabId);

    let id = getRequestId();
    let recovered = false;
    if (!id) {
      // Нет hash и нет window.name. Возможно crash-restore / discard /
      // непредвиденный reload. Пробуем recovery через tabId — bridge
      // помнит привязку research↔tabId.
      log('main.no_id_try_recover');
      bridgeLog('cs.no_id_try_recover', { hasHash: !!location.hash, hasWindowName: !!window.name }, null, myTabId);
      id = await recoverIdByTabId();
      if (!id) {
        log('main.no_id_recovery_failed');
        bridgeLog('cs.no_id_recovery_failed', null, null, myTabId);
        return; // не наш режим, или recovery не нашёл active research
      }
      recovered = true;
      log('main.id_from_recovery', { id });
      bridgeLog('cs.id_from_recovery', { id }, id, myTabId);
    }
    log('main.start', { id, url: location.href, recovered });

    let stopKeepAlive = startKeepAlivePort();

    let job;
    try {
      job = await fetchJob(id);
    } catch (e) {
      log('main.fetchJob_fail', { err: e?.message });
      try { stopKeepAlive(); } catch {}
      return;
    }
    log('main.job', { provider: job.provider, promptLen: job.prompt?.length || 0 });

    if (job.status === 'done' || job.status === 'error') {
      log('main.already_terminal', { status: job.status });
      try { stopKeepAlive(); } catch {}
      return;
    }

    // Параметры job'а. Отсутствие model/effort/thinking = «не трогать
    // селектор» (back-compat: старые MCP-вызовы шлют только prompt и ожидают
    // Research mode на текущей модели аккаунта). research default = true.
    const opts0 = job.options || {};
    const keepTabAfterDone = scKeepResearchTabAfterDone(opts0);
    const modelKey = resolveModel(opts0.model);
    const effortKey = resolveEffort(opts0.effort);
    const wantThinking = (typeof opts0.thinking === 'boolean') ? opts0.thinking : null;
    const researchOn = opts0.research !== false;
    currentJobId = id;
    log('main.options', { modelKey, effortKey, wantThinking, researchOn, raw: opts0 });

    // Opus 3 не поддерживает Research mode (юзер проверил в живом UI:
    // включение Research на opus-3 просто не работает). Ранний error,
    // не тихий запуск не-research-ответа.
    if (researchOn && modelKey === 'opus-3') {
      const ok = await postTerminalState(id, {
        status: 'error', stage: 'configuring',
        url: location.href, title: document.title,
        error: 'opus-3 не поддерживает Research mode — выбери другую модель или research:false',
      });
      if (ok) { try { stopKeepAlive(); } catch {} } // не подтвердилось → порт живой
      return;
    }

    // MCP-плашка (общий research-badge.js). Тот же зелёный card что на
    // AI Studio / Perplexity. Заголовок = что реально настраиваем.
    try {
      const badgeModel = modelKey
        ? CLAUDE_MODELS[modelKey].display
          + (effortKey ? ' · ' + effortKey : '')
          + (researchOn ? ' · Research' : '')
        : (researchOn ? 'Research mode' : 'Chat');
      window.scResearchBadge?.show({
        jobId: id, providerLabel: 'Claude',
        modelTitle: badgeModel,
        prompt: job.prompt || '',
      });
    } catch {}

    // Два сценария:
    //   (а) status='queued' (или 'running' но reset вручную) — первый
    //       инжект CS в /new или /chat/<uuid>. Делаем submit pipeline.
    //   (б) status='running' — CS заинжектился после reload'а (periodic
    //       reload фиксит claude.ai SPA баг). Submit уже сделан, нам
    //       нужно только watcher.
    const isReloadRestart = job.status === 'running';
    log('main.scenario', { isReloadRestart, jobStatus: job.status });

    // Wait for composer to exist (claude.ai SPA hydrates пару секунд).
    try {
      await waitFor(() => findComposer(), 'composer', 15000);
    } catch (e) {
      const ok = await postTerminalState(id, { status: 'error', error: 'composer not found: ' + e.message });
      if (ok) { try { stopKeepAlive(); } catch {} } // не подтвердилось → порт живой, fallback вооружён
      return;
    }

    try {
      log('v', 'v4-reload-aware');

      // Aggregate-стоп для submit-verify fallback'а: watcher/reload/clicker
      // создаются НИЖЕ по коду, а verify стартует сразу после submit'а —
      // поэтому через let-ref, который дозаполняется после их создания.
      let stopAllRef = () => {};

      if (!isReloadRestart) {
        // tabId: реальный (был хардкод -1 → Tab ID:-1 в Истории, нельзя
        // перейти на вкладку). myTabId получен в начале main().
        await postState(id, { status: 'running', stage: 'configuring',
          ...(typeof myTabId === 'number' ? { tabId: myTabId } : {}) });
        log('after.postState.configuring');
        // claude.ai гидрирует композер РАНЬШЕ тулбара: model-selector-dropdown
        // и пункты «+»-меню появляются позже (ждут account/models API). Живой
        // кейс rmqmvcidy: configuring → model.select_failed {label:""} через
        // 8мс — триггера ещё НЕ БЫЛО в DOM, обе retry-попытки сгорели мгновенно,
        // job молча уехал на модели аккаунта (Fable 5 вместо opus-4.7), и
        // thinking/Research-пункт меню тоже «не нашлись». Ждём триггер с
        // непустым aria-label = тулбар реально догидрировался.
        const hydT0 = Date.now();
        try {
          await waitFor(() => {
            const t = document.querySelector('[data-testid="model-selector-dropdown"]');
            return (t && (t.getAttribute('aria-label') || '').trim()) ? true : null;
          }, 'model-selector hydration', 20000);
          log('hydration.ok', { ms: Date.now() - hydT0 });
        } catch (_) {
          // Не фатально само по себе: ensure*-шаги ниже зафейлятся честно
          // (модель — терминально), если страница так и не ожила.
          log('hydration.timeout', { ms: Date.now() - hydT0 });
          bridgeLog('claude.hydration.timeout', { ms: Date.now() - hydT0 }, id, null);
        }
        // Порядок жёсткий: модель ПЕРЕД effort/thinking — смена модели может
        // сбросить уровень (шрам chatgpt: effort после модели). Потом
        // «+»-меню: Research по запросу, Web search — всегда включён.
        if (modelKey) {
          const okModel = await ensureModelSelected(modelKey);
          if (!okModel) {
            // Юзер попросил КОНКРЕТНУЮ модель — ответ чужой моделью хуже
            // ошибки. Контракт тот же, что у submit-verify: состояние на
            // странице не подтвердилось → терминальный error, не тихое
            // продолжение. (Раньше провал был non-fatal «как у effort» —
            // job уезжал на модели аккаунта, юзер получал ответ Fable 5
            // при заказанном opus-4.7.) Вкладку не закрываем — настоящая
            // ошибка страницы, оставляем для ручного разбора.
            const ok = await postTerminalState(id, {
              status: 'error', stage: 'configuring',
              url: location.href, title: document.title,
              error: `claude_model_select_failed: не удалось переключить модель на ${CLAUDE_MODELS[modelKey]?.display || modelKey} (на странице: «${currentModelLabel() || 'селектор не найден'}»)`,
            });
            if (ok) { try { stopKeepAlive(); } catch {} } // не подтвердилось → порт живой
            try { window.scResearchBadge?.hide(); } catch {}
            return;
          }
        }
        if (effortKey) await ensureEffortSelected(modelKey, effortKey);
        if (wantThinking !== null) await ensureThinkingToggle(modelKey, wantThinking);
        await ensurePlusMenuConfig(researchOn);
        log('after.ensureConfig');

        await postState(id, { stage: 'submitting' });
        log('after.postState.submitting');
        pasteIntoComposer(job.prompt);
        log('after.paste');
        await sleep(200);
        const sendOk = await clickSend();
        log('main.sent', { ok: sendOk });
        await postState(id, { stage: 'running' });
        log('after.postState.running');
        // Fallback: если Send не сменился на Stop (паста/клик не сработали,
        // «пустая вкладка») — error вместо вечного running. Глушим watcher и
        // прочие циклы через stopAllRef (дозаполнен после их создания).
        startSubmitVerify(id, () => { stopAllRef(); });
      } else {
        log('main.skip_submit_after_reload');
      }

      // Confirm-dialog «Enable connectors for Claude to use in research»
      // появляется ПОСЛЕ submit'а на первом research'е сессии. На reload'е
      // тоже жмём (если вылез заново). Если после MAX_FAIL=5 попыток
      // dialog не закрывается — это деградация (radix-ui ignored click,
      // или claude.ai сменил DOM и наш .click() не доходит) → завершаем
      // job с ошибкой, чтобы юзер не сидел в вечном loading.
      let stopReload = () => {};
      let stopWatcher = () => {};
      const stopConfirmClicker = startConfirmAutoClicker(
        () => log('confirm.dismissed'),
        async () => {
          log('confirm.terminal_error_emit');
          const okTerm = await postTerminalState(id, {
            status: 'error',
            stage: 'confirm_failed',
            url: location.href,
            title: document.title,
            error: 'Confirm dialog did not close after 5 attempts — research blocked at connectors prompt',
          });
          try { stopConfirmClicker(); } catch {}
          try { stopReload(); } catch {}
          try { stopWatcher(); } catch {}
          if (okTerm) { try { stopKeepAlive(); } catch {} } // не подтвердилось → порт живой
        }
      );

      // Periodic reload фикс для claude.ai SPA-баг: research-progress
      // иногда не обновляется в UI пока юзер не нажмёт F5. Перезагружаем
      // страницу каждые 90с пока финальная карточка не появится.
      // ТОЛЬКО для research: SPA-баг специфичен research-панели. Обычный
      // чат стримит нормально, а force-reload-5min убил бы легитимный
      // длинный стрим (Opus Max+Thinking легко думает дольше 5 минут).
      stopReload = researchOn ? startPeriodicReload(id) : (() => {});

      // Дозаполняем aggregate-стоп (для submit-verify fallback'а выше).
      stopAllRef = () => {
        try { stopWatcher(); } catch {}
        try { stopConfirmClicker(); } catch {}
        try { stopReload(); } catch {}
        try { stopKeepAlive(); } catch {}
        try { window.scResearchBadge?.hide(); } catch {}
      };

      // Стартуем done-watcher
      log('before.startDoneWatcher');
      stopWatcher = startDoneWatcher(
        async (final) => {
          // Terminal-error путь: research остановлен с ошибкой
          // (например "Stopped: No response on which connectors..."). Эмитим
          // status='error' и завершаем — НЕ done.
          if (final.terminal_error) {
            log('watcher.terminal_error', { label: final.panel_aria_label });
            const okTerm = await postTerminalState(id, {
              status: 'error',
              stage: 'stopped',
              url: final.url,
              title: final.title,
              error: final.panel_aria_label || 'research stopped',
            });
            try { stopWatcher(); } catch {}
            try { stopConfirmClicker(); } catch {}
            try { stopReload(); } catch {}
            if (okTerm) { try { stopKeepAlive(); } catch {} } // не подтвердилось → порт живой
            return;
          }

          // Дать DOM 600мс на финальную отрисовку (action-bar появляется
          // через небольшой delay после рендера). Для math-теста типа
          // "2+2 equals 4" текст уже есть к моменту done; для research'а с
          // карточкой Open research panel — может ещё не успеть.
          await sleep(600);
          const extracted = extractAnswerText();

          // Research-ответы Claude часто формируются так: summary-карточка в
          // main-thread (800-1500 chars) + полный документ в artifact pane
          // (10K-50K chars). Watcher выстреливает done пока юзер ещё ничего
          // не открыл — artifact pane не существует в DOM. Программно
          // кликаем View → читаем → Close, чтобы вытащить полный body.
          let artifactDoc = null;
          try {
            artifactDoc = await extractArtifactDocument();
          } catch (e) {
            log('artifact.flow_err', { err: e?.message });
          }

          // Детерминированные флаги для caller'а:
          //
          // is_research — был ли реально запущен Deep Research mode на claude.ai.
          // True если в процессе detector видел research-panel (`marker:'panel'`).
          // False если был обычный ответ (`marker:'copy'`) — claude.ai либо
          // отказался запускать Research («overkill для этого вопроса»), либо
          // задал clarifying-вопрос вместо запуска.
          //
          // is_clarifying — heuristic: claude задал юзеру вопрос вместо ответа.
          // Признаки: текст короткий (<800 chars), заканчивается на «?» или
          // содержит «could you clarify», «which» / «what» / «would you like».
          // Не perfect, но достаточно чтобы caller (Claude Code) знал что
          // нужно переформулировать prompt.
          const isResearch = final.marker === 'panel';
          const txt = extracted.text || '';
          const isShort = txt.length > 0 && txt.length < 800;
          const endsWithQuestion = /\?\s*$/.test(txt);
          const hasClarifyPhrases = /\b(could you (please )?clarify|would you like|which (of these|specific)|what (kind|type|exactly)|do you want me to|should I focus on|are you (interested|looking)|let me know)\b/i.test(txt);
          const isClarifying = !isResearch && isShort && (endsWithQuestion || hasClarifyPhrases);

          log('watcher.done', {
            ...final,
            textLen: extracted.text.length,
            kind: extracted.kind,
            is_research: isResearch,
            is_clarifying: isClarifying,
            artifactLen: artifactDoc?.text?.length || 0,
            artifactTitle: artifactDoc?.title || null,
          });
          const confirmed = await postTerminalState(id, {
            status: 'done',
            stage: 'done',
            url: final.url,
            title: final.title,
            result: {
              url: final.url,
              title: final.title,
              panel_aria_label: final.panel_aria_label,
              marker: final.marker,           // 'panel' | 'copy' | 'stopped'
              text: extracted.text,           // строкой; пустая если research_card_only
              text_kind: extracted.kind,      // 'answer' | 'research_card_only'
              is_research: isResearch,        // bool: реальный Deep Research vs прямой ответ
              is_clarifying: isClarifying,    // bool: claude задал юзеру вопрос
              document_text: artifactDoc?.text || null,    // полный artifact body или null
              document_title: artifactDoc?.title || null,  // title артефакта или null
              // Эхо настроек запуска — что реально просили у вкладки.
              model: modelKey || null,
              effort: effortKey || null,
              thinking: wantThinking,
              research: researchOn,
            },
          });
          try { stopWatcher(); } catch {}
          try { stopConfirmClicker(); } catch {}
          try { stopReload(); } catch {}
          try { window.scResearchBadge?.hide(); } catch {}
          // Auto-close tab + снятие keepalive ТОЛЬКО если bridge подтвердил done.
          // Иначе оставляем порт живым (tab-closed fallback вооружён) и вкладку
          // открытой (результат виден) — лучше «лишняя вкладка», чем зомби-running.
          if (confirmed) {
            try { stopKeepAlive(); } catch {}
            if (keepTabAfterDone) {
              log('done.keep_tab_open');
            } else {
              try {
                chrome.runtime.sendMessage({ __sc_close_self_tab: true, reason: 'research_done' });
              } catch {}
            }
          } else {
            log('done.unconfirmed_keep_tab_open');
          }
        },
        async (prog) => {
          if (prog.stage === 'timeout') {
            const ok = await postTerminalState(id, { status: 'error', stage: 'timeout', error: 'flow timed out (30min)' });
            try { stopConfirmClicker(); } catch {}
            try { stopReload(); } catch {}
            if (ok) { try { stopKeepAlive(); } catch {} } // не подтвердилось → порт живой
            try { window.scResearchBadge?.hide(); } catch {}
            return;
          }
          await postState(id, { stage: prog.stage, url: prog.url, title: prog.title });
        },
        { isReloadRestart, expectResearch: researchOn }
      );
    } catch (e) {
      log('main.flow_err', { err: e?.message });
      const ok = await postTerminalState(id, { status: 'error', error: e?.message || String(e) });
      if (ok) { try { stopKeepAlive(); } catch {} } // не подтвердилось → порт живой, fallback вооружён
      try { window.scResearchBadge?.hide(); } catch {}
    }
  }

  // Запускаемся либо на DOMContentLoaded, либо сразу если уже complete.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => main().catch(e => log('main.uncaught', { err: e?.message })));
  } else {
    main().catch(e => log('main.uncaught', { err: e?.message }));
  }
})();
