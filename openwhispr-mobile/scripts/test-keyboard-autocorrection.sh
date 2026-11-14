#!/bin/sh
# Foundation-only production rules; works wherever swiftc + Foundation are installed.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
swiftc -swift-version 5 -parse-as-library \
  "$ROOT/plugins/keyboard-extension/ios/KeyboardAutocorrection.swift" \
  "$ROOT/plugins/keyboard-extension/tests/KeyboardAutocorrectionTests.swift" \
  -o "$OUT/keyboard-autocorrection-tests"
"$OUT/keyboard-autocorrection-tests"
