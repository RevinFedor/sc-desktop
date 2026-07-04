# Fix: Telethon `mac_ver` crash при spawn из Electron на macOS Tahoe (26)

## 🚨 Симптомы
Job в Activity panel падает в `error`, в detail-экране видно:
```
python exited 1: ...telethon/crypto/libssl.py", line 26, in _find_ssl_lib
    ver, major, *_ = release.split('.')
ValueError: not enough values to unpack (expected at least 2, got 1)
```

При этом тот же скрипт **в обычном терминале работает идеально**. Запутанно.

## 🔍 Что происходит на самом деле
Telethon при импорте определяет версию macOS через `platform.mac_ver()` чтобы выбрать правильный `libssl.<major>.dylib` (на macOS старше 10.14 unversioned `libssl.dylib` сегфолтит):

```python
release, _, _ = platform.mac_ver()      # на Tahoe из терминала: '26.2'
ver, major, *_ = release.split('.')      # ['26', '2']
```

Когда тот же Python спавнится **из Electron child_process.spawn**, sandbox helper'а Electron'а на macOS Tahoe (15+, и теперь 26) **отрезает доступ к `/System/Library/CoreServices/SystemVersion.plist`**, откуда CPython читает версию ОС. `platform.mac_ver()` молча возвращает `('', '', '')`. Дальше `''.split('.')` = `['']` — одно значение, unpack 2 — крах.

Воспроизводится локально:
```bash
$ env -i PATH=/usr/bin:/bin python3 -c "import platform; print(platform.mac_ver())"
('', ('', '', ''), '')
```

## 💀 Отброшенные подходы
1. **Прокинуть env в `spawn()`.** Пробовали `{ ...process.env }` (по умолчанию) и явно прокидывать `SYSTEM_VERSION_*`. Не работает: переменных таких просто нет, plist читается через CoreFoundation API, который не реагирует на env.
2. **Патчить `telethon/crypto/libssl.py` в venv напрямую.** Сработало бы, но: (a) грязно, (b) `pip install --upgrade telethon` затрёт фикс, (c) не переносится между машинами.
3. **Apple Silicon SDK env (`MACOSX_DEPLOYMENT_TARGET`).** Влияет на компиляцию, не на runtime — Telethon его не читает.

## ✅ Решение
Monkey-patch `platform.mac_ver` **до** `import telethon` в `tg_fetch_json.py` (он импортируется первым). Версию берём через `sw_vers` — это shell-утилита, которая в sandbox'е Electron остаётся доступной.

```python
import platform, subprocess

if sys.platform == 'darwin':
    if not platform.mac_ver()[0]:
        try:
            r = subprocess.check_output(['/usr/bin/sw_vers', '-productVersion'],
                                        text=True).strip()
        except Exception:
            r = '14.0'    # safe modern fallback
        platform.mac_ver = lambda r=r: (r, ('', '', ''), platform.machine())

# теперь можно
from telethon import TelegramClient
```

Должен быть **в каждом Python-скрипте**, который spawn'ится из Electron. Если будет больше скриптов (`yt_fetch_json.py`, `ig_fetch_json.py`) — выносить в `python-workers/shared/_electron_compat.py` и импортировать первым.

## 🧪 Как воспроизвести фикс вручную
```bash
# Без фикса — должен упасть:
env -i PATH=/usr/bin:/bin python3 -c "from telethon import TelegramClient"

# С фиксом — после monkey-patch import проходит:
env -i PATH=/usr/bin:/bin /Users/fedor/Desktop/sc-desktop/.venv/bin/python3 \
  /Users/fedor/Desktop/sc-desktop/python-workers/telegram/tg_fetch_json.py durov --mode last_n --limit 3
# {"type": "entity", ...}
# {"type": "item", ...}
# {"type": "done", "items_total": 3, ...}
```

## 🪤 Связанные ловушки
- Та же проблема может всплыть с другими библиотеками которые читают `mac_ver()` для feature-detection: `cryptography`, `urllib3` (TLS warnings), низкоуровневый `ssl`. Если увидишь похожий ValueError — фикс тот же.
- В UI-логах фикс **виден через `[Jobs] end #N status=error error=...`**. Если status=error и error содержит `_find_ssl_lib`/`mac_ver`/`split` — это оно.
