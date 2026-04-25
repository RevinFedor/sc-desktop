# Fix: StrictMode + dedup-Set + alive-flag = setState дропается

## Симптом

YouTubeBatchPicker в search-mode вызывает `ytItemsStateGlobal({video_ids})` чтобы подсветить ✓ на видео уже-сохранённых в БД. IPC отрабатывает, возвращает 1+ совпадение, но **`setVideos` никогда не вызывается** — ✓ не появляется на строке.

Признак: дебаг через `window.__lastPickerLookup = {idCount: 30}` и `window.__lastPickerResult = {rows: 1}` — оба set'ятся, а `window.__lastMergeCount` остаётся `undefined`. Значит callback внутри `setVideos(prev => ...)` не вызвался.

## Что происходит

Стандартный паттерн async-effect'а:

```jsx
useEffect(() => {
  let alive = true
  fetch(...).then(rows => {
    if (!alive) return     // canonical guard
    setVideos(prev => prev.map(...))
  })
  return () => { alive = false }
}, [deps])
```

Плюс наш dedup чтобы не дёргать IPC дважды на одни ids:

```jsx
const lookedUpIdsRef = useRef(new Set())
useEffect(() => {
  const ids = providedVideos.filter(v => !lookedUpIdsRef.current.has(v.video_id))
  if (ids.length === 0) return
  for (const id of ids) lookedUpIdsRef.current.add(id)
  fetch(...).then(...)
}, [...])
```

Под StrictMode (dev only) каждый useEffect монтируется-размонтируется-монтируется заново ради проверки cleanup-логики. Цепочка событий:

1. **Mount #1.** `ids=[30 video_ids]`. Все добавляются в `lookedUpIdsRef`. IPC выпущен. `alive = true`.
2. **Cleanup #1** (StrictMode сразу). `alive = false` (closure локальная для mount #1).
3. **Mount #2.** `ids = providedVideos.filter(v => !lookedUpIdsRef.current.has(v.video_id))` — все уже в Ref → `ids.length === 0` → `return`. IPC не выпускается. `alive` не создаётся — но это и не важно.
4. IPC от mount #1 резолвится. `alive` (mount #1) === `false` → `if (!alive) return` → setVideos дропается.

Результат: данные пришли, callback не выполнился, ✓ не появилось.

## Решение

**Убрать `alive` flag целиком** в этом конкретном эффекте.

```jsx
useEffect(() => {
  const ids = providedVideos.filter(v => !lookedUpIdsRef.current.has(v.video_id))
  if (ids.length === 0) return
  for (const id of ids) lookedUpIdsRef.current.add(id)
  fetch(...).then(rows => {
    if (!Array.isArray(rows) || rows.length === 0) return
    setVideos(prev => prev.map(...))
  })
}, [...])
```

`setVideos` после unmount в React 18 — benign warning, не баг. В dev иногда логируется `Can't perform a React state update on an unmounted component`, но в prod подавляется. В обмен получаем reliable single-fire merge.

Это безопасно потому что:
- Dedup-Set уже гарантирует что IPC выпускается ровно один раз на (provided ids).
- Идемпотентный merge — повторный setVideos с тем же результатом не сделает вреда.
- Закрытие `byId`-мапы локально для callback'а — никаких side-effects на другие компоненты.

## Что пробовали и почему не сработало

1. **deps swap `[videos]` → `[videos.length]`.** Не помогло: эффект всё равно дёргается на каждое изменение длины (paginate +30) → race с parent-sync эффектом, который сетит `videos = providedVideos` без cache → перезатирает merge.

2. **Provided-sync effect делает no-op detection (если ids совпадают и cacheById пустой → return prev).** Помогло убрать одну петлю, но не решило главное — IPC promise всё равно был мёртв из-за StrictMode-cleanup.

3. **deps `[providedVideos]` → `[providedIds]` (joined string id-list).** Стабильная dep на одну round-trip. Помогло убрать второй re-fire эффекта, но `alive`-flag всё ещё сидел в callback и резал merge.

4. **`alive = true` через `useRef`** (общий для всех mount'ов). Не сработало: первый mount cleanup всё равно ставит `false`, второй mount его не сбрасывает (ids уже в Ref → effect возвращает раньше assignment'а).

Итог: alive-flag в этом конкретном паттерне **противоречит** dedup-Set. Любой из них работает в одиночку — в комбинации они блокируют друг друга.

## Когда применять

Этот fix не универсальный «alive-flag — антипаттерн». В большинстве async-эффектов `alive` нужен (race между двумя fetch'ами на одни и те же deps). Симптом, который однозначно указывает на эту ловушку:

- Effect использует **dedup через ref/cache** (Set, Map, last-fetched-ids) ВНУТРИ функции.
- Эффект может срабатывать в StrictMode дважды.
- IPC/fetch резолвится **между** двумя mount'ами.

Если все три условия — alive-flag будет блокировать единственный live-mount. Решение — выбрать **либо** alive (без dedup), **либо** dedup (без alive).

## Связанные

- `fact-youtube.md::Search-picker: ✓ для уже-сохранённых` — где этот фикс применён.
