# Knowledge: Fetch Strategies

Мотивация **зачем именно** такие fetch-режимы по платформам и как UI их использует.

- **Telegram** — тут, основная часть файла. Pre-analysis, sync_new, mode матрица.
- **YouTube** — в отдельном `fact-youtube.md` (channel flat-playlist, batch transcribe, single video с двумя стадиями).
- **Instagram** — обзор-секция ниже + детали в `fact-instagram.md` (cookies-free path, re-pagination для transcribe).

## 🔍 Pre-analysis pass (`--preview-only`)

**Что делает:** тот же `iter_messages()` что и обычный fetch, но **не emit**'ит `item`-события и не пишет в БД. Только агрегаты: `type_counts`, `senders` (top-10), `date_min`/`date_max`, `voice_seconds`/`video_seconds`.

**Зачем нужен:**
- Юзер не должен платить за транскрипцию voice/video, не зная сколько их там
- При выборе «Весь чат» полный fetch может занять часы — preview за 1-2 секунды показывает скоп
- Coverage tracking без записи в БД — детерминированный «что я получу»

### tg_preview как полноценный job (миграция)

Изначально preview запускался как `runTelegramPreview()` → `Promise<{summary,
entity}>`, не создавая job-row и не появляясь в Activity. Аргумент был —
preview за 1-2 секунды, отдельная карточка засоряет Recent jobs.

**Что не сошлось:** preview на 5000 сообщений занимает ~50 секунд, на
«Весь чат» с 50k+ — минуты. Без видимости в Activity юзер видит
spinner внутри формы, не понимает идёт ли процесс или повис, и нет cancel.

**Сейчас** `startTelegramPreview()` создаёт полноценный job с `type:
'tg_preview'`, виден в Activity, cancellable через SIGTERM, persist в БД.
Финальный `preview_summary` оседает в snapshot (см. `fact-jobs.md`). На
короткие preview (last_n=500, 1-2 сек) карточка моргает в Activity и почти
сразу уезжает в Recent — небольшая цена за правильную видимость на длинных.

Renderer подписан через `watchJob(id)` в `TelegramConfigForm::runPreview` —
рендерит summary как только `snap.preview_summary` приходит, поддерживает
cancel-кнопку рядом с «Запросить анализ».

### Signature-based stale detection

В `TelegramConfigForm` хранится `previewSig` — JSON-snapshot всех range-влияющих полей (target/mode/lastN/fullChat/dates/urls). При получении preview сохраняем `setPreviewSig(currentSig)`. Каждый рендер сравниваем: если `previewSig !== fetchSig` — preview becomes `previewStale = true`.

**UI:** stale preview затемняется (`opacity-60`), показывается надпись «устарело — обновите». Counts в чекбоксах типов скрываются.

**Альтернативы которые отброшены:**
- Реактивный auto-refetch при каждой правке — слишком много вызовов TG API, юзер платит API rate за каждое колебание
- Кнопка «Refresh» которая всегда видна — юзер думает что данные актуальны и не нажимает

### Pre-analysis для YouTube batch — upper-bound, не точный pre-pass

В отличие от Telegram (где `--preview-only` за 1-2 сек считает агрегаты по выбранному диапазону), для YouTube **точный** pre-analysis (subs-check на N выбранных видео) занимал бы 3-5 сек × N — на 50 видео это 4 минуты ожидания **до** оплаты. Юзер не выдержит.

Поэтому picker показывает **upper-bound cost** вместо точного: «до $0.0050 через Gemini» считается по длительности невыбранных-уже-транскрибированных. Реальная стоимость всегда ≤ показанной (subs free, AI только где нужно). Toggle `Auto-транскрипция при отсутствии субтитров` (default ON) — это явный consent с upper-bound. См. `fact-youtube.md::Toggle auto-AI`.

---

## ⏩ Incremental sync (`sync_new` mode + `--since-msgid`)

**Что делает:** `iter_messages(min_id=N)` — Telegram отдаёт только сообщения **новее** message_id `N`.

**Как UI его использует:** в `SourceDetail.jsx::syncNew` сначала вызывает `window.api.sourceMaxExternalId(sourceId)` — это `MAX(CAST(external_id AS INTEGER))` из БД. Полученное `N` идёт в `--since-msgid N`. Таким образом каждый Sync new подтягивает только то что появилось с прошлого парсинга.

**Fallback:** если БД пустая (`max_id = NULL`), скрипт делает `last_n = 200`. Не делать `iter_messages()` без limit — на большом канале висит часами.

### Catch-up batch — per-source min_id

Sidebar «Запросить до конца» (multi-select чатов, см.
`fact-source-actions.md::Множественное выделение`) гоняет тот же
`sync_new`, но **per-source**: umbrella `tg_catchup` для каждого чата
тянет его собственный `maxExternalId` из БД и подставляет в `min_id`
этого child-fetch'а. Чаты с разным tip'ом синхронятся каждый со своей
точки в одном действии.

Чат **без кэша** (`maxExternalId=0` — например только что demote'нутый
из «Прочее» после folder-resolve) падает на тот же `last_n=200`
fallback, что и одиночный sync_new — не «весь чат вслепую».

> **Почему не общий date-range на все выбранные чаты.** Заманчиво
> «дотяни всё с прошлой недели по N чатам». Но у чатов разный момент
> последней синхронизации — у одного хвост свежий, у другого месячной
> давности. Единая дата либо недотянет (где синк был раньше даты), либо
> перекачает дубли (где позже). `min_id` на чат — единственное что
> означает «ровно то, чего я ещё не видел» для каждого независимо.

### Auto-pull / auto-index — расписание поверх catch-up, не новый fetch-режим

`auto-pull` использует тот же `tg_catchup`, что и ручное «Запросить до
конца»: для каждого чата берётся его `MAX(external_id)`, а пустой чат
падает на `last_n=200`. Отличие только в инициаторе: Electron main стартует
первый проход через минуту после запуска приложения, затем повторяет каждые
30 минут, пока приложение открыто. Это не системный cron — закрытое
приложение ничего не парсит.

Планировщик **не запускает второй проход**, если предыдущий ещё активен:
лучше пропустить тик, чем создать параллельные Telethon-процессы и упереться
в session-lock. Внутри прохода источники группируются по `(tg_session,
types, engine)`: один umbrella на все auto-чаты был бы неправильным, потому
что чаты могут принадлежать разным аккаунтам и иметь разные типы контента.
После успешного `auto-pull` для строк с `auto-index` запускается обычная
инкрементальная индексация этого source. `auto-index` не имеет отдельного
fetch-пути и всегда подразумевает `auto-pull`.

Источник без выбранных `types` пропускается. UI не даёт включить auto-режим
с пустым набором типов, но guard в планировщике нужен для старых или
ручных `meta_json`-правок.

### `min_id` теперь применяется и в `last_n` (skip-dupes toggle)

В Python-стороне `--since-msgid` исторически игнорировался во всех режимах
кроме `sync_new`. С добавлением UI-toggle «пропускать дубли» (зелёная пилюля
рядом с инпутом N в форме) тот же `since_msgid` подставляется в
`kwargs["min_id"]` и для `last_n`. Семантика: «верни до N сообщений с
id > since_msgid», вместо легаси «верни N сообщений с хвоста чата».

**Симптом без toggle.** Юзер парсит чат с 30k уже сохранённых, ставит
`limit=500`, нажимает Спарсить. Telegram отдаёт последние 500 сообщений
чата → они почти все дубли уже-сохранённого. UPSERT их съест без записи
новых строк, но трафик потрачен и (если включена транскрипция) Gemini/AAI
получили платные RPC впустую. С toggle: 500 строго **новых** сообщений.

UI: TelegramConfigForm подгружает `sourceMaxExternalId(sourceId)` при
mount'е и хранит в state. На submit при `range.skipDupes && maxExternalId > 0`
добавляет `params.sinceMessageId = maxExternalId`. Toggle default ON.
Для свежих source без items (maxExternalId=0) — флаг no-op, как и
старое поведение `sync_new` без max_id.

#### Backfill-кейс: skipDupes отрезает то что юзер хочет

`min_id` — это **«отдай только msg_id выше N»**, причём по строкам, не по
полям. Это становится ловушкой когда юзер хочет дотянуть **тело** уже-
сохранённого сообщения. Типичный сценарий: канал с 35k опросов лежит как
metadata-only (`type='poll', caption=NULL`) до того как мы начали тянуть
poll body. Юзер выбирает только «Опросы», нажимает Спарсить → `min_id =
last_msg_id` → Telegram отдаёт 0 сообщений новее → 0 апсёртов, ни одно
тело не дозаписано.

Симптом ровно такой: «выбрал только опросы — fetch завершился за секунду,
items_done=0, но в БД есть 35k опросов».

UI-фикс — авто-отключение skipDupes в `TelegramConfigForm`: если у любого
выбранного типа `with_caption < count` (читается из
`items:typeBreakdown`), `params.sinceMessageId` не отправляется + amber-hint
«N опросов без тела — будут перепарсены». Без отключения backfill-проход
невозможен в принципе, потому что `min_id` режет именно нужный диапазон.

UI-сторона хинта — `fact-source-actions.md::🩹 Backfill-aware skipDupes`.

### `date_range` с опциональной верхней границей

Один режим обслуживает оба сценария:
- `from_date` (только нижняя граница) — `--date <X>` без `--date-to`
- `date_range` (обе границы) — `--date <X> --date-to <Y>`

Telethon **не принимает max_date** в `iter_messages` — там только
`offset_date` (нижняя граница) + `reverse=True`. Верхняя граница
реализована фильтром в loop'е: `if msg.date > cutoff: break`. break, не
continue, потому что reverse=True идёт oldest→newest, после первого
сообщения за границей все последующие тоже за ней.

**End-of-day эвристика для дат без HH:MM.** Юзер пишет «до 01.02.26»,
имея в виду весь день. Парсер видит `00:00:00`, и без правки cutoff бы
обрезал на полуночи (теряли бы весь 1 февраля). Если parsed_to.hour == 0
и minute == 0 — `parsed_to.replace(hour=23, minute=59, second=59)`. Это
**не** работает когда юзер сознательно пишет «до 01.02.26 00:00» —
неотличимо от первого случая, и end-of-day всё равно применится. На
практике никто не пишет полночь явно, эвристика безопасна.

UI-сторона — единый Range select без отдельного «С даты» режима: вторая
дата опциональна, placeholder «до конца», `range.toDate=''` → backend не
получает `--date-to` (открытая правая граница). См.
`переносимый-дизайн.md::Параллельные UI-flows` про мотивацию слива двух режимов в один
контрол.

### Что Telegram даёт, что нет

| Сценарий | Решается через | Можно skip? |
|---------|---------------|-----------|
| «Дотянуть свежие после моей последней синхронизации» | `min_id` | ✅ |
| «Спарсить старые посты до моего первого item» | `offset_date` + `reverse=True` + `max_id` | Через границу — да, через дыры — нет |
| «У меня есть 5-10 февраля, дотянуть только 1-4 и 11-15» | Два отдельных fetch | ❌ внутри диапазона |
| «У меня есть text+voice, дотянуть только photo за тот же период» | iter_messages не фильтрует по типу | ❌ всё равно весь диапазон |

**Дыры посредине** — идём через них заново, **но БД не пухнет**: `bulkUpsertItems` использует `INSERT … ON CONFLICT(source_id, external_id) DO UPDATE` (см. `fact-database.md`), повторные сообщения обновляют existing rows. Цена дыр — только трафик/время Telegram API.

**Filter-by-type через `iter_messages(filter=...)`** существует у Telethon, но мы не используем — сделает трафик в N раз дороже (N запросов на N типов) при той же экономии. Лучше один полный пробег + UPSERT.

---

## 🏷 Resolve by chat title (paste-flow для имён без ссылки)

Многие Telegram-чаты не имеют публичного `@username` (приватные группы,
переименованные чаты). Юзер пастит free-text название типа `Чат | EBASH`,
detect.js классифицирует это как `kind: 'title'`. Только Telegram умеет
такое резолвить — у других платформ нет equivalent'а `iter_dialogs()`.

**Flow:**
1. PasteScreen показывает один TG-chip `[найти чат]` (не 4-platform row, не
   YouTube kind-pair) — отражает что title resolve работает только для TG.
2. Click → `tg:resolveTitle(text)` IPC → spawn `tg_fetch_json.py
   --resolve-title <text>`. Скрипт walk'ает `client.iter_dialogs()`,
   эмитит `chat_candidate` events для каждого совпадения по
   `casefold()` exact-match.
3. 0 совпадений — error inline в форме. 1 — auto-pick + сразу в основной
   flow. 2+ — picker со списком (kind, @username если есть, members,
   last_message_at).
4. После выбора `target` подменяется на **numeric `chat_id`** — это
   стабильный идентификатор, не ломается при ребрендах темы.

**MCP fuzzy-resolve — отдельный режим для агентных запросов.** UI paste-flow
оставлен exact-match, чтобы не превращать ввод названия в список похожих людей.
Но агентный запрос часто звучит как *«найди Геннадия по профилю f9922»*, а source
в БД ещё не существует. Для этого `telegram_resolve_chat` включает
`--resolve-fuzzy`: `_normalize_title(dialog.name)` должен **содержать** query, а
не быть равным ему. Режим всё равно идёт через `iter_dialogs()` активной/переданной
сессии, шлёт `resolve_progress` каждые 100 диалогов и ограничивает выдачу лимитом
кандидатов. Найденный candidate (`kind`, `username`, `last_message_at`, numeric
`chat_id`) дальше передаётся в `telegram_fetch` как target; fetch сам создаёт
source через `upsertSource`, если чата ещё не было в `library.db`.

**Numeric chat_id и iter_dialogs warm-up.** При повторном fetch'е через
числовой id Telethon `get_entity(int)` требует чтобы entity была в
input-cache сессии. Если сессия свежеперезагружена и кэш холодный — fallback
на `iter_dialogs()` walk до тех пор пока `get_entity` не получит entity.
Симптом без warm-up: `Cannot find any entity corresponding to ...`.

> **Что пробовали и почему не сработало.** Изначально в `tg_reply_backfill_ndjson.py`
> стоял `async for _ in client.iter_dialogs(): break` (один диалог и сразу
> выйти). На маленьком аккаунте срабатывало, на ~300+ диалогах — нет.
> Telethon **кэширует диалоги по мере итерации**, не upfront — нужный chat
> может сидеть в середине списка, и `break` после первого его не достанет.
> Только полный `async for _ in iter_dialogs(): pass` гарантирует прогрев.
> Симптом регрессии: backfill работает на dev-аккаунте с 5 чатами, падает
> в prod на аккаунте с сотнями диалогов через `Cannot find any entity
> corresponding to <numeric_id>`.

См. `fact-architecture.md::Detection → chooser logic` про UI-сторону title
detection.

### Прогресс iter_dialogs() и нормализация заголовков

**Симптом до фикса.** Юзер пастит `Берсерки едут в Амстердам`, видит
«ищу чат в твоих диалогах…» и спиннер. На большом аккаунте (тысячи
диалогов) walk занимает 30-60 секунд легитимно — ни один способ это не
ускорит, у Telethon **нет server-side title search для приватных
диалогов**. Без обратной связи юзер думает что всё повисло.

**Решение — стрим прогресса.** `tg_fetch_json.py:resolve_title` шлёт
`{"type": "resolve_progress", "scanned": N}` каждые 100 диалогов. В
`runTelegramResolveTitle` это пробрасывается callback'ом → `main.js`
шлёт `tg:resolveProgress` через `event.sender.send` обратно в renderer.
Form подписывается через `window.api.onTgResolveProgress(fn)` и рендерит
`«просмотрено N диалогов…»` (tabular-nums) вместо статичной строки.

> **Что отбросили.** Скрытие спиннера или фиксированный таймаут — это
> легитимное время Telegram API, не баг.

**Тот же `resolve_progress` стрим в `run()`-fallback.** Когда юзер пастит
slug-shaped handle (например `bari_s_patrikovv`), detect.js классифицирует
его как `kind='username'` и ставит `target='@bari_s_patrikovv'`. Если такого
public username нет — Telethon `get_entity` падает с `UsernameNotOccupied`.
`run()` в этом случае делает **fallback** через `_resolve_via_dialog_walk`
(тот же iter_dialogs() exact-match что в dedicated mode). Чтобы 30-60 сек
walk не выглядел как зависание, fallback тоже emit'ит `resolve_progress`
каждые 100 диалогов — UI (Activity row + JobDetail "Сейчас" блок) показывает
«просмотрено N диалогов» через `job.resolve_scanned` поле. См.
`fact-jobs.md::Snapshot vs live job` за полем.

**Нормализация заголовков.** Юзер пастит `Берсерки едут в Амстердам`,
а реальный title в Telegram — `«Берсерки едут в Амстердам»` (гильметы).
Строгий `casefold()` exact-match в первой версии докатывался до конца
списка вхолостую. `_normalize_title()` стрипает с краёв `« » " ' ( ) . , ; : ! ? — - …`
и схлопывает whitespace — пунктуация на концах теряется, в середине
остаётся (`Чат | EBASH` всё ещё matches только себя).

### Парсинг `t.me/c/<id>/<msg>` (приватные каналы)

Приватный канал не имеет `@username` — ссылка на сообщение там выглядит
как `https://t.me/c/1911133953/560` (или `/c/<id>/<topic>/<msg>` в форумах).
**`c` это литерал**, не handle. Универсальный regex `t\.me/(\w+)/(\d+)`
вернёт handle=`c`, после чего Telethon `get_entity('c')` упадёт с
`Cannot find any entity corresponding to "c"`.

Решение — отдельная ветка в `detect.js::tg()` и `TelegramSingleMessageForm`:
`t.me/c/(\d+)` → handle = `-100<internal_id>` (полный chat_id формат
Telethon). Дальше работает как любой числовой chat_id — Python-сторона
делает iter_dialogs warm-up при первом обращении.

### Query-string в t.me ссылках

Реальные ссылки приходят с query-параметрами: `?thread=<topic_id>`
(сообщение в форум-топике), `?single` (открыть одиночный пост),
`?comment=<comment_id>` (deep-link в комменты), `?t=<seconds>` (таймкод
в видео). Старая Python-сторона `tg_fetch_json.py::single` парсила
message_id через `url.rstrip("/").split("/")[-1]` → на `t.me/c/X/7214?thread=6479`
получала строку `"7214?thread=6479"`, `int(...)` падал с
`Cannot parse message id from <url>`.

Симптом: юзер пастит ссылку на форум-пост из закреплённых сообщений
канала, форма получает 400 от Python, в Activity видна только запись
`tg_fetch ✗ Cannot parse message id`.

Фикс на Python-стороне:
```python
clean_url = url.split("?", 1)[0].rstrip("/")   # срезаем query + слэш
path_segs = clean_url.split("/")
mid = None
for seg in reversed(path_segs):                # последний числовой сегмент
    if seg.isdigit():
        mid = int(seg); break
```

Покрывает все четыре формата: `t.me/<chan>/<id>`,
`t.me/<chan>/<topic>/<id>`, `t.me/c/<internal>/<id>`,
`t.me/c/<internal>/<topic>/<id>` — с query или без.

В JS-стороне `detect.js` этой проблемы не было: regex
`t\.me/(\w+)/(\d+)` останавливается на `?` (не входит в `\w+`/`\d+`).
Но `urlparse(url).path` в Python даёт путь без query — без
`split("?", 1)` это работает; задача была именно в split-by-slash
способе, который query попадает в последний сегмент целиком.

### Pre-flight ffprobe для voice path

Telegram-«video» сообщения часто оказываются mp4/webm screencast'ами или
GIF-style анимациями **без аудио-дорожки** (стикеры-видео, анимированные
эмодзи, скринкасты ботов). AAI отвечает на такие файлы: `AssemblyAI error:
No audio stream found in the file. File type is video/mp4 (...)`. Без
pre-flight каждый такой msg идёт в `media-error` (и тратит API-минуты на
upload до того как AAI откажется).

`process_media` для voice path делает `ffprobe -select_streams a` сразу
после download (~50мс). Если audio stream нет — `media-skipped(reason=
"no audio track (silent video)")` без отправки в AAI. Заодно функция
вытаскивает `format=duration` — UI показывает `аудио 0:42` с первого
`downloading` event'а вместо ожидания AAI-replay'а на `queued` (sticky
duration в `media_phase.current.audio_duration_sec`).

> **Что отбросили — ловить AAI error и retry/swallow.** Деньги/квота
> уже потрачены на upload. Также невозможно отличить «реально нет
> звука» от «format unsupported» — AAI отвечает одним и тем же кодом
> ошибки на оба класса. ffprobe даёт ясный ответ локально.

Telethon-side: messages с `is_video and no audio` остаются в items с
`type='video'`, но `transcribe_status` остаётся `none` — UI показывает
`⚠ Только метаданные (видео)` через стандартный invariant, не путает с
ошибкой.

### Skip-already-processed media (engine-aware)

Re-fetch чата по дефолту не запускает AAI/Gemini заново на тех msg_id
которые уже обработаны (`items.transcribe_status='done'`). Реализация —
в job-runner: до spawn'а Python собирается map `{kind: {msg_id: engine}}`
из БД, передаётся через `--skip-processed-file`. Python чекает membership
в `process_media` ДО download → `media-skipped(reason="уже обработано · X")`.
Подробности — `fact-jobs.md::Skip-already-processed media через
--skip-processed-file`.

User-facing toggle **«парсить заново»** (амбер pill рядом со Start fetch,
default OFF) выключает skip полностью И отключает внутренний
`min_id`-windowing для last_n (иначе iter_messages выбросил бы те самые
msg_id что юзер хочет revisit'нуть).

> **Что отбросили — старая UI-кнопка «пропускать дубли».** Юзеры путали
> с re-transcribe-toggle. `skipDupes` остался внутренней оптимизацией
> (default ON, пинит `min_id=maxExternalId` для last_n) — без UI.

## 📅 Date format поддержка

`tg_fetch_json.py --date` принимает 6 форматов вместо одного:
`dd.mm.yy`, `dd.mm.yyyy`, оба с/без `HH:MM`, и ISO `yyyy-mm-dd[ HH:MM]`.
Без времени = `00:00`. Раньше принимался **только** `dd.mm.yy HH:MM`,
ввод `01.01.2026` без минут валился с `Bad date`.

## ⚙ Mode матрица

| Mode | Что делает | Используется где |
|------|------------|---|
| `last_n` | `limit=N` от свежих к старым; опционально `min_id=since_msgid` через skip-dupes toggle | Default в form, Re-fetch |
| `sync_new` | `min_id=N` (нужен `--since-msgid`); fallback last_n=200 | SourceDetail Sync new + sidebar catch-up (`tg_catchup`) |
| `from_date` | `offset_date + reverse=True` (от даты к сейчас) | Custom fetch |
| `single` | `get_messages(ids=N)` (один запрос) | Pre-detected URL t.me/x/100 |
| `all` | `iter_messages` без лимита, последовательный pull | Full в last_n или явный all |
| `--resolve-title` | one-shot iter_dialogs() exact-match (см. выше) | paste-flow с free-text |
| `--topic-ids 1,46,...` | оборачивает любой mode выше — N независимых iter_messages с `reply_to=tid` | Forum-чат, юзер выбрал темы в TelegramTopicsPopover |

### Last-used range safety

`TelegramConfigForm` сохраняет last-used параметры, но range восстанавливается
только для безопасных повторяемых режимов: `last_n`, `last_week`,
`date_range`; из числовых полей повторяется только `lastN`, а даты остаются
дефолтами формы. Full-history режимы (`all` / full через last_n), URL-based
`between`, одноразовые `from_date` и конкретные даты/URL не должны молча
приезжать в следующий «Новый запрос».

Пользовательский симптом, ради которого это правило существует: чат недавно
парсился, юзер открывает «Новый запрос», чекбокс «Парсить с нуля» не включён,
жмёт Start fetch — а из старого сохранённого `all` приложение начинает walk
всей истории на 55k сообщений. Для догрузки свежего есть отдельный `sync_new`
путь: Zap в split-кнопке и sidebar catch-up всегда идут от `MAX(external_id)`
с fallback `last_n=200`, а не от сохранённого range формы.

### Pre-fetch topic filter (forum-only, server-side)

В Telethon `iter_messages(reply_to=top_msg_id)` ходит в Telegram
`messages.GetReplies` — Telegram **сам** фильтрует и отдаёт только
сообщения этой темы. Никакого client-side скана всего чата + filter в
Python. Скорость внутри одной темы такая же как обычный fetch
(~10-20 msg/sec, FloodWait как обычно), но в разы быстрее «забрать
весь чат → отфильтровать» — не качаем чужой трафик и не платим Gemini
за чужой voice/photo.

**Multi-topic.** UI multi-select даёт массив `topic_ids[]`. Python-сторона
оборачивает основной цикл fetch'а в `for tid in topic_ids: await
_consume_iter({**kwargs, "reply_to": tid})`. Последовательно (не
параллельно), потому что Telegram FloodWait'ит на параллельных
GetReplies сильнее чем на серии. **`--limit` применяется per-topic, не
суммарно** — юзер галочкой выбрал 3 темы с N=200 → получит до 600
сообщений (по 200 на тему), не 200 распределённых.

**Почему не «исключить тему»**. `iter_messages` нет API для negative
filter. Делать «всё кроме X» = либо «забрать всё → отфильтровать»
(не лучше существующего полного fetch'а), либо N запросов на каждую
**не-выбранную** тему (медленнее в N раз). Обе альтернативы хуже —
фичу не делаем.

> **Что отбросили — `--exclude-topic-ids`**. Был соблазн добавить как
> комплемент. Просчитали: на чате с 24 темами и юзером, желающим
> «всё кроме 3» — 21 GetReplies против 1 полного fetch. Любой
> client-side filter дешевле на трафик. Selector в UI запутывает
> (две взаимоисключающие галочки на одну тему); один include-only
> чище.

См. `fact-telegram-topics.md::Pre-fetch multi-filter` про UI-сторону
(где живёт popover, как он скрывается на не-форумах, как пустой
itemsTopics-кэш на свежем источнике делает row невидимым).

При добавлении нового режима — обязательно:
- ASCII-короткое имя в `--mode` enum (тестируется через `argparse choices`)
- Соответствующий ключ в `kwargs` для `iter_messages`
- Обновить `buildFetchParams()` в `TelegramConfigForm`
- Если mode принимает `preview_only` — он тоже должен корректно работать (просто не emit'ить items)

---

## 📷 Instagram

Instagram-fetch отличается от TG в двух важных моментах: нет cheap pre-analysis по диапазону (web_profile_info — это глобальная сводка, не превью запроса), и нет sync_new по min_id (mobile-endpoint `clips/user/` не принимает «only новее X»).

### Mode матрица

| Mode | Что делает | Используется где |
|------|------------|---|
| `reels` | iterate `clips/user/`, page_size=12, до `--limit` (или `paging_info.more_available=false` если limit=0) | Default. UI checkbox «Reels» |
| `posts` | iterate `feed/user/<id>/` — **требует cookies**, через api backend недоступен | UI checkbox «Posts» (с предупреждением что нужен apify) |
| `both` | сначала reels, потом posts — две независимых пагинации в одном job'е | UI: оба чекбокса |

### Pre-analysis для IG — нет, есть «Обзор» через web_profile_info

`web_profile_info?username=<u>` отдаёт `media_count` (вместе reels+posts, без разбивки), `follower_count`, `biography`, `profile_pic_url`. Это **глобальная сводка** профиля, а не превью именно того fetch'а который собирается запустить юзер. Поэтому в UI она живёт отдельной кнопкой `📊 Обзор` в SourceDetail (см. `fact-source-actions.md`), не **внутри** формы как у TG.

Точного `type_counts` для конкретного диапазона мы получить не можем (`clips/user/` пагинируется только подряд, dry-run без emit'а итемов отсутствует) — отбросили попытки прикрутить `--preview-only`-вариант для IG. Юзер видит верхнеуровневую сводку (всего публикаций) и платит трафиком только когда жмёт «Спарсить».

### Sync new — нет since-id, спасает UPSERT

В отличие от Telegram (`min_id=N`), `clips/user/` не принимает «только новее». Каждый «Sync new» (`limit=50`) перетягивает последние 50 reels заново; `bulkUpsertItems` идемпотентен через `ON CONFLICT(source_id, external_id) DO UPDATE`. Цена дыр — только трафик IG (~5 сек на 50 reels через api).

### Pagination для transcribe — re-fetch `clips/user/`

Транскрипция (`ig_batch_transcribe_ndjson.py --backend api`) **повторно** пагинирует `clips/user/` для известного `user_id`, чтобы получить **свежий signed `video_url`** (TTL 5-15 минут). Альтернативный endpoint `media/info/?media_id=<pk>_<user_id>` требует cookies (`ds_user_id`) и без них возвращает 401.

Кэш per-user_id на весь batch: первый shortcode запускает пагинацию, накапливаются все встреченные reels, последующие shortcodes из того же batch ходят в кэш. Подробнее — `fact-instagram.md::Почему transcribe повторно ходит в clips/user/`.
