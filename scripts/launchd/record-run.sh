#!/bin/bash
# 小窓（TradePanel）に「37 分録画」を指示する（launchd の com.tomato.tradelog.record から平日 8:53 に呼ばれる）。
# 録画そのものは小窓の中で行う（画面収録の許可は小窓に付いているため）。ここは画面を消さないことと、指示を届けることだけ。
# 起動中なら URL（tradepanel://record?minutes=37）で、起動していなければ起動引数（--record-minutes 37）で届ける。
# どちらも前面には出さない（open -g）。ネットワークは使わない。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP="$ROOT/apps/panel/build/Build/Products/Release/TradePanel.app"
MINUTES=37
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [record] $*"; }
. "$ROOT/scripts/launchd/lib.sh"
rotate_log "${TRADELOG_LOG:-}"

if [ ! -d "$APP" ]; then
  log "小窓が見つからない: $APP（apps/panel で ./scripts/build.sh を実行する）"
  exit 1
fi

# 録画中（37 分＋余裕）に画面が消えたりスリープしたりすると黒画面になるので 45 分止める
caffeinate -u -d -t 2700 &
CAF=$!
sleep 1

# 指示を出した後に小窓が書く今日の録画のメタで、録画が始まったかを確かめる（指示が届かなかった・小窓が古いビルドで録画を知らない等に気づくため）
REC_DIR="$ROOT/data/paper/replay/recordings/$(date +%F)"
MARKER="$(mktemp -t tradelog-record)"
touch "$MARKER"

if pgrep -x TradePanel >/dev/null; then
  log "起動中の小窓に $MINUTES 分の録画を指示する"
  open -g -a "$APP" "tradepanel://record?minutes=$MINUTES"
else
  log "小窓を起動して $MINUTES 分の録画を指示する"
  open -g -a "$APP" --args --record-minutes "$MINUTES"
fi
code=$?
[ "$code" -ne 0 ] && log "open が失敗した（exit $code）。録画の結果は小窓の設定「録画」と data/paper/replay/recordings/ のメタを見る"

wait_recording_started "$REC_DIR" "$MARKER" 90
started=$?
rm -f "$MARKER"
if [ "$started" -ne 0 ]; then
  [ "$started" -eq 2 ] && log "録画が失敗した（$REC_DIR のメタの issues を見る）"
  log "録画が始まらなかった（小窓が古いビルド/画面収録の許可/データフォルダ未設定を確認）"
  kill "$CAF" 2>/dev/null
  exit 1
fi
log "録画が始まった（$REC_DIR）"

wait "$CAF"
log "終了（画面の点灯の維持を解除）"
exit "$code"
