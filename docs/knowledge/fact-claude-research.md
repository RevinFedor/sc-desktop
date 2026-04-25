# Knowledge: Claude-провайдер research (claude.ai) — модели, effort, thinking

Claude-специфика поверх общего канала `fact-deep-research.md` (тот же `/research-start` →
CS → `/research-state`, watcher, recovery). Изначально провайдер умел только Research mode
на модели аккаунта; теперь — полный выбор модели/уровня/thinking + режим обычного чата.
CS — `browser-extension/claude-research.js`.

## Параметры job'а

- **`options.model`** — `fable-5 / opus-4.8 / sonnet-4.6 / haiku-4.5 / opus-4.7 / opus-4.6 / opus-3`.
  **Отсутствие model = «не трогать селектор»** (back-compat: старые MCP-вызовы шлют только
  prompt и едут на модели аккаунта). Модель sticky per-account → если задана, verify на
  КАЖДОМ запуске (зеркало правила chatgpt, см. `fact-chatgpt-research.md::Параметры`).
- **`options.effort`** — `low/medium/high/extra/max`. Состав у каждой модели свой:
  `extra` есть у Fable 5 / Opus 4.8 / Opus 4.7, нет у Sonnet 4.6 / Opus 4.6; у Haiku 4.5 и
  Opus 3 Effort-подменю отсутствует целиком. Реестр — `CLAUDE_MODELS` в CS; DOM правее
  реестра (отсутствующее радио просто не найдётся, non-fatal).
- **`options.thinking`** — bool, тумблер `button[role="switch"]`. **Независим от effort**:
  «выбран Max, но Thinking выключен» — валидная комбинация самого меню claude.ai (юзер
  называл это «тугой переключатель»). Подпись зависит от модели: Thinking (Opus 4.8/4.7,
  Sonnet) / Extended (Opus 4.6, Haiku). У Haiku тумблер живёт **прямо в главном меню**
  (Effort-подменю нет); у остальных — внутри Effort-подменю. У Fable 5 и Opus 3 тумблера нет.
- **`options.research`** — default **true** (back-compat). `false` = обычный чат-вопрос
  конкретной модели: watcher пропускает 60-секундный NO_PANEL_GRACE (панели не будет по
  построению), и **periodic/force-reload выключен** — force-reload-5min, спасающий research
  от SPA-бага, убил бы легитимный длинный стрим (Opus Max+Thinking думает дольше 5 минут).
- **Opus 3 не поддерживает Research** (юзер проверил в живом UI — включение просто не
  работает). `research:true + model:'opus-3'` → ранний `status='error'` на configuring,
  не тихий запуск не-research-ответа.
- **Web search всегда включается** (юзер: «ситуации, когда захочу её отключить, я особо
  себя не представляю» — параметра нет, чекбокс в «+»-меню принудительно on, non-fatal).
  Research-чекбокс при `research:false` наоборот **выключается** если липко остался
  включённым с прошлого раза — иначе обычный вопрос внезапно запустит research.

Порядок конфигурации жёсткий: **модель → effort → thinking → «+»-меню**. Смена модели
может сбросить уровень и меняет состав подменю (шрам chatgpt, подтверждён здесь).
Verify-and-retry ×2 через `aria-checked` / aria-label триггера. **Провал выбора МОДЕЛИ —
фатальный** (`claude_model_select_failed`): юзер заказал конкретную модель, ответ чужой
(модель аккаунта) хуже ошибки — тот же контракт, что у submit-verify. Провал effort/
thinking — non-fatal (`claude.effort/thinking.set_failed`, едет на текущих настройках).

**Гидрация тулбара (шрам `rmqmvcidy`, 2026-06):** claude.ai гидрирует композер РАНЬШЕ
тулбара с `model-selector-dropdown` и пунктами «+»-меню (ждут account/models API). CS,
дождавшись только композера, лез в ещё-несуществующее меню → `model.select_failed
{label:""}` через 8мс (обе retry-попытки сгорали мгновенно), job молча уезжал на модели
аккаунта (Fable 5 вместо заказанного Opus 4.7); thinking и Research-пункт «не находились»
по той же причине. Фикс: перед `ensureModelSelected` ждём триггер с непустым aria-label
(до 20с) = тулбар реально догидрировался. Лог `claude.hydration.ok/timeout`.

## DOM-контракт меню (живая проба 2026-06)

- Триггер — `[data-testid="model-selector-dropdown"]`, его aria-label `Model: Opus 4.6 Medium`
  = текущая модель + подпись уровня. Это **источник verify** для выбора модели: клик по
  радио закрывает меню, перечитать `aria-checked` нельзя — ждём смену aria-label триггера.
- Верхние 4 модели — `menuitemradio` прямо в меню; Opus 4.7/4.6/3 — в подменю
  «More models» (открывается **hover'ом**, click — fallback; та же механика что
  pro-подменю chatgpt).
- Effort-радио — стабильные `[data-testid="effort-option-low|medium|high|extra|max"]`,
  подменю открывается hover'ом по `[data-testid="effort-menu-trigger"]`.
- Клик по **radio закрывает** меню, клик по **switch (Thinking) НЕ закрывает** — поэтому
  thinking верифицируется на месте, а модель/effort — переоткрытием.
- Research / Web search — `menuitemcheckbox` в «+»-меню (`Add files, connectors, and more`);
  чекбокс-клик меню не закрывает, оба пункта обрабатываются за одно открытие.

## Шрам: имя модели склеено с описанием — `\b` не существует

textContent радио верхних моделей = имя + описание **без пробела**: `Opus 4.8For complex
tasks`. Regex `/^Opus\s*4\.8\b/` НЕ матчится: между «8» и «F» нет word-boundary (оба
word-символы). Симптом: радио «не находится», хотя глазами оно в дампе есть. Матчить
anchored-prefix **без** `\b`: `/^Opus\s*4\.8/i`; для Opus 3 — negative lookahead
`/^Opus\s*3(?!\d|\.)/i`, иначе матчит и 4.7/4.6 ветку «Opus 3» не отличить от «Opus 4.x»
по префиксу. Родственник шрама «Confirm⏎» (`fact-deep-research.md::Confirm dialog`) —
текст элементов claude.ai не равен видимому тексту.

## Шрам: закрытые base-ui меню остаются в DOM

base-ui (UI-stack Anthropic) **не удаляет** закрытые меню из DOM — после пары открытий
в дереве лежат 4 `[role="menu"]` одновременно (живая проба). Любой
`querySelectorAll('[role="menuitemradio"]')` без фильтра видимости матчит **stale-узлы
прошлых открытий**: радио «нашлось», клик уходит в невидимый узел, ничего не происходит.
Все поиски пунктов — только через visible-фильтр: rect > 0 И `visibility/display/opacity`
И нет предка `[aria-hidden="true"]/[inert]/[hidden]`. rect-only недостаточно.

## Шрам: глиф-чекмарк ломает строгий матч пункта меню

У **включённого** `menuitemcheckbox` textContent содержит глиф-чекмарк шрифта Anthropicons
(PUA-символ, **невидим в логах**). Строгий `/^(Web search)$/` не матчился, а диагностика
выглядела парадоксально: item_missing с `present: ["Research", "Web search"]` — лог
печатает строку «Web search», но в ней есть невидимый хвост. Матчить после нормализации:
оставить только `\p{L}\p{N}` и пробелы (`norm()` в `ensurePlusMenuConfig`). Тот же класс
бага, что «Confirm⏎» — каждый строгий `===`/`$`-anchor по тексту claude.ai рано или поздно
ломается о декоративные символы.

## Лейблы в UI

`research-state.js::claudeModelLabel(options)` — единый формат для попапа, Истории и
страницы джобы: `opus-4.8 · max · Research` / `fable-5 · Chat` / `Research` (авто).
`· no-think` добавляется только при thinking:false (выключенное состояние информативно,
дефолт не показываем). Бейдж на вкладке — то же через `modelTitle`.

## Связано

- `fact-deep-research.md` — общий канал, scBridgeFetch (SW-fallback), submit-verify,
  tab-closed fallback, чеклист добавления провайдера
- `fact-chatgpt-research.md` — зеркальные правила (model sticky → verify, модель перед
  effort, verify-and-retry), первоисточник порядка конфигурации
- `fact-research-ui.md` — форма ручного запуска (таб Claude: Модель/Effort/Thinking/Research)
- `fact-claude-autoscrape.md` — другой потребитель меню claude.ai (autoscrape-вставка),
  свой независимый селекторный контракт
