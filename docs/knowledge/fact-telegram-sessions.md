# Knowledge: Telegram Sessions

Один Telegram API key + два аккаунта = две `*.session` файла. Вход в API делается через Telethon, session-файл (sqlite-формат) хранит токены/auth_keys. Активная сессия — глобальная, шарится с CLI.

## 📁 Где живут session-файлы

Resolution priority (`shared/tg_session_path.py::session_dirs()`):

1. **dev path** — `cli-tools/telegram/*.session` (рядом со скриптом).
   Шарится с CLI `sc -t @channel`, читающим Telethon напрямую из той же
   папки. Эту папку трогаем когда работаем «из исходников».
2. **prod fallback** — `~/Library/Application Support/sc-desktop/sessions/telegram/*.session`.
   Здесь живут sessions для production-сборки, потому что bundle filter
   намеренно исключает `*.session` из `Contents/Resources/cli-tools/`
   (security — токены логина не должны попадать в распространяемый артефакт).
   Plus Resources в .app code-signed read-only — туда писать нельзя.

Первый существующий путь выигрывает. **Новые** sessions, создаваемые
через UI Settings, пишутся в **prod-fallback** (writable), даже когда
ты в dev. Это сделано чтобы один user-dir работал и для prod-сборки
(установленной в /Applications), и для dev-запуска через `npm run dev`
параллельно.

`.session` файлы — это sqlite БД Telethon с token'ами. Не парсить руками,
работать только через `TelegramClient(<path-without-ext>, api_id, api_hash)`.

> **Что отбросили.**
> - **Класть session в `~/.config/sc/`** (рядом с settings.json, общий путь
>   с CLI) — отбросили, потому что `~/.config/sc/` концептуально для
>   **config**, а sessions — это **state** (бинарные sqlite-БД с токенами,
>   меняются на каждом logout/login). State идёт в `Application Support`,
>   аналогично `library.db`. Один backup root = один Application Support.
> - **Автоматически копировать sessions из bundle в user-dir при первом
>   запуске prod-сборки.** Но в bundle sessions **физически нет** — фильтр
>   их исключает раньше. Юзер на чистой prod-установке либо логинится через
>   UI заново (новый session уйдёт сразу в user-dir), либо руками копирует
>   старый dev-session в `~/Library/Application Support/sc-desktop/sessions/telegram/`.

См. `fix-production-asar-spawn.md::Sessions исключены из bundle` про
полный класс prod-only path-багов и общий чеклист.

---

## 🔑 Активная сессия в `~/.config/sc/settings.json`

```json
{
  "telegram": {
    "session": "session2"        // имя без .session расширения
  }
}
```

**Single source of truth** — этот же файл читает CLI и оба python-скрипта (`tg_fetch_json.py::_resolve_session_path()`, `tg_sessions_ndjson.py`). Никакого дублирования в SQLite или в renderer state.

UI Settings screen → `tg-settings` → клик «сделать активной» → `main.js::tg:setActiveSession` делает read-modify-write (shallow merge, не overwrite) этого JSON. Другие ключи (instagram, youtube prefs) не теряются.

---

## 🔗 Привязка чатов и папок к сессиям

Чат принадлежит аккаунту, которым его реально читали. До привязки страница Telegram показывала «371 чат» — смесь обеих сессий вперемешку, юзер не мог понять что к чему относится.

**Снимок на спавне, не на чтении.** `job-runner.js::activeTgSession()` читает `telegram.session` из settings.json **в момент старта job'а** и кладёт в `job.tg_session`. Все `upsertSource`/`upsertFolder` этого job'а пишут привязку из снимка — уже-бегущий fetch продолжает числиться за своей сессией, даже если юзер переключил активную (тот же принцип, что «running jobs не переключаются на лету» выше).

**Снимок уходит Python'у явным `--session`, race закрыт.** Раньше снимок жил только на JS-стороне (`job.tg_session`), а Python-скрипт **сам заново** читал `settings.json` при импорте — между этими двумя чтениями ~0.5-1 сек, в которые быстрое переключение сессии в UI ретаргетило уже-спавнящийся fetch на другой аккаунт (job записан за сессией A, Python реально ходил сессией B). Теперь `job-runner` снимает сессию **до** построения argv и передаёт её всем tg-скриптам аргументом `--session <name>`; зонтичные job'ы (`tg_folder_fetch`, `tg_catchup`) снимают **один** снимок на весь прогон и прокидывают его каждому ребёнку через `_tg_session_override`. `tg_reply_backfill` — особый случай: правильная сессия не «активная сейчас», а та, к которой **привязан сам чат** (`sources.tg_session`), активная только fallback для legacy-строк. Подтверждено e2e: длинный fetch + три переключения сессии во время работы → привязка осталась со снимка, дубль не родился, conflict не поднялся.

**Conflict — latch, гасится только пином.** Если upsert видит другое непустое имя сессии, чем уже записано — `tg_session` переписывается на свежую, `tg_session_conflict=1`. Флаг не сбрасывается сам: юзер видит amber-бейдж «выбери сессию» на странице чата (`SourceDetail::SessionBadge`) и пинит каноническую руками (`sources:setSession` → conflict=0). NULL-сессия (legacy-вызовы, не-TG платформы) ничего не перезаписывает — COALESCE.

**Переключатель на TelegramScreen = настоящая смена активной сессии,** не view-фильтр. Сегменты в шапке зовут тот же `tg:setActiveSession`, что и страница настроек — «что я вижу» и «куда пойдёт парсинг» не могут разойтись по определению. Отбросили вариант «локальный фильтр отображения»: с ним юзер смотрит чаты сессии A, жмёт «Спарсить», а fetch уходит сессией B.

**Legacy-строки (tg_session NULL) видимы в любой сессии** и усыновляются при следующем fetch/refresh. Прятать их = «у меня пропали чаты»; конфликтные тоже видимы везде — иначе их нечем запинить.

**Папки: DialogFilter.id нумеруется с 2 ВНУТРИ каждого аккаунта** (внешний факт Telegram API) — у двух сессий папки коллидируют на id=2,3,… Поэтому `folders.tg_session` + `UNIQUE(tg_filter_id, tg_session)` (миграция — `fact-database.md::folders`), `folder:list` фильтруется по сессии, а prune после refresh удаляет только папки **своей** сессии — свип ходил по одному аккаунту и не знает о существовании папок другого (см. `fact-telegram-folders.md`).

---

## 🚦 Login state machine

`tg_sessions_ndjson.py` поддерживает 4 режима через subcommand:

```
list                        → enumerate *.session, validate auth, emit per-file
login-start  --phone        → send_code_request, emit code_sent + phone_code_hash
login-finish --hash --code  → sign_in
                              ├── успех                  → emit logged_in
                              ├── 2FA включена           → emit 2fa_needed (без password)
                              └── PhoneCodeInvalid/Expired → emit error
delete --name               → удалить .session + journal/wal/shm файлы
```

Login-finish может быть вызван **дважды** для одного login-start: первый раз без password (получим `2fa_needed` если включён облачный пароль), второй раз с `--password X`.

**Почему не один single-shot login command:** Telethon `client.start()` в interactive mode дёргает stdin для ввода кода. В subprocess-spawn'е stdin недоступен (мы не PTY, см. `fact-ipc.md`). Поэтому 3 raw-step'а: запросить код, дождаться ввода юзера в UI, передать обратно.

---

## 🪤 Симптом: `items=0` для @username

**Что видит юзер:** `paste @SomeName` → канал «найден» (entity event приходит) → fetch завершается успехом → 0 items сохранено. Логи показывают:
```
[Jobs] start tg_fetch #1 target=SomeName mode=all
[Jobs] saved #1 → ...
[Jobs] end #1 status=done items=0
```

**Что произошло:** entity это `kind='user'` (частное лицо, не канал). Telethon `iter_messages(<user>)` возвращает сообщения **из приватной переписки текущей сессии с этим юзером**. Если в активной сессии (см. settings.json) с ним не было переписки — отдаёт пусто.

**Не баг, политика Telegram API.** Невозможно прочитать чужие сообщения, даже если знаешь @username.

**Чек-лист для дебага:**
1. Это вообще канал? `entity.kind` в логах: `channel`/`chat`/`group` — да. `user`/`bot` — нет, это частный диалог.
2. Если user — есть ли реально переписка в **активной** сессии? У юзера может быть две сессии с разными аккаунтами, переписка в одной, активна другая.
3. Решение: открыть Library → клик «Telegram» в sidebar → переключить активную сессию на ту где есть переписка.

UI улучшение (TODO): когда entity это `kind=user` и items=0, показывать жёлтый бейдж «приватный диалог в этой сессии пуст» вместо тихих 0.

---

## 🔁 `--session` от Electron побеждает settings.json

```python
def _resolve_session_path(name_override=None):
    name = "session2"
    if name_override and isinstance(name_override, str):
        name = name_override
    else:
        settings_path = Path.home() / ".config" / "sc" / "settings.json"
        if settings_path.exists():
            try:
                data = json.loads(settings_path.read_text("utf-8"))
                n = (data.get("telegram") or {}).get("session")
                if n and isinstance(n, str):
                    name = n
            except Exception:
                pass
    return resolve_session_path(name, Path(__file__).parent)
```

Все desktop tg-скрипты (`tg_fetch_json.py`, `tg_resolve_folder_ndjson.py`,
`tg_reply_backfill_ndjson.py`) принимают `--session <name>`: если флаг
передан, он **побеждает** settings.json. Electron всегда его передаёт
(снимок на спавне, см. «Снимок уходит Python'у явным --session» выше).
Чтение settings.json остаётся только **fallback'ом для ручного запуска
из терминала** — когда юзер сам дёргает скрипт без `--session`.

**MCP `session/profile` override не меняет активную сессию.** Агентный сценарий
типа *«по профилю f9922 найди Геннадия, если чата нет в БД — найди среди живых
диалогов и подтяни за сегодня»* не должен предварительно кликать UI-сегмент или
переписывать `settings.json`: это глобальное состояние SC Desktop и может
ретаргетить следующий ручной fetch пользователя. MCP tools (`telegram_resolve_chat`,
`telegram_preview_fetch`, `telegram_fetch`) принимают `session`/`profile`; сервер
сначала вызывает `tg_sessions_ndjson.py list`, матчится по session name, username,
phone или id (`profile:"f9922"` → `session_4531193`), проверяет `authorized`, а
дальше прокидывает имя как `_tg_session_override` в `job-runner`/`--session`.
Симптом без этого слоя: приватный диалог реально есть в другом аккаунте, но агент
парсит активную сессию и возвращает 0 items или «чат не найден».

**`telegram_list_sessions` всегда вызывает subcommand `list`.** `tg_sessions_ndjson.py`
не имеет default-режима; вызов без subcommand возвращает argparse usage-error.
Для агента это первый шаг discovery, поэтому MCP обязан отдавать `{active,
sessions[], errors[]}` вместо того чтобы просить пользователя вручную помнить имя
session-файла.

`resolve_session_path` (из `shared/tg_session_path.py`) пробует dev-путь
рядом со скриптом, потом prod-fallback в Application Support (см. «Где
живут session-файлы» выше) — единый helper для всех `tg_*_ndjson.py`,
не голый `Path(__file__).parent`.

Default `session2` — fallback для legacy installs. Если файла session нет на диске — emit понятный error «Session file '<name>.session' not found» вместо Telethon stack trace.

При смене активной сессии через UI **не нужен restart Electron** — следующий spawn прочитает свежее значение (теперь через `--session`, который job-runner снял из свежего settings.json). Но **уже запущенные** jobs продолжают использовать тот session, с которым стартовали — снимок уже зафиксирован в argv, переключить на лету невозможно by design.

---

## 🛡 Секурность

`session.session` содержит **полные API token'ы** аккаунта — кто скопирует файл, может действовать от имени юзера. Что мы делаем:
- Никогда не отдавать содержимое `.session` в IPC (UI получает только `me: {first_name, username, phone}`).
- Tg login через UI идёт строго через subprocess — `phone_code_hash` живёт в Python-процессе короткоживуще, в renderer передаётся только хэш (не код).
- `delete` режим стирает и `.session-journal` / `-wal` / `-shm` siblings — иначе sqlite оставит частичный state.

## 🔒 Lock на параллельных Python-процессах

`database is locked` при одновременных операциях (fetch + preview, fetch +
resolve-title) — фикс в `fix-telethon-session-lock.md`. Telethon `SQLiteSession`
не выставляет `busy_timeout`, мы патчим явно после init клиента.

## 🔓 Деавторизованная сессия: `connect_authorized`, не `client.start()`

**Симптом.** Активная сессия выбрана, `.session`-файл на диске есть, но
аккаунт в нём разлогинен (logout с другого устройства, revoke, протух).
Любой tg-job (`tg_folder_refresh`, `tg_fetch`, catch-up, reply-backfill)
падает в Activity/JobDetail с `python exited 1:` и **пустым** хвостом —
ни причины, ни stack trace.

**Почему пусто.** `client.start()` при неавторизованной сессии не кидает
исключение — он сваливается в интерактивный логин и печатает «Please
enter your phone…» в **stdout**. У subprocess'а stdin закрыт (мы не PTY,
`fact-ipc.md`), `input()` ловит `EOFError`, процесс выходит 1, в stderr
пусто. (То же поведение, что в login-state-machine выше — там оно решается
3-step raw-логином; здесь нам логин не нужен, нужна честная ошибка.)

**Решение — `shared/tg_session_path.py::connect_authorized(client)`.** Все
desktop tg-скрипты вызывают его вместо `client.start()`: он делает
`connect()` (без попытки логина) + явный `is_user_authorized()`. Если не
авторизован — возвращает `(False, human_message, code)`, скрипт эмитит
`{"type":"error","message":...,"code":"session_unauthorized"}` и выходит 4.

**Машинный `code`, не матчинг текста.** В ndjson-error едет
`code="session_unauthorized"` рядом с русским сообщением. job-runner
кладёт его в `job.error_code` (+ в snapshot), umbrella-jobs пробрасывают
код вверх из child'а (сессия общая — деавторизация валит всех детей
одинаково, тост нужен один). Renderer (`lib/sessionToasts.js`) реагирует
на **код**, а не на текст — глобальный тост с действием «Открыть
настройки Telegram» (→ `tg-settings`, где у каждой сессии виден статус
авторизации). См. `переносимый-дизайн.md::Toast для сквозного состояния`.

> **Что отбросили — `client.start()` с заглушкой phone-callback.** Можно
> было передать `start(phone=lambda: ...)` чтобы не падало на stdin. Но
> это маскирует проблему: юзер всё равно не залогинен, фетч вернёт 0 или
> зависнет на коде. Честный отказ с понятным сообщением + кнопкой в
> настройки лучше тихого «как будто работает».
