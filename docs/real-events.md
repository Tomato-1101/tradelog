# 本番の注文記録 イベント契約（panel-win → web）

Windows の記録小窓（`apps/panel-win`）が追記し、Mac の `scripts/pull-win.sh` が回収して web が取り込む。**追記専用**。
小窓は HYPER SBI 2 の「全板」窓を裏で見張り、売注・買注の列に本人の注文が出た・消えた瞬間を数字だけで残す。
本人が理由を声で入力欄に入れると、その文も残す。画像は撮らない・送らない。本物の発注・外部送信は一切しない（ファイルへの追記だけ）。

- Windows: `%USERPROFILE%\tradelog\data\real\events.jsonl`（1 行 1 イベントの JSON、UTF-8・BOM なし、改行 `\n`）。
- Mac: `data/real/events.jsonl`（git 管理外。リポジトリは PUBLIC）に丸ごと回収される。
- 取り込みは冪等: `id` が既に取り込み済みなら無視する。行が書きかけ（JSON として読めない）なら飛ばす。
- **`"test": true` の行は取り込まない**（動作確認用。`scripts/win-panel.sh clean-test` で消せる）。
- 時刻はすべてミリ秒付き ISO8601・PC の時計（JST）のオフセット付き（例 `2026-11-11T10:36:33.073+09:00`）。
- 旧版（v1, `type: real_memo`、タグボタン＋画像）の行が残っていてもよい。web は v1 も従来どおり読む。

## 全板の見え方（2026-11-11 実測、HYPER SBI 2）
- 自分の注文は 売注 列（青い数字）・買注 列（赤い数字）に株数で出る。
- 発注: マスの背景が一瞬（実測 0.09〜0.34 秒）白っぽくなり、そのあと数字が出る。
- 約定: 数字がそのまま消える（背景は白くならない）。
- 取消・訂正: 背景が白っぽくなったまま数秒（実測 2.4〜3.7 秒）続いてから消える。訂正は新しい値段のマスに出直す。
- 小窓は 1 秒に約 30 回見ている。どの状態も最低 2〜3 回は捉えられる。

## `board_order`（注文のマスの変化 1 回 = 1 行）
| key | 型 | 説明 |
|---|---|---|
| `v` | 2 | 契約バージョン |
| `type` | `board_order` | |
| `id` | string(UUID) | 行の ID（一意） |
| `ts` | string | その状態を最初に見たフレームの時刻 |
| `order_key` | string(UUID) | 同じマスの注文の一生（出てから消えるまで）に共通の ID。小窓の中だけの番号で SBI の注文番号ではない |
| `event` | string | 下の表 |
| `side` | `BUY` \| `SELL` | 買注 列なら BUY、売注 列なら SELL（新規か返済かは区別しない。Mac が SBI の約定で決める） |
| `price` | number \| null | そのマスの行の値段（OCR）。読めなければ null |
| `qty` | number \| null | マスの株数（OCR）。白い背景の間・消えた後は、同じ `order_key` で前に読めた値。一度も読めなければ null |
| `pending_ms` | number \| null | `placed`: 白い背景が出てから数字が出るまで。`cancelled`: 白くなってから消えるまで。他は null |
| `symbol` | string \| null | 窓のタイトルの `(...)` の中（例 `9984`）。取れなければ null |
| `symbol_name` | string \| null | タイトルの銘柄名（例 `ソフトバンクグループ`） |
| `board` | object[] | その瞬間の板（OCR、見えている行すべて、上から順）。読めなかった値は null |
| `test` | true（任意） | 動作確認の記録。取り込まない |

`event`:
| 値 | 意味（マスの見え方の移り変わり） |
|---|---|
| `placed` | 空 → 白い背景 → 数字。発注が通った（`ts` は白い背景が出た時刻） |
| `appeared` | 空 → いきなり数字（白い背景を見ていない）。別の窓からの発注や、白い背景が短すぎた発注 |
| `cancel_requested` | 数字 → 白い背景。取消か訂正を始めた |
| `cancelled` | 白い背景 → 空（`cancel_requested` の後）。取消・訂正で元の値段から消えた |
| `reverted` | 白い背景 → 数字に戻った（`cancel_requested` の後。訂正で株数だけ変えた等） |
| `filled` | 数字 → 空（白い背景を経ない）。約定した（全部約定して消えた） |
| `vanished` | 白い背景 → 空（数字を一度も見ていない）。発注が通らなかった等 |

- 訂正は「元の値段の `cancel_requested` → `cancelled`」と「新しい値段の `placed` か `appeared`」が数秒以内に続く形で出る（Mac 側で組にする）。
- 板をスクロールしても注文は追い続ける（値段の列の模様で行のずれを測る）。画面の外に出ている間はイベントを出さない。
- 銘柄（窓のタイトル）が変わったら追跡をやり直す（切り替えで消えた注文は `filled` にしない）。

`board[]`:
| key | 型 | 説明 |
|---|---|---|
| `price` | number \| null | 値段。`OVER` / `UNDER` の行は null で `label` に入る |
| `label` | string（任意） | `OVER` / `UNDER` |
| `sell` | number \| null | 売の数量 |
| `buy` | number \| null | 買の数量 |
| `sell_count` | number \| null | 売件数 |
| `buy_count` | number \| null | 買件数 |
| `my_sell` | number \| null | 自分の売注 |
| `my_buy` | number \| null | 自分の買注 |

## `real_note`（理由の入力 1 回 = 1 行）
| key | 型 | 説明 |
|---|---|---|
| `v` | 2 | |
| `type` | `real_note` | |
| `id` | string(UUID) | |
| `ts` | string | 保存した時刻 |
| `text` | string | 入力欄の文（voicekey の入力のまま。前後の空白は除く。空なら行を出さない） |
| `last_order` | object \| null | 保存した時点で最後に見た `board_order` の `{order_key, event, side, price, ts}`。手がかりで、結び付けの正は Mac |
| `test` | true（任意） | |
| `symbol` | string \| null（任意） | 銘柄コード。小窓は保存した時に全板で見ていた銘柄（全板が無ければ null）。手で書いたメモは必須（下記） |
| `position` | `LONG` \| `SHORT`（任意） | 建ての向き。手で書いたメモだけが持ち、`symbol` と組で使う |

### 手で書いたメモ（`data/real/manual-notes.jsonl`、Mac だけ）
- 小窓を使わなかった日の理由を後から入れる場所。形は `real_note` と同じで、`symbol`・`position` を付ける（`ts` は概算でよい）。
- `events.jsonl` は Windows から丸ごと上書きされるので別ファイルにする。daily が両方を読む（`--manual-notes` で差し替え可）。
- 結び付けは銘柄が書いてあれば銘柄を優先し、同じ日（日本時間）・同じ銘柄・同じ向きの建て約定に載せる（`linkMethod` = `symbol_day`）。
  約定に時刻が無い日でも結び付く。時刻付きの約定が複数あればメモの時刻に最も近いもの。

## 取り込みと結び付け（web 側）
- 小窓のメモは `last_order` の注文が約定に結び付いていればその約定、無ければ前後 5 分の建て約定のうち `symbol` と同じ銘柄で最も近いもの（`symbol` が null なら銘柄を見ない）。
- `npm run daily` が毎回 `data/real/events.jsonl` を読み、新しい `id` だけ DB に入れる。
- 結び付けは daily のたびに全件やり直す（SBI の約定時刻は後から注文履歴で付くため）。規則は web の実装（`apps/web/lib/real/`）が正。
- 理由の文が長いものは daily で LLM（Groq の無料枠）が短く要約する。鍵が無い・失敗した時は要約なしで続ける。
