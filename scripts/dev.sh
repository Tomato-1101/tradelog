#!/usr/bin/env bash
# Next.js (apps/web) を起動する。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/apps/web"
exec npm run dev
