# Knowledge: YouTube search — sourceless batch flow

Юзер пастит `https://www.youtube.com/results?search_query=...` или просто строку поиска,
получает список из N видео (по умолчанию 30) с фильтрами/сортировками, выбирает несколько,
запускает batch-транскрипцию. Результат живёт в Activity history, **не** создаёт source
в Library.

Это ad-hoc операция «нашёл по теме → собрал транскрипты → ушёл», не подписка на канал.
По mental model — ephemeral paste-flow как local-file и Telegram single-message
(см. `fact-source-actions.md::Mental model`).

## 🔍 Что принимает yt-dlp

Скрипт `python-workers/web/yt_search_ndjson.py` имеет **два режима** в зависимости от формы
ввода:

| Вход | yt-dlp получает | Что юзер контролирует |
|---|---|---|
| Plain query (`gpt 5.5 opus`) | `ytsearch{N}:gpt 5.5 opus` | Только текст, ranking = relevance |
| URL (`...?search_query=...&sp=...`) | URL **as-is** + `--playlist-end N` | YouTube-фильтры через `&sp=` (sort by upload date, period, type=video, captions=on…) |

URL-форма позволяет юзеру **скопировать ссылку с настроенными фильтрами прямо
из youtube.com** — yt-dlp сам пропустит `&sp=` к их extractor'у. Это покрывает 95%
юзкейсов «хочу видео за неделю по этому запросу, sort by views».

> **Что отбросили.** `ytsearchdate20:` (sort by date префикс) — `Unsupported url scheme`
> в нашей версии yt-dlp ([open issue #6335](https://github.com/yt-dlp/yt-dlp/issues/6335)).
> Не использовать — fallback'ом всегда работает либо `ytsearch:` либо URL+`sp=`.

## 🔓 Что внутри `&sp=` и почему важно показать

`&sp=` — base64-кодированный protobuf-blob от UI YouTube'а. Один токен может описывать **несколько** одновременных фильтров (sort + uploadDate + type + features). Из коробки юзеру показывалось «фильтры URL · убрать» без расшифровки — он не понимал что именно фильтрует и почему `+30` ничего не добавляет.

Мы декодируем токен на клиенте (`decodeYtSp` в `YouTubeSearchForm.jsx`) и показываем компоненты в SearchHeader: «сорт. по просм. · за неделю · видео · 4K». Декодер охватывает 95% реальных URL'ов с youtube.com:

| Кусок sp | Что значит | Откуда |
|---|---|---|
| `0x08 0xNN` (header) | sort: 1=rating, 2=date, 3=views, иначе relevance | base64 prefix `CAI=`, `CAM=`, `CAE=` |
| `0x12 0x02 0x08 0xNN` | uploadDate: 1=hour, 2=today, 3=week, 4=month, 5=year | inside-payload group |
| `0x12 0x02 0x10 0xNN` | type: 1=video, 2=channel, 3=playlist, 4=movie | |
| `0x12 0x02 0x18 0xNN` | duration bucket: 1=<4мин, 2=>20мин, 3=4-20мин | |
| `0x12 0x02 <feat> 0x01` | features: HD/CC/4K/live/3D/360 (по `feat`-byte) | |

Декодер best-effort — неизвестное хранится как raw token, но пользователь видит его рядом с расшифрованным («тип A · 0x52 0x01»). Этого достаточно чтобы юзер сделал выбор: оставить URL-фильтры или убрать («× убрать и переискать»).

> **Источник карты:** [ktsk.xyz: Decoding YouTube filters](https://ktsk.xyz/docs/programming/decoding-youtube-filters/) и [serpapi YouTube sp filters](https://serpapi.com/blog/youtube-sp-filters-paginating-sorting-and-filtering-with-the-youtube-api/). Полная спецификация YouTube не публикует — все open-source декодеры best-effort.

### Lock client-controls когда URL уже задаёт ось

Если декодер увидел `sort` — sort-chips в picker'е disabled с пометкой «· из URL». Аналогично `uploadDate` блокирует date-row, `duration` блокирует «Макс. длит.». Без этого юзер крутит «релевантность → дата ↓» в picker'е, но реально yt-dlp всё равно отдаёт sort-by-views (потому что `sp=CAM` в URL) — невидимый конфликт.

После `× убрать` форма re-fetch'ится без `sp=` и **те же самые** controls становятся активными. Это тот самый механизм почему «после убирания URL filter изменение дат не работает» — пока не убрал, поле выглядит активным но `pointer-events:none`. Сейчас в этом UX явно: chip серый+strikethrough = «убрано», `↻ вернуть` доступно для отката.

> **Что пробовали и почему не сработало.** Authoritative client-rewrite: при выборе sort в picker'е убирать `sp=` из URL и пере-fetch'ить. Хрупко — у юзера могут быть фильтры (например, captions=on) которые мы не контролируем. Lock + явный «убрать» простой и предсказуемый.

## 📅 Approximate dates

`--extractor-args 'youtubetab:approximate_date'` обязателен — без него `timestamp`/`upload_date`
у поисковых результатов = `NA`. yt-dlp парсит человекочитаемое «N months ago» в
`today − N×30`, поэтому day-of-month всегда сегодняшний для всех видео старше месяца —
**это враньё**, но для сортировки по дате достаточно.

В UI показываем **полную дату** (`29 апр 2026`) только в строках picker'а; для
SearchHeader / SourceDetail карточек прежнего формата (`апр 26`) — короткая. Это
sуществовало и для channel-flow (`fmtDate` vs `fmtDateFull` в `YouTubeBatchPicker.jsx`).

## 🪜 Pagination и dedup

yt-dlp ranked-search **не идемпотентен** между запросами с разным `N`:
- `ytsearch20:` отдаёт top 20
- `ytsearch40:` отдаёт top 40, но порядок первых 20 может **отличаться** от предыдущего
  запроса (YouTube пересчитывает ranking)

Поэтому "+ Показать ещё 30" не делает offset=30, а **рефетчит N+30** целиком и
дедуплицирует по `video_id`. Стоимость: один лишний yt-dlp call на 1.4-2.5 секунды,
зато список не дёргается и юзер видит знакомые верхние результаты на месте.

`yt_search_ndjson.py --offset N` оставлен как fallback (если когда-то YouTube
стабилизирует ranking), но фронт не использует.

## 🎚 Client-side filter/sort вместо повторных запросов

YT-фильтры через `sp=` достаточны для **sliced** запроса, но юзер часто хочет «крутить»
уже полученные 30 результатов:
- sort: relevance (yt-default) / date / views
- date range (любое направление — bidirectional swap внутри фильтра)
- min views (input в тысячах: `[1] K` → `>= 1000`, default 1)
- max duration (input в минутах, default 60) — режет длинные стримы из выдачи «найди подкасты по теме»
- title-search (substring)

Всё это **client-side**, поверх уже загруженного списка. Перезапрос к yt-dlp не
нужен — instant re-sort. Если юзеру не хватает — увеличивает `limit` через input
в select-all-bar (пере-fetch с новым N).

> **Что отбросили.** Auto-fetch loop «грузить до тех пор пока filtered.length достигнет
> limit». Стоит много yt-dlp вызовов и может зациклиться (нет видео достаточной
> популярности на этот query). Вместо — юзер сам видит «выбрано 0 из 17 · загружено 30 · запросить [N]» и
> увеличивает N если хочет больше.

### Counter-семантика «X из Y · загружено M · запросить N»

Три разных числа, юзер должен понимать какое что:
- **Y = `filtered.length`** — реально видимые строки после всех client-фильтров. То что юзер может выбрать прямо сейчас.
- **M = `videos.length`** — что вернул yt-dlp на последний запрос. Если фильтры режут половину — `M > Y`. Показываем только когда `M ≠ Y` (иначе шум).
- **N = `currentLimit`** — что **попросим** в следующий refetch. Editable input. После ceiling-detection (см. ниже) auto-snaps на `M`.

> **Шрам:** изначально показывали «выбрано 0 из 72» где 72 = `currentLimit` (то что **запросили**, не то что **есть**). Юзер видел 72, в списке 10 → недоверие к UI. Перешли на `filtered.length` со вспомогательной строкой про загруженное.

## 🪟 Ceiling: yt-dlp вернул меньше N чем просили

`&sp=` с upload-date filter («за неделю», «за сегодня») может ограничить выдачу YouTube'а до 10-40 видео независимо от того, сколько запросишь. yt-dlp честно отдаёт всё что есть, но дальше «+30» дёргает тот же список.

**Симптом до фикса:** юзер пастит URL с `sp=CAMSBAgCEAE` (+ за неделю), просит 30 — получает 10. Жмёт «+30», ждёт 2 секунды, получает те же 10. Даты в форме меняет — список не растёт. Кажется что приложение сломано.

**Лечение** — детектим в `applyLimit` если `merged.length < newLimit`, помечаем `reachedCeiling = true`. Эффект:
- Limit-input snaps к фактическому числу (`M`), повторное «120 → blur» автоматически становится «41».
- «+ Показать ещё 30» исчезает, на её месте — нотис «YouTube отдал всё что есть для этого запроса — 41 видео. Расширьте диапазон в самом YouTube или попробуйте убрать фильтры URL ↑».
- Date-фильтр в picker'е остаётся активным, но он **client-side** над загруженными 41 — не делает refetch с другим окном.

> **Когда не ceiling.** Юзер запросил больше чем YouTube вообще выдаст по запросу (sparse query). Тоже технически ceiling, но обычно недостижимо в типовом флоу — yt-dlp отдаёт сотни-тысячи на популярные темы.

См. `methodology/переносимый-дизайн.md::Ceiling vs filter` — переносимый принцип «пользователь должен понимать **что именно** ограничивает выдачу: платформа или мой клиентский фильтр».

## 💾 Persistence: search-batch как special case

`yt_batch_transcribe` обычно записывает в DB только базу: type, source_id, params,
status. Per-video transcripts восстанавливаются из `items.transcript_path` через
`source_id`. Но search-batch **не имеет source_id** — items table пуста для этих
видео. Поэтому в `params` персистятся два дополнительных поля:

```js
{
  is_search:     true,
  search_query:  '<original input — URL or plain text>',
  search_videos: [{ video_id, title, duration_sec, view_count, timestamp, uploader, url }, ...],
  video_files:   { '<video_id>': '<file_path>', ... }   // set on close
}
```

`search_videos` — snapshot выбранных видео **на момент запуска batch'а**, нужен для
JobDetail (рендер списка с заголовками/датами/просмотрами после рестарта). `video_files`
заполняется в close-handler из `b.log` — точная мапа vid→file, нужна для:
- `yt:assembleBatchTranscript` (Copy all / Save combined) — без items table нечего
  было бы агрегировать
- `yt:resumeBatch` — фильтрация уже сохранённых видео при ресюме interrupted batch
  (см. `fact-jobs.md::Resume interrupted batch`)

Без этого после рестарта Electron JobDetail для search-batch видел бы пустоту:
items table не содержит транскрипты, в-памяти `b.log` уже сброшен.

**Activity panel после рестарта.** Search-batch'и `source_id=NULL` дополнительно подгружаются в `listJobs()` через `db.listSourcelessJobs({type: 'yt_batch_transcribe'})` → `rowToHistoricSnapshot`. Без этого открыть batch можно было только через прямую ссылку на JobDetail — в правой Activity-панели sourceless-batch'и не появлялись (там был фан-аут только через Library/SourceDetail, а у search-batch нет источника). Channel-batches не дублируются — у них есть source_id и они уже доступны через source-fan-out. См. `fact-jobs.md::db-N IDs` про то как restored snapshots отделяются от live.

## 🎨 JobDetail как финальный read-only вид

После завершения batch'а JobDetail показывает **тот же layout** что был в picker'е
до запуска — дата · название · uploader · ✓ · длительность · просмотры — но **без
чекбоксов**. Это и есть «финализированный picker». Юзеру удобно: он видит привычный
список, но взаимодействие сужено до per-video `open` (откроет .txt в Sublime).

Distinguishing flag — `job.params?.is_search`. Без него body рендерит «обычный»
batch-вид (с simpler табличкой через items+log).

## 🪟 Wider container

YouTubeSearchForm раскрывается в **`max-w-4xl`** контейнере (overrides paste-screen
default `max-w-2xl`). Колонки picker'а не помещаются в 2xl-контейнер: дата + длинный
title + uploader + ✓ + длительность + просмотры. PasteScreen условно ставит
`isWide = activePlatform === 'youtube' && activeKind === 'search'`.

Channel-flow (`YouTubeChannelForm`) тоже использует `YouTubeBatchPicker`, но без
`showSearchControls` prop'а — он рендерится в стандартной 2xl-ширине. У channel-mode
видео из items table, дат меньше, фильтры не нужны → меньше колонок → 2xl ОК.

## 🗂 Files

- `python-workers/web/yt_search_ndjson.py` — wrapper над yt-dlp
- `electron/job-runner.js::runYoutubeSearch` — async one-shot (через `runOneShotNdjson`)
- `electron/job-runner.js::startYoutubeBatchTranscribe` — close-handler пишет
  `params.video_files` если `is_search`
- `electron/main.js::yt:searchFetch` — IPC. `yt:assembleBatchTranscript` расширен
  путём чтения файлов из `params.video_files` если sourceless
- `src/components/YouTubeSearchForm.jsx` — header + auto-fetch + paginate + applyLimit
- `src/components/YouTubeBatchPicker.jsx` — `showSearchControls` prop активирует
  sort/filter row, шире layout, sourceless mode (`!sourceId`)
- `src/components/DatePicker.jsx` — кастомный popover для диапазона. См.
  `fix-popover-outside-click.md` про race с outside-click
- `src/screens/JobDetail.jsx::YoutubeBatchBody` — branch на `isSearch`

## 🔗 Связанные

- `fact-source-actions.md::Mental model paste-flow` — общая концепция ephemeral
  paste-flow без SourceDetail
- `fact-jobs.md::Snapshot vs live job` — `params.search_videos` / `video_files`
  в snapshot
- `fact-jobs.md::Resume interrupted batch` — search-batch может быть прерван и
  ресюмлен через те же `video_files`
- `fix-popover-outside-click.md` — race в DatePicker
