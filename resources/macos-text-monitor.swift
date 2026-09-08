import Cocoa
import Foundation
import Darwin

let TIMEOUT_SECONDS: Double = 30.0
let MAX_OUTPUT_BYTES = 10240
let MAX_BASE64_SOURCE_CHARS = 7000

var monitoredElement: AXUIElement?
var observer: AXObserver?
var monitoredPid: pid_t = 0

func writeOutput(_ message: String) {
    FileHandle.standardOutput.write((message + "\n").data(using: .utf8)!)
    fflush(stdout)
}

func writeError(_ message: String) {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
}

func writeTextOutput(_ prefix: String, _ value: String) {
    let truncated = String(value.prefix(MAX_OUTPUT_BYTES))
    if truncated.contains("\n") || truncated.contains("\r") {
        let capped = String(truncated.prefix(MAX_BASE64_SOURCE_CHARS))
        let encoded = Data(capped.utf8).base64EncodedString()
        writeOutput("\(prefix)_B64:\(encoded)")
        return
    }

    writeOutput("\(prefix):\(truncated)")
}

func isEditableTextElement(_ element: AXUIElement) -> Bool {
    // A live selection means an editable verdict would let generated text
    // paste over the user's highlighted text (--editable-target mode probes
    // an element whose selection state the caller could not read itself).
    var selectedTextValue: AnyObject?
    if AXUIElementCopyAttributeValue(
        element,
        kAXSelectedTextAttribute as CFString,
        &selectedTextValue
    ) == .success, let selectedText = selectedTextValue as? String, !selectedText.isEmpty {
        return false
    }

    var enabledValue: AnyObject?
    if AXUIElementCopyAttributeValue(
        element,
        kAXEnabledAttribute as CFString,
        &enabledValue
    ) == .success, let enabled = enabledValue as? Bool, !enabled {
        return false
    }

    var subroleValue: AnyObject?
    if AXUIElementCopyAttributeValue(
        element,
        kAXSubroleAttribute as CFString,
        &subroleValue
    ) == .success, subroleValue as? String == "AXSecureTextField" {
        return false
    }

    var roleValue: AnyObject?
    guard AXUIElementCopyAttributeValue(
        element,
        kAXRoleAttribute as CFString,
        &roleValue
    ) == .success, let role = roleValue as? String,
          ["AXTextField", "AXTextArea", "AXComboBox"].contains(role)
    else {
        return false
    }

    var settable = DarwinBoolean(false)
    if AXUIElementIsAttributeSettable(
        element,
        kAXValueAttribute as CFString,
        &settable
    ) == .success, settable.boolValue {
        return true
    }

    settable = DarwinBoolean(false)
    return AXUIElementIsAttributeSettable(
        element,
        kAXSelectedTextAttribute as CFString,
        &settable
    ) == .success && settable.boolValue
}

func readCurrentValue() -> String? {
    guard let element = monitoredElement else { return nil }
    var value: AnyObject?
    let result = AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &value)
    guard result == .success, let str = value as? String else { return nil }
    return str
}

func observerCallback(
    _ observer: AXObserver,
    _ element: AXUIElement,
    _ notification: CFString,
    _ refcon: UnsafeMutableRawPointer?
) {
    if let value = readCurrentValue() {
        writeTextOutput("CHANGED", value)
    }
}

// Usage: macos-text-monitor <pid>
//        macos-text-monitor --selected-text <pid>
//        macos-text-monitor --editable-target <pid>
//        macos-text-monitor --window-bounds <pid>
let selectionReadMode = CommandLine.arguments.count >= 3 &&
    CommandLine.arguments[1] == "--selected-text"
let editableTargetMode = CommandLine.arguments.count >= 3 &&
    CommandLine.arguments[1] == "--editable-target"
let windowBoundsMode = CommandLine.arguments.count >= 3 &&
    CommandLine.arguments[1] == "--window-bounds"
let pidArgumentIndex = selectionReadMode || editableTargetMode || windowBoundsMode ? 2 : 1

guard CommandLine.arguments.count > pidArgumentIndex,
      let targetPid = Int32(CommandLine.arguments[pidArgumentIndex]),
      targetPid > 0 else {
    writeError("Usage: macos-text-monitor [--selected-text|--editable-target|--window-bounds] <pid>")
    writeOutput("NO_ELEMENT")
    exit(1)
}

monitoredPid = targetPid

// Reports the target's window rect so the caller can tell which display the user
// is working on. Asks the window server rather than accessibility on purpose:
// AXFocusedWindow is unavailable in exactly the apps whose accessibility tree
// stays dormant (Chromium), and window bounds need no Screen Recording
// permission — only window *titles* do.
if windowBoundsMode {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
    // Largest window rather than frontmost: layer 0 still includes the full-width
    // toolbar strips Arc-family browsers float above their content, and one of
    // those spanning another display would name the wrong screen.
    var best: (x: Int, y: Int, width: Int, height: Int, area: Double)?
    for window in windows {
        guard let ownerPid = window[kCGWindowOwnerPID as String] as? pid_t, ownerPid == targetPid,
              let layer = window[kCGWindowLayer as String] as? Int, layer == 0,
              let bounds = window[kCGWindowBounds as String] as? [String: Any],
              let x = bounds["X"] as? Double, let y = bounds["Y"] as? Double,
              let width = bounds["Width"] as? Double, let height = bounds["Height"] as? Double
        else { continue }
        let area = width * height
        if area > (best?.area ?? 0) {
            best = (Int(x), Int(y), Int(width), Int(height), area)
        }
    }

    guard let window = best else {
        writeOutput("NO_WINDOW")
        exit(1)
    }
    writeOutput("BOUNDS:\(window.x),\(window.y),\(window.width),\(window.height)")
    exit(0)
}

// Read original text from stdin (monitoring mode only). Selection reads are
// spawned via execFile, which keeps stdin open without writing — blocking on
// readLine there would hang until the caller's timeout kills the process.
var originalText = ""
if !selectionReadMode && !editableTargetMode, let line = readLine(strippingNewline: true) {
    originalText = line
}

// Target the specific application by PID (passed from the Electron host
// which captures it BEFORE the overlay steals focus).
let appElement = AXUIElementCreateApplication(monitoredPid)
let maxRetries = 5
var focusedElement: AXUIElement? = nil

for attempt in 1...maxRetries {
    var elementValue: AnyObject?
    let elementResult = AXUIElementCopyAttributeValue(
        appElement,
        kAXFocusedUIElementAttribute as CFString,
        &elementValue
    )

    if elementResult == .success, let element = elementValue {
        focusedElement = (element as! AXUIElement)
        if attempt > 1 {
            writeError("Got focused element on attempt \(attempt)")
        }
        break
    } else {
        writeError("Attempt \(attempt)/\(maxRetries): Cannot get focused element for PID \(monitoredPid) (error: \(elementResult.rawValue))")
    }

    if attempt < maxRetries {
        Thread.sleep(forTimeInterval: 0.3)
    }
}

guard let resolvedElement = focusedElement else {
    writeOutput("NO_ELEMENT")
    exit(1)
}

if editableTargetMode {
    writeOutput(isEditableTextElement(resolvedElement) ? "EDITABLE" : "NOT_EDITABLE")
    exit(0)
}

// Selection capture is a short-lived, read-only mode used before an AI edit.
// It deliberately uses the same AX client as the monitor so a packaged app's
// trusted native helper does not need to rely on System Events automation.
if selectionReadMode {
    var selectionValue: AnyObject?
    let selectionResult = AXUIElementCopyAttributeValue(
        resolvedElement,
        kAXSelectedTextAttribute as CFString,
        &selectionValue
    )

    if selectionResult == .success, let selection = selectionValue as? String {
        if selection.isEmpty {
            writeOutput(isEditableTextElement(resolvedElement) ? "EDITABLE_NONE:" : "NONE:")
        } else {
            writeTextOutput("SELECTED", selection)
        }
        exit(0)
    }

    if selectionResult == .noValue || selectionResult == .attributeUnsupported {
        writeOutput("NONE:")
        exit(0)
    }

    writeError("Cannot read selected text for PID \(monitoredPid) (error: \(selectionResult.rawValue))")
    writeOutput("UNAVAILABLE:")
    exit(1)
}

monitoredElement = resolvedElement
writeError("Monitoring element in PID \(monitoredPid)")

// Read initial value
guard let initialValue = readCurrentValue() else {
    writeError("Focused element has no text value")
    writeOutput("NO_VALUE")
    exit(0)
}

writeTextOutput("INITIAL_VALUE", initialValue)

// Create AXObserver for the target application's PID
var createdObserver: AXObserver?
let observerResult = AXObserverCreate(monitoredPid, observerCallback, &createdObserver)

guard observerResult == .success, let obs = createdObserver else {
    writeError("Failed to create AXObserver (error: \(observerResult.rawValue))")
    exit(1)
}

observer = obs

// Watch for value changes
let addResult = AXObserverAddNotification(
    obs,
    monitoredElement!,
    kAXValueChangedNotification as CFString,
    nil
)

if addResult != .success {
    writeError("Failed to add notification (error: \(addResult.rawValue))")
    exit(1)
}

// Add observer to run loop
CFRunLoopAddSource(
    CFRunLoopGetCurrent(),
    AXObserverGetRunLoopSource(obs),
    .commonModes
)

// Schedule auto-exit after timeout
DispatchQueue.main.asyncAfter(deadline: .now() + TIMEOUT_SECONDS) {
    CFRunLoopStop(CFRunLoopGetCurrent())
}

// Handle SIGTERM for clean exit
let signalSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
signal(SIGTERM, SIG_IGN)
signalSource.setEventHandler {
    CFRunLoopStop(CFRunLoopGetCurrent())
}
signalSource.resume()

CFRunLoopRun()
