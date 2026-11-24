#!/bin/bash
# Windows PC（apps/panel-win を動かす取引用 PC）へ SSH するための共通設定（source して使う）。
# 接続先はリポジトリに書かず ~/.config/tradelog/win.conf に置く（PUBLIC リポのため）:
#   WIN_HOST=192.168.x.x
#   WIN_USER=<Windows のユーザー名>
#   WIN_KEY=$HOME/.config/tradelog/ssh/win_ed25519   # 省略時はこの値
# コマンドは win_ps で渡す（引用の崩れを避けて PowerShell 5.1 に -EncodedCommand で送る）。ファイルは win_put / win_get。
# Windows の OpenSSH の既定シェルが WSL の時（2026-11 に別プロジェクトが wsl.exe にした）は、ssh にコマンドを引数で渡すと
# 「wsl.exe -c」で失敗し、sftp/scp も壊れる。その時は bash の台本を stdin で流し、WSL から powershell.exe を呼ぶ。
# どちらかは win_shell が最初に調べる（win.conf に WIN_SHELL=wsl / windows と書けば固定）。Windows 側の設定は変えない。

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

# Windows の OpenSSH の既定シェルを調べて WIN_SHELL（wsl / windows）に入れる。サブシェルでなく呼び出し元で 1 回呼ぶ。
# ssh が繋がらなければ 255 を返す（WIN_SHELL は決めない）
win_shell() {
  [ -n "${WIN_SHELL:-}" ] && return 0
  local out code
  out="$(printf 'uname -s 2>/dev/null\n' | ssh -T "${WIN_SSH_OPTS[@]}" "$WIN_USER@$WIN_HOST" 2>/dev/null)"
  code=$?
  [ "$code" -eq 255 ] && return 255
  case "$out" in *Linux*) WIN_SHELL=wsl ;; *) WIN_SHELL=windows ;; esac
}

# WSL の bash から見た Windows のホーム（%USERPROFILE%）を H に入れる台本の 1 行目
# （cmd.exe は stdin を読むので </dev/null を付ける。付けないと台本の続きの行を食べてしまう）
WIN_WSL_HOME='H="$(wslpath "$(/mnt/c/Windows/System32/cmd.exe /c "echo %USERPROFILE%" </dev/null 2>/dev/null | tr -d "\r")")"'
WIN_WSL_PS=/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe

# bash の台本（stdin）を WSL で実行する。WIN_SHELL=wsl の時だけ使う
_win_wsl() { ssh -T "${WIN_SSH_OPTS[@]}" "$WIN_USER@$WIN_HOST"; }

# PowerShell のスクリプト文字列を Windows で実行する。標準出力は UTF-8。ssh が繋がらなければ 255 を返す
win_ps() {
  local script="[Console]::OutputEncoding=[Text.Encoding]::UTF8; \$ProgressPreference='SilentlyContinue'; $1"
  local enc
  enc="$(printf '%s' "$script" | iconv -f UTF-8 -t UTF-16LE | base64 | tr -d '\n')"
  win_shell || return $?
  if [ "$WIN_SHELL" = wsl ]; then
    printf 'exec %s -NoProfile -NonInteractive -EncodedCommand %s </dev/null\n' "$WIN_WSL_PS" "$enc" | _win_wsl | tr -d '\r'
    return "${PIPESTATUS[1]}"
  fi
  ssh "${WIN_SSH_OPTS[@]}" "$WIN_USER@$WIN_HOST" "powershell -NoProfile -NonInteractive -EncodedCommand $enc" | tr -d '\r'
  return "${PIPESTATUS[0]}"
}

# パスに使える文字だけか（台本に埋め込むので引用を壊す文字を断る）
_win_safe_rel() {
  case "$1" in *..*|*[\"\$\`\\]*|/*) echo "想定外のパス: $1" >&2; return 1 ;; esac
}

# Mac のファイルを Windows のホームからの相対パス（/ 区切り）へ送る。途中で切れても壊れた物を残さない
win_put() {
  local src="$1" rel="$2"
  _win_safe_rel "$rel" || return 1
  win_shell || return $?
  if [ "$WIN_SHELL" = wsl ]; then
    { printf '%s\n' "$WIN_WSL_HOME" "set -e; f=\"\$H/$rel\"; mkdir -p \"\$(dirname \"\$f\")\"; base64 -d > \"\$f.part\" <<'__TRADELOG_EOF__'"
      base64 -b 76 -i "$src"
      printf '%s\n' '__TRADELOG_EOF__' 'mv -f "$f.part" "$f"'; } | _win_wsl
    return "${PIPESTATUS[1]}"
  fi
  scp -q "${WIN_SSH_OPTS[@]}" "$src" "$WIN_USER@$WIN_HOST:$rel"
}

# Windows のホームからの相対パスのファイルを Mac の dst に取る
win_get() {
  local rel="$1" dst="$2"
  _win_safe_rel "$rel" || return 1
  win_shell || return $?
  if [ "$WIN_SHELL" = wsl ]; then
    printf '%s\n' "$WIN_WSL_HOME" "exec cat \"\$H/$rel\"" | _win_wsl >"$dst"
    return "${PIPESTATUS[1]}"
  fi
  printf -- 'get "%s" "%s"\n' "$rel" "$dst" | sftp -q -b - "${WIN_SSH_OPTS[@]}" "$WIN_USER@$WIN_HOST" >/dev/null
}

# 記録の Mac 側の置き場。本体のチェックアウトの data/real（worktree から実行しても本体に入れる）。TRADELOG_DATA で差し替え可
win_real_dir() {
  local repo="$1" common
  if [ -n "${TRADELOG_DATA:-}" ]; then echo "$TRADELOG_DATA/real"; return; fi
  common="$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || common="$repo/.git"
  echo "$(dirname "$common")/data/real"
}
