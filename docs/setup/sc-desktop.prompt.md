# Установи SC Desktop с external research

Этот файл можно передать локальному AI с доступом к shell и браузеру вашего компьютера. Исходники: [RevinFedor/sc-desktop](https://github.com/RevinFedor/sc-desktop). Нужна полноценная Electron-медиатека с локальными Python workers, расширением и внешними AI-запросами. Если требуется только чтение вкладок через MCP, достаточно [инструкции Browser MCP](https://github.com/RevinFedor/sc-desktop/blob/main/docs/setup/браузер-mcp.prompt.md).

## Поручение AI

Скачай актуальный repo, прочитай `README.md`/`AGENTS.md` и самостоятельно установи зависимости, расширение, Browser MCP и SC Desktop. Используй пути этого компьютера. Сохрани существующие настройки, credentials, пользовательские данные и чужие рабочие процессы. Проверяй результат каждого существенного шага. Не запускай `build:install` для первого знакомства: он останавливает/заменяет установленный app и требует собственного signing certificate.

Установка включает бесплатные проверки. Не отправляй промпт AI-провайдеру, не транскрибируй платным API и не строй платные embeddings до отдельного согласованного теста. Пользователь сам вводит login/2FA и credentials; не проси вставить их в AI-чат. GUI-шаги выполни доступными разрешёнными инструментами. Если OS permissions/login или отсутствие GUI-доступа требуют участия человека, назови конкретный шаг и продолжай независимую подготовку.

## Зависимости и владельцы

| Возможность | Обязательная часть | Что добавляет пользователь |
|---|---|---|
| Приложение, история и локальная медиатека | macOS, Git, Node.js 22.12+ из ветки 22, Python 3.10+, Node/Python dependencies | Разрешения на выбранные файлы/папки |
| Browser MCP | Локальный stdio MCP-клиент и Chrome/Yandex с SC Browser Parser | Выбор browser profile и разрешения расширения |
| YouTube/TikTok/обработка медиа | `yt-dlp`, `ffmpeg` в PATH | При необходимости авторизованный browser profile |
| Telegram | Собственные Telegram API ID/hash и Telethon session | Login, код/2FA в Settings → Telegram |
| Instagram/Boosty/другие источники | Backend выбранного источника | Свой login/cookies/API token, если backend этого требует |
| ASR/embedding | Настроенный выбранный движок | Собственный API key, деньги/квота и явное согласие на запуск |
| External research | Работающий Electron bridge, расширение, доступ к выбранной модели AI-сайта | Login на сайте и согласованный расход квоты |
| Completion в Noted Terminal | Отдельно установленный совместимый Noted Terminal и Terminal MCP | Проверка его live tools; SC не устанавливает его автоматически |

В этой инструкции проверяемая платформа — macOS arm64. Intel/Windows/Linux не проходили такую же приёмку. Xcode Command Line Tools могут потребоваться для native Node modules и дополнительных native-dialog tools. Для PDF text/OCR нужны отдельно `poppler`/`tesseract` и необходимые языковые модели. Voice Record для синхронизации учебного словаря, GT Editor и YouGile — optional отдельные интеграции; не устанавливай их молча.

## 1. Скачать и подготовить

Если нет checkout:

```bash
git clone --depth 1 https://github.com/RevinFedor/sc-desktop.git
cd sc-desktop
npm ci
npm ci --prefix mcp/browser
npm run python:setup
```

Python setup ищет подходящий `python3`, включая стандартные Homebrew-пути. Проверяет Python 3.10+ и не удаляет старую `.venv` автоматически. Если выбрана неправильная версия, задай `SC_DESKTOP_SETUP_PYTHON` абсолютным путём к своему Python; несовместимую `.venv` сначала перенеси в резервную папку. Не полагайся на `/usr/bin/python3`: на macOS он может быть 3.9.

Собственные Node и Python зависимости ставятся в этом checkout. Внешние `cli-tools`/SaliTools не нужны. Недостающие `yt-dlp`/`ffmpeg` AI устанавливает обычным package manager; при наличии Homebrew пример — `brew install yt-dlp ffmpeg`. Установка Python/Node и Command Line Tools выполняется только если они отсутствуют и доступны штатным способом на этом Mac.

Бесплатная проверка зависимостей и transport:

```bash
.venv/bin/python3 -c 'import telethon, requests, PIL, assemblyai, youtube_transcript_api, browser_cookie3, playwright; print("Worker imports OK")'
npm run test:setup
```

`test:setup` использует тестовое расширение, отдельные порты и временные файлы. Он не запускает AI-сайт и не проверяет login/платную транскрипцию.

## 2. Расширение и реальный Browser MCP

Пройди [инструкцию Browser MCP](https://github.com/RevinFedor/sc-desktop/blob/main/docs/setup/браузер-mcp.prompt.md): загрузка `browser-extension/`, запись `mcp/browser/index.js` в локальном клиенте и чтение `SC_BROWSER_MCP_SMOKE_READY` с локальной страницы. Для этой части не нужен SC Desktop. Native Messaging installer для exporter-логов optional.

В full-варианте расширение понадобится research и browser-based источникам. Перед ними пользователь входит на нужный сайт в этом же profile. Не используй чужие sessions/cookies и не меняй модель локального AI ради установки.

## 3. Запустить приложение

После Node install, перед первым Electron запуском:

```bash
npm run rebuild
npm run dev
```

`rebuild` собирает `better-sqlite3` под Electron ABI. Vite слушает `5156`, Electron открывает приложение. Если порт занят, выясни, кто его использует; не убивай все Electron/Vite процессы по общему имени. Сохрани собственный PID/сессию dev-процесса для точечного завершения.

```text
SC Desktop
  Settings → Telegram / настройки нужного источника → свой login и доступы
  Main → External Research → история / параметры сохраняемого Chat
  медиатека / Activity → задания и результаты

Electron main
  127.0.0.1:53127 — HTTP research bridge
  127.0.0.1:53129 — безопасный extension reload/keepalive
```

Проверка bridge без модельного запроса:

```bash
curl --fail --max-time 5 http://127.0.0.1:53127/healthz
```

Ожидается JSON с `ok:true`. Это подтверждает listener, но не authorizations, provider Send или финал. Vite hot reload действует на renderer; main/preload меняются только после перезапуска вашего экземпляра. Active research откладывает extension reload до подтверждённого простоя.

Credentials читаются из process environment или `~/.config/sc/settings.json`. [Список переменных](https://github.com/RevinFedor/sc-desktop/blob/main/examples/credentials.env.example) — пример с пустыми значениями, не auto-loaded `.env`. Не копируй пустой пример поверх уже настроенного settings.json. Apify token настраивается в Instagram Settings / `instagram.apify_token` общего settings.json. Не все источники/движки требуют все ключи; Browser MCP и browser ChatGPT research не требуют OpenAI API key.

## 4. External research через обычного локального AI

Noted Terminal не обязателен для прямого HTTP-входа. Он добавляет свой durable run и автоматическую доставку completion; обычный локальный агент сохраняет SC `requestId`, читает status и получает результат сам.

```text
согласован один provider-turn
  → JSON с requestId, provider, prompt, options
  → POST /research-start
  → сохранён id; расширение открывает/настраивает свою вкладку
  → проверена отправка → GET /research-status того же id
  → done + result.text → AI читает ответ и проверяет его
```

До платного/квотного теста остановись на бесплатных проверках. Для одобренного запуска подготовь локальный request-файл по [примеру](https://github.com/RevinFedor/sc-desktop/blob/main/examples/research-request.example.json). Замени `requestId` новым UUID с префиксом и сохрани файл **до** отправки. Записывай prompt/files только в локальный рабочий каталог; не коммить их.

В примере явно выбраны `provider:"chatgpt"`, `mode:"chat"`, `model:"5.6-sol"`, `effort:"medium"`. Это selector-коды реализации, не обещание доступности модели на вашем account. Сверь доступный UI/код и выбранную пользователем модель; если она отсутствует, не заменяй её и не запускай дорогой fallback. `temporaryChat:false` оставляет беседу в истории, `autoClose:true` закрывает только служебную вкладку после подтверждённой записи результата. Work/Pro требуют отдельного решения о квоте.

После согласования можно отправить подготовленный файл:

```bash
curl --fail-with-body --max-time 30 \
  -H 'Content-Type: application/json' \
  --data-binary @/ABSOLUTE/PATH/TO/research-request.local.json \
  http://127.0.0.1:53127/research-start
```

Сохрани вернувшийся `id`. Для проверки/ожидания используй **тот же** id; long-poll возвращается по смене состояния или через максимум 60 секунд:

```bash
curl --fail-with-body --max-time 65 \
  'http://127.0.0.1:53127/research-status?id=YOUR_SAVED_ID&wait=60000'
```

Если `status` ещё `queued/running`, продолжай наблюдать тот же запрос. При timeout POST сначала проверь status по заранее сохранённому requestId. Повтор допускается только с тем же ID и неизменным исходным JSON; конфликтующий ID сервер отклоняет. Не создавай второй запрос, потому что первый долго думает или потерял ACK.

Реальная приёмка: подтверждён новый user-turn/отправка, job дошёл до `done`, `result.text` содержит ожидаемый ответ, URL соответствует той же беседе. Для тестового prompt ожидается `SC_RESEARCH_OK`. `queued`, открытая вкладка, Send ACK, healthz или подставленный fixture-ответ такую приёмку не заменяют. `error` требует прочитать `stage/error` и установить, был ли запрос реально отправлен, до решения о следующем ходе.

Для следующего одобренного вопроса в сохранённую беседу используй новый requestId и `conversationUrl` из прежнего результата. `files:[{"path":"/absolute/approved/source.md","startLine":1,"endLine":80}]` прикладывает явно выбранные исходники в Chat mode; путь только в тексте prompt файл не передаёт. До 20 файлов идут отдельно, большие текстовые наборы bridge упаковывает с сохранением имён/границ; локальные limits и provider-context не равны гарантии прочтения всех строк. Не расширяй доступ на весь диск.

Уже готовый ChatGPT `/c/<id>` можно читать без нового Send через отдельный import-flow: `options.readOnlyImport:true` и `conversationUrl` в `/research-start`, с новым requestId и служебным непустым prompt, который import-ветка не отправляет. Это чтение существующего доступного финала; незавершённый ход не считается ответом. При наличии совместимого Noted Terminal вместо ручного HTTP используй его `start_external_research`, `continue_external_research` и `import_external_conversation`; проверь live schema. Не обещай эти tools только по установке SC Desktop. Отслеживаемый Terminal run возвращает уведомление исходной сессии отдельно от SC job; не заменяй его polling-ом скрыто.

ChatGPT — основной описанный provider. Код других AI-сайтов присутствует, но их текущая авторизация/селекторы и real Send/result не подтверждены этим install-тестом. Не выбирай их как автоматический fallback.

## 5. Локальная .app по желанию

Из подготовленного checkout:

```bash
npm run build:app
```

Команда создаёт `release/mac-arm64/SC Desktop.app` на arm64 и не устанавливает/не запускает его. AI проверяет фактический путь. Пользователь может открыть эту локальную сборку и при желании скопировать её в `/Applications`, не заменяя чужую установленную версию без решения. Это ad-hoc signature, без Apple notarization; OS trust/доступы могут потребовать ручного подтверждения. Не отключай Gatekeeper глобально. Такой bundle собран с Python этого Mac; перенос на другой компьютер не входит в проверку. Для передачи другим людям используй source+инструкцию.

## Что должно быть в отчёте AI

Назови commit, версии Node/Python, путь checkout, результат импорта worker-зависимостей, реального Browser MCP чтения и `healthz`. Отдельно укажи, был ли вообще согласован и выполнен настоящий provider Send/result. Если были только сборка и fixture, так и напиши. Login, оплачиваемые API, полномасштабный парсинг и установка на другом Mac не подтверждаются build-тестом.
