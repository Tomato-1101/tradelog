# tradelog

ローカルで完結する個人向けトレード復習 + 資産管理アプリ。

- 取引履歴 (SBI 日本株 CSV / moomoo 米株・米株オプション API) を取り込み、ローソク足チャートに **エントリー/エグジットをピン留め**
- 勝率・ペイオフレシオ・期待値・プロフィットファクター・最大ドローダウン・銘柄別損益・月次バー・カレンダーヒートマップ
- すべてローカル動作。SQLite 1 ファイル DB。サーバや外部 SaaS にデータを送らない。
- 取り込んだバッチを「ノーカン (非表示)」「再表示」「削除」で柔軟に整理可能。

## スクリーンショット & 機能

- ダッシュボード: KPI + エクイティカーブ + 月次バー + 銘柄別 Top5
- トレード復習: ラウンド単位で OHLC を表示し、約定マーカー (BUY/SELL + 実約定価格の小円) で建値の位置まで可視化
- 統計: 期間プリセット (1M/3M/6M/1Y/YTD/ALL/カスタム) で再集計
- 取り込み: SBI CSV (注文一覧_約定履歴 / 注文一覧_当日約定) と moomoo OpenD API。ImportBatch 単位で非表示/再表示/削除

## 構成

```
apps/web      Next.js 16 (App Router) + Prisma 7 (SQLite) + Tailwind + lightweight-charts v5
apps/api-py   FastAPI サイドカー (moomoo OpenAPI + yfinance)
prisma/       スキーマ + マイグレーション + シード
data/raw/     ユーザーが投入する取引履歴 CSV (gitignore)
data/app.db   SQLite 本体 (gitignore)
docs/         セットアップ手順
```

## 必要環境

- Node.js 22 以上 (v25 で開発)
- Python 3.12 系 (moomoo-api SDK の対応都合、`pyenv` 推奨)
- moomoo OpenD (米株・オプションを使う場合のみ、`docs/OPEND_SETUP.md` 参照)

## 初回セットアップ

```sh
# Node 側
cd apps/web && npm install && cd ../..
cd apps/web && npx prisma migrate dev && cd ../..
npx tsx prisma/seed.ts

# Python 側 (米株・オプション機能を使うなら必須)
cd apps/api-py
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
pip install futu-api
```

## 開発起動

```sh
./scripts/dev.sh   # web + api-py を同時起動
```

- Next.js: <http://localhost:3000>
- FastAPI サイドカー: <http://127.0.0.1:8770> (`/healthz` で疎通確認)

## 取引履歴の取り込み

UI からインポートするファイルは下記のディレクトリに置くと、`/import` 画面から選択できる。

| ブローカー | パス | 形式 |
|---|---|---|
| SBI 証券 (日本株・信用) | `data/raw/sbi/*.csv` | 「注文一覧_約定履歴」「注文一覧_当日約定」(Shift_JIS / UTF-8 自動判定、和暦混在可) |
| moomoo (米株・オプション) | OpenD API 経由 | UI から「moomoo 全口座から取り込む」を押すと過去 90 日分を一括取得 |

ファイル名は自由。同じファイルを再投入しても `Execution.dedupeHash` の UNIQUE 制約で 2 重取り込みされない (取り込み画面で 新規 / 重複 件数が確認できる)。

### ImportBatch の管理

`/import` 画面の「直近の取り込み」リストで、バッチごとに次の操作ができる:

- **非表示 (ノーカン)**: 集計・チャート・Round 構築から除外する。データは残るのでいつでも戻せる。
- **再表示**: 非表示を解除して再集計する。
- **削除**: バッチに紐づく Execution を物理削除して該当ラウンドを再構築する (不可逆)。

## バックアップ

```sh
./scripts/backup-db.sh
# data/backups/app-YYYYMMDD-HHMMSS.db に SQLite online backup を保存。
# 直近 30 件を保持。
```

## プライバシー設計

- 取引履歴・口座番号・bank ID 等は **すべてローカルの `data/app.db`** に置く。
- moomoo の口座番号 (`uni_card_num`) や個人特有のスクリプトは `apps/web/scripts/*.local.ts` に分離し、`.gitignore` で除外している。
- `.env*` は除外、`data/raw/**` `data/backups/` `data/ohlc-cache/**` `data/app.db*` も除外。

## ライセンス

MIT。`docs/OPEND_SETUP.md` に moomoo OpenD のセットアップ手順を別途記載。
