# ペーパートレード イベント契約（panel → web）

発注小窓（`apps/panel`）が追記し、web（`apps/web`）が取り込む。**追記専用**。既存行を書き換えない・消さない。

- 置き場所: `data/paper/events.jsonl`（1 行 1 イベントの JSON、UTF-8、改行 `\n`）。スクショは `data/paper/shots/YYYY-MM-DD/<event id>.png`。
- `data/paper/` は git 管理外（リポジトリは PUBLIC）。
- 取り込みは冪等: `id` が既に取り込み済みなら無視する。
- 時刻 `ts` はミリ秒付き ISO8601、JST オフセット付き（例 `2026-10-05T09:01:23.456+09:00`）。DB には UTC で保存する。
- 価格・数量は **文字列の10進数**（浮動小数を経由させない）。数量は株数。
- 本物の発注は存在しない。panel は外部に一切送信しない（このファイルへの追記だけ）。

## 共通フィールド
| key | 型 | 説明 |
|---|---|---|
| `v` | 1 | 契約バージョン |
| `id` | string(UUID) | イベント ID（一意） |
| `type` | `order` / `fill_mark` / `cancel` / `memo` | |
| `ts` | string | 押した瞬間の時刻 |

## `order`
| key | 型 | 説明 |
|---|---|---|
| `position_id` | UUID | 建玉 ID。新規建てで panel が発行、決済・買い増しは既存の ID |
| `intent` | `open` / `add` / `close` | |
| `symbol` | string | 東証コード（例 `7203`, `285A`） |
| `side` | `buy` / `sell` | open+sell = 空売り |
| `qty` | string | 株数 |
| `order_type` | `market` / `limit` | |
| `limit_price` | string \| null | 指値のみ |
| `shot` | object \| null | 発注時の HYPER SBI 2 画面（撮れなかったら null） |

`shot`:
| key | 型 | 説明 |
|---|---|---|
| `path` | string | `data/paper/` からの相対パス |
| `price_text` | string \| null | 現在値領域の読み取り生文字列 |
| `price` | string \| null | 数値として解釈できた現在値（カンマ除去済み）。不確かなら null |
| `symbol_text` | string \| null | 銘柄コード領域の読み取り生文字列 |
| `confidence` | number \| null | 読み取り信頼度 0〜1 |

## `fill_mark`（指値が約定したと本人が判断して押した）
`order_id`（対象の order の id）。web 側で以降の 1 分足と照合して確定/要確認にする。

## `cancel`（指値の取消）
`order_id`。当日中に `fill_mark` も `cancel` も無い指値は、引け後に失効扱い。

## `memo`
`position_id`（必須）, `order_id`（任意）, `text`（音声入力の文字列そのまま）。建玉中・決済後いつでも追記できる。

## 約定価格の確定規則（web 側）
1. 板寄せの時間帯の成行 → その板寄せの価格・時刻で約定。足が無ければ「未確定」。
   - 寄り前（〜08:59:59）→ 日足始値・09:00。昼休み（11:30〜12:29）→ 12:30 の分足始値・12:30。
   - 引けの板寄せ（15:25〜15:29）→ 日足終値・15:30。大引け後（15:30〜）→「未確定」。
2. 連続売買中の成行 → `shot.price`。その分の 1 分足があれば [low, high] 内か照合、無ければ日足 [low, high] で照合。
   読めない・範囲外 → その分の足の close を仮置きして「要確認」。足も無ければ「未確定」。
3. 指値:
   - 板寄せの時間帯に出した指値は、板寄せの価格が指値以内（買い: ≤ / 売り: ≥）ならその価格で約定。
   - 連続売買中に発注時の `shot.price` で即約定する指値（買い: 指値 ≥ 現在値 / 売り: 指値 ≤ 現在値）は、
     規則 2 と同じく現在値で約定（指値で頭打ち）。実際の約定は現在値付近のため。
   - それ以外は `fill_mark` の時刻・指値で約定とし、発注〜fill_mark の 1 分足が指値を**越えて**いれば確定（同値は越えていない扱い）、
     越えていなければ「要確認」、足が欠けて判定できなければ「未確定」。
4. 「要確認」「未確定」は web から手入力で確定（`priceBasis = manual`）。
