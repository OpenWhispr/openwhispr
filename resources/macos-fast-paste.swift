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

func argument(after flag: String) -> String? {
    guard let index = CommandLine.arguments.firstIndex(of: flag),
          index + 1 < CommandLine.arguments.count else { return nil }
    return CommandLine.arguments[index + 1]
}

// `--await-read <ms> --session <id>` pastes the transcript given on stdin and
// reports when the target reads it, so the caller restores the user's clipboard
// after the paste has landed instead of on a timer that a late reader outlasts
// (#1740). Prints PASTE_POSTED once ⌘V is out, then PASTE_READ <ms after ⌘V>,
// PASTE_REPLACED (something else was copied first) or PASTE_NOT_READ.
let awaitRead: (budgetMs: Int, session: String)? = {
    guard !copyMode,
          let budgetMs = argument(after: "--await-read").flatMap({ Int($0) }),
          let session = argument(after: "--session") else { return nil }
    return (budgetMs, session)
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

// Keep in sync with PASTE_SESSION_TYPE in src/helpers/clipboard.js.
let pasteSessionType = NSPasteboard.PasteboardType("com.openwhispr.paste-session")
let transientType = NSPasteboard.PasteboardType("org.nspasteboard.TransientType")

// Hands the transcript over only when a reader asks for it, which is how the
// paste is seen to land in every app, Chromium and terminals included. Marked
// transient (nspasteboard.org) so clipboard managers neither record nor read it,
// and kept off Universal Clipboard. The session tag lets the caller tell its own
// item from a later copy without reading, and so requesting, the transcript.
final class TranscriptPromise: NSObject, NSPasteboardItemDataProvider {
    let pasteboard: NSPasteboard
    let transcript: String
    let session: String
    let item = NSPasteboardItem()
    private var changeCount = 0
    private var readAt: TimeInterval?

    init(pasteboard: NSPasteboard, transcript: String, session: String) {
        self.pasteboard = pasteboard
        self.transcript = transcript
        self.session = session
    }

    func write() -> Bool {
        changeCount = pasteboard.prepareForNewContents(with: .currentHostOnly)
        item.setData(Data(), forType: transientType)
        item.setData(Data(session.utf8), forType: pasteSessionType)
        item.setDataProvider(self, forTypes: [.string])
        return pasteboard.writeObjects([item])
    }

    func pasteboard(_ pasteboard: NSPasteboard?, item: NSPasteboardItem, provideDataForType type: NSPasteboard.PasteboardType) {
        item.setString(transcript, forType: type)
        if readAt == nil {
            readAt = ProcessInfo.processInfo.systemUptime
        }
    }

    // Read requests arrive through the run loop, so it runs until one does.
    func waitForRead(postedAt: TimeInterval, budgetMs: Int) -> String {
        let deadline = postedAt + Double(budgetMs) / 1000
        while readAt == nil, pasteboard.changeCount == changeCount,
              ProcessInfo.processInfo.systemUptime < deadline {
            RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.01))
        }
        if let readAt = readAt {
            return "PASTE_READ \(Int(max(0, readAt - postedAt) * 1000))"
        }
        if pasteboard.changeCount != changeCount {
            return "PASTE_REPLACED"
        }
        // A promise dies with this process, so leave the transcript itself.
        item.setString(transcript, forType: .string)
        return "PASTE_NOT_READ"
    }
}
// End of TranscriptPromise.

// Resolved before the keystroke is posted: this is the app that will receive it.
let target = copyMode ? NSWorkspace.shared.frontmostApplication : nil
if copyMode && target == nil {
    exit(1)
}

guard let keyDown = CGEvent(keyboardEventSource: nil, virtualKey: virtualKey, keyDown: true),
      let keyUp = CGEvent(keyboardEventSource: nil, virtualKey: virtualKey, keyDown: false) else {
    exit(1)
}

// Written right before ⌘V, so nothing else lands on the pasteboard in between.
let promise = awaitRead.map {
    TranscriptPromise(
        pasteboard: .general,
        transcript: String(decoding: FileHandle.standardInput.readDataToEndOfFile(), as: UTF8.self),
        session: $0.session
    )
}
if let promise = promise, !promise.write() {
    exit(1)
}

keyDown.flags = .maskCommand
keyUp.flags = .maskCommand
keyDown.post(tap: .cgSessionEventTap)
let postedAt = ProcessInfo.processInfo.systemUptime
if promise != nil {
    // The caller must never paste again once this is out, whatever happens next.
    print("PASTE_POSTED")
    fflush(stdout)
}
usleep(8000)
keyUp.post(tap: .cgSessionEventTap)
usleep(20000)

if let target = target {
    print("COPY_OK \(target.processIdentifier) \(target.localizedName ?? "")")
}

if let awaitRead = awaitRead, let promise = promise {
    print(promise.waitForRead(postedAt: postedAt, budgetMs: awaitRead.budgetMs))
}
