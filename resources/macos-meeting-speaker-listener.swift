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
 *     [--bundle-id com.google.Chrome --page-title '^Meet [–-] ' --page-marker '^Meet [–-] '
 *       --page-title '\| Microsoft Teams\b' --page-marker 'Context menu is available$']
 *     [--interval-ms 500]
 *   macos-meeting-speaker-listener --dump --bundle-id com.google.Chrome
 *
 * Each --page-title / --page-marker pair describes one kind of meeting page and
 * applies to the --bundle-id before it, which it marks as a browser. Only its
 * windows whose title (the front tab's title) matches a page title are read,
 * and inside them only a page (AXWebArea) whose own title matches one: never
 * the tab strip, which lists every other tab's title, nor a split-view tab,
 * side panel or DevTools beside the meeting. A page is reported only while one
 * of its elements, the page itself included, is titled or described like the
 * marker paired with its title (a call's video tile, say), so a Teams chat or
 * calendar page is never sent. Each page kept is reported as its own window,
 * tagged with the index of the page kind it matched ("page"). A page that
 * shows no marker within half a second of reading is given up on, so a large
 * non-meeting tab can't hold up the poll, unless the same window held a call at
 * the last complete read: then the read is late, not empty.
 *
 * stdout, one JSON object per line:
 *   {"type":"start","intervalMs":500}
 *   {"type":"status","state":"waiting_for_app"}
 *   {"type":"status","state":"tracking","bundleIds":["us.zoom.xos","com.google.Chrome"],
 *     "unreadable":[{"bundleId":"us.zoom.xos","axError":-25211}],"busy":["com.google.Chrome"]}
 *   {"type":"status","state":"unreadable","bundleIds":["us.zoom.xos"],
 *     "unreadable":[{"bundleId":"us.zoom.xos","axError":-25211}]}
 *   {"type":"snapshot","at":<ms>,"windows":[
 *     {"bundleId":"us.zoom.xos","title":"Zoom Meeting","frame":[x,y,w,h],"truncated":true,"page":0,"nodes":[
 *       {"role":"AXGroup","description":"Jane Doe","frame":[x,y,w,h],"depth":7}]}]}
 *   {"type":"error","code":"accessibility_denied","message":"…"}  (then exits 2)
 *
 * A snapshot is written only when the reported tree changed. An app that
 * doesn't answer in time (a read that fails after waiting at least 0.2 s of
 * the 0.25 s messaging timeout, or a read of the app past its 2 s deadline)
 * keeps its last complete windows rather than a half-read tree, which would
 * look like another layout; once its last complete read is 3 s old its
 * windows are dropped and it's listed as "busy", so a stale speaker doesn't
 * stay lit. A native app's snapshot carries each
 * element's title, description and help text, never a value. A browser page's
 * also carries the frames of unlabelled groups the size of a video tile (not
 * empty layout groups, nor one repeating its parent's frame), and the value of
 * a static text of at most 80 characters outside text fields (Meet and caption
 * bars keep participant names there); its titles, descriptions and help texts
 * over 120 characters are left out. A window (each browser page on its own)
 * cut off at 400 reported or 1,500 visited elements carries "truncated". Uses the Accessibility permission the
 * app already holds for paste; no Screen Recording.
 *
 * --dump prints one full tree of the first running target, values included,
 * without deadlines, for calibrating the adapters against a real meeting, then
 * exits. It is a developer tool: its output can contain participant names and
 * chat messages.
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
// Inside a browser page: a longer label is page content, not a tile or control.
let maxPageTextLength = 120
// A participant name; longer static text is chat or a caption sentence.
let maxReportedValueLength = 80
// Same thumbnail size as MIN_TILE_WIDTH/HEIGHT in meetingAppSpeakerAdapters.js.
let minTileWidth = 120
let minTileHeight = 68
// Meeting apps answer accessibility requests on their main thread; a busy
// meeting must delay one poll, not hang the helper.
let messagingTimeoutSeconds: Float = 0.25
// AX reports a timeout as .cannotComplete, which also means "this element
// can't answer": only a call that actually waited this long was a timeout.
let timedOutReadSeconds = 0.2
// One app's read that runs longer is dropped rather than reported half-read.
// Generous, since a large meeting takes many hundreds of reads; an app that
// stops answering is caught by its first timed-out read, not by this.
let appDeadlineSeconds = 2.0
// A browser page with no marker yet after this long isn't a call worth the wait.
let pageScanSeconds = 0.5
// How old an app's last complete read may be before its windows are dropped.
let staleWindowsSeconds = 3.0
// Text inside these is what the user is typing.
let editableRoles: Set<String> = ["AXTextArea", "AXTextField", "AXComboBox", "AXSearchField"]

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
// Browser chrome outside the meeting page is only walked, never reported; a
// page past the report cap is only searched for its marker.
let scanAttributes: [String] = [roleAttribute, titleAttribute, childrenAttribute]
let markerAttributes: [String] = [roleAttribute, titleAttribute, descriptionAttribute, childrenAttribute]

// One kind of meeting page in a browser: its tab title, and a label only that
// page carries while it shows a call.
struct Page {
    let title: NSRegularExpression
    var marker: NSRegularExpression?
}

struct Target {
    let bundleId: String
    var pages: [Page] = []
    var browser: Bool { !pages.isEmpty }

    func page(titled title: String?) -> Int? {
        pages.firstIndex { matches($0.title, title) }
    }
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

let usage = "Usage: macos-meeting-speaker-listener [--dump] --bundle-id <id> [--page-title <pattern> --page-marker <pattern> ...] [--interval-ms <ms>]"

var targets: [Target] = []
var intervalMs = defaultIntervalMs
var dumpMode = false

func pattern(_ value: String?) -> NSRegularExpression {
    guard let value = value, let expression = try? NSRegularExpression(pattern: value) else {
        emitError(code: "usage", message: usage)
        exit(64)
    }
    return expression
}

let arguments = CommandLine.arguments
var argumentIndex = 1
while argumentIndex < arguments.count {
    let argument = arguments[argumentIndex]
    let next: String? = argumentIndex + 1 < arguments.count ? arguments[argumentIndex + 1] : nil
    if argument == "--bundle-id", let bundleId = next {
        targets.append(Target(bundleId: bundleId))
        argumentIndex += 1
    } else if argument == "--page-title" || argument == "--page-marker" {
        // A page belongs to the app named before it, and its marker to the
        // title named before it.
        guard !targets.isEmpty, argument == "--page-title" || targets[targets.count - 1].pages.last?.marker == nil,
              argument == "--page-title" || !targets[targets.count - 1].pages.isEmpty
        else {
            emitError(code: "usage", message: usage)
            exit(64)
        }
        if argument == "--page-title" {
            targets[targets.count - 1].pages.append(Page(title: pattern(next), marker: nil))
        } else {
            targets[targets.count - 1].pages[targets[targets.count - 1].pages.count - 1].marker = pattern(next)
        }
        argumentIndex += 1
    } else if argument == "--interval-ms", let value = next.flatMap({ Int($0) }) {
        intervalMs = max(minimumIntervalMs, value)
        argumentIndex += 1
    } else if argument == "--dump" {
        dumpMode = true
    } else {
        // An unknown flag, or one missing its value.
        emitError(code: "usage", message: usage)
        exit(64)
    }
    argumentIndex += 1
}

// Every page needs its marker: a title alone would read any page that tab shows.
if targets.contains(where: { $0.pages.contains { $0.marker == nil } }) {
    emitError(code: "usage", message: usage)
    exit(64)
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

func text(_ raw: AnyObject?, limit: Int = maxTextLength) -> String? {
    guard let value = axValue(raw) as? String else { return nil }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : String(trimmed.prefix(limit))
}

func matches(_ expression: NSRegularExpression, _ string: String?) -> Bool {
    guard let string = string else { return false }
    return expression.firstMatch(in: string, range: NSRange(string.startIndex..., in: string)) != nil
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

func waitedOut(_ result: AXError, since start: Date) -> Bool {
    result == .cannotComplete && Date().timeIntervalSince(start) >= timedOutReadSeconds
}

func elementAttribute(_ element: AXUIElement, _ name: String) -> (value: AnyObject?, error: AXError, timedOut: Bool) {
    var valueRef: AnyObject?
    let start = Date()
    let result = AXUIElementCopyAttributeValue(element, name as CFString, &valueRef)
    return (value: result == .success ? axValue(valueRef) : nil, error: result, timedOut: waitedOut(result, since: start))
}

// One round trip per element instead of one per attribute. An element that
// can't answer is skipped; one the app didn't answer in time ends the read.
func attributes(of element: AXUIElement, _ names: [String]) -> (values: [String: AnyObject], timedOut: Bool) {
    var valuesRef: CFArray?
    let start = Date()
    let result = AXUIElementCopyMultipleAttributeValues(element, names as CFArray, [], &valuesRef)
    guard result == .success, let values = valuesRef as? [AnyObject], values.count == names.count
    else { return (values: [:], timedOut: waitedOut(result, since: start)) }

    var byName: [String: AnyObject] = [:]
    for (index, name) in names.enumerated() {
        if let value = axValue(values[index]) {
            byName[name] = value
        }
    }
    return (values: byName, timedOut: false)
}

func describeNode(_ values: [String: AnyObject], depth: Int, dump: Bool, textLimit: Int) -> [String: Any] {
    var node: [String: Any] = ["depth": depth]
    if let role = text(values[roleAttribute]) { node["role"] = role }
    if let subrole = text(values[subroleAttribute]) { node["subrole"] = subrole }
    for (key, attribute) in [("title", titleAttribute), ("description", descriptionAttribute), ("help", helpAttribute)] {
        // Over the limit is left out whole: a cut-off label still carries content.
        if let value = text(values[attribute], limit: textLimit + 1), value.count <= textLimit {
            node[key] = value
        }
    }
    if let nodeFrame = frame(position: values[positionAttribute], size: values[sizeAttribute]) {
        node["frame"] = nodeFrame
    }
    if (values[selectedAttribute] as? Bool) == true { node["selected"] = true }
    if dump {
        if let value = text(values[valueAttribute]) { node["value"] = value }
        if let identifier = text(values[identifierAttribute]) { node["identifier"] = identifier }
    }
    return node
}

func isTextBearing(_ node: [String: Any]) -> Bool {
    node["title"] != nil || node["description"] != nil || node["help"] != nil
}

// An unlabelled group the size of a video tile: Meet draws tiles this way and
// keeps the participant's name in a static text inside. Its empty layout
// groups, and groups that only repeat their parent's frame, add nothing.
func isTileSizedGroup(_ node: [String: Any], parentFrame: [Int]?) -> Bool {
    guard node["role"] as? String == "AXGroup", node["subrole"] as? String != "AXEmptyGroup",
          let nodeFrame = node["frame"] as? [Int], nodeFrame != parentFrame
    else { return false }
    return nodeFrame[2] >= minTileWidth && nodeFrame[3] >= minTileHeight
}

enum WindowRead {
    // One entry per window; a browser window gives one per meeting page kept.
    case described([[String: Any]])
    case skipped
    case timedOut
}

struct QueuedElement {
    let element: AXUIElement
    let depth: Int
    // The meeting page this element belongs to, nil outside one.
    let page: Int?
    let inEditable: Bool
    let parentFrame: [Int]?
}

// knownTitles: windows that held a call at the app's last complete read. One
// of them that is slow to show its marker is late, not empty.
func describeWindow(
    _ window: AXUIElement,
    target: Target,
    dump: Bool,
    deadline: Date,
    knownTitles: Set<String> = []
) -> WindowRead {
    let browser = !dump && target.browser
    let windowRead = attributes(of: window, dump ? dumpAttributes : nodeAttributes)
    if windowRead.timedOut && !dump { return .timedOut }
    let windowValues = windowRead.values
    // Matched whole: a long meeting subject must not push "| Microsoft Teams"
    // past the reporting limit.
    if browser && target.page(titled: text(windowValues[titleAttribute], limit: Int.max)) == nil {
        return .skipped
    }

    var base: [String: Any] = ["bundleId": target.bundleId]
    let title = text(windowValues[titleAttribute])
    if let title = title { base["title"] = title }
    let windowFrame = frame(position: windowValues[positionAttribute], size: windowValues[sizeAttribute])
    if let windowFrame = windowFrame { base["frame"] = windowFrame }

    // Outside a browser the whole window is one "page".
    let rootPage: Int? = browser ? nil : 0
    var queue: [QueuedElement] = ((windowValues[childrenAttribute] as? [AXUIElement]) ?? []).map {
        QueuedElement(element: $0, depth: 1, page: rootPage, inEditable: false, parentFrame: windowFrame)
    }
    var head = 0
    var nodesByPage: [Int: [[String: Any]]] = [:]
    var truncatedPages = Set<Int>()
    var pagesWithMarker = Set<Int>()
    var visitsTruncated = false
    let visitLimit = dump ? maxDumpNodes : maxVisitedNodes
    let scanUntil = Date().addingTimeInterval(pageScanSeconds)

    while head < queue.count {
        if head >= visitLimit {
            visitsTruncated = true
            break
        }
        if !dump {
            if Date() > deadline { return .timedOut }
            // A page with no call to show by now isn't worth the poll, unless
            // this window held one last time.
            if browser && pagesWithMarker.isEmpty && Date() > scanUntil {
                return title.map { knownTitles.contains($0) } == true ? .timedOut : .skipped
            }
        }
        let queued = queue[head]
        head += 1

        // The cap counts each page on its own, so a chat page's elements beside
        // a call can't use up the call's.
        let reportFull = !dump && queued.page.map { (nodesByPage[$0]?.count ?? 0) >= maxReportedNodes } == true
        if reportFull, let page = queued.page {
            truncatedPages.insert(page)
            // Past the cap a browser page is only searched for its marker.
            if !browser || pagesWithMarker.contains(page) { continue }
        }

        let names = dump ? dumpAttributes
            : reportFull ? markerAttributes
            : queued.page != nil ? nodeAttributes
            : scanAttributes
        let read = attributes(of: queued.element, names)
        if read.timedOut && !dump { return .timedOut }
        let values = read.values
        let role = text(values[roleAttribute])

        // The meeting page itself, not another page sharing the window.
        let page = queued.page
            ?? (browser && role == "AXWebArea" ? target.page(titled: text(values[titleAttribute], limit: Int.max)) : nil)
        let inEditable = queued.inEditable || editableRoles.contains(role ?? "")
        var nodeFrame: [Int]? = queued.parentFrame

        if dump {
            nodesByPage[0, default: []].append(describeNode(values, depth: queued.depth, dump: true, textLimit: maxTextLength))
        } else if let page = page {
            // Matched on the whole label: it's never reported, and a long tile
            // label must still end in the marker.
            if browser, !pagesWithMarker.contains(page), let marker = target.pages[page].marker,
               matches(marker, text(values[titleAttribute], limit: Int.max))
                || matches(marker, text(values[descriptionAttribute], limit: Int.max)) {
                pagesWithMarker.insert(page)
            }
            if !reportFull {
                var node = describeNode(
                    values,
                    depth: queued.depth,
                    dump: false,
                    textLimit: browser ? maxPageTextLength : maxTextLength
                )
                nodeFrame = node["frame"] as? [Int] ?? queued.parentFrame
                if browser && role == "AXStaticText" && !inEditable {
                    let value = elementAttribute(queued.element, valueAttribute)
                    if value.timedOut { return .timedOut }
                    if let short = text(value.value, limit: maxReportedValueLength + 1),
                       short.count <= maxReportedValueLength {
                        node["value"] = short
                    }
                }
                if isTextBearing(node) || node["value"] != nil
                    || (browser && isTileSizedGroup(node, parentFrame: queued.parentFrame)) {
                    nodesByPage[page, default: []].append(node)
                }
            }
        }

        if queued.depth < maxDepth, let children = values[childrenAttribute] as? [AXUIElement] {
            for child in children {
                queue.append(QueuedElement(
                    element: child,
                    depth: queued.depth + 1,
                    page: page,
                    inEditable: inEditable,
                    parentFrame: nodeFrame
                ))
            }
        }
    }

    // Only pages showing a call, each as its own window: a Teams chat beside a
    // Meet call stays out, and each page goes to its own adapter.
    let keptPages = browser ? pagesWithMarker.sorted() : [0]
    if keptPages.isEmpty { return .skipped }
    return .described(keptPages.map { page in
        var described = base
        described["nodes"] = nodesByPage[page] ?? []
        if browser { described["page"] = page }
        if visitsTruncated || truncatedPages.contains(page) { described["truncated"] = true }
        return described
    })
}

func runningTargets() -> [(app: NSRunningApplication, target: Target)] {
    targets.compactMap { target in
        let running = NSRunningApplication.runningApplications(withBundleIdentifier: target.bundleId)
        return running.first(where: { !$0.isTerminated }).map { (app: $0, target: target) }
    }
}

func asElement(_ value: AnyObject?) -> AXUIElement? {
    guard let value = value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}

// Zoom 7.2 sometimes answers AXWindows with an empty list while its meeting
// window is open and readable through AXChildren and AXMainWindow, so those
// fill in. error is set only when no window could be read and AXWindows
// itself failed, so a refused read never passes for "no meeting". Any read
// here that waits out the timeout makes the whole list late, not empty.
func windowElements(of appElement: AXUIElement, dump: Bool) -> (windows: [AXUIElement], error: AXError?, timedOut: Bool) {
    let late = (windows: [AXUIElement](), error: AXError?.none, timedOut: true)
    let listed = elementAttribute(appElement, "AXWindows")
    if listed.timedOut && !dump { return late }
    var windows = (listed.value as? [AXUIElement]) ?? []
    if windows.isEmpty {
        let children = elementAttribute(appElement, childrenAttribute)
        if children.timedOut && !dump { return late }
        var candidates: [AXUIElement] = []
        for child in (children.value as? [AXUIElement]) ?? [] {
            let role = elementAttribute(child, roleAttribute)
            if role.timedOut && !dump { return late }
            if text(role.value) == "AXWindow" { candidates.append(child) }
        }
        for name in ["AXMainWindow", "AXFocusedWindow"] {
            let window = elementAttribute(appElement, name)
            if window.timedOut && !dump { return late }
            if let element = asElement(window.value) { candidates.append(element) }
        }
        for candidate in candidates where !windows.contains(where: { CFEqual($0, candidate) }) {
            windows.append(candidate)
        }
    }
    let error = windows.isEmpty && listed.error != .success ? listed.error : nil
    return (windows: windows, error: error, timedOut: false)
}

struct AppRead {
    var windows: [[String: Any]] = []
    var error: AXError?
    var timedOut = false
}

func describeApp(_ app: NSRunningApplication, target: Target, dump: Bool, knownTitles: Set<String> = []) -> AppRead {
    let deadline = dump ? Date.distantFuture : Date().addingTimeInterval(appDeadlineSeconds)
    let found = windowElements(of: AXUIElementCreateApplication(app.processIdentifier), dump: dump)
    if found.timedOut { return AppRead(windows: [], error: nil, timedOut: true) }
    var read = AppRead(windows: [], error: found.error, timedOut: false)
    for window in found.windows {
        switch describeWindow(window, target: target, dump: dump, deadline: deadline, knownTitles: knownTitles) {
        case .described(let described): read.windows += described
        case .skipped: continue
        case .timedOut:
            read.timedOut = true
            return read
        }
    }
    return read
}

if targets.isEmpty {
    emitError(code: "usage", message: usage)
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

// A plain handler, not a dispatch source: the main queue may be inside a slow
// poll, and stopping must not wait for it.
for signalNumber in [SIGTERM, SIGINT] {
    signal(signalNumber) { _ in _exit(0) }
}

var lastStatus = ""
var lastWindowsJSON: Data?
// Per running app process: its last complete windows and when they were read.
struct CompleteRead {
    let pid: pid_t
    let at: Date
    var windows: [[String: Any]]
}
var lastCompleteReads: [String: CompleteRead] = [:]

func reportStatus(
    _ state: String,
    bundleIds: [String] = [],
    unreadable: [(bundleId: String, error: AXError)] = [],
    busy: [String] = []
) {
    let unreadableKey = unreadable.map { "\($0.bundleId)=\($0.error.rawValue)" }.joined(separator: ",")
    let key = [state, bundleIds.joined(separator: ","), unreadableKey, busy.joined(separator: ",")]
        .joined(separator: ":")
    guard key != lastStatus else { return }
    lastStatus = key
    var payload: [String: Any] = ["type": "status", "state": state]
    if !bundleIds.isEmpty { payload["bundleIds"] = bundleIds }
    if !unreadable.isEmpty {
        payload["unreadable"] = unreadable.map { ["bundleId": $0.bundleId, "axError": Int($0.error.rawValue)] }
    }
    if !busy.isEmpty { payload["busy"] = busy }
    emit(payload)
}

func poll() {
    // Orphaned by a crashed app (reparented to launchd): nothing reads stdout
    // any more, and the helper writes too rarely for SIGPIPE to end it.
    if getppid() == 1 { exit(0) }

    let running = runningTargets()
    // An app that quit (or restarted) takes its old windows with it.
    lastCompleteReads = lastCompleteReads.filter { bundleId, read in
        running.contains { $0.target.bundleId == bundleId && $0.app.processIdentifier == read.pid }
    }
    if running.isEmpty {
        lastWindowsJSON = nil
        reportStatus("waiting_for_app")
        return
    }

    // Every running app is read each poll: a browser is always open, and a
    // Meet call must not hide a Zoom call or the other way round.
    var windows: [[String: Any]] = []
    var unreadable: [(bundleId: String, error: AXError)] = []
    var busy: [String] = []
    for entry in running {
        let bundleId = entry.target.bundleId
        let knownTitles = Set((lastCompleteReads[bundleId]?.windows ?? []).compactMap { $0["title"] as? String })
        let read = describeApp(entry.app, target: entry.target, dump: false, knownTitles: knownTitles)
        if read.timedOut {
            // Late, not gone: its last complete windows stand in for a while.
            if let last = lastCompleteReads[bundleId], Date().timeIntervalSince(last.at) < staleWindowsSeconds {
                windows += last.windows
            } else {
                busy.append(bundleId)
            }
            continue
        }
        lastCompleteReads[bundleId] = CompleteRead(pid: entry.app.processIdentifier, at: Date(), windows: read.windows)
        windows += read.windows
        if let error = read.error { unreadable.append((bundleId: bundleId, error: error)) }
    }
    let bundleIds = running.map { $0.target.bundleId }
    if unreadable.count == running.count {
        lastWindowsJSON = nil
        reportStatus("unreadable", bundleIds: bundleIds, unreadable: unreadable)
        return
    }
    reportStatus("tracking", bundleIds: bundleIds, unreadable: unreadable, busy: busy)

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
