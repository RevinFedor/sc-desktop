# Knowledge: ChatGPT automation (research + compose + export)

`browser-extension/chatgpt-research.js` содержит общий низкоуровневый compose-layer
для chatgpt.com и три разных entrypoint'а. Research-провайдер поверх общего канала
`fact-deep-research.md` идёт как `/research-start` → CS → `/research-state`: watcher
ответа, keepalive, recovery через window.name/tabId, парсинг «Источников» и сохранение
результата в bridge. YouTube `+ ai → ChatGPT` идёт через `?sc-compose=<id>`:
background кладёт prompt/model/effort в `chrome.storage.local`
`__sc_chatgpt_compose_job_*`, CS выбирает модель/effort, вставляет текст, ждёт готовности
document-loader'а и нажимает Send. В compose-ветке **нет MCP-badge, нет парсинга правой
панели «Источники», нет `/research-state` и нет записи в историю MCP** — результат
остаётся обычным ChatGPT-чатом для пользователя. Третий вход — popup export на
`/c/<conversation-id>`: расширение собирает текущую ветку чата в markdown и доставляет
её в clipboard/файл; это не research job и не compose handoff.

## YouTube `sc-compose`: независимые Chat и Work

YouTube-пересказ может идти в двух режимах ChatGPT: `chat` или `work`. У каждого
режима свои модель и уровень рассуждения: переключение режима не должно молча
переносить выбор из соседнего режима. В момент клика `+ ai` расширение фиксирует
весь набор следующего запуска — режим, модель, уровень и промпт. Поэтому правка
настройки, пока видео уже транскрибируется, влияет только на следующее видео.

Compose сначала подтверждает выбранный режим, затем модель, затем уровень, ждёт
готовность вставленного текста и лишь после этого нажимает Send. Вкладка ChatGPT
создаётся в фоне; эмуляция фокуса поддерживает рендер страницы, но не переводит
фокус браузера или операционной системы к пользователю. После подтверждённого
Send запись handoff удаляется, чтобы повторный запуск content-script не отправил
тот же запрос второй раз.

Постоянные настройки YouTube-handoff принадлежат только popup расширения (`__yt`).
Форма «Новый research» в SC Desktop держит аналогичные поля лишь как ручной
per-run запуск для проверки ChatGPT; она не читает и не перезаписывает настройки
YouTube. Это две разные точки входа, а не два редактора одного состояния.

## Задача и исходный материал — разные каналы

`chatgpt_prompt` сначала попадает в composer отдельной первой секцией пользовательского
ввода `Задача:`. Транскрипт и комментарии остаются исходным материалом: при выключенном
`chatgpt_show_in_text_field` это `.txt`-вложение, при включенном ChatGPT может
сначала показать chip «Вставленный текст», а затем развернуть его в composer.
Переключатель меняет только способ показа материала, но никогда не переносит
задачу внутрь документа. Иначе ChatGPT видит файл без явного действия и спрашивает,
что с ним сделать.

Развёрнутый материал начинается с явной границы «Исходный материал», говорит
следовать задаче выше и не исполнять инструкции из блока; сам текст заключён в
backtick-fence длиннее любого backtick-run внутри транскрипта. Это разделяет
команду пользователя и недоверенные данные, а не полагается на порядок строк.

Кнопка «Показать в текстовом поле» у ChatGPT может быть hover-only: синтетические
DOM-события вызывают JS-listener'ы, но не включают CSS `:hover`. Поэтому content-script
запрашивает у background настоящее `mouseMoved` через `chrome.debugger`; только затем
пробует click. Если интерфейс помечает материал как слишком длинный для поля, chip
остаётся вложением, prompt уже лежит в composer, а handoff проверяет, что chip не
исчез до Send. Это штатный путь, не ожидание несуществующей кнопки.

## Параметры job'а

- **`options.mode`** — `chat` или `work`. У YouTube каждая из этих пар хранится
  отдельно, поэтому переключение не переносит модель и интеллект между режимами.
- **`options.model`** — в `chat`: `5.5` (GPT-5.5 Instant) или `5.6-sol`; в `work`:
  `5.6-sol`, `5.6-terra` или `5.6-luna`. Старые `5.4/5.3/5.2/4.5/o3` при чтении
  настроек нормализуются к текущей паре, а числовой legacy-id `5.6` означает Sol.
  **ChatGPT запоминает модель per-аккаунт**, поэтому CS верифицирует её на каждом
  запуске, а не считает дефолт уже выбранным.
- **Модель выбирается ПЕРЕД уровнем интеллекта** — состав уровней зависит от модели
  и смена модели может сбросить уровень.
- **`options.effort`** — для `chat/5.5` только `instant`; для `chat/5.6-sol`:
  `medium/high/xhigh/pro`; для `work`: `low/medium/high/xhigh/max/ultra`.
  «Очень высокий» = `xhigh`. Pro остаётся двухслойным меню: верхний Pro и его detail
  проверяются отдельно, потому что checked detail при выключенном верхнем Pro не означает
  активный режим. Legacy `pro-extended` нормализуется к `pro` в настройках.
- **`options.sources`** (default false, только research-ветка) — включать ли блок источников в `result.text`.
  Источники **парсятся всегда** и лежат в `result.sources[{url,title}]`; activity/tool
  steps из правой панели ChatGPT лежат в `result.source_activity[]` и дублируются в
  `result.sources_meta.activity_items[]` вместе с `activity`/thinking-таймингами. Флаг
  управляет только текстовой презентацией, не сбором. Принцип —
  `methodology/переносимый-дизайн.md::Сбор данных ≠ выдача`.
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
- **`options.keepTab` / `options.autoClose === false`** — не закрывать вкладку после
  подтверждённого terminal done в research-ветке. YouTube `+ ai → ChatGPT` больше не
  использует этот флаг: для него вкладка остаётся открытой по природе `sc-compose`
  handoff'а, потому что CS после Send не извлекает ответ и не делает terminal teardown.

Выбор режима, модели и уровня — verify-and-retry: после клика меню переоткрывается и читается
`aria-checked` только у видимых menu-нóд (ChatGPT оставляет stale-ноды от закрытых меню;
текст pill'а лагает — живой probe: после клика Instant pill ещё показывал «Pro»).
Для `pro/pro-extended` verify читает верхний `Pro` и detail-radio отдельно.
Провал выбора режима, модели **или уровня** фатальный
(`chatgpt_mode_select_failed` / `chatgpt_model_select_failed` /
`chatgpt_effort_select_failed`): молчаливый запрос со sticky-настройкой аккаунта хуже
честной ошибки, потому что пользователь явно выбрал другую конфигурацию.

`~/.claude/skills/external-research/SKILL.md` задаёт другой, вызывающий дефолт для
bridge-job'ов: `work` + `5.6-sol` + `max`. Он не меняет сохранённые YouTube-настройки
и не должен неявно синхронизироваться с ручной формой SC Desktop; у обеих поверхностей
свои явно видимые параметры.

Текст ответа не является источником истины о версии: модель может назвать себя иначе.
Подтверждение — проверка выбранного menu-radio и bridge-лог выбора, не self-report.

## Popup export текущего чата

Popup export запускается только когда активная вкладка уже на `chatgpt.com/c/<id>`.
Главный контракт — **API-first, DOM fallback**. Через `/api/auth/session` берётся
access token текущей страницы, потом `fetch('/backend-api/conversation/<id>')` возвращает
`mapping` и `current_node`. Ветка строится от `current_node` к корню по `parent`, затем
разворачивается в пользовательский порядок. Это защищает от виртуализации: в проверочном
чате 2026-07-03 visible DOM давал 44 turn'а, а API — 235 nodes / 227 nodes в current path /
150 значимых записей. Поэтому DOM-only exporter выглядел бы рабочим на коротких чатах и
молча терял бы большую часть длинного диалога.

API-path собирает user messages, final assistant messages, reasoning/thinking, tool/code
activity и вложения. File citations вида `source: my_files` без URL не считаются web
sources: это пользовательские/ChatGPT-файлы внутри conversation, в markdown они остаются
как вложения или цитаты. Web source появляется только когда есть реальный `http(s)` URL.
DOM fallback остаётся нужен для случаев, когда backend API недоступен или формат поменялся:
он скроллит видимые сообщения и может открыть right-side sources panel, но не должен быть
единственным источником истины на длинных чатах.

Экспорт определяет режим из данных беседы: Work получает свой заголовок и путь
`chatgpt-work`, а не маскируется под обычный чат. API-path сохраняет актуальную
ветку, включая Work-специфичные summary рассуждений; DOM fallback остаётся только
деградацией, потому что видимый список может быть виртуализирован.

Доставка результата повторяет общий принцип browser-extension: текстовый markdown сначала
идёт в clipboard, файл — только по `downloadFile=true`. Особый шрам ChatGPT popup export:
`navigator.clipboard.writeText` может падать с `Document is not focused`, потому что popup
инициирует экспорт, а документ страницы уже не в фокусе. Поэтому после `writeText` обязан
быть DOM fallback через временный textarea + `document.execCommand('copy')`; если оба пути
заблокированы, exporter скачивает `.md` как последнюю деградацию, а не завершает экспорт
красной ошибкой.

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

**Открытое ограничение (2026-08).** Chrome может сразу снять debugger с причиной
`canceled_by_user`; это системный код Chrome, а не доказательство ручной отмены или
проблемы соседней вкладки. `onDetach` делает best-effort reattach, но открытие вкладки
сейчас всё ещё возвращает успех, если attach не пережил старт. В трёх подтверждённых
compose-job'ах CS загрузился с `visibility:hidden`, затем через 120 секунд выдал
`chatgpt_composer_not_ready_after_paste`, хотя Send уже был виден и не был занят.
Это известная дыра в проверке фоновой готовности, а не повод открывать вкладку active.
Будущий ремонт должен подтвердить удержание emulation до paste/submit и иметь
background-safe путь проверки composer'а; точный источник auto-detach пока не установлен.

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

Research-ветка всегда парсит правую панель как часть terminal result. Popup export тоже
может собрать sources/activity, но сначала через backend conversation API; DOM/right-panel
парсинг для него — fallback. Compose/handoff для YouTube не трогает эту панель: если после
`+ ai → ChatGPT` справа открылась «Детали рассуждения/Источники» или появился бейдж
`MCP · CHATGPT`, значит YouTube снова ошибочно пошёл через high-level research-пайплайн,
а не через reusable compose-layer.

Чип `button[aria-label="Источники"]` в action-bar ответа → клик → справа
`section[aria-label="Детали рассуждения"]`: активность (`Активность · 2m 20s`),
thinking-блоки («Думал на протяжении X» — RU/EN), заголовок «Источники · N», ссылки,
а у agentic ChatGPT ещё activity/tool steps: «Получение исходного кода с GitHub»,
«Тестирование загрузки данных с GitHub», `bash -lc ...`, Python snippets, output/error.

- **Список виртуализирован**: панель показывала «Источники · 47», в DOM было 8 `<a>`.
  Сбор — скроллим scrollable-контейнер панели шагами, собирая новые ссылки на каждом
  шаге; на тех же шагах собираем activity items, потому что они тоже могут быть ниже
  первого viewport'а. Стоп — два шага без новых ссылок или дно.
- `textContent` панели склеивает блоки **без `\n`** — regex activity с жадным хвостом
  заглатывал весь протокол (1000+ симв); нужен нежадный матч с жёстким cap длины.
- Activity/tool steps не равны URL-источникам. Пример живого DOM: шаг
  `Тестирование загрузки данных с GitHub` содержит `pre/code` с командой
  `bash -lc python3 ... urllib.request ... raw.githubusercontent.com ...` и stdout/stderr
  под тем же блоком. Это сохраняется как
  `{title, links?, command?, text?}` в `result.source_activity[]`.
- Ссылки фильтруются от внутренней навигации только по `chatgpt.com`/subdomains и
  `chat.openai.com`; **не** фильтровать весь `openai.com`, иначе реальные источники
  `developers.openai.com` пропадают. Дедуп по href.
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

**Длинная вставка может стать document-loader'ом.** На реальном YouTube-пересказе
длинный prompt после paste не сразу становится обычным текстом в composer: ChatGPT
показывает карточку вроде «Вставленный текст» и на время загрузки выключает input/Send.
Клик по Send раньше этого момента даёт внешний симптом «ничего не отправилось»:
composer ещё disabled, а job потом ждёт stop-button до submit timeout.

Нельзя лечить это `sleep(800)` или другим guessed delay: размер текста, аккаунт и
состояние ChatGPT меняют длительность loader'а. После paste нужно ждать реальные
маркеры готовности composer'а: Send видим и enabled, editor не disabled/contenteditable=false,
нет `aria-busy`, progressbar/loader/spinner и текстовых признаков uploading/loading.
В реализации это `MutationObserver` + `requestAnimationFrame`; `setTimeout` остаётся
только аварийным ceiling'ом, который должен завершить job ошибкой с диагностикой, а
не «подождать на всякий случай». В hidden-вкладке `requestAnimationFrame` сам по себе
не является драйвером проверки: если emulation слетела, observer может видеть изменения,
но scheduled check не выполнится. Симптом `sendVisible:true` при timeout означает именно
эту рассинхронизацию, не обязательно незагруженный composer.

**Done-сигнал ≠ результат сохранён.** Живой кейс `ryccfz` был именно chatgpt-job:
`watcher.done` сработал, ответ готов в браузере, но финальный `status=done` не долетел
до bridge и job завис `running` на 10+ часов. Поэтому done-хендлер пишет финал через
`postTerminalState` (подтверждение + ретрай) и закрывает вкладку **только** после
подтверждения. Механика и почему гонка с tab-closed fallback не спасала —
`fact-deep-research.md::Терминальный статус подтверждается перед teardown'ом`.

Вторая форма того же симптома — **terminal POST слишком большой**, а не потерянный:
`rja1mjv8…` и `rkkhjzer…` дошли до `gpt.watcher.done {hasAnswer:true}`, но
`/research-state` отклонял финальный JSON как `request body too large`
(`129233 > 65536`, `77152 > 65536`). Причина — ChatGPT agentic/research result
несёт не только `answer_text`, но и `sources`, `source_activity`, code/output snippets
из правой панели. Ретраи `postTerminalState` в таком случае не лечат — payload
детерминированно больше лимита. Bridge лимит для `/research-state` поднят адресно
до 5MB; не переносить большие sources/activity в `/research-log` и не обрезать их
ради прохождения 64KB, иначе история MCP снова потеряет структурированный result.

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

Лимит картинок живёт на `/research-artifact`, не на `/research-state`: JSON/base64
transport до 30MB, decoded-файл до 25MB. Поэтому image-flow не является аргументом
поднимать state-limit бесконечно или класть base64 в `result.images[]`; state несёт
только descriptors.

`result.text_kind = "image"` и `result.is_image = true` ставятся если есть хотя бы одна
сохранённая картинка. `answer_text` при этом может быть пустым — это нормальный image-only
ответ, а не ошибка extract'а. UI обязан показывать `result.images`, а не считать пустой
текст пустым результатом; см. `fact-research-ui.md::История MCP в SQLite`.

## Связано

- `fact-deep-research.md` — общий канал, recovery, чеклист добавления провайдера
- `fact-browser-extension.md::Поток данных (ChatGPT)` — popup export текущего `/c/<id>`
- `fact-research-ui.md` — форма ручного запуска (таб ChatGPT: Модель/Интеллект/Источники)
- `fact-asset-protocol.md` — `sc-asset://research-artifacts/...` для input/output картинок
- `fact-aistudio-mcp.md::studio-ready` — первоисточник focus-pulse эскалации
- `fact-browser-tab-marking.md` — пометка вкладки `chatgpt-parser`
- `methodology/переносимый-дизайн.md::Hidden tab деградирует слоями` — переносимая лестница
- `~/.claude/skills/external-research/SKILL.md` — секция 🟢 ChatGPT (effort-таблица, Pro vs xhigh)
