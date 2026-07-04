# Knowledge: Deep Research через MCP

Запуск **Deep Research** на claude.ai (Research mode) и perplexity.ai (Глубокое исследование) из Claude Code через `mcp__browser__deep_research_start` / `deep_research_wait`. Длительность одного research'а — 5-30 минут; принципиально не помещается в `COMMAND_TIMEOUT=90s` одного MCP-вызова.

## Архитектура (3 канала, 1 источник правды)

```
Claude Code ─(MCP stdio)─→ mcp/browser/index.js ─(HTTP)─→ electron/browser-bridge.js
                                                                │
                                                  electron/research-state.js (RAM)
                                                                ▲
                                                                │ POST /research-state
                                       ┌────────────────────────┘
                                       │
   browser-extension/{claude,perplexity}-research.js (content-script на вкладке)
       │
       ├─ MutationObserver на Send↔Stop  (immune к Chrome timer throttling)
       └─ chrome.runtime.connect('sc-research-keepalive')  (exempt от intensive throttling)
```

Bridge — **единый источник правды**. SKILL не держит state, content-script не держит state — оба ходят к bridge'у HTTP'ом. Это даёт live-симметрию: даже если расширение временно отвалилось, bridge помнит job и отдаёт snapshot. Bridge также служит **persistent log sink'ом** для CS (через `POST /research-log`) и **recovery каталогом** (через `GET /research-by-tab?tabId=N`) — оба нужны после crash-restore вкладки, когда in-DOM state CS потерян.

## Контракт curl-flow (без MCP tools)

Раньше pipeline шёл через MCP `deep_research_start` + `deep_research_wait` (внутри tool'а блокирующий long-poll loop). Tools удалены — оказалось что один длинный MCP-вызов через stdio-протокол менее устойчив к транспортным сбоям чем серия независимых HTTP-вызовов из Bash, а добавочной ценности от обёртки нет. Текущий pipeline — pure curl, выполняется внутри SKILL `external-research`:

```
POST /research-start         {provider, prompt, options?, attachments?, conversationUrl?}
  → {id, provider, tabId, url, status:'queued'}     (мгновенно — create + open вкладки одним вызовом)

GET  /research-status?id=…&wait=60000
  → snapshot (publicSnapshot)                       (long-poll до 60 сек или до tuple change)
```

`attachments` / `files` и `conversationUrl` сейчас имеют смысл только для ChatGPT-провайдера:
attachments — локальные image files, которые bridge валидирует и отдаёт CS через
`GET /research-attachment?id&index`; `conversationUrl` — существующий
`https://chatgpt.com/c/<id>` для follow-up в тот же чат. Сгенерированные картинки идут
обратно не в long-poll body как base64: CS POST'ит `/research-artifact`, bridge сохраняет
файл в `LIB_ROOT/research-artifacts/<jobId>/...`, а `result.images[]` содержит только
descriptor. Подробности — `fact-chatgpt-research.md::Картинки`.

SKILL крутит `while`-loop с `wait=60000`: каждый раз либо приходит изменение `status`/`stage` (мгновенный return), либо 60-секундный timeout (continue). Это даёт ту же блокирующую семантику что раньше, но без MCP-обёртки — если bash-loop умер, легко перезапустить с тем же `id` (bridge помнит RAM-state до 24 часов).

**Анти-паттерн bash-loop'а**: `S=$(echo "$R" | jq -r .status)` ломается на JSON с `\n` escape — `echo` в zsh интерпретирует `\n` как литеральный LF, ломая jq parser. См. `fix-bash-jq-echo-pitfall.md` — обязательно `jq <<<"$R"`.

## Детектор «research завершён» — claude.ai

Финал детектируется в content-script'е через `MutationObserver` (см. `claude-research.js::startDoneWatcher`). Несколько слоёв защиты, каждый — следствие живого debug'а ложных done'ов:

**Базовое условие**: `findSendBtn()` есть и enabled, `findStopBtn()` отсутствует, **и** видна одна из двух кнопок-маркеров: `button[aria-label*="Open research panel"]` (research-card) или `[data-testid="action-bar-copy"]`. Action-bar-copy — defence-in-depth: появляется на любом завершённом ответе и стабилен между релизами, research-card специфична research-flow.

**Quiet-window 3 секунды.** Stop button у claude.ai на research'е **мигает** между стадиями (Setting up → Searching → Reading → Analyzing → Synthesizing). Между стадиями он пропадает на 300-800мс. Без quiet window watcher срабатывал ложно — `!stop && panel` true на 47-й секунде, research реально только начался. Решение: запоминаем `lastStopSeenAt`, требуем `sinceLastStopSeen ≥ 3000ms` до done.

**`panelSeen` + `isFinalPanelLabel` без «and counting».** Research-card имеет шаблон `<title>: N sources [and counting]. Open research panel.` Промежуточные label'ы: «Setting up my research space...», «Reading sources... 51 sources and counting», «Synthesizing findings». Регекс `\b\d+\s+sources\b` совпадает и с «51 sources and counting» (research ещё активно собирает источники), и с финальным «456 sources». Решение: явный exclude `/and\s+counting/i` и `/и\s+считает/i` — без него watcher срабатывал в момент когда research только начал индексировать первые ~50 источников. Это знание из живого test'а на «Microsoft Majorana 1» research, длинна был ~13 минут с прогрессией от 51 до 456 sources в реальном времени.

**NO_PANEL_GRACE 60 секунд.** Claude.ai после submit research-промпта **сначала** генерит короткий текстовый блок «Launching research now…» в обычном message-area (`div.standard-markdown`) — у него появляется `action-bar-copy` ДО появления research-карточки. Watcher детектил это как «обычный ответ без panel» → done с пустым result. Решение: запоминаем `firstStopGoneAt` (момент первого ухода Stop) и ждём до 60с появления research-panel. Если за 60с panel так и не появился — это действительно обычный ответ (или clarifying-вопрос), done срабатывает по `copyBtn`. Если panel появился раньше — переключаемся на panel-режим (требуем finalLabel «N sources» без «and counting»).

**`panelSeen` flag**: однократно поднимается когда panel впервые увидена; не сбрасывается даже если panel временно исчезает между стадиями. Это защищает от случая когда panel мигает (видели → пропала → снова появилась с обновлённым label) — watcher продолжает быть в panel-режиме.

**Artifact-pane программное открытие — где лежит реальный документ.** Текст в обычном `.standard-markdown` под чатом — это **905-символьный summary** от Claude'а («Я провёл research по теме X, основные выводы…»), не сам документ. Полный артефакт-документ (29K+ chars в живом тесте) живёт **только** в правом artifact-pane, который по умолчанию закрыт. Если pane не открыт — markdown'а артефакта в DOM нет, MutationObserver его не видит. `extractArtifactDocument()` в `claude-research.js`: находит artifact-card в чате (`findArtifactCard()` — по `aria-label*="Open" + "artifact"`), кликает чтобы открыть pane, ждёт `[role="region"][aria-label*="artifact" i]` с содержимым, читает все `.standard-markdown` внутри, кликает закрытие pane, возвращает `{text, title}`. Watcher.done теперь сохраняет в `result.document_text` (~29K) и `result.document_title`, оставляя `result.text` (~905) как краткий summary. `extractAnswerText` дополнительно фильтрует через `.closest('[aria-label*="artifact" i]')` чтобы НЕ захватывать artifact-pane markdown в текст обычного ответа (иначе дубль).

## Детектор «research завершён» — perplexity.ai

**Реальный aria-label у Stop button — `«Остановить ответ (Esc)»`, не голое «Остановить».** Старый exact-match selector `[aria-label="Остановить"]` никогда не находил → `stopAppeared` всегда `false` → watcher думал что Stop вообще не появлялся → done срабатывал на первом появлении документа (false done, документ ещё стримит). Match по префиксу: `Array.from(document.querySelectorAll('button[aria-label]')).find(b => /^Остановить/i.test(b.getAttribute('aria-label')))`.

**Финальная карточка документа** — `div.prose.dark\:prose-invert.max-w-none` с дочерним `h1.font-editorial`. Это контейнер с research-документом (заголовок + полный markdown). На странице может быть несколько таких — берём последний по document order.

**`hasDocument()` ≠ «документ готов» — нужен `documentComplete()` (spinner + «Скачать»).** Главный шрам early-done. Старое условие watcher'а `!stop && (submit || hasDocument())` считало появление `h1.font-editorial` сигналом завершения. Но карточка документа возникает в DOM **в начале стрима**, с ◯-спиннером у заголовка и наполняется от ~370 символов до десятков тысяч. Живой capture (job `rczazicps`/`rriqxvq3`, sampler пушил в bridge `pplx.obs`) зафиксировал момент появления карточки: `stop:true, cards:1, spin:1, dl:false, len:373` — против done-state той же карточки `stop:false, spin:0, dl:true, len:24528`. Watcher хапал 373-символьный фрагмент. **Дискриминатор завершения — НЕ время и НЕ существование h1, а: (1) спиннер `[class*="animate-spin"]` внутри корня карточки исчез, И (2) появилась кнопка «Скачать»** (её рендерит только достроенный документ; fallback — текст карточки стабилен ≥1.5с по wall-clock, не по тикам: tick идёт до 60/сек через rAF). `documentComplete()` проверяет именно это. Корень карточки — подъём от `h1.font-editorial` до контейнера с кнопкой «Копировать содержимое» (`findDocCardRoot`), не сама `.prose`-нода (спиннер и «Скачать» в шапке, выше `.prose`).

**Quiet-window 3с (калька с claude-side).** После того как Stop у композера исчез, perplexity ещё может на пару секунд дописать **дополнительный ответ** под карточкой документа (юзер: «после этого дополнительный ответ ещё пишется»). Без quiet-window watcher ловил done в этой паузе. `lastStopSeenAt` + требование `sinceStopGone ≥ 3000ms`. Для обычного ответа (документа нет) done = `submit` вернулся И quiet прошёл; для research-flow done = `documentComplete()` И quiet. Проверено на живом search-mode: tick `submit:true,quiet:false` НЕ fire'ит, следующий `quiet:true` — fire (старый код сработал бы на первом).

**Stable polling после Stop quiet** (см. секцию Perplexity DOM-quirks ниже). Дублирующая страховка в `extractAnswerText`: extractor тоже ждёт пока `docCardStreaming()` (тот же спиннер-чек) погаснет, плюс стабилизацию длины. Без этого extractor выдавал обрезанный текст в первый момент когда документ ещё стримился.

**Upsell-modal при locked feature → clean error за 17с.** Дневной free-лимит Perplexity исчерпан → «Глубокое исследование» в `+`-меню становится Pro-locked. UI-side: role меняется с `menuitemradio` (unlocked toggle) на `menuitem` (action that opens upsell). Клик не переключает mode — открывается `[role="dialog"]` с aria-label/text вроде «Обновитесь для расширенных возможностей исследования» / «Upgrade to Max for extended research». Раньше watcher не понимал что mode не переключился, Stop button никогда не появлялся → таймаут 30 мин. `findUpsellModal()` после click'а в меню проверяет наличие диалога с regex `/обновитесь|upgrade|перейдите\s+на\s+max|расширенный\s+доступ.+глубокому|max\s+for\s+extended/i` по aria-label+text — если match, throw `pplx_daily_limit: <label>`. SKILL по этой ошибке может fallback'нуть на `provider:"claude"`. Selector `findMenuItemRadioByLabel` расширен на ОБА role'и (`menuitemradio` + `menuitem`) — без этого CS не находил пункт меню в locked-state.

## Mode selection — deep vs search

`options.mode` в `/research-start` body выбирает между двумя режимами Perplexity:
- `'deep'` (default) → «Глубокое исследование», 5-25 минут, `text_kind: 'document'`,
  полноценный markdown с заголовком и структурой.
- `'search'` → «Поиск», до 5 минут, `text_kind: 'thread_answer'`, более короткий
  ответ-обзор с цитатами. Бесплатный для всех, не требует Pro.

`perplexity-research.js::ensureModeSelected(mode)` — обобщение `ensureDeepResearchSelected`,
читает `MODE_LABELS[mode]` (deep → «Глубокое исследование», search → «Поиск»), кликает
соответствующий menuitem в dropdown'е mode-trigger'а.

**Mode-trigger vs model-trigger — два разных button[aria-haspopup="menu"]** на одной
странице. Различаются по фильтру:
- Mode trigger: `(b.textContent || '').trim()` совпадает с одним из значений mode-набора
  (Поиск / Глубокое исследование / Совет моделей / Учитесь шаг за шагом). aria-label отсутствует.
- Model trigger: `b.getAttribute('aria-label')` совпадает с именем текущей модели
  (`GPT-5.4 Thinking`, `Claude Opus 4.7`, etc). textContent тоже отображает модель, но в
  selector'е надёжнее aria-label — её формат стабильнее (нет лишних whitespace из иконок).

## Model selection: реестр PPLX_MODELS + locked-detect + /pplx-models

`options.model` в `/research-start` выбирает модель (ярлык, регистр/частичное совпадение
ОК). Дефолт — **Gemini 3.1 Pro** (не GPT-5.4 как было). `options.reasoning` (default true)
тогглит «Рассуждение». Выбор модели — **только в режиме `search`**; в `deep` Perplexity
сам управляет моделью, селектора на странице нет (форма его прячет).

**Единый реестр `PPLX_MODELS`** в `perplexity-research.js` — одно место, добавить модель =
одна строка `{key, match, aliases, locked?}`. `resolvePplxModel(input)` резолвит ярлык
юзера (`"gemini"`, `"gpt"`, `"sonnet"`) в каноничную строку меню по match/aliases. Реестр —
источник правды; CS на каждой загрузке Perplexity-страницы POST'ит его в bridge
(`/pplx-models-register`), а `GET /pplx-models` отдаёт нейронке/UI актуальный список с
locked-флагами. Так список не дрейфует от того что реально работает (живёт рядом с логикой
выбора, а не дублируется в skill).

**locked-detect — по `role`, не по 🔒-иконке:**
- доступные модели → `role="menuitemradio"` (кликабельны): `Лучший`, `Sonar 2`, `GPT-5.4`,
  `Gemini 3.1 Pro`, `Claude Sonnet 4.6`, `Kimi K2.6`, `Nemotron 3 Super`.
- Max/locked → `role="menuitem"` (не radio): `GPT-5.5 Max`, `Claude Opus 4.8 Max`.
- **Рассуждение** → `role="menuitemcheckbox"` (toggle). Бывает `aria-disabled` для
  некоторых моделей/режимов — guard: не кликать по disabled.

`ensureModelSelected` сначала ищет пункт среди ОБОих role (`findAnyModelItemByLabel`):
если найден но не `menuitemradio` → `throw 'pplx_model_locked: модель X недоступна (Max)'`
(чёткая ошибка вместо тихого падения на дефолт). Поиск через startsWith — exact ломается
на хвостах (`Sonar 2` + «Новый» badge, `Kimi K2.6` + «Новый»).

**Баг: триггер модели не находился на свежей странице.** `findModelTrigger` искал кнопку
по regex имени модели (`GPT|Sonar|Gemini|…`). Но на **свежей** странице (модель ещё не
выбрана) триггер имеет дефолтный `aria-label="Модель"`/`"Model"` — regex его не ловил →
`model.trigger_not_found` → выбор модели молча скипался, research шёл на дефолте аккаунта
(симптом: просишь opus, а работает Nemotron). Фикс: добавить `/^(Модель|Model)$/i` в
распознавание + обернуть поиск триггера в `waitFor` (триггер рендерится позже композера,
особенно в hidden tab).

Закрытие dropdown'а после клика — `pressEscape()`, иначе `pasteIntoComposer` промахивается
(dropdown держит focus).

Фоновая вкладка с research'ем сидит без user-input на 30 минут. Chrome 88+ агрессивно тротлит `setTimeout`/`setInterval`:
- обычный фон: 1 такт/сек
- intensive (через 5 мин): 1 такт/мин

**MutationObserver immune к этому** — срабатывает синхронно на реальной DOM-мутации, минуя event loop timer queue. Это ключ к надёжному детектору в фоне. Источник: hh-tool/docs::fact-extension-runtime.md::v0.8.5.

**Anti-intensive-throttling**: `chrome.runtime.connect({name:'sc-research-keepalive'})` в content-script'е. Long-lived port между CS и SW — exemption-условие от intensive throttling (1/мин). Сам по себе непосредственно не нужен (MutationObserver и так immune), но fetch'и `POST /research-state` уходят через `setTimeout` queue — без exemption они после 5 мин начали бы лагать на минуту.

Закрываем port в `finally` (terminal-state job'а), чтобы не держать SW активным после завершения. Background SW принимает connection через `chrome.runtime.onConnect.addListener` с `port.name === 'sc-research-keepalive'` — никакого state, никаких сообщений, только сам факт port'а.

Изначально keepalive port был только в Claude CS. PPLX добавлен в этой же сессии после симметричного симптома (long-poll возвращался только когда юзер вручную фокусил вкладку). Реализация полностью идентична Claude'у, не отдельный модуль — copy внутри `perplexity-research.js`.

## Throttle MutationObserver через rAF

На активном research'е claude.ai генерирует сотни DOM-мутаций в секунду (stream рендерится по токену). Без throttle `tick()` жарил бы CPU; мы оборачиваем в `requestAnimationFrame`-флаг — максимум 1 tick на frame (~60/сек), не на каждую мутацию.

## Click strategy: MAIN-world через `chrome.scripting.executeScript`

**Claude.ai CSP режет любые синтетические клики из content-script'а.** Это не general issue — это специфика именно claude.ai. У него `script-src 'self' 'nonce-XXX'`; ноncе из CS не видны (Chrome скрывает после load), inline `<script>` тег с execCommand не пробивает CSP. Synthetic dispatchEvent chain `pointerdown → mousedown → pointerup → mouseup → click` обрабатывается base-ui но **не воспринимается** Confirm-dialog'ом и Send-button'ом как trusted interaction. Видимый симптом: `confirm.click` написано в логе, но dialog **остался открыт**, Send-button **не нажат**, на странице ноль реакции.

**Что пробовали и не сработало**:
- Прямой `el.click()` из CS — Lexical в Perplexity принимает, claude.ai игнорирует.
- Synthetic chain `dispatchEvent(new MouseEvent(...))` — открывает radix popover (он на pointerdown), но Confirm-dialog режет.
- Inline `<script>` тег с `document.querySelector + el.click()` — режется CSP.
- `chrome.userScripts.execute({world:'USER_SCRIPT'})` — требует enabled toggle Chrome 138+, ненадёжно как primary.

**Решение**: `chrome.scripting.executeScript({target:{tabId}, world:'MAIN', func: ...})` — это extension API, CSP его не касается. CS ставит data-attr на элемент (`[data-sc-mw-click="<markId>"]`), шлёт `chrome.runtime.sendMessage({__sc_main_click, markId})` в SW, SW делает executeScript в MAIN world который querySelector'ит mark и зовёт `.click()`. Click из page-VM (MAIN world) воспринимается React/base-ui как trusted.

`mainWorldClick(el)` в `claude-research.js` async по этой причине. Используется для Send-button и Confirm-dialog. Для radix-trigger'ов (открыть/закрыть `+`-меню) `mainWorldClick` НЕ работает — radix слушает pointerdown, не click; туда отправляем `nativeMousePointerChain` (synthetic chain). Две разные стратегии под две разные UI-библиотеки.

**Pointer-chain в SW `__sc_main_click` handler.** Голый `el.click()` из MAIN-world внутри `chrome.scripting.executeScript` claude'ом принимался как trusted **не для всех элементов** — Send-button иногда не реагировал, хотя `el.click()` отрабатывал без ошибки. Заменили на полную цепочку trusted events: `pointerdown → mousedown → pointerup → mouseup → click`, диспатченные на element'е через `dispatchEvent(new PointerEvent/MouseEvent(...))` внутри MAIN world. Без полного chain'а base-ui (Anthropic UI-stack) считает interaction'е incomplete и игнорирует.

## Confirm dialog «Enable connectors for Claude to use in research»

**Этот диалог появляется ПОСЛЕ Submit'а, не после toggle Research.** Изначальное предположение «Confirm — продолжение toggle» было неверным: после клика Research-checkbox в `+`-меню диалога нет; он всплывает через 2-10 секунд после Send. Если за ~30с не нажать Confirm — research отменяется на стороне Anthropic с error «No response on which connectors to enable during research», и в DOM появляется блок «Stopped».

**Решение**: `startConfirmAutoClicker` стартует **в main() сразу после clickSend()** и крутится пока watcher не вышел в done/error. MutationObserver на `documentElement` (не на body — Anthropic рендерит dialog как прямой child html через portal) + active polling `setInterval(500ms)` 60 секунд (страховка если MO не увидит появление через shadow DOM или другой портал). Селектор: `[role="dialog"] button` с text === `Confirm` (либо «Подтвердить» / «OK» — на разных локалях). Click через `mainWorldClick` (см. предыдущую секцию).

**Если у юзера Excalidraw/connectors уже сконфигурированы — диалог не появляется**. Auto-clicker no-op'ит, watcher работает.

**Verify-and-retry с giveup.** Раньше auto-clicker делал `mainWorldClick` и считал работу законченной — а dialog иногда оставался открыт (особенно когда research'ов несколько подряд и Anthropic показывает повторный Confirm). Сейчас после click'а ждём 500мс и проверяем `[role="dialog"]` всё ещё видим — если да, retry. Максимум 3 попытки. На 4-й — `pplx_*`-style clean error `confirm_giveup: dialog still visible after 3 retries`. Без этого watcher тихо ждал бы Stop button, который никогда не появится.

**Кнопка стала `"Confirm⏎"` — строгий `/^Confirm$/` перестал матчить.** claude.ai добавил
в кнопку keyboard-hint: `textContent` теперь `"Confirm⏎"` (Confirm + U+23CE, иногда с `\n`),
не голое `"Confirm"`. Старый матчер `/^Confirm$/i` с anchor'ом `$` это не ловил → кликер
видел диалог, перебирал кнопки, **ни одной не матчил**, тихо `return false`. Симптом из
живого теста: **ноль `confirm.*` событий в логе** (не «клик не сработал», а «кликер кнопку
не нашёл»), диалог висит вечно, research не стартует. Фикс: матчить **первое слово-токен**
вместо точного равенства — `((b.textContent||'').match(/\p{L}+/u)||[''])[0].toLowerCase() === 'confirm'`
(или `подтвердить`/`ok`). Промежуточный фейл фикса: `/^Confirm\b/` — `\b` в JS **не
Unicode-aware**, ломался на `"Подтвердить⏎"` (после кириллицы граница слова срабатывает
неверно); потому ушли на извлечение первого буквенного токена через `\p{L}+`.

## claude.ai SPA-bug: periodic reload каждые 90 секунд

**Подтверждённый юзером баг claude.ai SPA**: research завершается на бэке (Anthropic присылает финальный markdown + research-card), но UI на вкладке **не обновляется до F5**. Симптом: панель research'а застревает на «N sources and counting…» 10+ минут, в реальности research давно закончен. В момент **физической перезагрузки** вкладки — финальное состояние мгновенно отрисовывается. Этот баг наблюдается даже на активной вкладке, не только в фоновых — это claude.ai-side, не наша throttling-проблема.

**Решение**: `startPeriodicReload` в `claude-research.js` крутит `setInterval(15s)` — если прошло ≥90с от `performance.timeOrigin` (момент загрузки страницы) → `location.reload()`. Hash `#sc-research=<id>` переживает reload, после reload новый CS читает `status='running'` через `/research-job` → попадает в `isReloadRestart=true` ветку (см. ниже) → пропускает submit-pipeline, только заводит watcher заново.

**Guards** (`reload.skip.*` маркеры в DOM-логе):
- `stopEverSeen` — не reload'имся пока Stop button **хоть раз не появился**. Без этого: если submit не сработал (Send-button есть, prompt не отправлен), reload попадает на `/new` с пустым composer'ом — research потерян.
- `streaming` — `findStopBtn()` сейчас активен, research что-то стримит. Reload посреди стрима риск потерять финальный chunk.
- `final_visible` — `panel.aria-label` уже содержит «N sources» без «and counting» → финал виден, reload не нужен, останавливаем interval.

**Force-reload despite Stop (5-min threshold).** Streaming-guard выше блокирует reload пока Stop активный — но claude.ai SPA-bug бывает в форме «Stop активный 10+ минут, никакого стрима нет». Решение — два слоя:
1. `researchStartTs` сохраняется в `window.name = "sc-research:<id>:<startTsMs>"`. window.name **переживает `location.reload()` same-origin** (но не cross-origin / crash-restore). Это **обязательно** — без persistence `performance.timeOrigin` обнуляется на каждый reload, счётчик «5 мин от старта» никогда не достигается.
2. После `FORCE_RELOAD_MS = 5 минут` от **`researchStartTs`** (не от pageLoadTs!) — force-reload **даже если Stop активный**. В лог пишется `reload.force_despite_streaming`. Если research реально живой — потеряем последний chunk, но research переподнимется через reload-restart ветку и watcher досмотрит. Если research уже sticky (SPA-bug) — это единственный способ закончить.

**Force-reload elapsed counter per-pageload bug.** Изначально threshold считался от `performance.timeOrigin`, который обнуляется на каждом reload. Симптом: первый reload сделался корректно через 90с, после него `elapsed` обнулилось → следующий force-reload-tick никогда не превысит 5 минут (после 90с reload снова обнуляет) → force-fallback бесполезен. Фикс — отделить два таймера: 90-сек tick от `pageLoadTs`, 5-мин threshold от `researchStartTs` (persistent через window.name).

**`reload.skip.final_visible` без exclude «and counting» — false stop.** До этой сессии regex `\b\d+\s+sources\b` срабатывал на промежуточное «281 sources and counting» — reload-iv останавливался на середине research'а, force-reload-фолбэк больше никогда не fire'ил даже если research зависал. Сейчас add'нут exclude `/and\s+counting/i` симметрично с watcher-side детектором.

**Port-copy в `perplexity-research.js`.** Изначально `startPeriodicReload` был только в Claude CS. PPLX в фоне страдал тем же background-freeze (long-poll не возвращался пока юзер не сфокусил вкладку). Скопировали force-reload+keepalive в pplx-side с pplx-специфичными терминаторами (`h1.font-editorial` финального документа, `findSubmitBtn()` для streaming check'а).

**PPLX-side force-reload диверговал с claude-side: ЗАСТОЙ контента, не 5-мин таймер.** Claude-side `FORCE_RELOAD_MS = 5min force_despite_streaming` (выше) на perplexity **ломал живой длинный research**. Живой capture (`rriqxvq3`, sonar, deep): research легитимно искал ~6.8 минут со `stop:true` всё это время (карточка появилась только в конце), а 5-мин таймер сработал на t=347s → `location.reload()` → re-inject CS → re-run `ensureModeSelected('deep')` → попал в `pplx_daily_limit` upsell → research убит на почти-готовом состоянии. Дискриминатор «живой» vs «завис» на perplexity — **изменение контента, а не время**: длинный research это норма; завис — это когда DOM перестал меняться. Трекер `livenessSig()` = `docLen + bodyLen + hasStop`; reload-при-Stop теперь только если сигнатура не менялась `≥ STAGNATION_MS (4 мин)` (`reload.force_stagnant`), иначе `reload.skip.streaming` сколько бы ни шло. Важно ловить ЛЮБОЕ изменение, не только рост: synthesis-фаза может сокращать видимый статус («Reading 51 sources» → «Synthesizing»), длина падает, но страница активна — счётчик-по-росту начал бы ложную стагнацию. Claude-side таймер не трогали — там SPA-bug имеет иную форму (Stop sticky без стрима с самого начала), и нет re-mode-select на reload'е.

**Что пробовали и не сработало**:
- `Object.defineProperty(document, 'visibilityState', {get: () => 'visible'})` (visibility-override из hh-tool) — не помогает, баг не в `visibilityState` checks, а в самом SPA-обновлении.
- Бóльшее `QUIET_WINDOW_MS` для Stop — не помогает, проблема не в детекторе, а в том что DOM **физически не меняется** на бэк-side updates.
- MAIN-world keep-alive ping на window — не помогает.

### isReloadRestart scenario

Когда CS заинжектился **после reload**, `fetchJob` возвращает `status='running'` (от прошлого `postState({status:'running'})` который сделал предыдущий CS). Это отличие от первого инжекта где `status='queued'`. `main()` ветвится: при queued — полный pipeline (configure → paste → submit); при running — `main.skip_submit_after_reload`, только `startDoneWatcher` + `startConfirmAutoClicker` + `startPeriodicReload`. Без этого reload крутил бы submit заново на пустом composer'е и засорял чат повторными отправками.

## Perplexity done-detection: poke-binding и piggyback на reload-loop

Два шрама done-detection, специфичные для perplexity (в claude были изначально, в pplx —
портированы/починены в этой сессии).

**`window.__scResearchPoke` не присваивался — SW-watchdog бил впустую.** Poke-механизм
(SW `chrome.alarms` каждые 30с шлёт `__sc_research_poke` → CS-listener зовёт
`window.__scResearchPoke()` чтобы форсировать `wrappedTick` в throttled/frozen вкладке)
был **только в claude**. В perplexity listener стоял, но `window.__scResearchPoke` нигде
не присваивался → `poke.no_handler` в логе, alarm бил в пустоту. Симптом: done детектился
с задержкой (только когда юзер фокусил вкладку). Фикс — присвоить `window.__scResearchPoke = pokeHandler`
внутри `startDoneWatcher` + cleanup, точная калька claude-паттерна.

**Done детектился медленно — piggyback на reload-loop.** Даже с poke между готовностью
ответа и его детектом было окно ~20с: `setInterval(20000)` watcher'а в hidden-вкладке
throttled, MutationObserver молчит когда DOM не меняется (ответ дописался), а poke раз в
30с. Решение: (1) interval watcher'а 20с→2с; (2) **дёргать `window.__scResearchTick` из
reload-loop'а** — тот тикает каждые 15с надёжно даже под intensive-throttling (доказано:
`pplx.reload.tick` идёт в логе стабильно). Done теперь срабатывает ≤15с после готовности,
не дожидаясь force-reload (90с). Контрольный замер: было 55-111с, стало ~15-17с.

**watcher.tick спамил тысячами в секунду.** Debug-лог на каждый tick × MutationObserver на
`body+subtree+attributes` (Perplexity при стриме меняет DOM сотни раз/сек) = `n:1056→1136`
за 1 секунду в production.log. Фикс: логировать tick **только при смене сигнатуры**
состояния (`[submit, stop, doc, armed].join()` ≠ предыдущей) — диагностика переходов
сохранена (3 tick на джоб вместо тысяч), спам убран.

## Фоновая вкладка замерзает — freeze + render-freeze (глобальный паттерн)

**Главный шрам, подтверждён юзером дважды.** Фоновая automation-вкладка деградирует двумя способами, оба лечатся одним механизмом:
1. **Lifecycle freeze** (never-active): вкладка открыта в фоне и ни разу не была active → Yandex/Chrome замораживают JS execution целиком (MutationObserver молчит, setInterval не тикает, keep-alive port жив но бесполезен).
2. **Render-freeze при деактивации всего браузера** (кейс `rm6equid`): вкладка «живая» и не discarded, но юзер надолго ушёл из браузера → Chromium глушит rAF/таймеры на уровне renderer'а. Watcher тикает раз в ~12-30с (только от SW-poke), DOM не коммитится. autoDiscardable тут НЕ помогает (это про discard, не про rendering).

Общий симптом: `status` застрял на `running`, юзер кликает вкладку → всё мгновенно «дорисовывается» и завершается (его клик и есть то, что разморозило renderer).

Историческая заметка (что было до текущего решения): сначала боролись focus-pulse'ом (открыть active → вернуть фокус, юзер видел ~50мс flash), потом заменили на `autoDiscardable:false` (без flash, но покрывает только lifecycle freeze, не render-freeze). Текущее единственно-достаточное решение — `attachFocusEmulation`, см. ниже.

### Основной слой (актуальный): `attachFocusEmulation` для ВСЕХ automation-вкладок

**Это глобальный паттерн, не aistudio-частность** — единственное, что детерминированно держит фоновую вкладку живой. `mcp_open_research_tab` сразу после `chrome.tabs.create({active:false})` зовёт `background.js::attachFocusEmulation(tabId)`: `chrome.debugger.attach` + `Emulation.setFocusEmulationEnabled({enabled:true})`. Это держит `Page::IsPageVisible()=true` на C++ уровне renderer'а → rAF тикает на 60Hz → React/Angular коммитят DOM в фоне, таймеры не троттлятся. Подробная механика (почему JS-override visibilityState не работает, почему именно debugger) — `fact-aistudio-mcp.md::Hidden-tab strategy`. Домены под emulation перечислены в `background.js::SC_FOCUS_EMULATION_URL` (aistudio | chatgpt | claude | perplexity); тот же regex используют `onDetach` и 15-секундный watchdog для auto-reattach, если emulation слетела при SPA-навигации.

**Почему autoDiscardable/focus-pulse/alarms-poke НЕДОСТАТОЧНЫ (живой кейс `rm6equid`, 2026-06):** chatgpt-job в pro-режиме с уже стоящим `autoDiscardable:false` завис на 9.5 минут — 48 watcher-тиков за 577с (1/12с вместо штатных 1/2с), done наступил только когда юзер сам кликнул на вкладку. Корень: юзер **деактивировал весь браузер** (отошёл на часы), и Chromium заглушил rAF/таймеры даже в «не-discarded, живой» вкладке. `autoDiscardable:false` защищает **только от discard**, а это render-freeze — другая политика. `attachFocusEmulation` это снимает (rAF тикает независимо от активности окна). Длительность джоба роли не играет — упадёт и быстрый Поиск, если браузер давно деактивирован.

### Вспомогательные слои (остались как defense-in-depth поверх emulation)

- **`autoDiscardable:false`** — `mcp_open_research_tab` ставит его до load complete: страховка от discard (emulation не покрывает discard-политику отдельно). Дёшево, оставлено.
- **SW chrome.alarms watchdog + per-tab poke.** `chrome.alarms` — privileged API, **не подвержен** timer throttling. CS на старте делает `chrome.runtime.connect({name:'sc-research-keepalive'})` — SW регистрирует tabId в `RESEARCH_TABS` Set. Раз в 30с alarm шлёт `chrome.tabs.sendMessage(tabId, {__sc_research_poke})` → CS форсирует `wrappedTick()`. Полезно как нижний слой если emulation по какой-то причине не встала (attach упал, circuit-breaker). Но один tick/30с медленнее emulation — это страховка, не основной механизм.
- **focus-pulse эскалация** (`escalateFocus` в CS) — теперь **dormant-страховка**: при живой emulation render-freeze'а нет, и пульс (выдёргивание окна браузера на передний план) не срабатывает. Остаётся на случай если attach упал и watcher всё же увидел «стрим закончился, DOM пуст».

**Что пробовали и НЕ сработало**:
- `chrome.runtime.connect` keep-alive port — снимает intensive throttling таймеров (1/мин), но не tab freezing и не render-freeze (freeze это про lifecycle/rendering, не про таймеры).
- visibility-override через executeScript MAIN world — `document.visibilityState='visible'` обманывает page-VM проверки, но Chromium читает C++ `Page::IsPageVisible()`, не JS-getter.
- `autoDiscardable:false` сам по себе — спасает от discard, НЕ от render-freeze (кейс `rm6equid` выше).
- Document Picture-in-Picture / silent audio — экзотические workaround'ы из hh-tool::fact-extension-runtime.md::v0.8.5 не работают против lifecycle/render freeze. Единственное что работает детерминированно — `attachFocusEmulation` (chrome.debugger).

## Perplexity DOM-quirks

Несколько неочевидных deталей которые потребовали separate debug:

**Lexical paste через ClipboardEvent + DataTransfer.** Perplexity использует Lexical editor (Meta). `document.execCommand('insertText', false, text)` из CS (ISOLATED world) **возвращает `true`, но текст не вставляется** — Lexical перехватывает event на этапе beforeinput и режет synthetic input не из правильного источника. Из `evaluate_raw` (USER_SCRIPT world) тот же execCommand работает — это разница исполнительных контекстов. Решение для CS:
```js
const dt = new DataTransfer();
dt.setData('text/plain', text);
ed.dispatchEvent(new ClipboardEvent('paste', { bubbles:true, cancelable:true, clipboardData: dt }));
```
Lexical слушает `paste` event и принимает text/plain из DataTransfer как валидный input.

**Submit через Enter, не click.** `keydown('Enter') → keypress → keyup` primary, click submit-button fallback. Submit-button часто **disabled** через ~200мс после paste — React не успевает обновить state. Решение: sleep 800мс между paste и submit; первая попытка Enter, проверка `!findSubmitBtn() || pathname.startsWith('/search/')` — если submit пропал ИЛИ URL сменился, значит сработало. Иначе fallback `nativeMouseClick(submitBtn)`.

**Selector финального документа.** `div.prose.dark:prose-invert.max-w-none` (escapes: `div.prose.dark\\:prose-invert.max-w-none` в querySelectorAll) с дочерним `h1.font-editorial` — это и есть карточка research-документа со «Скачать»-кнопкой. Заголовок документа в этом h1, **не в document.title**.

**Stable polling после Stop quiet.** Юзер подтвердил: финальный документ Perplexity показывается **ДО** завершения генерации, продолжает стримиться ещё ~30-60 секунд. Если извлечь сразу как только увидели документ — получим обрезанный текст (на тесте: 233 chars из реальных 13710). Решение в `extractAnswerText`:
1. Wait Stop button to disappear AND не появляться 2500мс (`STOP_QUIET_MS`).
2. Wait document innerText length не растёт 2 probe'а подряд по 800мс (`STABILIZE_MAX_MS=30000` cap).
3. Только после этого return текст.

Без шага 1 шаг 2 даст ложное stable: document может временно остановиться растёт между chunks.

**Fallback на rest/thread API.** Если документ не найден (например clarifying-вопрос), используем `/rest/thread/<slug>?version=2.18` REST API (тот же что `perplexity-content.js` для экспорта). Возвращает `text_kind: 'thread_answer'` вместо `'document'`. Логика выбора copilot vs ASI mode — см. `fact-browser-extension.md::Где лежит финальный текст ответа Perplexity`.

## Recovery: 4 типа потери state

Pipeline имеет 4 разных способа потерять state, для каждого свой fallback. Все они одинаково проявляются на бридже — job застрял в `running` бесконечно — но имеют разные причины и разные пути восстановления.

### 1. Bridge respin (sc-desktop рестартовал)

`research-state.js` RAM-only — рестарт sc-desktop теряет все active job'ы. Content-script на research-вкладке продолжает POST'ить в `/research-state`, получает 404, теряет связь — а research в браузере живёт.

**Fallback**: на 404 в `POST /research-state` если body содержит `provider` → `researchState.recreate({id, provider})` создаёт stub job:
```
{ id, provider, prompt: '', status: 'running', stage: 'recovered', recovered: true }
```
Дальше state-merge продолжается нормально. CS прокидывает `provider: 'claude'` / `'perplexity'` в **каждом** postState — без него bridge не знает что за platform у CS, recovered job нельзя создать.

Prompt при recovery теряется (оригинал был только в исходной job'е). Это нормально: CS уже сделал submit ДО bridge respin'а, prompt'а ему больше не нужно. Reload-restart ветка в `main()` сработает корректно (`isReloadRestart=true` для status='running'), CS только заведёт watcher.

`GET /research-job` на recovered job вернёт 404 (потому что prompt пустой). Это **не покрывает** случай когда CS заинжектился **впервые** после bridge respin'а (юзер открыл вкладку с #sc-research=... вручную позже). Этот edge-case не покрываем — слишком редкий.

### 2. Periodic reload (claude.ai SPA-bug fallback)

CS сам себе делает `location.reload()`. URL hash сбрасывается с первого history.pushState (claude.ai после создания чата делает push на `/chat/<uuid>` без hash). `getRequestId()` после reload берёт id из `window.name = "sc-research:<id>:<startTsMs>"` — этот formant переживает same-origin reload, см. секцию про periodic reload выше.

### 3. Crash-restore / discard (window.name потерян)

Если Chrome дискардил вкладку (memory pressure / system sleep / network drop восстановление) и потом восстановил — window.name **сбрасывается**. Это новый process, не reload. Симптом из живого debug'а сессии: bridge видел последний CS-event в 00:29:40, потом 6 минут тишины, потом `performance.timeOrigin` показал что новая загрузка была в 00:35:47 — Chrome перезагрузил вкладку сам, и `window.name === ""`, `location.hash === ""`. `getRequestId()` вернул null → силент exit.

**Fallback**: `recoverIdByTabId()` в `claude-research.js`. CS просит у SW свой tabId (`chrome.runtime.sendMessage({__sc_get_tab_id})` → SW смотрит `sender.tab.id`). Затем дёргает `GET /research-by-tab?tabId=N` — bridge возвращает самый свежий `running` job привязанный к этому tabId. Если найден — id восстановлен, window.name переустановлен, watcher запускается в `isReloadRestart=true` режиме.

Без этого fallback'а после crash-restore research висел бы в RAM bridge'а зомби-running'ом до 24-часового GC. Юзер видит «research завершён в браузере» (panel с N sources на вкладке), но bridge не знает.

**Caveat: recovery по tabId обязан учитывать provider.** Живой post-mortem после
зомби ChatGPT jobs: старая вкладка `tabId=57069372` уже навигировала на
`perplexity.ai`, Perplexity CS сделал `cs.no_id_try_recover`, а
`/research-by-tab` вернул старый running ChatGPT job `rkkhjzer…` по тому же tabId.
Итог — Perplexity-пайплайн начал configuring чужого job'а и записал в него
`pplx_model_locked`, хотя исходный результат был ChatGPT. Если трогаешь
`recoverIdByTabId` / `/research-by-tab`, не считай tabId достаточным identity:
provider из ответа должен совпасть с текущим CS/provider domain, иначе recovery надо
отклонять.

### 4. Тихий ext-reload во время research'а

Если расширение перезагрузилось (`chrome.runtime.reload()` — hot-reload в dev, или manual ⟳) пока research активный, CS на странице получает teardown (chrome.* объекты становятся inaccessible), watcher умирает. Новый CS впрыснется только при следующей навигации — если research уже завершился до этого момента, watcher.done не сработает.

Частичный fallback — реальная навигация (force-reload по 5-мин threshold) переподнимает CS под новым ext-version'ом, и **новый** CS зайдёт в recovery flow через window.name (если ещё set) или через tabId. Не идеал — но не зомби.

В prod-сборке ext hot-reload не работает в принципе (`__ext_version` endpoint возвращает 404, browser-extension/ не упакован в asar — см. секцию «Production hot-reload не работает»). Manual ⟳ убивает CS, watcher теряется. В dev — hot-reload работает (10-15 сек после правки), и это **частая причина** что watcher.done не сработал на dev-research'е, и приходится мануально дотягивать.

## Канал CS→bridge: scBridgeFetch (page-fetch → SW-fallback)

Все запросы CS к bridge (`fetchJob`, `postState`, `bridgeLog`, recovery) идут через общий
`window.scBridgeFetch` из `research-badge.js` (он в manifest подключён ПЕРЕД каждым
research-CS — тот же приём, что `window.scResearchBadge`). Внутри: page-fetch с таймаутом
4с → при сетевом провале **sticky-переключение на SW-канал** (`{__sc_bridge_fetch}` →
SW fetch'ит от extension-origin) до конца жизни страницы.

Зачем: страничный fetch на `127.0.0.1` режется **Local Network Access** (Chromium 138+)
per-origin. Две формы отказа, обе ловили вживую:
- юзер ещё не отвечал на диалог → fetch **молча висит** до таймаута (chatgpt-кейс,
  `fact-chatgpt-research.md::LNA-диалог`);
- юзер когда-то нажал «Блокировать» → fetch падает **мгновенным TypeError** (~12мс), и
  диалог больше не покажется. Claude-кейс этой сессии: `permissions.query({name:
  'local-network-access'})` на claude.ai вернул `denied`, CS бутался и молча умирал на
  fetchJob → job вечно `queued` при живых `sw.tab.*` событиях (SW-канал LNA не подвержен —
  это и был детерминированный указатель на решение).

SW-канал в handler'е принимает только path с `/` (allowlist формы, не произвольный URL).
Page-канал остаётся первым — он быстрее (без SW round-trip) и работает у большинства
origin'ов.

## Стоп, tab-closed и submit-verify fallback'и

Три контракта против зомби-job'ов (все три — из одного инцидента: job висел в «Запущенные
MCP» 30+ минут, Стоп не работал, вкладка была закрыта руками, а CS вообще не стартовал):

**`POST /research-stop {id}`** — детерминированный стоп: job → `error stage=stopped`
«Остановлено пользователем» **сразу** (не дожидаясь закрытия вкладки — у зомби tabId
может быть null), потом `mcp_close_tab`. Кнопка «Стоп» в попапе зовёт его через IPC
`research:stop`. Раньше кнопка била прямым fetch'ем из renderer'а → CORS резал до сети →
«нажимаю стоп, ничего не происходит».

**Tab-closed fallback**: вкладку закрыли руками → `sw.tab.onRemoved` → bridge
`failAllByTabId(tabId)` переводит все non-terminal jobs этой вкладки в
`error stage=tab_closed` «Вкладка браузера закрыта». Две обязательные детали:
- tabId пишется в job **сразу на `/research-start`** (после `mcp_open_research_tab`), не
  при первом postState CS — иначе зомби-job (CS не стартовал из-за LNA) ничей и его нечем
  прибить;
- вкладка регистрируется в `RESEARCH_TABS` **при открытии** в `mcp_open_research_tab`, не
  при keepalive-connect CS — по той же причине (нет CS = нет порта = нет onRemoved-лога).
Terminal jobs не трогаются: авто-закрытие вкладки после done тоже даёт onRemoved.

**Submit-verify** (контракт юзера: «кнопка отправки не сменила состояние → ошибка»):
после клика Send CS ждёт детерминированный маркер отправки — Stop появился ИЛИ своё
user-message в DOM (claude), Stop ИЛИ редирект на `/search/` (pplx), Stop за 120с
(chatgpt, было изначально). Маркер не пришёл за verify-окно (90с) → `status='error',
stage='submit_failed'`, все watcher'ы/reload-циклы глушатся. Без этого «пустая вкладка»
(paste/click не сработали) висела в running до hard-cap 30 минут.

## Терминальный статус подтверждается перед teardown'ом

Четвёртый контракт против зомби — из живого кейса `ryccfz` (chatgpt, pro-режим): job
отработал за 5.5 мин, `gpt.watcher.done` корректно поймал готовый ответ, но в bridge
**не пришёл** финальный `status=done`, и job навсегда остался `running` (GC не трогает
non-terminal). При этом `sw.tab.onRemoved` для его вкладки в логе **отсутствовал** —
tab-closed fallback (секция выше) не сработал, хотя вкладка закрылась.

Корень — порядок teardown в done-хендлере CS разоруживал **оба** предохранителя сразу.
Было: `postState({status:'done'})` (fire-and-forget — глотает ошибку, ничего не
возвращает) → `stopKeepAlive()` → `closeSelfTab()`. `stopKeepAlive()` рвёт keepalive-порт
→ SW `port.onDisconnect` делает `RESEARCH_TABS.delete(tabId)` → когда вкладка реально
закрывается, `onRemoved` первой строкой `if (!RESEARCH_TABS.has(tabId)) return` молча
выходит, `failAllByTabId` не зовётся. То есть если финальный POST потерялся (LNA-таймаут,
вкладка уже рвётся), bridge остаётся в `running`, а fallback, который должен был это
поймать, уже снят тем же teardown'ом. Сам `onRemoved`↔`onDisconnect` порядок на закрытии
вкладки гонка — поэтому tab-closed fallback **в принципе не может** быть единственной
гарантией терминального перехода.

Решение — `postTerminalState(id, patch)` в каждом CS (chatgpt/claude/perplexity):
POST → читает echo-snapshot (`/research-state` отвечает `publicSnapshot`) → подтверждает
что bridge смерджил нужный `status` → 5 ретраев с backoff. Первый attempt идёт
page-каналом; при сетевом провале `scBridgeFetch` sticky-переключается на SW-канал
(LNA-иммунный) — ровно тот путь, что довезёт потерянный POST. `stopKeepAlive()` +
`closeSelfTab()` (и любой `stopKeepAlive` на error-путях: timeout, submit_failed,
model/config fail, confirm_failed, stopped, flow_err) вызываются **только** при
подтверждении. Не подтвердилось за 5 попыток → порт остаётся живым (tab-closed fallback
снова вооружён), вкладка открытой (ответ виден для ручного разбора), персистентный
`bridgeLog('<prov>.terminal.giveup')` (переживает закрытие вкладки — в отличие от in-DOM
`log()`, который и потерялся в инциденте: postState-ошибка писалась только через `log()`).
Промежуточные `stage`-апдейты остаются fire-and-forget — там потеря безвредна.

**Body-limit failure — отдельный класс, ретраи не помогают.** Живой кейс
`rja1mjv8…` / `rkkhjzer…`: ChatGPT watcher корректно дошёл до
`gpt.watcher.done {hasAnswer:true}`, но terminal `POST /research-state` содержал
structured result с большим `sources/source_activity` и bridge отклонял его как
`request body too large` (`129233 > 65536`, `77152 > 65536`). `postTerminalState`
честно сделал 5 попыток и ушёл в `gpt.terminal.giveup`, но payload каждый раз был
тем же — это не сетевой flake. Контракт после фикса: малые управляющие endpoints
остаются на 64KB, `/research-start`/`/research-create` — 2MB,
`/research-state`/`/aistudio-state` — 5MB. Не снимай лимит глобально: loopback
bridge всё равно должен отсекать случайный huge POST; поднимать надо адресно под
канал, где большие ответы являются нормой.

> **Что пробовали мысленно и почему не то.** Наивный fix — «починить tab-closed fallback,
> чтобы он ловил и этот случай». Не годится: fallback опирается на членство вкладки в
> `RESEARCH_TABS` на момент `onRemoved`, а его снимает `stopKeepAlive()` до закрытия —
> плюс сам порядок событий на закрытии гонка. Правильный инвариант — сделать **сам
> терминальный write надёжным** (подтверждение + ретрай по более живучему каналу), а не
> чинить страховку, которая по построению ненадёжна.

## Передача задания в content-script

Content-script видит вкладку через URL hash (claude) / query (perplexity) / оба (chatgpt):
```
https://claude.ai/new#sc-research=<requestId>
https://www.perplexity.ai/?sc-research=<requestId>
https://chatgpt.com/?sc-research=<requestId>#sc-research=<requestId>
```

CS при старте:
1. Парсит `requestId` из URL
2. `fetch http://127.0.0.1:53127/research-job?id=<requestId>` — получает `{prompt, options, status}`
3. Делает работу
4. `POST /research-state` с обновлениями

Почему так, а не через `chrome.storage.local` (как у autoscrape):
- bridge единственный знает истинный prompt — он же его создал в `/research-create`. Не нужно дублировать в SW storage.
- При SW respin'е CS просто перечитывает с bridge'а — `local` storage переживает respin, но bridge надёжнее (sc-desktop живёт стабильно, SW тротлится).
- MCP-сервер не имеет доступа к chrome.storage — а к bridge'у имеет.

Для perplexity используем `?` query вместо `#` hash, потому что Perplexity SPA при первом submit'е делает `history.pushState` с заменой hash → CS теряет requestId. Query-param остаётся, потому что Perplexity редиректит с `/?...` на `/search/<uuid>` сохраняя только `slug` — но к моменту редиректа CS уже зачитал id и больше не нуждается в нём.

Для chatgpt — query И дубль в hash одновременно: ChatGPT SPA при submit'е pushState'ит на `/c/<uuid>` срезая query, hash страхует ре-инжект CS до того как window.name установлен.

## Bridge endpoints

```
POST /research-start      {provider, prompt, options?}
                          provider:'claude'|'perplexity'|'chatgpt' → researchState, id='r…'
                          provider:'aistudio'|'gemini'   → sendToExtension('mcp_aistudio_start'), id='aim_…'
                          → {id, provider, tabId, url, status}
GET  /research-job?id=…   → {prompt, options, status}    CS читает на старте
GET  /research-by-tab?tabId=N → {id, provider, status, …}  CS recovery (crash-restore)
POST /research-state      {id, status?, stage?, tabId?, url?, error?, result?}
                          partial merge; на 404 если body.provider → recreate stub.
                          tabId сохраняется (CS шлёт свой tabId в первом postState —
                          раньше был null/хардкод -1 → Tab ID:-1 в Истории).
                          На done/error → persistResearchJob → research_jobs (БД).
                          body cap 5MB: большие ChatGPT sources/activity — штатный result.
POST /research-artifact   {id, kind, name, contentType, base64}
                          body cap 30MB, decoded file cap 25MB; base64 не попадает в result_json.
POST /aistudio-state      {id, status?, stage?, responseText?, ...}
                          body cap 5MB: AI Studio result mirror для renderer/history.
POST /research-log        {id?, tabId?, tag, …}  persistent log в production.log;
                          на tag=sw.tab.onRemoved → failAllByTabId (tab-closed fallback)
POST /research-stop       {id}  job → error 'Остановлено пользователем' + close tab.
                          IPC research:stop из попапа «Запущенные MCP».
GET  /research-status?id=…&wait=N  long-poll до N мс (cap 60000)
                          id='aim_…' роутится в AISTUDIO_JOBS, иначе researchState.
GET  /external-jobs       → unified список RAM(live) + research_jobs(БД), дедуп по id.
                          Источник для попапа «Запущенные MCP» и Истории MCP.
GET  /pplx-models         → {models:[{name,locked,aliases}], default}
POST /pplx-models-register {models, default}  CS self-register реестра при загрузке pplx
POST /open-url            {url}  WS sendToExtension('mcp_open_url') — мгновенно
                          (не queue+alarm-poll). Кнопка «В браузере» в JobDetail.
POST /reload-extension    кладёт reload_extension в BRIDGE_COMMAND_QUEUE → авто-wake SW
                          (mcp/browser/bridge.js дёргает при мёртвом канале)
```

Stage-семантика (для UI/debugging):
- `null` → `queued` (только что создан)
- `configuring` — CS включает Research toggle / выбирает Deep Research
- `submitting` — CS пастит prompt и жмёт Send
- `running` — Stop появился, research идёт
- `reloading_t<N>s_pl<M>s` — periodic-reload tick: t = сек от researchStartTs, pl = сек от текущего pageLoad. По разрыву pl можно понять происходил ли реальный reload между tick'ами (pl сброшен в ~0) vs застрял (pl растёт линейно).
- `done` — финал-сигнал поймал watcher
- `error` — что-то отвалилось

## Result-флаги и retry-стратегия

`result` Claude'а теперь содержит `is_research: bool` и `is_clarifying: bool` помимо текстовых полей. Это нужно потому что Claude может **технически завершить research-flow** на бэке (watcher увидел финал), но **семантически** ответ — не то что юзер просил:

- `is_research: false, is_clarifying: true` — Claude задал уточняющий вопрос («Какой период вас интересует?»). Это значит submit прошёл, но Claude посчитал prompt неоднозначным и не запустил extended research. SKILL ретраит: добавляет к prompt'у defaults-блок «assume the most general interpretation; do not ask further questions; launch extended research immediately».
- `is_research: false, is_clarifying: false` — Claude дал короткий обычный ответ без research-mode (200-600 chars). SKILL ретраит с research-explicit prompt: «Please conduct a Deep Research investigation. Use launch_extended_search_task — DO NOT skip extended research mode».
- `is_research: true` — research реально прошёл, есть panel/sources/document. Accept.

Без этих флагов watcher на `is_research:false`-результате срабатывал, юзер получал короткий ответ и думал «research забуксовал на 30 секунд — пайплайн сломан». На деле это была не та форма ответа, и нужен retry с другим prompt'ом. Маркер `is_research` определяется наличием `findResearchPanelBtn()` (panel `aria-label*="Open research panel"` с числовым sources count в финальном label'е).

`is_clarifying` определяется heuristic'ом на тексте: вопросительные конструкции в начале + длина <500 chars + отсутствие research-panel. Может давать false-positive на коротких research'ах без panel, но это допустимо — retry не убивает true-result, просто проводит ещё один research.

## Диагностика и post-mortem

Pipeline проходит через несколько чёрных ящиков (browser SW, browser CS, page DOM, claude.ai SPA), каждый из которых может молча умереть. Раньше debug упирался в *«CS не запустился ИЛИ запустился и вышел молча — непонятно»*. Сейчас три персистентных канала логов:

- **In-DOM `#sc-research-dbg-log`** — CS пишет на каждый `log(tag, data)`. Доступно через DevTools/MCP пока вкладка жива и не reload'илась. Удобно для realtime debug, но **умирает с tab close/reload** — для post-mortem непригодно.
- **`POST /research-log`** в bridge — CS зеркалит критичные boot/recover события. Bridge пишет в `production.log` (`~/Library/Logs/sc-desktop/`), который переживает закрытие вкладки и рестарт расширения. Используется для `cs.boot`, `cs.no_id_try_recover`, `cs.no_id_recovery_failed`, `cs.id_from_recovery` — всё что нужно знать «CS впрыснулся и в каком состоянии».
- **SW tab-lifecycle events** — `chrome.tabs.onUpdated/onReplaced/onRemoved` listener для зарегистрированных в RESEARCH_TABS вкладок, шлёт `sw.tab.*` в bridge log. Видны discard'ы (`{discarded:true}`), реальные load-cycles (`status:'loading' → 'complete'`), crash-restore (`onReplaced`), закрытие вкладки.

Типичный post-mortem timeline в `production.log` после зомби-research'а:
```
01:41:13 cs.boot hash=#sc-research=ID hasWindowName=false ...  ← первый инжект (hash present)
01:41:19 sw.tab.onUpdated status=loading url=/chat/<uuid>      ← SPA-navigation
01:47:48 cs.boot hash="" hasWindowName=true windowName=...      ← после reload (window.name восстановил id)
```
Если между двумя `cs.boot` событиями был tab.onUpdated со `status:loading` без CS-driven `reloading_*` события — это discard/crash-restore, не наш reload. Если cs.boot пришёл с `hash="" hasWindowName=false` — recovery flow обязателен, иначе зомби.

## Production hot-reload расширения не работает

В dev-сборке расширение перезагружается само через ~10-15 секунд после правки `browser-extension/*.js` (background.js `__sc_pollExtVersion` через `chrome.alarms` опрашивает `http://127.0.0.1:53127/__ext_version`, bridge возвращает max mtime файлов расширения, при расхождении расширение делает `chrome.runtime.reload()`).

В prod-сборке этот mechanism **не работает**: `__ext_version` endpoint возвращает `{error: "no source files"}` 404. Причина — `browser-extension/` **не упакован в asar** (в `package.json::build` нет `extraResources` для этой папки), bridge не может найти source files для max-mtime. Поэтому в prod-сборке расширение всегда установлено как **unpacked extension из исходной папки `browser-extension/`** на диске, и hot-reload-poll'у нечего опрашивать.

**Симптом**: правишь код CS/SW, делаешь `npm run build:i` (пересборка asar и переустановка), но в Chrome старая версия расширения. Bridge log не показывает `reload.firing` события.

**Workaround**: после `build:i` обязательно `chrome://extensions/ → ⟳` (или toggle off/on, если попало в Yandex circuit-breaker «слишком часто перезагружалось»). Без этого новый CS-код не активируется. Не лечится на стороне sc-desktop — это архитектурное решение «browser-extension живёт как unpacked, не в asar».

В принципе можно добавить `browser-extension/` в `extraResources` и положить отдельную копию в bundle для hot-reload-poll'а — но это удвоит размер asar и сделает unpacked-copy out-of-sync с bundled. Текущий compromise: prod = manual ⟳.

## Auto-close вкладки: детерминированное условие vs настоящая ошибка

CS шлёт `chrome.runtime.sendMessage({__sc_close_self_tab:true, reason})`, SW handler в
`background.js` делает `chrome.tabs.remove` с reason-aware задержкой (done — 500мс,
ошибка — 4с чтобы юзер успел заметить).

Раньше закрывали **только при done**, на любой error вкладка висела «для диагностики».
Юзер уточнил границу тоньше (см. `methodology/переносимый-дизайн.md::Авто-управление ресурсом`):
- **`research_done`** → закрыть (быстро).
- **детерминированная ошибка** (perplexity `pplx_daily_limit` / `pplx_model_locked` /
  `pplx_mode_switch_failed` — заранее известное условие, не сбой страницы) → закрыть.
  CS классифицирует в catch: `if (/pplx_daily_limit|pplx_model_locked|pplx_mode_switch_failed/.test(msg)) closeSelfTab(…)`.
- **настоящая ошибка** (`timeout` — что-то зависло на странице; claude `confirm_failed`,
  `terminal_error`) → НЕ закрывать, оставить для ручного разбора.

Обоснование (юзер): *«диагностика в любом случае проводится вручную по логам»* — вкладка
с известной модалкой лимита это мусор, а не источник информации. А вот если Gemini/claude
реально сломались (что-то не отобразилось) — вкладку держим. У claude детерминированных
условий нет (Research mode либо есть, либо нет) → закрывается только на `research_done`.
Тот же `__sc_close_self_tab` handler + reason работает для обоих провайдеров; aistudio
закрывается своим путём (`__sc_aistudio_mcp_done`, только на ok — см.
`fact-aistudio-mcp.md::Auto-close вкладки`).

## RAM-state для live + SQLite для истории

`research-state.js` хранит **live**-jobs в `Map`, GC раз в 5 мин дропает старше 1 часа.
Это правильно для активного research'а: пока job идёт, нужен EventEmitter + long-poll,
БД тут не нужна.

**Но история — в SQLite** (`research_jobs` таблица в `library.db`). Симптом до фикса:
юзер открывал «История MCP» после рестарта приложения — пусто, потому что RAM-Map
очистилась. История внешних research должна переживать рестарт и показывать хронологию
(дата/время/последовательность запусков).

Разделение «live в RAM, история в БД» (не «всё в БД»): на терминальном статусе
(done/error) bridge пишет джоб в `research_jobs` (`persistResearchJob` для claude/perplexity
через `/research-state`, `persistAistudioJob` для aistudio через `/aistudio-state`). А
`GET /external-jobs` отдаёт **объединение**: live из RAM-Map (свежее) + история из БД,
дедуп по `jobId` (RAM-запись приоритетнее БД для того же id). Таблица desktop-only —
**не** в основной `database.js::SCHEMA` (которая sync'ается с CLI `library_db.py`), а
отдельным `_db.exec` (CLI про research-историю не знает).

> **Что пробовали и почему передумали.** Изначально тут стояло «SQLite не решит проблему —
> если sc-desktop умер посреди research'а, CS всё равно не сможет POST'ить». Это верно для
> **live recovery** (его и не трогаем — live остаётся в RAM), но **неверно для истории**:
> завершённые джобы persist'ить в БД ничего не стоит, и именно их юзер хочет видеть после
> рестарта. Урок: «RAM приемлемо» относилось к live-state, ошибочно распространили на историю.

## Что не реализовано (на будущее)

1. **Hot-reload расширения убивает CS на открытых research-вкладках** — при правке любого `browser-extension/*.js` в dev SW делает `chrome.runtime.reload()`, и CS на активных вкладках получает teardown (chrome.* становятся unavailable). Частично смягчено: `chrome.alarms` watchdog + window.name persistence + tabId-recovery дают CS второй шанс при следующей навигации; **но** между teardown и навигацией события watcher'а теряются. В prod ext hot-reload не работает (см. «Production hot-reload не работает»), так что в prod этого симптома нет — но juzer должен помнить про manual ⟳ после `build:i`.
2. **Network-level fallback** через `chrome.webRequest.onCompleted` для SSE-стримов claude.ai / perplexity — описан в ресерче (см. промпт-пакет), но избыточен для текущего DOM-детектора.

(Cancel-endpoint и «job в error при закрытой вкладке» реализованы — см. секцию «Стоп,
tab-closed и submit-verify fallback'и».)

## Чеклист добавления нового провайдера

Точки, которые надо тронуть при добавлении провайдера (выведено на живом добавлении
chatgpt — два пункта из списка были забыты и стоили по итерации отладки):

1. CS `<provider>-research.js` — по образцу perplexity (watcher/keepalive/recovery/badge).
2. `manifest.json` — content_scripts entry (`research-badge.js` ПЕРЕД CS-потребителем).
3. `background.js::PROVIDER_TITLES` + `providerFromUrl` — пометка вкладки.
4. `browser-bridge.js::/research-start` — provider enum + targetUrl.
5. `research-state.js::recreate` — provider в whitelist (иначе recovery после bridge
   respin молча превратит job в claude).
6. **`browser-bridge.js::ALLOWED_ORIGINS`** — origin нового сайта. ЗАБЫЛИ при добавлении
   chatgpt: CS бутается, а все его fetch'и к bridge молча падают → job вечно `queued`,
   в bridge-логе от CS тишина при живых `sw.tab.*` событиях (канал SW→bridge работает,
   page→bridge нет). Симптом обманчив — выглядит как «CS не запустился».
7. Hot-reload watch-lists в bridge (двa места: `__ext_version` + WS-watcher).
8. UI: `NewResearchScreen` (таб+поля), метки в `McpRunningPopover`/`McpHistoryPanel`/
   `AistudioJobScreen`, тултип `+`-кнопки TitleBar.
9. Skill `~/.claude/skills/external-research/SKILL.md` — секция провайдера + cheat-sheet.
10. CS обязан ходить к bridge через `window.scBridgeFetch` (НЕ голый fetch) — иначе
    LNA-диалог нового origin'а (Chromium 138+) делает job вечно-queued: «Разрешить» не
    нажато → fetch молча висит; «Блокировать» нажато → мгновенный TypeError навсегда.
    SW-fallback внутри scBridgeFetch снимает обе формы. См. секцию «Канал CS→bridge»
    + `fact-chatgpt-research.md::LNA-диалог`.

## Файлы

| Файл | Назначение |
|---|---|
| `electron/research-state.js` | In-memory state + EventEmitter + `recreate()` для bridge respin + `findByTabId()` для CS recovery |
| `electron/browser-bridge.js` | endpoints `/research-{start,create,job,by-tab,state,log,status}` + recovery на 404 |
| `browser-extension/claude-research.js` | content-script для claude.ai (watcher, confirm-clicker, periodic+force reload, mainWorldClick, artifact-extract, tabId-recovery, `postTerminalState` confirmed-write; model/effort/thinking — `fact-claude-research.md`) |
| `browser-extension/research-badge.js` | общий MCP-бейдж + `window.scBridgeFetch` (page→SW fallback канала к bridge) |
| `browser-extension/perplexity-research.js` | content-script для perplexity.ai (Lexical paste, stable polling, keepalive port, force-reload, upsell-modal detector, `postTerminalState` confirmed-write) |
| `browser-extension/chatgpt-research.js` | content-script для chatgpt.com (model+effort select, focus-pulse против render-freeze, парсинг «Источников», `postTerminalState` confirmed-write) — детали в `fact-chatgpt-research.md` |
| `browser-extension/background.js` | `onConnect('sc-research-keepalive')` + `chrome.alarms` watchdog + tab.onUpdated/onReplaced/onRemoved lifecycle log + `__sc_get_tab_id` + `__sc_main_click` через `chrome.scripting.executeScript` (pointer-chain) |
| `browser-extension/mcp-handlers.js` | `mcp_open_research_tab` (background + `attachFocusEmulation` против render-freeze + autoDiscardable:false против discard) |
| `browser-extension/background.js` | `attachFocusEmulation`/`SC_FOCUS_EMULATION_URL` (все automation-домены), onDetach/watchdog auto-reattach |
| `browser-extension/manifest.json` | регистрация CS под claude.ai/*, perplexity.ai/*, chatgpt.com/* |
| `~/.claude/skills/external-research/SKILL.md` | глобальный skill — когда и как вызывать deep research через curl |

## Связано

- `fact-claude-research.md` — claude-провайдер: модели/effort/thinking, шрамы меню
  (regex без `\b`, stale base-ui меню, глиф-чекмарк), Opus 3 без research
- `fact-chatgpt-research.md` — chatgpt-провайдер: model/effort/sources, render-freeze
  фоновой вкладки (attachFocusEmulation — focus-pulse теперь dormant), LNA-диалог, виртуализированный список источников
- `fact-browser-mcp.md` — общая архитектура SC Browser Parser + MCP
- `fact-browser-extension.md` — компоненты расширения, в т.ч. Perplexity `/rest/thread/<slug>` API структура (для fallback в perplexity-research.js::fetchThreadLastAnswer)
- `fact-yt-extension-bridge.md` — образец long-poll-паттерна (от него унаследована схема `/research-status?wait=N`)
- `fact-logging.md::Не запускать npm run dev с tee` — EPIPE → uncaughtException → bridge POST виснет, отдельный шрам выявленный в этой сессии при debug'е research'а
- `fact-browser-tab-marking.md` — визуальная пометка research-вкладок через favicon
  и title (claude/perplexity-research открываются с провайдер-named title и иконкой
  расширения)
- `~/Desktop/hh-tool/docs/knowledge/fact-extension-runtime.md::v0.8.5` — MutationObserver обходит throttling, port-keepalive обходит intensive (не помогает против freeze/render-freeze — см. секцию «Фоновая вкладка замерзает» выше; единственное решение — attachFocusEmulation)
- `~/.claude/skills/external-research/SKILL.md` — глобальный skill: триггеры, как писать prompt, manual extract recipe для случая когда CS умер
- `fix-bash-jq-echo-pitfall.md` — `echo "$R" | jq` ломает JSON с `\n` escape, в SKILL'е везде `jq <<<"$R"`
