/**
 * macOS Calendar Listener
 *
 * Long-running process that reads the local EventKit store and emits
 * line-delimited JSON on stdout: a permission message on launch, then a
 * calendars+events snapshot whenever the store changes, "sync" arrives on
 * stdin, or a 5-minute timer rolls the 7-day window forward.
 *
 * Pass --request to prompt for calendar access when it is not determined —
 * the TCC prompt is attributed to the parent app's usage string.
 *
 * Compile: swiftc -O macos-calendar-listener.swift -o macos-calendar-listener -framework EventKit -framework Foundation
 */

import CoreGraphics
import EventKit
import Foundation

// MARK: - State

let eventStore = EKEventStore()
let requestAccess = CommandLine.arguments.contains("--request")
let LOOKAHEAD_DAYS = 7.0
let REFRESH_INTERVAL_SECONDS = 300.0

let isoFormatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.timeZone = TimeZone(identifier: "UTC")
    return formatter
}()

let jsonEncoder = JSONEncoder()

// MARK: - Output

func emit(_ message: String) {
    print(message)
    fflush(stdout)
}

func emitError(_ message: String) {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
}

func emitJSON<T: Encodable>(_ value: T) {
    guard let data = try? jsonEncoder.encode(value),
          let json = String(data: data, encoding: .utf8)
    else {
        emitError("Failed to encode JSON message")
        return
    }
    emit(json)
}

// MARK: - Messages

struct PermissionMessage: Encodable {
    let type = "permission"
    let status: String
}

struct CalendarOut: Encodable {
    let id: String
    let title: String
    let color: String?
    let source_name: String?
}

struct AttendeeOut: Encodable {
    let email: String?
    let name: String?
    let status: String
    let isSelf: Bool

    enum CodingKeys: String, CodingKey {
        case email, name, status
        case isSelf = "self"
    }
}

struct EventOut: Encodable {
    let id: String
    let calendar_id: String
    let title: String?
    let start: String
    let end: String
    let is_all_day: Bool
    let status: String
    let organizer_email: String?
    let url: String?
    let location: String?
    let notes_urls: [String]
    let attendees: [AttendeeOut]
}

struct SnapshotMessage: Encodable {
    let type = "snapshot"
    let calendars: [CalendarOut]
    let events: [EventOut]
}

// MARK: - Permission

func permissionStatus() -> String {
    let status = EKEventStore.authorizationStatus(for: .event)
    if #available(macOS 14.0, *) {
        switch status {
        case .fullAccess: return "granted"
        case .writeOnly, .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "notDetermined"
        default: return "denied"
        }
    }
    switch status {
    case .authorized: return "granted"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "notDetermined"
    default: return "denied"
    }
}

func emitPermission() -> String {
    let status = permissionStatus()
    emitJSON(PermissionMessage(status: status))
    return status
}

// MARK: - Mapping

func hexColor(_ cgColor: CGColor?) -> String? {
    guard let cgColor,
          let sRGB = CGColorSpace(name: CGColorSpace.sRGB),
          let converted = cgColor.converted(to: sRGB, intent: .defaultIntent, options: nil),
          let components = converted.components, components.count >= 3
    else { return nil }
    return String(
        format: "#%02X%02X%02X",
        Int(round(components[0] * 255)),
        Int(round(components[1] * 255)),
        Int(round(components[2] * 255))
    )
}

func mailtoEmail(_ url: URL?) -> String? {
    guard let url, url.scheme?.lowercased() == "mailto" else { return nil }
    let email = url.absoluteString.dropFirst("mailto:".count)
    return email.isEmpty ? nil : String(email)
}

func participantStatus(_ status: EKParticipantStatus) -> String {
    switch status {
    case .accepted: return "accepted"
    case .declined: return "declined"
    case .tentative: return "tentative"
    default: return "needsAction"
    }
}

func eventStatus(_ status: EKEventStatus) -> String {
    switch status {
    case .tentative: return "tentative"
    case .canceled: return "cancelled"
    default: return "confirmed"
    }
}

let linkDetector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)

func extractURLs(from text: String?) -> [String] {
    guard let text, !text.isEmpty, let linkDetector else { return [] }
    let range = NSRange(text.startIndex..., in: text)
    return linkDetector.matches(in: text, options: [], range: range).compactMap { match in
        guard let url = match.url, url.scheme == "https" || url.scheme == "http" else { return nil }
        return url.absoluteString
    }
}

func mapEvent(_ event: EKEvent) -> EventOut? {
    guard let eventIdentifier = event.eventIdentifier,
          let calendarId = event.calendar?.calendarIdentifier,
          let startDate = event.startDate,
          let endDate = event.endDate
    else { return nil }

    let attendees = (event.attendees ?? []).map { participant in
        AttendeeOut(
            email: mailtoEmail(participant.url),
            name: participant.name,
            status: participantStatus(participant.participantStatus),
            isSelf: participant.isCurrentUser
        )
    }

    return EventOut(
        id: "\(eventIdentifier):\(Int(startDate.timeIntervalSince1970))",
        calendar_id: calendarId,
        title: event.title,
        start: isoFormatter.string(from: startDate),
        end: isoFormatter.string(from: endDate),
        is_all_day: event.isAllDay,
        status: eventStatus(event.status),
        organizer_email: mailtoEmail(event.organizer?.url),
        url: event.url?.absoluteString,
        location: event.location,
        notes_urls: extractURLs(from: event.notes),
        attendees: attendees
    )
}

// MARK: - Snapshot

func emitSnapshot() {
    let calendars = eventStore.calendars(for: .event)

    let calendarsOut = calendars.map { calendar in
        CalendarOut(
            id: calendar.calendarIdentifier,
            title: calendar.title,
            color: hexColor(calendar.cgColor),
            source_name: calendar.source?.title
        )
    }

    let start = Date()
    let end = start.addingTimeInterval(LOOKAHEAD_DAYS * 24 * 60 * 60)
    let predicate = eventStore.predicateForEvents(withStart: start, end: end, calendars: calendars)
    let eventsOut = eventStore.events(matching: predicate).compactMap(mapEvent)

    emitJSON(SnapshotMessage(calendars: calendarsOut, events: eventsOut))
}

// MARK: - Change Observation

var pendingSnapshot: DispatchWorkItem?
var timers: [DispatchSourceTimer] = []
var storeObservers: [NSObjectProtocol] = []

func scheduleSnapshot(debounce: TimeInterval = 1.0) {
    pendingSnapshot?.cancel()
    let work = DispatchWorkItem { emitSnapshot() }
    pendingSnapshot = work
    DispatchQueue.main.asyncAfter(deadline: .now() + debounce, execute: work)
}

func startStreaming() {
    emitSnapshot()

    // The observer token must stay retained or the observation ends immediately
    storeObservers.append(
        NotificationCenter.default.addObserver(
            forName: .EKEventStoreChanged,
            object: eventStore,
            queue: .main
        ) { _ in
            scheduleSnapshot()
        }
    )

    // Roll the 7-day window forward even without store changes
    let refreshTimer = DispatchSource.makeTimerSource(queue: .main)
    refreshTimer.schedule(
        deadline: .now() + REFRESH_INTERVAL_SECONDS,
        repeating: REFRESH_INTERVAL_SECONDS
    )
    refreshTimer.setEventHandler { emitSnapshot() }
    refreshTimer.resume()
    timers.append(refreshTimer)

    // "sync" on stdin forces an immediate snapshot; EOF means the parent died
    FileHandle.standardInput.readabilityHandler = { handle in
        let data = handle.availableData
        if data.isEmpty {
            DispatchQueue.main.async { exit(0) }
            return
        }
        guard let input = String(data: data, encoding: .utf8) else { return }
        if input.split(separator: "\n").contains(where: { $0.trimmingCharacters(in: .whitespaces) == "sync" }) {
            DispatchQueue.main.async { scheduleSnapshot(debounce: 0) }
        }
    }
}

// MARK: - Signal Handling

var signalSources: [DispatchSourceSignal] = []

func setupSignalHandlers() {
    for sig in [SIGTERM, SIGINT] {
        signal(sig, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
        source.setEventHandler { exit(0) }
        source.resume()
        signalSources.append(source)
    }
}

// MARK: - Main

setupSignalHandlers()

let initialStatus = emitPermission()

switch initialStatus {
case "granted":
    startStreaming()
case "notDetermined" where requestAccess:
    let completion: (Bool, Error?) -> Void = { _, error in
        if let error {
            emitError("Calendar access request failed: \(error.localizedDescription)")
        }
        DispatchQueue.main.async {
            if emitPermission() == "granted" {
                startStreaming()
            } else {
                exit(0)
            }
        }
    }
    if #available(macOS 14.0, *) {
        eventStore.requestFullAccessToEvents(completion: completion)
    } else {
        eventStore.requestAccess(to: .event, completion: completion)
    }
default:
    // denied / restricted / notDetermined without --request: nothing to stream
    exit(0)
}

CFRunLoopRun()
