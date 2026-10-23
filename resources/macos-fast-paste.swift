import Cocoa
import Carbon.HIToolbox

if !AXIsProcessTrusted() {
    exit(2)
}

// Selection capture sends ⌘C and reports which app received it, so the caller
// can tell a copied selection from a target that changed underneath it. With no
// arguments this stays what the paste path expects: ⌘V, no output.
let copyMode = CommandLine.arguments.contains("--copy")
let shortcutCharacter = copyMode ? "c" : "v"
let commandModifierState = UInt32(cmdKey) >> 8

func keyboardLayoutData(from inputSource: TISInputSource?) -> Data? {
    guard let inputSource = inputSource,
          let layoutDataPointer = TISGetInputSourceProperty(inputSource, kTISPropertyUnicodeKeyLayoutData) else {
        return nil
    }

    return Unmanaged<CFData>.fromOpaque(layoutDataPointer).takeUnretainedValue() as Data
}

func lookupVirtualKey(for character: String) -> CGKeyCode? {
    // Non-ASCII layouts can define their own Command shortcuts. Use the last
    // ASCII layout only when the active input method provides no layout data.
    guard let layoutData = keyboardLayoutData(from: TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue())
        ?? keyboardLayoutData(from: TISCopyCurrentASCIICapableKeyboardLayoutInputSource()?.takeRetainedValue()) else {
        return nil
    }

    return layoutData.withUnsafeBytes { rawBuffer in
        guard let baseAddress = rawBuffer.baseAddress else { return nil }
        let keyboardLayout = baseAddress.assumingMemoryBound(to: UCKeyboardLayout.self)
        var deadKeyState: UInt32 = 0
        var actualStringLength = 0
        var unicodeString = [UniChar](repeating: 0, count: 4)

        for keyCode in 0..<128 {
            deadKeyState = 0
            let status = UCKeyTranslate(
                keyboardLayout,
                UInt16(keyCode),
                UInt16(kUCKeyActionDisplay),
                commandModifierState,
                UInt32(LMGetKbdType()),
                OptionBits(kUCKeyTranslateNoDeadKeysBit),
                &deadKeyState,
                unicodeString.count,
                &actualStringLength,
                &unicodeString
            )
            if status == noErr,
               String(utf16CodeUnits: unicodeString, count: actualStringLength) == character {
                return CGKeyCode(keyCode)
            }
        }

        return nil
    }
}

// Chromium browsers drop a synthetic ⌘V's insert at random, in waves (Chrome 155:
// the paste and beforeinput events fire with the right text, nothing is inserted,
// focus never moves), with this helper and the osascript fallback alike. Typing
// the clipboard text as keyboard unicode events never dropped, so those browsers
// get the text typed; every other app keeps the ⌘V paste.
let typedBrowsers: Set<String> = [
    "com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.dev", "com.google.Chrome.canary",
    "org.chromium.Chromium", "com.brave.Browser", "com.microsoft.edgemac", "company.thebrowser.Browser",
    "com.vivaldi.Vivaldi", "com.operasoftware.Opera",
]

func typeText(_ text: String) {
    // ⇧↩ for line breaks: a newline in a chat box or textarea instead of a send.
    for (index, line) in text.components(separatedBy: "\n").enumerated() {
        if index > 0 {
            for down in [true, false] {
                guard let e = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(kVK_Return), keyDown: down) else { continue }
                e.flags = .maskShift
                e.post(tap: .cgSessionEventTap)
            }
            usleep(2000)
        }
        // At most 20 UTF-16 units per event, never splitting a surrogate pair.
        var chunk: [UniChar] = []
        func flush() {
            guard !chunk.isEmpty else { return }
            for down in [true, false] {
                guard let e = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down) else { continue }
                e.flags = []
                e.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
                e.post(tap: .cgSessionEventTap)
            }
            usleep(2000)
            chunk = []
        }
        for scalar in line.replacingOccurrences(of: "\r", with: "").unicodeScalars {
            let units = Array(String(scalar).utf16)
            if chunk.count + units.count > 20 { flush() }
            chunk.append(contentsOf: units)
        }
        flush()
    }
}

if !copyMode,
   let bundleId = NSWorkspace.shared.frontmostApplication?.bundleIdentifier,
   typedBrowsers.contains(bundleId),
   let text = NSPasteboard.general.string(forType: .string), !text.isEmpty {
    typeText(text)
    usleep(20000)
    exit(0)
}

// Do not post the old US-ANSI fallback key code: on a non-QWERTY layout it
// can invoke a different shortcut while still reporting a successful paste.
guard let virtualKey = lookupVirtualKey(for: shortcutCharacter) else {
    exit(3)
}

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
