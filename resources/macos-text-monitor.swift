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
guard CommandLine.arguments.count >= 2,
      let targetPid = Int32(CommandLine.arguments[1]),
      targetPid > 0 else {
    writeError("Usage: macos-text-monitor <pid>")
    writeOutput("NO_ELEMENT")
    exit(1)
}

monitoredPid = targetPid

// Read original text from stdin
var originalText = ""
if let line = readLine(strippingNewline: true) {
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
