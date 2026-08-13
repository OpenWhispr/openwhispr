import Cocoa

if !AXIsProcessTrusted() {
    exit(2)
}

// Selection capture sends ⌘C and reports which app received it, so the caller
// can tell a copied selection from a target that changed underneath it. With no
// arguments this stays what the paste path expects: ⌘V, no output.
let copyMode = CommandLine.arguments.contains("--copy")
let virtualKey: CGKeyCode = copyMode ? 0x08 : 0x09  // kVK_ANSI_C : kVK_ANSI_V

// Resolved before the keystroke is posted: this is the app that will receive it.
let target = copyMode ? NSWorkspace.shared.frontmostApplication : nil
if copyMode && target == nil {
    exit(1)
}

guard let keyDown = CGEvent(keyboardEventSource: nil, virtualKey: virtualKey, keyDown: true),
      let keyUp = CGEvent(keyboardEventSource: nil, virtualKey: virtualKey, keyDown: false) else {
    exit(1)
}

keyDown.flags = .maskCommand
keyUp.flags = .maskCommand
keyDown.post(tap: .cgSessionEventTap)
usleep(8000)
keyUp.post(tap: .cgSessionEventTap)
usleep(20000)

if let target = target {
    print("COPY_OK \(target.processIdentifier) \(target.localizedName ?? "")")
}
