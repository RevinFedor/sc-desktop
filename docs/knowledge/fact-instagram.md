# Knowledge: Instagram стек

Всё про Instagram-парсинг в desktop. Платформа в Library — `instagram`. Источник — профиль (`source.handle = '<username>'`), элементы — рилсы (`external_id = 'reel:<shortcode>'`) и опционально посты (`'post:<shortcode>'`).

Здесь — про desktop-flow и как Instagram-стек устроен под Electron через
`python-workers`. Старые CLI-only материалы, если встретятся в истории, не
являются точкой входа для desktop-правок.

## 🧭 Ndjson-скрипты Instagram

| Скрипт | Что делает | Тип job |
|---|---|---|
| `python-workers/instagram/ig_login_ndjson.py` | headed-login в Instagram и запись cookies | one-shot, не job |
| `python-workers/instagram/ig_sessions_ndjson.py` | inventory/health-check cookies-файлов + delete | one-shot, не job |
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

## 🎯 Почему transcribe **повторно** ходит в `clips/user/`, а не в `media/info/`

Натуральный путь для «получить видео по shortcode» — `media/info/?media_id=<pk>_<user_id>`. Но он **требует ds_user_id cookie** (логинного юзера), без cookies возвращает 401. У stateless-клиента нет ds_user_id → не работает.

Есть и другие пути, тоже не работают без cookies:
- `instagram.com/api/v1/media/by_shortcode/?shortcode=<c>` → 404 для анонимных.
- `instagram.com/graphql/query/?...` → `require_login: true`.
- `instagram.com/p/<c>/?__a=1&__d=dis` → 404.

Что работает — это **повторно** дёрнуть `clips/user/` (тот же endpoint, что использует `ig_profile_ndjson.py`) для конкретного `target_user_id` и пагинировать пока нужный shortcode не появится. У каждого reel в payload уже есть свежий signed `video_url` (минуты-часы TTL).

**Архитектура transcribe-job через `--backend api`:**
1. `ig_batch_transcribe_ndjson.py` принимает обязательный `--user-id <pk>` (passed из `source.external_id` в job-runner). Если job sourceless или у source нет числового Instagram `user_id`, api-путь невозможен: `clips/user/` не умеет резолвить произвольный shortcode без владельца.
2. Перед первым reel'ом `_get_ig_client()` создаёт singleton `IGAPIClient(skip_session=True)`.
3. Для каждого shortcode из batch:
    - Сначала смотрим `_cache[user_id].reels[shortcode]` — был ли он уже спарсен в предыдущем page.
    - Если нет — пагинируем `clips/user/` страницами по 12, **накапливая все встреченные** reels в кэш.
    - Останавливаемся, когда нужный shortcode появился (early-exit), либо когда `paging_info.more_available=false`.
4. Из reel-объекта берём `video_url`, скачиваем curl'ом → ffmpeg → Gemini.

**Кэш per-user_id на весь batch** — критичен. Без него для batch из 50 reels в одном профиле скрипт бы пагинировал `clips/user/` 50 раз с нуля. С кэшем — один раз пагинируем профиль до полного покрытия shortcodes из batch (обычно 1-3 страницы), дальше hits идут из памяти.

**Альтернатива через apify (transcribe_backend=apify):** актор `apple_yang/instagram-transcripts-scraper` принимает `videoUrl` (полный URL рилса), отдаёт audioUrl. $0.001 за reel. Используется как fallback и для случаев когда нужен **приватный** рилс на который у юзера есть подписка (apify-actors сами держат залогиненную сессию).

---

## 📦 Apify-акторы

Используем два:
- `apify/instagram-reel-scraper` — для metadata-fetch профиля. Отдаёт массив reels с metadata. ~$0.0026 / профиль (пакетная цена).
- `apple_yang/instagram-transcripts-scraper` — для transcribe-fetch одного reel'а. Отдаёт audioUrl. $0.001 / reel.

Apify-runs работают так: POST `acts/<actor>/runs?token=...`, получаем `run.id` + `defaultDatasetId`, далее **поллинг** `/actor-runs/<id>` каждые 3 секунды до `status=SUCCEEDED`, потом GET `/datasets/<dsId>/items`. Это live-state, нельзя skip'нуть.

**Cancel-проблема:** при cancel job в Electron мы делаем `child.kill('SIGTERM')` — Python-процесс умирает, но **запущенный run на сервере Apify продолжает выполняться** ещё 5-30 секунд и спишет деньги. Мы не зовём `apify abort` API. Это известный недочёт; кост на отменённые runs пока приемлемый ($0.001-0.0026 максимум).

**`apify_token`** — в `~/.config/sc/settings.json::instagram.apify_token`. Legacy plaintext-файл `~/.config/sc/apify_token` (CLI-старый формат) тоже читается через `cfg.get_apify_token()`. При сохранении токена через UI legacy-файл удаляется, чтобы CLI не подхватил устаревшее значение. InstagramSettings проверяет токен сетевым запросом к Apify `users/me`: «сохранён» означает только что секрет лежит на диске, «валиден» показывается только после ответа Apify.

---

## 🍪 Cookies для приватных профилей — опциональны

`~/.config/sc/instagram_session.json` (Playwright storage_state) и `~/.config/sc/instagram_api_session.json` (плоский dict) — два формата одной Instagram-сессии. Если файл есть и `IGAPIClient` создан **без** `skip_session=True`, он подхватит cookies и будет ходить как залогиненный юзер. Это нужно **только** для приватных профилей на которые юзер подписан.

**Login-flow:** `sc -i --login` (shim в `cli-tools/scripts/sc`) запускает тот же путь что и `npm run instagram:login`: headed Chrome через Playwright, пользователь логинится руками, скрипт ждёт `sessionid` cookie и сохраняет оба файла. Это не «браузерный парсер» и не Docker — только ручной способ получить cookies без автозаполнения Instagram-форм.

**В UI** управление сессиями скрыто за `Расширенное · Cookies-сессии` в InstagramSettings. Юзер видит файлы, возраст файла, результат проверки и может удалить сессию. Наличие `sessionid` в JSON больше не считается доказательством авторизации: старая cookie могла протухнуть месяц назад, поэтому Settings вызывает `ig_sessions_ndjson.py list --check`.

`ig_sessions_ndjson.py` — inventory + optional health-check:
- `list` → emit per-file `{kind:'playwright'|'api', authorized, user_id, error, age_days}`
- `list --check` → дополнительно делает network-check на `instagram.com/api/v1/accounts/edit/web_form_data/` и возвращает `health.ok`, `health.username` или HTTP/JSON-причину невалидности.
- `delete --kind <k>` → удалить файл (используется в UI кнопкой 🗑)

Файл без network-check — это только inventory («на диске что-то есть»). UI-статусы «сессия проверена» / «не прошла проверку» опираются на `health`, а не на `authorized`.

## 🎬 Одиночный reel из paste-flow

Inline-форма для `https://www.instagram.com/reel/<shortcode>/...` больше не должна показывать CLI-заглушку. Поток такой:

1. Сначала `ig:lookupReel` ищет уже готовый текст: `items.external_id = 'reel:<shortcode>'` для source-attached reels, затем sourceless `ig_batch_transcribe` jobs по `parameters_json.shortcodes` + `file_path`. Cache-hit сразу показывает «Уже есть транскрипт» и копирует combined-файл, без нового Apify run.
2. Если shortcode уже привязан к локальному Instagram source с числовым `user_id`, можно идти бесплатным `android-api`: transcribe заново пагинирует `clips/user/<user_id>` и берёт свежий `video_url`.
3. Если юзер вставил **голый reel URL**, а владельца/source в БД нет, бесплатный api-путь невозможен. `clips/user/` требует owner `user_id`; надёжного cookies-free shortcode-resolve в текущем стеке нет. В этом случае UI явно планирует Apify, проверяет валидность токена и пишет почему android-api не подходит.

Это не silent fallback: переключение на платный backend для bare URL видно в форме до запуска. Если Apify token невалиден или не задан, кнопка блокируется с причиной.

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

- **`media/info/` для transcribe вместо re-pagination `clips/user/`** — 401 без `ds_user_id` cookie. Без cookies endpoint не доступен независимо от `X-IG-App-ID`.
- **`graphql/query/?shortcode=<c>`** — отвечает `require_login: true` для анонимных запросов. Workaround нет.
- **Хранить `video_url` в БД при первом fetch** — signed URL экспирится через 5-15 минут, БД переполнится протухшими URL. Re-fetch перед скачиванием обязателен.
- **Auto-fallback api → apify при ошибке** — отбросили: тихо тратятся деньги на apify в случаях которые юзер бы сам решил перезагрузкой / переключением. Failure visible — лучше чем quiet retry.
- **Парсинг через Docker/browser** — первый вариант был ближе к «открыть Instagram как страницу и вытащить данные», но Android mobile endpoints оказались быстрее и проще. Браузер не возвращаем в runtime-парсинг; он нужен только для headed login.
- **Импорт cookies из Yandex/Chrome как основной flow** — browser cookies часто зашифрованы системным keychain и не читаются детерминированно из worker'а. Надёжнее дать пользователю headed-login, сохранить оба app-specific session-файла и потом проверять их network-check'ом.
- **Свой phone+code login flow в UI (как у Telegram)** — IG банит за автозаполнение полей входа. Логин остаётся ручным в headed Chrome, UI только показывает команду и валидность получившихся cookies.
