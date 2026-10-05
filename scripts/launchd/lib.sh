#!/bin/bash
# web-start.sh / daily-run.sh が共通で使う関数（source して使う）。
# 前提: 呼び出し側で ROOT（リポジトリ直下）と log() を定義し、apps/web に cd 済み。

# launchd のログ（StandardOutPath）は無制限に伸びるので、5MB を超えたら .1 に回して 1 世代だけ残す。
# launchd が開いたままのファイルなので mv ではなくコピーして切り詰める（追記モードなので以降は先頭から書かれる）。
rotate_log() {
  local f="${1:-}"
  [ -n "$f" ] && [ -f "$f" ] || return 0
  local size
  size="$(stat -f%z "$f" 2>/dev/null || echo 0)"
  if [ "$size" -gt $((5 * 1024 * 1024)) ]; then
    cp "$f" "$f.1" && : > "$f"
    log "ログが ${size} バイトになったので $f.1 に回した"
  fi
}

# 未適用の migration があれば、DB をバックアップしてから適用する（スキーマ変更を pull しただけで画面や daily が壊れないように）。
# 失敗したら 1 を返す（呼び出し側で止まる）。
ensure_migrated() {
  local out
  if out="$(node_modules/.bin/prisma migrate status 2>&1)"; then
    return 0
  fi
  if ! grep -q "have not yet been applied" <<<"$out"; then
    log "prisma migrate status が失敗した（未適用の判定ができないので止まる）:"
    echo "$out"
    return 1
  fi
  log "未適用の migration がある。バックアップしてから prisma migrate deploy を実行する:"
  sed -n '/have not yet been applied/,/^$/p' <<<"$out"
  if ! "$ROOT/scripts/backup-db.sh"; then
    log "バックアップに失敗したので migration を適用せずに止まる"
    return 1
  fi
  if ! node_modules/.bin/prisma migrate deploy; then
    log "prisma migrate deploy が失敗した。復旧手順:"
    log "  1. 原因を直す（エラーは上）。DB を戻すなら web と daily を止めて（scripts/launchd/uninstall.sh）"
    log "     data/backups/ の直前の app-*.db を data/app.db にコピーする"
    log "  2. cd apps/web && npx prisma migrate status で状態を確かめ、npx prisma migrate deploy を手で流す"
    log "  3. scripts/launchd/install.sh で入れ直す"
    return 1
  fi
  log "migration を適用した"
}

# 録画が始まったかを待つ（record-run.sh）。marker より後に書かれたメタ（<dir>/*.json）に "status":"recording" が現れたら 0、
# "failed" なら 2（すぐ返す）、timeout 秒たっても現れなければ 1。メタは小窓が録画を始めた直後に書く（docs/paper-events.md）
wait_recording_started() {
  local dir="$1" marker="$2" timeout="$3" i f
  for ((i = 0; i < timeout; i++)); do
    if [ -d "$dir" ]; then
      while IFS= read -r f; do
        grep -Eq '"status" *: *"recording"' "$f" && return 0
        grep -Eq '"status" *: *"failed"' "$f" && return 2
      done < <(find "$dir" -maxdepth 1 -name '*.json' -newer "$marker" 2>/dev/null)
    fi
    sleep 1
  done
  return 1
}
