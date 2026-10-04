#!/bin/bash
# 小窓が外部へ送信できないことの確認。違反が 1 つでもあれば exit 1。
#   1. ソースに通信・外部起動の API が無い
#   2. entitlements が App Sandbox あり・ネットワーク系なし（ソースとビルド成果物の両方）
#   3. バイナリが通信系のフレームワークをリンクしていない
# 使い方: scripts/check-no-network.sh [TradePanel.app のパス]（省略時は Release の成果物）
set -uo pipefail
cd "$(dirname "$0")/.."

APP="${1:-build/Build/Products/Release/TradePanel.app}"
fail=0
ng() { echo "NG: $*"; fail=1; }
ok() { echo "ok: $*"; }

# 1. ソース検査（テストも含む全 Swift）
patterns=(
  'URLSession' 'NSURLSession' 'NSURLConnection' 'URLRequest'
  'import[[:space:]]+Network' 'NWConnection' 'NWListener' 'NWBrowser' 'NWEndpoint' 'NWPathMonitor'
  'import[[:space:]]+WebKit' 'WKWebView'
  'CFSocket' 'CFStream' '(^|[^A-Za-z_.])socket[[:space:]]*\(' 'getaddrinfo' 'gethostbyname'
  'NSWorkspace' 'openURL' '\.open\(URL' '(^|[^A-Za-z_.])Link[[:space:]]*\('
  'URL\(string:' 'https?://'
  'Process\(' 'NSTask' 'posix_spawn' '(^|[^A-Za-z_.])system[[:space:]]*\('
  'MultipeerConnectivity' 'CloudKit' 'NSUbiquit'
)
files=$(find App PanelKit Tests -name '*.swift' -not -path '*/build/*')
src_hits=0
for p in "${patterns[@]}"; do
  hits=$(grep -nE -- "$p" $files 2>/dev/null || true)
  if [ -n "$hits" ]; then
    ng "ソースに禁止パターン /$p/"
    echo "$hits" | sed 's/^/    /'
    src_hits=1
  fi
done
[ $src_hits -eq 0 ] && ok "ソースに通信・外部起動の API なし（$(echo "$files" | wc -l | tr -d ' ') ファイル）"

# 2a. ソースの entitlements
ENT_SRC="App/TradePanel.entitlements"
if /usr/libexec/PlistBuddy -c 'Print :com.apple.security.app-sandbox' "$ENT_SRC" 2>/dev/null | grep -q true; then
  ok "$ENT_SRC: app-sandbox = true"
else
  ng "$ENT_SRC: app-sandbox が true でない"
fi
if grep -q 'network' "$ENT_SRC"; then ng "$ENT_SRC にネットワーク系 entitlement がある"; else ok "$ENT_SRC: ネットワーク系なし"; fi

# 2b. ビルド成果物の entitlements（実際に署名されたもの）
if [ ! -d "$APP" ]; then
  ng "ビルド成果物が無い: $APP（先に scripts/build.sh を実行）"
else
  ent=$(codesign -d --entitlements - --xml "$APP" 2>/dev/null | plutil -convert xml1 -o - - 2>/dev/null)
  if [ -z "$ent" ]; then
    ng "$APP の entitlements を読めない"
  else
    if echo "$ent" | grep -A1 'com.apple.security.app-sandbox' | grep -q '<true/>'; then
      ok "署名済み entitlements: app-sandbox = true"
    else
      ng "署名済み entitlements に app-sandbox が無い"
    fi
    if echo "$ent" | grep -q 'network'; then
      ng "署名済み entitlements にネットワーク系がある"
      echo "$ent" | grep network | sed 's/^/    /'
    else
      ok "署名済み entitlements: ネットワーク系なし"
    fi
  fi
  # 埋め込みフレームワークも含め、すべての Mach-O が通信系フレームワークをリンクしていないこと
  while IFS= read -r bin; do
    links=$(otool -L "$bin" 2>/dev/null | grep -E 'Network\.framework|WebKit\.framework|CFNetwork\.framework|MultipeerConnectivity|CloudKit' || true)
    if [ -n "$links" ]; then
      ng "$bin が通信系フレームワークをリンクしている"
      echo "$links" | sed 's/^/    /'
    fi
  done < <(find "$APP" -type f -perm -u+x -exec sh -c 'file "$1" | grep -q Mach-O && echo "$1"' _ {} \;)
  [ $fail -eq 0 ] && ok "$APP: 通信系フレームワークのリンクなし"
fi

if [ $fail -ne 0 ]; then
  echo "check-no-network: FAILED"
  exit 1
fi
echo "check-no-network: PASSED"
