# tradelog

日本株デイトレの練習と振り返りを、お金を使わずにローカルで完結させるアプリ。

- 値動きは HYPER SBI 2 で見て、発注だけを常に最前面の小窓で行う（ペーパートレード。本物の発注機能は持たない）
- 発注の瞬間に HYPER SBI 2 の画面を撮り、表示中の現在値を読み取って約定価格の根拠にする
- 音声入力のメモで「なぜ入ったか・なぜ出たか」を建玉中でも後からでも残せる
- 引け後に 1 分足を取って約定を確定し、チャートに売買の位置（ピン・約定価格の点・平均建値線）を表示する
- 勝率・ペイオフレシオ・期待値・PF・最大ドローダウン・時間帯別・銘柄別・損益曲線
- 本番の取引は SBI の約定履歴 CSV を取り込んで同じ画面で振り返る
- すべての売買・メモ・前後の足を AI が読める形（`data/ai/`）に書き出し、Claude Code に聞けば分析できる

データはすべてローカルの SQLite とファイルに置く。外部に出るのは足の取得（Yahoo）だけ。

## 構成

```
apps/panel   発注小窓（Swift / SwiftUI + NSPanel）。data/paper/events.jsonl に追記するだけ。外部送信なし（サンドボックスで遮断）
apps/web     振り返り画面と日次処理（Next.js 16 + Prisma 7 / SQLite + lightweight-charts v5）
docs/        paper-events.md（小窓 → web のイベント契約・約定価格の決め方）
data/        すべて gitignore（DB・CSV 原本・イベント・スクショ・AI 書き出し）
  app.db        SQLite 本体
  raw/sbi/      SBI の約定履歴 CSV（原本）
  paper/        events.jsonl とスクショ
  ai/           trades.jsonl（1 行 1 トレード）と summary.md
```

## セットアップ

```sh
cd apps/web
npm install
npx prisma migrate deploy   # data/app.db を作る
```

発注小窓のビルドと権限（画面収録・撮影範囲の設定）は `apps/panel/README.md`。

## 使い方

```sh
./scripts/dev.sh                                   # 振り返り画面 http://localhost:3000
cd apps/web && npm run daily                       # 引け後: 取り込み → 足の取得 → 約定確定 → 再計算 → AI 書き出し
cd apps/web && npm run import:sbi -- ../../data/raw/sbi/*.csv   # 本番の約定 CSV を取り込む（重複は除外）
./scripts/backup-db.sh                             # DB のバックアップ（data/backups/）
```

- Yahoo の 1 分足は約 30 日前までしか遡れない。取りこぼさないよう daily は早めに回す。
- 画面を撮れなかった・読めなかった約定は「要確認」「未確定」になる。画面の「要確認」から価格を手入力して確定する。
- SBI の CSV は日付だけで時刻が無い。同じ日の売買は「買い → 売り」の順とみなすため、取り込み期間より前に買った株をその日に売り、同じ日に買い直した場合は、損益が実際とずれることがある。
- 現物で、持っている株数を超える売りは「期間外に買った株の売却」として扱う（建値が分からないので損益は計算しない）。

## 開発

- テスト: `cd apps/web && npm test`、`cd apps/panel && ./scripts/test.sh`
- 型とビルド: `cd apps/web && npm run build`
- 外部送信が無いことの検査: `cd apps/panel && ./scripts/check-no-network.sh`
- 旧版（moomoo 連携・Python サイドカー・旧 UI）は `v0-legacy` タグにだけ残している。

## ライセンス

MIT
