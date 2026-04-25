# Fix: spawn ENOTDIR в production-сборке (cli-tools внутри app.asar)

## 🚨 Симптом

В production-сборке (`/Applications/SC Desktop.app`) любой Telegram fetch
падает мгновенно с error в Activity panel. Прод-лог
(`~/Library/Logs/sc-desktop/production.log`):

```
[Jobs] start yt_transcribe #1 url=https://...
[ERROR] Error occurred in handler for 'yt:single': Error: spawn ENOTDIR
    at ChildProcess.spawn (node:internal/child_process:420:11)
    at Object.startYoutubeSingle (.../app.asar/electron/job-runner.js:596:17)
```

В dev всё работает.

## 🔍 Корневая причина

`electron-builder` упаковывает renderer + main в `app.asar` (tar-like архив).
`__dirname` внутри main указывает на `Resources/app.asar/electron`.
`CLI_ROOT = path.resolve(__dirname, '..', 'cli-tools')` указывает на
`Resources/app.asar/cli-tools`.

`spawn(VENV_PYTHON, [scriptPath], { cwd: CLI_ROOT })` валится с **`ENOTDIR`**
потому что **asar — это файл-архив, а не директория**. Node.js fs API
читает asar transparently (file reads работают), но `cwd` в child_process
требует реальной mount-точки на FS.

В dev `__dirname` указывает на настоящую папку, поэтому проблема не видна.

## ✅ Решение

`cli-tools` копируется **рядом** с `app.asar`, не внутрь. Это и не нужно —
в архиве Python всё равно был бы недоступен для venv-интерпретатора как cwd.

`package.json::build`:
```json
"extraResources": [
  {
    "from": "cli-tools",
    "to": "cli-tools",
    "filter": [
      "**/*.py",
      "!**/__pycache__/**",
      "!**/test_*.py",
      "!**/*.session",
      "!**/output/**"
    ]
  }
]
```

`extraResources` копирует в `Contents/Resources/cli-tools/` — обычная
директория, доступная для spawn.

`electron/job-runner.js`:
```js
const CLI_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'cli-tools')
  : path.resolve(__dirname, '..', 'cli-tools')
```

`app.isPackaged` различает dev/prod без явного NODE_ENV.

## 🪤 Что отбросили

- **`asar: false`** в build config — выключает asar целиком, теряем sign+
  notarize-friendly архив. Большой удар по структуре сборки ради одной
  проблемы.
- **`asarUnpack` для cli-tools** — копирует папку рядом с asar, но имя
  получается `app.asar.unpacked/cli-tools/` — менее чистый путь, и `__dirname`
  всё равно указывает в asar, нужен такой же app.isPackaged-switch.
- **Переписать `*_ndjson.py` в Node** — прибил бы Telethon-зависимость, но
  CLI-side тоже на Python и они шарят shared модули. Перепиливать сейчас
  нет смысла, см. `CLAUDE.md::cli-tools — папка со скриптами`.

## ⚠ После фикса проверить

```bash
ls "/Applications/SC Desktop.app/Contents/Resources/cli-tools/web/yt_single_ndjson.py"
```

Должен существовать. Если нет — проверить filter в `extraResources` (могло
исключить что-то нужное).

## 🪤 Другие prod-only path-ловушки (тот же класс багов)

`spawn ENOTDIR` — самый яркий случай, но **тот же корень — `__dirname`
в prod указывает в asar — производит ещё минимум три бага**, каждый
проявляется отдельно по мере того как юзер открывает в prod очередную
фичу. Все три починены, держим в уме при добавлении новых ресурсов из
`cli-tools/` или нативных deps:

### `vec0.dylib` (sqlite-vec)

`sqliteVec.getLoadablePath()` делает `require.resolve('sqlite-vec-darwin-arm64/vec0.dylib')`,
что в prod возвращает путь **внутрь asar**. `db.loadExtension()` —
обёртка над dlopen — не умеет читать из packed asar (в отличие от Node fs
API, который читает asar transparently). Симптом: `SqliteError: no such
module: vec0` на каждом обращении к `items_vec` (включая `vectorCountForSource`,
`tg:indexStatus`, `tg:index`, hybridSearch). В dev всё работает —
`require.resolve` возвращает реальный путь в `node_modules/`.

Решение в `database.js::getDb()`:
```js
let p = sqliteVec.getLoadablePath()
if (p.includes('app.asar' + path.sep) && !p.includes('app.asar.unpacked')) {
  p = p.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep)
}
db.loadExtension(p)
```

И **обязательно** `asarUnpack` правило в `package.json::build`:
```json
"asarUnpack": [
  "node_modules/sqlite-vec-darwin-*/**",
  "node_modules/sqlite-vec-darwin-*/vec0.dylib"
]
```
Без `asarUnpack` electron-builder может зашить .dylib **внутрь** asar
(zip-like), и rewrite не поможет — файла на диске не будет.

### `embedder.js` искал `config.env` через `__dirname/../cli-tools`

Аналогично `cwd` для spawn'ов: `__dirname/../cli-tools` в prod указывает
в asar, а `cli-tools` живёт в `extraResources` (рядом с asar, не внутри).
fs.readFile асаровского пути молча возвращает «нет файла», embedder
бросает `GEMINI_API_KEY not found in env or cli-tools/config.env`.

Симптом: **индексация запускается, мгновенно падает с error**, при том
что ключ в config.env есть, fetch работает (job-runner уже использует
`process.resourcesPath`). Решение — зеркальный switch на app.isPackaged
прямо в embedder'е.

### Sessions исключены из bundle

`extraResources.filter` в package.json содержит `!**/*.session` —
**намеренно**, токены логина не должны попадать в распространяемый артефакт.
Но без user-dir fallback'а скрипты ищут session рядом с собой
(`Path(__file__).parent / "<name>.session"` = в read-only bundle path
который к тому же не содержит файлов) → **вся Telegram-функциональность
мертва в свежей prod-сборке**.

Симптом сразу после установки нового билда: каждый Telegram-job
завершается через 1 секунду с `Session file 'session.session' not
found`, fetch / preview / backfill / folder-resolve — все падают.

Решение — общий helper `cli-tools/shared/tg_session_path.py` с приоритетом
`[script_dir, ~/Library/Application Support/sc-desktop/sessions/telegram/]`.
Подробно — `fact-telegram-sessions.md::Где живут session-файлы`. Новые
sessions через UI (`sc -t settings` → Add) пишутся сразу в user-dir, а
существующие dev-копии в `cli-tools/telegram/` остаются — dev-flow не
ломается.

> **Что отбросили:** автокопирование sessions из bundle в user-dir при
> первом запуске prod-app. Сессий **в bundle нет** (выше — фильтр их
> исключает), копировать нечего. Юзер заново логинится через UI, либо
> руками копирует `cli-tools/telegram/session.session` в user-dir после
> чистой установки.

### PATH в GUI-launched prod (yt-dlp / ffmpeg / brew tools)

GUI-запуск (Dock, Finder, `open -a`) поднимает app через **launchd**, не через
shell. PATH у такого процесса = `/usr/bin:/bin:/usr/sbin:/sbin` — никаких
`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`. Python-subprocess
наследует `process.env.PATH` через `{ ...process.env, PYTHONUNBUFFERED: '1' }` →
`subprocess.run(['yt-dlp', ...])` валится с `FileNotFoundError`. В
`yt_single_ndjson.py::fetch_meta` это ловится общим `except Exception: return None` →
emit `{"type":"error","message":"yt-dlp metadata fetch failed"}`. То же касается
`yt_batch_transcribe_ndjson.py`, `yt_channel_ndjson.py`, `yt_batch_comments_ndjson.py`,
`tk_channel_ndjson.py` и любого будущего скрипта, который зовёт `yt-dlp`/`ffmpeg`
по короткому имени.

В dev не воспроизводится: `npm run dev` запускается из zsh, Electron наследует
полный shell-PATH → `/opt/homebrew/bin` уже там → `yt-dlp` находится.

Решение — augment'ить PATH в `electron/main.js` сразу после `initLogger()`:
```js
if (process.platform === 'darwin') {
  const extra = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/opt/local/bin']
  const cur = (process.env.PATH || '').split(':').filter(Boolean)
  const merged = [...cur]
  for (const p of extra) if (!merged.includes(p)) merged.push(p)
  process.env.PATH = merged.join(':')
  console.log(`[Startup] PATH augmented with brew/macports: ${process.env.PATH}`)
}
```

Это покрывает Apple Silicon (`/opt/homebrew`), Intel-Mac (`/usr/local`),
MacPorts (`/opt/local`), и не дублирует пути если они уже есть (dev-запуск
из shell). Стартовая строка лога — sanity-check, что патч применён.

Альтернативы, которые отбросили:
- **Hardcode `/opt/homebrew/bin/yt-dlp`** — ломает Intel-Mac'и и переезды.
- **Fix в Python-скриптах** (передавать `env={**os.environ, 'PATH': ...}`) —
  5+ файлов, забудешь при добавлении нового скрипта.
- **`shell: true` в spawn** — выполняет команду через `/bin/sh`, который
  тоже имеет минимальный PATH. Без отдельной обвязки ничего не меняет.

Воспроизведение для теста:
```bash
pkill -f 'SC Desktop'
env -i HOME="$HOME" launchctl asuser $UID /usr/bin/open -a "/Applications/SC Desktop.app"
grep '\[Startup\] PATH' /Users/fedor/Library/Logs/sc-desktop/production.log
# должно быть PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:...
```
Без `env -i launchctl asuser` запуск из shell-сессии наследует shell-PATH и
test'у false-pass.

### Общий чеклист

При добавлении нового кода в **main process**, который читает что-либо
из `cli-tools/` через FS (read, spawn, fork, native lib load) или пишет
куда-либо рядом со скриптом:

- ❓ Этот код будет работать в **packed asar**? Если использует `__dirname`
  + `..` — почти наверняка нет.
- ✅ Read из cli-tools → `app.isPackaged ? path.join(process.resourcesPath, 'cli-tools', ...) : path.resolve(__dirname, '..', 'cli-tools', ...)`.
- ✅ Native .dylib/.so/.node резолвится через `require.resolve` →
  rewrite `app.asar/` → `app.asar.unpacked/`, плюс `asarUnpack` правило.
- ✅ Write куда-либо рядом со скриптом (sessions, кэш, лог) → менять
  на user-dir (`~/Library/Application Support/sc-desktop/...`),
  либо явный prod-fallback.
- ⚠ extraResources filter включает только `**/*.py` + `config.env` +
  явные исключения. Любой новый non-Python ресурс из cli-tools (json,
  txt, csv, sqlite-template) — добавляй в filter явно или будет
  silently отсутствовать в bundle.
- ✅ Вызываешь внешний бинарь по короткому имени (`yt-dlp`, `ffmpeg`,
  `pbcopy`, `afplay`) из Python-subprocess'а — main.js уже augment'ит PATH
  brew/macports путями, ничего делать не надо. Если нужен бинарь из
  нестандартного места (например `~/.local/bin`) — добавь в массив `extra`
  в main.js.

## 🔗 Связанное

- Venv Python захардкожен на `/Users/fedor/Desktop/telethon/venv/bin/python3`
  (`job-runner.js::VENV_PYTHON`). Переезд на другую машину = указать новый
  путь или bundling Python (что не сделано).
- `fact-telegram-sessions.md::Где живут session-файлы` — дев/прод
  fallback и почему bundle не содержит sessions.
