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
./scripts/dev.sh                                   # 振り返り画面 http://127.0.0.1:3000（127.0.0.1 だけで待ち受ける）
cd apps/web && npm run daily                       # 引け後: 取り込み → 足の取得 → 約定確定 → 再計算 → AI 書き出し
cd apps/web && npm run import:sbi -- ../../data/raw/sbi/*.csv   # 本番の約定 CSV を取り込む（重複は除外）
./scripts/backup-db.sh                             # DB のバックアップ（data/backups/）
```

- Yahoo の 1 分足は約 30 日前までしか遡れない。取りこぼさないよう daily は早めに回す。
- 画面を撮れなかった・読めなかった約定は「要確認」「未確定」になる。画面の「要確認」から価格を手入力して確定する。
- SBI の CSV は日付だけで時刻が無い。同じ日の売買は「買い → 売り」の順とみなすため、取り込み期間より前に買った株をその日に売り、同じ日に買い直した場合は、損益が実際とずれることがある。
- 現物で、持っている株数を超える売りは「期間外に買った株の売却」として扱う（建値が分からないので損益は計算しない）。
- 手で囲んだ領域の現在値が読めない・その分の 1 分足の外のときは、小窓のサイドカー（`shots/…/<注文 id>.ocr.json`）の自動読取の値で照合する（根拠「発注時の画面（自動読取）」）。サイドカーは後から書かれるので、daily を回し直すと要確認から確定に上がることがある（手入力した値は上書きしない）。

### 常駐と自動実行（macOS の launchd）

```sh
./scripts/launchd/install.sh     # 常駐と自動実行を入れる（入れ直しも同じ）
./scripts/launchd/uninstall.sh   # 止めて外す（ログは残す）
```

- 振り返り画面（`com.tomato.tradelog.web`）: ログイン時に本番ビルド（`next start`、http://127.0.0.1:3000）で起動し、落ちたら再起動する。
  この Mac からだけ見える（LAN には出さない）。スマホで見るなら認証が要るので別途。
  起動のたびに、ソースが前回のビルドより新しければ `next build` してから起動する。コードを変えた後は
  `launchctl kickstart -k gui/$(id -u)/com.tomato.tradelog.web` で再起動すると作り直される。ビルドに失敗したら前回のビルドのまま起動する（web.log に出る）。
- web・daily とも起動前に未適用の migration を調べ、あれば `scripts/backup-db.sh` → `prisma migrate deploy` してから進む（失敗したら止まり、ログに復旧手順を出す）。
- daily（`com.tomato.tradelog.daily`）: 平日 15:45 に `npm run daily` と同じ処理を実行する。スリープ中に過ぎた分は復帰時に 1 回実行される。
  祝日は足が無いだけでそのまま動く。AI の呼び出し（分析）はしない（`data/ai/` への書き出しまで）。
  今すぐ 1 回回す: `launchctl kickstart gui/$(id -u)/com.tomato.tradelog.daily`
  結果は `data/daily-status.json` に残り、失敗・一部失敗（足の取得失敗など）・2 営業日以上未実行のときだけ画面の上部に警告が出る。
- 録画（`com.tomato.tradelog.record`）: **既定では入れない**（HYPER SBI 2 は毎朝 6:30 頃に切断され、再ログインにスマホ認証が要るので無人では録れない）。入れるときは `RECORD=1 ./scripts/launchd/install.sh`。入れると平日 8:53 に `caffeinate -u -d -t 2700`（45 分は画面を消さない）を張ってから、小窓（TradePanel）に 37 分の録画を指示する
  （起動中なら `open -g -a TradePanel.app 'tradepanel://record?minutes=37'`、起動していなければ `--args --record-minutes 37` で起動。前面には出さない・ネットワークは使わない）。
  録画は小窓の中で行い、`data/paper/replay/recordings/` に残す（自動では消さない）。小窓は `apps/panel/build/Build/Products/Release/TradePanel.app` を使うので、
  ビルドし直したら起動中の小窓も起動し直す。ロック中・ディスプレイが消えている間は録れないことがある（録れなかった区間はメタの `issues` に残る）。詳しくは `apps/panel/README.md`「録画リプレイ練習」。
  指示から 90 秒以内に新しい録画メタが `status: recording` にならなければ、`record.log` に「録画が始まらなかった（小窓が古いビルド/画面収録の許可/データフォルダ未設定を確認）」と書いて失敗で終わる。
  容量の実測は 1 分 約 15 MB（37 分で約 540 MB/日、20 営業日で約 11 GB）。データフォルダのディスクの空きが 5 GB 未満なら録画しない（ゴミ箱に移しただけでは空きは戻らない）。
- ログ: `~/Library/Logs/tradelog/web.log` / `daily.log` / `record.log`（5MB を超えたら `.1` に回して 1 世代だけ残す）。状態: `launchctl print gui/$(id -u)/com.tomato.tradelog.web`
- 一時的に止める: `launchctl bootout gui/$(id -u)/com.tomato.tradelog.web`（daily も同様）。戻すときは `install.sh` を再実行する。
- node は install 時に見つけた場所（`NODE_BIN=/path/to/node` で指定可）を使う。node を入れ替えたら `install.sh` を再実行する
  （better-sqlite3 が合わなければ先に `cd apps/web && npm rebuild better-sqlite3`）。
- install.sh は 3000 番を別のプロセスが使っていたら、その PID とコマンドを出して登録を中止する。常駐中は 3000 番を使うので、開発時は `./scripts/dev.sh` の前に止めるか、`cd apps/web && npx next dev -H 127.0.0.1 -p 3001` のように別の番号で起動する。

## 開発

- テスト: `cd apps/web && npm test`、`cd apps/panel && ./scripts/test.sh`
- 型とビルド: `cd apps/web && npm run build`
- 外部送信が無いことの検査: `cd apps/panel && ./scripts/check-no-network.sh`
- 旧版（moomoo 連携・Python サイドカー・旧 UI）は `v0-legacy` タグにだけ残している。

## ライセンス

MIT
