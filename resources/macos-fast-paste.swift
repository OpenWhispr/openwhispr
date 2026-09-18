import Cocoa

if !AXIsProcessTrusted() {
    exit(2)
}

// Selection capture sends ⌘C and reports which app received it, so the caller
// can tell a copied selection from a target that changed underneath it. With no
// arguments this stays what the paste path expects: ⌘V, no output.
let copyMode = CommandLine.arguments.contains("--copy")
let virtualKey: CGKeyCode = copyMode ? 0x08 : 0x09  // kVK_ANSI_C : kVK_ANSI_V

func argumentValue(after flag: String) -> String? {
    let arguments = CommandLine.arguments
    guard let index = arguments.firstIndex(of: flag), index + 1 < arguments.count else {
        return nil
    }
    return arguments[index + 1]
}

// --submit <key> presses the key that submits the pasted text, once --submit-delay
// <ms> has given the target app time to take the paste. The outcome is printed
// and the exit code stays 0: the paste already happened, and a failure would send
// the caller to a fallback that pastes a second time.
let submitKey = copyMode ? nil : argumentValue(after: "--submit")
let submitDelayMs = argumentValue(after: "--submit-delay").flatMap { UInt32($0) } ?? 0

// Resolved before the keystroke is posted: this is the app that will receive it.
let target = copyMode ? NSWorkspace.shared.frontmostApplication : nil
if copyMode && target == nil {
    exit(1)
}
let pastedAppPid = submitKey == nil ? nil : NSWorkspace.shared.frontmostApplication?.processIdentifier

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

func submit(_ key: String) -> String {
    guard key == "enter" else { return "SUBMIT_SKIPPED unsupported-key" }
    let returnKey: CGKeyCode = 0x24  // kVK_Return
    guard let returnDown = CGEvent(keyboardEventSource: nil, virtualKey: returnKey, keyDown: true),
          let returnUp = CGEvent(keyboardEventSource: nil, virtualKey: returnKey, keyDown: false) else {
        return "SUBMIT_FAILED"
    }
    // Empty flags for the same reason the paste sets ⌘ explicitly: a hotkey
    // modifier the user still holds must not turn Return into another shortcut.
    returnDown.flags = []
    returnUp.flags = []
    // Waits on the run loop rather than sleeping: NSWorkspace only refreshes
    // frontmostApplication while it runs, so a sleep would read the stale app.
    RunLoop.main.run(until: Date(timeIntervalSinceNow: Double(submitDelayMs) / 1000))
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pastedAppPid else {
        return "SUBMIT_SKIPPED focus-changed"
    }
    returnDown.post(tap: .cgSessionEventTap)
    usleep(8000)
    returnUp.post(tap: .cgSessionEventTap)
    usleep(20000)
    return "SUBMIT_OK"
}

if let submitKey = submitKey {
    print(submit(submitKey))
}
