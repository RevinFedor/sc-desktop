# Knowledge: Google AI Studio через MCP

End-to-end: Claude → `POST /research-start {provider:'aistudio'}` → bridge дёргает
SW → open tab → CS executes DOM flow → результат через `GET /research-status?id=aim_…`.
Параллельно тот же DOM-API (`window.scAistudio.*`) переиспользуется
`aistudio-autoscrape.js` при YouTube→Gemini автоскрапе.

> **АРХИТЕКТУРНЫЙ СДВИГ (эта сессия): AI Studio вынесен из browser-MCP на HTTP.**
> Раньше запуск шёл через MCP-tools `mcp__browser__aistudio_run` /
> `aistudio_get_result` (в `mcp/browser/index.js`). Они **удалены**. Теперь AI
> Studio идёт через тот же bridge HTTP что claude/perplexity: `POST /research-start`
> с `provider:'aistudio'` + `options.model`, поллинг через `GET /research-status?id=<aim_…>`.
> Мотивация (юзер): browser-MCP — инструмент **живого парсинга** (list_tabs/click/
> evaluate/snapshot), research-flow ему концептуально не место — см.
> `methodology/переносимый-дизайн.md::Граница каналов`. Реализация наполовину уже
> была готова: CS `aistudio-mcp.js` и так триггерился по URL `?sc-mcp-job=` и постил
> state на HTTP `/aistudio-state` — через WS шли только две команды-обёртки
> (`mcp_aistudio_start` / `mcp_aistudio_result`), их и перенесли. SW-логика (резолв
> модели, открытие вкладки, debugger-attach) переиспользована как была. Bridge роутит
> по префиксу id: `aim_…` → `AISTUDIO_JOBS` Map, `r…` → `researchState`.

## Один модуль, три потребителя

`browser-extension/aistudio-core.js` — единственное место где живут DOM-селекторы
и шаги взаимодействия с `aistudio.google.com/prompts/*`. Экспонирует
`window.scAistudio = { ensureModel, ensureVisualizationOff, setSystemInstruction,
pastePromptAndRun, waitForCompletion, parseLastTurn, KNOWN_MODELS, ... }`.

Потребители:
1. **`aistudio-autoscrape.js`** — YouTube target автоскрапа. Использует
   `ensureModel + setSystemInstruction + pastePromptAndRun`. Парсинг ответа
   ему не нужен — флоу завершается на Run (юзер сам смотрит результат).
2. **`aistudio-mcp.js`** — MCP-driven runner. Использует весь API включая
   `ensureVisualizationOff + waitForCompletion + parseLastTurn`.
3. **`content.js`** (legacy NMH-экспортёр) — не делегирует в `scAistudio`,
   живёт своей жизнью со сложной логикой harvest'а турнов. Не трогаем.

Подключение в `manifest.json::content_scripts[aistudio]`:
```
aistudio-core.js → aistudio-autoscrape.js → aistudio-mcp.js
```
(порядок в массиве `js[]` гарантирует доступность `window.scAistudio` к моменту
запуска обоих consumer'ов.)

## Поддерживаемые модели

| id | title | класс API | назначение |
|---|---|---|---|
| `gemini-3.1-pro-preview` (DEFAULT) | Gemini 3.1 Pro Preview | 1-фаза | SOTA reasoning, default |
| `gemini-3.5-flash` | Gemini 3.5 Flash | 1-фаза | agentic + coding |
| `gemini-3-flash-preview` | Gemini 3 Flash Preview | 1-фаза | fast general |
| `gemini-3.1-flash-lite` | Gemini 3.1 Flash Lite | 1-фаза | high-volume, translate |
| `deep-research-preview-04-2026` | Deep Research Preview (Apr-21-2026) | 2-фазы (DR) | 5-10 мин |
| `deep-research-max-preview-04-2026` | Deep Research Max Preview (Apr-21-2026) | 2-фазы (DR) | 10-15 мин |
| `antigravity-preview-05-2026` | Antigravity Agent Preview | 2-фазы (agent) | autonomous agent в remote Linux env |

Модель резолвится через `resolveModel(input)` — принимает id, title, alias (`pro`,
`flash`, `dr`, `dr-max`, `agent`/`ag`) или подстроку. Реестр `KNOWN_MODELS`
(`aistudio-core.js`) зеркалится в `KNOWN_MODELS_MCP` (`mcp-handlers.js`) — alias'ы
обязаны совпадать. Флаги модели: `isDeepResearch` (только DR — есть Visualization-
toggle), `isAgent` (только Antigravity), `isInteractionApi` (DR + Antigravity вместе —
двухфазный submit-API, см. секцию ниже; от него зависят timeout и обработка ключа).

## Два класса моделей: GenerateContent (1 фаза) vs Interactions API (2 фазы)

**Это корневое различие, объясняющее почему агент/DR ведут себя не как Pro.** Один и
тот же DOM-flow (textarea + Run), но backend под капотом — РАЗНЫЙ. Доказано перехватом
сети (net-tap, см. ниже) с маркером промпта в теле запроса:

- **Pro / Flash / Flash-Lite → `GenerateContent`, одна фаза.** Один backend-запрос,
  промпт внутри тела (`["models/…", [[["<промпт>"]],"user"]]`). Один ответ. Наш
  «paste → Run → ждать ответ» точно ложится на это.
- **Deep Research / Antigravity → Interactions API, две фазы.** Submit = `CreateInteraction`
  /`CreateInteractionStream` (поднять агентскую сессию + Linux-песочницу) → затем
  `CreatePrompt` / `GetInteractionStream`. У **DR** промпт кладётся прямо в `CreateInteraction`
  (тело содержит `"user",[[[["<промпт>"]]]]`). У **Antigravity** первый `CreateInteractionStream`
  уходит БЕЗ промпта (`["antigravity-preview-…"]`, маркера нет) — сессия создаётся, потом
  агент сам гоняет env-init (List Files, Run Command — мусорные `Agent`-турны) пока не
  получит реальный prompt отдельным сообщением.

Практическое следствие: агентский submit нельзя мерить «однофазной» логикой Pro. Первый
Run у агента — это «создать сессию», а не «отправить промпт». Если на этом шаге всплыло
окно ключа (а оно всплывает, см. paid-key секцию) — сессия стартует пустой, и без
вмешательства агент отвечает «the actual task is missing». Фикс — в paid-key секции
(вернуть промпт в композер до привязки ключа) + двухфазный fallback `submitPromptAsNewMessage`
(дождаться возврата Run после env-init, отправить промпт вторым сообщением, верифицировать
появление User-turn'а).

**Сигнал «промпт реально отправлен» = User-turn.** Считаем через
`document.querySelectorAll('ms-chat-turn [data-turn-role="User"]')`. Тонкость: атрибут
`data-turn-role` висит на **дочернем** элементе внутри `ms-chat-turn`, НЕ на самом
`ms-chat-turn` — селектор `ms-chat-turn[data-turn-role="User"]` всегда даёт 0 (этот баг
один раз стоил ложного детектора «агент сам продолжил»).

**net-tap — сетевая диагностика (flag-gated).** `background.js::SC_NETTAP_ENABLED` (по
умолчанию `false`). Когда `true` — на уже-подключённой к job-вкладке debugger-сессии
включается `Network.enable`, и каждый интересный backend-запрос (`GenerateContent` /
`CreateInteraction` / `CreatePrompt`) логируется в bridge: endpoint, `postLen`,
`hasPromptMarker` (есть ли в теле уникальный префикс промпта). Именно так доказано «первый
Run агента уходит пустым». Оставлен в коде за флагом — Network domain не бесплатен для CPU,
но переиспользует существующий debugger-attach (focus-emulation), отдельной сессии не плодит.

## HTTP API (через bridge, не MCP-tools)

```
POST /research-start  {provider:'aistudio', prompt, options:{model?, systemInstruction?, reuse_tab?, focus?}}
  → {id:'aim_…', tabId, modelId, modelTitle, isDeepResearch, url, status:'pending'}
```
Bridge видит `provider:'aistudio'` → `sendToExtension('mcp_aistudio_start', …)` (WS к
расширению). SW открывает (или реюзает) вкладку `…/prompts/new_chat?model=<id>&sc-mcp-job=<id>`,
кладёт job в `chrome.storage.local.__sc_aistudio_mcp_jobs[jobId]`, debugger-attach,
возвращает сразу. CS (`aistudio-mcp.js`) подхватывает jobId из URL и стартует flow:
ensureModel → ensureVisualizationOff → (setSystemInstruction) → pastePromptAndRun →
waitForCompletion → parseLastTurn. State CS PATCH'ит через `POST /aistudio-state`.

```
GET /research-status?id=<aim_…>&wait=60000
  → {id, provider:'aistudio', status, stage, modelId, modelTitle, isDeepResearch,
     tabId, elapsedSec, error, url, result:{text, links, ...}?}
```
Bridge по префиксу `aim_` роутит чтение в `AISTUDIO_JOBS` Map (а не `researchState`),
long-poll'ит до изменения status/stage или таймаута. Форма ответа приведена к
research-подобной (`result.text`), чтобы caller'у было единообразно с claude/perplexity.

**Паттерн вызова для Deep Research** (5-15 мин) — тот же curl-loop что claude/perplexity:
```bash
ID=$(curl -sf -X POST .../research-start -d '{"provider":"aistudio","prompt":"...","options":{"model":"dr-max"}}' | jq -r .id)
while …; do curl -s ".../research-status?id=$ID&wait=60000"; done   # до status=done|error
```

## Авто-wake мёртвого service worker

**Симптом**: MCP-команда (`list_tabs`, research-start, …) возвращает `Extension not
connected`, в `mcp/browser/bridge.js` логе — `[Bridge] Extension disconnected` без
реконнекта. SW расширения уснул/отвалился; reconnect к bridge `:3457` висит на
`setTimeout(connectMcpBridge, 5000)` в `mcp-handlers.js`, а **`setTimeout` не переживает
терминацию SW** — таймер умирает вместе с воркером, переподключаться некому. Раньше
лечилось вручную (клик по иконке расширения / toggle off-on), и «само заработало через
N часов» — это случайная активность в браузере будила SW.

**Самовосстановление**: в `mcp/browser/bridge.js` команда при мёртвом канале больше не
отдаёт голый отказ — вызывает `wakeExtension()` (`POST http://127.0.0.1:53127/reload-extension`
к sc-desktop bridge) + ждёт reconnect до ~6с + повторяет команду один раз. Механизм
работает потому что SW подписан на `chrome.alarms` (тик ~3с, `background.js` poll
`/bridge-commands`), **а alarms переживают смерть SW** (privilege API). Alarm забирает
команду `reload_extension` → `chrome.runtime.reload()` → на boot top-level
`connectMcpBridge()` заново дозванивается до `:3457`. Cooldown 10с между wake чтобы пачка
параллельных команд не устроила reload-шторм (он же — путь в Yandex circuit-breaker).

Покрывает **только** failure-mode «уснул/отвалился SW». Circuit-breaker (расширение
force-disabled после reload-шторма, `disable_reasons` выставлен в профиле) этим НЕ лечится —
Chromium намеренно не даёт снять enable извне, остаётся ручной toggle off/on. Проверка
состояния: `Secure Preferences` → `extensions.settings[<id>].disable_reasons` (null = просто
уснул, не заблокирован).

## Visualization всегда выключаем

Deep Research модели в Visualization-mode отдают результат как интерактивную
diagram-визуализацию, а не как plain markdown в `ms-text-chunk`. Парсер
(`parseLastTurn`) умеет читать только `ms-text-chunk` — из VizML ответ не
извлечь. Решение: `ensureVisualizationOff()` идемпотентно проверяет toggle
`button[role="switch"][aria-label="Visualization"]` и кликает если включён.

Selector детерминированный, не меняется между Pro / Flash / DR — toggle
живёт в правой Settings panel. Если панель свёрнута, `ensureSettingsPanelOpen()`
сначала кликает `button[contains-text="Settings"]` — после этого toggle
становится доступен.

Другие toggles (Code execution, Grounding with Google Search, URL context,
Thinking summaries) пока **не трогаем**. Если когда-нибудь юзер скажет
«выключай ещё и X» — добавляешь в `ensureVisualizationOff` массивом, селекторы
те же (`button[role="switch"][aria-label="..."]`).

## Завершение генерации: Stop появился → исчез + Run вернулся

`waitForCompletion({timeoutMs, onProgress})` опирается на наблюдаемое
поведение Studio:
1. После `runBtn.click()` в течение ~800ms кнопка Run превращается в Stop.
2. Пока модель отвечает — Stop visible, Run скрыт.
3. На завершении Stop исчезает, Run возвращается.

Двойная проверка `!stop && run` нужна чтобы не словить промежуточный кадр
где обе кнопки скрыты (Angular пересоздаёт shell в момент transition).

`stopAppeared` фиксируется в первой ~8с фазе — если за это время Stop не
показался (короткий ответ < 200мс / cache hit), допускаем выход после
3 секунд `!stop && run`. Без этого юзер получал бы timeout на тривиальных
ответах от Flash.

`timeoutMs` в `aistudio-mcp.js` — 20 минут для **двухфазных** моделей (по
`model.isInteractionApi`: DR + Antigravity), 5 минут для однофазных Pro/Flash. Раньше
шёл по `isDeepResearch` → агент получал 5 минут хотя он multi-step и медленный как DR
(env-init + tool-шаги), и длинные агентские задачи отваливались по таймауту.

## Hidden-tab strategy: chrome.debugger + setFocusEmulationEnabled

**Проблема:** AI Studio в background tab (то что нам нужно для MCP-flow с
`active:false`) НЕ материализует `ms-text-chunk` в DOM. Backend получает
запрос, response пишется в Angular structural-state, но template binding
никогда не runs — на странице остаётся пустой `ms-chat-turn` или вообще
ничего. При переключении вкладки в foreground (через юзера, F5, или
просто focus) — текст мгновенно появляется как из ниоткуда.

**Root cause (детерминированно, не догадка):**
- AI Studio построен на Angular с `ngZoneRunCoalescing: true` —
  change detection coalesce'ится через `requestAnimationFrame`.
- Chrome/Blink ставит rAF на паузу для hidden tabs на уровне
  C++ `Page::IsPageVisible()` — это не JS-getter `document.visibilityState`,
  а внутренний enum в renderer process.
- Без rAF NgZone change detection не fires → template-binding не commit'ит
  ни одну новую DOM-ноду из `*ngFor` template над `ms-text-chunk`.

Это объясняет почему **все попытки JS-override провалились:**
- `Object.defineProperty(document, 'visibilityState', {get: () => 'visible'})` —
  Blink читает не JS-getter а C++ Page::IsPageVisible()
- Monkey-patch `EventTarget.prototype.addEventListener` для подавления
  `visibilitychange` — Angular CD не reads visibilityState, она reads rAF
- `setInterval` re-apply каждые 200мс — `setInterval` в hidden throttled
  до 1s/tick, не помогает
- `chrome.offscreen` — offscreen документы по дизайну `visibilityState='hidden'`,
  rAF никогда не fires
- `chrome.windows.create({state:'minimized'})` — broken в MV3, silently ignored
- `Page.setWebLifecycleState({state:'active'})` — только frozen-bit, не
  меняет Page::IsPageVisible()

**Решение:** `chrome.debugger.attach({tabId}, "1.3")` +
`Emulation.setFocusEmulationEnabled({enabled: true})`. Это то же что
DevTools' "Emulate a focused page" rendering option. Меняет
`Page::IsPageVisible()` → true на C++ уровне → rAF тикает на 60Hz →
Angular CD work normally → `ms-text-chunk` рендерится сразу как получен.

Implementation (`background.js::attachFocusEmulation`):
```js
await chrome.debugger.attach({ tabId }, '1.3');
await chrome.debugger.sendCommand({ tabId },
  'Emulation.setFocusEmulationEnabled', { enabled: true });
// Belt-and-braces:
await chrome.debugger.sendCommand({ tabId },
  'Page.setWebLifecycleState', { state: 'active' });
```

Вызывается из `mcp-handlers.js::mcp_aistudio_start` сразу после
`chrome.tabs.create`, до того как CS успел проверить initial visibility.
Detach делается в `__sc_aistudio_mcp_done` handler — banner исчезает,
вкладка возвращается к нормальному throttling.

**Бонус:** Chrome (Q4 2025+) держит SW alive пока debugger attached —
30s idle teardown не работает в течение всего job'а. Это устраняет
отдельную проблему "SW умирает на длинном DR job'е и теряем onProgress".

**UX cost:** жёлтая полоса "Расширение начало отладку этого браузера".
Прячется одним из:
1. `--silent-debugger-extension-api` launch flag (для power users)
2. `ExtensionInstallForceList` enterprise policy (для деплоя в org)
3. Принять как есть (для desktop-app сценария — юзер видит badge но не
   обращает внимания, расширение работает)

См. `fact-aistudio-mcp.md::chrome.debugger strategy` — детальный отчёт
Claude Deep Research (940 сек, 372 sources) подтверждающий это
единственным детерминированным решением. Альтернативу через
`chrome.tabCapture.getMediaStreamId` (создаёт реальный MediaStream →
tab considered foreground для throttling) отметили как fallback —
требует click-activation per job и показывает red recording-dot, что
визуально хуже banner'а.

### Параллельные debugger sessions: silent detach + auto-reattach

Chrome **не** запрещает одновременный attach к нескольким tabs (multi-tab debugger
официально поддерживается), но на практике при открытии 3-х tab'ов подряд
один за другим в одном окне старые sessions получают `chrome.debugger.onDetach`
с `reason='canceled_by_user'`. Это **не** юзер нажал Cancel в banner'е — это
**system-driven cancel** при создании новой debug-сессии в том же window.
Симптом: запустил 3 параллельных aistudio_run → 1 job отработал, 2 других
вернули `error: completion finished but no response text found` потому что
их emulation slipped в момент attach третьего.

Что НЕ работает: пропускать reattach если `reason === 'canceled_by_user'` —
именно это значение приходит для system cancel'ов тоже, и пропуская их
теряем emulation навсегда. Решение: **auto-reattach всегда**, кроме случая
когда `chrome.tabs.get(tabId)` упал (вкладка реально закрыта).

Дополнительная защита — `chrome.alarms`-based watchdog каждые 15 сек:
для каждого tabId в `SC_DEBUGGER_ATTACHED` шлём `Runtime.evaluate('document.visibilityState')`
через debugger. Если sendCommand упал — session dead, делаем full reattach.
Если sendCommand вернул `'hidden'` — emulation slipped, re-apply
`Emulation.setFocusEmulationEnabled({enabled:true})`. Альтернатива через
`setInterval` в SW не работает: MV3 SW idle-teardown гасит таймер; `chrome.alarms`
— privilege API, не throttled, переживает SW idle.

### sendMessage SW→SW не доставляется

`mcp-handlers.js` и `background.js` живут в одном service worker global'е
(подгружены через `importScripts`). Попытка `chrome.runtime.sendMessage({__sc_debugger_attach:...})`
из mcp-handler'а в свой же SW handler — **no-op**: Chrome не доставляет
сообщения в тот же контекст откуда они отправлены. Симптом: handler
успешно регистрируется, никаких ошибок, но event'ы не приходят, attached/detached
лог пуст. Решение: прямой вызов `attachFocusEmulation(tabId)` как функции;
hoisting `async function` гарантирует доступность к моменту первого MCP call.

### Pre-parse reattach в parseLastTurn

Между `waitForCompletion` и `parseLastTurn` может пройти несколько секунд
(чтение validChunks, scroll into view). За это время debugger session
могла отвалиться (silent detach из параллельного job'а, ещё не среагировал
onDetach handler). Angular видит `visState='hidden'` без rAF → демонтирует
`ms-text-chunk` обратно. parseLastTurn ловит пустой DOM.

Защита: если в начале parseLastTurn `document.visibilityState === 'hidden'`,
шлём `__sc_debugger_attach` в SW + sleep 1500мс. Этого хватает на reattach
+ один Angular CD цикл → chunks возвращаются. Если reattach не помог
(вкладка реально hidden) — следующий fallback на `turnCache` (MO-snapshot).

## Double-click submit race

`mainWorldClick` через `chrome.scripting.executeScript` выполняет в MAIN-world
pointer-chain: `pointerdown → mousedown → pointerup → mouseup → MouseEvent('click')`.
Последний шаг — это уже **полный click event**, Angular Material принимает
его как submit. Дополнительный `el.click()` в конце handler'а (раньше
выглядел «безвредной страховкой на случай если pointer-chain не сработал»)
даёт **второй submit** на ту же кнопку.

Симптом: parseLastTurn возвращает два склеенных независимых ответа
(*"17 × 23 = 391.Результат умножения 17 на 23 равен 391."*) или ещё хуже —
два потока перемешанные построчно в один `ms-text-chunk` (Studio пишет
оба stream'а в shared chunk-ref, Angular делает diff'ы). На coротких
prompts особенно заметно — Stop вообще не появляется, оба ответа приходят
за <1с в один chunk.

Различие radix-ui vs Angular Material:
- **radix-ui (claude.ai Confirm dialog)** — дебаунсит дублирующиеся click'и,
  второй no-op, безвредно.
- **Angular Material (AI Studio Run кнопка)** — НЕ дебаунсит, оба submit'а
  принимаются. Нужен `singleClick: true` mode в `__sc_main_click` handler:
  pointer-chain без финального `el.click()`.

`aistudio-core.js::mainWorldClick` теперь всегда шлёт `singleClick: true`.
`claude-research.js` оставлен на двойном click'е (radix-ui dependency).

Что пробовали и почему не сработало:
- ISO `runBtn.click()` → mainWorldClick fallback с verify через `stopVisible()`:
  ISO-click в hidden tab срабатывал с задержкой 1.5с (после rAF unblock через
  debugger), пока мы делали fallback на mainWorldClick — двойной submit.
  Решение не «увеличить sleep между ISO и main», а вообще убрать ISO —
  для AI Studio Angular Material он всегда не работает (isTrusted check),
  смысла пробовать нет.

## innerText vs textContent в hidden tab

В hidden tab Blink **не делает layout/reflow**. `Element.innerText` зависит
от layout (учитывает CSS `display:none`, `visibility:hidden`, computed
text rendering) — значит в hidden tab возвращает **пустую строку**, даже
если контент полностью в DOM. `Element.textContent` работает на DOM-уровне
(без layout) и возвращает реальный текст.

Симптом: `ms-text-chunk` в DOM, `innerText` = "", parseLastTurn пропускает
chunk как пустой → "completion finished but no response text found". После
переключения вкладки в foreground текст «появляется» — это не Studio
ре-рендерит, это Blink наконец-то делает layout и `innerText` начинает
возвращать содержимое.

Решение: везде где читаем chunk-content для логики — **textContent first**:
```js
const txt = (tc.textContent || tc.innerText || '').trim();
```
Три места исправлено: `parseLastTurn`, `captureTurnSnapshot` (MO callback),
`waitForStableText` (stability check).

## waitForStableText: только non-thought chunks

После `wait.done.stop_disappeared` нужно дать stream'у дописаться — на быстрых
Flash-ответах Stop button успевает появиться и исчезнуть за ~1.5с (один POLL
цикл), parseLastTurn моментально читает partial chunk → truncated текст.
Защита: `waitForStableText` ждёт пока длина не перестанет расти за 2 sample подряд
по 800мс.

Что измеряем: **только non-thought ms-text-chunk внутри последнего turn'а**, не
общий `textContent` турна. Общий textContent включает UI bar
(`more_vert / thumb_up / thumb_down / 8.1с`) — после завершения он имеет
constant length, даёт false-positive stable даже если chunks ещё стримятся
или уже демонтированы Angular'ом.

## MutationObserver sweep timing в hidden tab

`scheduleSweep` через `setTimeout(0)` / `requestAnimationFrame` не работает в hidden tab:
- `rAF` ВООБЩЕ не тикает (frame pipeline paused для hidden Pages).
- `setTimeout(0)` тротлится до ~1с/tick (background timer throttling).

При быстром stream + demount цикле AI Studio (chunks приходят и уходят
за 200мс) MO callback получает мутации, но defer'нутый sweep тикает с
секундной задержкой → к моменту чтения DOM `ms-text-chunk` уже null.
turnCache остаётся пустым.

Решение: синхронный sweep прямо в MO callback с throttle через timestamp
(50мс между sweep'ами, mutations часто batch'атся сотнями на frame).
Periodic safety net через `setInterval` уменьшен с 2с до 500мс — реальный
тик в hidden tab будет ~1с, что хватает на непрерывный snapshot.

## Storage race для параллельных aistudio_run

`chrome.storage.local.get(KEY) + ...set({[KEY]: allJobs})` **не атомарен**.
При параллельных aistudio_run два job'а делают одновременно:
- A: get → {} → set({A})
- B: get → {} → set({B})  ← перезаписал A

CS job_A открывается, читает storage по jobId_A → **`job not found`** → CS
завершается с error.

Решение: global promise-chain serialize в `mcp_aistudio_start`:
```js
globalThis.__sc_aistudio_storage_lock = (globalThis.__sc_aistudio_storage_lock || Promise.resolve())
  .then(async () => { /* get + mutate + set */ });
await globalThis.__sc_aistudio_storage_lock;
```
Все aistudio_run проходят через одну цепочку, set'ы выполняются строго
последовательно. Cost: микро-latency на параллельных стартах, не заметно
для пользователя.

## Backend ошибки AI Studio

Studio возвращает **"An internal error has occurred."** в `ms-chat-turn`
(0.1-0.5с после submit) вместо ответа модели. `ms-text-chunk` рендерится
с этим текстом, но `validChunks.length === 0` потому что текст в error-обёртке.

**ГЛАВНАЯ причина (диагностировано 2026-06): нет transient user-activation.**
Долго считали это «backend сам виноват» — НЕВЕРНО. AI Studio с апдейта нач.-2026
требует **transient user-activation** для submit'а. Наш job гонит вкладку в **фоне**:
- Синтетический `mainWorldClick` (`isTrusted=false`) создаёт turn (Angular ловит
  click), но запрос уходит без activation → backend мгновенно 500.
- CDP-`Input.dispatchMouseEvent` (`isTrusted=true`) в **background-табе НЕ даёт
  activation** — известный CDP-issue: dispatch требует **active** вкладку
  ([issue #89](https://github.com/ChromeDevTools/devtools-protocol/issues/89)).

Доказательство-цепочка (по логам): 0/7 авто-сабмитов падали (synthetic / CDP-trusted /
pinned / visible-но-не-active — все), при этом **ручной клик мышью юзера проходил** (его
вкладка active). Reproduced даже в чистой вкладке без расширения, пока она не active.

**РЕШЕНИЕ (no-focus) — клик через `Runtime.evaluate {userGesture:true}`.** CDP-eval с
флагом `userGesture:true` синтезирует transient activation **ДАЖЕ в hidden/inactive
вкладке** (`el.click()` внутри такого eval засчитывается как настоящий жест). Доказано
живьём: `vis:hidden` → `ua:true`, submit без error. Это лучше двух тупиков:
- НЕ `Input.dispatchMouseEvent` (требует active-таб, в фоне молчит).
- НЕ «focus вкладки на передний план» (первый рабочий фикс этой сессии: 3/3 sequential,
  НО выдёргивал окно Яндекса поверх всех приложений + ломался на конкурентных job'ах —
  active-таб может быть только одна, job'ы дрались за фокус). userGesture-eval это снимает.

Реализация: SW-handler `__sc_usergesture_click` (`background.js`) делает
`chrome.debugger Runtime.evaluate {expression:"el.click()", userGesture:true}` по
помеченному `data-sc-ug-click` элементу. `aistudio-core.js::trustedClick` это вызывает —
БЕЗ focus. Итог после фикса: **6/6** (1 single + 3 concurrent + 2 bg-test) против 0/7 до.
Источники: [CDP issue #89](https://github.com/ChromeDevTools/devtools-protocol/issues/89),
[MDN userActivation](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/userActivation).

**Остаточный ложно-положительный backend-error.** Иногда Studio реально отдаёт 500
сам по себе (документированный серверный сбой, [Google forum](https://discuss.ai.google.dev/t/gemini-3-1-pro-an-internal-error-has-occurred/127964)) —
тогда даже active-tab + рабочий ключ даёт error часами на конкретной модели. Отличить
от activation-проблемы: серверный сбой бьёт и по ручному клику юзера тоже.

**Antigravity Agent Preview (`antigravity-preview-05-2026`) — работает, но flow особый.**
Раньше думали «0/N, не работает» — НЕВЕРНО (юзер подтвердил руками: 1й запрос error, 2й ок).
Отличия агента от Flash/Pro и что под них починено:
- **Cold-start error.** Первый submit часто → Agent-turn `internal error` за 0.2с (агент
  инициализирует remote Linux env). Лечится retry — см. «Retry через Rerun».
- **Run открывает paid-key dialog вместо submit'а.** После привязки ключа — фикс
  через restore-before-select + двухфазный re-submit (см. paid-key секцию).
- **У error-турна агента НЕТ кнопки Rerun** (только Edit / Open options, в меню Delete/Copy).
  Значит retry «повторить turn» невозможен кнопкой — повтор = заново paste+Run через композер
  (см. `rerunLastTurn` fallback).
- **Структура ответа:** агент даёт несколько `ms-chat-turn` с `data-turn-role=Agent` —
  отдельно Thoughts/activity (`ms-thought-activity-chunk`, `validChunks=0`) и отдельно
  финальный ответ (`validChunks>0`). `parseLastTurn` берёт последний с `validChunks>0`.

**Бывшее «ограничение парсинга» оказалось другим багом — РЕШЕНО.** Раньше тут стояло
«парсер цепляет tool-активность (List Files, Run Command) вместо финального текста, агентский
research ненадёжен». Net-tap показал: парсер был ни при чём — агент **физически работал над
пустой задачей** (первый `CreateInteractionStream` без промпта из-за paid-key dialog), поэтому
в DOM были только env-init tool-турны, а финального ответа и не существовало. После фикса
paid-key (промпт уходит первым турном) агент отвечает по делу с источниками — проверено на
«последняя версия Claude Code» (W3Techs/Cloudflare, `[1]` cite). См. paid-key секцию.

**Раньше watcher завис.** В оригинальной версии `parseLastTurn` детектил backend-error
**в самом конце** waiting'а — но если Stop **никогда не появился** (backend ответил error'ом
до того как начал стримить), waitForCompletion проваливался в основной цикл с
`stopAppeared=false` и крутился до timeout'а 5/20 минут. Job висел 30 минут вместо 3 секунд.

`detectBackendError()` хелпер (`aistudio-core.js`):
- Берёт `lastTurn.textContent`, ищет два класса ошибок:
  - **internal error** (`/An internal error has occurred|Произошла внутренняя ошибка/i`) —
    транзиентная, **retryable** (retry-loop ловит `/backend error|internal error/` и делает rerun).
  - **rate limit** (`/reached your rate limit|rate limit.*try again/i`) — терминальная,
    **НЕ retryable**, возвращается с префиксом `rate_limit:` чтобы retry-loop её НЕ счёл
    retryable (повтор сразу упрётся в тот же лимит). Раньше детектился только internal error
    → rate-limit-турн висел ~297с до полного таймаута (`stopAppeared=false`, turnCount замер).
- Вызывается в **stop-probe loop** (40 iterations × 200мс = 8 сек ожидания Stop'а) — на каждой
  итерации, выбрасывает error за <1 сек как только Studio покажет error-message.
- Вызывается в **main wait-loop** на каждый poll-tick (1500мс) — на случай если error
  случился между Stop'ами или после.

### Retry через Rerun this turn (без location.reload)

AI Studio показывает три action-кнопки на каждом user-turn'е при hover:
карандаш (Edit), sparkle (Rerun this turn), more_vert (Open options). Sparkle —
`button[aria-label="Rerun this turn"]` — повторяет отправку прошлого user-turn'а **без**
полной перезагрузки страницы. Используется как retry-механизм поверх transient backend errors.

`aistudio-core.js::rerunLastTurn` — **два условия вместе** (поодиночке не работает,
проверено живьём):
1. **CSS-pin снимает hover-gate.** Rerun-кнопка в `.actions.hover-or-edit` с
   `opacity:0 + pointer-events:none` — кликабельна ТОЛЬКО под курсором. Доказано:
   `elementFromPoint` в центре кнопки возвращал DIV-контейнер, `btn pointer-events:none`;
   после force `opacity:1+pe:auto` → `hitsButton:true`. Инжектим `<style>` с правилом
   `[data-sc-rerun-pin] .actions.hover-or-edit{opacity:1!important;pointer-events:auto!important}`,
   маркируем целевой турн `data-sc-rerun-pin`, снимаем в finally.
2. **userGesture-клик** (`trustedClick` → `__sc_usergesture_click`) — даёт activation в фоне.

   Fallback на `mainWorldClick` (synthetic) если eval не сработал — хотя бы turn создаст.

**Run/Rerun: `trustedClick` через userGesture-eval (no-focus).** Помечаем элемент
`data-sc-ug-click` → SW делает `Runtime.evaluate {expression:"el.click()", userGesture:true}`.
Это и есть основной фикс «internal error» — даёт transient activation БЕЗ вывода окна на
передний план, работает в hidden-табе и при конкуренции (см. секцию «internal error» выше).
Run не hover-gated (всегда в композере) — ему только userGesture-клик, без pin.

**Stale-error grace при ретрае.** После `rerunLastTurn` СТАРЫЙ error-turn ещё ~1с в DOM,
пока новая генерация не заменит его. Без защиты `detectBackendError` на `i:0` мгновенно
ловил СТАРЫЙ error → 3 ретрая за 3.4с впустую. `waitForCompletion({ignoreStaleErrorMs})`:
на ретрае (attempt>0) 6с grace, в котором error НЕ throw'ается — ждём либо его исчезновения
(rerun очистил), либо Stop (генерация пошла). Лог `wait.stale_error_grace`.

`aistudio-mcp.js::runJob` (и зеркально `aistudio-autoscrape.js` для YouTube-пересказов)
оборачивает retry-loop:
- `MAX_RETRIES = 2` (всего 3 попытки). Catch `/backend error|internal error/i` и attempt < MAX →
  `rerunLastTurn(job.prompt)` + `sleep(1500)` + повтор.
- **parseLastTurn ВНУТРИ retry-loop, не после.** Раньше parse был после loop'а — но error-turn
  часто рендерится уже ПОСЛЕ того как `waitForCompletion` вернул (Antigravity cold-start: вернул
  `no_stop_short_answer`, error всплыл на parse). Parse кидал НЕ-backend-ошибку («no response
  text found»), retry-loop (ловил только backend) не срабатывал. Теперь parse в try → backend-error
  на parse-стадии тоже retryable → rerun. `parsed===null` + `detectBackendError()` → throw backend.
- **`rerunLastTurn(prompt)` fallback для Antigravity.** У error-турна агента нет кнопки «Rerun
  this turn» (только Edit/Open options). Если кнопок 0 и передан prompt — повтор через композер
  `pastePromptAndRun(prompt)`. Без prompt — старый throw `rerun: button not found`.

**`no_stop_short_answer` гейт по реальному ответу — иначе медленные модели отдают
промежуточный текст.** В `waitForCompletion` есть ранний выход «Stop ни разу не появился +
`elapsedSec>3`» — он для instant Flash cache-hit. Но он **мисфайрил на DR/Antigravity**: у них
Stop появляется поздно (после env-init / план-фазы), probe-окно (8с) его пропускало, и выход
срабатывал на промежуточном тексте — DR отдавал *«Generating research plan…»*, Antigravity
*«folder List Files…»* вместо результата. Фикс: выходить по no-stop **только когда есть реальный
ответ** — последний турн с непустым не-thought `ms-text-chunk` (`validChunks>0`). Activity/
thinking-турны (`validChunks=0`) не считаются завершением. Flash cache-hit имеет validChunks
сразу → не регрессит; DR/agent ждут настоящего Stop или материализации финального текста.
Проверено: DR 446с → реальный отчёт 5075 симв (раньше бросал бы план на 8-й секунде).

**Конкурентность.** userGesture-eval не фокусит вкладку → одновременные aistudio-job'ы
НЕ дерутся за foreground. Проверено: 3/3 concurrent (`uno`/`dos`/`tres`) → done. (С прежним
focus-фиксом конкуренция ломалась — это была причина выбросить focus-подход.)

Юзер запросил такой flow: *«у неё есть возможность перезагрузки всю страницу, там
перезагружаться не нужно... есть отдельная кнопочка на отправленном промпте... если
нажимаешь на кнопку „Звёздочки“, у тебя этот промпт повторяется заново»*. Полная
`location.reload()` обнуляла бы прогресс DR/Antigravity job'ов в той же вкладке (если
бы reuse), sparkle оставляет вкладку и историю turn'ов.

## Paid API key dialog

AI Studio иногда при первом открытии вкладки на сессии (после смены billing-статуса
проекта или после длинного idle) показывает модал **«Link a paid API key»**. Это
3-шаговый wizard: Choose project and API key → Set up billing → Link API key.
Первые два уже отмечены ✓ (билинг настроен с прошлой сессии), активен третий:
`Select key "<имя ключа>" as part of project "<имя проекта>"` + кнопка
`<button aria-label="Select key">`.

**Симптом если не закрыть.** Run-кнопка под текстаркой кликается успешно, но
запрос уходит в null-key, `ms-chat-turn` с моделью никогда не появляется, watcher
висит до полного timeout'а (5 мин для не-DR, 20 мин для DR). С точки зрения вызывающего
Claude — job выглядит как «вкладка зависла» без сигнала об ошибке.

**Окно всплывает на КАЖДОМ джобе DR/agent** (не раз в сессию). Toggle «Save paid API key»
мы жмём каждый раз, но он не персистится между job-вкладками (каждый job = свежая вкладка) —
проверено: 7/7 агент-джобов получили dialog несмотря на `save_toggle_enabled`. Поэтому
обработка ключа — часть каждого двухфазного submit'а, не одноразовая настройка.

**ПРИВЯЗАТЬ ключ, а не закрыть.** Ранний шрам: `ensurePaidKeyLinked` жал X (close) — dialog
исчезал, но ключ НЕ привязывался → instant `internal error` (доказано `aim_mq4z1n1l`).
Правильное действие — кнопка **«Select key»** (привязать). `ensurePaidKeyLinked()`:
- Контейнер `mat-dialog-container` visible с `/Link a paid API key/i`. Нет → no-op.
- Клик `Select key` (fallback `Link API key`) через userGesture-click (`data-sc-ug-click` +
  `__sc_usergesture_click`). Verify до 4с (линковка — network). Fallback на X (close)
  только если «Select key» нет (старый вариант диалога).

**КОРНЕВОЙ шрам (эта сессия): «Select key» сам авто-сабмитит ПУСТОЙ композер.** Доказано
net-tap с маркером промпта: при открытии окна композер очищается, а клик «Select key» (линковка
ключа) триггерит submit → у агента уходит `CreateInteractionStream` с `hasPromptMarker:FALSE` =
пустая сессия = мусорный env-init (List Files, Run Command), агент отвечает «the actual task is
missing». То же у DR (первый `CreateInteraction` пустой), но у DR пустой турн невидим, а у агента —
видимый мусор.

**Фикс (restore-before-select):** ПЕРЕД кликом «Select key» возвращаем промпт в композер
(`window.__scPaidKeyRestorePrompt`, ставит `handlePaidKeyDuringWait`). Тогда авто-сабмит от
привязки ключа уносит ПРОМПТ первым же турном (`CreateInteractionStream hasPromptMarker:TRUE`) —
мусорного env-init нет, ждать нечего, первый турн = User-turn. После select_key проверяем
появился ли User-turn (`prompt_landed_on_select`, до 2.5с): да → готово; нет → fallback на
`submitPromptAsNewMessage` (дождаться возврата Run после env-init, отправить промпт вторым
сообщением, верифицировать User-turn). Лог-путь успеха: `prompt_restored_before_select` →
`select_key_click` → `prompt_landed_on_select`. Проверено: agent×3 + DR — все чистым путём.

**Что отбросили (graveyard):**
- **X (close) как стратегия** — закрытие ≠ привязка → agent/DR error на следующем submit.
  `mainWorldClick` (synthetic) по X Angular Material отбрасывал (isTrusted=false).
- **Проактивная привязка ключа ДО первого Run** (открыть окно кликом по кнопке-ключу
  `ms-paid-api-key-button`) — окно, открытое кнопкой-ключом, содержит ТОЛЬКО `close`, кнопки
  «Select key» в нём нет (ключ для него уже «выбран»). Привязать нечем. Окно с «Select key»
  появляется только в ответ на Run.
- **always-resubmit с clear+repaste** (чистить композер и заново paste+Run после линковки) —
  гонка: `pastePromptAndRun` чистит поле, а AI Studio параллельно авто-сабмитит пустоту →
  промпт терялся. Решение — НЕ чистить, а восстанавливать промпт ДО select_key.
- **submit2 пассивно ждёт мусорную сессию** (дождаться пока пустой env-init сам закончится,
  ~60с, потом отправить промпт вторым сообщением) — работает, но даёт видимый мусорный турн +
  минуту ожидания. Юзер жал Stop чтобы ускорить. Оставлен только как fallback; primary —
  restore-before-select (мусора нет вообще).

**Места вызова:** `handlePaidKeyDuringWait` — единый обработчик, зовётся из probe-цикла (ловит
окно сразу ~1.5с, не ждёт 8с) и из main wait-loop (mid-stream rotation ключа у DR).

## Полный текст + grounding-источники в bridge

Research-flow читает результат AI Studio через HTTP (`GET /research-status` → `result.text`),
не через MCP-tool. Поэтому в bridge надо слать ПОЛНЫЙ ответ, а не превью.

**Шрам 1 — `result.text` обрезался до 600 символов.** На `job.done` в bridge-зеркало
(`/aistudio-state` через `__sc_log` relay) уходил только `responseHead` (`responseText.slice(0,600)`),
а полный `responseText` оставался в `chrome.storage.local`. Bridge-читалка
(`result.text = j.responseText || j.responseHead`) отдавала head → caller получал огрызок.
Миграция на HTTP сделала bridge основным каналом, а relay остался «лёгким» от старой логики
«полный текст через MCP-tool». Фикс: на `job.done` слать в bridge полный `responseText` + `links`
(не только `responseHead` + счётчики).

**Шрам 2 — grounding-источники не извлекались (`links:1` «Learn more»).** Фильтр шумовых
ссылок был `NOISE_HOSTS=['google.com', ...]` + `hostname.includes('google.com')`. Но
grounding-источники Gemini идут через `vertexaisearch.cloud.google.com/grounding-api-redirect/…`
— это хост `*.google.com`, и фильтр резал их вместе с навигацией. Замена на `isNoiseLink(href)`:
явно ПРОПУСКАЕТ `/grounding-api-redirect|vertexaisearch/`, режет точечную UI-навигацию
(`aistudio.google.com`, `gstatic.com`, `policies/support/accounts.google.com`, `ai.google.dev`).
После фикса grounding-промпт даёт 14-50 реальных источников (redirect-ссылки `[1]..[N]` +
поисковые запросы `google.com/search?q=…`) вместо одной «Learn more». Используется в обоих
местах сбора ссылок (`captureTurnSnapshot` MO-callback + `parseLastTurn`).

## Auto-close вкладки: детерминированное условие vs настоящая ошибка

Юзер провёл границу (см. `methodology/переносимый-дизайн.md::Авто-управление ресурсом`):
закрывать вкладку нужно не «только на успех» и не «на любой исход», а по **природе
исхода**.

**AI Studio** (`__sc_aistudio_mcp_done` handler в `background.js`): закрываем **только
на `ok===true` (done)**, на error — **оставляем**. Логика: AI Studio уже отрабатывает
transient-ошибки через retry (`rerunLastTurn`, 1-2 нажатия Rerun this turn). Если ПОСЛЕ
retry всё равно error — это настоящая поломка страницы (Angular/Gemini сломались, что-то
не отобразилось), вкладку держим для ручной диагностики. `keepTab=true` (popover) уважается.

**Perplexity/Claude** (`__sc_close_self_tab` в `background.js`, reason-aware задержка):
- `research_done` → закрыть быстро (500мс), юзер уже увидел готовность в UI.
- **детерминированная ошибка** Perplexity (`pplx_daily_limit` / `pplx_model_locked` /
  `pplx_mode_switch_failed` — заранее известные условия, на странице смотреть нечего) →
  закрыть с задержкой 4с. CS классифицирует в catch: `if (/pplx_daily_limit|…/.test(msg)) closeSelfTab(…)`.
- **настоящая ошибка** (timeout — что-то зависло; claude `confirm_failed`/`terminal_error`) →
  НЕ закрываем, вкладка остаётся.

Юзеровское обоснование почему детерминированные закрываем несмотря на «диагностику»:
*«диагностика в любом случае проводится вручную по логам»* — лишняя вкладка с известной
модалкой лимита это мусор, а не источник информации. У claude детерминированных условий
нет (Research mode либо доступен, либо нет), поэтому claude закрывается только на `research_done`.

UI-driven close из popover МСР: bridge кладёт `{cmd:'close_tab', tabId}` в
`BRIDGE_COMMAND_QUEUE`, расширение polls `GET /bridge-commands` через `chrome.alarms` (3с).
Тот же путь для `focus_tab`. Bridge не имеет прямого доступа к chrome.tabs — queue+poll
единственная архитектура через SW-границу. **Исключение — `/open-url`** (кнопка «В браузере»):
переведён с queue (лаг 3-6с от alarm-poll) на прямой WS `sendToExtension('mcp_open_url')` →
мгновенно находит вкладку по url и фокусит. Fallback в queue если WS лёг.

## TitleBar UI: композит-кнопка с popover'ом и историей

UX-обёртка над MCP jobs в renderer'е sc-desktop.

Кнопка в TitleBar — композит из трёх зон: `[+ (новый research) | Запущенные MCP (N) | История]`.
Popover, История MCP и панель «Запросы» взаимоисключающие (`TitleBar::openOnly`) — открытие
одной закрывает остальные, иначе оверлеи наслаиваются по z-index.

`McpRunningPopover.jsx` — открывается по клику на основную часть кнопки
«Запущенные MCP (N)», список active jobs (status=running|pending|queued). Источник —
unified `GET /external-jobs` (claude+perplexity+aistudio в одном списке). Корень popover'а —
`no-drag` (он внутри titlebar-drag-region; без класса клик по div-карточке таскал окно —
см. `fact-titlebar.md::Слой ПОВЕРХ titlebar'а`). Карточка job'а
**кликабельна целиком** → `pushScreen('aistudio-job', {jobId})` (AistudioJobScreen умеет
и research, и aistudio); внутренние кнопки — `stopPropagation`:
- **Браузер** — `POST /focus-tab` («Вкладка» переименована: лейбл = куда попадёшь, в браузер).
- **Стоп** — `POST /close-tab` + `clearAistudioJob`.
- **keepTab** (Pin/PinOff) — только для aistudio (research флага не имеет).
Время — живой клиентский таймер `McpJobTimer` (см. ниже), не серверный `elapsedSec`.
Попап **без header'а и крестика** — закрывается outside-click'ом (оверлей). Внизу —
строка «последний: <провайдер · модель>  <дата>», клик открывает Историю MCP. Никакого
uppercase в попапе (`methodology/переносимый-дизайн.md::Без декоративного uppercase`).
Research-заголовки пишутся как `provider · model`: `ChatGPT · 5.5 · high`,
`Perplexity · gpt`, `Claude · Research`. Разделитель обязателен даже для дефолтного
Claude Research, потому что первое слово — провайдер, всё после точки — модель/режим.

`McpHistoryPanel.jsx` — sidepanel справа. Клик по строке открывает джобу **и закрывает
панель** (как Activity-overlay). Источник тот же `/external-jobs` = RAM (live) + БД
(история, см. `fact-deep-research.md::RAM-state для live + SQLite для истории`). Cross-ref в
`methodology/переносимый-дизайн.md::Композит-кнопка для двух смежных операций`.

`RequestsRunningPopover.jsx` — такой же popover настоящего состояния, но для локальных
jobs (`useJobs`: Telegram/YouTube/TikTok/Instagram/local). Основная зона кнопки
«Запросы» открывает только active jobs; правая history-зона открывает full Activity
sidepanel. Обе поверхности переиспользуют один row-контракт: клик по job-row ведёт в
JobDetail и закрывает текущую поверхность.

`McpJobTimer` (общий для McpRunningPopover и AistudioJobScreen): прыжок времени (6с→73с) был из-за пересчёта серверного
`elapsedSec` через `createdAt→doneAt` на разных снапшотах. Решение — живой монотонный
клиентский таймер: для running тикает `+1с` от `createdAt` через `setInterval`, для
терминальных фиксирует `doneAt − createdAt`. Формат `m:ss` / `h:mm:ss`. См.
`methodology/переносимый-дизайн.md::Живой таймер вместо пересчёта серверного значения`.

`AistudioJobScreen.jsx` (страница джобы) — ветвится по `kind` (research/aistudio).
Мета компактно одной строкой (`Статус: готово · Режим: Поиск · Модель: sonar · Время: 1:15`)
вместо 2-колоночной grid с пустотами. Порядок блоков: **Промпт → Ответ** (что просили →
что получили). Убраны шумовые поля (Канал, Tab ID, Response chars, Links, Last tag) и
блок-ссылка (кнопка «↗ В браузере» через `/open-url` надёжнее, ссылка-текст глючила).

Поведение popover'а: outside-click через `document.mousedown` listener
с `setTimeout(0)` guard — без него тот же физический клик что открыл
popover, закрывает его в следующем event-cycle (классический popover-race,
см. `fix-popover-outside-click.md`).

## parseLastTurn: только текст ответа, не reasoning

Идём с конца `ms-chat-turn[]`, ищем первый Model/Agent турн. Берём
`ms-text-chunk` ВНЕ `ms-thought-chunk` (последний — Deep Research reasoning,
не финальный ответ; см. `content.js::extractModelMessageText` для полной
реализации того же принципа в legacy-экспортёре).

Если у турна 0 валидных text-chunk'ов — это не завершённый турн (Stop
ещё держится), идём дальше назад.

## Storage схема

`chrome.storage.local.__sc_aistudio_mcp_jobs = { [jobId]: {...} }`.

Per-job поля:
- `jobId`, `prompt`, `modelId`, `modelTitle`, `isDeepResearch`, `systemInstruction`
- `tabId` — вкладка, куда CS пишет результат
- `status: 'pending'|'running'|'done'|'error'`
- `createdAt`, `startedAt?`, `finishedAt?`, `updatedAt`
- `elapsedSec` — обновляется по throttle (3 сек) в `onProgress`
- `responseText?`, `error?`

Old job'ы НЕ чистятся автоматически — TODO добавить TTL/cleanup при
росте количества (сейчас один job ≈ 5KB, 1000 job'ов = 5MB, в пределах
storage.local quota).

## Anti-patterns

- ❌ **Не дублировать DOM-логику в `aistudio-mcp.js` или `aistudio-autoscrape.js`.**
  Любая работа с селекторами Studio идёт через `window.scAistudio.*`. Если
  нужно расширить (новая модель, новый toggle) — правишь `aistudio-core.js`
  один раз, оба consumer'а подхватывают.
- ❌ **Не возвращать `aistudio_run`/`aistudio_get_result` обратно в browser-MCP.**
  Они удалены намеренно — browser-MCP это инструмент живого парсинга, не flow-runner.
  AI Studio research идёт через `POST /research-start {provider:'aistudio'}` +
  `GET /research-status?id=aim_…` (тот же HTTP-канал что claude/perplexity). См.
  `methodology/переносимый-дизайн.md::Граница каналов`. Async start+poll обязателен
  (DR 5-15 мин) — но через curl-loop к bridge, не через MCP-tool с COMMAND_TIMEOUT=90с.
- ❌ **Не доверять `card.querySelector('.title')` для сравнения моделей.**
  Title содержит дату/версию ("Deep Research Max Preview (Apr-21-2026)"),
  которая поменяется на следующем релизе. Сравнение по `.subtitle` (id —
  "deep-research-max-preview-04-2026") тоже привязано к версии, но
  AI Studio передаёт его в URL `?model=…`, и для совпадения id в карточке
  vs id в URL у нас один источник истины.
- ❌ **Не открывать вкладку с `active:true` для MCP-flow без необходимости.**
  Юзер запросил «сделай research в фоне» — `aistudio_run` дефолтит на
  `active: false` + `autoDiscardable: false`. Без `autoDiscardable=false`
  Yandex.Browser замораживает вкладку которая ни разу не была активна, и
  long-running watcher замирает (та же проблема что в `fact-deep-research.md::Recovery`).
- ❌ **Не парсить ответ ДО `waitForCompletion`'а.** Studio лениво рендерит
  text-chunk'и пока Stop держится — `parseLastTurn` вернёт partial текст
  если позвать раньше. Сначала ждём transition Stop→Run, потом читаем.
- ❌ **Не пытаться override visibilityState через JS.** Blink читает не
  JS-getter а C++ `Page::IsPageVisible()` для rAF scheduler. `defineProperty`,
  `EventTarget.prototype` monkey-patch, `setInterval` re-apply — всё бесполезно.
  Единственное что работает — `chrome.debugger.attach` +
  `Emulation.setFocusEmulationEnabled`. См. секцию «Hidden-tab strategy».
- ❌ **Не пропускать reason='canceled_by_user' в `chrome.debugger.onDetach`.**
  Этот reason приходит и для system-driven cancel при создании новой
  debugger session в том же window. Skip'ая reattach — теряем emulation на
  параллельных jobs. Reattach всегда (кроме `chrome.tabs.get` упал).
- ❌ **Не использовать `innerText` для чтения DOM в hidden tab.** Blink
  не делает layout — `innerText` возвращает пустую строку даже если контент
  в DOM. Только `textContent` (DOM-only, без layout). Касается parseLastTurn,
  captureTurnSnapshot, любого DOM-чтения внутри aistudio-core.js.
- ❌ **Не доверять `lastTurn.textContent` как индикатору stream stability.**
  `more_vert / thumb_up / thumb_down / 8.1s` (UI bar турна) даёт constant
  length после завершения — false-positive «стрим стабилен» когда chunks
  уже демонтированы. Считать длину только `ms-text-chunk` non-thought.
- ❌ **Не делать `chrome.runtime.sendMessage` из SW в свой же SW handler.**
  Chrome не доставляет сообщения в тот же контекст. `mcp-handlers.js`
  загружен через `importScripts` — вызывай функции напрямую
  (`attachFocusEmulation(tabId)`), а не через message-relay.
- ❌ **Не делать `get + set` `chrome.storage.local` без serialize lock'а
  для параллельных операций.** Last-writer-wins → потеря записей других
  jobs (`job not found in storage`). Global promise chain:
  `__sc_aistudio_storage_lock = lock.then(async () => { /* atomic op */ })`.
- ❌ **Не добавлять `el.click()` в конце pointer-chain'а для Angular Material.**
  Pointer-chain уже шлёт `MouseEvent('click')` — это полный submit. Angular
  Material не дебаунсит, второй click даёт двойной submit, два независимых
  stream'а в один chunk → дублированный текст. Используй `singleClick: true`
  mode в `__sc_main_click`. На radix-ui (claude.ai) двойной click безвреден —
  не путать архитектуры.
- ❌ **Не использовать эмодзи (🕘 ⚡ 🧹 ↻) как функциональные иконки в TitleBar
  и других action-кнопках UI.** Юзер считывает их как «стикер», бутафорию.
  lucide-react уже подключён — `Activity / History / Settings / RotateCw /
  Trash2 / Square / ExternalLink / Cpu / FileText / X`. См.
  `methodology/переносимый-дизайн.md::Иконки через icon-library`.

## Файлы

| Файл | Что делает |
|---|---|
| `browser-extension/aistudio-core.js` | `window.scAistudio` — единый DOM API |
| `browser-extension/aistudio-autoscrape.js` | YT→Gemini autoscrape; делегирует в scAistudio.* |
| `browser-extension/aistudio-mcp.js` | job-runner; URL trigger `?sc-mcp-job=<id>` |
| `browser-extension/mcp-handlers.js` | actions `mcp_aistudio_start` / `mcp_aistudio_get_result` / `mcp_open_url` |
| `mcp/browser/index.js` | **больше НЕ держит** `aistudio_run`/`aistudio_get_result` (удалены — миграция на HTTP) — чистый browser-парсер |
| `electron/browser-bridge.js` | роутинг `/research-start` provider:aistudio → `mcp_aistudio_start`; `/research-status?id=aim_…` → AISTUDIO_JOBS; авто-wake SW |
| `src/components/McpJobTimer.jsx` | общий live-таймер для MCP/research UI |
| `src/components/RequestsRunningPopover.jsx` | popover активных локальных jobs (Telegram/YouTube/…) |

## Связано

- `fact-yt-extension-flow.md::Gemini Studio: автоскрапинг` — параллельный
  consumer того же DOM API.
- `fact-browser-mcp.md` — общая архитектура MCP-bridge'а, Why `evaluate`
  vs `evaluate_raw`, port `:3458`.
- `fact-deep-research.md` — другой channel для long-running генерации
  (claude.ai/perplexity), асимметричный flow через `?sc-research=`.
- `fact-browser-tab-marking.md` — визуальная пометка MCP-вкладок через favicon
  и title (tabGroups в Yandex не работает, см. там).
- `methodology/переносимый-дизайн.md::State per-resource + глобальный indicator` —
  родственный принцип для будущего UI прогресса DR job'ов.
