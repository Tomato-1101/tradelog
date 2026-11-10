# panel-win — Windows の記録小窓

HYPER SBI 2 でエントリーした瞬間に押すと、チャート画面・時刻・タグを残す常に最前面の小窓（C# .NET 9 WinForms）。
記録の形は `docs/real-events.md`。Mac へは `scripts/pull-win.sh`（launchd `com.tomato.tradelog.pullwin`）が回収する。

- ボタン: 「記録」（タグなし）＋タグボタン。ホットキー既定 `Ctrl+Shift+M`（タグなし）。押しても HYPER SBI 2 からフォーカスを奪わない。
- Windows の置き場（`%USERPROFILE%\tradelog\`）: `app\`（本体）、`data\real\`（記録）、`logs\panel.log`、`settings.json`、`panel-state.json`（窓の位置）。
- `settings.json`（初回起動で既定値が作られる。変えたら小窓を起動し直す）:
  ```json
  { "tags": ["ブレイク", "押し目", "反発", "逆張り", "ニュース"], "hotkey": "Ctrl+Shift+M" }
  ```
  `hotkey` は `Ctrl` / `Shift` / `Alt` / `Win` と 1 キー（`M`, `F9`, `1` 等）を `+` でつなぐ。`""` で無効。
- 起動はタスクスケジューラの `tradelog-panel`（ログオン時・本人のセッション・通常の権限）。SSH のセッションからは窓を出せないので、必ずタスク経由で起動する。

Mac からの操作（接続先は `~/.config/tradelog/win.conf`）:
```
scripts/win-panel.sh deploy          # ソースを送って Windows 上で dotnet publish → 起動し直す
scripts/win-panel.sh install-task    # ログオン時の自動起動タスクを作る（uninstall-task で消す）
scripts/win-panel.sh start|stop|status
scripts/win-panel.sh snap            # 1 回撮影させる（test 記録）→ clean-test で消す
```
