# moomoo OpenD セットアップ手順 (macOS)

米株・米株オプションのチャートと取引履歴を本アプリに取り込むには moomoo の **OpenD** ローカルゲートウェイが必要。日本株 (SBI CSV) と統計だけ使う分には不要。

## 1. OpenD の入手

1. <https://openapi.moomoo.com/moomoo-api-doc/intro/intro.html> を開く
2. 左メニュー「OpenD のダウンロードとログイン」→ **macOS 版 (arm64 DMG)** をダウンロード
3. DMG を開いて `OpenD.app` を `アプリケーション` フォルダにドラッグ
4. 初回起動でセキュリティ警告が出たら「システム設定 → プライバシーとセキュリティ」で許可

## 2. 起動 + 本番口座ログイン

1. `OpenD.app` を起動
2. moomoo の **本番口座** の口座番号 + パスワードでログイン
   - **デモ口座では履歴取得 API を使えない**
3. ログイン後に表示される `API: 127.0.0.1:11111` を確認
4. 設定で「システム起動時に自動起動」を ON

> ポート番号を変えた場合は `apps/api-py/.env` (作成予定) に書く。デフォルト 11111 のままで OK。

## 3. Python 3.12 + futu-api SDK のセットアップ

moomoo の Python SDK は **3.12 系まで**しか正式対応していない。`apps/api-py/.venv` を 3.12 で作り直す。

```sh
# pyenv が入っていなければ
brew install pyenv

# 3.12 系の最新を入れる
pyenv install 3.12.7

# apps/api-py ディレクトリでバージョン固定
cd $REPO_ROOT/apps/api-py
pyenv local 3.12.7

# 既存 venv を退避して作り直し
mv .venv .venv-py314.bak
python -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
pip install futu-api   # moomoo Python SDK (旧名 moomoo-api)
```

## 4. 疎通テスト

OpenD が起動していて、ログイン済みであることを確認した上で:

```sh
cd $REPO_ROOT/apps/api-py
source .venv/bin/activate
python -c "from futu import OpenQuoteContext; ctx=OpenQuoteContext(host='127.0.0.1',port=11111); print(ctx.get_global_state()); ctx.close()"
```

期待される出力:

```
(0, {'market_sh': '...', 'market_us': 'OPEN', ...})
```

タプルの 1 要素目が `0` (= 成功) なら OK。

エラー時のチェックポイント:

| エラー | 原因 | 対処 |
|---|---|---|
| `Connection refused` | OpenD が起動していない | OpenD を起動してログイン |
| `account is not unlocked` | 履歴系では出ないはず。出たらデモ口座でログインしている | 本番口座でログインし直す |
| `ImportError: No module named futu` | venv を有効化していない / 3.12 で作り直していない | `source .venv/bin/activate` |
| 1 要素目が `0` 以外 | OpenD ログインが切れている / ネットワーク異常 | OpenD を再ログイン |

## 5. 本アプリ側の確認

OpenD と疎通できたら、Next.js アプリの `/api/healthz` で sidecar 経由のステータスを確認できる:

```sh
curl http://localhost:3000/api/healthz
```

`sidecar.opend` が `"connected"` になれば S10 (米株 OHLC) と S11 (履歴取り込み) が使える状態。

## 補足

- **OpenD は常駐させる**。閉じるとアプリ側で米株 OHLC とニュー moomoo 取り込みが 503 になる。
- **見積もりサブスク不要**: 履歴 OHLC と取引履歴は照会扱いで Quotation Card が無くても取れる。リアルタイム見積もりが必要になったら検討する。
- **OpenD は moomoo アプリと同時起動可能**。普段使いと並行して問題ない。
- ログ: `~/Library/Logs/Futu/` に OpenD のログがある。SDK エラーが出たらここを見る。
