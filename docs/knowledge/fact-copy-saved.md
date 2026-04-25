# Knowledge: Copy Saved (assemble panel)

`<CopySavedPanel>` — собирает срез сохранённых items Telegram-источника в
text-блок для clipboard или `.txt`-файла, с фильтром по range × content
types × topic × direction. Раньше панель жила inline под графом
«Распределение по типам», сейчас — controlled-панель раскрывается по
кнопке `📋 Скопировать · N` в action-row (см. `fact-source-actions.md::
кнопка action-row`). Опционально может работать и uncontrolled (если
`open` prop не передан — рендерит свою header-кнопку с `▾`).

Telegram-only, потому что у YT/IG batch-jobs уже есть Combined-файл через
свой job-lifecycle (см. `fact-jobs.md::Auto-combined.txt`).

## 🧬 Shared form-fields с fetch-формой

Range / Types / Topic / Comments — общие с «Новый запрос…» через
`<TelegramScopeFields use="copy">` (см. `fact-source-actions.md::
Shared scope-fields`). Wrapper владеет:
- live estimate (debounced 200ms, IPC `itemsAssembleEstimate`)
- buttons `[💾 .txt] [📋 Скопировать]`
- toast в кнопке `Скопировать` (~2.4s)
- `commentsCount` prop → передаётся в scope-fields для disabling
  «с комментариями» когда под постами ничего не сохранено

## 🔄 Direction (с конца / с начала)

В `last_n` режиме — icon-only toggle с lucide `ArrowLeftRight`,
позиционирован **между** range select и input N: `[Последние N ▾] [↔] [500]`
читается как один composite control. State видится только через background
(active=white = «с начала») и tooltip — текстовый label на самой кнопке
конкурировал бы с цифрой N справа.

- `newest` (default): N свежих от хвоста чата (legacy поведение)
- `oldest`: N старых от начала чата

`aria-pressed` отражает active-state, tooltip объясняет current state +
что сделает клик («Сейчас: с конца. Клик → переключить на «с начала»»).

`scope.direction` приезжает в `assemblyEstimate` и `assemblyFetch` —
обе крутят `ORDER BY published_at ${ASC|DESC} LIMIT N`. После выборки
всегда re-sort'им ASC чтобы blob читался top-to-bottom хронологически.

`assemblyTranscriptPaths` тоже зеркалит direction — иначе byte-estimate
посчитал бы транскрипты не той половины чата, а копировался бы другой.

## 🗓 Period preset modes

Range select в copy содержит preset-modes (`last_day` / `last_week` /
`last_3days` / `last_2weeks` / `last_month` / `last_3months`) **отдельной
группой** между `all` и `last_n`. `last_week` стоит вторым (после `all`)
как самый частый «catch up за неделю» сценарий.

Внутри `buildScope`:
```
const days = presetDaysOf(range.mode)
if (days != null) {
  scope.mode = 'from_date'
  scope.date_from = Math.floor((Date.now() - days * 86400 * 1000) / 1000)
}
```

Backend различает только `mode='from_date'` + `date_from` — preset id
существует только в UI/scope-builder. Это даёт две вещи: (1) backend не
знает про названия пресетов и не нуждается в обновлении при добавлении
нового; (2) preset-mode в state переживает invalidation/re-render без
«размотки» в дату («через час я открыл копи-форму, там всё равно стоит
«Последняя неделя», а не дата 26.04 которая теперь устарела»).

`PERIOD_PRESETS` + `presetDaysOf` / `presetIdForDays` — экспорт из
`TelegramScopeFields.jsx`, переиспользуется в TelegramScreen через
`FOLDER_RANGE_MODES`.

## 📦 Правила инклюзии item'а

**Чекбокс «Текст» = весь текст чата, а не строки `type='text'`.** Семантика чекбоксов — пользовательская, не схемная: юзер, выбравший «Текст», ожидает все посты с текстом, в каком бы носителе они ни пришли. В Telegram длинный пост с приложенной картинкой имеет `type='photo'` + текст в caption — для юзера это «текстовый пост с картинкой».

**Симптом бага (до фикса):** копирование канала «обрывается» на старой дате (26.12.25 при контенте до 08.06.26) — и через дату, и через весь чат одинаково. Канал в какой-то момент стал постить только с картинками → все новые посты `type='photo'` → старый гейт `type IN ('text')` их отрезал. 151 пост вместо 598. Выглядело как баг дат, было багом типов.

Селекция-driven eligibility (`_buildAssemblyWhere`):

| Выбран чекбокс | Что включается |
|-----|------|
| text | `type NOT IN ('voice','video','audio') AND caption непустой` — текст в ЛЮБОМ носителе |
| photo / document / poll | `type = X AND caption непустой` — для добора подписей когда «Текст» выключен |
| voice / video / audio | `type = X AND transcript_path IS NOT NULL` (тело на диске) |
| other | никогда — это стикеры/системные сообщения |

**Что отбросили — «any caption» без исключения AV.** Первая версия фикса считала текстом любой непустой caption, включая подписи под видео. Ломался инвариант **estimate == copy**: estimate считал 34 видео-с-подписью, а copy их выкидывал — тело video-item'а рендерится из transcript-файла (`assemble.js::_bodyFor`), не из caption. Поэтому в «Текст» AV-типы исключены явно: eligibility-SQL обязан зеркалить `_bodyFor`, иначе цифра в кнопке врёт.

**Опросы и реакции — без отдельных чекбоксов.** Telethon отдаёт `msg.reactions`
и `MessageMediaPoll` бесплатно (одно поле в response, без сетевых RPC).
Поэтому в форме есть только чекбокс «Текст» с подписью «текст + опросы +
реакции», а под капотом `process_polls=true` всегда. Опросы пишутся в
`caption` как обычный текст, реакции — в отдельную колонку и приклеиваются
к caption хвостом `[👍8 ❤️2]`. См. `fact-database.md::items.reactions` и
`fact-database.md::items.type='poll'`.

Сразу применяется в SQL `_buildAssemblyWhere` — единый WHERE кормит и
`assemblyEstimate`, и `assemblyFetch`, и `assemblyTranscriptPaths`. UI/backend
по определению не разойдутся.

**Для voice/video/audio тело читается из файла** через `fs.readFileSync` уже
в `assemble.js` на стороне main. SQL-aggregate знает только что transcript
есть, но не его размер — для точного byte-estimate отдельно идёт стат-пробежка
по файлам (см. `assemblyTranscriptPaths`).

## 🔀 last_n идёт **после** type-фильтра

Если бы limit применялся раньше (`SELECT * LIMIT 500 → filter by type/text`),
«Последние 500 голосовых с транскриптом» в чате с 95% текста дали бы 5 строк
из 500 случайных messages. Юзер увидит «5 сообщ.», подумает что данных нет.

Поэтому в SQL: сначала WHERE по type/caption/topic, потом ORDER BY DESC LIMIT.
Estimate показывает реальное число, и ровно столько же копируется.

## 📏 Format вывода — CLI-compatible

```
## Тема: General                       ← только если topic_id == null

--- 26.04.26 22:32 Алексей ---
эх обидно
[👍 8 ❤️ 2]                             ← реакции: только если непустые

--- 26.04.26 18:30 Max [🖼 Фото] ---
<caption если есть>

--- 27.04.26 09:10 Иван [📊 Опрос] ---
Куда едем в субботу?
▢ Парк Победы — 12
▣ Эрмитаж — 27
▢ Дома — 4
```

Формат повторяет вывод существующего CLI `sc -t @chat`. Юзер может пастить
оба источника в одну downstream-цепочку без разрыва шаблона.

**Header `## Тема: …` появляется только при «Все темы»** — когда юзер выбрал
конкретную тему (или чат не форум), заголовок становится избыточным.

## 🔢 Estimate vs реальный размер

**Симптом до фикса:** «4 386 сообщ. · ~339.7 KB текста» в estimate, реально
в clipboard оказывалось 743 KB. Разница ×2.18.

Корни:
1. **`length(caption)` считал символы**, а не байты UTF-8. Cyrillic = 2 байта
   на codepoint, поэтому char-count = bytes занижалось ×2.
   Фикс: `octet_length(caption)`.
2. **Заголовки `--- ... ---` не учитывались.** На 5k сообщений это +50 B × 5000
   = +250 KB. Фикс: на стороне IPC прибавляем `count * 50`.
3. **Тела voice/video в transcript-файлах** не входили в SQL aggregate. Фикс:
   `fs.statSync(path).size` каждого файла из `assemblyTranscriptPaths`.

После: estimate ~36.8 KB, real 35.96 KB — overshoot 4.6%, безопасный буфер.

## 🪙 Token estimate

`tokens = round(bytes / 3)` на стороне IPC, всегда отображается с префиксом
`~`. Real Claude/GPT BPE для смешанного RU/EN сидит в диапазоне 2.7–3.3
байт/токен; 3 — безопасная середина.

**Почему не tiktoken:** native-модуль ~2MB + table-data, плюс отдельный
forсing для Anthropic vs OpenAI токенизаторов. Для одной информационной
строчки overkill. Heuristic держит порядок и форматирование (`12.6k`, `1.3M`)
для оценки относительно context-window (Claude 200k, GPT-4o 128k).

## 🎚 Live estimate + invalidation

Estimate дебаунсится 200мс на смену любого инпута и подписан на
`useInvalidator('items:${sourceId}')` — когда параллельный fetch допарсил
новые сообщения, цифра обновится без перезагрузки страницы.

## 💬 С комментариями (Telegram-only opt-in)

Чекбокс `с комментариями` в панели — добавляет тред обсуждения после каждого
поста в combined.txt. Default off: одиночный пост-копировать без обсуждения
самый частый случай (короткая выжимка для Claude), а на крупном канале
1k+ постов с комментами это раздувает blob в десятки MB.

Формат: после `--- DD.MM.YY HH:MM Sender ---` идёт пост, потом сразу
`--- комментарии (N) ---` с тредом в flat-with-↳ виде (см.
`fact-telegram-comments.md`). Посты без комментов разделитель не получают
— без шумных «нет данных» строк.

Source-of-truth для сборки — `db.listCommentsForPosts(source_id, postIds)`
вызывается **внутри** assemble-handler (`_buildCommentsMap` в `main.js`),
делает один SQL JOIN'ом, не in-memory dump. Estimate-handler **не**
учитывает комменты — реальный bytes copy будет больше показанного
числа, но юзер видит fact в финальном toast'е (`✓ Скопировано · M сообщ. ·
KB`).

> **Что отбросили:** «всегда включать если комменты есть». Раз юзер
> их собрал — значит хочет видеть в копии. Логика правдоподобная, но
> ломается на «хочу выжимку только постов для другого AI» — снимать чекбокс
> каждый раз раздражает. Default off + явный жест включения симметричен
> default'у в TelegramConfigForm (платные опции тоже off).

## 💾 Save vs Copy

`[💾 .txt]` использует `dialog.showSaveDialog` с default-name
`tg_<YYYY-MM-DD>[_<topic-slug>].txt`. После записи звуковой Blow.aiff не
играет — `playClipboardSound` зарезервирован за clipboard-операциями.

Toast в кнопке (см. `methodology/переносимый-дизайн.md::Toast в кнопке, не рядом`) — на
2.4 секунды кнопка превращается в `Готово · 173 сообщ. · ~12.0k токенов · 35.1 KB`,
не двигая layout (фиксированный min-width).
