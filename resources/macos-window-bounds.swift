/**
 * macOS System Settings Window Reporter
 *
 * Prints, as JSON, the on-screen bounds of the System Settings window, whether
 * a prompt is sitting in front of it, and which app owns the front window:
 *
 *   {"settings":{"x":232,"y":232,"width":723,"height":804},"authPrompt":false,
 *    "frontmost":"settings","settingsRunning":true}
 *
 * The onboarding permission guide anchors itself to that window, dismisses
 * itself when the window closes, and gets out of the way while macOS asks for a
 * password, the user switches to another app, or the dialog sits on another
 * Space (settingsRunning without a window on screen). Uses the CoreGraphics window
 * list, which reports window owners and bounds without the Accessibility or
 * Screen Recording permissions — the guide runs while those are still being
 * granted, so anything requiring them would be circular.
 *
 * Windows are attributed by owner process, never by owner name: the name is the
 * localized bundle name ("Systemeinstellungen" on a German Mac). The first
 * argument is the caller's own pid, so its windows report as "self".
 *
 * Compile: swiftc -O macos-window-bounds.swift -o macos-window-bounds
 */

import AppKit
import CoreGraphics
import Foundation

// Ventura renamed System Preferences to System Settings; the bundle identifier
// is the one thing that stayed the same across the releases the app supports.
let settingsBundleId = "com.apple.systempreferences"
// Authorization can also be drawn by a separate process depending on the macOS
// release, so those owners count as a prompt wherever they appear.
let authOwners: Set<String> = ["SecurityAgent", "loginwindow", "UserNotificationCenter"]
// Smaller than this and a window is a shadow or helper surface, not a dialog.
let minimumDialogSide: CGFloat = 100
// Dialogs live at the normal and modal-panel levels. The lock screen's shield
// windows sit far above them and must not read as a prompt.
let maximumDialogLayer = 8

let selfPid: pid_t = CommandLine.arguments.dropFirst().first.flatMap { Int32($0) } ?? 0

struct Window {
    let ownerPid: pid_t
    let owner: String
    let layer: Int
    let x: CGFloat
    let y: CGFloat
    let width: CGFloat
    let height: CGFloat

    var area: CGFloat { width * height }
    var isDialogSized: Bool { width >= minimumDialogSide && height >= minimumDialogSide }
    var isDialogLayer: Bool { layer >= 0 && layer <= maximumDialogLayer }
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
        let height = bounds["Height"] as? CGFloat,
        [x, y, width, height].allSatisfy({ $0.isFinite })
    else { return nil }
    return Window(
        ownerPid: entry[kCGWindowOwnerPID as String] as? pid_t ?? 0,
        owner: entry[kCGWindowOwnerName as String] as? String ?? "",
        layer: entry[kCGWindowLayer as String] as? Int ?? -1,
        x: x, y: y, width: width, height: height)
}

func isSettingsProcess(_ pid: pid_t) -> Bool {
    NSRunningApplication(processIdentifier: pid)?.bundleIdentifier == settingsBundleId
}

let settingsRunning = !NSRunningApplication.runningApplications(withBundleIdentifier: settingsBundleId)
    .isEmpty

// Layer 0 is the normal window layer, skipping the panels and popovers System
// Settings keeps above its window.
let settingsWindows = windows.enumerated().filter { _, window in
    window.layer == 0 && window.isDialogSized && isSettingsProcess(window.ownerPid)
}

// The largest one is the settings window itself. Picking the frontmost instead
// anchors the overlay to whatever sheet is open — including the password prompt.
let main = settingsWindows.max { $0.element.area < $1.element.area }

// Anything System Settings puts in front of its own window is a sheet the user
// has to deal with first, and the password prompt is one of those.
let sheetInFront = main.map { mainWindow in
    settingsWindows.contains { index, _ in index < mainWindow.offset }
} ?? false

let separateAuthWindow = windows.contains {
    authOwners.contains($0.owner) && $0.isDialogSized && $0.isDialogLayer
}

var settings = "null"
if let window = main?.element {
    settings =
        "{\"x\":\(Int(window.x)),\"y\":\(Int(window.y)),\"width\":\(Int(window.width)),\"height\":\(Int(window.height))}"
}

// The list is front to back, so the first normal window belongs to whichever app
// the user is actually looking at. The overlay hides when that is neither the
// dialog nor the app itself.
let frontmost = windows.first { $0.layer == 0 && $0.isDialogSized }.map { window -> String in
    if isSettingsProcess(window.ownerPid) { return "\"settings\"" }
    if selfPid != 0 && window.ownerPid == selfPid { return "\"self\"" }
    return "\"other\""
}

print(
    "{\"settings\":\(settings),\"authPrompt\":\(sheetInFront || separateAuthWindow),"
        + "\"frontmost\":\(frontmost ?? "null"),\"settingsRunning\":\(settingsRunning)}"
)
