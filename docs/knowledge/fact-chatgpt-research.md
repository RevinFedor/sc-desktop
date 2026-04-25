# Knowledge: ChatGPT-провайдер research (chatgpt.com)

Четвёртый research-провайдер поверх общего канала `fact-deep-research.md` (тот же
`/research-start` → CS → `/research-state`, тот же watcher-паттерн, keepalive, recovery
через window.name/tabId). Здесь — только chatgpt-специфика: параметры, шрамы фоновой
вкладки, парсинг «Источников». CS — `browser-extension/chatgpt-research.js`.

## Параметры job'а

- **`options.model`** — `5.5` (default) / `5.4` / `5.3` / `5.2` / `4.5` / `o3`. Пункт
  «GPT-5.5» в меню composer-pill'а — сабменю с radio (текст триггера = текущая модель).
  **ChatGPT запоминает модель per-аккаунт** — поэтому CS верифицирует модель на КАЖДОМ
  запуске, а не «скип если просили дефолт»: прошлый job мог оставить o3, и «дефолтный»
  запуск ушёл бы не на ту модель.
- **Модель выбирается ПЕРЕД уровнем интеллекта** — состав уровней зависит от модели
  (у o3/4.5 другой набор пунктов), и смена модели может сбросить уровень.
- **`options.effort`** — `instant/medium/high/xhigh (default)/pro/pro-extended`.
  Плоские уровни — radio прямо в меню. Pro-режим двухслойный: сначала верхнеуровневый
  radio `Pro` включает сам режим, потом в сабменю
  `[data-testid="composer-intelligence-pro-thinking-effort-trigger"]` выбирается деталь
  `Pro стандартный` / `Pro расширенный` (submenu раскрывается hover, click — страховка).
  Живой шрам: `Pro стандартный` может быть `aria-checked=true`, но верхний `Pro` при этом
  `false`; pill остаётся «Очень высокий», и запрос уходит не в Pro. Поэтому verify обязан
  проверять оба уровня. «Очень высокий» = xhigh из Codex CLI; Pro-режимы — эксклюзив
  тарифа Pro, в CLI недоступны, но для нашего асинхронного канала идеальны (мы поллим).
- **`options.sources`** (default false) — включать ли блок источников в `result.text`.
  Источники **парсятся всегда** и лежат в `result.sources[{url,title}]` +
  `result.sources_meta` (activity, thinking-тайминги) — флаг управляет только текстовой
  презентацией, не сбором. Принцип — `methodology/переносимый-дизайн.md::Сбор данных ≠ выдача`.
- **`attachments` / `files`** — локальные изображения для upload в composer. Поддержано
  только для `provider:"chatgpt"`: bridge валидирует MIME/размер, копирует файл в
  `LIB_ROOT/research-artifacts/<jobId>/input/`, а CS забирает bytes через
  `/research-attachment` и кладёт `File` в `#upload-photos` / image file input. Копия
  в `LIB_ROOT` важна не только для upload'а: история должна пережить удаление исходника
  из Desktop-папки и показать, что именно было отправлено.
- **`conversationUrl` / `continueUrl` / `url`** — продолжение существующего ChatGPT-чата
  `https://chatgpt.com/c/<conversation-id>`. Bridge нормализует URL, добавляет
  `?sc-research=<id>#sc-research=<id>` и открывает тот же conversation вместо нового
  чата. Это контракт для follow-up запросов вроде «у того изображения внеси такой-то
  комментарий»: повторный job должен попасть в тот же чат, а не создавать новый контекст.

Выбор и модели и уровня — verify-and-retry: после клика меню переоткрывается и читается
`aria-checked` только у видимых menu-нóд (ChatGPT оставляет stale-ноды от закрытых меню;
текст pill'а лагает — живой probe: после клика Instant pill ещё показывал «Pro»).
Для `pro/pro-extended` verify читает верхний `Pro` и detail-radio отдельно.
**Провал выбора МОДЕЛИ — фатальный** (`chatgpt_model_select_failed`): ChatGPT
помнит модель per-аккаунт, и молчаливый ответ прошлой sticky-моделью (o3 вместо
запрошенной 5.5) хуже честной ошибки — тот же контракт, что у claude/perplexity и у
submit-verify. Провал **уровня** (effort) — non-fatal, лог `gpt.effort.select_failed`,
едет на текущем (неточный уровень терпим, убитый job — нет).

**Модель врёт о своей версии в тексте ответа** (живой тест: выбрана 5.4, ответ «я —
GPT-5.3»). Источник истины — bridge-лог `gpt.model.selected` + verify по меню, не текст.

## Шрам: hidden tab не рендерит стрим ответа (render-freeze)

Главный шрам провайдера. В фоновой вкладке ChatGPT **не коммитит streamed-токены в DOM**:
узел `[data-message-author-role="assistant"]` существует, `textContent` пустой (0 chars),
при этом кнопки композера обновляются нормально (stop появился → ушёл). Рендер сообщений
завязан на rAF/IntersectionObserver — в hidden tab не тикают. При фокусе вкладки контент
дорисовывается мгновенно (<1с).

Симптом снаружи: `gpt.watcher.tick` показывает `stop:false, voice:true, quiet:true`
(стрим закончился), а done не наступает — `hasAnswer` всегда 0; job висит в `running`,
при клике юзера на вкладку мгновенно завершается.

**Что пробовали и почему не сработало:**
- `textContent` вместо `innerText` (шрам aistudio, `fact-aistudio-mcp.md`) — не помогло:
  там layout не строился при готовом DOM, здесь **сам DOM пустой**.
- `autoDiscardable:false` — не помогает: это защита от discard, а рендер-freeze не discard.
- Ждать дольше — бесконечно: DOM не догонит, пока вкладка не станет visible.

**Основное решение (актуальное): `attachFocusEmulation` при открытии вкладки.**
`mcp_open_research_tab` сразу после `chrome.tabs.create` зовёт `attachFocusEmulation(tabId)`
(`chrome.debugger.attach` + `Emulation.setFocusEmulationEnabled`) — держит
`Page::IsPageVisible()=true` на C++ уровне → rAF тикает в фоне → ChatGPT коммитит
стрим в DOM **без всякого фокуса**, watcher видит текст сразу. Это глобальный паттерн
для всех automation-вкладок (не chatgpt-частность), `background.js::SC_FOCUS_EMULATION_URL`.
Механика и почему JS-override не работает — `fact-aistudio-mcp.md::Hidden-tab strategy`,
архитектурный обзор слоёв — `fact-deep-research.md::Фоновая вкладка замерзает`.

Живой кейс, доказавший недостаточность прежнего подхода (`rm6equid`, pro-режим): при
деактивации **всего браузера** на часы autoDiscardable стоял, а вкладка всё равно
замёрзла на 9.5 минут (48 тиков за 577с), done — только от ручного клика юзера. После
emulation того же класса джоб тикает раз в ~0.3с с `vis:visible` в фоне.

**Focus-pulse — теперь dormant-fallback** (механика как `__sc_focus_self` у
aistudio-mcp studio-ready). При живой emulation render-freeze'а нет и пульс не
срабатывает; остаётся на случай, если `attachFocusEmulation` упал (circuit-breaker,
debugger занят):
1. Watcher: стрим закончился (stop ушёл + quiet 3с), а `readAnswerText()` пуст →
   однократный `escalateFocus()` — SW делает вкладку активной, запоминает prevTabId.
2. Done-handler: если `document.visibilityState === 'hidden'` перед extract —
   ещё один пульс. Без этого extract читал **частичный** DOM (живой тест: 55 символов
   из полного ответа + «Источники»-чип не дорисован) — стабилизация длины ложно
   проходила, потому что замороженный DOM не растёт.
3. После done/timeout — `restoreFocus()` возвращает юзера на prevTabId.

У thinking-ответов (xhigh/pro) в сообщении ДВА `.markdown`: сводка рассуждений
(`.result-thinking.markdown`, идёт первым) и финальный ответ — thinking исключается
фильтром класса, иначе в text попадает протокол рассуждений вместо ответа.

## Шрам: LNA-диалог браузера блокирует fetch к bridge

Chromium 138+ (Local Network Access): сайт, фетчащий `127.0.0.1`, требует разрешения
юзера — «Сайт chatgpt.com запрашивает разрешение на доступ к другим приложениям и
сервисам». Для claude/perplexity разрешение давно выдано; **новый провайдер = новый
origin = новый диалог**. Пока юзер не нажал «Разрешить»:

- все `fetch` CS к bridge **молча таймаутятся** (probe: `/healthz` 5с+ без ответа,
  без CORS-ошибки в консоли);
- симптом в логах: `cs.boot`/`main.start` есть в DOM-логе вкладки, но job застрял в
  `queued` навсегда (fetchJob висит), в bridge-логе от CS — тишина, при этом SW-события
  (`sw.tab.onUpdated`) приходят — канал SW→bridge живёт, канал page→bridge нет;
- диалог показывается только когда вкладка **активна** — фоновый research его не
  увидит; юзер замечает при случайном переключении на вкладку.

Разрешение одноразовое per-origin. **Вторая форма отказа** (claude-кейс): юзер когда-то
нажал «Блокировать» → `permissions.query({name:'local-network-access'})` = `denied`,
fetch падает мгновенным TypeError (~12мс), диалог больше не показывается вовсе.
Проверка состояния — именно `permissions.query`, не консоль (ошибки нет).

Системное решение (после claude-инцидента) — `window.scBridgeFetch`: page-fetch с
4с-таймаутом → sticky SW-fallback, которому LNA не указ. Все три CS переведены на него;
LNA-диалог больше не фатален ни в одной форме. См. `fact-deep-research.md::Канал CS→bridge`.

## Парсинг «Источников» (правая панель)

Чип `button[aria-label="Источники"]` в action-bar ответа → клик → справа
`section[aria-label="Детали рассуждения"]`: активность (`Активность · 2m 20s`),
thinking-блоки («Думал на протяжении X» — RU/EN), заголовок «Источники · N», ссылки.

- **Список виртуализирован**: панель показывала «Источники · 47», в DOM было 8 `<a>`.
  Сбор — скроллим scrollable-контейнер панели шагами, собирая новые ссылки на каждом
  шаге; стоп — два шага без новых или дно.
- `textContent` панели склеивает блоки **без `\n`** — regex activity с жадным хвостом
  заглатывал весь протокол (1000+ симв); нужен нежадный матч с жёстким cap длины.
- Ссылки фильтруются от внутренней навигации (`chatgpt.com|openai.com`), дедуп по href.
- Панель закрывается после сбора (кнопка «Закрыть») — она перекрывает чат.
- `is_research` = есть ли собранные web-ссылки (аналог research-маркера других провайдеров).

## Submit и done-detection

Кнопка композера — 3 состояния (спарсено с живого DOM, юзер подтвердил модель):
**голосовой режим** (композер пуст) → **отправить** (`[data-testid="send-button"]`,
появляется только при непустом композере — появление = paste принят) → **остановить**
(`[data-testid="stop-button"]`, стримит). Done = stop ушёл + quiet 3с + есть текст ответа
или новый generated image container после pre-submit baseline.
Paste — ClipboardEvent + DataTransfer в ProseMirror `#prompt-textarea` (как Lexical у
Perplexity, execCommand из isolated world игнорируется). Если stop не появился за 120с —
терминальная ошибка `chatgpt_submit_failed` (paste в пустоту / логин-волл).

**Done-сигнал ≠ результат сохранён.** Живой кейс `ryccfz` был именно chatgpt-job:
`watcher.done` сработал, ответ готов в браузере, но финальный `status=done` не долетел
до bridge и job завис `running` на 10+ часов. Поэтому done-хендлер пишет финал через
`postTerminalState` (подтверждение + ретрай) и закрывает вкладку **только** после
подтверждения. Механика и почему гонка с tab-closed fallback не спасала —
`fact-deep-research.md::Терминальный статус подтверждается перед teardown'ом`.

URL вкладки: `chatgpt.com/?sc-research=<id>#sc-research=<id>` — query + дубль в hash
(SPA срезает query при pushState на `/c/<uuid>`; hash страхует ре-инжект CS до того как
window.name установлен).

## Картинки: input upload и generated output

ChatGPT image-flow отличается от текстового research тем, что успешный ответ может вообще
не иметь markdown-текста. Для запроса «измени картинку и верни только изображение» финальный
turn рендерится как `div[id^="image-"]` с `<img src="/backend-api/estuary/content?...">`,
а `.markdown` ответа пустой. Старое условие `done = stop ушёл + quiet + есть текст` висело
в `running` бесконечно, хотя кнопка Stop уже стала обычной Send/Voice. Поэтому done watcher
считает финалом **текст ИЛИ новые generated image containers** после baseline, снятого до
submit'а. Loader/stop-state остаётся тем же, что у обычного чата: Send → Stop → Send/Voice,
но критерий результата multimodal.

Generated image не хранится в `result_json` как base64. CS скачивает estuary `src`,
конвертирует в base64 только на время POST `/research-artifact`, bridge пишет файл в
`LIB_ROOT/research-artifacts/<jobId>/...` и возвращает компактный descriptor
`{file_path,name,bytes,content_type}`. В `result.images[]` лежит только descriptor; renderer
потом строит `sc-asset://research-artifacts/...`. Это тот же принцип, что для входных
attachments: история хранит локальный артефакт, а не ссылку ChatGPT CDN, которая может
истечь или стать недоступной без сессии.

`result.text_kind = "image"` и `result.is_image = true` ставятся если есть хотя бы одна
сохранённая картинка. `answer_text` при этом может быть пустым — это нормальный image-only
ответ, а не ошибка extract'а. UI обязан показывать `result.images`, а не считать пустой
текст пустым результатом; см. `fact-research-ui.md::История MCP в SQLite`.

## Связано

- `fact-deep-research.md` — общий канал, recovery, чеклист добавления провайдера
- `fact-research-ui.md` — форма ручного запуска (таб ChatGPT: Модель/Интеллект/Источники)
- `fact-asset-protocol.md` — `sc-asset://research-artifacts/...` для input/output картинок
- `fact-aistudio-mcp.md::studio-ready` — первоисточник focus-pulse эскалации
- `fact-browser-tab-marking.md` — пометка вкладки `chatgpt-parser`
- `methodology/переносимый-дизайн.md::Hidden tab деградирует слоями` — переносимая лестница
- `~/.claude/skills/external-research/SKILL.md` — секция 🟢 ChatGPT (effort-таблица, Pro vs xhigh)
