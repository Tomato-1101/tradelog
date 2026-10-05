#!/bin/bash
# 引け後の daily を 1 回実行する（launchd の com.tomato.tradelog.daily から呼ばれる）。
# やるのはファイル書き出しまで。AI の呼び出し（分析）はしない。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT/apps/web"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [daily] $*"; }
. "$ROOT/scripts/launchd/lib.sh"
rotate_log "${TRADELOG_LOG:-}"

# 画面の警告用の状態ファイル（lib/daily-status.ts と同じ形）。daily.ts まで行けずに止まったときはここで「失敗」を書く
STATUS="$ROOT/data/daily-status.json"
STARTED="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
write_failed() {
  local msg="${1//\\/\\\\}"
  msg="${msg//\"/\\\"}"
  local now
  now="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  printf '{"v":1,"startedAt":"%s","finishedAt":"%s","result":"failed","error":"%s","barFailures":0,"sidecarErrors":0,"ordersIngested":0}\n' \
    "$STARTED" "$now" "$msg" > "$STATUS.tmp" && mv "$STATUS.tmp" "$STATUS"
}

if ! command -v node >/dev/null 2>&1; then
  log "node が見つからない（PATH=$PATH）。scripts/launchd/install.sh を入れ直す"
  write_failed "node が見つからない。scripts/launchd/install.sh を入れ直す"
  exit 1
fi

if ! ensure_migrated; then
  write_failed "migration の確認・適用に失敗（daily.log に復旧手順）"
  exit 1
fi

log "開始（node $(node -v)）"
mark="$(mktemp)"
touch -A -01 "$mark" # 同じ秒に書かれた状態ファイルも「新しい」と判定できるよう 1 秒戻す
node_modules/.bin/tsx scripts/daily.ts
code=$?
# daily.ts が状態を書けずに落ちた（読み込みエラー・強制終了など）ときは、ここで失敗を書く
if [ "$code" -ne 0 ] && ! [ "$STATUS" -nt "$mark" ]; then
  write_failed "daily.ts が異常終了（exit $code）"
fi
rm -f "$mark"
log "終了（exit $code）"
exit "$code"
