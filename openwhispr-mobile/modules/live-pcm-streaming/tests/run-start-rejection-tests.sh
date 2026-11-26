#!/bin/sh
# Compiles the Foundation-only start rejection mapping with the test executable and runs it.
set -eu
MODULE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$(mktemp -d)"
trap 'rm -rf "$OUT_DIR"' EXIT
swiftc -swift-version 5 -o "$OUT_DIR/tests" \
  "$MODULE_DIR/ios/StartRejection.swift" \
  "$MODULE_DIR/tests/StartRejectionTests.swift"
"$OUT_DIR/tests"
