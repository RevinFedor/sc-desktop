# SC Desk: mobile API и исходящие уведомления

Mobile API — внешний one-shot вход в те же Instagram/YouTube pipelines, которыми
владеет SC Desktop. Первый клиент — нативная вкладка SC Desk в
`/Users/fedor/Desktop/vs-code/habit-tracker`. Старый интерактивный Telegram-вход,
который принимал ссылки через polling, удалён; узкий исходящий канал уведомлений
Custom Terminal остаётся отдельным живым контрактом. Mobile API не переносит
desktop Library на телефон и не создаёт второй job engine: он хранит маленькую
мобильную запись, запускает обычный job и проецирует его состояние в стабильный
HTTP/SSE contract.

Текущий продуктовый scope mobile API:

- один Instagram Reel или Post с транскрибируемым video/audio;
- одно YouTube-видео, включая Shorts/Live URL;
- никакого Instagram profile timeline, YouTube channel или batch-import.

Image-only Instagram Post проходит URL-классификацию, но завершается понятной
ошибкой отсутствия транскрибируемого media. Это не обещание OCR/vision для
поста.

## Custom Terminal: исходящие Telegram-уведомления

SC Desktop сохраняет только нижний исходящий слой старого Telegram-бота:
доставка `sendMessage` о завершении AI-вкладки. Интерактивный `getUpdates`,
приём Instagram-ссылок и bot UI не возвращаются. Потребитель этого узкого слоя —
Custom Terminal; удаление прежнего пользовательского входа не означает, что
межпроектный получатель больше никому не нужен.

Это отдельная loopback/auth-граница: Custom Terminal вызывает
`POST http://127.0.0.1:53127/notifications/terminal-completion` с bearer token из
`~/Library/Application Support/sc-desktop/notification-bridge-token`. Не
переносить route на mobile API `:7898`, не переиспользовать `mobile-api-token` и
не разрешать browser Origin. Dev-runtime не отправляет реальные Telegram-
сообщения без явного opt-in.

Canonical identity события — `eventId = tabId:firedAt`. Custom Terminal сначала
пишет событие в durable FIFO и только потом доставляет: `400/401/403` завершают
запись как постоянную ошибку контракта, а `404/429/5xx`, timeout и network failure
остаются в очереди с backoff. SC Desktop сериализует Telegram-вызовы и хранит
receiver-side dedupe по `eventId`, потому что Telegram мог принять сообщение,
а HTTP-ответ отправителю — потеряться. Sender-side dedupe одного этого случая не
закрывает.

Практическое следствие: восстановление production-получателя может немедленно
отправить весь накопленный backlog. Перед запуском сначала проверить очередь и
явно решить, доставлять ли старые события; молча очищать её нельзя. Парная сторона
контракта — `/Users/fedor/Desktop/custom-terminal/docs/knowledge/fact-tabs.md`
в секции «Уведомление о завершении вкладки».

## Сетевая граница

Listener намеренно привязан только к `127.0.0.1:7898`. Внешний путь:

```
iPhone
  → https://sc.f9922.tech
  → nginx на 94.242.59.5
  → reverse SSH :7898
  → 127.0.0.1:7898 на Mac
  → Electron main / обычные job-runner pipelines
```

LaunchAgent `~/Library/LaunchAgents/tech.f9922.sc.tunnel.plist` держит
`autossh -R 7898:127.0.0.1:7898 root@94.242.59.5` через `KeepAlive` и
`RunAtLoad`. DNS A-record `sc.f9922.tech` указывает на VPS. Nginx завершает TLS,
отключает proxy buffering для SSE, держит длинные read/send timeouts и при
недоступном Mac возвращает JSON 503. Сервер не надо открывать на `0.0.0.0` и
не надо делать iPhone зависимым от одной Wi‑Fi сети.

Это реальная внешняя инфраструктура, а не вывод из Electron-кода. При симптоме
«SC Desk недоступен» проверять по порядку:

1. `GET https://sc.f9922.tech/api/me` с bearer token;
2. DNS/TLS/nginx на VPS;
3. LaunchAgent и `~/Library/Logs/sc-tunnel.log`;
4. loopback listener `127.0.0.1:7898`;
5. только затем конкретный Instagram/YouTube job.

Все routes, включая health/capabilities и SSE, требуют bearer token. Token
создаётся один раз в
`~/Library/Application Support/sc-desktop/mobile-api-token`, каталог имеет
mode `0700`, файл — `0600`. Значение никогда не логировать и не переносить в
документацию. iOS хранит согласованное значение в gitignored Secrets.

## HTTP/SSE contract

Основные операции:

| Method | Path | Смысл |
|---|---|---|
| `GET` | `/api/me` | auth + capabilities |
| `GET` | `/api/imports` | mobile-history; можно фильтровать `clientRequestId` |
| `POST` | `/api/imports` | принять один URL; `202` для нового, `200` для dedupe |
| `GET` | `/api/imports/:id` | одна публичная запись |
| `GET` | `/api/imports/:id/result` | текст только для готового import |
| `POST` | `/api/imports/:id/resume-ai` | продолжить YouTube после `awaiting_ai` |
| `POST` | `/api/imports/:id/cancel` | отменить живой job/import |
| `GET` | `/api/events` | SSE seed активных записей + live updates |

`POST /api/imports` принимает `{url, clientRequestId}`. Если такой
`clientRequestId` уже есть, новый job не создаётся. Это не просто debounce:
телефон мог потерять response после того, как Mac уже принял POST. Повтор с тем
же id обязан вернуть существующий import.

`clientRequestId` идентифицирует одну пользовательскую попытку, а не сам URL.
Потерянный response повторяется с прежним id; осознанный retry после ошибки,
новая ссылка и повтор старой ссылки после другой получают новый id. Если клиент
переиспользует id для другого URL, сервер намеренно вернёт первую запись:
idempotency не должна незаметно превратиться в повторный запуск.

Public record отдаёт только стабильную проекцию:
`id/clientRequestId/platform/url/externalId/mediaKind/title`,
`status/stage/progress`, `backend/backendMode/engine`,
`stepIndex/stepTotal/errorCode/error/resultReady/createdAt/updatedAt`. Внутренний
`jobId` и путь результата наружу не уходят.

SSE сначала посылает `ready`, затем seed для `queued/running/awaiting_ai`,
после чего `event: import` и heartbeat раз в 20 секунд. REST остаётся
обязательным seed/recovery каналом: клиент не должен считать открытый SSE
доказательством полной истории.

`GET result` дополнительно проверяет, что resolved path находится внутри
Library root. Даже запись из локальной history не даёт API произвольно читать
файл по внешнему пути.

## URL scope и canonicalization

Instagram direct URL принимает `/reel/<code>`, `/reels/<code>` и `/p/<code>`.
Server также умеет defensive-resolve `/share/reel/...` и `/share/p/...`: не
больше пяти HTTPS redirects, каждый host остаётся Instagram; если redirect не
дал direct path, читается canonical/`og:url`. Redirect наружу отклоняется.
Нативный iOS-клиент сейчас pre-validates только direct paths, поэтому наличие
server resolver не расширяет само по себе iOS UI contract.

YouTube URL нормализуется к `https://www.youtube.com/watch?v=<id>`.
Поддерживаются `watch`, `youtu.be`, `shorts`, `live`, `embed`; channel/playlist
не проходят single-video classifier.

Классификация выполняется и на клиенте для UX, и здесь как trust boundary.
Нельзя принимать arbitrary URL только потому, что iOS уже показал кнопку.

## Instagram: проекция обычного batch job

Mobile import вызывает общий single-reel service, который выбирает backend из
текущих SC Desktop settings и запускает обычный `ig_batch_transcribe`. Mobile
слой не делает скрытый Android→Apify fallback и не меняет engine пользователя.
Если выбран Android API, отсутствие нерелевантного Apify token не должно
блокировать запуск.

Публичные стадии собраны из `ig_batch.current`:

1. `checking_backend`;
2. `resolving_media`;
3. `downloading_media`;
4. `preparing_audio`;
5. `transcribing`;
6. `saving`;
7. `done`.

Важен не только mutation `job.current.stage`, но и немедленный
`emit(job)`. Без него worker действительно идёт дальше, а iPhone остаётся на
старой строке до terminal event. Общий snapshot-инвариант — `fact-jobs.md`.

Reel и video-Post используют один pipeline, но сохраняют `mediaKind`, чтобы
история не стирала продуктовую разницу. Подробности cache/backend/external-id —
`fact-instagram.md`.

### Аудио есть, распознанного текста нет

Если media успешно resolved и аудиофайл уже подготовлен, но Gemini завершился
без текстовых parts, это отдельный terminal outcome: `status=error`,
`stage=audio_no_text`, `errorCode=audio_no_text`, `resultReady=false`. Клиенты
ветвятся по машинному `errorCode`, а не сопоставляют локализованный `error`;
человеческий текст может меняться без изменения API-контракта.

До появления кода Gemini-парсер выдавал наружу `transcribe failed: 'parts'`.
При загрузке старой mobile-history только эта точная Instagram-сигнатура после
шага 5 нормализуется в `audio_no_text`. Ограничение по сигнатуре и стадии не
даёт переименовать ранний resolve/download/API-сбой в отсутствие речи.

## YouTube: две стадии одной mobile-записи

Stage 1 проверяет metadata и субтитры. Если субтитры найдены, import сохраняет
их и становится `done`. Если нет, обычный `yt_transcribe` переходит в
`awaiting_ai`: child уже завершился, но `jobId` остаётся нужным для
`resumeYoutubeAi`.

После явного `resume-ai` тот же import расширяется с трёх до шести шагов:

1. `fetching_metadata`;
2. `searching_subtitles`;
3. `saving_subtitles` или `awaiting_ai`;
4. `downloading_audio` / `preparing_audio`;
5. `transcribing`;
6. `saving` → `done`.

Это одна пользовательская работа и одна history-row, а не две записи вокруг
consent. Cache-hit завершает import без нового spawn. Механика общего job —
`fact-youtube.md::Two-stage single video`.

## Mobile-history не равна jobs table

`mobile-imports.json` — внешний facade максимум из 200 записей. Он сохраняется
atomic temp+rename и не содержит текст результата: только metadata и
`resultFile`, а сам текст читается по запросу из Library. Эта история нужна для
стабильного UUID, `clientRequestId` и iOS UX; она не заменяет
`library.db::jobs`, Activity или source history.

Запись обновляется на каждом публичном изменении и рассылается SSE. На disk
никогда не сериализуется `resultText`, иначе один и тот же большой транскрипт
начнёт дублироваться в JSON history и Library.

## Рестарт: process-local `jobId` всегда забывается

`jobId` — счётчик текущего Electron-процесса. После рестарта новый job снова
может получить `1`; persisted mobile import со старым `jobId=1` ошибочно
подписался бы на его snapshots и присвоил чужие title/result.

Поэтому при чтении `mobile-imports.json` `jobId` очищается без условий:

- существующий `resultFile` восстанавливает `done`;
- YouTube дополнительно может восстановить title/result через общий cache;
- `queued/running/awaiting_ai` без готового файла становится
  `error/interrupted` с предложением запустить ссылку заново;
- terminal записи остаются terminal.

Не пытаться «возобновить» Python child после рестарта и не сохранять
process-local id как durable identity. Долговечная identity mobile-слоя —
UUID import и `clientRequestId`; identity Library — собственный DB id.

## Связанное

- `/Users/fedor/Desktop/vs-code/habit-tracker/docs/knowledge/fact-sc-desk.md`
  — нативный clipboard/UI/autocopy flow.
- `fact-instagram.md` — single Reel/Post service и backend selection.
- `fact-youtube.md` — двухстадийный `yt_transcribe`.
- `fact-jobs.md` — snapshots, emit и независимые id-пространства.
- `fact-logging.md` — production Electron logs; tunnel имеет отдельный log.
