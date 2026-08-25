# Knowledge: интерактивные субтитры YouTube

SC Browser Parser заменяет визуальный слой субтитров YouTube собственным
интерактивным слоем только после нажатия штатной кнопки **CC**. Родная дорожка
остаётся источником текста и таймкодов; расширение не распознаёт аудио и не
запускает платный AI, пока у видео есть субтитры.

## Пользовательский контракт

- CC включена → поверх плеера показывается текущая реплика.
- Наведение на реплику → появляется перевод Azure Translator.
- Клик по слову → карточка с вариантами перевода, частью речи и примерами из
  текущего видео.
- Слева: предыдущая реплика, повтор, следующая реплика.
- Справа: поменять стороны управления, автопауза, настройки.
- Сохранение слова/фразы пишет данные в локальную `library.db`; вход в сторонний
  аккаунт Language Reactor не нужен.
- Старый Language Reactor может оставаться установленным на время миграции. Его
  субтитры, уведомления и большая боковая панель скрываются только после того,
  как SC успешно получил собственные реплики. При ошибке старый слой не
  скрывается — существующая возможность не теряется.

## Azure Translator

Ресурс:

- регион: `northeurope`;
- Text Translation endpoint: `https://api.cognitive.microsofttranslator.com`;
- тариф: `Free F0`;
- ключ хранится только локально в
  `~/.config/sc/settings.json → api_keys.AZURE_TRANSLATOR_KEY`;
- значение ключа запрещено записывать в Git, Markdown, логи, extension storage
  или ответы localhost API.

Расширение не получает Azure key. Оно вызывает loopback-мост SC Desktop:

```text
YouTube content-script
  → http://127.0.0.1:53127/translator/*
  → Electron читает локальный ключ
  → Azure Translator
  → ответ без credentials возвращается расширению
```

Маршруты:

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/translator/status` | Наличие конфигурации без выдачи ключа |
| POST | `/translator/translate` | Перевод одной или нескольких реплик |
| POST | `/translator/dictionary` | Варианты перевода слова, части речи и back-translations |
| POST | `/yt-learning-cues` | Бесплатная локальная дорожка с таймкодами |
| GET/POST | `/learning/entry` | Прочитать или сохранить слово/фразу и контекст |

В режиме «При наведении» Azure вызывается только для наведённой реплики. В
режиме «Всегда» заранее переводится небольшое окно вокруг текущей позиции, а не
всё видео. Повторные тексты читаются из `translation_cache`, поэтому не расходуют
квоту снова.

## Получение дорожки

Основной путь читает выбранный caption track из main-world YouTube player и
пытается получить `json3`/VTT. В текущей версии YouTube встречается состояние,
где `captionTracks[].baseUrl` валиден для самого плеера, но script-fetch получает
HTTP 200 с пустым body.

В этом случае расширение вызывает `/yt-learning-cues`. Electron использует уже
существующий бесплатный race:

```text
youtube-transcript-api × yt-dlp
  → первый непустой результат
  → файл *__timestamps.txt
  → cues [{startMs, endMs, text}]
```

Файл с таймкодами кэшируется рядом с обычным транскриптом. Повторное открытие
видео не запускает worker заново.

## Локальная БД

Схема объявлена с двух сторон, потому что Electron и Python workers открывают
один `library.db`:

- `electron/database.js::SCHEMA`;
- `python-workers/shared/library_db.py::SCHEMA_V1`.

Таблицы:

- `translation_cache` — provider response по ключу
  `(operation, source language, target language, source text)`;
- `learning_entries` — одна нормализованная запись слова/фразы со статусом
  `saved | known | ignored`;
- `learning_examples` — несколько контекстов из разных видео для одной записи.

## Настройки

Источник правды после bootstrap — общий `~/.config/sc/settings.json`, секция
`browser_extension.youtube`, schema version 2. Настройки меняются как из
SC Desktop (`Настройки → YouTube`), так и из компактной панели в плеере. Открытая
YouTube-вкладка перечитывает desktop-настройки и применяет их без F5.

Поля learning-слоя:

- `learning_enabled`;
- `learning_target_lang`;
- `learning_auto_pause`;
- `learning_subtitle_position` (`top | bottom`);
- `learning_controls_mirrored`;
- `learning_translation_mode` (`hover | always`);
- `learning_hide_native_subtitles`.

## Проверка

Проверенный сценарий на `youtube.com/watch`:

1. CC on/off соответственно включает и полностью снимает SC-слой.
2. Дорожка `en/asr` получена локальным fallback: 722 timed cues; повторный вызов
   вернул `cached: true`.
3. Azure перевёл реплику и dictionary lookup вернул несколько вариантов слова.
4. Предыдущая/повтор/следующая реплика меняют позицию видео; повтор сохраняет
   текущую cue.
5. Автопауза остановила видео у конца реплики и была возвращена в исходное
   выключенное состояние.
6. Смена сторон переставила control rails и была возвращена обратно.
7. Слово и фраза сохранились в `learning_entries`, их контексты — в
   `learning_examples`.
8. Изменение автопаузы в SC Desktop дошло до уже открытой YouTube-вкладки и
   после проверки было отменено.

