# Knowledge: claude.ai как target автоскрапинга YouTube транскриптов

Параллельный flow с Gemini Studio (`fact-yt-extension-flow.md::Gemini Studio: автоскрапинг`):
клик на `+ ai` в YouTube → bridge принимает job → background-tracker
`openClaudeBackground` открывает `claude.ai/new#sc=<requestId>` в фоновой
вкладке → `claude-autoscrape.js` забирает payload из `chrome.storage.local`,
выбирает model/project/thinking, paste'ит транскрипт, нажимает submit.

Target выбирается в popup'е расширения (segmented switch Gemini ⟷ Claude).
Настройки обоих target'ов хранятся параллельно — переключение target'а не
теряет конфигурацию.

## Контракт payload'а в storage

Ключ: `__sc_claude_job_<requestId>`. Поля:
- `cachedFilePath` / `cachedCommentsFilePath` — для cache-hit'а (sync fetch).
- `jobId` / `commentsJobId` — для live polling'а через `/yt-status`.
- `model` (`Opus 4.7` / `Sonnet 4.6` / `Haiku 4.5`).
- `project` — имя проекта или `""` (пропустить шаг).
- `postProject` — пока заглушка (claude.ai не переключает project в
  существующем чате, в отличие от Gemini'и где можно поменять sys-prompt).
- `adaptiveThinking` (default true).
- `ytTabId/ytVideoId/ytTitle` — для финального toast'а на YouTube.

## Шаги autoscrape

1. **Получить транскрипт** — тот же путь что в aistudio (cachedFilePath
   синхронно через `/yt-fetch`, иначе polling `/yt-status`).
2. **`selectProject`** — если `job.project` непустой, открыть «+ menu»,
   найти trigger «Add to project», открыть submenu, кликнуть проект,
   дождаться chip-индикатора рядом с input'ом.
3. **`ensureModelAndThinking`** — кликнуть `[data-testid="model-selector-dropdown"]`,
   выбрать модель, переключить «Adaptive thinking» / «Extended thinking»
   toggle (имя зависит от модели, селектор по `input[type=checkbox][aria-label*=thinking i]`).
4. **`pastePromptAndSubmit`** — ProseMirror `[data-testid="chat-input"]`:
   `selectNodeContents` + `execCommand('delete')` + `execCommand('insertText', text)`
   + клик `button[aria-label*="Send"]`. Fallback Cmd+Enter.

## DOM-особенности claude.ai (2026-05)

Самое контринтуитивное место — submenu trigger и обход project items.

### Submenu trigger открывается на CLICK, не hover

В base-ui v2 (которую claude.ai использует сейчас) `Add to project` —
обычный clickable menuitem, который **сам открывает submenu при клике**.
Это противоречит классическому Radix Menu, где submenu trigger открывается
по `pointerenter`/`pointermove` с intent-delay.

Поэтому `openSubmenu(trigger)` делает `trigger.focus() + trigger.click()`.
Hover-events (даже trusted real-mouse) submenu НЕ открывают в текущей
версии — подтверждено детерминированно через MCP browser.

**Атрибут `aria-haspopup="menu"` пропал из new base-ui.** Раньше им можно
было фильтровать menuitems на submenu-triggers. Сейчас детект только по
`textContent.startsWith('Add to project')`. Если в будущей версии вернут
aria — детект через `aria-haspopup` сработает первым (более точный).

### Project items в submenu НЕ имеют `role="menuitem"`

`document.querySelectorAll('div[role="menuitem"]')` находит **только**
items в первичном `+ menu` (Add files, Take a screenshot, Add to project, ...).
Project items в развёрнутом submenu — обычные `<div>`'ы без role-атрибута.
Обход: найти **последний** `.z-dropdown.rounded-xl` контейнер на странице
(submenu открывается во втором popover после основного меню) и взять его
прямые потомки.

Project menuitem содержит **две строки**: имя проекта + имя владельца
(например, «пересказ ютуб\nFedor Revin»). `textContent` склеит их без
\n через flex layout — для match'а используем `lowercase + includes`,
исключая «Start a new project».

### Click по project НЕ меняет URL — добавляет chip

Это самое неинтуитивное. После `opt.click()` claude.ai остаётся на
`/new` (URL не меняется), но рядом с input'ом появляется **chip-индикатор**
проекта — `button[aria-label="Project: <имя>"]` с tooltip `<имя>` и
кнопкой `×` для удаления. **Без chip'а** последующий submit отправит
сообщение в обычный чат, не в проект.

Поэтому после click обязательно ждать appearance этого chip'а:
`waitFor(() => document.querySelector('button[aria-label="Project: <wanted>"]'))`.
Если за 5 сек chip не появился — не fatal, но log warning'ом, paste+submit
всё равно идут (юзер увидит результат и сможет повторить).

## Что пробовали и почему не сработало

- **`dispatchEvent(pointerenter)` / `mouseenter` на submenu trigger.**
  Не открывает submenu в base-ui v2 (см. выше). Радикс v1 раньше реагировал,
  но текущая версия claude.ai — другой component. Подтверждено через
  MCP browser hover (synthetic pointermove) и через `pointerenter` диспатч
  из content-script — оба без эффекта.
- **`keydown ArrowRight` после focus на trigger.** Промежуточная гипотеза —
  Radix submenu обычно открывается через ArrowRight в keyboard-режиме.
  В текущей base-ui не сработал, но оставлен fallback в коде на случай
  ещё одного редизайна.
- **Поиск project через `querySelectorAll('[role="menuitem"]')`.**
  Возвращал только первичный + menu items, project'ы (обычные div'ы)
  отсутствовали. Перешли на обход прямых потомков последнего `.z-dropdown`.
- **Detection активации project'а по URL `/project/<id>`.** Claude.ai
  остаётся на `/new` — chip живёт inline. Перешли на chip-detection через
  `button[aria-label="Project: ..."]`.
- **`aria-haspopup="menu"` для submenu trigger.** Был в Radix v1, ушёл
  из base-ui v2. Детект только по textContent.

## UI-параллели с Gemini Studio

| Шаг | Gemini Studio (`aistudio-autoscrape.js`) | Claude (`claude-autoscrape.js`) |
|---|---|---|
| Open target | `aistudio.google.com/prompts/new_chat#sc=<id>` | `claude.ai/new#sc=<id>` |
| Model select | `button.model-selector-card` → click → mat-option по `textContent` | `[data-testid="model-selector-dropdown"]` → click → div с `textContent.startsWith(model)` |
| Sys-context | System instructions panel + mat-select preset | Project (через submenu trigger) |
| Sys-context reset after Run | `+ Create new instruction` (пустая) | Невозможно — project зафиксирован в чате при submit |
| Editor | `<textarea placeholder="Start typing a prompt">` (нативный) | `[data-testid="chat-input"]` (contenteditable ProseMirror) |
| Submit | `button{textContent: "Run + keyboard_return"}` | `button[aria-label*="Send"]` |
| Submit fallback | Ctrl/Cmd+Enter dispatch в textarea | Ctrl/Cmd+Enter dispatch в editor |
| Stage UI | overlay сверху (32px pill) + global toast stack | overlay сверху + global toast stack (тот же стиль через `methodology/переносимый-дизайн.md::Единая форма для уведомлений`) |

## Diag в DOM

`claude-autoscrape.js` мирорит свой `log()` в скрытый `<pre id="sc-claude-dbg-log">`
(аналог `#sc-yt-dbg-log` в content-script YouTube). Читается через
`mcp__browser__get_text` без `userScripts` toggle. Ключевые tag'и:
`boot`, `selectProject.menuitems`, `selectProject.found_trigger`,
`selectProject.after_openSubmenu`, `selectProject.option_search`,
`selectProject.clicking_option`, `selectProject.chip_appeared`,
`selectProject.chip_not_detected`.

## 🔗 Связано

- `fact-yt-extension-flow.md` — общий flow YouTube + autoscrape (Gemini-вариант
  и target switcher).
- `fact-yt-extension-bridge.md` — endpoints `/yt-status`, `/yt-fetch`,
  PNA-headers для loopback, hot-reload.
- `fact-browser-mcp.md::Synthetic hover vs Radix submenu` — почему MCP
  browser hover не открывал submenu на этапе диагностики.
- `methodology/переносимый-дизайн.md::Placeholder ≠ значение поля` — родственный UX-урок
  из живой сессии (юзер видел placeholder в popup'е и не вводил project).
