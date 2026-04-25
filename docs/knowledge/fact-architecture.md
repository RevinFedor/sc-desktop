# Knowledge: UI Architecture

## 🏛 Three-pane persistent chrome
Окно поделено на три зоны, **двое из них никогда не уходят** при навигации:

```
┌───────── Title bar (40px, drag) ─────────┐
├─────────┬─────────────────────┬──────────┤
│ Library │  CENTER             │ Activity │
│ (240px) │  (swappable)        │  (300px) │
│ persist │                     │ persist  │
├─────────┴─────────────────────┴──────────┤
│ Footer (28px, library stats)             │
└──────────────────────────────────────────┘
```

**Инвариант:** `LibrarySidebar` и `ActivityPanel` всегда смонтированы. Только центральная колонка меняется в зависимости от `screen.name` в zustand-like store. Это даёт пользователю ощущение «я всегда вижу что у меня есть и что прямо сейчас работает» — клик в источник или джоб не вырывает из контекста.

**Важно при добавлении новых экранов:** новый screen — это **компонент центральной колонки**, не оверлей и не модал. PasteScreen, TelegramConfig, JobDetail, SettingsScreen — все подчиняются той же сетке. Добавляя новый screen, **никогда не используй `fixed`/`absolute` для контента** — он должен жить внутри `min-h-0 overflow-hidden` обёртки в App.jsx.

### LibrarySidebar — группировка и стабильная ширина

Колонка фиксирована `grid-cols-[240px_1fr]`. Внутри:
- **По платформам** (Telegram → YouTube → Instagram → Reddit → остальное).
- **Внутри платформы**: сначала каналы с `is_explicit=1`, затем
  свёрнутая подгруппа `▸ Прочее (N)` для `is_explicit=0` (single-paste'ы
  из browser-extension'а). Состояние свёрнутости в `localStorage` (ключ
  `sc-other-collapsed`) — переживает перезапуск. См.
  `fact-database.md::sources.is_explicit`.

**Gotcha: ширина «прыгала» при разворачивании Прочее.**
- Симптом: юзер раскрывает «Прочее (10)», список становится длиннее
  чем viewport, появляется вертикальный скролл, контент на ~15px
  сдвигается влево, длинные имена начинают обрезаться по-другому.
- Причина: `<aside>` `overflow-y-auto` без зарезервированного места
  под скролл. Плюс `truncate` в SourceRow без `min-w-0` на flex-цепочке
  раздвигал grid-cell на длинные имена ещё хуже.
- Фикс: `style={{ scrollbarGutter: 'stable' }}` на скролл-контейнере
  (резервирует место под скроллбар всегда, контент не сдвигается).
  Плюс `min-w-0` на `<aside>`, scroll-wrapper, header'ах групп, кнопках
  «Прочее» и SourceRow + явный `flex-1`/`shrink-0` на детях. Длинные
  имена теперь обрезаются truncate'ом, а не распирают колонку.
- Иконки `▸/▾/⚙/↻/+` заменены на `lucide-react` (ChevronRight,
  ChevronDown, Settings, RotateCw, Plus) — старые символы рендерились
  ~3-4px на ретине из-за font-size:11px, плохо читались.

## 🧭 Screen stack (in-memory)
`src/lib/store.js` — самописный store на `useSyncExternalStore`. Без zustand, без redux: одной задачи (push/pop/recents/screen) достаточно.

```
state = {
  screen:  { name, payload },
  history: [{ name, payload }, ...],
  recents: [{ id, label, kind, platform, addedAt }, ...],
  paste:   { value: '', committed: { platform, kind } | null },
}
```

`pushScreen(name, payload)` кладёт текущий screen в history, переключается на новый. `popScreen()` достаёт из history. `goHome()` чистит весь стек. `navigateTo(index)` — прыжок в произвольную точку history (см. `fact-navigation.md::navigateTo контракт`).

**`paste` поле** живёт здесь чтобы draft пережил уход на source-detail/job-detail и возврат. Подробнее — `fact-navigation.md::Paste draft persists`.

**Зачем не использовать react-router:** URL-роутинг даёт нулевую пользу в desktop-приложении (нет deep-links снаружи), но навешивает baseline complexity (Outlet, link components, history API). История переходов хранится прямо в стейте, push/pop тривиально.

### Per-platform screens (когда нужен отдельный экран платформы)

Не каждая платформа имеет свой *screen* на уровне `pushScreen('<platform>')`. Решение зависит от того есть ли у платформы операции **поверх отдельных source'ов** (multi-source batch, фильтры, agg-сводки).

- **Telegram → `telegram` screen** есть. Юзер работает с папками (group-of-chats), запускает batch-fetch и copy на множество чатов разом. Это операция, для которой нет места ни на Home, ни на SourceDetail. См. `fact-telegram-folders.md`.
- **Instagram / YouTube / TikTok / Reddit** — пока нет своих screens. Клик в sidebar по заголовку Instagram уводит на `ig-settings` (per-account настройки), на YouTube/Reddit вообще нет header-screen — клик никуда не ведёт. Нет multi-source workflow → нет нужды в screen.

**Когда добавлять `<platform>` screen:** появилась операция которую логично делать сразу над несколькими source'ами (batch-transcribe всех IG-профилей, multi-channel YT poll). До этого хранить функционал внутри SourceDetail каждого отдельного source'а.

## 🎯 Paste-screen — это режим, а не отдельный layout
Стартовый экран (`paste`) — это **просто компонент центральной колонки**, такой же как `tg-config` или `settings`. Layout вокруг (Library/Activity/Footer) одинаковый. Когда юзер вводит URL и жмёт Continue — `pushScreen('tg-config', detection)` — меняется только центр.

**Anti-pattern которого избегаем:** «hero»-экран на весь viewport с paste-полем по центру и при первом источнике переход на «main app». Это сделало бы две разные раскладки UI — лишняя ментальная нагрузка.

## 🔍 Detection → chooser logic
Когда юзер вводит **URL**, `detect()` (см. `src/lib/detect.js`) однозначно определяет платформу.

Когда юзер вводит **`@username`** или просто слово — платформа неоднозначна. В строке Detection появляются **4 chip-кнопки** (logos) справа от текста-подсказки. Enter жмёт первую (Telegram, как самый частый случай).

**Почему Telegram дефолтным:** в моём workflow это самый частый вход. Если ситуация изменится — поменять одной строкой в `PasteScreen.jsx::onKey`.

### YouTube kind-chips: video vs channel

URL платформа определяется однозначно, но для YouTube **этого мало** — `youtube.com/watch?v=...` это видео, а `youtube.com/@channel` это канал, и flow совершенно разные (single-transcript vs channel-fetch). Поэтому для YouTube auto-commit отключён и в Detection-row показываются **kind-chip'ы**:

- `/watch`, `/shorts`, `youtu.be` — split-chip `[видео | + comm]` (default Enter = транскрипт; правая половина «+ comm» добавляет параллельный yt_comments-fetch с дефолтами `sort=new, limit=500, replies=off`) + соседний chip `[канал]` (резолвит owner-канал через `yt-dlp --dump-json`).
- `/@x`, `/c/x`, `/channel/UC...`, `/user/x` — один чип `[канал]`.
- bare `@username` после клика YouTube из 4-platform-chip — один чип `[канал]` (single video не указать без полного URL).

Telegram single-message URL (`t.me/<chan>/<id>`, `t.me/c/<id>/<msg>`) — split-chip `[сообщение | + comm]`. Левая половина — обычный single-message fetch, правая добавляет comments side-fetch (см. `fact-telegram-comments.md::Single-message side-fetch`).

Split-chip как UI-паттерн (default + additive variant в одной обёртке) — `methodology/переносимый-дизайн.md::Split-control`.

Клик чипа = немедленный коммит и старт fetch (без отдельного Enter). Telegram URLs продолжают auto-commit'иться без чипа **только** для chat-handle'ов (`t.me/<chan>` без msg_id) — там нет ambiguity. Single-message и topic-message ждут явный клик — иначе input очищается мгновенно после paste и юзер не успевает abort'нуть.

### Detection-строка — фиксированная высота
`<Detection>` всегда `h-12 mt-3` независимо от состояния. Пустой ввод → invisible spacer той же высоты. Распознанный ввод → chip-row справа (`ml-auto`); описательной подписи слева нет — chip самоописательный (см. `methodology/переносимый-дизайн.md::Кнопка показывает что произойдёт` параграф «Chip без описательного hint'а»). Catch-all hint (*«не похоже на ссылку или username»*) появляется **только** когда классификатор не сработал и chip'а нет — единственный сигнал что мы вообще пытались. **Контент под Detection (Continue, форма, Recent) никогда не двигается** — это критично для UX, иначе chip'ы выглядят как «прыжки» layout'а.

### Committed state machine

Внутри PasteScreen есть три состояния, и `committed` хранит **и платформу, и kind**:

```
┌──────────────────────────────────────────────┐
│ value="" → empty                              │  Detection пустая, форма не показана
└──────────────────────────────────────────────┘
              │ паста / ввод
              ▼
┌──────────────────────────────────────────────┐
│ value="@user" + committed=null                │  Detection показывает chip-row,
│ → ждём явный chip click                       │  форма скрыта
└──────────────────────────────────────────────┘
              │ клик chip
              ▼
┌──────────────────────────────────────────────┐
│ committed = {platform: 'telegram', kind: ...} │  Detection показывает Logo + Telegram,
│ → inline-форма раскрывается под Detection     │  форма раскрывается inline
└──────────────────────────────────────────────┘
```

**Auto-commit правило:** Telegram URLs коммитятся через `useEffect` без явного клика (там нет ambiguity). YouTube требует **явного chip-click даже для URL** — потому что для YouTube kind=video и kind=channel ведут к радикально разному flow (см. `### YouTube kind-chips`). 

`useEffect` не перезатирает уже установленный committed (`prev` check) — иначе восстановление через `restoreFromRecent` сразу затиралось бы auto-commit'ом.

**Зачем committed как объект `{platform, kind}` отдельно от detection:** detection пересчитывается на каждый рендер, а committed — это **намерение пользователя**. Для YouTube detection.kind может быть `video`, но юзер кликнул `[канал]` — kind должен сохраниться отдельно от detection.

Persistence committed между screens — см. `fact-navigation.md::Paste draft persists`.

## 🧩 Inline forms vs full sub-screens
Форма конфигурации платформы (`TelegramConfigForm`) — **headless-компонент** без header'а/footer'а/кнопки Back. Используется в двух местах:

- **Inline в PasteScreen** — раскрывается под Detection-строкой при committed-платформе. Юзер не уходит со startscreen'а, layout chrome (sidebar/activity/footer) остаётся.
- **Внутри full-screen TelegramConfig** — обёрнут в screen-обёртку с header/Back для случая «Custom fetch» из SourceDetail (когда у юзера уже есть source и он жмёт «настроить запрос»).

**Почему два места:** inline-форма быстрее (юзер сразу видит что вводит → что получит), full-screen вариант нужен когда контекст другой («я пришёл из источника, хочу детальный re-parse»). Один и тот же компонент — никакого дублирования логики.

**Антипаттерн:** копировать TelegramConfigForm в две разные стены контейнера. Если нужен другой набор полей для inline vs full — добавлять prop, не fork'ать.

### `forceForm` prop как способ переиспользовать форму с разным default-поведением

`InstagramConfigForm` живёт **в двух местах**:
- В paste-flow на Home — на mount делает `igLookupProfile(handle)`, и если профиль уже спарсен → автоматически переключается на header + picker (стадия `ready`). Юзер не делает повторный fetch если кеш есть.
- В SourceDetail's «Новый запрос…» панели — там source уже отрендерен **сверху** action-row (identity-row с лого + handle), и `<InstagramBatchPicker>` тоже уже есть. Если форма автоматически переключится на header+picker → дубль того что уже видно.

Решение — prop `forceForm`. На SourceDetail передаём `<InstagramConfigForm forceForm />`, форма пропускает auto-lookup и сразу показывает kickoff-form. Один компонент, два контекста, разница в **одном булевом флаге**, не в коде логики. См. `fact-instagram.md::forceForm prop`.

Pattern переносимый: если headless-форма должна уметь оба поведения (auto-skip-on-cached vs always-show-form) — добавить `forceForm`-style prop, не делать второй компонент.

## 🗄 Где хранится state
| State | Место | Lifetime |
|-------|-------|----------|
| Текущий screen, history | in-memory store | до перезапуска окна |
| Recents (последние pasted) | in-memory store | до перезапуска (ещё не персистится) |
| Активные jobs + lifecycle | Electron main `jobs Map` + `job:update` события | до перезапуска main |
| Renderer cache invalidation | dataBus + `useInvalidator(key)` (см. `fact-data-bus.md`) | пер-сессия |
| Завершённые job results | `~/Library/Application Support/sc-desktop/jobs/<id>.json` | навсегда |
| Settings | `~/.config/sc/settings.json` (общий с CLI) | навсегда |
| Sources/items DB | `~/Library/Application Support/sc-desktop/library.db` (через better-sqlite3, см. `fact-database.md`) | навсегда |
| Jobs history (БД-копия) | `library.db::jobs` table | навсегда |
| Coverage tracking | `library.db::source_coverage` (depth metadata→media→transcribed) | навсегда |

**Cross-app contract:** settings.json намеренно **разделяется** с CLI `sc` — изменение через `sc -i settings` или через UI Settings screen видно обеим сторонам. Не дублировать в SQLite.

## 🎨 Platform logos vs colored dots
`src/components/PlatformLogo.jsx` — inline SVG лого 4 платформ. Заменили цветные точки потому что Instagram и YouTube оба красные (`#E4405F` vs `#FF0000`) и в маленьком размере неотличимы.

Размер указывается явно (`<PlatformLogo platform="telegram" size={14} />`), без `currentColor`-прав — лого должны быть в брендовых цветах независимо от theme.

## 👥 Senders block — collapsed by default

Список отправителей на странице Telegram-чата по умолчанию **свёрнут** (видна
только строка-заголовок `ОТПРАВИТЕЛИ · 23 ▾`). Раскрывается по клику.
Раньше показывался полным списком всегда — занимал ~280px вертикали ради
данных, которые юзеру нужны раз в десять заходов.

**Что внутри expanded-state:**
- Поиск по имени отправителя — фильтрует список на лету.
- Master-чекбокс «выбрать все» с indeterminate, работает **на видимом
  отфильтрованном** подмножестве, не на полном списке.
- Per-row `<Checkbox>` со счётчиком сообщений справа.

**«Выбрать все» считает только видимое — потому что иначе break'ает
mental model поиска.** Юзер пишет в search «Alex» → видит трёх Alex'ов →
хочет «выделить всех найденных». Если master select добавляет в Set ВСЕХ
500 отправителей — это сюрприз и недоверие к кнопке. Видимое подмножество
делает поведение читаемым «то что я вижу = то что я выделю».

**`keyOf(sender)` для null.** Sender может быть NULL (старые items, system-
сообщения). Если бы Set хранил `null` напрямую — все unknown коллапсили
бы в одну запись и галка отметила бы их разом. `keyOf(r) = r.sender ??
'__unknown__'` даёт стабильный distinct key, без коллизий с реальным
отправителем по имени `null`.

**Selection — пока local state**, никуда не передаётся. Это задел: будущий
фильтр-by-sender в ChatView (читать `selected: Set<string>` через prop)
работает без переписывания SendersBlock. Сделано так потому что
функциональность фильтрации полезна, но добавление её **сейчас** удваивало
бы surface правок (ещё один параметр в IPC `items:list`, ещё одно
измерение в invalidation key).

См. `src/components/SendersBlock.jsx`.
