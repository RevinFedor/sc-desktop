# Knowledge: UI запуска и истории research в sc-desktop

Renderer-сторона external-research: форма ручного запуска, попап активных, История MCP,
страница джобы. Механика самих research-каналов — `fact-deep-research.md` (claude/perplexity)
и `fact-aistudio-mcp.md` (AI Studio). Здесь — только UI-слой и его связи.

## Форма «Новый research» (NewResearchScreen)

Запуск research'а руками из приложения, без нейронки. Вход — **плюс-зона** композит-кнопки
«Запущенные MCP» в TitleBar (`[+ | Запущенные MCP | История]`) → `pushScreen('new-research')`.
Отдельная широкая кнопка «+ Новый research» убрана — создание research'а живёт внутри той же
кнопки, что и его текущие/прошлые состояния (см. `переносимый-дизайн.md::Композит-кнопка`).
Trail канонический `Главная › Новый research` (см. `fact-navigation.md::Канонический trail`);
crumbFor даёт label «Новый research».

Структура (provider-табы сверху, поля меняются под провайдер):
- **Claude** — Модель («Авто (как в аккаунте)» + 7 моделей claude.ai) + Effort
  (model-зависимый список, прячется у Haiku/Opus 3) + чекбоксы Research (default on,
  заблокирован с пометкой «нет на Opus 3») и Thinking/Extended (подпись от модели).
  «Авто» = options без model/effort/thinking вовсе (CS не трогает селекторы страницы).
  **Thinking выключен → Effort-селект disabled и effort не отправляется** (effort —
  глубина thinking'а; юзер: «если thinking-переключатель выключен, логично, что
  disabled будет селект»). Реестр моделей/уровней — `fact-claude-research.md::Параметры`.
- **Perplexity** — Режим (Поиск/Глубокое) + Модель. Модель показывается **только в режиме
  «Поиск»**: в «Глубоком» Perplexity сам управляет моделью, селектора на странице нет
  (детерминированность — не показывать выбор которого нет). Список моделей — живой из
  `GET /pplx-models` (фолбэк на статический если реестр ещё не зарегистрирован).
- **AI Studio** — Модель (фиксированный список Gemini/DR из реестра).
- **ChatGPT** — Модель (5.5/5.4/5.3/5.2/4.5/o3) + Интеллект (instant…pro-extended,
  default xhigh) + чекбокс «Источники в ответе». Зеркала реестров CS — см.
  `fact-chatgpt-research.md::Параметры`.

**Запуск — через main-process IPC (`window.api.researchStart/Status/PplxModels`), НЕ
прямым fetch'ем на bridge.** Renderer не может фетчить `127.0.0.1:53127`: его origin
(`localhost:5156` в dev, `file://` в prod) не в CORS-allowlist'е bridge'а, и добавлять
его туда нельзя (`file://` даёт null-origin, который allowlist'ить небезопасно). Прямой
fetch падает «Failed to fetch» ещё до сети. Симптом, с которого нашли: юзер «Cmd+Enter
в инпуте не активирует кнопку отправки» — обработчик клавиш при этом срабатывал и
`submit()` вызывался, падал именно fetch; кнопка показывала «Ошибка — повторить /
Failed to fetch». Заголовок `'Origin': 'chrome-extension://internal'`, который стоял в
старом коде — мёртвый: `Origin` это forbidden header, браузер его молча выкидывает.
Предсказание «остаточные direct-fetch'и сломаются» сбылось: юзер «нажимаю Стоп —
ничего не происходит» в попапе — это был тот самый прямой fetch. Все кнопки переведены
на IPC: Стоп research'а → `research:stop` (новый `/research-stop`, job → error сразу +
закрытие вкладки), Браузер/open-url → `bridge:tabCommand` (whitelist путей
focus-tab/close-tab/open-url в main). Direct-fetch'ей из renderer'а на bridge не осталось.

Сабмит формы: **Enter** в textarea — запуск, Shift+Enter — перенос строки, Cmd/Ctrl+Enter
тоже работает. После отправки: feedback **в самой кнопке** (`Запустить →
Отправляем… → ✓ Отправлено`, фикс-ширина чтобы не дёргалась — см.
`methodology/переносимый-дизайн.md::Toast в кнопке`), prompt очищается, ссылка «открыть в Истории».

**Реактивная ошибка (`watchEarlyError`).** aistudio возвращает ошибку синхронно в ответе
`/research-start`; claude/perplexity — 200 с job-id, а ошибка (`pplx_daily_limit` и пр.)
прилетает позже через `/research-state`. Чтобы форма показала ошибку, а не «Отправлено»
с тихим провалом — после старта short-poll `/research-status` первые ~12с: если `status:error`
→ показать. `humanError()` переводит технические коды в русский текст с советом:
`pplx_daily_limit` → «Лимит «Глубокого исследования» исчерпан. Переключись на режим «Поиск»»,
`pplx_model_locked` → «Модель недоступна на тарифе (Max)», и т.д. Принцип реактивности
(не проверять lock проактивно) — `methodology/переносимый-дизайн.md::Реактивная обработка known-условия`.

## История MCP в SQLite (research_jobs)

Раньше история была RAM-only и терялась при рестарте приложения (юзер открывал «История MCP»
после рестарта — пусто). Теперь таблица `research_jobs` в `library.db`:
- **desktop-only** — не в `database.js::SCHEMA` (которая sync'ается с CLI `library_db.py`),
  а отдельным `_db.exec` в `getDb()`. CLI про research-историю не знает.
- На терминальном статусе (done/error) bridge пишет джоб: `persistResearchJob` (claude/perplexity
  через `/research-state`), `persistAistudioJob` (aistudio через `/aistudio-state`).
- `GET /external-jobs` отдаёт **объединение** RAM-Map (live, свежее) + БД (история), дедуп
  по `jobId` (RAM приоритетнее БД для того же id). Этим питаются и попап, и History-панель.
- `result_json` хранит structured-result целиком, не только `response_text`. Для ChatGPT
  image-flow это критично: `response_text` может быть пустым, а настоящий результат лежит
  в `result.images[]`. Входные attachments на persist дополняются как `input_images[]`,
  чтобы detail-screen показывал не только «что ответили», но и «что отправили».
- Для ChatGPT sources panel хранит два разных слоя: URL-ссылки в `result.sources[]` и
  agentic activity/tool steps в `result.source_activity[]` /
  `result.sources_meta.activity_items[]` (например «Тестирование загрузки данных с GitHub»
  + `bash -lc python3 ...`). `AistudioJobScreen` показывает это в блоке «Источники» как
  `N ссылок · M шагов`; не считать этот слой дублем ссылок.
- Нормализация истории добавляет `images[]` / `inputImages[]` с `assetUrl` через
  `sc-asset://research-artifacts/...`. Это делается и для live RAM-state, и для SQLite rows,
  чтобы картинка появлялась сразу после done и не пропадала после рестарта.

Разделение «live в RAM, история в БД» (не всё в БД) — `fact-deep-research.md::RAM-state для
live + SQLite для истории`. Методы: `db.upsertResearchJob` / `listResearchJobs` / `deleteResearchJob`.

## Попап «Запущенные MCP» и История MCP

UI-детали (кликабельная карточка, JobTimer, без uppercase/крестика, компактный JobDetail) —
`fact-aistudio-mcp.md::TitleBar UI`. Здесь только связь: оба компонента (попап +
McpHistoryPanel) читают unified `/external-jobs`, поэтому показывают claude+perplexity+aistudio
одним списком. История MCP клик по строке → открыть джобу + закрыть sidepanel (как Activity).
Заголовки research-строк держат форму `provider · model` (`Claude · Research`, `ChatGPT · 5.5 · high`);
таймер один и тот же в popover и на странице джобы (`McpJobTimer`), чтобы `elapsedSec` не
дрейфовал между двумя UI-поверхностями.

Для image jobs строка истории не должна выглядеть как «готово, но текста нет». `McpHistoryPanel`
показывает счётчики `вход N карт.` / `ответ N карт.` и первые thumbnails; `AistudioJobScreen`
показывает отдельные блоки «Входные изображения» и «Картинки ответа» с действиями copy path /
Reveal in Finder. Для ChatGPT continuation экран дополнительно группирует завершённые jobs по
нормализованному `chatgpt.com/c/<conversation-id>` и показывает «Историю чата»: prompt каждого
turn'а, входные картинки и картинки ответа. Это UI-контракт для сценария «открой тот же чат и
добавь комментарий к прошлой картинке» — проверять надо не только текущий job, а всю цепочку
turn'ов в этом conversation.

## Файлы

| Файл | Что делает |
|---|---|
| `src/screens/NewResearchScreen.jsx` | форма запуска (provider-табы, watchEarlyError, humanError) |
| `src/components/McpRunningPopover.jsx` | попап активных + JobTimer + footer «последний» |
| `src/components/McpJobTimer.jsx` | общий live-таймер `m:ss` / `h:mm:ss` для popover и страницы джобы |
| `src/components/McpHistoryPanel.jsx` | sidepanel истории, клик закрывает панель |
| `src/screens/AistudioJobScreen.jsx` | страница джобы (research+aistudio, prompt→ответ) |
| `electron/database.js` | таблица `research_jobs` + upsert/list/delete |
| `electron/browser-bridge.js` | `/external-jobs` (RAM+БД), `/pplx-models`, persist на done/error |

## Связано

- `fact-deep-research.md` — claude/perplexity механика, Bridge endpoints, RAM+SQLite разделение
- `fact-claude-research.md` — реестр моделей/effort/thinking claude-таба формы
- `fact-aistudio-mcp.md` — AI Studio механика, TitleBar UI детали, JobTimer, auto-close
- `methodology/переносимый-дизайн.md` — Toast в кнопке, Без uppercase, Живой таймер, Реактивная обработка known-условия
- `fact-navigation.md` — Level-1 screens, crumbFor
