import Cocoa
import Darwin

var fnIsDown = false
var fnInterrupted = false
var lastModifierFlags: NSEvent.ModifierFlags = []
var suppressedMouseButtons: Set<String> = []

struct ListenerConfig: Decodable {
    var mouseButtons: Set<String> = []
    var suppressGlobeAction: Bool = false
}

func emit(_ message: String) {
    FileHandle.standardOutput.write((message + "\n").data(using: .utf8)!)
    fflush(stdout)
}

func emitWarning(_ message: String) {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
}

// Mouse buttons arrive as a positional comma-separated list; everything else is
// an explicit flag.
func parseArguments() -> (config: ListenerConfig, statePath: String?) {
    var config = ListenerConfig()
    var statePath: String?
    var arguments = CommandLine.arguments.dropFirst().makeIterator()

    while let argument = arguments.next() {
        switch argument {
        case "--suppress-system-globe-action":
            config.suppressGlobeAction = true
        case "--globe-preference-state":
            statePath = arguments.next()
        default:
            config.mouseButtons.formUnion(
                argument.split(separator: ",")
                    .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                    .filter { !$0.isEmpty }
            )
        }
    }

    return (config, statePath)
}

struct GlobePreferenceState: Codable {
    let version: Int
    let originalValue: Int32
    let keyExisted: Bool
}

// macOS runs the standalone Globe action (emoji viewer, input-source switch,
// dictation) from WindowServer ahead of every event tap, so a listener cannot
// consume the key — the only way to stop it firing alongside an OpenWhispr Globe
// hotkey is to hold AppleFnUsageType at "Do Nothing" while we own the key.
// TISUpdateFnUsageType is what System Settings itself calls: it persists the
// preference and broadcasts the change so it applies live. Writing the
// preference directly is ignored until the user's next login.
enum GlobeSystemAction {
    private typealias GetUsageType = @convention(c) () -> Int32
    private typealias UpdateUsageType = @convention(c) (Int32) -> Void

    private static let doNothing: Int32 = 0
    private static let stateVersion = 1
    private static let domain = "com.apple.HIToolbox" as CFString
    private static let key = "AppleFnUsageType" as CFString

    private static let entryPoints: (get: GetUsageType, update: UpdateUsageType)? = {
        guard let carbon = dlopen("/System/Library/Frameworks/Carbon.framework/Carbon", RTLD_LAZY),
              let get = dlsym(carbon, "TISGetFnUsageType"),
              let update = dlsym(carbon, "TISUpdateFnUsageType")
        else { return nil }
        return (unsafeBitCast(get, to: GetUsageType.self), unsafeBitCast(update, to: UpdateUsageType.self))
    }()

    static var statePath: String?
    private static var owned: GlobePreferenceState?

    // Adopts a marker left by a crashed run so its recorded original value is
    // used instead of mistaking our own override for the user's preference.
    static func recoverLeftoverState() {
        guard let state = readMarker(), let entryPoints else { return }
        if entryPoints.get() == doNothing {
            owned = state
        } else {
            // The user picked a new action since we died — theirs wins.
            removeMarker()
        }
    }

    static func apply() {
        guard owned == nil else { return }
        guard let entryPoints else {
            emitWarning("Cannot suppress the macOS Globe action: TISUpdateFnUsageType unavailable")
            return
        }

        let original = entryPoints.get()
        guard original != doNothing else { return }

        let state = GlobePreferenceState(
            version: stateVersion,
            originalValue: original,
            keyExisted: rawValueExists()
        )
        // Record how to get back before changing anything.
        guard writeMarker(state) else { return }

        owned = state
        entryPoints.update(doNothing)
    }

    static func restore() {
        guard let state = owned, let entryPoints else { return }
        owned = nil

        // Only put the value back while it is still ours: if the user picked a
        // new action while we were running, that choice wins.
        if entryPoints.get() == doNothing {
            entryPoints.update(state.originalValue)
            // The value was a macOS-computed default before we touched it, so
            // clear the key again to keep it tracking hardware and input sources.
            if !state.keyExisted {
                clearRawValue()
            }
        }

        removeMarker()
    }

    // CFPreferencesCopyAppValue caches foreign domains for the life of the
    // process and would miss changes made after launch.
    private static func rawValueExists() -> Bool {
        CFPreferencesSynchronize(domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost)
        return CFPreferencesCopyValue(key, domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost) != nil
    }

    private static func clearRawValue() {
        CFPreferencesSetValue(key, nil, domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost)
        CFPreferencesSynchronize(domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost)
    }

    private static func readMarker() -> GlobePreferenceState? {
        guard let statePath, let data = FileManager.default.contents(atPath: statePath) else { return nil }
        guard let state = try? JSONDecoder().decode(GlobePreferenceState.self, from: data),
              state.version == stateVersion
        else {
            removeMarker()
            return nil
        }
        return state
    }

    private static func writeMarker(_ state: GlobePreferenceState) -> Bool {
        guard let statePath else {
            emitWarning("Cannot suppress the macOS Globe action: no state path provided")
            return false
        }
        do {
            try JSONEncoder().encode(state).write(to: URL(fileURLWithPath: statePath), options: .atomic)
            return true
        } catch {
            emitWarning("Cannot suppress the macOS Globe action: \(error.localizedDescription)")
            return false
        }
    }

    private static func removeMarker() {
        guard let statePath else { return }
        try? FileManager.default.removeItem(atPath: statePath)
    }
}

func applyConfiguration(_ config: ListenerConfig) {
    suppressedMouseButtons = config.mouseButtons
    if config.suppressGlobeAction {
        GlobeSystemAction.apply()
    } else {
        GlobeSystemAction.restore()
    }
}

let launchOptions = parseArguments()
GlobeSystemAction.statePath = launchOptions.statePath
GlobeSystemAction.recoverLeftoverState()

let rightModifiers: [(UInt16, NSEvent.ModifierFlags, String)] = [
    (61, .option, "RightOption"),
    (54, .command, "RightCommand"),
    (62, .control, "RightControl"),
    (60, .shift, "RightShift"),
]

let modifierMask: NSEvent.ModifierFlags = [.control, .command, .option, .shift]

let releases: [(NSEvent.ModifierFlags, String)] = [
    (.control, "control"),
    (.command, "command"),
    (.option, "option"),
    (.shift, "shift"),
]

func mouseButtonName(_ buttonNumber: Int) -> String? {
    switch buttonNumber {
    case 3:
        return "MouseButton4"
    case 4:
        return "MouseButton5"
    default:
        return nil
    }
}

func emitMouseEvent(_ type: CGEventType, _ event: CGEvent) -> Bool {
    guard type == .otherMouseDown || type == .otherMouseUp else { return false }

    let buttonNumber = Int(event.getIntegerValueField(.mouseEventButtonNumber))
    guard let buttonName = mouseButtonName(buttonNumber) else { return false }

    emit(type == .otherMouseDown ? "MOUSE_BUTTON_DOWN:\(buttonName)" : "MOUSE_BUTTON_UP:\(buttonName)")
    return suppressedMouseButtons.contains(buttonName)
}

let mouseEventMask =
    (1 << CGEventType.otherMouseDown.rawValue) |
    (1 << CGEventType.otherMouseUp.rawValue)

var mouseEventTapPort: CFMachPort?

let mouseEventTap = CGEvent.tapCreate(
    tap: .cgSessionEventTap,
    place: .headInsertEventTap,
    options: .defaultTap,
    eventsOfInterest: CGEventMask(mouseEventMask),
    callback: { _, type, event, _ in
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let mouseEventTapPort {
                CGEvent.tapEnable(tap: mouseEventTapPort, enable: true)
            }
            return Unmanaged.passUnretained(event)
        }

        if emitMouseEvent(type, event) {
            return nil
        }

        return Unmanaged.passUnretained(event)
    },
    userInfo: nil
)

var mouseRunLoopSource: CFRunLoopSource?
if let mouseEventTap {
    mouseEventTapPort = mouseEventTap
    mouseRunLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, mouseEventTap, 0)
    CFRunLoopAddSource(CFRunLoopGetMain(), mouseRunLoopSource, .commonModes)
    CGEvent.tapEnable(tap: mouseEventTap, enable: true)
} else {
    emitWarning("Failed to create mouse event tap")
}

guard let monitor = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged, handler: { event in
    let flags = event.modifierFlags
    let containsFn = flags.contains(.function)

    if containsFn && !fnIsDown {
        fnIsDown = true
        fnInterrupted = false
        emit("FN_DOWN")
    } else if !containsFn && fnIsDown {
        fnIsDown = false
        fnInterrupted = false
        emit("FN_UP")
    }

    let keyCode = event.keyCode
    for (code, flag, name) in rightModifiers {
        if keyCode == code {
            emit(flags.contains(flag) ? "RIGHT_MOD_DOWN:\(name)" : "RIGHT_MOD_UP:\(name)")
            break
        }
    }

    let currentModifiers = flags.intersection(modifierMask)
    if currentModifiers != lastModifierFlags {
        let released = lastModifierFlags.subtracting(currentModifiers)
        for (flag, name) in releases {
            if released.contains(flag) {
                emit("MODIFIER_UP:\(name)")
            }
        }
        lastModifierFlags = currentModifiers
    }
}) else {
    emitWarning("Failed to create event monitor")
    GlobeSystemAction.restore()
    exit(1)
}

// Detect another key pressed while Fn is held (e.g. Fn+Arrow → Home) so the
// JS side can cancel an in-progress bare-Fn push-to-talk instead of transcribing noise.
let keyMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { _ in
    if fnIsDown && !fnInterrupted {
        fnInterrupted = true
        emit("FN_INTERRUPTED")
    }
}

func shutdownListener() -> Never {
    GlobeSystemAction.restore()
    NSEvent.removeMonitor(monitor)
    if let keyMonitor {
        NSEvent.removeMonitor(keyMonitor)
    }
    if let mouseEventTap {
        CGEvent.tapEnable(tap: mouseEventTap, enable: false)
    }
    if let mouseRunLoopSource {
        CFRunLoopRemoveSource(CFRunLoopGetMain(), mouseRunLoopSource, .commonModes)
    }
    exit(0)
}

// Only take over the system Globe action once the listener is known to work.
applyConfiguration(launchOptions.config)

// Reconfiguration arrives as one JSON object per line so the hotkey can change
// without restarting; EOF means the app is gone and the Globe key goes back.
var stdinBuffer = [UInt8]()
let stdinSource = DispatchSource.makeReadSource(fileDescriptor: STDIN_FILENO, queue: .main)
stdinSource.setEventHandler {
    var chunk = [UInt8](repeating: 0, count: 4096)
    let bytesRead = read(STDIN_FILENO, &chunk, chunk.count)

    guard bytesRead > 0 else {
        if bytesRead == 0 || (errno != EAGAIN && errno != EINTR) {
            shutdownListener()
        }
        return
    }

    stdinBuffer.append(contentsOf: chunk[0..<bytesRead])
    while let newline = stdinBuffer.firstIndex(of: UInt8(ascii: "\n")) {
        let line = Data(stdinBuffer[..<newline])
        stdinBuffer.removeSubrange(...newline)
        if let config = try? JSONDecoder().decode(ListenerConfig.self, from: line) {
            applyConfiguration(config)
        } else {
            emitWarning("Ignored malformed configuration line")
        }
    }
}
stdinSource.resume()

func installTerminationSource(for signalNumber: Int32) -> DispatchSourceSignal {
    signal(signalNumber, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
    source.setEventHandler { shutdownListener() }
    source.resume()
    return source
}

// Held for the process lifetime: releasing these sources would drop the signal
// handlers and with them the preference restore on quit.
let terminationSources = [SIGTERM, SIGINT].map(installTerminationSource(for:))

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
app.run()
