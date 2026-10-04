# tradelog — プロジェクト指針（毎セッション自動読込）

ローカル完結のトレード復習 + 資産管理アプリ。構成や機能の一次資料は `README.md` と `docs/`。

- `apps/web`: Next.js 16 (App Router) + Prisma 7 (SQLite) + lightweight-charts v5（Node 22 以上）。
  ペーパー/SBI の取り込み・約定確定・Round 集計・統計・AI 書き出しも TS でここに一本化（`lib/` と `scripts/`）
- `apps/panel`: 発注小窓（Swift）。`data/paper/events.jsonl` に追記するだけ。契約は `docs/paper-events.md` が正
- `data/app.db`: SQLite 本体（gitignore）。`data/raw/`: ユーザー投入の取引履歴 CSV（**原本。上書き・削除禁止**）
- `data/paper/`（イベント・スクショ）、`data/ai/`（AI 用書き出し）、`data/legacy/app-v0.db`（旧版 DB）も gitignore（本人の取引データ。PUBLIC なので絶対に入れない）
- 起動は `scripts/dev.sh`（web のみ）、DB バックアップは `scripts/backup-db.sh`
- 旧版（api-py サイドカー・moomoo 連携・旧 UI）は v0-legacy タグにだけ残っている

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

- web: `cd apps/web && npm test`（vitest。実 CSV のゴールデンは `data/raw/sbi/SaveFile_*.csv` が無ければ skip）
- web: `cd apps/web && npm run build`（型 + ビルド）
- スキーマ変更: `cd apps/web && npx prisma migrate dev --name <名前>`。空 DB での確認は
  `DATABASE_URL=file:/tmp/x.db npx prisma migrate deploy`（`DATABASE_URL` 未指定なら `data/app.db`）
- 一連の流れを本番 DB に触れずに確かめる: `DATABASE_URL=file:<一時DB> npm run daily -- --events <合成 events.jsonl> --out <一時ディレクトリ>`
- DB を壊しうる変更の前に `scripts/backup-db.sh`
- Node を上げたら `cd apps/web && npm rebuild better-sqlite3`（2026-10 に Node 26 へ上がって ABI 不一致で DB が開けなくなった。テストは DB を使わないので通ってしまう）

## 日々の運用（引け後）

- `cd apps/web && npm run daily`: `data/paper/events.jsonl` 取り込み → Yahoo の 1 分足/日足を取得して DB に保存 →
  ペーパー約定の価格確定 → Round 再計算（MAE/MFE 付き）→ `data/ai/` へ書き出し。何度回しても同じ結果（冪等）
  - `--no-fetch`（足を取らない）、`--events <path>`、`--out <dir>` で差し替え可
  - Yahoo の 1 分足は約 30 日前までしか遡れない。取りこぼした日は早めに daily を回す
- `npm run import:sbi -- <csv...>`: SBI の約定 CSV を取り込む（重複は自動で除外）→ Round 再計算
- 要確認・未確定の価格は手入力で確定する（`lib/paper/ingest.ts` の `setManualPrice`。MANUAL は daily で上書きされない）

## AI 分析の手順

1. `npm run daily` を回す（`data/ai/` は毎回全量を書き直す）
2. AI には `data/ai/summary.md`（全体・直近 30 日・PAPER・SBI の集計とデータ品質）を先に読ませ、
   個別の検討は `data/ai/trades.jsonl`（1 行 1 ラウンド: 約定・メモ・前後 30 分の 1 分足・スクショのパス）を読ませる
3. 「要確認」「未確定」を含むラウンドは損益が仮か未計算。分析結果を鵜呑みにする前に price_status を確認する
4. 書き出しは本人の取引データ。外部に送る・コミットする場合は本人の判断で
