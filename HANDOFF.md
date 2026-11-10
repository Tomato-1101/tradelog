# HANDOFF — tradelog

## 恒久要件
- リポジトリは **PUBLIC**。`data/` 配下（DB・CSV 原本・ペーパーのイベント/スクショ・AI 書き出し）は絶対に push しない。コミット前に `git check-ignore` で確認。
- `data/raw/` は原本。上書き・削除禁止。
- 発注小窓は本物の発注を一切しない（外部送信なし）。誤発注が構造的に起き得ないことを保つ。
- 旧版は `v0-legacy` タグ（07dccca）。古い UI・デザイン・サイドカーは流用しない。純粋ロジックだけ移植＋テスト強化。
- 損益計算を触るときは実 CSV の正解値との照合テストを先に作る（CLAUDE.md）。
- 計画書: `~/.claude/plans/sunny-singing-gray.md`。イベント契約: `docs/paper-events.md`。

## ペーパートレード v1 作り直し（10-05 21:10 更新）
- 目的: HYPER SBI 2 で値動きを見ながら、最前面の自作小窓でペーパー発注 → 音声メモ → 後から約定確定 → 1分足チャートに売買点 → 集計 → AI が読める書き出し。
- 現状: edde576 まで push 済み（web 292・panel 84）。両建て禁止＋ドテン（2回押し）、全画面 OCR の自動読取（領域は任意）、撮影 ms 表示、
  web は launchd 常駐（127.0.0.1:3000 のみ）＋平日15:45 daily（AI 分析はしない）。Codex 5観点レビュー13件は全件反映済み。
- 本人に確認待ち: スマホから見たいなら認証付きで LAN 公開するか。
- 10-06 本人指示でテスト発注 2 件（DB・events.jsonl・スクショ）と試し録画 3 本を削除済み（DB は data/backups/app-20261006-005429.db、events は paper-events-20261006-005429.jsonl、ファイルは ~/.Trash/tradelog-test-20261006）。
- 残り（本人）: 寄り付きで「いま撮影」の読取と撮影 ms・サイドカーの auto.price を実画面と照合。
- 未対応: 実 DB の旧指値状態は次の daily で再判定。信用ドテンの -flip ラウンド詳細の建玉表示（従来どおり）。web-start と daily の migrate 同時実行の排他なし。

## 録画リプレイ練習（10-06 00:05 更新）
- 目的: 平日 8:53 に HYPER SBI 2 の画面を 37 分録画し、後で再生しながら小窓で練習発注（通常のペーパーと別記録・別建玉）。web は source=REPLAY で一覧・集計。
- 現状: c58b625（web）/ 98080de（panel）/ da3ea4d（launchd）push 済み。panel 110・web 314 件通過、常駐 web は再ビルド済み。Codex 5観点レビュー14件中13件反映（残り1件=スリープ起床は pmset sleep 0 のため不要）。
  実ピクセル録画 5120x2880 で 1 分 14.7MB、録画コマから BoardReader で 5,566 / 15:30 を読めた。実 DB に migration 適用済み（SBI 927 件・-524485.5 不変）。
- 10-06 本人決定: **朝の自動録画はやめる**（本人が自分で起きて取引する）。launchd record は停止・削除済み、install.sh は RECORD=1 の時だけ入れる。
  理由: HYPER SBI 2 は毎日 6:30 頃のメンテで切断、再ログインはスマホの FIDO 認証が必須で無人では録れない。録画・リプレイ機能のコードは残す（手動の「今すぐ録画」は使える）。

## 本番の癖分析・Windows 記録小窓（11-10 18:55 更新）
- 目的: SBI 本番のエントリー時刻（秒）と 1 分足・記録ボタンの画像から「どんな形で入る癖があるか」を分析する。本人はデイトレを Windows で行う。
- 現状: main に fa61eae まで取り込み済み（未 push）。常駐 web 再ビルド済み。SBI 注文履歴（詳細）を Chrome から収集 → data/raw/sbi-orders/part1・part2.json（10/16〜11/09）→ `npm run import:sbi-orders` で 564 件中 539 件に時刻。
  1 分足 104 銘柄日取得済み、MAE/MFE 241 本。損益合計 -741715.5 不変。Windows（SSH 鍵 ~/.config/tradelog/ssh/win_ed25519、宛先は ~/.config/tradelog/win.conf）に apps/panel-win を配置、ログオン時起動タスク tradelog-panel。
  Mac は launchd com.tomato.tradelog.pullwin が平日 8:30〜18:00 に 10 分おき回収 → data/real/ → daily が RealMemo に取り込み建て約定に結び付け。
- 次: (1) HYPER SBI 2 窓の撮影経路が未確認。初の本物の記録の shots[].method（print/screen）と画像を見る。(2) 注文履歴は約 3 か月・セッション 2.5〜4 時間で切れる。定期的に Chrome で収集して import:sbi-orders（収集 JS は本セッションの記録にしかないので、要ならスクリプト化）。
  (3) Yahoo 1 分足は 9:05 以降しか無く寄り 5 分の取引は形を測れない。
