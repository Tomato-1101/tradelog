#!/usr/bin/env bash
# data/app.db を data/backups/ に timestamp 付きでコピーする。
# 用途: 取り込み前 / 大きなマイグレーション前のスナップショット保存。
# SQLite の online backup (sqlite3 .backup) を使うので、書き込み中でも安全。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/data/app.db"
DEST_DIR="$ROOT/data/backups"

if [ ! -f "$SRC" ]; then
  echo "[backup] $SRC が見つからない" >&2
  exit 1
fi

mkdir -p "$DEST_DIR"
TS=$(date "+%Y%m%d-%H%M%S")
DEST="$DEST_DIR/app-$TS.db"

sqlite3 "$SRC" ".backup '$DEST'"
echo "[backup] -> $DEST ($(du -h "$DEST" | cut -f1))"

# 30 個より多い古いバックアップを削除
KEEP=30
COUNT=$(ls -1 "$DEST_DIR"/app-*.db 2>/dev/null | wc -l | tr -d ' ')
if [ "$COUNT" -gt "$KEEP" ]; then
  DROP=$((COUNT - KEEP))
  ls -1t "$DEST_DIR"/app-*.db | tail -n "$DROP" | while read -r f; do
    echo "[backup] prune $f"
    rm -- "$f"
  done
fi
