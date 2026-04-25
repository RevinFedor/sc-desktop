#!/bin/bash
# =============================================================================
# Semantic Indexer — Phase 1 (Parallel)
# Сканирует всю docs/ (knowledge/, methodology/, product/, meta/, ux-patterns/, и т.д.)
# исключая tmp/ и _intro.md, отправляет в Claude Haiku через `claude -p`
# или в Gemini через `--gemini-write`,
# получает "семантический паспорт" и складывает в .semantic-index.json.
# MCP-роутер сам отфильтрует по симптомам — маркетинговые тексты не подтянутся
# при отладке кода и наоборот.
#
# Запуск: bash scripts/ai/build-index.sh
# Опции: -g            — использовать Gemini 3 Flash (результат → clipboard, индекс не меняется)
#         --gemini-write — использовать Gemini 3 Flash и записать .semantic-index.json
#         --with-src    — также индексировать src/ (компоненты и сторы)
#         --parallel N  — количество параллельных запросов (по умолчанию 10)
#         --force / -f  — переиндексировать все файлы (игнорировать кеш хешей)
#
# CLAUDE.md переименовывается автоматически (mv → .bak) и восстанавливается при выходе
#
# =============================================================================

set -u

PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
INDEX_FILE="$PROJECT_DIR/.semantic-index.json"
LOG_FILE="$PROJECT_DIR/scripts/ai/indexer.log"
RESULTS_DIR=$(mktemp -d /tmp/indexer-results-XXXXXXXX)

MAX_PARALLEL=10

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Парсим аргументы
WITH_SRC=false
USE_GEMINI=false
GEMINI_WRITE=false
FORCE_REINDEX=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    -g|--gemini) USE_GEMINI=true; shift ;;
    --gemini-write) USE_GEMINI=true; GEMINI_WRITE=true; shift ;;
    --with-src) WITH_SRC=true; shift ;;
    --force|-f) FORCE_REINDEX=true; shift ;;
    --parallel) MAX_PARALLEL="$2"; shift 2 ;;
    [0-9]*) MAX_PARALLEL="$1"; shift ;;
    *) shift ;;
  esac
done

if [ "$USE_GEMINI" = true ]; then
  if [ -z "${GEMINI_API_KEY:-}" ]; then
    echo -e "${RED}ERROR: GEMINI_API_KEY not set${NC}"
    echo "export GEMINI_API_KEY=your_key"
    exit 1
  fi
  GEMINI_MODEL="${GEMINI_MODEL:-gemini-3.5-flash}"
  echo -e "${YELLOW}Mode: Gemini ($GEMINI_MODEL, thinking=HIGH)${NC}"
  if [ "$GEMINI_WRITE" = true ]; then
    echo -e "${YELLOW}Write mode: результат → .semantic-index.json${NC}"
  else
    echo -e "${YELLOW}Dry-run: результат → clipboard, индекс не меняется${NC}"
  fi
fi

echo "=== Indexer started: $(date) ===" > "$LOG_FILE"

log() {
  echo "$@" >> "$LOG_FILE"
}

if [ "$USE_GEMINI" = false ] && ! command -v claude &>/dev/null; then
  echo -e "${RED}ERROR: claude CLI not found${NC}"
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo -e "${RED}ERROR: jq required. brew install jq${NC}"
  exit 1
fi

# Автоматическое переименование CLAUDE.md (чтобы claude -p не грузил проектный контекст)
CLAUDE_MD_MOVED=false
if [ -f "$PROJECT_DIR/CLAUDE.md" ]; then
  if [ -f "$PROJECT_DIR/CLAUDE.md.bak" ]; then
    echo -e "${YELLOW}WARNING: CLAUDE.md.bak уже существует — пропускаю mv${NC}"
    echo -e "${YELLOW}Удали CLAUDE.md.bak вручную и перезапусти${NC}"
    exit 1
  fi
  mv "$PROJECT_DIR/CLAUDE.md" "$PROJECT_DIR/CLAUDE.md.bak"
  CLAUDE_MD_MOVED=true
  echo -e "${GREEN}CLAUDE.md → CLAUDE.md.bak (будет восстановлен в конце)${NC}"
fi

# Гарантируем восстановление CLAUDE.md и очистку tmp при любом выходе
cleanup() {
  if [ "$CLAUDE_MD_MOVED" = true ] && [ -f "$PROJECT_DIR/CLAUDE.md.bak" ]; then
    mv "$PROJECT_DIR/CLAUDE.md.bak" "$PROJECT_DIR/CLAUDE.md"
    echo -e "\n${GREEN}CLAUDE.md.bak → CLAUDE.md (восстановлен)${NC}"
  fi
  rm -rf "$RESULTS_DIR" 2>/dev/null
  rm -f "${HASH_MAP_FILE:-/dev/null}" 2>/dev/null
  rm -f "${EXISTING_PATHS:-/dev/null}" 2>/dev/null
}
trap cleanup EXIT

SYSTEM_PROMPT='You are a Semantic Indexer for SC Desktop (Electron GUI поверх Python CLI `sc` для парсинга/транскрипции медиа).
Your task: create a semantic JSON passport for a file, used by a search router.

ALL OUTPUT MUST BE IN ENGLISH. Tags, symptoms, questions — everything in English only.

PROJECT ARCHITECTURE:
- All docs in docs/knowledge/ — flat structure, two types:
  - fix-* — scars: bugs, workarounds, structural hacks
  - fact-* — how subsystems work, platform constraints, feature behavior
- Electron Main (electron/main.js) ↔ Renderer (React + Vite) via contextBridge in preload.js
- Python subprocess via child_process.spawn() — NOT node-pty (deliberate decision, see fact-ipc.md)
- ndjson protocol over stdout for job progress events
- better-sqlite3 in runtime + dual schema with Python CLI (cli-tools/shared/library_db.py — bundled submodule under project root)
- FTS5 for transcript search
- Three-pane persistent UI: LibrarySidebar (240px) | center (swappable screen) | ActivityPanel (300px)
- In-memory screen stack store via useSyncExternalStore (no zustand, no react-router)
- Frameless window with traffic-light overlay zone (env(titlebar-area-x))
- Domain: Telegram/YouTube/Instagram/TikTok parsers, transcript via Whisper

RULES FOR implicit TAGS:

1. CONCRETE NAMES, NOT ABSTRACTIONS:
   BAD: "State Machine Detection", "Race Condition Handling"
   GOOD: "ndjson_subprocess_protocol", "library_db_dual_schema", "screen_stack_pushpop"

2. SUBSYSTEM NAMES — if the file describes multiple mechanisms, each gets its own tag

3. CROSS-DOMAIN BRIDGES — categories specific to this stack:
   a) IPC contextBridge limits → preload.js whitelist, no direct require() in renderer
   b) subprocess vs PTY → spawn + readline, why not node-pty (see fact-ipc.md)
   c) SQLite dual-source → schema must sync between electron/database.js and Python CLI
   d) FTS5 search → transcript indexing, special tokenizer for cyrillic
   e) Three-pane invariant → never use fixed/absolute for screen content, must fit min-h-0 overflow-hidden
   f) Settings shared with CLI → ~/.config/sc/settings.json, not duplicated in SQLite
   g) Telethon spawn quirks → Python venv, environment variables, working directory
   h) Title bar drag zone → traffic-light area reserved, do not override padding-left
   i) Logger [Tag] prefix → console.log without tag does not reach file logger
   j) Job runner lifecycle → spawn → ndjson stream → ActivityPanel listens → job:update events

   If the file TOUCHES any of these categories — add the corresponding tag.

RULES FOR symptoms ARRAY (CRITICAL):

The "symptoms" field is the MOST IMPORTANT field for search quality.
Write 3-5 SHORT ENGLISH SENTENCES describing WHEN a developer needs this file.
Focus on OBSERVABLE SYMPTOMS, not implementation details.

Example for a file about subprocess protocol:
  "symptoms": [
    "Job stuck in pending state after spawn",
    "Progress events not reaching ActivityPanel",
    "Python script output garbled or partial"
  ]

Example for a file about three-pane layout:
  "symptoms": [
    "New screen breaks Library sidebar position",
    "Footer disappears on certain screens",
    "Center column scrollbar shows over Activity panel"
  ]

Respond with STRICT JSON (no markdown, no comments, no backticks):
{"path": "...", "type": "fix|fact", "explicit": ["topic1", "topic2"], "implicit": ["concrete_tag_1", "concrete_tag_2", "...minimum 8 tags..."], "symptoms": ["When X happens and Y is visible", "If Z returns empty after W"], "related_components": ["src/path/file.tsx"]}'

# Директория для token-счётчиков (Gemini)
TOKENS_DIR=$(mktemp -d /tmp/indexer-tokens-XXXXXXXX)

# Экспортируем для дочерних процессов
export SYSTEM_PROMPT LOG_FILE RESULTS_DIR USE_GEMINI TOKENS_DIR
export GEMINI_API_KEY GEMINI_MODEL GEMINI_WRITE 2>/dev/null || true

echo -e "${BLUE}Scanning project: $PROJECT_DIR${NC}"

FILES=()

while IFS= read -r -d '' f; do
  FILES+=("$f")
done < <(find "$PROJECT_DIR/docs" -type f -name '*.md' \! -path '*/tmp/*' \! -name '_intro.md' -print0 2>/dev/null)

if [ "$WITH_SRC" = true ]; then
  echo -e "${YELLOW}Including src/ components and stores...${NC}"
  while IFS= read -r -d '' f; do
    FILES+=("$f")
  done < <(find "$PROJECT_DIR/src" \( -path '*/components/*.tsx' -o -path '*/store/*.ts' -o -path '*/hooks/*.ts' \) -print0 2>/dev/null)
fi

TOTAL=${#FILES[@]}

if [ "$TOTAL" -eq 0 ]; then
  echo -e "${RED}No files found. Check project structure.${NC}"
  exit 1
fi

# ===== Инкрементальная индексация: загружаем существующие хеши =====
HASH_MAP_FILE=""
CAN_USE_CACHE=true
if [ "$USE_GEMINI" = true ] && [ "$GEMINI_WRITE" = false ]; then
  CAN_USE_CACHE=false
fi
if [ "$FORCE_REINDEX" = false ] && [ -f "$INDEX_FILE" ] && [ "$CAN_USE_CACHE" = true ]; then
  HASH_MAP_FILE=$(mktemp /tmp/indexer-hashmap-XXXXXXXX)
  jq -r '.[] | "\(.path)\t\(.hash // "")"' "$INDEX_FILE" > "$HASH_MAP_FILE" 2>/dev/null || true
  EXISTING_PATHS=$(mktemp /tmp/indexer-paths-XXXXXXXX)
  jq -r '.[].path' "$INDEX_FILE" > "$EXISTING_PATHS" 2>/dev/null || true
  echo -e "${GREEN}Found $TOTAL files to index (incremental mode)${NC}"
else
  if [ "$FORCE_REINDEX" = true ]; then
    echo -e "${GREEN}Found $TOTAL files to index (force reindex)${NC}"
  else
    echo -e "${GREEN}Found $TOTAL files to index${NC}"
  fi
fi
echo -e "${YELLOW}Parallel: $MAX_PARALLEL workers${NC}"
echo ""

# ===== Функция обработки одного файла (запускается как background job) =====
process_file() {
  local FILE="$1"
  local IDX="$2"
  local FILE_HASH="$3"
  local REL_PATH="${FILE#$PROJECT_DIR/}"
  local RESULT_FILE="$RESULTS_DIR/$IDX.json"
  local FILE_START=$(date +%s)

  # Читаем содержимое
  local CONTENT=""
  CONTENT=$(cat "$FILE" 2>/dev/null) || true
  if [ -z "$CONTENT" ]; then
    echo "SKIP" > "$RESULT_FILE"
    return
  fi

  local TEXT=""

  if [ "$USE_GEMINI" = true ]; then
    # ---- Gemini 3 Flash API ----
    local USER_MSG
    USER_MSG=$(printf 'Файл: %s\n\nСодержимое:\n%s' "$REL_PATH" "$CONTENT")

    local REQFILE=$(mktemp /tmp/indexer-req-XXXXXXXX)
    jq -n \
      --arg system "$SYSTEM_PROMPT" \
      --arg user "$USER_MSG" \
      '{
        contents: [{ role: "user", parts: [{ text: $user }] }],
        systemInstruction: { parts: [{ text: $system }] },
        generationConfig: {
          thinkingConfig: { thinkingLevel: "HIGH" },
          responseMimeType: "application/json"
        }
      }' > "$REQFILE"

    local RAW=""
    RAW=$(curl -s -X POST \
      -H "Content-Type: application/json" \
      "https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}" \
      -d "@$REQFILE" 2>> "$LOG_FILE") || true

    rm -f "$REQFILE"

    # Сохраняем token usage в файл (суммируем в конце)
    echo "$RAW" | jq -r '[
      .usageMetadata.promptTokenCount // 0,
      .usageMetadata.candidatesTokenCount // 0,
      .usageMetadata.totalTokenCount // 0,
      .usageMetadata.thoughtsTokenCount // 0
    ] | @tsv' > "$TOKENS_DIR/$IDX.tsv" 2>/dev/null

    # Извлекаем текст из response (пропускаем thinking parts)
    TEXT=$(echo "$RAW" | jq -r '
      [.candidates[0].content.parts[] | select(.text and (has("thought") | not)) | .text] | join("")
    ' 2>/dev/null) || true

    # Если text пустой, пробуем без фильтра thought
    if [ -z "$TEXT" ] || [ "$TEXT" = "null" ]; then
      TEXT=$(echo "$RAW" | jq -r '.candidates[0].content.parts[-1].text // empty' 2>/dev/null) || true
    fi

    # Логируем ошибки API
    if [ -z "$TEXT" ] || [ "$TEXT" = "null" ]; then
      local API_ERROR=$(echo "$RAW" | jq -r '.error.message // empty' 2>/dev/null)
      if [ -n "$API_ERROR" ]; then
        log "GEMINI ERROR for $REL_PATH: $API_ERROR"
      else
        log "GEMINI ERROR (no text) for $REL_PATH: $(echo "$RAW" | head -c 300)"
      fi
      echo "ERROR" > "$RESULT_FILE"
      return
    fi
  else
    # ---- Haiku via claude -p ----
    local TMPFILE=$(mktemp /tmp/indexer-XXXXXXXX)
    printf 'Файл: %s\n\nСодержимое:\n%s' "$REL_PATH" "$CONTENT" > "$TMPFILE"

    TEXT=$(claude -p \
      --model haiku \
      --system-prompt "$SYSTEM_PROMPT" \
      --no-session-persistence \
      < "$TMPFILE" \
      2>> "$LOG_FILE") || true

    rm -f "$TMPFILE"
  fi

  if [ -z "$TEXT" ]; then
    echo "ERROR" > "$RESULT_FILE"
    log "ERROR (empty response): $REL_PATH"
    return
  fi

  log "RESPONSE for $REL_PATH: $(echo "$TEXT" | head -c 200)"

  # Парсим JSON (4 стратегии)
  local PARSED=""

  # Шаг 1: чистый JSON
  PARSED=$(echo "$TEXT" | jq --arg path "$REL_PATH" '. + {path: $path}' 2>/dev/null) || true

  # Шаг 2: markdown fence
  if [ -z "$PARSED" ] || [ "$PARSED" = "null" ]; then
    local CLEANED=$(echo "$TEXT" | sed -n '/^```/,/^```/p' | sed '/^```/d')
    PARSED=$(echo "$CLEANED" | jq --arg path "$REL_PATH" '. + {path: $path}' 2>/dev/null) || true
  fi

  # Шаг 3: { на начале строки
  if [ -z "$PARSED" ] || [ "$PARSED" = "null" ]; then
    local EXTRACTED=$(echo "$TEXT" | sed -n '/^{/,/^}/p' | head -20)
    PARSED=$(echo "$EXTRACTED" | jq --arg path "$REL_PATH" '. + {path: $path}' 2>/dev/null) || true
  fi

  # Шаг 4: { где угодно
  if [ -z "$PARSED" ] || [ "$PARSED" = "null" ]; then
    local EXTRACTED=$(echo "$TEXT" | grep -o '{.*}' | head -1)
    PARSED=$(echo "$EXTRACTED" | jq --arg path "$REL_PATH" '. + {path: $path}' 2>/dev/null) || true
  fi

  local FILE_END=$(date +%s)
  local FILE_ELAPSED=$((FILE_END - FILE_START))

  if [ -z "$PARSED" ] || [ "$PARSED" = "null" ]; then
    PARSED=$(jq -n --arg path "$REL_PATH" --arg raw "$TEXT" --arg hash "$FILE_HASH" \
      '{path: $path, hash: $hash, type: "unknown", explicit: [], implicit: [], related_components: [], raw_response: $raw}') || true
    echo "WARN:${FILE_ELAPSED}s" > "$RESULT_FILE.status"
  else
    PARSED=$(echo "$PARSED" | jq --arg hash "$FILE_HASH" '. + {hash: $hash}') || true
    echo "OK:${FILE_ELAPSED}s" > "$RESULT_FILE.status"
  fi

  echo "$PARSED" > "$RESULT_FILE"
}

# ===== Параллельный запуск =====
START_TIME=$(date +%s)
RUNNING=0
CACHED=0

for i in "${!FILES[@]}"; do
  FILE="${FILES[$i]}"
  REL_PATH="${FILE#$PROJECT_DIR/}"

  # Считаем хеш файла
  FILE_HASH=$(shasum -a 256 "$FILE" | cut -d' ' -f1)

  # Проверяем кеш: если хеш совпадает — пропускаем
  if [ -n "$HASH_MAP_FILE" ] && [ -f "$HASH_MAP_FILE" ]; then
    EXISTING_HASH=$(grep "^${REL_PATH}	" "$HASH_MAP_FILE" | cut -f2)
    if [ "$EXISTING_HASH" = "$FILE_HASH" ] && [ -n "$EXISTING_HASH" ]; then
      # Копируем существующую запись из индекса
      jq --arg path "$REL_PATH" '.[] | select(.path == $path)' "$INDEX_FILE" > "$RESULTS_DIR/$i.json" 2>/dev/null
      echo "CACHED:0s" > "$RESULTS_DIR/$i.json.status"
      CACHED=$((CACHED + 1))
      echo -e "  ${GREEN}cached${NC} $REL_PATH"
      continue
    fi
  fi

  # Запускаем в фоне
  process_file "$FILE" "$i" "$FILE_HASH" &
  RUNNING=$((RUNNING + 1))

  echo -e "${BLUE}[launched $((i+1))/$TOTAL]${NC} $REL_PATH"

  # Ждём, если достигли лимита параллельности
  while [ "$(jobs -rp | wc -l)" -ge "$MAX_PARALLEL" ]; do
    sleep 0.5
  done
done

# Ждём оставшиеся
echo ""
echo -e "${YELLOW}Waiting for remaining workers...${NC}"
wait

# ===== Сборка результатов =====
echo -e "${BLUE}Merging results...${NC}"

ERRORS=0
INDEXED=0
SKIPPED=0
WARNINGS=0

RESULTS="["
FIRST=true

for i in "${!FILES[@]}"; do
  RESULT_FILE="$RESULTS_DIR/$i.json"
  STATUS_FILE="$RESULTS_DIR/$i.json.status"
  REL_PATH="${FILES[$i]#$PROJECT_DIR/}"

  if [ ! -f "$RESULT_FILE" ]; then
    echo -e "  ${RED}missing${NC} $REL_PATH"
    ERRORS=$((ERRORS + 1))
    continue
  fi

  CONTENT=$(cat "$RESULT_FILE")

  if [ "$CONTENT" = "SKIP" ]; then
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  if [ "$CONTENT" = "ERROR" ]; then
    echo -e "  ${RED}error${NC} $REL_PATH"
    ERRORS=$((ERRORS + 1))
    continue
  fi

  # Читаем статус
  STATUS=""
  if [ -f "$STATUS_FILE" ]; then
    STATUS=$(cat "$STATUS_FILE")
  fi
  TIME_STR=$(echo "$STATUS" | cut -d: -f2)

  if echo "$STATUS" | grep -q "^CACHED"; then
    # уже залогировано при пропуске
    true
  elif echo "$STATUS" | grep -q "^WARN"; then
    echo -e "  ${YELLOW}wrapped${NC} $REL_PATH [${TIME_STR}]"
    WARNINGS=$((WARNINGS + 1))
  else
    echo -e "  ${GREEN}ok${NC} $REL_PATH [${TIME_STR}]"
  fi

  # Добавляем в JSON массив
  if [ "$FIRST" = true ]; then
    FIRST=false
  else
    RESULTS="${RESULTS},"
  fi
  RESULTS="${RESULTS}${CONTENT}"
  INDEXED=$((INDEXED + 1))
done

RESULTS="${RESULTS}]"

# Записываем и форматируем
if [ "$USE_GEMINI" = true ] && [ "$GEMINI_WRITE" = false ]; then
  echo "$RESULTS" | jq '.' 2>/dev/null | pbcopy
  echo -e "${GREEN}Result copied to clipboard (pbcopy)${NC}"
  echo "$RESULTS" | jq '.' > "$PROJECT_DIR/scripts/ai/gemini-index-preview.json" 2>/dev/null
  echo -e "${GREEN}Preview saved: scripts/ai/gemini-index-preview.json${NC}"
else
  echo "$RESULTS" | jq '.' > "$INDEX_FILE" 2>/dev/null
fi

END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

echo ""
echo -e "${GREEN}========================================${NC}"
if [ "$USE_GEMINI" = true ] && [ "$GEMINI_WRITE" = false ]; then
  echo -e "${GREEN}Gemini dry-run complete (index NOT modified)${NC}"
elif [ "$USE_GEMINI" = true ]; then
  echo -e "${GREEN}Gemini index built: $INDEX_FILE${NC}"
else
  echo -e "${GREEN}Index built: $INDEX_FILE${NC}"
fi
echo -e "${GREEN}Files indexed: $INDEXED/$TOTAL (cached: $CACHED, skip: $SKIPPED, warn: $WARNINGS, err: $ERRORS)${NC}"
echo -e "${GREEN}Time: ${ELAPSED}s (parallel: $MAX_PARALLEL)${NC}"

# Суммируем токены Gemini и считаем стоимость
if [ "$USE_GEMINI" = true ] && ls "$TOKENS_DIR"/*.tsv &>/dev/null; then
  TOTAL_PROMPT=0
  TOTAL_OUTPUT=0
  TOTAL_THINK=0

  for f in "$TOKENS_DIR"/*.tsv; do
    read -r p o a t < "$f" 2>/dev/null || continue
    TOTAL_PROMPT=$((TOTAL_PROMPT + ${p:-0}))
    TOTAL_OUTPUT=$((TOTAL_OUTPUT + ${o:-0}))
    TOTAL_THINK=$((TOTAL_THINK + ${t:-0}))
  done

  # Gemini Flash pricing: input $0.15/1M, output $0.60/1M, thinking $3.50/1M
  COST=$(awk "BEGIN {
    inp = ${TOTAL_PROMPT} * 0.15 / 1000000;
    out = ${TOTAL_OUTPUT} * 0.60 / 1000000;
    thn = ${TOTAL_THINK} * 3.50 / 1000000;
    printf \"%.4f\", inp + out + thn
  }")
  COST_INPUT=$(awk "BEGIN { printf \"%.3f\", ${TOTAL_PROMPT} * 0.15 / 1000000 }")
  COST_OUTPUT=$(awk "BEGIN { printf \"%.3f\", ${TOTAL_OUTPUT} * 0.60 / 1000000 }")
  COST_THINK=$(awk "BEGIN { printf \"%.3f\", ${TOTAL_THINK} * 3.50 / 1000000 }")

  echo -e "${YELLOW}── Gemini Token Usage & Cost ──${NC}"
  echo -e "${YELLOW}  Input:    $(printf '%7d' $TOTAL_PROMPT) tok  \$${COST_INPUT}${NC}"
  echo -e "${YELLOW}  Output:   $(printf '%7d' $TOTAL_OUTPUT) tok  \$${COST_OUTPUT}${NC}"
  echo -e "${YELLOW}  Thinking: $(printf '%7d' $TOTAL_THINK) tok  \$${COST_THINK}${NC}"
  echo -e "${YELLOW}  ─────────────────────────${NC}"
  echo -e "${YELLOW}  TOTAL COST: \$${COST}${NC}"
fi

echo -e "${GREEN}========================================${NC}"

# Cleanup token dir
rm -rf "$TOKENS_DIR" 2>/dev/null
