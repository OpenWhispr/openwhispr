import Cocoa

// -----------------------------------------------------------------------
// Spoken-command mode: --key <KEY_NAME>
// Accepted keys: Return, Escape, Tab, BackSpace, Shift+Return
// When --key is supplied the binary injects that keystroke instead of Cmd+V.
// -----------------------------------------------------------------------

struct KeyEntry {
    let name: String
    let keyCode: CGKeyCode
    let shift: Bool
}

let KEY_TABLE: [KeyEntry] = [
    KeyEntry(name: "Return",       keyCode: 0x24, shift: false),
    KeyEntry(name: "Escape",       keyCode: 0x35, shift: false),
    KeyEntry(name: "Tab",          keyCode: 0x30, shift: false),
    KeyEntry(name: "BackSpace",    keyCode: 0x33, shift: false),
    KeyEntry(name: "Shift+Return", keyCode: 0x24, shift: true),
]

func sendNamedKey(_ keyName: String) -> Int32 {
    guard let entry = KEY_TABLE.first(where: { $0.name.lowercased() == keyName.lowercased() }) else {
        fputs("ERROR: Unknown key name '\(keyName)'\n", stderr)
        return 1
    }

    let src: CGEventSource? = nil
    guard let keyDown = CGEvent(keyboardEventSource: src, virtualKey: entry.keyCode, keyDown: true),
          let keyUp   = CGEvent(keyboardEventSource: src, virtualKey: entry.keyCode, keyDown: false)
    else {
        return 1
    }

    if entry.shift {
        keyDown.flags = .maskShift
        keyUp.flags   = .maskShift
    }

    keyDown.post(tap: .cgSessionEventTap)
    usleep(8000)
    keyUp.post(tap: .cgSessionEventTap)
    usleep(20000)

    print("KEY_OK \(keyName)")
    return 0
}

// -----------------------------------------------------------------------
// Parse arguments
// -----------------------------------------------------------------------

var keyArg: String? = nil
var argIdx = 1
while argIdx < CommandLine.arguments.count {
    let arg = CommandLine.arguments[argIdx]
    if arg == "--key" && argIdx + 1 < CommandLine.arguments.count {
        argIdx += 1
        keyArg = CommandLine.arguments[argIdx]
    }
    argIdx += 1
}

// -----------------------------------------------------------------------
// Accessibility check (required for both paste and key injection)
// -----------------------------------------------------------------------

if !AXIsProcessTrusted() {
    exit(2)
}

// -----------------------------------------------------------------------
// Spoken-command mode
// -----------------------------------------------------------------------

if let keyName = keyArg {
    exit(sendNamedKey(keyName))
}

// -----------------------------------------------------------------------
// Original paste mode (Cmd+V)
// -----------------------------------------------------------------------

guard let keyDown = CGEvent(keyboardEventSource: nil, virtualKey: 0x09, keyDown: true),
      let keyUp = CGEvent(keyboardEventSource: nil, virtualKey: 0x09, keyDown: false) else {
    exit(1)
}

keyDown.flags = .maskCommand
keyUp.flags = .maskCommand
keyDown.post(tap: .cgSessionEventTap)
usleep(8000)
keyUp.post(tap: .cgSessionEventTap)
usleep(20000)
