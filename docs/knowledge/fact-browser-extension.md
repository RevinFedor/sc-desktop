# Knowledge: Browser Parser (расширение)

Браузерный канал парсинга в SC Desktop. Лежит в `sc-desktop/browser-extension/` рядом с `cli-tools/`. **Это не часть Electron-приложения** — отдельный MV3-extension Chrome/Yandex, который юзер вручную устанавливает через `browser://extensions` → «Load unpacked». Логи пишутся в `~/Desktop/sc-desktop/browser-extension/logs/exporter-YYYY-MM-DD.log` через Native Messaging Host (отдельный Node-процесс, спавнится браузером).

## Зачем существует отдельно от CLI

Платформы которые уже покрывает CLI (`cli-tools/youtube/`, `telegram/`, etc.) имеют public API или yt-dlp. Они вне браузера парсятся проще. Этот extension — для **двух классов источников где CLI невозможен**:

1. **Нет публичного API + cookie-only auth** → AI Studio (Google), Perplexity Computer/Tasks. CLI с anonymous-cookies возвращает 401.
2. **Anti-bot защита блокирует yt-dlp** → планируется YouTube как fallback. Браузер с реальным юзер-cookie проходит мимо detection.

То есть — это **четвёртый канал парсинга** наравне с `tg_*_ndjson.py`, `yt_*_ndjson.py`, `ig_*_ndjson.py`. Не подмена CLI, а добор того что CLI не может.

## Что покрыто сейчас (v1.4.0)

- **Google AI Studio (Gemini Studio)** (`/prompts/*`) — два режима в одном content-script
  pipeline:
  - **Экспорт диалога.** DOM-scraping. Текстовый markdown по умолчанию копируется
    в clipboard; `.md` скачивается только если включён общий `downloadFile`.
    Если есть картинки и `scrapeImages=true` — скачивается `.zip`, потому что
    markdown + assets нельзя честно положить в текстовый буфер. Включая reasoning
    блоки research-режима (`<ms-thought-chunk>`) и картинки сгенерированные
    моделью (`<ms-image-chunk>`).
  - **Автоскрапинг (входящий).** `aistudio-autoscrape.js` отдельным content-script'ом
    в том же manifest-блоке. Триггер: `prompts/new_chat#sc=<requestId>`. Выбирает
    модель (`button.model-selector-card`), пресет System instructions из
    `mat-select` (по точному имени), paste'ит готовый транскрипт от sc-desktop в
    main textarea, click Run + fallback Ctrl+Enter. См. `fact-yt-extension-flow.md`.
- **Perplexity** (`/search/*` + `/computer/tasks/*`) — same-origin
  `fetch('/rest/thread/<slug>')`. Один HTTP — весь thread, никакого DOM.
  Текстовый markdown копируется в clipboard по умолчанию, `.md` скачивается
  только при общем `downloadFile`. Источники выводятся footnote-списком.
- **Claude** (`/chat/<uuid>`) — DOM-export текущей видимой ветки чата. Markdown
  включает turn'ы `You said` / `Claude responded`, раскрытые status/reasoning-блоки,
  видимые файловые карточки и текстовые preview вложений. Для документов exporter
  сначала использует встроенную кнопку `Copy` в viewer'е Claude, а DOM читает только
  как fallback; бинарники и картинки пока не скачиваются.
- **YouTube** (`/`, `/results`, `/@channel/videos`, `/watch`) — pill-кнопка
  «забрать в sc-desktop» на каждой видео-карточке + FAB на /watch. Click → POST
  на bridge sc-desktop'а (см. `fact-yt-extension-bridge.md`). Опциональный
  автоскрапинг → новая вкладка Gemini Studio в фоне. Прогресс — на самой кнопке
  (sending/working/opening/done/error), без toast'ов.

## Архитектура

Несколько изолированных контекстов: content-script'ы + service worker +
NMH-процесс + HTTP-bridge на стороне Electron (для YouTube). Хорошо
подсмотреть на схему `fact-architecture.md`, но здесь без Electron-renderer'а —
браузер вместо main process.

```
[content.js / perplexity-content.js / claude-content.js / youtube-content.js / aistudio-autoscrape.js]
   ↓ chrome.runtime.sendMessage   ↘ HTTP fetch
[background.js (service worker)]   [Electron HTTP bridge :53127]
   ↓ chrome.runtime.connectNative      (только YouTube ↔ sc-desktop;
[nmh/host.js (Node subprocess)]         см. fact-yt-extension-bridge.md)
   ↓ fs.appendFileSync
[logs/exporter-YYYY-MM-DD.log]

[popup.html/js] → chrome.tabs.sendMessage → content scripts
```

| Компонент | Что делает |
|---|---|
| `content.js` | AI Studio парсинг через DOM. ~1100 строк, включает overlay/error/success cards. |
| `aistudio-autoscrape.js` | AI Studio автоскрапинг (входящий поток для YouTube). ~210 строк. См. `fact-yt-extension-flow.md::autoscrape`. |
| `perplexity-content.js` | Perplexity парсинг через REST API. ~370 строк, включает overlay. |
| `claude-content.js` | Claude chat export через DOM. Читает только колонку текущей переписки, раскрывает status/Show more и file preview-панели, не обходит стрелки edit-history. |
| `youtube-content.js` | Pill-кнопка на YouTube-карточках/FAB. ~370 строк. См. `fact-yt-extension-flow.md`. |
| `logger.js` | Универсальный фасад: `log.info|warn|error|debug|timed|timer|domSnapshot`. Зеркалит в console + шлёт в background. Загружается во все content-script'ы через `manifest.content_scripts[].js`. |
| `background.js` | Service worker. (а) Релеит логи AI Studio/Perplexity/Claude в NMH через port, буферит последние 500 событий в `chrome.storage.local` как fallback. (б) **YouTube job-tracker:** хранит активные job'ы в `chrome.storage.local`, polls bridge через `chrome.alarms` (period 6с), на готовности открывает Gemini Studio через `chrome.tabs.create({active:false})` и шлёт state-update в YouTube-вкладку. (в) Выполняет main-world click для claude.ai, когда synthetic click не проходит из content-script world. |
| `popup.html/js` | UI с блоком **Настройка экспорта**: tabs Gemini Studio / Perplexity / Claude + общий switch `Скачивать файл`. YouTube flow живёт отдельным блоком ниже. Активный сайт автоматически открывает свой export-tab. |
| `settings.js` | Дефолты + sanitize/detect helpers для AI Studio, Perplexity, Claude export, YouTube и общего `__export.downloadFile`. |
| `libs/jszip.min.js` | Локальная копия (CSP запрещает CDN). Используется только AI Studio экспорт. |
| `nmh/host.js` | Node-процесс. Принимает length-prefixed JSON (4 byte LE + payload), пишет в файл лога. |
| `nmh/setup.js` | **Идемпотентный установщик.** Генерит RSA-ключ, прописывает публичный ключ в `manifest.json` (фиксирует extension ID), деплоит NMH-манифест в Chrome и Yandex `NativeMessagingHosts/`. |
| `nmh/extension-key.pem` | Приватный ключ. **Gitignored.** Терять нельзя — поменяется ID. |
| `nmh/host-wrapper.sh` | Генерится `setup.js`. Содержит абсолютные пути к Node и `host.js` (NMH спавнится без PATH). **Gitignored.** При переносе папки — перезапусти `setup.js`. |
| `logs/` | NMH пишет сюда. **Gitignored.** Один файл на день. Логи всех сайтов в одном потоке, отличаются по тэгам. |

**Permissions заметки.** `chrome.notifications` НЕ запрашивается — весь
прогресс YouTube-flow на самой pill-кнопке (юзер просил без macOS
notification spam'а). `alarms` нужен для YouTube job-tracker (SW idle-recycling).
Allowlist origin'ов в `host_permissions` плюс `http://127.0.0.1:53127/*`
для bridge.

Origin кода: fork от [Sukarth/AI-studio-exporter](https://github.com/Sukarth/AI-studio-exporter) (upstream commit `7c8a088`). Дальше форкаемся, апстрим не догоняем.

## Установка (одна команда, один раз)

```bash
cd ~/Desktop/sc-desktop/browser-extension
node nmh/setup.js
```

После: `browser://extensions` → «Load unpacked» → папку `browser-extension/`. Изменил код? → 🔄 в `browser://extensions`. Если правил `manifest.content_scripts` — ещё **F5 на каждой целевой вкладке** (MV3 не реинжектит автоматически в существующие табы).

Extension ID **зафиксирован навсегда** через `manifest.key`: `phnlfhkblebijojjnnlbcbklijgcijgf`. Один и тот же в Chrome и Yandex, после удаления/переустановки/переноса папки. Это нужно для `allowed_origins` в NMH-манифесте.

## Поток данных (AI Studio)

1. Юзер жмёт «Экспортировать» в popup → popup шлёт `{action:'export'}` в content-script того же таба.
2. content-script:
   - **STEP 1.** Раскрывает «View more actions» меню, кликает «Toggle viewing raw output». Это переключает AI Studio в режим plain markdown (а не отрендеренный HTML). Без этого мы вытаскивали бы HTML и теряли разметку.
   - **STEP 2.** `document.querySelectorAll('ms-chat-turn')` — фиксируем количество turn'ов как baseline.
   - **STEP 3.** Цикл: `scrollIntoView({block:'center'})` → `waitFor(turnHasRenderedContent)` → читаем содержимое.
   - **STEP 4.** **Гард детерминированности.** Если хоть один turn вернул `null` (matched nothing) И не задетектился как `empty-turn` (rerun-skeleton) — `throw new Error(...)`, файл НЕ скачивается, в overlay показывается красный alert с индексами.
   - **STEP 5.** Сборка markdown с шапкой-сводкой (количество, длительность, breakdown по типам).
   - **STEP 6.** Если нет картинок и `__export.downloadFile=false` → markdown
     копируется в clipboard. Если `downloadFile=true` → одиночный `.md`. Если есть
     картинки → JSZip и скачивание `.zip` независимо от `downloadFile`.
   - **STEP 7.** Возврат raw mode в исходное состояние (best-effort).

## Поток данных (Perplexity)

1. Юзер жмёт «Экспортировать» → popup шлёт `{action:'export', settings}` (включая Perplexity settings inline).
2. `perplexity-content.js`:
   - Извлекает slug из URL: `/search/<uuid>` → uuid; `/computer/tasks/foo-bar-iwIlv_v...` → весь хвост.
   - `fetch('/rest/thread/<slug>?version=2.18&from_first=true&limit=100')` с куками юзера. Пагинация через `data.next_cursor` если `has_next_page`.
   - Цикл по `entries`: парсит `entry.text` (JSON-string внутри JSON), достаёт ответ.
   - Markdown с шапкой-сводкой. Источники нумерованным списком под каждым ответом (если `show_sources=true`). Related queries после последнего ответа (если `show_related=true`).
   - Доставка такая же как у текстового AI Studio: clipboard по умолчанию, `.md` только
     при `__export.downloadFile=true`.

## Поток данных (Claude)

1. Юзер жмёт «Экспортировать» → popup шлёт `{action:'export', settings}` с
   `__claude.includeReattachedFiles` и общим `__export.downloadFile`.
2. `claude-content.js` сначала закрывает открытую file-preview панель, затем строит
   chat-scope: общий ancestor всех текущих `h2.sr-only` заголовков `You said:` /
   `Claude responded:`. Это намеренно уже, чем
   `#main-content`: правый sidebar Claude (`Files` / `Artifacts`) находится в том
   же SPA-root, но не является частью текущего transcript.
3. Для каждого turn'а берутся только элементы внутри chat-scope и без hidden-ancestor
   (`hidden`, `inert`, `display:none`, `visibility:hidden`, `opacity:0`). `aria-hidden`
   не считается hidden-сигналом для Claude: в `ad44f6ab-...` видимые answer-блоки
   имели `aria-hidden="true"`, и строгий фильтр давал «Пропущено 16 из 31 сообщений
   Claude». Сами `sr-only` заголовки не требуют layout-видимости, но реальные hidden
   ancestors всё равно отсекаются.
4. Внутри Claude-turn'а exporter раскрывает status/reasoning accordion
   (`button...group/status`) и hover-only `Show more`, затем читает полный текст
   процесса. Это делается только в chat-scope: `Show more` из sidebar или соседней
   ветки edit-history не должен попасть в markdown. Reasoning выводится отдельным
   блоком `### Процесс Claude`.
5. Файловые карточки (`[data-testid="file-thumbnail"]`) экспортируются как metadata,
   а при `includeReattachedFiles=true` кликаются main-world click'ом. Claude открывает
   полный текст справа в preview-панели; exporter сначала нажимает верхнюю кнопку
   `Copy` и читает clipboard, а самый длинный `pre/code/div` использует как fallback.
   Кнопку `Download` для текстовых документов не трогать: download — другой
   destination, не extraction. Preview закрывается через `Go back`, с короткими
   bounded waits вместо многосекундных sleep.
6. Artifact-карточки читаются только если они реально находятся в chat-scope. Не нужно
   обходить стрелки edit-history: пользовательский контракт — экспортировать текущую
   видимую ветку, а не соседние версии prompt'а.

**Шрам `Telegram mode3`.** В сессии `0345f4f9-...` экспорт зависал на шаге 8/8:
лог показывал `artifact open {"title":"Telegram mode3"}` и затем ровно 9 секунд
`artifact markdown — TIMEOUT`. DOM-проверка показала, что карточка была видимой,
но находилась в правой панели `Files/Artifacts`, а не в текущем сообщении Claude.
Простого visible-фильтра недостаточно: sidebar видимый. Правильный фильтр — сначала
сузить scope до колонки переписки, затем применять visibility/current-branch фильтры.
Перед открытием любого artifact/file/status нужно сверять, что его карточка или
заголовок реально найден внутри текущего scope; если title живёт только в sidebar
или другой ветке edit-history, exporter быстро оставляет metadata/placeholder и идёт
дальше, а не ждёт timeout.

## Где лежит финальный текст ответа Perplexity (важная гетча)

Это самое неочевидное в Perplexity API. Зависит от entry, **не от mode**:

| Случай | Где взять текст |
|---|---|
| Длинный ответ в режиме `copilot` | `JSON.parse(FINAL.content.answer).answer` — markdown |
| Длинный ответ в режиме `asi` (Computer/Tasks) | `entry.plan.goals[].description` — берём только те где `length >= 250` (короче — служебные фразы «Loading skill...») |
| Часть `copilot` thread'ов | FINAL.answer пустой, текст всё равно в `plan.goals[].description` |

**Правило:** не доверять полю `mode`. Парсер пробует **обе стратегии** и берёт **более длинную непустую**:

```js
const finalAnswerStr = JSON.parse(FINAL.content.answer).answer || '';
const planLong = goals.filter(g => g.description?.length >= 250).map(g => g.description).join('\n\n---\n\n');
const answer = planLong.length >= finalAnswerStr.length && planLong ? planLong : (finalAnswerStr || lastDitchPlanGoals);
```

**Web-источники** (для обоих режимов): `JSON.parse(FINAL.content.answer).web_results` — массив `{name, snippet, url, timestamp}`. Inline citations в тексте — `[1]`, `[2]`... — соответствуют индексам массива. Парсер не разрешает inline-ссылки, просто выводит источники списком.

**Гипотезы которые опровергнуты** (не пытайся их снова):
- ~~«В Computer mode есть отдельный endpoint типа `/rest/computer/tasks/<id>`»~~ — нет, 404.
- ~~«Текст ответа всегда в FINAL.content.answer»~~ — нет, см. таблицу выше.

## Ключевые правила

### 1. Никаких `setTimeout(N)` для ожидания DOM в AI Studio. Только `waitFor(predicate, why, timeoutMs)`

Оригинальный апстрим имел `sleep(700ms)` после каждого DOM-действия. На 63 turns это давало 81 секунду. Заменили на polling DOM-предикатов — стало 2.3 сек. Совпадает с правилом для hh.ru («SPA-хайдрейт недетерминирован»).

### 2. `[data-turn-role]` — это скелет, не сигнал hydration

Этот атрибут есть в `<ms-chat-turn>` ДО того, как Angular заполнит содержимое. Использование его в `waitFor` создаёт false-positive (был такой баг, исправлен). Реальные сигналы готовности turn'а:
- `ms-text-chunk` — текст
- `ms-image-chunk` — картинка (User или Model)
- `ms-file-chunk` — приложенный файл
- `.mat-expansion-panel-body` — разворачиваемый блок (legacy reasoning)
- `ms-thought-chunk` — research-режим reasoning (новый Angular-компонент)

### 3a. Deep Research Preview (`deep-research-preview-04-2026`): `role="Agent"` вместо `Model`, новые ms-теги

С апреля 2026 в Studio появилась новая "Deep Research Preview" модель — agentic
mode который сам делает несколько раундов Google Search и reasoning перед финальным
ответом. Это **полностью меняет каркас turn'ов**:

| Изменение | Старый чат | Deep Research |
|---|---|---|
| `data-turn-role` | `"Model"` | `"Agent"` |
| Thoughts wrapper | `<ms-thought-chunk>` | `<ms-thought-activity-chunk>` (новое имя! не путать с старым `ms-thought-chunk`, иначе extractor fallback'нет на 5-сек chevron-timeout) |
| Tool-use turn | — | `<ms-tool-activity-chunk>` с `<ms-activity-panel>` + `<ms-search-entry-point>` |
| Сжатый turn вне viewport | `<div height:100px><!-----></div>` | то же — virtual scroll агрессивный, нужен `scrollIntoView` |

**⚠️ Чексумма для имени тега reasoning'а.** Был случай: я предположил что Deep Research использует тот же `ms-thought-chunk`, что и старый research. Поставил extractor под него, прогнал — каждый Thoughts turn падал в legacy fallback (chevron_right click + 5-сек wait на `.mat-expansion-panel-body` который никогда не появлялся) → 5 сек × 8 thought-turn'ов = 40 сек мёртвых таймаутов, плюс reasoning-текст попадал в финальный ответ дважды (через `extractModelMessageText`'s loop по `ms-text-chunk` без фильтра `ms-thought-activity-chunk`). Правильное имя видно ТОЛЬКО в логе `msChildTagsInOrder` — никаких предположений из кода upstream'а.

`processChatTurn` сейчас лечит обе ветки одним условием `role === 'Model' || role === 'Agent'`.
Без этого fix'а Deep Research экспортится как **«Пропущено 26 из 27 сообщений»** —
все Agent-turn'ы матчатся ни во что, гард детерминированности падает throw'ем.

`turnHasRenderedContent` дополнен сигналами `ms-thought-chunk`, `ms-thought-activity-chunk`
и `ms-tool-activity-chunk` — иначе collapsed thought-only/tool-only turn'ы выходят
в timeout (`TURN_TIMEOUT_MS`) и обрабатываются впустую.

**Google Search блоки.** Внутри `ms-tool-activity-chunk` живёт `ms-activity-panel`
(сворачиваемая шапка с queries и chip'ами) и `ms-search-entry-point` (Google-виджет
с suggestions). URL'ы и snippets источников **здесь не появляются** — они только в
финальных footnotes ответа (`References` секция, `[1]`, `[2]`, … в markdown). Текущий
extractor пытается вытащить queries (chip'ы с текстом, отфильтровывая UI-шум типа
`"check"`, `"chevron_right"`, `"more_vert"`, `"Learn more"`, иконки `material-symbols-outlined`).
Реально вытащил ~5 query-строк на каждый Google Search turn — нормально, это и был
запрос юзера. Если queries не вытащились — пишем `_[Google Search вызван — не удалось
извлечь queries из DOM.]_` (НЕ data loss — placeholder, гард не срабатывает).

**No-op Agent turn (только `ms-chat-turn-options`).** Иногда Deep Research оставляет
в иерархии turn без полезной нагрузки: внутри только меню «три точки», а в
`virtual-scroll-container` пустой `<!---->` placeholder. Angular никогда не hydrate'ит
его — `waitFor(turnHasRenderedContent)` уходит в timeout. Это **не data loss**, а
артефакт rerun/edit-history. Детектируется по `msChildren.every(t => t === 'ms-chat-turn-options')`
и помечается как `empty-turn` — placeholder в markdown, throw не срабатывает.

**Reasoning-текст не должен попадать в response.** `extractModelMessageText` skip'ает
ms-text-chunk внутри **обоих** wrapper'ов (`closest('ms-thought-chunk')` И
`closest('ms-thought-activity-chunk')`). Без второго фильтра текст рассуждения
дублировался в финальный ответ Deep Research'а (Thoughts → reasoning + response).

**Settings.** `scrapeReasoning` единый toggle на и Thoughts, и tool-activity — потому
что и то, и другое = research-внутрянка одного agentic-ответа. Раздельный toggle
делать не нужно.

**Markdown секции для Agent.** В дополнение к `🤖 Model` / `🤖 Model (Reasoning)`
добавлены `🤖 Agent` / `🤖 Agent (Reasoning)` / `🌐 Google Search` (queries
рендерятся unordered list'ом). Старые Model-секции оставлены для совместимости с
не-research чатами.

### 3. `<ms-thought-chunk>` оборачивает рассуждения. Их нужно ИСКЛЮЧАТЬ при чтении финального ответа

В research-режиме Angular рендерит:
```
<ms-chat-turn role=Model>
  <ms-thought-chunk>
    <ms-text-chunk>...скрытое рассуждение...</ms-text-chunk>
  </ms-thought-chunk>
  <ms-text-chunk>...видимый ответ...</ms-text-chunk>
</ms-chat-turn>
```
Если `extractModelMessageText` вернёт `chatTurn.querySelector('ms-text-chunk')` — он схватит ПЕРВЫЙ, то есть скрытый. Текст попадёт в файл дважды (как reasoning + как response). Правильный селектор: `ms-text-chunk` который **НЕ внутри `ms-thought-chunk`** (через `closest()` проверка).

### 4. Reasoning текст всегда в DOM. Кликать chevron не нужно

Апстрим кликал «развернуть → sleep(700) → прочитать → свернуть → sleep(700)». Лог показал железно: `panel.textContent.length` ДО клика идентичен длине ПОСЛЕ клика во всех случаях (22/22). Angular рендерит развёрнутое состояние всегда, просто скрывает CSS'ом. Если в будущем Angular изменит поведение — есть fallback с `chevronButton.click() + waitFor(panel)` и громким `[ERROR] FALLBACK` в логе.

### 5. Каждый чанк — отдельный `<ms-chat-turn>`

AI Studio для каждого визуального элемента (мысль, текст, картинка модели, картинка пользователя) создаёт **отдельный** `<ms-chat-turn>` с одним контентным чанком внутри. **Не пытайся** делать обход sibling'ов внутри одного turn'а — это не нужно.

### 6. Если что-то не извлеклось — экспорт обязан упасть (ИЛИ задетектиться как empty-turn)

Гард `skippedTurnIndices.length > 0 → throw` — пользовательское требование «жёсткая детерминированность, частичный файл недопустим». Нельзя «втихую пропустить» turn — это data loss. Если нашёл новый тип контента, который не парсится — добавляй extractor + placeholder, не убирай гард.

**Три категории пропусков:**
- `image-placeholder` / `attachment-placeholder` — контент в DOM есть, но юзер выключил его в настройках. Markdown получает `_[Картинка пропущена при экспорте: alt]_`. НЕ skipped.
- `empty-turn` — DOM-скелет на месте (`ms-prompt-chunk` + пустой `ms-text-chunk`), это rerun-артефакт от AI Studio. Markdown получает `_[Пустой turn — rerun-скелет]_`. НЕ skipped.
- `null` (real data loss) — нет ни одного распознанного chunk-типа. **Skipped → гард → throw → файл не скачан.**

### 7. Логи — единственный источник правды

При диагностике любого бага: **сначала** смотри `logs/exporter-YYYY-MM-DD.log`, **потом** правь код. Никогда наоборот. Полезные grep'ы:

```bash
# Сводка по последнему экспорту
LATEST=$(grep "EXPORT START" logs/exporter-*.log | tail -1 | grep -oE "exp:[a-z0-9-]+")
grep "$LATEST" logs/exporter-*.log | grep -E "STEP|EXPORT|matched nothing|skipped|TIMEOUT"

# Все skipped turns
grep "matched nothing — POSSIBLE DATA LOSS" logs/exporter-*.log

# Тайминги по turn'ам
grep "turn .*/.*END" logs/exporter-*.log | tail -50
```

### 8. DOM AI Studio менять руками НЕЛЬЗЯ

Не работает попытка анализировать DOM через `mcp__browser__*` или `mcp__chrome-devtools__*`:
- Virtual scroll AI Studio агрессивно делает teardown — turn вне viewport заменяется на `<!---->`.
- Между MCP-командами «scroll» и «evaluate» Angular успевает удалить узлы.
- `harvest_list` дедуплицирует пустые контейнеры в один.

**Вывод:** для анализа структуры DOM делаем расширение само его читает (это быстро, в нужный момент времени, гарантированно с hydration) и пишет в лог через `domSnapshot()` или `innerHTMLSample`. Потом читаем лог. Так найден баг с `<!---->` teardown, формат `<ms-image-chunk>`, формат `<ms-thought-chunk>`, кейс с пустым turn[2] на 1nAfv. Если очень нужно увидеть DOM глазами — F12 руками.

## Настройки в popup

Хранятся в `chrome.storage.sync`. Меняются live (без кнопки «Save»), без отдельного
submit/save шага.
Popup автодетектит сайт через `detectSite(tab.url)`: Gemini Studio / Perplexity /
Claude открывают соответствующий tab в блоке «Настройка экспорта», YouTube остаётся
отдельной секцией.

### Общие export-настройки (под ключом `__export`)

| Ключ | Что значит |
|---|---|
| `downloadFile` | Default `false`: текстовый markdown копируется в clipboard. Если `true`, текстовые Gemini/Perplexity/Claude экспорты скачивают `.md`. Gemini ZIP с картинками скачивается всегда, потому что clipboard не несёт assets. |

### AI Studio (top-level keys в storage)

| Ключ | Что значит |
|---|---|
| `scrapeImages` | Картинки, прикреплённые юзером в чат (drag-and-drop фото) |
| `scrapeAttachments` | Файлы (PDF/видео/доки), приложенные юзером |
| `scrapeAttachmentTitle` | Имя файла рядом с вложением |
| `scrapeAttachmentSize` | Размер/токены |
| `scrapeAttachmentPreview` | Превью-картинка (thumbnail) рядом с файлом — **НЕ сам файл**, его не достать |
| `scrapeReasoning` | Рассуждения модели (ms-thought-chunk + legacy mat-expansion-panel) |

### Perplexity (под ключом `__pplx` в storage, плоский объект)

| Ключ | Что значит |
|---|---|
| `show_sources` | Под каждым ответом — нумерованный список цитируемых источников (`web_results`) |
| `show_related` | Под последним ответом — массив `related_queries` |
| `asi_min_chunk_len` | (numeric, default 250) Минимальная длина `plan.goals[].description` для попадания в финальный markdown в ASI mode |

Perplexity-настройки **НЕ читаются content-script'ом из storage** — попап шлёт их inline в `chrome.tabs.sendMessage(tab.id, { action:'export', settings })`. Это упрощает контракт и избавляет от лишнего read.

### Claude (под ключом `__claude`)

| Ключ | Что значит |
|---|---|
| `includeReattachedFiles` | Default `true`: кликать файловые карточки Claude и вытаскивать полный текст preview-панели через Copy-first. Если `false`, в markdown остаются только видимые карточки/счётчик пропуска. |

Claude-настройки, как и Perplexity, отправляются popup'ом inline вместе с `__export`.

### YouTube (под ключом `__yt`)

| Ключ | Что значит |
|---|---|
| `auto_aistudio` | (bool) После транскрибации открывать Gemini Studio в фоне с готовым промптом |
| `with_comments` | (bool) Дополнительно тянуть комменты к видео; склеиваются с транскриптом одним блобом |
| `system_instruction` | (string) **Имя сохранённого пресета** в Gemini Studio (а не сам текст инструкции). Autoscrape выберет его из `mat-select` dropdown'а; не найден или дубли → throw |
| `model_title` | (string, default «Gemini 3 Flash Preview») Точное имя model-card'а |

YouTube-настройки **читаются content-script'ом из storage напрямую** —
кнопка на карточке должна знать `auto_aistudio` чтобы показать `⬇ sc · AI`
или `⬇ sc`, без round-trip'а в popup. `chrome.storage.onChanged` listener
обновляет лейблы всех существующих кнопок при перещёлкивании toggle.

См. `fact-yt-extension-flow.md` для полного flow.

## Что делать когда ломается

1. Открой `logs/exporter-YYYY-MM-DD.log`, найди последний `EXPORT START`. Прочитай весь блок до `EXPORT DONE` или `EXPORT FAILED`.
2. Если `EXPORT FAILED` — текст ошибки в `error.message`. Если содержит «Пропущено N из M» — смотри `[ERROR] matched nothing — POSSIBLE DATA LOSS`, там есть `innerHTMLSample` (3000 символов) и `tagOrder` (последовательность ms-* тегов в проблемном turn'е).
3. Если экспорт быстрый, но файл неполный — это баг predicate'а в `waitFor` или extractor'а. Проверь что turn matched-as-content (см. лог `matched: ...`).
4. Если лог пустой — NMH не подключён. В popup жми «Ping NMH» (если кнопки нет — открой `popup.js` и убедись что diagnostic-buttons включены). Если статус «NMH ERROR» — пробуй `node nmh/setup.js` ещё раз.
5. Если Claude пишет «Пропущено 16 из 31 сообщений» на видимой странице — сначала проверь hidden predicate: `aria-hidden` на claude.ai не равен data-loss, он может стоять на видимом answer-блоке. Если кнопка `Закрыть` в overlay не реагирует — проверь delegated close-target (`data-sc-claude-close`), потому что сама карточка overlay останавливает bubbling.
6. **Никогда не добавляй sleep'ы.** Никогда не меняй гард на «силент скип». Никогда не парси HTML регулярками — только через `querySelector`.

## История версий

- **1.0.x** — fork от Sukarth/AI-studio-exporter, только AI Studio.
- **1.1.0** — добавлен Perplexity (`/search/*` + `/computer/tasks/*`), переименован в «AI Conversation Exporter». Двойной content-script.
- **1.2.0** — переименован в «SC Browser Parser», переехал в `sc-desktop/browser-extension/`. Готовится поддержка YouTube как третьего сайта.
- **1.4.0** — поддержка Deep Research Preview (`deep-research-preview-04-2026`):
  `role="Agent"`, `ms-thought-activity-chunk`, `ms-tool-activity-chunk` (Google Search
  с queries-extractor'ом), no-op Agent turn'ы. Убран legacy chevron-click fallback в
  `extractReasoningText` (был 5-сек timeout-pit на новом DOM). 27 turn'ов экспортятся
  за ~3 сек.
- **1.4.x** — добавлен Claude chat export, tabs в настройках экспорта и общий
  `downloadFile`. Текстовые экспорты по умолчанию копируются в clipboard; файлом
  скачиваются только по явному switch'у или когда у Gemini есть картинки/ZIP.
  Claude export читает текущую ветку, раскрывает status/Show more и документы берёт
  через viewer Copy-first, без скачивания текстовых preview.
