#!/bin/bash
# 振り返り画面を本番ビルドで起動する（launchd の com.tomato.tradelog.web から呼ばれる）。
# ソースが前回ビルドより新しければ、ビルドしてから start する（古いビルドのまま動かさないため）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT/apps/web"
PORT="${TRADELOG_PORT:-3000}"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [web] $*"; }
. "$ROOT/scripts/launchd/lib.sh"
rotate_log "${TRADELOG_LOG:-}"

if ! command -v node >/dev/null 2>&1; then
  log "node が見つからない（PATH=$PATH）。scripts/launchd/install.sh を入れ直す"
  sleep 300 # KeepAlive で即再起動を繰り返さないよう待ってから終わる
  exit 1
fi

# Prisma クライアントは gitignore の生成物。schema の方が新しければ作り直す（DB のマイグレーションはしない）
if [ ! -f generated/prisma/client.ts ] || [ "$ROOT/prisma/schema.prisma" -nt generated/prisma/client.ts ]; then
  log "prisma generate"
  node_modules/.bin/prisma generate
fi

# 未適用の migration があればバックアップしてから当てる。失敗したら古いスキーマのまま動かさない
if ! ensure_migrated; then
  sleep 300
  exit 1
fi

# 前回ビルド（.next/BUILD_ID）より新しいソースが 1 つでもあればビルドし直す
needs_build() {
  [ -f .next/BUILD_ID ] || return 0
  [ -n "$(find app components lib public generated next.config.ts package.json package-lock.json tsconfig.json postcss.config.mjs \
    -newer .next/BUILD_ID -type f -print -quit 2>/dev/null)" ]
}

# next build は始めに .next を消すので、失敗すると前回のビルドも無くなる。.next.prev に退避しておき、失敗したら戻す
# （前回この退避の途中で落ちていたら、まず戻す）
if [ -d .next.prev ] && [ ! -f .next/BUILD_ID ]; then
  log "前回のビルドの退避（.next.prev）が残っていたので戻す"
  rm -rf .next
  mv .next.prev .next
fi

if needs_build; then
  log "ソースが前回のビルドより新しいので next build"
  rm -rf .next.prev
  [ -f .next/BUILD_ID ] && mv .next .next.prev
  if node_modules/.bin/next build; then
    rm -rf .next.prev
  elif [ -d .next.prev ]; then
    log "ビルドに失敗。前回のビルドに戻して起動する（直したら launchctl kickstart -k gui/$(id -u)/com.tomato.tradelog.web）"
    rm -rf .next
    mv .next.prev .next
  else
    log "ビルドに失敗し、前回のビルドも無い"
    sleep 300
    exit 1
  fi
fi

# この Mac からだけ見える（LAN には出さない）。スマホから見るなら認証を付けてから別途
log "next start -H 127.0.0.1 -p $PORT（node $(node -v)）"
exec node_modules/.bin/next start -H 127.0.0.1 -p "$PORT"
