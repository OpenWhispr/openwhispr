/**
 * macOS Notch Geometry Probe
 *
 * One-shot probe: prints one JSON line describing every NSScreen (points) then exits.
 * notchWidth = frame.width - auxiliaryTopLeftArea.width - auxiliaryTopRightArea.width (0 when no notch).
 * menuBarInset = safeAreaInsets.top.
 *
 * Compile: swiftc -O notch-probe.swift -o notch-probe -framework AppKit
 */

import AppKit
import Foundation

// Touch NSApplication so NSScreen is populated in a plain command-line tool.
_ = NSApplication.shared

var screenObjects: [String] = []
for screen in NSScreen.screens {
    let frame = screen.frame
    var notchWidth: CGFloat = 0
    var menuBarInset: CGFloat = 0
    if #available(macOS 12.0, *) {
        if let left = screen.auxiliaryTopLeftArea, let right = screen.auxiliaryTopRightArea {
            notchWidth = frame.width - left.width - right.width
        }
        menuBarInset = screen.safeAreaInsets.top
    }
    screenObjects.append(
        "{\"x\":\(frame.origin.x),\"y\":\(frame.origin.y),\"width\":\(frame.width),\"height\":\(frame.height),\"notchWidth\":\(notchWidth),\"menuBarInset\":\(menuBarInset)}"
    )
}

print("{\"screens\":[\(screenObjects.joined(separator: ","))]}")
