import Cocoa
import Foundation
import Darwin

func jsonEscape(_ str: String) -> String {
    var result = str
    result = result.replacingOccurrences(of: "\\", with: "\\\\")
    result = result.replacingOccurrences(of: "\"", with: "\\\"")
    result = result.replacingOccurrences(of: "\n", with: "\\n")
    result = result.replacingOccurrences(of: "\r", with: "\\r")
    result = result.replacingOccurrences(of: "\t", with: "\\t")
    return result
}

func jsonString(_ value: String?) -> String {
    guard let value = value else { return "null" }
    return "\"\(jsonEscape(value))\""
}

// Gather frontmost application info (no Accessibility needed)
guard let app = NSWorkspace.shared.frontmostApplication else {
    FileHandle.standardError.write("No frontmost application\n".data(using: .utf8)!)
    exit(1)
}

let bundleId = app.bundleIdentifier
let appName = app.localizedName
var windowTitle: String?
var exitCode: Int32 = 0

// Accessibility required for window title
if AXIsProcessTrusted() {
    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    var focusedWindow: AnyObject?
    let windowResult = AXUIElementCopyAttributeValue(axApp, kAXFocusedWindowAttribute as CFString, &focusedWindow)
    if windowResult == .success {
        var titleValue: AnyObject?
        let titleResult = AXUIElementCopyAttributeValue(focusedWindow as! AXUIElement, kAXTitleAttribute as CFString, &titleValue)
        if titleResult == .success, let title = titleValue as? String, !title.isEmpty {
            windowTitle = title
        }
    }
} else {
    exitCode = 2
}

let json = "{\"bundleId\":\(jsonString(bundleId)),\"appName\":\(jsonString(appName)),\"windowTitle\":\(jsonString(windowTitle))}"
FileHandle.standardOutput.write(json.data(using: .utf8)!)
FileHandle.standardOutput.write("\n".data(using: .utf8)!)
exit(exitCode)
