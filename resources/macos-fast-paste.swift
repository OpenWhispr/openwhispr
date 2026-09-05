import Cocoa
import Carbon

if !AXIsProcessTrusted() {
    exit(2)
}

// Look up which key code produces a given character in the current keyboard
// layout. Hardcoded key codes (0x09 for 'v', 0x08 for 'c') are only correct on
// QWERTY, so Cmd+V / Cmd+C land on the wrong key on Dvorak, Colemak, etc.
func keyCodeForCharacter(_ target: UniChar) -> CGKeyCode? {
    guard let sourceRef = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
          let layoutDataRef = TISGetInputSourceProperty(sourceRef, kTISPropertyUnicodeKeyLayoutData) else {
        return nil
    }
    let layoutData = unsafeBitCast(layoutDataRef, to: CFData.self)
    let keyLayout = unsafeBitCast(CFDataGetBytePtr(layoutData), to: UnsafePointer<UCKeyboardLayout>.self)

    for keyCode: UInt16 in 0..<128 {
        var deadKeyState: UInt32 = 0
        var chars = [UniChar](repeating: 0, count: 4)
        var length = 0

        let status = UCKeyTranslate(
            keyLayout,
            keyCode,
            UInt16(kUCKeyActionDown),
            0,
            UInt32(LMGetKbdType()),
            UInt32(kUCKeyTranslateNoDeadKeysBit),
            &deadKeyState,
            4,
            &length,
            &chars
        )

        if status == noErr && length > 0 && chars[0] == target {
            return CGKeyCode(keyCode)
        }
    }
    return nil
}

// Selection capture sends ⌘C and reports which app received it, so the caller
// can tell a copied selection from a target that changed underneath it. With no
// arguments this stays what the paste path expects: ⌘V, no output.
let copyMode = CommandLine.arguments.contains("--copy")
// 0x0063 = 'c', 0x0076 = 'v'. Fall back to the QWERTY key code for the same
// mode if the layout lookup fails, never to the other mode's key.
let virtualKey: CGKeyCode = keyCodeForCharacter(copyMode ? 0x0063 : 0x0076)
    ?? (copyMode ? 0x08 : 0x09)  // kVK_ANSI_C : kVK_ANSI_V

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
