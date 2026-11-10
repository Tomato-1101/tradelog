#!/bin/bash
# Windows の記録小窓（apps/panel-win）が書いた本番エントリー記録を Mac の data/real/ へ取ってくる。
# events.jsonl は追記型なので丸ごと取り直す（中身が同じなら置き換えない）。画像（shots/）は Mac に無い・大きさが違うものだけ取る。
# Mac 側では何も消さない。何度回しても同じ結果。Windows が落ちている・つながらない時は 1 行ログに残して正常終了する。
#   --scheduled  launchd から呼ぶ時に付ける。平日 8:30〜17:59 以外は何もせずに終わる
# 接続先は scripts/win-lib.sh（~/.config/tradelog/win.conf）。保存先は本体のチェックアウトの data/real（TRADELOG_DATA で差し替え可）。
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [pull-win] $*"; }
. "$HERE/launchd/lib.sh"
rotate_log "${TRADELOG_LOG:-}"
. "$HERE/win-lib.sh"

if [ "${1:-}" = "--scheduled" ]; then
  dow="$(date +%u)" hm="$(date +%H%M)"
  { [ "$dow" -le 5 ] && [ "$hm" -ge 0830 ] && [ "$hm" -le 1759 ]; } || exit 0
fi
win_check_conf || exit 1

DEST="$(win_real_dir "$ROOT")"
REMOTE=tradelog/data/real # sftp はユーザーのホーム（%USERPROFILE%）から始まる

errf="$(mktemp -t pull-win-err)"
batch="$(mktemp -t pull-win)"
trap 'rm -f "$batch" "$errf"' EXIT

# Windows にあるファイル（相対パス<TAB>バイト数）。書きかけ（.tmp）と動作確認の口（cmd\）は除く
listing="$(win_ps '$d = Join-Path $env:USERPROFILE "tradelog\data\real"
  if (!(Test-Path $d)) { exit 0 }
  Get-ChildItem -LiteralPath $d -Recurse -File |
    Where-Object { $_.Extension -ne ".tmp" -and $_.FullName -notlike (Join-Path $d "cmd\*") } |
    ForEach-Object { $_.FullName.Substring($d.Length + 1).Replace("\", "/") + "`t" + $_.Length }' 2>"$errf")"
code=$?
if [ "$code" -eq 255 ]; then
  log "Windows（$WIN_HOST）につながらないので今回は取らない（$(tail -n 1 "$errf")）"
  exit 0
elif [ "$code" -ne 0 ]; then
  log "Windows で一覧を作れなかった（exit $code）:"
  cat "$errf"
  exit 1
fi

mkdir -p "$DEST"
want=() sizes=() gets=""
while IFS=$'\t' read -r rel size; do
  [ -n "$rel" ] || continue
  case "$rel" in *..*) log "想定外のパスを飛ばす: $rel"; continue ;; esac
  case "$rel" in
    events.jsonl) ;;
    shots/*.png) [ -f "$DEST/$rel" ] && [ "$(stat -f%z "$DEST/$rel")" = "$size" ] && continue ;;
    *) continue ;;
  esac
  mkdir -p "$(dirname "$DEST/$rel")"
  # 先頭の - は「この 1 件が失敗しても残りを続ける」
  line="$(printf -- '-get "%s/%s" "%s.part"' "$REMOTE" "$rel" "$DEST/$rel")"
  # events.jsonl を先に取る（小窓は画像を書き終えてから行を足すので、取った行の画像は必ず Windows にある）
  if [ "$rel" = events.jsonl ]; then gets="$line"$'\n'"$gets"; else gets="$gets$line"$'\n'; fi
  want+=("$rel") sizes+=("$size")
done <<<"$listing"
printf '%s' "$gets" >"$batch"

if [ "${#want[@]}" -eq 0 ]; then
  log "Windows にまだ記録が無い"
  exit 0
fi

if ! sftp -q -b "$batch" "${WIN_SSH_OPTS[@]}" "$WIN_USER@$WIN_HOST" >/dev/null; then
  log "sftp が途中で失敗した（取れた分だけ反映する）"
fi

events="-" images=0
for i in "${!want[@]}"; do
  rel="${want[$i]}" part="$DEST/${want[$i]}.part"
  [ -f "$part" ] || continue
  if [ "$rel" = events.jsonl ]; then
    if cmp -s "$part" "$DEST/$rel"; then
      rm -f "$part"
      events="変化なし"
    else
      mv -f "$part" "$DEST/$rel"
      events="更新（$(wc -l <"$DEST/$rel" | tr -d ' ') 行）"
    fi
  elif [ "$(stat -f%z "$part")" = "${sizes[$i]}" ]; then
    mv -f "$part" "$DEST/$rel"
    images=$((images + 1))
  else
    rm -f "$part" # 取っている間に変わった。次回取り直す
  fi
done
log "events.jsonl: $events / 新しい画像: $images 枚"
