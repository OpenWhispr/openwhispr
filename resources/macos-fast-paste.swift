import Cocoa

if !AXIsProcessTrusted() {
    exit(2)
}

// --press-enter: send a bare Return (submit-after-paste). Default: Cmd+V paste.
let pressEnter = CommandLine.arguments.contains("--press-enter")
let keyCode: CGKeyCode = pressEnter ? 0x24 : 0x09

guard let keyDown = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true),
      let keyUp = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false) else {
    exit(1)
}

// Explicit flags override the user's physically held modifiers: paste forces ⌘,
// Enter forces none so a still-held hotkey can't turn it into Cmd/Ctrl+Enter.
let flags: CGEventFlags = pressEnter ? [] : .maskCommand
keyDown.flags = flags
keyUp.flags = flags
keyDown.post(tap: .cgSessionEventTap)
usleep(8000)
keyUp.post(tap: .cgSessionEventTap)
usleep(20000)
