# 本番エントリー記録 イベント契約（panel-win → web）

Windows の記録小窓（`apps/panel-win`）が追記し、Mac の `scripts/pull-win.sh` が回収して web が取り込む。**追記専用**。
本人が HYPER SBI 2 でエントリーした瞬間にボタンを押し、その時のチャート画面・時刻・タグを残す。後で SBI の約定（秒まで）と時刻で突き合わせる。
本物の発注・外部送信は一切しない（ファイルへの追記だけ）。

- Windows: `%USERPROFILE%\tradelog\data\real\events.jsonl`（1 行 1 イベントの JSON、UTF-8・BOM なし、改行 `\n`）。画像は `shots\YYYY-MM-DD\<id>-<n>.png`。
- Mac: `data/real/`（git 管理外。リポジトリは PUBLIC）に同じ構成で回収される。`events.jsonl` は丸ごと取り直し、画像は差分だけ。
- 小窓は画像を書き終えて（`.tmp` から名前を変えて）から行を足す。Mac では行の画像がまだ回収されていないことがある（次の回収で揃う）。
- 取り込みは冪等: `id` が既に取り込み済みなら無視する。行が書きかけ（JSON として読めない）なら飛ばす。
- **`"test": true` の行は取り込まない**（SSH からの動作確認用。`scripts/win-panel.sh clean-test` で消せる）。

## フィールド
| key | 型 | 説明 |
|---|---|---|
| `v` | 1 | 契約バージョン |
| `type` | `real_memo` | |
| `id` | string(UUID) | 記録 ID（一意） |
| `ts` | string | ボタン・ホットキーを押した瞬間。ミリ秒付き ISO8601、PC の時計（JST）のオフセット付き（例 `2026-11-11T09:21:32.123+09:00`） |
| `tags` | string[] | 押したタグボタン（例 `["押し目"]`）。「記録」ボタン・ホットキーは `[]` |
| `shots` | object[] | 撮った画像。撮影がすべて失敗したら `[]`（時刻とタグは残る） |
| `active_window_title` | string | 押した時に前面にあった窓のタイトル（小窓は押してもフォーカスを奪わない） |
| `test` | true（任意） | 動作確認の記録。取り込まない |
| `capture_error` | string（任意） | 撮影・保存の失敗の内容 |

`shots[]`:
| key | 型 | 説明 |
|---|---|---|
| `path` | string | `data/real/` からの相対パス（`/` 区切り） |
| `window_title` | string \| null | HYPER SBI 2 の窓のタイトル（銘柄が出る窓ならここに残る）。モニタ全体なら null |
| `process` | `"HYPERSBI2"` \| null | モニタ全体なら null |
| `rect` | [x, y, w, h] | 画面上の位置（実ピクセル。窓は影を除いた見た目の矩形） |
| `method` | `print` / `screen` / `monitor` | `print`: 窓だけを PrintWindow で撮った。`screen`: PrintWindow が黒・失敗で窓の矩形を画面からコピー（上に重なった窓も写る）。`monitor`: HYPER SBI 2 が起動していない・窓が全部最小化 → 前面の窓があるモニタ全体 |

撮るのは HYPER SBI 2（`HYPERSBI2.exe`）の見えているトップレベル窓すべて（Z 順で上から。最小化・非表示・小さな窓 120x80 未満は除く）。

## 取り込みと SBI 約定への結び付け（web 側）
- `npm run daily` が毎回 `data/real/events.jsonl` を読み、新しい `id` だけ DB（`RealMemo`）に入れる。`test` の行・書きかけの行は入れない。
- 結び付けは daily のたびに全件やり直す（SBI の約定時刻は後から注文履歴で付くため）。
  候補は SBI の時刻付き（`timePrecision=ms`）の建て約定（現物買・信用新規買・信用新規売）。記録の `ts` との差が **60 秒以内**のうち
  差の絶対値が最小のもの。同じ差なら約定の早い方、同じ時刻なら約定 id の小さい方。無ければ結び付けない。実装は `apps/web/lib/real/memos.ts` が正。
- AI 書き出し（`data/ai/trades.jsonl`）では、結び付いた記録がその約定のラウンドの `real_memos`（時刻・約定時刻・差・タグ・画像のパス）に入る。
