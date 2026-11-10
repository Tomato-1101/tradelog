#!/bin/bash
# Windows PC（apps/panel-win を動かす取引用 PC）へ SSH するための共通設定（source して使う）。
# 接続先はリポジトリに書かず ~/.config/tradelog/win.conf に置く（PUBLIC リポのため）:
#   WIN_HOST=192.168.x.x
#   WIN_USER=<Windows のユーザー名>
#   WIN_KEY=$HOME/.config/tradelog/ssh/win_ed25519   # 省略時はこの値
# ログイン先のシェルは Windows PowerShell 5.1。コマンドは win_ps で渡す（引用の崩れを避けて -EncodedCommand で送る）。

WIN_CONF="${TRADELOG_WIN_CONF:-$HOME/.config/tradelog/win.conf}"
# shellcheck disable=SC1090
[ -f "$WIN_CONF" ] && . "$WIN_CONF"
WIN_KEY="${WIN_KEY:-$HOME/.config/tradelog/ssh/win_ed25519}"
WIN_SSH_OPTS=(-i "$WIN_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=5 -o ServerAliveInterval=5 -o ServerAliveCountMax=3)

win_check_conf() {
  if [ -z "${WIN_HOST:-}" ] || [ -z "${WIN_USER:-}" ]; then
    echo "接続先が未設定: $WIN_CONF に WIN_HOST と WIN_USER を書く" >&2
    return 1
  fi
}

# PowerShell のスクリプト文字列を Windows で実行する。標準出力は UTF-8。ssh が繋がらなければ 255 を返す
win_ps() {
  local script="[Console]::OutputEncoding=[Text.Encoding]::UTF8; \$ProgressPreference='SilentlyContinue'; $1"
  local enc
  enc="$(printf '%s' "$script" | iconv -f UTF-8 -t UTF-16LE | base64 | tr -d '\n')"
  ssh "${WIN_SSH_OPTS[@]}" "$WIN_USER@$WIN_HOST" "powershell -NoProfile -NonInteractive -EncodedCommand $enc" | tr -d '\r'
  return "${PIPESTATUS[0]}"
}

# 記録の Mac 側の置き場。本体のチェックアウトの data/real（worktree から実行しても本体に入れる）。TRADELOG_DATA で差し替え可
win_real_dir() {
  local repo="$1" common
  if [ -n "${TRADELOG_DATA:-}" ]; then echo "$TRADELOG_DATA/real"; return; fi
  common="$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || common="$repo/.git"
  echo "$(dirname "$common")/data/real"
}
