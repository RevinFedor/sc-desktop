# Knowledge: Navigation & Headers

Глобальный Breadcrumbs над центральной колонкой, screens без своих top-bar'ов, persistent paste draft, danger zone внизу body.

## 🍞 Breadcrumbs как persistent header

`src/components/Breadcrumbs.jsx` смонтирован в `App.jsx` между TitleBar и центральной колонкой как 40px-полоса. Всегда видна (кроме home), читает stack из store: `Home › crumb1 › current`.

Каждый кроме последнего — кликабелен → `navigateTo(index)`. Последний — белый/жирный, не кликабелен (это где ты сейчас).

### `navigateTo(index)` контракт

```
-1                       → goHome (clears history, switches to paste)
[0..history.length-1]    → make history[index] current, trim everything after
i ≥ history.length       → no-op (уже на этом месте или дальше)
```

Не путать с `popScreen()` — тот идёт строго на один шаг назад. `navigateTo` — прыжок в произвольную точку.

### Skip-paste-as-first

Первый элемент history почти всегда `paste` (юзер начал с главной). Home уже представляет paste. Чтобы не было `Home › New paste › X` — Breadcrumbs скрывает paste-как-первый-элемент. Индексы для `navigateTo` остаются канонические в `store.history` (через offset `histIdx = i + skipFirst`).

---

## 🪜 Канонический trail: иерархия сущности, не история кликов

`pushScreen()` для большинства экранов **строит history заново** через `canonicalTrail(name, payload)` в `src/lib/store.js` — trail выводится из того, *что экран показывает*, а не из того, *как юзер сюда пришёл*:

```
source-detail → Главная › [Telegram] › чат      (платформенный уровень
                                                  существует только у TG)
job-detail    → Главная › [Telegram] › чат › job (источник резолвится
                 через sourceForJob: source_id, для tg_* fallback по handle;
                 sourceless one-shot — Главная › job, YouTube-paste идёт
                 прямо с главной)
telegram / settings / configs / research → Главная › X
```

Экраны **не из списка** (`notes`, `tg-settings`) стекаются по-старому поверх текущего — «уход вглубь» (`Главная › Telegram › Сессии`). Same-type replace для них остаётся: повторный push того же типа заменяет screen, не растит history.

`sourceForJob(job)` зеркалит matching ActivityPanel — без него job, открытый из Activity, не знал бы свой родительский канал. Папочные jobs (`tg_folder_*`) без единого source получают уровень `Главная › Telegram`.

**Что отбросили (две итерации):**
1. **Flat-история** (всё стекается) — `Home › Сессии › @ch1 › @ch2 › Notes` — навигация назад невозможна.
2. **LEVEL1/LEVEL2-модель** (level-1 сбрасывает до `[Home]`, level-2 пушится поверх) — лечила хвосты, но trail всё равно копил мусор пути: клик по TG-job'у из Activity при открытом research-экране давал `Home › AI Studio Job › Telegram fetch` — иерархию, которой в данных не существует. Юзер: *«как у меня может быть job Телеграма идти после AI Studio Job? Сначала home, потом канал, если он есть, и только потом job»*. Канонический trail убирает класс целиком: стек больше не зависит от точки клика (Activity / сайдбар / попап / страница) — любой путь к чату даёт `Главная › Telegram › чат`.

Переносимый принцип — `methodology/переносимый-дизайн.md::Хлебные крошки`.

---

## 📚 Library: платформа, прокрутка и возврат

Панель платформ над Library — не заголовок, а постоянная навигация с двумя
разными действиями. Основная зона открывает страницу платформы; маленькая
стрелка только переносит Library к заголовку её группы. Прокрутка должна быть
мгновенной: стрелка отвечает на вопрос «где этот список», а не запускает
отдельную наблюдаемую операцию.

Фоновое выделение такой платформы означает, что в viewport видна **любая часть
её списка**, а не только его заголовок и не текущий экран в центральной колонке.
Длинный Telegram остаётся выделенным, пока видны его элементы после ушедшего
за край заголовка; на границе Telegram и YouTube допустимы два выделения
одновременно. Стрелка рассчитывается отдельно: если заголовок уже вне экрана,
она остаётся действием прокрутки даже при видимом содержимом группы.

Платформа, заголовок группы и строка source используют один контракт повторного
клика: первый открывает назначение и запоминает точное место, второй возвращает
туда. Все вкладки Settings считаются одной поверхностью: переход между ними не
перезаписывает это место, а повторный клик на глобальную шестерёнку закрывает
Settings обратно к исходной странице. Крошки для них всегда
`Главная › Настройки › <платформа>`; Telegram-сессии больше не являются
отдельным уровнем `Telegram · сессии`.

Это не сохраняется после перезапуска приложения: «вернуться» без живого
предыдущего контекста означало бы угадать и могло бы привести не туда.

Переносимые правила — `methodology/переносимый-дизайн.md::Видимость навигации определяется содержимым`, `::Разные намерения — разные зоны действия` и `::Повторный клик возвращает контекст`.

---

## 🎚 Activity-overlay: close-on-document-click, не capture-on-parent

ActivityPanel — **absolute-aside поверх контента**, не третья колонка грида. Открывается из
правой history-зоны split-кнопки «Запросы» в TitleBar; основная зона этой же кнопки открывает
`RequestsRunningPopover` только с активными jobs. Sidepanel закрывается при клике в любое место
кроме самой панели.

**Реализация:** `document.mousedown` listener в `App.jsx` пока `activityOpen=true`. Если `e.target` не внутри `panelRef` и не внутри `toggleRef` (вся split-кнопка «Запросы» в TitleBar) — `closeActivity()`.

**Что отбросили:** `onMouseDownCapture` на родителе грида + `stopPropagation` на самой `<aside>`. Не сработало потому что capture-фаза идёт **сверху вниз** — родительский handler срабатывает **до** того, как событие достигнет панели. `stopPropagation` на aside в этой фазе уже бесполезен, состояние закрылось, click до кнопки внутри панели не дошёл, навигация не сработала.

**Auto-close на job-row click:** `RequestJobRow` вызывает `onClose` сразу после
`pushScreen('job-detail', ...)` — в Activity это `closeActivity()`, в active-popover это
закрытие popover'а. Клик на job должен унести юзера на JobDetail и сразу убрать поверхность,
из которой он кликнул, иначе она остаётся накрывать новый screen.

**Universal click contract — never per-type detours.** Любая job-row в Activity открывает **JobDetail**, без исключений. Был соблазн увести `tg_folder_fetch` / `tg_folder_refresh` сразу на TelegramScreen («там же всё равно те же данные»), но это нарушает паттерн: юзер ожидает что *клик из Activity всегда показывает «постмортем» одной операции*, а не «текущее состояние страницы». Клик на yt_batch не уводит на SourceDetail; клик на ig_profile_fetch не уводит на InstagramConfig. Так и папочные jobs идут в JobDetail. Если для типа нужен особый body — добавь `XxxBody` в `JobDetail.jsx`. См. `TelegramFolderFetchBody` / `TelegramFolderRefreshBody` как референс.

---

## 🚫 Headers внутри body, не top-bar

Раньше каждый screen рендерил свой `← Back + лого + title + delete` бар сверху. Дублировал navigation (breadcrumbs показывали то же самое) + забирал 56px высоты + header'ы расходились визуально между screens.

**Сейчас:** screens начинаются сразу с body, identity-row внутри body — обычный flex с лого+названием. Никаких `← Back` (есть Breadcrumbs).

**Antipattern:** добавить новый screen и сразу написать `<div class="border-b ...">← Back</div>`. Не нужно. Используй inline identity-row в начале body или вообще ничего (Breadcrumbs покажет название из `crumbFor` resolver).

---

## 🗑 Danger zone в самом низу body

Деструктивные действия (Delete source, Delete job) переехали из top-bar в **последний блок** body со стилем «Опасная зона»:

```
... весь основной контент ...
─────────────────────────  (border-t border-zinc-900, mt-12 pt-6)
ОПАСНАЯ ЗОНА
[🗑 Удалить источник]
Текст-предупреждение что именно сносится.
```

**Зачем внизу:** в top-bar кнопка Delete была визуально близко к back-arrow и primary-actions. Easy click-by-mistake. Внизу — отдельная зона, требует доскроллить, явно отделена.

**Antipattern:** «А давай в top-bar оставим, там ml-auto же — справа стоит». Принцип: deletion это first-class action (см. `methodology/переносимый-дизайн.md::Deletion`), а не side-menu item. Должна быть видна, но требовать сознательного жеста.

---

## 💾 Paste draft persists через store

PasteScreen `value` + `committed` хранятся **и** в локальном useState (для скорости рендера), **и** в `store.paste`. Возврат с source-detail или job-detail на Home → useState инициализируется из store через `useState(persistedValue)`. Юзер видит то же самое что вводил.

```js
state = {
  ...
  paste: { value: '', committed: null },  // { platform, kind } | null
}
```

**Очистка только:**
- Явный `clearInput()` (× в input)
- Ручной ввод нового текста (через `onInputChange` — `setPasteState({value: v})` + `setCommitted(null)`)

**Не очищается:**
- При `pushScreen`/`popScreen`/`navigateTo` (оставляет draft)
- При `recents` click (`restoreFromRecent` — целиком восстанавливает {value, platform, kind})

### Tradeoff с `useState`-only

Альтернатива — держать всё только в store. Отбросили: лишний rerender всего PasteScreen на каждый keystroke (Zustand-style selector subscriptions нужно строить). Hybrid local+store — keystroke остаётся локальным (быстрый), флаш в store при каждом set (дешёво).

---

## 📜 Inline expand vs new screen

Для длинных списков (история парсинга в SourceDetail) — **inline-expand toggle** вместо отдельной страницы для деталей.

**Когда inline:**
- Все данные уже в БД, нет live-state (батч завершился час назад)
- Деталей мало (10-20 строк)
- Часть workflow «глянуть и пойти дальше» — push отдельной страницы перебивает контекст

**Когда отдельный screen:**
- Live job — нужен подписчик на updates (JobDetail для running)
- Много деталей (200+ строк) — отдельный экран читабельнее
- Юзер регулярно возвращается — даём ему breadcrumb-trail

В SourceDetail-истории batch-jobs раскрываются inline (`▾`/`▴` toggle), TG fetch jobs продолжают открывать full JobDetail (там items_total, type_breakdown, и live-progress если ещё бежит).

---

## 🎯 `crumbFor(screen, sources)` — динамические лейблы

Resolver в `Breadcrumbs.jsx` маппит `screen.name` → `{label, icon}`. Для `source-detail` — тянет live-name из `useSources()` хука (если source ребрендили — crumb обновится). Для `job-detail` — **тип job'а + `#N`** (`Telegram fetch · #604`, `YouTube канал · #18`, …) через TYPE_LABEL-таблицу, **не** `entity_title`. Корневая крошка — «Главная» (не «Home», см. `переносимый-дизайн.md::UI на языке пользователя`); `aistudio-job` даёт крошку «Research» — провайдер уже в заголовке самой страницы.

**Зачем не entity_title.** В типичной траектории `Home › @durov › <job>` родительский source-detail crumb уже показывает entity. Дублировать `Telegram fetch` крамбом бы превращал в `Home › @durov › @durov` — визуальный дубликат. Тип job'а наоборот описывает **что за операция** была произведена: re-fetch, preview, index, comments-catch-up. `#N` — это `payload.jobId` (DB-row id когда есть, in-memory id иначе — см. `fact-jobs.md::Dual-id space`).

**Folder-jobs — исключение.** Для `tg_folder_fetch`/`tg_folder_refresh` крамб использует `Папка · <title>` или `Обновление папок` — у них родительский экран TelegramScreen, не source-detail, дубликата нет. Fallback на `entity_title` остаётся для unknown типов.

**Антипаттерн:** хардкодить label в `pushScreen('source-detail', {label: '@x', sourceId})`. Лейбл должен быть **производной** от текущего state, не от момента push'а.

---

## 🛡 Inline forms все живут под Detection

См. `fact-architecture.md::Inline forms vs full sub-screens` — это правило не изменилось. Новые формы (YouTubeChannelForm, YouTubeSingleForm) тоже **inline под Detection в PasteScreen**, не отдельный screen. Pattern проверен временем.

Когда **screen всё-таки нужен** (TelegramSettings, NotesScreen) — он не имеет своего top-bar'а, начинается с body как описано выше. Identity-row + body content + (опционально) danger zone в конце.
