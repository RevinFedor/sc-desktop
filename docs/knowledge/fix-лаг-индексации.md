# Fix: лаг индексации и скрытый reply-backfill

Симптомы от пользователя: при клике по индексации приложение лагало в разные
моменты; казалось, что кнопка «Стоп» не работает; на уже проиндексированном
чате клик всё равно вызывал тяжёлую активность. Важная ловушка расследования:
рядом с кликом могли быть логи Telegram/backfill, но root cause засчитывался
только после замеров длительности SQL и внешнего `sample` зависшего процесса.

## Что доказали логами

На source #48 (`neuraldeepchat`, ~55k items) после клика по index в production
не появился новый `IndexJob start`, зато дважды стартовал скрытый
`tg_reply_backfill`:

```text
[Jobs] start tg_reply_backfill #1 source=48 ... pending=105
[Jobs] end tg_reply_backfill #1 status=done resolved=105 with_parent=0
[Jobs] start tg_reply_backfill #2 source=48 ... pending=105
[Jobs] end tg_reply_backfill #2 status=done resolved=105 with_parent=0
```

DB подтвердила, что это не «новые сообщения»: все 105 строк были
`reply_resolved=1`, `reactions_resolved=0`, `reactions IS NULL`. Python
возвращал явное `reactions: null`, а JS трактовал null как «не удалось,
попробовать позже». Поэтому каждый следующий `tg:index` снова видел pending
и запускал backfill. Исправление: явный `reactions: null` защёлкивает
`reactions_resolved=1`; отсутствие поля `reactions` оставляет старое значение.

## SQL, который реально лагал

На полной индексации old-path запросы были синхронными блоками main process:

- `vectorCountForSource` через `items_vec JOIN items` — около 525-550ms.
- `selectItems` через `LEFT JOIN items_vec ... v.item_id IS NULL` на уже полном
  индексе — около 596ms, хотя результат 0 rows.

Быстрые per-source варианты на той же базе:

- `SELECT COUNT(*) FROM items_vec WHERE item_id IN (SELECT id FROM items WHERE source_id=?)`
  — около 50-70ms.
- `AND i.id NOT IN (SELECT item_id FROM items_vec)` для поиска непроиндексированных
  items — около 68ms warm.

Не переносить этот per-source паттерн на список всех источников как correlated
subquery. Промежуточная правка `listSources()` с per-row `IN` ушла в >60s и
100% CPU. Внешний `sample <pid>` показал main thread внутри
`better_sqlite3.node: Statement::JS_all -> sqlite3_step -> sqlite3BtreeInsert`,
то есть зависание было не React и не renderer, а sync SQLite work в main.
Для all-sources нужен grouped aggregate:

```sql
SELECT i.source_id, COUNT(*) AS semantic_indexed_count
FROM items_vec v
JOIN items i ON i.id = v.item_id
GROUP BY i.source_id
```

Он считается один раз и join'ится к `sources`, вместо N correlated count'ов.

## Финальный контракт

`tg:index` сначала стартует index job и сразу возвращает результат. Если
`selectItems` вернул 0, backend отвечает `noop reason=already-indexed`, UI
показывает «Индекс готов»/toast и **не** запускает `tg_reply_backfill`.
Backfill стартует только после реального index-start и через `setImmediate`,
чтобы не сидеть в синхронном click IPC.

Stop для `tg_index` обязан матчиться по двум identity: live id из Activity и
SQLite `jobs.id` из History/JobDetail. Кроме того, RPM-throttle sleep должен
проверять cancel-флаг короткими интервалами; иначе Stop технически принят, но
видимо срабатывает только после длинного `sleeping 13695ms`.

Практическая диагностика следующего лага: сначала искать `[tg:index] request`,
`[IndexJob] start ... selectItems ... took`, `vectorCount ... took`,
`reply-backfill pending-check ... took`. Если процесс уже на 100% CPU и лог
молчит, обычный logger слеп — нужен внешний `sample`, как в этом расследовании.
