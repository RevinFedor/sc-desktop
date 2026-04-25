# Fix: `echo "$R" | jq` ломает JSON с `\n` escape

## Симптом

Bash-loop в SKILL `external-research` (опрос bridge'а через `curl /research-status`):
```bash
R=$(curl -s "http://127.0.0.1:53127/research-status?id=$ID&wait=60000")
S=$(echo "$R" | jq -r '.status // empty')   # ← падает
```

`jq` выдаёт `parse error: Invalid control character at: line 1, column N`, либо `S=""` (если `// empty` маскирует). Loop никогда не выходит, потому что не может прочитать `.status`. Юзер видит «MCP пришёл с done immediate, но bash-loop висит 30+ минут».

## Причина

`echo "$R"` в zsh (всегда) и bash (при `xpg_echo` опции, дефолт в macOS Catalina+) **интерпретирует backslash-escape sequences внутри переменной**: `\n` → литеральный 0x0A LF byte, `\t` → 0x09, etc.

Bridge возвращает валидный JSON `{"prompt":"line1\\nline2","status":"running"}` — здесь `\\n` это **2 байта** `\` + `n` (правильно escaped LF в JSON-строке). После `echo "$R"` стейт превращается в `{"prompt":"line1<LF>line2","status":"running"}` — литеральный LF внутри JSON-string, что **запрещено** JSON-спекой (0x00-0x1F должны быть escaped). jq отказывается парсить.

Контр-интуитивно потому что `echo "$R" | jq` — **самый распространённый bash-pattern для JSON**. Все туториалы пишут так. Шрам проявляется только когда payload содержит JSON-escape sequences (большие prompt'ы / multi-line text fields).

## Решение

Использовать **here-string** или `printf '%s'`, оба передают байты `$R` как есть без интерпретации escape:

```bash
# Хорошо — here-string:
S=$(jq -r '.status // empty' <<<"$R")

# Хорошо — printf:
S=$(printf '%s' "$R" | jq -r '.status // empty')

# Плохо:
S=$(echo "$R" | jq -r '.status // empty')
```

`<<<` короче и читается естественно когда `jq` единственная команда в пайплайне. `printf '%s' |` удобен когда нужно chain'ить несколько команд после него.

## Что пробовали и почему не сработало

1. **`echo -E "$R" | jq`** — `-E` отключает escape interpretation в bash, но **в zsh `-E` означает другое** (не подавление escapes). На macOS дефолтный shell — zsh, поэтому `-E` молча игнорируется.
2. **`echo -e "$R" | jq`** — наоборот, **включает** escape interpretation (противоположное от нужного).
3. **Quote-escape `"\\\\n"` в jq-arg'е** — не помогает, jq не видит до этого момента, проблема на shell-stage.
4. **Wrap `$R` в `\"` явно** — добавляет дополнительные кавычки, ломает JSON по-другому.

## Файлы

- `~/.claude/skills/external-research/SKILL.md` — все 3 `echo "$R" | jq` заменены на `jq <<<"$R"`.
- `docs/knowledge/fact-deep-research.md::Контракт curl-flow` — anti-pattern callout.

## Связано

- `fact-deep-research.md` — SKILL и curl-flow для Deep Research.
