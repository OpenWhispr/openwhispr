import Carbon
import Cocoa
import Darwin
import IOKit.hidsystem

var fnIsDown = false
var fnInterrupted = false
var fnTapInterrupted = false
var lastModifierFlags: NSEvent.ModifierFlags = []
var suppressedMouseButtons: Set<String> = []
var watchedCompoundKeys: Set<String> = []
var compoundKeysDown: [UInt16: Set<String>] = [:]
var uninterruptedRightModifiers: Set<String> = []

struct ListenerConfig: Decodable {
    var mouseButtons: Set<String> = []
    var suppressGlobeAction: Bool = false
    var compoundKeys: Set<String>?
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
        case "--compound-key":
            if let key = arguments.next() {
                config.compoundKeys = (config.compoundKeys ?? []).union([key])
            }
        case "--globe-preference-state":
            statePath = arguments.next()
        case "--restore-leftover-globe-preference":
            restoreLeftoverPreferenceOnly = true
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
    let nextCompoundKeys = config.compoundKeys ?? []
    if watchedCompoundKeys != nextCompoundKeys {
        watchedCompoundKeys = nextCompoundKeys
        compoundKeysDown.removeAll()
    }
    suppressedMouseButtons = config.mouseButtons
    updateMouseEventTap()
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

let rightModifiers: [(keyCode: Int, flag: NSEvent.ModifierFlags, name: String, leftBit: UInt, rightBit: UInt)] = [
    (kVK_RightOption, .option, "RightOption", UInt(NX_DEVICELALTKEYMASK), UInt(NX_DEVICERALTKEYMASK)),
    (kVK_RightCommand, .command, "RightCommand", UInt(NX_DEVICELCMDKEYMASK), UInt(NX_DEVICERCMDKEYMASK)),
    (kVK_RightControl, .control, "RightControl", UInt(NX_DEVICELCTLKEYMASK), UInt(NX_DEVICERCTLKEYMASK)),
    (kVK_RightShift, .shift, "RightShift", UInt(NX_DEVICELSHIFTKEYMASK), UInt(NX_DEVICERSHIFTKEYMASK)),
]

let modifierMask: NSEvent.ModifierFlags = [.control, .command, .option, .shift]
let standaloneModifierMask = modifierMask.union(.function)

func interruptModifiedStandaloneKeys(_ flags: NSEvent.ModifierFlags) {
    if !flags.intersection(modifierMask).isEmpty {
        interruptFnTap()
    }

    for modifier in rightModifiers where uninterruptedRightModifiers.contains(modifier.name) {
        let otherFlags = standaloneModifierMask.subtracting(modifier.flag)
        if !flags.intersection(otherFlags).isEmpty || flags.rawValue & modifier.leftBit != 0 {
            uninterruptedRightModifiers.remove(modifier.name)
            emit("RIGHT_MOD_INTERRUPTED:\(modifier.name)")
        }
    }
}

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

    let shouldSuppress = suppressedMouseButtons.contains(buttonName)
    if type == .otherMouseDown && shouldSuppress {
        // A suppressed side-button press never reaches the AppKit monitor.
        interruptPointerModifiers()
    }
    emit(type == .otherMouseDown ? "MOUSE_BUTTON_DOWN:\(buttonName)" : "MOUSE_BUTTON_UP:\(buttonName)")
    return shouldSuppress
}

let mouseEventMask =
    (1 << CGEventType.otherMouseDown.rawValue) |
    (1 << CGEventType.otherMouseUp.rawValue)

var mouseEventTapPort: CFMachPort?
var mouseRunLoopSource: CFRunLoopSource?

// The active tap can suppress configured side buttons and is Accessibility-
// protected, so keep it absent until a mouse-button hotkey actually needs it.
func updateMouseEventTap() {
    if suppressedMouseButtons.isEmpty {
        if let mouseEventTapPort {
            CGEvent.tapEnable(tap: mouseEventTapPort, enable: false)
            if let mouseRunLoopSource {
                CFRunLoopRemoveSource(CFRunLoopGetMain(), mouseRunLoopSource, .commonModes)
            }
        }
        mouseEventTapPort = nil
        mouseRunLoopSource = nil
        return
    }
    if mouseEventTapPort != nil { return }

    guard let tap = CGEvent.tapCreate(
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
    ) else {
        emitWarning("Failed to create mouse event tap")
        return
    }

    mouseEventTapPort = tap
    mouseRunLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
    CFRunLoopAddSource(CFRunLoopGetMain(), mouseRunLoopSource, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
}

guard let monitor = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged, handler: { event in
    let flags = event.modifierFlags
    let containsFn = flags.contains(.function)
    let currentModifiers = flags.intersection(standaloneModifierMask)

    // A flags event can add and remove modifiers together. Reject the changed chord
    // before any release can complete a compound tap or stop gesture.
    if !watchedCompoundKeys.isEmpty {
        let pressed = currentModifiers.subtracting(lastModifierFlags)
        for (flag, name) in releases where pressed.contains(flag) {
            emit("MODIFIER_DOWN:\(name)")
        }
        if pressed.contains(.function) { emit("MODIFIER_DOWN:fn") }
    }

    if containsFn && !fnIsDown {
        fnIsDown = true
        fnInterrupted = false
        fnTapInterrupted = false
        emit("FN_DOWN")
    }

    let rightModifier = rightModifiers.first { $0.keyCode == Int(event.keyCode) }
    let rightModifierIsDown = rightModifier.map { modifier in
        // The generic flag remains set when the other side is still held.
        let sideBits = flags.rawValue & (modifier.leftBit | modifier.rightBit)
        return sideBits == 0 ? flags.contains(modifier.flag) : sideBits & modifier.rightBit != 0
    } ?? false
    if let rightModifier, rightModifierIsDown {
        uninterruptedRightModifiers.insert(rightModifier.name)
        emit("RIGHT_MOD_DOWN:\(rightModifier.name)")
    }

    // Interrupt after a down so the candidate exists, and before an up can pair it.
    interruptModifiedStandaloneKeys(flags)

    if !containsFn && fnIsDown {
        fnIsDown = false
        fnInterrupted = false
        emit("FN_UP")
    }
    if let rightModifier, !rightModifierIsDown {
        uninterruptedRightModifiers.remove(rightModifier.name)
        emit("RIGHT_MOD_UP:\(rightModifier.name)")
    }

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

let namedCompoundKeys: [Int: String] = [
    kVK_Space: "space", kVK_Return: "return", kVK_ANSI_KeypadEnter: "return",
    kVK_Tab: "tab", kVK_Escape: "esc", kVK_Delete: "backspace", kVK_ForwardDelete: "delete",
    kVK_Home: "home", kVK_End: "end", kVK_PageUp: "pageup", kVK_PageDown: "pagedown",
    kVK_LeftArrow: "left", kVK_RightArrow: "right", kVK_UpArrow: "up", kVK_DownArrow: "down",
    kVK_F1: "f1", kVK_F2: "f2", kVK_F3: "f3", kVK_F4: "f4", kVK_F5: "f5", kVK_F6: "f6",
    kVK_F7: "f7", kVK_F8: "f8", kVK_F9: "f9", kVK_F10: "f10", kVK_F11: "f11", kVK_F12: "f12",
    kVK_F13: "f13", kVK_F14: "f14", kVK_F15: "f15", kVK_F16: "f16", kVK_F17: "f17", kVK_F18: "f18",
    kVK_F19: "f19", kVK_F20: "f20",
    kVK_ANSI_Keypad0: "num0", kVK_ANSI_Keypad1: "num1", kVK_ANSI_Keypad2: "num2",
    kVK_ANSI_Keypad3: "num3", kVK_ANSI_Keypad4: "num4", kVK_ANSI_Keypad5: "num5",
    kVK_ANSI_Keypad6: "num6", kVK_ANSI_Keypad7: "num7", kVK_ANSI_Keypad8: "num8",
    kVK_ANSI_Keypad9: "num9", kVK_ANSI_KeypadDecimal: "numdec", kVK_ANSI_KeypadPlus: "numadd",
    kVK_ANSI_KeypadMinus: "numsub", kVK_ANSI_KeypadMultiply: "nummult", kVK_ANSI_KeypadDivide: "numdiv",
]

func matchingCompoundKeys(_ event: NSEvent) -> Set<String> {
    if let namedKey = namedCompoundKeys[Int(event.keyCode)] {
        return watchedCompoundKeys.contains(namedKey) ? [namedKey] : []
    }
    // Resolve printable terminals in the active layout without chord modifiers.
    // Shift can also be part of the terminal itself, as for Plus.
    let candidates = [
        event.characters(byApplyingModifiers: []),
        event.characters(byApplyingModifiers: event.modifierFlags.intersection(.shift)),
    ].compactMap { $0?.lowercased() }
    return watchedCompoundKeys.intersection(candidates)
}

func interruptStandaloneModifiers() {
    if fnIsDown && !fnInterrupted {
        fnInterrupted = true
        emit("FN_INTERRUPTED")
    }
    interruptRightModifiers()
}

func interruptFnTap() {
    // An interruption ignored by Hold must not swallow its later keyboard interruption.
    guard fnIsDown && !fnTapInterrupted else { return }
    fnTapInterrupted = true
    emit("FN_TAP_INTERRUPTED")
}

func interruptPointerModifiers() {
    interruptFnTap()
    interruptRightModifiers()
}

func interruptRightModifiers() {
    for modifier in uninterruptedRightModifiers.sorted() {
        emit("RIGHT_MOD_INTERRUPTED:\(modifier)")
    }
    uninterruptedRightModifiers.removeAll()
}

let inputMonitor = NSEvent.addGlobalMonitorForEvents(
    matching: [.keyDown, .keyUp, .leftMouseDown, .rightMouseDown, .otherMouseDown]
) { event in
    switch event.type {
    case .leftMouseDown, .rightMouseDown, .otherMouseDown:
        interruptPointerModifiers()
    case .keyDown:
        interruptStandaloneModifiers()
        if !watchedCompoundKeys.isEmpty && !event.isARepeat {
            let matched = matchingCompoundKeys(event)
            if !matched.isEmpty {
                compoundKeysDown[event.keyCode] = matched
            }
        }
    case .keyUp:
        guard !watchedCompoundKeys.isEmpty else { return }
        // Keep the key-down identity when modifiers changed before release.
        // A system accelerator can consume the down event before AppKit sees it.
        let released = compoundKeysDown.removeValue(forKey: event.keyCode)
            ?? matchingCompoundKeys(event)
        for key in released.sorted() {
            emit("COMPOUND_KEY_UP:\(key)")
        }
    default:
        break
    }
}

func shutdownListener() -> Never {
    GlobeSystemAction.restore()
    NSEvent.removeMonitor(monitor)
    if let inputMonitor {
        NSEvent.removeMonitor(inputMonitor)
    }
    if let mouseEventTapPort {
        CGEvent.tapEnable(tap: mouseEventTapPort, enable: false)
    }
    if let mouseRunLoopSource {
        CFRunLoopRemoveSource(CFRunLoopGetMain(), mouseRunLoopSource, .commonModes)
    }
    exit(0)
}

// Only take over the system Globe action once the listener is known to work.
applyConfiguration(launchOptions.config)
if inputMonitor != nil {
    emit("KEY_MONITOR_READY")
} else {
    emit("KEY_MONITOR_UNAVAILABLE")
    emitWarning("Failed to create keyboard event monitor")
}

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
