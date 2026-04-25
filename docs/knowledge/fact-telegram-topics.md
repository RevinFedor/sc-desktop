# Knowledge: Telegram Forum Topics

Forum-supergroups (Telegram «темы») — отдельная subdivision сообщений внутри
чата. Например в `All Mentors | Общение` 24 темы: General, Моки, Мемы,
Анонсы собеседований, Собеседования / 1…9, README и т.д.

## 🔍 Detection

`entity.forum: bool` приходит на `client.get_entity(...)` в Telethon.
Эмитится в `entity` event: `{ ..., forum: true }`. Не-форум чаты получают
`forum: false`, и весь нижеследующий код пропускается.

## 📜 GetForumTopicsRequest — версионирование Telethon

В Telethon 1.42+ класс лежит в **`telethon.tl.functions.messages`**, в более
старых — в `telethon.tl.functions.channels`. Симптом ошибки в логах:

```
[Jobs] end #1 status=error error=telethon not installed
```

(сообщение вводит в заблуждение — это `except ImportError` из верхнеуровневого
блока, а не отсутствие telethon как такового). Реальная причина — `from
telethon.tl.functions.channels import GetForumTopicsRequest` падает, потому
что класс переехал.

**Решение** — try-cascade без вылета на ImportError:
```python
GetForumTopicsRequest = None
try:
    from telethon.tl.functions.messages import GetForumTopicsRequest
except ImportError:
    try:
        from telethon.tl.functions.channels import GetForumTopicsRequest
    except ImportError:
        pass
```

Если на машине совсем старый Telethon и оба пути промахнулись — для не-форум
чатов всё работает (мы проверяем `is_forum and GetForumTopicsRequest is not None`).
Форум-чаты на устаревшем Telethon просто не получат списка тем — items
сохранятся с `topic_id=null`.

**Аргумент `peer=`, не `channel=`.** В новой signature первый
позиционный — `peer: TypeInputPeer`. Тоже было источником
ошибки на первом тесте.

## 🪪 General topic = msg_id 1

Telegram **резервирует `top_msg_id=1`** под «General» во всех forum-чатах.
Сообщения в General не имеют `reply_to.forum_topic` флага вообще — для них
`_topic_for(msg)` принудительно возвращает `(1, "General")`. Без этого General
не показывался бы как chip в UI.

## 🔗 Как сообщение знает свою тему

Telethon Message exposes `msg.reply_to`:
```python
if rt and getattr(rt, "forum_topic", False):
    tid = getattr(rt, "reply_to_top_id", None) or getattr(rt, "reply_to_msg_id", None)
else:
    tid = 1   # General
```

Fallback `reply_to_top_id || reply_to_msg_id` важен потому что **первое
сообщение** в теме само себе root и `reply_to_top_id` может быть None — в
этом случае `reply_to_msg_id` указывает на topic-creation message, что и есть
наш topic_id.

## 💾 Что попадает в БД

Колонки в `items`:
- `topic_id INTEGER` — top_msg_id темы (1 для General, любой int для других).
- `topic_title TEXT` — копия заголовка на момент парсинга. Юзер может
  переименовать тему — старые items сохранят прежний заголовок.

Pre-fetch один раз на job через `GetForumTopicsRequest(limit=100)`. Кэш
`topic_titles: dict[id, title]` живёт в scope `run()`, каждый item смотрит
туда без сети.

> **Лимит 100 топиков.** Чаты с большим числом тем не пагинируются (offset_id
> не реализован сейчас). Юзер увидит первую сотню тем + items за пределами
> этой сотни сохранятся с `topic_id` известный, `topic_title=null`. UI
> render'ит таких как `#<id>` в chip-row.

## 🎚 Renderer: chip-row + dropdown типов

ChatView получает `topics` через `window.api.itemsTopics(sourceId)` — простой
SQL aggregate:

```sql
SELECT topic_id AS id, MAX(topic_title) AS title, COUNT(*) AS count
  FROM items
 WHERE source_id = ? AND topic_id IS NOT NULL
 GROUP BY topic_id ORDER BY count DESC
```

`MAX(topic_title)` потому что копии могут различаться при ребрендах темы —
берём последний сохранённый.

UI:
- **Forum (≥2 темы):** chip-row сверху списка messages. Первый chip «Все темы».
  Activе — bg-zinc-200 light, остальные — выкл. Click меняет `selectedTopic`,
  это бьёт `useEffect` deps → `reset()` + новая страница items.
- **Не-форум / 1 тема:** chip-row не показывается. Если есть один titled
  topic — тонкая полоса «Тема: <title>» вместо row, без интерактива.

Типы контента переехали в **dropdown «Фильтры»** справа от поиска.
Multi-select через кастомный `<Checkbox>`, счётчики реактивны на смену темы
(передаётся `topic_id` в `itemsTypeBreakdown`). Пустые в текущей теме типы
получают `opacity-40`.

**Почему dropdown, а не chips:** topic-chips и type-chips жили бы рядом и
конкурировали за внимание. Топики — **контекст** (что я смотрю), типы —
**фильтр** (часто = «все», редко правится). Контекст всегда виден, фильтр
за кнопкой.

## 🪤 Reset на смену source

`selectedTopic` и `selectedTypes` — local state в ChatView. При навигации
в другой источник эти значения **бессмысленны** (id-шники топиков/типов
принадлежат прошлому чату). `useEffect([sourceId])` сбрасывает в начало
(null + empty Set). Без этого после перехода All Mentors → Чат | EBASH
запрос items уходил с topic_id=68 → 0 результатов на не-форум чате →
«нет сообщений».

## 🎯 Pre-fetch multi-filter (server-side)

Раньше topic-фильтр работал **только** в ChatView post-fetch — спарсили
весь чат, потом отфильтровали в выдаче. Теперь TelegramConfigForm даёт
**pre-fetch** multi-select: юзер галочкой выбирает N тем, парсится
**только** их содержимое.

UI (multi-select):
- `TelegramTopicsPopover` — отдельный компонент, визуально mirror-it
  TelegramTypesPopover (max-w cap, truncate, tri-state «Все темы»).
- Сидит **на той же row** что types popover (одна строка
  `<RowLabel label="Типы контента">`), не отдельной row под ней.
  Цель — не давать форме расти вертикально.
- Скрывается когда `topics.length <= 1` — на не-форум чатах и форум-чатах
  с одним General-топиком popover не появляется.

Источник списка тем: `window.api.itemsTopics(sourceId)` — sql aggregate
по `items.topic_id` уже сохранённых сообщений. На свежем источнике
без cached items список **пустой** → row hidden. Нагревается после
первого «полного» fetch'а — тогда topics.length > 1, popover появляется.
Без этого юзер на первом fetch'е не видит селектор; это **сознательный
trade-off**, потому что упрощает архитектуру — не надо вызывать
GetForumTopicsRequest до клика «Спарсить».

**Server-side фильтрация и многотомный fetch** — детали в
`fact-fetch-strategies.md::Pre-fetch topic filter`. Здесь только UI.

### Single vs multi: copy-flow остался single

CopySavedPanel (post-fetch sample assembly) использует **single-select**
по теме (`topicId` + старый `<Select>`) — потому что copy assembly
форматирует один блок текста, multi-topic в нём не имеет физического
смысла. Fetch-flow перешёл на multi (TelegramTopicsPopover), copy-flow
сохранил single (один общий `<Select>` со списком topics).

В TelegramScopeFields это разделено пропсами:
- `topicId` + `onTopicIdChange` + `topics` — для copy
- `topicIds` + `onTopicIdsChange` + `topics` — для fetch

Старый single-`Select` рендерится только при `use === 'copy'`, новый
multi-popover рендерится только при `use === 'fetch' && onTopicIdsChange`.
В fetch'е раньше отображались **оба** (был баг времён миграции — пара
дней с двумя селекторами на странице).
