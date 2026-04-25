# Знание: Twitter/X через browser MCP

Twitter/X в sc-desktop сейчас реализован как **агентный MCP-парсер через реальный
браузер пользователя**, а не как UI-форма и не как официальный API. Мотивация:
публичный поиск X даёт нужную выдачу только в залогиненной сессии, официальный API
дорогой/лимитированный для такого discovery, а для агента важнее быстро собрать
поиск, открыть несколько обсуждений и при необходимости дотянуть картинки.

## Архитектура

`mcp/server.js` обслуживает `twitter_*` tools и пишет результат в ту же
`library.db`, что UI. DOM-парсинг вынесен в `mcp/twitter-browser.js`: он
подключается к SC Browser Parser bridge (`127.0.0.1:3458`), открывает X search
или status page в реальном профиле браузера и читает `article[data-testid="tweet"]`.
Это не headless Chrome и не `navigator.webdriver`; используется пользовательская
сессия/куки того браузера, где уже открыт X.

Риск блокировки не исчезает магически: это всё равно scraping с аккаунта. Но
поведение ближе к обычному browsing, чем к анонимному HTTP-скрейперу. Практический
guardrail: не запускать десятки параллельных X-поисков, держать modest scroll
(`settle_ms` 250-300ms), закрывать вкладки после fetch, и для больших задач дробить
запросы по датам/темам вместо одного агрессивного harvest.

## Search

`twitter_search` строит обычный X query и открывает `https://x.com/search?q=...`.
Поддержанные операторы важны для фильтрации мусорной выдачи с 1-2 просмотрами:

- текст: `query`, `exact_phrase`, `any_words` (OR-группа), `exclude_words`;
- авторы/адресаты: `from_user`, `to_user`, `mention_user`;
- даты и язык: `since`, `until`, `lang`;
- качество: `min_likes` → `min_faves`, `min_replies`, `min_retweets`;
- типы: `exclude_replies`, `only_replies`, `only_links`, `only_media`,
  `only_images`, `only_videos`;
- вкладка: `tab=latest|top|media`.

Фактические замеры на 2026-06-13: широкий search на 8 постов собрался примерно
за 3 секунды; фильтрованный запрос по orchestration/multi-agent с датами и
`min_likes` вернул 12 постов примерно за 4 секунды. Это порядок величины для
малых research-запросов, не SLA: X ранжирует выдачу, DOM виртуализирован, скорость
зависит от сети и текущей сессии.

## Thread tree

`twitter_thread_fetch` читает один status URL и сохраняет root-пост + видимые
ответы. Важный шрам: background tab на X показал только корневой пост, ответы
не коммитились в DOM. Поэтому thread fetch принудительно открывает активную
вкладку (`background:false`), в отличие от простого search, который может идти
в фоне.

`reply_depth=1` читает страницу поста: root + видимые replies. `reply_depth=2/3`
дополнительно открывает страницы видимых reply-постов и собирает replies-to-replies
до `branch_limit`. Это **best-effort дерево**, а не гарантия полного треда: X
ранжирует/прячет часть ответов, не все ветки раскрываются из DOM, hidden replies
и элементы "show more" сейчас не разворачиваются отдельным API. Smoke-test:
thread OpenAI status дал 78 rows, 77 comments, `maxDepth=2`; вложенные ответы
сохранились через `parent_external_id`.

## Sources/items модель

Twitter сохраняется как `platform='twitter'`, с двумя source-kind в `meta_json`:

| Kind | Handle | Что внутри |
|---|---|---|
| `search` | `xq-<sha8>` | Только найденные посты |
| `thread` | `xt-<status_id>` | Root-пост + replies tree |

Items используют `external_id='tweet:<status_id>'`. Root/search posts пишутся
как `type='text'`, replies — как `type='comment'`, дерево строится через
`parent_external_id` и `depth`. Поиск и треды не являются semantic/vector search;
это fetch/read tools поверх library rows. Для чтения сохранённого: `twitter_source_items`
для flat list и `twitter_thread_tree` для вложенного дерева.

## Картинки: lazy media fetch

По умолчанию `twitter_search` и `twitter_thread_fetch` **не скачивают картинки**.
Они сохраняют текст, счётчики, `has_media`, `media_count` и URL в `raw_meta.media`.
Это намеренно: большинство research-запросов решаются по тексту, а массовая загрузка
картинок увеличивает IO, шум в ответе и риск лишней активности на X.

Когда текст явно указывает на визуальный контекст (скриншот, график, "на картинке",
ссылка на чат/контекст которого нет), агент вызывает `twitter_media_fetch`. Он
скачивает только `*.twimg.com` изображения в
`~/Library/Application Support/sc-desktop/twitter-media/<tweet-id>/`, заполняет
`items.media_path` / `thumbnail_path` первым локальным файлом и возвращает
`sc-asset://twitter-media/...` для renderer/агента. Лимит на один файл — 25 MB.

Важная деталь URL: для `pbs.twimg.com/media/...` нельзя выкидывать query string.
`format=jpg&name=...` является частью рабочего адреса; после strip query часть
картинок отдаёт 404 или низкое качество. Парсер сохраняет query и, если есть
`format`, меняет `name=orig`, чтобы забрать максимально полезную версию.

## MCP tools

Основной flow агента:

1. `twitter_search({query, since?, until?, min_likes?, exclude_replies?, limit?})`
   → создаёт search-source и возвращает компактные posts.
2. `twitter_thread_fetch({url, max_items?, reply_depth?, branch_limit?})`
   → создаёт thread-source с post + replies.
3. `twitter_thread_tree({source_id})` или `twitter_source_items({source_id})`
   → читает сохранённое без нового обращения к X.
4. `twitter_media_fetch({source_id|url|status_id, item_status_id?, limit?})`
   → дотягивает картинки только когда они нужны.

Сервисные tools: `twitter_list_sources`, `twitter_source_state`. Fresh MCP
smoke после build вернул 7 `twitter_*` tools, а `twitter_list_sources` увидел
сохранённые test-runs: search на 12 items, thread на 78 rows, media counters
3/7 downloaded.

## Ограничения

- Нет гарантии полного треда: X DOM отдаёт ranked/visible slice.
- Нет отдельной пагинации search через cursor; сбор идёт scroll'ом до `limit`
  или stagnation.
- Нет отдельного UI-экрана запуска Twitter в renderer; это MCP-first фича.
- Нет OCR/описания картинок на стороне fetch. Сохраняем локальные пути; модель
  сама читает изображение, если ей нужен визуальный контекст.
- Нет paid API cost: browser path стоит $0, но дальнейший LLM-анализ и embedding
  оплачиваются отдельно.

## Связанное

- `fact-browser-mcp.md` — почему используется реальный browser bridge, а не
  headless/CDP Chrome.
- `fact-asset-protocol.md` — `sc-asset://` и локальный `LIB_ROOT` для картинок.
- `fact-semantic-search.md::MCP-сервер для Claude Code` — регистрация MCP,
  Electron ABI wrapper и production packaging boundary.
