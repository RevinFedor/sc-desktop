# Knowledge: Yandex Maps search через browser MCP (`yandex_maps_search`)

Инструмент `yandex_maps_search` в **browser MCP** (`mcp/browser/index.js` + handler
`mcp_yandex_search` в `browser-extension/mcp-handlers.js`). Ищет организации на
Яндекс.Картах и отдаёт структурированные данные (title, address, coordinates,
phones, **site**, socials, rating, working hours, categories) **без API-ключа**.

Главный use-case: «найти клиники по теме → получить их сайты → зайти на каждый
сайт (`navigate`+`get_text`/`evaluate`) → вычитать врачей/услуги/профиль». То есть
заменяет ручной гугл-обход каждой клиники, который юзер раньше делал руками.

## Почему НЕ платный API и НЕ HTML-парсинг

Три способа получить данные Яндекс.Карт, проверены руками:

1. **Официальный Search API** — от 150 000 ₽/год за 1k запросов/сутки. Полноценного
   бесплатного тарифа для HTTP Search API нет. Готовые MCP (`@theyahia/yandex-maps-mcp`,
   `peschinskiy/...`) ходят в этот же платный API — тупик.
2. **Парсинг HTML выдачи** — боль со скроллом, виртуализацией, разметкой.
3. **✅ Встроенный SSR-state** — то что мы используем. Яндекс при загрузке
   `/maps/<region>/search/<query>/` встраивает весь результат выдачи в HTML
   (inline `<script>`). Читаем его из MAIN world. Бесплатно, структурировано,
   без скролла.

## Как это работает (детерминированно)

```
1. (своя фоновая вкладка) navigate на yandex.ru/maps/<regionId>/<citySlug>/search/<query>/?ll=&spn=&z=[&page=N]
2. ждём load complete (SSR-state приезжает в HTML)
3. chrome.scripting.executeScript({world:'MAIN', func: extractYandexSearch})
   → парсит встроенный searchResult, нормализует items[]
4. (цикл по страницам с дедупом — см. «Пагинация»)
5. возврат {area_covered, total_in_area, fetched, remaining, complete, pages_fetched, stop_reason, results[]}
```

`has_more` — внутреннее поле одной страницы (`extractYandexSearch`), наружу
инструмент его не отдаёт: после цикла пагинации истину о полноте несёт
`complete` (см. «Пагинация»).

**Локация = URL-параметры, НЕ скролл.** Нейронка не «угадывает где юзер» и не
скроллит карту. Регион задаётся `region` (`spb`→2, `msk`/`moscow`→213, или числовой
id), центр области — `ll` (lon,lat), охват — `spn` (dLon,dLat). Широкий spn ≈ весь
город, узкий ≈ пара кварталов. Без region Яндекс определяет регион из текста
(«осанка спб»).

**Число результатов = функция от (текст, область), не «город вообще».** Проверено:
«кафе» в 3-км квадрате = 16; «остеопат внчс» по всему СПб (spn 0.66×0.30) = 70.
`area_covered` (bbox) и `total_in_area` возвращаются в каждом ответе → **не чёрный
ящик**: всегда видно какую область покрыли и сколько всего там есть.

## Stateless — состояние «сколько осталось» держит Claude, не storage

Каждый вызов возвращает свежий `total_in_area` (ground truth от Яндекса) +
`fetched` + `remaining` + `has_more`. Нейронка держит «забрал 25 из 70, осталось
45» в своём рабочем контексте. **Не** персистим курсор в storage — потому что:

- Внутренний `/maps/api/search` подписан HMAC-параметром `s` по всему query string;
  любое изменение (text, ll, page, results) → `400 Bad Request`. Реплей замороженного
  URL хрупок (подпись + csrfToken ротируются).
- Поэтому мы вообще не реплеим API — читаем SSR-state, который фронт уже отрендерил.
  Каждый ответ самодостаточен и самопроверяем.

## Поля результата (`results[]`)

| Поле | Источник в item | Заметка |
|---|---|---|
| `title` | `title`/`shortTitle` | |
| `address` | `fullAddress`/`address` | |
| `coordinates` | `coordinates` | `[lon, lat]` |
| `phones` | `phones[].formatted` | массив |
| `site` | `urls[0]` / `businessLinks[].link.href`, **очищен** | без `?yclid/utm_*` — для `navigate()` |
| `sites` | все ссылки, очищены | **опционально** — только если есть 2-я реально отличная от `site`; иначе поля нет (дубль `site` = лишний вес) |
| `socials` | `socialLinks[].{type,href}` | чистятся + дедуп по типу (см. «Вес ответа») |
| `rating` | `ratingData.{ratingValue,ratingCount,reviewCount}` | `{score, votes, reviews}` |
| `working_time` | `workingTimeText` | «пн-сб 09:00–20:00» |
| `open_now` | `currentWorkingStatus.text` | «Закрыто до завтра» |
| `categories` | `categories[].name` | |
| `id`, `seoname` | | для дедупа/ссылок |

Сайт в выдаче приходит с рекламными хвостами (`?yclid=…&utm_…`) — `cleanUrl()`
срезает их в `site`. Поле `uri` (`ymapsbm1://org?oid=…`) из norm убрано — наружу
не нужно, дедуп идёт по `id`.

## Извлечение SSR-state (`extractYandexSearch`, MAIN world)

Две стратегии по убыванию надёжности:
1. **Глобалы** — `window.__INITIAL_STATE__` и подобные (`deepFind` рекурсивно ищет
   объект с `items[]` + `totalResultCount`). Доступно только из MAIN world.
2. **Fallback: парсинг inline-`<script>`** — поиск `"totalResultCount"`, извлечение
   охватывающего JSON-объекта балансировкой скобок (`balancedSlice`), `JSON.parse`.
   Ветка `inline-direct` работает и из USER_SCRIPT world — поэтому логику можно
   тестировать через `evaluate_raw` до релоада handler'а.

`extractYandexSearch` обязана быть **самодостаточной** (инжектится в MAIN world,
никаких замыканий на SW-scope).

## MAIN world инжект, не `evaluate_raw`

Handler инжектит функцию через `chrome.scripting.executeScript({world:'MAIN'})`:
- обходит CSP (это инжект функции, не `eval` — `new Function` не нужен);
- видит window-глобалы страницы (USER_SCRIPT world их НЕ видит — ключевое отличие
  от `evaluate_raw`);
- не требует toggle «Allow user scripts»;
- нативная сериализация (socials приходят полными `{type,href}`, не `[Object]` как
  при `evaluate_raw` с maxDepth).

Permissions есть в manifest: `scripting` + `<all_urls>`.

## Фоновая служебная вкладка

По умолчанию (`tabId` не передан) инструмент **создаёт собственную вкладку**
`chrome.tabs.create({active:false})` + `autoDiscardable:false` и листает страницы
в ней — вкладки юзера не трогаются, он продолжает работать в браузере. В конце
вкладка закрывается в `finally` (на успехе и на ошибке). Если передан явный
`tabId` — работаем в нём, не создаём и не закрываем.

**Шрам: `finally` мог закрыть активную вкладку юзера.** `workTabId`
инициализируется как `targetTabId` (= активная вкладка, когда `tabId` не передан).
Если `chrome.tabs.create` отработает, но вернёт объект без числового `id`,
`workTabId` остался бы активной вкладкой — и `finally` закрыл бы **её**. Защита:
флаг `ownTab` поднимается в `true` **только после** успешного create с валидным
`id`; `finally` закрывает вкладку лишь при `ownTab`. Цена ошибки высокая (снести
рабочую вкладку юзера), поэтому проверка явная, не «обычно create не падает».

**Почему freeze never-active вкладки тут не страшен.** `fact-deep-research.md::Tab
freezing` описывает как Yandex/Chrome замораживают вкладку, ни разу не бывшую
active (throttling таймеров, discard). Тот freeze бил по **пассивному** 30-мин
ожиданию research'а через MutationObserver/`setInterval`. Здесь модель другая:
активный навигационный цикл (каждая страница — свежий `tabs.update` + немедленное
чтение SSR), данные уже в HTML на момент load, чтение идёт через extension-API
(`chrome.scripting`, не page event loop), а `autoDiscardable:false` не даёт
выгрузить вкладку между навигациями. Проверено на живой never-active вкладке:
`visibilityState:"hidden"`, SSR-state доступен, навигация page1→page2 работает.

## Вес ответа — чистка socials под лимит токенов

При `max_pages:"all"` полная выдача (39 орг с полями) **превышала лимит токенов
одного MCP-результата** (56 KB / 1788 строк → tool-result обрезался в файл). Замер
по полям показал: `socials` = **40% веса** ответа. Причина — мессенджер-ссылки
вида `https://wa.me/79…?text=Обращение+из+Яндекс+Карт%0AЗдравствуйте!…` несут
сотни символов urlencoded-текста, и один бизнес даёт 6-10 соцсетей.

Лечение в нормализаторе:
- `cleanSocial()` режет query у `wa.me`/`viber`/`t.me` (номер уже в path,
  `?text=…` не нужен);
- дедуп по `type` — оставляем первую ссылку каждого типа (бывало 3 whatsapp подряд);
- `sites` отдаём только если есть 2-я реально отличная от `site` (иначе дубль).

После — полная выдача влезает в один ответ.

## Пагинация — реализована через `?page=N` (НЕ скролл)

Параметр `max_pages`: `1` (дефолт) — первая страница; число N — авто-листание до N
страниц; `"all"`/`0` — до конца выдачи (hard cap 40 страниц).

**Механизм — нумерованные страницы, не бесконечный скролл.** В DOM выдачи есть
`<ol class="seo-pagination-view">` со ссылками `?page=2`, `?page=3`… (1-based:
`page=1` = первая = дефолт). ~25 орг на страницу. Догрузка скроллом завязана на
IntersectionObserver реального scroll-события и **не будится** синтетическим
`scrollTop`/`wheel`/MCP `scroll_element` (проверено 3×) — поэтому листаем
навигацией на `?page=N` и читаем SSR-state каждой страницы той же
`extractYandexSearch`.

**Область надо пинить `ll`+`spn` для консистентной пагинации.** Без явных координат
navigate на `?page=N` смещает вьюпорт карты → `bounds` и выдача «плывут» между
страницами (проверено: `total` скачет 69→40, результаты не стыкуются). С
зафиксированными `ll`+`spn` `bounds` идентичен на всех страницах.

**Дедуп по `id`** (Map). Между соседними страницами бывает 1-2 дубля (выдача
динамическая) — дедуп их отсекает.

**Условия останова** (`stop_reason`):
- `no_new_results` — страница не дала ни одного нового id → выдача исчерпана;
- `last_page_short` — страница вернула < perPage (≈25) → последняя;
- `max_pages` — достигнут лимит вызывающего;
- `page_error` — навигация/инжект упали на N>1 (возвращаем что собрали).

**`total_in_area` нестабилен и потому справочный.** Яндексовый `totalResultCount` —
релевантностная оценка, плавает между страницами даже при фиксированной области
(70 на page1, 40 на page2). Поэтому в ответе `total_in_area` = max наблюдённый
(не меньше реально собранного), а **истина о полноте — флаг `complete`**
(true ⇔ stop_reason `no_new_results`/`last_page_short`). `remaining` = 0 если
`complete`, иначе `total - fetched` (оценочно). `fetched` = число уникальных
собранных — это всегда точно.

Пример («остеопат внчс», ll=30.32,59.93 spn=0.5,0.4, max_pages="all"): page1=25 id,
page2=15 (14 новых, <25) → стоп `last_page_short`, `fetched=39`, `complete=true`,
`pages_fetched=2`.

## Шрамы (что НЕ делать)

- ❌ **Не реплеить `/maps/api/search` с модифицированным query.** Подпись `s` = HMAC
  по всему query. Любое изменение → 400. Читать SSR-state, не дёргать API.
- ❌ **Не ловить запрос через `PerformanceObserver`/resource-buffer.** Недетерминированно:
  observer может стартовать после запроса; input+submit = no-op если текст в поле уже
  тот же → 0 запросов; «брать последний» ловит чужой запрос (был случай: вернулся
  **Оренбург** вместо СПб из-за гонки suggest+старый+новый). Только навигация на
  канонический `/search/` URL + чтение SSR-state.
- ❌ **Не доверять полю `pageCount` как числу страниц.** Это **размер** страницы
  (`results`), не количество. «остеопат»: `total=86, pageCount=25`. Число страниц =
  `ceil(total/perPage)`, считать самим.
- ❌ **Не использовать USER_SCRIPT world (`evaluate_raw`) для чтения глобалов страницы.**
  Он их не видит. Глобалы — только через MAIN-world инжект. Inline-script парсинг
  работает в обоих мирах (потому тестируется через `evaluate_raw`).

## Применение изменений

- `mcp-handlers.js` — часть расширения, hot-reload за ~30 сек (или `force_reload_extension`).
- `index.js` — MCP-сервер, спавнится на старте Claude-сессии. Изменения сигнатуры
  tool (новый параметр, новое описание) видны только **после перезапуска
  Claude-сессии**. Логику самого handler'а (extraction, цикл пагинации) можно
  проверить заранее без перезапуска через `evaluate_raw`-прокси (ветка inline-direct
  работает и в USER_SCRIPT world) — что и делалось при разработке.
