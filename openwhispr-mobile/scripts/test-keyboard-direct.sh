#!/bin/sh
# Compiles and runs the keyboard's direct-dictation tests on macOS. Only sources that need no
# UIKit or WebKit are listed, so they build with plain swiftc, like the capitalization tests.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IOS="$ROOT/plugins/keyboard-extension/ios"
TESTS="$ROOT/plugins/keyboard-extension/tests"
OUT="$(mktemp -d)/keyboard-direct-tests"
swiftc -swift-version 5 -parse-as-library \
  "$IOS/DirectDictationConfig.swift" \
  "$IOS/DirectDictationAudio.swift" \
  "$IOS/DirectAudioEncoder.swift" \
  "$IOS/SnippetExpander.swift" \
  "$IOS/DirectDictationRequests.swift" \
  "$IOS/DirectDictationStore.swift" \
  "$IOS/DirectLocalTranscription.swift" \
  "$IOS/DirectDictation.swift" \
  "$IOS/DirectAudioRoute.swift" \
  "$IOS/KeyboardCredentialStore.swift" \
  "$TESTS"/direct/*.swift \
  -o "$OUT"
"$OUT" "$TESTS/fixtures"
