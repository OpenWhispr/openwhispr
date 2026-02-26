import Cocoa
import Foundation
import Darwin

let electronEditors: Set<String> = [
    "com.microsoft.VSCode",
    "com.todesktop.230313mzl4w4u92",   // Cursor
    "com.exafunction.windsurf",         // Windsurf
    "com.codeium.windsurf",             // Windsurf (alternate)
]

let treeWalkDeadline = DispatchTime.now() + .milliseconds(400)

// MARK: - JSON helpers

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

func jsonArray(_ values: [String]) -> String {
    let items = values.map { "\"\(jsonEscape($0))\"" }.joined(separator: ",")
    return "[\(items)]"
}

// MARK: - AX tree walking

func getRole(_ element: AXUIElement) -> String? {
    var value: AnyObject?
    guard AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &value) == .success else { return nil }
    return value as? String
}

func getTitle(_ element: AXUIElement) -> String? {
    var value: AnyObject?
    guard AXUIElementCopyAttributeValue(element, kAXTitleAttribute as CFString, &value) == .success else { return nil }
    return value as? String
}

func getDescription(_ element: AXUIElement) -> String? {
    var value: AnyObject?
    guard AXUIElementCopyAttributeValue(element, kAXDescriptionAttribute as CFString, &value) == .success else { return nil }
    return value as? String
}

func getChildren(_ element: AXUIElement) -> [AXUIElement] {
    var value: AnyObject?
    guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value) == .success else { return [] }
    return value as? [AXUIElement] ?? []
}

func findByRole(_ element: AXUIElement, role: String, maxDepth: Int = 8) -> [AXUIElement] {
    if DispatchTime.now() > treeWalkDeadline || maxDepth <= 0 { return [] }

    var results: [AXUIElement] = []
    if getRole(element) == role {
        results.append(element)
    }
    for child in getChildren(element) {
        results.append(contentsOf: findByRole(child, role: role, maxDepth: maxDepth - 1))
        if results.count > 120 { break }
    }
    return results
}

func extractTabNames(_ window: AXUIElement) -> [String] {
    let tabGroups = findByRole(window, role: "AXTabGroup")
    var tabs: [String] = []
    for group in tabGroups {
        for child in getChildren(group) {
            guard let role = getRole(child) else { continue }
            // Electron tabs appear as AXRadioButton or AXTab
            if role == "AXRadioButton" || role == "AXTab" {
                if let title = getTitle(child), !title.isEmpty {
                    tabs.append(title)
                }
            }
        }
        if !tabs.isEmpty { break }
    }
    return tabs
}

func extractSidebarItems(_ window: AXUIElement) -> [String] {
    let outlines = findByRole(window, role: "AXOutline")
    var items: [String] = []
    for outline in outlines {
        if DispatchTime.now() > treeWalkDeadline { break }
        let rows = getChildren(outline)
        for row in rows {
            if items.count >= 100 || DispatchTime.now() > treeWalkDeadline { break }
            // Each AXRow may have a title or a description
            if let title = getTitle(row), !title.isEmpty {
                items.append(title)
            } else if let desc = getDescription(row), !desc.isEmpty {
                items.append(desc)
            } else {
                // Try children of the row for text content
                for child in getChildren(row) {
                    if let childTitle = getTitle(child), !childTitle.isEmpty {
                        items.append(childTitle)
                        break
                    }
                    if let role = getRole(child), role == "AXStaticText" {
                        var val: AnyObject?
                        if AXUIElementCopyAttributeValue(child, kAXValueAttribute as CFString, &val) == .success,
                           let text = val as? String, !text.isEmpty {
                            items.append(text)
                            break
                        }
                    }
                }
            }
        }
        if !items.isEmpty { break }
    }
    return items
}

// MARK: - Main

guard let app = NSWorkspace.shared.frontmostApplication else {
    FileHandle.standardError.write("No frontmost application\n".data(using: .utf8)!)
    exit(1)
}

let bundleId = app.bundleIdentifier
let appName = app.localizedName
var windowTitle: String?
var openTabs: [String] = []
var sidebarFiles: [String] = []
var exitCode: Int32 = 0

if AXIsProcessTrusted() {
    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    var focusedWindow: AnyObject?
    let windowResult = AXUIElementCopyAttributeValue(axApp, kAXFocusedWindowAttribute as CFString, &focusedWindow)
    if windowResult == .success {
        let win = focusedWindow as! AXUIElement

        var titleValue: AnyObject?
        let titleResult = AXUIElementCopyAttributeValue(win, kAXTitleAttribute as CFString, &titleValue)
        if titleResult == .success, let title = titleValue as? String, !title.isEmpty {
            windowTitle = title
        }

        // AX tree walking only for known Electron editors
        if let bid = bundleId, electronEditors.contains(bid) {
            openTabs = extractTabNames(win)
            sidebarFiles = extractSidebarItems(win)
        }
    }
} else {
    exitCode = 2
}

var json = "{\"bundleId\":\(jsonString(bundleId)),\"appName\":\(jsonString(appName)),\"windowTitle\":\(jsonString(windowTitle))"
if !openTabs.isEmpty {
    json += ",\"openTabs\":\(jsonArray(openTabs))"
}
if !sidebarFiles.isEmpty {
    json += ",\"sidebarFiles\":\(jsonArray(sidebarFiles))"
}
json += "}"

FileHandle.standardOutput.write(json.data(using: .utf8)!)
FileHandle.standardOutput.write("\n".data(using: .utf8)!)
exit(exitCode)
