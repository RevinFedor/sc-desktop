// SC Browser Parser — единый DOM-API для Google AI Studio.
//
// Один модуль, который умеет всё что нужно при работе с aistudio.google.com/prompts/*:
//   - найти/переключить модель (Gemini 3.5 Flash, 3.1 Pro Preview, 3 Flash Preview, 3.1 Flash Lite,
//     Deep Research Preview / Max Preview)
//   - выключить Visualization toggle (и опционально другие переключатели в Settings panel)
//   - выставить System instruction preset (по имени)
//   - вставить промпт и нажать Run
//   - дождаться завершения генерации (Stop button исчез + появился Run обратно)
//   - выдрать текст последнего ответа (с фильтрацией thinking-блоков)
//
// API экспортируется в window.scAistudio — content-script aistudio-autoscrape.js
// и обработчики mcp_aistudio_* в background.js используют этот же интерфейс,
// чтобы не дублировать селекторы и DOM-логику. ВСЕ подключения идут через
// manifest content_scripts (этот файл стоит ПЕРЕД aistudio-autoscrape.js).
//
// Whitelist моделей хранится в KNOWN_MODELS — это короткий список того, что
// юзер реально хочет дергать. ID модели резолвится по двум источникам:
//   1) URL ?model=<id> на странице new_chat (Studio сам ставит при выборе)
//   2) data-test-id / textContent / .title карточки модели в DOM
//
// Никаких overlay'ев / тостов / IPC в этом файле — он чисто-функциональный
// API над DOM'ом. Все user-visible эффекты (overlay autoscrape, toast'ы)
// живут в caller-файлах.

(function () {
  'use strict';

  // Защита от двойного подключения. manifest подключает aistudio-core.js
  // в content_scripts вместе с aistudio-autoscrape.js — если расширение
  // reload'нулось пока вкладка жива, второй прогон не должен переписать
  // объект (там могут жить in-flight job'ы).
  if (window.scAistudio) return;

  const TAG = '[SC-AIST-CORE]';
  // Persistent log в bridge: aistudio-mcp.js устанавливает window.__scAistudioJobId
  // в начале runJob; core читает его чтобы привязать свои логи к тому же jobId.
  // SW-relay через chrome.runtime.sendMessage({__sc_log}) (см. background.js).
  const log = (msg, data) => {
    try { console.log(TAG, msg, data || ''); } catch {}
    try {
      chrome.runtime.sendMessage({
        __sc_log: true,
        id: window.__scAistudioJobId || '-',
        tag: 'aistudio.core.' + msg,
        url: location.href.slice(0, 160),
        data: (data && typeof data === 'object') ? data : (data == null ? undefined : { v: String(data).slice(0, 200) }),
      }).catch(() => {});
    } catch {}
  };

  // ── Известные модели ──────────────────────────────────────────────────
  //
  // `id` — то, что AI Studio кладёт в URL ?model=… и что на карточке выводит
  // вторым subtitle'ом (под title'ом). Юзер выбирал именно эти модели — их
  // 5 (4 Gemini + 2 Deep Research). Anti-gravity намеренно не включён сюда:
  // юзер сказал «пока похуй, потом отдельно».
  //
  // Default для MCP-tool'а — 'gemini-3.1-pro-preview' (SOTA reasoning, юзер
  // явно назвал его дефолтом). aistudio-autoscrape.js передаёт modelTitle
  // отдельно и default не использует.
  // ДВА КЛАССА МОДЕЛЕЙ (доказано net-tap'ом, см. fact-aistudio-mcp.md::Два класса):
  //   • ОДНОФАЗНЫЕ (GenerateContent): Pro / Flash / Flash-Lite. Один backend-
  //     запрос с промптом внутри, один ответ. `isInteractionApi:false`.
  //   • ДВУХФАЗНЫЕ (Interactions API): Deep Research / Antigravity. Submit =
  //     CreateInteraction (поднять агентскую сессию + Linux-песочницу, БЕЗ
  //     промпта) → CreatePrompt/GetInteractionStream (промпт отдельным шагом).
  //     `isInteractionApi:true`. Эти модели: (а) на первом submit в фоне
  //     открывают окно paid-key, (б) долгие multi-step (нужен большой timeout),
  //     (в) если paid-key-окно перехватило первый Run — промпт надо отправить
  //     вторым сообщением после подъёма сессии (см. submitPromptAsNewMessage).
  const KNOWN_MODELS = [
    {
      id: 'gemini-3.1-pro-preview',
      title: 'Gemini 3.1 Pro Preview',
      alias: ['gemini-3.1-pro', '3.1-pro', 'pro'],
      isDeepResearch: false,
      isInteractionApi: false,
    },
    {
      id: 'gemini-3.5-flash',
      title: 'Gemini 3.5 Flash',
      alias: ['3.5-flash', 'flash'],
      isDeepResearch: false,
      isInteractionApi: false,
    },
    {
      id: 'gemini-3-flash-preview',
      title: 'Gemini 3 Flash Preview',
      alias: ['3-flash', '3-flash-preview'],
      isDeepResearch: false,
      isInteractionApi: false,
    },
    {
      id: 'gemini-3.1-flash-lite',
      title: 'Gemini 3.1 Flash Lite',
      alias: ['flash-lite', '3.1-flash-lite'],
      isDeepResearch: false,
      isInteractionApi: false,
    },
    {
      id: 'deep-research-preview-04-2026',
      title: 'Deep Research Preview (Apr-21-2026)',
      alias: ['deep-research', 'dr', 'deep-research-preview'],
      isDeepResearch: true,
      isInteractionApi: true,
    },
    {
      id: 'deep-research-max-preview-04-2026',
      title: 'Deep Research Max Preview (Apr-21-2026)',
      alias: ['deep-research-max', 'dr-max', 'deep-research-max-preview'],
      isDeepResearch: true,
      isInteractionApi: true,
    },
    {
      // Antigravity Preview — general-purpose autonomous agent в remote Linux env.
      // Двухфазный (Interactions API), как Deep Research. Парсинг истории живёт
      // в aistudio-export.js — Agent-роль в `ms-chat-turn` обрабатывается тем же кодом
      // что и Model.
      id: 'antigravity-preview-05-2026',
      title: 'Antigravity Agent Preview',
      alias: ['antigravity', 'antigravity-agent', 'agent', 'ag'],
      isDeepResearch: false,
      isAgent: true,
      isInteractionApi: true,
    },
  ];

  // Resolve пользовательский input → известная модель. Принимает id, title,
  // alias, или хвост c "preview". Если ничего не подошло — возвращает null
  // (caller должен throw'нуть, не угадывать дальше).
  function resolveModel(input) {
    if (!input) return null;
    const s = String(input).toLowerCase().trim();
    for (const m of KNOWN_MODELS) {
      if (m.id.toLowerCase() === s) return m;
      if (m.title.toLowerCase() === s) return m;
      if (m.alias.some(a => a.toLowerCase() === s)) return m;
    }
    // Substring match — пользователь мог дать "3.1 pro" / "Deep Research Max"
    for (const m of KNOWN_MODELS) {
      if (m.id.toLowerCase().includes(s) || m.title.toLowerCase().includes(s)) return m;
    }
    return null;
  }

  // ── helpers ───────────────────────────────────────────────────────────

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function waitFor(predicate, why, timeoutMs = 15000, intervalMs = 200) {
    const t0 = performance.now();
    while (true) {
      let v;
      try { v = predicate(); } catch (e) { v = null; }
      if (v) return v;
      if (performance.now() - t0 > timeoutMs) {
        throw new Error('timeout: ' + why);
      }
      await sleep(intervalMs);
    }
  }

  // Native React/Angular value setter — нужен и для textarea, и для contenteditable.
  function setReactValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Сколько User-turn'ов сейчас в чате. ВАЖНО: атрибут `data-turn-role` висит
  // на ДОЧЕРНЕМ элементе внутри ms-chat-turn, НЕ на самом ms-chat-turn
  // (проверено DOM-probe: ms-chat-turn[data-turn-role] всегда 0). Поэтому
  // ищем по дочернему [data-turn-role="User"]. Это единственный надёжный
  // сигнал «промпт реально отправлен как сообщение» — на нём строится
  // двухфазный submit агента/DR (Interactions API).
  function countUserTurns() {
    return document.querySelectorAll('ms-chat-turn [data-turn-role="User"]').length;
  }
  // Кнопки Run/Stop в композере (live-поиск, Angular пересоздаёт узлы).
  function findRunBtn() {
    return Array.from(document.querySelectorAll('button'))
      .find(b => /Run/.test(b.textContent || '') && /keyboard_return/.test(b.textContent || '') && b.offsetParent);
  }
  function findStopBtn() {
    return Array.from(document.querySelectorAll('button'))
      .find(b => /Stop/.test(b.textContent || '') && b.offsetParent);
  }
  function findPromptTextarea() {
    return Array.from(document.querySelectorAll('textarea'))
      .find(t => /typing a prompt/i.test(t.placeholder || ''));
  }

  // Является ли href «шумовой» UI-ссылкой (нав AI Studio, gstatic, доки) —
  // её НЕ кладём в links. ВАЖНО: grounding-источники Gemini идут через
  // `vertexaisearch.cloud.google.com/grounding-api-redirect/...` — это хост
  // *.google.com, но это РЕАЛЬНЫЙ источник, не шум. Старый фильтр
  // `hostname.includes('google.com')` резал их вместе с навигацией →
  // result.links оставался пустым/мусорным (только «Learn more»). Теперь:
  // редирект-ссылки grounding'а пропускаем, а точечную UI-навигацию режем.
  function isNoiseLink(href) {
    let u;
    try { u = new URL(href); } catch { return true; }
    if (!href || href.startsWith('javascript:') || href.startsWith('chrome')) return true;
    // grounding-источник — ПРОПУСКАЕМ (это то что юзер и хочет видеть).
    if (/grounding-api-redirect|vertexaisearch/i.test(href)) return false;
    // UI-навигация AI Studio / ассеты / доки — шум.
    const NOISE = ['aistudio.google.com', 'gstatic.com', 'policies.google.com',
                   'support.google.com', 'accounts.google.com', 'ai.google.dev',
                   'myaccount.google.com', 'youtube.com/redirect'];
    if (NOISE.some(h => u.hostname.includes(h) || (u.hostname + u.pathname).includes(h))) return true;
    return false;
  }

  // ── Settings panel ────────────────────────────────────────────────────
  //
  // На /prompts/new_chat правая колонка с Settings (toggles + tools) обычно
  // уже открыта. Но если юзер её свернул через X — нужно открыть обратно
  // прежде чем искать toggles. Триггер — кнопка с textContent "settings Settings"
  // в trigger-button menu-trigger. Класс одинаковый между моделями.
  //
  // Идемпотентно: если панель уже открыта, проверяем через наличие toggle'ов
  // и сразу возвращаем.
  async function ensureSettingsPanelOpen() {
    // Toggle'ы видны только когда панель раскрыта.
    const probe = document.querySelector('button[role="switch"][aria-label="Visualization"]');
    if (probe) return;

    // Иначе ищем trigger и кликаем.
    const triggers = Array.from(document.querySelectorAll('button.trigger-button, button[class*=settings]'));
    const settingsBtn = triggers.find(b => /settings/i.test(b.textContent || ''));
    if (settingsBtn) {
      settingsBtn.click();
      await waitFor(
        () => document.querySelector('button[role="switch"][aria-label="Visualization"]'),
        'settings-panel-opened',
        5000,
      );
    }
    // Если settings-button тоже не нашли — Studio может быть на необычном
    // экране (например, project-settings, не /prompts/...). Толку throw'ить
    // нет, просто log и идём дальше — caller увидит «toggle not found».
  }

  // Выключить Visualization toggle (если включён). Идемпотентно.
  //
  // Зачем: Deep Research модели в Visualization-режиме отдают результат
  // как интерактивную diagram-визуализацию, а не как plain markdown в
  // ms-text-chunk. Парсер не умеет читать VizML — нам нужен текстовый ответ.
  //
  // ВАЖНО: toggle есть ТОЛЬКО у Deep Research моделей (обычной и Max).
  // У Flash/Pro его в DOM нет вообще. Чтобы не открывать Settings panel
  // зря и не ждать timeout на каждый Flash-job — пропускаем эту фазу для
  // не-DR моделей. Caller (aistudio-mcp / autoscrape) знает isDeepResearch
  // из resolveModel и должен передать его сюда.
  //
  // Other settings (Code execution, Grounding with Google Search, etc.) пока
  // НЕ трогаем. extraTogglesOff в API оставлен для будущего расширения —
  // если когда-нибудь юзер скажет «выключай ещё и X» — добавляешь в массив,
  // селекторы те же.
  async function ensureVisualizationOff(opts = {}) {
    const { isDeepResearch = null } = opts;
    if (isDeepResearch === false) {
      log('visualization step skipped — non-DR model has no toggle');
      return false;
    }
    // Если caller не передал явный флаг, делаем soft probe: ищем toggle
    // БЕЗ открытия панели. На вкладках где Settings уже открыт (типичный
    // /prompts/new_chat) DR-toggle сразу видим. На Flash/Pro его нет —
    // пропускаем без timeout'а.
    let toggle = document.querySelector('button[role="switch"][aria-label="Visualization"]');
    if (!toggle && isDeepResearch === true) {
      // DR явно указано — стоит попробовать открыть Settings panel.
      await ensureSettingsPanelOpen();
      toggle = document.querySelector('button[role="switch"][aria-label="Visualization"]');
    }
    if (!toggle) {
      log('visualization toggle not present — skipping');
      return false;
    }
    if (toggle.getAttribute('aria-checked') === 'false') {
      log('visualization already off');
      return true;
    }
    toggle.click();
    await waitFor(
      () => toggle.getAttribute('aria-checked') === 'false',
      'visualization-toggled-off',
      3000,
    );
    log('visualization → off');
    return true;
  }

  // ── Model selector ────────────────────────────────────────────────────
  //
  // Card.querySelector('.title') возвращает короткое имя ("Deep Research Max Preview (Apr-21-2026)").
  // Card.querySelector('.subtitle') возвращает id-строку ("deep-research-max-preview-04-2026").
  // Совпадение проверяем по subtitle (id точнее, чем title с датой).
  async function ensureModel(modelInput) {
    const model = resolveModel(modelInput);
    if (!model) {
      const known = KNOWN_MODELS.map(m => `${m.title} (${m.id})`).join(', ');
      throw new Error(`unknown model "${modelInput}". Known: ${known}`);
    }

    const card = await waitFor(
      () => document.querySelector('button.model-selector-card'),
      'model-selector-card',
      15000,
    );

    // Card.subtitle = id; card.title = human title. Сравниваем по subtitle.
    const curId = (card.querySelector('.subtitle')?.textContent || '').trim();
    if (curId === model.id) {
      log('model already selected', { id: model.id });
      return model;
    }

    log('switching model', { from: curId, to: model.id });
    card.click();

    // Открылся dropdown ("Model selection"). Studio запоминает последний
    // выбранный chip-filter (All / Featured / Gemini / Agents / Gemma…),
    // и при следующем открытии dropdown'а активен этот же фильтр. Если юзер
    // последний раз сидел в "Agents" — там нет нужных нам Gemini-моделей,
    // поиск проваливается. Решение: всегда явно тыкаем "All" chip, потом ищем.
    await sleep(300);
    await ensureAllChipSelected();

    // Studio чем дальше, тем больше моделей в списке — некоторые могут не
    // рендериться пока их не проскроллили (virtual list). Сначала просто
    // ищем в DOM, если не нашли — пытаемся через search input + scroll.
    const findOption = () => {
      const els = Array.from(document.querySelectorAll(
        'button, mat-list-item, [role="option"], ms-model-option, .model-option'
      ));
      for (const el of els) {
        const subId = (el.querySelector('.subtitle')?.textContent || '').trim();
        if (subId === model.id) return el;
      }
      // Fallback: textContent includes id
      for (const el of els) {
        if ((el.textContent || '').includes(model.id)) return el;
      }
      return null;
    };

    await waitFor(() => findOption() != null || document.querySelector('button, mat-list-item, [role="option"]'),
      'model-options-rendered', 5000);
    let target = findOption();

    if (!target) {
      // Не нашли по первичному скану — попробуем через search input
      // (он стоит сверху dropdown'а). Type model.id или model.title.
      const search = document.querySelector('input[placeholder*="Search" i], input[type="search"]');
      if (search) {
        log('model search input found, typing query', { query: model.title });
        setReactValue(search, model.title);
        await sleep(400);
        target = findOption();
        if (!target) {
          // Альтернативный query — поискать по id
          setReactValue(search, model.id);
          await sleep(400);
          target = findOption();
        }
      }
    }

    if (!target) {
      // Не нашли — закрываем dropdown и рапортуем юзеру какую модель он
      // хотел. Не paste'им в случайную текущую модель.
      try { document.body.click(); } catch {}
      throw new Error(`модель "${model.title}" (${model.id}) не найдена в списке`);
    }

    // Прокрутить в зону видимости — для virtualized списка элемент может
    // быть не materialized если за горизонтом; для не-virtualized — просто
    // эстетически ставим в центр.
    try { target.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch {}
    await sleep(100);

    target.click();
    await waitFor(
      () => (card.querySelector('.subtitle')?.textContent || '').trim() === model.id,
      'model-applied',
      5000,
    );
    return model;
  }

  // Studio Model-selection dropdown показывает chip-фильтр (All, Featured,
  // Gemini, Live, Images, Video, Audio, Music, Agents, Gemma…). Последний
  // выбранный фильтр персистится — если юзер сидел в "Agents", при следующем
  // открытии dropdown'а опять Agents. Это ломает поиск Gemini-моделей.
  // Гарантируем что активен "All" — все модели видны.
  async function ensureAllChipSelected() {
    // Ищем chip-кнопку с textContent "All". Studio рендерит chips как
    // <button> с .mdc-evolution-chip__action или просто `button` с текстом.
    const allChip = Array.from(document.querySelectorAll('button'))
      .find(b => (b.textContent || '').trim() === 'All' && b.offsetParent);
    if (!allChip) {
      log('all_chip.not_found — Studio UI changed?');
      return false;
    }
    // Active-маркер chips в Material: aria-pressed="true" или aria-selected,
    // либо .mdc-evolution-chip--selected.
    const isActive =
      allChip.getAttribute('aria-pressed') === 'true' ||
      allChip.getAttribute('aria-selected') === 'true' ||
      allChip.classList.contains('mdc-evolution-chip--selected') ||
      (allChip.closest('.mdc-evolution-chip')?.classList.contains('mdc-evolution-chip--selected'));
    if (isActive) {
      log('all_chip.already_selected');
      return true;
    }
    log('all_chip.clicking');
    try { allChip.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch {}
    allChip.click();
    // Дать DOM перерендериться после фильтра.
    await sleep(300);
    return true;
  }

  // ── System instructions ───────────────────────────────────────────────
  //
  // ПОЛНОЕ дублирование логики из aistudio-autoscrape.js — оставлено as-is
  // (с минорной корректировкой имени), чтобы автоскрап мог делегировать
  // сюда без поведенческих расхождений.
  //
  // presetName — имя сохранённого пресета (как в Title-input). Пустая строка
  // + skipIfEmpty:false означает «выбрать + Create new instruction» (reset).
  async function setSystemInstruction(presetName, { skipIfEmpty = true } = {}) {
    const wanted = (presetName || '').trim();
    if (!wanted && skipIfEmpty) {
      log('no preset name — skip system-instructions step');
      return;
    }
    const card = document.querySelector('[data-test-system-instructions-card], button.system-instructions-card');
    if (!card) throw new Error('System instructions card не найден');

    if (wanted) {
      const titleInputBefore = document.querySelector('input[placeholder="Title"]');
      if (titleInputBefore && (titleInputBefore.value || '').trim() === wanted) {
        log('preset already selected', { wanted });
        document.querySelector('button[aria-label="Close panel"]')?.click();
        return;
      }
    }

    card.click();
    const matSelect = await waitFor(() => {
      return Array.from(document.querySelectorAll('mat-select[role="combobox"]'))
        .find(el => el.offsetParent && !el.getAttribute('aria-label'));
    }, 'sys-instructions-preset-select', 5000);

    if (wanted) {
      const currentPresetText = matSelect.textContent?.trim() || '';
      if (currentPresetText === wanted) {
        log('preset already selected', { wanted });
        document.querySelector('button[aria-label="Close panel"]')?.click();
        await waitFor(
          () => !document.querySelector('button[aria-label="Close panel"]'),
          'panel-closed',
          3000,
        ).catch(() => {});
        return;
      }
    }

    matSelect.click();
    const options = await waitFor(() => {
      const all = Array.from(document.querySelectorAll('mat-option, [role="option"]'))
        .filter(el => el.offsetParent);
      return all.length ? all : null;
    }, 'sys-instructions-options', 5000);

    if (!wanted) {
      const createOpt = options.find(o => {
        const t = (o.textContent || '').replace(/\s+/g, ' ').trim();
        return /^\+\s*Create new instruction$/i.test(t);
      });
      if (!createOpt) {
        document.body.click();
        throw new Error('опция "+ Create new instruction" не найдена');
      }
      createOpt.click();
    } else {
      const matches = options.filter(o => o.textContent?.trim() === wanted);
      if (matches.length === 0) {
        document.body.click();
        const available = options
          .map(o => o.textContent?.trim())
          .filter(t => t && t !== '+ Create new instruction')
          .join(', ');
        throw new Error(`пресет "${wanted}" не найден. Доступные: ${available || '—'}`);
      }
      if (matches.length > 1) {
        document.body.click();
        throw new Error(`пресет "${wanted}" встречается ${matches.length} раз — переименуй дубли`);
      }
      matches[0].click();
    }

    document.querySelector('button[aria-label="Close panel"]')?.click();
    await waitFor(
      () => !document.querySelector('button[aria-label="Close panel"]'),
      'panel-closed',
      3000,
    ).catch(() => {});
  }

  // ── Paste prompt + Run ────────────────────────────────────────────────

  // MAIN-world click через SW. CS .click() из ISOLATED world может игнориться
  // если Angular считает event «not trusted» либо в frozen tab event-loop
  // вообще не дотягивает до handler'ов. SW делает chrome.scripting.executeScript
  // в MAIN-world с pointer-chain'ом (см. background.js::__sc_main_click).
  // См. docs/knowledge/fact-deep-research.md::Click strategy MAIN-world.
  async function mainWorldClick(el) {
    if (!el) return { ok: false, err: 'no element' };
    const markId = 'aist-' + Math.random().toString(36).slice(2, 10);
    try { el.setAttribute('data-sc-mw-click', markId); } catch {}
    try {
      // singleClick: true — Angular Material НЕ дебаунсит, второй .click()
      // даст двойной submit и дублированный stream (см. #77).
      const resp = await chrome.runtime.sendMessage({ __sc_main_click: true, markId, singleClick: true });
      log('mainWorldClick.resp', resp);
      return resp || { ok: false, err: 'no resp' };
    } catch (e) {
      log('mainWorldClick.err', { err: e?.message || String(e) });
      return { ok: false, err: e?.message || String(e) };
    } finally {
      try { el.removeAttribute('data-sc-mw-click'); } catch {}
    }
  }

  // TRUSTED click с transient user-activation — БЕЗ вывода вкладки на передний
  // план (работает в ФОНЕ).
  //
  // ЗАЧЕМ: AI Studio с апдейта нач.-2026 требует transient user-activation для
  // submit'а. Синтетический mainWorldClick (isTrusted=false) создаёт turn, но
  // backend отбивает запрос без activation мгновенным 500 "internal error".
  //
  // КАК: клик выполняется ВНУТРИ `chrome.debugger Runtime.evaluate` с
  // `userGesture:true` (SW-handler __sc_usergesture_click). CDP-eval с этим
  // флагом синтезирует transient activation ДАЖЕ в hidden/inactive вкладке —
  // доказано живьём (vis:hidden → ua:true, submit без error). Это лучше
  // Input.dispatchMouseEvent, который в фоне activation НЕ даёт (CDP issue #89,
  // требует active-таб) — раньше мы из-за этого фокусили окно, что выдёргивало
  // Яндекс поверх всех приложений и ломалось на конкурентных job'ах. Теперь
  // фокус НЕ нужен. См. fact-aistudio-mcp.md::user-activation.
  //
  // Вызывающий ОБЯЗАН снять hover-gate (CSS-pin) для hover-gated кнопок (Rerun),
  // иначе .click() внутри eval попадёт в disabled/occluded элемент. Помечаем
  // элемент data-sc-ug-click, SW кликает его через el.click() (HTMLElement.click
  // внутри userGesture-eval засчитывается как настоящий жест).
  async function trustedClick(el) {
    if (!el) return { ok: false, err: 'no element' };
    try { el.scrollIntoView({ block: 'center' }); } catch {}
    await sleep(120);
    const markId = 'ug-' + Math.random().toString(36).slice(2, 10);
    try { el.setAttribute('data-sc-ug-click', markId); } catch {}
    try {
      const resp = await chrome.runtime.sendMessage({
        __sc_usergesture_click: true,
        selector: '[data-sc-ug-click="' + markId + '"]',
        pickLast: false,
      });
      log('trustedClick.resp', { vis: document.visibilityState, resp });
      // resp.result.clicked === true → клик прошёл; ua → была ли активация
      const okClicked = !!(resp && resp.ok && resp.result && resp.result.clicked);
      return { ok: okClicked, ua: resp?.result?.ua, raw: resp };
    } catch (e) {
      log('trustedClick.err', { err: e?.message || String(e) });
      return { ok: false, err: e?.message || String(e) };
    } finally {
      try { el.removeAttribute('data-sc-ug-click'); } catch {}
    }
  }

  // ── Paid-API-key dialog handler ───────────────────────────────────────
  //
  // AI Studio иногда показывает диалог "Link a paid API key" при первом
  // открытии вкладки на сессии (после смены биллинг-статуса проекта или
  // после долгого idle). DOM: <mat-dialog-container> со строками
  // "Link a paid API key" + "Link API key" + кнопкой <button aria-label="Select key">.
  // Если не закрыть — Run-кнопка кликается, но запрос уходит в null-key,
  // ms-chat-turn никогда не появляется, watcher висит до timeout'а.
  //
  // Поведение: если dialog не виден — no-op (return false). Если виден:
  //   - найти Select key, проверить !disabled
  //   - mainWorldClick (trusted, как для Run-кнопки)
  //   - подождать до 2с пока dialog закроется
  //   - если всё ещё открыт → throw 'paid_key_link_failed: <diagnostics>'
  //
  // Caller (runJob) ловит throw и кладёт его в job.error с stage='paid_key_failed',
  // MCP отдаёт детерминированную ошибку через get_result.
  function findPaidKeyDialog() {
    const dialogs = Array.from(document.querySelectorAll('mat-dialog-container'));
    for (const d of dialogs) {
      if (!d.offsetParent) continue;
      const txt = (d.textContent || '');
      if (/Link a paid API key/i.test(txt)) return d;
    }
    return null;
  }

  async function ensurePaidKeyLinked() {
    const dialog = findPaidKeyDialog();
    if (!dialog) return false; // no dialog — happy path

    log('paid_key.dialog_seen', {
      textHead: (dialog.textContent || '').slice(0, 200).replace(/\s+/g, ' '),
    });

    // **Стратегия: Escape через chrome.debugger (trusted), а X-click как
    // fallback.** История проблемы:
    //
    // 1. Сначала пробовали click на Select key через mainWorldClick (pointer-chain
    //    в MAIN world). Click ОК (resp.ok=true), но dialog не закрылся
    //    через 2с — Studio Angular Material требует focus/trusted state.
    // 2. Изменили на «всегда X (close)». То же самое: click_resp ok, но
    //    dialog_stuck. mainWorldClick — это synthetic dispatchEvent в MAIN
    //    world, event.isTrusted=false, Material dialog их отбрасывает.
    // 3. Юзер подтверждает: «нажимаю X **руками** — работает». Hand-click
    //    имеет event.isTrusted=true. Решение — `chrome.debugger.Input.dispatchKeyEvent`
    //    (Escape), который эмулирует ОС-уровневое событие.
    //
    // Чтобы не возвращаться к этой проблеме: первый удар — Escape (debugger),
    // verify 1.5с. Если не закрылся (debugger не прикреплён? Material не
    // слушает Escape?) — fallback на X-click (хоть оно и не сработало в нашем
    // тесте, может в других UI-states сработает).
    //
    // Стратегия: TRUSTED MOUSE CLICK по координатам X (close-button) через
    // chrome.debugger.Input.dispatchMouseEvent. Эмулирует ОС-уровневый клик
    // (event.isTrusted=true), Angular Material принимает. Если упало —
    // fallback на mainWorldClick (synthetic, на всякий случай если debugger
    // detached).
    // ПРИВЯЗАТЬ ключ, а НЕ закрыть. Раньше жали X (close): диалог исчезал, но
    // ключ НЕ привязывался → Antigravity/Deep Research (которым нужен paid key)
    // падали instant-error'ом (доказано: aim_mq4z1n1l — close→no_stop→error).
    // Юзер показал диалог «Link a paid API key» (Choose project ✓ / Set up
    // billing ✓ / Link API key) c кнопкой «Select key» — её и надо нажать.
    // План: (1) включить toggle «Save paid API key» (диалог не появится в
    // будущем), (2) клик «Select key» через userGesture (наш надёжный click).
    // Fallback X (close) — только если «Select key» нет (старый вариант).
    const findBtnByText = (re) => Array.from(dialog.querySelectorAll('button'))
      .find(b => re.test((b.textContent || '').replace(/\s+/g, ' ').trim()) && b.offsetParent && !b.disabled);

    // (1) toggle «Save paid API key».
    try {
      const saveToggle = Array.from(dialog.querySelectorAll('button[role="switch"], [role="switch"], mat-slide-toggle'))
        .find(t => t.offsetParent);
      if (saveToggle && saveToggle.getAttribute('aria-checked') !== 'true') {
        saveToggle.setAttribute('data-sc-ug-click', 'pk-save');
        try { await chrome.runtime.sendMessage({ __sc_usergesture_click: true, selector: '[data-sc-ug-click="pk-save"]', pickLast: false }); } catch {}
        try { saveToggle.removeAttribute('data-sc-ug-click'); } catch {}
        await sleep(200);
        log('paid_key.save_toggle_enabled');
      }
    } catch (e) { log('paid_key.save_toggle_err', { err: e?.message }); }

    // (1.5) ВОССТАНОВИТЬ промпт в композере ПЕРЕД select_key. Доказано net-tap:
    // клик select_key авто-сабмитит (CreateInteractionStream), а композер к
    // этому моменту ПУСТ (открытие dialog'а его очистило) → создаётся ПУСТАЯ
    // агентская сессия (hasPromptMarker:false) = мусорный env-init турн. Если
    // вернуть промпт в композер до select_key — авто-сабмит унесёт ЕГО, и
    // первый же турн будет с задачей, без мусора и без 60-сек ожидания.
    // restorePrompt передаётся из waitForCompletion (job.prompt). Делаем ТОЛЬКО
    // если поле пустое (не перетираем то что юзер/код уже там оставил).
    if (window.__scPaidKeyRestorePrompt) {
      try {
        const ta = findPromptTextarea();
        if (ta && !(ta.value || '').trim()) {
          setReactValue(ta, window.__scPaidKeyRestorePrompt);
          ta.focus();
          await sleep(150);
          log('paid_key.prompt_restored_before_select', { len: window.__scPaidKeyRestorePrompt.length });
        }
      } catch (e) { log('paid_key.prompt_restore_err', { err: e?.message }); }
    }

    // (2) «Select key» → привязать.
    const selectBtn = findBtnByText(/^Select key$/i) || findBtnByText(/Select key/i) || findBtnByText(/^Link API key$/i);
    if (selectBtn) {
      selectBtn.setAttribute('data-sc-ug-click', 'pk-select');
      log('paid_key.select_key_click', { text: (selectBtn.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30) });
      try { await chrome.runtime.sendMessage({ __sc_usergesture_click: true, selector: '[data-sc-ug-click="pk-select"]', pickLast: false }); } catch (e) { log('paid_key.select_key_err', { err: e?.message }); }
      try { selectBtn.removeAttribute('data-sc-ug-click'); } catch {}
      const deadline = performance.now() + 4000; // линковка ключа = network, до 4с
      while (performance.now() < deadline) {
        await sleep(150);
        if (!findPaidKeyDialog()) { log('paid_key.dialog_closed', { via: 'select_key' }); return true; }
      }
      log('paid_key.select_key_did_not_close');
    } else {
      log('paid_key.no_select_key_button', {
        buttons: Array.from(dialog.querySelectorAll('button')).map(b => ({ t: (b.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 25), a: b.getAttribute('aria-label') })),
      });
    }

    // Fallback: X (close). Ключ не привязан, но лучше чем зависнуть — для Flash
    // (которому ключ не нужен) сработает.
    const closeBtn = Array.from(dialog.querySelectorAll('button'))
      .find(b => b.getAttribute('aria-label') === 'close');
    if (closeBtn) {
      try { closeBtn.scrollIntoView({ block: 'center' }); } catch {}
      await sleep(120);
      const rect = closeBtn.getBoundingClientRect();
      const cx = Math.round(rect.x + rect.width / 2);
      const cy = Math.round(rect.y + rect.height / 2);
      try { await chrome.runtime.sendMessage({ __sc_trusted_click: true, x: cx, y: cy }); } catch {}
      const d1 = performance.now() + 2000;
      while (performance.now() < d1) {
        await sleep(100);
        if (!findPaidKeyDialog()) { log('paid_key.dialog_closed', { via: 'close_fallback' }); return true; }
      }
      await mainWorldClick(closeBtn);
      const d2 = performance.now() + 1500;
      while (performance.now() < d2) {
        await sleep(100);
        if (!findPaidKeyDialog()) { log('paid_key.dialog_closed', { via: 'synthetic_x' }); return true; }
      }
    }

    const still = findPaidKeyDialog();
    const finalText = still ? (still.textContent || '').slice(0, 300).replace(/\s+/g, ' ') : '<gone>';
    log('paid_key.dialog_stuck', { stillVisible: !!still, finalText });
    throw new Error('paid_key_link_failed: dialog did not close after Select key + close fallback. Final text: ' + finalText);
  }

  async function pastePromptAndRun(text) {
    log('paste.start', { textLen: text.length });
    const ta = await waitFor(
      () => Array.from(document.querySelectorAll('textarea'))
        .find(t => /typing a prompt/i.test(t.placeholder || '')),
      'main-prompt-textarea',
      10000,
    );
    log('paste.textarea_found', { hadValue: !!ta.value });
    if (ta.value) setReactValue(ta, '');
    setReactValue(ta, text);
    ta.focus();
    log('paste.done', { valueLen: ta.value.length });

    const runBtn = await waitFor(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      return btns.find(b => {
        const t = b.textContent || '';
        return /Run/.test(t) && /keyboard_return/.test(t) && b.offsetParent;
      });
    }, 'run-button', 8000);
    log('run.found', { disabled: runBtn.disabled, visible: !!runBtn.offsetParent });

    await waitFor(() => !runBtn.disabled, 'run-button-enabled', 10000).catch(() => {});
    log('run.enabled');

    // Single-shot main-world click. История race-condition:
    //   - ISO-world `runBtn.click()` НЕ работает в AI Studio (Angular Material
    //     проверяет event.isTrusted, синтетические клики игнорятся).
    //   - Раньше делали ISO → sleep(800) → если Stop не появился → mainWorldClick.
    //     На медленных Angular CD циклах (даже с debugger rAF unblock'нут)
    //     ISO click мог отложенно сработать ПОСЛЕ нашего sleep, к моменту
    //     mainWorldClick. Двойной submit → AI Studio запускает 2 параллельных
    //     stream'а в тот же ms-text-chunk → "Произведение... Произведение..."
    //     (см. fact-aistudio-mcp.md::Double-click race и issue #77).
    //   - Решение: ВСЕГДА сразу делать mainWorldClick через SW, не пробовать
    //     ISO-click впустую. Один submit = один stream = чистый ответ.
    function stopVisible() {
      return !!Array.from(document.querySelectorAll('button')).find(b => /Stop/.test(b.textContent || '') && b.offsetParent);
    }
    const initialTurnCount = document.querySelectorAll('ms-chat-turn').length;
    function turnCountAdvanced() {
      return document.querySelectorAll('ms-chat-turn').length > initialTurnCount;
    }
    function runBtnStillRun() {
      const t = runBtn.textContent || '';
      return /Run/.test(t) && /keyboard_return/.test(t);
    }

    // TRUSTED клик (isTrusted=true) — backend AI Studio требует user-activation
    // для submit'а (synthetic mainWorldClick создаёт turn, но запрос отбивается
    // мгновенным 500 "internal error"). Run всегда видим (не hover-gated, в
    // композере), pin не нужен — только trusted. Fallback на synthetic если
    // нет debugger/координат. См. trustedClick() и fact-aistudio-mcp.md.
    const runTr = await trustedClick(runBtn);
    if (!runTr || runTr.ok !== true) {
      log('run.trusted_failed_fallback_synthetic', runTr || {});
      await mainWorldClick(runBtn);
    } else {
      log('run.clicked', { via: 'trusted' });
    }
    // Даём Angular CD цикл, через debugger rAF тикает на 60Hz —
    // 1.5с с запасом, обычно state переходит за 200-400мс.
    await sleep(1500);
    if (stopVisible() || turnCountAdvanced() || !runBtnStillRun()) {
      log('run.advanced.main_world', { stop: stopVisible(), turnAdv: turnCountAdvanced(), btnStill: runBtnStillRun() });
      return;
    }

    // DOM не сдвинулся за 1.5с. ПРЕЖДЕ чем делать keyboard-fallback — НЕ спешим:
    // на ПЛАТНЫХ моделях (Antigravity / Deep Research) клик Run не submit'ит, а
    // ОТКРЫВАЕТ модалку «Link a paid API key», которую AI Studio рендерит лениво
    // — наблюдалось ~11с между run.clicked и paid_key.dialog_seen (см. лог
    // aim_mq535269). Раньше мы ждали всего 1.5+1.5с и стреляли Ctrl/Cmd+Enter в
    // окне загрузки диалога — это СПУРИОЗНЫЙ второй submit без привязанного ключа:
    //   • уходит «internal error» Agent-turn ПЕРЕД user-промптом, и/или
    //   • буферизуется → двойной запуск (промпт остаётся в инпуте, агент уже
    //     «ведёт ответ»).
    // Ровно симптомы из багрепорта. Поэтому поллим до ~12с в ожидании ОДНОГО из:
    //   • Stop/turn появился       → submit реально пошёл (free-модель), return
    //   • paid-key dialog появился  → Run открыл модалку; prompt НЕ отправлен →
    //                                 return и отдаём wait-loop'у, он привяжет
    //                                 ключ и сделает РОВНО ОДИН re-submit
    //                                 (waitForCompletion::mid_paid_key_resubmit).
    // См. fact-aistudio-mcp.md::Paid API key dialog (медленный рендер) +
    // Double-click race.
    for (let i = 0; i < 24; i++) { // 24 × 500мс = 12с
      if (stopVisible() || turnCountAdvanced() || !runBtnStillRun()) {
        log('run.advanced.delayed', { afterMs: 1500 + i * 500 });
        return;
      }
      if (findPaidKeyDialog()) {
        log('run.paid_key_dialog_opened — Run открыл модалку ключа, defer to wait-loop (skip kbd fallback)', { afterMs: 1500 + i * 500 });
        return;
      }
      await sleep(500);
    }

    // 12с тишины И ни Stop, ни turn, ни paid-key dialog — клик реально не
    // сработал. ТОЛЬКО тогда Ctrl/Cmd+Enter fallback (защита от double-submit:
    // если бы submit прошёл или модалка грузилась — мы бы уже вышли выше).
    log('run.no_advance_12s — trying Ctrl/Cmd+Enter fallback');
    if (!runBtnStillRun() || turnCountAdvanced()) {
      log('run.advanced.late_main_world_detected');
      return;
    }
    // Boundary guard: модалка ключа могла дорендериться ровно на 12-й секунде
    // (Google lazy render джиттерит). Ещё раз проверяем перед нажатием — иначе
    // keystroke улетит в окно загрузки диалога = тот самый спуриозный submit.
    if (findPaidKeyDialog()) {
      log('run.paid_key_dialog_opened_at_boundary — defer to wait-loop (skip kbd fallback)');
      return;
    }
    ta.focus();
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', ctrlKey: true, bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', metaKey: true, bubbles: true }));
    await sleep(1500);
    if (stopVisible() || turnCountAdvanced() || !runBtnStillRun()) {
      log('run.advanced.kbd_fallback');
      return;
    }

    log('run.all_fallbacks_failed', {
      promptInTextarea: (ta.value || '').slice(0, 60),
      runBtnDisabled: runBtn.disabled,
      runBtnVisible: !!runBtn.offsetParent,
    });
  }

  // Двухфазная отправка промпта для Interactions-API моделей (Antigravity / Deep
  // Research). Доказано net-tap'ом: у этих моделей submit = `CreateInteraction`
  // (поднять агентскую сессию + Linux-песочницу), а промпт идёт ОТДЕЛЬНЫМ шагом
  // (`CreatePrompt`/`input`). Первый Run на платной модели в фоне открывает окно
  // ключа И запускает поднятие сессии (env-init турны «Spinning up… / List
  // Files»). К моменту привязки ключа Run занят (стал Stop) — отправить промпт
  // некуда. Раньше мы repaste'или и сразу пытались дожать Run (занят → no-op),
  // промпт оставался недоотправленным → агент отвечал «the actual task is
  // missing» (0 User-turn'ов).
  //
  // Правильно (= ручной сценарий юзера): дождаться пока сессия поднимется и Run
  // ВЕРНЁТСЯ (env-init турн завершился), затем отправить промпт вторым
  // сообщением. Сигнал успеха — появился новый User-turn (countUserTurns вырос).
  async function submitPromptAsNewMessage(text, { waitRunMs = 90000 } = {}) {
    const userTurnsBefore = countUserTurns();
    log('submit2.start', { userTurnsBefore, waitRunMs });

    // Фаза 1: дождаться возврата Run (сессия поднялась, env-init-турн закончил
    // первый шаг). Поллим до waitRunMs. Параллельно ловим окно ключа (вдруг
    // всплыло снова посреди подъёма) и backend-error.
    const deadline = performance.now() + waitRunMs;
    let runBtn = null;
    while (performance.now() < deadline) {
      if (findPaidKeyDialog()) { try { await ensurePaidKeyLinked(); } catch {} }
      const be = detectBackendError();
      if (be) { log('submit2.backend_error_while_waiting_run', { err: be.slice(0, 80) }); throw new Error(be); }
      runBtn = findRunBtn();
      if (runBtn && !runBtn.disabled) break;
      await sleep(500);
    }
    if (!runBtn) { log('submit2.run_never_returned'); throw new Error('submit2: Run button never returned within ' + waitRunMs + 'ms'); }

    // Фаза 2: вставить промпт и отправить.
    const ta = findPromptTextarea();
    if (!ta) { log('submit2.no_textarea'); throw new Error('submit2: prompt textarea not found'); }
    setReactValue(ta, text);
    ta.focus();
    log('submit2.pasted', { len: text.length });
    await sleep(150);
    const freshRun = findRunBtn();
    if (!freshRun) { log('submit2.run_gone_after_paste'); throw new Error('submit2: Run disappeared after paste'); }
    const tr = await trustedClick(freshRun);
    if (!tr || tr.ok !== true) { await mainWorldClick(freshRun); log('submit2.clicked', { via: 'synthetic' }); }
    else log('submit2.clicked', { via: 'trusted' });

    // Фаза 3: верифицировать что промпт стал User-turn'ом (а не потерялся).
    const verifyDeadline = performance.now() + 8000;
    while (performance.now() < verifyDeadline) {
      await sleep(300);
      if (countUserTurns() > userTurnsBefore) { log('submit2.user_turn_confirmed', { now: countUserTurns() }); return true; }
    }
    log('submit2.user_turn_not_confirmed', { still: countUserTurns() });
    return false;
  }

  // ── Wait for completion + parse last response ─────────────────────────
  //
  // Признак того что модель закончила: кнопка Stop пропала AND вернулась
  // Run. Deep Research модели держат Stop 5-15 минут — caller обязан передать
  // соответствующий timeout. Onprogress(elapsedSec, hasStop) для UI-обновлений.
  // Backend error detect: AI Studio иногда возвращает "An internal error has
  // occurred" сразу после submit (даже не успев показать Stop). Эта строка
  // появляется внутри ms-chat-turn[role=Model]. Detect нужен в обоих местах:
  // (а) stop-probe loop — чтобы не ждать 8 секунд если ошибка пришла за 500мс;
  // (б) основной wait-loop — на случай если error случился между Stop'ами.
  function detectBackendError() {
    const turns = document.querySelectorAll('ms-chat-turn');
    const lastTurn = turns[turns.length - 1];
    if (!lastTurn) return null;
    const txt = (lastTurn.textContent || '');
    // RATE LIMIT — терминальная, НЕ retryable (повтор сразу упрётся в тот же
    // лимит). Доказано: DR-турн «You've reached your rate limit. Please try
    // again later.» висел 297с без детекта (старый код ловил только internal
    // error) → job крутился до 20-мин таймаута. Префикс «rate_limit:» — чтобы
    // retry-loop (ловит /backend error|internal error/) НЕ счёл это retryable.
    if (/reached your rate limit|rate limit.*try again|превыс\w+ лимит|достигли лимит/i.test(txt)) {
      return 'rate_limit: AI Studio — ' + txt.slice(0, 160).replace(/\s+/g, ' ').trim();
    }
    // "An internal error has occurred" (eng) / "Произошла внутренняя ошибка" (ru)
    // — транзиентная, retryable (retry-loop её ловит и делает rerun).
    if (/An internal error has occurred|Произошла внутренняя ошибка/i.test(txt)) {
      return 'AI Studio backend error: ' + txt.slice(0, 200);
    }
    return null;
  }

  // Обработка окна платного ключа во время ожидания submit'а. Выделено в
  // helper чтобы звать ИЗ ДВУХ мест: probe-цикла (ловит окно сразу, ~1.5с) и
  // основного while-цикла (mid-stream rotation ключа у DR). Раньше окно
  // обрабатывалось только во while — а до него probe крутил 8с впустую,
  // окно висело нетронутым, агент успевал уйти в разведку песочницы. Теперь
  // жмём «Select key» в момент появления окна.
  // Возвращает true если окно было и обработано (caller сбросит stopAppeared).
  async function handlePaidKeyDuringWait(elapsedSec, promptForResubmit) {
    if (!findPaidKeyDialog()) return false;
    log('wait.mid_paid_key_seen', { elapsedSec });
    const userTurnsBefore = countUserTurns();
    // Подсказка для ensurePaidKeyLinked: вернуть промпт в композер ПЕРЕД
    // select_key, чтобы авто-сабмит от привязки ключа унёс промпт (а не пустоту).
    try { window.__scPaidKeyRestorePrompt = promptForResubmit || ''; } catch {}
    await ensurePaidKeyLinked();              // привязка ключа + (возможно) сабмит с промптом
    try { window.__scPaidKeyRestorePrompt = ''; } catch {}
    log('wait.mid_paid_key_handled', { elapsedSec });

    if (!promptForResubmit) return true;

    // Проверяем: select_key уже унёс промпт как User-turn? (наш restore сработал)
    // Даём 2.5с на материализацию User-turn'а после select_key.
    let landed = false;
    for (let k = 0; k < 5; k++) {
      await sleep(500);
      if (countUserTurns() > userTurnsBefore) { landed = true; break; }
    }
    if (landed) {
      // Промпт ушёл первым же турном — мусорного env-init НЕТ, ждать нечего.
      log('wait.mid_paid_key_prompt_landed_on_select', { elapsedSec });
      return true;
    }

    // Fallback: select_key унёс пустоту (или промпт не успел) → старый
    // двухфазный путь: дождаться возврата Run и отправить промпт вторым
    // сообщением. submitPromptAsNewMessage верифицирует User-turn.
    log('wait.mid_paid_key_resubmit', { elapsedSec, promptLen: promptForResubmit.length });
    try { await submitPromptAsNewMessage(promptForResubmit); } catch (rsErr) { log('wait.resubmit_err', { err: rsErr?.message }); }
    return true;
  }

  async function waitForCompletion({ timeoutMs = 20 * 60 * 1000, onProgress = null, ignoreStaleErrorMs = 0, promptForResubmit = null } = {}) {
    const t0 = performance.now();
    // ignoreStaleErrorMs: при ретрае waitForCompletion зовётся СРАЗУ после
    // rerunLastTurn, когда СТАРЫЙ error-turn ещё в DOM (~1с пока новая генерация
    // не заменит его). Без grace detectBackendError на i:0 видел бы этот СТАРЫЙ
    // error и мгновенно throw'ал — 3 ретрая за 3.4с впустую (см. лог
    // aim_mq4v25pn: early_backend_error i:0 на КАЖДОМ ретрае). В grace-окне
    // НЕ throw'аем по error: ждём либо его исчезновения (rerun очистил), либо
    // Stop (генерация пошла). Только error, переживший grace И не сменившийся
    // на Stop, считается настоящим.
    const graceUntil = ignoreStaleErrorMs > 0 ? performance.now() + ignoreStaleErrorMs : 0;
    // 1. Подождём пока Stop появится (модель начала отвечать). Если Run
    //    был просто disabled и сразу обратно enabled — нет смысла ждать
    //    Stop вечно; короткий probe + переход к фазе "ждём Run".
    let stopAppeared = false;
    for (let i = 0; i < 40; i++) {
      // Окно платного ключа КАЖДУЮ итерацию (~200мс) — а не через 8с во
      // while-цикле. Это и был баг агента: probe ждал ТОЛЬКО Stop, окно ключа
      // висело нетронутым 8с, агент уходил в разведку песочницы. Жмём Select
      // key сразу как окно появилось (~1.5с), пере-submit'им промпт, и дальше
      // основной цикл честно ждёт Stop→Run НАШЕГО submit'а (stopAppeared сброшен).
      if (findPaidKeyDialog()) {
        try {
          const handled = await handlePaidKeyDuringWait(Math.round((performance.now() - t0) / 1000), promptForResubmit);
          if (handled) { stopAppeared = false; break; }
        } catch (pkErr) { log('wait.probe_paid_key_failed', { err: pkErr?.message }); throw pkErr; }
      }
      const stop = Array.from(document.querySelectorAll('button')).find(b => /Stop/.test(b.textContent || '') && b.offsetParent);
      if (stop) { stopAppeared = true; break; }
      // Early backend-error detect: за 0.5-2 секунды AI Studio часто успевает
      // показать "An internal error has occurred" — выходим сразу, retry layer
      // выше решит что делать. НО в grace-окне (ретрай) — пропускаем стейл-error.
      const err = detectBackendError();
      if (err) {
        if (performance.now() < graceUntil) {
          if (i % 5 === 0) log('wait.stale_error_grace', { i });
          await sleep(200);
          continue;
        }
        log('wait.early_backend_error', { i, err: err.slice(0, 80) });
        throw new Error(err);
      }
      await sleep(200);
    }
    log('wait.stop_probe_done', { stopAppeared, tookMs: Math.round(performance.now() - t0) });

    // 2. Если Stop появился — крутимся пока он не исчезнет.
    const POLL = 1500;
    let lastLogAt = 0;
    while (performance.now() - t0 < timeoutMs) {
      const stop = Array.from(document.querySelectorAll('button')).find(b => /Stop/.test(b.textContent || '') && b.offsetParent);
      const run  = Array.from(document.querySelectorAll('button')).find(b => /Run/.test(b.textContent || '') && /keyboard_return/.test(b.textContent || '') && b.offsetParent);
      const elapsedSec = Math.round((performance.now() - t0) / 1000);
      if (onProgress) {
        try { onProgress({ elapsedSec, hasStop: !!stop, hasRun: !!run }); } catch {}
      }
      // Heartbeat в bridge каждые 5 сек, чтобы пост-mortem видел прогресс.
      if (elapsedSec - lastLogAt >= 5) {
        lastLogAt = elapsedSec;
        const turnCount = document.querySelectorAll('ms-chat-turn').length;
        const chunkCount = document.getElementsByTagName('ms-text-chunk').length;
        log('wait.tick', { elapsedSec, hasStop: !!stop, hasRun: !!run, stopAppeared, turnCount, chunkCount });
      }
      // Mid-stream backend error detect.
      const err = detectBackendError();
      if (err) { log('wait.mid_backend_error', { elapsedSec, err: err.slice(0, 80) }); throw new Error(err); }
      // Mid-stream paid-key dialog: Studio иногда вышибает key посреди
      // research'а (session-level rotation). Dialog overlay'ит вкладку,
      // research-stream продолжается под ним, но новые turn'ы / финальный
      // document не сохранятся пока key не подтверждён. Кликаем Select key
      // и продолжаем wait. Если упало — throw, retry-layer наверху может
      // решить что делать.
      // Mid-stream окно ключа (rotation у DR посреди стрима, или если probe
      // его не застал). Тот же helper что в probe-цикле. Если обработали —
      // сбрасываем ложный stopAppeared (env-init Antigravity мог выставить Stop
      // ещё до нашего промпта), чтобы дождаться Stop→Run НАШЕГО submit'а.
      try {
        if (await handlePaidKeyDuringWait(elapsedSec, promptForResubmit)) stopAppeared = false;
      } catch (pkErr) {
        log('wait.mid_paid_key_failed', { err: pkErr?.message });
        throw pkErr;
      }
      // Готово, когда Stop пропал И Run появился. Двойная проверка нужна
      // чтобы не словить промежуточный кадр где обе кнопки скрыты.
      if (!stop && run && stopAppeared) {
        log('wait.done.stop_disappeared', { elapsedSec });
        return { elapsedSec };
      }
      // Stop вообще не появлялся. Раньше тут был выход по `elapsedSec > 3`
      // (для instant Flash cache-hit). НО он МИСФАЙРИЛ на медленных моделях
      // (DR, Antigravity): Stop появляется поздно (после env-init / план-фазы),
      // probe-окно его пропускало → no_stop_short_answer выходил на 3-8с и
      // хапал промежуточный текст («Generating research plan…», «folder List
      // Files…»). Доказано: aim_mq4ziik1 (DR) вернул план вместо отчёта.
      //
      // Фикс: выходить по no-stop ТОЛЬКО когда есть РЕАЛЬНЫЙ ответ — Model/Agent
      // турн с непустым не-thought ms-text-chunk (validChunks>0). Activity/
      // thinking-турны (validChunks=0) НЕ считаются завершением. Flash cache-hit
      // имеет validChunks сразу → не регрессит. DR/agent ждут до настоящего Stop
      // или до материализации финального текста.
      if (!stop && run && !stopAppeared && elapsedSec > 3) {
        const errNoStop = detectBackendError();
        if (errNoStop) {
          log('wait.no_stop_backend_error', { elapsedSec, err: errNoStop.slice(0, 80) });
          throw new Error(errNoStop);
        }
        // Есть ли уже реальный ответ (не thinking/activity)?
        const allTurns = document.querySelectorAll('ms-chat-turn');
        const lastT = allTurns[allTurns.length - 1];
        const realAnswer = lastT && Array.from(lastT.querySelectorAll('ms-text-chunk'))
          .some(tc => !tc.closest('ms-thought-chunk') && !tc.closest('ms-thought-activity-chunk')
            && (tc.textContent || '').trim().length > 0);
        if (realAnswer) {
          log('wait.done.no_stop_short_answer', { elapsedSec });
          return { elapsedSec };
        }
        // Нет реального ответа — продолжаем ждать (DR/agent ещё работают).
        // Лог раз в ~10с чтобы видеть что ждём не зря.
        if (elapsedSec % 10 === 0) log('wait.no_stop_waiting_real_answer', { elapsedSec });
      }
      await sleep(POLL);
    }
    log('wait.timeout', { timeoutMs });
    throw new Error('timeout waiting for completion');
  }

  // ── TurnCache (MutationObserver) ──────────────────────────────────────
  //
  // Studio демонтирует ms-text-chunk/ms-cmark-node/ms-thought-chunk из
  // `turn-content` div'а когда `document.visibilityState === 'hidden'`.
  // После demount живой DOM пуст — parseLastTurn ничего не находит, job
  // помечается как 'completion finished but no response text found' даже
  // если модель ответила.
  //
  // Решение по аналогии с claude-research.js::startDoneWatcher:
  // глобальный MutationObserver, который ловит каждое появление
  // ms-text-chunk/ms-cmark-node/ms-thought-chunk и кэширует их innerText
  // + linkные <a href> в `turnCache` Map<turnId, {role, parts[], thoughts[], links[]}>.
  // Кэш переживает demount, parseLastTurn читает из него.
  //
  // Throttle через rAF (см. claude-research.js): на активном response Studio
  // может генерить сотни мутаций/сек, мы делаем максимум 1 sweep/frame.
  //
  // Объём: средний ответ Studio ~5-20 KB innerText на турн, ссылок до 50.
  // 10 турнов = ~200 KB в Map'е, переживёт пока вкладка жива.

  const TAG_LOG = '[scAist-cache]';
  function clog(msg, data) { try { console.log(TAG_LOG, msg, data || ''); } catch {} }

  // Map<turnId, {role, textParts:[], thoughtParts:[], links:Map<href, {title,source}>}>
  const turnCache = new Map();
  let observerStarted = false;
  let observerRafScheduled = false;

  function getTurnIdFromEl(el) {
    const turn = el.closest && el.closest('ms-chat-turn');
    if (!turn) return null;
    return turn.id || null;
  }

  function captureTurnSnapshot(turn) {
    if (!turn) return;
    const id = turn.id;
    if (!id) return;
    const role = turn.querySelector('[data-turn-role]')?.getAttribute('data-turn-role');
    if (!role) return;
    if (role !== 'Model' && role !== 'Agent' && role !== 'User') return;

    let entry = turnCache.get(id);
    if (!entry) {
      entry = { role, textParts: [], thoughtParts: [], links: new Map() };
      turnCache.set(id, entry);
    }

    // text chunks НЕ внутри thought-обёрток — это финальный ответ
    // Используем textContent first (innerText пуст в hidden tab — Blink
    // не делает layout для скрытых вкладок, innerText построен на layout).
    const textChunks = Array.from(turn.querySelectorAll('ms-text-chunk, ms-cmark-node, ms-prompt-chunk'))
      .filter(tc => !tc.closest('ms-thought-chunk') && !tc.closest('ms-thought-activity-chunk'));
    if (textChunks.length > 0) {
      const joined = textChunks.map(tc => (tc.textContent || tc.innerText || '').trim()).filter(Boolean).join('\n\n');
      if (joined && joined.length > (entry.textParts.join('\n\n') || '').length) {
        // Заменяем целиком (а не дописываем) — stream обновляет тот же chunk
        // частичным текстом, partial-append даст дубли.
        entry.textParts = [joined];
      }
    }

    // thought chunks отдельно — diagnostic, не идут в финальный text
    const thoughts = Array.from(turn.querySelectorAll('ms-thought-chunk, ms-thought-activity-chunk'));
    if (thoughts.length > 0) {
      const joined = thoughts.map(t => (t.innerText || t.textContent || '').trim()).filter(Boolean).join('\n\n');
      if (joined && joined.length > (entry.thoughtParts.join('\n\n') || '').length) {
        entry.thoughtParts = [joined];
      }
    }

    // ссылки — катч-олл всех <a href> внутри турна (grounding-источники
    // пропускаются, UI-навигация режется — см. isNoiseLink).
    for (const a of turn.querySelectorAll('a[href]')) {
      const href = a.href || '';
      if (isNoiseLink(href)) continue;
      if (entry.links.has(href)) continue;
      const title = (a.textContent || a.getAttribute('aria-label') || '').trim().slice(0, 200);
      const source = a.closest('ms-search-entry-point, ms-tool-activity-chunk') ? 'search' : 'inline';
      entry.links.set(href, { href, title, source });
    }
  }

  function sweepAllTurns() {
    observerRafScheduled = false;
    const turns = document.querySelectorAll('ms-chat-turn');
    for (const turn of turns) captureTurnSnapshot(turn);
  }

  let lastSweepAt = 0;
  function scheduleSweep() {
    // СИНХРОННЫЙ sweep в MO callback. Чем дольше мы defer'им (setTimeout/
    // rAF), тем выше риск что Studio демонтирует chunk до того как мы
    // прочитали innerText. На быстрых ответах Flash (~1с) Studio пишет
    // chunks и сразу же их свопает в Shadow DOM hidden-state, а наш
    // setTimeout(0) тикает с throttle 1с в hidden tab → пропуск.
    //
    // Throttle через timestamp вместо setTimeout: если последний sweep
    // был <50мс назад — пропускаем (mutations часто batch'атся, сотни
    // в один frame). Иначе sweep сразу же.
    const now = performance.now();
    if (now - lastSweepAt < 50) return;
    lastSweepAt = now;
    sweepAllTurns();
  }

  function startTurnCacheObserver() {
    if (observerStarted) return;
    observerStarted = true;

    // Один глобальный MO на documentElement subtree. Это охватывает любые
    // турны где бы они ни появились (ms-chat-session, virtual-scroll, etc).
    const mo = new MutationObserver(() => scheduleSweep());
    mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

    // Periodic safety net — раз в 500мс принудительно sweep. На случай
    // если MO пропустил мутацию (Studio reset whole subtree через innerHTML).
    // В hidden tab setInterval тротлится до 1с/тик, но мы запрашиваем 500
    // — реальный тик будет ~1с, что приемлемо для непрерывного captureSnapshot
    // даже при коротких ответах.
    setInterval(sweepAllTurns, 500);

    // Сразу captured-snapshot — на случай если CS заинжектился ПОСЛЕ того
    // как chunks уже отрендерены и в DOM (но ещё не демонтированы).
    sweepAllTurns();

    clog('observer started');
  }

  // Build {text, links, role} из cache entry (last Model/Agent в порядке DOM).
  function readLastFromCache() {
    const turns = Array.from(document.querySelectorAll('ms-chat-turn'));
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      const entry = turnCache.get(t.id);
      if (!entry) continue;
      if (entry.role !== 'Model' && entry.role !== 'Agent') continue;
      const text = entry.textParts.join('\n\n').trim();
      if (!text) continue;
      const links = [...entry.links.values()].slice(0, 50);
      return { text, links, role: entry.role, turnIdx: i, fromCache: true };
    }
    return null;
  }

  // Extract markdown text + ссылки из ПОСЛЕДНЕГО Model/Agent турна.
  // Логика упрощённая версия aistudio-export.js::extractModelMessageText:
  //   - игнорируем ms-thought-chunk И ms-thought-activity-chunk (reasoning,
  //     старый и новый теги — см. fact-browser-extension.md::Deep Research)
  //   - берём ms-text-chunk вне thought-обёрток
  //   - перед чтением скроллим турн в view, чтобы Angular подгрузил DOM
  //     (DR/Antigravity турны лениво-материализуются через virtual-scroll-container)
  //   - если live DOM пуст (hidden-tab demount) — пробуем cache от
  //     turnCacheObserver, который захватил chunks ДО demount'а
  //
  // Ссылки собираем из ТРЁХ источников (важно — Studio кладёт ссылки в
  // разных местах в зависимости от модели):
  //   1) <a href> внутри валидных ms-text-chunk'ов — inline-links в markdown'е
  //      (типично для Flash/Pro)
  //   2) <a href> в ms-search-entry-point внутри ms-tool-activity-chunk — это
  //      Google Search Suggestions блок у Deep Research / grounded моделей
  //   3) ВСЕ <a href> внутри ms-chat-turn (catch-all) — на случай если новая
  //      версия DR/Antigravity положит ссылки в новый wrapper
  //
  // Дедуп по href, кап на ~50 чтобы не раздуть JSON. Возвращает
  // {text, links, role, turnIdx, fromCache?} или null.
  // Ждёт пока live DOM не перестанет расти. Race: stop_disappeared может
  // прилететь на самом начале стрима (Flash успевает start+stop за 1
  // POLL=1500мс). parseLastTurn моментально читает partial chunk →
  // truncated ответ (см. #76). Защита: 2 sample подряд должны дать тот же
  // textLen, тогда считаем что стрим закончился.
  //
  // ВАЖНО: измеряем только ms-text-chunk (не-thought), а не общий textContent
  // турна. textContent захватывает UI controls (more_vert/thumb_up/thumb_down)
  // которые имеют constant length после завершения — даёт false positive
  // "stable" даже если chunk демонтировался. Только validChunks - надёжно.
  async function waitForStableText({ maxWaitMs = 4000, sampleIntervalMs = 800 } = {}) {
    const t0 = performance.now();
    let lastLen = -1;
    let stableCount = 0;
    while (performance.now() - t0 < maxWaitMs) {
      const turns = document.querySelectorAll('ms-chat-turn');
      const last = turns[turns.length - 1];
      let curLen = 0;
      if (last) {
        const valid = Array.from(last.querySelectorAll('ms-text-chunk'))
          .filter(tc => !tc.closest('ms-thought-chunk') && !tc.closest('ms-thought-activity-chunk'));
        for (const tc of valid) {
          // textContent first — innerText пуст в hidden tab (нет layout).
          curLen += (tc.textContent || tc.innerText || '').length;
        }
      }
      if (curLen === lastLen && curLen > 0) {
        stableCount++;
        if (stableCount >= 1) {
          log('parse.stable_text_reached', { len: curLen, tookMs: Math.round(performance.now() - t0) });
          return;
        }
      } else {
        stableCount = 0;
      }
      lastLen = curLen;
      await sleep(sampleIntervalMs);
    }
    log('parse.stable_text_timeout', { len: lastLen, maxWaitMs });
  }

  // Запрос re-attach debugger через SW. Используется в parseLastTurn если
  // debugger отвалился между Stop и parse (race с параллельным attach в
  // другую вкладку — Chrome canceled_by_user приходит и для system events).
  async function reattachDebugger() {
    try {
      const r = await chrome.runtime.sendMessage({ __sc_debugger_attach: true });
      log('reattach.resp', r);
      return r;
    } catch (e) {
      log('reattach.err', { err: e?.message || String(e) });
      return { ok: false };
    }
  }

  async function parseLastTurn({ maxScrollWaitMs = 2500 } = {}) {
    // Дать DOM стабилизироваться перед парсингом — иначе на коротких
    // ответах Flash ловим partial stream (см. #76).
    await waitForStableText();

    // AI Studio иногда возвращает "An internal error has occurred." —
    // backend ошибка (не наш bug), часто на коротких prompts с моделями
    // в preview. Detect раньше parseLastTurn чтобы вернуть осмысленный
    // error, не "no response text found".
    const lastTurnText = (document.querySelectorAll('ms-chat-turn')?.[document.querySelectorAll('ms-chat-turn').length - 1]?.textContent || '');
    if (/An internal error has occurred/i.test(lastTurnText)) {
      log('parse.detected_internal_error', { sample: lastTurnText.slice(0, 200) });
      throw new Error('AI Studio: An internal error has occurred (backend-side, not extension bug)');
    }

    // Force re-attach debugger перед parse. Параллельные jobs (3-4 одновременно)
    // могут переотбирать debugger session: новая вкладка attach'ится → старая
    // получает auto_detached с reason='canceled_by_user'. Studio в hidden tab
    // без debugger демонтирует ms-text-chunk. Pre-parse re-attach гарантирует
    // что DOM материализовался прежде чем мы читаем.
    if (document.visibilityState === 'hidden') {
      log('parse.precheck.reattach_request');
      await reattachDebugger();
      // Дать Angular CD цикл после reattach чтобы chunks ре-материализовались.
      await sleep(1500);
    }

    const turns = Array.from(document.querySelectorAll('ms-chat-turn'));
    log('parse.entry', {
      turnCount: turns.length,
      visState: document.visibilityState,
      cacheSize: turnCache.size,
    });
    if (turns.length === 0) return null;

    // Идём с конца, ищем Model/Agent с контентом.
    for (let i = turns.length - 1; i >= 0; i--) {
      const turn = turns[i];
      const role = turn.querySelector('[data-turn-role]')?.getAttribute('data-turn-role');
      if (role !== 'Model' && role !== 'Agent') continue;

      // Lazy-материализация: скроллим в view и ждём чтобы хотя бы один
      // не-thought ms-text-chunk появился. Если за maxScrollWaitMs не появился —
      // вероятно турн пустой (UI feedback wrapper / no-op Agent turn), идём дальше.
      turn.scrollIntoView({ block: 'center' });
      const t0 = performance.now();
      let validChunks = [];
      while (performance.now() - t0 < maxScrollWaitMs) {
        const all = Array.from(turn.querySelectorAll('ms-text-chunk'));
        validChunks = all.filter(tc =>
          !tc.closest('ms-thought-chunk') &&
          !tc.closest('ms-thought-activity-chunk')
        );
        if (validChunks.length > 0 && validChunks.some(tc => (tc.textContent || '').trim().length > 0)) break;
        await sleep(150);
      }
      log('parse.try_turn', { i, role, validChunks: validChunks.length, turnTxtLen: (turn.textContent || '').length });
      if (validChunks.length === 0) continue;

      // ВАЖНО: innerText в hidden tab возвращает пустую строку — Blink не
      // делает reflow/layout пока вкладка скрыта, а innerText построен на
      // layout. textContent работает всегда (DOM-only, без layout). Если
      // innerText пуст — берём textContent.
      const text = validChunks
        .map(tc => {
          const it = (tc.innerText || '').trim();
          return it || (tc.textContent || '').trim();
        })
        .filter(Boolean)
        .join('\n\n');
      if (!text) continue;

      // ── Сбор ссылок ───────────────────────────────────────────────
      const linkMap = new Map(); // href → {title, source}

      function pushLink(a, source) {
        const href = a.href || '';
        // grounding-источники пропускаем, UI-навигацию режем (см. isNoiseLink).
        // Старый фильтр резал vertexaisearch.cloud.google.com (хост *.google.com)
        // вместе с навигацией → реальные источники терялись.
        if (isNoiseLink(href)) return;
        if (linkMap.has(href)) return;
        const title = (a.textContent || a.getAttribute('aria-label') || '').trim().slice(0, 200);
        linkMap.set(href, { href, title, source });
      }

      // 1) inline-ссылки в markdown'е валидных chunk'ов
      for (const tc of validChunks) {
        for (const a of tc.querySelectorAll('a[href]')) pushLink(a, 'inline');
      }
      // 2) Search entry-point footnotes — DR/Pro со включенным grounding'ом
      for (const a of turn.querySelectorAll('ms-search-entry-point a[href], ms-tool-activity-chunk a[href]')) {
        pushLink(a, 'search');
      }
      // 3) Catch-all — все <a href> внутри turn'а (на случай новой DOM-структуры).
      //    Фильтр noise-host'ов сверху не пустит google-внутренние.
      for (const a of turn.querySelectorAll('a[href]')) pushLink(a, 'turn');

      const links = [...linkMap.values()].slice(0, 50);
      return { text, links, role, turnIdx: i };
    }

    // Fallback: live DOM пуст (hidden-tab demount). Читаем из turnCache
    // — там snapshot который MutationObserver захватил пока chunks были
    // в DOM.
    log('parse.live_dom_empty.try_cache', { cacheSize: turnCache.size });
    const fromCache = readLastFromCache();
    if (fromCache) {
      log('parse.fromCache.ok', { textLen: fromCache.text.length, linksN: fromCache.links.length });
      return fromCache;
    }
    log('parse.fail_no_cache', {
      cacheSize: turnCache.size,
      cacheEntries: [...turnCache.entries()].map(([id, e]) => ({ id, role: e.role, textLen: (e.textParts.join('') || '').length, links: e.links.size })),
    });
    return null;
  }

  // ── public API ────────────────────────────────────────────────────────

  // Re-run last turn через sparkle-button "Rerun this turn" — AI Studio
  // ставит её на любой User-turn'е при hover. Используется как retry-механизм
  // после backend error: не нужно делать location.reload(), вообще не нужно
  // менять prompt, просто кликаем «повторить отправку этого turn'а».
  // Rerun-кнопка живёт в `.actions.hover-or-edit` с opacity:0 + pointer-events:none
  // — она кликабельна ТОЛЬКО под курсором (CSS :hover). Доказано детерминированно
  // (elementFromPoint в центре кнопки возвращал DIV-контейнер; btn pointer-events:
  // none; после force opacity:1+pe:auto → hitsButton:true). Ни synthetic, ни
  // CDP-trusted клик по координате не срабатывали — событие падало в occluder/
  // disabled-кнопку. Юзер вручную попадал, потому что реальная мышь даёт :hover.
  //
  // Фикс: инжектим CSS-правило, форсящее .hover-or-edit видимой+кликабельной
  // (детерминированно, без зависимости от hover-таймингов). Маркируем целевой
  // турн data-sc-rerun-pin, правило снимает gate только с него. Потом клик
  // (synthetic достаточно — pointer-events уже auto). Снимаем маркер в finally.
  let __rerunPinStyle = null;
  function ensureRerunPinStyle() {
    if (__rerunPinStyle && __rerunPinStyle.isConnected) return;
    __rerunPinStyle = document.createElement('style');
    __rerunPinStyle.id = 'sc-rerun-pin-style';
    // Снимаем hover-gate с actions ВНУТРИ помеченного турна: видимость +
    // pointer-events на контейнере И на самой кнопке.
    __rerunPinStyle.textContent =
      '[data-sc-rerun-pin] .actions.hover-or-edit{opacity:1 !important;pointer-events:auto !important;}' +
      '[data-sc-rerun-pin] button[aria-label="Rerun this turn"]{pointer-events:auto !important;}';
    (document.head || document.documentElement).appendChild(__rerunPinStyle);
  }
  async function rerunLastTurn(promptForResubmit) {
    // Найти все Rerun-кнопки. Они рендерятся для каждого user-turn'а, но
    // активна только последняя (предыдущие говорят "Finish editing previous
    // turns to rerun"). Берём именно selector с aria-label="Rerun this turn".
    const buttons = Array.from(document.querySelectorAll('button[aria-label="Rerun this turn"]'));
    if (!buttons.length) {
      // Antigravity: error-turn НЕ имеет кнопки Rerun (только Edit/Open options,
      // в меню — Delete/Copy, без Rerun). Доказано на живой error-вкладке.
      // Для агента «повторить» = заново вставить prompt в композер и нажать Run.
      // Юзер так и делал руками (1й error → перезапуск → ok). Нужен prompt.
      if (promptForResubmit) {
        log('rerun.no_button_resubmit', { promptLen: promptForResubmit.length });
        await pastePromptAndRun(promptForResubmit);
        return;
      }
      throw new Error('rerun: button not found');
    }
    // Берём последнюю (нижнюю на странице) — она же для last user-turn'а.
    const btn = buttons[buttons.length - 1];
    const turn = btn.closest('ms-chat-turn') || btn.parentElement;
    // Комбо из ДВУХ необходимых условий (по отдельности не работает):
    //   1. CSS-pin снимает hover-gate (.actions.hover-or-edit opacity:0+pe:none) →
    //      кнопка становится hit-target'ом (без этого клик падает в occluder).
    //   2. TRUSTED клик (isTrusted=true) даёт user-activation, которую backend
    //      AI Studio теперь требует для submit (synthetic → мгновенный 500).
    ensureRerunPinStyle();
    try { turn.setAttribute('data-sc-rerun-pin', '1'); } catch {}
    await sleep(120); // дать CSS применить opacity/pe + layout settle перед rect
    try {
      const tr = await trustedClick(btn);
      if (!tr || tr.ok !== true) {
        // Нет debugger / координат — деградируем на synthetic (хотя бы turn создаст).
        log('rerun.trusted_failed_fallback_synthetic', tr || {});
        await mainWorldClick(btn);
        log('rerun.clicked', { via: 'synthetic_pinned' });
      } else {
        log('rerun.clicked', { via: 'trusted_pinned' });
      }
    } finally {
      try { turn.removeAttribute('data-sc-rerun-pin'); } catch {}
    }
  }

  window.scAistudio = {
    KNOWN_MODELS,
    resolveModel,
    ensureSettingsPanelOpen,
    ensureVisualizationOff,
    ensureModel,
    setSystemInstruction,
    pastePromptAndRun,
    submitPromptAsNewMessage,
    rerunLastTurn,
    ensurePaidKeyLinked,
    waitForCompletion,
    parseLastTurn,
    detectBackendError,
    startTurnCacheObserver,
    readLastFromCache,
    // expose helpers for autoscrape (legacy code may want them)
    sleep,
    waitFor,
    setReactValue,
  };

  log('scAistudio API attached', {
    models: KNOWN_MODELS.length,
    href: location.href.slice(0, 80),
  });
})();
