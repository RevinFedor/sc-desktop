# Knowledge: Jobs Lifecycle

## 🔄 State machine
```
        spawn()
pending ────────▶ running ─────done event────▶ done
                     │  │
                     │  └── awaiting_ai (no live child) ──── resumeYoutubeAi ──▶ running
                     │
                     ├──── error event/non-0 exit ───▶ error
                     │
                     └──── cancelJob() ──────────────▶ cancelled
```

`finished_at` устанавливается **всегда** при переходе из `running`, независимо от результата — для расчёта `duration_sec` и сортировки в Activity panel. Если status = `running` но `finished_at` уже set — это баг, не должно случаться.

### `awaiting_ai`: состояние без alive child

Особенность `yt_transcribe`: после Stage 1 (subs check) если субтитры не нашлись, скрипт корректно выходит exit 0, но job переходит в `awaiting_ai`, а не `done`. Live child'а нет (`job.child = null`), но юзер видит «ждёт подтверждения AI» в Activity. Cancel в этом состоянии = просто `status='cancelled'` без `kill()`. Resume = новый spawn с `--ai`, **переиспользует тот же jobId** — Activity показывает одну строку, не две. См. `fact-youtube.md::Two-stage single video`.

### ⏸ `interrupted`: zombie running после рестарта app

Симптом: юзер запустил `yt_batch_transcribe` на 30 видео, прошло 11 — закрыл/рестартнул
Electron. После рестарта в БД row висит как `status='running'`, но process'а уже нет.
В UI Activity показывает `⚡ running` с прогрессом который никогда не сдвинется.

**Лечение** — на старте `electron/job-runner.js` (один раз при импорте модуля)
markStuckRunningAsInterrupted покрывает **все типы которые могут оставить
zombie-row** — не только AI batch'и, но и весь TG-стек (`tg_index`, `tg_fetch`,
`tg_preview`, `tg_folder_fetch`, `tg_folder_refresh`, `tg_reply_backfill`) и
single-сценарии yt/tk/ig. Любая `running`-row у которой нет live-process
помечается `status='interrupted'`. Это отдельный статус (не `error`, не
`cancelled`) — JobDetail рендерит для него амбер-pill `⏸ прервано` и кнопку
**«▶ Продолжить»**.

> **Почему расширили scope.** Симптом «2 running rows на одном source» юзер
> поймал на `tg_index`: рестартнул во время индексации, открыл UI — Activity
> показывает live progress нового запуска, но в БД параллельно лежит orphan
> от прошлого процесса. Раньше cleanup был только для batch'ей yt/tk/ig
> (потому что они «дольше всех» и видимо проблемнее), но это hand-picked
> логика; правильное правило — **любая running-row без in-memory job это
> zombie**. Не лечишь — дублируется в "История парсинга", путает счётчики
> и блокирует UI-логику «один индекс на источник».

**DB-guard поверх Map-проверки.** В `index-job.js::start()` стоит in-memory
проверка `activeJobs.get(sourceId)` — на одной сессии двойной старт
невозможен. Но между «процесс умер» и «zombie-cleanup на старте» юзер
успевает кликнуть Index ещё раз → memory пустая, проверка пропускает.
Поэтому добавлен belt-and-suspenders: `db.findRunningJobForSource('tg_index',
sourceId)` находит orphan'а и помечает его interrupted **до** записи новой
row. Без этого пара running-row'ов рожает счётчик «2 running» в Activity, и
непонятно какой релевантен.

### Cancel routing для tg_index (две разные Map'ы)

`tg_index` — единственный job-type который **не живёт** в `jobs.Map` job-runner'а.
Свой жизненный цикл (asyncio в Node, без Python child) ведёт в собственном
`activeJobs` Map внутри `index-job.js`. ActivityPanel шлёт Cancel через
общий `jobs:cancel` IPC → `cancelJob(id)` в job-runner'е, который раньше
смотрел только в `jobs.Map` → тихо возвращал false для tg_index. Симптом:
кнопка Cancel в Activity не работает, прогресс продолжает идти.

Фикс: `cancelJob(id)` в job-runner'е сначала пробует `indexJob.cancelById(id)`
(перебирает свой Map), и только потом fallback на jobs.Map. Helper
`cancelById` в `index-job.js` симметричен `cancel(sourceId)` (старый API),
но ищет **и по live id, и по `dbRowId`**. Причина та же, что в секции
`Dual-id space`: Activity отдаёт in-memory id, а History/JobDetail могут
отдать SQLite `jobs.id`; для `tg_index` оба должны попасть в один live job.
Snapshot `tg_index` экспортирует `db_id`, чтобы renderer мог сравнивать оба
identity без знания источника.

Cancel должен пробиваться даже во время RPM-throttle sleep. На больших индексах
Gemini-лимитер может уснуть на несколько секунд (`RPM throttle ... sleeping
13695ms`); обычный `await setTimeout(waitMs)` не проверяет `job.cancelled`
до конца сна, поэтому Stop выглядит неработающим. В `index-job.js` sleep
разбит на короткие интервалы с проверкой cancel-флага.

**Cancel → 'cancelled', не 'error'.** В `index-job.js` cancel-сигнал
работает через `live.cancelled = true`, а в loop'е `if (job.cancelled)
throw new Error('cancelled')`. Этот throw попадает в общий catch — раньше
catch ставил `status='error'`, окрашивал dot красным «failure». Теперь
catch различает по message: `'cancelled'` или `job.cancelled` → `status='cancelled'`,
error=null; иначе — реальная ошибка. Сюрприз для UX — серая точка вместо
красной, и в JobDetail виден точный счётчик «Остановлено пользователем
· 9900 из 32145» (items_done на момент cancel).

### Отдельные label/body для tg_index и tg_reply_backfill

Раньше эти типы падали в **TelegramBody fallback** (предназначенный для
`tg_fetch`) и в **жёсткий else в jobRowLabel** — потому что у tg_fetch
есть `params.mode/limit/date`, а у tg_index — только `params.limit`.
Симптом: «Режим: —», «Длительность: —», пустой блок «Файл результата» (его
у индекса нет в принципе — векторы пишутся в `items_vec`, не на диск).

Теперь jobRowLabel имеет ветки для `tg_index` (`Семантический индекс ·
12000 / 32145`), `tg_reply_backfill` (`Reply-граф — backfill`), `tg_preview`
(`Пред-анализ`). JobDetail рендерит **TelegramIndexBody** /
**TelegramReplyBackfillBody** — узкие панели «Всего/Обработано/Длительность
/Запущено/Закончено» + статус-индикаторы:
- `interrupted` → амбер «Прервано на рестарте — запусти индексацию заново,
  продолжит с того же места»
- `cancelled` → серый «Остановлено пользователем · X из Y»
- `error` → красный с message

См. `electron/job-runner.js::cancelJob`, `electron/index-job.js::cancelById`,
`electron/database.js::findRunningJobForSource`.

**Resume логика — `resumeYoutubeBatch(rowId)`:**
1. Парсит `parameters_json` → `params.video_ids[]`
2. Для каждого `vid` проверяет: есть ли file в `params.video_files[vid]` (search-batch
   персистит эту мапу в close-handler) ИЛИ filesystem `<vid>__*.txt` в `YT_TRANSCRIPTS_DIR`
3. Оставляет только не-сохранённые → `remaining[]`
4. Если `remaining.length === 0` — flips `status='done'` и не запускает batch
5. Иначе — `startYoutubeBatchTranscribe({...params, video_ids: remaining})` свежим
   id, со всеми search-метаданными форварднутыми

> **Почему не reuse тот же jobId как `awaiting_ai`/resume.** Batch-jobs в DB иммутабельны
> по `params.video_ids` — это «снимок что было запрошено». Если бы мы UPDATE'или его
> с `remaining`, потеряли бы данные «оригинально хотели 30, прервались на 11, ресюмили
> 19». Новый row сохраняет аудит, старый interrupted остаётся видимым в истории как
> «такого-то числа было прервано».

> **Что пробовали и почему не сработало.** Hard-cancel zombie row → `status='cancelled'`
> без resume-кнопки. Юзер должен сам вспомнить параметры и запустить новый batch
> заново. Слишком много трения для частого случая «закрыл лаптоп — потерял прогресс».

См. `fact-youtube-search.md::Persistence` про роль `params.video_files` для resume
search-batch'ей (там нет items table, files мапа — единственный источник правды).

**TikTok `tk_transcribe` этой стадии НЕ имеет** — у платформы нет субтитров вообще, развилки subs/AI нет, single всегда сразу скачивает аудио и шлёт в Gemini в одном spawn'е. Не копировать `attachYoutubeStreams` целиком на TikTok — `awaiting_ai` handler останется мёртвым кодом. См. `fact-tiktok.md::Single video НЕ имеет awaiting_ai`.

## 💾 Items: in-memory → flush on close
**Items накапливаются в памяти** (`job.items[]`) и **flush'атся в JSON-файл одним вызовом `fs.writeFileSync`** на `child.on('close')`. После flush — `delete job.items` чтобы не утекало.

**Почему не стрим в файл по мере прихода:**
- Лишние syscalls (1 close vs 5000 appends)
- Ненужная фрагментация если процесс крашится посередине — итак получим broken JSON

**Почему не SQLite сразу:**
- Phase 2 не запущена. Сейчас live-data просто файл, потом перейдём на UPSERT в `items` table.

**Память:** для канала в 50k messages с captions ~3KB средний = ~150MB на job. Приемлемо для одного активного job. Если будем запускать массовый bulk — переходить на streaming в SQLite (см. Phase 2 в `CLAUDE.md`).

## 📁 Имя файла
`<YYYY-MM-DD>_<type>_<sanitized-target>_<jobid>.json`. Например: `2026-04-25_tg_durov_1.json`.

`<sanitized-target>` обрезается до 60 символов и фильтруется через `[^\w.-]+ → _`. Это нужно потому что target может прийти с точками (`@n.dubyk`), пробелами (`"Имя чата"`), кириллицей. macOS принимает почти всё, но Sublime/`subl` иногда давятся на спецсимволы в путях.

`<jobid>` — strictly increasing integer от старта main process. **Перезапуск Electron сбрасывает счётчик** — это нормально, имя файла защищено датой + target.

**`tg_fetch` mode='single' пишет `.txt`, не `.json`.** Юзер копирует через
JobDetail → ожидает читаемый текст, а не сериализованный объект с заголовками
`summary`/`items[]`. В .txt лежит: `<sender>\n\n<text>\n\n[голосовое — расшифровка
· <engine>]\n<transcript>` (последние два блока — только если был voice). Все
остальные TG-режимы (last_n, all, …) сохраняют JSON-сидекар по-прежнему — там
важна структура для re-обработки.

## 🪞 Snapshot vs live job
В Map `jobs` хранится **полный** объект с `child` (handle процесса), `items[]`, raw params. Через IPC отдаётся **snapshot** — усечённая копия:

| Field | В Map | В snapshot |
|-------|-------|-----------|
| `id`, `type`, `target`, `status` | ✅ | ✅ |
| `db_id` (SQLite jobs.id; null до entity-event'а) | — (хранится как `dbRowId` в Map) | ✅ |
| `source_id` | ✅ | ✅ |
| `entity_title`, `entity_kind` | ✅ | ✅ |
| `items_done`, `items_total` | ✅ | ✅ |
| `resolve_scanned` (pre-entity dialog walk counter, 0 если не private chat fallback) | ✅ | ✅ |
| `started_at`, `finished_at`, `error` | ✅ | ✅ |
| `params` (что юзер запросил) | ✅ | ✅ |
| `type_breakdown` | ✅ | ✅ |
| `file_path` (после flush) | ✅ | ✅ |
| `yt`, `yt_channel`, `yt_batch` (per-type payload) | ✅ | ✅ |
| `tk`, `tk_channel`, `tk_batch` (TikTok payloads — same shape as YT) | ✅ | ✅ |
| `ig_batch` (Instagram batch — same shape as `yt_batch`: saved/skipped/errors/cost_usd/log) | ✅ | ✅ |
| `local` (для `local_transcribe`: path/name/size/duration/engine/file_path/copied_bytes) | ✅ | ✅ |
| `tg_voice` (для `tg_fetch` mode='single' с голосовым: stage/engine/text/error) | ✅ | ✅ |
| `tg_comments` (для `tg_fetch` с include_comments: posts_done/posts_total/comments_collected/comments_post_errors) | ✅ | ✅ |
| `file_path_comments` (sidecar `.txt` для single-mode + comments — см. `fact-telegram-comments.md::Single-message side-fetch`) | ✅ | ✅ |
| `has_discussion` (cached от entity-event'а — UI решает между «недоступны» (false) и «вернулось 0» (true)) | ✅ | ✅ |
| `tg_media` (live progress vision/doc на batch fetch'ах: msg_id/stage/kind) | ✅ | ✅ |
| `tg_media_results` (stash {msg_id, kind, engine, text} для replay в caption на close) | ✅ | ❌ |
| `media_phase` (per-kind aggregate voice/photo/pdf — см. секцию ниже) | ✅ | ✅ (без `_seen`/`_finished` Set'ов) |
| `preview_summary` (для `tg_preview`, см. ниже) | ✅ | ✅ |
| `items[]` | ✅ (до close) | ❌ |
| `child` (proc handle) | ✅ | ❌ |
| stderr buffer | ✅ | ❌ |

`yt` — для `yt_transcribe` (single), `yt_channel` — для `yt_channel_fetch`, `yt_batch` — для `yt_batch_transcribe`. Каждый имеет свою форму (см. `fact-youtube.md` за событиями), на не-YouTube job'ах — null.

Разница важна: рендерер по `jobs:detail` получает только что нужно для UI, без тяжёлой нагрузки и без shell-handle (security).

### Правило: live-аккумулируемое поле → ОБЯЗАТЕЛЬНО в snapshot

Если бэкенд начал писать в `job.foo` где-то в `handleEvent`/`case 'progress'`
(не только на close), это поле **должно** быть добавлено и в `snapshot()`.
Без этого renderer видит прогресс только после round-trip через DB-restore
при следующей mount — то есть «оно появляется только если уйти и вернуться».

**Симптом до фикса.** Юзер запустил `tg_fetch mode='single' --include-comments`.
В step-row UI «Получаем комментарии» вечно `pending` (или `running` без счётчика),
а после close мгновенно скачет в `done · 80`. Backend всё считал правильно —
просто `snapshot()` пропускал `tg_comments` / `file_path_comments` /
`has_discussion`, и `onJobUpdate`-events приходили в renderer без этих полей.

**Чек-лист при добавлении поля в job:**
1. Добавил `job.foo = …` в backend? Найди `function snapshot(j)` и допиши
   `foo: j.foo || null`.
2. Поле должно пережить рестарт? Добавь и в `params` snapshotting на close
   (`job.params = { ..., foo: job.foo }`) — иначе после рестарта DB-restore
   восстановит null. См. `Persistence-only поля` ниже.
3. Поле читается из `params` при historic-snapshot? Допиши `rowToTgSingleSnapshot`
   (или соответствующий `rowToXxxSnapshot`) маппинг `p?.foo → snapshot.foo`.

Подробнее общий принцип — `methodology/переносимый-дизайн.md::Live snapshot должен
включать все аккумулируемые в job поля`.

### Persistence-only поля в `params` (не в snapshot)

Некоторые job-types кладут дополнительные поля прямо в `parameters_json` чтобы
после рестарта Electron можно было восстановить состояние **без обращения к items
table** (которой может не быть для sourceless-jobs). Снимок отдаёт всё `params`
как есть — рендерер сам разбирает.

| Поле | Где | Зачем |
|---|---|---|
| `is_search`, `search_query`, `search_videos[]` | `yt_batch_transcribe` (search-batch) | JobDetail рендерит финальный список с метаданными; assembleBatch собирает combined.txt без items table |
| `video_files: { vid: file_path }` | `yt_batch_transcribe` (search-batch), set on close | resume-фильтр («что уже сохранено»); assembleBatch путь к файлам |
| `mode='single'` + `url` | `tg_fetch` (single message) | history-row без source_id — после рестарта по этому jobId восстанавливаем что юзер пастил какую ссылку |
| `transcribe_engine`, `transcribe_lang` | `tg_fetch` (single + voice) | юзер выбрал engine для голоса; resume/история показывают через какой движок прогнали |
| `entity_title`, `type_breakdown` (snapshotted) | `tg_fetch` (single), set on close | historic snapshot отрисовывает Header «✓ Готово · Пантела · voice 1» без обращения к items table |
| `_type_breakdown` | `tg_fetch` (любой с source_id), set on close | JobDetail на historic-row рисует chip-ряд «По типам» без обращения к items table |
| `_media_phase` | `tg_fetch` (любой), set on close, только если media_phase непустой | JobDetail на historic-row раскрывает chip-ы «Видео ⚠ 14» в per-msg список ошибок/skipped — иначе errors_log теряется при reaping |

Принцип: если данные нужны UI **после рестарта** и нет другого носителя (items
table, fs convention) — кладём в `params`. См. `fact-youtube-search.md::Persistence`
для search-batch контекста.

> **Шрам — `db.updateJob` партиал пропускает `params`.** Финальный UPDATE на close
> делает partial-обновление и **не** пишет `parameters_json` если поле не передано
> явно. Если в close-handler ты добавил `job.params._media_phase = …` но забыл
> передать `params: job.params` в `db.updateJob(…)` — изменения в params живут
> только в памяти, после reaping/restart их нет. Все четыре persistence-only ключа
> для `tg_fetch` (`_type_breakdown`, `_media_phase`, `entity_title`, `tg_comments`)
> требуют явной передачи params в финальный UPDATE.

### `db-N` IDs для restored sourceless jobs

Sourceless `yt_transcribe` jobs (single video, без source_id) после рестарта Electron живут только в БД. `listJobs()` дополняет live-list историческими через `rowToYoutubeSnapshot()` — у этих snapshots **id это строка `'db-<rowId>'`** вместо integer. Это маркер: cancel невозможен (нет child), `getJobDetail` идёт в БД через тот же префикс. См. `lookupYoutubeCache()` для cache-hit перед новым spawn.

Тот же подход теперь применяется к ещё трём типам без source_id:
- `local_transcribe` через `rowToLocalSnapshot`.
- `tg_fetch` mode='single' через `rowToTgSingleSnapshot` (history-row при mode='single' пишется в close-handler через `db.recordJob({source_id: null, ...})`).
- `yt_batch_transcribe` с `params.is_search === true` через `rowToHistoricSnapshot` — search-batch'и не имеют source_id и иначе пропали бы из Activity-overlay после рестарта (открыть их можно было только через прямой URL).

> **Dedup live vs historic.** Когда close-handler пишет DB row для всё ещё живого
> snapshot'а в Map'е, `listJobs` отдаёт **обе** копии. Renderer-формы (TelegramSingleMessageForm
> и др.) фильтруют по identity-полю и берут first-by-started-at — если это
> попадает на historic snapshot (id=`db-N`), форма теряет связь с live-id и
> пропускает финальный update с `file_path`. Симптом: Copy-кнопка остаётся
> disabled при том что файл уже на диске. Решение — `listJobs` фильтрует
> historic-rows по совпадению `file_path` с любым live snapshot того же типа.

### Historic recovery для всех остальных типов (через `getJobDetail` DB-fallback)

Source-attached batch jobs (`yt_batch_transcribe`, `tk_batch_transcribe`, `ig_batch_transcribe`) **не** живут в Activity-overlay после рестарта — они открываются из «Истории парсинга» в `SourceDetail`, по integer-id напрямую. Раньше клик на такой исторический row отдавал `null` из `getJobDetail` (искал только в Map) → JobDetail зависал на «Loading job…».

**Симптом:** «бесконечная загрузка в JobDetail» при клике на исторический job-row из SourceDetail после рестарта Electron.

**Фикс:** в `getJobDetail(id)` после Map-lookup добавлен DB-fallback `SELECT * FROM jobs WHERE id = ?` → конвертация через `rowToHistoricSnapshot(row)`. Helper:
- Парсит `parameters_json` → `params`.
- Для `*_batch_transcribe` пересоздаёт `yt_batch` / `tk_batch` / `ig_batch` shape с `saved/skipped/errors/cost_usd` из БД-колонок.
- `current` и `log` остаются пустыми — это live-state, восстанавливать его нет смысла. Per-item состояние (какие видео сохранены, file_path) восстанавливается из `items.transcript_path` через `params.video_ids`/`params.shortcodes` в самих body-функциях JobDetail.

Это делает поведение для historic vs live-jobs визуально неотличимым с точки зрения пользователя — ровно одни и те же блоки «Прогресс / Сохранённые видео / Файл результата».

**Фоллбек на «✗ ошибка» в historic строках.** Per-video log пуст после рестарта,
но факт «видео не сохранилось» восстанавливается из `it.transcript_path === null`.
Если `job.status === 'done'` (или `'error'`/`'interrupted'`) и transcript_path для
видео нет — рендерим красное «✗ ошибка» вместо тире. Без этого юзер видит
агрегатный счётчик «3 ошибки» сверху, но не понимает **какие именно** видео не
получились — приходится открывать каждое вручную. Per-video error message
(с текстом причины) теряется — то pending-задача добавить json-сериализацию
`b.log` в close-handler.

## 🎙 Inline AI processing — voice/photo/docs внутри tg_fetch

Юзер пастит `t.me/<chat>/<id>` голосовое или прогоняет batch фетч с галочками
«Голосовые / Видео / Фото / Документы» — ожидает что **в одном спавне**
получит и метаданные, и текст из медиа. Не два subprocess'а с переключением
job, не «сначала fetch, потом отдельный transcribe».

Реализация — `tg_fetch_json.py::process_media(msg, msg_type, ...)` —
общая функция, которая диспетчеризирует по `msg_type`:
- `voice/audio/video` (если `process_voice=true`) → `gemini_utils.transcribe_audio(engine=transcribe_engine)`
- `photo` (если `process_photo=true`) → `gemini_utils.describe_image()` через Vision
- `document` (если `process_docs=true`, и mime содержит `pdf`) → `gemini_utils.extract_pdf()`

Per-msg ndjson-event'ы (все включают `msg_id` чтобы привязать результат к
конкретному item'у):

| Event | Когда | Поля |
|---|---|---|
| `media-progress` | любой stage (downloading/uploading/queued/transcribing/describing/extracting/completed) | `kind` ∈ {`voice`,`photo`,`pdf`}, `msg_id`, `stage`, `engine?`, `aai_status?`, `elapsed_sec?`, `audio_duration_sec?`, `transcript_id?` |
| `media-error` | exception в любой ветке process_media | `kind`, `msg_id`, `message` |
| `media-skipped` | pre-flight skip (silent video, уже обработано) | `kind`, `msg_id`, `reason` |
| `transcript` | voice/audio/video готов (final) | `msg_id`, `engine`, `text` |
| `photo-text` | Vision вернул описание (final) | `msg_id`, `engine`, `text` |
| `pdf-text` | extract_pdf вернул текст (final) | `msg_id`, `engine`, `text` |
| `doc-skipped` | document не PDF (zip/docx/etc) — pre-existing, тоже инкрементит `media_phase[pdf].skipped` | `msg_id`, `mime`, `reason` |
| `transcribe-progress` / `vision-progress` / `doc-progress` / `transcribe-error` / `vision-error` / `doc-error` | **legacy aliases** | те же поля что у нового `media-*` |

**Зачем aliases.** Python теперь emit'ит только унифицированные `media-*`, но Node-сторона держит case'ы legacy-имён — на случай если перезапуск Electron происходит во время активного Python-процесса от старой сборки (закэшенный spawn продолжает emit'ить старыми именами). Через одну-две версии (когда уверены что нет orphan'ов) — уберём.

**AAI sub-stages (только для engine='assemblyai').** Раньше `transcribe_assemblyai` делал блокирующий `Transcriber.transcribe()` — SDK молча ждёт upload → queued → processing → completed и возвращает текст. Юзер видел замёрзший спиннер на 2 часа для длинных файлов. Теперь — `Transcriber.submit()` + ручной poll цикла каждые 2 сек:

1. `stage=uploading` — emit перед `submit` (заливаем файл, может ехать долго при больших размерах)
2. `stage=queued` — после submit; есть `transcript_id`, `audio_duration_sec` (ms→sec в gemini_utils)
3. `stage=transcribing` (повторяется) — `aai_status` ∈ {queued, processing}, `elapsed_sec`, `audio_duration_sec`
4. `stage=completed` — финальный tick перед получением `text`

UI рендерит таймер `M:SS / ~ETA`. ETA = `audio_duration × 0.2` (universal-2 ~5x realtime, грубо — нагрузка варьируется). Без UI'я (CLI-сторона) `progress_cb=None` → старая блокирующая ветка.

**Polling 2с не 5с.** SDK `polling_interval` дефолт 5s, но короткие файлы (5 мин аудио = ~30-60s обработки) проходят за один SDK-tick — UI не успевает увидеть transcribing. 2s даёт ~10-20 ticks для среднего файла. Для часовых записей разница незаметна, но визуальная гладкость лучше. См. `gemini_utils.transcribe_assemblyai`.

**Где НЕ работает — Gemini engine.** Gemini chunked-pipeline делает свою внутреннюю разбивку на 10-минутные куски и склеивает. progress_cb пробрасывается в `transcribe_audio` но игнорируется AssemblyAI-пути там нет. Расширение по той же сигнатуре (`progress_cb('chunk', i, total)`) — если станет нужно.

job-runner обрабатывает их аналогично batch'у — оседает в `job.tg_voice = {stage, engine, text, error}`. UI (TelegramSingleMessageForm) рендерит **две независимые строки**: «Загружаем сообщение» и «Транскрибируем голосовое · assemblyai», каждая со своим pending/running/done/error состоянием. Без разделения юзер видел один «загружаем…» спиннер на 30+ секунд и не понимал на какой стадии висит.

В close-handler (`fs.writeFileSync` для single) транскрипт склеивается с caption: `<sender>\n\n<text>\n\n[голосовое — расшифровка · assemblyai]\n<transcript>`. Если transcript-error — `[голосовое — расшифровка не удалась: <message>]` вместо текста. Если engine не запрошен (юзер выбрал «без транскрипции» — пока не реализовано в UI) — placeholder `[голосовое сообщение — транскрипция не запрошена]`.

> **Что отбросили — отдельный subprocess после tg_fetch close**. Можно было сделать второй spawn `tg_voice_transcribe.py` после первого. Минусы: два jobId в Activity (юзеру одно действие — одна запись в истории), две отдельные ошибки если что-то упало, лишнее IPC-туда-сюда. Один скрипт с lazy-import gemini_utils (только если voice присутствует) проще и логичнее.

> **Шрам — shadowed `client`**. Telethon-`client` живёт в `run()`-функции с момента подключения до `await client.disconnect()` в конце. В блоке voice-transcription лежит соблазн написать `client = gemini_utils.GeminiClient()` — но это перетирает локальное имя в той же замыкающей области. После выхода из блока `await client.disconnect()` падает `AttributeError: 'GeminiClient' object has no attribute 'disconnect'`. Симптом: job завершён `done`, файл сохранён, но в логе error. Использовать `gc = GeminiClient()` или подобное локальное имя. См. `CLAUDE.md::anti-pattern shadow client`.

### On-demand перевод выбранных сообщений (`mode=media_only`)

Юзер на странице источника в списке сообщений (`ChatView`) галочками выбирает
конкретные voice/photo/document-сообщения и жмёт «перевести» (per-row или bulk).
Это НЕ re-fetch всего чата — это точечная (ре)обработка уже-сохранённых
сообщений по их `msg_id`.

**Контракт.** Renderer зовёт `window.api.tgFetch({ mode:'media_only',
_source_id, _media_only_msg_ids:[id,...], transcribe_engine, process_voice/photo/docs })`.
Это **тот же** `tg_fetch` job-type — не новый. Различие несёт `params.mode`.

**Python (`tg_fetch_json.py`).** Новая ветка `elif mode == "media_only"` (рядом с
`single`): `client.get_messages(entity, ids=[...])` → цикл `process_media()` на
каждое сообщение → `done`. Никакого `iter_messages` walk. Аргумент
`--media-only-msg-ids` (+ `media_only` в `--mode choices`). Переиспользует все
существующие media-события (`media-progress` / `transcript` / `photo-text` /
`pdf-text`, каждое с `msg_id`).

**job-runner.** `isMediaOnly = Array.isArray(params._media_only_msg_ids)`:
- `--media-only-msg-ids` в args;
- `isEphemeral |= isMediaOnly` → **skip-processed НЕ строится** (юзер явно просит
  обработать заново, возможно другим движком — иначе skip-set занулил бы запрос);
- media_only **не эмитит `entity`-pending-row через обычный путь надёжно**, поэтому
  `job.source_id = Number(params._source_id)` + pending `recordJob` ставятся
  **на старте job'а** (паттерн «pending row on spawn» как у `tg_reply_backfill`).
  entity-event всё равно прилетает (резолв сущности до dispatch) — но его
  `recordJob` гард `!job.dbRowId` уже false → **без дубля History-row**;
- файловый sidecar **не пишется** (`fpath=null`): результат в caption'ах, а не в
  файле; `job.items` пуст;
- **replay вынесен из `if (job.items.length)`** — стал `if (job.source_id &&
  stash.length)`. Без этого on-demand перевод тихо терял бы результаты (items
  пуст → старый guard скипал replay). Для обычного fetch'а порядок сохранён:
  `bulkUpsertItems` (создаёт строки) → `appendItemTranscript` (дописывает в caption).

**UI-замыкание.** На terminal `done` — `jobInvalidation.js` бьёт `items:<source_id>`
→ `ChatView` рефетчит → строка теперь `transcribe_status='done'` + caption с
AI-блоком → loader исчезает, ✓ показан, копи-кнопка отдаёт готовый текст. Per-row
loader жив, пока `media_phase[kind].current.msg_id === item.external_id` у live-job'а
(`String(msg_id)` обе стороны, TG external_id = голый msg_id без префикса).
Label в Activity / History — «Telegram · перевод медиа» / «Перевод медиа · N»
(ветка по `params.mode==='media_only'`). Per-item копи — IPC `items:copyMany`
(читает caption'ы по external_id, не через type-gated assembly-WHERE).

Multi-select живёт в `src/lib/chatSelection.js` (зеркало `telegramSelection.js`):
`Set<id>+anchor`, Shift-range по видимому порядку, `pruneTo`/`clear` идемпотентны
(early-return при отсутствии изменений — иначе useSyncExternalStore-петля).

### Per-type флаги (process_voice/photo/docs)

Включение AI-обработки требует **двух** независимых параметров:
1. `--transcribe-engine assemblyai|gemini` — какой движок использовать для аудио (общий для voice/video)
2. `--process-voice` / `--process-photo` / `--process-docs` — какие типы вообще обрабатывать

Только `--transcribe-engine` без флагов **ничего не делает** (кроме legacy
single-mode guard, см. ниже). Это сделано чтобы UI мог выбрать разные подмножества
(юзер галочкой включил «Голосовые + Документы», но не «Фото») без угадывания
по engine.

> **Шрам — folder batch регрессия**. До явных флагов `tg_folder_fetch`
> передавал детям только `transcribe_engine` (общий на всех children). После
> разделения engine/process — folder fetch с types=['text','voice','photo','docs']
> возвращался metadata-only потому что `process_voice/photo/docs=false`. Симптом:
> юзер галочкой выбрал voice+photo, нажал Спарсить, в caption полей остались
> placeholders — **только метаданные** (см. fact-database.md::caption format).
> Лечение в job-runner: `tg_folder_fetch` строит wantsVoice/Photo/Docs из
> `params.types` и пробрасывает в каждый child startTelegramFetch.

**Single-message legacy guard.** TelegramSingleMessageForm посылает только
`transcribe_engine: 'assemblyai'` без явных process-флагов (старый контракт
до этого расширения). Чтобы не ломать существующий путь, в Python-стороне
есть guard: «если single-mode и engine задан, но ни один process_* флаг не
выставлен — force `process_voice=True`». Новые callers (TelegramConfigForm,
TelegramScreen) передают флаги явно и guard не срабатывает.

### MIME-фильтр для documents

Telethon кладёт в `msg_type='document'` всё что не distinct тип: PDF, DOCX,
архивы, exe-файлы, mp4 без preview-thumbnail, голосовые из старых клиентов
без `voice` flag. Прямой `extract_pdf()` на не-PDF падает с 400 от Gemini
(`API_KEY_INVALID` или `bad mime type`).

Перед download в `process_media` берётся `msg.media.document.mime_type` и
сравнивается с `pdf` substring. Если не PDF — `doc-skipped` info-event с
mime + reason, никакой ошибки. UI логирует на `console.log(...)`, не на
красный `doc-error` — это валидное поведение, не сбой.

### Replay результатов в caption через appendItemTranscript

Live AI-events приходят **до** того как `bulkUpsertItems` запишет items в
БД (close-handler делает batch-insert на закрытие job'а). Если бы каждый
`transcript`/`photo-text`/`pdf-text` сразу UPDATE'ил items — UPDATE падал
бы no-op (row ещё нет).

Решение — events stash в `job.tg_media_results = [{msg_id, kind, engine, text}]`,
а **после** `bulkUpsertItems` close-handler делает replay через
`db.appendItemTranscript({source_id, external_id, text, engine, kind})` для
каждого stashed-результата. См. `fact-database.md::appendItemTranscript`.

**Idempotency в caption.** appendItemTranscript генерит heading вида
`[голосовое — расшифровка · gemini]` / `[фото — описание · gemini]` /
`[документ — извлечение · gemini]` и проверяет вхождение в существующий
caption. Если heading уже там (re-fetch с тем же engine) — body не
дублируется, но статусные поля (`transcribe_status='done'`,
`transcribe_engine`) пишутся всё равно. Re-fetch с **другим** engine
сознательно добавляет второй блок — юзер сравнивает Gemini vs AAI на одном
аудио.

### GeminiClient lazy-init с `requires_real_key`

`gemini_utils.GeminiClient.__init__` требует ключ из env или `cli-tools/config.env`
**безусловно**, даже если `engine='assemblyai'`. Чистый AAI-путь не делает ни
одного RPC к Google — но constructor падает если ключа нет.

Вместо placeholder-trick (`os.environ['GEMINI_API_KEY'] = 'unused-by-assemblyai'`
до import) — helper `_make_gemini_client(*, requires_real_key=True)`:
1. Создаёт client (он сам подгружает из config.env если в env пусто)
2. Если `requires_real_key=True` (любой Gemini-вызов) и ключ пустой/placeholder
   → `RuntimeError("GEMINI_API_KEY not found — Gemini transcription / vision /
   PDF extraction won't work...")` — чёткое сообщение в UI до попытки RPC
3. Если `requires_real_key=False` (AAI-only путь) и ключ пустой → ставит
   placeholder, RPC к Gemini не пойдёт → не критично

Симптом без discriminator'а: юзер выбрал AAI, но забыл положить
GEMINI_API_KEY → fetch падает с криптичным `400 API_KEY_INVALID` от
Google вместо понятной ошибки конфигурации. См.
`fact-local-files.md::Gemini-required init` — там аналогичный workaround
для local-file flow.

## 📊 `media_phase`: per-kind aggregate (voice / photo / pdf)

Каждое `media-progress`/`media-error`/`media-skipped` событие наполняет
лениво растущий слот `job.media_phase[kind]`:

```
{
  total:    int,    // count уникальных msg_id, видимых в любом media-* event'е
  done:     int,    // финальные события: transcript / photo-text / pdf-text
  errors:   int,    // media-error на этом msg_id
  skipped:  int,    // media-skipped (silent video, уже обработано, doc-skipped)
  current:  { msg_id, stage, engine, aai_status, elapsed_sec, audio_duration_sec } | null,
  errors_log:  [{msg_id, message}, ...max 20],   // что показать в UI «показать ошибки»
  skipped_log: [{msg_id, reason},  ...max 20],   // и «показать пропущенные»
  _seen:     Set<msg_id>,   // приватный, не попадает в snapshot
  _finished: Set<msg_id>,   // приватный, дедупит final/error/skipped per-msg
}
```

**Лень.** Слот создаётся первым касанием kind, и `total` инкрементится
только когда впервые встретили `msg_id`. Не идём в Telegram чтобы заранее
посчитать сколько voice'ов в выборке — это удвоило бы трафик. Пользовательский
вид при работе становится `7 / ?` пока fetch ещё не дошёл до конца, и
`✓ 13/13 · 11 пропущ.` после close.

**Race-avoidance в `current`.** Final-событие (`transcript`/`photo-text`/
`pdf-text`/`media-error`) очищает `current` **только если** `msg_id`
совпадает с тем, что сейчас «в работе». Без этой проверки на параллельной
обработке двух msg final по A освобождал бы UI-индикатор для msg B —
визуально кажется что B мгновенно «остановился», а потом снова «пошёл»
когда придёт next progress event. Возможна параллельность когда
несколько photo обрабатываются одновременно (Vision-API быстрая).

**Sticky `audio_duration_sec`.** Между stages для одного msg_id duration
**не сбрасывается**: `media-progress(stage=downloading, audio_duration_sec=42)`
ставит 42, потом `media-progress(stage=uploading)` без duration **сохраняет**
42 (sticky). AAI возвращает свой replay duration на `queued` — вытесняет
наш ffprobe-replay (точнее). Без sticky UI моргал «аудио 0:42» → пусто →
«аудио 0:42» при переходе через uploading.

**Snapshot копия (`_publicMediaPhase`).** В IPC уходит чистая JSON-форма
без `_seen`/`_finished` Set'ов (они не сериализуются и не нужны на UI).
Если ни один kind не тронут — поле в snapshot = `null` (компактнее).

UI-сторона — `<JobProgress job={...} variant="compact|full" />` — единый
рендерер для ActivityPanel JobRow, JobDetail TelegramBody и SourceDetail
History row. См. `methodology/переносимый-дизайн.md::Detection #1`.

**Маппинг `item-type` → `media_phase.kind` для UI-индикаторов.** Type-breakdown
group'ит по физическому `items.type` (voice/video/audio/photo/document/…),
а media_phase агрегирует по **AI-пайплайну** — один слот на пайплайн, не на
физический тип. Для UI:
- `voice` / `video` / `audio` → `media_phase.voice` (один транскрайбер на любой
  audio-источник, неважно вынут он из voice-message'а или video-track'а).
- `photo` → `media_phase.photo`.
- `document` / `docs` → `media_phase.pdf`.
- `text` / `poll` / `service` / `sticker` / `gif` / `other` → нет слота, chip
  в UI не имеет drill-down (нет AI-пайплайна, нечему упасть).

`JobDetail::TypeBreakdownChips` использует `TG_TYPE_TO_MEDIA_KIND` для разрешения,
показывать ли красный ⚠ + раскрытие. Без маппинга chip-ы для `video` рендерились
бы без warning'а (потому что `media_phase.video` не существует), хотя именно
видео типично роняются на AAI с no-audio-track.

**Persist для historic JobDetail.** `_publicMediaPhase(job.media_phase)` записывается
в `params._media_phase` в close-handler. `rowToHistoricSnapshot` и
`rowToTgSingleSnapshot` хайдратируют `snapshot.media_phase = params._media_phase`.
Без этого historic-row после reaping/restart лишается per-kind errors_log /
skipped_log — JobDetail видит chip `Видео 60 ⚠ 14`, но клик ничего не раскрывает
(`media_phase.voice.errors_log = []`). См. таблицу «Persistence-only поля» выше.

## ⏭ Skip-already-processed media через `--skip-processed-file`

Re-fetch чата по дефолту **не должен** заново гонять voice/photo/pdf через
AAI/Gemini, если эти msg_id уже обработаны в прошлый раз. Логика — на
Node-стороне до spawn'а:

1. `db.findTelegramSourceByTarget(target)` ищет existing source row
   (handle exact-match, fallback на оба варианта numeric `-100<id>` /
   `<id>`, last-resort match по `external_id` без `-100` префикса —
   compensation для расхождения форматов handle между paste-flow'ами).
2. `db.listProcessedExternalIdsByKind(source_id)` отдаёт map
   `{kind: {msg_id: engine_string}}` где `transcribe_status='done'` —
   **с** `transcribe_engine` (важно для engine-aware skip ниже).
3. Map пишется в `os.tmpdir()/tg_skip_<jobId>.json`, в args добавляется
   `--skip-processed-file <path>`. Файл удаляется в close-handler.
4. Python загружает map в `_SKIP_VOICE/_SKIP_PHOTO/_SKIP_PDF`.
   `process_media` чекает membership ДО download → `media-skipped(reason="уже
   обработано · <engine>")`.

**Engine-aware skip — не плоский set.** Skip срабатывает только если
**тот же** engine (например, AAI ↔ AAI, Gemini Vision ↔ Gemini Vision).
Re-run с **другим** известным engine — сознательно пропускается через
skip и идёт в обработку: `appendItemTranscript` приклеит второй блок
с другим heading (`[голосовое — расшифровка · gemini]` рядом с
`[голосовое — расшифровка · assemblyai]`) — юзер сравнивает движки
side-by-side. См. `fact-database.md::appendItemTranscript`.

**Legacy items без engine info.** Старые items (записаны до того как
`transcribe_engine` стал персиститься) приходят с `engine=''`. Они
скипаются **независимо от запрошенного engine** — bandwidth-saver, иначе
flat-set отлуп раздражал бы юзеров вечного re-runa. Override — toggle
«парсить заново» (см. ниже).

**Что выпадает из skip — ephemeral flows.** Skip пропускается для:
- `mode='single'` (paste single-message t.me) — single-mode пишет
  отдельный `.txt` файл. Skip обнулил бы файл (transcript event не
  пришёл бы), `.txt` содержал бы только caption. Single всегда
  re-process.
- `_comments_only_post_ids` (Дотянуть комментарии) — не вызывает
  process_media в принципе, skip-pass cheap но бесполезен.
- `tg_folder_fetch` children — НЕ ephemeral, skip активен (TG-folder
  batch ожидает skip как нормальное поведение).

**User-facing toggle «парсить заново».** Default OFF, амбер pill
рядом со Start fetch button. При ON выставляет `params.redo_processed=true`
в job-runner — skip-set не строится. Заодно отключает внутренний
`skipDupes`-windowing (`min_id=maxExternalId`) для `last_n` режима, иначе
iter_messages выбросил бы те самые msg_id что юзер хочет revisit'нуть.

> **Что отбросили — старая UI-кнопка «пропускать дубли».** Юзеры путали её
> с re-transcribe toggle (она была про fetch-window: `min_id` для last_n).
> Сняли с UI оставив `skipDupes` внутренней оптимизацией (default ON,
> trim'ит трафик на больших чатах).

> **Что отбросили — flat-set без engine match.** Это сломало бы
> `appendItemTranscript` сценарий side-by-side compare для AAI vs Gemini.
> Map с engine-info добавляет ~30% к payload size, payload всё равно
> в пределах MB на чатах с 10k обработанных media — приемлемо.

## 🆔 Dual-id space: in-memory vs DB

Job имеет **два** integer-id, идущих из независимых счётчиков:
- `j.id` — in-memory, `nextId++` от старта Electron-процесса. Используется
  ActivityPanel'ом (читает `listJobs()` который возвращает live snapshots).
- `dbRowId` (он же `db_id` в snapshot) — `SELECT last_insert_rowid()` после
  `INSERT INTO jobs` на entity-event. Используется SourceDetail History
  (читает `db.listJobsForSource()` напрямую из БД-row).

Они **не совпадают**. На `nextId=1` SQLite уже мог быть на `last_id=403` —
in-memory id=1 ≠ DB row id=403 для одного и того же job'а.

**Симптом расхождения.** Кнопка Stop в Activity (передаёт `j.id` =
in-memory) работала, ровно та же Stop в SourceDetail History (передаёт
DB id) — silent no-op: `cancelJob(403)` не находил в `jobs.Map` (там id=1).

**Фикс — fallback по `dbRowId`** в трёх местах:
- `cancelJob(id)` — после промаха `jobs.get(id)` делает линейный поиск
  по `jobs.values()` где `j.dbRowId === id`.
- `getJobDetail(id)` — тот же fallback перед DB-fallback. Без него
  JobDetail открытый из History у running job показывал «Loading job…»
  бесконечно (Map-промах → DB-снимок без live-state).
- `watchJob(id, onChange)` в renderer — `onJobUpdate` сравнивает с
  `updated.id || updated.db_id`. Иначе live-progress не доходил бы до
  JobDetail, открытого из History в момент когда job ещё бежит.

Снапшот теперь экспортирует оба id (`id` + `db_id`) — renderer-side код
не должен знать какой откуда пришёл, оба считаются legitimate identity.

> **Что отбросили — единое id-пространство.** Хотелось присвоить
> in-memory id = DB id (взять у SQLite сразу при `recordJob`). Сломало бы:
> (а) `db-N` строковые id для restored sourceless jobs (см. секцию
> «`db-N` IDs для restored sourceless jobs»), (б) entity-event приходит
> *после* старта job'а, до этого момента DB row не существует — а
> `j.id` нужен сразу для emit'а в Activity. Two id-пространства проще,
> чем pre-allocate DB row до spawn'а.

## 🟢 Pending row на entity → UPDATE на close

Раньше для `tg_fetch` строка в БД-таблице `jobs` появлялась **только** на
успешный close (внутри coverage-recording блока). Симптом: «История парсинга»
на странице источника не показывает running job, юзер не видит спиннер
прогресса.

**Контракт сейчас:** на `entity` event делается `db.recordJob({ status:
'running', items_done: 0, ... })`, id запоминается в `job.dbRowId`. На close
— **`db.updateJob(dbRowId, { status, finished_at, file_path, ... })`**, тот
же id, без второго INSERT. Coverage records пишутся через тот же id.

Renderer подписан на `'jobs:<source_id>'` через invalidation bus
(см. `fact-data-bus.md`) — pending row появляется в истории сразу после
`entity`-event, обновляется на close.

`db.updateJob(id, patch)` — partial update: пишутся только переданные поля.
Сделано так чтобы coverage-flow и close-flow могли независимо апдейтить
свою часть row без затирания.

### Backfill-jobs: pending row на spawn, UPDATE на каждый page

`tg_reply_backfill` — особый случай: **нет `entity` event** (target резолвится
JS-стороной до спавна Python из `sources.handle`). Pending row пишется
**сразу в start-handler**, до spawn'а subprocess.

Также этот job-type делает `db.updateJob({items_done: evt.loaded})` на
**каждый `page` event** (1 батч = 100 items), не only-on-close. Симптом
без этого: JobDetail (читает row из БД на mount) показывает stale `0/N`
весь runtime job'а, пока Activity (живой in-memory snapshot) показывает
актуальный 5000/21108. Юзер видит расхождение между двумя UI-источниками,
кажется будто job завис. Один UPDATE на 100 items — недорого, синхронизация
двух представлений сама собой.

### Mid-run DB sync для tg_fetch и tg_index (тот же паттерн)

То же правило — расширено на основные TG-job'ы, которые тоже страдали
двойным источником правды:

| Тип | Когда `db.updateJob({items_done})` |
|---|---|
| `tg_fetch` | на `page` event (раз в 100 items) **+ tick на каждый 10-й item** в `case 'item'` |
| `tg_index` | после каждого `embedBatch` + `bulkUpsertVectors` (~~раз в 32 items) |
| `tg_reply_backfill` | на каждый `page` event (раз в 100 items) |
| `tg_folder_fetch` | finalize-only (per-chat children сами синхронятся, umbrella никого не торопит) |
| `tg_folder_refresh` | finalize-only (короткие job'ы, ≤ нескольких секунд) |

**Симптом без mid-run sync:** в Activity panel (читает live in-memory
snapshot через `onJobUpdate`) счётчик растёт нормально — `12000 / 32145`.
В «История парсинга» (читает из БД через `jobsListForSource`) и в JobDetail
открытого с историка — `0 msgs`, прочерк, длительность `—`. Юзер
переключается между двумя UI-местами и видит **разные** прогрессы у
одного job'а. Кажется будто app сломан или job повис.

### Timing logs для tg_fetch start/close

Для лагов «на старте fetch» и «на окончании fetch» не гадать по коду, а
смотреть фазовые `[Jobs]` логи. `tg_fetch` теперь пишет duration у spawn,
entity resolve, `upsertSource`, pending row, skip-processed setup, close begin,
prepare rows, `bulkUpsertItems`, media replay, coverage, JSON stringify,
sidecar write, `updateJob` и общий `close_ms`.

Практический тест: если пользователь говорит «после Start fetch всё висит»,
сравни соседние строки `start tg_fetch`, `spawned pid`, `entity=... resolve_ms`
и `recordJob pending`. Если лаг на завершении — смотреть `close #... begin`
до `end #... close_ms=...`, а не искать глазами React-компонент. Все строки
с `[Jobs]` префиксом попадают в production log по контракту `fact-logging.md`.

**Item-tick (раз в 10 items) для `tg_fetch`** — нужен потому что page-event
boundary раз в 100 не помогал на медленных fetch'ах с инлайн AI: между
двумя page'ами проходит минута+ (download + AAI на каждом voice), Activity
показывает живые `84`, History всё ещё `0` после первой сотни. Симптом:
юзер думает «job завис». Item-tick — single-row UPDATE, ~0.5мс, не
конфликтует с page-tick (последний всегда побеждает на boundary).

Mid-run UPDATE — single `WHERE id=?`, дешевле всех других операций
batch'а (embedBatch ~ 200мс, write — ~0.5мс). Не конфликтует с
close-handler'ом: тот делает финальный UPDATE с full payload (status,
items_total, finished_at, file_path), mid-run пишет только `items_done`.

> **Что пробовали и почему не сработало.** Изначально в `index-job.js`
> `db.updateJob` стоял только в `finally`. Аргумент был «зачем плодить
> WRITE'ы, всё равно close сразу финализирует». Не учли что embedBatch
> идёт **минутами** на средних чатах (32k items × 250 ms = 13 минут), и
> юзер за это время заходит в History и думает «ничего не делается».

## 🧪 `tg_preview` как полноценный job-type

Раньше pre-analysis запускался как `runTelegramPreview() → Promise<{summary,
entity}>` и не светился в Activity panel. Симптом: preview на 5000 сообщений
занимает 50 секунд, юзер видит spinner внутри формы и не понимает идёт ли
процесс или зависло.

**Сейчас** `startTelegramPreview()` создаёт полноценный job со своим
`type: 'tg_preview'`, виден в Activity и в «История парсинга», cancellable
через SIGTERM. По завершении `preview_summary` оседает в snapshot
(см. таблицу выше). Renderer подписан через `watchJob(id)` в TelegramConfigForm.

Подробнее про motivation миграции — `fact-fetch-strategies.md::tg_preview`.

## 🧹 На что обращать внимание при изменении
- **Не emit'ить snapshot из renderer-side кода** — это контракт main process'а. Renderer пассивно слушает.
- **Не забывать очищать listeners** при unmount (`useEffect` cleanup в `JobDetail.jsx`). Иначе после второго клика на job получишь два setState на каждое обновление.
- **При добавлении нового поля в job state** — обновить и `snapshot()` функцию, и тип-чек в renderer (если будет TS).
- **Cancel-кнопка `e.stopPropagation()`** — потому что вся карточка job в `ActivityPanel` clickable (открывает detail). Без stopPropagation cancel + сразу детальное открытие.

## 🗂 Где сохранённые файлы
`~/Library/Application Support/sc-desktop/jobs/`. Можно переопределить через env `SC_DESKTOP_DIR` — полезно для тестов.

### 🔔 Звук на auto-copy

YouTube и TikTok single-video flow автоматически копируют transcript в
буфер обмена в момент завершения (или мгновенно при cache-hit). На каждый
такой auto-copy `playClipboardSound()` играет macOS-системный
`Blow.aiff` через `afplay` — повторяет CLI-привычку «Copy-First, со звуком».

**Только auto-copies.** Manual «Copy» в JobDetail (через `jobs:copyFile`)
звука не даёт — юзер сам инициировал, ему звук не нужен. Cache-hit IPC
(`yt:copyCachedFile`/`tk:copyCachedFile`) делит handler с auto-mount-копией
формы, поэтому звук там тоже играет — разделение на два IPC ради тишины
manual «Copy ещё раз» не оправдано.

В UI на JobDetail screen есть три действия:
- **Copy** — читает файл и кладёт **содержимое** в clipboard (не путь). Для drag-drop в Cursor/ChatGPT.
- **Open in Sublime** — пытается `subl <file>`, потом `open -a /Applications/Sublime Text.app <file>`, потом `shell.openPath()`. Возвращает `opener` чтобы UI показал «Opened in subl».
- **Reveal** — `shell.showItemInFolder()`, открывает Finder с подсветкой файла.

### Auto-combined.txt для IG batch (vs by-request для YT)

`ig_batch_transcribe` пишет combined-файл `<date>_ig_batch_<jobN>_combined.txt` в `JOBS_DIR` **автоматически** на close — без отдельного «Save combined» action в UI. JobDetail сразу показывает «Файл результата» с Copy/Open/Reveal.

`yt_batch_transcribe`, наоборот, требует от юзера явного клика «Save combined». Разница в семантике:
- YT — у каждого видео есть **бесплатный** subs-путь, юзер часто хочет посмотреть отдельные транскрипты по ссылкам и не нуждается в сводке.
- IG — каждый сохранённый рилс это **платный AI-транскрипт**. Combined блок — единственный итог, ради которого юзер собрал batch. Делать «Save combined» отдельной кнопкой = заставлять кликать ради вещи, которая нужна всегда.

`job.file_path` устанавливается в combined-файл, поэтому universal-FileCard в JobDetail его подцепляет автоматически. Per-reel transcripts (`<shortcode>__<slug>.txt` в `transcripts/instagram/`) остаются на диске — `JobDetail::InstagramBatchBody` рендерит per-reel список с кнопками `open` рядом с каждым.
