# Knowledge: IPC + ndjson Protocol

Между Electron main и Python CLI — **стрим ndjson по stdout**. Это сознательный выбор, не путь по умолчанию.

## 📜 Контракт ndjson
Каждый Python-скрипт, который запускается через `job-runner.js`, **обязан** на каждой стадии печатать одну JSON-строку в stdout, кончающуюся `\n`. Никакого pretty-print, ни перевод строк внутри объектов, ни stderr-mixing.

Типы событий (для Telegram-fetch):
```
{"type": "info",   "message": "..."}
{"type": "entity", "kind": "user|channel|chat|group", "title": "...", "username": "...", "id": ...}
{"type": "page",   "loaded": 100, "limit": 500}
{"type": "item",   "data": { ... }}
{"type": "error",  "message": "..."}
{"type": "done",   "items_total": N, "duration_sec": 4.2}
```

**Ordering invariant:** `entity` приходит первым, `done` — последним. `page` идёт **только** на границах 100 items (см. ниже про per-item batching). `item` может прийти 0…N раз. `error` может прийти посреди потока (тогда status job-а станет `error` на close, а не на этом event'е).

## ⏱ Per-item events: throttle, не silence

В `job-runner.js::handleEvent` на каждый `item` мы инкрементим counter в job
state и **`emit(job)` делается throttled — не чаще раз в 250 мс на job**.
Page-boundary (раз в 100 items, см. ndjson-протокол) **всегда** эмитит как
keep-alive, обновляя счётчик даже если последний throttled-emit был в этом же
окне. Сами items копятся в `job.items` массиве в памяти и flush'атся в JSON-файл
одним write на `child.on('close')`. См. `fact-jobs.md`.

**Почему throttle, а не emit-on-every-item.** На 5000+ сообщений
per-item emit = 5000 IPC frames + 5000 React re-renders. Прогресс-бар
дёргается, drag-drop в sidebar лагает, DevTools тонет в `job:update`-логах.

**Почему throttle, а не emit-only-on-page.** Старое правило (только page)
давало другую крайность: между двумя page-boundaries (10-20 секунд на медленном
чате) Activity замораживался на одном числе, юзер думал что job повис. 4 эмита
в секунду — глаз успевает прочитать «47 → 52 → 60», ipcRenderer не лагает
(snapshot ~1-2 KB на эмит).

> **Что пробовали и почему не сработало.** Изначально стояло emit только на
> page/done. Симптом: юзер запускал last_n=2000, открывал JobDetail, видел
> «42» секунд 8, потом резко «100» — кажется что fetch замер, на самом деле
> ничего не сломано. Throttled emit раз в 250 мс — видимый прогресс без
> render-storm.

### То же правило для YouTube batch transcribe

Аналогичный контракт: `yt_batch_transcribe_ndjson.py` эмитит per-video события (`item_start`, `subs_racing`, `transcribe_done`, ...), но job-runner вызывает `emit(snapshot)` **только** на агрегатных границах: `saved`, `skipped`, `item_error`, `done`. Иначе на 50 видео получим 250+ rerender'ов для прогресс-панели в picker'е. См. `fact-youtube.md::Batch transcribe`.

## 🚫 Почему subprocess + stdout, а не HTTP-sidecar
Альтернатива была: запустить Python как long-running daemon, повесить FastAPI на unix-socket, дёргать через fetch. **Отказались.**

| | subprocess + stdout (наш путь) | HTTP daemon |
|--|--|--|
| Cancel job | `child.kill('SIGTERM')` | требует /cancel endpoint + correlation ID |
| Track exit | `close` event с code | требует health-check |
| Memory cleanup | OS убивает процесс | надо чистить между запросами |
| Deadlocks | невозможны | возможны (lock в shared state) |
| Crash isolation | один зомби-job не валит остальные | один грязный handler роняет daemon |
| Cold start | ~500ms (Python+telethon) | 0ms (но daemon занимает RAM весь день) |
| Конкурентность | spawn N процессов | надо async-везде |

500ms на старт — единственная цена. Если станет неприемлемо — daemon-режим как опт-ин, не как умолчание.

## 🔌 IPC channels (preload bridge)
Контракты на стороне renderer:

```js
window.api.tgFetch({ target, mode, limit?, date?, url? })  → jobId
window.api.tgPreview({ target, mode, ... })                → jobId  // tg_preview job
window.api.tgResolveTitle(text)                            → { matches[], error? }
window.api.jobsList()                                      → snapshot[]
window.api.jobsListForSource(sourceId)                     → row[]   // light, для history
window.api.jobDetail(id)                                   → snapshot | null
window.api.cancelJob(id)
window.api.copyFile(path)                                  → { ok, bytes? | error }
window.api.openExternal(path)                              → { ok, opener: 'subl'|'sublime.app'|'default' }  // ТОЛЬКО локальные файлы (fs.existsSync)
window.api.openUrl(url)                                    → { ok, error? }   // http(s) URL → shell.openExternal
window.api.revealInFinder(path)
window.api.onJobUpdate(fn)                                 → unsubscribe

// Items / topics / breakdown — для ChatView, CopySavedPanel
window.api.itemsList({ source_id, limit, offset, types?, topic_id? })
window.api.itemsSearch({ source_id, query, limit })
window.api.itemsTopics(sourceId)                           → [{id, title, count}]
window.api.itemsTypeBreakdown({ source_id, topic_id? })

// Assemble (Copy-saved) — single scope, три действия
window.api.itemsAssembleEstimate(scope)                    → { count, bytes, tokens, ... }
window.api.itemsAssembleCopy(scope)                        → { ok, bytes, tokens }  // + Blow.aiff
window.api.itemsAssembleSave({ scope, defaultName })       → { ok, path, ... }
```

`jobs:list` и `jobs:detail` возвращают **snapshot** объекта (см. `job-runner.js::snapshot`) — *не* live job со ссылкой на `child` или полный array of items. Это сознательное усечение: рендерер не должен видеть тяжёлые поля (`items`, `child`, `params.password`).

Намеренное исключение — `tg_live_items` и `tg_current_item` для ChatView. Это
не проброс `job.items` в renderer, а короткий capped tail текущего Telegram
fetch'а: нужен чтобы чат показывал новые сообщения до финального DB write, но
не превращал snapshot в dump всей истории. Не расширять лимит хвоста «чтобы было
побольше» без пересчёта render-cost и размера IPC-frame; полный источник правды
после close остаётся в БД.

**`openExternal` ≠ `openUrl`.** Эти два handler'а часто хочется свести в один, но семантика разная:
- `jobs:openExternal` — для локальных файлов. Валидирует `fs.existsSync(path)`, открывает в Sublime (fallback на system default). Если передать URL — вернёт `{ok:false, error:'File not found'}` **молча**, без visible feedback'а.
- `jobs:openUrl` — для веб-ссылок. Валидирует `/^https?:\/\//i`, открывает через `shell.openExternal` (системный браузер).

Симптом смешивания: кликабельный URL в JobDetail/YoutubeCard когда-то вызывал `openExternal(url)` — клик визуально ничего не делал, в консоли тоже тихо (return-объект игнорился вызывающим). Отдельный `openUrl` решает: имя handler'а сразу подсказывает что внутри ожидается строка-URL, а не file-path.

**`onJobUpdate` listener'ом подписываться один раз.** В приложении он живёт
в `src/lib/jobInvalidation.js::wireJobInvalidation()`, маппит status на
ключи data-bus (`fact-data-bus.md`). Не добавлять `onJobUpdate(...)` в
каждый компонент — это анти-паттерн (часть фич забывают подписаться, counts
утекают).

## 🖼 Custom protocols

`sc-asset://` — read-only access к локальным ассетам в `LIB_ROOT`. Используется
для аватаров источников (Telegram скачивает `download_profile_photo` в
`avatars/telegram/<id>.jpg`). См. `fact-asset-protocol.md`.

## 🎚 Stderr handling
`stderrTail` — последние 2KB stderr в кольцевом буфере. На non-zero exit прикладываются к `job.error`. **Не пробрасывается per-line к renderer** — большинство Python-предупреждений (Telethon SSL warnings, deprecation notices) шумные и неинтересные.

## 🪵 Логи на стороне Electron
Все важные транзишены залогированы с `[Jobs]` префиксом — попадают в `logs/dev.log` или `production.log` (см. `fact-logging.md`). Достаточно `tail -f` чтобы видеть жизнь:
```
[Jobs] start tg_fetch #1 target=durov mode=last_n limit=50
[Jobs] saved #1 → ~/Library/Application Support/sc-desktop/jobs/2026-04-25_tg_durov_1.json
[Jobs] end #1 status=done items=50 duration=2s
```
