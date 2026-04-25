# Fix: popover закрывается тем же кликом, что его открыл

## 🪤 Симптом

Кликаешь по триггер-кнопке — popover не виден, кажется будто `setOpen(true)` не сработал. Через DevTools видишь:
- onClick handler выполнился (можно проверить `console.log` или React DevTools)
- следующий рендер уже с `open=false`
- DOM popover ни на миллисекунду не существовал

Особенно сложно отследить через CDP `Input.dispatchMouseEvent` — событие проходит как настоящий клик, и проблема воспроизводится.

## 🔬 Корень

```jsx
useEffect(() => {
  if (!open) return
  function onDoc(e) {
    if (!wrapRef.current.contains(e.target)) setOpen(false)
  }
  document.addEventListener('mousedown', onDoc)   // ← регистрация в том же tick
  return () => document.removeEventListener('mousedown', onDoc)
}, [open])
```

**Хронология одного физического клика:**
1. `mousedown` стреляет — listener'а ещё нет (open=false), событие игнорится.
2. `mouseup` → `click` стреляет на button → `setOpen(true)` → React schedules re-render.
3. React commit-фаза → useEffect видит `open=true` → **синхронно** регистрирует listener.
4. Если CDP/тест отправляет mouseup отдельно от mousedown с задержкой, или если в браузере есть последующее `pointerdown`/`mousedown` (e.g. focus shift), оно ловится новым listener'ом → `e.target` всё ещё button (внутри `wrapRef`) → kept... но в реальности достаточно одного "паразитного" mousedown по странице (бывает в Electron при focus changes, в CDP при искусственных событиях) и он промахивается мимо ref → закрывает.

Реально проявляется чаще в одном кейсе: при **повторном** клике по той же кнопке. После первого `setOpen(true)` listener зарегистрирован. Второй `mousedown` на ту же кнопку проходит **до** onClick toggle, целит в button, но button уже **может быть размонтирована или re-mounted React'ом** между mousedown и click — тогда `wrapRef.current.contains(e.target)` возвращает false → `setOpen(false)`.

## 🩹 Лечение: задержать регистрацию на одну task

```jsx
useEffect(() => {
  if (!open) return
  function onDoc(e) { /* ... */ }
  function onKey(e) { /* ESC */ }
  const tid = setTimeout(() => {
    document.addEventListener('mousedown', onDoc)
  }, 0)
  document.addEventListener('keydown', onKey)
  return () => {
    clearTimeout(tid)
    document.removeEventListener('mousedown', onDoc)
    document.removeEventListener('keydown', onKey)
  }
}, [open])
```

`setTimeout(0)` отодвигает `addEventListener` на следующий event-loop tick — после того, как все события текущего physical click закончили propagation. ESC-listener регистрируется сразу: keyboard не страдает от race.

## 🪦 Что пробовали и почему не сработало

- **`onMouseDownCapture` на родителе грида + `stopPropagation` на самой панели.** Capture-фаза идёт **сверху вниз** — родительский handler срабатывает **до** того, как событие достигнет панели. `stopPropagation` на панели в этой фазе уже бесполезен.
- **`pointerdown` вместо `mousedown`.** Чистый порядок тот же, не лечит race.
- **`requestAnimationFrame` вместо `setTimeout(0)`.** Иногда работает, иногда нет (зависит от браузера и от того, сколько комит-фаз выполняется между rAF и mousedown).
- **Проверка `e.composedPath()` вместо `contains`.** Не помогает — проблема в timing'е, не в point-location.

## 📌 Когда применять

В **любом popover/dropdown/tooltip** который слушает `mousedown`/`pointerdown` на document для close-on-outside. Universal паттерн.

В нашем проекте — `src/components/DatePicker.jsx`. Если будут добавляться другие popover-компоненты (autocomplete, color-picker, custom-select) — копировать тот же `setTimeout(0)`-обвяз.

> **Альтернатива:** ловить `click` (после mouseup) вместо `mousedown` — тоже работает, но click bubbles из popover-контента (по пресетам, по дням сетки) которые сами вызывают `onPick → setOpen(false)` → если порядок click→listener плохой, возможно то же самое. `mousedown` + `setTimeout(0)` — самый предсказуемый вариант.

См. `methodology/переносимый-дизайн.md::Контролы` — общий принцип «outside-click в popover».
