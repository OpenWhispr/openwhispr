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

// `--await-paste <ms> --paste-length <n>` watches the frontmost app's focused
// field so the caller restores the user's clipboard only once the target has
// read the pasteboard; a target that dequeues ⌘V after the restore pastes the
// old clipboard. The budget covers waiting for a target still busy with earlier
// work (it could not take the paste sooner anyway) and watching after the post.
// Prints PASTE_CONSUMED <ms> when the field shows the pasted text in place of
// the selection, caret right after it, PASTE_TIMEOUT when the budget runs out, or
// PASTE_UNVERIFIED when the field cannot be read (Chromium apps keep their tree
// dormant), focus moved, or it changed some other way (terminal output, typing).
func intArgument(after flag: String) -> Int? {
    guard let index = CommandLine.arguments.firstIndex(of: flag),
          index + 1 < CommandLine.arguments.count else { return nil }
    return Int(CommandLine.arguments[index + 1])
}
let awaitPaste: (budgetMs: Int, length: Int)? = {
    guard !copyMode,
          let budgetMs = intArgument(after: "--await-paste"),
          let length = intArgument(after: "--paste-length") else { return nil }
    return (budgetMs, length)
}()
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

// Do not post the old US-ANSI fallback key code: on a non-QWERTY layout it
// can invoke a different shortcut while still reporting a successful paste.
guard let virtualKey = lookupVirtualKey(for: shortcutCharacter) else {
    exit(3)
}

struct FieldSnapshot: Equatable {
    let characters: Int
    let selectionLocation: Int
    let selectionLength: Int
}

func focusedField(of app: AXUIElement) -> (element: AXUIElement?, error: AXError) {
    var value: AnyObject?
    let error = AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute as CFString, &value)
    guard error == .success, let element = value else { return (nil, error) }
    return ((element as! AXUIElement), error)
}

func snapshot(of field: AXUIElement) -> FieldSnapshot? {
    var countValue: AnyObject?
    var rangeValue: AnyObject?
    var range = CFRange()
    guard AXUIElementCopyAttributeValue(field, kAXNumberOfCharactersAttribute as CFString, &countValue) == .success,
          let characters = countValue as? Int,
          AXUIElementCopyAttributeValue(field, kAXSelectedTextRangeAttribute as CFString, &rangeValue) == .success,
          let rangeRef = rangeValue, CFGetTypeID(rangeRef) == AXValueGetTypeID(),
          AXValueGetValue(rangeRef as! AXValue, .cfRange, &range) else { return nil }
    return FieldSnapshot(characters: characters, selectionLocation: range.location, selectionLength: range.length)
}

// Resolved before the keystroke is posted: this is the app that will receive it.
let target = (copyMode || awaitPaste != nil) ? NSWorkspace.shared.frontmostApplication : nil
if copyMode && target == nil {
    exit(1)
}

let watchStart = Date()
func watchElapsedMs() -> Int { Int(Date().timeIntervalSince(watchStart) * 1000) }

var watch: (app: AXUIElement, field: AXUIElement, baseline: FieldSnapshot)? = nil
if let awaitPaste = awaitPaste, let target = target {
    // A stalled target must answer late, not never: the watch has its own deadline.
    AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 0.25)
    let app = AXUIElementCreateApplication(target.processIdentifier)
    while true {
        let (field, error) = focusedField(of: app)
        if let field = field, let baseline = snapshot(of: field) {
            watch = (app, field, baseline)
            break
        }
        // Only a target that is busy (not one that cannot be read at all) is worth
        // waiting for; it will take the paste once it drains anyway.
        if error != .cannotComplete || watchElapsedMs() >= awaitPaste.budgetMs { break }
        usleep(15000)
    }
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

if copyMode, let target = target {
    print("COPY_OK \(target.processIdentifier) \(target.localizedName ?? "")")
}

if let awaitPaste = awaitPaste {
    guard let watch = watch else {
        // A target busy for the whole budget timed out; any other miss is an unreadable field.
        print(watchElapsedMs() >= awaitPaste.budgetMs ? "PASTE_TIMEOUT" : "PASTE_UNVERIFIED")
        exit(0)
    }
    // Only the pasted text replacing the selection, caret after it, proves the
    // pasteboard was read; any other change (output, typing, a click) does not.
    let pasted = FieldSnapshot(
        characters: watch.baseline.characters + awaitPaste.length - watch.baseline.selectionLength,
        selectionLocation: watch.baseline.selectionLocation + awaitPaste.length,
        selectionLength: 0
    )
    while watchElapsedMs() < awaitPaste.budgetMs {
        if let current = focusedField(of: watch.app).element {
            // Focus moved: the field we measured is no longer the paste target.
            if !CFEqual(current, watch.field) {
                print("PASTE_UNVERIFIED")
                exit(0)
            }
            if let now = snapshot(of: current), now != watch.baseline {
                print(now == pasted ? "PASTE_CONSUMED \(watchElapsedMs())" : "PASTE_UNVERIFIED")
                exit(0)
            }
        }
        usleep(15000)
    }
    print("PASTE_TIMEOUT")
}
