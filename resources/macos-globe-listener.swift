import Cocoa
import Darwin

var fnIsDown = false
var fnInterrupted = false
var lastModifierFlags: NSEvent.ModifierFlags = []
var suppressedMouseButtons: Set<String> = []

struct ListenerConfig: Decodable {
    var mouseButtons: Set<String> = []
    var suppressGlobeAction: Bool = false
    // Modifier-only chords to watch, as canonical names ("option+command").
    var modifierChords: [String] = []
}

// Each configuration line carries the whole state, but a key a build does not
// know is a config it can still apply: missing keys keep their defaults.
extension ListenerConfig {
    private enum CodingKeys: String, CodingKey {
        case mouseButtons, suppressGlobeAction, modifierChords
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        mouseButtons = try container.decodeIfPresent(Set<String>.self, forKey: .mouseButtons) ?? []
        suppressGlobeAction = try container.decodeIfPresent(Bool.self, forKey: .suppressGlobeAction) ?? false
        modifierChords = try container.decodeIfPresent([String].self, forKey: .modifierChords) ?? []
    }
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
func parseArguments() -> (config: ListenerConfig, statePath: String?, restoreLeftoverPreferenceOnly: Bool) {
    var config = ListenerConfig()
    var statePath: String?
    var restoreLeftoverPreferenceOnly = false
    var arguments = CommandLine.arguments.dropFirst().makeIterator()

    while let argument = arguments.next() {
        switch argument {
        case "--suppress-system-globe-action":
            config.suppressGlobeAction = true
        case "--globe-preference-state":
            statePath = arguments.next()
        case "--restore-leftover-globe-preference":
            restoreLeftoverPreferenceOnly = true
        case "--modifier-chords":
            config.modifierChords = (arguments.next() ?? "")
                .split(separator: ",")
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
        default:
            config.mouseButtons.formUnion(
                argument.split(separator: ",")
                    .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                    .filter { !$0.isEmpty }
            )
        }
    }

    return (config, statePath, restoreLeftoverPreferenceOnly)
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
    applyModifierChords(config.modifierChords)
    updateEventTap()
    if config.suppressGlobeAction {
        GlobeSystemAction.apply()
    } else {
        GlobeSystemAction.restore()
    }
}

let launchOptions = parseArguments()
GlobeSystemAction.statePath = launchOptions.statePath
GlobeSystemAction.recoverLeftoverState()
if launchOptions.restoreLeftoverPreferenceOnly {
    GlobeSystemAction.restore()
    exit(0)
}

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

// A modifier-only chord such as Option+Command. Neither Electron's accelerators
// nor the right-modifier path above can watch one, so the listener reports the
// chord itself: MOD_CHORD_DOWN once the held modifiers are exactly the chord,
// MOD_CHORD_INTERRUPTED when another key or modifier joins it (the user is
// typing a shortcut the chord merely prefixes, e.g. Option+Command+Esc), and
// MOD_CHORD_UP once a chord modifier is released. Which side of the keyboard a
// modifier came from does not matter.
struct ModifierChord {
    let name: String
    let flags: NSEvent.ModifierFlags
}

let modifierFlagsByName: [String: NSEvent.ModifierFlags] = [
    "control": .control,
    "option": .option,
    "command": .command,
    "shift": .shift,
]

var modifierChords: [ModifierChord] = []
var activeChord: ModifierChord?
var activeChordInterrupted = false

func parseModifierChord(_ name: String) -> ModifierChord? {
    var flags: NSEvent.ModifierFlags = []
    var count = 0
    for part in name.split(separator: "+") {
        guard let flag = modifierFlagsByName[String(part)] else { return nil }
        if flags.contains(flag) { return nil }
        flags.insert(flag)
        count += 1
    }
    guard count >= 2 else { return nil }
    return ModifierChord(name: name, flags: flags)
}

func applyModifierChords(_ names: [String]) {
    modifierChords = names.compactMap { name in
        guard let chord = parseModifierChord(name) else {
            emitWarning("Ignored unsupported modifier chord: \(name)")
            return nil
        }
        return chord
    }
    // A chord no longer configured must not report a release later.
    if let active = activeChord, !modifierChords.contains(where: { $0.flags == active.flags }) {
        activeChord = nil
        activeChordInterrupted = false
    }
}

func interruptActiveChord() {
    guard let active = activeChord, !activeChordInterrupted else { return }
    activeChordInterrupted = true
    emit("MOD_CHORD_INTERRUPTED:\(active.name)")
}

func updateChordState(_ current: NSEvent.ModifierFlags) {
    if let active = activeChord {
        if current == active.flags { return }
        let next = modifierChords.first(where: { $0.flags == current })
        if current.isSuperset(of: active.flags) && next == nil {
            // Another modifier joined the chord: a larger shortcut is being typed.
            interruptActiveChord()
            return
        }
        activeChord = nil
        activeChordInterrupted = false
        emit("MOD_CHORD_UP:\(active.name)")
        if let next {
            activeChord = next
            emit("MOD_CHORD_DOWN:\(next.name)")
        }
        return
    }
    if let chord = modifierChords.first(where: { $0.flags == current }) {
        activeChord = chord
        activeChordInterrupted = false
        emit("MOD_CHORD_DOWN:\(chord.name)")
    }
}

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

// A key pressed while a chord is held has to be seen even when macOS consumes
// it for a system shortcut (Option+Command+Esc, Command+Space), which never
// reaches an NSEvent global monitor; a session-level tap sees it first.
let keyDownEventMask = 1 << CGEventType.keyDown.rawValue

var eventTapPort: CFMachPort?
var eventRunLoopSource: CFRunLoopSource?
var eventTapMask: CGEventMask = 0

func removeEventTap() {
    if let eventTapPort {
        CGEvent.tapEnable(tap: eventTapPort, enable: false)
        if let eventRunLoopSource {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), eventRunLoopSource, .commonModes)
        }
    }
    eventTapPort = nil
    eventRunLoopSource = nil
    eventTapMask = 0
}

// The tap is Accessibility-protected, so keep it absent until a mouse-button or
// chord hotkey needs it. Only a mouse button has to be swallowed; a chord just
// watches key-downs, and a listen-only tap can never hold up the keyboard if
// the listener stalls.
func updateEventTap() {
    var mask: CGEventMask = 0
    if !suppressedMouseButtons.isEmpty {
        mask |= CGEventMask(mouseEventMask)
    }
    if !modifierChords.isEmpty {
        mask |= CGEventMask(keyDownEventMask)
    }
    if mask == 0 {
        removeEventTap()
        return
    }
    if eventTapPort != nil && eventTapMask == mask { return }
    removeEventTap()

    guard let tap = CGEvent.tapCreate(
        tap: .cgSessionEventTap,
        place: .headInsertEventTap,
        options: suppressedMouseButtons.isEmpty ? .listenOnly : .defaultTap,
        eventsOfInterest: mask,
        callback: { _, type, event, _ in
            if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                if let eventTapPort {
                    CGEvent.tapEnable(tap: eventTapPort, enable: true)
                }
                return Unmanaged.passUnretained(event)
            }

            if type == .keyDown {
                interruptActiveChord()
                return Unmanaged.passUnretained(event)
            }

            if emitMouseEvent(type, event) {
                return nil
            }

            return Unmanaged.passUnretained(event)
        },
        userInfo: nil
    ) else {
        emitWarning("Failed to create event tap")
        return
    }

    eventTapPort = tap
    eventTapMask = mask
    eventRunLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
    CFRunLoopAddSource(CFRunLoopGetMain(), eventRunLoopSource, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
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
        updateChordState(currentModifiers)
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
    removeEventTap()
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
