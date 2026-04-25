# CDP Testing — workflow для AI-агента

Полуавтоматический способ end-to-end проверять Electron-приложение из CDP без headless-режима. Renderer открыт реальным окном на экране пользователя, я через DevTools-протокол читаю/жму DOM и снимаю скриншоты.

## Запуск Electron с открытым CDP-портом

```bash
(npx concurrently "npx vite" \
  "npx wait-on http://localhost:5156 && NODE_ENV=development npx electron . --remote-debugging-port=9222" \
  > /tmp/sc_dev.log 2>&1 &)
```

`--remote-debugging-port=9222` поднимает HTTP+WebSocket эндпоинты:
- `GET http://localhost:9222/json` — список targets, я нахожу renderer по `url=localhost:5156/`.
- `webSocketDebuggerUrl` каждого target — туда WS-подключение для команд.

Готовность ловлю через Monitor:
```bash
until curl -sf http://localhost:9222/json >/dev/null 2>&1; do sleep 1; done
```

## Helper `/tmp/cdp.js`

~80 строк, использует `ws` из node_modules проекта. Две команды:

```bash
node /tmp/cdp.js eval '<expression>'   # Runtime.evaluate, JSON-result
node /tmp/cdp.js shot /tmp/x.png        # Page.captureScreenshot
```

Возвращает `{ value, type }` или `{ error }`. `awaitPromise: true` обязателен для async-кода — иначе получишь `{ type: "object" }` от Promise-объекта.

## Что делаю через `Runtime.evaluate`

Renderer'у через preload пробрасывается `window.api.*` — я дёргаю IPC напрямую, без curl-ов в Python-скрипты:

```js
window.api.jobDetail(29).then(j => ({ type: j?.type, status: j?.status }))
window.api.tkBatchTranscribe({ video_ids: ["..."], source_id: 12, engine: "gemini" })
window.api.itemsList({ source_id: 12, limit: 10, type: "video" })
```

Плюс DOM-query для UI-проверок:

```js
// Кнопка по тексту — устойчиво к layout-сдвигам
const btn = Array.from(document.querySelectorAll("button"))
              .find(b => b.textContent.trim() === "Спарсить")
btn.click()  // React реагирует одинаково на программный и человеческий клик

// Установка значения в input через React-friendly setter
const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set
setter.call(input, "https://...")
input.dispatchEvent(new Event("input", { bubbles: true }))

// Breadcrumb-проверка
Array.from(document.querySelectorAll(".h-10.border-b button, .h-10.border-b span"))
  .map(e => e.textContent.trim())
  .filter(t => t && !["⌂","⚡ Activity","⚙","›"].includes(t))
```

## Скриншоты

```js
node /tmp/cdp.js shot /tmp/sc_NN_label.png
```

Потом `Read` тулза показывает PNG визуально (multimodal). Закрывает «фон тёмный? кнопка справа? padding нормальный?» без диалога с пользователем.

## Логи параллельно

`logs/dev.log` — Electron туда пишет всё с `[Tag]`-префиксом. Через Monitor стримлю интересующие события:

```bash
tail -F /Users/fedor/Desktop/sc-desktop/logs/dev.log \
  | grep --line-buffered -E "\[Jobs\] (start|end) tk_|tk_batch"
```

Так ловлю «job стартанул», «job закрылся» без опроса CDP.

## Ограничения

- **Нет headless** — окно физически открывается на экране пользователя и видно в Dock'е.
- **Не вижу анимаций** — только статичные кадры (snapshot до/после).
- **Не ловлю race-condition'ы человеческой скорости** — клики через `.click()` синтетические, не настоящие mouse events.
- **Реальные `mousedown`/`hover`-баги** не воспроизводятся (focus-rings, dropdown'ы которые закрываются на blur).
- **Electron может закрыться** во время теста (пользователь сам или crash) — каждый `eval` падает с exit 1, проверять `lsof -ti tcp:9222` и перезапускать.

## Цикл одного теста

1. `cdp.js eval` — DOM-действие или прямой IPC.
2. Подождать (`sleep 0.3` для UI re-render, или Monitor на event в `dev.log`).
3. `cdp.js shot` + `Read /tmp/x.png` — визуальная проверка.
4. `cdp.js eval` — DOM-предикат (текст breadcrumb, число выбранных, наличие класса).

За минуту прогоняю 10–15 шагов end-to-end (paste → fetch → picker → transcribe → JobDetail → Copy → проверить буфер). Не замена ручному QA на нюансы — баги «нажал и оно дёрнулось» нужен пользователь.

## Когда НЕ применять

- Любая правка в `electron/main.js` / `electron/preload.js` / `job-runner.js` требует **полного рестарта Electron** (HMR не работает на main process). Прогонять старый CDP-порт будет давать `Exit code 1` без понятной ошибки.
- Запуск платных операций (Gemini, Apify, AssemblyAI) — проверять стоимость заранее, использовать самые короткие видео (<30 сек у TikTok = $0.0001).
