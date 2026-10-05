#!/bin/bash
# 振り返り画面の常駐（com.tomato.tradelog.web）と引け後の daily（com.tomato.tradelog.daily）、
# 平日 8:53 の小窓への録画指示（com.tomato.tradelog.record。既定は入れない。RECORD=1 ./install.sh の時だけ）を
# ユーザーの LaunchAgents に入れて読み込む。何度実行してもよい（入れ直し）。
# node の場所は NODE_BIN で指定できる。無ければ PATH → ログインシェル（nvm 等）→ nvm.sh の順に探す。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs/tradelog"
DOMAIN="gui/$(id -u)"
LABELS=(com.tomato.tradelog.web com.tomato.tradelog.daily com.tomato.tradelog.record)
# 朝の自動録画は既定で切る（HYPER SBI 2 が毎朝 6:30 頃に切断され、無人では再ログインできないため。本人は自分で起きて取引する）
if [ "${RECORD:-0}" != 1 ]; then
  LABELS=(com.tomato.tradelog.web com.tomato.tradelog.daily)
  launchctl bootout "$DOMAIN/com.tomato.tradelog.record" 2>/dev/null && echo "停止: com.tomato.tradelog.record（自動録画は既定で切。入れるなら RECORD=1）" || true
  rm -f "$AGENTS/com.tomato.tradelog.record.plist"
fi

find_node() {
  if [ -n "${NODE_BIN:-}" ]; then echo "$NODE_BIN"; return; fi
  local n
  n="$(command -v node 2>/dev/null || true)"
  if [ -z "$n" ]; then
    n="$("${SHELL:-/bin/zsh}" -lic 'command -v node' 2>/dev/null | tail -n 1 || true)"
  fi
  if [ -z "$n" ] && [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
    n="$(bash -c '. "${NVM_DIR:-$HOME/.nvm}/nvm.sh" >/dev/null 2>&1; command -v node' || true)"
  fi
  echo "$n"
}

NODE="$(find_node)"
if [ -z "$NODE" ] || ! "$NODE" -v >/dev/null 2>&1; then
  echo "node が見つからない。NODE_BIN=/path/to/node ./install.sh で指定する" >&2
  exit 1
fi
NODE_DIR="$(cd "$(dirname "$NODE")" && pwd)"
echo "node: $NODE_DIR/node ($("$NODE" -v))"

# better-sqlite3 はネイティブモジュール。node を上げた後は ABI が合わず DB が開けないので、先に確かめる
if ! "$NODE" -e "new (require('$REPO/apps/web/node_modules/better-sqlite3'))(':memory:').close()" 2>/dev/null; then
  echo "この node で better-sqlite3 が読めない。cd apps/web && npm rebuild better-sqlite3 をしてから入れ直す" >&2
  exit 1
fi

# 3000 番を別のプロセスが使っていると web が起動に失敗し続けるので、登録をやめて知らせる。
# 入れ直しのときは自分の web が使っているので、先に外して空くのを待ってから調べる
launchctl bootout "$DOMAIN/com.tomato.tradelog.web" 2>/dev/null || true
pids=""
for _ in $(seq 1 20); do
  pids="$(lsof -nP -tiTCP:3000 -sTCP:LISTEN 2>/dev/null || true)"
  [ -z "$pids" ] && break
  sleep 0.5
done
if [ -n "$pids" ]; then
  echo "ポート 3000 を別のプロセスが使っているので登録を中止する（止めてから入れ直す）:" >&2
  ps -o pid=,command= -p $(echo $pids | tr ' ' ',') >&2 || true
  exit 1
fi

# sed の置換文字列で特別な意味を持つ文字（\ & |）を逃がす
esc() { printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'; }

mkdir -p "$AGENTS" "$LOG_DIR"
for label in "${LABELS[@]}"; do
  plist="$AGENTS/$label.plist"
  sed -e "s|__REPO__|$(esc "$REPO")|g" \
      -e "s|__NODE_DIR__|$(esc "$NODE_DIR")|g" \
      -e "s|__LOG_DIR__|$(esc "$LOG_DIR")|g" \
      "$HERE/$label.plist.template" > "$plist"
  plutil -lint "$plist" >/dev/null

  # 入れ直し: 読み込み済みなら外してから読み込む（bootout は少し遅れて終わることがあるので消えるまで待つ）
  launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
  for _ in $(seq 1 20); do
    launchctl print "$DOMAIN/$label" >/dev/null 2>&1 || break
    sleep 0.5
  done
  launchctl bootstrap "$DOMAIN" "$plist"
  echo "読み込み: $label ($plist)"
done

echo "ログ: $LOG_DIR/web.log / $LOG_DIR/daily.log / $LOG_DIR/record.log"
echo "画面: http://127.0.0.1:3000（この Mac からだけ）。初回は next build が走るので、開けるまで 1 分ほどかかることがある"
