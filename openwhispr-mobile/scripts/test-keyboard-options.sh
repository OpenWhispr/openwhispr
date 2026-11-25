#!/bin/sh
# Compiles and runs the keyboard's options tests on macOS (Foundation only).
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mktemp -d)/keyboard-options-tests"
swiftc -swift-version 5 -parse-as-library \
  "$ROOT/plugins/keyboard-extension/ios/KeyboardOptionsMenu.swift" \
  "$ROOT/plugins/keyboard-extension/tests/KeyboardOptionsMenuTests.swift" \
  -o "$OUT"
"$OUT"
