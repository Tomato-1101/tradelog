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

# ダウンロードに落とした SBI の約定 CSV（SaveFile_*.csv）を data/raw/sbi へ写して取り込む。
# 中身が同じ CSV は取り込み済みとして飛ばす（原本は上書きしない）。取り込みに失敗しても daily は続ける
pick_sbi_csv() {
  local dl="${TRADELOG_DOWNLOADS:-$HOME/Downloads}" raw="$ROOT/data/raw/sbi" f h dest have
  local new=()
  mkdir -p "$raw"
  # ~/Downloads は macOS の権限（ファイルとフォルダ）で launchd からは読めないことがある。黙って「無し」にしない
  if ! ls "$dl" >/dev/null 2>&1; then log "ダウンロード（$dl）を読めない（macOS の権限）。SBI の CSV は拾わずに続ける"; return 0; fi
  have="$(shasum -a 256 "$raw"/*.csv 2>/dev/null | cut -d' ' -f1)"
  for f in "$dl"/SaveFile_*.csv; do
    [ -f "$f" ] || continue
    h="$(shasum -a 256 "$f" | cut -d' ' -f1)" || continue
    grep -qx "$h" <<<"$have" && continue
    dest="$raw/SaveFile_$(date -r "$f" '+%Y%m%d_%H%M%S')_$(basename "$f" .csv | sed 's/^SaveFile_//').csv"
    [ -e "$dest" ] && continue
    cp -n "$f" "$dest" || continue
    new+=("$dest")
    have+=$'\n'"$h"
  done
  if [ ${#new[@]} -eq 0 ]; then log "ダウンロードに新しい SBI の CSV なし"; return 0; fi
  log "SBI の CSV を拾った: ${new[*]##*/}"
  node_modules/.bin/tsx scripts/import-sbi.ts "${new[@]}" || log "SBI の CSV の取り込みに失敗（daily は続ける）"
}
# 既定 OFF（2026-11-12 本人「自分でやる」。launchd からは ~/Downloads を読めないため）。TRADELOG_PICK_SBI_CSV=1 で ON
[ "${TRADELOG_PICK_SBI_CSV:-0}" = 1 ] && pick_sbi_csv
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
