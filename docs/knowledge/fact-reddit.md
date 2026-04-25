# Знание: Reddit (Search + Thread)

## 🔌 Backend'ы: api / auto / apify

**`api`** — прямой вызов `reddit.com/*.json` через залогиненные browser cookies. Бесплатно, быстрый default, **без платного fallback**. Если cookies не прочитались или Reddit вернул 403/429, job должен завершиться ошибкой, а не молча уйти в Apify.

**`auto`** — сначала `api`, затем fallback на `apify` только если бесплатный путь упал. Это явный paid opt-in для случаев когда важнее получить результат, чем гарантировать нулевой spend.

**`apify`** — сразу актор `trudax/reddit-scraper-lite`. Платный, но не зависит от локальных cookies.

Выбирается через `cfg.get('reddit', 'backend')` (`~/.config/sc/settings.json::reddit.backend`). По умолчанию `api`. В скриптах флаг `--backend api|auto|apify` перекрывает settings; в UI это показывается явно как `Free / Auto / Apify`. Старые/битые значения settings безопасно приводятся к `api`, чтобы не включить платный путь из-за мусора в конфиге.

### api: anonymous .json заблокирован, нужны cookies

Публичный `reddit.com/.../*.json` **с anonymous-IP отдаёт 403** (с 2024, через Cloudflare bot management). Любой User-Agent, любая подсеть — блок одинаковый. Это не баг, это глобальная политика Reddit против скрейперов.

**С залогиненной сессией** (`reddit_session` или `token_v2`) тот же endpoint отдаёт нормальный JSON (status 200) — авторизованным пользователям бот-фильтр даёт зелёный.

Cookies загружаются через `cli-tools/reddit/reddit_auth.py`: сначала `SC_REDDIT_COOKIE_HEADER` (удобно для тестов/bridge-интеграций), затем browser-cookie loaders (`firefox`, `chrome`, `chromium`, `brave`, `arc`, `edge`, `opera`, `opera_gx`, `vivaldi`, `safari`). В логах можно писать только источник и количество cookies, не значения. Важно: live browser MCP может видеть cookies в текущем профиле, но `browser_cookie3` читает только профили/браузеры, к которым у процесса есть доступ. Если текущий Chrome-профиль не читается, Firefox-сессия или env header остаются самым детерминированным путём.

### Что делать если api отвалился

В `backend=api` любой cookie/API failure → `error` и exit 7. Это намеренно: режим `Free` не должен тратить деньги из-за истёкшей сессии. Если пользователь готов платить за recovery, он выбирает `backend=auto`. Если нужен только актор без попытки cookies — `backend=apify`.

### Стоимость и скорость (фактически замерено, июнь 2026)

| Что | api | apify |
|---|---:|---:|
| Search 25 постов | ~$0, обычно 0.8-1.1s | раньше замерялось ~$0.14 |
| Search 100 постов | ~$0, обычно ~2.1s | платно |
| Thread 1 пост + 50 комментариев | ~$0, обычно ~0.9s | раньше замерялось ~$0.20-0.26 |
| Thread 1 пост + 150 комментариев | ~$0, обычно ~1.8s | платно |
| Thread 1 пост + 500 комментариев | ~$0, обычно ~3.5s | платно |

Search через Reddit `.json` практически ограничен примерно 100 результатами за один запрос: `limit=250` всё равно вернул 100 items. Пагинация через `after` пока не реализована. Thread path читает уже раскрытую `.json` структуру с `depth=10&showmore=false`; `morechildren` не разворачивается, поэтому `max_comments` остаётся верхним срезом, а не гарантией «все комментарии».

## 🔁 Логика fallback

```
backend=api       →  cookies/env header  →  reddit.com/*.json
                     └→ если fail: error, exit 7, cost_usd=0

backend=auto      →  cookies/env header  →  reddit.com/*.json
                     │ если fail
                     └→ Apify run

backend=apify     →  сразу Apify run, никакого api не пробуем
```

Нельзя возвращать старое поведение «`api` сам упал в Apify»: оно нарушает правило default = no paid opt-in. Деньги тратятся только в режимах `auto` или `apify`, выбранных явно.

## 📐 Два source-type

В таблице `sources` Reddit представлен как `platform='reddit'`, но **с двумя видами** в `meta_json.kind`:

| Kind | Handle | Что внутри items |
|---|---|---|
| `search` | `q-<sha8>` (хеш query+sub+sort+time) | Только посты (depth=0, без комментов) |
| `thread` | `t-<post_id>` | 1 пост (depth=0) + комменты (depth ≥ 1) |

**Зачем разделять:** разный UI (список vs дерево), разная семантика повторного открытия (search можно догружать новыми сортировками; тред — целостный snapshot). Один тред нельзя превратить в search и наоборот.

**Конверсия Search → Thread:** клик по строке в `RedditSearchView` запускает `rdThreadFetch` для URL поста — получается **отдельный** Thread-source. Не «дополнение» текущего search'а, а новая сущность в Library.

## 🌳 Дерево комментов

В `items` добавлены **две колонки**:
- `parent_external_id` — external_id родительского узла, или `NULL` для самого поста
- `depth` — `0` для поста, `1+` для комментов (по уровню вложенности)

Apify не отдаёт `depth` напрямую, только `parentId` в формате `t1_<id>` (комментарий) или `t3_<id>` (пост). В `rd_thread_ndjson.py` восстанавливаем depth через **итеративный BFS** от `post_eid`: каждый проход пытается резолвнуть depth у комментов, чей родитель уже разрешён. Сходится за <30 итераций для любого реального дерева.

В UI (`RedditThreadView`) дерево строится **на клиенте** один раз при загрузке через Map `parent_external_id → [items]`, потом DFS с сортировкой children по `likes` desc. Виртуализации нет — тред редко превышает 500-1000 узлов, обычный DOM справляется.

**Свернуть/развернуть** ветку: `Set<external_id>` локального state. Скрытые поддеревья не рендерятся. Счётчик «N скрыто» считается через рекурсивный subtreeCount (мемо).

## 📂 Файлы

```
cli-tools/reddit/
  reddit_auth.py         — cookie loading: env header → browser_cookie3 loaders
  rd_thread_ndjson.py    — один URL → пост + дерево комментов
  rd_search_ndjson.py    — keyword [+ subreddit] → посты без комментов

src/components/
  RedditBackendControl.jsx — явный выбор Free / Auto / Apify
  RedditThreadForm.jsx   — inline-form в PasteScreen для thread URL
  RedditSearchForm.jsx   — inline-form в PasteScreen для поиска
  RedditThreadView.jsx   — tree рендер в SourceDetail (kind='thread')
  RedditSearchView.jsx   — список постов в SourceDetail (kind='search')

mcp/
  server.js              — reddit_* tools поверх того же job-runner + library.db
```

## 🔄 Flow

**Search:**
```
PasteScreen → RedditSearchForm  →  rdSearch (IPC)  →  rd_search_ndjson.py
                                                       ├── api: reddit.com/search.json / r/<sub>/search.json
                                                       └── auto/apify: trudax/reddit-scraper-lite
                                                       └── emits item per post (depth=0)
                       ↓
       Library: новый source с handle=q-<sha8>
                       ↓
       SourceDetail → RedditSearchView → клик по посту → rdThreadFetch → новый Thread-source
```

**Thread:**
```
PasteScreen (URL поста) → RedditThreadForm → rdThreadFetch (IPC) → rd_thread_ndjson.py
                                                                    ├── api: reddit.com/r/.../comments/.../.json
                                                                    └── auto/apify: trudax/reddit-scraper-lite
                                                                    └── emits post (depth=0) + comments (depth=N, parent_external_id)
                       ↓
       Library: новый source с handle=t-<post_id>
                       ↓
       SourceDetail → RedditThreadView (BFS-дерево с свёртыванием)
```

## 🎫 Эвенты ndjson

Совместимо с общим контрактом (см. `fact-ipc.md`):

```python
{"type":"info",  "message":"…"}
{"type":"entity","kind":"thread"|"search","title":"…","subreddit":"r/…"|null,"id":"…","author":"…"|null,"url":"…","query":"…"|null}
{"type":"item",  "data":{external_id, type, url, title, caption, date, likes, comments, sender, has_media:0, parent_external_id, depth, raw_meta?}}
{"type":"page",  "loaded":N, "limit":L}
{"type":"done",  "items_total":N, "cost_usd":F}
{"type":"error", "message":"…"}
```

`type` для items = `"text"` (пост) или `"comment"` (комментарий) — это наш собственный enum, добавлен только для Reddit (Telegram/IG/YT не используют `comment`).

## 🤖 MCP tools для Reddit

`mcp/server.js` даёт агенту тот же бесплатный Reddit path, что UI. Это не semantic/vector search: tools запускают fetch job или читают уже сохранённые `sources/items` из `library.db`. Default backend в MCP — `api`; платный fallback появляется только если вызвать tool с `backend:"auto"` или `backend:"apify"`.

Основной быстрый flow для агента:
1. `reddit_search({query, subreddit?, limit?, sort?, time?, wait_ms, return_items:true})` → создаёт search-source и, если job уложился в `wait_ms`, сразу возвращает посты.
2. `reddit_thread_fetch({url|post_id, max_comments?, wait_ms, return_items:true})` → создаёт thread-source и сразу возвращает пост + comments для маленьких/средних тредов.
3. `reddit_thread_tree({source_id})` → отдаёт вложенное дерево по `parent_external_id/depth`, чтобы агент не восстанавливал структуру руками.

Сервисные tools: `reddit_list_sources`, `reddit_source_state`, `reddit_source_items`, `reddit_job_status`. Smoke-test через MCP: `reddit_search` на 3 поста и `reddit_thread_fetch` на 20 comments оба завершались примерно за секунду, cost `0`, а `reddit_thread_tree` возвращал root + children.

## ⚠️ Gotchas и ограничения

- **Apify token обязателен только для `auto` fallback или `apify`.** Default `api` не должен требовать токен и не должен падать из-за отсутствия Apify credentials.
- **`maxComments` ≠ всем комментам.** И api, и Apify дают верхний срез. В api-path `morechildren` пока не разворачивается; в Apify path scraper-lite тоже оставляет часть дерева за `more` placeholder. Для тредов с 1000+ comments мы видим только top-N.
- **Search cap около 100 items.** Reddit `.json` возвращает максимум около 100 results за один запрос даже если просить `limit=250`. Чтобы собрать больше, нужен отдельный pagination job через `after`.
- **Subreddit normalization — не `lstrip("r/")`.** `lstrip("r/")` удаляет любые `r` и `/` слева посимвольно: `redditdev` превращается в `edditdev`, а search выглядит как «сабреддит пустой». Нормализатор обязан явно снимать только префиксы `r/`, `/r/` или `https://www.reddit.com/r/...`.
- **HTML vs body.** API/Apify возвращают markdown/body и иногда html. В `caption` кладётся текстовая часть; если пост media-only, текст может быть пустым.
- **TimeStamps.** В разных backend'ах приходят `created_utc`, `created`, `createdAt` или ISO. Python скрипты нормализуют в ISO.
- **depth fallback = 1.** Если для коммента не удалось резолвнуть depth через BFS (orphan parent), ставим depth=1, parent_external_id=post_eid. В UI он отрендерится как top-level.
- **Один job на запрос.** Никакой догрузки страниц/`morechildren` между запросами пока нет. Юзер видит progress через `job:update` events; MCP может подождать быстрый job через `wait_ms`.

## 💰 Бюджет ресёрча

Для воронки L0→L4 (см. CLAUDE.md секцию про research workflow):
- **L0 (discovery):** Search-source с 100 постами по широкому keyword через `api` = **$0**
- **L0+ (filter):** клик по 10 топовым постам через `api` = **$0**
- **L1 (index):** Haiku 4.5 batch на полученных ~2000 комментах = **~$0.50**
- **L3 (deep):** Sonnet/Opus подсессии для топ-50 историй = **~$1-2**

Полный Reddit discovery + thread collection больше не должен стоить Apify денег в default-flow. Платный spend начинается только если агент/юзер явно выбрал `auto`/`apify` или если дальше используется платный LLM-анализ.

## 🚧 Не реализовано

1. **Пагинация треда (`morechildren`).** Если тред больше `maxComments`, видим обрезок. Чтобы догнать остальное — нужен второй вид job'а («догрузить больше комментов»). Аналог Telegram «дотянуть медиа».
2. **Пагинация поиска (`after`).** Сейчас practical cap около 100 результатов за запрос.
3. **User-source.** `reddit.com/user/<name>` — посты конкретного юзера как source.
4. **Subreddit feed без поиска.** `reddit.com/r/<sub>/` без query — сейчас лучше моделировать отдельным feed (top/hot) без поискового поля.
5. **Semantic/vector search для Reddit.** MCP умеет fetch/read/tree, но не отдельный Reddit RAG индекс.
6. **Reddit-аватары/иконки сообщества.** Сейчас Avatar generic; могли бы тянуть subreddit icon из meta.
