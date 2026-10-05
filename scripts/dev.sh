#!/usr/bin/env bash
# Next.js (apps/web) を起動する。127.0.0.1 だけで待ち受ける（スクショやフレームを返す経路に認証が無いので LAN には出さない）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/apps/web"
exec npm run dev
