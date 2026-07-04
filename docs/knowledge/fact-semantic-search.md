# Knowledge: Семантический поиск по сообщениям

Векторный индекс поверх `library.db`, чтобы искать парафразами и синонимами,
а не только точными словами как FTS5. Telegram-only пока (другие платформы
парсятся реже и там FTS+транскрипты обычно хватает).

## 🗺️ Карта файлов

```
electron/
  database.js             items_vec virtual table + bulkUpsertVectors + hybridSearch
  embedder.js             Gemini gemini-embedding-001 client (HTTP)
  index-job.js            Node-only job: батчи, троттлинг, Late Chunking
  main.js                 IPC handlers tg:index / tg:indexStatus / tg:search
src/
  components/IndexButton.jsx        кнопка + chevron-input
  components/CoverageBars.jsx       прогресс-бар индексации
  components/ChatView.jsx           Semantic-кнопка + порог-ползунок + confidence-badge
  screens/SourceDetail.jsx          подписка на job:update + статус
mcp/
  server.js               MCP-сервер для Claude Code (Telegram + Reddit + Twitter + gt-editor)
  run.sh                  обёртка с ELECTRON_RUN_AS_NODE=1
.mcp.json                 регистрация для Claude Code
```

## 🧬 Late Chunking — что и почему

Каждое сообщение эмбеддится не одно, а с префиксом из `CONTEXT_NEIGHBORS = 5`
предыдущих сообщений (по `published_at`). Gemini получает склеенный текст,
возвращает один вектор для сообщения целиком, **но в этих 768 числах зашит
смысл всей мини-ветки**. Без этого короткие реплики `«+»`, `«топ»`, `«+1»`
получали бы случайные/мусорные векторы и никогда не находились.

```
индексируем #100:
  prefix = последние 5 сообщений с непустой caption, до #100
  склейка = [sender]: [text]\n × 6
  Gemini → один вектор → INSERT items_vec WHERE item_id=100
  префикс в БД НЕ сохраняется — растворился в 768 числах вектора
```

Окно сдвигается по каждому сообщению. У 10k сообщений → 10k векторов,
без дублей. Соседи попадают в склейку много раз (для #100, #101, #102...),
но **получают вектор только когда сами в центре окна**.

> **Что пробовали и почему не сработало.**
> Хотел добавить «±5 соседей под каждым хитом» в выдачу — отбросили: граница
> произвольная (реальная ветка может быть 3 или 30), на каждое сообщение
> юзер должен жать «+5 ещё». Правильно — провалиться в `ChatView` со
> scroll-anchor на конкретный `id`, чтобы юзер сам видел сколько контекста
> ему нужно. Не реализовано (отдельная задача).

## 📦 sqlite-vec gotchas

### BigInt strict primary key

vec0 module отвергает обычные JS `number` для PK с ошибкой
`Only integers are allowed for primary key values on items_vec`. Symptom
неочевидный — обычный `INTEGER PRIMARY KEY` в SQLite принимает оба.
Поэтому в `bulkUpsertVectors` явный `BigInt(r.item_id)` перед `del.run()` /
`ins.run()`. Callers об этом не знают, coercion внутри.

### sqlite-vec возвращает Euclidean, не cosine

Стандартный `MATCH ... AND k=N` сортирует по L2-distance, не по косинусу.
Но: и query, и stored векторы у нас L2-нормализованы (это делает
`embedder.js::l2Normalise`). Для нормализованных:

```
cos(A, B) = 1 - |A - B|² / 2     ∈ [-1, 1]
```

Конвертим в `database.js::hybridSearch` чтобы в UI отдавать интуитивные
0..1, независимо от внутренней метрики vec0.

### Pre-built dylib для arm64

`sqlite-vec-darwin-arm64` ставится как optional dep, кладёт `vec0.dylib`
рядом — компиляции не нужно. Загружается через `sqliteVec.load(db)` сразу
после `new Database(...)` в `getDb()`, до выполнения `SCHEMA`.
`CREATE VIRTUAL TABLE items_vec` идёт отдельным `try/catch` — если
extension не загрузилась, FTS-поиск всё равно работает.

В **production**-сборке `sqliteVec.getLoadablePath()` возвращает путь
внутри asar (`...app.asar/node_modules/.../vec0.dylib`), но
`db.loadExtension()` не открывает файлы из packed asar — нужен реальный
fs-путь. Решение и asarUnpack-конфиг — `fix-production-asar-spawn.md::
Другие prod-only path-ловушки`.

## 🪙 RPM-троттлинг — внешний факт Gemini

**`batchEmbedContents(100)` биллится как 100 запросов в RPM-квоте**, не как
1. Это не очевидно из документации API и не из формы вызова — у нас один
HTTP round-trip, у Google это N отдельных юнитов. На tier=3K RPM мы
упёрлись в `429` после ~30 батчей по 100 сообщений за минуту.

> **Симптом:** индексация падает с `Gemini 429: You exceeded your current
> quota` где-то на 3000-м сообщении. В AI Studio rate-limits panel:
> `RPM: 2.8K / 3K` (TPM при этом всего `540K / 1M` — половина).

**Решение** в `index-job.js`: rolling-window 60s ledger, target
`RPM_TARGET = 2400` (10% запас для retry на транзиентных 429). Каждый
батч резервирует `batch.length` request-units, ждёт пока окно не осядет.

> **Что пробовали и почему не сработало.**
> Сначала поставил `MIN_BATCH_INTERVAL_MS = 700` (фиксированная пауза
> между батчами). Не помогло — проблема была не в throughput-пиках, а в
> том что мы не считали сколько именно request-units уходит. Юзер
> заметил по AI Studio картинке: TPM не упирается, RPM упирается. Всё
> переписал на ledger.

Embedder делает retry на 429 с exponential backoff и парсит `RetryInfo`
из ответа Google (`retryDelay: "47s"`).

## 🔎 Поиск: только vec, без FTS+RRF

Текущая реализация `hybridSearch()`: один SQL по `items_vec MATCH ?`,
сортировка по cosine descending, top-N. FTS-ветка отключена.

> **Что пробовали и почему не сработало.**
> Был гибрид FTS5 + vec через Reciprocal Rank Fusion с весами 0.5/0.5:
> `score = 0.5/(60+rk_vec) + 0.5/(60+rk_fts)`. Проблема: на запросе
> `"парсинг телеграм"` FTS возвращал ровно **2 хита по точным словам**,
> которые получали позиции 1 и 2 — наравне с vec-топом из 100 кандидатов.
> RRF не учитывает «глубину» списка и силу совпадения, только позицию.
> Эти 2 натянутых FTS-хита искусственно всплывали выше **реально
> релевантных** vec-хитов с cos=0.78. Юзер задал вопрос «почему рейтинг
> позиции-1 одинаковый?» — выкинули FTS-ветку.
>
> FTS остался отдельной кнопкой `FTS` в `ChatView` (раньше называлась
> `Search`) — для точных строк (имена пакетов, ники, хеши), где vec
> работает хуже. Двух режимов через одну кнопку нет, юзер выбирает явно.

Cmd+Enter → semantic, Enter → FTS. Активная кнопка подсвечивается, после
сабмита список не пересортировывается при смене режима без нового сабмита.

### Эмпирические пороги cosine

Калибровка для Gemini `gemini-embedding-001` с `taskType=RETRIEVAL_*` на
русскоязычном чате:

| cos | категория | значение |
|---|---|---|
| ≥ 0.70 | strong | прямо про твою тему |
| 0.55-0.70 | medium | смежное, тот же домен |
| < 0.55 | noise | случайное «ближайшее» из 100 |

В UI `ChatView::confidenceColor()`: green/yellow/rose. **Не переносится на
другие модели** — у BGE-M3, Jina, Voyage свои шкалы. При смене модели —
заново калибровать.

Топ-100 vec возвращает **всегда**, даже если в базе нет ничего по теме.
Поэтому ползунок «Порог релевантности» (default 0.50) фильтрует клиентски
без перезапроса. Юзер двигает — результаты пропадают/появляются мгновенно.

### Load-more `+50`

В sqlite-vec нет offset/cursor — `k` фиксируется на этапе MATCH. Поэтому
кнопка `Показать ещё +50` делает full re-query с увеличенным `k`. Не
красиво, но единственный способ. Heuristic: если вернулось ровно
`semLimit` записей — кнопка есть; если меньше — `Всего N результатов ·
больше нет`.

## 🧮 Прогресс-бар: кумулятивная семантика

`SourceDetail.jsx` подписан на `job:update` для `tg_index`. На каждом тике
дёргается `tgIndexStatus(sourceId)` → возвращает:

```js
{ state: 'running', done: initial_indexed + items_done, total: initial_indexed + items_total }
```

`initial_indexed` снимается snapshot'ом при старте job (`vectorCountForSource()`).
**Зачем:** если у юзера было 3000 проиндексировано и он жмёт «индексировать
ещё 6500» — бар должен показать `3000 → 9500`, не `0 → 6500`. Без snapshot'а
прогресс «сбрасывался к нулю» каждый раз при rerun, что выглядело как баг.

`CoverageBars.jsx::indexable` = сумма `with_caption` по всем type-rows
(не только `type='text'`), потому что indexer покрывает любое сообщение
с непустой caption — включая photo/document с подписью. Знаменатель
`Math.min(indexed, indexable)` clamp защищает от случая когда фактических
индексированных больше чем «text-rows» (баг до фикса показывал
`9684 / 9161 (100%)` с большим первым числом).

## 🤖 MCP-сервер для Claude Code

`mcp/server.js` — MCP-провайдер с Telegram-тулами и соседними non-semantic tools. Эта секция описывает Telegram/RAG-контракт; Reddit fetch/read tools (`reddit_search`, `reddit_thread_fetch`, `reddit_source_items`, `reddit_thread_tree` и сервисные state/list/job tools) живут в том же сервере, но документируются отдельно в `fact-reddit.md`, потому что это бесплатный `.json` парсинг + library read, а не vector search. Twitter/X tools (`twitter_search`, `twitter_thread_fetch`, `twitter_media_fetch`, `twitter_source_items`, `twitter_thread_tree` и state/list tools) тоже живут здесь же и документируются отдельно в `fact-twitter.md`, потому что это browser-MCP парсинг реальной X-сессии + library read.

Telegram tools:
- `list_telegram_chats` — какие чаты доступны для поиска (только с
  `items_indexed > 0`).
- `telegram_list_sessions` — inventory Telegram-аккаунтов; агент использует его
  перед приватными диалогами, где один и тот же человек может существовать только
  в конкретной Telethon-сессии.
- `telegram_list_sources` / `telegram_source_state` — локальное состояние всех
  Telegram sources, включая fetched-but-not-indexed. Не путать с
  `list_telegram_chats`, который намеренно показывает только уже индексируемые
  чаты для vec-поиска.
- `telegram_list_folders` — локальный inventory Telegram-папок из `folders`
  для активной или явно выбранной сессии; с `all_sessions` показывает срез по
  всем аккаунтам, но не меняет active session.
- `telegram_refresh_folders` — стартует настоящий `tg_folder_refresh` job для
  выбранной сессии. Это не read-only call: он ходит в Telethon dialogs и
  материализует `folders`/`folder_sources`, как UI refresh.
- `telegram_folder_state(folder_id/title, session/profile)` — состояние папки:
  sources, counts, auto flags и привязка к session. Используется когда агенту
  нужно понять что лежит в папке вроде `😑events`, не кликая UI.
- `telegram_search_chats(query, folder, session/profile, all_sessions)` —
  fuzzy-поиск по уже сохранённым Telegram sources. Это быстрый library lookup,
  не live Telethon resolve и не fetch.
- `telegram_resolve_chat(text, session/profile, fuzzy)` — live scan по dialogs
  выбранной сессии, когда чата ещё нет в БД.
- `telegram_fetch` / `telegram_preview_fetch` / `telegram_index` — тот же
  job-runner, что UI: можно сначала подтянуть отсутствующий чат, затем
  проиндексировать его для RAG.
- `telegram_semantic_search(source_id, query, limit, min_cos)` — vec-поиск
  внутри чата. `min_cos` фильтр по умолчанию 0.55 — отрезает noise.
- `telegram_neighbors(item_id, before, after)` — сообщения ±N по времени
  вокруг найденного, для реконструкции ветки которую видел Late Chunking
  при индексации. Хорош для **плотных бёрстов** одной темы.
- `telegram_reply_thread(item_id, max_depth, max_descendants)` — реплай-
  цепочка (ancestors + descendants) через `parent_external_id`. Хорош для
  **разнесённых по времени тредов** где neighbors не поможет. Подробно
  ниже в секции «🧵 Reply-граф».

`session`/`profile` override у Telegram tools — per-call scope. Он нужен
агенту для приватных диалогов и папок конкретного аккаунта, но не должен
ретаргетить следующий ручной fetch пользователя; active session меняется
только UI-настройкой/логином.

**Агентный flow для отсутствующего Telegram-чата.** Если пользователь просит
*«по профилю f9922 найди последнее сообщение Геннадия сегодня»*, а чата ещё нет
в `sources`, агент не должен падать в raw SQLite или говорить «нет в базе».
Правильная цепочка: `telegram_list_sessions` → выбрать/заматчить `profile`
(`f9922` по username/phone) → `telegram_resolve_chat({text:"Геннадий", profile,
fuzzy:true})` → взять numeric `chat_id` → `telegram_fetch({target:chat_id, profile,
mode:"date_range", date:<today>, date_to:<today>, types:["text","voice"],
process_voice:true})` → poll `telegram_job_status` → `telegram_index(source_id)`.
После этого обычный RAG работает через `telegram_semantic_search`, а точный ответ
по последним сообщениям можно взять из fetched items/sidecar. Важная граница:
`profile`/`session` — per-call override, он не меняет активную сессию SC Desktop.

### `ELECTRON_RUN_AS_NODE=1` обёртка

`mcp/run.sh` запускает сервер не через системный Node, а через
`./node_modules/.bin/electron` в Node-режиме. **Зачем:** `better-sqlite3`
собран под Electron ABI (`NODE_MODULE_VERSION=141`), системный Node
(`NODE_MODULE_VERSION=132/...`) не загрузит native module — ошибка
`ERR_DLOPEN_FAILED`. Electron в Node-режиме сохраняет тот же ABI, так
что MCP открывает ту же `library.db` без дополнительной сборки или
дублирования кода.

Альтернатива была — отдельная сборка `better-sqlite3` под Node — но
это второй native binary в репо, второй `npm rebuild`, рассинхрон
версий. Через wrapper всё одинаковое.

### WAL и параллельная работа с десктопом

SQLite в WAL-mode допускает много читателей параллельно с одним
писателем. MCP — читатель (через embed запроса в Gemini → SELECT по
items_vec). Десктоп пишет (индексер вставляет векторы). Конкурентный
запуск безопасен, `busy_timeout = 30000` уже стоит в `getDb()`.

### Регистрация в Claude Code

`.mcp.json` в корне проекта:

```json
{
  "mcpServers": {
    "sc-desktop-tg-search": {
      "command": "/Users/fedor/Desktop/sc-desktop/mcp/run.sh"
    }
  }
}
```

Claude Code подхватывает project-scoped `.mcp.json` при старте сессии в
этой директории. После «Trust this MCP server?» — тулы доступны рядом
с Read, Bash, WebFetch.

### Production `.app` не содержит MCP-код

`Build and Store` / `npm run build:install` обновляет `/Applications/SC Desktop.app`
и packaged Electron main/renderer, но project-scoped MCP берётся **не из app.asar**.
`.mcp.json` указывает на `/Users/fedor/Desktop/sc-desktop/mcp/run.sh`, а wrapper
запускает workspace `mcp/server.js`. Проверено на production build 2026-06-13:
`app.asar` содержит обновлённый `electron/database.js` (включая `media_path` upsert),
но не содержит `mcp/server.js` и `mcp/twitter-browser.js`; fresh `tools/list` через
`.mcp.json` при этом увидел новые `twitter_*` tools из рабочей копии.

Следствие: после правки MCP нужно перезапускать MCP-сессию/Claude connection, но
пересобирать `.app` для самих tools не обязательно. Если когда-нибудь нужен
self-contained prod MCP из `/Applications`, тогда `mcp/**/*` надо явно добавить в
`electron-builder.files` или `extraResources` и поменять регистрацию; сейчас это
не сделано намеренно.

> **Альтернатива (хуже):** CLI-скрипт `sc-search "запрос"` через Bash.
> Минус: CC не «понимает» что у него такой инструмент есть, юзер должен
> явно просить и точно формулировать запрос. MCP даёт авто-discovery.

## 🌉 Cross-project MCP: gt-editor notes

Тот же `mcp/server.js` обслуживает второй корпус — markdown-заметки gt-editor.
Не отдельный сервер, не отдельная регистрация — те же `mcp/run.sh` и `.mcp.json`,
просто дополнительные тулы с префиксом `gt_*`. Один Claude в одной сессии имеет
доступ и к Telegram-чатам, и к заметкам.

**Поисковые тулы:**
- `gt_list_indexed_folders` — какие папки индексированы (root, files, chunks, last_indexed_at, stale-stats считаются отдельно через gt-editor IPC)
- `gt_search(query, root?, limit, min_cos)` — vec-поиск; `root` опционален, без него ищем по всем индексированным корням
- `gt_note_chunks(note_id|path, offset, limit)` — все параграфы файла в idx-порядке (аналог `telegram_neighbors` но в пределах одного файла)
- `gt_note_content(note_id|path)` — полный сырой markdown с диска через `fs.readFileSync` (заметки локальные, не нужно дёргать API)
- `gt_neighbors(chunk_id, before, after)` — ±N параграфов по idx внутри той же заметки

**GT Editor metadata tools.** В тот же MCP добавлены `gt_list_background_palette`,
`gt_get_line_backgrounds`, `gt_set_line_backgrounds`. Это не поиск, но это та же
внешняя поверхность для агентов вроде Voice Record: текст они правят через свои
file tools, а фон строки меняют как metadata GT Editor. `gt_set_line_backgrounds`
пишет `gt-line-backgrounds` в SQLite и после этого вызывает
`gteditor://line-backgrounds-changed?path=<abs>` через `open -g`, чтобы уже
открытые окна GT Editor перечитали карту и обновили EditorView. Если модель
пытается выполнить `list_background_palette` в bash и получает `command not
found`, проблема не в палитре, а в том, что MCP tool был вызван не той
поверхностью.

**Почему не импортируем `gt-editor/electron/database.js`.** Там module-level
`let db = null` singleton + зависимость от `electron.app.getPath('userData')`.
Импорт в наш sc-desktop process выкрутил бы это singleton'ом *чужого* приложения,
конфликтуя с нашим `db = require('./electron/database.js')`. Вместо этого открываем
**второй handle** напрямую через `better-sqlite3`:

```js
const Database = require('better-sqlite3')
const sqliteVec = require('sqlite-vec')
const gtDb = new Database(GT_DB_PATH)
gtDb.pragma('journal_mode = WAL')
gtDb.pragma('busy_timeout = 30000')
sqliteVec.load(gtDb)
```

`GT_DB_PATH` дефолтит `~/Library/Application Support/gt-editor/storage.db`,
можно переопределить через env `GT_EDITOR_DB`. Тулы создают этот handle лениво
(только когда вызван первый `gt_*` тул) — чтобы Telegram-only сессии не тащили
gt-editor зависимости.

**WAL + параллельная работа с gt-editor desktop.** Безопасно: gt-editor может
писать (индексер), MCP читает. Тот же паттерн что используем для sc-desktop/library.db.
Конкурентный запуск двух Electron-приложений + одного MCP — тестировался, OK.

**Embedder делится.** Не дублируем embed-логику. `embedQuery(text)` из
`electron/embedder.js` возвращает 768d L2-normalised вектор от Gemini
embedding-001 — идентично тому что gt-editor использует при индексации,
поэтому cosine считается корректно. **Зависимость:** обе системы должны
использовать одну и ту же модель и одну размерность; смена embedder'а в
gt-editor (например на локальный multilingual-e5-small/384d) сломает
cross-project поиск пока sc-desktop не подхватит то же изменение.

**Cosine-формула та же.** `cos = 1 - distance² / 2` для нормализованных
векторов (см. секцию «sqlite-vec gotchas» выше). Применяется одинаково
к `items_vec` (Telegram) и `search_chunks_vec` (notes).

**Префиксы тулов** не конфликтуют. Claude видит:
```
list_telegram_chats / telegram_semantic_search / telegram_neighbors /
telegram_reply_thread / telegram_get_by_external_id
gt_list_indexed_folders / gt_search / gt_note_chunks / gt_note_content / gt_neighbors
gt_list_background_palette / gt_get_line_backgrounds / gt_set_line_backgrounds
```
По описанию каждого тула в schema (английский, специфический) Claude
сам выбирает что использовать — нет жёсткой привязки к проекту. Если
пользователь в чате говорит «найди в моих чатах» → telegram-тулы; «найди
в моих заметках» → gt-тулы.

**PK не пересекаются между корпусами.** `item_id` из `telegram_semantic_search`
**нельзя** передать в `gt_neighbors` — это разные id-пространства, упадёт
или вернёт мусор (если PK случайно совпали). Аналогично наоборот. Claude
обычно сам не путает (тулы названы по-разному), но при ручном вызове
из чата нужно явно различать.

**Промпт для Claude-агента** (опционально): для Telegram — этот файл-промпт
рядом в `docs/meta/поиск-по-rag.prompt.md`. Для заметок — общий prompt в
`/Users/fedor/Global-Templates/🧩 Code-Patterns/документация/rag/поиск-по-rag-gt.prompt.md`.
Без них Claude делает один `gt_search` и отвечает, без wide-search волны.

## 🧵 Reply-граф (`telegram_reply_thread`)

Late Chunking прячет соседей по времени в вектор сообщения, но **разнесённые
по часам/дням reply-цепочки** оно не покрывает. Типичный кейс: короткий ответ
*«они ущербны, посоветуйте годные»* через 10 минут после исходного поста —
эмбеддинг такой реплики мусорный, поиск её не найдёт. Time-window neighbors
тоже не помогает — между постом и репликой 200 сообщений другой темы.

Решение — отдельный MCP-тул `telegram_reply_thread(item_id, max_depth=10,
max_descendants=100)` поверх `parent_external_id`. Два рекурсивных CTE:

- **ancestors** — `(source_id, external_id) ← (source_id, parent_external_id)`
  транзитивно вверх. Останавливается на `max_depth` хопов или когда
  parent_external_id NULL.
- **descendants** — обратное ребро `parent_external_id = external_id`,
  bounded по `max_descendants` чтобы 50+ репликовых веток не утопили контекст.

Возврат: `{center, ancestors[], descendants[], ancestor_chain_truncated,
descendants_truncated}`. Truncation-флаги — честный сигнал «дерево глубже,
подними лимит» вместо тихого обрезания. Каждый узел несёт `hop` (расстояние
от center'а), `published_at`, `sender`, `caption` (8000 → 800 char trim).

**Инструкция по использованию:**
- semantic_search → найти кандидатов
- хит в плотном бёрсте обсуждения (несколько сообщений на одну минуту,
  одна тема) → `telegram_neighbors` (time-window)
- хит в длинной цепочке *«1-минута на ответ, потом тишина час»* → `telegram_reply_thread`
- **не уверен** → звать оба параллельно, выдача разная по структуре, не
  смешивается

> **Что пробовали и почему не сработало.**
> Сначала пытались уместить «ответы на хит» внутрь `telegram_neighbors` через
> флаг `include_replies`. Получилось грязно: одна выдача с двумя разными
> концепциями (соседи по времени vs reply-граф), ассистенту тяжело понимать
> откуда что пришло. Вынесли в отдельный тул — звать можно параллельно,
> структура каждого ответа понятна.

### Topic-marker не reply

В forum-supergroup'ах `msg.reply_to.reply_to_msg_id` присутствует на каждом
сообщении — указывает на **корень топика**, не на reply. Telethon выдаёт
дополнительное поле `reply_to_top_id`: если `reply_to_msg_id == reply_to_top_id`,
сообщение «просто в этом топике», не настоящий reply. `tg_fetch_json._reply_to_for`
эту пару фильтрует и возвращает None, иначе все 100% сообщений форум-чата
считались бы reply'ями на root-пост топика.

### Backfill для исторических items

Старые fetch'и (до этой фичи) писали items без `parent_external_id`. Полный
re-fetch через iter_messages — дорого и долго. Альтернатива —
`tg_reply_backfill_ndjson.py`: смотрит `listItemsMissingParent(source_id)`,
батчами по 100 дёргает `client.get_messages(entity, ids=[...])` — это
дешёвый Telegram API path без re-pagination. Эмитит `item-update` events,
JS-сторона делает `bulkUpdateParentExternalId` пачками по 100.

**Скорость:** Telegram throttle на `get_messages` — мягкий, не FloodWait.
~5-10 items/sec на больших чатах (21k чат — ~36 минут walltime). На FloodWait
есть retry с `await asyncio.sleep(seconds+1)`, но он редко срабатывает в
нормальной нагрузке.

Auto-spawn из `tg:index` IPC запускается **только после того, как реально
стартовал Gemini index-job**. Backfill вынесен из синхронного click-path в
`setImmediate`: сначала пользователь получает `{ok:true, jobId}`, потом main
проверяет `listItemsMissingParent` и, если есть unresolved items, стартует
`tg_reply_backfill`. **Параллель безопасна:** Gemini-индекс читает `caption`
из БД и пишет в `items_vec`, backfill пишет в `items.parent_external_id +
reply_resolved` и `items.reactions + reactions_resolved`. Разные columns,
разные API — не конфликтуют.

Почему не делать проверку/backfill до ответа `tg:index`: на полностью
проиндексированном чате клик по «Индексировать» раньше мог не стартовать
индекс вообще, но всё равно запускал скрытый Telethon-backfill. Для юзера
это выглядело как «нажал индекс — приложение лагает», хотя видимой
индексации не было. No-op индекс не должен выполнять maintenance-задачи
внутри клика.

> **Гард от session-lock.** Backfill отказывается стартовать если на том же
> source уже бежит другой Telethon-job (`tg_fetch`, `tg_folder_fetch`,
> `tg_preview`, другой backfill). См. `fix-telethon-session-lock.md::
> Backfill auto-spawn гард` — busy_timeout 30s не покрывает 5000-item fetch
> который держит лок дольше. Главный код в `tg:index` ловит refusal как
> `[tg:index] reply-backfill deferred: ...` и продолжает с индексом без
> ошибки.

### `noop` ответ от `tg:index`

Если `selectItems` возвращает пустой массив (всё уже проиндексировано),
main.js отвечает `{ok:true, noop:true, reason:'already-indexed'}` — UI
показывает toast «Все сообщения уже проиндексированы». Раньше синтетический
done-job эмитился без следа в Истории парсинга и без визуального фидбека
(казалось «индекс прошёл мгновенно, ничего не понятно»).

> **Почему не пишем no-op в `jobs` table.** При повторных кликах History
> засорилась бы 0-msg row'ами без полезной информации. Toast достаточен —
> юзер видит «ага, всё уже сделано», и след не остаётся.

No-op теперь также означает **не запускать `tg_reply_backfill`**. Если индекс
уже готов, кнопка в SourceDetail переходит в «Индекс готов» и disabled-state,
а backend логирует `[tg:index] source #... noop reason=already-indexed
total_ms=...`. Шрам с lag/root-cause и SQL timings — `fix-лаг-индексации.md`.

### JobDetail toggle `Google RAG`

На странице `tg_fetch` есть per-job toggle `Google RAG`: он означает «после
успешного завершения этого конкретного парсинга запустить semantic index».
Флаг хранится в `jobs.parameters_json` как `_auto_index_after_fetch`, потому что
это не source-level настройка и не folder `auto-index`: пользователь мог
захотеть RAG именно после тяжёлого backfill job, не меняя фоновые правила чата.

Автозапуск стоит после финального close-path `tg_fetch`: items уже записаны в
SQLite, `jobs` row уже обновлена, и только затем вызывается `indexJob.start({
origin:'tg-fetch-auto-rag' })`. Если toggle включают на уже завершённой job,
тот же старт выполняется сразу. Результат фиксируется рядом в params:
`_auto_index_after_fetch_started`, `_auto_index_after_fetch_noop` или
`_auto_index_after_fetch_error`, чтобы JobDetail после remount не показывал
ложно «можно включить заново».

Этот путь не проходит через IPC `tg:index` и не обязан запускать hidden
`tg_reply_backfill`: он следует сразу за свежим `tg_fetch`, где reply/reactions
уже приходят из Telethon. Если нужен maintenance-backfill исторических строк,
это остаётся задачей ручного `tg:index`/reply-backfill path, а не post-close
автозапуска.

## 🔑 Gemini API key

Embedder и Python workers читают ключ из env или общего
`~/.config/sc/settings.json` (`api_keys.GEMINI_API_KEY` /
`api.gemini_api_key`). Это сознательно заменило старый `config.env`-контракт:
production-бандл не должен зависеть от файла рядом со скриптами, а ключи
должны обновляться одним способом для Node embedder'а и `python-workers`.

Симптом неправильного источника ключа: в dev «починили» `config.env`, но
production history продолжает писать `Ключ Gemini недоступен`. Проверять надо
env процесса или settings.json, не `Contents/Resources/python-workers`.
