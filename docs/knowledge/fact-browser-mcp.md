# Browser MCP — управление браузером для Claude Code

## Зачем существует

Расширение SC Browser Parser умеет работать в **реальном** браузере
пользователя — настоящий профиль, настоящие cookies, `navigator.webdriver = false`,
без CDP-артефактов. Через WebSocket-bridge оно подключается к локальному
MCP-серверу, через который Claude Code управляет браузером по MCP-протоколу
(парсинг AI Studio, LinkedIn, YouTube, Cloudflare-сайтов, Google-форм и т.п.).

Этот канал — **dev-only по природе**: SC Browser Parser сам по себе
вспомогательный инструмент к sc-desktop, не дистрибутируется конечным
пользователям, не имеет прод-сборки. Никакого стриппинга dev-only кода
не нужно (исторически в hh-tool оно было, потому что тот же extension
имел prod-вариант для конечных юзеров).

## Архитектура (3 процесса)

```
Claude session ─(stdio)→ mcp/browser/index.js ─(WS:3458)→ bridge.js ─(WS:3457)→ Browser Extension → DOM
```

- **`mcp/browser/index.js`** — per-session, спавнится Claude'ом через
  MCP stdio. Сколько активных Claude-сессий, столько копий index.js.
- **`mcp/browser/bridge.js`** — singleton на машине. Один процесс
  обслуживает все сессии. Слушает 3457 (для расширения, единственный WS)
  и 3458 (для MCP-клиентов, много WS).
- **`browser-extension/mcp-handlers.js`** — подключается через
  `importScripts('mcp-handlers.js')` в `background.js`. Единственный
  клиент 3457; при connect отдаёт расширение в распоряжение всех
  подключённых MCP-клиентов.
- **`browser-extension/mcp-content.js`** — content-script, инжектится
  динамически через `chrome.scripting.executeScript({ allFrames: true })`
  из service worker'а **на любой сайт** при первом MCP-tool call'е,
  требующем DOM-доступ. В manifest он не прописан.

## Окна браузера и OAuth popup

Google OAuth и похожие входы открывают не «особую модалку внутри вкладки», а
отдельное top-level окно браузера со своей активной вкладкой. В состоянии с
несколькими окнами у основной страницы и popup одновременно может быть
`active: true`: это активность **внутри своего окна**, а не доказательство
системного фокуса. Старый `list_tabs` фактически видел вкладку popup через
`chrome.tabs.query({})`, но выбрасывал её `windowId` и возвращал плоский список —
агент не мог отличить основное окно от второго и адресовать их детерминированно.

Источником правды служит `chrome.windows.getAll({ populate: true })`, а не
`currentWindow`: для service worker последнее означает последнее активное окно и
может не совпадать с тем, которое агент считает основным. `list_windows`
сохраняет группировку по окнам, а `list_tabs` отдаёт рядом с вкладкой `windowId`,
тип и фокус окна, плюс `openerTabId`, когда браузер его сохранил. После discovery
DOM-команды (`snapshot` / `click` / `fill` / `evaluate`) всегда получают явный
`tabId`; фокусировка и закрытие окна — явный `windowId`. `openerTabId` только
подсказка: у окна, созданного самим extension API, он законно `null`, а
page-level `window.opener` может быть разорван политикой COOP.

**Граница hot-reload.** `mcp-handlers.js` живёт в расширении, поэтому изменение
существующей команды применяется после горячей перезагрузки: уже открытый
`list_tabs` сразу начал возвращать оконные поля. Но регистрации инструментов и
их схемы находятся в личном `mcp/browser/index.js` и фиксируются при MCP
`initialize`. Новые имена (`list_windows`, `new_window`, `focus_window`,
`close_window`) появляются только в новой или переподключённой MCP-сессии. Если
старое имя уже показывает новые поля, а нового имени ещё нет, это ожидаемая
граница процессов, не частично применившийся фикс.

**Повторяемый smoke-тест без выдачи OAuth-доступа:** открыть `new_window` типа
`popup` на `https://accounts.google.com/AccountChooser?continue=https%3A%2F%2Fwww.google.com%2F&hl=en`;
`list_windows` должен показать normal + popup
с разными `windowId`, причём обе вложенные вкладки могут иметь `active: true`, но
только одно окно — `focused: true`. Затем сфокусировать normal-окно и прочитать в
popup по его `tabId` заголовок `Choose an account`: это доказывает независимый
DOM-доступ в фоне. В конце закрыть только popup по `windowId` и повторным
`list_windows` доказать, что тестовое окно исчезло, а основное осталось.

## Auto-spawn bridge

`index.js` при старте пробует TCP-подключение к `127.0.0.1:3458`.
Если порт пуст — спавнит `bridge.js` через
`spawn(node, [bridge.js], { detached: true, stdio: ['ignore', logFd, logFd] })`
+ `child.unref()`. Логи: `/tmp/hh-extension-bridge.log` (имя сохранено
по историческим причинам — менять не стали, чтобы не плодить файлов).

**Почему именно так:**
- Bash tool в Claude убивает детей при завершении (родительский shell
  умирает → SIGHUP → дети умирают). Простой `node bridge.js &` из Bash
  → bridge мрёт сразу.
- `detached: true` + `unref()` отвязывает процесс от родителя
  (PPID становится 1/launchd) — bridge переживает любую Claude-сессию,
  не нужен launchd plist.
- **Race условие:** при одновременном старте N сессий каждая делает
  `net.createConnection({port: 3458})`. Первая получает ECONNREFUSED →
  спавнит. Параллельные тоже получат ECONNREFUSED и тоже попробуют
  спавнить — но второй+ `WebSocketServer({port: 3457})` упадёт с
  EADDRINUSE и тихо умрёт. Победитель один, остальные подключаются как
  клиенты.

## Завершение сессии и брошенные процессы

Личный `index.js` должен завершаться вместе со своей Claude/Codex-сессией:
обрыв stdin или системный сигнал запускает единый shutdown. До выхода он
отменяет запланированное переподключение, закрывает только своё соединение с
bridge и отклоняет незавершённые команды. Это важно в таком порядке: иначе
закрытие собственного WebSocket снова запланирует reconnect, а процесс с уже
мёртвым родителем останется жить под PPID 1 и будет накапливать память после
каждого закрытия сессии.

`bridge.js` — отдельный намеренно отвязанный singleton: его не останавливают
при закрытии личной сессии, иначе все остальные сессии потеряют доступ к
браузеру. Регрессию проверять отдельным `index.js` с закрываемым stdin: он
должен выйти с кодом 0, а PID bridge остаться прежним. Старые накопившиеся
сироты после установки фикса чистить разово только по двум признакам вместе:
PPID 1 и точный путь к `mcp/browser/index.js`; не убивать все `node` и не
трогать bridge.

## MV3 SW idle keep-alive (chrome.alarms-pulse)

Chrome MV3 service worker засыпает через ~30 секунд idle. WebSocket
connection сам по себе **не считается активностью** — recv'ы по WS не
сбрасывают idle-таймер. Без защиты SW засыпает с открытым WS, bridge
видит close, при следующем MCP-tool call'е получает «Extension not
connected».

Симптом без фикса: первый tool call после паузы > 30 сек проваливается;
часто видится сразу после перезагрузки расширения если юзер сразу не
кликнул на иконку SC Browser Parser в попап-bar.

Решение в `mcp-handlers.js` — `chrome.alarms.create('sc-mcp-keepalive', { periodInMinutes: 0.42 })`
(0.42 мин ≈ 25 сек, короче 30s SW-timeout'а). Pulse handler дёргает
`chrome.runtime.getPlatformInfo()` (cheap, без побочных эффектов) — этого
достаточно чтобы reset'нуть idle-таймер. Alarm стартует на `ws.onopen`
и stop'ается на `ws.onclose` — не жжёт ресурсы при мёртвом bridge'е,
которому всё равно нечего обслуживать.

Параллельные расширения с собственными alarm'ами для других нужд
(YouTube tracker `sc-yt-poll` с 0.1 мин периодом) дают тот же побочный
эффект, поэтому keep-alive нужен только когда нет других активных
alarms — на случай когда юзер закрыл все YouTube-вкладки и SC Browser
Parser идлит без своих job'ов.

## Multi-session safety: commandId rewrite

В `index.js` есть локальный счётчик `let commandId = 0`. Если две
Claude-сессии параллельно посылают команду — обе шлют `commandId: 1`.
Без защиты в bridge `pendingCommands.set(1, {mcpSocket: A})` затирался бы
вторым `pendingCommands.set(1, {mcpSocket: B})`, ответ от расширения
уходил бы только B.

Bridge переписывает входящий `commandId` на свой `bridgeCommandSeq`
(глобальный по процессу), хранит маппинг `bridgeId → {mcpSocket, originalId}`,
на ответе восстанавливает `originalId` перед отправкой клиенту. Расширение
видит только `bridgeId`, клиенты видят только свой локальный id, сессии
не пересекаются.

Тот же ремап используется при `extensionWs.close` — отказ рассылается
каждому клиенту с **его** id, не с `bridgeId`.

## Reconnect leak (исторический шрам)

**Симптомы:**
- `kernel_task` стабильно 250-300% CPU
- Шумят кулеры на простаивающем Mac
- `lsof -i :3458` показывает 80K closed sockets в одном процессе
- Несколько часов после старта Claude-сессий без активности

**Причина:** старая версия `index.js` имела два бага:
1. Reconnect не дедуплицировался: `ws.on('close')` → `setTimeout(connect, 3000)`
   И `ws.on('error')` → `setTimeout(connect, 3000)`. Оба обработчика
   срабатывали на каждой неудачной попытке → удвоенный темп reconnect'ов.
2. Не было backoff: 20 reconnect/мин стабильно, при мёртвом bridge.
3. `ws` не закрывался явно при failed connect → CLOSED-сокет висел в
   таблице ядра до GC.

× 6 параллельных Claude-сессий × несколько часов = десятки тысяч CLOSED
TCP-сокетов на машине, ядро тратит CPU на их учёт.

**Фикс:** `reconnectScheduled` флаг (дедуп close+error), exponential
backoff 3→6→12→24→60 (cap), `ws.removeAllListeners() + ws.terminate()`
при close/error.

**Защита от регрессии:** НЕ убирать backoff "для скорости подключения" —
без bridge оно бесконечно. НЕ возвращать парные обработчики close+error
без флага.

## Frame routing gotcha

`chrome.tabs.sendMessage(tabId, command)` **без** `frameId` — broadcast:
сообщение уходит во все content-script'ы (main frame + все iframe),
Promise резолвится **первым** ответом.

На страницах хотя бы с одним iframe (AI Studio имеет служебный
`bscframe`, у Google везде) первым обычно отвечает iframe — content-script
инжектится во все frames одновременно через
`executeScript({ allFrames: true })`. Если искомый элемент в main frame,
iframe ответит `{success: false, error: "Element not found"}` → main
даже не получит шанса.

**Симптомы:**
- harvest_list / scroll_element / wait_for_selector says
  "Container not found" / "Element not found"
- evaluate (DSL) на той же странице с тем же селектором находит элемент
- интермиттенс на сайтах с iframe'ами (Google, любые embed'ы)

**Фикс:** все CS-команды в `mcp-handlers.js` шлют с `{frameId: 0}`
(main frame). Sub-frame iteration оставлен как fallback для случаев
когда контент реально в iframe (LinkedIn модалки).

Исключение — `mcp_inspect`/`mcp_act` (см. «v2 Page Interaction»): они
возвращаются **строго с frame 0 без fallback'а**. Сами проходят shadow/iframe
из верхнего документа, а fallback ниже считает любой `success:false` поводом
«пробуй другой фрейм» и в конце отдаёт только `result.error` — structured-конверт
(`status:ambiguous` + candidates + suggestions) при этом схлопнулся бы в голый
`{success,error}`.

## Arbitrary JS: почему `chrome.userScripts`, а не `chrome.scripting`

`evaluate_raw` нужен на CSP-locked сайтах (AI Studio, банки, любые
SPA с `script-src 'self'` без `unsafe-eval`). Что пробовали:

1. **`new Function(code)` в content-script (mcp-content.js)** — провалилось.
   Content-script запускается в isolated world, **но** `new Function`
   всё равно проверяется CSP страницы. На AI Studio падает с
   `Evaluating a string as JavaScript violates the following Content
   Security Policy directive`. Удалили.

2. **`chrome.scripting.executeScript({ world: 'ISOLATED', func: ... })`** —
   выглядело правильно, по интуиции isolated world должен игнорировать
   CSP. **Не игнорирует.** Если внутри `func` есть `new Function(code)` —
   падает с тем же CSP-error. Откатили.

3. **`chrome.userScripts.execute({ world: 'USER_SCRIPT' })`** — сработало.
   Это API специально для extension'ов, которые хотят запускать
   произвольный пользовательский код, отдельный мир с **разрешённым eval**
   независимо от CSP страницы.

**Цена:** требует Chrome 138+ И однократного toggle "Allow user scripts"
на странице деталей расширения (`chrome://extensions/?id=...`). Это
намеренное ограничение Chrome — extension не может включить себе сам
через API, пользователь должен явно согласиться (security disclaimer).
Без toggle `chrome.userScripts === undefined`, `evaluate_raw` отдаёт
явную ошибку с инструкцией.

**Когда что использовать в коде:**
- Произвольный JS / чтение state / обход CSP → `evaluate_raw`
- Простой селектор+чтение → `evaluate` (DSL `{selector, extract}`) —
  работает без toggle, не требует userScripts permission
- Клик/fill индексированного элемента → `evaluate` DSL `{click/fill, index}`

## hover — синтетический, не trusted

`mcp_hover` диспатчит pointerover/mouseover/pointerenter/mouseenter/
pointermove/mousemove на элемент. Это работает для:
- CSS `:hover` стилей,
- JS-listener'ов на mouseover/mouseenter/pointerover,
- Tippy/Popper/MUI tooltip'ов,
- любого UI который полагается на event-bubbling в DOM.

Это **НЕ** будит trusted-only поведение — например, **YouTube
inline-preview видео** активируется только от настоящих ОС-events
(`Input.dispatchMouseEvent` через CDP). Из расширения без `chrome.debugger`
permission такое отправить невозможно. Если нужен такой trusted hover —
отлаживать руками юзера или временно поднимать `chrome-devtools` MCP
(headless Chrome без юзерского профиля).

**Radix submenu в hover-mode тоже не открывается** под `mcp_hover`. На
старом Radix v1 submenu trigger реагировал на `pointermove` с intent-delay
— наш synthetic pointermove dispatch'ит, но Radix внутри проверяет
последовательность move-events и не считает её «человеческой». В новой
base-ui v2 (которую claude.ai использует на 2026-05) submenu trigger
переключился на **click-mode** — `mcp_click` штатно открывает. Если столкнулся
с «hover не помогает открыть submenu» — проверь принимает ли trigger click;
если да (как в текущей claude.ai), переключи content-script с hover на
`.click()`. Конкретный кейс: `fact-claude-autoscrape.md::Submenu trigger
открывается на CLICK, не hover`.

## v2 Page Interaction: anchors, shadow/iframe inspect, ambiguity guard

Поверх старого `mcp_snapshot`/`mcp_click`/`mcp_fill` (CSS-path + первый-матч)
добавлены две команды — `mcp_inspect` и `mcp_act` (портировано по духу из
референса `packages/BrowserPowers`, ADR-001). Решают три слабости старого слоя:
хрупкий CSS-path, молчаливый клик по первому из N совпадений, голый `{success,error}`.

**Анкеры вместо селекторов.** `mcp_inspect` возвращает интерактивные элементы как
`a1/a2/…` и держит в module-scope **живую ссылку на узел**, не селектор. Перерезолвить
нечего (ссылка уже на элемент), а `el.isConnected` даёт детект протухания бесплатно:
удалили элемент со страницы → `act` по его анкеру вернёт `ANCHOR_STALE`, а не промах.
Стор чистится сам на навигации (новый документ → скрипт ре-инициализируется), плюс
у inspect есть `epoch`-счётчик. Это убирает и токены (короткий `a3` вместо длинного
пути), и хрупкость к рестайлу вёрстки.

**Сканер проходит shadow DOM и same-origin iframe.** Старый `buildSnapshot` видел
только light DOM — кнопки внутри open shadow root (web-component SPA) и внутри iframe
для него не существовали. Новый рекурсивный обход (`__scanRecords`, depth-guard 12)
заходит в `el.shadowRoot` и `iframe.contentDocument`, помечает находки `where:'shadow'|'iframe'`.
CSS-селектор границу shadow не пересекает в принципе — поэтому для таких элементов
единственный путь действия это анкер либо смысловой таргет.

**Structured targets — по смыслу, не по адресу.** `mcp_act` принимает `anchor` |
`{role,name}` | `{text}` | `{label}` | `{placeholder}` | `{testId}` | `{css}` | legacy
`selector`. Смысловой таргет (видимое имя/роль) переживает редизайн вёрстки, когда
CSS-путь уже сломался. Резолвер семантических таргетов идёт по всему universe (вкл.
shadow/iframe); `css` — только light DOM.

**Ambiguity guard — главная защита от тихих багов.** Старый `mcp_click` делал
`querySelector` и кликал **первый** молча: три кнопки «Save» → клик в первую, возможно
не ту, и снаружи выглядит как успех. Теперь при N>1 совпадениях действие **не
выполняется** — возвращается `status:'ambiguous'` + список кандидатов (зарегистрированы
как `c1/c2…`, агент сразу выбирает нужный) + suggestions. Один матч → действие, ноль →
`blocked/NOT_FOUND`.

**ActionResult-конверт.** Каждое действие отдаёт `{success, status, action, message,
errorCode?, recoverable?, suggestions?, evidence?}`. `status` ∈ `performed` /
`already_in_desired_state` (fill тем же значением, чек уже в нужном состоянии —
без лишней записи) / `ambiguous` / `blocked` / `not_performed`. Поле `error` **намеренно
дублирует** `message` на провалах — это backward-compat: frozen MCP-тулзы (`click`/`fill`
в `mcp/browser/index.js` живут в сессии, не hot-reload'ятся) читают `result.success`/
`result.error`, и старые legacy-`selector` вызовы продолжают работать через тот же движок.

**Дедуп удвоенных имён.** Фреймворки (claude.ai и др.) рендерят видимый + sr-only
дубль заголовка ссылки — `textContent` склеивает их в «дикциядикция», что ломает
текстовый матч. Если accessible-name = две одинаковые половины, оставляем одну.
Невидимо из кода почему — отсюда запись.

**Routing:** `mcp_inspect`/`mcp_act` возвращаются **verbatim с frame 0**, без
multi-frame fallback'а (см. «Frame routing gotcha» ниже) — они и так пробивают
iframe из верхнего документа, а fallback схлопнул бы structured-конверт в
`{success,error}`.

## Global vs local scope (переносимый принцип)

`browser` MCP зарегистрирован глобально (`claude mcp add -s user`) —
доступен в любой Claude-сессии любого проекта.

**Принцип:** глобальная регистрация безопасна для **stateless** MCP
(HTTP request-response: terminal-server, knowledge-server, yougile,
gemini). Они спят в idle, ничего не держат.

Глобальная регистрация **опасна** для MCP с persistent-connection
(WebSocket, long-poll). N открытых проектов = N процессов = N соединений
= N reconnect-loop'ов = N×leak. Этот MCP единственный в системе с
persistent WS. Реквизит к нему — bridge.js всегда в рабочем состоянии
(или auto-spawn) и аккуратный backoff (см. "Reconnect leak").

## Где документировать поведение MCP

Описание архитектуры/recovery/tool-rubric передаётся через MCP-протокол
поле `instructions` (`new McpServer({...}, {instructions: '...'})`).
Поле уходит в любую Claude-сессию любого проекта при initialize, без
правки CLAUDE.md проектов где этот MCP подключён.

Это проектно-независимый принцип: MCP, который доступен глобально,
**должен** документировать свои рецепты в `instructions`, а не в
CLAUDE.md одного из проектов — иначе пользователь в другом проекте не
получит контекста.

Доменная логика отдельных парсеров документируется отдельными `fact-*`, а не
раздувает этот общий архитектурный файл. Пример: `fact-yandex-maps.md` описывает
SSR-state Яндекс.Карт и пагинацию; `fact-avito-mcp.md` описывает Avito realty
search/detail/chat, фоновые вкладки, safety отправки сообщений и пост-фильтрацию
квартир по адресу/метро/окружению.

## Recovery flow

При ошибках MCP-tool:

| Ошибка | Что делать |
|---|---|
| `Bridge not connected yet — auto-spawn in progress` | Bridge только что запущен (lazy-spawn), retry через 2-3 сек. |
| `Extension not connected` | Bridge жив, расширение нет. Открыть `chrome://extensions`, проверить что SC Browser Parser включён. Кликнуть на иконку расширения чтобы разбудить service worker. |
| `No tab with id: X` | Вкладка закрыта. `list_tabs` → актуальный id → retry. |
| `No response from any frame` | Content-script не отвечает. Причин несколько: (1) вкладка предшествует обновлению расширения — `reload_tab` или F5; (2) service worker задремал между tool-call'ами (см. MV3 keep-alive выше) — открой иконку расширения в browser bar; (3) dev-сервер перезапустился на том же порту, страница в браузере уже на новой версии но frame-injection ещё не догнал — F5 на конкретной вкладке; (4) ты обращаешься к старому `tabId` после `reload_tab`/`close_tab` — `list_tabs` для актуального id. **Перед повтором команды всегда проверь реальное состояние** через `list_tabs` или внешний канал — см. глобальный skill `~/.claude/skills/mcp-debugging/SKILL.md`. |
| `Cannot access contents of the page` | То же, F5 / reload_tab. |
| `Error: no result from page` (от `evaluate_raw` / `evaluate`) | Тот же класс ошибок что `No response from any frame` — content-script запустился но не успел отдать результат (страница reload'ится, frame удаляется в момент eval'а, переход на другой URL). Не значит «страница пустая». `list_tabs` → проверь актуальный URL. |
| `chrome.userScripts unavailable` / упоминание "Allow user scripts" | Только для `evaluate_raw`. Пользователь должен включить toggle на странице деталей расширения в `chrome://extensions/?id=...` (Chrome 138+). DSL `evaluate` продолжает работать без этого. |

**Anti-pattern:** при сбоях browser MCP **НЕ** переключаться на
`chrome-devtools` MCP. Тот спавнит **новый** headless Chrome без
cookies/расширений пользователя — задача не решится, потеряется контекст
залогиненной сессии.

### Несколько браузеров на одной машине

Расширение установлено в **конкретном** браузере (Chrome / Yandex / Brave —
каждый отдельный Chromium-инстанс со своим extension store). MCP-bridge
видит только тот браузер, где SC Browser Parser реально загружен.

**Симптом:** AI запускает «http://localhost:5175/» в **другом** Chrome
для smoke-теста, видит тайм-аут / `No response from any frame`, делает
вывод «фронтенд упал». На самом деле фронтенд работает, юзер видит его
в **своём** Yandex Browser'е, а MCP смотрит в пустой Chrome без
расширения.

**Чек:** `list_tabs` показывает реальные открытые вкладки **того**
браузера, к которому подключён bridge. Если в списке нет вкладок которые
юзер прямо сейчас видит — ты смотришь не в тот браузер. Спрашивай юзера
в каком браузере у него стоит расширение; не открывай новых браузеров
«на пробу».

## Known limitations

### `harvest_list` dedup на пустых скелетах виртуализированных списков

Текущая dedupe-логика в `mcp-content.js`:
```js
key = hash(textContent) + ':' + length
```

В виртуализированных контейнерах (Angular CDK virtual scroll, AI Studio
`ms-autoscroll-container`) невидимые элементы существуют в DOM как
**пустые скелеты** с одинаковым textContent (типично `"more_vert"` —
кнопка меню). Все 14 невидимых turn'ов получают один и тот же ключ →
склеиваются в одну запись. `harvest_list` возвращает 3 элемента вместо 17.

**Workaround на стороне вызывающего:**
- Использовать узкий `itemSelector`, который матчит **только отрендеренные**
  элементы (в Angular часто `[data-turn-role]`, `.materialized` и т.п.)
- Передать `dedupeAttr: 'data-id'` если у элементов есть стабильный
  per-item атрибут

## История переезда

Изначально жил в `~/Desktop/hh-tool/extension-mcp/` + `backend/extension/mcp-content.js`,
потому что Flow Tab расширение умело и MCP, и парсинг hh.ru, а dev-MCP-канал
делил кодовую базу с прод-расширением. Прод-сборка Flow Tab резала
dev-only код (`build-extension.js` по маркеру
`// ============ MCP Bridge (dev-only) ============`).

После выделения парсинга hh.ru от парсинга всего остального, весь browser
MCP переехал в SC Browser Parser целиком — отдельное расширение, полностью
dev-only, без прод-варианта. Стриппер больше не нужен. Один источник
правды для browser MCP — здесь.
