/**
 * macOS Meeting Speaker Listener
 *
 * Snapshots the accessibility tree of running meeting apps (Zoom, and Meet or
 * Teams in a browser) so OpenWhispr can tell which participant the app shows
 * as speaking. The helper is app-agnostic on purpose: it reports text-bearing
 * elements and their frames, and src/helpers/meetingAppSpeakerAdapters.js
 * decides what a video tile or an active-speaker marker looks like. Meeting
 * apps restyle their UI without notice; those fixes belong in JS beside their
 * tests, not here.
 *
 * Usage:
 *   macos-meeting-speaker-listener --bundle-id us.zoom.xos
 *     [--bundle-id com.google.Chrome --page-title '^Meet [–-] '] [--interval-ms 500]
 *   macos-meeting-speaker-listener --dump --bundle-id us.zoom.xos
 *
 * --page-title applies to the --bundle-id before it and marks that app as a
 * browser: only its windows whose title (the front tab's title) matches the
 * pattern are read, and only the page inside them, never the tab strip, which
 * lists every other tab's title.
 *
 * stdout, one JSON object per line:
 *   {"type":"start","intervalMs":500}
 *   {"type":"status","state":"waiting_for_app"}
 *   {"type":"status","state":"tracking","bundleIds":["us.zoom.xos"]}
 *   {"type":"status","state":"unreadable","bundleIds":["us.zoom.xos"],"axError":-25204}
 *   {"type":"snapshot","at":<ms>,"windows":[
 *     {"bundleId":"us.zoom.xos","title":"Zoom Meeting","frame":[x,y,w,h],"nodes":[
 *       {"role":"AXGroup","description":"Jane Doe","frame":[x,y,w,h],"depth":7}]}]}
 *   {"type":"error","code":"accessibility_denied","message":"…"}  (then exits 2)
 *
 * A snapshot is written only when the reported tree changed. It carries an
 * element's title, description and help text, the frames of unlabelled groups
 * the size of a video tile, and the value of a static text only when it is at
 * most 80 characters: Meet and caption bars keep participant names there.
 * Longer values (most chat messages) and every other element's value are left
 * out. Uses the Accessibility permission the app already holds for paste; no
 * Screen Recording.
 *
 * --dump prints one full tree, values included, for calibrating the adapters
 * against a real meeting, then exits. It is a developer tool: its output can
 * contain participant names and chat messages.
 *
 * Compile: swiftc -O macos-meeting-speaker-listener.swift -o macos-meeting-speaker-listener
 */

import AppKit
import ApplicationServices
import Foundation

let defaultIntervalMs = 500
let minimumIntervalMs = 200
// Bounds on one snapshot, so a huge tree (a long chat, a 49-tile gallery) can't
// stall the poll or flood the pipe. Breadth-first, so video tiles near the top
// of the window are reached before deep list contents.
let maxVisitedNodes = 1_500
let maxDumpNodes = 5_000
let maxReportedNodes = 400
let maxDepth = 40
let maxTextLength = 200
// A participant name; longer static text is chat or a caption sentence.
let maxReportedValueLength = 80
// Video tiles are at least thumbnail-sized; smaller unlabelled groups are layout.
let minTileWidth = 120
let minTileHeight = 68
// Meeting apps answer accessibility requests on their main thread; a busy
// meeting must delay one poll, not hang the helper.
let messagingTimeoutSeconds: Float = 0.25

// Attribute names as literals: their values are fixed by the AX API, and the
// list is passed to AXUIElementCopyMultipleAttributeValues as one CFArray.
let roleAttribute = "AXRole"
let subroleAttribute = "AXSubrole"
let titleAttribute = "AXTitle"
let descriptionAttribute = "AXDescription"
let helpAttribute = "AXHelp"
let positionAttribute = "AXPosition"
let sizeAttribute = "AXSize"
let childrenAttribute = "AXChildren"
let selectedAttribute = "AXSelected"
let valueAttribute = "AXValue"
let identifierAttribute = "AXIdentifier"

let nodeAttributes: [String] = [
    roleAttribute, subroleAttribute, titleAttribute, descriptionAttribute, helpAttribute,
    positionAttribute, sizeAttribute, childrenAttribute, selectedAttribute,
]
let dumpAttributes: [String] = nodeAttributes + [valueAttribute, identifierAttribute]

struct Target {
    let bundleId: String
    // Set for a browser: the front-tab titles worth reading.
    var pageTitle: NSRegularExpression?
}

var targets: [Target] = []
var intervalMs = defaultIntervalMs
var dumpMode = false

let arguments = CommandLine.arguments
var argumentIndex = 1
while argumentIndex < arguments.count {
    let argument = arguments[argumentIndex]
    let next: String? = argumentIndex + 1 < arguments.count ? arguments[argumentIndex + 1] : nil
    if argument == "--bundle-id", let bundleId = next {
        targets.append(Target(bundleId: bundleId, pageTitle: nil))
        argumentIndex += 1
    } else if argument == "--page-title", let pattern = next, !targets.isEmpty {
        guard let expression = try? NSRegularExpression(pattern: pattern) else {
            print("{\"type\":\"error\",\"code\":\"usage\",\"message\":\"Invalid --page-title pattern\"}")
            exit(64)
        }
        targets[targets.count - 1].pageTitle = expression
        argumentIndex += 1
    } else if argument == "--interval-ms", let value = next.flatMap({ Int($0) }) {
        intervalMs = max(minimumIntervalMs, value)
        argumentIndex += 1
    } else if argument == "--dump" {
        dumpMode = true
    }
    argumentIndex += 1
}

func emit(_ payload: [String: Any], pretty: Bool = false) {
    let options: JSONSerialization.WritingOptions = pretty ? [.prettyPrinted, .sortedKeys] : []
    guard
        JSONSerialization.isValidJSONObject(payload),
        let data = try? JSONSerialization.data(withJSONObject: payload, options: options),
        let json = String(data: data, encoding: .utf8)
    else { return }
    print(json)
    fflush(stdout)
}

func emitError(code: String, message: String) {
    emit(["type": "error", "code": code, "message": message])
}

func nowMs() -> Int {
    Int(Date().timeIntervalSince1970 * 1000)
}

// AX reports failures per attribute as AXValues of the error type.
func axValue(_ raw: AnyObject?) -> AnyObject? {
    guard let raw = raw else { return nil }
    if CFGetTypeID(raw) == AXValueGetTypeID(), AXValueGetType(raw as! AXValue) == .axError {
        return nil
    }
    return raw
}

func text(_ raw: AnyObject?) -> String? {
    guard let value = axValue(raw) as? String else { return nil }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : String(trimmed.prefix(maxTextLength))
}

func coordinate(_ value: CGFloat) -> Int? {
    guard value.isFinite, abs(value) < 1_000_000 else { return nil }
    return Int(value.rounded())
}

func frame(position rawPosition: AnyObject?, size rawSize: AnyObject?) -> [Int]? {
    guard
        let positionValue = axValue(rawPosition), CFGetTypeID(positionValue) == AXValueGetTypeID(),
        let sizeValue = axValue(rawSize), CFGetTypeID(sizeValue) == AXValueGetTypeID()
    else { return nil }

    var point = CGPoint.zero
    var size = CGSize.zero
    guard
        AXValueGetValue(positionValue as! AXValue, .cgPoint, &point),
        AXValueGetValue(sizeValue as! AXValue, .cgSize, &size),
        let x = coordinate(point.x), let y = coordinate(point.y),
        let width = coordinate(size.width), let height = coordinate(size.height)
    else { return nil }
    return [x, y, width, height]
}

// One round trip per element instead of one per attribute.
func attributes(of element: AXUIElement, _ names: [String]) -> [String: AnyObject] {
    var valuesRef: CFArray?
    let result = AXUIElementCopyMultipleAttributeValues(element, names as CFArray, [], &valuesRef)
    guard result == .success, let values = valuesRef as? [AnyObject], values.count == names.count
    else { return [:] }

    var byName: [String: AnyObject] = [:]
    for (index, name) in names.enumerated() {
        if let value = axValue(values[index]) {
            byName[name] = value
        }
    }
    return byName
}

func describeNode(_ values: [String: AnyObject], depth: Int, includeValue: Bool) -> [String: Any] {
    var node: [String: Any] = ["depth": depth]
    if let role = text(values[roleAttribute]) { node["role"] = role }
    if let subrole = text(values[subroleAttribute]) { node["subrole"] = subrole }
    if let title = text(values[titleAttribute]) { node["title"] = title }
    if let description = text(values[descriptionAttribute]) { node["description"] = description }
    if let help = text(values[helpAttribute]) { node["help"] = help }
    if let nodeFrame = frame(position: values[positionAttribute], size: values[sizeAttribute]) {
        node["frame"] = nodeFrame
    }
    if (values[selectedAttribute] as? Bool) == true { node["selected"] = true }
    if includeValue {
        if let value = text(values[valueAttribute]) { node["value"] = value }
        if let identifier = text(values[identifierAttribute]) { node["identifier"] = identifier }
    }
    return node
}

func isTextBearing(_ node: [String: Any]) -> Bool {
    node["title"] != nil || node["description"] != nil || node["help"] != nil
}

// An unlabelled group the size of a video tile: Meet draws tiles this way and
// keeps the participant's name in a static text inside.
func isTileSizedGroup(_ node: [String: Any]) -> Bool {
    guard node["role"] as? String == "AXGroup", let nodeFrame = node["frame"] as? [Int] else { return false }
    return nodeFrame[2] >= minTileWidth && nodeFrame[3] >= minTileHeight
}

// Live snapshots keep a static text's value only when it is short enough to
// be a name; the value is fetched only for static text, never for text areas
// or fields.
func shortStaticTextValue(_ element: AXUIElement, role: String?) -> String? {
    guard role == "AXStaticText", let value = text(elementAttribute(element, valueAttribute).value) else {
        return nil
    }
    return value.count <= maxReportedValueLength ? value : nil
}

// nil for a browser window whose front tab isn't a meeting page.
func describeWindow(_ window: AXUIElement, target: Target, dump: Bool) -> [String: Any]? {
    let windowValues = attributes(of: window, dump ? dumpAttributes : nodeAttributes)
    let title = text(windowValues[titleAttribute])
    if !dump, let pageTitle = target.pageTitle {
        guard let title = title,
              pageTitle.firstMatch(in: title, range: NSRange(title.startIndex..., in: title)) != nil
        else { return nil }
    }

    var described: [String: Any] = ["bundleId": target.bundleId]
    if let title = title { described["title"] = title }
    if let windowFrame = frame(position: windowValues[positionAttribute], size: windowValues[sizeAttribute]) {
        described["frame"] = windowFrame
    }

    // In a browser only the page is reported: the tab strip and toolbar sit
    // outside its AXWebArea and carry every other tab's title.
    let pageOnly = !dump && target.pageTitle != nil
    var queue: [(element: AXUIElement, depth: Int, inPage: Bool)] =
        ((windowValues[childrenAttribute] as? [AXUIElement]) ?? []).map { (element: $0, depth: 1, inPage: !pageOnly) }
    var head = 0
    var nodes: [[String: Any]] = []
    let visitLimit = dump ? maxDumpNodes : maxVisitedNodes

    while head < queue.count && head < visitLimit {
        let (element, depth, parentInPage) = queue[head]
        head += 1

        let values = attributes(of: element, dump ? dumpAttributes : nodeAttributes)
        var node = describeNode(values, depth: depth, includeValue: dump)
        let inPage = parentInPage || node["role"] as? String == "AXWebArea"
        if dump {
            nodes.append(node)
        } else if inPage && nodes.count < maxReportedNodes {
            if let value = shortStaticTextValue(element, role: node["role"] as? String) {
                node["value"] = value
            }
            if isTextBearing(node) || node["value"] != nil || isTileSizedGroup(node) {
                nodes.append(node)
            }
        }

        if depth < maxDepth, let children = values[childrenAttribute] as? [AXUIElement] {
            for child in children {
                queue.append((element: child, depth: depth + 1, inPage: inPage))
            }
        }
    }

    described["nodes"] = nodes
    if head < queue.count { described["truncated"] = true }
    return described
}

func runningTargets() -> [(app: NSRunningApplication, target: Target)] {
    targets.compactMap { target in
        let running = NSRunningApplication.runningApplications(withBundleIdentifier: target.bundleId)
        return running.first(where: { !$0.isTerminated }).map { (app: $0, target: target) }
    }
}

func elementAttribute(_ element: AXUIElement, _ name: String) -> (value: AnyObject?, error: AXError) {
    var valueRef: AnyObject?
    let result = AXUIElementCopyAttributeValue(element, name as CFString, &valueRef)
    return (value: result == .success ? axValue(valueRef) : nil, error: result)
}

func asElement(_ value: AnyObject?) -> AXUIElement? {
    guard let value = value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}

// Zoom 7.2 sometimes answers AXWindows with an empty list while its meeting
// window is open and readable through AXChildren and AXMainWindow, so those
// fill in. error is set only when no window could be read and AXWindows
// itself failed, so a refused read never passes for "no meeting".
func windowElements(of appElement: AXUIElement) -> (windows: [AXUIElement], error: AXError?) {
    let listed = elementAttribute(appElement, "AXWindows")
    var windows = (listed.value as? [AXUIElement]) ?? []
    if windows.isEmpty {
        var candidates = ((elementAttribute(appElement, childrenAttribute).value as? [AXUIElement]) ?? [])
            .filter { text(elementAttribute($0, roleAttribute).value) == "AXWindow" }
        for name in ["AXMainWindow", "AXFocusedWindow"] {
            if let window = asElement(elementAttribute(appElement, name).value) {
                candidates.append(window)
            }
        }
        for candidate in candidates where !windows.contains(where: { CFEqual($0, candidate) }) {
            windows.append(candidate)
        }
    }
    return (windows: windows, error: windows.isEmpty && listed.error != .success ? listed.error : nil)
}

func describeApp(_ app: NSRunningApplication, target: Target, dump: Bool) -> (windows: [[String: Any]], error: AXError?) {
    let found = windowElements(of: AXUIElementCreateApplication(app.processIdentifier))
    return (windows: found.windows.compactMap { describeWindow($0, target: target, dump: dump) }, error: found.error)
}

if targets.isEmpty {
    emitError(code: "usage", message: "Usage: macos-meeting-speaker-listener [--dump] --bundle-id <id> [--page-title <pattern>] [--interval-ms <ms>]")
    exit(64)
}

// The app's own Accessibility grant covers this helper, as it does the text
// monitor; without it every read fails, so stop rather than poll for nothing.
if !AXIsProcessTrusted() {
    emitError(code: "accessibility_denied", message: "Accessibility permission is required to read the meeting app")
    exit(2)
}

_ = AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), messagingTimeoutSeconds)

if dumpMode {
    guard let running = runningTargets().first else {
        emitError(code: "app_not_running", message: "None of the requested apps is running")
        exit(1)
    }
    let described = describeApp(running.app, target: running.target, dump: true)
    if let error = described.error {
        emitError(code: "windows_unreadable", message: "Could not read the app's windows (AXError \(error.rawValue))")
        exit(1)
    }
    emit(
        ["type": "dump", "at": nowMs(), "bundleId": running.target.bundleId, "windows": described.windows],
        pretty: true
    )
    exit(0)
}

var signalSources: [DispatchSourceSignal] = []
for signalNumber in [SIGTERM, SIGINT] {
    signal(signalNumber, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
    source.setEventHandler { exit(0) }
    source.resume()
    signalSources.append(source)
}

var lastStatus = ""
var lastWindowsJSON: Data?

func reportStatus(_ state: String, bundleIds: [String] = [], axError: AXError? = nil) {
    let key = state + ":" + bundleIds.joined(separator: ",") + ":" + (axError.map { String($0.rawValue) } ?? "")
    guard key != lastStatus else { return }
    lastStatus = key
    var payload: [String: Any] = ["type": "status", "state": state]
    if !bundleIds.isEmpty { payload["bundleIds"] = bundleIds }
    if let axError = axError { payload["axError"] = Int(axError.rawValue) }
    emit(payload)
}

func poll() {
    // Orphaned by a crashed app (reparented to launchd): nothing reads stdout
    // any more, and the helper writes too rarely for SIGPIPE to end it.
    if getppid() == 1 { exit(0) }

    let running = runningTargets()
    if running.isEmpty {
        lastWindowsJSON = nil
        reportStatus("waiting_for_app")
        return
    }

    // Every running app is read each poll: a browser is always open, and a
    // Meet call must not hide a Zoom call or the other way round.
    var windows: [[String: Any]] = []
    var errors: [AXError] = []
    for entry in running {
        let described = describeApp(entry.app, target: entry.target, dump: false)
        windows += described.windows
        if let error = described.error { errors.append(error) }
    }
    let bundleIds = running.map { $0.target.bundleId }
    if errors.count == running.count, let error = errors.first {
        lastWindowsJSON = nil
        reportStatus("unreadable", bundleIds: bundleIds, axError: error)
        return
    }
    reportStatus("tracking", bundleIds: bundleIds)

    guard
        JSONSerialization.isValidJSONObject(windows),
        let windowsJSON = try? JSONSerialization.data(withJSONObject: windows, options: [.sortedKeys])
    else { return }
    if windowsJSON == lastWindowsJSON { return }
    lastWindowsJSON = windowsJSON

    emit(["type": "snapshot", "at": nowMs(), "windows": windows])
}

emit(["type": "start", "intervalMs": intervalMs])

let pollTimer = DispatchSource.makeTimerSource(queue: .main)
pollTimer.schedule(deadline: .now(), repeating: .milliseconds(intervalMs))
pollTimer.setEventHandler { poll() }
pollTimer.resume()

CFRunLoopRun()
