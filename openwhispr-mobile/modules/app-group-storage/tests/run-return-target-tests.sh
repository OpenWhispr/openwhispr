#!/usr/bin/env bash
# Compiles the Foundation-only return resolver with its tests and runs them.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
build_dir="$(mktemp -d)"
trap 'rm -rf "$build_dir"' EXIT
swiftc -swift-version 5 -o "$build_dir/return-target-tests" \
  "$here/../ios/ReturnTargetResolver.swift" \
  "$here/ReturnTargetResolverTests.swift"
"$build_dir/return-target-tests"
