# Knowledge: Telegram Channel Comments

Комменты под постами Telegram-канала живут в **отдельной linked discussion
group** (другой чат с собственными msg_id), не в самом канале. Это меняет
архитектуру по сравнению с YouTube-комментами (одна сущность):
для одного fetch'а нужно резолвить **два entity** и делать два прохода
(посты → комменты per-post).

## 🎬 Где это в UI

**TelegramConfigForm.** Пятый чекбокс `[Комментарии]` в строке content-types
(после Текст / Голосовые / Видео / Фото / Документы), default off — как все
платные/затратные опции (см. `methodology/переносимый-дизайн.md::Default = безопасный
для денег`). Под ним показывается строка
`Комментариев на пост: [все] [____input____]` (см. `methodology/переносимый-дизайн.md::
Дискретные пресеты + free input`). Если у канала
`sources.has_discussion === 0` — чекбокс disabled, tooltip
«У канала нет обсуждений».

**SourceDetail.** В блоке `Распределение по типам` после text/voice/video/photo
chips появляется отдельный chip `💬 комментариев N` (только для TG, только
когда N>0). Не смешивается с type_breakdown потому что комменты не в `items`.

**Action-row.** Conditional кнопка `💬 Дотянуть комментарии (M)` появляется
когда:
- `s.platform === 'telegram'`
- `s.has_discussion === 1`
- `posts_count > postsWithComments` (есть посты без хотя бы одного коммента в БД)

`M` — `posts_count - postsWithComments`. Клик → catch-up flow (см. ниже).

**CopySavedPanel.** Чекбокс `с комментариями` — opt-in (default off, см.
`fact-copy-saved.md::С комментариями`). При on, в combined.txt после каждого
поста подклеивается тред с разделителем `--- комментарии (N) ---` в
flat-with-↳ формате (один уровень nesting'а — глубже Telegram отдаёт, но
для LLM-контекста плоско читается лучше).

## ⚙ Архитектура fetch'а

Resolver узнаёт `linked_chat_id` ОДИН раз через `GetFullChannelRequest.full_chat`
(стандартный `Channel`-объект его не содержит). Результат → emit `entity`
event с `has_discussion: bool` → runner кэширует в `sources.has_discussion`.

Когда `--include-comments` ON, regular iter_messages() loop ещё накапливает
`fetched_post_ids[]`. После основного цикла второй проход:

```
for post_id in fetched_post_ids:
    disc = client(GetDiscussionMessageRequest(channel, post_id))
    thread_root = disc.messages[0].id          # id треда в linked_chat
    iter_messages(linked_chat, reply_to=thread_root, limit=N)
        → emit per-post {comments: [...]}
    every 10 posts → emit comments_progress
```

Sequential, не параллельно — yt-dlp в YouTube-comments научил что параллель
триггерит anti-bot (там это yt-dlp, тут Telegram, но принцип универсален).

### Edge cases

- **Пост без discussion thread.** Некоторые посты (старые, или которые автор
  отключил для обсуждения) → `GetDiscussionMessageRequest` падает с
  `MessageIdInvalidError`. Логируем как `comment_error`, продолжаем — это не
  job-fail, это per-post «комментов нет».
- **Reply-цепочка глубже одного уровня.** Telegram пишет `reply_to_msg_id` на
  любой следующий коммент, может быть depth 3+. Мы храним полный
  `parent_comment_id`, но при рендере (в `electron/assemble.js::_formatComments`
  и в copy-flow) уплощаем до 1-level: orphan replies (parent не в наборе)
  hoist'ятся к top-level. Глубокая иерархия для LLM-контекста = шум, не
  сигнал.
- **FloodWait.** Один retry на тред с `await asyncio.sleep(e.seconds + 1)`,
  второй фейл → `comment_error`. Не зацикливаемся: на крупном канале
  (10k+ постов) FloodWait может прилететь много раз — exponential backoff
  через retry-loop переплачивал бы временем без выигрыша.
- **Reply на сам thread root.** В Telegram-discussion первый коммент
  технически указывает `reply_to_msg_id == thread_root`. Это не «ответ» на
  пост, это «первый коммент». Мы его трактуем как top-level (`parent =
  null`). Без этого все top-level комменты получили бы фейковый parent →
  древо стало бы одним мега-тредом.

## 🪡 Single-message side-fetch — `mode='single' + --include-comments`

Третий путь к комментам помимо channel-fetch и `comments_only`-catchup:
**paste одного сообщения с правой половиной split-chip'а `[+ comm]`** (см.
`methodology/переносимый-дизайн.md::Split-control`). Юзер хочет «один пост + его обсуждение»
для разовой LLM-вставки, без подписки на канал.

### Чем единая sourceless-операция отличается от channel-mode

В channel-mode main loop `iter_messages` накапливает `fetched_post_ids[]` и
после основного прохода идёт `_fetch_comments_for_post` для каждого id. В
single-mode main loop **не запускается** — вызов идёт сразу `client.get_messages(entity, ids=mid)`
для одного сообщения. Без явной обработки `fetched_post_ids` оставался пустым,
условие на запуск второго прохода не срабатывало → **юзер видел 0 комментов
на канале с явной discussion**.

Симптом: пользователь паст'ит `t.me/<chan>/<id>`, кликает `[+ comm]`, форма
показывает done с серой row'ой «Комментарии · недоступны». Заходит в Telegram —
под этим постом 80 комментов. Цифра в Telegram явная, в UI ноль.

Корневая причина невидима из кода без знания истории: `if include_comments and
fetched_post_ids` — на первый взгляд защитное условие, на деле в single-mode
это `if True and []` = false. Решение — отдельная single-mode ветка:

```py
elif mode == "single":
    msg = await client.get_messages(entity, ids=mid)
    emit({"type": "item", "data": item_data})
    await process_media(...)
    # Mirror channel-mode comments-pass for THIS one msg.id.
    if include_comments and has_discussion and linked_chat_id is not None:
        linked = await client.get_entity(linked_chat_id)
        rows = await _fetch_comments_for_post(client, entity, linked, msg.id, ...)
        if rows:
            emit({"type": "comments", "post_id": msg.id, "comments": rows})
        emit({"type": "comments_progress", "posts_done": 1, "posts_total": 1,
              "comments_collected": len(rows)})
    emit({"type": "done", "comments_collected": len(rows), ...})
```

### Sourceless storage — sidecar `.txt`, не post_comments table

В channel-mode `case 'comments'` в job-runner вызывает `db.bulkInsertComments`
по `job.source_id`. Single-mode **не имеет source_id** (paste одного сообщения
не создаёт `sources`-row, см. `methodology/переносимый-дизайн.md::Single точка входа` /
`fact-jobs.md::Pending row`). Прямой UPSERT не работает.

Решение — параллельный путь записи: `case 'comments'` детектирует
`!job.source_id && job.params?.mode === 'single'` и **буферизирует** rows в
`job.tg_comments_buffer[]`. На close-handler:

```js
if (job.params?.include_comments && job.status === 'done') {
  const cBuf = job.tg_comments_buffer || []
  const cName = fname.replace(/\.txt$/, '_comments.txt')
  const cPath = path.join(JOBS_DIR, cName)
  const body = cBuf.length === 0
    ? `--- комментарии (0) ---\n(под этим постом нет комментариев)\n`
    : `--- комментарии (${cBuf.length}) ---\n` + formatCommentsBlock(cBuf) + '\n'
  fs.writeFileSync(cPath, body, 'utf8')
  job.file_path_comments = cPath
}
```

Sidecar лежит **рядом** с message `.txt` (`<job>_comments.txt`) — Reveal in
Finder показывает оба, copy-кнопки в форме читают каждый отдельно.

### `formatCommentsBlock` экспорт — общий рендер

`assemble.js` теперь экспортирует не только `assembleText` (для CopySavedPanel),
но и `formatCommentsBlock(comments)` — обёртка над приватным `_formatComments`.
Используется в close-handler single-mode для рендера sidecar, в копии CopySavedPanel
для inline-комментов. Один источник правды для формата flat-with-↳, поправил в
одном месте — поправил везде.

### Always-write sidecar при `include_comments && status==='done'`

Даже когда `comments_collected === 0` (у канала нет discussion ИЛИ post-thread
пустой) — sidecar **всё равно пишется** с placeholder `«(под этим постом нет
комментариев)»`. Без этого:

- `file_path_comments` остаётся null → renderer не знает выполнилась ли
  side-операция вообще или просто не запросили.
- Кнопка «📋 Комменты» рендерилась бы disabled, что визуально не отличает
  «попытались, нет данных» от «не запросили».

С placeholder файлом юзер получает явный сигнал: side-fetch отработал, и
действительно ничего нет. Renderer в этом кейсе показывает muted-row
«Комментарии · недоступны» с статичным badge'ом «нечего копировать»
(не Copy-кнопкой) — см. `methodology/переносимый-дизайн.md::Тон done-row`.

> **Не writes на error/cancel.** Если job завершился `status='error'` или
> `cancelled` — sidecar не пишем (в close-handler условие `&& job.status === 'done'`).
> Иначе амбер-error-card на форме противоречил бы зелёному «комменты тут».

### Sort: top DESC, replies ASC

`_formatComments` (общий для всех Telegram comments-flow) теперь явно сортирует
комменты:
- Top-level threads (`parent_comment_id == null`) — DESC по `comment_id` (новые
  сверху, как ленте под постом в Telegram).
- Replies внутри треда — ASC по `comment_id` (диалог сверху-вниз
  хронологически — иначе ответ предшествует исходному комменту).

Telethon `iter_messages` без `reverse=True` отдаёт DESC, но другие callers
(catch-up, DB-read) могут отдавать ASC. **Не полагайся на «как массив пришёл»** —
сортируй явно. Подробнее — `methodology/переносимый-дизайн.md::Sort = match the user's
native mental model`.

### UI — где это в форме

`TelegramSingleMessageForm`:
- На `fetching` — две step-row'и: «Загружаем сообщение», «Получаем комментарии»
  (вторая видна только при `includeComments=true`).
- На `done` — две done-row'и (mirroring loader rows, см.
  `methodology/переносимый-дизайн.md::Done-rows зеркалят loader-rows`):
  - Сообщение — emerald `✓` + `[📋 Скопировать]`.
  - Комментарии — emerald `✓ · N` + `[📋 Скопировать]` если `collected > 0`,
    иначе muted `— · недоступны` + статичный бейдж.
- В header'е блока — кнопка `[📋 Пост+комм]` появляется только когда **оба
  файла существуют + collected > 0** (combined-copy через
  `jobs:copyCombined` IPC, склеивает blob через `\n\n`).
- Вторая row показывается **всегда** на done, даже без include_comments —
  с muted `— · не загружены` + кнопкой `[↻ Получить]` для post-hoc opt-in.
  Клик дёргает `loadComments()` который ставит `includeComments=true` и
  re-kickOff'ит fetch с тем же URL.

### Re-mount filter — отвергает broken-runs

`existingJob` lookup по `(url, include_comments)` дополнительно проверяет
`comments_collected !== 0`: старые job'ы от багнутого Python single-mode
(до фикса выше) лежат в БД с `params.include_comments=true` но collected=0 —
их реставрировать нельзя, иначе пользователь застревает на permanent
«недоступны» при свежем клике [+ comm]. Подробнее —
`methodology/переносимый-дизайн.md::Filter по content, не по existence`.

## 🔁 `comments_only` mode — для «Дотянуть»

Юзер уже спарсил 500 постов канала, хочет догнать комменты по уже-сохранённым.
`tg_fetch_json.py --comments-only-post-ids="1,2,3,..."` skip'ает
`iter_messages` целиком и идёт сразу во второй проход с переданным списком.

`SourceDetail::CatchUpCommentsButton` собирает список так:
```
allIds  = items.external_id WHERE source_id = X
covered = SELECT DISTINCT post_external_id FROM post_comments WHERE source_id = X
missing = allIds - covered
```

`bulkInsertComments` use'ает `INSERT … ON CONFLICT(source_id, post_external_id,
comment_id) DO UPDATE` — повторный clic безопасен, существующие комменты
обновятся (в основном `text` если был отредактирован), новые добавятся.

> **Почему не autoschedule.** «Дотянуть» — не CRON, явная кнопка. Комменты
> могут расти неделями (старый пост получил всплеск дискуссии после новости).
> Auto-sync на каждом sync_new = бесконечный API расход. Кнопка =
> юзер-driven: знаю что хочу свежий срез именно сейчас.

## 🚀 Производительность

Замер на @sofiandpartners (50 постов, 1 406 комментов): **80 секунд**.
~1.6 сек/пост — складывается из:
- 1 round-trip GetDiscussionMessageRequest на пост (~300ms);
- iter_messages для треда (для треда из 30+ комментов = 1-2 страницы);
- сетевая задержка к DC.

На каналах 1k+ постов считай минуты. Прогресс по постам каждые 10 (`{posts_done,
posts_total, comments_collected}`) — без него прогресс-бар выглядит замёрзшим
во время второго прохода (items_done уже = posts_total).

## 🧹 Что не делаем

- **Live-индексация по типам.** Комменты НЕ в FTS5 `items_fts`. Они отдельная
  таблица — поиск по ним пока не реализован. Если понадобится — отдельный
  `post_comments_fts` virtual table mirror'ит pattern items_fts.
- **Семантический индекс.** `items_vec` тоже только items. Embedding'и
  комментов могли бы дать «найди тред где спорили про релиз» — но ROI пока
  не оправдан (комменты часто короткие, слабо embeddable).
- **Re-pagination на «дотянуть свежие».** Tелеграм не отдаёт `min_id` для
  reply-thread iter'а. Catch-up догоняет полный список треда, INSERT ON
  CONFLICT делает идемпотентность; неэффективно но просто. Если станет
  bottleneck'ом — добавить `since_comment_id` per-post.

## 🔗 Связано

- `fact-database.md::post_comments` — схема таблицы и почему отдельно от items.
- `fact-copy-saved.md::С комментариями` — формат разделителя в combined.txt.
- `fact-source-actions.md::Дотянуть комментарии` — UI для catch-up.
- `fact-fetch-strategies.md::Resolve by chat title` — общая механика
  Telethon resolve, нормализация заголовков, прогресс iter_dialogs.
- `methodology/переносимый-дизайн.md::Default = безопасный для денег` — почему чекбокс
  off по умолчанию.
- `fact-youtube-comments.md` — параллельный продукт для YT, разные
  архитектуры (одна сущность vs linked group), но shared принципы (cache key,
  per-platform marker, flat-with-↳ format).
