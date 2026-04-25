# Fix: `database is locked` при параллельных Telethon процессах

## 🚨 Симптомы

- Запустил парсинг 5000 сообщений (50+ секунд) — отдельно в Activity panel
  job показывает `error: OperationalError: database is locked`.
- В paste-flow одновременно с running fetch'ем запросил «Анализ» (preview) —
  ошибка та же, мгновенно.
- В paste-flow ввёл текст-название чата → клик «найти чат» (resolve-title)
  одновременно с running fetch — снова lock.

## 🔍 Корневая причина

Все три случая используют один файл `cli-tools/telegram/session2.session` —
sqlite-БД Telethon с auth_keys. Telethon `SQLiteSession` открывает соединение
**без `busy_timeout`**, поэтому второй параллельный коннект (preview /
resolve-title spawn'ятся отдельным Python-процессом) ловит lock мгновенно
при попытке write.

В CLI один процесс по определению (юзер запускает `sc -t @x` руками,
другой раз ждёт). В desktop UI юзер легко триггерит несколько Telegram
операций одновременно — lock неизбежен без busy_timeout.

## ✅ Решение

Patch helper в `tg_fetch_json.py`:

```python
def _bump_session_busy_timeout(client, timeout_ms=30000):
    try:
        sess = getattr(client, "session", None)
        conn = getattr(sess, "_conn", None) if sess else None
        if conn is None:
            return
        conn.execute(f"PRAGMA busy_timeout = {int(timeout_ms)}")
    except Exception:
        pass
```

Вызвать **после** `TelegramClient(...)` создания, **до** `await client.start()`.
Применено в обеих ветках (`run()` и `resolve_title()`).

30 секунд — компромисс: достаточно чтобы переждать write большой пачки от
fetch-процесса, не настолько много чтобы юзер успел посчитать app мёртвым.

## ⚙ Параллельный фикс на стороне `library.db`

CLI `sc` и Electron оба пишут в `~/Library/Application Support/sc-desktop/library.db`.
Та же проблема в зародыше. `electron/database.js::getDb()`:

```js
_db.pragma('busy_timeout = 30000')
```

WAL mode уже был, но без timeout-а первый conflict валит writer. Пара
WAL + busy_timeout избавляет от таких ошибок при «фоновый CLI sc + UI fetch
одновременно».

## 🛡 Backfill auto-spawn гард

`tg:index` IPC намеренно стартует `tg_reply_backfill` параллельно с
Gemini-индексом (Gemini-job не трогает Telethon-session, реальной коллизии
с другим job'ом — нет). Но если на том же source **уже бежит другой
Telethon-job** (`tg_fetch`, `tg_folder_fetch`, `tg_preview`, или другой
backfill), busy_timeout 30s **не спасает**: 5000-item fetch держит
session-lock 30-50 секунд, второй процесс выходит за timeout и падает с
`database is locked` мгновенно.

Решение: `startTelegramReplyBackfill` смотрит активный `jobs.values()`,
выбирает по `j.source_id === sourceId` и `j.type` ∈ списке, и **отказывается
стартовать** с понятной ошибкой:

```
another Telegram job is running for source #48 (job #3 tg_fetch) —
try again after it finishes
```

Caller в `tg:index` ловит ошибку и логирует как
`[tg:index] reply-backfill deferred: ...`. Индекс продолжает без
возмущения — следующий клик «Индексировать» (или мануальный backfill через
preload) подхватит unresolved items когда tg_fetch закончится.

> **Почему не положить backfill в очередь.** Гард — fail-fast, не очередь.
> Очередь усложнила бы: persist между рестартами, отмена, race condition'ы
> «backfill в очереди → юзер удалил source». Отказ + повторный клик —
> предсказуемее.

## 🪤 Что отбросили

- **Singleton-mutex на стороне Electron**, чтобы спавнить только один Python
  за раз. Защищает от lock'а, но **запрещает** preview / resolve пока fetch
  идёт — а это валидные операции, юзер не должен ждать конца 50-секундного
  парсинга.
- **Перевести Telethon на shared-cache mode** — есть в sqlite, но Telethon
  его не настраивает; форк библиотеки нерационально.
- **Перейти с SQLite session на `StringSession`** — теряем persist между
  рестартами Electron, юзер каждый раз заново вводит код.

## 🔗 Связанное

`cli-tools/docs/knowledge/fact-telegram.md::Session lock` упоминает аналогичную
ошибку с подсказкой `lsof ... session.session` — но это для CLI-сценария
«завис прошлый процесс`. В desktop'е процессы не виснут, они просто
конкурируют за write-лок параллельно.
