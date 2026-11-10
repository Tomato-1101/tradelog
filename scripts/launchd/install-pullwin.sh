#!/bin/bash
# Windows の記録の回収（com.tomato.tradelog.pullwin）をユーザーの LaunchAgents に入れて読み込む。何度実行してもよい（入れ直し）。
# web / daily を入れ直さないよう install.sh とは分けてある（外すのは uninstall.sh でまとめて外れる）。
# 回収先は本体のチェックアウトの data/（worktree から入れても本体の data/real/ に入る）。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
MAIN="$(dirname "$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir)")"
DATA="${TRADELOG_DATA:-$MAIN/data}"
AGENTS="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs/tradelog"
DOMAIN="gui/$(id -u)"
LABEL=com.tomato.tradelog.pullwin

. "$REPO/scripts/win-lib.sh"
win_check_conf

esc() { printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'; }

mkdir -p "$AGENTS" "$LOG_DIR"
plist="$AGENTS/$LABEL.plist"
sed -e "s|__REPO__|$(esc "$REPO")|g" \
    -e "s|__DATA__|$(esc "$DATA")|g" \
    -e "s|__LOG_DIR__|$(esc "$LOG_DIR")|g" \
    "$HERE/$LABEL.plist.template" > "$plist"
plutil -lint "$plist" >/dev/null

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
for _ in $(seq 1 20); do
  launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break
  sleep 0.5
done
launchctl bootstrap "$DOMAIN" "$plist"
echo "読み込み: $LABEL ($plist)"
echo "回収先: $DATA/real  ログ: $LOG_DIR/pullwin.log"
