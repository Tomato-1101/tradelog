# tradelog — プロジェクト指針（毎セッション自動読込）

ローカル完結のトレード復習 + 資産管理アプリ。構成や機能の一次資料は `README.md` と `docs/`。

- `apps/web`: Next.js 16 (App Router) + Prisma 7 (SQLite) + lightweight-charts v5（Node 22 以上）
- `apps/api-py`: FastAPI サイドカー（moomoo OpenAPI + yfinance）
- `data/app.db`: SQLite 本体（gitignore）。`data/raw/`: ユーザー投入の取引履歴 CSV（**原本。上書き・削除禁止**）
- 起動は `scripts/dev.sh`、DB バックアップは `scripts/backup-db.sh`

## このプロジェクトで過去に繰り返した失敗（先に知る）

1. **損益・手数料計算を触るときは、正解値との答え合わせを先に作る。**
   過去にオプション損益の誤差をユーザーに何度も指摘され、ユーザーが正解値（実際の累計損益）を
   提示するまで収束しなかった。計算ロジック変更時は、実 CSV からの期待値テストを書いて通してから報告する。
2. **moomoo OpenD は起動していない前提で書く・確かめる。**
   OpenD 非起動時に futu の接続リトライで API がハングし、healthz 確認が詰まった事例あり。
   OpenD 依存の処理はタイムアウト/optional 扱いを確認し、ヘルスチェックは即応答することを確かめる。
3. **「修正した」と報告する前に画面で確認する**（チャート状態リセット等、「直ってない」指摘が複数回あった）。
   detail は `deploy-verify` / `root-cause-debug` スキル参照。
4. 長丁場の実装はコンテキスト枯渇で分断された実績あり（3回）。
   フェーズ・恒久要件・現在地は `HANDOFF.md` に書いてから進める（`session-handoff` スキル）。

## 検証コマンド

- web: `cd apps/web && npm run build`（型 + ビルド）
- api-py: `.venv` の python で `python -m py_compile <file>`、テストがあれば pytest
- DB を壊しうる変更の前に `scripts/backup-db.sh`
