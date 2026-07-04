# Knowledge: локальные файлы как «платформа»

Описывает paste-flow для абсолютных путей к видео/аудио на диске. Юзер копирует путь
из CleanShot/Finder/Sublime → ставит в Home → транскрибируется → результат в буфер.

## 🪤 Mental model — ephemeral platform

Локальный файл — **полноправная "платформа"** в `detect.js` (`platform: 'local'`,
`kind: 'local-file'`), но в Library не попадает. Каждый запрос — одноразовая
операция как YouTube single-video, без персистентного источника.

Это первый случай, когда paste-flow сознательно **не** ведёт к SourceDetail — у локального
файла **нет** сущности «канал/профиль/чат», нечего листать. Аналогично теперь работают:
YouTube search (там «канал» это search query, не подписчик), Telegram single-message
(см. ниже про `mode='single'`). Расширяет mental model в `fact-source-actions.md::Mental
model paste-flow ↔ SourceDetail-flow`.

## 🎯 Detection

`src/lib/detect.js::detect()` распознаёт **до** title-fallback:
- absolute path начинающийся с `/` или `~/`
- `file://` URI
- расширение из `LOCAL_AUDIO_VIDEO_EXT_RE` (mp4/mov/m4v/mkv/webm/avi/flv/wmv/3gp/mp3/m4a/wav/flac/aac/ogg/opus/aiff/aif/wma)
- кавычки и smart-quotes автоматически срезаются (CleanShot-paste часто оборачивает путь в `"..."`)

`.txt`/`.pdf`/`.json` сюда не попадают — это контент-расширения, не медиа.

## 🎙 Engine: AssemblyAI default

В отличие от YouTube single (где default `gemini` — дешевле и Gemini справляется
с короткими видео), для локальных файлов default `assemblyai`:
- юзер чаще пастит длинные screencast'ы (15+ мин), Gemini chunked-путь даёт хуже
  склейку чем нативный AssemblyAI long-form
- цена близкая, преимущества AssemblyAI на arbitrary user audio существеннее

Engine selector виден всегда — юзер может переключиться на Gemini одним кликом
если хочет дешевле для короткого файла.

## 🧨 Gotcha: Gemini-required init для AssemblyAI-пути

`gemini_utils.GeminiClient.__init__` поднимает `ValueError: GEMINI_API_KEY not found`
безусловно — даже если юзер выбрал `engine=assemblyai` и Gemini ни разу не дёрнется.
Симптом в проде: «выбрал AssemblyAI, нажал Транскрибировать — ошибка про GEMINI_API_KEY».

**Лечение в `python-workers/web/local_transcribe_ndjson.py`** (узкое, не трогает shared
gemini_utils):

```python
if args.engine == "assemblyai" and not os.environ.get("GEMINI_API_KEY"):
    os.environ["GEMINI_API_KEY"] = "unused-by-assemblyai"
```

Placeholder проходит constructor-check, на путь к API не попадает потому что для
assembly он не нужен. Альтернатива (правка `GeminiClient.__init__` чтоб ключ был
optional) — рискованнее, она ломает контракт shared-модуля который используют worker-скрипты.

## ⏱ Progress на длинных файлах (AAI polling)

Раньше `TranscribingPanel` показывал статичное «Транскрибация (assemblyai)…» — без таймера, без этапов. Юзер с 2-часовой записью смотрел на спиннер 30+ минут не понимая, идёт ли вообще что-то. Корень: `transcribe_audio` блокировал на `Transcriber.transcribe()` который не отдаёт промежуточных состояний.

**Что есть теперь.** В `gemini_utils.transcribe_assemblyai` если передан `progress_cb`, переключаемся на `Transcriber.submit()` + polling каждые 2 сек. Стадии:

| Stage | UI label |
|---|---|
| `uploading` | «Заливаем файл на сервер AssemblyAI…» |
| `queued` | «В очереди обработки…» |
| `transcribing` | «Транскрибируем · M:SS / ~ETA» |
| `completed` | «Получаем результат…» (мгновенный) |

ETA = `audio_duration_sec × 0.2` (universal-2 ~5x realtime, погрешность ±30%). Для AAI этого достаточно — точного процента модель не отдаёт, только статус.

**`local_transcribe_ndjson.py` ловит callback и emit'ит** `transcribe_progress` событие на каждый poll. Runner мерджит поля в `job.local.aai_*`, UI читает в `TranscribingPanel`.

**Gotcha: `silenced()` proxy для stdout.** Скрипт оборачивает вызов `transcribe_audio` в `with silenced():` чтобы заглушить богатый print-output Gemini. Без фикса наш `progress_cb` пишет в `sys.stdout` который — внутри блока — это `io.StringIO`, не настоящий stdout. Лечение: захватить **до** silenced'а:

```python
_REAL_STDOUT = sys.stdout  # captured at module init
def emit(event):
    _REAL_STDOUT.write(...)  # always real, even inside silenced()
```

## 📦 Persistence формы при возврате

При навигации (юзер уходит в Activity → возвращается на Home) форма `LocalFileTranscribeForm`
переоткрывает `done`/`error`/`transcribing` состояние через **lookup в `useJobs()`**:

```js
const allJobs = useJobs()
useEffect(() => {
  if (!path || stage !== 'idle' || job) return
  const match = allJobs
    .filter(j => j.type === 'local_transcribe' && j.target === path)
    .sort((a, b) => (b.started_at || 0) - (a.started_at || 0))[0]
  if (!match) return
  setJob(match); setStage(match.status === 'done' ? 'done' : ...)
}, [path])
```

Это переносимый паттерн для любой async-формы: stay stateless через rerender через global
job-list, не дублировать локальный store. Mount → ищет live/historic job по identity-полю
(`target = path`) → re-attach или показать финальное состояние. См.
`methodology/переносимый-дизайн.md::Persistent paste draft` — общий принцип.

Тот же подход применён в `TelegramSingleMessageForm` (identity = `params.url`, тип = `tg_fetch` с `mode='single'`). См. `fact-jobs.md::Voice transcription` — там добавляется ещё одна тонкость: dedup live vs historic по `file_path`, чтобы форма не подцепилась к terminal historic snapshot и не пропустила done-update от live job.

Без этого юзер кликнул «Транскрибировать», ушёл смотреть прогресс в Activity, вернулся —
форма пустая, кажется будто ничего не происходило. Симптом до фикса.

## 🗂 Files

- `src/lib/detect.js` — добавлен `LOCAL_AUDIO_VIDEO_EXT_RE` и `'local-file'` kind
- `src/components/LocalFileTranscribeForm.jsx` — inline форма
- `python-workers/web/local_transcribe_ndjson.py` — Python wrapper над `gemini_utils.transcribe_audio`
  (он сам делает ffmpeg `-vn` для видео → mp3, ничего особого мы не делаем)
- `electron/job-runner.js::startLocalTranscribe` — type `local_transcribe`, transcripts
  в `LIB_ROOT/transcripts/local/`, `source_id = NULL`
- `electron/main.js` — IPC `local:transcribe`
- `src/screens/JobDetail.jsx::LocalBody` — финальный read-only вид с Copy/Open/Reveal

JobDetail для local — `LocalBody` body. Активирован по `job.type === 'local_transcribe'`,
показывает basename + полный путь + размер + длительность + `AI · assemblyai` + Copy/Open
кнопки. Историческая запись восстанавливается через `rowToLocalSnapshot()` в job-runner
(аналог YT-варианта).

## 🪟 Recents

Сохраняется в `store.recents` как остальные. В Recent-чипе показывается только
basename файла, не полный путь (через `r.kind === 'local-file' ? path.lastIndexOf('/')+1 : ...`).

## 🚫 Что отбросили

- **Чистое аудио only.** Был вопрос — ограничивать `mp4/mov/...` или нет. Юзер пастит
  CleanShot-видео часто, `gemini_utils.transcribe_audio()` уже делает ffmpeg `-vn` для
  видео → принимаем всё.
- **Ограничивать тип `'local'`.** Думал делать `kind='local-video'`/`kind='local-audio'`
  раздельно — нет смысла, путь к файлу обрабатывается одинаково на бэке.
- **PlatformLogo для `local`.** Сделана своя SVG-«файл с треугольником play» — fallback
  ничего бы не показал, точка-цвет нечитаема среди других платформ.

## 🔗 Связанные

- `methodology/переносимый-дизайн.md::Persistent paste draft` — паттерн re-mount restoration
- `fact-source-actions.md::Mental model` — ephemeral paste-flow без SourceDetail
- `fact-jobs.md::Snapshot vs live job` — `local`-shape в snapshot
