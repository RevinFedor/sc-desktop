# Knowledge: визуальная пометка MCP-вкладок в браузере

MCP-вкладки (aistudio / claude / perplexity открываемые из sc-desktop) должны быть
визуально отличимы в таб-баре, чтобы юзер не путал их с обычными чатами. Изначально
планировалась группировка через `chrome.tabGroups`, но в Яндекс.Браузере этот API
не реализован — пришёл к workaround через подмену favicon и title с MutationObserver-сторожем.

## Почему не tabGroups: API недоступен в Yandex

В Яндекс.Браузере (форк Chromium 124–130 по browserslist/map-to-chrome) поведение
tab-groups API отличается от vanilla Chrome:

| Operation | Yandex поведение |
|---|---|
| `typeof chrome.tabGroups` | **`undefined`** — namespace отсутствует целиком |
| `chrome.tabs.group({tabIds})` | работает, создаёт безымянную группу, возвращает groupId |
| `chrome.tabs.group({groupId, tabIds})` | добавляет вкладку в существующую группу по id |
| `chrome.tabs.query()` field `groupId` | **всегда `-1`** — Yandex не отдаёт текущую принадлежность |
| `chrome.tabs.onUpdated` `changeInfo.groupId` | **не emit'ится** при перетаскивании юзером |
| Программное задание title/color группы | **невозможно** — нужен `chrome.tabGroups.update` |

Архитектурно: Yandex заменил Chromium tab-strip groups собственной side-panel реализацией
(Ctrl+Shift+E Tab Manager), которая не привязана к Chromium-инфраструктуре, на которую
завязан `chrome.tabGroups`. Подробный research — claude.ai chat
`af4b9cd2-d2a5-417b-8842-1d2d4628f607` («Поддержка tab groups API в Yandex Browser»).

## Что отсюда следует для расширения

Узнать `groupId` существующей user-named группы из API нельзя — `chrome.tabs.query`
возвращает `-1` для всех вкладок. Это значит:

- **«запомнить group 'mcp' юзера и кидать туда новые вкладки» — невозможно** без ручного ввода
  groupId через DevTools SW.
- **Pattern D** (research-вывод) — Yandex автоматически кладёт `chrome.tabs.create({url})`
  вкладку в активную группу, если юзер сейчас в ней. Но **расширение не может прочитать**
  в какую группу попала вкладка, и не может выбрать другую. Pattern D подходит как
  «опциональный side-effect», не как контролируемый канал.

## Workaround: favicon + title override + persist

`background.js::markTabAsMcpVisually(tabId, provider)` помечает вкладку, инжектя в MAIN-world
`<link rel="icon">` с `chrome.runtime.getURL('images/icon32.png')` и фиксированный
`document.title`. Provider определяет title:

| provider | title | детект через |
|---|---|---|
| `gemini` | `gemini-parser` | hostname === `aistudio.google.com` |
| `claude` | `claude-parser` | hostname === `claude.ai` |
| `perplexity` | `perplexity-parser` | hostname === `www.perplexity.ai` |
| `chatgpt` | `chatgpt-parser` | hostname === `chatgpt.com` / `www.chatgpt.com` |
| `yandex` | `yandex-maps` | hostname === `yandex.ru` / `*.yandex.ru` |

Provider определяется автоматически из `chrome.tabs.get(tabId).url` если явно не передан.

`yandex` отличается от трёх research-провайдеров природой вкладки: это не SPA-чат,
а **фоновая служебная вкладка** `yandex_maps_search` (см. `fact-yandex-maps.md`),
которая за один tool-call делает много навигаций (`about:blank → /maps/search →
?page=2 → …`). Метка поставлена один раз при создании вкладки, дальше держится тем же
`chrome.tabs.onUpdated`-механизмом — он пере-инжектит guard на каждую из этих навигаций,
а не только на SPA-route. Title `yandex-maps`, а не `yandex-parser`, потому что метит
именно Карты, не Диск/Почту (юзер выбрал описательность над мономорфным `-parser`-суффиксом).

**Persist через `chrome.storage.local.__sc_mcp_marked_tabs`** — map `{tabId: provider}`.
Переживает SW respin. При `chrome.tabs.onRemoved` — снимаем tabId.

**MutationObserver защищает от SPA-перезаписи.** Claude/AI Studio/Perplexity — SPA, и они
переписывают `<title>` + `<link rel="icon">` на каждый client-side route change. One-shot
injection не сохраняется. Гвард в MAIN-world слушает:

- `MutationObserver` на `document.head` (childList + subtree + attributes `href|rel`) — debounce
  200мс, при каждом mutation восстанавливает наш `<link data-sc-mcp-favicon="1">` если сайт
  его удалил.
- Отдельный `MutationObserver` на сам `<title>` (childList + characterData) — текстовая
  замена textContent не ловится через head-MO.
- Watcher на `head.childList` для случая когда Angular удаляет и пересоздаёт `<title>` —
  при `addedNodes` с `TITLE` пере-привязываем title-MO.

**Полный location.reload требует re-inject из SW.** MAIN-world скрипт умирает с страницей.
Слушаем `chrome.tabs.onUpdated`:

- `changeInfo.status === 'loading'` с URL — новый navigation, ставим `setTimeout(150мс)` и
  инжектим (даём 150мс на initial parse `head`).
- `changeInfo.status === 'complete'` — страховка если loading-инжект промазал.

Без `'loading'`-тригера на claude-research force-reload (каждые 90с после 5 минут) пометка
возвращается обратно к исходному `claude.ai` favicon на 1-2 секунды.

## web_accessible_resources обязателен

Для favicon на `chrome-extension://<id>/images/icon32.png`. Без записи в manifest Yandex
**молча** не загружает иконку (favicon показывается пустым документом-плейсхолдером).
Симптом: title подменяется, favicon — нет.

```json
"web_accessible_resources": [
  {
    "resources": ["images/icon16.png", "images/icon32.png", "images/icon48.png", "images/icon128.png"],
    "matches": ["https://*/*"]
  }
]
```

## MCP-badge на самой странице (info-плашка)

Дополнительно к favicon/title — info-плашка справа сверху: jobId, model, prompt-head (первые
160 символов). Цель — если юзер открыл вкладку руками во время работы, видно что под капотом
активный MCP-job.

Реализация вынесена в общий `research-badge.js` (`window.scResearchBadge.{show,hide}`) — единый
источник правды, подключается в manifest ПЕРЕД потребителем (как `aistudio-core.js` отдаёт
`window.scAistudio`). Рендерится на **всех трёх** research-провайдерах: AI Studio
(`aistudio-mcp.js`), Perplexity (`perplexity-research.js`), Claude (`claude-research.js`) — с
суффиксом провайдера в заголовке «MCP · <provider>». Раньше плашка жила локально в
`aistudio-mcp.js::showMcpBadge` и была только на AI Studio.

Свойства:
- `position: fixed; top: 60px; right: 16px; z-index: 2147483646; pointer-events: none` —
  не блокирует DOM Angular'а, сайт работает нормально.
- Удаляется в `runJob::finally{ hideMcpBadge() }` — при любом завершении (done/error).
- Render через `document.documentElement.appendChild` — выживает demount'ы Angular'а
  которые работают только с `<body>`.

Cross-ref: `fact-aistudio-mcp.md::Hidden-tab strategy` (общая архитектура MCP-job'а).

## Что пробовали и почему отброшено

- **Запомнить groupId существующей user-группы через `tabs.query`.** Yandex отдаёт `-1`
  для всех вкладок (см. таблицу выше). Probe из SW в реальном Yandex 26.4.0.2182
  подтвердил детерминированно — массив из 8 sample вкладок, у всех `groupId: -1`,
  включая ту что юзер вручную положил в группу.
- **Listener `tabs.onUpdated` с `changeInfo.groupId`.** В Yandex событие не emit'ится при
  перетаскивании юзером. Listener вообще не срабатывает.
- **Boot-scan вкладок при старте SW.** Если бы `tabs.query` возвращал нормальный groupId,
  можно было бы найти любую research-вкладку в группе и взять её groupId. Не работает по
  той же причине: все вкладки `groupId: -1`.
- **Popup-кнопка «Запомнить активную как MCP-группу»** — клик → `chrome.tabs.group({tabIds})`
  без groupId. По Chromium-спеке это создаёт **новую** группу с переносом вкладки из старой,
  а не возвращает groupId текущей. Реализовано → откатано до коммита.
- **DevTools SW + ручной `chrome.storage.local.set({__sc_mcp_group_id: <число>})`.** Юзер
  отказался от ручного ввода в DevTools каждый раз когда группа пересоздаётся.
- **Безымянная группа auto-create.** При первом MCP-job `chrome.tabs.group({tabIds})` создаёт
  безымянную группу, запоминается её id, последующие вкладки → туда. Yandex показывает её
  как цветной хвостик без имени; юзер должен один раз руками вписать «mcp». Отброшено —
  при удалении группы вручную всё начинается заново, накапливаются orphan-группы рядом.
- **Pattern D (inherit active group)** — `chrome.tabs.create({url, openerTabId})` без group-API
  и Yandex автоматически кладёт в активную группу. Работает (юзер подтвердил), но не подходит
  как «всегда в группу X»: открывает в **той** группе которую юзер сейчас раскрыл, не в
  конкретной.

## Связано

- `fact-aistudio-mcp.md::Hidden-tab strategy` — общая архитектура MCP-job'ов и их жизненный
  цикл в browser-extension.
- `fact-deep-research.md` — claude/perplexity research-вкладки, тот же markTabAsMcpVisually
  flow для них.
- `methodology/переносимый-дизайн.md::Параллельный канал сигнализации` — переносимый принцип для
  ситуаций «API платформы не даёт пометить — используй атрибут страницы».
- `methodology/переносимый-дизайн.md::Против SPA: MO + reapply` — переносимый принцип защиты кастомных
  атрибутов от SPA-перезаписи.
