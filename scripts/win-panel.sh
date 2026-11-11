#!/bin/bash
# Windows の記録小窓（apps/panel-win）を Mac から SSH で配置・登録・起動・停止する。
#   deploy          ソースを送って Windows 上で dotnet publish し、%USERPROFILE%\tradelog\app\ に置いて起動し直す
#   install-task    ログオン時に本人のセッションで小窓を起動するタスク（tradelog-panel）を作る（作り直し可）
#   uninstall-task  そのタスクを消す（小窓も止める）
#   start / stop    タスク経由で起動（本人のセッションに窓が出る）/ 止める
#   status          プロセス・タスクの状態と小窓のログの末尾
#   selftest        追跡・行のずれ・数字の読み方と、全板の見本画像（%USERPROFILE%\tradelog\selftest-board.png があれば）の OCR を確かめる
#   snap            動作確認用に理由を 1 件保存させる（"test":true の real_note になる）
#   clean-test      "test":true の記録（旧版の画像も）を Windows と Mac の両方から消す（本物の記録は残す）
# Windows の設定・ファイアウォール・SSH の設定、HYPER SBI 2 には触らない。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
. "$HERE/win-lib.sh"
win_check_conf
TASK=tradelog-panel
DEST="$(win_real_dir "$REPO")"

# Windows 側の置き場（%USERPROFILE%\tradelog 以下）
PS_PATHS='$root = Join-Path $env:USERPROFILE "tradelog"; $app = Join-Path $root "app"; $data = Join-Path $root "data\real"; $exe = Join-Path $app "TradelogPanel.exe";'
PS_STOP='Stop-ScheduledTask -TaskName "'$TASK'" -ErrorAction SilentlyContinue; Get-Process TradelogPanel -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep -Milliseconds 500;'
PS_SELFTEST='$img = Join-Path $root "selftest-board.png"; $a = @("--selftest"); if (Test-Path $img) { $a += "`"$img`"" }
  $p = Start-Process -FilePath $exe -ArgumentList $a -Wait -PassThru; Get-Content (Join-Path $root "logs\selftest.txt") -Encoding UTF8; if ($p.ExitCode -ne 0) { throw "自己テストに失敗（exit $($p.ExitCode)）" };'
PS_START='if (Get-ScheduledTask -TaskName "'$TASK'" -ErrorAction SilentlyContinue) { Start-ScheduledTask -TaskName "'$TASK'"; Start-Sleep -Seconds 3; Get-Process TradelogPanel -ErrorAction SilentlyContinue | Select-Object Id, SessionId, StartTime | Format-Table -AutoSize | Out-String } else { "タスク '$TASK' が無い（install-task を先に）" }'

cmd="${1:-}"
case "$cmd" in
  deploy)
    tarball="$(mktemp -t panel-win).tar"
    # macOS の拡張属性（._*）を入れない。入るとコンパイラが .cs として読んで失敗する
    COPYFILE_DISABLE=1 tar -C "$REPO/apps" --no-mac-metadata --exclude 'bin' --exclude 'obj' --exclude '._*' --exclude '.DS_Store' -cf "$tarball" panel-win
    win_ps "$PS_PATHS New-Item -ItemType Directory -Force (Join-Path \$root 'src') | Out-Null" >/dev/null
    scp -q "${WIN_SSH_OPTS[@]}" "$tarball" "$WIN_USER@$WIN_HOST:tradelog/src/panel-win.tar"
    rm -f "$tarball"
    win_ps "$PS_PATHS \$ErrorActionPreference = 'Stop'
      \$src = Join-Path \$root 'src'
      if (Test-Path (Join-Path \$src 'panel-win')) { Remove-Item -Recurse -Force (Join-Path \$src 'panel-win') }
      tar -xf (Join-Path \$src 'panel-win.tar') -C \$src
      if (\$LASTEXITCODE -ne 0) { throw 'tar の展開に失敗' }
      $PS_STOP
      \$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'; \$env:DOTNET_NOLOGO = '1'
      dotnet publish (Join-Path \$src 'panel-win\TradelogPanel.csproj') -c Release -o \$app --nologo -v q
      if (\$LASTEXITCODE -ne 0) { throw 'dotnet publish に失敗' }
      'publish: ' + (Get-Item \$exe).LastWriteTime.ToString('s')
      $PS_SELFTEST
      $PS_START"
    ;;
  install-task)
    win_ps "$PS_PATHS \$ErrorActionPreference = 'Stop'
      if (!(Test-Path \$exe)) { throw \"\$exe が無い（deploy を先に）\" }
      # SSH のセッションでは USERDOMAIN が WORKGROUP になるので、実際のアカウント名（PC名\\ユーザー）を使う
      \$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
      \$a = New-ScheduledTaskAction -Execute \$exe -WorkingDirectory \$app
      \$t = New-ScheduledTaskTrigger -AtLogOn -User \$user
      # 対話型（本人のデスクトップに窓を出す）・通常の権限。パスワードは保存しない
      \$p = New-ScheduledTaskPrincipal -UserId \$user -LogonType Interactive -RunLevel Limited
      # 実行時間の上限なし・電源で止めない・二重起動しない・優先度は通常（既定の 7 は低くて撮影が遅れる）
      \$s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -Priority 4
      Register-ScheduledTask -TaskName '$TASK' -Description 'tradelog: HYPER SBI 2 のエントリー記録小窓（apps/panel-win）' -Action \$a -Trigger \$t -Principal \$p -Settings \$s -Force | Out-Null
      Get-ScheduledTask -TaskName '$TASK' | Select-Object TaskName, State, @{n='LogonType';e={\$_.Principal.LogonType}}, @{n='RunLevel';e={\$_.Principal.RunLevel}} | Format-List | Out-String"
    ;;
  uninstall-task)
    win_ps "$PS_STOP Unregister-ScheduledTask -TaskName '$TASK' -Confirm:\$false -ErrorAction SilentlyContinue; 'removed: $TASK'"
    ;;
  start)
    win_ps "$PS_START"
    ;;
  stop)
    win_ps "$PS_STOP 'stopped'"
    ;;
  selftest)
    win_ps "$PS_PATHS \$ErrorActionPreference = 'Stop'
      $PS_SELFTEST"
    ;;
  status)
    win_ps "$PS_PATHS
      'process:'; Get-Process TradelogPanel -ErrorAction SilentlyContinue | Select-Object Id, SessionId, StartTime | Format-Table -AutoSize | Out-String
      'task:'; Get-ScheduledTask -TaskName '$TASK' -ErrorAction SilentlyContinue | Select-Object TaskName, State | Format-Table -AutoSize | Out-String
      'log:'; Get-Content (Join-Path \$root 'logs\panel.log') -Tail 10 -Encoding UTF8 -ErrorAction SilentlyContinue"
    ;;
  snap)
    win_ps "$PS_PATHS
      \$ev = Join-Path \$data 'events.jsonl'
      \$before = if (Test-Path \$ev) { (Get-Item \$ev).Length } else { 0 }
      [IO.File]::WriteAllText((Join-Path \$data ('cmd\' + [guid]::NewGuid().ToString() + '.snap')), 'テスト（win-panel.sh snap）', (New-Object Text.UTF8Encoding \$false))
      for (\$i = 0; \$i -lt 20; \$i++) {
        Start-Sleep -Milliseconds 500
        if ((Test-Path \$ev) -and (Get-Item \$ev).Length -gt \$before) { Get-Content \$ev -Tail 1 -Encoding UTF8; exit 0 }
      }
      'タイムアウト: 小窓が動いていない？（status で確認）'; exit 1"
    ;;
  clean-test)
    # Windows: test 行を除いて書き直し、その画像を消す。消した画像の相対パスを返してもらい、Mac 側も同じものを消す
    removed="$(win_ps "$PS_PATHS \$ErrorActionPreference = 'Stop'
      \$ev = Join-Path \$data 'events.jsonl'
      if (!(Test-Path \$ev)) { exit 0 }
      \$keep = New-Object System.Collections.Generic.List[string]
      foreach (\$line in [IO.File]::ReadAllLines(\$ev, [Text.Encoding]::UTF8)) {
        if (\$line.Trim() -eq '') { continue }
        \$o = \$null; try { \$o = \$line | ConvertFrom-Json } catch { }
        if (\$o -and \$o.test -eq \$true) {
          foreach (\$s in \$o.shots) { \$f = Join-Path \$data (\$s.path -replace '/', '\'); if (Test-Path \$f) { Remove-Item -Force \$f }; 'shot ' + \$s.path }
        } else { \$keep.Add(\$line) }
      }
      \$text = if (\$keep.Count -gt 0) { (\$keep -join \"\`n\") + \"\`n\" } else { '' }
      [IO.File]::WriteAllText(\$ev + '.tmp', \$text, (New-Object Text.UTF8Encoding \$false))
      Move-Item -Force (\$ev + '.tmp') \$ev
      'kept ' + \$keep.Count")"
    echo "$removed"
    while IFS= read -r line; do
      case "$line" in
        "shot "*)
          rel="${line#shot }"
          case "$rel" in shots/*/*.png) ;; *) echo "想定外のパスなので消さない: $rel"; continue ;; esac
          case "$rel" in *..*) echo "想定外のパスなので消さない: $rel"; continue ;; esac
          if [ -f "$DEST/$rel" ]; then rm -f "$DEST/$rel" && echo "Mac から削除: $rel"; fi
          ;;
      esac
    done <<<"$removed"
    "$HERE/pull-win.sh"
    ;;
  *)
    sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
