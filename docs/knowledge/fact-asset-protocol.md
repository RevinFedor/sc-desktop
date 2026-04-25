# Knowledge: Asset Protocol (sc-asset://)

Кастомный Electron-protocol для отдачи локальных бинарных ассетов (avatars,
research artifacts, social-media images) в `<img>` без отключения webSecurity.

## 🔌 Контракт

`sc-asset://<rel-path>` → файл по адресу `LIB_ROOT/<rel-path>`.

Регистрируется один раз на `app.whenReady()` через `protocol.registerFileProtocol`.
Path-traversal через `..` блокируется явно (`if (rel.includes('..')) return error`).

## 📁 Где живут ассеты

```
~/Library/Application Support/sc-desktop/
├── avatars/
│   └── telegram/
│       └── <chat_id>.jpg     ← download_profile_photo результат
├── research-artifacts/
│   └── <jobId>/
│       ├── input/
│       │   └── 01-<name>.png ← копия image attachment, отправленного в ChatGPT
│       └── <timestamp>-<hash>-chatgpt-image-....png
│                               ← сгенерированная ChatGPT картинка
└── twitter-media/
    └── <tweet-id>/
        └── 01-<hash>.jpg ← картинка из twimg, дотянутая по требованию
```

Один корень с `library.db` и `jobs/` — backup/`SC_DESKTOP_DIR=...` покрывает
всё одной командой. См. `CLAUDE.md::instructions` про invariant.

Research artifacts хранятся в `LIB_ROOT`, а не рядом с исходным файлом пользователя и
не как base64 в SQLite. Причина: история MCP должна пережить удаление исходного файла
и рестарт приложения, но renderer всё равно должен грузить картинку как обычный `<img>`.
`sc-asset://research-artifacts/...` даёт это без `file://` и без отключения webSecurity.

Twitter/X media использует тот же принцип, но с другим lifecycle: search/thread
сохраняют только признаки и URL, а бинарники качаются отдельным `twitter_media_fetch`,
когда текст поста указывает на визуальный контекст. Локальный файл кладётся в
`twitter-media/<tweet-id>/`, первый путь пишется в `items.media_path` /
`thumbnail_path`, а ответ получает `sc-asset://twitter-media/...`. Это не
research artifact (не результат LLM), а исходное медиа из social-поста; хранить
его рядом с `library.db` важно, чтобы агент мог прочитать картинку позже без
повторного обращения к X.

## 🪞 Перегруженный `avatar_url`

Колонка `sources.avatar_url TEXT` хранит **разное** в зависимости от
платформы:

- **Telegram:** относительный путь типа `avatars/telegram/2322212159.jpg`.
  Telethon `download_profile_photo` пишет файл, мы кладём rel-path в БД.
- **YouTube / Instagram / TikTok:** **полный CDN-URL** типа
  `https://yt3.googleusercontent.com/...`. yt-dlp / `web_profile_info` отдают
  его напрямую, локально не сохраняем.

`<Avatar>` компонент маршрутизирует:
```
http(s)://...   → <img src> напрямую (CDN)
иначе           → sc-asset://<value>
```

См. `src/components/Avatar.jsx::resolveAvatarSrc`.

## ↩ Fallback chain

```
1. <img src=...>   (если есть avatar_url + не broken)
2. Initial         (первая буква display_name на zinc-фоне)
3. PlatformLogo    (если имени нет вообще)
```

Шаг 1 → 2 переключается через `onError={() => setBroken(true)}`. Это покрывает
случаи когда:
- TG-аватар удалён юзером (download_profile_photo вернул None — мы не пишем
  путь и сразу идём на initial).
- YT CDN URL истёк или ребренднулся (Google ротирует ссылки).
- `protocol.registerFileProtocol` ещё не зарегистрирован (в renderer-preview).

## 🪤 Что отбросили

- **`file://` + `webSecurity: false`** — нюк-вариант. Открывает любой файл
  с диска для произвольного `<img src>`. У нас private-data в `library.db`
  рядом — не хочется.
- **IPC + base64 в `<img src="data:...">`** — round-trip каждое изображение,
  bloat на больших списках. Если sidebar показывает 50 источников — 50 IPC
  + 50 base64-строк в memory.
- **`process.resourcesPath` для аватаров** — не подходит, аватары
  пишутся в runtime, а Resources read-only в production.
- **`protocol.handle` (Electron 25+)** — современнее, но контракт чуть
  отличается (Web Streams). `registerFileProtocol` всё ещё поддерживается
  в Electron 34, миграция отложена.

## 🛡 Path-traversal

`new URL('sc-asset://avatars/telegram/123.jpg')` парсится как
`{ host: 'avatars', pathname: '/telegram/123.jpg' }`. Конкатенация даёт
`avatars/telegram/123.jpg`. Если `pathname` содержит `..` — `path.posix.normalize`
не уберёт их (он обрабатывает чисто строково), поэтому явный `if (rel.includes('..'))`
проверка перед `path.join(LIB_ROOT, rel)`.

Без этого `<img src="sc-asset://x/../../../../etc/passwd">` отдал бы любой
файл с домашней директории.
