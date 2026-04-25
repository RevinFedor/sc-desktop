# Knowledge: YouTube Comments Stack

Комментарии под видео — отдельный продукт от транскрипта. У них собственный
лимит, формат файла, кэш-семантика и UI-маркер. См. `fact-youtube.md` для
транскриптов.

## 🎬 Где это в UI

Третий kind-чип `[комментарии]` в Detection-row при пасте `youtube.com/watch?v=…`
— рядом с `[видео]` (default Enter, транскрипт) и `[канал]` (резолвить
владельца канала). Клик мгновенно раскрывает форму без промежуточной свёрнутой
строки — у юзера уже есть явное намерение.

В picker'е канала рядом с ✓-маркером транскрипта живёт независимый 💬-маркер.
Клик на 💬 раскрывает inline-форму комментариев под строкой видео в compact-режиме
(без дублирования заголовка — оно уже в строке выше). Action-row picker'а имеет
кнопку `💬 Комментарии (N)` рядом с `Транскрибировать (N)` для batch-прохода.

> **Не «один зелёный ✓ для всего».** Транскрипт и комменты — два разных
> продукта. Если показать общий ✓ когда есть только транскрипт, юзер кликнет
> «получить» думая что комменты тоже готовы → лишний фетч и удивление. Один
> маркер на один продукт.

## ⚙ Скрипты и поток событий

`yt_comments_ndjson.py` оборачивает `yt-dlp --write-comments`. yt-dlp пишет
комменты в служебный `<id>.info.json`, мы парсим этот файл на close, рендерим
в плоский .txt, эмитим финальный `saved`. Прогресс по ходу — yt-dlp сам
печатает строки `[youtube] Downloading comment API JSON page X (Y/~Z)` в
stdout, мы регулярим и переэмитим как `fetch_progress {got, expected}`.

```
fetch_meta (1 yt-dlp call)         → emit video {title, channel, comment_count}
yt-dlp --write-comments (page-by-page)
   stdout: "page 5 (412/~1242)"    → emit fetch_progress {got: 412, expected: 1242}
   stdout: "Extracted 412 comments"→ emit fetch_progress {got: 412, expected: 412}
parse <id>.info.json
render_comments → .txt             → emit saved {file_path, count_total, count_top, count_replies}
                                   → emit done
```

`yt_batch_comments_ndjson.py` запускает `yt_comments_ndjson.py` как subprocess
последовательно для каждого video_id. Параллелизм отброшен — yt-dlp легко
тригерит anti-bot rate-limit от YouTube если бить параллельно. Per-video
события (item_start / fetch_progress / saved / item_error / skipped) → JobDetail
рендерит progress по тому же шаблону что batch-transcribe.

## 🔑 Cache key = (video_id, sort, limit, includeReplies)

Кэш-ключ — не video_id, а **полный tuple параметров запроса**. Разные значения
любого из четырёх → отдельный файл рядом, ничего не перетирается.

Имя файла кодирует параметры: `<videoId>__<slug>__comments_<sort>_<limit>[_withreplies].txt`.

```
H2MDyZ5h4d8__xxx__comments_new_500.txt          # sort=new, limit=500, no replies
H2MDyZ5h4d8__xxx__comments_top_500.txt          # сменили sort
H2MDyZ5h4d8__xxx__comments_new_500_withreplies.txt  # включили ответы
```

Form пересчитывает `findYoutubeCommentsForVideo({videoId, sort, limit, includeReplies})`
на каждое изменение тогглов в UI — это дешёвый SQL LIKE по `parameters_json`.
Если попадание — мгновенный done-card с auto-copy, без spawn'а Python. Если
тапли поменялась и для нового набора кэша нет — done-card сбрасывается, кнопка
возвращается в `Получить`.

> **Что отбросили.** «Один файл на видео, перезаписываем». Юзер сделал 200 top
> вечером, утром хочет 500 new — старый файл потерян. С param-exact кэшем оба
> остаются, юзер не теряет работу.

## 🎚 Defaults

| Параметр | Дефолт | Почему |
|---|---|---|
| `sort` | `new` (по новизне) | Соответствует ожиданию юзера; yt-dlp default `top` пришёл из CLI-эпохи |
| `limit` | 500 | ~20 сек на запрос, покрывает 95% кейсов «вижу настроение треда» без минутного ожидания |
| `includeReplies` | off | yt-dlp считает replies в общий лимит → на 200-запросе из 200 collected ~140 top + 60 replies (треть полезного объёма съедена). Default off = чистые верхнеуровневые до лимита |

Замер на репрезентативном видео:
- `max_comments=2000` без флага: 2000 collected, **907 reply** (45%) + 1093 top.
- `max_comments=200` с `max_replies=0`: 200 чистых top-level.

«С ответами» — явный чекбокс в форме, выбор юзера, не silent default.

> **Default selector layout.** `[500] [своё ___] [все]` — три контрола в одной
> группе. Дефолт-пилюля 500 активна, инпут «своё» серый-плейсхолдер.
> Ввод любого числа → пилюли гаснут, активный режим = свой. Пустой инпут на
> blur → snap к дефолту 500 (никакой «invisible 0» где юзер думает что 500,
> а реально firе с 0).

## 📄 Формат .txt — flat with one-level replies

YouTube отдаёт reply-tree максимум на один уровень (проверено эмпирически —
глубже не идёт). Поэтому формат **плоский с одним отступом** под `↳`,
без markdown-скобок и без вложенности. Цель — LLM-контекст, нейронка читает
это как естественный диалог.

```
@author_one · автор · закреп · 4.5M ❤
We're so honored that the first ever YouTube video was filmed here!
  ↳ @reply_one · 46k ❤
    How did I randomly go to this video and see this comment...
  ↳ @reply_two · 14k ❤
    very cool

@author_two · 312 ❤
Видео ещё не родилось, а уже легенда
```

- **Inline-теги** только когда реально есть: `автор` (uploader), `закреп` (pinned),
  лайки `4.5M ❤` (фрейм `1.5k`/`4.5M`).
- **Пустая строка между тредами** — естественная граница группы, нейронка
  читает как смену темы.
- **4-space indent у текста ответа** под `↳` маркером — визуальная иерархия
  без markdown.
- **Header файла** — самоописательный (title, channel, url, sort, limit, with_replies).
  Открыл `.txt` через месяц — понятно что это.

## 💬 Done-card показывает версию в буфере

В done-card обязательно показываем композицию (что именно положили в clipboard):
- Без replies: `«7 комментариев · только верхнеуровневые»`.
- С replies: `«7 комментариев · 6 тредов + 1 ответов»`.
- Из кэша: добавить `· Из кэша 2 ч назад`.

Без этого юзер фетчит без replies, забывает выключить чекбокс, фетчит
снова — и из кэша получит **старый** результат-без-replies, не понимая
почему ответов нет. Composition-tag в карточке убирает это сомнение —
**версию текста в буфере видно**.

> **Связано:** `methodology/переносимый-дизайн.md::Cache origin transparency` —
> расширенная таблица «что показать в done-card».

## 📦 Pre-filter cached перед batch spawn

`startYoutubeBatchComments` в Electron-стороне зеркалит batch-transcribe
паттерн (см. `fact-youtube.md::Pre-filter cached`):
1. `findYoutubeCommentsForVideo({videoId, sort, limit, includeReplies})` для
   каждого id из выбора. Param-exact: запрос `(top, 500)` не получит файл
   из `(new, 500)`.
2. Делим на `cachedFiles` (есть на диске) и `runIds` (надо фетчить).
3. Если `runIds.length === 0` → `_synthesiseAllCachedBatchCommentsJob` без
   spawn. Создаётся синтетический done-job с `b.log` пред-залит'ом
   `kind: 'cache'` для каждого видео, DB row пишется чтобы Activity
   и JobDetail работали как обычно.
4. Иначе spawn `yt_batch_comments_ndjson.py --videos runIds.join(',')` и
   pre-seed `b.log` cached-записями — JobDetail с первого рендера показывает
   их как `✓ кэш`.

## 🔁 Re-mount restoration через useJobs()

Юзер кликнул `Получить` → ушёл смотреть прогресс в Activity → вернулся в
форму. `YouTubeCommentsForm` на mount фильтрует `useJobs()` по
`(type='yt_comments', target=url, params.sort, params.limit, params.includeReplies)`
и берёт самый свежий — поднимает done-state без повторного фетча. Реализация —
тот же паттерн что в `LocalFileTranscribeForm` и `TelegramSingleMessageForm`,
см. `methodology/переносимый-дизайн.md::Re-mount restoration форм`.

## 🤝 Параллельный режим в YouTubeSingleForm

Помимо самостоятельной `YouTubeCommentsForm` (`[комментарии]` чип в paste-flow),
тоггл `+ комментарии` живёт прямо в `YouTubeSingleForm` и виден на **всех**
стадиях транскрипта (idle / searching / cache-hit / done / error). Дефолт off.

Включение тоггла → effect на `[includeComments, videoId]`:
- `lookupYoutubeCommentsCache({videoId, sort:'new', limit:500, replies:false})` —
  если попал, ставим `commentsCache=hit`, не спавним.
- Если miss → `startYoutubeComments(...)` параллельно с транскрипт-job'ом.

**Не последовательно, не lazy-on-click.** Транскрипт берёт 5–60 сек (subs vs AI),
комменты — 10–30 сек (зависит от их числа). Sequential добавил бы N+M времени;
parallel = max(N, M). User-facing импакт: к моменту когда транскрипт готов
комменты тоже готовы или почти. Copy-кнопка получает label-эскалацию:
- `📋 Скопировать ещё раз` — если комменты off или ещё не готовы (только транскрипт).
- `📋 Скопировать всё` — оба готовы; click → `jobs:copyCombined` IPC читает оба
  файла, склеивает blank-line разделителем, пишет в clipboard.

> **Никакого silent partial-copy.** Если бы лейбл всегда был «Скопировать всё»
> — половину раз юзер бы получал только транскрипт (комменты не успели), не
> понимая почему 50KB вместо ожидаемых 200KB. Лейбл = состояние, проверяемое
> visually. Кнопка disabled (busy) пока fetch активен.

> **Что отбросили.** Comments-button рядом с Transcript-button. Две Copy-кнопки
> = первая мысль «зачем их две, что выбрать?». Одна Copy + смена label при
> готовности обоих файлов = один primary action на одно намерение
> («забрать что есть»).

## 🪤 Effects gotcha: cache-effect не должен переписывать активный fetch

Form имеет два эффекта от тапли (`sort`, `limit`, `includeReplies`):
- Cache lookup → если попал, ставит `stage='done'` и `cache=hit`.
- Reset done-state → если не попал и предыдущее состояние `done`, сбрасываем
  на `idle` чтобы юзер не думал что старый результат относится к новому tuple.

Оба — внутри одного эффекта. Guard на старте: **если `stage === 'fetching'` —
return**. Без него можно попасть в:

1. Юзер жмёт Получить → `stage='fetching'`, kickOff увеличивает `cache=null`.
2. Cache effect re-fires (от какого-то bouncing'а зависимостей).
3. Cache lookup `Promise.then` приходит позже Python'а с `cache=null` →
   override done-state на idle → юзер видит «начни сначала» когда работа
   закончилась.

Guard `if (stage === 'fetching') return` после await решает — fetch выигрывает
гонку.

## 🗃 Где живут файлы

```
~/Library/Application Support/sc-desktop/transcripts/youtube_comments/
  H2MDyZ5h4d8__xxx__comments_new_500.txt
  H2MDyZ5h4d8__xxx__comments_top_500.txt
  H2MDyZ5h4d8__xxx__comments_new_500_withreplies.txt
```

Отдельная директория от `transcripts/youtube/` (там транскрипты). Один пул
shared между single-paste и batch — оба пишут одним кодом
(`yt_batch_comments_ndjson.py` форкает `yt_comments_ndjson.py` per video).

## 🚫 Не написано

- **Assemble/copy combined** для batch comments — нет (в отличие от
  batch-transcribe). 50 видео × 5 KB = 250 KB combined.txt — пока не было
  юзкейса. Если появится — добавить `yt:assembleCommentsBatch` IPC по тому
  же паттерну.
- **Comments в Library как items** — комменты не пишутся в `items` table.
  Они эфемерный артефакт; юзер открывает файл из Reveal in Finder или
  пере-копирует через `📋 Скопировать ещё раз`. Если попадётся юзкейс
  «дай мне все комменты со всего канала склеенным потоком» — придётся
  либо писать в items, либо в новую таблицу.

## 🔗 Связано

- `fact-youtube.md` — транскрипты, основной picker, batch-transcribe.
- `methodology/переносимый-дизайн.md::Cache origin transparency` — общий принцип
  «show what's in clipboard».
- `methodology/переносимый-дизайн.md::Cache key = пользовательский tuple` — почему
  cache-key должен включать все юзер-видимые параметры.
- `methodology/переносимый-дизайн.md::Re-mount restoration форм` — общий паттерн
  для form re-mount через useJobs().
