# Knowledge: HTTP-bridge между sc-desktop и browser-extension

`electron/browser-bridge.js` — loopback HTTP-сервер на `127.0.0.1:53127`,
который Electron поднимает рядом с UI. Через него browser-extension
(SC Browser Parser) кладёт YouTube-видео в Library, дёргает кэш, читает
готовые транскрипты для Gemini Studio автоскрапинга.

**Это четвёртый канал ввода в sc-desktop** наравне с paste-screen, clipboard
и CLI. Расширение его никогда не подменяет — только добавляет источник.

## 🛣 Эндпоинты

| Метод | Путь | Семантика |
|-------|------|-----------|
| GET | `/healthz` | `{ok:true}` — расширение пингует перед каждым кликом, чтобы показать «sc-desktop не запущен» если нет |
| POST | `/yt-add` | cache-first lookup → либо `{fromCache:true, cached_file_path, ...}`, либо `{jobId, commentsJobId?}`. Body принимает `withComments`, `lang`, `engine`. Cache-hit **сам** пишет в `electron.clipboard` (см. секцию Clipboard ниже) |
| GET | `/yt-status?id=…&comments_id=…&wait=N` | polling job'а; ответ содержит `status`, `file_path`, `yt_stage` (`searching`/`subs_found`/`awaiting_ai`/`transcribing`), `yt_engine` (`gemini`/`assemblyai`), `transcript_text` на done. `wait=ms` (1..25000) включает long-poll — см. секцию ниже |
| POST | `/yt-resume-ai` | `{id, engine?}` — фоновый resume для job'а зависшего в `awaiting_ai` (subs_missing pause). Расширение дёргает автоматически, see Auto-resume |
| GET | `/yt-fetch?path=…` | sync read готового файла из LIB_ROOT (path-traversal защита) |

## 🎯 Почему loopback HTTP, а не чище

**Не Native Messaging** для команд (только для логов). NMH у нас уже есть
для логов AI Studio экспортёра, но он spawn'ится **браузером** и живёт
**пока расширение** активно — sc-desktop не может через него инициировать,
а нам нужно ровно наоборот: расширение шлёт в Electron, Electron отвечает.
Двусторонний канал через NMH потребует второго процесса-моста, ровно того
же что HTTP-сервер делает в одну строку.

**Не chrome.webRequest / chrome.scripting.executeScript** в обратную сторону.
Это работает только на страницах с host_permission — нельзя дёрнуть `eval`
в `chrome://*` или окне sc-desktop. Полный круг получится только через
сервер на стороне Electron.

**HTTP вместо WebSocket** — все вызовы request/response shape (нет push'ей
от Electron в расширение). Polling хорош — `chrome.alarms` в SW работает
ровно так же; сложности WS (reconnect, ping/pong, fragmented messages)
не оправданы.

## 🔒 Безопасность

CORS allow-list жёстко фиксирован под наши content-script'ы:
```js
ALLOWED_ORIGINS = new Set([
  'https://www.youtube.com',
  'https://m.youtube.com',
  'https://aistudio.google.com',
])
```
Любой другой origin не получит CORS headers — preflight отлуп. Этого
достаточно для loopback (`127.0.0.1` не доступен извне без специальной
конфигурации сети), но хорошо — даже зайдя на вредоносный сайт юзер не
получит «случайный» yt-add от него.

**Path-traversal в `/yt-fetch`.** Параметр `?path=...` принимает абсолютный
путь к файлу транскрипта. Перед чтением `path.resolve(fp)` сравнивается с
`jobRunner.LIB_ROOT` — если выходит за корень, возвращаем 403. Без этой
проверки JS в расширении мог бы дёрнуть `?path=/etc/passwd` через CORS-
дыру (теоретическую, allowlist выше), и Electron-сервер прочитал бы и
отдал. С проверкой — даже при компрометации origin'а отдаём только
файлы Library.

## 🎯 Cache-first логика `/yt-add`

`lookupYoutubeCache(videoId)` в job-runner возвращает один из двух
вариантов:
- `origin='jobs'` — нашёл строку в `jobs` table (single-paste был раньше).
  У неё есть `id` (jobId) и `file_path`.
- `origin='items'` — нашёл `items.transcript_path` (видео из канала, который
  юзер целиком фетчил). У этой строки `id=null` потому что это item, не job.

**Раньше bridge различал эти два случая** и для items-origin запускал новый
job, считая что нужен «стабильный jobId для polling». Это и был тот баг
«долгое ожидание уже готового видео» — autoscrape в Gemini Studio полил
свежий yt_transcribe и ждал минуту вместо моментальной отдачи кэша.

**Сейчас** оба случая обрабатываются одинаково: возвращаем
`{fromCache:true, cached_file_path}`. Расширение через `/yt-fetch?path=...`
читает файл напрямую — без job-shape, без polling'а. JobId возвращается
только если он был (origin='jobs'); при items-origin = null, расширение
видит `cached_file_path` и сразу идёт за файлом.

```
POST /yt-add → {fromCache:true, cached_file_path}
            → расширение GET /yt-fetch?path=… → {text}
            → autoscrape paste'ит сразу, без полла
```

Для miss'а — обычный `startYoutubeSingle`, возвращаем `{jobId}`. Расширение
polls `/yt-status?id=<jobId>` каждые 6с до `done`.

## 📡 Long-poll вместо alarm-polling

`/yt-status` теперь принимает `wait=ms` (1..25000). Если передан — bridge **не отвечает сразу**, а подписывается на `jobRunner.subscribe(j => ...)` и держит ответ открытым пока не изменится кортеж `(status, yt_stage, yt_engine, error, comments_status, comments_error, file_path, comments_file_path)`. На любое изменение — ответ моментально, на timeout — текущий снапшот.

**Зачем.** `chrome.alarms` имеет минимум **6 секунд** между tick'ами. Старая схема: SW alarm'ом каждые 6с дёргает `/yt-status` без `wait`. Между «sc-desktop сохранил файл» и «pill стал ✓» проходило 0–6 секунд. Симптом: юзер слышал системный звук готовности из приложения, ставил Cmd+V — **видео уже было в буфере**, а тост на YT-вкладке появлялся через несколько секунд после.

**Long-poll схема:**
```
SW startLongPoll(jobId) ──fetch /yt-status?wait=25000──► bridge
                                                          │
                                                  subscribe(j => ...)
                                                  ждёт изменения tuple'а
  ◄─────────────────── ответ при first change ─────────────┘
SW process snapshot, шлёт state'ы content-script'у
SW сразу следующий fetch(/yt-status?wait=25000)
```

`activeLongPolls = Set<jobId>` защищает от дубликатов. На terminal-snapshot loop выходит. Alarm 6с оставлен **safety-net**: если SW убили посреди long-poll'а, alarm разбудит и перезапустит loop'ы для всех висящих job'ов из storage.

`req.on('close', ...)` отписывается от subscribe'а если клиент (SW) ушёл — без этого утечёт listener на каждый аборт fetch'а.

## 📋 Clipboard на cache-hit и live+comments

Симптом: юзер кликает pill «+ субтитры», слышит системный звук готовности транскрипции, **в clipboard'е пусто**. Без этой логики работало только при первом транскрибировании видео; повторные клики (cache-hit) и любая комбинация с комментами не наполняли буфер.

**Cause.** `job-runner.js` пишет `electron.clipboard.writeText(content)` в обработчике события `'saved'` от Python-subprocess'а. Когда `/yt-add` находит cache-hit — **subprocess не запускается**, `'saved'` не приходит, clipboard остаётся прежним.

**Live + comments отдельный bug.** Два независимых job'а (`yt_transcribe` и `yt_comments_ndjson`) каждый эмитит свой `'saved'`, каждый вызывает `copyFileToClipboard(file_path)`. Второй (комменты) **затирает** первый (транскрипт). Итог в буфере — только блок комментов без основного текста. Это уже существовавший баг paste-flow в desktop-UI; для расширения наружу видимо в варианте `+ субтитры`.

**Bridge-side фиксы:**

1. **Cache-hit с готовыми обоими файлами** (transcript-cache HIT + comments-cache HIT) — bridge синхронно `fs.readFileSync` оба и `clipboard.writeText(transcript + "\n\n" + comments)`.
2. **Cache-hit транскрипт + miss комменты** — пишем сразу транскрипт в clipboard, **подписываемся** на `subscribe(j => j.id === commentsJobId && j.status === 'done')` и переписываем clipboard склейкой когда comments save'нулся. Без этого comments-job через минуту затрёт транскрипт.
3. **Live transcript + live comments** — subscribe на оба job'а, переписываем clipboard склейкой когда оба `done`. Это перекрывает поверх двойной copyFileToClipboard в job-runner.

**Что пробовали и отбросили:**
- Расширение само склеивает на стороне content-script через `navigator.clipboard.writeText` — не работает, в SW нет clipboard API, content-script может писать только при user gesture (а pill'е клик уже отдан в bridge).
- Изменить порядок 'saved' event'ов в job-runner так чтобы comments шёл первым: даже так — последний `writeText` всё равно один из двух блоков, не оба сразу.

## 🔄 awaiting_ai auto-resume

`yt_single_ndjson.py` без флага `--ai` ищет субтитры через yt-dlp+youtube-transcript-api. Если не нашёл — эмитит `subs_missing` и завершается. Job-runner ставит `status='awaiting_ai'`, ждёт **explicit resume** через `resumeYoutubeAi(jobId, {engine})`. В desktop-UI это ручная кнопка «продолжить через AI» в JobDetail; в paste-flow юзер видит подсказку «нет субтитров — нажмите чтобы запустить AI».

В browser-extension flow **нет UI** для этой кнопки. Юзер кликнул pill один раз, ждёт результат — должна появиться готовая транскрипция, а не зависнуть «awaiting_ai».

**Решение:** background tracker детектит `status='awaiting_ai'` в snapshot'е и фоново POST'ит `/yt-resume-ai {id, engine}`. Engine берётся из tracker-записи (`job.engine || 'gemini'`), а тот — из `ytSettings.engine`, прокинутого через `__sc_track_job` (см. `fact-yt-extension-flow.md::awaiting_ai engine`). Флаг `resumeRequested` защищает от повторного дёрганья на каждый long-poll tick.

> **Латч `resumeRequested` — только при подтверждённом успехе.** Раньше fetch
> сидел в пустом `catch {}`, а флаг ставился **безусловно** следующей строкой.
> Один транзиентный сбой bridge'а (он же штатное «sc-desktop недоступен» при
> перезапуске приложения) навсегда блокировал resume: `awaiting_ai` — стабильный
> статус без живого child, его tuple в long-poll'е не меняется, bridge отвечает
> только по 25с-таймауту, следующий тик видит `resumeRequested=true` и не
> ретраит. Итог — job висел на «🔎 Ищу субтитры…» до 30-минутного `TRACKER_TTL`.
> Сейчас латчим только при `r.ok || r.status === 409` (409 = job уже не в
> awaiting_ai, ретраить бессмысленно). На сетевой/5xx — НЕ латчим, следующий
> тик ретраит; после `MAX_RESUME_ATTEMPTS` (3) отдаём `state:'error'`, не ждём
> полчаса.

Не каскад «попробовать gemini → если упал → assemblyai», а единичный engine
выбранный заранее.

## 🚪 Port-conflict semantics

Порт **53127 фиксированный** — расширение знает его наизусть, без
discovery. На `EADDRINUSE` Electron логирует:
```
[BrowserBridge] port 53127 занят — другой инстанс sc-desktop уже слушает,
               расширение работать не будет
```
и не падает — UI продолжает работать без bridge.

Семантика: одновременно живёт **только один** инстанс bridge. Кто первый
поднял (dev или prod sc-desktop) — у того расширение работает; второй
без bridge. Это устраивает — `library.db` всё равно одна и та же на
обоих, дубли source'ов не появятся.

Когда понадобится dev+prod одновременно — добавим `SC_BRIDGE_PORT` env
и расширение pickup через `chrome.storage`. Сейчас не плодим.

## ⚡ Hot-reload расширения

Основной канал — **WebSocket из SW к bridge'у на порту 53129**. По правилам Chrome 116+
любая активность WebSocket (send/recv) сбрасывает 30-секундный idle-таймер service worker'а.
Bridge при изменении mtime файлов `browser-extension/` шлёт `'reload'` всем подключённым SW
→ `chrome.runtime.reload()`. Hot-reload < 1 секунды. Это тот же паттерн что использует
WXT и CRXJS (см. research claude.ai chat `3896988f-7d96-43d7-85ce-4630f77039d0`).

**Bridge-сторона** (`electron/browser-bridge.js`):
- `RELOAD_WS_PORT = 53129` — отдельный порт для hot-reload.
- Путь к `browser-extension/` ищется по **двум** местам: `repoExtDir` (рядом с
  `__dirname`, работает в dev) → fallback `homeExtDir`
  (`~/Desktop/sc-desktop/browser-extension`). **Поэтому hot-reload работает и в
  packaged `.app`**: внутри asar папки нет, но физически она лежит у юзера на
  диске и находится по home-пути. WS-сервер не поднимается только если папки нет
  ни там ни там (лог `hot-reload WS skipped: extension dir not found`).
- `setInterval(1000)` проверяет `max mtime` ключевых файлов, при росте — `ws.send('reload')`
  всем подключённым клиентам.
- Лог: `[BrowserBridge] hot-reload triggered (mtime A → B), notifying N clients` — видно
  что watcher ловит изменения и кому шлёт.

> **`reload` обновляет SW, но НЕ живые вкладки.** `chrome.runtime.reload()`
> перезагружает service worker (`background.js`) сразу. Но уже открытые
> YouTube-вкладки продолжают крутить **старый** `youtube-content.js` — content-script
> инжектится при загрузке страницы, задним числом не переписывается. Поэтому при
> правке `background.js` хватает reload SW; при правке `youtube-content.js` /
> `settings.js` нужен ещё **F5 вкладки**. Симптом если забыть: после правки CSS
> в `injectGlobalCss` страница держит старый `<style>` (он ещё и early-return'ит
> если `#sc-yt-style` уже есть), новый код виден только после перезагрузки вкладки.
>
> **Исключение — `mcp-content.js`: F5 не нужен.** Он не в manifest, инжектится
> on-demand через `executeScript` из SW на КАЖДУЮ DOM-команду browser-MCP. После
> reload расширения следующая же команда подтягивает свежий код из бандла. Поэтому
> цикл правки v2-слоя (`mcp_inspect`/`mcp_act`) детерминирован: правка → reload
> расширения (WS-watcher или ручной `POST /reload-extension`) → ~6-7 сек на respin
> SW → тестируй, без перезагрузки тестовой вкладки.

**Watch-список ведётся в ДВУХ местах — держать синхронно.** Список ключевых файлов
(по чьему mtime триггерится reload) продублирован в `browser-bridge.js`: WS-watcher
(`setInterval(1000)`, быстрый <1с путь) и HTTP `/__ext_version` (fallback-poll). Файл,
добавленный только в один список, будет ловиться одним каналом и игнориться другим.
`mcp-content.js` исходно был только в логике инжекта, не в watch — поэтому правки
v2-слоя не авто-перезагружались, пока его не добавили в **оба** списка.

> **Если SW уснул, `reload` не долетит мгновенно.** Watcher шлёт `reload` только
> **подключённым** SW (`reloadClients`). Idle SW в Yandex (выгружается ~30с) теряет
> WS-соединение → правка ждёт. Подстраховки: SW реконнектит WS на любой user-action
> (см. wake-triggers ниже), `chrome.alarms` HTTP-poll `/__ext_version`, и ручной
> `POST /reload-extension` (кладёт команду в очередь, SW забирает поллом за ~3с).

**SW-сторона** (`browser-extension/background.js::__sc_connectReloadWs`):
- WebSocket к `ws://localhost:53129`. На `open` запускает `setInterval(20s)` ping —
  WS-трафик через каждые 20 сек держит SW живым.
- На `close` — `setTimeout(2s)` reconnect. Если SW убьют до setTimeout — следующий boot
  IIFE вызовет `__sc_connectReloadWs()` заново, retry автоматический.
- На сообщение `'reload'` — `chrome.runtime.reload()`.
- CSP в manifest: `connect-src ... ws://127.0.0.1:53129 ws://localhost:53129`.

**Safety net через `chrome.alarms` 0.5 min** (минимум по правилам Chrome 120+):
- Bridge `GET /__ext_version` возвращает `{mtime}` — fallback HTTP-poll если WS не поднялся.
- Alarm tick: если `__sc_reloadWs` не OPEN — `__sc_connectReloadWs()` + `__sc_pollExtVersion()`.
- Persist `__sc_ext_mtime` + `__sc_last_reload_ts` в `chrome.storage.local` — переживает
  respin SW и `chrome.runtime.reload()` (без persist'а module-level `let` сбрасывается → loop).

**5 wake-triggers для idle SW в Yandex** — alarms в Yandex idle SW могут пропадать на 5+
минут (см. «Что пробовали и почему не сработало» ниже). Дополнительно вызываем
`__sc_pollExtVersion()` (debounced 3 сек) на любое user-action:
- `chrome.tabs.onActivated` — переключение вкладки.
- `chrome.webNavigation.onCompleted` — любая навигация в любой вкладке.
- `chrome.runtime.onStartup` — старт браузера.
- `chrome.runtime.onInstalled` — установка/обновление расширения.
- `chrome.runtime.onMessage` от content-script'ов — wake'ит SW автоматически.

**Storage.session НЕ работает в Яндекс.Браузере.** Симптом детерминирован
в логах: `[reload.init_mtime]` пишется 17+ раз с разными timestamps. Причина:
`chrome.storage.session.set` в Яндексе молча падает (Promise resolve без
ошибки, но `get` возвращает undefined). Это известный quirk Яндекс'а, не
Chromium-вообще — в Chrome session работает корректно. Используем local.

**Grace period 5 секунд после boot.** Сразу после `chrome.runtime.reload()`
SW стартует с нуля, при первом poll-tick'е может прочитать ещё-не-записанный
`last` из storage и сравнить со свежим `mt` → mismatch → reload → loop. Grace
просто игнорирует mismatch в первые 5с — за это время `last` точно успеет
записаться.

**Cooldown 30 секунд между reload'ами.** Последняя защита от Yandex
circuit-breaker'а (см. ниже). Даже если все grace-проверки подведут,
30-секундный rate-limit держит нас далеко от блокировки.

### Force-reload через bridge queue

Когда нужно применить свежий код **прямо сейчас**, не дожидаясь mtime-poll или WS-tick'а:
`POST /reload-extension` кладёт команду `{cmd:'reload_extension'}` в `BRIDGE_COMMAND_QUEUE`.
Расширение polls `GET /bridge-commands` через `chrome.alarms` (3с) и обрабатывает
`reload_extension` → `chrome.runtime.reload()`. То же транспортное звено что у `focus_tab`/
`close_tab` из popover'а Запущенные MCP (см. `fact-aistudio-mcp.md::TitleBar UI`).

Применимо когда WS-keep-alive в Yandex idle SW проспал и нужно разбудить через single
HTTP-request — но это safety, не основной путь.

### Yandex circuit-breaker

Симптом: на странице расширения в `chrome://extensions/` появляется
**жёлтая кнопка «Перезагрузить»** и сообщение «Это расширение слишком
часто перезагружалось». Триггер: ~30 `chrome.runtime.reload()` за секунду
(было в первой версии hot-reload без cooldown — SW писал init_mtime,
сравнивал с свежим mt от моих Edit'ов и тут же reload, без задержки между
итерациями).

**После circuit-breaker'а кнопка «Перезагрузить» (⟳) не помогает.**
Это контринтуитивно — Chrome/Yandex держит код кэшированным даже после
⟳-клика, новая версия `background.js` не загружается. Подтверждено
детерминированно через probe (`scBgVersion: 'v1'` остался после reload).
**Единственный способ полного сброса** — toggle вкл/выкл в `chrome://extensions/`
(переключатель в верхнем-правом углу карточки расширения). Это убивает SW
полностью и грузит код заново.

### Debug-маркеры в bg-логе

Все шаги hot-reload пишутся в `chrome.storage.local.__sc_bg_dbg` (ring 200):
- `sw_boot` — старт нового SW (после reload или wake).
- `reload.init` — первая запись `mtime` в storage (без grace check).
- `reload.skip.grace` — mismatch обнаружен, но `sinceBoot < 5000ms`.
- `reload.skip.cooldown` — mismatch обнаружен, но `sinceReload < 30000ms`.
- `reload.firing` — все проверки пройдены, `chrome.runtime.reload()` вызван.

Content-script на YouTube мирорит этот лог в `#sc-yt-dbg-log` (хидден `<pre>`
в DOM), читаемый через `mcp__browser__get_text` без `userScripts` toggle.

### Что пробовали и почему не сработало

- **`chrome.alarms` с `periodInMinutes: 0.1` (6 сек) как единственный канал.**
  Формально разрешено только в unpacked-режиме. Симптом в Yandex.Browser: после
  правки исходника **5+ минут тишины**, никаких `reload.firing` entries, хотя alarm
  должен тикать каждые 6 сек. Причина: Yandex применяет packed-throttling даже на
  unpacked-расширениях (минимум 0.5 min с Chrome 120+, всё что меньше — игнорируется).
  Плюс crbug 1305369/1371876: alarm может «забыть» проснуться один-два цикла подряд
  после терминации SW в самом Chromium. Перешли на WS из SW + alarm 0.5 min как
  safety, не как основной канал. Подтверждено: после `touch` файла bridge видит
  изменение за 1 секунду и шлёт `reload` подключённому SW.
- **`setInterval(__sc_pollExtVersion, 2000)`.** SW в idle не получает CPU,
  polls не идут. Подтверждено детерминированно: после twin'а touch'ем файла
  в логе **нет ни одного** нового `reload.*` entry'я в течение минуты —
  пока я не сделал клик по pill'у YouTube (что разбудило SW через
  `chrome.runtime.onMessage`).
- **`chrome.storage.session` для persist'а.** В Яндекс.Браузере set
  молча падает (см. выше). В Chrome работает, но Яндекс — наш target
  браузер. Перешли на local.
- **CDP `--remote-debugging-port` к юзеровскому Chrome для programmatic reload.**
  Chrome 136+ блокирует CDP против default user-data-dir (security):
  даже с флагом `--remote-allow-origins=*` порт не открывается. Workaround
  — отдельный профиль через `--user-data-dir=/path`, но это создаёт
  параллельный экземпляр с пустыми extension'ами. Отброшено.
- **Открыть `chrome-extension://<id>/popup.html?reload=1` через `open` macOS.**
  `kLSApplicationNotFoundErr` — system handler не зарегистрирован на
  `chrome-extension://` scheme. Через `mcp__browser__new_tab` теоретически
  работает, но требует чтобы SW был жив (иначе MCP-bridge отлуп). Это
  bootstrap-loop: чтобы reload через MCP нужен живой SW, чтобы добраться
  до сломанного SW нужен другой механизм.

## 🔗 Связано

- `fact-yt-extension-flow.md` — что делает расширение поверх этого bridge'а
  (pill-кнопка, autoscrape, состояния)
- `fact-browser-extension.md` — общая архитектура SC Browser Parser
  (AI Studio экспортёр + Perplexity + YouTube — три content-script'а)
- `fact-youtube.md::Single-paste = source + items` — что делает
  `startYoutubeSingle` под капотом
- `fact-database.md::sources.is_explicit` — bridge-yt-add НЕ ставит флаг
  (single-paste из расширения = «случайный» канал, попадает в свёрнутое
  «Прочее» в LibrarySidebar)
