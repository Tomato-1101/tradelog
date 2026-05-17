#!/usr/bin/env bash
# Next.js (apps/web) と Python サイドカー (apps/api-py) を同時起動する。
# Ctrl-C で両方止める。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

pids=()
cleanup() {
  echo
  echo "[dev] stopping..."
  for pid in "${pids[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Next.js
( cd "$ROOT/apps/web" && npm run dev ) &
pids+=($!)

# Python sidecar (起動できる場合のみ)
if [ -d "$ROOT/apps/api-py/.venv" ] && [ -f "$ROOT/apps/api-py/main.py" ]; then
  (
    cd "$ROOT/apps/api-py"
    # shellcheck disable=SC1091
    source .venv/bin/activate
    uvicorn main:app --reload --host 127.0.0.1 --port 8770
  ) &
  pids+=($!)
else
  echo "[dev] skipping api-py (no .venv or main.py)"
fi

wait
