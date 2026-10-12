# SC Desktop

SC Desktop — приложение для macOS, которое собирает Telegram, YouTube, Instagram, TikTok, Reddit и Boosty в локальную медиатеку. Python workers получают материалы, Electron показывает задания и результаты, а расширение работает с вашим обычным Chromium-браузером. Есть локальная транскрипция, поиск по архиву, экспорт AI-диалогов и external research.

Начать можно с одного из двух файлов. Их можно отправить знакомому целиком: каждый содержит поручение для его AI, команды установки и критерии проверки.

| Что нужно | Инструкция | Что должно работать |
|---|---|---|
| Управлять вкладками и читать страницы через MCP | [Browser MCP и расширение](docs/setup/браузер-mcp.prompt.md) | Node.js, локальный MCP-клиент, Chrome/Yandex с расширением |
| Медиатека, парсинг и external research | [Полный SC Desktop](docs/setup/sc-desktop.prompt.md) | Всё из первого варианта, Electron, Python и доступы к выбранным источникам |

```text
Browser MCP:
локальный AI → stdio MCP → loopback WebSocket → расширение → ваша вкладка

External research:
локальный AI / SC UI → Electron HTTP bridge → расширение → AI-сайт
                               ↑                  ↓
                         status + result ← сохранённый финал
```

Browser MCP работает без запущенного SC Desktop, Python, API-ключей и Noted Terminal. Это `list_tabs`, `snapshot`, `get_text`, `click`, `fill`, `evaluate` и другие операции с реальными вкладками. Его сервер — `mcp/browser/index.js`.

External research требует работающий SC Desktop и вход в выбранный AI-сайт. Прямой HTTP-вход доступен обычному локальному агенту; автоматическое возвращение результата в отдельную сессию Noted Terminal требует дополнительно совместимый Noted Terminal и его Terminal MCP. Настройка SC Desktop сама по себе этого не устанавливает. Обычный браузерный ChatGPT-чат не запускает локальный stdio-сервер по этому README; нужен локальный клиент с shell/MCP.

## Быстрый вход

Поддерживаемый здесь путь — macOS, Node.js 22.12+ из ветки 22, Git и актуальный Chrome либо Yandex. Для полного приложения нужен Python 3.10+. Проверка этого выпуска выполняется на macOS arm64; Windows/Linux и Intel Mac не проходят эту же приёмку.

```bash
git clone --depth 1 https://github.com/RevinFedor/sc-desktop.git
cd sc-desktop
npm ci --prefix mcp/browser
```

Загрузите папку `browser-extension/` через страницу расширений браузера → Developer mode → Load unpacked. Затем настройте локальный MCP-клиент по [первой инструкции](docs/setup/браузер-mcp.prompt.md). Корневой `npm ci` для этого варианта не нужен. В checkout уже есть собранная options page расширения.

Для полного приложения после установки расширения:

```bash
npm ci
npm run python:setup
npm run rebuild
npm run dev
```

Парсинг YouTube/медиа дополнительно использует `yt-dlp` и `ffmpeg` в PATH. Авторизации Telegram/Instagram, API-ключи ASR/embedding и доступные модели AI-сайта настраивает сам пользователь. Они не нужны для бесплатной проверки Browser MCP. `npm run python:setup` выбирает Python 3.10+ и сообщает об ошибке версии до установки; при необходимости задайте `SC_DESKTOP_SETUP_PYTHON` абсолютным путём.

## Сборка приложения

```bash
npm run build:app
```

Эта команда собирает renderer, расширение и локальный `.app` с ad-hoc подписью. До неё должны быть установлены `.venv` и Node-зависимости. Результат остаётся в `release/mac-arm64/SC Desktop.app` (на Intel путь другой); приложение не копируется в `/Applications` и не запускается автоматически. Это локальная сборка без notarization, а не готовый подписанный установщик для раздачи. После обновления ad-hoc сборки macOS может снова запросить доступы к папкам.

Старый `build:install` — отдельный режим разработчика: требует собственного сертификата для подписи, останавливает установленный SC Desktop и заменяет его в `/Applications`. Для первой установки по этим инструкциям используйте `dev` или `build:app`.

## Проверки

```bash
node --test mcp/browser/bridge.test.js
```

Это изолированная проверка stdio/WebSocket, защиты от browser origins, раздельных ответов клиентам и Native Messaging. В ней расширение подменено; она не доказывает загрузку настоящего расширения. В [инструкции Browser MCP](docs/setup/браузер-mcp.prompt.md) есть отдельное чтение локальной страницы через реальный браузер.

HTTP `GET http://127.0.0.1:53127/healthz` подтверждает только Electron bridge. Прочитанная страница подтверждает Browser MCP. Только согласованный Send провайдеру, подтверждённый терминальный статус и проверенный `result.text` подтверждают external research. Бесплатная установка не запускает модельный запрос автоматически.

## Данные и доступы

Рабочая медиатека, sessions и результаты находятся в `~/Library/Application Support/sc-desktop/`. Общие настройки сервисов читаются из `~/.config/sc/settings.json` или переменных окружения. Эти настройки, cookies, базы, ключи, экспорты, логи и скриншоты не входят в текущий публикуемый набор. [Пример MCP-конфига](.mcp.example.json) содержит placeholders; [список переменных](examples/credentials.env.example) не загружается автоматически.

Browser MCP получает доступ к реальному browser profile и широкие разрешения расширения, включая cookies и debugger. Устанавливайте его в выбранный вами профиль и подключайте только доверенного локального AI. WebSocket/HTTP listeners привязаны к `127.0.0.1`; не открывайте их в LAN или туннель в интернет. MCP-клиенты — локальные процессы, а веб-страницы не могут подключаться к командному WebSocket. Отсутствие SC Desktop не даёт Native Messaging-логам или research дополнительных возможностей.

## Для разработчика

Runtime-код Python находится в `python-workers/`, а не во внешнем CLI. Новая БД-схема должна быть согласована в `electron/database.js` и `python-workers/shared/library_db.py`. Electron main/preload требуют полного перезапуска вашего экземпляра; renderer обновляется через Vite. При активном research расширение откладывает reload до подтверждённого простоя — не обходите этот gate.

Optional-интеграции с Voice Record, GT Editor, YouGile и Noted Terminal требуют свои приложения/доступы и отдельно проверяются. Учебный словарь с синхронизацией использует Voice Record; установка одного SC Desktop не создаёт этот сервис.
