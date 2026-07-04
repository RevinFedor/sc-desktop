# Knowledge: YouTube → sc-desktop → AI target (расширение)

End-to-end flow «забрать видео с YouTube в Library + автоматически отправить
готовый текст в выбранный AI-target». Правая половина pill'а `+ ai` сейчас
умеет Gemini Studio, Claude и ChatGPT. Реализовано content-script'ами
расширения SC Browser Parser, background tracker'ом и HTTP-bridge'ом sc-desktop'а
(см. `fact-yt-extension-bridge.md`).

```
[YouTube card / watch]                  [AI target tab]
  📋 copy / + клик                              ↑
       │                                        │ tabs.create({active:false})
       ▼                                        │   (только когда транскрипт готов)
[youtube-content.js]                            │
  → POST /yt-add ────────► [Electron bridge] ───┤
  → state: working                              │
  ▼                                             │
[background tracker]  ──── chrome.alarms 6s ────┤
  poll /yt-status                               │
  done → tabs.sendMessage                       │
       (state: done)                            │
       + openTargetBackground ───────────► Gemini/Claude autoscrape
                                            или ChatGPT sc-compose
```

## 🎬 Pill-кнопка на карточке — гибрид из 3 источников

В стиле Яндекс-чипа «Пересказать» — тёмный pill в левом-верх углу
карточки. **Все три источника (singleton, per-card, FAB в dock'е)** —
**split** copy / `+` (вариант `overlay` для карточек, `dock` для плеера —
см. `### Split SC-pill`). На странице плеера дополнительно speed-pill
снизу в общем dock'е — секция `🎚 Player dock`.

Финальная архитектура — **3 источника pill в DOM**, всё shared state:

| Источник | Где живёт | Когда работает |
|---|---|---|
| **Singleton-pill** | `ytd-video-preview > #video-preview-container` | Главная, /results, и любое место где YouTube активирует inline-preview overlay при hover'е карточки |
| **Per-card pill** | `yt-thumbnail-view-model` / `.ytThumbnailViewModelHost` внутри scope'а: `ytd-watch-next-secondary-results-renderer` (рекомендации /watch), `ytd-rich-grid-renderer` (канал /videos и /watch sidebar grid), `ytd-shelf-renderer` + `ytd-item-section-renderer` (канал /featured горизонтальные полки), `ytd-channel-featured-content-renderer` (hero-видео на /featured). На shorts-карточках канала — `ytm-shorts-lockup-view-model[-v2]` (нет вложенного thumb-host, якорим к `<a.reel-item-endpoint>`). | Везде где singleton hover-preview не запускается. **Hover-only везде** (и /watch sidebar, и канал) — `opacity:0` по умолчанию, видна на hover карточки. Исключение — `data-sc-pinned` во время активного transcribe. |
| **Player dock** | `position: fixed`, прибит к `body`; координаты считаются от bbox якоря (см. ниже) | Страница плеера: /watch?v=… и /shorts/<id>. Внутри — split SC-pill (copy / `+`) сверху и speed-pill (`−/X.Xx/+`) снизу. См. секцию **🎚 Player dock**. |

### Singleton-pill (Яндекс-подход)

Подсмотрено как работает чип «Пересказать» от Яндекса: одна `<button>`
на всю страницу, прибита к `ytd-video-preview > #video-preview-container`,
обновляет атрибут `data-video-id` на каждый hover-event. YouTube сам
позиционирует контейнер поверх hover'нутой карточки и прячет когда hover
ушёл — pill наследует это поведение бесплатно:
- preview не останавливается когда курсор на pill (pill — сестра `<video>`
  в одном контейнере, hover не покидает preview-area);
- z-index не нужно перебивать (естественный stacking-context preview
  даёт правильный порядок, у Яндекса z:35);
- никакой re-injection'ы на virtualization, никаких дублей с lockup,
  никакой DOM-mutation на каждую карточку.

Pill держит `data-video-id`, обновляется через body-level
`mouseover`-делегацию: `closest('a[href*="/watch?v="]')` → `extractVideoId(href)`
→ `pill.dataset.videoId = vid`. Click читает **актуальный** `dataset.videoId`
в момент клика (не closure'нную переменную — критично для thumb-recycle,
см. ниже).

### Per-card pill (fallback на /watch + канал)

В правой колонке `/watch` YouTube **не запускает inline-preview** — там
карточки рендерятся как «список ссылок» в Lit/Polymer'е. Singleton туда
не доходит, юзер видит чистую карточку. То же самое на всех канальных
страницах (`/@<handle>/featured|videos|shorts`): preview-overlay YouTube'ом
не запускается. Решение — Yandex'овский подход для этих случаев: в каждый
`.ytThumbnailViewModelHost` инжектим pill (для канал-shorts'ов — в сам
`<a.reel-item-endpoint>` внутри `ytm-shorts-lockup-view-model`).

- Позиция: `top: 46px; left: 8px` (под Yandex-чипом «Пересказать»).
- Hover-видимость через CSS-rule `[card]:hover .sc-percard-pill { opacity: 1 !important }`
  (`!important` нужен потому что `makeButton` ставит `opacity: 1` inline
  для singleton — без `!important` perp-card не скрылась бы).
- Pinned (`data-sc-pinned="1"`) во время active state — pill не пропадает
  если юзер увёл мышь во время transcribe.

**Hover-rule сидит на самом thumb-host'е, не на `yt-lockup-view-model`.**
Внутри `yt-lockup-view-model` есть `display: contents` (он structural
wrapper, не имеет своего box'а), из-за чего CSS `:hover` **не каскадирует
вниз** на child-элементы по обычным правилам. Hover-rule на сам
`yt-lockup-view-model:hover .sc-percard-pill` не активировал бы pill даже
когда мышь над thumb'ом — `:hover` стрелял на скрытый layout-узел, а pill
лежит уровнем ниже. Поэтому rule висит на `yt-thumbnail-view-model:hover`
и `a.ytLockupViewModelContentImage:hover` напрямую — это уже box'ы с
реальной hover-областью.

**Hover-only ВЕЗДЕ, включая канал.** Per-card pill по умолчанию `opacity:0`,
видна только на hover карточки — одинаково на /watch sidebar и на странице
канала. Раньше на `/@<handle>/*` ставили `data-sc-always-visible="1"`
(постоянная видимость, как Yandex'овский «Пересказать»), но юзер захотел единый
hover везде — *«должно отображаться только при наведении»*. Флаг и его CSS-rule
удалены; `injectPerCardPills` теперь безусловно снимает `data-sc-always-visible`
со всех существующих pill'ов на каждом проходе (чистит и stale-флаги от старых
сборок в живом DOM). Принцип «свой UI поверх чужого контента — hover-gated» —
см. `methodology/переносимый-дизайн.md::Свой UI поверх чужого контента`.

`data-sc-pinned="1"` (видимость во время активного transcribe, чтобы pill не
пропала когда юзер увёл мышь) остаётся — это отдельное правило базовой
видимости, не путать с удалённым always-visible.

### Что пробовали и отбросили перед гибридом

- *Pill в `yt-thumbnail-view-model` каждой карточки, hover через JS*.
  Дубли на главной (`ytd-rich-item-renderer + yt-lockup-view-model` оба
  в `CARD_SELECTORS`), MutationObserver жёг CPU при scroll'е, **preview
  останавливался** когда курсор на pill — pill была descendant thumb-anchor,
  YouTube считал что мышь покинула card-area.
- *Pill сестрой anchor'а с `z-index: 2147483000`*. Preview не останавливался,
  но при scroll YouTube перерисовывал thumb-anchor и pill пропадала.
- *`mouseover/mouseout` JS-listener'ы + pointermove fallback*. `mouseout`
  стрелял с `relatedTarget=<video>` (overlay снаружи DOM-tree карточки),
  pill пряталась мгновенно.
- *Per-card на `yt-thumbnail-view-model` ВНУТРИ `ytd-watch-next-secondary-results-renderer`*.
  Селектор не нашёл узлы — на /watch там реально `.ytThumbnailViewModelHost`
  (новый шаблон). Расширили селектор до обоих.
- *Hover-rule `yt-lockup-view-model:hover .sc-percard-pill { opacity:1 }`*.
  Симптом: pill инжектится в DOM (видно в snapshot'е), `rect` валидный
  поверх thumb'а, но визуально невидима даже при реальной мыши над
  карточкой. Причина — `display: contents` у `yt-lockup-view-model`:
  обёртка не имеет собственного box'а, `:hover` не активируется на ней
  по каскаду. Перенесли rule на `yt-thumbnail-view-model:hover` и
  `a.ytLockupViewModelContentImage:hover` (оба — реальные box'ы).
- *Always-visible на ВСЕХ страницах*. Превращало /watch sidebar (20+ карточек)
  в визуальный шум. Сначала сузили до канала через `isChannelPage()`, потом
  отбросили **и** канальный always-visible — юзер захотел единый hover везде
  (постоянные плашки на 30 карточках канала дороже, чем «юзер может не
  догадаться навести»). Итог: hover-only без исключений по pathname.

## 📊 Состояние per-videoId через Map

State хранится в **`videoStateMap = Map<videoId, {state, error, title, autoAistudio}>`**,
не на DOM-кнопке. Pill (singleton/FAB/per-card) — read-only view: на
hover/render берёт `videoStateMap.get(currentVideoId) ?? idle`.

Почему Map, не attribute на pill: singleton-pill **переезжает** между
видео при hover. Если хранить state на самом DOM-узле, наведение на
видео B показывало бы «working» от видео A. См. `methodology/переносимый-дизайн.md::State per-resource + глобальный indicator`
для общего принципа.

Тосты = **одна строка**: иконка состояния + название видео (с ellipsis при overflow). Без слов «Готово»/«Транскрипция»/«Отправляю» — состояние читается по иконке и border-цвету. height:32px, border-radius:16px, max-width:360.

| state | pill | toast иконка | граничит на |
|-------|------|--------------|-------------|
| `idle` | `📋 copy │ +` (split в любом variant'е: overlay 30px на карточках, dock 36px на /watch /shorts) | — | стартовое |
| `sending` | overlay-label поверх обеих половин: `⏳ Отправляю…` | `⏳` | POST /yt-add в полёте |
| `searching` | `🔎 Ищу субтитры…` | `🔎` | bridge отрапортовал `yt_stage=searching\|subs_found\|awaiting_ai` |
| `transcribing` | `🤖 Запрос к Gemini…` или `🎙 Запрос к AssemblyAI…` (по `yt_engine`) | `🤖`/`🎙` | bridge отрапортовал `yt_stage=transcribing` с engine |
| `working` | `⏳ Транскрипция…` | `⏳` | legacy fallback когда bridge не передал yt_stage |
| `opening` | `🤖 <target>…` | `🤖` | (autoAistudio=true) открывается выбранная AI-вкладка |
| `done` | **возвращается в idle сразу** | `✓` (зелёный border, 3с TTL) | sc-desktop сохранил файл + положил в clipboard |
| `pasted` | **возвращается в idle сразу** | `🤖✓` (зелёный border, 4.5с TTL) | autoscrape вставил текст в Gemini Studio textarea |
| `error` | **возвращается в idle сразу** | `✗` (красный border, 4с TTL) + текст ошибки в title-attr | финал с ошибкой |

**Pill НЕ показывает done/error/pasted.** Юзер видит результат в тосте; pill сразу готова к новому клику — иначе после транскрибации нужно было бы ждать TTL прежде чем нажать заново.

**`done` и `pasted` — два разных события.** Для autoscrape-target'ов
Gemini/Claude юзер кликает `+ ai` и ожидает последовательно: `🔎 → 🤖 → ✓ → 🤖✓`
(ищу субтитры → транскрибирую → сохранил в clipboard → вставил в AI-вкладку).
Без разных иконок две `✓` подряд читались бы как дублирующиеся уведомления —
юзер не понимал что произошло. ChatGPT target идёт через отдельный `sc-compose`
handoff, поэтому у него нет отдельного autoscrape-сигнала `pasted`: после submit
вкладка остаётся открытой, а итог живёт в обычном ChatGPT-чате.

**Pill НЕ показывает done/error.** Юзер видит результат в тосте; pill
сразу готова к новому клику — иначе после транскрибации нужно было бы
ждать TTL прежде чем нажать заново. Решает UX-кейс «вкладка показывает
готово/ошибка, хотя я уже это видел в уведомлении и хочу нажать снова».

**4 источника UI обновляются вместе.** `setVideoState(videoId, ...)`
триггерит `renderPillForCurrentVideo` + `renderFabFromState` +
`renderPerCardFromState` + `renderToasts`. Каждый источник смотрит свой
`btn.dataset.videoId` (или `pill.dataset.videoId`) и берёт actual state
из Map'а. Background-tracker пишет в Map через `chrome.runtime.sendMessage({__sc_btn_state, videoId, state})`
→ content-script.onMessage → `setVideoState(...)` — broadcast получают
все 3 типа pill автоматически без ручного `querySelectorAll`.

## 📡 Stage-aware прогресс

Раньше pill висела на одном слепом `working` от момента когда bridge принял jobId до момента когда транскрипт сохранён. На длинных видео (5-15 минут транскрибации Gemini'ем) юзер не понимал — система ещё работает или зависла.

Bridge `/yt-status` теперь отдаёт `yt_stage` (`searching` / `subs_found` / `awaiting_ai` / `transcribing`) и `yt_engine` (`gemini` / `assemblyai`). Background маппит на content-script state'ы:

| `yt_stage` от bridge | content-script state | UI |
|---|---|---|
| `searching` | `searching` | 🔎 Ищу субтитры… |
| `subs_found` | `transcribing` | 🤖 (текст уже найден, идёт сохранение) |
| `awaiting_ai` | `searching` | 🔎 (между subs_missing и resume — специальной фазы нет) |
| `transcribing` + engine | `transcribing` | 🤖 Запрос к Gemini… / 🎙 Запрос к AssemblyAI… |
| (отсутствует) | `working` | ⏳ Транскрипция… (legacy fallback) |

Background дедуп'ит state-event'ы в `tracker.lastSentState` — не шлём content-script'у тот же state дважды. Subs-found пропускает transcribe-фазу: для видео с готовыми субтитрами юзер видит `🔎 → ✓` без промежуточного `🤖`, потому что AI там не запускается.

## 🍞 Глобальный тост-стек

Fixed-position контейнер сверху-справа (`#sc-yt-toast-host`, `z-index: 2147483000`). По тосту на каждый активный videoId из Map'а. Source-of-truth для done/error/pasted (pill их не показывает — см. выше).

Зачем нужен помимо pill: юзер кликнул видео → ушёл скроллить дальше → через минуту не помнит ни что кликал, ни сколько штук в работе. Тост постоянно виден независимо от scroll/hover-контекста. Каждый тост держит заголовок видео, снимаемый прямо в момент клика через `pickCardTitleForVideo` (аria-label thumb-anchor'а / h1 на /watch / closest card title).

**One-line дизайн.** Тост = `display:flex` row, `height:32px`, `box-sizing:border-box`, `padding: 0 4px 0 12px` (asymmetric — справа меньше под крестик), `border-radius:16px`. Внутри: span с иконкой (flex:0 0 auto) + span с названием видео (flex:1, `overflow:hidden white-space:nowrap text-overflow:ellipsis`) + `<button>` с `×` (flex:0 0 auto, opacity 0.7 → 1 на hover). Все состояния визуально одинаковые — различитель только иконка и border-color (`done`/`pasted` зелёный, `error` красный, остальные синий). Никаких слов «Готово»/«Транскрипция»/«Открываю» — иконка несёт всё.

**Крест — explicit override TTL.** TTL автоматически убирает терминальные тосты через 3-4.5с. Крестик нужен для случая «юзер вернулся к экрану, увидел готовое, хочет сразу скрыть» — не ждать таймер. Клик по кресту атомарно удаляет vid из `videoStateMap` + `clearTimeout` своего TTL-таймера + `renderToasts()`. Не отменяет сам job (он на бэкенде), только скрывает UI.

**Граница с overlay autoscrape.** На AI Studio есть **два** UI канала:
- `aistudio-autoscrape::makeOverlay` (`#sc-aist-overlay`) — внутренний overlay в самой странице AI Studio (Получено задание · жду транскрипт · Готово · вставлено). Промежуточные шаги, видны юзеру когда он на AI Studio. Сидит в `top:34`, чтобы не накладываться на toast-host (top:70).
- `aistudio-autoscrape::renderToasts` (`#sc-ai-toast-host`) — финальные `pasted`/`done`/`error`. Показывается всегда, независимо от того где фокус.

**Все три (`renderToasts` YT-стороны, `renderToasts` AI-стороны, `makeOverlay`) имеют одинаковую визуальную форму** — 32px pill, иконка слева + текст ellipsis + крест справа. Раньше `makeOverlay` был другой карточкой (`padding: 10px 14px`, без иконки, ≈40px высоты), что юзер мгновенно прочитал как «это разные компоненты, кто-то забыл унифицировать». Привели к одной форме — см. `methodology/переносимый-дизайн.md::Единая форма для уведомлений одного домена`. Иконка `makeOverlay` зависит от `kind`: `⏳` для прогресса, `✓` для ok, `✗` для error.

Дублирование renderer'а на двух доменах вынуждено: content-scripts'ы изолированы, нельзя шарить module между YouTube и AI Studio. Скопирована минимальная версия (`#sc-ai-toast-host`, `setToast`, `toastIcon`).

Принцип «локальный indicator + глобальный тост» — переносимый, см. `methodology/переносимый-дизайн.md::State per-resource + глобальный indicator`.

## 🎞 Shorts: тот же flow, другой DOM

YouTube Shorts (URL формат `/shorts/<id>`) для sc-desktop'а — та же платформа: `extractWatchUrl` нормализует обе формы в `https://www.youtube.com/watch?v=<id>`, bridge не различает (yt-dlp принимает оба варианта). Один кэш-файл, одно view в Library, общая скорость воспроизведения.

**Hover-делегация singleton-pill** ловит `a[href*="/watch?v="], a[href*="/shorts/"]` через единую константу `ANCHOR_SELECTOR`. Без shorts'ов в селекторе pill застревала на старом videoId — **клик отправлял прошлое видео, юзеру казалось «копирует последнее, что было скопировано»**. Симптом видимый: на /shorts/ нажимаешь pill, открывается AI Studio с транскриптом совершенно другого ролика, который юзер смотрел минуту назад.

Player dock (sc-pill + speed-pill) на /shorts/ работает идентично /watch — см. секцию `🎚 Player dock` ниже.

## 🎚 Player dock

Общий контейнер `#sc-yt-shorts-dock` (id-имя историческое) для двух pill'ов на странице плеера: SC-pill сверху (split copy/`+`), speed-pill снизу (`−/X.Xx/+`). Применяется и к /watch?v=…, и к /shorts/<id>.

### Архитектура

`position: fixed`, прибит к `body`. Координаты пересчитываются от bbox **якоря** на каждый resize/scroll/rAF-poller-tick. Это решает три проблемы сразу:
- offsetParent под YouTube'овским DOM нестабилен (Polymer пересоздаёт `#player-container` при смене качества/языка/свайпе);
- абсолютный якорь к `#player-container` не работал — на F5 у него `position: static` или нулевой bbox;
- свайп между шортами переезжает с активным reel'ом, а fixed-dock остаётся жив.

Layout: `flex-direction: column`, SC сверху, speed снизу. SC-pill prepend'ится в dock уже после speed-pill (порядок инжекта обратный визуальному порядку).

### Якорь по pathname'у

| Страница | `findDockAnchor()` возвращает |
|---|---|
| `/watch` | глобальный `#movie_player` (id уникален, всегда указывает на видимый плеер) |
| `/shorts/` | **`#movie_player` ВНУТРИ активного reel-renderer'а**, fallback на сам reel |

**Почему НЕ глобальный `#movie_player` на /shorts/.** На /shorts/ глобальный `document.getElementById('movie_player')` возвращает узел с `bbox = (0,0,0,0)` — он лежит в неактивном reel-renderer'е (prefetched соседи). Симптом: dock инжектится в правильный DOM, но его координаты вычисляются от bbox=0 → визуально pills уезжают в левый-верх viewport'а, на чёрный фон рядом с плеером (плеер по центру, узкая колонка).

Активный reel-renderer выбирается через `findActiveReelRenderer()` — по максимальной видимой площади в viewport (intersection с `window.innerHeight`). НЕ по `!video.paused` (на F5 видео ещё не запустилось), НЕ по первому в DOM (prefetched соседи могут быть первыми).

### F5: bbox=0 у prefetched reel'ов и rAF-poller

**Симптом.** При первой загрузке /shorts/ юзер видит pill'ы где-то слева на чёрном фоне, а сам shorts отрисован в центре — обе кнопки парят в стороне.

**Причина.** Polymer **лениво** поднимает layout активного reel-renderer'а: первые ~500ms у `#movie_player` внутри него `bbox=0`. `updateShortsDockPosition` вызывается один раз в момент инжекта, получает нулевые координаты, ставит dock в (0,0).

**Решение.** Dock стартует с `visibility: hidden`. RAF-poller (до 5 секунд после navigate) на каждом тике вызывает `updateShortsDockPosition` + `bindDockHover`, и как только bbox якоря становится валидным (`width > 0 && height > 0`) — пересчитывает `left/top`, привязывает hover-листенеры и **останавливается**. Дальнейшие изменения (resize, scroll, smaller-viewport-mode) ловит `resize` + `scroll` listener.

> **Stop-условие poller'а — готовность ЯКОРЯ, не видимость dock'а.** Раньше
> poller крутился пока `dock.style.visibility === 'visible'`. После того как dock
> стал hover-gated (см. ниже), это условие сломалось бы: видимость теперь зависит
> от hover, а не от layout — poller крутил бы полные 5 секунд каждую навигацию.
> Стоп-условие переключено на `bbox якоря > 0`: координаты пересчитаны, листенеры
> привязаны → выходим, дальше держит resize/scroll + pointerenter.

**Что пробовали и почему не сработало:**
- *Dock как `position: absolute` внутри `#player-container`*. На F5 у `#player-container` бывал `position: static`, dock с `top: 80; left: 12` уезжал относительно прошлого offsetParent (body / html). Установка `host.style.position = 'relative'` срабатывала непредсказуемо — Polymer переписывал inline-стили.
- *Якорь к первому `ytd-reel-video-renderer` в DOM*. Первый узел часто оказывался prefetched соседом — dock прибивался к нему, но визуально соседа не видно (display:none / overflow), pill уезжали за viewport.
- *Якорь к глобальному `#movie_player`*. На /watch работало, на /shorts/ — bbox=(0,0,0,0) (movie_player в неактивном reel'е).

### Dock visibility — hover-gated через JS, не CSS

Dock (sc-pill + speed-pill) по умолчанию **скрыт**, появляется на hover плеера.
Раньше висел постоянно, как только у якоря появлялся layout — юзер захотел
hover, как у остального («на основное видео так же, как по умолчанию работает»).

Гейтим **JS-флагом `dockHovered`**, не CSS `#movie_player:hover`. Причина: dock —
`position:fixed` сосед `body` (вынесен из плеера намеренно, см. Архитектуру
выше — Polymer пересоздаёт `#player-container`, F5 даёт bbox=0). CSS
descendant-rule от плеера до body-сиблинга **не достаёт**. `updateShortsDockPosition`
ставит `visibility` по флагу; координаты пересчитывает **всегда** (даже скрытым)
— чтобы первый hover после F5/навигации показал dock сразу на месте, без прыжка
из (0,0).

- **Union-hover**: `pointerenter`/`leave` вешаются на якорь плеера **И** на сам
  dock (`bindDockHover`, идемпотентно по dataset-флагу). Иначе переезд курсора с
  видео на пилюли (через 12px зазор) прятал бы их.
- **Grace-таймер 240ms** на `pointerleave` — зазор плеер↔dock и sc-pill↔speed-pill
  не мигает.
- **Re-bind на каждый resolve якоря** (injectWatchFab, poller, yt-navigate-finish):
  Polymer пересоздаёт `#movie_player` при смене качества/языка и при свайпе
  shorts'ов — новому узлу нужны свои листенеры. На навигации `dockHovered`
  сбрасывается в false (новый плеер = ещё не наведён).
- **Скрытие через `visibility:hidden`, не `opacity:0`**: hidden убирает hit-testing,
  невидимый dock не перехватывает клики по видео. opacity оставил бы pointer-events
  живыми.

### BUG#3: мигание скорости на `,`/`.` = нативный OSD, не наш dock

Симптом: юзер жмёт speed-шорткат `,`/`.` → на полсекунды вспыхивает окошко со
скоростью. Разбор (adversarial-верификация) показал: **наш код dock не трогает**.
Цепочка `,`/`.` → `bumpShortsSpeed` → `setShortsSpeed` делает три вещи (save +
`setPlaybackRate` + переписать текст лейбла) — ни одна не меняет видимость dock'а,
не реинжектит pill, не будит poller.

Мигало **нативное speed-OSD самого YouTube**: `movie_player.setPlaybackRate()`
будит родной индикатор скорости + control-bar, который YouTube автохайдит через
~1с. Пока наш dock висел постоянно поверх плеера, юзер читал нативную вспышку как
«наша плашка мигнула». После hover-gating (выше) наш dock при нажатии клавиш
остаётся `hidden` (`setPlaybackRate` **не** генерит `pointerenter`) — мигать
нечему. Баг ушёл как побочка фикса видимости, отдельной правки не потребовал.

### Speed-control (общий для /shorts/ и /watch)

UI: `−` (минус 0.1) | `1.0x` (label, клик = reset на 1.0) | `+` (плюс 0.1). Шаг 0.1, диапазон 0.1..4.0, формат `X.Xx` (одна цифра после точки — иначе 1.0+0.1 рендерится как «1.0999999999x»).

**Общее хранилище для shorts и watch.** `chrome.storage.local.__sc_yt_speed` — один источник правды. Юзер просил единое значение между площадками: «выставил 1.5x на /shorts/, перешёл на /watch — там тоже 1.5x». Legacy-ключ `__sc_yt_speed_shorts` читается при первом старте для миграции. Это выбор UX, не технический — могли бы держать раздельно.

**На /watch — `movie_player.setPlaybackRate(rate)`.** Это YT-API метод, и он **обновляет значение в нативном меню «Скорость воспроизведения»** (которое открывается через ⚙ → Скорость). Если ставить напрямую `<video>.playbackRate = rate`, скорость применяется, но нативный slider остаётся на 1.0x — юзер видит расхождение. Fallback на `<video>.playbackRate` остаётся, если YT-API недоступен (рекламный плеер в начале и т.п.).

**На /shorts/ — прямой `<video>.playbackRate`.** YouTube не выставляет нативное меню скорости на shorts вообще, так что отражать не во что.

**Sticky между свайпами шортов.** YouTube переинициализирует `<video>` при свайпе. `loadedmetadata` listener в **capture-фазе** (capture: true) ловит каждый новый `<video>`-узел и применяет сохранённую скорость. Capture обязателен — media-events не bubble. Пере-применение также делается в `yt-navigate-finish` для случая когда `<video>` reuse через src-swap (без re-attach → loadedmetadata не стрельнёт).

**Pause НЕ сбрасывает playbackRate.** Это поведение HTML5 video element (внешний факт), не нужно ничего восстанавливать после `<video>.pause()` / `play()`. Проверено: ставишь 2.0x → пауза → resume → продолжает 2.0x.

**F5 переживает.** init() читает storage до первого инжекта pill'а; первый `loadedmetadata` тут же применяет.

**Keyboard shortcuts `,` / `.` (без Shift).** На /watch и /shorts/ одиночные `,` = -0.1, `.` = +0.1. Match по `e.code === 'Comma' / 'Period'` (раскладко-независимо: на русской раскладке с теми же физическими клавишами приходит `key:"б"/"ю"`, но `code` тот же).

YouTube **нативно** перехватывает эти клавиши:
- одиночные `,` / `.` — покадровое перемещение на паузе.
- `Shift+,` / `Shift+.` — изменение скорости шагом 0.25.

Чтобы наша логика выиграла — listener'ы на window AND document с `capture: true`, плюс `e.preventDefault() + stopPropagation() + stopImmediatePropagation()`. Дедуп через `e.timeStamp`: тот же event приходит и в window-handler, и в document-handler — bump'аем только в первом.

`isTypingTarget(e.target)` проверяет input/textarea/contenteditable — не ловим при наборе в комментариях под видео или поиске.

**Что пробовали и отбросили:** требование `Shift` в условии. Юзер просил `< / >` — на латинской раскладке это и есть `Shift+,` / `Shift+.`. Лог детерминированно показал `shift:false` на каждом нажатии — юзер бил без Shift. Убрали. `Shift+,` / `Shift+.` теперь не наш код — пропускаем (даём YT-нативному 0.25 step жить).

### Split SC-pill (copy / `+`)

Двух-частная кнопка: левая (`📋 copy`) — только сохранить в sc-desktop, правая (`+`) — сохранить + отправить в выбранный AI-target. **Identical background, identical hover-фон, identical text-color** — единый pill, разница только в иконке/лейбле, vertical 1px-divider визуально показывает зону клика. Юзер итерировал на этом: исходно правая половина была акцентно-фиолетовой, потом откатили — слишком кричит, две одинаковых половинки с разделителем читаются понятнее.

**handleClick(url, btn, autoAistudioOverride, withCommentsOverride)** — explicit override. Левая кнопка передаёт `false, false`, правая `true, false`. Background-tracker дальше обрабатывает идентично — единственное различие: при `autoAistudioOverride=true` он откроет `aistudio.google.com` в фоновой вкладке после готовности транскрипта. `withCommentsOverride` отвечает за добавление комментариев — см. секцию **Cmd-row** ниже.

**Active state — overlay-label поверх обеих половин.** Когда идёт `sending`/`searching`/`transcribing`/`opening`, обе кликабельные половины скрываются (`visibility: hidden`), поверх pill'а абсолютно-позиционированным `<div>` рисуется единый текст. Без этого видно две disabled-кнопки рядом — юзер не понимает что пилюля занята целиком, тыкает обе и ждёт реакции. **Cmd-row тоже принудительно скрывается** в active-state'е — иначе клик `+ субтитры` создал бы второй POST для уже-активного видео.

**Удалили global toggle «Автоскрапинг нейронки» из popup'а.** Раньше юзер один раз ставил toggle и каждое нажатие шло по этому пути. Минусы: переключаться приходится каждый раз когда хочешь поведение наоборот, нет визуальной подсказки на самом видео что произойдёт. Split-pill решает оба — выбор explicit на каждый клик. Поле `__yt.auto_aistudio` оставлено в storage (legacy совместимость), всегда `false` — sanitize-функция в `settings.js` не падает на старых данных.

**Two variants: overlay (карточки) vs dock (плеер).** `makeSplitPill(videoId, url, {variant})`:
- `'overlay'` — height:30, padX:10, position:absolute. Применяется в singleton-pill (hover-preview) и per-card pill'ах. Меньшая высота — на превьюшках мелких видео pill не съедает половину thumb'а.
- `'dock'` — height:36, padX:12, position:static (dock сам позиционирует). Применяется в FAB на /watch и /shorts/.

**Closure-free `resolveUrl()` для overlay-варианта.** Singleton/per-card pill используют `cloneNode(true)` чтобы перевесить click handler с динамическим `videoId` (он берётся из `wrap.dataset.videoId` в момент клика — критично из-за thumb-recycle Lit'ом). Оригинальный handler из `makeSplitPill` теряется при клонировании, но cmd-row'ные кнопки **внутри cmd-row контейнера** не клонируются и сохраняют свой closure'ный `resolveUrl()` — он сам читает `wrap.dataset.videoId`, поэтому работает после переезда pill'а на другое видео.

> **Comments divergence из-за cloneNode.** При перевешивании click'а у overlay-клонов
> легко передать `handleClick(url, btn, role === 'ai')` — **без 4-го арга**
> `withCommentsOverride`. Тогда он падает в `null` → берётся `ytSettings.with_comments`,
> и plain `copy` на карточке начинает тянуть комменты, если настройка включена — а
> dock-FAB (единственная pill чьи половины **не** клонируются, сохраняет исходный
> `false`) комменты не тянет. Итог: одна и та же кнопка шлёт разный запрос в
> зависимости от того где она. Фикс: три overlay-клона (singleton/per-card/shorts)
> передают явный `false` 4-м аргом. Комменты — **только** через Cmd-row (он передаёт
> `true` своим собственным, не-клонированным handler'ом).

**Hover-эффект через CSS `.sc-pill-half:hover`, не JS.** Изначально `mkHalf` ставил inline JS-listener'ы `mouseenter/mouseleave` для подсветки фона половин. На overlay-варианте `cloneNode(true)` копирует только атрибуты, **не listeners** — половинки на карточках перестали реагировать на hover. Перенесли подсветку в CSS-rule в `injectGlobalCss`: `button.sc-pill-half:hover:not(:disabled) { background: rgba(255,255,255,0.10) !important }`. CSS выживает клонирование.

**Что пробовали и отбросили:**
- *Inline-flex sc-pill в нативной группе `ytd-shorts-player-controls #right-controls` рядом с CC/меню/fullscreen*. Работало визуально на чистом YouTube, но **Yandex Summary Overlay** (расширение от Яндекса со чипом «Пересказать») висит над верхней полосой controls и перекрывает её. У юзера расширение установлено — pill была невидима. Ушли в свой dock «под Play», вне зоны Yandex'а.
- *Hover-only Watch FAB через CSS `#movie_player:hover #sc-yt-fab`*. CSS-подход
  отброшен: dock — `position:fixed` сосед body, CSS descendant-rule от плеера до
  него не достаёт. Сама идея hover-only для **обеих** pill (включая speed) в
  итоге принята — юзер захотел hover везде — но реализована JS-флагом
  `dockHovered` (union-hover плеер+dock + grace-таймер), см. `Dock visibility`
  выше. Промежуточный вариант «обе видимы постоянно когда плеер виден» прожил
  недолго и тоже отброшен.
- *Single-button «⬇ sc · AI» (старая версия) с global toggle*. UX-проблема выше — нужно идти в popup чтобы переключить поведение. Split закрывает за один клик.

### Cmd-row: copy с комментариями

UX: pill остаётся `📋 copy / +`. Зажимаешь Cmd над pill'ом — снизу с offset 6px разворачивается **второй ряд**: `+ субтитры / + субтитры + ai`. Тот же handleClick, но `withCommentsOverride: true` — bridge запустит и transcript-job, и `yt_comments` (sort:'new', limit:500). На отпускание Cmd ряд исчезает.

**DOM: cmd-row живёт в `document.body`, не внутри `wrap`'а pill'а.** `WeakMap<wrap, cmdRow>` (`scCmdRowMap`) держит связь.

Почему не внутри wrap'а: YouTube ставит `transform`/`will-change`/`overflow:hidden` на родителях карточки, а `position: fixed` child'а в таком предке **превращается в position:absolute относительно того предка** — клипается его границами. Симптом: cmd-row видим в DOM с `display:inline-flex`, координаты валидные, но визуально не виден — YouTube'овский overflow:hidden обрезает.

Position fixed с координатами от `wrap.getBoundingClientRect()` в момент `showCmdRow` решает.

**Listeners.** `keydown`/`keyup` на `Meta`/`Control` обоих, на window AND document, capture:true оба. YouTube ставит свои listener'ы где попало (на /watch ловит modkeys на window для шорткатов поиска); capture-true перехватывает раньше.

**Sticky пока Cmd зажат.** `mouseleave` от pill'а **не закрывает** cmd-row — иначе юзер не успевает переехать через 6px зазор между pill и рядом, теряет клик. Закрывается только на `keyup Meta/Control` или `window.blur`.

**Single row at a time.** `showCmdRow(wrap)` сначала `hideCmdRow` у всех остальных pill'ов. Если юзер зажал Cmd над pill A → переехал курсором на pill B (без отпускания Cmd) → cmd-row у A исчезает, у B появляется.

**Hover-detection через `wrap.matches(':hover')`, не dataset-флаг.** Если pill только что инжектнули в DOM а курсор УЖЕ над ней — `mouseenter` не сработает (мышь не переходила границу). `:hover` — атомарная DOM-проверка в момент keydown.

**Что пробовали и отбросили:**
- *cmd-row внутри `wrap.appendChild(cmdRow)` со своим `position: fixed`*. На карточках `wrap` сам `position: absolute` и его родители имеют `transform` — fixed-child клипался. Перенос в body решил.
- *Скрытие cmd-row через 50ms timeout на mouseleave с pill*. Юзер не успевает дотянуться до ряда через 6px зазор, ряд исчезает раньше клика. Sticky-до-keyup надёжнее.
- *Hover-tracking через `dataset.scHovered = '1'` на mouseenter и сброс на mouseleave*. На pill'е созданной под уже-зажатым курсором mouseenter не стрелял (мышь не пересекала границу). `:hover` — атомарная проверка.

## 🛡 Архитектурные edge cases

Все вытащены из аудита, не из реальных багов — превентивная защита.

**Re-entry guard для double-click.** `handleClick` async. Между
`pill.addEventListener('click', ...)` и `paintPill('sending')` есть как
минимум один tick — за этот tick юзер успевает кликнуть второй раз пока
pill ещё `disabled=false`. Без guard'а — два параллельных POST /yt-add,
два разных jobId на сервере. Решение: `isActiveForVideo(videoId)`
проверяет Map синхронно ДО любых await — второй click игнорируется
с логом `[SC-YT] click ignored, already active`.

**Thumb-recycle (Lit/Polymer DOM-reuse).** YouTube переиспользует
thumb-узлы при scroll'е виртуализованных списков. Раньше использовали
`thumb.dataset.scPercardInjected = '1'` для дедупа — на переиспользованном
узле флаг сохранялся, pill оставалась с **старым videoId**. Решение:
вместо dataset-флага источник правды — `existing.dataset.videoId vs
extractVideoId(currentLink.href)`. Если расходятся — обновляем dataset
и перерендериваем под новое видео из Map'а. Click читает **актуальный**
`btn.dataset.videoId` (не closure-переменную из времени инжекта).

**FAB recreate на смене videoId.** Player dock — `position: fixed` в `body`,
переинициализация `#movie_player` сама по себе dock не убивает (нет
detached-DOM проблемы как раньше с inline-FAB'ом в `#movie_player`).
Но при смене videoId pill хранит старый dataset.videoId — после
`yt-navigate-finish` сравниваем `oldFab.dataset.videoId !== cur` и
удаляем FAB чтобы handleClick не отправил старый URL. RAF-poller
после navigate тут же пере-инжектит обе pill'ы и пересчитывает
координаты якоря (см. секцию `🎚 Player dock::F5` — тот же поллер,
работает и для свайпа shorts'ов).

**Singleton recreate при detach.** YouTube пересоздаёт `<ytd-video-preview>`
при переходах / → /watch и обратно. Pill остаётся в detached DOM,
последующие `setVideoState` пишут в Map но визуально ничего не видно.
Решение: на каждый `yt-navigate-finish` проверяем
`pill.isConnected && pill.closest('#video-preview-container')` —
если detach'нулась, пересоздаём через `getOrCreateSingletonPill()`.

**Reset hover-sentinel.** `__sc_lastHoveredVideoId` хранит последний
hovered videoId чтобы не дёргать render на каждый mouseover. После
`yt-navigate-finish` DOM полностью обновлён, тот же hover на ту же
карточку с тем же videoId должен снова обновить pill (контейнер
preview пересоздан/пуст). Без сброса pill «зависала» на старом videoId.

**Stale-error защита.** `handleClick` может попасть в catch (например,
`pingBridge()` вернул false из-за временного сетевого глюка) **уже после**
того как background успел прислать `done` (cache-hit мгновенный). Без
защиты stale-error перетёр бы свежий done. Решение: в `setVideoState`
если `state === 'error' && (prev.state === 'done' || prev.state === 'pasted')` —
игнорируем, лог `[SC-YT] setVideoState: ignoring stale error`.

**Singleton якорь — `#media-container-link`, не `#video-preview-container`.**
После очередного редизайна YT outer-container перестал быть прямой
обёрткой thumb'а — в DOM-snapshot'е видно, что между ним и видео
появился `#media-container > #media-container-link`. Singleton-pill
с `top:46/left:8` относительно outer'а уезжала **под** карточку (в
футер с avatar+title). Симптом: пилюля видна, но не на превью видео —
где-то ниже, перекрывая название канала. Якорим к `#media-container-link`
напрямую — он теперь прямая обёртка thumb'а; outer оставлен как fallback
на следующий редизайн.

**DOM-attribute лог для MCP-отладки.** В content-script встроен `dbg(tag, data)`,
пишет ring-buffer в `<pre id="sc-yt-dbg-log">` (textContent) +
`window.__sc_debug` + `console.log`. Каждые 1.5с поллит
`chrome.storage.local['__sc_bg_dbg']` (туда пишет background) и
зеркалит SW-логи в свой sink. Используется для отладки через
`mcp__browser__get_text` без `userScripts` toggle: DSL-evaluate не
читает `window.*` и `data-*`, а текстовое содержимое `<pre>` читается
надёжно через `get_text`.

## 🤖 AI target: dispatch и автоскрапинг

Выбор target'а делается селектом в строке заголовка «YouTube пересказ» в
popup'е расширения. Popup показывает **только карточку выбранной цели**:
не выбранный Claude/Gemini/ChatGPT не занимает половину экрана и не выглядит
как активная конфигурация. При этом настройки всех целей хранятся одновременно:
переключение target'а меняет destination следующего `+ ai`, но не стирает
модель, project/system-instruction или ChatGPT effort.

Три target'а делятся на два механических класса:
- **Gemini Studio** и **Claude** — autoscrape: background кладёт payload в
  `chrome.storage.local`, открывает вкладку target'а в фоне, content-script
  на странице сам выбирает модель/проект/инструкцию, вставляет текст и жмёт Run.
- **ChatGPT** — compose handoff: background читает готовый transcript/comments через
  `/yt-fetch`, собирает один prompt (`chatgpt_prompt` + текст видео + комментарии),
  кладёт payload в `chrome.storage.local` под `__sc_chatgpt_compose_job_*` и открывает
  `chatgpt.com/?sc-compose=<id>#sc-compose=<id>`. `chatgpt-research.js` в этой ветке
  переиспользует только низкоуровневые шаги выбора модели/effort, paste, ожидания
  document-loader'а и Send. MCP-badge, watcher ответа, парсер «Источников» и
  `/research-state` не запускаются.

У ChatGPT target нет события `__sc_aistudio_pasted`: вкладка остаётся открытой после
submit, потому что результат пересказа нужно читать прямо в ChatGPT. Для YouTube-кнопки
это означает: `opening`/`done` подтверждают, что ChatGPT-вкладка открыта и prompt
принят к отправке; финальный текст дальше живёт в обычной истории/вкладке ChatGPT,
не в истории MCP.

`aistudio-autoscrape.js` — content-script на `aistudio.google.com/prompts/*`.
Триггер: открытие `prompts/new_chat#sc=<requestId>`.

`requestId` — ключ записи в `chrome.storage.local` куда background-tracker
кладёт payload (модель, имя пресета, путь к файлу или jobId). После чтения
ключ удаляется (idempotent на F5).

### Шаги

1. **Получить транскрипт.** Если в payload есть `cachedFilePath` — fast
   path: `GET /yt-fetch?path=…` синхронно даёт текст. Иначе polling
   `GET /yt-status?id=<jobId>` каждые 2-10с экспоненциальным backoff'ом.
2. **Выбрать модель.** Кликнуть `button.model-selector-card`, открыть
   dropdown, найти `mat-option` с `textContent === settings.modelTitle`,
   click. Если текущая модель уже та — skip.
3. **Выбрать System instructions пресет.** Кликнуть
   `[data-test-system-instructions-card]`, дождаться `mat-select` (первый
   combobox в открывшейся панели — без aria-label). Кликнуть, в overlay
   `mat-option`'ах найти `textContent === wanted`. Если 0 → throw «не
   найден». Если ≥2 → throw «дубли». Иначе click.
4. **Paste промпта.** В textarea с placeholder `Start typing a prompt`
   проставить `setReactValue(ta, text)` (нативный setter + dispatchEvent
   input/change). Если в textarea уже что-то — затереть, иначе наш
   транскрипт допишется хвостом и первая часть будет мусорной.
5. **Run.** Клик на `button` где `textContent` содержит `Run` И
   `keyboard_return` (mat-icon).
6. **Дождаться завершения генерации (`waitForCompletionWithRetry`).** КРИТИЧНО —
   до этого шага НЕЛЬЗЯ трогать модель/инструкции (см. scar ниже). Ждём
   Stop→Run transition через `scAistudio.waitForCompletion`, с retry через
   `rerunLastTurn` (sparkle «Rerun this turn», MAX_RETRIES=2) на транзиентные
   backend-error'ы — зеркало `aistudio-mcp.js::runJob`.
7. **Post-Run reset System Instructions.** Опционально (`post_system_instruction`).
   Снова открываем sys-card → mat-select; пустая строка → `+ Create new
   instruction` (sys-prompt = «нет инструкции»); имя → выбираем как обычно.
   Non-fatal: ошибка не валит `done()`.
8. **Post-Run model switch.** Опционально (`post_model_title`, default
   `Gemini 3.1 Pro Preview`, пустая = не менять). `ensureModel(postModelTitle)`.
   Идея: пересказ делает быстрая Flash, следующие вопросы юзера идут на Pro.
   Делается **только если был надёжный сигнал завершения** (`focusOk`, см.
   ниже) — иначе оставляем Flash. Non-fatal.

#### ❌ Scar: post-Run мутации в середине генерации → «permission denied»

**Симптом (юзер):** клик AI-кнопки на YouTube → в Gemini Studio турн падает
с *«An internal error has occurred. Failed to generate content: permission
denied»*. Ручной клик sparkle «Rerun this turn» — проходит нормально.

**Root cause.** Раньше шаги 7-8 (reset sys-instruction + `ensureModel`
Flash→Pro) выполнялись **СРАЗУ после Run**, без ожидания завершения.
`pastePromptAndRun` возвращается как только появился Stop — запрос ещё
**стримится**. Открытие model-dropdown'а и переключение модели посреди
in-flight генерации ломает текущий turn (Angular пересобирает request-context
под сменившейся моделью) → backend роняет его с permission-denied. Дефолты
гарантируют срабатывание: `model_title='Gemini 3 Flash Preview'` ≠
`post_model_title='Gemini 3.1 Pro Preview'`, switch всегда fires. Ручной
Rerun работает потому, что к тому моменту модель уже устаканилась на Pro и
запрос пересылается начисто.

**Усугубляющий фактор — скрытая вкладка.** Autoscrape-вкладка открыта
`active:false` и (в отличие от MCP-пути) **не получала focus-emulation**.
В hidden tab Angular CD заморожен (rAF на паузе, см.
`fact-aistudio-mcp.md::Hidden-tab strategy`) → Stop→Run не рендерится →
наивный `waitForCompletion` вернулся бы преждевременно. Поэтому шаг 6 без
debugger-attach бесполезен.

**Фикс (3 части):**
1. **Wait-before-mutate** — шаг 6 вставлен между Run и post-Run мутациями.
2. **Focus-emulation для autoscrape** — перед Run шлём `__sc_debugger_attach`
   (background.js уже умеет attach к вкладке-отправителю, правок там нет),
   в `finally` — `__sc_debugger_detach`. Без него (`focusOk=false`, напр.
   prod без debugger-привилегии) шаг 8 пропускается: не зная, дописал ли
   Flash, не рискуем повторно ломать turn — оставляем Flash, юзер сам
   переключит.
3. **Retry через rerunLastTurn** — autoscrape раньше вообще не ретраил
   (клик Run → сразу `done()` вслепую), теперь self-heal'ит транзиентные
   backend-error'ы как MCP-путь.

Диагностируемость: `aistudio-autoscrape::log()` годами писал в
`window.__aise_log`, которого НЕ существует (logger.js экспонирует
`window.__AISE_LOGGER__`) → все autoscrape-логи шли только в console, в
NMH-файл `exporter-*.log` не попадали. Отсюда «просто пусто, ноль следов»
при отладке. Исправлено → теперь `completion_ok` vs `backend_error_retry`
в файле-логе однозначно скажет, in-flight-мутация это была или сама
Flash-модель денайнута.

### Fallback Ctrl+Enter

После `runBtn.click()` success проверяется по реальному маркеру `Stop`: если
Run-click не перевёл composer в streaming-state, fallback диспатчит штатный
шорткат Gemini Studio (Ctrl+Enter / Cmd+Enter) в textarea. Это работает напрямую
через ProseMirror и не зависит от focus/event-bubbling кнопки Run. Фиксированная
пауза сама по себе не считается доказательством submit'а — см.
`methodology/переносимый-дизайн.md::UI-состояние ждём по маркеру, не по задержке`.

### Что отбросили

**paste-в-textarea для system instructions.** Изначально юзер вводил в
popup ПОЛНЫЙ текст инструкции, autoscrape кликал sys-card → paste'ил в
textarea. Не сработало:
- Длинный текст (5-8KB) забивал `chrome.storage.sync`-лимиты на
  отдельный ключ.
- В Gemini Studio пресет всё равно не сохранялся — там своя форма с
  Title-input + textarea, и пресет нужно сохранять explicit'но через
  кнопку Save. Юзер каждый раз перезаписывал текст, а не выбирал пресет.

Решение: input в popup'е принимает **имя сохранённого пресета** (Title),
autoscrape выбирает его из dropdown. Пресет один раз сохранил — пользуешься
именем.

**macOS chrome.notifications.** Изначально background-tracker показывал
системные уведомления при готовности. Юзер сказал — отвлекают, дублируют
то что и так на pill-кнопке. Permission `notifications` снят с manifest'а;
весь feedback на сайте.

**content-script-driven open Gemini Studio.** Изначально вкладка
открывалась `window.open` сразу после клика на YouTube — autoscrape там
сам polls'ил bridge и ждал транскрипт. Юзер выбрасывался с YouTube до
готовности. Теперь content-script только шлёт payload в background, а
открытие делает сам tracker через `chrome.tabs.create({active:false})`
**только** на done. Юзер остаётся на YouTube, во вкладку приходит уже
готовое — переключается когда захочет.

**Reset sys-prompt и смена модели ДО Run.** Логически естественно: «сначала
поставить желаемое состояние, потом отправить». На практике — Gemini
Studio в момент валидации Run-payload'а реагирует на любое изменение
mat-select'ов: открытие dropdown'а на sys-instructions card убирает
focus с textarea, новый sys-prompt применяется К САМОМУ запросу (а не
после), переключение модели сбрасывает payload в input'е. Безопасно
делать оба только **после** Run-клика — Gemini уже зафиксировал input,
а UI-операции дальше для него прозрачные.

## 🤖✓ pasted: финал autoscrape

`done` и `pasted` — **два разных** терминальных события для пользователя кликнувшего `+ ai`:
- `done` (`✓`) — sc-desktop сохранил транскрипт в файл и положил в clipboard.
- `pasted` (`🤖✓`) — autoscrape вставил текст в Gemini Studio textarea и нажал Run.

Между ними может быть 5-15 секунд (autoscrape ждёт чтобы Angular UI догрузился, выбирает model + system instruction, печатает). Без отдельного события юзер не понимает завершилась ли автоматизация — `done` приходит раньше чем тексту реально появиться в AI Studio.

**Канал.** `aistudio-autoscrape::done(requestId)` шлёт `chrome.runtime.sendMessage({__sc_aistudio_pasted: true, requestId, ok: true})`. `fail(message, requestId)` — то же с `ok:false`. Background-side `handleAistudioPasted` находит соответствующую YT-вкладку и шлёт `state='pasted'`.

**Routing requestId → YT-вкладка.** При open'е AI Studio через `openAistudioBackground(payload)` мы кладём в `chrome.storage.local['__sc_aistudio_job_<requestId>']` запись со связкой `{ytTabId, ytVideoId, ytTitle}`. На `__sc_aistudio_pasted` event берём оттуда `ytTabId/ytVideoId` и шлём toast туда. Запись подчищается после.

`history.replaceState(null, '', location.pathname + location.search)` стирает `#sc=<requestId>` из URL'а сразу при чтении в autoscrape — F5 на AI Studio не запустит flow повторно. Но storage-запись остаётся для background'а — она удаляется только в `handleAistudioPasted`.

**Broadcast на оба домена.** `sendBtnState` для терминальных state'ов (`pasted`/`done`/`error`) отправляет на:
1. Активную visible YT-вкладку (`chrome.tabs.query`).
2. Исходную YT-вкладку где был клик (`originalTabId` из tracker'а).
3. Все AI Studio вкладки (`chrome.tabs.query({url:[aistudio.google.com]})`).

`aistudio-autoscrape.js` содержит **независимый** `renderToasts` с тем же стилем (height:32, иконка+название, ellipsis). Дублирование вынуждено — content-scripts'ы изолированы между доменами, нельзя шарить module между YouTube и AI Studio.

**Минорное: на AI Studio показываются только финальные state'ы** (`pasted`/`done`/`error`) — промежуточные `searching`/`transcribing` autoscrape сам рисует через свой overlay в самой странице AI Studio (видимый только когда юзер на ней).

## 👁 Visibility-aware delivery

Юзер кликнул `+ ai` на YT → переключился на AI Studio смотреть как идёт paste → вернулся на YT через минуту → должен увидеть финал. Раньше через TTL 4.5 сек тост сгорал в фоне на скрытой вкладке, юзер ничего не видел.

**Background broadcast.** `sendBtnState(originalTabId, payload)` отправляет на ДВА адреса (плюс AI Studio для терминалов):
- активную visible YT-вкладку через `chrome.tabs.query({active:true, lastFocusedWindow:true, url:[youtube]})`.
- `originalTabId` — исходная вкладка где был клик.

Дубль безопасен — content-script сам отбросит на скрытой вкладке для не-терминальных событий.

**Content-script visibility-гард.** В `chrome.runtime.onMessage` listener'е:
```js
const persistOnHidden = (req.state === 'pasted' || req.state === 'done');
if (document.visibilityState !== 'visible' && !persistOnHidden) return;
setVideoState(vid, req.state, ...);
```

То есть: на скрытой вкладке `searching`/`transcribing`/`opening` дропаются (на момент возврата они уже устарели), а `pasted`/`done` сохраняются в Map.

**TTL зависит от visibility.** В `setVideoState` для терминальных:
```js
if (document.visibilityState === 'visible') {
  setTimeout(remove, ttl);  // запускаем сейчас
}
// Если скрытая — TTL НЕ запускается. Запустится при visibilitychange→visible.
```

`visibilitychange → visible` listener:
- стирает `done`/`error` сразу (юзер уже знает что job завершился, новый кликает с idle).
- `pasted` запускает TTL 4.5 сек (юзер только сейчас видит — должен увидеть толст и затем он сам исчезнет).

**Stale-error защита расширена.** `if (state === 'error' && (prev.state === 'done' || prev.state === 'pasted')) ignore`. Late `pingBridge()` retry мог вернуть error уже после успешного `done`/`pasted`; не даём перетереть.

## 🛡 Background tracker

`background.js` хранит активные job'ы в `chrome.storage.local.__sc_tracker_jobs`.
Polling через `chrome.alarms` (period 0.1 min ≈ 6с — минимум что
поддерживает Chrome alarms API).

```js
trackJob({jobId, videoId, tabId, fromCache, autoAistudio, target, modelTitle, systemInstruction, chatgptModel, chatgptEffort, ...})
```

- `fromCache:true` → не polls'им, сразу финализируем (открываем выбранный
  AI-target если auto, шлём `state:'done'`).
- `target` нормализуется в `aistudio|claude|chatgpt`. Legacy job'ы без target'а
  считаются `aistudio`, чтобы старые storage-записи не ломали opening.
- Иначе кладём в storage, поднимаем alarm. На каждый tick `pollTracker`:
  - timeout 30 минут → `state:'error', "таймаут"`, удаляем
  - bridge unreachable → пропускаем тик (попробуем в следующем)
  - status=error / comments_status=error → relay error, удаляем
  - оба done → если auto: `state:'opening'`, `openTargetBackground(target)`,
    `state:'done'`. Иначе сразу `state:'done'`. Удаляем.

**Idle-resilience SW.** Service worker в Chrome выгружается через ~30с
неактивности. `chrome.alarms` переживает это — на следующий tick SW
просыпается заново. Поэтому tracker-state в `chrome.storage.local`, а
не в module-level переменной.

При reload расширения SW стартует, читает map из storage; если есть
ожидающие job'ы — поднимает alarm. Юзер мог закрыть popup и забыть, но
notification на pill-кнопке всё равно прилетит когда транскрипт готов
(если YouTube-вкладка ещё жива — content-script её обновит; если нет —
fail silent, при следующем визите старая кнопка уже идёт в idle через TTL).

### Надёжность handoff'а и финализации

Три места где job мог молча потеряться или продублироваться — все вокруг того
что SW идемпотентен и может проснуться/умереть посреди flow'а.

**Click→SW handoff с callback, не fire-and-forget.** Content-script шлёт
`{__sc_track_job}` в SW. Раньше это был `sendMessage` без callback в пустом
`catch {}`; если канал к SW рвался (SW выгружен, расширение перезагружается) —
`trackJob` не запускался, в storage не появлялась запись, **ни таймаута, ни
ошибки**: плашка зависала на «⏳ Транскрипция…» навсегда (спасал только F5).
Сейчас `sendMessage` с callback + проверкой `chrome.runtime.lastError`; при
провале → `state:'error'` с понятным текстом. Re-entry guard держится: `'sending'`
выставлен синхронно до await, так что двойного POST нет.

**Idempotency-латч перед открытием AI-вкладки.** `aiOpenStarted` ставится в
storage **до** `openTargetBackground`. Если SW выгрузят и разбудят alarm'ом между
открытием target'а и финальным `state:'done'`, новый проход `processSnapshot`
снова увидит `transcriptDone && commentsDone`; без storage-латча он открыл бы
вторую вкладку. Искусственной задержки ради того, чтобы тост «Открываю…» пожил
на экране, нет: `opening` — событийный маркер «начали open target», а не
таймерный loading-state.

**Orphan-storage cleanup при сбое открытия.** `openTargetBackground` пишет
`__sc_aistudio_job_*` / `__sc_claude_job_*` для autoscrape и
`__sc_chatgpt_compose_job_*` для ChatGPT compose. Autoscrape-записи удаляются после
`pasted`, ChatGPT-запись — после успешного submit в обычный чат. Если открытие упало
или вкладку закрыли до чтения payload'а, запись висела бы в `storage.local` вечно.
На error-пути `cleanupOrphanAiJob(videoId)` подчищает все три семейства ключей по
`ytVideoId`.

### awaiting_ai engine берётся из настройки

`__sc_track_job` теперь несёт `engine` (gemini|assemblyai) из `ytSettings.engine`
→ `trackJob.engine` → `POST /yt-resume-ai`. Раньше payload его не включал и
auto-resume всегда шёл gemini'ем, игнорируя настройку. Сам латч resume'а на
стороне bridge'а — см. `fact-yt-extension-bridge.md::awaiting_ai auto-resume`.

## 🔗 Связано

- `fact-yt-extension-bridge.md` — HTTP-эндпоинты, cache-first семантика,
  CORS, port-conflict
- `fact-browser-extension.md` — общая архитектура расширения (NMH,
  AI Studio экспортёр, Perplexity, теперь YouTube)
- `methodology/переносимый-дизайн.md::Прогресс на источнике клика` — почему toast'ы
  не подходят для долгих операций с привязкой
- `methodology/переносимый-дизайн.md::Фоновое открытие зависимой вкладки` — почему
  открываем только после готовности и `active:false`
