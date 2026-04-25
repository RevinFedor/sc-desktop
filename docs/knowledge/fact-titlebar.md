# Knowledge: Title Bar & Traffic Lights

Окно — **frameless** (`titleBarStyle: 'hidden'` + `titleBarOverlay`). Это даёт нам управление всей шапкой как обычным DOM, но требует осторожности с двумя вещами: **drag region** и **traffic-light overlap**.

## 📐 Reservation для трафик-лайтов
```css
.titlebar {
  -webkit-app-region: drag;
  padding-left: env(titlebar-area-x, 78px);
}
```

`env(titlebar-area-x)` — Electron на macOS подставляет реальную ширину overlay'а трафик-лайтов. Fallback `78px` подобран эмпирически под macOS 26 (3 кружка × ~14px + межбуквенные зазоры + edge padding).

**Если поставить `0` или забыть** — текст «SC Desktop» будет под красным/жёлтым/зелёным кружком. Юзер сначала видит «текст плывёт», потом понимает что левая часть title bar — мёртвая зона. См. скриншот feedback'а в session log.

**Если поставить слишком много (85px+)** — текст отъезжает правее центра трафик-лайтов. Тоже визуальный disbalance.

## 🖱 Drag/no-drag каскад
Главное правило: `-webkit-app-region: drag` **наследуется ребёнком только если ребёнок-flex-child тоже его получил**. Это контринтуитивно — без явного применения к детям клик по любому child-элементу не таскает окно.

```css
.titlebar > * {
  -webkit-app-region: drag;
}

.titlebar .no-drag,
.titlebar button,
.titlebar input,
.titlebar [role="tab"] {
  -webkit-app-region: no-drag;
}
```

Без `.titlebar > *` — окно таскается только за пустые промежутки flex (например `flex-1` спейсер). Это subtle UX-bug который заметил пользователь — поэтому правило явное.

### Слой ПОВЕРХ titlebar'а тоже нуждается в no-drag

Drag-region — **геометрическая зона окна**, а не CSS-свойство элементов под ней. Любой элемент, отрендеренный поверх titlebar'а (popover из него, fullscreen-оверлей `fixed inset-0`), наследует drag-поведение в этих верхних 40px, если сам не объявил `no-drag`.

**Как выглядит:** клик по div-карточке с `onClick` внутри popover'а «Запущенных MCP» молча не срабатывал — выглядело как сломанный React-handler (юзер: «не могу нормально кликнуть на блок»), на деле клик ТАСКАЛ ОКНО. Кнопки внутри popover'а при этом работали — их спасало правило `.titlebar button { no-drag }`, что дополнительно маскировало причину («кнопки кликаются, div нет → значит дело в React»). Ни ошибки, ни лога — drag не event.

**Правило:** корень любого popover'а, смонтированного внутри `.titlebar`, и любого fullscreen-оверлея (QuickOpen backdrop) получает класс `no-drag`. Иначе верхние 40px оверлея таскают окно вместо клика/закрытия.

## 📏 Высота 40px
Это число **зашито в `titleBarOverlay.height`** в `main.js` и **должно совпадать** с `h-10` (Tailwind = 40px) на `.titlebar` в App.jsx. Если разойдутся — overlay покроет часть контента или оставит пустую полоску.

Размер выбран потому что трафик-лайты на macOS центрируются в overlay'е по высоте — 40px даёт ~13px от края до кнопки, выглядит сбалансированно. Меньше 36px — кнопки залезают в content. Больше 44px — лишний пустой бар.

## 🎯 Вертикальное центрирование контента
```jsx
<div className="titlebar h-10 flex items-stretch">
  <div className="flex items-center px-3 leading-none">  {/* ← items-center */}
    SC Desktop
  </div>
</div>
```

Используем `items-center`, **не** `items-end` или baseline. Трафик-лайты macOS сами центрированы в 40px overlay'е по вертикали — наш текст должен совпасть с их центром. Это особенно важно при разных размерах шрифта (если будут tabs в title bar).

`leading-none` — потому что иначе flex считает height с учётом line-height множителя, и `items-center` центрирует по «коробке» line-box, а не по самому тексту.

## 💡 DevTools docked-right в dev
```js
const APP_WIDTH      = 1700
const APP_HEIGHT     = 1000
const DEVTOOLS_WIDTH = isDev ? 320 : 0
new BrowserWindow({ width: APP_WIDTH + DEVTOOLS_WIDTH, height: APP_HEIGHT, ... })

if (isDev) win.webContents.openDevTools({ mode: 'right' })
```

Production окно — **1700×1000**. В dev добавляется 320px справа для встроенных DevTools → outer window 2020×1000. Так пользователю не нужно перетаскивать DevTools в нужное место каждый раз — они открыты сразу справа, как в `custom-terminal`.

`mode: 'right'` важен — `mode: 'detach'` создаёт отдельное окно, что путает (два окна в Dock, легко закрыть основное и не понять).

### DevTools width 320 — workaround
Electron не имеет публичного API для `openDevTools({ width })`. Chromium запоминает размер dock в своём prefs-файле, но в первый запуск использует ~30% окна (≈600px), что отнимает слишком много от приложения.

Решение — после `devtools-opened` event'а делаем `executeJavaScript` в DevTools webContents и пишем нужный размер в `localStorage`:
```js
win.webContents.devToolsWebContents.executeJavaScript(`
  localStorage.setItem('InspectorView.splitViewState', JSON.stringify({ vertical: { size: 320 } }))
`)
```

Chromium DevTools читает этот ключ при старте. После первого запуска можно вручную дёрнуть разделитель — Chromium сам запомнит, и наш hack становится no-op.
