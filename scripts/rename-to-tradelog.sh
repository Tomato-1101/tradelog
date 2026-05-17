#!/usr/bin/env bash
# trades → tradelog にリポジトリフォルダを改名し、Claude Code の履歴 (jsonl) も
# 新パスに追従させるためのワンショットスクリプト。
#
# ⚠ 重要 (CLAUDE.md 7.5 の手順をスクリプト化):
# 1. このスクリプトは現在 *動いていない* Claude Code セッションでのみ走らせること。
#    現セッションは cwd=/Users/tomato/Project/trades なので、まず Claude Code を
#    完全に終了 (全タブを閉じる) してから別ターミナルで実行する。
# 2. Next.js dev server (apps/web) と Python sidecar (apps/api-py) を止めてから実行。
# 3. 終了後の手動作業:
#    - apps/api-py/.venv は絶対パスを内部に持つので *再作成* が安全。
#    - GitHub remote の URL は変わらない (リポ名は tradelog で push 済)。
#
# 取り消し: スクリプトは旧フォルダを削除せず .bak-renamed-to-tradelog-YYYY-MM-DD/
# にリネームするだけ。動作確認したあと、ユーザー判断で `rm -rf` する。

set -euo pipefail

OLD="/Users/tomato/Project/trades"
NEW="/Users/tomato/Project/tradelog"

CLAUDE_OLD="$HOME/.claude/projects/-Users-tomato-Project-trades"
CLAUDE_NEW="$HOME/.claude/projects/-Users-tomato-Project-tradelog"

STAMP=$(date "+%Y-%m-%d")

if [ ! -d "$OLD" ]; then
  echo "[rename] $OLD が見つからない" >&2
  exit 1
fi
if [ -d "$NEW" ]; then
  echo "[rename] $NEW が既に存在する。中止" >&2
  exit 1
fi

echo "[rename] 1/5 リポジトリフォルダを mv"
mv "$OLD" "$NEW"
echo "  $OLD -> $NEW"

echo "[rename] 2/5 旧 venv を退避 (絶対パスを含むため再作成推奨)"
if [ -d "$NEW/apps/api-py/.venv" ]; then
  mv "$NEW/apps/api-py/.venv" "$NEW/apps/api-py/.venv-trades.bak"
  echo "  退避: apps/api-py/.venv -> .venv-trades.bak"
fi

if [ -d "$CLAUDE_OLD" ]; then
  echo "[rename] 3/5 Claude Code 履歴 (jsonl) を新パスにコピー"
  mkdir -p "$CLAUDE_NEW"
  cp -a "$CLAUDE_OLD/." "$CLAUDE_NEW/"
  echo "  $CLAUDE_OLD -> $CLAUDE_NEW"

  echo "[rename] 4/5 jsonl 内の絶対パスを置換"
  python3 - <<PY
import os, pathlib, re
new_dir = pathlib.Path("$CLAUDE_NEW")
old_path = "$OLD"
new_path = "$NEW"
for f in new_dir.rglob("*.jsonl"):
    raw = f.read_text(encoding="utf-8", errors="replace")
    out = raw.replace(old_path, new_path).replace("-Users-tomato-Project-trades", "-Users-tomato-Project-tradelog")
    if out != raw:
        f.write_text(out, encoding="utf-8")
        print(f"  rewrote {f.relative_to(new_dir)}")
for f in (new_dir / "memory").glob("*.md") if (new_dir / "memory").is_dir() else []:
    raw = f.read_text(encoding="utf-8")
    out = raw.replace(old_path, new_path)
    if out != raw:
        f.write_text(out, encoding="utf-8")
        print(f"  rewrote memory/{f.name}")
PY

  echo "[rename] 5/5 旧 Claude Code 履歴を bak リネーム"
  mv "$CLAUDE_OLD" "${CLAUDE_OLD}.bak-renamed-to-tradelog-${STAMP}"
  echo "  $CLAUDE_OLD -> ${CLAUDE_OLD}.bak-renamed-to-tradelog-${STAMP}"
else
  echo "[rename] 3-5/5 Claude Code 履歴フォルダが見つからない ($CLAUDE_OLD)。スキップ"
fi

echo
echo "[done] フォルダリネーム完了。次の手動作業:"
echo "  1. cd $NEW/apps/api-py && python3.12 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt && pip install futu-api"
echo "  2. Claude Code を起動し、cd $NEW した状態で /resume — 履歴一覧に過去会話が出ることを確認"
echo "  3. cd $NEW/apps/web && npm run build / vitest run で疎通確認"
echo "  4. 問題なければ $NEW/apps/api-py/.venv-trades.bak と ${CLAUDE_OLD}.bak-renamed-to-tradelog-${STAMP} を rm -rf"
