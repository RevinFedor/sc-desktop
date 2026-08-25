#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
ROOT="$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd)"
PYTHON="$ROOT/.venv/bin/python3"

if [[ ! -x "$PYTHON" ]]; then
  echo "Не найден Python runtime SC Desktop: $PYTHON" >&2
  echo "Сначала выполните: cd '$ROOT' && npm run python:setup" >&2
  exit 2
fi

exec "$PYTHON" "$ROOT/python-workers/web/boosty_full_channel.py" "$@"
