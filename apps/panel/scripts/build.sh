#!/bin/bash
# 小窓をビルドする（Release）。成果物: apps/panel/build/Build/Products/Release/TradePanel.app
# 署名は project.yml の Apple Development 証明書（画面収録の権限が再ビルドで外れないように固定）。
set -euo pipefail
cd "$(dirname "$0")/.."
xcodegen generate --quiet
xcodebuild -project TradePanel.xcodeproj -scheme TradePanel -configuration Release \
  -derivedDataPath build -destination 'platform=macOS' build "$@"
APP="build/Build/Products/Release/TradePanel.app"
codesign --verify --strict "$APP"
echo "built: $(pwd)/$APP"
