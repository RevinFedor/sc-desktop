<!-- @deploy-start -->
<instructions>
  <step index="1">
    ПЕРЕД написанием кода — ИССЛЕДУЙ реальное состояние:
    - Запроси реальные данные (SQL/network/curl), не предполагай
    - Если результат пустой/0/unexpected — проверь данные ПЕРВЫМ, не код
    - Используй MCP `docs_search` для поиска шрамов и фактов по подсистеме: это primary-канал проектной документации перед `rg docs/` и ручным чтением файлов. 
        - В том случае, если ты сейчас работаешь после компакта, Или в начале сессии уже использовал DocsSearch, то не нужно его использовать по новой. Если ты в процессе реализации какой-то длительной фичи, и ты не обновлял по ней документацию, то не надо просто так вызывать DocsSearch.
    - Если используешь `docs_search` по другой директории/`projectPath`, сначала прочитай `CLAUDE.md` этой директории (fallback: `AGENTS.md`/`GEMINI.md`), потому что там лежат project-specific инструкции, включая логирование, деплой и anti-patterns
    - Запрос в `docs_search` формулируй по действию/симптому подсистемы; если MCP пустой или недоступен — явно зафиксируй это и только потом переходи к `rg`/Read как fallback
    - Переиндексация документации выполняется только через MCP `docs_reindex` с явным `projectPath` для нужного проекта. Не запускай и не создавай repo-local shell-индексатор: индексатор является частью knowledge MCP, а не отдельным скриптом каждого репозитория.
  </step>
   <step index="2">
    Объясняй пользователю сложные технические решения человеческим языком.
    - Пользователь работает через нейронку и понимает продукт, общий код, сущности уровня "запись", "история", "API", "input", "кэш", "состояние", "сервер", "клиент", но не обязан понимать внутренние имена полей, camelCase, английские runtime-термины и названия промежуточных слоёв.
    - Внутри анализа можешь использовать любые технические термины, но в ответе пользователю сначала называй смысл, а не внутреннее имя. Не пиши как основной вывод `deliveryStatus: "in-composer"`, `composerDraft top-level field`, `runtime overlay`, `volatile signal`, `entry`, `rehydrate`, `tail validation`, если без них можно объяснить проще. Переводи это в понятные формулировки:
        - не `deliveryStatus`, а "статус сообщения / статус показа";
        - не `composerDraft`, а "текст, который сейчас лежит в поле ввода";
        - не `top-level field`, а "отдельное поле рядом с историей, а не внутри самой записи";
        - не `volatile signal`, а "временный сигнал, который может исчезнуть или измениться";
        - не `entry`, а "запись";
        - не `overlay`, а "временная пометка поверх обычных данных".
    - Если техническое имя важно для кода или API, сначала объясни смысл простыми словами, потом в скобках дай точное имя. Не делай наоборот. Плохой формат: "нужно вынести composerDraft в top-level". Хороший формат: "текст из поля ввода нужно отдавать отдельно от истории, чтобы он не выглядел частью сохранённой записи; в коде это может называться composerDraft".
    - В отчётах по багам и архитектуре объясняй не "какая функция/поле/парсер сработали", а "что система ошибочно приняла за что". Например: "система приняла совпадение текста за доказательство, что это одно и то же сообщение" понятнее, чем "matcher связал composerDraft с history entry". Технические названия добавляй только после человеческой модели и только если они нужны для дальнейшей реализации.
   </step>
 
  <step index="3">
    НЕ деградируй фичу и НЕ меняй архитектурный контракт без явного подтверждения пользователя.
    - Если баг в background/async/renderer-зависимой фиче требует архитектурного ремонта, нельзя подменять его «быстрым» fail-closed фиксом, который отключает или сужает уже существующий user-flow.
    - Сначала явно назови: что текущая фича умеет, что быстрый вариант отнимет, какой правильный вариант сохраняет capability, и получи подтверждение на downgrade/ограничение.
    - Без подтверждения делай только вариант, сохраняющий capability, либо ограничься логами/тестами. Пример: если Rewind должен работать в фоновой вкладке, отсутствие renderer snapshot нельзя чинить отказом от background Rewind; правильный ремонт — перенести proof-слой из renderer в main/headless terminal mirror или другой source of truth.
  </step>
  <step index="4">
    Для управления Noted Terminal используй единый Terminal MCP:
    - Встроенные subagent-инструменты Claude/Codex — для временного делегирования, ресерча и параллельной проверки внутри текущей сессии.
    - Terminal MCP — для отдельных полноценных Claude/Codex-сессий: создать видимую вкладку, отправить задачу, получить уведомление о завершении, прочитать результат/историю, переименовать вкладку, применить подтверждённые изменения плана задач или прикрепить рабочий файл.
    - Для долгой работы между вкладками вызывай `delegate_to_session`: доставка возвращает `runId`; после неё заверши текущий ход. Завершение приходит отдельным следующим уведомлением, и только в этом новом ходе результат читается один раз через `get_delegation_result`. Не жди ответ внутри исходного хода, не вызывай result до уведомления и не опрашивай terminal/history циклом.
    - Вложенный `delegate_to_session` автоматически становится зависимостью текущего orchestration-run: по умолчанию родитель ждёт собственный результат и всех потомков. `waitForDescendants=false` используй только когда пользователь явно разрешил ранний отчёт.
    - Когда текущая задача действительно завершена, все дочерние Terminal MCP-run обработаны и больше нет работы, один раз вызови `complete_task` ближе к концу финального ответа. Не вызывай его для плана, частичного итога, ожидания или ошибки.
    - Связанную подзадачу/ресерч создавай дочерней вкладкой (default `placement=child`), независимую работу — с `placement=root`; разовую тестовую вкладку после `get_delegation_result` закрывай через `close_tab`, если она больше не нужна.
    - Когда речь о «текущей вкладке», сначала вызывай `current_context`; не угадывай `tabId` по cwd или sessionId.
  </step>
  <step index="5">
    Для доступа к данным и контексту локальных приложений используй их живой Application API/протокол, а не внутренние JSON, SQLite или storage-файлы:
    - Перед работой с конкретным приложением сначала прочитай его `CLAUDE.md` (fallback: `AGENTS.md`) и вызови `docs_search` по нужному действию. Если приложение или API недоступны, скажи об этом явно; не подменяй API прямым чтением/записью внутреннего хранилища.
    - **GT Editor.** Для каталога источников и дисковых документов используй discovery `~/.noted-terminal/gt-editor-api.json` и `/api/sources`, `/api/tree`, `/api/file`. Обычный абсолютный путь `/...` читай и правь файловыми инструментами.
    - Живая несохранённая вкладка `untitled://...` — не файл. Работай с ней через `node /Users/fedor/Desktop/gt-editor/scripts/gt-documents.js current|read|edit|write`: сначала получи текст и `revision`, передай её в правку; при `stale_document` перечитай документ и пересобери правку, не перезатирай текст пользователя. Не передавай `untitled://` в `read_file`/`edit_file`/`write_file` и не читай `storage.db` напрямую.
    - В исходном GT-документе `@ai`-блоки — локальные инструкции для AI, а `@include` — ссылка на включаемый контекст, не мусор для удаления. Семантический поиск и editor-метаданные вызывай только через соответствующие `gt_*` MCP-инструменты, не через bash.
    - **Voice Record — библиотека промптов.** Фраза «получи мои промпты из Voice Record» означает только компактный каталог: вызови `node /Users/fedor/Desktop/voice-record/scripts/voice-prompts.js list`; не загружай тела всех промптов, файлов и сборок.
    - Когда пользователь называет промпт и спрашивает, как он устроен, вызови `voice-prompts.js inspect --name "<название>"`. Он показывает один объект: собственный текст, файлы, варианты и вложенные промпты, но без их больших тел. При нескольких совпадениях названия уточни группу или вариант.
    - Загружай итоговый текст только по явному запросу «прочитай содержимое», «покажи» или «используй»: `voice-prompts.js read --name "<название>"`. Поле `resolvedText` уже собрано Voice Record в правильном порядке; не склеивай самостоятельно вариант, основной текст, файлы и вложенные промпты. Просмотр или чтение не означает автоматически применить промпт как инструкцию текущей задачи.
    - Создавай обычный промпт через тот же CLI: `voice-prompts.js create --title "<название>" --text "<текст>"`; вместо `--text` можно передать `--text-file <path>`, а `--file <absolute-path>` (можно несколько раз) сохраняет живую ссылку — содержимое файла читается Voice Record в момент использования. Текст и файлы можно сочетать. Не записывай `prompts.json` напрямую.
    - Для папок и порядка используй `group-create --name`, `group-update --group "<папка>" ... --position N` и `move --name "<промпт>" --group "<папка>"|--ungrouped --position N`. Позиции в CLI считаются с 1. Для дальнейшей правки промпта используй `update --name`: доступны `--title`, `--text|--text-file|--clear-text`, замена списка через повторяемый `--file`, а также `--add-file`, `--remove-file`, `--clear-files`.
    - Промпт из нескольких промптов создавай как сборку: `voice-prompts.js bundle-create --title "<название>" --text "<общая инструкция>" --ref "<промпт 1>" --ref "<промпт 2>"`. Порядок повторяемых `--ref` = порядок итоговой склейки; вариант задаётся как `"<промпт>::<вариант>"`. Чтобы изменить состав или порядок, вызови `update --name "<сборка>" --ref ...`; `--clear-refs` очищает состав. При неоднозначном названии используй ID (`--id`, `--group-id`, `--ref-id`). CLI сам проверяет актуальную ревизию, не затирает параллельную правку из Settings и сразу обновляет открытые окна Voice Record.
  </step>
</instructions>
<!-- @deploy-end -->

# SC Desktop — Electron GUI с локальными Python workers

Electron + React + better-sqlite3 — desktop-приложение для парсинга/транскрипции медиа из Telegram, YouTube, Instagram, TikTok. Python-часть, нужная desktop'у, живёт в локальном `python-workers/`; внешний `cli-tools` / `SaliTools` больше не является runtime-зависимостью. Нативный iOS SC Desk использует тот же job engine через authenticated mobile API, а не отдельного бота/pipeline.

<instructions>
- **НЕ обновляй документацию без ЯВНОГО приказа пользователя.** Файлы `docs/knowledge/`, `docs/methodology/`, `fact-*`, `fix-*` — не создавать и не редактировать, пока пользователь прямо не попросил («обнови доки» и т.п.). Закончил фичу/фикс → остановись, не пиши доки «заодно» / «по итогам» / на каждой итерации. Причина: пользователь сначала сам проверяет код; документация по непроверенной итерации = мусор, который придётся откатывать. Это отдельный явный шаг. (Правило «новые UX-правила писать прямо в `переносимый-дизайн.md`» ниже относится к тому, КУДА писать, когда уже получен приказ — а не к тому, что писать можно без приказа.)
- Перед редактированием Electron main: помни что **node-pty не используется**. Если соблазн добавить — сначала прочитай `docs/knowledge/fact-ipc.md` секцию «Почему subprocess + ndjson, не PTY».
- Любой `console.log` в main process — **только с `[Tag]` префиксом**, иначе он не попадает в файл-лог. См. `docs/knowledge/fact-logging.md`.
- Всё что пишется на диск — **в одну корневую директорию**: `~/Library/Application Support/sc-desktop/`. Не разбрасывать по `~/.config/`, `~/Documents/`, и т.д.
- `~/.config/sc/settings.json` — **разделяется с CLI**. Читать через `shared/settings.py` или его JS-эквивалент. Не дублировать настройки в SQLite.
- Перед добавлением новой IPC channel: проверь существующие в `electron/preload.js` — могут переиспользоваться.
- При работе с UI: title bar уже зарезервировал зону под трафик-лайты (`env(titlebar-area-x)`). Не переопределять `padding-left`. См. `fact-titlebar.md`.
- При изменении схемы БД: **обязательно** обновить и `electron/database.js::SCHEMA`, и `~/Desktop/sc-desktop/python-workers/shared/library_db.py::SCHEMA_V1` — обе стороны пишут в один `library.db`. См. `fact-database.md`.
- Все UX-правила (детерминированность, default = безопасный для денег, inline > push, action-row, mutex inline-панелей, единая структура `fetch`/`copy`-форм, и т.д.) живут в `docs/methodology/переносимый-дизайн.md`. **Не дублировать здесь** — добавлять новые правила прямо туда. Сюда выносятся только структурные хард-инварианты (схема БД, IPC, логирование).
- **Выполнять задачу до конца, не останавливаясь на operational шагах.** Если пользователь сформулировал задачу и **явно не запрашивал ручной фидбек на каждом шаге** — делать всё самостоятельно: перезапускать `npm run dev` (kill старого + старт нового), F5 страницы через `mcp__browser__reload_tab`, открывать новые вкладки через `mcp__browser__new_tab`, ставить недостающие зависимости через `npm install`, рестартить bridge/SW, чистить storage. Просить пользователя нажать что-то — **только** когда есть явный технический блок: расширение попало в Yandex circuit-breaker ("слишком часто перезагружалось"), нужен interactive OAuth/login, нужен закрытый ресурс по доступам. В остальных случаях — выполнять сам и докладывать факт детерминированно из логов.
- **Hot-reload расширения работает автоматически за <1 сек** — после правки любого `browser-extension/*.js` расширение перезагружается через WebSocket-канал bridge ↔ SW. Механика: `electron/browser-bridge.js` поднимает WS-сервер на `127.0.0.1:53129`, watch'ит mtime ключевых файлов каждую секунду; при изменении шлёт `'reload'` всем подключённым SW. `background.js::__sc_connectReloadWs` принимает → `chrome.runtime.reload()`. Параллельно SW шлёт ping каждые 20 сек по WS — это сбрасывает 30-секундный idle-таймер SW (правило Chrome 116+), keep-alive держится без `chrome.alarms`. Safety net: `chrome.alarms 0.5 min` (минимум разрешённый Chrome 120+) + HTTP-poll `/__ext_version` на случай если WS не поднялся (например prod app). **Manual ⟳ нужен только когда расширение попало в circuit-breaker** ("слишком часто перезагружалось" — Yandex блокирует после ~30 reload'ов/сек, кнопка ⟳ в `chrome://extensions/` НЕ сбрасывает — нужен toggle off/on). См. `fact-yt-extension-bridge.md::Hot-reload` для деталей, что пробовали и почему `chrome.alarms 0.1` не работает в Yandex idle SW.
- **Детерминированные логи > предположения из кода.** При отладке complex pipeline (особенно через черные ящики типа MCP+SW+content-script) — не строить hypothesis на основе чтения исходника. Если на текущих логах нет 100% уверенности — добавить новые `scBgDbg`/dbg-маркеры в подозрительные места, прогнать пайплайн заново, прочитать. Юзеровское возмущение «никаких предположений, только логи» — сигнал что я полез в догадки.
</instructions>

## Methodology
Дизайн-правила (UX-философия, типография, контролы, deletion) — в `docs/methodology/переносимый-дизайн.md`. Активируется по запросу *«следуй правилам дизайна»* или редизайн-задаче.

E2E-тесты — глобальный skill `electron-e2e-testing` (`~/.claude/skills/electron-e2e-testing/SKILL.md`): общая методология через `mcp__electron__*`. sc-desktop-specific (CDP 9223, `/tmp/cdp.js` helper, react-arborist chevron-различитель, hot-reload расширения через WS-bridge, `window.api`) — в `references/sc-desktop.md`. Практический рецепт запуска dev-сборки через CDP — секция «Автотест dev-сборки через Chrome DevTools Protocol» ниже.

## Стек
- **Electron 34** (frameless, hidden title bar, traffic-light overlay)
- **React 18 + Vite 6** (renderer на `:5156` в dev)
- **Tailwind v4**
- **better-sqlite3** в runtime + dual-source schema с Python workers (см. `fact-database.md`). FTS5 для поиска по транскриптам.
- **Python subprocess** через `child_process.spawn()` для запуска `python-workers/*_ndjson.py`.

## `python-workers/` — Python runtime для desktop jobs

Основное приложение — Electron (main + renderer). Папка `python-workers/` — first-class runtime desktop'а: `electron/job-runner.js` спавнит оттуда `*_ndjson.py`, а production-сборка кладёт её в `Contents/Resources/python-workers`. Зависимости ставятся в `.venv` через `npm run python:setup` / `npm run build:install`.

**Что трогаем для desktop-фич:** `python-workers/*_ndjson.py` и `python-workers/shared/*`, либо Electron main/renderer. Если logic нужна desktop'у — переносить её сюда, не ссылаться на старые внешние папки.

**Что НЕ трогаем для desktop-фич:**
- внешний `cli-tools`, `SaliTools`, `sc_core.py`, `tg_core.py`, `ig_core.py`, `ig_api_core.py`, `web_core.py` — это legacy/CLI-only контур, не точка входа desktop'а.
- TUI-меню `sc -i settings`, `sc -t settings` — не дублируем в UI, а пишем свои screens, которые читают/пишут тот же `~/.config/sc/settings.json`.

**Что отсутствует и считаем «не написано»:** если в `python-workers/` нет реализации нужного backend'а, пишем её прямо там через нормальные API/requests, не пытаемся опираться на CLI-only функции из старых папок.

## Process-границы и внешний mobile-вход
```
┌─────────────────────────────┐
│ Electron Main (Node)        │  job-runner.js, logger.js, IPC handlers
│  ├─ spawn() Python          │
│  ├─ readline parse ndjson   │
│  └─ emit job:update events  │
└──────────┬──────────────────┘
           │ contextBridge (preload.js)
           │ window.api.*
┌──────────┴──────────────────┐
│ React Renderer (Vite)       │  App.jsx, screens/, components/
│  ├─ in-memory store         │
│  ├─ ActivityPanel listens   │
│  └─ Screens swap in center  │
└─────────────────────────────┘

         ┌───────────────────────────┐
spawn ──▶│ Python subprocess         │  ~/Desktop/sc-desktop/python-workers/telegram/tg_fetch_json.py
         │  ├─ telethon              │  emits ndjson to stdout
         │  └─ writes to stdout      │
         └───────────────────────────┘
```

Четвёртая граница не идёт через renderer: iPhone → `https://sc.f9922.tech` → nginx на VPS →
reverse SSH tunnel → `127.0.0.1:7898` → `electron/mobile-api-server.js` в Electron main.
Mobile API только проецирует обычные Instagram/YouTube jobs в REST/SSE и отдельную
`mobile-imports.json` history; источником обработки остаётся job-runner. Listener не открывать
в LAN, токен не логировать. Полный контракт — `docs/knowledge/fact-sc-desk.md`.

## Документация
Вся документация в `docs/knowledge/` — единая плоская структура (`fact-*` факты, `fix-*` шрамы). Семантический поиск через `docs_search` MCP — выбирает релевантные файлы по симптомам, не по названиям. Каталога ссылок здесь нет.

Python worker runtime — см. `docs/knowledge/fact-python-воркеры.md`.

Автотест dev-сборки через CDP — секция ниже.

## Anti-patterns
- ❌ **Не подключать node-pty.** Долго-живущая PTY-сессия не нужна, всё через `spawn()` + ndjson.
- ❌ **Не делать HTTP-sidecar на Python.** Каждый job — отдельный subprocess, чище для cancel/exit/error tracking.
- ❌ **Не emit'ить per-item events** в `job:update` без throttle. Контракт сейчас — throttled emit раз в 250 мс на job + всегда на page-границе. Без throttle: 5000 IPC frames на больших чатах = scroll-storm. Только on-page (как было раньше): между двумя page-boundaries Activity замёрзает на 10-20 сек, юзер думает «job повис». См. `fact-ipc.md::Per-item events: throttle, не silence`.
- ❌ **Не хранить items в job-snapshot** после `close`. Они flush'атся в JSON и `delete` из памяти. Иначе утечка при больших чатах.
- ❌ **Не сохранять process-local `jobId` как identity mobile import после рестарта.** Новый Electron-процесс снова начинает счётчик с 1, и старая запись подхватит snapshots чужого job. При чтении mobile-history id всегда очищается; durable identity — UUID import / `clientRequestId`. См. `fact-sc-desk.md::Рестарт`.
- ❌ **Не использовать `console.log('msg')`** без `[Tag]`. Лог не попадёт в файл, останется только в stdout.
- ❌ **Не ждать что Vite hmr подхватит правки в `electron/main.js`/`preload.js`.** Hmr только для renderer. Любая правка в main process требует **полного kill всех Electron-процессов + npm run dev заново**. Иначе видишь старый код, IPC-handler «No handler registered for X» и подобное.
- ❌ **Не забыть `npm run rebuild` при смене Electron версии.** `better-sqlite3` (и любой native module) собирается под конкретный ABI. Симптом: `NODE_MODULE_VERSION 132 vs 141` в логе. См. `fact-database.md`.
- ❌ **Не полагаться на дефолтный `cursor: pointer` у button.** Tailwind base сбрасывает его. Глобальное правило в `src/styles/main.css` — все кликабельные имеют явный pointer, disabled — `not-allowed`. При добавлении кастомного кликабельного div'а (`role="button"`) — он автоматически получит pointer от того же глобального правила.
- ❌ **Не использовать эмодзи (🕘 ⚡ 🧹 ↻ ⚙ и т.п.) как функциональные иконки в action-кнопках.** lucide-react уже подключён — берём оттуда (`Activity`, `History`, `Settings`, `RotateCw`, `Trash2`, `Square`, `ExternalLink`, `Cpu`, `FileText`, `X`). Эмодзи допустимы только как декоративные маркеры состояния (status dot не нужен emoji — он CSS), в seed-data или в логах. См. `methodology/переносимый-дизайн.md::Иконки через icon-library`.
- ❌ **Не удалять item-строку при skip медиа-файла.** Хранить metadata всегда (`media_path = null + has_media = 1`), иначе теряем детерминированность «было / не скачали». См. `fact-database.md`.
- ❌ **Не дёргать IPC на каждое изменение state в picker'ах/списках.** Если данные уже загружены в массив — `useMemo` от него (см. `transcribedSet` в `YouTubeBatchPicker`). useEffect с deps `[selectionIds.join(',')]` который дёргает запрос на каждый клик чекбокса — экран дёргается, см. `fact-youtube.md::Performance`.
- ❌ **Не рендерить свой `← Back` header в screen'е.** Глобальный Breadcrumbs в `App.jsx` уже даёт навигацию. Identity-row начинается прямо в body, destructive actions — внизу в Danger zone. См. `fact-navigation.md`.
- ❌ **Не оставлять `python-workers/` без `watch.ignored` в `vite.config.js`.** Telethon на каждый connect() создаёт sqlite WAL-файлы внутри project root → Vite видит mutation → full-reload renderer → store reset → юзера кидает на Home. См. `fix-frontend-gotchas.md::Vite full-reload`.
- ❌ **Не использовать `&&` для guard'а с числом из SQLite.** `item.has_media && <Warning/>` рендерит литеральный `"0"` если поле = 0 (integer, не bool). Только `!!item.has_media`, `Boolean(...)` или явное `> 0`. См. `fix-frontend-gotchas.md::JSX && 0`.
- ❌ **Не подписываться на `window.api.onJobUpdate` в каждом компоненте.** Единственный listener живёт в `src/lib/jobInvalidation.js` и маппит status на ключи data-bus. Компоненты подписываются на ключи через `useInvalidator(key)`. См. `fact-data-bus.md`.
- ❌ **Не писать row в jobs-таблицу только на close.** Создавай pending row на `entity` event (`status='running'`), на close делай `db.updateJob(id, ...)` — иначе running job не виден в «История парсинга». См. `fact-jobs.md::Pending row`.
- ❌ **Не вставлять `number` как PK в `items_vec`.** vec0 module строгий, требует `BigInt`. Симптом: `Only integers are allowed for primary key values on items_vec`. Coerce внутри API (`bulkUpsertVectors` уже делает). См. `fact-semantic-search.md::sqlite-vec gotchas`.
- ❌ **Не считать `batchEmbedContents(N)` как 1 запрос в RPM-квоте Gemini.** Биллится как N — это внешний факт, не очевидный из формы вызова. Симптом: `429 You exceeded quota` при `RPM 2.8K/3K` хотя TPM наполовину пуст. См. `fact-semantic-search.md::RPM-троттлинг`.
- ❌ **Не собирать production без `python-workers/` и `.venv`.** `telethon not installed` в UI — это не Telegram-login, а `worker_dependency_missing`: app запустила Python без нужных deps или bundle не содержит `.venv`. `config.env` больше не active contract; ключи читать из env / `~/.config/sc/settings.json`. См. `fact-python-воркеры.md` и `fix-production-asar-spawn.md`.
- ❌ **Не делать `GEMINI_API_KEY` обязательным для AssemblyAI-пути.** `gemini_utils.GeminiClient.__init__` поднимает ValueError если ключа нет, даже когда юзер выбрал `engine=assemblyai` и Gemini ни разу не вызовется. В `local_transcribe_ndjson.py` подсовываем placeholder-значение если engine не gemini, чтобы init не падал. В `tg_fetch_json.py` — helper `_make_gemini_client(requires_real_key=...)` решает то же самое явно: AAI-путь не требует реальный ключ, Gemini-путь падает с понятной ошибкой раньше чем сервер вернёт `400 API_KEY_INVALID`.
- ❌ **Не передавать `--transcribe-engine` без `--process-voice/photo/docs`.** Engine — это «как обрабатывать аудио», а флаги — «какие типы вообще обрабатывать». Только engine без флагов = ничего не делает (кроме legacy single-mode guard для TelegramSingleMessageForm). Folder batch ловил такую регрессию: в детей передавался engine, но не флаги → AI-обработка всех типов скипалась, в caption приходили placeholders «только метаданные». См. `fact-jobs.md::Per-type флаги`.
- ❌ **Не вешать `mousedown` outside-click listener без `setTimeout(0)` обёртки.** Тот же физический клик, который открыл popover, может закрыть его на следующем mousedown'е (race между React commit-фазой и event propagation). Симптом: popover не виден после клика, кажется что `setOpen(true)` не сработал, но через DevTools видишь, что onClick handler выполнился. См. `fix-popover-outside-click.md`.
- ❌ **Не сохранять source/items для ad-hoc paste-flow.** Local-file paste, YouTube search и Telegram single-message URL — ephemeral операции, не подписки. Library засорять не надо. Признак: `params.mode === 'single'` (TG), `params.is_search === true` (YT), `type === 'local_transcribe'`. Job-row в БД пишется (для history), но `source_id = NULL` и `bulkUpsertItems` пропускается. См. `fact-source-actions.md::Ephemeral paste-flows`.
- ❌ **Не shadow'ить `client` в Python-скриптах когда уже есть Telethon-`client` снаружи.** В `tg_fetch_json.py` параллельно живут Telethon-`client` (для get_messages/download_media) и `gemini_utils.GeminiClient` (для transcribe). Если написать `client = GeminiClient()` внутри single-mode ветки — внешний `await client.disconnect()` после блока упадёт `AttributeError: 'GeminiClient' object has no attribute 'disconnect'`. Job завершается `done`, но в логе error. Использовать локальное имя (`gc`, `gem`). См. `fact-jobs.md::Voice transcription`.
- ❌ **Не использовать `client.start()` в desktop `tg_*_ndjson.py` / `tg_fetch_json.py`.** При деавторизованной сессии `start()` не кидает исключение — печатает «Please enter your phone…» в stdout и ждёт stdin, которого у subprocess нет → `EOFError` → exit 1 с **пустым** stderr, в UI «python exited 1:» без причины. Звать `shared/tg_session_path.py::connect_authorized(client)` — connect без логина + явный `is_user_authorized()`, при неудаче emit `{"type":"error","code":"session_unauthorized"}`. См. `fact-telegram-sessions.md::Деавторизованная сессия`.
- ❌ **Не парсить `t.me/c/<id>/<msg>` универсальным `t.me/(\w+)/(\d+)` regex'ом.** В приватных каналах `c` — это литерал, не handle, а `<id>` — internal chat_id. Telethon не разрешает `@c`, ловишь `Cannot find any entity corresponding to "c"`. Спецветка в detect.js + form: target = `-100<internal_id>`, Telethon принимает как numeric chat_id (с warm-up через iter_dialogs() при первом обращении). См. `fact-fetch-strategies.md::Resolve by chat title`.
- ❌ **Не пере-использовать кэш-ключ из «video_id» когда есть юзер-видимые параметры.** Cache-key для YouTube comments = `(video_id, sort, limit, includeReplies)` целиком. Если юзер сменил `sort` → старый файл-с-другим-sort'ом не должен silently выдаваться как «уже есть». Done-card врёт без показа версии («только верхнеуровневые» / «N тредов + M ответов»). См. `fact-youtube-comments.md::Cache key` и `methodology/переносимый-дизайн.md::Cache key = пользовательский tuple`.
- ❌ **Не парсить message_id из t.me URL через `url.split("/")[-1]`.** Реальные ссылки приходят с query: `?thread=…` (форум-топик), `?single`, `?comment=…`, `?t=12s`. `int("7214?thread=6479")` падает с `Cannot parse message id from <url>`. Сначала `url.split("?", 1)[0].rstrip("/")`, потом ищем последний числовой сегмент через `for seg in reversed(path_segs)`. То же касается `urlparse(url).path` — в JS-стороне детекта работает потому что regex останавливается на `?`, но Python-стороне в `tg_fetch_json.py` нужно явно срезать query.
- ❌ **Не хранить state pill-кнопки в DOM-attribute или закрывать его в click-closure.** State живёт в `videoStateMap = Map<videoId, ...>`. Pill сейчас 3 типа в DOM (singleton + FAB + per-card), все они read-only views Map'а: на render берут `state[currentVideoId] ?? idle`. Background-tracker пишет в Map через onMessage — все 3 типа pill перерисовываются автоматически через `renderPillForCurrentVideo + renderFabFromState + renderPerCardFromState + renderToasts`. Хранение state на самой pill ломалось бы для singleton (она переезжает между видео при hover); хранение в click-closure ломалось бы для per-card (Lit/Polymer переиспользует thumb-узлы при scroll'е, click читал бы старый videoId). Click читает АКТУАЛЬНЫЙ `btn.dataset.videoId`. См. `fact-yt-extension-flow.md::4 источника UI` и `methodology/переносимый-дизайн.md::State per-resource + глобальный indicator`.
- ❌ **Не открывать loopback-bridge на `0.0.0.0`.** `electron/browser-bridge.js` слушает строго `127.0.0.1:53127` с CORS-allowlist'ом (youtube.com, aistudio.google.com). Без этого расширение получит CORS-отлуп — но и любой сайт сможет дёрнуть `/yt-fetch`, что даст read доступ к LIB_ROOT через path-traversal (защита есть, но отдавать готовый файл случайному origin'у всё равно неприемлемо). Порт фиксированный, не discovery — расширение знает 53127 наизусть.
- ❌ **Не удалять `/notifications/terminal-completion` вместе со старым интерактивным Telegram-ботом.** Polling/приём ссылок через `getUpdates` больше не являются продуктовым входом, но исходящий `sendMessage` остаётся межпроектным контрактом Custom Terminal. У отправителя durable-очередь: отсутствие route копит backlog, а восстановление production-получателя может отправить его сразу. Отдельные bearer token и правила dedupe — `fact-sc-desk.md::Custom Terminal: исходящие Telegram-уведомления`.
- ❌ **Не звать `aai.Transcriber.transcribe()` если есть UI.** Это блокирующий вызов SDK который ждёт всю обработку молча — UI получит один `transcribe_start` event и потом тишину 30+ минут на длинном файле. Используем `Transcriber.submit()` + ручной polling `aai.Transcript.get_by_id()` каждые 2 сек, на каждый tick emit'им `transcribe_progress {stage, aai_status, elapsed_sec, audio_duration_sec}`. CLI-сторона (`progress_cb=None`) остаётся на блокирующем пути — там никому progress не нужен. См. `fact-jobs.md::AAI sub-stages` и `fact-local-files.md::AAI polling`.
- ❌ **Не emit'ить ndjson внутри `with silenced():` блока без `_REAL_STDOUT`.** В `local_transcribe_ndjson.py` контекст-менеджер `silenced()` подменяет `sys.stdout` на `io.StringIO` чтобы заглушить рич-print из gemini_utils. Если `emit()` пишет в `sys.stdout` через короткое имя — внутри блока он пишет в StringIO, события до Electron не доходят. Захватить реальный stdout на module-init: `_REAL_STDOUT = sys.stdout` и писать в него явно. См. `fact-local-files.md::silenced() proxy`.
- ❌ **Не дублировать `CONTENT_TYPES` / `ENGINES` в новых TG-компонентах.** Единый `src/components/TelegramTypesPopover.jsx` экспортирует и массивы, и сам popover-компонент. И `TelegramConfigForm` (paste-flow + Custom fetch), и `TelegramScreen` (папки) — обязаны импортировать оттуда. Любое новое место с типами контента или движком транскрипции — туда же, не локальная копия. Иначе появление нового типа (например `sticker`) или engine = чинить N мест и расходиться визуально между формой и страницей.
- ❌ **Не возвращать новый array из `getSnapshot` в `useSyncExternalStore`.** `arr.filter(...)` каждый раз = новая ссылка → React видит изменение → render → opnova → infinite loop с симптомом «Maximum update depth exceeded». Любой трансформированный snapshot (filter / map / pick) обязан мемоизировать результат относительно identity исходного store. См. `fix-frontend-gotchas.md::useSyncExternalStore + filter`.
- ❌ **Не использовать NULL как трёхзначный sentinel.** Если `column IS NULL` в твоём SQL означает одновременно «нет значения» и «ещё не проверено» — backfill-loop по `WHERE column IS NULL` не сходится, повторно дёргает уже-обработанные строки (которые корректно записали NULL). Решение — отдельный bool-флаг (как `reply_resolved` для `parent_external_id`), `WHERE flag=0`. И обязательно `MAX(items.flag, excluded.flag)` в ON CONFLICT, иначе metadata-only re-upsert сбросит флаг. См. `fact-database.md::parent_external_id + reply_resolved`.
- ❌ **Не делать `chrome.runtime.reload()` без cooldown.** Хочется hot-reload — должен быть **grace period после boot** + **cooldown ≥ 30 сек между reload'ами**, persist в `chrome.storage.local`. Без защит SW попадает в loop: respin → читает свежий mtime → reload → respin, и за ~30 reload'ов/сек Yandex/Chrome блокирует расширение (circuit-breaker, «Это расширение слишком часто перезагружалось»). Кнопка ⟳ в `chrome://extensions/` после этого НЕ помогает — нужен toggle off/on. См. `fact-yt-extension-bridge.md::Hot-reload`.
- ❌ **Не использовать `chrome.storage.session` в расширении** для persist'ов между respin SW. В Яндекс.Браузере `storage.session.set` молча падает (Promise resolve без ошибки, но `get` возвращает undefined). Это вызывает невидимый зацикл «init/reload» в hot-reload-poll'е. Только `chrome.storage.local` — он переживает и SW respin, и reload extension. См. `fact-yt-extension-bridge.md::Hot-reload`.
- ❌ **Не запускать research (claude/perplexity/aistudio/chatgpt) через browser-MCP tools.** browser-MCP (`mcp__browser__*`) — инструмент **живого парсинга** (list_tabs/click/evaluate/snapshot), не flow-runner. Все четыре research-провайдера идут через bridge HTTP: `POST /research-start {provider}` + `GET /research-status?id&wait=N`. `aistudio_run`/`aistudio_get_result` были удалены из `mcp/browser/index.js`. Граница: разовая команда с мгновенным ответом → browser-MCP; долгий процесс который надо ждать/поллить → research-канал. См. `fact-aistudio-mcp.md` + `methodology/переносимый-дизайн.md::Граница каналов`.
- ❌ **Не fetch'ить bridge (`127.0.0.1:53127`) из renderer'а.** Origin renderer'а (`localhost:5156` в dev, `file://` в prod) не в CORS-allowlist'е bridge'а, и добавлять его нельзя (`file://` = null-origin). Прямой `fetch` падает «Failed to fetch» до сети, симптом обманчив («кнопка не работает»). Все bridge-вызовы из UI — через main-process IPC (паттерн `research:start` / `research:stop` / `bridge:tabCommand` / `aistudio:listJobs` в `electron/main.js`). См. `fact-research-ui.md::Запуск через IPC`.
- ❌ **Не доверять submit'у без verify смены send-кнопки.** Контракт любого research/MCP content-script'а (claude/perplexity/chatgpt/aistudio): после отправки промпта Send обязан смениться на Stop (или другой детерминированный маркер отправки: своё user-message в DOM, редирект на `/search/`). Не сменился за verify-окно (90–120с) → CS emit'ит `status='error', stage='submit_failed'`, а не оставляет job в running. Симптом без fallback'а: «пустая вкладка» (paste/click не сработали), job висит 30 минут в «Запущенные MCP». Парный fallback в bridge: ручное закрытие вкладки (`sw.tab.onRemoved`) → все её non-terminal jobs → `error stage=tab_closed`; для этого tabId пишется в job сразу на `/research-start`, не дожидаясь CS. См. `fact-deep-research.md`.
- ❌ **Не использовать таймер как основной способ дождаться UI-состояния.** `sleep(800)`, `setTimeout(1000)`, interval/polling «на всякий случай» вместо факта из DOM/сети/лога — запрещены для рабочих сценариев. Основное ожидание должно быть событийным или проверяемым по реальному маркеру: `MutationObserver`, смена `disabled/aria-busy`, появление/исчезновение Send/Stop, network/IPC event, запись в лог/state. Таймер допустим только как fallback: hard timeout, bounded retry/backoff после ошибки, debounce race (`setTimeout(0)` для outside-click) или аварийный ceiling с явным error-статусом.
- ❌ **Не рвать keepalive / не закрывать вкладку до подтверждения терминального POST'а.** В research-CS финал (`status=done/error`) пишется через `postTerminalState` (POST → read-back echo-snapshot → подтверждение смерженного статуса → ретраи по `scBridgeFetch` со sticky-SW-fallback), и только при подтверждении вызывается `stopKeepAlive()`/`closeSelfTab()`. Голый fire-and-forget `postState({status:'done'})` + безусловный teardown даёт зомби: `stopKeepAlive()` рвёт порт → SW `onDisconnect` удаляет вкладку из `RESEARCH_TABS` → `sw.tab.onRemoved` короткозамыкается, tab-closed fallback (предыдущий пункт) **не срабатывает**, а потерянный POST оставляет job вечно `running` (живой кейс `ryccfz`: watcher.done сработал, done-POST потерялся, job висел 10+ ч). Не подтвердилось → порт живой + вкладка открыта + `bridgeLog('<prov>.terminal.giveup')`. tab-closed fallback по построению ненадёжен (гонка `onRemoved`↔`onDisconnect`) — гарантией должна быть сама запись, не страховка. См. `fact-deep-research.md::Терминальный статус подтверждается перед teardown'ом`.
- ❌ **Не слать чужой текст (письмо, ответ внешнего сервиса) через `sendMessage` + `parse_mode`.** Один неподдерживаемый тег из чужой разметки — и Telegram отбивает всё сообщение с `can't parse entities`, а не показывает его криво; плюс потолок 4096 символов. Для такого — `sendRichMessage` (Bot API 10.1+): чужие теги не роняют отправку, лимит 32768, есть сворачиваемый `<details>`. Но «не падает» ≠ «выглядит нормально»: table-вёрстка письма проходит и схлопывается в кашу, поэтому чужую разметку всё равно пересобирают, а не экранируют. См. `fact-почта-в-telegram.md`.
- ❌ **Не открывать фоновую automation-вкладку без `attachFocusEmulation`.** Глобальный паттерн для ЛЮБОЙ вкладки, которой управляет расширение (chatgpt/claude/perplexity/aistudio — research, быстрый Поиск, autoscrape — одинаково): сразу после `chrome.tabs.create({active:false})` → `attachFocusEmulation(tabId)` (`chrome.debugger.attach` + `Emulation.setFocusEmulationEnabled`), detach на done. `autoDiscardable:false` спасает ТОЛЬКО от discard, не от render-freeze: при длительно-деактивированном браузере (юзер отошёл на часы) Chromium глушит rAF и душит таймеры даже в «живой» вкладке — MutationObserver-watcher слепнет (живой кейс: 48 тиков за 577с вместо 1/2с, без единой смены сигнатуры), done наступает только от ручного клика юзера по вкладке, а focus-pulse-эскалация выдёргивает окно браузера поверх текущего приложения. Длительность джоба не влияет — упадёт и быстрый запрос, если браузер давно деактивирован. Домены-кандидаты перечислены в `background.js::SC_FOCUS_EMULATION_URL` (тот же regex используют onDetach/watchdog для auto-reattach). См. `fact-aistudio-mcp.md::Hidden-tab strategy` (механика Page::IsPageVisible) + `fact-deep-research.md`.

## Автотест dev-сборки через Chrome DevTools Protocol

Можно поднять Electron в dev и **программно** проверить flow: дёрнуть IPC, кликнуть кнопку в DOM, снять скриншот, прочитать лог. Полностью end-to-end, без ручного QA.

**Порт:** sc-desktop держит CDP на **9223** (закреплено в `package.json::electron:dev`).
Соседние Electron-проекты на других портах, чтобы не пересекаться при параллельном
dev'е: gt-editor=9222, custom-terminal=9224. `npm run dev` уже передаёт правильный
флаг — отдельной правки команды не нужно.

**Запуск:**
```bash
# 1. Грохни предыдущий dev:
pkill -f 'electron .' 2>/dev/null; pkill -f 'vite' 2>/dev/null

# 2. Очисти лог чтобы grep'ать только эту сессию:
: > /Users/fedor/Desktop/sc-desktop/logs/dev.log

# 3. Запусти dev в фоне (CDP порт уже зашит в скрипт = 9223):
NODE_ENV=development \
  ./node_modules/.bin/concurrently --kill-others-on-fail \
    "./node_modules/.bin/vite" \
    "./node_modules/.bin/wait-on http://localhost:5156 && \
     NODE_ENV=development ./node_modules/.bin/electron . --remote-debugging-port=9223"
# (через Bash run_in_background: true)

# 4. Дождись подъёма CDP-эндпоинта (~5-10 сек):
until curl -sf http://localhost:9223/json/version > /dev/null; do sleep 1; done
```

Окно SC Desktop появится в Dock'е на время теста. Headless режим Electron на macOS не работает.

**Как взаимодействовать:** через `/tmp/cdp.js`. **Дефолт helper'а = 9222 (gt-editor)** — для sc-desktop всегда передавай `CDP_PORT=9223`, иначе попадёшь в чужой проект и получишь `Cannot read properties of undefined (reading 'sourcesList')`:
```bash
CDP_PORT=9223 NODE_PATH=/Users/fedor/Desktop/sc-desktop/node_modules \
  node /tmp/cdp.js eval '<JS-выражение>'   # Runtime.evaluate, awaitPromise:true
CDP_PORT=9223 NODE_PATH=/Users/fedor/Desktop/sc-desktop/node_modules \
  node /tmp/cdp.js shot /tmp/sc_NN.png     # Page.captureScreenshot
```
`NODE_PATH` нужен потому что helper лежит в `/tmp/` и ищет `ws` относительно gt-editor; sc-desktop'овский `node_modules/ws` подкидываем явно.

**Что внутри `eval`:**
- IPC: `window.api.igGetSettings()`, `window.api.tgFetch({...})` — все методы из `electron/preload.js`. Это самый надёжный путь — идёт через preload → main → job-runner, как настоящий клик из UI.
- DOM: `document.querySelector(...)`, `Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Спарсить').click()`. **Не двигай мышь координатами** — селекторы по тексту переживают layout-сдвиги.
- Async: `awaitPromise: true` уже выставлен, можно возвращать промис прямо из выражения.

**Скриншоты** читаются через `Read /tmp/sc_NN.png` — они отдаются мультимодально, ассистент их «видит» как изображения.

**Параллельно — лог:** запускай `Monitor` с `tail -F logs/dev.log | grep --line-buffered '\[Jobs\] ...'` чтобы ловить старт/конец job'ов без поллинга.

**Cleanup:** в конце `pkill -f 'electron .'` + `pkill -f 'vite'`.

**Что нельзя:**
- Поймать race-condition'ы при человеческой скорости — `.click()` синхронный, реальный мышь даёт паузы.
- Hover/focus-зависимое поведение (dropdown'ы которые закрываются на blur, ring при фокусе) — это синтетические event'ы, не настоящая мышь. То же относится к `mcp__browser__hover` через SC Browser Parser: synthetic `pointermove` **не активирует CSS `:hover`** pseudo-class. Если visibility элемента опирается на `:hover` — на screenshot'е его не будет, даже если он реально в DOM. Проверяй через `mcp__browser__wait_for_selector` + DOM rect, либо временно ставь `data-sc-pinned="1"` (опираясь на rule из `injectGlobalCss`) — не полагайся на скриншот для hover-визуала.
- Анимации между кадрами — только статичные снимки.

**Когда использовать:** проверить новый IPC handler, прогнать end-to-end парсинг/транскрипцию, увидеть как screen реально рендерится после изменений CSS, убедиться что новый screen зарегистрирован в `App.jsx::SCREENS` и в Breadcrumbs.

## Pending переходы (в порядке приоритета)
1. **Транскрипция в UI для Telegram** — сейчас `tg_fetch_json.py` только тянет метаданные. UI-сторона полностью готова: TelegramScreen и TelegramConfigForm используют `<TelegramScopeFields>` с engine-select и comments-toggle, params собираются и могут содержать `engine: 'gemini'|'assemblyai'`. Не реализовано — реальный `--transcribe` flag в `tg_fetch_json.py`, чтобы при включённых voice/video типах автоматически прогонять полученные media через `gemini_utils` и поднимать coverage depth `media → transcribed`. (Для YouTube и Instagram — уже сделано через `yt_batch_transcribe_ndjson.py` / `ig_batch_transcribe_ndjson.py`.)
2. **«Дотянуть медиа» action для Telegram** — кнопка появляется в `SourceDetail` если есть items с `has_media=1, media_path=NULL`. Нужен subprocess для batch-download без re-fetch metadata.
3. **Instagram Posts через api backend** — сейчас `clips/user/` тянет только reels. Posts (timeline media) требуют `feed/user/` который без cookies возвращает login_required. Через apify работает (`apify/instagram-post-scraper`), через api backend — пока заглушка с явной ошибкой. Возможно: документировать как «только apify для posts», либо добавить cookies-aware fallback.
4. **Apify-cancel при cancel job** — `child.kill('SIGTERM')` убивает Python, но run на сервере Apify продолжается ещё 5-30 секунд и тратит деньги. Добавить `apify abort` HTTP-вызов в cancelJob для ig_*-jobов с `backend: apify`.
5. **Settings UI** — Telegram sessions реализованы (см. `fact-telegram-sessions.md`), Instagram backend selectors реализованы (см. `fact-instagram.md`). Остальные секции (`youtube.preferred_lang`) пока mock-rows в `SettingsScreen.jsx`. Заменить на реальные read/write через shared `~/.config/sc/settings.json`.
