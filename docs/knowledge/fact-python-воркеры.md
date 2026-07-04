# Knowledge: Python workers runtime

SC Desktop больше не спавнит внешнюю папку `cli-tools` / `SaliTools` с рабочего
стола. Активный runtime для desktop — локальная папка `python-workers/` внутри
репозитория, упакованная в production как `Contents/Resources/python-workers`.
Если новый код или документация предлагает чинить старые `cli-tools/*_core.py`,
это почти наверняка неверная точка входа для desktop-фичи.

## Контракт запуска

`electron/job-runner.js` выбирает worker root по среде:

- dev: `<repo>/python-workers`
- production: `process.resourcesPath/python-workers`

Python runtime выбирается отдельно. Приоритет: `SC_DESKTOP_PYTHON`, если файл
реально существует; затем bundled/interrepo `.venv/bin/python3`; затем системные
fallback'и. `npm run build:install` перед сборкой проверяет `.venv/bin/python3`
и при необходимости запускает `npm run python:setup`, который ставит
`python-workers/requirements.txt`.

Пользовательский симптом поломанного runtime: экран «Добавить сессию» или
Telegram fetch пишет `telethon not installed`, хотя код на месте. Это не ошибка
логина и не проблема Telegram API — worker запущен Python'ом без нужных
зависимостей или production-бандл не содержит `.venv`. Скрипты эмитят
`code="worker_dependency_missing"`, job-runner считает это структурной ошибкой:
umbrella batch (`tg_folder_fetch` / `tg_catchup`) останавливается сразу, не
запускает оставшиеся doomed children, а история парсинга показывает короткую
причину в row.

## Config и credentials

Workers читают секреты через env и `~/.config/sc/settings.json`:

- Telegram: `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` или `settings.telegram.*`
  / `settings.api_keys.*`.
- Gemini: `GEMINI_API_KEY` или `settings.api_keys.GEMINI_API_KEY` /
  `settings.api.gemini_api_key`.

`config.env` больше не является active contract для worker runtime. Если
Gemini-ключ поменялся в соседнем проекте, переносить надо значение в env или
`~/.config/sc/settings.json`, а не добавлять `config.env` в production filter.

## Схема БД

`library.db` всё ещё открывают две стороны, но dual-source schema теперь:

- `electron/database.js`
- `python-workers/shared/library_db.py`

При изменении схемы менять оба файла. Старые упоминания
`cli-tools/shared/library_db.py` относятся к legacy-документации и не должны
вести новые правки в несуществующую папку.

## Что не делать

- Не восстанавливать внешний dependency на `~/Desktop/cli-tools` /
  `SaliTools`: production app должен быть самодостаточным.
- Не писать state рядом с worker-скриптами. Sessions, jobs, transcripts и DB
  живут в `~/Library/Application Support/sc-desktop/`.
- Не чинить desktop-flow в CLI-only core-модулях. Если logic нужна desktop'у,
  она должна жить в `python-workers/*_ndjson.py`, `python-workers/shared/*` или
  в Electron main.
