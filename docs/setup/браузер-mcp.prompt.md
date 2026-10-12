# Установи Browser MCP и расширение SC Browser Parser

Этот файл можно передать локальному AI, который умеет выполнять команды и настраивать MCP на вашем компьютере. Репозиторий: [RevinFedor/sc-desktop](https://github.com/RevinFedor/sc-desktop). Для Browser MCP не нужно запускать Electron, ставить Python или иметь Noted Terminal.

## Поручение AI

Установи и проверь Browser MCP по этой инструкции. Сначала прочитай актуальные `README.md` и `AGENTS.md` скачанного repo. Сам выполни clone, установку зависимостей, подготовку MCP-конфига и проверки. Используй реальный выбранный пользователем браузер. Сохрани существующие MCP-записи и пользовательские настройки; не заменяй конфиг целиком. Не покупай сервисы, не вызывай модели для проверки и не читай cookies/личные страницы ради smoke-теста.

GUI-шаги можешь выполнить через доступные разрешённые инструменты, проверяя фактическое состояние. Если нет GUI-доступа, нужны login/2FA либо macOS ещё не дала разрешение, сообщи пользователю конкретный шаг. Не обещай автоматическую выдачу OS permissions. Не перезапускай чужие активные browser/research-задания ради установки.

## Что понадобится

- macOS и Git; этот путь проверен на macOS arm64. Другие OS не входят в эту приёмку.
- Node.js 22.12+ из ветки 22. AI проверяет `node --version` и абсолютный путь исполняемого файла.
- Chrome или Yandex с разрешённой установкой unpacked расширений. Политика рабочего браузера может запретить Developer mode.
- Локальный AI-клиент с MCP stdio и доступом к этому компьютеру. Например, Codex CLI; один обычный чат на AI-сайте эти команды не выполнит.

API-ключи, Python, аккаунт ChatGPT и Native Messaging Host не нужны для базового чтения страниц. Расширение работает в реальном профиле с его правами; пользователь выбирает профиль и соглашается на разрешения.

## 1. Скачать исходники

Выбери постоянную папку, которую пользователь не удалит после установки. Пример из пустого каталога:

```bash
git clone --depth 1 https://github.com/RevinFedor/sc-desktop.git
cd sc-desktop
npm ci --prefix mcp/browser
```

Если checkout уже есть, сначала проверь remote, ветку и diff; не делай reset или pull поверх чужих правок. Не скачивай зависимости `cli-tools` или каталоги автора: расширение и standalone MCP уже находятся здесь. Корневой `npm ci` для Browser MCP не нужен.

## 2. Подключить расширение

Открой `chrome://extensions` в Chrome или `browser://extensions` в Yandex.

```text
Extensions
  Developer mode [ON]
  Load unpacked → <путь к checkout>/browser-extension/
  SC Browser Parser [ON] → Details → нужные разрешения
```

Выбирай именно `browser-extension/`, где лежит `manifest.json`, а не корень repo и не `mcp/browser/`. Публичный `manifest.key` — публичный ключ для стабильного extension ID, не API credential. Приватный RSA key создавать не требуется.

Для базовых `snapshot`/`get_text` обычных веб-страниц достаточно разрешений на сайты. `evaluate_raw` требует доступного `chrome.userScripts` и отдельного `Allow user scripts` в новых Chromium; на управляемом профиле переключатель может быть недоступен. Native macOS dialog recovery — дополнительная возможность, требует Xcode Command Line Tools и Accessibility у реального MCP-исполнителя. Отсутствие этих прав не мешает обычному DOM smoke-тесту.

Официальный Chrome путь установки: [Load an unpacked extension](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked).

## 3. Добавить standalone MCP

Обнаружь абсолютные пути к Node и checkout. В клиенте, принимающем `mcpServers`, добавь одну запись из [.mcp.example.json](https://github.com/RevinFedor/sc-desktop/blob/main/.mcp.example.json), заменив оба placeholders:

```json
{
  "mcpServers": {
    "browser": {
      "command": "/ABSOLUTE/PATH/TO/node",
      "args": ["/ABSOLUTE/PATH/TO/sc-desktop/mcp/browser/index.js"]
    }
  }
}
```

Для Codex CLI из корня checkout можно добавить запись через CLI, подставив обнаруженный абсолютный Node path:

```bash
codex mcp add browser -- /ABSOLUTE/PATH/TO/node /ABSOLUTE/PATH/TO/sc-desktop/mcp/browser/index.js
codex mcp list
```

Если `browser` уже настроен, сравни запись и меняй только её при необходимости. Переподключи MCP/обнови список инструментов поддерживаемым способом клиента. Конкретный путь JSON/TOML зависит от клиента; не создавай произвольный конфиг, который он не читает. Для Codex поддерживаются CLI и `[mcp_servers.browser]` в TOML: [официальная документация MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

```text
AI-клиент запускает index.js (stdio)
              ↓
bridge.js — общий процесс, auto-start
  127.0.0.1:3458 ← локальные MCP-клиенты
  127.0.0.1:3457 ← SC Browser Parser
              ↓
          реальные вкладки
```

Отдельный HTTP-хаб Noted Terminal на `53133` не нужен. Browser bridge остаётся работать после выхода AI-клиента. Не запускай второй bridge на занятых портах и не останавливай существующий без проверки владельца. При переносе checkout обнови абсолютный путь в MCP-конфиге и путь загруженного расширения.

## 4. Проверить без моделей и личных данных

Сначала изолированный transport-тест:

```bash
node --test mcp/browser/bridge.test.js
```

В нём расширение подменено тестовым WebSocket-клиентом. Это проверка кода и зависимостей, не вашей browser-установки.

Затем запусти локальную страницу из checkout, сохрани PID/сессию процесса:

```bash
node scripts/browser-smoke-page.cjs
```

Команда печатает `[BrowserSmoke] http://127.0.0.1:<свободный-порт>/`. Через настроенный Browser MCP:

1. Вызови `list_tabs`; убедись, что это выбранный реальный браузер. Не публикуй список личных вкладок.
2. Открой напечатанный URL через `new_tab({url,background:true})` и сохрани возвращённый `tabId`.
3. Вызови `snapshot({tabId})` и `get_text({tabId,selector:"#sc-smoke"})`.
4. Ожидай точный текст `SC_BROWSER_MCP_SMOKE_READY`. ACK открытия или наличие инструмента в каталоге недостаточны.
5. Закрой только созданную тестовую вкладку и останови только созданный сервер.

AI сообщает: commit checkout, версия Node, настроенный MCP-клиент, подтверждённое имя расширения и точный результат чтения. Если чтение не прошло, установка ещё не проверена. Успех этой проверки не подтверждает external research; для него нужна [полная установка](https://github.com/RevinFedor/sc-desktop/blob/main/docs/setup/sc-desktop.prompt.md).

## Дополнительно: файл exporter-логов

Native Messaging Host нужен только для файловых логов экспортера. По желанию:

```bash
node browser-extension/nmh/setup.js --dry-run
node browser-extension/nmh/setup.js
```

Installer использует публичный ID, не меняет manifest и не создаёт signing private key. Wrapper и логи находятся в `~/Library/Application Support/sc-desktop/browser-mcp/`; browser host manifests — в стандартных `NativeMessagingHosts` каталогах Chrome/Yandex. После переноса repo или Node повтори setup. Для других Chromium этот installer не регистрирует host автоматически.

## Если инструмент не ответил

Сначала установи, что реально произошло: проверь URL/наличие своей вкладки через `list_tabs`, bridge log `~/Library/Application Support/sc-desktop/browser-mcp/bridge.log` и статус расширения. Пустой результат selector может означать отсутствие элемента; это не доказательство сбоя канала.

Первый MCP-вызов может попасть на auto-start bridge: дождись маркера подключения и повтори read-only вызов. `Extension not connected` означает отсутствие канала к расширению, а не необходимость установить Electron. Без SC Desktop его дополнительный auto-wake недоступен: открытие toolbar popup может разбудить SW. Native alert/confirm требует dialog tools, а не повтора предыдущего клика. Если Chromium отключил расширение за слишком частые reload, проверь ошибку и toggle off/on; не запускай reload-loop. При active research дождись завершения и не обходи persistent reload gate.
