import AppKit

// Writes text to the macOS pasteboard along with a custom marker type so that
// clipboard managers (e.g. Maccy) can identify and optionally ignore OpenWhispr's
// transient clipboard writes during paste operations.
//
// Usage: macos-clipboard-marker "text to write" ["custom.type.name"]

let text = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
let markerType = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "com.openwhispr.transcription"

let pb = NSPasteboard.general
pb.clearContents()
pb.declareTypes([.string, NSPasteboard.PasteboardType(markerType)], owner: nil)
pb.setString(text, forType: .string)
pb.setString("1", forType: NSPasteboard.PasteboardType(markerType))
