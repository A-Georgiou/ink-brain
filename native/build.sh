#!/usr/bin/env bash
# Builds the native helper app bundle when its sources change.
set -euo pipefail
cd "$(dirname "$0")"

APP="build/Ink Brain Helper.app"
BIN="$APP/Contents/MacOS/ink-brain-helper"

if [[ -x "$BIN" && "$BIN" -nt Helper.swift && "$BIN" -nt Info.plist ]]; then
  exit 0
fi

mkdir -p "$APP/Contents/MacOS"
cp Info.plist "$APP/Contents/Info.plist"
swiftc -O -swift-version 5 -target "$(uname -m)-apple-macos14.0" Helper.swift -o "$BIN" \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker Info.plist
codesign --force --sign - --identifier io.github.a-georgiou.ink-brain.helper "$APP" >/dev/null
echo "Built $APP"
