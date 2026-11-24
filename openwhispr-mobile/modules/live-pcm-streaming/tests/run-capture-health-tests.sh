#!/bin/sh
# Compiles the Foundation-only capture health policy with the test executable and runs it.
# AVFoundation capture is iOS-only, so only the pure policy is compiled here.
set -eu
MODULE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$(mktemp -d)"
trap 'rm -rf "$OUT_DIR"' EXIT
swiftc -swift-version 5 -o "$OUT_DIR/tests" \
  "$MODULE_DIR/ios/CaptureHealthPolicy.swift" \
  "$MODULE_DIR/tests/CaptureHealthPolicyTests.swift"
"$OUT_DIR/tests"
