#!/bin/bash
# install.sh で入れた常駐と自動実行を止めて外す。ログ（~/Library/Logs/tradelog）は残す。
set -euo pipefail

AGENTS="$HOME/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"
for label in com.tomato.tradelog.web com.tomato.tradelog.daily com.tomato.tradelog.record; do
  if launchctl bootout "$DOMAIN/$label" 2>/dev/null; then
    echo "停止: $label"
  else
    echo "読み込まれていない: $label"
  fi
  rm -f "$AGENTS/$label.plist"
done
