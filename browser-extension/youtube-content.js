// SC Browser Parser — YouTube content script.
//
// Ставит кнопку «забрать в sc-desktop» на каждую видео-карточку YouTube:
//   • главная             → ytd-rich-item-renderer
//   • поиск               → ytd-video-renderer / yt-lockup-view-model
//   • канал /videos       → ytd-rich-item-renderer
//   • watch /watch?v=…    → плавающий FAB рядом с заголовком
//
// Клик → POST http://127.0.0.1:53127/yt-add → расширение сразу показывает
// тост «отправлено». Если в настройках YouTube включён «Автоскрапинг
// нейронки» — попутно открывается aistudio.google.com/prompts/new_chat?sc=…
// и AI Studio content script (он же AISE-content) ждёт окончания
// транскрибации (polling /yt-status), затем выбирает модель, ставит
// system instruction из настроек, paste'ит готовый текст и жмёт Run.
//
// SPA-устойчивость: один MutationObserver на весь body. Карточки
// маркируются `data-sc-injected="1"`, повторно не обрабатываются.
//
// Один источник истины — settings.js (он же грузится в popup.js). Эти
// content-script'ы не могут require, поэтому settings.js включён в
// manifest.content_scripts[2].js перед youtube-content.js.

(function () {
  'use strict';

  const log = (typeof window !== 'undefined' && window.__aise_log) || (() => ({}));
  const SC_ENDPOINT_BASE = 'http://127.0.0.1:53127';

  // ─────────── Детерминированный лог для MCP ───────────
  // Пишем в data-sc-debug атрибут body (последние 200 строк) +
  // window.__sc_debug ring buffer + console.log с префиксом [SC-DBG].
  // Атрибут можно прочитать через `mcp__browser__evaluate selector:body
  // extract:[{attr:'data-sc-debug'}]`. Не требует userScripts toggle.
  if (!window.__sc_debug) window.__sc_debug = [];
  // Лог-buffer пишется в видимый textContent скрытого <pre id="sc-yt-dbg-log">,
  // потому что MCP browser DSL умеет get_text по селектору, а evaluate'у
  // в DSL-режиме недоступны произвольные window.* / data-* attributes
  // без userScripts toggle. textContent читается get_text'ом надёжно.
  function getOrCreateDbgSink() {
    let n = document.getElementById('sc-yt-dbg-log');
    if (n && n.isConnected) return n;
    n = document.createElement('pre');
    n.id = 'sc-yt-dbg-log';
    // visibility:hidden + position:fixed + size 0 — вне layout'а, но
    // textContent остаётся доступным. display:none НЕ ставим: некоторые
    // версии headless API игнорят hidden display'ом.
    n.style.cssText = 'position:fixed;left:-99999px;top:0;width:0;height:0;visibility:hidden;pointer-events:none;';
    if (document.body) document.body.appendChild(n);
    else document.documentElement.appendChild(n);
    return n;
  }
  function dbg(tag, data) {
    const t = (performance.now() / 1000).toFixed(3);
    const entry = `${t}s [${tag}] ` + (data == null ? '' : (typeof data === 'string' ? data : JSON.stringify(data)));
    window.__sc_debug.push(entry);
    if (window.__sc_debug.length > 200) window.__sc_debug.shift();
    try {
      const sink = getOrCreateDbgSink();
      sink.textContent = window.__sc_debug.join('\n');
    } catch {}
    try { console.log('[SC-DBG]', entry); } catch {}
  }
  dbg('boot', { url: location.href, ts: Date.now() });

  // Diagnostic block — пишем в ОТДЕЛЬНЫЙ DOM-узел (#sc-yt-boot-log) чтобы
  // не страдать от ring-buffer'а основного #sc-yt-dbg-log. Этот узел
  // содержит ТОЛЬКО content-script-side диагностику, ни одной bg-записи.
  function bootLog(tag, data) {
    try {
      let n = document.getElementById('sc-yt-boot-log');
      if (!n || !n.isConnected) {
        n = document.createElement('pre');
        n.id = 'sc-yt-boot-log';
        n.style.cssText = 'position:fixed;left:-99999px;top:0;width:0;height:0;visibility:hidden;pointer-events:none;';
        (document.body || document.documentElement).appendChild(n);
      }
      const entry = `${(performance.now()/1000).toFixed(3)}s [${tag}] ` + (data == null ? '' : JSON.stringify(data));
      n.textContent = (n.textContent || '') + '\n' + entry;
    } catch {}
  }
  bootLog('boot', { url: location.href, ts: Date.now() });
  try {
    chrome.storage.local.get(['__sc_bg_dbg', '__sc_ext_mtime', '__sc_last_reload_ts'], loc => {
      const buf = loc?.__sc_bg_dbg;
      // Берём ВСЕ записи где есть `reload.` чтобы видеть всю историю
      // hot-reload poll'ов с момента запуска.
      const reloadLines = Array.isArray(buf) ? buf.filter(l => /reload\./.test(l)).slice(-10) : null;
      bootLog('storage.local', {
        bgDbgLen: Array.isArray(buf) ? buf.length : null,
        reloadLines,
        ext_mtime: loc?.__sc_ext_mtime,
        last_reload_ts: loc?.__sc_last_reload_ts,
      });
    });
    chrome.runtime.sendMessage({ __sc_ping: true, ts: Date.now() }, resp => {
      const err = chrome.runtime.lastError?.message || null;
      bootLog('ping.response', { resp, err });
    });
  } catch (e) {
    bootLog('probe.threw', { err: String(e?.message || e) });
  }

  // ─────────── Helpers ───────────

  // YouTube'овский id одинаков и для /watch и для /shorts: 11-значный
  // (исторически 6-20 для обратной совместимости со старыми ссылками).
  // Один id = один файл в sc-desktop'е; никакого «shorts vs watch»
  // разделения у нас нет, обе формы шлём как `watch?v=<id>`.
  function extractVideoId(href) {
    if (!href) return null;
    let u;
    try { u = new URL(href, location.origin); } catch { return null; }
    let v = null;
    if (u.pathname.startsWith('/watch')) {
      v = u.searchParams.get('v');
    } else if (u.pathname.startsWith('/shorts/')) {
      // /shorts/<id> или /shorts/<id>/ — берём первый сегмент после shorts.
      const seg = u.pathname.split('/').filter(Boolean); // ['shorts', '<id>']
      v = seg[1] || null;
    }
    return /^[\w-]{6,20}$/.test(v || '') ? v : null;
  }
  function extractWatchUrl(href) {
    const v = extractVideoId(href);
    // Канонический URL без трекеров — расширение шлёт ровно это в Electron,
    // чтобы кэш-хит совпал с тем, что считает paste-flow в самой sc-desktop.
    // Shorts тоже нормализуем в watch-форму: для bridge'а это одна и та же
    // платформа (yt-dlp умеет качать оба варианта по watch?v=…).
    return v ? `https://www.youtube.com/watch?v=${v}` : null;
  }

  // Селектор для hover-делегации, поиска линков в карточках, поиска по
  // videoId — единый источник правды. И /watch, и /shorts.
  const ANCHOR_SELECTOR = 'a[href*="/watch?v="], a[href*="/shorts/"]';

  function findCardLink(card) {
    // Карточки могут быть разной формы — главное найти href с /watch?v=… или /shorts/<id>.
    return card.querySelector(ANCHOR_SELECTOR);
  }

  function findCardTitle(card) {
    const sel = [
      'a#video-title-link',
      'a#video-title',
      '#video-title',
      'h3 a',
      '.yt-lockup-metadata-view-model h3',
    ].join(', ');
    const el = card.querySelector(sel);
    return el?.textContent?.trim() || null;
  }

  // Локальный кэш настроек YouTube. Заполняется при init(), обновляется
  // через chrome.storage.onChanged. Все вызовы (рендер кнопки, click handler)
  // читают отсюда, чтобы кнопка-маркер «sc · AI» соответствовал текущему
  // состоянию toggle'а без race'а с асинхронным storage.get.
  let ytSettings = { ...YOUTUBE_DEFAULT_SETTINGS };

  function loadYoutubeSettings() {
    return new Promise(resolve => {
      try {
        chrome.storage.sync.get({ __yt: YOUTUBE_DEFAULT_SETTINGS }, raw => {
          ytSettings = sanitizeYoutubeSettings(raw.__yt || {});
          resolve(ytSettings);
        });
      } catch {
        resolve(ytSettings);
      }
    });
  }

  // ─────────── Кнопка ───────────

  // Pill-кнопка в стиле Яндекс «Пересказать», рядом с которым она живёт.
  // Тёмный фон, скруглённые края, иконка ⬇ слева, короткий маркер справа.
  // Маркер меняется в зависимости от toggle «Автоскрапинг нейронки»:
  //   off → "sc"      (только скачать в sc-desktop)
  //   on  → "sc · AI" (скачать + дальше Gemini Studio)
  function buttonLabel(autoAistudio) {
    return autoAistudio ? '⬇ sc · AI' : '⬇ sc';
  }
  function buttonTitle(autoAistudio) {
    return autoAistudio
      ? 'Забрать в sc-desktop и автоматически открыть Gemini Studio'
      : 'Забрать в sc-desktop (только субтитры)';
  }

  // ─────────── Состояния по videoId (Map) ───────────
  //
  // Singleton-pill живёт одна на весь сайт, но состояний может быть
  // несколько (юзер кликнул на 3 разных видео — все 3 параллельно
  // транскрибируются в sc-desktop). Хранение состояния НА pill самой
  // дало бы баг «навожусь на соседнее видео — pill показывает чужое
  // working/done». Решение: Map<videoId, {state, error, title, autoAistudio, expiresAt}>.
  //
  // - Pill при смене hover'а перерендеривается на основе stateMap[hoveredId] ?? idle.
  // - Click и background-сообщения пишут в Map по videoId.
  // - Глобальный тост-стек (renderToasts) показывает ВСЕ активные job'ы.
  // - done/error авто-удаляются из Map через TTL.
  //
  // Стадии:
  //   idle         — нет в Map (pill: «⬇ sc»)
  //   sending      — клик нажат, идёт POST /yt-add
  //   searching    — bridge принял, sc-desktop ищет субтитры (yt-dlp + transcript-api)
  //   transcribing — субтитров нет, идёт запрос к Gemini/AssemblyAI (engine в entry)
  //   working      — legacy fallback если bridge не передал yt_stage
  //   opening      — транскрипт готов, открываю Gemini Studio в фоне
  //   done         — финал; через 3с удаляется из Map
  //   error        — поломалось; через 4с удаляется из Map
  //
  // Тосты НЕ показываем на скрытых вкладках: incoming state-event'ы от
  // background дропаются при document.visibilityState !== 'visible',
  // а на возврат ('visible' transition) чистим done/error из Map'а,
  // чтоб не появлялись «протухшие» уведомления о завершившихся jobах.
  // Активные (sending/searching/transcribing/opening) на возврате
  // остаются — это идущая работа, юзер хочет её видеть.

  /** @type {Map<string, {state: string, engine?: string, error?: string, title?: string, autoAistudio?: boolean, expiresAt?: number}>} */
  const videoStateMap = new Map();
  const stateTimers = new Map(); // videoId → timeoutId

  function getVideoState(videoId) {
    return videoStateMap.get(videoId) || null;
  }

  function setVideoState(videoId, state, opts = {}) {
    if (!videoId) return;
    const prev = videoStateMap.get(videoId) || {};
    // Защита от stale-error: handleClick может вызвать setVideoState('error',
    // 'sc-desktop не запущен') из catch'а УЖЕ ПОСЛЕ того как background
    // успел прислать done (cache-hit отвечает мгновенно, локальный fetch
    // может failnut'ь поздно). Не даём stale-error перетереть свежий done.
    if (state === 'error' && (prev.state === 'done' || prev.state === 'pasted')) {
      console.log('[SC-YT] setVideoState: ignoring stale error for', videoId, '— already', prev.state);
      return;
    }
    if (state === 'idle') {
      videoStateMap.delete(videoId);
      const t = stateTimers.get(videoId);
      if (t) { clearTimeout(t); stateTimers.delete(videoId); }
    } else {
      const auto = opts.autoAistudio != null ? opts.autoAistudio : prev.autoAistudio;
      const title = opts.title != null ? opts.title : prev.title;
      // engine приходит из background.js на стадии 'transcribing'; на
      // 'searching' bridge ещё не знает какой engine (subs могут найтись
      // и AI вообще не понадобится). Сохраняем prev.engine чтобы при
      // переходе searching→transcribing не потерять уже известный engine.
      const engine = opts.engine != null ? opts.engine : prev.engine;
      videoStateMap.set(videoId, { state, engine, error: opts.error, title, autoAistudio: auto });
      // Авто-удаление done/error/pasted через TTL.
      const t = stateTimers.get(videoId);
      if (t) clearTimeout(t);
      if (state === 'done' || state === 'error' || state === 'pasted') {
        const ttl = state === 'error' ? 4000 : (state === 'pasted' ? 4500 : 3000);
        // Если вкладка скрыта — НЕ запускаем TTL сразу. Юзер сейчас на
        // другой вкладке (например, AI Studio), он не видит тост.
        // visibilitychange → visible запустит TTL когда юзер вернётся —
        // только тогда таймер начнётся. Без этого «✓ Вставлено в Gemini
        // Studio» сгорает в фоне за 4.5 сек, юзер возвращается и ничего.
        if (document.visibilityState === 'visible') {
          const id = setTimeout(() => {
            stateTimers.delete(videoId);
            videoStateMap.delete(videoId);
            renderPillForCurrentVideo();
            renderToasts();
          }, ttl);
          stateTimers.set(videoId, id);
        }
      }
    }
    renderPillForCurrentVideo();
    renderFabFromState();
    renderPerCardFromState();
    renderToasts();
  }

  // Рендер pill = state[pill.dataset.videoId] ?? idle.
  // Вызывается на изменение hover (из mouseover-делегации) и на изменение Map.
  function renderPillForCurrentVideo() {
    const pill = document.getElementById(PILL_ID);
    if (!pill) return;
    const vid = pill.dataset.videoId || '';
    const entry = vid ? videoStateMap.get(vid) : null;
    const state = entry?.state || 'idle';
    paintPill(pill, state, {
      error: entry?.error,
      engine: entry?.engine,
      autoAistudio: entry?.autoAistudio != null ? entry.autoAistudio : ytSettings.auto_aistudio,
    });
  }

  // Pill показывает ТОЛЬКО активные состояния (sending/working/opening).
  // done/error видны в глобальном тосте — pill сразу возвращается в idle,
  // чтобы юзер мог нажать снова без ожидания TTL и не путать «готово»
  // с актуальным состоянием. Тост остаётся источником правды о результате.
  function paintPill(btn, state, opts = {}) {
    if (!btn || !btn.dataset) return;
    const uiState = (state === 'done' || state === 'error' || state === 'pasted') ? 'idle' : state;
    btn.dataset.state = uiState;
    const auto = opts.autoAistudio != null
      ? opts.autoAistudio
      : (btn.dataset.auto === '1');
    btn.dataset.auto = auto ? '1' : '0';

    const isActiveState = uiState !== 'idle';
    if (isActiveState) btn.dataset.scPinned = '1';
    else delete btn.dataset.scPinned;

    // Split-pill (sc-yt-fab в dock'е) — обновляем как контейнер: на active
    // state'ах ставим overlay-label на весь pill, idle — восстанавливаем
    // обе половинки.
    if (btn.dataset.scYtSplitFab === '1') {
      paintSplitPill(btn, uiState, isActiveState, opts.engine);
      return;
    }

    let label, title;
    switch (uiState) {
      case 'sending':
        label = '⏳ Отправляю…';
        title = 'Отправляю в sc-desktop';
        break;
      case 'searching':
        label = '🔎 Ищу субтитры…';
        title = 'sc-desktop ищет готовые субтитры на YouTube';
        break;
      case 'transcribing': {
        const eng = (opts.engine || 'gemini') === 'assemblyai' ? 'AssemblyAI' : 'Gemini';
        label = (eng === 'AssemblyAI' ? '🎙 Запрос к ' : '🤖 Запрос к ') + eng + '…';
        title = 'Субтитров нет, идёт расшифровка через ' + eng;
        break;
      }
      case 'working':
        // legacy fallback на случай если bridge не передал yt_stage
        label = '⏳ Транскрипция…';
        title = 'sc-desktop обрабатывает видео';
        break;
      case 'opening':
        label = '🤖 Gemini Studio…';
        title = 'Открываю Gemini Studio в фоне';
        break;
      case 'idle':
      default:
        label = buttonLabel(auto);
        title = buttonTitle(auto);
        break;
    }
    btn.textContent = label;
    btn.title = title;
    btn.disabled = isActiveState;
    btn.style.borderColor = 'rgba(102, 126, 234, 0.55)';
  }

  // Для split-pill (sc-yt-fab в dock'е): на активных state'ах рисуем
  // один overlay-label поверх обеих половинок, на idle — восстанавливаем
  // copy | ai. Активный state блокирует обе кнопки внутри.
  function paintSplitPill(wrap, uiState, isActive, engine) {
    const overlay = wrap.querySelector(':scope > .sc-split-overlay');
    const halves = wrap.querySelectorAll(':scope > button[data-sc-half]');
    const divider = wrap.querySelector(':scope > div:not(.sc-split-overlay)');
    if (isActive) {
      let label = '';
      let title = '';
      switch (uiState) {
        case 'sending':      label = '⏳ Отправляю…';     title = 'Отправляю в sc-desktop'; break;
        case 'searching':    label = '🔎 Ищу субтитры…';  title = 'sc-desktop ищет готовые субтитры на YouTube'; break;
        case 'transcribing': {
          const eng = (engine || 'gemini') === 'assemblyai' ? 'AssemblyAI' : 'Gemini';
          label = (eng === 'AssemblyAI' ? '🎙 Запрос к ' : '🤖 Запрос к ') + eng + '…';
          title = 'Субтитров нет, идёт расшифровка через ' + eng;
          break;
        }
        case 'working':      label = '⏳ Транскрипция…';   title = 'sc-desktop обрабатывает видео'; break;
        case 'opening':      label = '🤖 Gemini Studio…';  title = 'Открываю Gemini Studio в фоне'; break;
        default:             label = uiState;              title = uiState;
      }
      // Скрываем половины, показываем overlay-метку.
      for (const h of halves) h.style.visibility = 'hidden';
      if (divider) divider.style.visibility = 'hidden';
      // Active state'ы не должны экспонировать cmd-row — клик по «+ копи»
      // создал бы второй POST /yt-add для того же видео.
      const cmdRow = scCmdRowMap.get(wrap);
      if (cmdRow) cmdRow.style.display = 'none';
      let ov = overlay;
      if (!ov) {
        ov = document.createElement('div');
        ov.className = 'sc-split-overlay';
        ov.style.cssText = `
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 0 12px;
          pointer-events: none;
          font: inherit;
          color: inherit;
          white-space: nowrap;
        `;
        wrap.style.position = 'relative';
        wrap.appendChild(ov);
      }
      ov.textContent = label;
      wrap.title = title;
    } else {
      // idle — убираем overlay, показываем половинки.
      if (overlay) overlay.remove();
      for (const h of halves) h.style.visibility = '';
      if (divider) divider.style.visibility = '';
      wrap.title = '';
    }
  }

  // ─────────── Глобальный тост-стек ───────────
  //
  // Fixed-position контейнер сверху-справа. Один тост на каждый видос
  // в Map'е (sending/working/opening/done/error). Auto-hide вместе с
  // удалением из Map (см. TTL в setVideoState).

  const TOAST_HOST_ID = 'sc-yt-toast-host';

  function getOrCreateToastHost() {
    let host = document.getElementById(TOAST_HOST_ID);
    if (host && host.isConnected) return host;
    host = document.createElement('div');
    host.id = TOAST_HOST_ID;
    host.style.cssText = `
      position: fixed;
      top: 70px;
      right: 16px;
      z-index: 2147483000;
      display: flex;
      flex-direction: column;
      gap: 8px;
      pointer-events: none;
      max-width: 360px;
    `;
    document.body.appendChild(host);
    return host;
  }

  // Тост = одна строка: иконка состояния + название видео. Никаких
  // «Транскрипция», «Готово» — состояние читается по иконке и цвету
  // border'а. Title через text-overflow:ellipsis (не slice'ом — иначе
  // длинные в одну строку всё равно сжимаются криво).
  function renderToasts() {
    const host = getOrCreateToastHost();
    if (!host) return;
    const existing = new Map();
    for (const node of host.querySelectorAll('[data-sc-toast-vid]')) {
      existing.set(node.dataset.scToastVid, node);
    }
    const wantedIds = new Set(videoStateMap.keys());
    for (const [vid, node] of existing) {
      if (!wantedIds.has(vid)) node.remove();
    }
    for (const [vid, entry] of videoStateMap) {
      let node = existing.get(vid);
      if (!node) {
        node = document.createElement('div');
        node.dataset.scToastVid = vid;
        node.style.cssText = `
          height: 32px;
          box-sizing: border-box;
          padding: 0 4px 0 12px;
          border-radius: 16px;
          background: rgba(20, 20, 24, 0.94);
          border: 1px solid rgba(102, 126, 234, 0.55);
          color: #e9ecef;
          font: 13px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          box-shadow: 0 4px 12px rgba(0,0,0,0.45);
          backdrop-filter: blur(6px);
          pointer-events: auto;
          display: flex;
          align-items: center;
          gap: 8px;
          animation: sc-toast-in 0.18s ease-out;
          max-width: 360px;
        `;
        // Иконка слева
        const ic = document.createElement('span');
        ic.dataset.scToastIcon = '1';
        ic.style.cssText = 'flex: 0 0 auto; line-height: 1;';
        // Название видео — text-overflow: ellipsis вместо .slice()
        const tt = document.createElement('span');
        tt.dataset.scToastTitle = '1';
        tt.style.cssText = `
          flex: 1 1 auto;
          min-width: 0;
          overflow: hidden;
          white-space: nowrap;
          text-overflow: ellipsis;
        `;
        // Крест-закрытие справа — единый для всех state'ов. Не отменяет
        // job (это всё ещё происходит на бэкенде), просто прячет тост.
        // Удаляем из Map'а ровно так же как делает TTL-таймер.
        const cls = document.createElement('button');
        cls.dataset.scToastClose = '1';
        cls.textContent = '×';
        cls.style.cssText = `
          flex: 0 0 auto;
          background: transparent;
          border: none;
          color: #a5a5a5;
          cursor: pointer;
          font: 16px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          padding: 0 4px;
          margin-left: 2px;
          opacity: 0.7;
          transition: opacity 0.12s;
        `;
        cls.addEventListener('mouseenter', () => { cls.style.opacity = '1'; });
        cls.addEventListener('mouseleave', () => { cls.style.opacity = '0.7'; });
        cls.addEventListener('click', e => {
          e.stopPropagation();
          // setVideoState(vid, 'idle') и таймер уберёт; чтобы не дёргать
          // лишнюю стейт-логику — атомарно удалим из обеих map'ов и пере-рендерим.
          videoStateMap.delete(vid);
          const t = stateTimers.get(vid);
          if (t) { clearTimeout(t); stateTimers.delete(vid); }
          renderToasts();
        });
        node.appendChild(ic);
        node.appendChild(tt);
        node.appendChild(cls);
        host.appendChild(node);
      }
      const ic = node.querySelector('[data-sc-toast-icon]');
      const tt = node.querySelector('[data-sc-toast-title]');
      ic.textContent = toastIcon(entry);
      // Для error'а показываем причину ПРЯМО в тосте (не только в hover-tooltip):
      // красный ✗ + border сигналят «ошибка», но без видимого текста юзер не
      // понимал ЧТО сломалось, а tooltip ещё и сгорал через 4с TTL. one-line
      // ellipsis сам обрежет длинное; полный текст остаётся в node.title.
      const errSuffix = entry.state === 'error' && entry.error ? ' — ' + entry.error : '';
      const baseTitle = entry.title || `Видео ${vid}`;
      tt.textContent = entry.state === 'error' ? baseTitle + errSuffix : baseTitle;
      node.title = baseTitle + errSuffix;
      // Border color по state
      const borderByState = { done: '#2b8a3e', pasted: '#2b8a3e', error: '#c92a2a' };
      node.style.borderColor = borderByState[entry.state] || 'rgba(102, 126, 234, 0.55)';
    }
  }

  // Иконка тоста — единственный визуальный различитель состояний
  // (плюс border-цвет). Все состояния = одна строка «icon + title».
  function toastIcon(entry) {
    switch (entry.state) {
      case 'sending':      return '⏳';
      case 'searching':    return '🔎';
      case 'transcribing': return (entry.engine === 'assemblyai') ? '🎙' : '🤖';
      case 'working':      return '⏳';
      case 'opening':      return '🤖';
      case 'done':         return '✓';        // транскрипт сохранён + в clipboard
      case 'pasted':       return '🤖✓';      // вставлен в Gemini Studio (отличаем от done)
      case 'error':        return '✗';
      default:             return '•';
    }
  }

  // CSS для анимации тоста — отдельный стиль, чтобы не плодить inline keyframes.
  function injectToastCss() {
    if (document.getElementById('sc-yt-toast-style')) return;
    const s = document.createElement('style');
    s.id = 'sc-yt-toast-style';
    s.textContent = `
      @keyframes sc-toast-in {
        from { opacity: 0; transform: translateX(20px); }
        to   { opacity: 1; transform: translateX(0); }
      }
    `;
    document.head.appendChild(s);
  }

  // Split-pill для shorts/watch dock'а: левая половина = copy-only,
  // правая = copy + AI Studio. Между ними vertical divider. Каждая
  // половина — самостоятельная <button>, обе вызывают handleClick с
  // разным autoAistudioOverride.
  //
  // Возвращает div-контейнер; на нём id и dataset.videoId — чтобы
  // существующая логика поиска FAB и обновления state работала.
  // variant:
  //   'dock'    — для FAB в sc-dock'е на /watch и /shorts. height:36,
  //               position:static (dock сам позиционирует). Используется
  //               в getOrCreateShortsDock + injectWatchFab.
  //   'overlay' — для pill поверх thumb'а (singleton hover-preview +
  //               per-card на главной/поиске/sidebar). height:32,
  //               position:absolute, родителю выставляется position:relative
  //               снаружи (вызывающим кодом).
  function makeSplitPill(videoId, url, opts = {}) {
    const variant = opts.variant === 'overlay' ? 'overlay' : 'dock';
    const wrap = document.createElement('div');
    wrap.dataset.scYtSplitFab = '1';
    wrap.dataset.scYtBtn = '1';   // чтобы старый cleanup в init() мёл и split-pill'ы
    wrap.dataset.videoId = videoId || '';
    wrap.dataset.state = 'idle';
    if (opts.className) {
      for (const cls of opts.className.split(/\s+/)) if (cls) wrap.classList.add(cls);
    }
    const isOverlay = variant === 'overlay';
    // Overlay (карточки) — компактнее dock'а: меньшая высота и горизонтальный
    // padding (иначе на превьюшках мелких видео pill съедает половину thumb'а).
    const height = isOverlay ? '30px' : '36px';
    wrap.style.cssText = `
      display: inline-flex;
      align-items: stretch;
      height: ${height};
      min-height: ${height};
      box-sizing: border-box;
      border-radius: 18px;
      overflow: hidden;
      background: rgba(20, 20, 24, 0.88);
      border: 1px solid rgba(102, 126, 234, 0.55);
      color: #e9ecef;
      font: 500 13px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      backdrop-filter: blur(6px);
      box-shadow: 0 2px 6px rgba(0,0,0,0.35);
      pointer-events: auto;
      user-select: none;
    `;

    // SVG copy icon (16x16, currentColor) — для левой части.
    const copyIcon = `
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block;">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
      </svg>
    `;
    // AI side — простой «+».
    const aiIcon = `
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" style="display:block;">
        <path d="M12 5v14M5 12h14"></path>
      </svg>
    `;

    const padX = isOverlay ? '10px' : '12px';
    const mkHalf = (icon, label, title, onClick, opts = {}) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.title = title;
      b.dataset.scHalf = opts.role || 'copy';
      // Hover-фон через CSS-класс, не inline JS — иначе cloneNode(true)
      // в singleton/per-card теряет listener'ы и кнопки на карточках
      // не подсвечиваются. CSS-класс выживает клонирование.
      b.classList.add('sc-pill-half');
      b.style.cssText = `
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 0 ${padX};
        height: 100%;
        border: none;
        background: transparent;
        color: inherit;
        font: inherit;
        cursor: pointer;
        line-height: 1;
        transition: background 0.12s;
      `;
      b.innerHTML = `${icon}<span>${label}</span>`;
      b.addEventListener('mousedown', e => e.stopPropagation());
      b.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      });
      return b;
    };

    // Главные половинки рассчитаны на dynamic url из dataset.videoId
    // в overlay-варианте — резолвим url в момент клика, а не в closure.
    const resolveUrl = () => {
      if (url) return url;
      const vid = wrap.dataset.videoId;
      return vid ? `https://www.youtube.com/watch?v=${vid}` : null;
    };
    const left = mkHalf(copyIcon, 'copy', 'Скопировать в sc-desktop',
      () => { const u = resolveUrl(); if (u) handleClick(u, wrap, false, false); },
      { role: 'copy' });
    const divider = document.createElement('div');
    divider.style.cssText = `
      width: 1px;
      align-self: stretch;
      background: rgba(102, 126, 234, 0.45);
    `;
    // AI-половина: тот же background что у copy. Hover-фон такой же,
    // как у copy — единый стиль, только divider визуально разделяет
    // зоны клика.
    const right = mkHalf(aiIcon, 'ai', 'Скопировать + открыть Gemini Studio',
      () => { const u = resolveUrl(); if (u) handleClick(u, wrap, true, false); },
      { role: 'ai' });

    wrap.append(left, divider, right);

    // Cmd-row: невидим по умолчанию. Появляется когда зажат Cmd/Ctrl и
    // курсор над pill'ом (или над самим cmd-row'ом). Две кнопки —
    // copy + comments  И  copy + comments + ai. Зачем это: лень
    // пользоваться popup'ом для разовой смены «забрать ли комменты» —
    // удобно одноразово прижать Cmd при клике.
    //
    // Хранится В САМОМ wrap'е чтобы при удалении pill'а cmd-row тоже
    // очищался (cleanup via [data-sc-yt-btn] селектор). Position:fixed
    // с пересчётом координат по bbox wrap'а — не зависим от родителя
    // (overflow:hidden у wrap'а, разные variant'ы и т.п.).
    // Cmd-row визуально отличаем от основного pill'а: чуть прозрачнее
    // (alpha 0.78 vs 0.94), приглушённый border. Высота 36 — совпадает с
    // dock-pill'ами (sc-pill + speed-pill), чтобы при перекрытии со
    // speed-pill была единая линия, а не «один выше другого».
    const cmdRow = document.createElement('div');
    cmdRow.dataset.scCmdRow = '1';
    cmdRow.style.cssText = `
      position: fixed;
      display: none;
      align-items: stretch;
      height: 36px;
      border-radius: 18px;
      overflow: hidden;
      background: rgba(35, 38, 50, 0.78);
      border: 1px dashed rgba(102, 126, 234, 0.45);
      color: #e9ecef;
      font: 500 12px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      backdrop-filter: blur(6px);
      box-shadow: 0 4px 12px rgba(0,0,0,0.45);
      pointer-events: auto;
      user-select: none;
      z-index: 2147483001;
    `;
    // Без иконок — чистый текст «+ субтитры» / «+ субтитры + ai»,
    // чтобы визуально отличалось от основного pill'а с copy/ai-иконками.
    const cmtPlus = mkHalf('', '+ субтитры', 'Скопировать вместе с комментариями',
      () => {
        const u = resolveUrl();
        dbg('cmd.click.copy-comments', { url: u, vid: wrap.dataset.videoId });
        if (u) handleClick(u, wrap, false, true);
      },
      { role: 'copy-comments' });
    const cmtDivider = document.createElement('div');
    cmtDivider.style.cssText = 'width: 1px; align-self: stretch; background: rgba(102, 126, 234, 0.35);';
    const cmtAi = mkHalf('', '+ субтитры + ai', 'Скопировать с комментариями + открыть Gemini Studio',
      () => {
        const u = resolveUrl();
        dbg('cmd.click.ai-comments', { url: u, vid: wrap.dataset.videoId });
        if (u) handleClick(u, wrap, true, true);
      },
      { role: 'ai-comments' });
    cmdRow.append(cmtPlus, cmtDivider, cmtAi);
    // Диагностика: видим ли курсор реально cmd-row, и долетают ли по
    // нему mousedown/click. Без этого нельзя различить «юзер не кликнул»
    // от «клик ушёл мимо».
    cmdRow.addEventListener('mouseenter', () => dbg('cmdRow.mouseenter', { vid: wrap.dataset.videoId }));
    cmdRow.addEventListener('mouseleave', () => dbg('cmdRow.mouseleave', { vid: wrap.dataset.videoId }));
    cmdRow.addEventListener('mousedown',  (e) => dbg('cmdRow.mousedown', { target: e.target?.tagName, role: e.target?.dataset?.scHalf || null }));
    cmdRow.addEventListener('click',      (e) => dbg('cmdRow.click', { target: e.target?.tagName, role: e.target?.dataset?.scHalf || null }));
    // КЛЮЧЕВОЕ: cmd-row пристёгиваем к document.body, а не к wrap'у.
    // У wrap'а overflow:hidden + position:absolute, и YouTube часто
    // ставит transform/filter на родителях карточки — fixed-position
    // child обрезается контейнером с transform'ом. body-level
    // позиционирование чисто viewport-relative, режется только viewport'ом.
    // Связь wrap↔cmdRow держим через scCmdRowMap (см. ниже).
    document.body.appendChild(cmdRow);
    scCmdRowMap.set(wrap, cmdRow);
    dbg('makeSplitPill.cmdRow.attached', { variant, vid: videoId, parent: 'body' });

    // На mouseenter pill'а — если Cmd сейчас зажат, сразу показываем
    // cmd-row. На leave — если курсор НЕ ушёл на cmd-row, прячем.
    // Используем pointerover/pointerout (live :hover) вместо dataset-флагов.
    // Пока Cmd зажат — cmd-row, появившийся под этой pill, остаётся
    // видимым даже если курсор съезжает (юзер целит во вторую pill
    // → нет мерцания между). Скрытие — только на keyup Meta или blur.
    wrap.addEventListener('mouseenter', () => {
      dbg('pill.mouseenter', { vid: wrap.dataset.videoId, isCmdHeld });
      if (isCmdHeld) showCmdRow(wrap);
    });
    wrap.addEventListener('mouseleave', () => {
      dbg('pill.mouseleave', { vid: wrap.dataset.videoId, isCmdHeld });
    });

    return wrap;
  }

  // Cmd-toggle: глобальный state + helpers. Cmd на macOS, Ctrl на Win/Linux —
  // оба event.metaKey/event.ctrlKey ловим (юзер сказал Cmd, остальным даём
  // тот же шорткат через ctrlKey без отдельной настройки).
  let isCmdHeld = false;
  // Связь wrap → cmdRow (cmd-row живёт в document.body, не в wrap'е, чтобы
  // обойти transform-clip от YouTube'овских предков).
  const scCmdRowMap = new WeakMap();
  function isModKey(e) { return e.key === 'Meta' || e.key === 'Control'; }

  function showCmdRow(wrap) {
    const cmdRow = scCmdRowMap.get(wrap);
    if (!cmdRow) {
      dbg('showCmdRow.NO_ROW', { vid: wrap.dataset.videoId });
      return;
    }
    const r = wrap.getBoundingClientRect();
    if (r.width <= 0) {
      dbg('showCmdRow.ZERO_BBOX', { vid: wrap.dataset.videoId, r: { l: r.left, t: r.top, w: r.width, h: r.height } });
      return;
    }
    // Один cmd-row за раз — прячем у всех остальных pill'ов.
    for (const otherWrap of document.querySelectorAll('[data-sc-yt-split-fab="1"]')) {
      if (otherWrap !== wrap) hideCmdRow(otherWrap);
    }
    cmdRow.style.left = r.left + 'px';
    cmdRow.style.top  = (r.bottom + 6) + 'px';
    cmdRow.style.minWidth = r.width + 'px';
    cmdRow.style.display = 'inline-flex';
    dbg('showCmdRow.SHOWN', { vid: wrap.dataset.videoId, left: r.left, top: r.bottom + 6, width: r.width });
  }
  function hideCmdRow(wrap) {
    const cmdRow = scCmdRowMap.get(wrap);
    if (!cmdRow) return;
    cmdRow.style.display = 'none';
  }
  function showCmdRowsForHoveredPills() {
    const all = document.querySelectorAll('[data-sc-yt-split-fab="1"]');
    const hoveredVids = [];
    let shown = 0;
    for (const wrap of all) {
      const isHover = wrap.matches(':hover');
      if (isHover) { hoveredVids.push(wrap.dataset.videoId); showCmdRow(wrap); shown++; }
    }
    dbg('cmd.scan', { totalPills: all.length, hovered: shown, hoveredVids });
  }
  function hideAllCmdRows() {
    let n = 0;
    for (const wrap of document.querySelectorAll('[data-sc-yt-split-fab="1"]')) {
      hideCmdRow(wrap); n++;
    }
    dbg('cmd.hideAll', { hidden: n });
  }

  function installCmdListeners() {
    if (window.__sc_cmd_listeners) return;
    window.__sc_cmd_listeners = true;
    dbg('installCmdListeners.attached');

    // 3 уровня перехвата чтобы детерминированно понять, какой именно
    // путь работает (window/document/body, capture/bubble). Каждый
    // даёт свою dbg-строку — по логу видно «какой именно слышит».
    const onDown = (where, e) => {
      if (!isModKey(e)) return;
      dbg('keydown.heard', { where, key: e.key, code: e.code, isCmdHeld, repeat: e.repeat });
      if (isCmdHeld) return;
      isCmdHeld = true;
      showCmdRowsForHoveredPills();
    };
    const onUp = (where, e) => {
      if (!isModKey(e)) return;
      dbg('keyup.heard', { where, key: e.key, code: e.code, isCmdHeld });
      if (!isCmdHeld) return;
      isCmdHeld = false;
      hideAllCmdRows();
    };

    window.addEventListener('keydown', e => onDown('window.capture', e), true);
    document.addEventListener('keydown', e => onDown('document.capture', e), true);
    document.addEventListener('keyup',   e => onUp('document.capture', e), true);
    window.addEventListener('keyup',     e => onUp('window.capture', e), true);

    window.addEventListener('blur', () => {
      dbg('window.blur', { isCmdHeld });
      if (!isCmdHeld) return;
      isCmdHeld = false;
      hideAllCmdRows();
    });
  }

  // Speed shortcuts: < = -0.1, > = +0.1 (независимо от языка раскладки —
  // ловим e.code === 'Comma'/'Period' + e.shiftKey, это physical keys).
  // YouTube'ный нативный Shift+, / Shift+. меняет скорость шагом 0.25 —
  // перехватываем capture:true + preventDefault, наша логика идёт первой.
  // Не реагируем когда фокус в input/textarea/contenteditable (юзер
  // печатает в комментариях/поиске).
  function installSpeedShortcuts() {
    if (window.__sc_speed_listeners) return;
    window.__sc_speed_listeners = true;
    dbg('installSpeedShortcuts.attached');
    const isTypingTarget = (t) => {
      if (!t) return false;
      const tag = (t.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') return true;
      if (t.isContentEditable) return true;
      return false;
    };
    // Двойная регистрация: window AND document, capture:true оба. YouTube
    // на /watch'е может ставить keydown на window — capture-listener на
    // window сработает ДО любого regular bubble-listener'а где угодно.
    // Idempotency через timestamp: если второй listener получил тот же
    // event (window→document оба capture), не дёргаем bump дважды.
    let lastHandledTs = 0;
    const handler = (where, e) => {
      // Лог для всех Comma/Period — увидим долетают ли вообще.
      if (e.code === 'Comma' || e.code === 'Period') {
        dbg('speed.key.heard', {
          where, code: e.code, key: e.key,
          shift: e.shiftKey, meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey,
          target: e.target?.tagName,
          isTyping: isTypingTarget(e.target),
        });
      }
      // Юзер просил «< / >» — оказалось имеется в виду одиночные , / .
      // (без Shift'а). Раскладку не считываем — слушаем e.code (physical keys
      // Comma / Period). На /watch'е YouTube нативно использует , / . для
      // покадрового перемещения на паузе — мы перехватываем capture-true
      // + preventDefault, чтобы наша скорость выиграла.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Shift пропускаем — YouTube'ный Shift+,/Shift+. меняет скорость
      // шагом 0.25. Если юзер хочет крупный шаг — этот путь остаётся.
      if (e.shiftKey) return;
      if (isTypingTarget(e.target)) return;
      const p = location.pathname;
      if (!p.startsWith('/watch') && !p.startsWith('/shorts/')) return;
      let delta = 0;
      if (e.code === 'Comma')  delta = -0.1;
      else if (e.code === 'Period') delta = +0.1;
      else return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      // Тот же event пришёл и в window.capture, и в document.capture —
      // bump'аем только в первом, второй просто ест event и preventDefault'ит.
      if (e.timeStamp !== lastHandledTs) {
        lastHandledTs = e.timeStamp;
        bumpShortsSpeed(delta);
        dbg('speed.shortcut', { delta, code: e.code, where });
      }
    };
    window.addEventListener('keydown',   (e) => handler('window.capture',   e), true);
    document.addEventListener('keydown', (e) => handler('document.capture', e), true);
  }

  // При смене toggle в popup'е chrome.storage.sync эмитит onChanged во всех
  // вкладках — обновляем подписи existing кнопок без F5. Перерендерим только
  // idle-кнопки (singleton + FAB), у активных state свой label, его нельзя
  // затирать mid-flight — у нас стейт хранится в Map, перерендер pill'а
  // делается через renderPillForCurrentVideo / renderFabFromState и подберёт
  // актуальный auto автоматически.
  function refreshAllButtons(autoAistudio) {
    renderPillForCurrentVideo();
    renderFabFromState();
  }

  // CSS rules:
  // 1. Singleton-pill: ничего не делаем — наследует видимость
  //    #video-preview-container (YouTube сам прячет/показывает).
  // 2. Per-card pill (.sc-percard-pill в `yt-lockup-view-model`/`ytd-rich-item-renderer`):
  //    opacity:0 по умолчанию, opacity:1 на hover ближайшего родителя-карточки.
  //    Это нужно для рекомендаций /watch и других мест где preview-overlay
  //    не активируется YouTube'ом — pill не должна торчать постоянно.
  function injectGlobalCss() {
    if (document.getElementById('sc-yt-style')) return;
    const style = document.createElement('style');
    style.id = 'sc-yt-style';
    // !important потому что makeSplitPill для singleton-pill ставит
    // wrap.style.opacity='1' inline (у неё свой механизм видимости через
    // hover-preview контейнер YouTube'а). Inline-стили перекрывают обычные
    // CSS-rule'ы — без !important per-card hover-скрытие не сработало бы.
    style.textContent = `
      .sc-percard-pill {
        opacity: 0 !important;
        transition: opacity 0.08s;
      }
      yt-lockup-view-model:hover .sc-percard-pill,
      ytd-rich-item-renderer:hover .sc-percard-pill,
      ytd-video-renderer:hover .sc-percard-pill,
      ytd-grid-video-renderer:hover .sc-percard-pill,
      ytd-compact-video-renderer:hover .sc-percard-pill,
      ytm-shorts-lockup-view-model:hover .sc-percard-pill,
      ytm-shorts-lockup-view-model-v2:hover .sc-percard-pill,
      /* На канале /videos thumb-host прямой потомок <a class="ytLockupViewModelContentImage">,
         а сам yt-lockup-view-model имеет display:contents — :hover на нём
         не «доходит» вниз через каскад. Hover на самом thumb-host'е надёжнее. */
      yt-thumbnail-view-model:hover .sc-percard-pill,
      .ytThumbnailViewModelHost:hover .sc-percard-pill,
      a.ytLockupViewModelContentImage:hover .sc-percard-pill,
      /* Активный transcribe: pill закреплена видимой даже если мышь ушла
         (data-sc-pinned ставится в paintPill на sending/working). Канальный
         data-sc-always-visible удалён — pill теперь hover-only везде (BUG#1). */
      .sc-percard-pill[data-sc-pinned="1"] {
        opacity: 1 !important;
      }
      /* sc-yt-fab живёт в общем sc-dock'е (position:fixed). Сам fab всегда
         opacity:1 — видимостью управляет dock через JS-флаг dockHovered
         (updateShortsDockPosition ставит dock.style.visibility). CSS-hover
         тут не годится: dock — сосед body, не потомок #movie_player. */
      #sc-yt-fab {
        opacity: 1;
        pointer-events: auto;
      }

      /* Hover-фон для половинок split-pill'а. Через CSS, а не inline-JS —
         singleton/per-card pill клонируют half-кнопки cloneNode(true)'ом
         для перевешивания click handler'а, и JS-listener'ы при этом
         теряются (cloneNode копирует только атрибуты). CSS-класс выживает. */
      button.sc-pill-half:hover:not(:disabled) {
        background: rgba(255, 255, 255, 0.10) !important;
      }
    `;
    document.head.appendChild(style);
  }

  // Toast'и удалены: весь прогресс теперь — на самой pill-кнопке (sending →
  // working → opening → done). Это даёт детерминированную привязку к
  // конкретному видео без лишнего шума на странице.

  // ─────────── Action ───────────

  async function pingBridge() {
    try {
      const r = await fetch(SC_ENDPOINT_BASE + '/healthz', { method: 'GET' });
      return r.ok;
    } catch { return false; }
  }

  // withCommentsOverride: explicit boolean. null = читать из ytSettings.
  async function sendVideo(url, withCommentsOverride = null) {
    const withComments = withCommentsOverride != null
      ? !!withCommentsOverride
      : !!ytSettings.with_comments;
    const r = await fetch(SC_ENDPOINT_BASE + '/yt-add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, withComments }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || ('HTTP ' + r.status));
    }
    const data = await r.json();
    return { ...data, settings: ytSettings };
  }

  function pageVideoTitle() {
    if (location.pathname.startsWith('/watch')) {
      const t = document.querySelector('h1.ytd-watch-metadata, h1.title');
      if (t?.textContent?.trim()) return t.textContent.trim();
    }
    return document.title.replace(/ - YouTube$/, '').trim() || null;
  }

  // Re-entry guard: если для этого videoId уже идёт активный flow (sending/
  // working/opening), второй click игнорируется. Это закрывает кейс «юзер
  // двойным кликом запустил 2 параллельных POST /yt-add → 2 разных jobId на
  // sc-desktop». Старый btn.disabled не помогал: handleClick async, между
  // первым click'ом и paintPill('sending') есть как минимум один tick — за
  // этот tick юзер успевает кликнуть второй раз пока pill ещё в idle.
  function isActiveForVideo(videoId) {
    const entry = videoStateMap.get(videoId);
    return entry && (entry.state === 'sending' || entry.state === 'working' || entry.state === 'opening');
  }

  // autoAistudioOverride: explicit boolean. null = читать из ytSettings
  // (legacy single-button paths). Split-button в dock'е передаёт явно
  // true (правая часть) или false (левая часть).
  // withCommentsOverride: explicit boolean. null = читать из ytSettings.
  // Cmd-expansion ряд передаёт true (copy/ai + комменты).
  async function handleClick(url, btn, autoAistudioOverride = null, withCommentsOverride = null) {
    const videoId = extractVideoId(url);
    dbg('handleClick.enter', { url, videoId, autoAistudioOverride, withCommentsOverride });
    if (isActiveForVideo(videoId)) {
      dbg('handleClick.ignored', { reason: 'already-active', videoId });
      return;
    }
    const titleSnapshot = pickCardTitleForVideo(videoId, btn) || pageVideoTitle();
    setVideoState(videoId, 'sending', { title: titleSnapshot });
    try {
      if (!await pingBridge()) {
        setVideoState(videoId, 'error', { error: 'sc-desktop не запущен', title: titleSnapshot });
        return;
      }
      const sent = await sendVideo(url, withCommentsOverride);
      const {
        jobId, commentsJobId, fromCache,
        cached_file_path: cachedFilePath,
        cached_comments_file_path: cachedCommentsFilePath,
        settings,
      } = sent;

      // autoAistudio: если override не задан — читаем из settings (legacy).
      // Split-button в dock'е передаёт override явно.
      const autoAistudio = autoAistudioOverride != null
        ? !!autoAistudioOverride
        : !!settings.auto_aistudio;

      const chosenTarget = settings.target || 'aistudio';
      dbg('handleClick.track_job', { target: chosenTarget, fromCache: !!fromCache, autoAistudio, claudeProject: settings.claude_project, claudeModel: settings.claude_model });

      // Передаём job трекеру в SW. КРИТИЧНО: с callback + проверкой
      // chrome.runtime.lastError. Раньше это был fire-and-forget в `catch {}`,
      // и если канал к SW рвался (SW выгружен, расширение перезагружается) —
      // trackJob не запускался, в storage не появлялась запись, ни таймаута,
      // ни ошибки: плашка зависала на «⏳ Транскрипция…» навсегда (только
      // F5 спасал). Теперь оборачиваем в Promise, ждём ответ, и при провале
      // переводим в 'error'. Re-entry guard держится: 'sending' выставлен
      // синхронно выше (isActiveForVideo это видит) — двойного POST нет.
      const trackResp = await new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage({
            __sc_track_job: true,
            job: {
              jobId, commentsJobId,
              url, videoId, title: titleSnapshot,
              fromCache: !!fromCache,
              cachedFilePath: cachedFilePath || null,
              cachedCommentsFilePath: cachedCommentsFilePath || null,
              autoAistudio,
              // Движок AI-транскрипции для awaiting_ai resume (gemini|assemblyai).
              // trackJob.engine → POST /yt-resume-ai. Без этого resume всегда
              // шёл gemini'ем, игнорируя настройку.
              engine: settings.engine || 'gemini',
              // Target dispatch: 'aistudio' (Gemini) или 'claude'.
              target: chosenTarget,
              // Gemini-side
              modelTitle: settings.model_title || 'Gemini 3 Flash Preview',
              postModelTitle: settings.post_model_title || '',
              systemInstruction: settings.system_instruction || '',
              postSystemInstruction: settings.post_system_instruction || '',
              // Claude-side
              claudeModel: settings.claude_model || 'Opus 4.7',
              claudeProject: settings.claude_project || '',
              claudePostProject: settings.claude_post_project || '',
              claudeAdaptiveThinking: settings.claude_adaptive_thinking !== false,
            },
          }, (resp) => {
            const lerr = chrome.runtime.lastError;
            resolve({ ok: !lerr && resp && resp.ok !== false, error: lerr?.message || resp?.error });
          });
        } catch (e) {
          resolve({ ok: false, error: e.message || String(e) });
        }
      });

      if (!trackResp.ok) {
        dbg('handleClick.track_failed', { error: trackResp.error });
        // stale-error guard в setVideoState не даст затереть быстрый
        // cache-hit 'done', если он успел прийти раньше callback'а.
        setVideoState(videoId, 'error', {
          error: 'трекер недоступен — перезапустите расширение' + (trackResp.error ? ': ' + trackResp.error : ''),
          title: titleSnapshot,
        });
        return;
      }

      setVideoState(videoId, 'working', { title: titleSnapshot, autoAistudio });
    } catch (e) {
      console.warn('[SC-YT] send failed', e);
      setVideoState(videoId, 'error', { error: e.message || String(e), title: titleSnapshot });
    }
  }

  // Найдём title видео по videoId, ища его в текущем DOM (карточки на странице,
  // /watch заголовок, hover-preview header). Используется для тоста: чтобы юзер
  // через 5 минут увидел «✓ Готово: <название>» и понял какое видео завершилось.
  function pickCardTitleForVideo(videoId, btnHint) {
    if (!videoId) return null;
    // /watch на этом самом видосе — берём h1.
    if (location.pathname.startsWith('/watch')) {
      const v = new URLSearchParams(location.search).get('v');
      if (v === videoId) {
        const h = document.querySelector('h1.ytd-watch-metadata, h1.title');
        if (h?.textContent?.trim()) return h.textContent.trim();
      }
    }
    // /shorts/<id> — на странице активного шорта берём заголовок из
    // нового шаблона ShortsVideoTitle.
    if (location.pathname.startsWith('/shorts/')) {
      const seg = location.pathname.split('/').filter(Boolean);
      if (seg[1] === videoId) {
        const h = document.querySelector('h2[class*="ShortsVideoTitle"], yt-shorts-video-title-view-model');
        if (h?.textContent?.trim()) return h.textContent.trim();
      }
    }
    // Ищем карточку с этим videoId по anchor'у — учитываем обе формы.
    const link = document.querySelector(`a[href*="/watch?v=${videoId}"], a[href$="/shorts/${videoId}"], a[href*="/shorts/${videoId}?"]`);
    if (link) {
      // 1) ближайший контейнер карточки (включая shorts-карточку нового шаблона)
      const card = link.closest('ytd-rich-item-renderer, ytd-video-renderer, yt-lockup-view-model, ytd-grid-video-renderer, ytd-compact-video-renderer, yt-shorts-lockup-view-model');
      if (card) {
        const t = findCardTitle(card);
        if (t) return t;
        // shorts-карточка: title — это сам link.title или span с aria-label
        if (link.title) return link.title.trim();
      }
      // 2) сам anchor — у него может быть aria-label с заголовком
      const aria = link.getAttribute('aria-label');
      if (aria) return aria.split('\n')[0].trim();
      if (link.title) return link.title.trim();
    }
    return null;
  }

  // ─────────── Singleton preview-pill ───────────
  //
  // Подход скопирован у Яндекса (ya-video-summarization-preview-button):
  // вместо инжекта pill на каждую карточку — ОДНА singleton pill, прибитая
  // к #video-preview-container внутри <ytd-video-preview>. YouTube сам
  // управляет positioning'ом этого контейнера: переезжает на hover'нутую
  // карточку, скрывается когда юзер увёл мышь, остаётся видимым пока
  // курсор внутри inline-preview-плеера. Pill наследует это поведение
  // бесплатно — и preview не останавливается, и hover-видимость работает,
  // и нет дублей с lockup-обёрткой, и стек/z-index не нужно перебивать.
  //
  // Пилюля держит атрибут data-video-id, который обновляется на каждый
  // mouseover карточки. Click читает его в момент клика.
  //
  // Watch-FAB (на /watch) — отдельная история, остаётся как FAB на плеере
  // (там нет preview-механики, видео уже играет в основном плеере).

  const PILL_ID = 'sc-yt-singleton-pill';

  function getOrCreateSingletonPill() {
    let pill = document.getElementById(PILL_ID);
    if (pill && pill.isConnected) return pill;

    // Раньше якорились к `#video-preview-container`, но в новой DOM-схеме
    // YouTube'а сам `#video-preview-container` перестал быть прямой обёрткой
    // thumb'а (между ним и видео встал `#media-container > #media-container-link`),
    // и pill уезжала ВНИЗ под карточку. `#media-container-link` лежит
    // строго поверх thumb'а — позиционирование `top:46/left:8` снова попадает
    // в верх preview-плеера. Fallback на video-preview-container оставлен
    // на случай ещё одного редизайна.
    const container = document.querySelector('ytd-video-preview #media-container-link')
                   || document.querySelector('#video-preview-container #media-container-link')
                   || document.querySelector('ytd-video-preview #video-preview-container')
                   || document.querySelector('#video-preview-container');
    if (!container) return null;

    // Split-pill: copy | + ai. Каждая половина — независимая <button>
    // с собственным handleClick'ом (autoAistudioOverride). videoId
    // меняется при hover'е через dataset на wrap'е, click внутри половин
    // читает АКТУАЛЬНЫЙ videoId с самого pill'а (не closure'нный).
    pill = makeSplitPill('', '', { variant: 'overlay', className: 'sc-card-btn' });
    pill.id = PILL_ID;
    pill.dataset.state = 'idle';
    pill.dataset.videoId = '';
    // Position: тот же якорь что был у старого `makeButton('overlay')` —
    // под Яндекс-чипом «Пересказать» сверху-слева preview-плеера.
    pill.style.position = 'absolute';
    pill.style.top      = '46px';
    pill.style.left     = '8px';
    pill.style.zIndex   = '35';
    pill.style.opacity  = '1';

    // Click delegation на оба <button data-sc-half>: closure делает только
    // диспатч, реальный videoId читается с pill.dataset.videoId — он
    // обновляется hover-делегацией под текущей карточкой.
    for (const half of pill.querySelectorAll(':scope > button[data-sc-half]')) {
      const role = half.dataset.scHalf;
      // Полностью перевешиваем click: оригинальный handler в makeSplitPill
      // привязан к (url, wrap, autoAi) — но url там пустой строкой передан
      // на этапе создания, нам нужен динамический url из dataset.videoId.
      const newBtn = half.cloneNode(true);
      newBtn.addEventListener('mousedown', e => e.stopPropagation());
      newBtn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        const vid = pill.dataset.videoId;
        if (!vid) return;
        const url = `https://www.youtube.com/watch?v=${vid}`;
        // Явный withComments=false: plain copy/+ai НЕ тянут комменты.
        // Комменты — только через Cmd-row (+ субтитры). Без этого 4-го
        // аргумента он падал в null → бралось ytSettings.with_comments,
        // и overlay-плашки расходились с dock-FAB (BUG: comments divergence).
        handleClick(url, pill, role === 'ai', false);
      });
      half.replaceWith(newBtn);
    }

    container.appendChild(pill);
    return pill;
  }

  // mouseover на body — при наведении на любую карточку с /watch?v=…
  // вытаскиваем videoId, обновляем pill, чтобы клик попал в нужное видео,
  // и перерисовываем pill из stateMap[videoId] (если этот видос в работе —
  // pill покажет «⏳ Транскрипция»; если другой — pill вернётся в idle).
  let __sc_lastHoveredVideoId = null;
  function installCardHoverDelegation() {
    if (window.__sc_yt_hover_delegated) return;
    window.__sc_yt_hover_delegated = true;
    document.body.addEventListener('mouseover', e => {
      // Не реагируем на hover внутри самой pill — иначе бесконечный
      // loop при обновлении dataset.
      if (e.target.closest && e.target.closest('#' + PILL_ID)) return;
      // ВАЖНО: ловим и /watch?v=, и /shorts/<id> — без shorts'ов pill
      // оставалась на старом videoId, клик отправлял прошлое видео
      // (юзеру казалось что «копирует последнее, что было скопировано»).
      const link = e.target.closest && e.target.closest(ANCHOR_SELECTOR);
      if (!link) return;
      const vid = extractVideoId(link.href);
      if (!vid || vid === __sc_lastHoveredVideoId) return;
      __sc_lastHoveredVideoId = vid;
      const pill = getOrCreateSingletonPill();
      if (pill) {
        pill.dataset.videoId = vid;
        renderPillForCurrentVideo();
      }
    }, true);
  }

  // ─────────── Per-card pills (fallback) ───────────
  //
  // На страницах где YouTube НЕ запускает inline-preview overlay
  // (правая колонка рекомендаций на /watch, sidebar в некоторых шаблонах),
  // singleton-pill в #video-preview-container не появляется. Yandex там
  // инжектит свой чип «Пересказать» прямо в каждую `yt-thumbnail-view-model`
  // — мы делаем то же самое.
  //
  // Стратегия:
  //   1) ВСЕГДА держим singleton-pill (для главной/поиска и любого видео
  //      где preview активируется);
  //   2) ДОПОЛНИТЕЛЬНО инжектим per-card pill в thumb'ы — для случаев
  //      когда preview не работает.
  // На страницах где работает И то И другое (если такие найдутся) — обе
  // pill'ы видны на разных слоях, click работает с обеих.
  //
  // Активируется только для определённых scope'ов где известно что preview
  // не запускается, чтобы не дублировать pill на главной/поиске.

  const PER_CARD_SCOPES = [
    'ytd-watch-next-secondary-results-renderer',  // /watch — правая колонка
    // Канал /@<handle>/videos — сетка `yt-lockup-view-model` внутри
    // `ytd-rich-grid-renderer`. Singleton hover-preview здесь YouTube'ом
    // НЕ запускается (canvas overlay не лезет в карточки канала), поэтому
    // нужна per-card pill. Тот же selector ytd-rich-grid-renderer
    // используется и для главной страницы youtube.com, но там работает
    // singleton — обе pill'ы будут видны, но это не страшно: они на разных
    // слоях, hover-CSS-правила одинаково их подсвечивают.
    'ytd-rich-grid-renderer',
    // Канал /@<handle>/featured («Главная» внутри канала) — карточки
    // лежат в `ytd-shelf-renderer` (горизонтальные полки) внутри
    // `ytd-item-section-renderer`. Те же `yt-lockup-view-model` с
    // `yt-thumbnail-view-model` внутри.
    'ytd-shelf-renderer',
    'ytd-item-section-renderer',
    // Hero-видео в шапке канальной /featured-страницы — обёрнут в
    // `ytd-channel-featured-content-renderer`, lockup горизонтальный
    // (большая превью слева, заголовок справа), thumb-host тот же
    // `yt-thumbnail-view-model`.
    'ytd-channel-featured-content-renderer',
  ];

  function getPerCardScopeRoots() {
    const roots = [];
    for (const sel of PER_CARD_SCOPES) {
      for (const r of document.querySelectorAll(sel)) roots.push(r);
    }
    return roots;
  }

  // Каналы — все URL вида `/@<handle>/*` (включая /featured, /videos,
  // /shorts, /playlists, /community). На канальных страницах pill должна
  // быть видна постоянно — singleton hover-preview там не запускается и
  // юзер не сможет догадаться навести именно на thumb. /watch и /results
  // оставляем на hover-видимость (там тоже работают per-card pill'ы в
  // правой колонке, но загромождать длинный список нельзя).
  function isChannelPage() {
    return /^\/@[^\/]+(\/|$)/.test(location.pathname);
  }

  // Селекторы для thumb-контейнера в разных шаблонах YouTube'а:
  //   - старый: yt-thumbnail-view-model (главная, поиск)
  //   - новый: .ytThumbnailViewModelHost (правая колонка /watch и др.)
  // На /watch видим только второй вариант, поэтому ищем оба.
  const PER_CARD_THUMB_SELECTOR = 'yt-thumbnail-view-model, .ytThumbnailViewModelHost';

  // Логи в DOM-атрибут body (last 20 entries в JSON) — чтобы можно было
  // прочитать через MCP evaluate без user-scripts toggle. Параллельно
  // console.log для DevTools.
  if (!window.__sc_perCardLog) window.__sc_perCardLog = [];
  let __sc_perCardCallNo = 0;
  function pcLog(msg, extra) {
    const entry = { t: Date.now(), msg, ...(extra || {}) };
    window.__sc_perCardLog.push(entry);
    if (window.__sc_perCardLog.length > 200) window.__sc_perCardLog.shift();
    console.log('[SC-YT-percard]', msg, extra || '');
    try {
      document.body.setAttribute('data-sc-percard-log', JSON.stringify(window.__sc_perCardLog.slice(-20)));
    } catch {}
  }

  function injectPerCardPills() {
    const callNo = ++__sc_perCardCallNo;
    const roots = getPerCardScopeRoots();
    // Per-card pill'ы теперь hover-only ВЕЗДЕ, включая канал (BUG#1).
    // Раньше на /@handle/* ставили data-sc-always-visible="1" (постоянно
    // видны, как Yandex'овский «Пересказать»), но юзер хочет единообразный
    // hover. Здесь безусловно снимаем флаг со всех существующих pill'ов —
    // чистит и stale-флаги, оставшиеся от старых сборок/сессий в DOM.
    for (const pill of document.querySelectorAll('.sc-percard-pill')) {
      delete pill.dataset.scAlwaysVisible;
    }
    let totalThumbs = 0, totalUninjected = 0, totalNoLink = 0, totalNoVid = 0, injected = 0, refreshed = 0;
    let firstUninjectedSample = null;
    for (const root of roots) {
      const thumbs = root.querySelectorAll(PER_CARD_THUMB_SELECTOR);
      totalThumbs += thumbs.length;
      for (const thumb of thumbs) {
        const link = thumb.querySelector('a[href*="/watch?v="]')
                  || thumb.closest('a[href*="/watch?v="]')
                  || thumb.parentElement?.querySelector?.('a[href*="/watch?v="]');
        if (!link) {
          totalNoLink++;
          if (!firstUninjectedSample) {
            firstUninjectedSample = (thumb.outerHTML || '').slice(0, 400);
          }
          continue;
        }
        const vid = extractVideoId(link.href);
        if (!vid) { totalNoVid++; continue; }

        // Проверка: уже есть pill в этом thumb'е?
        // Раньше использовали dataset.scPercardInjected, но Lit/Polymer
        // YouTube'а переиспользует DOM-узлы — на одном и том же thumb может
        // оказаться pill со старым videoId из предыдущего видео в списке.
        // Источник правды — сам button.dataset.videoId vs текущий link.
        const existing = thumb.querySelector(':scope > .sc-percard-pill');
        if (existing) {
          if (existing.dataset.videoId !== vid) {
            existing.dataset.videoId = vid;
            // Перерисуем под состояние нового видео из Map'а.
            const entry = videoStateMap.get(vid);
            paintPill(existing, entry?.state || 'idle', {
              error: entry?.error,
              engine: entry?.engine,
              autoAistudio: entry?.autoAistudio != null ? entry.autoAistudio : ytSettings.auto_aistudio,
            });
            refreshed++;
          }
          continue;
        }
        totalUninjected++;

        const cs = getComputedStyle(thumb);
        if (cs.position === 'static') thumb.style.position = 'relative';

        // Split-pill (copy | + ai) на самой карточке. Каждая половина —
        // независимая кнопка; click читает АКТУАЛЬНЫЙ videoId с pill.dataset
        // (а не closure'нный) — критично из-за thumb-recycle Lit/Polymer'ом.
        const btn = makeSplitPill(vid, '', { variant: 'overlay', className: 'sc-percard-pill' });
        btn.dataset.state = 'idle';
        // Hover-only везде (BUG#1) — без data-sc-always-visible на канале.
        btn.style.position = 'absolute';
        btn.style.top = '46px';
        btn.style.left = '8px';
        btn.style.right = 'auto';
        btn.style.zIndex = '35';
        for (const half of btn.querySelectorAll(':scope > button[data-sc-half]')) {
          const role = half.dataset.scHalf;
          const newBtn = half.cloneNode(true);
          newBtn.addEventListener('mousedown', e => e.stopPropagation());
          newBtn.addEventListener('click', e => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            const currentVid = btn.dataset.videoId;
            if (!currentVid) return;
            const url = `https://www.youtube.com/watch?v=${currentVid}`;
            // Явный withComments=false (см. singleton выше) — комменты только
            // через Cmd-row, плашка не должна молча тянуть их по настройке.
            handleClick(url, btn, role === 'ai', false);
          });
          half.replaceWith(newBtn);
        }
        thumb.appendChild(btn);
        injected++;
      }
    }
    // Также проверим — есть ли вообще scope в DOM, и есть ли альтернативные
    // классы thumb'а которые мы могли упустить.
    const altThumbCount = document.querySelectorAll('ytd-watch-next-secondary-results-renderer .ytThumbnailViewModelHost').length;
    const altLockupCount = document.querySelectorAll('ytd-watch-next-secondary-results-renderer yt-lockup-view-model').length;
    pcLog(`#${callNo} INJECTED=${injected} REFRESHED=${refreshed}`, {
      roots: roots.length,
      thumbs: totalThumbs,
      uninjected: totalUninjected,
      noLink: totalNoLink,
      noVid: totalNoVid,
      injected,
      refreshed,
      url: location.pathname,
      // Direct DOM probes — чтобы видеть есть ли scope и какие thumb-обёртки.
      probe_scope_exists: !!document.querySelector('ytd-watch-next-secondary-results-renderer'),
      probe_thumb_host: altThumbCount,
      probe_lockup: altLockupCount,
      sample: firstUninjectedSample,
    });
  }

  // Shorts на странице канала (`/@handle/shorts`) и в shorts-секциях
  // главной — карточки `ytm-shorts-lockup-view-model[-v2]` без вложенного
  // `yt-thumbnail-view-model`. Singleton hover-preview здесь не запускается
  // (overlay-механика только для watch-карточек), поэтому per-card pill
  // нужна. Структура: внутри shortsLockupViewModelHost лежит `a.reel-item-endpoint`
  // с href `/shorts/<id>` — извлекаем videoId оттуда.
  //
  // Класс pill'а — тот же `.sc-percard-pill`, поэтому renderPerCardFromState
  // и CSS-rule выше автоматически их обрабатывают. Hover-видимость даём
  // через дополнительный селектор в CSS (см. injectGlobalCss).
  const SHORTS_LOCKUP_SELECTOR = 'ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2';

  function injectShortsLockupPills() {
    const cards = document.querySelectorAll(SHORTS_LOCKUP_SELECTOR);
    let injected = 0, refreshed = 0;
    for (const card of cards) {
      const link = card.querySelector('a[href*="/shorts/"]');
      if (!link) continue;
      const vid = extractVideoId(link.href);
      if (!vid) continue;

      // Существующая pill? У нас может быть и v2-обёртка над v1 (см. snapshot:
      // ytm-shorts-lockup-view-model-v2 содержит ytm-shorts-lockup-view-model).
      // Чтобы не дублировать pill — ищем только в самой card (не внутри
      // nested v1 внутри v2). Используем :scope > для прямого descendant,
      // но pill висит на link'е → проверяем что link.querySelector('.sc-percard-pill')
      // не вернул чужую pill.
      const existing = card.querySelector(':scope > a .sc-percard-pill, :scope > ytm-shorts-lockup-view-model .sc-percard-pill');
      if (existing) {
        if (existing.dataset.videoId !== vid) {
          existing.dataset.videoId = vid;
          const entry = videoStateMap.get(vid);
          paintPill(existing, entry?.state || 'idle', {
            error: entry?.error,
            engine: entry?.engine,
            autoAistudio: entry?.autoAistudio != null ? entry.autoAistudio : ytSettings.auto_aistudio,
          });
          refreshed++;
        }
        continue;
      }

      // Якоримся к самому `<a class="reel-item-endpoint">` — у него
      // position:relative по умолчанию (он отвечает за aspect-ratio).
      // Если внезапно position:static — переключим (как и для thumb'а
      // в injectPerCardPills).
      const anchor = link;
      const cs = getComputedStyle(anchor);
      if (cs.position === 'static') anchor.style.position = 'relative';

      const btn = makeSplitPill(vid, '', { variant: 'overlay', className: 'sc-percard-pill' });
      btn.dataset.state = 'idle';
      // Hover-only везде (BUG#1) — без data-sc-always-visible на канале.
      btn.style.position = 'absolute';
      // Yandex'овский «Пересказать» (если они доберутся до shorts-канала)
      // тоже занимает top:8/left:8. Сидим под ним — top:46. Если Yandex'а
      // нет — pill всё равно на видном месте поверх preview-кадра.
      btn.style.top = '46px';
      btn.style.left = '8px';
      btn.style.right = 'auto';
      btn.style.zIndex = '35';
      for (const half of btn.querySelectorAll(':scope > button[data-sc-half]')) {
        const role = half.dataset.scHalf;
        const newBtn = half.cloneNode(true);
        newBtn.addEventListener('mousedown', e => e.stopPropagation());
        newBtn.addEventListener('click', e => {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          const currentVid = btn.dataset.videoId;
          if (!currentVid) return;
          // Нормализуем в watch-форму — у sc-desktop единый кэш для shorts/watch.
          const url = `https://www.youtube.com/watch?v=${currentVid}`;
          // Явный withComments=false (см. singleton/per-card) — комменты
          // только через Cmd-row.
          handleClick(url, btn, role === 'ai', false);
        });
        half.replaceWith(newBtn);
      }
      anchor.appendChild(btn);
      injected++;
    }
    if (injected || refreshed) {
      pcLog(`shorts INJECTED=${injected} REFRESHED=${refreshed}`, {
        cards: cards.length,
        url: location.pathname,
      });
    }
  }

  // Перерисовать per-card pill'ы из stateMap (для chrome.runtime onMessage'ей).
  function renderPerCardFromState() {
    for (const btn of document.querySelectorAll('.sc-percard-pill')) {
      const vid = btn.dataset.videoId;
      const entry = vid ? videoStateMap.get(vid) : null;
      paintPill(btn, entry?.state || 'idle', {
        error: entry?.error,
        engine: entry?.engine,
        autoAistudio: entry?.autoAistudio != null ? entry.autoAistudio : ytSettings.auto_aistudio,
      });
    }
  }

  // ─────────── Shorts dock (общий контейнер под Play) ───────────
  //
  // Зачем dock: верхняя линия #left-controls / #right-controls перекрывается
  // Yandex Summary Overlay (большой слой с пересказом, вылезает поверх
  // controls-bar'а). Поэтому пилы переехали ВНИЗ-ВЛЕВО плеера, в свой
  // независимый контейнер. Order: speed-pill (-/X.Xx/+) первая, sc-pill
  // вторая — единая визуальная линия.
  //
  // Dock сидит в #player-container (узкая колонка плеера, не во всю
  // ширину страницы), absolute top:80 left:12 — под Play+Mute.

  const SHORTS_DOCK_ID = 'sc-yt-shorts-dock';

  // ─── Dock hover-gating (BUG#2/#3) ───
  // Раньше dock (sc-pill + speed-pill) на /watch и /shorts/ висел ПОСТОЯННО,
  // как только у плеера появлялся layout. Юзер хочет hover-only — как у
  // per-card pill'ов. Гейтим через JS-флаг `dockHovered`, НЕ через CSS
  // `#movie_player:hover`: dock — это position:fixed сосед body (не потомок
  // плеера, специально — из-за F5 bbox=0 и пересоздания Polymer'ом), CSS
  // descendant-rule до него не достанет.
  //
  // Union-hover (плеер ИЛИ сам dock): курсор с видео на пилюли не прячет их.
  // Grace-таймер 240ms на pointerleave: переезд через 12px зазор между
  // плеером и dock'ом (или между sc-pill и speed-pill) не мигает.
  //
  // BUG#3 решается этим же бесплатно: смена скорости через `,`/`.` зовёт
  // movie_player.setPlaybackRate(), который будит НАТИВНЫЙ speed-OSD YouTube'а
  // — но НЕ генерит pointerenter на плеере. Значит наш dock остаётся
  // hidden при нажатии клавиш (мерцал именно нативный бейдж, поверх
  // которого висел наш постоянный dock — теперь dock скрыт).
  let dockHovered = false;
  let dockHideTimer = null;
  const DOCK_HOVER_GRACE_MS = 240;

  function setDockHovered(on) {
    if (on) {
      if (dockHideTimer) { clearTimeout(dockHideTimer); dockHideTimer = null; }
      if (!dockHovered) { dockHovered = true; updateShortsDockPosition(); }
    } else {
      if (dockHideTimer) clearTimeout(dockHideTimer);
      dockHideTimer = setTimeout(() => {
        dockHideTimer = null;
        dockHovered = false;
        updateShortsDockPosition();
      }, DOCK_HOVER_GRACE_MS);
    }
  }

  // Привязка hover-листенеров к ТЕКУЩЕМУ якорю + самому dock'у. Идемпотентна
  // (dataset-флаг), пере-вызывается на каждый resolve якоря — Polymer
  // пересоздаёт #movie_player при смене качества/языка и при свайпе shorts'ов,
  // новому узлу нужны свои листенеры. Никогда не вешаем на клоны pill-половин
  // (cloneNode теряет listeners) — только на стабильный dock-контейнер и
  // живой якорь.
  function bindDockHover() {
    const dock = document.getElementById(SHORTS_DOCK_ID);
    if (dock && !dock.dataset.scHoverBound) {
      dock.dataset.scHoverBound = '1';
      dock.addEventListener('pointerenter', () => setDockHovered(true));
      dock.addEventListener('pointerleave', () => setDockHovered(false));
    }
    const anchor = findDockAnchor();
    if (anchor && !anchor.dataset.scHoverBound) {
      anchor.dataset.scHoverBound = '1';
      anchor.addEventListener('pointerenter', () => setDockHovered(true));
      anchor.addEventListener('pointerleave', () => setDockHovered(false));
    }
  }

  // Активный reel-renderer = тот, что занимает основную часть viewport'а.
  // На /shorts/ в DOM могут быть prefetched соседи с bbox=0 (display:none)
  // или далеко за viewport'ом — якориться к ним нельзя, dock уедет за плеер.
  function findActiveReelRenderer() {
    const all = document.querySelectorAll('ytd-reel-video-renderer');
    if (!all.length) return null;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    let best = null, bestArea = 0;
    for (const r of all) {
      const b = r.getBoundingClientRect();
      if (b.width <= 0 || b.height <= 0) continue;
      const top = Math.max(0, b.top);
      const bot = Math.min(vh, b.bottom);
      const visH = Math.max(0, bot - top);
      const visArea = visH * b.width;
      if (visArea > bestArea) { bestArea = visArea; best = r; }
    }
    return best || all[0];
  }

  // Якорь для dock'а:
  //   /watch  — #movie_player (стандартный плеер, его bbox корректный).
  //   /shorts/ — #movie_player ВНУТРИ активного reel-renderer'а.
  //              Глобальный document.getElementById('movie_player') на
  //              /shorts/ может вернуть узел с bbox=0 (в неактивном
  //              reel'е). Поэтому ищем его строго в активном reel'е.
  function findDockAnchor() {
    if (location.pathname.startsWith('/watch')) {
      return document.getElementById('movie_player')
          || document.querySelector('ytd-player #player');
    }
    if (location.pathname.startsWith('/shorts/')) {
      const reel = findActiveReelRenderer();
      if (!reel) return null;
      // Внутри reel-renderer'а #movie_player может ещё не загрузиться.
      // Тогда якоримся к самому reel'у — он имеет тот же bbox.
      return reel.querySelector('#movie_player') || reel;
    }
    return null;
  }

  // Dock — position:fixed, координаты вычисляются от bbox якоря в момент
  // вызова. Если якорь ещё не получил layout (F5, bbox=0), скрываем —
  // позже rAF-poller докрасит когда bbox появится.
  function updateShortsDockPosition() {
    const dock = document.getElementById(SHORTS_DOCK_ID);
    if (!dock) return;
    const anchor = findDockAnchor();
    if (!anchor) { dock.style.visibility = 'hidden'; return; }
    const aRect = anchor.getBoundingClientRect();
    if (aRect.width <= 0 || aRect.height <= 0) { dock.style.visibility = 'hidden'; return; }

    let topOffset = 12;
    if (location.pathname.startsWith('/shorts/')) {
      // На /shorts/ сверху плеера — Play+Mute (h~80px). Ставимся под них
      // с зазором.
      const lc = document.querySelector('ytd-shorts-player-controls #left-controls');
      if (lc) {
        const lcRect = lc.getBoundingClientRect();
        if (lcRect.height > 0) topOffset = (lcRect.bottom - aRect.top) + 12;
        else topOffset = 92;
      } else {
        topOffset = 92;
      }
    }
    // На /watch — отступ всего 12px от верха плеера. Yandex Summary
    // Overlay (если активен) сидит на верхней панели controls'ов, она
    // появляется только при hover'е на плеере и автохайдится — не должно
    // мешать dock'у в angle левого-верха.
    //
    // Координаты пересчитываем ВСЕГДА (даже когда скрыт) — чтобы на первый
    // hover после F5/навигации dock появился сразу в правильном месте, а не
    // прыгнул из (0,0). Видимость — отдельно, по hover-флагу (BUG#2).
    dock.style.left = `${aRect.left + 12}px`;
    dock.style.top  = `${aRect.top + topOffset}px`;
    dock.style.visibility = dockHovered ? 'visible' : 'hidden';
  }

  function getOrCreateShortsDock() {
    let dock = document.getElementById(SHORTS_DOCK_ID);
    if (dock && dock.isConnected) {
      updateShortsDockPosition();
      return dock;
    }
    dock = document.createElement('div');
    dock.id = SHORTS_DOCK_ID;
    // Stack вертикально: SC-pill сверху, speed-pill снизу. Юзер просил
    // именно этот порядок и для shorts, и для watch — две строчки.
    dock.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      z-index: 60;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 6px;
      pointer-events: auto;
      visibility: hidden;
    `;
    document.body.appendChild(dock);
    updateShortsDockPosition();
    return dock;
  }

  // ─────────── Shorts speed-control ───────────
  //
  // На /shorts/ YouTube не даёт менять скорость через UI вообще. Делаем
  // свой control: 3 inline-кнопки (−, X.Xx, +) внутри #left-controls
  // после volume-controls. Шаг 0.1, диапазон 0.1..4.0.
  //
  // Sticky-логика:
  //   • При свайпе на следующий шорт YouTube переинициализирует
  //     <video.html5-main-video>. Слушаем 'loadedmetadata' в capture-фазе
  //     (media-events не bubble) и пере-применяем сохранённую скорость.
  //   • При F5 init() читает chrome.storage.local и применяет на первый
  //     loadedmetadata.
  //   • Pause не сбрасывает playbackRate — YouTube сохраняет его на
  //     <video>; восстанавливать не нужно.

  // ОБЩИЙ ключ для shorts и /watch — пользователь хочет единое значение
  // скорости для обеих площадок (по запросу). Старый ключ
  // __sc_yt_speed_shorts больше не используется; миграция при первом
  // loadShortsSpeed (если в local лежит старый — читаем).
  const SPEED_KEY = '__sc_yt_speed';
  const SPEED_KEY_LEGACY = '__sc_yt_speed_shorts';
  const SHORTS_SPEED_MIN = 0.1;
  const SHORTS_SPEED_MAX = 4.0;
  const SHORTS_SPEED_STEP = 0.1;
  const SHORTS_SPEED_DEFAULT = 1.0;
  const SHORTS_SPEED_PILL_ID = 'sc-yt-shorts-speed'; // оставлен для совместимости — это id pill-узла, не storage-ключа

  let shortsSpeed = SHORTS_SPEED_DEFAULT; // in-memory cache, source of truth = storage

  function clampSpeed(x) {
    if (!Number.isFinite(x)) return SHORTS_SPEED_DEFAULT;
    return Math.max(SHORTS_SPEED_MIN, Math.min(SHORTS_SPEED_MAX, x));
  }
  function roundSpeed(x) {
    // Один знак после точки. Без этого 1.0 + 0.1 = 1.0999999…, отображение врёт.
    return Math.round(x * 10) / 10;
  }
  function formatSpeed(x) {
    return roundSpeed(x).toFixed(1) + 'x';
  }

  function loadShortsSpeed() {
    return new Promise(resolve => {
      try {
        chrome.storage.local.get({ [SPEED_KEY]: null, [SPEED_KEY_LEGACY]: null }, raw => {
          let v = parseFloat(raw[SPEED_KEY]);
          if (!Number.isFinite(v)) v = parseFloat(raw[SPEED_KEY_LEGACY]);
          if (!Number.isFinite(v)) v = SHORTS_SPEED_DEFAULT;
          shortsSpeed = roundSpeed(clampSpeed(v));
          resolve(shortsSpeed);
        });
      } catch { resolve(shortsSpeed); }
    });
  }
  function saveShortsSpeed(v) {
    shortsSpeed = roundSpeed(clampSpeed(v));
    try {
      chrome.storage.local.set({ [SPEED_KEY]: shortsSpeed });
    } catch {}
  }

  function findShortsVideo() {
    // Активный <video> shorts'а — внутри ytd-reel-video-renderer.
    // На /shorts/ может быть несколько reel-renderer'ов (prefetched соседи),
    // нам нужен ИГРАЮЩИЙ: у него !paused или хотя-бы readyState >= 2.
    const candidates = document.querySelectorAll('ytd-reel-video-renderer video.html5-main-video, ytd-reel-video-renderer video.video-stream');
    let best = null;
    for (const v of candidates) {
      if (!v.paused) return v;
      if (!best && v.readyState >= 2) best = v;
    }
    return best || candidates[0] || null;
  }

  function findWatchVideo() {
    // Активный <video> на /watch — единственный внутри #movie_player.
    return document.querySelector('#movie_player video.html5-main-video, #movie_player video.video-stream')
        || document.querySelector('ytd-watch-flexy video.html5-main-video, ytd-watch-flexy video.video-stream');
  }

  function applyShortsSpeed() {
    // На /shorts/: прямой <video>.playbackRate (нативного speed-меню нет).
    const v = findShortsVideo();
    if (!v) return false;
    try { v.playbackRate = shortsSpeed; return true; } catch { return false; }
  }

  function applyWatchSpeed() {
    // На /watch: предпочтительно через #movie_player.setPlaybackRate(rate)
    // — это YT-API метод, он же двигает значение в нативном меню «Скорость
    // воспроизведения». Fallback на <video>.playbackRate если API не отдан.
    const player = document.getElementById('movie_player');
    if (player && typeof player.setPlaybackRate === 'function') {
      try { player.setPlaybackRate(shortsSpeed); return true; } catch {}
    }
    const v = findWatchVideo();
    if (!v) return false;
    try { v.playbackRate = shortsSpeed; return true; } catch { return false; }
  }

  function applySpeedAuto() {
    if (location.pathname.startsWith('/shorts/')) return applyShortsSpeed();
    if (location.pathname.startsWith('/watch')) return applyWatchSpeed();
    return false;
  }

  function setShortsSpeed(rate) {
    saveShortsSpeed(rate);
    // applySpeedAuto возвращает false если <video>/player ещё не найден
    // (например клик по pill'у до того как плеер поднялся). Раньше результат
    // глотался молча — скорость в лейбле менялась, а на видео нет, без следа.
    // Логируем для детерминированной отладки; сама скорость переживёт —
    // loadedmetadata-listener (capture) применит сохранённое значение когда
    // <video> появится.
    const applied = applySpeedAuto();
    if (applied === false) {
      dbg('speed.apply.noop', { rate, path: location.pathname });
    }
    renderShortsSpeedPill();
  }

  function bumpShortsSpeed(delta) {
    setShortsSpeed(shortsSpeed + delta);
  }

  function renderShortsSpeedPill() {
    const wrap = document.getElementById(SHORTS_SPEED_PILL_ID);
    if (!wrap) return;
    const label = wrap.querySelector('[data-sc-speed-label]');
    if (label) label.textContent = formatSpeed(shortsSpeed);
  }

  function injectShortsSpeedPill() {
    // Speed-pill теперь живёт и на /shorts/, и на /watch (общее
    // хранилище скорости). Решение делать или нет — по pathname.
    const isShorts = location.pathname.startsWith('/shorts/');
    const isWatch  = location.pathname.startsWith('/watch');
    if (!isShorts && !isWatch) return;
    if (document.getElementById(SHORTS_SPEED_PILL_ID)) return;
    const host = getOrCreateShortsDock();
    if (!host) return;

    // Wrapper в форме pill'а: minus | label | plus. Высота min-height:32px
    // выровнена со sc-pill — единая линия. Тёмный фон, скруглённые края,
    // совпадает по стилю.
    const wrap = document.createElement('div');
    wrap.id = SHORTS_SPEED_PILL_ID;
    wrap.style.cssText = `
      display: inline-flex;
      align-items: center;
      gap: 2px;
      height: 36px;
      min-height: 36px;
      box-sizing: border-box;
      padding: 2px;
      border-radius: 18px;
      background: rgba(20, 20, 24, 0.88);
      border: 1px solid rgba(102, 126, 234, 0.55);
      color: #e9ecef;
      font: 500 13px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      backdrop-filter: blur(6px);
      pointer-events: auto;
      user-select: none;
      vertical-align: middle;
      box-shadow: 0 2px 6px rgba(0,0,0,0.35);
    `;

    const mkBtn = (text, title, onClick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.title = title;
      b.style.cssText = `
        min-width: 30px;
        height: 30px;
        padding: 0 8px;
        border-radius: 15px;
        border: none;
        background: transparent;
        color: inherit;
        font: inherit;
        cursor: pointer;
        line-height: 1;
      `;
      b.addEventListener('mouseenter', () => { b.style.background = 'rgba(255,255,255,0.10)'; });
      b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; });
      // Глушим mousedown/click чтобы YouTube не словил это как клик по плееру
      // (на /shorts/ клик по плееру = pause).
      b.addEventListener('mousedown', e => e.stopPropagation());
      b.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      });
      return b;
    };

    const minus = mkBtn('−', 'Уменьшить скорость на 0.1', () => bumpShortsSpeed(-SHORTS_SPEED_STEP));
    const label = document.createElement('span');
    label.dataset.scSpeedLabel = '1';
    label.style.cssText = 'min-width:38px;text-align:center;padding:0 2px;font-variant-numeric:tabular-nums;';
    label.textContent = formatSpeed(shortsSpeed);
    // Клик по label сбрасывает на 1.0 — приятный shortcut.
    label.style.cursor = 'pointer';
    label.title = 'Сбросить в 1.0x';
    label.addEventListener('mousedown', e => e.stopPropagation());
    label.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      setShortsSpeed(SHORTS_SPEED_DEFAULT);
    });
    const plus = mkBtn('+', 'Увеличить скорость на 0.1', () => bumpShortsSpeed(SHORTS_SPEED_STEP));

    wrap.append(minus, label, plus);
    host.appendChild(wrap);
  }

  // ─────────── /watch + /shorts FAB ───────────

  // На watch-странице кнопка живёт ПОВЕРХ плеера, в верхней части справа
  // от Яндекс-чипа «Пересказать» (он же сидит сверху-слева плеера). Якорь
  // — `#movie_player` (главный контейнер плеера). Ставим absolute-позицию
  // относительно него, поэтому ему нужен `position: relative` (он уже
  // такой по дефолту, но проверяем на всякий случай).
  //
  // На /shorts/ — другой DOM: плеер сидит в `ytd-reel-video-renderer
  // #player-container` (узкая колонка по центру). В правом-верху уже
  // YouTube'овские Play+Mute (~78x78px) и CC+меню+fullscreen, в правом-низу
  // — лайки/комменты/ремикс. Свободный угол — **левый-верх**. FAB ставим
  // там. Видимость dock'а (sc-pill + speed-pill) — hover-gated через
  // JS-флаг dockHovered (см. bindDockHover / updateShortsDockPosition),
  // НЕ через CSS — dock это position:fixed сосед body, не потомок плеера.
  function injectWatchFab() {
    const isWatch  = location.pathname.startsWith('/watch');
    const isShorts = location.pathname.startsWith('/shorts/');
    if (!isWatch && !isShorts) return;

    const url = extractWatchUrl(location.href);
    if (!url) return;
    if (document.getElementById('sc-yt-fab')) return;

    // И на /shorts/, и на /watch — общий sc-dock с двумя строчками pill'ов.
    // SC-pill теперь split-button: copy (левая) | ai (правая). Юзер выбирает
    // прямо на клик, без global toggle в popup'е.
    const dock = getOrCreateShortsDock();
    if (!dock) return;

    const videoId = extractVideoId(location.href) || '';
    const wrap = makeSplitPill(videoId, url, { variant: 'dock' });
    wrap.id = 'sc-yt-fab';
    // SC-pill СВЕРХУ (первая строка), speed-pill снизу. Dock — column-flex.
    // Prepend гарантирует SC первой, даже если speed-pill уже инжектнута.
    dock.prepend(wrap);
    renderFabFromState();
    // Привязываем hover-листенеры к dock'у + текущему якорю плеера.
    bindDockHover();
  }

  function renderFabFromState() {
    const fab = document.getElementById('sc-yt-fab');
    if (!fab) return;
    const vid = fab.dataset.videoId;
    const entry = vid ? videoStateMap.get(vid) : null;
    paintPill(fab, entry?.state || 'idle', {
      error: entry?.error,
      engine: entry?.engine,
      autoAistudio: entry?.autoAistudio != null ? entry.autoAistudio : ytSettings.auto_aistudio,
    });
  }

  // ─────────── Wireup ───────────

  async function init() {
    injectGlobalCss();
    injectToastCss();
    // Грузим настройки до первого рендера, чтобы маркер «sc · AI» / «sc»
    // появлялся уже правильным, а не моргал после ре-рендера.
    await loadYoutubeSettings();
    // Reload расширения: сметаем все старые кнопки/инжект-метки старых
    // схем (thumb-anchor, card-direct и т.п.) — пилюля теперь singleton.
    for (const old of document.querySelectorAll('[data-sc-yt-btn="1"]')) old.remove();
    // Cmd-row живёт в document.body отдельно от pill'а — чистим тоже,
    // иначе после reload останутся osирые ряды.
    for (const old of document.querySelectorAll('[data-sc-cmd-row="1"]')) old.remove();
    for (const c of document.querySelectorAll('[data-sc-injected="1"]')) delete c.dataset.scInjected;

    // Singleton-pill в #video-preview-container + hover-delegation на body.
    // Если #video-preview-container ещё не создан YouTube'ом —
    // installCardHoverDelegation попробует создать pill при первом hover'е
    // карточки (когда YouTube гарантированно поднимает inline-preview-плеер).
    dbg('init.start', { url: location.href });
    // Зеркало SW-логов в наш DOM-sink, чтобы из MCP можно было прочитать
    // их без userScripts toggle. SW пишет в chrome.storage.local['__sc_bg_dbg'],
    // мы поллим storage и дописываем новые строки в #sc-yt-dbg-log.
    let lastBgDbgIdx = 0;
    setInterval(() => {
      try {
        chrome.storage.local.get(['__sc_bg_dbg'], (raw) => {
          const buf = Array.isArray(raw?.__sc_bg_dbg) ? raw.__sc_bg_dbg : [];
          if (buf.length === 0) return;
          for (let i = lastBgDbgIdx; i < buf.length; i++) {
            dbg('bg', buf[i]);
          }
          lastBgDbgIdx = buf.length;
        });
      } catch {}
    }, 1500);
    getOrCreateSingletonPill();
    installCardHoverDelegation();
    installCmdListeners();
    installSpeedShortcuts();
    getOrCreateToastHost();
    dbg('init.done');
    // Per-card pill'ы для рекомендаций (правая колонка /watch и т.п.)
    // и shorts-lockup карточек на канале /@<handle>/shorts.
    // Throttle через rAF чтобы не дёргать querySelectorAll на каждый mutation.
    console.log('[SC-YT-percard] init() — first injectPerCardPills call');
    injectPerCardPills();
    injectShortsLockupPills();
    let perCardRafScheduled = false;
    const perCardObserver = new MutationObserver(() => {
      if (perCardRafScheduled) return;
      perCardRafScheduled = true;
      requestAnimationFrame(() => {
        perCardRafScheduled = false;
        injectPerCardPills();
        injectShortsLockupPills();
        // На /shorts/ DOM controls собирается асинхронно после navigate.
        // Если #left-controls появился позже init/yt-navigate-finish,
        // инжектим speed-pill сейчас. Дешёвый no-op если уже на месте
        // (injectShortsSpeedPill сам проверяет существование).
        if (location.pathname.startsWith('/shorts/')) injectShortsSpeedPill();
      });
    });
    perCardObserver.observe(document.body, { childList: true, subtree: true });

    // Shorts speed-control: грузим persist'нутую скорость, инжектим pill
    // ПЕРВОЙ (она в dock'е будет слева). Затем FAB — справа от speed.
    // Order в скрине юзера: [−1.0x+] [⬇sc].
    await loadShortsSpeed();
    injectShortsSpeedPill();
    injectWatchFab();
    document.addEventListener('loadedmetadata', e => {
      const t = e.target;
      if (!t || !t.matches || !t.matches('video.html5-main-video, video.video-stream')) return;
      if (location.pathname.startsWith('/shorts/') || location.pathname.startsWith('/watch')) {
        // На /watch предпочитаем YT-API (нативное меню обновится).
        // Listener'ом сюда тоже попадаем — но ставить дважды не страшно.
        try { t.playbackRate = shortsSpeed; } catch {}
      }
    }, true);
    // Если video уже играет к моменту init(), сразу применим скорость.
    applySpeedAuto();

    // Repeat-positioning: на F5 активный reel имеет bbox=0 какое-то время
    // (Polymer лениво поднимает layout). RAF-poller вызывает
    // updateShortsDockPosition + пере-инжектит pill'ы + bindDockHover пока
    // якорь не получит layout. Stop через 5 секунд.
    window.addEventListener('resize', updateShortsDockPosition);
    window.addEventListener('scroll', updateShortsDockPosition, { passive: true });
    let pollerStartedAt = performance.now();
    let pollerActive = true;
    const pollerStep = () => {
      if (!pollerActive) return;
      const onPlayerPage = location.pathname.startsWith('/shorts/') || location.pathname.startsWith('/watch');
      if (onPlayerPage) {
        if (!document.getElementById(SHORTS_SPEED_PILL_ID)) injectShortsSpeedPill();
        if (!document.getElementById('sc-yt-fab')) injectWatchFab();
        updateShortsDockPosition();
        bindDockHover();
        // Stop-условие — ГОТОВНОСТЬ ЯКОРЯ (bbox > 0), НЕ видимость dock'а.
        // dock теперь hover-gated (BUG#2): visibility='visible' только при
        // hover'е, так что старое условие `visibility==='visible'` крутило бы
        // poller полные 5с каждую навигацию. Как только у якоря есть layout —
        // координаты пересчитаны, листенеры привязаны, дальше держит
        // resize/scroll + pointerenter.
        const anchor = findDockAnchor();
        if (anchor) {
          const r = anchor.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) { pollerActive = false; return; }
        }
      }
      if (performance.now() - pollerStartedAt > 5000) { pollerActive = false; return; }
      requestAnimationFrame(pollerStep);
    };
    requestAnimationFrame(pollerStep);

    // SPA-навигация на YouTube эмитит yt-navigate-finish — это самый
    // надёжный сигнал что URL и main DOM сменились (push-state у YouTube
    // довольно безмолвный для observer'а на body root).
    window.addEventListener('yt-navigate-finish', () => {
      // FAB пересоздаём ВСЕГДА — даже если URL не сменился, потому что
      // YouTube может переинициализировать #movie_player при смене качества/
      // аудио-дорожки или при переходе на тоже видео из рекомендации
      // (refresh плеера). Старый FAB остаётся в detached DOM, новый плеер
      // без кнопки. Поэтому удаляем безусловно если узел плеера сменился.
      // Между /shorts/<id1> ↔ /shorts/<id2> SPA-переходы то же самое:
      // ytd-reel-video-renderer пересобирается, FAB надо пересоздать.
      const oldFab = document.getElementById('sc-yt-fab');
      const cur = extractVideoId(location.href);
      const isShortsNow = location.pathname.startsWith('/shorts/');
      const isWatchNow  = location.pathname.startsWith('/watch');
      // FAB теперь живёт в общем sc-dock'е (и для shorts, и для watch).
      // Удаляем если URL сменился (videoId != cur) или пагинация ушла со страницы плеера.
      if (oldFab) {
        if ((!isWatchNow && !isShortsNow) || oldFab.dataset.videoId !== cur) {
          oldFab.remove();
        }
      }

      // Singleton-pill: проверяем что pill всё ещё в живом контейнере.
      // YouTube может пересоздать #video-preview-container при переходе
      // / → /watch и обратно — pill останется detached, всё что после
      // этого setVideoState запишет в Map визуально не отразится до
      // следующего hover'а карточки.
      const pill = document.getElementById(PILL_ID);
      if (!pill || !pill.isConnected
          || !pill.closest('#video-preview-container, ytd-video-preview')) {
        if (pill) pill.remove();
        getOrCreateSingletonPill();
      }

      // Reset hover-sentinel: __sc_lastHoveredVideoId хранит последний
      // увиденный videoId. После SPA-навигации DOM полностью обновлён,
      // тот же hover-event на ту же карточку с тем же видео должен
      // снова обновить pill (контейнер preview пересоздан / пуст).
      __sc_lastHoveredVideoId = null;

      // Per-card pill'ы могут потеряться при смене /watch (рекомендации
      // полностью переинъекчиваются Angular-renderer'ом). Перепрогоним.
      injectPerCardPills();
      injectShortsLockupPills();

      // Shorts speed-pill: между /shorts/<id1> ↔ /shorts/<id2> dock
      // пересобирается (т.к. #player-container внутри ytd-reel-video-renderer
      // переинициализируется). Удалим detached'ы и пере-инжектим pill'ы
      // в правильном порядке: speed первой (слева), FAB вторым (справа).
      // Скорость — из in-memory кэша (он не теряется между переходами).
      const oldSpeed = document.getElementById(SHORTS_SPEED_PILL_ID);
      if (oldSpeed && (!oldSpeed.isConnected || !oldSpeed.closest('#' + SHORTS_DOCK_ID))) {
        oldSpeed.remove();
      }
      // Все dock'и, которые не в активном reel-renderer'е — удалить.
      // Это покрывает свайп между шортами: dock переходит из старого
      // reel'а в новый (старый детачится Polymer'ом).
      const activeReel = location.pathname.startsWith('/shorts/') ? findActiveReelRenderer() : null;
      for (const stale of document.querySelectorAll('#' + SHORTS_DOCK_ID)) {
        if (!stale.isConnected || stale.parentElement !== activeReel) stale.remove();
      }
      injectShortsSpeedPill();
      injectWatchFab();
      // Новый плеер = ещё не наведён. Сбрасываем hover-флаг чтобы свежий
      // dock стартовал скрытым (а не унаследовал visible от прошлой
      // страницы), и привязываем pointer-листенеры к новому якорю/dock'у.
      if (dockHideTimer) { clearTimeout(dockHideTimer); dockHideTimer = null; }
      dockHovered = false;
      updateShortsDockPosition();
      bindDockHover();
      // Пере-применить на видимый <video>: при SPA-переходе loadedmetadata
      // мог уже отгреметь до того как content-script был готов.
      applySpeedAuto();
      if (location.pathname.startsWith('/shorts/') || location.pathname.startsWith('/watch')) {
        // Перезапустим poller — после yt-navigate-finish bbox якоря
        // тоже может быть 0 ещё какое-то время (особенно на /shorts/).
        pollerStartedAt = performance.now();
        if (!pollerActive) {
          pollerActive = true;
          requestAnimationFrame(pollerStep);
        }
      }
    });

    // chrome.storage.sync.onChanged эмитит во всех вкладках — обновляем
    // кэш и подписи. Это покрывает «юзер перещёлкнул toggle в popup'е»
    // без F5 на каждой YouTube-вкладке.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      if (!changes.__yt) return;
      ytSettings = sanitizeYoutubeSettings(changes.__yt.newValue || {});
      refreshAllButtons(ytSettings.auto_aistudio);
    });

    // Background tracker присылает state-update'ы:
    //   { __sc_btn_state, videoId, state, engine?, error? }
    // Пишем в stateMap по videoId. Pill (если сейчас под этим видео) и
    // тост перерисуются автоматически.
    //
    // Гард на visibility: background сам адресует активную visible
    // youtube-вкладку, но дополнительно дропаем event на странице, если
    // вкладка скрыта (race: tab активной была в момент chrome.tabs.query,
    // юзер успел переключиться до доставки sendMessage). Юзер увидит
    // только последующие event'ы — старые не реплеим.
    chrome.runtime.onMessage.addListener((req) => {
      if (!req || req.__sc_btn_state !== true) return;
      const vid = req.videoId;
      if (!vid) return;
      // Терминальные «успех» события (`pasted`, `done`) НЕ дропаем —
      // юзер мог сейчас сидеть на AI Studio'е, YT-вкладка в фоне; когда
      // он вернётся, должен увидеть финал «Вставлено в Gemini Studio».
      // Промежуточные состояния (`searching`/`transcribing`/`opening`)
      // на скрытой вкладке смысла не имеют — они быстро устаревают.
      const persistOnHidden = (req.state === 'pasted' || req.state === 'done');
      if (document.visibilityState !== 'visible' && !persistOnHidden) return;
      setVideoState(vid, req.state, { engine: req.engine, error: req.error, title: req.title });
    });

    // На возврат на вкладку — выкидываем «протухшие» done/error из
    // stateMap, чтобы пользователь не видел тосты о jobах, которые
    // завершились пока он был на другой вкладке (по запросу: «новые
    // только»). Активные state'ы (sending/searching/transcribing/opening)
    // оставляем — это идущая работа, она и должна быть видна.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      let touched = false;
      for (const [vid, e] of videoStateMap) {
        if (e.state === 'done' || e.state === 'error') {
          // «Готово» / «Ошибка» — стираем при возврате (они не несут
          // ценной информации в момент возврата, юзер уже знает что
          // job завершился; новый он начинать будет с idle).
          videoStateMap.delete(vid);
          const t = stateTimers.get(vid);
          if (t) { clearTimeout(t); stateTimers.delete(vid); }
          touched = true;
        } else if (e.state === 'pasted' && !stateTimers.has(vid)) {
          // 'pasted' дошёл пока вкладка была скрыта — TTL не запустился.
          // Сейчас юзер вернулся, видит тост — стартуем TTL чтобы он
          // через 4.5 сек исчез сам.
          const id = setTimeout(() => {
            stateTimers.delete(vid);
            videoStateMap.delete(vid);
            renderPillForCurrentVideo();
            renderToasts();
            renderFabFromState();
            renderPerCardFromState();
          }, 4500);
          stateTimers.set(vid, id);
          touched = true;
        }
      }
      if (touched) {
        renderToasts();
        renderPillForCurrentVideo();
        renderFabFromState();
        renderPerCardFromState();
      }
    });

    // /watch FAB — обновляем как обычно через paintPill (state из Map).
    // Background всё равно пишет в Map, оттуда подхватим при click handler'е.
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
