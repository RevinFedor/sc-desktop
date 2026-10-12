// research-badge.js — общий MCP-бейдж для research/MCP-вкладок (AI Studio,
// Perplexity, Claude). Раньше жил локально в aistudio-mcp.js::showMcpBadge;
// вынесен сюда как ЕДИНЫЙ источник правды (см. CLAUDE.md anti-pattern про
// дублирование CONTENT_TYPES/ENGINES — то же правило: одна реализация, все
// провайдеры импортируют, а не копируют).
//
// Экспорт: window.scResearchBadge = { show, hide }.
// Все content-script'ы расширения на одной странице делят один isolated-world,
// поэтому достаточно подключить этот файл в manifest ПЕРЕД потребителем
// (aistudio-mcp / perplexity-research / claude-research) — так же как
// aistudio-core.js отдаёт window.scAistudio для aistudio-mcp.js.
//
// Плашка не блокирует страницу вне карточки: контейнер pointer-events:none,
// текстовые поля доступны обычному выделению, кнопки остаются интерактивными.
// Сворачивание persist'ится в localStorage
// (per-origin — каждый провайдер помнит своё состояние).
(function installResearchContentPing() {
  try {
    if (window.__scResearchContentPingInstalled) return;
    window.__scResearchContentPingInstalled = true;
    const hostname = String(location.hostname || '').toLowerCase();
    const provider = hostname === 'chatgpt.com' || hostname === 'www.chatgpt.com'
      ? 'chatgpt'
      : hostname === 'claude.ai' || hostname.endsWith('.claude.ai')
        ? 'claude'
        : hostname === 'perplexity.ai' || hostname.endsWith('.perplexity.ai')
          ? 'perplexity'
          : hostname.includes('aistudio.google.com') ? 'aistudio' : null;
    chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
      if (request?.__sc_research_content_ping !== true) return undefined;
      sendResponse({ ok: true, provider });
      return false;
    });
  } catch (_) {}
})();

(function () {
  const BADGE_ID = 'sc-mcp-badge';
  const STYLE_ID = 'sc-mcp-badge-style';
  const COLLAPSED_KEY = 'sc-mcp-badge-collapsed';

  function isCollapsed() {
    try { return localStorage.getItem(COLLAPSED_KEY) === '1'; } catch { return false; }
  }
  function setCollapsed(v) {
    try { localStorage.setItem(COLLAPSED_KEY, v ? '1' : '0'); } catch {}
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement('style');
    st.id = STYLE_ID;
    // Стили рассчитаны на shadow-DOM-free injection; .sc-mcp-mini-btn
    // получает pointer-events:auto чтобы клики работали — общий контейнер
    // имеет pointer-events:none чтобы не перехватывать сайтовые клики.
    st.textContent = `
      @keyframes scMcpPulse{0%,100%{opacity:1}50%{opacity:0.35}}
      #${BADGE_ID}{
        position:fixed; top:60px; right:16px; z-index:2147483646;
        background:#25262b; color:#e9ecef;
        border:1px solid #2c2e33; border-radius:12px;
        box-shadow:0 12px 32px rgba(0,0,0,0.45);
        font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;
        font-size:12px; line-height:1.45;
        pointer-events:none;
        transition:all 0.18s ease;
      }
      #${BADGE_ID}.collapsed{
        padding:6px 10px;
        display:flex; align-items:center; gap:8px;
      }
      #${BADGE_ID}:not(.collapsed){
        padding:14px 16px;
        max-width:320px;
      }
      #${BADGE_ID} .sc-mcp-body,
      #${BADGE_ID} .sc-mcp-selectable{
        pointer-events:auto;
        user-select:text!important;
        -webkit-user-select:text!important;
        cursor:text;
      }
      #${BADGE_ID} .sc-mcp-meta-value{overflow-wrap:anywhere;}
      #${BADGE_ID} .sc-mcp-prompt-text{
        pointer-events:auto;
        user-select:text!important;
        -webkit-user-select:text!important;
        cursor:text;
        color:#cbd5e1;
        font-size:11px;
        line-height:1.45;
        max-height:64px;
        overflow-y:scroll;
        overflow-x:hidden;
        white-space:pre-wrap;
        overflow-wrap:anywhere;
        scrollbar-width:thin;
        scrollbar-color:rgba(148,163,184,0.45) rgba(255,255,255,0.04);
        padding-right:6px;
      }
      #${BADGE_ID} .sc-mcp-prompt-text.expanded{
        max-height:160px;
      }
      #${BADGE_ID} .sc-mcp-prompt-text::-webkit-scrollbar{
        width:4px;
      }
      #${BADGE_ID} .sc-mcp-prompt-text::-webkit-scrollbar-track{
        background:rgba(255,255,255,0.04);
        border-radius:999px;
      }
      #${BADGE_ID} .sc-mcp-prompt-text::-webkit-scrollbar-thumb{
        background:rgba(148,163,184,0.45);
        border-radius:999px;
      }
      #${BADGE_ID} .sc-mcp-prompt-text::-webkit-scrollbar-thumb:hover{
        background:rgba(203,213,225,0.65);
      }
      #${BADGE_ID} .sc-mcp-more-btn{
        pointer-events:auto;
        cursor:pointer;
        margin-top:6px;
        padding:0;
        border:none;
        background:transparent;
        color:#34d399;
        font-size:11px;
        line-height:1.2;
        font-weight:500;
      }
      #${BADGE_ID} .sc-mcp-more-btn:hover{
        color:#6ee7b7;
      }
      #${BADGE_ID} .sc-mcp-mini-btn{
        pointer-events:auto;
        cursor:pointer;
        background:transparent;
        border:none;
        color:#9ca3af;
        padding:2px;
        border-radius:4px;
        display:flex; align-items:center; justify-content:center;
        transition:all 0.12s ease;
      }
      #${BADGE_ID} .sc-mcp-mini-btn:hover{
        background:#363840;
        color:#e9ecef;
      }
      #${BADGE_ID} .sc-mcp-header{
        display:flex; align-items:center; gap:8px; margin-bottom:8px;
      }
      #${BADGE_ID}.collapsed .sc-mcp-header{
        margin-bottom:0;
      }
      #${BADGE_ID}.collapsed .sc-mcp-body{
        display:none;
      }
    `;
    document.head.appendChild(st);
  }

  // show({ jobId, providerLabel, modelTitle, prompt }) — идемпотентна
  // (если бейдж уже в DOM — no-op). providerLabel — суффикс заголовка
  // «MCP · <provider>» (AI Studio / Perplexity / Claude).
  function show({ jobId, providerLabel, modelTitle, prompt } = {}) {
    try {
      if (document.getElementById(BADGE_ID)) return;
      const fullPrompt = prompt || '';
      const hasLongPrompt = fullPrompt.length > 160 || fullPrompt.split(/\r?\n/).length > 4;
      const safe = (s) => String(s || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

      ensureStyle();

      const collapsed = isCollapsed();
      const el = document.createElement('div');
      el.id = BADGE_ID;
      if (collapsed) el.classList.add('collapsed');

      el.innerHTML = `
        <div class="sc-mcp-header">
          <div style="width:8px;height:8px;border-radius:50%;background:#22c55e;animation:scMcpPulse 1.4s ease-in-out infinite;flex-shrink:0;"></div>
          <div class="sc-mcp-selectable" style="font-weight:600;letter-spacing:0.3px;color:#fff;font-size:11px;text-transform:uppercase;flex:1;">MCP · ${safe(providerLabel || 'Research')}</div>
          <button class="sc-mcp-mini-btn" data-sc-mcp-toggle="1" title="Свернуть/развернуть">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" data-sc-mcp-chevron="1">
              <path data-sc-mcp-chevron-path="1" d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
        </div>
        <div class="sc-mcp-body">
          <div style="color:#9ca3af;font-size:11px;margin-bottom:4px;">Job</div>
          <div class="sc-mcp-selectable sc-mcp-meta-value" data-sc-mcp-job="1" style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:#cbd5e1;margin-bottom:10px;">${safe(jobId)}</div>
          <div style="color:#9ca3af;font-size:11px;margin-bottom:4px;">Модель</div>
          <div class="sc-mcp-selectable sc-mcp-meta-value" data-sc-mcp-model="1" style="color:#e9ecef;font-size:12px;margin-bottom:10px;">${safe(modelTitle)}</div>
          <div style="color:#9ca3af;font-size:11px;margin-bottom:4px;">Промпт</div>
          <div class="sc-mcp-prompt-text" data-sc-mcp-prompt="1">${safe(fullPrompt)}</div>
          ${hasLongPrompt ? '<button class="sc-mcp-more-btn" data-sc-mcp-prompt-more="1" type="button">Показать ещё</button>' : ''}
        </div>
      `;

      // Обновить chevron-direction под текущее состояние.
      const updateChevron = () => {
        const path = el.querySelector('[data-sc-mcp-chevron-path]');
        if (!path) return;
        // collapsed → стрелка вниз "развернуть" (chevron-down); expanded → вверх "свернуть"
        path.setAttribute('d', el.classList.contains('collapsed')
          ? 'M3 4.5L6 7.5L9 4.5'   // ▼ down
          : 'M3 7.5L6 4.5L9 7.5'); // ▲ up
      };
      updateChevron();

      // Toggle handler
      const toggleBtn = el.querySelector('[data-sc-mcp-toggle]');
      if (toggleBtn) {
        toggleBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const nextCollapsed = !el.classList.contains('collapsed');
          el.classList.toggle('collapsed', nextCollapsed);
          setCollapsed(nextCollapsed);
          updateChevron();
        });
      }

      const promptText = el.querySelector('[data-sc-mcp-prompt]');
      const promptMoreBtn = el.querySelector('[data-sc-mcp-prompt-more]');
      if (promptText) {
        promptText.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
      }
      if (promptMoreBtn && promptText) {
        promptMoreBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const expanded = !promptText.classList.contains('expanded');
          promptText.classList.toggle('expanded', expanded);
          promptMoreBtn.textContent = expanded ? 'Свернуть' : 'Показать ещё';
        });
      }

      document.documentElement.appendChild(el);
    } catch {}
  }

  function hide() {
    try { document.getElementById(BADGE_ID)?.remove(); } catch {}
  }

  try { window.scResearchBadge = { show, hide }; } catch {}
})();

// ── scBridgeFetch — LNA-иммунный канал CS → bridge ─────────────────────
// Живёт здесь, потому что research-badge.js подключён в manifest ПЕРЕД
// каждым research-CS (claude/perplexity/chatgpt/aistudio) — тот же приём,
// что с window.scResearchBadge: одна реализация на всех.
//
// Зачем: страничный fetch на 127.0.0.1 блокируется Local Network Access
// (Chromium 138+) пока юзер не нажал «Разрешить» в per-origin диалоге.
// Диалог показывается ТОЛЬКО на активной вкладке; research-вкладки фоновые
// → fetch молча висит (chatgpt-кейс) или мгновенно падает TypeError, если
// юзер уже нажал «Блокировать» (claude-кейс: permissions.query →'denied',
// job вечно queued при живом CS). SW-fetch LNA не подвержен (extension
// origin + host_permissions) — доказано: sw.tab.onUpdated логи доходили,
// пока страничный канал был мёртв.
//
// Контракт: scBridgeFetch(path, init) → {ok, status, json(), text()} —
// то же подмножество Response, которым пользуются CS. Page-канал пробуем
// первым (быстрее, без SW round-trip); после первого сетевого провала —
// sticky переключение на SW до конца жизни страницы.
(function () {
  const BRIDGE = 'http://127.0.0.1:53127';
  const PAGE_TIMEOUT_MS = 4000;
  let pageChannelDead = false;

  async function viaPage(path, init) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PAGE_TIMEOUT_MS);
    try {
      const r = await fetch(BRIDGE + path, { ...(init || {}), signal: ctrl.signal });
      const text = await r.text();
      return { ok: r.ok, status: r.status, text };
    } finally { clearTimeout(t); }
  }

  function viaSw(path, init) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({
          __sc_bridge_fetch: true,
          path,
          init: {
            method: (init && init.method) || 'GET',
            headers: (init && init.headers) || undefined,
            body: (init && typeof init.body === 'string') ? init.body : undefined,
          },
        }, (resp) => {
          if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
          if (!resp || resp.ok !== true) { reject(new Error((resp && resp.error) || 'sw bridge fetch failed')); return; }
          resolve({ ok: resp.status >= 200 && resp.status < 300, status: resp.status, text: resp.body || '' });
        });
      } catch (e) { reject(e); }
    });
  }

  function wrap(r) {
    return {
      ok: r.ok,
      status: r.status,
      text: async () => r.text,
      json: async () => JSON.parse(r.text || 'null'),
    };
  }

  async function scBridgeFetch(path, init) {
    if (!pageChannelDead) {
      try {
        return wrap(await viaPage(path, init));
      } catch (e) {
        // Сетевой провал/таймаут (HTTP-статусы сюда не попадают — viaPage
        // их возвращает как ok:false). Переключаемся на SW навсегда.
        pageChannelDead = true;
        try { console.log('[SC-BRIDGE] page→bridge канал мёртв (' + ((e && e.name) || e) + ') — переключаюсь на SW-канал (LNA?)'); } catch {}
      }
    }
    return wrap(await viaSw(path, init));
  }

  try { window.scBridgeFetch = scBridgeFetch; } catch {}
})();
