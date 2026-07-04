# Knowledge: SQLite Library

`~/Library/Application Support/sc-desktop/library.db` — общая БД для Electron-приложения и CLI `sc`. **Обе стороны открывают её одновременно** (WAL mode разрешает); никаких дублирующих копий не делаем.

## 🔁 Dual-source schema (важно при изменениях)

Schema живёт в **двух местах**:
- `electron/database.js` — JS-сторона (`SCHEMA` константа)
- `~/Desktop/sc-desktop/python-workers/shared/library_db.py` — Python-сторона (`SCHEMA_V1` константа)

**Обе должны совпадать.** При добавлении колонки/таблицы — менять обе. Пока миграций не введено, используем idempotent `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE … ADD COLUMN` блоки в `try/catch` для backwards-compat при upgrade dev DB.

Когда дойдём до v2 — выносить SQL в `electron/migrations/000N_*.sql` и runner; обе стороны читают из одного места.

### Forum-topic колонки в `items`

`items.topic_id INTEGER` + `items.topic_title TEXT` (NULL для не-форум чатов
и не-Telegram items). Индекс `idx_items_topic ON (source_id, topic_id)` —
для chip-row aggregate query (`listSourceTopics`) и фильтра по теме в
ChatView. Семантика и pre-fetch tо id→title — `fact-telegram-topics.md`.

### `parent_external_id` + `reply_resolved` — двухслойный reply-граф

Колонка `parent_external_id TEXT` изначально была Reddit-only (для дерева
комментов с `depth INTEGER`). Сейчас она же используется для **Telegram
reply-графа**: при fetch'е сообщения, у которого `msg.reply_to.reply_to_msg_id`
указывает на другое сообщение в том же чате, parent пишется как строка с этим
msg_id. Индекс `idx_items_parent ON (source_id, parent_external_id)` обслуживает
и Reddit-CTE для thread fetch'а, и MCP-tool `telegram_reply_thread` (см.
`fact-semantic-search.md`).

Парная колонка `reply_resolved INTEGER NOT NULL DEFAULT 0` — отдельный sentinel
от `parent_external_id IS NULL`. Без неё backfill зацикливается:
`parent_external_id IS NULL` означает одновременно «нет родителя» (нормальный
случай для не-reply сообщений) и «ещё не проверено» (старые items до
backfill'а). Скрипт смотрит `WHERE reply_resolved=0` и пишет `=1` после check'а —
теперь два состояния разделены.

В `upsertItem` UPDATE-ветке стоит `reply_resolved = MAX(items.reply_resolved,
excluded.reply_resolved)` — без MAX любой metadata-only re-upsert (например
caption refresh) сбрасывал бы 1 на 0, и backfill снова забирал бы строку.
Reddit-flow про reply_resolved не знает, передаёт undefined → coerce в 0,
что для Reddit фактически инвариант (reply-структура там приходит из API
сразу полная, backfill не нужен).

### `items.reactions` + `reactions_resolved` — Telegram-реакции

`reactions TEXT` (JSON-массив `[{e:'👍', n:8}, ...]`) и парная
`reactions_resolved INTEGER NOT NULL DEFAULT 0` — те же два слоя, что у
`parent_external_id` / `reply_resolved` выше. Источник — `msg.reactions.results`
в Telethon; `ReactionEmoji` кодируется как `e=emoticon`, `ReactionCustomEmoji`
как `e='custom:<document_id>'`. Семантика читается **только парой колонок**:
`reactions_resolved=0 AND reactions IS NULL` — не проверено;
`reactions_resolved=1 AND reactions IS NULL` — проверено, но Telegram/Telethon
не дал конкретный список; `reactions_resolved=1 AND reactions='[]'` —
проверено, реакций нет; populated JSON — сами реакции с count'ами.

Реакции **не** индексируются (ни FTS, ни эмбеддинг) — это социальный сигнал
«сообщение зацепило», не семантический. Используются:
- `ChatView::ReactionsRow` — chip-row под caption.
- `assemble.js::_formatReactions` — приклеивает `[👍8 ❤️2]` к телу при копировании.
- MCP-tools (`telegram_semantic_search` / `telegram_neighbors` /
  `telegram_reply_thread`) возвращают `reactions: { total, top: [...] }`
  в каждом hit — LLM сам решает, фильтровать ли по «обсуждаемости».

`bulkUpdateParentExternalId` (`database.js`) умеет писать одновременно и
parent, и реакции в одном UPDATE: `tg_reply_backfill_ndjson.py` зовёт один
`client.get_messages(ids=batch)`, который Telethon отдаёт оба поля разом.
`listItemsMissingParent` фильтрует `WHERE reply_resolved=0 OR reactions_resolved=0`,
один проход чинит оба пробела.

`reactions=NULL` сам по себе **не** sentinel. Реальные логи на source #48
показали 105 строк с `reply_resolved=1`, `reactions_resolved=0`,
`reactions=NULL`: каждый `tg:index` снова запускал `tg_reply_backfill`,
Python снова возвращал `reactions: null`, и строка оставалась pending.
Поэтому backfill-ответ с явным `reactions: null` защёлкивает
`reactions_resolved=1`; только отсутствие поля `reactions` в событии
сохраняет прежнее значение. Подробный шрам — `fix-лаг-индексации.md`.

### `post_comments` — отдельная таблица под TG обсуждения

Telegram комменты под постом канала живут в **связанной discussion-группе**
(другой чат с другими msg_id), не в самом канале. `sources.has_discussion`
(NULL=unknown / 0 / 1) ставится один раз при entity-resolve через
`GetFullChannelRequest.full_chat.linked_chat_id`. UI читает его до запуска
fetch'а (грейит `[Комментарии]` чекбокс если 0).

Сами комменты идут в `post_comments(source_id, post_external_id, comment_id,
parent_comment_id, sender, text, date)` с `UNIQUE(source_id, post_external_id,
comment_id)` и `idx_post_comments_post(source_id, post_external_id)`. FK
`ON DELETE CASCADE` на source_id — удаление канала чистит и комменты.

> **Что отбросили:** смешивать комменты в `items`. Comment'ы — message'и
> чужого чата (linked discussion), их `comment_id` пересекается с настоящими
> `items.external_id` (msg_id канала). UNIQUE(source_id, external_id) ловит
> коллизии на любом канале где id треда совпадает с id поста. Отдельная
> таблица + composite UNIQUE решает на уровне схемы.

> **Что отбросили:** хранить как JSON в `meta_json` поста. Не скейлится:
> 138 комментов × 50 постов = 7000 объектов в JSON-тексте, любой list/copy
> грузит всё в память. Indexed table + JOIN по `(source_id, post_external_id)`
> отдаёт срез по посту мгновенно.

Подробнее про fetch-flow и UI — `fact-telegram-comments.md`.

### `sources.is_explicit` — отделение запрошенных каналов от случайных

`sources.is_explicit INTEGER NOT NULL DEFAULT 0` — поле для разделения
«целенаправленно запрошенных каналов» (юзер ввёл `@channel`, fetch-channel,
batch-pick) от «случайных» (single-paste отдельного видео из browser
extension'а). LibrarySidebar группирует первые сверху, вторые — в
свёрнутый блок «Прочее (N)» (см. `fact-architecture.md::LibrarySidebar`).

**Где ставится `is_explicit:true`:**
- TG fetch (mode != single) — через `db.upsertSource({...is_explicit:true})`
- TG preview (preview-only через config-form) — там тоже юзер ввёл @канал
- YouTube channel fetch (`startYoutubeChannelFetch`)
- TikTok channel fetch
- Instagram profile fetch
- Reddit thread / search

**Где НЕ ставится (остаётся 0):**
- `startYoutubeSingle` (single-paste видео — и из самого sc-desktop, и из
  bridge `/yt-add` от расширения; см. `fact-yt-extension-bridge.md`)
- TikTok single

**Семантика «защёлкивается в 1».** На UPSERT флаг обновляется через
`MAX(sources.is_explicit, excluded.is_explicit)`. Без MAX был бы баг:
юзер целенаправленно фетчит канал → `is_explicit=1`. Через неделю получает
single-paste отдельного видео того же канала → дефолтный `is_explicit=0`
перезатёр бы. Канал бы «разжаловался» в Прочее. С MAX — однажды поднял в
1, никто не понизит.

**Backfill для старых row'ов** (миграция при первом open()):
```sql
UPDATE sources SET is_explicit = 1
 WHERE is_explicit = 0
   AND (avatar_url IS NOT NULL
        OR (SELECT COUNT(*) FROM items WHERE source_id = sources.id) > 1)
```
Аватарка качается только при фактическом channel/entity request (single-
paste кладёт source без аватарки). >1 item значит юзер фетчил список.
Один из критериев достаточно — поэтому OR.

> **Что отбросили:** backfill через `display_name IS NOT NULL`. Single-paste
> тоже его ставит (`channel_name` из yt-dlp event'а). Слишком широкий
> критерий — backfill сделал бы explicit=1 для всех single-paste каналов.

### Demote-миграция для folder-only chats (Telegram)

`folder resolve` для каждого чата в Telegram-папке скачивает аватар (профильное
фото — для Avatar-компонента в TelegramScreen). Avatar-based backfill из
секции выше из-за этого автоматически промоутил чаты папок в `is_explicit=1`,
даже если юзер их никогда сам не фетчил → sidebar засирался 300+ строками.

Лечение — идемпотентная **demote-миграция** в том же `getDb()`, **после**
backfill'а:
```sql
UPDATE sources
   SET is_explicit = 0
 WHERE platform = 'telegram'
   AND is_explicit = 1
   AND id IN (SELECT source_id FROM folder_sources)
   AND NOT EXISTS (
     SELECT 1 FROM jobs j
     WHERE j.source_id = sources.id
       AND j.type LIKE 'tg_%'
       AND (j.parameters_json IS NULL
            OR json_extract(j.parameters_json, '$._folder_umbrella_id') IS NULL)
   )
```
Критерий — был ли когда-нибудь **direct** (не-folder) fetch-job для этого
source. `_folder_umbrella_id` в `params` ставит `startTelegramFolderFetch` для
каждого чата зонтичного fetch'а — отличает «спарсили в составе папки» от
«юзер сам ввёл @handle». Direct fetch остаётся explicit, любой будущий direct
fetch автоматически промоутит обратно через MAX-семантику в `upsertSource`.

> **Что отбросили (v1):** критерий `items=0` вместо `NOT EXISTS jobs`. Папочный
> fetch тоже наполняет items — после первого же фолдер-парсинга чат уходил
> обратно в explicit и засирал sidebar. См. историю в `fact-telegram-folders.md::sidebar`.
>
> **Что отбросили (v0):** ужесточить backfill критерий («avatar AND not in folder_sources»).
> Не сработает при первом резолве папок — на момент `getDb()` `folder_sources`
> ещё пустая, потом наполняется через folder-resolve.

### `folders` + `folder_sources` (Telegram)

Папка из Telegram-клиента — **указатель на чаты**, не отдельная content-store.
Содержимое каждого чата идёт в обычную `items` table; принадлежность —
junction-таблица `folder_sources`.

```sql
folders         (id, tg_filter_id, title, tg_session,
                 default_period_days, default_types_json,
                 last_fetched_at, UNIQUE(tg_filter_id, tg_session))
folder_sources  (folder_id, source_id)   -- m:n, ON DELETE CASCADE
```

**Никакого folder_items / folder_messages.** items хранятся один раз — даже
если чат входит в несколько папок. `assemblyEstimate({source_ids[]})` принимает
список и фильтрует одним SQL-WHERE. См. `fact-telegram-folders.md`.

**UNIQUE расширен до (tg_filter_id, tg_session).** DialogFilter.id нумеруется
с 2 внутри КАЖДОГО аккаунта — папки двух сессий коллидируют на id=2,3,…
Старый `UNIQUE(tg_filter_id)` физически не давал держать обе. `CREATE IF NOT
EXISTS` существующую таблицу не перестраивает, поэтому в `getDb()` есть
one-shot миграция: детект legacy-автоиндекса (pragma `index_list`/`index_info`)
→ пересборка через `folders_new` + `INSERT SELECT` + `DROP/RENAME`.
**`PRAGMA foreign_keys = OFF` на время пересборки обязателен** — иначе DROP
старой таблицы триггерит `ON DELETE CASCADE` из `folder_sources` и молча
стирает всю привязку папка↔чаты (ловили на dry-run по копии реальной БД:
с FK ON folder_sources пустела, с OFF — 20 строк до и после).

### `sources.tg_session` + `tg_session_conflict` (Telegram)

Имя session-файла, которым чат последний раз читали (NULL = legacy, сессия
неизвестна до следующего fetch). `tg_session_conflict` — latch по той же
схеме, что `reply_resolved` выше: upsert поднимает 1 при upsert'е с другим
непустым именем, гасится **только** явным пином юзера (`setSourceSession`),
сам не сбрасывается. NULL в upsert'е ничего не перезаписывает (COALESCE) —
metadata-only вызовы без сессии не стирают привязку. Семантика и UI —
`fact-telegram-sessions.md::Привязка чатов и папок к сессиям`.

**Dual-source mirror.** Та же mirror-обязанность, что и для основной схемы:
изменение в `electron/database.js::SCHEMA` требует копии в
`python-workers/shared/library_db.py::SCHEMA_V1`. Workers сами с папками не работают,
но открывают ту же `library.db` — без зеркала ALTER упадёт при первом open()
с Python-стороны.

### `busy_timeout` для конкурирующих writers

`getDb()` ставит `db.pragma('busy_timeout = 30000')` сразу после открытия.
WAL-mode сам по себе не предотвращает `database is locked` — он только
разрешает читателей пока writer пишет; конкурирующий writer всё равно
ждёт или падает. С 30-секундным timeout-ом параллельный writer (например,
CLI `sc -t @x` в другом шелле) ждёт в очереди, а не выбрасывает ошибку.

Telethon session-файлы имеют ту же проблему — фикс вынесен в
`fix-telethon-session-lock.md`.

---

## 🪜 Coverage depth ladder

`source_coverage` — таблица коротких записей вида «для source X в диапазоне
Y…Z был просмотрен тип T на глубине D». Несколько записей на один источник
нормально, UI агрегирует.

```
metadata     — есть строка в items, но media_path NULL (файл не качали)
media        — media_path указан (файл скачан, но не транскрибировано)
transcribed  — transcript_path указан (есть текст)
```

Ladder монотонный: depth повышается, никогда не понижается. Когда юзер делает «Дотянуть фото» (TODO) — apply UPDATE на existing items, не INSERT новых, и добавляет новую coverage-запись с depth=`media`.

**Зачем ladder** (а не bool «есть/нет файла»): чтобы UI всегда знал что **сейчас доступно** vs что **было запрошено**. Это даёт детерминированность по принципу методологии — юзер видит «28 фото метаданные, файлы не загружены», и UI может предложить «Дотянуть» точечно по такому source без перетягивания всего.

Для Telegram `from_date` coverage — это **requested interval**, а не min/max
фактически найденных сообщений. Если job просмотрел 20.02.2022→сейчас и первые
реальные сообщения начались только в июле, пустой февраль-июль всё равно покрыт:
повторный запуск не должен ходить туда снова. Поэтому close-handler пишет
`date_from/date_to` из параметров запроса (`params.date/date_to` или время
старта/закрытия), а не из `job.date_min/date_max`, и добавляет нулевые строки
для выбранных бесплатных типов (`text`, `poll` при `process_polls=true`) даже
когда конкретного типа в диапазоне не нашлось.

Старые строки до этого правила могут начинаться с первого найденного сообщения.
Planner компенсирует это read-time: `listCoverage()` отдаёт рядом
`jobs.parameters_json/status`, а `fact-fetch-strategies.md::Coverage planner`
расширяет successful source-wide `from_date` до `params.date`. Не мигрировать
старые rows вручную: их достаточно корректно интерпретировать при планировании.

### YouTube exception: depth `media` пропускается

Для YouTube видео нет «локального файла» в обычном смысле — мы стримим аудио и сразу транскрибируем, mp3 живёт в `/tmp` пока идёт `gemini.transcribe_audio` и удаляется. То есть для youtube items `depth` идёт `metadata` → `transcribed`, минуя `media`. UI это знает: `CoverageBars` принимает `platform` и для youtube не показывает «⚠ файлы не загружены» (это TG-specific сообщение).

---

## 🪤 Detection invariant: «есть метаданные, нет файла»

Это **никогда** не пишется как просто отсутствие записи. У каждого `item` всегда:
- `has_media = 1` если в TG было прикреплено медиа
- `media_path = null` если файл не скачивался (skip-список из CONTENT_TYPES в форме)

UI код полагается на этот invariant в `SourceDetail.jsx::TypeRow` для пометки `файлы не скачаны (N)` и в `ChatView.jsx::MessageRow` для `⚠ Только метаданные ({type})`.

Metadata-only строка может уже знать длительность. Для Telegram voice/video/audio
длительность часто лежит в атрибутах сообщения и пишется в `duration_seconds`
даже когда файл не скачивался. Это намеренно: после text-only прохода UI может
локально оценить будущую AI-нагрузку («8 видео · 4:01») без повторного Telegram
walk и без загрузки бинарников. Не стирать `duration_seconds` при повторном
metadata-upsert'е только потому что `media_path` остаётся NULL.

**Антипаттерн:** удалить строку item потому что «не скачали файл — нечего хранить». Тогда UI потеряет информацию что именно было пропущено.

**Особенность `type='poll'`:** у опроса физического файла нет в принципе (только структура внутри Telethon-объекта), поэтому `has_media=1, media_path=null` — это перманентное состояние, не «пока не дотянули». Без флага `process_polls` в caption пусто (как у фото без подписи), с флагом — caption содержит рендер «вопрос + варианты + голоса». Backfill «дотянуть медиа» к опросам неприменим; для backfill тела используется обычный re-fetch с включённой галочкой «Текст» (см. `fact-fetch-strategies.md::Backfill-кейс`).

---

## 🪪 Source uniqueness: `external_id` для YouTube

`sources` имеет `UNIQUE(platform, handle)`, но для YouTube этого мало: один канал может быть доступен по 4 формам URL (`@durov`, `c/durov`, `channel/UCxxx`, `user/durov`), а handle может смениться (юзер ребрендит канал) при стабильном `channel_id`.

Поэтому `db.upsertYoutubeChannel()` сначала ищет по `(platform='youtube', external_id=channel_id)`, fallback по handle. Lookup-перед-insert функционально эквивалентен второму UNIQUE, без миграции схемы.

Подробнее — `fact-youtube.md::URL canonicalization`.

## 🪪 Source dedup по identity чата (Telegram)

Та же проблема, что у YouTube выше, но в Telegram она долго копилась молча:
один чат приходит как `@username` (folder resolve, paste), голый `<id>`
(resolve-title), `-100<id>` (ссылки `t.me/c/...`), и в другом регистре
username'а. `UNIQUE(platform, handle)` видит их как **разные** строки —
на реальной БД накопилось 9 пар дублей (например `vibecod3rs` с 16k items
и пустой `1187714594` из папки — один и тот же чат). Симптом: чат в
sidebar дважды, история/привязки/coverage растеклись по двум строкам.

`upsertSource` для `platform='telegram'` делает **canonical-lookup перед
INSERT** (как `upsertYoutubeChannel`): ищет существующую строку сначала по
`external_id` (chat id — стабильный идентификатор), потом по
`handle COLLATE NOCASE`, потом по альтернативной числовой форме
(`-100<id>` ↔ `<id>`). Если `external_id` не передали — выводит кандидата
из числового handle (та же конвенция, что `findTelegramSourceByTarget`).
Нашёл строку → UPDATE с теми же правилами, что ON CONFLICT-ветка
(conflict-latch для `tg_session`, MAX для `is_explicit`). Канонизация
handle **в одну сторону**: пришёл username поверх строки с числовым
handle — переименовываем на читаемый (если имя не занято); число поверх
username — не трогаем.

Переносимый принцип (identity = стабильный id, не отображаемая форма) —
`methodology/переносимый-дизайн.md::Identity ресурса`.

> **Что отбросили — полагаться на UNIQUE(platform, handle).** Он ловит
> только точное совпадение строки handle. Расширять его до
> `UNIQUE(platform, external_id)` нельзя: у не-Telegram source'ов
> external_id бывает NULL/неуникален, и миграция existing-дублей всё равно
> нужна отдельным проходом. Lookup-перед-insert решает на уровне кода без
> схемной миграции — как и для YouTube.

## 📦 Что хранится в `sources.meta_json`

Поле было задумано для произвольных платформо-специфичных данных. Сейчас живёт:
- `subs_count` — для youtube channels (Display only).
- `channel_url` — каноничный `/channel/UC...` URL (заголовок жмёт сюда).
- `notes` — заметки юзера к источнику (см. NotesScreen).
- (для Telegram) `kind`, `username` — из `entity` event'а. `kind` уже
  заполнен на реальной базе для существующих чатов и используется как
  дешёвый классификатор TelegramScreen: `user` → личные, `channel` →
  каналы, `group/chat` → чаты. Это не отдельная колонка намеренно: значение
  приходит как платформа-специфичная мета Telethon, а не участвует в FK.
- (для Telegram) `tg_auto` — настройки `auto-pull` / `auto-index` на уровне
  source: `{ pull, index, types, engine }`. `index=true` всегда означает
  `pull=true`; выключение `pull` гасит `index`. Это тоже `meta_json`, а не
  новая таблица: правило принадлежит одному чату, редко меняется, и не
  требует миграции схемы ради пары bool'ов.

Всегда **read-modify-write** при апдейте (`getSourceNotes` → ... → `setSourceNotes`), чтобы не затирать другие ключи. См. `db.setSourceNotes` как образец.
Это правило критично для `tg_auto`: обычный `upsertSource` от entity-event'а
при fetch'е приносит свежие `kind`/`username`, но не знает про auto-режимы.
Если такой patch перезаписывает весь `meta_json`, бейджи `auto-pull` /
`auto-index` пропадают после успешного парсинга, хотя настройка должна жить
дальше. Поэтому source meta мержится key-wise; вложенный `tg_auto` не удаляется
отсутствующим полем в новом patch.

## 🪶 FTS5 contentless mode

`items_fts` объявлена как `content='', contentless_delete=1` — это contentless table. **Нельзя** делать `SELECT caption FROM items_fts` — вернётся NULL. Только:
```sql
SELECT i.* FROM items_fts fts JOIN items i ON i.id = fts.rowid
WHERE items_fts MATCH 'ключ' AND i.source_id = ?
```

При изменении caption/transcript — нужно сначала `DELETE FROM items_fts WHERE rowid = ?`, потом `INSERT INTO items_fts (rowid, caption, transcript) VALUES (...)`. Это в `bulkUpsertItems` уже делается, но новый код должен помнить.

**`contentless_delete=1` обязателен — без него DELETE кидает исключение.**
Contentless-таблица fts5 **по умолчанию** не поддерживает DELETE: попытка
`DELETE FROM items_fts WHERE rowid=?` на существующей строке падает с
`cannot DELETE from contentless fts5 table: items_fts` (контринтуитивно —
обычный SQLite на отсутствующем rowid делает no-op, а тут throw на
**существующем**). Этим валились две вещи: `deleteSource` любого чата с
проиндексированным текстом (вся транзакция откатывалась — чат нельзя было
удалить), и FTS-refresh в `appendItemTranscript`/`markItemTranscribed` для
item'а, чей caption уже в индексе (молча не обновлялся).

Флаг `contentless_delete=1` (SQLite 3.43+) включает DELETE для contentless.
Меняется он **только пересозданием таблицы** — `getDb()` детектит старый DDL
(`sql NOT LIKE '%contentless_delete%'`) и пересобирает один раз: DROP +
CREATE с флагом + reindex (caption из `items`, transcript из файла
`transcript_path`, как в `markItemTranscribed`). На реальной БД ~253k строк
≈ 2.4 сек на первом старте. Зеркальная правка в `python-workers/shared/library_db.py`
(Python-сторона открывает ту же `items_fts`; там же чинили лишнюю колонку
`title` в INSERT — её нет в реальной таблице, INSERT падал
`no column named title`).

> **Что пробовали:** обойтись плейн-`DELETE` без флага — кидает исключение
> на существующей строке (не no-op). `INSERT OR REPLACE` тоже не помогает —
> contentless без флага вообще не даёт удалять старую версию строки.

**Зачем contentless:** размер базы уменьшается на 2x (FTS не дублирует caption). Trade-off — нельзя отдать оригинал из FTS, JOIN обязателен.

## 🎙 `appendItemTranscript` — caption replay для inline AI

Job-runner на каждый `transcript`/`photo-text`/`pdf-text` event'a во время
running tg_fetch не может сразу UPDATE'ить items — items приходят из job
state в один момент (`bulkUpsertItems` в close-handler), AI-events идут
**раньше**. Поэтому events stash'атся в `job.tg_media_results = [{msg_id,
kind, engine, text}]`, и **после** bulkUpsert close-handler делает replay:

```js
db.appendItemTranscript({source_id, external_id, text, engine, kind})
```

Функция:
1. Находит item по `(source_id, external_id)` — если нет, no-op
2. Генерит heading по kind: `[голосовое — расшифровка · gemini]`,
   `[фото — описание · gemini]`, `[документ — извлечение · gemini]`
3. Если caption уже содержит этот heading — body не дублируем (re-fetch
   с тем же engine идемпотентен), но `transcribe_status='done'` и
   `transcribe_engine` всё равно проставляются
4. Иначе — appends `\n\n{heading}\n{text}` к существующему caption
5. Refresh FTS row: `DELETE FROM items_fts WHERE rowid=?` + reindex

**Idempotency через heading, не через kind alone.** Re-fetch с
**другим** engine (юзер сравнивает Gemini vs AssemblyAI) сознательно
**добавляет второй блок** — heading отличается строкой engine'а. Если бы
дедупили по `kind=voice` целиком, второй блок не появился бы. Это not a
bug — это feature: рядом два транскрипта, можно сравнить.

**Зачем `transcribe_status='done'` всегда (даже на skipped append).**
CoverageBars в SourceDetail рисует «✓ N обработано» по count'у
`transcribe_status='done'`, не по факту наличия `transcript_path`. Если
пропускать UPDATE статуса при идемпотентном повторе — после ручного
`UPDATE items SET transcribe_status='none'` (тесты, миграции) повторный
fetch не вернёт счётчик в правильное состояние.

См. также «Caption preservation на UPSERT» ниже — `bulkUpsertItems` (он
запускается **до** этого replay в close-handler) защищает existing
caption с AI-блоком от перезатирания raw `msg.text`'ом, чтобы skip-already-
processed re-fetch (`fact-jobs.md::Skip-already-processed media`) не
превращал caption в pumpkin.

## 🛡 Caption preservation на UPSERT

`upsertItem` в `ON CONFLICT(source_id, external_id) DO UPDATE` для поля
`caption` использует не `COALESCE(excluded.caption, items.caption)`, а
CASE-ветку:

```sql
caption = CASE
  WHEN items.caption IS NOT NULL
       AND (items.caption LIKE '%[голосовое — расшифровка%'
         OR items.caption LIKE '%[фото — описание%'
         OR items.caption LIKE '%[документ — извлечение%')
    THEN items.caption                          -- AI-блок есть → не трогаем
  ELSE COALESCE(excluded.caption, items.caption) -- обычный путь
END
```

**Зачем.** При активном skip-already-processed re-fetch'е (`fact-jobs.md::
Skip-already-processed media`) Python emit'ит `media-skipped` для уже
обработанных msg → `appendItemTranscript` для них **не вызывается** на
close → но `bulkUpsertItems` всё равно UPSERT'ит свежий item-row.
`excluded.caption = msg.text` (то что юзер написал как caption к
голосовому, обычно пустая строка). Без CASE: `COALESCE(excluded, items)` →
если `msg.text` не null, новый caption = `msg.text` → AI-блок,
наработанный в прошлом fetch'е, **теряется**.

**Trade-off.** Если юзер реально отредактировал подпись к голосовому в
самом Telegram («перезалил» с новым caption), новая подпись **не
подтянется** — старая (с AI-блоком) останется. Это редкий кейс vs частая
регрессия с потерей транскриптов: подписи к voice в Telegram почти не
редактируются, а re-fetch'и с включёнными AI-флагами — обычное событие
после изменения engine или прихода новых msg.

**Симптом без CASE-ветки.** Юзер делает второй fetch чата с включённой
галочкой «Голосовые». Skip-already-processed справедливо пропускает
старые msg → AAI не вызывается → стопроцентная экономия квоты. Но через
час юзер замечает что caption у старых голосовых **пустые** или содержат
только сырой `msg.text` — AI-блок, который был в прошлый раз, исчез.
Ищет в логах ошибку appendItemTranscript — её нет, всё чисто. Косяк в
том что blockUpsertItems перезаписал caption на новой записи UPSERT'а
до того как мог бы сработать idempotent append.

См. `fact-jobs.md::Inline AI processing` про upstream — как ndjson-events
генерируются, и почему replay делается на close, а не сразу.

---

## ⚠ Cascade delete invariants

```
sources  ON DELETE CASCADE  → items, source_coverage   (FK работает)
jobs                        → source_id ON DELETE SET NULL (статистика остаётся)
items_fts                   — virtual, не имеет FK. Удалять явно перед DELETE items.
```

Поэтому в `database.js::deleteSource` явный transaction:
1. `DELETE FROM jobs WHERE source_id = ?` (FK не каскадит, нужно вручную)
2. `DELETE FROM source_coverage WHERE source_id = ?` (формально каскадит, но явный надёжнее)
3. `DELETE FROM items_fts WHERE rowid IN (SELECT id FROM items WHERE source_id = ?)` (virtual table)
4. `DELETE FROM items WHERE source_id = ?`
5. `DELETE FROM sources WHERE id = ?`

Если порядок нарушен — sqlite оставит ghost rows в FTS которые матчат на пустоту.

**Шаг 3 работает только потому что `items_fts` создана с `contentless_delete=1`**
(см. «FTS5 contentless mode» выше). Без флага этот DELETE кидал
`cannot DELETE from contentless fts5 table`, **вся транзакция откатывалась**,
и удалить можно было только чат, у которого нет ни одного проиндексированного
caption'а. Симптом: «не могу удалить канал» на любом реально наполненном
источнике, без явной ошибки в UI (throw глотался выше по стеку).

---

## 🧠 Векторный индекс (items_vec)

Поверх той же `library.db` подключается `sqlite-vec` extension и virtual
table `items_vec(item_id INTEGER PRIMARY KEY, embedding float[768])` для
семантического поиска по сообщениям. Pre-built `vec0.dylib` идёт через
optional dep `sqlite-vec-darwin-arm64` — компиляции не нужно.

`getDb()` грузит extension сразу после `new Database(...)`, до выполнения
`SCHEMA`. `CREATE VIRTUAL TABLE items_vec` идёт отдельным `try/catch` —
если extension не загрузилась, FTS-поиск всё равно работает.

> **Gotcha: BigInt PK.** vec0 строгий к типам PK, отвергает обычные JS
> `number` с ошибкой `Only integers are allowed for primary key values on
> items_vec`. Symptom неочевидный — обычный SQLite принимает оба.
> `bulkUpsertVectors` делает `BigInt(item_id)` coercion внутри.

> **Gotcha: `items_vec_rowids` — служебная BLOB-id таблица.** vec0 поверх
> virtual table создаёт три служебные таблицы: `items_vec_chunks`,
> `items_vec_rowids`, `items_vec_vector_chunks00`. Они видны через
> `.tables` и `PRAGMA table_info()`, что вводит в заблуждение — id-колонка
> там без типа (`PRAGMA` показывает её как нормальную), но реально хранит
> **BLOB-формат** vec0. Запрос `SELECT ... FROM items_vec_rowids r JOIN
> items i ON i.id = r.id WHERE ...` всегда возвращает 0 строк, хотя
> данные есть. `MIN(CAST(id AS INTEGER))` тоже даёт NULL. Симптом:
> «индексация только что прошла без ошибок, но прямой JOIN на rowids
> говорит ноль векторов».
>
> **Считай через `items_vec` (PK = `item_id INTEGER`)**, не через
> `items_vec_rowids`. В коде уже есть helper `vectorCountForSource()` —
> используй его, или `WHERE item_id IN (SELECT id FROM items WHERE ...)`.

> **Gotcha: vec0-count запросы блокируют main process.** Для одного source
> быстрый путь — `SELECT COUNT(*) FROM items_vec WHERE item_id IN (SELECT id
> FROM items WHERE source_id=?)`; для списка всех source — один grouped join
> `items_vec JOIN items GROUP BY source_id`. Не делать correlated
> `(SELECT COUNT(*) ... WHERE i.source_id=s.id)` внутри `listSources()`: на
> реальной базе такой вариант ушёл в >60s/100% CPU, а macOS `sample` показал
> main thread внутри `better_sqlite3.node -> sqlite3_step`. Подробности и
> проверенные timings — `fix-лаг-индексации.md`.

Архитектура поиска (Late Chunking при индексации, Gemini API, RPM-троттлинг,
MCP-сервер для Claude Code) — `fact-semantic-search.md`.

## 🔧 electron-rebuild gotcha

**Симптом:** при первом запуске `npm run dev` после `npm install` — лог
```
Error: The module 'better_sqlite3.node' was compiled against a different
Node.js version using NODE_MODULE_VERSION 132. This version of Node.js
requires NODE_MODULE_VERSION 141.
```

**Причина:** `npm install` собирает native module под system Node ABI, Electron использует свой.

**Решение:** `npm run rebuild` (alias на `electron-rebuild -f -w better-sqlite3`). Запускать после:
- свежего `npm install`
- смены major-версии Electron в package.json
- `npm install <native-package>`

Если внутри Electron работает (`[DB] opened ...` есть в логе), а `node -e "require('./electron/database')"` падает с ABI ошибкой — это **нормально**, разные ABI. Не пытаться чинить, просто использовать sqlite3 CLI для проверок DB снаружи.
