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
- 本人に確認待ち: events.jsonl と DB に残る旧ルールのテスト発注 2 件（5803 10/05 19:41）を消すか／スマホから見たいなら認証付きで LAN 公開するか。
- 残り（本人）: 寄り付きで「いま撮影」の読取と撮影 ms・サイドカーの auto.price を実画面と照合。
- 未対応: 実 DB の旧指値状態は次の daily で再判定。信用ドテンの -flip ラウンド詳細の建玉表示（従来どおり）。web-start と daily の migrate 同時実行の排他なし。

## 録画リプレイ練習（10-06 00:05 更新）
- 目的: 平日 8:53 に HYPER SBI 2 の画面を 37 分録画し、後で再生しながら小窓で練習発注（通常のペーパーと別記録・別建玉）。web は source=REPLAY で一覧・集計。
- 現状: c58b625（web）/ 98080de（panel）/ da3ea4d（launchd）push 済み。panel 110・web 314 件通過、常駐 web は再ビルド済み。Codex 5観点レビュー14件中13件反映（残り1件=スリープ起床は pmset sleep 0 のため不要）。
  実ピクセル録画 5120x2880 で 1 分 14.7MB、録画コマから BoardReader で 5,566 / 15:30 を読めた。実 DB に migration 適用済み（SBI 927 件・-524485.5 不変）。
- 次: 10-06 8:53 の初回自動録画を確認（~/Library/Logs/tradelog/record.log と recordings/2026-10-06/*.json の status・issues。ロック中に録れるかが未検証）。
  TradePanel は本人が 10-05 23:30 に終了済み。8:53 は record-run.sh が --record-minutes で起動する。
