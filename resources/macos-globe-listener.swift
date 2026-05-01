import Cocoa
import CoreGraphics
import Darwin
import IOKit.hid

var fnIsDown = false
var fnInterruptedThisCycle = false
var lastModifierFlags: NSEvent.ModifierFlags = []

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

func emit(_ message: String) {
    FileHandle.standardOutput.write((message + "\n").data(using: .utf8)!)
    fflush(stdout)
}

guard let monitor = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged, handler: { event in
    let flags = event.modifierFlags
    let containsFn = flags.contains(.function)

    if containsFn && !fnIsDown {
        fnIsDown = true
        fnInterruptedThisCycle = false
        emit("FN_DOWN")
    } else if !containsFn && fnIsDown {
        fnIsDown = false
        fnInterruptedThisCycle = false
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
    FileHandle.standardError.write("Failed to create event monitor\n".data(using: .utf8)!)
    exit(1)
}

// Proactively request Input Monitoring permission so the user sees the TCC
// prompt (or the app appears in System Settings → Privacy & Security → Input
// Monitoring) instead of the listener silently no-op'ing.
_ = IOHIDRequestAccess(kIOHIDRequestTypeListenEvent)

// CGEventTap delivers global keyDown reliably (NSEvent global keyDown monitor
// is gated by Input Monitoring TCC and silently no-ops without it).
let keyDownTapCallback: CGEventTapCallBack = { _, _, event, _ in
    if fnIsDown && !fnInterruptedThisCycle {
        fnInterruptedThisCycle = true
        emit("FN_INTERRUPTED")
    }
    return Unmanaged.passUnretained(event)
}

let keyDownEventMask: CGEventMask = (1 << CGEventType.keyDown.rawValue)

var keyDownTapRef: CFMachPort? = nil
var keyDownRunLoopSource: CFRunLoopSource? = nil
var inputMonitoringGranted = false

func tryAttachKeyDownTap() -> Bool {
    let tap = CGEvent.tapCreate(
        tap: .cghidEventTap,
        place: .headInsertEventTap,
        options: .listenOnly,
        eventsOfInterest: keyDownEventMask,
        callback: keyDownTapCallback,
        userInfo: nil
    )
    guard let tap = tap else { return false }
    let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
    if let source = source {
        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        keyDownTapRef = tap
        keyDownRunLoopSource = source
        return true
    }
    return false
}

if tryAttachKeyDownTap() {
    inputMonitoringGranted = true
    emit("INPUT_MONITORING:granted")
} else {
    FileHandle.standardError.write("Failed to create keyDown event tap — Fn interrupt detection disabled (grant Input Monitoring permission)\n".data(using: .utf8)!)
    emit("INPUT_MONITORING:denied")
}

// Re-probe periodically so a newly-granted permission is picked up without
// requiring an app restart. Stops probing once granted.
let probeTimer = Timer(timeInterval: 3.0, repeats: true) { _ in
    if inputMonitoringGranted { return }
    if tryAttachKeyDownTap() {
        inputMonitoringGranted = true
        emit("INPUT_MONITORING:granted")
    }
}
RunLoop.main.add(probeTimer, forMode: .common)

let signalSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
signal(SIGTERM, SIG_IGN)
signalSource.setEventHandler {
    NSEvent.removeMonitor(monitor)
    if let tap = keyDownTapRef {
        CGEvent.tapEnable(tap: tap, enable: false)
    }
    if let source = keyDownRunLoopSource {
        CFRunLoopRemoveSource(CFRunLoopGetCurrent(), source, .commonModes)
    }
    exit(0)
}
signalSource.resume()

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
app.run()
