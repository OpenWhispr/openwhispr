/**
 * macOS System Settings Window Reporter
 *
 * Prints, as JSON, the on-screen bounds of the System Settings window plus
 * whether a prompt is sitting in front of it:
 *
 *   {"settings":{"x":232,"y":232,"width":723,"height":804},"authPrompt":false}
 *
 * The onboarding permission guide anchors itself to that window, dismisses
 * itself when the window closes, and gets out of the way while macOS asks for a
 * password. Uses the CoreGraphics window list, which reports window owners and
 * bounds without the Accessibility or Screen Recording permissions — the guide
 * runs while those are still being granted, so anything requiring them would be
 * circular.
 *
 * Compile: swiftc -O macos-window-bounds.swift -o macos-window-bounds
 */

import CoreGraphics
import Foundation

// Ventura renamed System Preferences to System Settings; both names are matched
// so the helper keeps working on the older releases the app still supports.
let settingsOwners: Set<String> = ["System Settings", "System Preferences"]
// Authorization can also be drawn by a separate process depending on the macOS
// release, so those owners count as a prompt wherever they appear.
let authOwners: Set<String> = ["SecurityAgent", "loginwindow", "UserNotificationCenter"]
// Smaller than this and a window is a shadow or helper surface, not a dialog.
let minimumDialogSide: CGFloat = 100

struct Window {
    let owner: String
    let layer: Int
    let x: CGFloat
    let y: CGFloat
    let width: CGFloat
    let height: CGFloat

    var area: CGFloat { width * height }
    var isDialogSized: Bool { width >= minimumDialogSide && height >= minimumDialogSide }
}

// Front to back, which is what makes "in front of the settings window" decidable.
let windows: [Window] = (
    CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]] ?? []
).compactMap { entry in
    guard let bounds = entry[kCGWindowBounds as String] as? [String: Any],
        let x = bounds["X"] as? CGFloat,
        let y = bounds["Y"] as? CGFloat,
        let width = bounds["Width"] as? CGFloat,
        let height = bounds["Height"] as? CGFloat
    else { return nil }
    return Window(
        owner: entry[kCGWindowOwnerName as String] as? String ?? "",
        layer: entry[kCGWindowLayer as String] as? Int ?? -1,
        x: x, y: y, width: width, height: height)
}

// Layer 0 is the normal window layer, skipping the panels and popovers System
// Settings keeps above its window.
let settingsWindows = windows.enumerated().filter { _, window in
    settingsOwners.contains(window.owner) && window.layer == 0 && window.isDialogSized
}

// The largest one is the settings window itself. Picking the frontmost instead
// anchors the overlay to whatever sheet is open — including the password prompt.
let main = settingsWindows.max { $0.element.area < $1.element.area }

// Anything System Settings puts in front of its own window is a sheet the user
// has to deal with first, and the password prompt is one of those.
let sheetInFront = main.map { mainWindow in
    settingsWindows.contains { index, _ in index < mainWindow.offset }
} ?? false

let separateAuthWindow = windows.contains { authOwners.contains($0.owner) && $0.isDialogSized }

var settings = "null"
if let window = main?.element {
    settings =
        "{\"x\":\(Int(window.x)),\"y\":\(Int(window.y)),\"width\":\(Int(window.width)),\"height\":\(Int(window.height))}"
}

// The list is front to back, so the first normal window belongs to whichever app
// the user is actually looking at. The overlay hides when that is not the dialog.
func jsonString(_ value: String) -> String {
    let escaped = value.replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
    return "\"\(escaped)\""
}

let frontmost = windows.first { $0.layer == 0 && $0.isDialogSized }.map { jsonString($0.owner) }

print(
    "{\"settings\":\(settings),\"authPrompt\":\(sheetInFront || separateAuthWindow),\"frontmost\":\(frontmost ?? "null")}"
)
