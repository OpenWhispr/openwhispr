#!/bin/sh
# Compiles the Foundation-only Live Activity sources with the test executable and runs it.
# ActivityKit is iOS-only, so only the pure files are compiled here.
set -eu
MODULE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$(mktemp -d)"
trap 'rm -rf "$OUT_DIR"' EXIT
swiftc -swift-version 5 -o "$OUT_DIR/tests" \
  "$MODULE_DIR/ios/RecordingActivityContentState.swift" \
  "$MODULE_DIR/ios/LiveActivityResolver.swift" \
  "$MODULE_DIR/tests/LiveActivityResolverTests.swift"
"$OUT_DIR/tests"
