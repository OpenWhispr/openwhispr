#!/bin/sh
# Compiles and runs the keyboard's capitalization tests on macOS (Foundation only).
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mktemp -d)/keyboard-capitalization-tests"
swiftc -swift-version 5 -parse-as-library \
  "$ROOT/plugins/keyboard-extension/ios/KeyboardCapitalization.swift" \
  "$ROOT/plugins/keyboard-extension/tests/KeyboardCapitalizationTests.swift" \
  -o "$OUT"
"$OUT"
