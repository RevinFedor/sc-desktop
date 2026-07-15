# Knowledge: Instagram стек

Всё про Instagram-парсинг в desktop. Платформа в Library — `instagram`. Источник — профиль (`source.handle = '<username>'`), элементы — рилсы (`external_id = 'reel:<shortcode>'`) и опционально посты (`'post:<shortcode>'`).

Здесь — про desktop-flow и как Instagram-стек устроен под Electron через
`python-workers`. Старые CLI-only материалы, если встретятся в истории, не
являются точкой входа для desktop-правок.

## 🧭 Ndjson-скрипты Instagram

| Скрипт | Что делает | Тип job |
|---|---|---|
| `python-workers/instagram/ig_login_ndjson.py` | headed-login, проверка доступа и запись двух session-форматов | one-shot, не job |
| `python-workers/instagram/ig_sessions_ndjson.py` | inventory + раздельный web/Android API health-check + delete | one-shot, не job |
| `python-workers/instagram/ig_profile_ndjson.py` | username → список reels/posts | `ig_profile_fetch` |
| `python-workers/instagram/ig_batch_transcribe_ndjson.py` | список shortcodes → транскрипты | `ig_batch_transcribe` |

Скрипты используют worker-side API helpers. Любой helper, который пишет rich/ANSI
в stdout, должен быть обёрнут `silenced()` — ndjson stdout остаётся чистым.

---

## 🔑 Два независимых бэкенда — `metadata_backend` и `transcribe_backend`

В `~/.config/sc/settings.json::instagram` живут **два** селектора:
- `metadata_backend` — что использует `ig_profile_ndjson.py` (api / apify, default `api`)
- `transcribe_backend` — что использует `ig_batch_transcribe_ndjson.py` (api / apify, default `api`)

**Зачем разделены:** парсинг профиля и скачивание видео для транскрипции — две независимых сетевых операции. Можно столкнуться с rate-limit на одной и не на другой. Юзер должен иметь возможность переключиться точечно («api тротлит на профиле — ставлю apify только на metadata, transcribe оставляю api»). Один общий backend = всё-или-ничего, что заставляет переплачивать или ждать.

**Auto-fallback не делаем намеренно.** Если `api` упал — это видимая ошибка в UI, юзер сам решает что переключать. Тихий fallback скрывал бы факт rate-limit'а и юзер бы платил за apify не понимая что api снова работает.

**Legacy-ключ `instagram.backend` (pre-split)** — если найден, мапится на `metadata_backend`; значение `'android'` старого формата считается равным `'api'` (после refactor'а это один и тот же путь). См. `_readIgBackends` в `electron/main.js`.

---

## 🚪 Cookies-free путь через `clips/user/`

`IGAPIClient(skip_session=True)` — клиент без auto-load `instagram_*_session.json` с диска. Ходит на `i.instagram.com/api/v1/clips/user/` с **только** двумя обязательными заголовками:
- `User-Agent: Instagram <version> Android (...)`
- `X-IG-App-ID: 936619743392459` — публичный mobile-app ID, одинаковый у всех пользователей IG-приложения.

Этого достаточно чтобы получить **публичные reels публичных профилей** с полными метаданными **и прямыми `video_url`** (signed CDN, действителен ~5–15 минут).
Это requests-эмуляция Android-клиента, не Docker/headless-browser: браузер остался только для ручного login/cookies, не для парсинга reels.

**Ограничения:**
- Приватные профили → endpoint вернёт `login_required`. В UI это error для юзера, не silent skip.
- Posts (timeline media) этим путём недоступны — endpoint `feed/user/` тоже хочет cookies.
- Rate-limit IG не публикует, в практике на 200+ reels подряд работает; если упадёт — юзер видит ошибку и переключает на apify.

**`web_profile_info` для «Обзора»** — отдельный публичный HTTP к `instagram.com/api/v1/users/web_profile_info/?username=<u>`. Тот же `X-IG-App-ID`. Отдаёт media_count (включая и posts, и reels — IG не разбивает в этом endpoint), follower_count, biography, profile_pic_url. Используется кнопкой `📊 Обзор` в SourceDetail (см. `fact-source-actions.md`). Запрос делается из Node main-process прямо (`electron/main.js::ig:overview` → `https.request`), без Python — это один HTTP без зависимостей, лишний spawn оверкилл.

---

## 🎯 Два Android API-пути получения `video_url`

`--backend api` выбирает бесплатный Android API, но способ разрешения reel зависит
от известного контекста. Backend при этом не меняется:

1. **Есть числовой owner `user_id`** — stateless-клиент повторно пагинирует
   `clips/user/<user_id>` до нужного shortcode. Этот путь не читает cookies и
   сохраняет анонимный профильный batch быстрым.
2. **Есть только bare shortcode/URL** — authenticated-клиент переводит shortcode
   в media PK и вызывает канонический `media/<pk>/info/`. Он требует сохранённую
   Android API-сессию, зато owner заранее не нужен: ответ самого reel содержит
   owner и свежий signed `video_url`.

Проверено прямыми запросами на одном и том же reel: старый маршрут
`media/info/?media_id=...` вернул HTTP 404 с HTML, а
`media/<pk>/info/` с действующей сессией вернул HTTP 200, owner и video URL.
Анонимный запрос к media endpoint вернул `login_required`. Поэтому отсутствие
owner в локальной БД не является ошибкой Android API; ошибкой является только
отсутствующая или отклонённая Instagram-сессия.

Для профильного batch кэш `per-user_id` остаётся критичным: страницы
`clips/user/` накапливаются один раз на весь job, а следующие shortcodes ищутся
в уже полученных reels. Для bare URL используется отдельный session-клиент, чтобы
профильный stateless flow не начал случайно зависеть от login cookies.

`api_resolution` делает выбранный путь явным в job/logs:
`profile_clips` для известного owner и `shortcode_session` для bare URL. При
ошибке ни один из путей не переключается на Apify. Актор
`apple_yang/instagram-transcripts-scraper` запускается только если пользователь
сам выбрал `transcribe_backend=apify`.

---

## 📦 Apify-акторы

Используем два:
- `apify/instagram-reel-scraper` — для metadata-fetch профиля. Отдаёт массив reels с metadata. ~$0.0026 / профиль (пакетная цена).
- `apple_yang/instagram-transcripts-scraper` — для transcribe-fetch одного reel'а. Отдаёт audioUrl. $0.001 / reel.

Apify-runs работают так: POST `acts/<actor>/runs?token=...`, получаем `run.id` + `defaultDatasetId`, далее **поллинг** `/actor-runs/<id>` каждые 3 секунды до `status=SUCCEEDED`, потом GET `/datasets/<dsId>/items`. Это live-state, нельзя skip'нуть.

**Cancel-проблема:** при cancel job в Electron мы делаем `child.kill('SIGTERM')` — Python-процесс умирает, но **запущенный run на сервере Apify продолжает выполняться** ещё 5-30 секунд и спишет деньги. Мы не зовём `apify abort` API. Это известный недочёт; кост на отменённые runs пока приемлемый ($0.001-0.0026 максимум).

**`apify_token`** — в `~/.config/sc/settings.json::instagram.apify_token`. Legacy plaintext-файл `~/.config/sc/apify_token` (CLI-старый формат) тоже читается через `cfg.get_apify_token()`. При сохранении токена через UI legacy-файл удаляется, чтобы CLI не подхватил устаревшее значение. InstagramSettings проверяет токен сетевым запросом к Apify `users/me`: «сохранён» означает только что секрет лежит на диске, «валиден» показывается только после ответа Apify.

---

## 🍪 Instagram-сессии и повторный вход

`~/.config/sc/instagram_session.json` хранит Playwright storage state,
`~/.config/sc/instagram_api_session.json` — cookies и постоянную identity
Android-устройства. Это два представления одного входа с разной проверяемой
способностью: browser-session нужна headed flow, API-session — bare reel и
authenticated mobile endpoints. Публичный профиль через `clips/user/` по-прежнему
работает stateless.

В Settings сессии видны сразу в секции `Android API · Instagram-сессия`, потому
что bare URL зависит от них. Кнопка `Войти заново` запускает headed Chrome через
IPC без терминальной команды. Helper сначала пробует Instagram one-tap
`Продолжить`, затем ждёт ручной ввод только если Instagram действительно показал
login form/challenge, обрабатывает известную post-login кнопку сохранения входа и
записывает оба файла только после успешного сетевого web-check. Наличие старого
`sessionid` в browser context само по себе больше не завершает login как success.

`ig_sessions_ndjson.py list --check` проверяет форматы раздельно:

- Playwright cookies — web endpoint аккаунта без redirect-following; redirect на
  login является invalid, а не циклом `TooManyRedirects`.
- Android API cookies — representative authenticated mobile request
  `discover/media_metadata/?media_id=1`. Для действующей сессии он возвращает
  HTTP 200/status ok даже без реального media, для anonymous/отозванной —
  HTTP 403 `login_required`.

Успешный web-check не доказывает, что mobile API принимает те же cookies, поэтому
зелёный статус Android API строится только по mobile probe. Username для строки
берётся дополнительным web-check и не влияет на API verdict.

API-session сохраняет device/app UUID и Android ID между worker-запусками, чтобы
не представляться Instagram новым устройством на каждый запрос. Это hardening,
а не доказанная причина прежней инвалидизации: после серии диагностических
private API-запросов старая сессия была отозвана сервером, но точную server-side
причину текущие логи не установили.

## 🎬 Одиночный reel из paste-flow

Inline-форма для `https://www.instagram.com/reel/<shortcode>/...` больше не должна показывать CLI-заглушку. Поток такой:

1. Сначала `ig:lookupReel` ищет уже готовый текст: `items.external_id = 'reel:<shortcode>'` для source-attached reels, затем sourceless `ig_batch_transcribe` jobs по `parameters_json.shortcodes` + `file_path`. Cache-hit сразу показывает «Уже есть транскрипт» и копирует combined-файл без нового network/AI job.
2. Если shortcode привязан к source с числовым owner, Android API использует
   stateless `profile_clips` и берёт свежий `video_url` из `clips/user/`.
3. Если юзер вставил **голый reel URL**, а source в БД нет, выбранный Android API
   использует `shortcode_session`. Такой job остаётся sourceless, не создаёт
   фиктивный профиль/items и требует валидную API-session.
4. Если пользователь явно выбрал Apify, форма проверяет его token и запускает
   только Apify. Невалидная Android session не является разрешением потратить
   деньги через автоматический fallback.

Тот же service вызывается Telegram-ботом, поэтому cache/backend/error contract
не расходится между paste-flow и сообщением. Формат и lifecycle бота описаны в
`fact-telegram-bot.md`.

---

## 🏷 `external_id`-префикс — `reel:` и `post:`

Items в `library.db` хранятся с префиксом:
- `reel:C5dWF-2SFed` — рилс
- `post:DULBkEngpxg` — пост

**Зачем:** shortcode формально может пересечься между постом и рилсом одного юзера (формат `[A-Za-z0-9_-]{11}`). `UNIQUE(source_id, external_id)` без префикса упал бы на коллизии. Префикс делает namespace явным.

**В UI** префикс **скрывается** при отображении (`#displayId` в ChatView обрезает `^(reel|post):`). Юзер видит чистый shortcode. Внутри (job-runner, БД, IPC) — всегда полный `reel:<code>`.

**Python-скрипт `ig_batch_transcribe_ndjson.py` принимает чистый shortcode** (без префикса) в `--shortcodes`. Job-runner добавляет `reel:` префикс обратно при `db.markItemTranscribed` на `saved` event.

---

## 🧰 `forceForm` prop у InstagramConfigForm

Один компонент рендерится в двух местах:
- **Paste-flow (Home):** `<InstagramConfigForm target="durov" />` — на mount делает `igLookupProfile(handle)`, и если профиль уже есть в БД с items → сразу показывает header + picker (стадия `ready`). Юзер не делает повторный fetch если кешированно.
- **SourceDetail «Новый запрос…»:** `<InstagramConfigForm target={s.handle} forceForm />` — пропускает auto-lookup, всегда стартует в kickoff-form. Без флага компонент бы скипнул на header+picker, дублируя то что **уже отрендерено выше** в SourceDetail (там и identity-row есть, и picker через `<InstagramBatchPicker>`).

`forceForm` — единственное отличие в поведении формы в этих двух контекстах. Нет двух разных компонентов, нет fork'а — один и тот же `InstagramConfigForm` с props.

---

## 📂 Где сохранённые файлы

```
~/Library/Application Support/sc-desktop/
├── transcripts/instagram/<shortcode>__<slug>.txt    # один файл на каждый saved reel
└── jobs/<date>_ig_batch_<jobN>_combined.txt          # автоматический combined по batch (см. fact-jobs.md)
```

Combined.txt пишется **автоматически** при close batch-job, без отдельного «Save combined» action. Для IG это уместно потому что каждый сохранённый рилс — платный AI-транскрипт, и combined блок — единственный итог ради которого юзер пришёл. Для YT combined опционален (там есть бесплатный subs-path и юзер может захотеть отдельные .txt'ы), для IG — всегда.

---

## 🪤 Что пробовали и почему не сработало

- **`media/info/?media_id=...` как shortcode-resolve** — это не канонический
  private API route: с валидной сессией он вернул 404 HTML. Рабочий маршрут —
  `media/<pk>/info/`; без session cookies он ожидаемо отвечает `login_required`.
- **`graphql/query/?shortcode=<c>`** — отвечает `require_login: true` для анонимных запросов. Workaround нет.
- **Хранить `video_url` в БД при первом fetch** — signed URL экспирится через 5-15 минут, БД переполнится протухшими URL. Re-fetch перед скачиванием обязателен.
- **Auto-fallback api → apify при ошибке** — отбросили: тихо тратятся деньги на apify в случаях которые юзер бы сам решил перезагрузкой / переключением. Failure visible — лучше чем quiet retry.
- **Парсинг через Docker/browser** — первый вариант был ближе к «открыть Instagram как страницу и вытащить данные», но Android mobile endpoints оказались быстрее и проще. Браузер не возвращаем в runtime-парсинг; он нужен только для headed login.
- **Импорт cookies из Yandex/Chrome как основной flow** — browser cookies часто зашифрованы системным keychain и не читаются детерминированно из worker'а. Надёжнее дать пользователю headed-login, сохранить оба app-specific session-файла и потом проверять их network-check'ом.
- **Свой phone+code login flow и автозаполнение password в UI** — challenge/2FA
  Instagram нельзя надёжно свести к нашей форме. UI запускает headed Chrome и
  автоматизирует только безопасные известные шаги one-tap/save-login; credentials
  и challenge остаются в Instagram, после чего worker сам проверяет результат.
