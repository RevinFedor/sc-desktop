# Knowledge: Console Interceptor & File Logging

`electron/logger.js` — портирован из `~/Desktop/custom-terminal/src/main/main.js:48-127`. Совпадает один в один по контракту, потому что эта схема показала себя в production: дешёвая, без сторонних libraries, читается `tail -f`.

## 📜 Контракт `[Tag]` префикса
```js
console.log('[Jobs] start tg_fetch #1')   // ✅ попадает в файл
console.log('Jobs: started')              // ❌ только stdout, в файле ничего

console.error('something broke')          // ✅ всегда пишется как [ERROR] something broke
console.error('[Jobs] save failed', err)  // ✅ пишется как есть (тег уже есть)

console.warn('[Telethon] deprecated')     // ✅ tag → файл
console.warn('something deprecated')      // ❌ только stdout
```

**Зачем такой контракт:** Electron сам по себе сыпет в console кучу шума (DevTools `Autofill.enable failed`, deprecation warnings от node, GPU process logs). Без фильтра файл-лог за неделю превратится в 500MB мусора. Tag-prefix — тривиальный, безусловный фильтр, не требующий поддержки.

**Соглашения по тегам:**
- `[Startup]` — initialisation, app lifecycle
- `[Jobs]` — job-runner транзишены
- `[IPC]` — IPC handlers (если нужно)
- `[ERROR]` — добавляется автоматически если console.error без тега
- `[uncaughtException]`, `[unhandledRejection]` — глобальные ловушки в logger.js

## 🗂 Пути логов
| Среда | Путь |
|-------|------|
| Dev (`npm run dev`) | `~/Desktop/sc-desktop/logs/dev.log` |
| Production (`.app`) | `~/Library/Logs/SC Desktop/production.log` (через `app.getPath('logs')`) |

Логгер инициализируется **первым** в `main.js` — до `require('./job-runner')`. Это нужно чтобы любой ранний crash в зависимостях попал в файл, а не только в stdout (в production запуске `.app` нет stdout вообще).

## 🔁 Дедупликация повторов
Подряд идущие одинаковые строки схлопываются в `×N`:
```
07:24:03.075 [Jobs] start tg_fetch #1 target=durov mode=last_n limit=50
  ×3
07:24:08.102 [Jobs] end #1 status=done items=50
```

**Зачем:** в горячих циклах (например `[Telethon] iterating page`) одинаковые строки могут лететь сотнями. Без dedup лог пухнет, ничего не видно. С dedup ×N сжимает шум в одну строку.

**Реализация:** `lastLine` + `dedupCount` в closure. При **первой** новой строке — сначала flush'ит `×N` для предыдущей, потом пишет новую. На `process.on('exit')` тоже флаш — иначе теряется счётчик последней группы.

## 🧹 Ротация
Только по возрасту: если файл старше 7 дней — переименовать в `.old`. **Без size cap** — длинная сессия может писать много, и обрезание её посредине ломает контекст для дебага.

## 🚫 Что НЕ делать
- Не создавать отдельные logger-объекты (`pino`, `winston`). Перехвачены глобальные `console.*`, этого достаточно.
- Не вызывать `fs.appendFile` напрямую для своих логов — пиши через `console.log('[Tag]')`.
- Не удалять `[Startup]` лог в `main.js` — это маркер сессии, по нему ориентируешься в `.log` файле.
- Не отключать crash hooks (`uncaughtException`, `unhandledRejection`) — они единственный способ узнать что упало в production без DevTools.

## 🪤 Не запускать `npm run dev | tee logs/dev.log`

> **Симптом:** POST к bridge'у виснет (curl 28-timeout), `GET /healthz` работает. Electron на 99% CPU, лог содержит `Error: write EPIPE` + stack trace в `electron/logger.js:74` (`console.log` → `Socket._writeGeneric` → `EPIPE`). Bridge не отвечает, перезапуск не помогает — те же зависания.

`logger.js` интерсептит `console.log/.warn/.error` и **внутри** делает оригинальный `process.stdout.write` ПЕРЕД записью в файл. Когда `npm run dev` запущен через pipe в `tee`, и tee/concurrently/parent shell умирает или закрывает stdin — следующая запись в stdout кидает **EPIPE**. EPIPE улетает в наш `uncaughtException` handler. Handler **сам** пишет `console.error('[uncaughtException]', ...)` → opnova `process.stdout.write` → новый EPIPE → infinite loop unhandled errors. Bridge перестаёт обрабатывать новые requests — Node event loop забит cycle'ами exception handling.

**Решение**: запускать `npm run dev` **без tee**. `electron/logger.js` сам пишет в `logs/dev.log` через `fs.appendFile`. Терминальный stdout — опционален, не critical path. Для tail'а лога: `tail -f logs/dev.log` в отдельном окне, не через pipe запуска.

Альтернативное решение (если очень нужен tee): обернуть `process.stdout.write` в try/catch в `logger.js`, EPIPE подавлять silently. Но это **скрывает** другие потенциальные stdout-проблемы — лучше избегать tee.
