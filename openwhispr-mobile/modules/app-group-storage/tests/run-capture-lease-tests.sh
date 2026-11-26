#!/usr/bin/env bash
# Compiles the Foundation-only capture lease policy with its tests and runs them.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
build_dir="$(mktemp -d)"
trap 'rm -rf "$build_dir"' EXIT
swiftc -swift-version 5 -o "$build_dir/capture-lease-tests" \
  "$here/../ios/CaptureLeasePolicy.swift" \
  "$here/CaptureLeasePolicyTests.swift"
"$build_dir/capture-lease-tests"
