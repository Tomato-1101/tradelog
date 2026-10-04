#!/bin/bash
# ユニットテスト（PanelKit をホストなしで読み込むので、小窓は画面に出ない・画面収録も使わない）
set -euo pipefail
cd "$(dirname "$0")/.."
xcodegen generate --quiet
xcodebuild -project TradePanel.xcodeproj -scheme TradePanel -configuration Debug \
  -derivedDataPath build -destination 'platform=macOS' test "$@"
