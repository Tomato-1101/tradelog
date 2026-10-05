# apps/panel — ペーパー発注の小窓

HYPER SBI 2 で値動きを見ながら、常に最前面の小窓でペーパー発注・決済・メモを記録する macOS アプリ。
**本物の発注は存在しない。** やることは `data/paper/events.jsonl` への追記（契約: `docs/paper-events.md`）と、
発注時の HYPER SBI 2 画面のスクショ保存（`data/paper/shots/YYYY-MM-DD/<event id>.png`）だけ。

## 構成

| パス | 中身 |
|---|---|
| `project.yml` | xcodegen の定義（`TradePanel.xcodeproj` はここから生成。生成物はコミットしない） |
| `App/` | `TradePanel.app` 本体（NSPanel を出すだけ）、`Info.plist`、`TradePanel.entitlements` |
| `PanelKit/` | ロジックと画面（framework）。イベント契約・再生（建玉の復元）・価格解釈・Vision 読み取り・ScreenCaptureKit 撮影・SwiftUI 画面 |
| `Tests/` | ユニットテスト（PanelKit だけを読み込む。小窓は画面に出ない・画面収録も使わない） |
| `scripts/` | `build.sh` / `test.sh` / `check-no-network.sh` |

## 必要なもの

- macOS 15 以上（開発は macOS 27 / Xcode 27 で確認）
- xcodegen（`brew install xcodegen`）
- 署名用の証明書 `Apple Development`（Team `9KT598FS4A`、DEVELOPMENT_TEAM で特定）がキーチェーンにあること。
  `security find-identity -v -p codesigning` で確認できる。

## ビルド・テスト・検査

```sh
cd apps/panel
./scripts/test.sh             # ユニットテスト（Debug）。見た目の確認用 PNG も shots-dev/ に書き出す
./scripts/build.sh            # Release ビルド → build/Build/Products/Release/TradePanel.app
./scripts/check-no-network.sh # 外部送信できないことの検査（違反なら exit 1）
```

`check-no-network.sh` が確かめること:
1. Swift ソースに通信・外部起動の API（URLSession、Network.framework、ソケット、NSWorkspace による URL 起動、WebKit、外部プロセス起動、URL 文字列など）が無い。
2. entitlements（ソースと、署名済みの成果物の両方）が App Sandbox あり・ネットワーク系（`network.client` / `network.server`）なし。
3. 成果物のバイナリが Network / WebKit / CFNetwork 等のフレームワークを直接リンクしていない。

App Sandbox を ON にしてネットワーク entitlement を付けていないので、OS のレベルでも外へは送信できない。
ファイルは、設定でユーザーが選んだフォルダ（security-scoped bookmark で記憶）の中にだけ書く。

## 起動

```sh
open apps/panel/build/Build/Products/Release/TradePanel.app
```

Dock には出ない（`LSUIElement`）。小窓を閉じるとアプリも終了する（書きかけの記録は書き切ってから終わる）。
設定は小窓の歯車ボタン、または小窓を選んだ状態で ⌘, 。

## 初回にやること（本人の操作が要る）

1. **データフォルダを選ぶ**: 初回起動で設定画面が開く。「選ぶ…」で `~/Project/tradelog/data/paper` を選ぶ
   （無ければダイアログ内で作る）。サンドボックスのため、ここで選んだフォルダにしか書けない。
2. **画面収録の権限**: 設定画面の「権限を求める」→ システム設定 > プライバシーとセキュリティ > 画面とシステムオーディオの収録 で
   「TradePanel（ペーパー発注）」を許可 → アプリを終了して起動し直す。
   - 毎回同じ Apple Development 証明書で署名しているので、再ビルドしても権限は外れない（ad-hoc 署名だと毎回外れる）。
   - macOS 15 以降は、画面収録を使うアプリに対して OS が定期的（約 1 か月ごと）に「引き続き許可するか」を確認してくることがある。その時は許可を選ぶ。
   - 権限が壊れた時のリセット: `tccutil reset ScreenCapture com.tomato.tradelog.panel`
3. **撮影対象のウィンドウ**: HYPER SBI 2 を起動した状態で「一覧を更新」→ 撮りたいウィンドウをタイトルで選ぶ
   （「自動」は画面に出ている最大のウィンドウ）。
4. **読み取り領域**: HYPER SBI 2 を画面に出した状態で、設定画面の「現在値」を選んで「画面上で囲む」を押す。
   画面が暗くなり HYPER SBI 2 のウィンドウだけ黄色い枠で明るく残るので、実物の現在値の数字をマウスでドラッグして囲む
   （Esc で取り消し。選んでいる間は設定画面と小窓が隠れる）。続けて「銘柄コード」を選んで同じように囲む。
   囲んだ直後に 1 回撮影して読み、設定画面に「切り出した拡大画像」と「生の文字列 → 解釈した値」が出るので、正しく読めるまで囲み直す。
   数字の周りに少し余白を取って囲むと安定する。下の縮小プレビューは位置の確認用（上でドラッグして囲み直すこともできる）。
   領域はウィンドウの大きさに対する比率で保存される（ウィンドウの位置を動かしても使えるが、レイアウトを変えたら囲み直す）。
   HYPER SBI 2 をフルスクリーンにしている時は、そのスペースで小窓の歯車から設定画面を開いてから押す
   （HYPER SBI 2 が今の画面に出ていないと「画面に出ていません」と出て、オーバーレイは出ない）。

## 使い方

- **銘柄**: 小窓にマウスを乗せると HYPER SBI 2 の銘柄コード領域を読んで自動入力する（1.5 秒に 1 回まで）。
  手で直した値は、HYPER SBI 2 側で別の銘柄に切り替わるまで上書きしない。虫眼鏡ボタンで強制的に読み直す。
- **株数**: 前回の値を覚える。
- **成行／指値**: 指値は「価格」欄に入れる（カンマ付きでも可）。
- **買い（赤）／売り（青）**: 同じ銘柄・同じ向きの建玉があれば買い増し（`add`）、無ければ新規（`open`。売りの新規 = 空売り）。
  反対向きのボタンでは決済しない（決済は建玉の行のボタンから）。
- 押した瞬間の時刻（ミリ秒）を記録し、HYPER SBI 2 を撮影して現在値・銘柄コード領域を読み、order を 1 行追記する。
  撮影が 3 秒で終わらない・権限が無い等で撮れなくても、発注の記録は `shot: null` で必ず残る。
  現在値は「数字・カンマ・小数点だけで、3 桁区切りが正しい」時だけ `price` に入れる。曖昧なら `null`（誤った値より null）。
- **建玉**: 方向・数量・平均建値（約定価格が 1 つでも不明なら「不明」）・経過時間。数量欄（既定は決済できる全数）と
  「決済（成行）」「決済（指値。上の価格欄の値）」。
- **待機中の指値**: 「約定した」（`fill_mark`）／「取消」（`cancel`）。
- **メモ**: 発注直後に自動でフォーカスが移る（音声入力でそのまま話せる）。⌘↩ で保存。対象の建玉はプルダウンで選べ、既定は直前に発注した建玉。
- 建玉・待機中の指値は、起動時に events.jsonl を頭から再生して復元する。

## 実機で本人が確かめること（ユニットテストでは確かめられない）

- 画面収録の権限付与と、HYPER SBI 2 の実画面での現在値・銘柄コードの読み取り精度（ザラ場で数回発注して `shot.price` を目視照合）。
- 小窓がフルスクリーンの HYPER SBI 2 の上・別の Space にも出ること。
- 発注直後にメモ欄へフォーカスが移り、音声入力ソフトの文字（貼り付け方式でも）が入ること、⌘↩ で保存できること。
