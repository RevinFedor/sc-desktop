# Knowledge: TikTok Stack

Всё что касается TikTok как платформы в SC Desktop. Канал — это `source` в Library (`platform='tiktok'`). Видео — `item` внутри. Разовое видео без канала — `tk_transcribe` job без source_id.

Контракт events и схема UI намеренно зеркалят YouTube (`fact-youtube.md`) — `job-runner.js` использует те же snapshot-поля и тот же batch-picker pattern. Различия описаны ниже и являются единственным, что AI не может вывести из чтения кода.

---

## 🧭 Три скрипта, три цели

| Скрипт | Что делает | Тип job |
|---|---|---|
| `cli-tools/web/tk_single_ndjson.py`     | URL → AI-транскрипт | `tk_transcribe` (sourceless) |
| `cli-tools/web/tk_channel_ndjson.py`    | URL канала → список видео (yt-dlp flat-playlist) | `tk_channel_fetch` (с source_id) |
| `cli-tools/web/tk_batch_transcribe_ndjson.py` | N video_ids → batch транскрипция | `tk_batch_transcribe` (с source_id) |

Скрипты лежат в `web/` рядом с YouTube — категориально это та же «web» платформа, оба тащат через yt-dlp + Gemini.

---

## 🎬 Single video НЕ имеет `awaiting_ai`

YouTube single-flow гонит race subs vs AI (см. `fact-jobs.md::awaiting_ai`): если субтитры найдены — done; если нет — переход в `awaiting_ai`, ждём подтверждения юзера на оплату AI. **TikTok этой стадии не имеет** — у платформы нет субтитров вообще. Single всегда сразу скачивает аудио + Gemini, в одном spawn'е.

**Почему важно явно:** соблазн скопировать `startYoutubeSingle` + `attachYoutubeStreams` целиком оставит «мёртвый» `awaiting_ai`-handler, который никогда не сработает, и UI будет рендерить лишнюю стадию для confirmation. Не копировать.

---

## 🌐 Backend для листинга канала: yt-dlp, не Apify

Канал тянется через `yt-dlp --flat-playlist --dump-single-json` — **бесплатно**, ~30 видео/секунда. Apify-актор `clockworks/free-tiktok-scraper` ($0.005/видео) **не используется** для листинга в проде.

**Что отбросили:**
- Apify дороже на 2 порядка ($0.50 за 100 видео vs $0).
- Свой POST на `tikwm.com/api/user/posts` — закрытый endpoint, отдаёт 403 даже с UA/Referer заголовками.

**Чем платим за yt-dlp:**
- Warning «extractor is attempting impersonation» — пока работает, но TikTok может в любой момент потребовать `curl_cffi`. Если перестанет — fallback на Apify (актор уже изучен в `cli-tools/docs/knowledge/fact-apify.md`).
- `--dateafter` и `--playlist-end` фильтрация работает по факту скачки, не сужает API-запрос — на больших каналах full re-fetch каждый Sync new неизбежен.

**Что от Apify взяли:** только мысль «оставить как fallback», кода в `tk_*_ndjson.py` нет.

---

## ⏳ TikWM `play` URL экспирирует за 5-15 минут

Single и batch берут прямой MP4 URL через TikWM (`tikwm.com/api/?url=...`). Этот endpoint открытый, без ключей, ~0.2 сек на запрос. Возвращаемый `data.play` — подписанный CDN URL `tiktokcdn-us.com`, действителен **5-15 минут**.

**Что это диктует архитектуре:**
- В `tk_batch_transcribe_ndjson.py::process_one` TikWM-запрос делается **внутри цикла на каждое видео**, не batch'ом заранее. На batch'е из 50 видео pipeline может идти 30+ минут — URL'ы пачкой протухнут до того, как очередь до них дойдёт.
- В БД сохраняется **только** `webVideoUrl` (стабильная human-readable ссылка), не `play`. При повторе всегда дёргаем TikWM свежий.

**Соблазн «оптимизировать»:** собрать все play-URL'ы одним проходом и потом качать. Не делать — экспирация съест поздние видео в очереди.

---

## 📅 Даты точные, не «approximate»

YouTube tab возвращает `timestamp: null` или фейковую дату через `youtubetab:approximate_date` — день получается = (today − N×30), поэтому YT-UI рендерит **только месяц + год** (`fact-youtube.md::Approximate dates trade-off`).

TikTok через yt-dlp возвращает **настоящий Unix timestamp** (`entry.timestamp` или `release_timestamp`). Поэтому `TikTokBatchPicker.fmtDate` показывает полную дату (`26 апр 26`), `ChatView` для TikTok — `dateStyle:'short' + timeStyle:'short'` как Telegram.

**Зачем явно:** копирование YT-фразы «approximate» в TikTok-комментарии будет ложью — день настоящий, можно сортировать по дню без оговорок.

---

## 🪪 Канон URL и каноникализация

`canonicalize()` в `tk_channel_ndjson.py` принимает:
- `@handle` / `handle` (bare) → `https://www.tiktok.com/@handle`
- `https://www.tiktok.com/@handle/...` → срезает trailing path → профиль
- `https://www.tiktok.com/@handle/video/123...` → извлекает handle из path → профиль
- `https://vt.tiktok.com/XXXX/` или `vm.tiktok.com/XXXX/` → HEAD-редирект через `urllib`, после редиректа повторная нормализация. Short-URL не пропускаются «как есть» в yt-dlp, потому что он на них даёт inconsistent metadata — yt-dlp не resolve'ит short canonical channel.

`detect.js::tk()` в renderer повторяет этот же routing, чтобы PasteScreen знал заранее: `vt.*` и `/video/` URL'ы — это `kind: 'video'`, profile URL — `kind: 'channel'`.

---

## 🆔 channel_id = numeric uploader_id

YouTube использует `UC{22}` channel_id как стабильный ключ (handle может смениться при ребренде, см. `fact-youtube.md::UPSERT по external_id`). TikTok аналог — `uploader_id` от yt-dlp, **числовой**: `6773990553749390341`.

`db._upsertWebChannel('tiktok', { channel_id, handle, ... })` — общая функция для youtube/tiktok, ищет существующий source сначала по `(platform, external_id)`, fallback по `(platform, handle)`. Тот же anti-rebrand contract, что и YouTube.

---

## 💰 Стоимость batch'а

```
batch upper-bound = sum(video.duration_sec) / 3600 × $0.0125    (Gemini 16kHz mono)
```

Та же формула, что и YouTube AI-path. Toggle «Авто-AI при отсутствии субтитров» **отсутствует** в `TikTokBatchPicker` — он бессмыслен (всегда AI), вместо него фикс: «до $X через Gemini/AssemblyAI».

---

## 📂 Где живут файлы

```
~/Library/Application Support/sc-desktop/
└── transcripts/tiktok/<videoId>__<slug>.txt
```

Параллельно `transcripts/youtube/` и `transcripts/instagram/`. Helper `write_text_file()` — копия YT-варианта внутри `tk_single_ndjson.py` (импортируется в batch).

---

## 🚪 `tk_channel_fetch` тоже не пишется в jobs

Та же логика, что и `yt_channel_fetch` — listing — это «обновить данные», не операция для истории. `main.js::sources:detail` фильтрует `j.type !== 'tk_channel_fetch'`, иначе при каждом Sync new в SourceDetail история бы пухла записью «Список видео · N=200».

В истории канала остаются только `tk_batch_transcribe` (вычисления, цена, время).
