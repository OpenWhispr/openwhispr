import AppKit
import Foundation

// Posts a media play/pause NSEvent (NSEventSubtypeMediaKey / NX_KEYTYPE_PLAY),
// the only event class media apps (Spotify, Music, browser tabs) listen for —
// synthetic F-key codes are not media keys.
//
// State-aware pause/resume is handled by the vendored mediaremote-adapter
// loaded through /usr/bin/perl; this helper is the fallback when the adapter
// is unavailable.

let usage = "Usage: macos-media-remote --media-key-toggle"

let args = CommandLine.arguments
let command = args.count > 1 ? args[1] : ""

guard command == "--media-key-toggle" else {
    print(usage)
    exit(1)
}

let NSEventSubtypeMediaKey: Int16 = 8
let NX_KEYTYPE_PLAY: Int32 = 16

func postMediaKey(keyDown: Bool) -> Bool {
    let flags: UInt = keyDown ? 0xA00 : 0xB00
    let state: Int32 = keyDown ? 0xA : 0xB
    let data1 = (NX_KEYTYPE_PLAY << 16) | (state << 8)

    guard let event = NSEvent.otherEvent(
        with: .systemDefined,
        location: .zero,
        modifierFlags: NSEvent.ModifierFlags(rawValue: flags),
        timestamp: 0,
        windowNumber: 0,
        context: nil,
        subtype: NSEventSubtypeMediaKey,
        data1: Int(data1),
        data2: -1
    ) else {
        return false
    }
    guard let cgEvent = event.cgEvent else { return false }
    cgEvent.post(tap: .cghidEventTap)
    return true
}

guard postMediaKey(keyDown: true), postMediaKey(keyDown: false) else {
    print("FAIL")
    exit(1)
}

print("OK")
exit(0)
