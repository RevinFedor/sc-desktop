# Knowledge: Telegram folders

Раздел `Telegram` в боковой панели открывает **TelegramScreen** — общую страницу платформы с табами Telegram-папок и multi-chat batch-операциями.

## 🧠 Mental model

> **Папка — это указатель на чаты, не отдельная сущность.**

Источник правды для папок — клиент Telegram самого юзера (`DialogFilter` через `GetDialogFiltersRequest`). Мы не создаём папки внутри приложения, не редактируем их состав; мы их **резолвим в множество telegram-source'ов** через `tg_resolve_folder_ndjson.py`. Каждый чат внутри становится обычным source row (`platform='telegram'`), а связь хранится в junction-таблице:

```
folders         (id, tg_filter_id, title, default_period_days, default_types_json, last_fetched_at)
folder_sources  (folder_id, source_id)   -- many-to-many, ON DELETE CASCADE
```

Items сохраняются **как обычно** в общую `items` table со ссылкой на `source_id`. Никаких отдельных folder_items / folder_messages — это бы дублировало storage и ломало `assemblyEstimate({source_ids[]})`.

## 🪜 Trip flow

```
Sidebar «Telegram» → pushScreen('telegram')
  ├─ ⟳ refresh → startTelegramFolderRefresh() → job 'tg_folder_refresh'
  │     • walks GetDialogFiltersRequest --all
  │     • upserts folder + setFolderSources for each `folder` event
  │     • prunes folders missing from new sweep (user deleted in TG client)
  │       — СТРОГО только строки с tg_session === job.tg_session. legacy
  │         NULL-папки НЕ трогаем (см. ниже про убитую папку Oku27)
  │
  ├─ Tab клик (folder) → folderListSources(id) → render checkbox list
  │
  └─ «Спарсить (N)» → folderFetch IPC → startTelegramFolderFetch()
        • job 'tg_folder_fetch' (umbrella) sequentially spawns N×tg_fetch
        • each child carries _folder_umbrella_id in params
        • ActivityPanel filters children, renders only umbrella row
```

## 🔧 Конкретные правила

### Sidebar — folder-only chats прячутся в «Прочее»

Чаты, добавленные в Library *только* через folder resolve (никогда не парсились отдельно), идут с `is_explicit=0`. Эвристика sidebar (`LibrarySidebar.jsx`) сворачивает их в подгруппу `▸ Прочее (N)`. Не загромождает основной список из 8 явно добавленных каналов 300+ чатами папок.

**Вторая причина демоции (TG-only): 0 сохранённых сообщений.** Explicit-чат без единого item'а — заброшенный или ещё не спарсенный, контента за ним нет. Они затопляли основной список (288 из 371 на реальной БД), хороня рабочие каналы. `splitSources()` уводит их в то же «Прочее» до первого fetch'а. Внутри «Прочего» сортировка — по `last_synced_at` DESC (дата последнего запроса, не алфавит): чат, который юзер только что пробовал, всплывает наверх, где его легко найти. Не-TG платформы правило не трогает — YT-канал с 0 видео всё равно осмыслен (picker живёт на его странице).

`upsertSource` в `handleEvent` (на entity-event) проверяет `params._folder_umbrella_id` и **не повышает** `is_explicit` на 1 если fetch родился под зонтиком. Прямой fetch (paste @durov, channel-config form) продолжает ставить 1.

Идемпотентная **demote-миграция** в `getDb()` снимает `is_explicit` с чатов которые есть в `folder_sources` и **не имеют ни одного direct (не-folder) job'а** в `jobs`. Direct = `type LIKE 'tg_%'` без ключа `_folder_umbrella_id` в `parameters_json`. Компенсирует две слишком жадные эвристики:
1. Avatar-based backfill («есть аватар = explicit») — folder-resolve тоже качает аватары.
2. Items-based backfill («items > 1 = explicit») — папочный fetch тоже наполняет items.

Прямой fetch (paste @handle, channel-config form, batch-pick) пишет job без `_folder_umbrella_id` → demote промахивается, канал остаётся в основном списке. См. `fact-database.md::Demote-миграция`.

### Sequential, never parallel

Telethon сессионный lock: два параллельных `tg_fetch` против одного `.session` файла дают `OperationalError: database is locked`. Поэтому **umbrella job** (`tg_folder_fetch`) обходит чаты строго по очереди через `subscribe()`-await. Цена — линейное время (1-3 мин на 12 чатов), компенсируется live-прогрессом и групповой картинкой в Activity.

См. `fix-telethon-session-lock.md`.

### Сортировка чатов внутри папки

`listFolderSources` отдаёт `ORDER BY last_item_at IS NULL, last_item_at DESC, fs.added_at ASC, s.id ASC`:
1. Сначала чаты с постами — по дате последнего сообщения (свежее вверху).
2. Потом пустые / неспарсенные (`last_item_at = NULL`) — между ними по `added_at` (порядок Telegram'а на момент resolve), стабильный fallback.

Делает «живые» чаты видимыми сразу, не зарытыми между unparsed-болтанками. Telethon-порядок самостоятельной ценности не имеет (он отражает порядок diaolog filter в момент resolve, а не активность чата).

### Вкладки типов диалогов внутри списка

Внутри текущей выборки TelegramScreen — «Все чаты» активной сессии или
конкретная папка — есть второй ряд фильтров: `Все`, `Личные чаты`,
`Каналы`, `Чаты`, `auto`. Это **не** новые папки и не отдельные источники,
а view-filter поверх уже выбранной популяции. Счётчики считаются до поиска,
чтобы вкладка отвечала на вопрос «сколько здесь вообще таких диалогов», а
строка поиска уже уточняла результат внутри вкладки.

Классификация берётся из `sources.meta_json.kind`, который приходит с
Telethon entity event: `user` → личные чаты, `channel` → каналы,
`group/chat` → чаты. Неизвестный `kind` остаётся видимым во `Все`, но не
попадает в частные вкладки — это лучше, чем угадывать по названию или
аватарке. На реальной базе перед фичей `kind` уже был заполнен у всех
Telegram sources, поэтому отдельная миграция не нужна.

`auto` — такая же вкладка-фильтр, только по наличию `tg_auto.pull` или
`tg_auto.index` в `meta_json`. Она показывает «что живёт в автоматическом
режиме», а не запускает автоматизацию сама. Внизу вкладки есть одно
предложение с расписанием: первый запуск через минуту после старта
приложения, дальше каждые 30 минут, пока приложение открыто. Механика
самого запуска — `fact-fetch-strategies.md::Auto-pull / auto-index`.

### MCP доступ к папкам

MCP-тулы зеркалят ту же session-scoped модель, что и UI: отдельного
«агентского» хранилища папок нет. `telegram_list_folders` и
`telegram_folder_state` читают материализованные `folders`/`folder_sources` и
возвращают sources из той же `library.db`; `telegram_refresh_folders` запускает
настоящий refresh через Telethon для выбранной session; `telegram_search_chats`
фильтрует уже сохранённые sources по папке/запросу без нового fetch.

`session`/`profile` override в MCP — область одного вызова. Агент может
посмотреть папку другого аккаунта или `all_sessions`, но это не переключает
активную сессию в UI и не меняет куда пойдёт следующий ручной парсинг.

### Auto-кнопки в строке списка

`auto-pull`, `auto-index` и `Types` живут в header-строке списка рядом с
select-all и поиском, а не в каждой строке чата. Это один batch-rule для
выделенных чатов: типы контента выбираются один раз в header'е, строки
получают только компактные бейджи `auto-pull` / `auto-index` после
сохранения правила.

Кнопки показывают **дельту будущего клика**, а не только текущее состояние:
если выделено 5 чатов и у 2 уже включён `auto-pull`, кнопка показывает
`auto-pull (+3)`. Если у всех выделенных включено — следующий клик снимает
режим и показывается `(-5)`. Так mixed selection не превращается в
непонятное «частично включено»: видно, сколько строк реально изменится.
`auto-index` автоматически включает `auto-pull`; выключение `auto-pull`
гасит `auto-index`.

Selection сбрасывается при смене папки или вкладки типов диалогов. Иначе
скрытая строка из другой вкладки продолжила бы участвовать в auto-действии,
и счётчик `(+N)` перестал бы соответствовать видимому списку.

### Activity — одна строка на batch

ActivityPanel фильтрует child-jobs через `j.params?._folder_umbrella_id` — в overlay видна только umbrella row с прогрессом «N/M чатов · ↻ @x». Детализация per-chat живёт **на самом TelegramScreen** в строке каждого чата.

Universal click contract: клик на любую row в Activity → `pushScreen('job-detail')`, без per-type detour'ов. См. `fact-navigation.md::Universal click contract`. Папочным types (`tg_folder_fetch`, `tg_folder_refresh`) дано отдельное body в `JobDetail.jsx` — список чатов со статусами и сводка.

### Persistence per-folder

Каждая папка хранит свои `default_period_days` и `default_types_json` (массив `['text', 'voice']` сериализованным JSON). При смене таба TelegramScreen загружает их и проставляет в локальный state. На любой toggle — `folderUpdateParams` в БД через fire-and-forget. У таба `Все чаты` нет folder-row — настройки session-only.

**Persistence только для preset-modes.** `default_period_days` — legacy int-column,
которая отлично описывает preset диапазоны (`last_week → 7`, `last_month → 30`,
`all → 0`). Manual `from_date` / `date_range` в БД **не пишутся** — у юзера
эти моды по сути одноразовые («посмотрел между 1 и 15 апреля и всё»), не
устойчивое предпочтение. На re-mount после смены таба preset подхватится
из БД, manual mode сбросится в default (`last_week`). Альтернатива (схема
с `default_range_json`) — больше state на ровном месте + миграция, без
наблюдаемого выигрыша для юзера.

При load: `presetIdForDays(default_period_days)` маппит обратно в preset
id (`7 → 'last_week'`); неизвестные значения → fallback к
`DEFAULT_RANGE_MODE = 'last_week'`.

### Live статистика

Вся форма (range / types / engine / comments-toggle) — это `<TelegramScopeFields use="copy" rangeModes={FOLDER_RANGE_MODES} showEngine>` (см. `fact-source-actions.md::Shared scope-fields`), **рендерится постоянно** (см. секцию ниже про inline-без-toggle). Range default = `last_week`. `FOLDER_RANGE_MODES` — preset-only набор без `last_n` / `between` / `single`: эти моды бессмысленны для batch'а N чатов (count и URL'ы перестают означать одно и то же).

`assemblyEstimate({source_ids, types, mode, date_from, date_to})` дешёвый: `COUNT + SUM(octet_length)` по индексу `(source_id, type, published_at)`. На каждое изменение (selection / range / types) — debounce 200мс, потом IPC. Результат показывается в двух местах: в кнопке `📋 Скопировать (N) · ~12k` и отдельной строкой под action-row.

Для voice/video учитываются только items с **сохранённым transcript_path** — голосовое без транскрипта не имеет «текстового веса», добавляется только после `Спарсить` с включённым движком.

### 🪟 Inline scope-fields без toggle

В отличие от SourceDetail (где scope-fields раскрываются по клику
`📋 Скопировать` в action-row) — на TelegramScreen форма видна **сразу**,
без toggle. Контекст разный:

- **SourceDetail:** у источника есть несколько конкурирующих режимов
  работы (Обзор / Новый запрос / Скопировать / Picker / Индекс) — toggle
  нужен чтобы юзер выбрал в каком сейчас. Без toggle все формы стояли бы
  открытыми одновременно = шум на 5+ блоков.
- **TelegramScreen:** страница уже **сама по себе** есть batch-mode
  (multi-chat selection + одна копи/спарси операция). Конкурирующих
  режимов нет, toggle на одну форму = лишний клик ради клика.

Default content-types = `text` (как и в TelegramConfigForm) — копи только
текст по умолчанию, voice/video opt-in (`переносимый-дизайн.md::Default = безопасный
для денег`). Comments-toggle опциональный (по умолчанию off).

### Refresh — реальный job, не sync IPC

Кнопка ⟳ в шапке TelegramScreen стартует `startTelegramFolderRefresh()` (job-runner). Идёт через ту же ActivityPanel, имеет cancel, видна после рестарта в Recent. До этого был синхронный IPC, но 30+ секундный walk Telegram'а без видимости в Activity = «не понятно идёт ли что-то».

Inline-индикатор у кнопки ⟳ читает `tg_folder_refresh` shape из `useJobs()` — общий single source of truth (не локальный `refreshing`-flag, иначе можно расходиться).

**Prune — строгий session-scope, legacy NULL не трогаем.** Свип ходит по
**одному** аккаунту (сессия снимка) и не знает о папках другого — поэтому
удалять «пропавшие» можно только среди папок **этой** сессии. Тонкость в
NULL-строках: первая версия prune считала legacy `tg_session=NULL` «своими»
для любой сессии (на логике «их же сейчас усыновит upsertFolder»). Это
оказалось багом: refresh под аккаунтом A видел NULL-папку, реально
принадлежащую аккаунту B (синканную до ввода привязки), не находил её в
своём свипе и **удалял**. Так у юзера пропала папка «реклама» аккаунта
Oku27 после refresh'а под F9922 (`synced=12 removed=1`). Симптом: «после
запроса под одним аккаунтом пропала папка другого». Сейчас условие
строгое — `lf.tg_session === job.tg_session`, ничего больше; NULL-папки,
реально принадлежащие сессии свипа, упоминаются в нём и усыновляются
`upsertFolder`'ом, а не упомянутые могут быть чужими — пусть живут до
refresh'а под своим аккаунтом. См. `fact-telegram-sessions.md::Привязка`.

## 🚫 Что отбросили

- **AI-резюме внутри приложения.** Юзер уже paste'ит выводы в свою нейронку — добавлять второй биллинговый поток (Gemini-call внутри SC Desktop) за результатом, который и так копируется руками, не оправдано. Может быть когда-нибудь как opt-in кнопка `🤖 Резюмировать в Gemini` в footer'е TelegramScreen.
- **Параллельный fetch на уровне папки.** Session-lock не пускает; обходные пути (отдельная .session per chat) ломают Telegram-account аутентификацию.
- **Folder = собственная items-store.** Дубль storage и ломает любой single-chat workflow («открыть @durov из sidebar → его items»).
- **Кнопка `+` рядом с папкой в sidebar.** Парсинг — только через Home/paste, единая точка входа (`переносимый-дизайн.md`). Папка добавляется paste'ом её имени → chip `[папка]`.
