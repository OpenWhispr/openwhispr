import Cocoa
import Darwin

var fnIsDown = false
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
        emit("FN_DOWN")
    } else if !containsFn && fnIsDown {
        fnIsDown = false
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

let signalSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
signal(SIGTERM, SIG_IGN)
signalSource.setEventHandler {
    NSEvent.removeMonitor(monitor)
    exit(0)
}
signalSource.resume()

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
app.run()
