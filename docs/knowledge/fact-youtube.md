# Knowledge: YouTube Stack

Всё что касается YouTube как платформы в SC Desktop. Канал — это `source` в Library. Видео — это `item` внутри канала. Разовое видео без канала — `yt_transcribe` job без source_id.

> TikTok работает по тому же контракту events (`entity`/`item`/`page`/`preview_summary`/`done`) и переиспользует тот же batch-picker pattern. Различия — отсутствие `awaiting_ai`, точные даты вместо approximate, экспирация play-URL — описаны в `fact-tiktok.md`.

> Комментарии — отдельный продукт со своими параметрами и кэшем; всё про них в `fact-youtube-comments.md`.

## 🧭 Скрипты, цели

| Скрипт | Что делает | Тип job |
|---|---|---|
| `python-workers/web/yt_single_ndjson.py` | Один URL → транскрипт (subs или AI) | `yt_transcribe` (с source_id) |
| `python-workers/web/yt_channel_ndjson.py` | URL канала → список видео (flat-playlist) | `yt_channel_fetch` (с source_id) |
| `python-workers/web/yt_batch_transcribe_ndjson.py` | Список video_ids → batch транскрипция | `yt_batch_transcribe` (с source_id) |
| `python-workers/web/yt_comments_ndjson.py` | Один URL → комментарии в .txt | `yt_comments` (с source_id) |
| `python-workers/web/yt_batch_comments_ndjson.py` | Список video_ids → батч комментариев | `yt_batch_comments` (с source_id опционально) |

Batch и channel-fetch ассоциируются с source. Single — теперь тоже (см.
ниже «Single-paste = source + items»); видео попадает в Library под своим
каналом, в Activity → Recent видим всё через `WHERE type IN (...)` без
учёта source_id.

---

## 🪪 URL canonicalization → `channel_id`

Юзер может прийти 4 разными формами одного и того же канала:
```
@durov                 →  https://www.youtube.com/@durov/videos
durov                  →  https://www.youtube.com/@durov/videos
UCAuUUnT6oDeKwE6v1NGQxug  →  https://www.youtube.com/channel/UC.../videos
https://www.youtube.com/c/x          →  .../c/x/videos
https://www.youtube.com/watch?v=ID   →  resolve channel_url, потом /videos
```

`canonicalize()` в `yt_channel_ndjson.py` приводит всё к `/videos` URL. Bare 24-char UC-id превращается в `/channel/<id>/videos` явно (`UC_ID_RE`). Video URL → дополнительный `yt-dlp --dump-json --no-playlist` чтобы вытащить `channel_url`, потом обычный flat-playlist по нему.

**Зачем `/videos` суффикс:** bare `/@handle` отдаёт meta-playlist `[Videos, Shorts]` — yt-dlp возвращает структуру с `playlist_count: 2` и nested entries. `/videos` отдаёт сразу tab с видео.

### UPSERT по `external_id = channel_id`, не handle

`db.upsertYoutubeChannel()` сначала ищет по `(platform='youtube', external_id=UC...)`, fallback по handle. Это критично потому что **handle может смениться** (юзер ребрендит канал), а `channel_id` стабилен. Если бы UPSERT шёл по handle — ребренд + повторный paste создавал бы дубль.

Без `UNIQUE(platform, external_id)` constraint в схеме — это была бы миграция БД. Используем lookup-перед-insert внутри функции, функционально эквивалентно.

---

## 📅 Approximate dates trade-off

yt-dlp на flat-playlist по умолчанию возвращает `timestamp: null` для всех видео. Чтобы получить дату — нужно запросить каждое видео отдельно (медленно, 200 видео = ~5 минут).

Флаг `--extractor-args "youtubetab:approximate_date"` парсит относительный текст feed'а («3 months ago») в timestamp `today − N×30 дней`. Канал тянется так же быстро (2-3 секунды на 200 видео), но **день не настоящий** — это арифметика today minus N дней.

**Симптом для пользователя:** «у всех 6 видео день одинаковый — 26-е число». Не баг — это просто смещение от сегодняшней даты.

**Решение:** UI рендерит только месяц+год (`мар 26`, не `26.03.26`). См. `fmtDate` в `YouTubeBatchPicker.jsx`, `YouTubeChannelForm.jsx::ChannelHeader`, `ChatView.jsx::MessageRow` (для youtube items). Для Telegram остаётся полный datetime — Telethon отдаёт точные timestamps.

**Альтернативы которые отбросили:**
- Per-video `dump-json` для точных дат — слишком долго на больших каналах (≈1.5s × 200 = 5 минут).
- Не показывать дату вообще — теряется сортировка и диапазон.

---

## 🎬 Two-stage single video (`yt_transcribe`)

Жизненный цикл одиночного транскрипта проходит через **два spawn'а одного скрипта** под одним `jobId`:

```
Stage 1: yt_single_ndjson.py <url> --out-dir ...
   → emit: metadata_start, video, subs_racing, subs_found | subs_missing,
           save_start, saved (если subs), done
   → если subs не нашлись: status='awaiting_ai', child exited cleanly

Stage 2 (опционально): тот же скрипт + --ai --engine gemini|assemblyai
   → emit: audio_download_start, audio_download_done,
           transcribe_start, transcribe_done, save_start, saved, done
```

Stage 1 начинается с `fetch_meta()` — yt-dlp metadata pull. Он **изредка
флакает транзиентно на первом холодном клике** (rate-limit / cookie-лок /
nsig-прогрев) и раньше дед-эндил весь клик безликим «metadata fetch failed».
Сейчас ретраит 3× с backoff и пробрасывает реальную ошибку yt-dlp. См.
`fix-yt-dlp-meta-retry.md`.

**Зачем два spawn'а вместо одного с consent prompt'ом:**
- Stage 1 эфемерен (1-3 сек). Если subs нашлись — задача закрыта, никакого AI и оплаты.
- Если subs нет — `awaiting_ai` это **состояние без alive child**: процесс exited 0, мы ждём решения юзера. Можно сидеть в этом состоянии хоть час, никто не висит. Cancel = просто `status='cancelled'` без kill (см. `cancelJob` в job-runner).
- Resumable через тот же jobId — Activity Recent видит **одну** строку, а не две.

SC Desk mobile API проецирует тот же job в одну внешнюю history-row. До
`awaiting_ai` видны `fetching_metadata → searching_subtitles →
saving_subtitles`; после явного Resume AI та же запись расширяется до
`downloading_audio → preparing_audio → transcribing → saving`. Каждая смена
пользовательской стадии обязана сразу вызвать `emit(job)`, иначе iPhone
застынет на прежнем шаге при реально работающем worker. Внешний REST/SSE
contract и restart recovery — `fact-sc-desk.md`.

Внешние потребители не обязаны принимать одинаковое решение после этой паузы.
Browser-extension сам продолжает `awaiting_ai`, потому что там у пользователя
нет отдельной кнопки согласия. MCP-инструмент `youtube_get_subtitles`, наоборот,
сообщает `subtitles_not_found` и `needs_ai=true`, но не запускает платный второй
этап: агенту разрешено забрать готовые прямые субтитры, а не принимать денежное
решение вместо пользователя. Не переносить auto-resume browser-extension'а на
MCP или mobile API. Контракт ожидания, пагинации текста и отмены —
`fact-sc-desk.md::MCP: субтитры для локального AI-агента`.

### Single-paste = source + items (architectural shift)

Раньше `yt_transcribe` был **sourceless**: paste одного видео не создавал
канал в Library, файл лежал на диске + строка в jobs. Cross-context cache
работал только в одну сторону — при batch-fetch'е канала находил твой
старый single-paste этого же видео по `parameters_json LIKE`. Обратная
сторона не работала: paste того же URL дважды → второй раз заново фетчил
metadata + проверял subs + spawn'ил AI.

Сейчас single-paste **тоже** идёт через Library:
1. На `video` event → `db.upsertYoutubeChannel({channel_id, handle:
   uploader_id, display_name: channel, ...})` → `job.source_id`.
2. На `saved` event → `db.bulkUpsertItems([{source_id, external_id:
   video_id, type: 'video', title, transcript_path, ...}])`.
3. `db.recordJob` использует `job.source_id` в close-handler.

Single + batch теперь пишут в **тот же** items table — re-paste того же
видео мгновенно поднимает items-branch cache из `Cache lookup` ниже,
не дёргая yt-dlp. Канал виден в sidebar со счётчиком 1; повторный
batch-fetch этого канала добавляет остальные видео UPSERT'ом, existing
single-paste row остаётся.

> **Что не сломали.** Старые `yt_transcribe` rows с `source_id IS NULL`
> остаются в DB; `listJobs` теперь queries `WHERE type = 'yt_transcribe'`
> без `source_id IS NULL` filter — оба варианта попадают в Activity →
> Recent. То же для `yt_comments`. Если когда-то появится миграция —
> backfill source_id из parameters_json.channel_id, но пока не нужно.

> **Что отбросили.** Hidden source с флагом `single_paste = true`. Скрытое
> состояние, которое потом не вспомнить. Если юзер не хочет канал в
> Library — удалит одним кликом из sidebar; если хочет — увидит свой
> single-paste videos накапливающимися в этом канале и однажды нажмёт
> «Спарсить остальные» через batch-fetch.

**`is_explicit=0` для single-paste каналов.** `startYoutubeSingle` не ставит
флаг (см. `fact-database.md::sources.is_explicit`). Это значит single-paste
канал попадает в свёрнутый блок `▸ Прочее (N)` в LibrarySidebar — независимо
от того, пришёл ли paste из самого sc-desktop (paste-form `https://www.youtube.com/watch?v=…`)
или из browser-extension'а через bridge `/yt-add` (см.
`fact-yt-extension-bridge.md::Cache-first`). Когда юзер потом фетчит этот
канал целиком через `+ Add channel`, `is_explicit` через `MAX(...)` поднимается
в 1, и канал «всплывает» из Прочего наверх к остальным явным.

### Cache lookup

Перед Stage 1 — `db.findYoutubeTranscriptForVideo(videoId)` ищет в **двух источниках**:
1. `items.transcript_path` JOIN `sources WHERE platform='youtube'` — видео уже сохранено как часть какого-то канала (channel-batch успел его транскрибировать).
2. Sourceless `yt_transcribe` jobs (parameters_json LIKE `%"video_id":"<id>"%"`) — single-paste того же видео ранее.

Items wins при коллизии: file тот же (`transcripts/youtube/<videoId>__*.txt`, batch и single делят пул), но items branch даёт `source_handle` — UI может сказать **из какого канала** взяли результат, а не безымянное «из кэша». Substring-match по jobs остаётся безопасным: `video_id` всегда 11 символов из `[A-Za-z0-9_-]`, JSON-special characters не встречаются.

Если найден hit + файл существует — auto-copy, никакого spawn'а. CacheHitPanel рендерит две формы:
- **items-origin** (`from_items: true`): «Из канала samiysvejiyvshkole · субтитры». Без `finished_at` — items table его не хранит, и юзеру важнее **где** видео живёт, чем **когда** транскрибировалось.
- **jobs-origin**: «Из кэша 18 марта · AI · gemini». Классическая single-paste cache.

> **Что отбросили.** «Чистый» lookup только по jobs (как было). Симптом: юзер фетчит канал «@samiysvejiyvshkole», получает 30 видео с транскриптами. Через неделю пастит youtube.com/watch?v=H2MDyZ5h4d8 (одно из тех же видео) — Stage 1 не находит cache (ищет только sourceless jobs), запускает yt-dlp + subs check + AI заново. Платит за то что уже было на диске. Items branch исправляет это.

Bulk-вариант для search-picker — `findYoutubeTranscriptsByVideoIds(ids[])` — Map<external_id, hit>. См. ниже про search-mode UX.

### Search-picker: ✓ для уже-сохранённых из других каналов

YouTubeBatchPicker в search-mode вызывает `ytItemsStateGlobal({video_ids})` после поступления списка от yt-dlp и мерджит `transcript_path` / `cache_origin` / `cache_source_handle` в локальный `videos[]`. Результат — emerald ✓ на строке с tooltip «Уже есть в канале X — повторно не запрашиваем».

> **StrictMode race.** Lookup-effect спервоначала использовал `let alive = true` + `if (!alive) return` после await — каноничный паттерн. Не сработало из-за StrictMode + dedup-Set: cleanup первого mount флипает `alive=false`, второй mount банится через `lookedUpIdsRef.has(id)` → setVideos никогда не вызывается, ✓ не появляются. См. `fix-react-strictmode-alive-flag.md`.

---

## 📺 Batch transcribe (`yt_batch_transcribe`)

Принимает `--videos vid1,vid2,...` + `--auto-ai` + `--engine`. Per-video flow внутри: subs first → если есть, save; если нет и `auto_ai` ON, AI-transcribe; если OFF — emit `skipped`.

### Pre-filter cached перед spawn'ом

`startYoutubeBatchTranscribe` в Electron-стороне вычитает `findYoutubeTranscriptsByVideoIds(params.video_ids)` ДО spawn'а Python и делит список на:
- `cachedIds[]` — уже есть на диске (любой канал + sourceless jobs). Файл подтверждаем `fs.existsSync` (stale rows бывают если transcript удалили вручную).
- `runIds[]` — реально новые, спавнятся Python'у через `--videos`.

В `params.video_ids` остаётся **исходный** селект (audit + JobDetail рендер всех выбранных). Cached видео seed'ятся в `yt_batch.log[]` как `{kind: 'cache', video_id, file_path}` сразу при старте — picker / JobDetail показывают их как «✓ из кэша» с первого рендера, не дожидаясь Python.

> **Что отбросили.** Передавать `cachedIds` в Python и пусть он skip'ает. Стоит лишний metadata-fetch на каждое cached видео (yt-dlp `--print` запрос для имени файла) — на batch из 50 видео это +50 сетевых запросов ради ничего. Pre-filter в JS дёшевле и проще.

### All-cached short-circuit (`_synthesiseAllCachedBatchJob`)

Если `runIds.length === 0` — Python вообще не спавнится. Создаётся синтетический job со `status='done'`, `items_done = items_total = video_ids.length`, log seed'нутый всем cached, `started_at === finished_at`. Записывается DB row через `db.recordJob` чтобы Activity и search-batch persistence работали как обычно.

> **Зачем синтетический job, а не просто toast «всё уже есть».** JobDetail / picker должны показать тот же финальный layout что и регулярный run — для search-batch это критично, потому что `params.video_files` через close-handler собирает мапу для `ytAssembleBatchTranscript` (Copy all). Без job-row юзер не получит combined.txt.

UI-метка для cached строки в JobDetail — `log.kind === 'cache'` → «✓ из кэша» (emerald-300, чуть бледнее обычного «✓ субтитры» / «✓ AI»). См. `methodology/переносимый-дизайн.md::Cache origin transparency`.

### Toggle auto-AI вместо двух-стадийного pre-analysis

Альтернатива была: перед запуском batch гонять subs-check для всех выбранных, показывать «4 видео нужны AI ($0.05)», потом просить confirm. Отбросили потому что:
- Subs-check медленный (3-5 сек × N видео — на 50 видео это 4 минуты ожидания **до** оплаты)
- Юзер всё равно увидит cost в Activity по ходу

Вместо этого: тогл `Auto-транскрипция при отсутствии субтитров` (default ON). Цена — **upper-bound** (`до $X через Gemini`) считается по длительности невыбранных-уже-транскрибированных. Реальная стоимость всегда ≤ показанной (subs free, AI только где нужно).

### События: per-video агрегация

Каждое видео в batch'е эмитит отдельные events с `i` (1-based индекс) и `video_id`:
```
item_start → subs_racing → subs_found | subs_missing
                              ↓
                          (если auto_ai)
                              ↓
                    transcribe_start → transcribe_done → saved
                              ↓
                          (или) skipped | item_error
```

В job-runner-snapshot копится `yt_batch.log[]` с `{video_id, kind, file_path | message}`. **Per-video НЕ emit'ится в renderer на каждый event** — `emit(job)` только на саммари-границах (saved / skipped / error). Иначе на 50 видео получим 250+ React re-renders.

После рестарта app `b.log` теряется (in-memory only), но детали восстанавливаются через `items.transcript_path` — `markItemTranscribed()` пишет туда после каждого `saved` event'а. Поэтому JobDetail и история парсинга работают даже для давно завершённых batch'ей.

---

## 🧩 Унифицированный picker как переиспользуемый компонент

`src/components/YouTubeBatchPicker.jsx` — single source of truth для выбора видео. Используется в **двух местах**:

1. **Inline в `YouTubeChannelForm`** под шапкой канала (paste-screen flow)
2. **Inline в `SourceDetail`** под action-кнопками (Library flow)

Обе точки вызывают один и тот же компонент с одинаковым sourceId. Это даёт визуальную унификацию: юзер не учит два разных UI для «выбрать видео».

**Антипаттерн которого избегаем:** копировать picker как `ChannelFormPickerPanel` и `SourceDetailPicker` потому что «контексты разные». Контексты разные — props разные, компонент один.

### Опции pre-loaded vs lazy

```js
<YouTubeBatchPicker sourceId={id} />              // lazy: тянет items из БД сам
<YouTubeBatchPicker sourceId={id} videos={arr} /> // pre-loaded: skip query
```

Channel form передаёт уже загруженные videos (они только что пришли из fetch'а). SourceDetail не передаёт — picker сам читает из items.

### Performance: не дёргать IPC на каждый клик

`transcribed` set вычисляется через `useMemo` от `videos[].transcript_path` — не отдельный `fetchYoutubeItemsState` IPC. Раньше был эффект с deps `[selectionIds.join(',')]` который дёргал IPC на **каждое** изменение selection — экран дёргался при кликах на чекбоксах.

**Правило:** если данные уже есть в загруженном массиве — derive через useMemo, не запрашивай заново.

`VideoRow` обёрнут в `React.memo`, `chips` индексирован в `chipsSet` для O(1) lookup. На 200 видео — клик одной строки рендерит только её.

---

## 🪜 Kickoff stage в YouTubeChannelForm

Paste-flow для YT канала имеет **четыре стадии**: `idle` → (cache lookup) →
`kickoff` | `ready`. Раньше при пасте незнакомого канала форма автоматически
звала `startYoutubeChannelFetch({limit: 200})` — без согласия юзера, без
возможности уточнить параметры. На крупном канале (10к+ видео) это тянет
200 видео за один запрос ~30-60 сек, расход ресурсов, никакой возможности
взять «топ-50» или «старые видео сначала».

Сейчас на `kickoff` рендерится `<YouTubeScopeFields>` (limit + direction
toggle) + кнопка `Спарсить`. Юзер задаёт что хочет до сетевого вызова.
Если канал уже в кэше (`cached.items_count > 0`) — стадия `ready` сразу,
показывается ChannelHeader + picker, kickoff пропускается.

**Что отбросили:** дефолтить limit=200 «как раньше» с возможностью отменить
после fetch'а. Не работает: на крупном канале yt-dlp потратит 30+ сек до
того как первый item начнёт стримиться, а юзер не понимает идёт ли что-то
вообще. Лучше один лишний клик «Спарсить» с явным выбором, чем сюрприз с
длительным ожиданием.

См. `fact-source-actions.md::Per-platform формы` про общий паттерн scope-fields.

## 🧬 YouTubeScopeFields — почему отдельный компонент, не TG-shared

Не переиспользуем `<TelegramScopeFields>` для YT, хотя визуально похоже.

**Backend-разница:** `yt_channel_ndjson.py` принимает только `--limit` и
`--reverse` (oldest-first). Date-фильтры (`from_date`, `date_range`,
`last_week`-presets) — **невозможны** без правки Python. yt-dlp
`--playlist-end N` режет по count, не по timestamp. Добавить date-window
значит post-filter в Python поверх уже скачанного списка — та же сетевая
нагрузка, только меньший результат на клиенте; не имеет смысла как UX.

**Domain-разница:** TG имеет типы контента (text/voice/video/photo/docs),
темы (форумы), движок транскрипции, comments-toggle. Для YT канала всего
этого нет — есть только список видео с timestamp'ом. Натянуть TG-fields на
YT означает либо рендерить их пустыми (визуальный шум), либо ветвить
`use="youtube"` со скрытием 80% полей (хрупко, любой новый prop ломается).

**Решение:** короткий собственный `<YouTubeScopeFields>` (~80 строк) —
`limit` input + DirectionToggle + slot для children. Та же визуальная
грамматика как у TG (`RowLabel`, h-9, font-sizes), но без таскания
лишних props/conditional logic.

**Что отбросили:** добавить `--from-date` в `yt_channel_ndjson.py` и
объединить под TelegramScopeFields. Цена — Python-сторона, тестирование,
ничего не выигрывает в UX (всё равно тянем N видео и режем). Если
понадобится — отдельная задача.

---

## ⚙ Smart action button

Если **все** выбранные видео уже имеют `transcript_path`, primary-кнопка превращается из «Транскрибировать (N)» в «📋 Скопировать (N)». Click → `ytAssembleBatch({source_id, video_ids, action:'copy'})` собирает combined .txt и кладёт в clipboard.

Toast результата (`Copied · 3 видео · 83.2 KB`) подменяет содержимое **той же** кнопки (фиксированная `min-w-[210px]`) на 2.5 секунды, не сдвигая layout. См. `methodology/переносимый-дизайн.md::Toast в кнопке`.

---

## 🪤 Video URL → resolve channel chip

Когда юзер пастит `youtube.com/watch?v=...`, в Detection-row показываются **два** kind-chip'а: `[видео]` (default Enter) и `[канал]`. Клик `[канал]` → `canonicalize()` в Python резолвит channel_url через `yt-dlp --dump-json --no-playlist` (один extra-запрос ~1 сек), дальше — обычный channel-fetch.

**Зачем:** «вот видео которое мне понравилось — спарси весь канал». Альтернатива (заставлять юзера копать handle руками) — лишний шаг.

---

## 📂 Где живут файлы

```
~/Library/Application Support/sc-desktop/
├── transcripts/youtube/<videoId>__<slug>.txt    # один файл на видео, разделяется между single/batch
└── jobs/<date>_yt_batch_<jobN>_combined.txt      # combined export, по запросу Save combined
```

Single и batch пишут в **одну** папку `transcripts/youtube/` — один и тот же helper `write_text_file()` в `yt_single_ndjson.py` (импортируется в batch). Имя файла одинаковое для одного видео, повторный запуск перезаписывает (не страшно — содержимое детерминировано).

**Зачем не сегрегировать**: чтобы cache-lookup в Stage 1 single video находил файл, который мог быть создан через batch. Один пул — одна точка истины.

---

## 🚪 Не-источник: `yt_channel_fetch` не пишется в jobs

В `job-runner.js::startYoutubeChannelFetch` на close мы **не вызываем** `db.recordJob` для channel-fetch. Это намеренно — список видео это «обновить данные», а не операция требующая истории. Symptom если бы писали: история канала пухла бы записями «Список видео · N=200 · 6 видео» каждые 5 минут когда юзер жмёт Sync new.

`source_coverage` запись (`depth=metadata`) пишется — это нужно для UI «вот сколько у меня известно».

`main.js::sources:detail` дополнительно фильтрует `j.type !== 'yt_channel_fetch'` чтобы старые записи в БД из dev-сессий тоже скрылись (без миграции).

В истории канала остаются только `yt_batch_transcribe` (вычисления, цена, время) и tg_fetch (для Telegram-каналов).
