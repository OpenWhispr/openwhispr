#!/bin/sh
# Compiles the keyboard's typing engines (lexicon, autocorrect, swipe, hit targets, trackpad,
# emoji) with their tests and benchmarks on macOS. Only UIKit-free sources are listed, so they
# build with plain swiftc. With no arguments it runs the unit tests; otherwise the arguments go
# to the benchmark tool, e.g. `sh scripts/test-keyboard-typing.sh autocorrect en dev`.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN="$ROOT/plugins/keyboard-extension"
IOS="$PLUGIN/ios"
OUT="${KEYBOARD_TYPING_BUILD_DIR:-$(mktemp -d)}/keyboard-typing"
if [ ! -x "$OUT" ] || [ -z "${KEYBOARD_TYPING_REUSE:-}" ]; then
  swiftc -swift-version 5 -parse-as-library -O \
    "$IOS/KeyGeometry.swift" \
    "$IOS/TypingLexicon.swift" \
    "$IOS/Autocorrector.swift" \
    "$IOS/TypingSession.swift" \
    "$IOS/SwipeDecoder.swift" \
    "$IOS/HitTargetModel.swift" \
    "$IOS/TrackpadModel.swift" \
    "$IOS/EmojiCatalog.swift" \
    "$PLUGIN/tests/typing"/*.swift \
    -o "$OUT"
fi
if [ "$#" -eq 0 ]; then set -- test; fi
cmd="$1"; shift
"$OUT" "$PLUGIN" "$cmd" "$@"
