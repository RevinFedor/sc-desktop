# Knowledge: Data Bus + Job Invalidation

Renderer-side инвалидация данных через **один** listener `job:update` и pub-sub
по строковым ключам. Заменяет ad-hoc `onJobUpdate` в каждом компоненте, которые
плодились со временем (`useSources`, `SourceDetail`, ChatView без него →
counts уплывали).

## 🎯 Зачем именно bus, а не "сделать в каждом компоненте"

Когда компонент сам слушает `window.api.onJobUpdate` — каждое новое место
дублирует логику «терминальный статус? связан со мной? рефетч». Тип ошибки —
не сам факап, а его **отсутствие**: добавили ChatView с topics/breakdown,
забыли подписаться → юзер видит stale data после fetch'а пока не уйдёт-вернётся.

Bus решает по принципу: маппинг event → ключи живёт **в одном файле**, и при
добавлении новой фичи прописываешь только подписку на ключ. Регрессия типа
«забыл рефетч после fetch» становится невозможной — ключ либо есть, либо нет.

## 📍 Конвенция ключей

```
'sources'             — список источников (sidebar)
'source:<id>'         — header/stats/coverage страницы источника
'items:<id>'          — items list, topics, type breakdown, senders для одного source
'jobs:<id>'           — список jobs в "История парсинга" одного source
```

Кто подписан:
- `useSources` (sidebar) → `'sources'`
- `SourceDetail.reloadAll()` → `'source:<id>'`
- `SourceDetail.reloadJobs()` → `'jobs:<id>'`
- `ChatView` (topics, type breakdown, items) → `'items:<id>'`
- `CopySavedPanel.estimate` → `'items:<id>'`

Compose: `useInvalidator(key)` возвращает counter — кладёшь в `useEffect` deps,
рефетч происходит автоматически.

## ⏱ Throttling прогресса

`tg_fetch` на 5000 сообщений = ~50 page-events (Python emit'ит каждые 100 items).
Без троттлинга это 50 React-render storm на главном экране за 50 секунд.

**Симптом до фикса:** во время большого парсинга скролл в SourceDetail дёргался,
ChatView reset'ил пагинацию каждые 100мс, picker не давал кликать — экран
жил «отдельной жизнью».

**Контракт `jobInvalidation.js`:**
- terminal (`done`/`error`/`cancelled`) — бьём всё: `'sources'`, `'source:<id>'`,
  `'items:<id>'`, `'jobs:<id>'`. Здесь стало действительно новое — saved counts,
  coverage rows, etc.
- progressing (`running`/`awaiting_ai`) — **только `'jobs:<id>'`**, и троттлим
  до раз в 750мс на jobId. Sidebar и items list deliberately стоят пока fetch
  идёт — там ничего не изменилось до close.

Окно 750мс — компромисс: глаз не успеет прочитать счётчик чаще, а DB-round-trips
сжимаются до ~70 за 50-секундный fetch против 50 без троттла.

## 🪶 Live-хвост ChatView во время `tg_fetch`

Live-сообщения в ChatView — не исключение из правила «progressing бьёт только
`jobs:<id>`». Они едут внутри лёгкого job-snapshot (`tg_live_items` +
`tg_current_item`) и мержатся с уже загруженной страницей в памяти по
`external_id`. На каждый item нельзя инвалидировать `items:<id>` или звать
`itemsList()` заново: это возвращает тот же render-storm, ради которого bus
делили на тяжёлые и лёгкие ключи. Terminal-status всё ещё бьёт `items:<id>` —
после финального DB write временные live-строки заменяются обычными строками из
БД.

`tg_live_items` — capped tail, а не новый канал persistence. Держать хвост
коротким (сейчас 120), строки показывать read-only: у них ещё может не быть
стабильного DB id, `media_path`, transcript/result-полей, поэтому checkbox/copy/
reprocess по ним создают race с финальным upsert. В поиске live-хвост скрыт:
поисковая выдача должна быть полным ответом БД, а не смесью «что нашлось» и
«что только что прилетело». Footer при этом остаётся и сообщает, что загрузка
идёт в фоне.

`tg_current_item` существует не ради рендера списка, а ради ответа на вопрос
«что именно сейчас парсится?». Если есть `media_phase.current`, она важнее
обычного current-item: пользователю полезнее видеть «#123 · документ ·
извлекаем», чем общий «#123 · document». Цвет строки или серый placeholder не
считаются объяснением состояния.

Сортировка `Дата ↑` для Telegram тоже не должна менять DB-query на
`published_at ASC LIMIT ...`. Для больших чатов это открывает архивный край
чата, а не текущий диалог. Chat-like вид строится так: SQLite всё равно отдаёт
freshest window (`DESC`), а renderer визуально переворачивает окно, чтобы старые
были сверху, новые снизу. `Дата ↓` просто показывает то же окно newest-first.

## 🔀 Split refresh-paths в SourceDetail

`sourceDetail(id)` IPC возвращает **тяжёлый** объект: header, typeBreakdown,
senders, coverage, jobs, dateRange — всё одним пакетом. На progress-инвалидации
это перебор.

Поэтому:
- **`reloadAll()`** — на `source:<id>` invalidate (только terminal). Тянет
  весь sourceDetail. Рендерится header/CoverageBars/SendersBlock.
- **`reloadJobs()`** — на `jobs:<id>` invalidate (включая throttled progress).
  Дёргает лёгкий `jobs:listForSource` и делает `setData(prev => { ...prev, jobs })`
  — обновляется только массив `data.jobs`, остальные children не перерендерятся
  (React reference equality сохраняется на typeBreakdown / senders / coverage).

**Тонкость:** первый mount запускается через `reloadAll()`, поэтому `jobsVer`
эффект пропускает первый run через `useRef(true)` flag. Иначе на mount шёл бы
двойной fetch — sourceDetail() + jobsListForSource() параллельно.

## ➕ Как добавить новую фичу

1. Решить, какой ключ ей нужен. Для большинства — это `'items:<sourceId>'`
   (всё что зависит от saved items). Для глобального — `'sources'`.
2. В компоненте: `const ver = useInvalidator('items:42')` → `useEffect([..., ver])`
   с рефетчем.
3. Если новый job-type кладёт в БД что-то новое — обновить маппинг в
   `jobInvalidation.js::wireJobInvalidation`. Если просто пишет items —
   ничего, существующая логика покроет.

## 🪤 Что отбросили

- **Полный рефетч на каждый `job:update`.** Простой, но создавал тот самый
  scroll-storm. Throttle мог бы помочь, но без split на light/heavy всё равно
  тянул бы весь sourceDetail() каждые 750мс.
- **Подписка на конкретный jobId через `watchJob(id)`.** Используется в формах
  для отслеживания одного long-job'а (см. `TelegramConfigForm` для preview),
  но как replace для `useSources`/`SourceDetail` не подходит — компонент не
  знает о jobs до их старта.
- **TanStack Query / SWR.** Overkill для desktop без сетевых fetch — у нас
  всё IPC локальное, queryKey-инвалидация ровно соответствует нашему bus, но
  тащить ~50KB зависимостей ради 30 строк кода нерационально.
