import Foundation

/// Where a tap on the dictation pill goes. A meeting the app is recording wins over every way of
/// starting audio, since each one would take the microphone from it.
enum KeyboardMicTapRoute: Equatable {
  /// Starts nothing and says why.
  case meetingRecording
  /// Asks the app's warm mic to start (the Darwin start notification).
  case inPlace
  /// The keyboard records and transcribes the take itself.
  case direct
  /// The pill's link opens OpenWhispr, which records.
  case handoff
}

/// The app's capture lease as the keyboard sees it. While a meeting records, the app writes an
/// epoch-ms heartbeat (a decimal string) to the App Group every 5 seconds and removes it when the
/// meeting ends. A crash can't remove it, so an old heartbeat counts as free; so does one from the
/// future, since a clock moved back would otherwise hold the keyboard's mic off until it caught up.
///
/// `isHeld` is a copy of `CaptureLeaseHeartbeat.isHeld` in
/// modules/app-group-storage/ios/CaptureLeasePolicy.swift: the keyboard target is built only from
/// this folder. tests/direct/LeaseTests.swift pins both to the same vectors, so change them together.
enum MeetingCaptureLease {
  static let heartbeatKey = "capture_lease_heartbeat_ms"
  static let staleAfterMs: Int64 = 15_000
  static let unavailableHint = "Unavailable while a meeting is recording"

  static func isHeld(heartbeatMs: Int64?, nowMs: Int64) -> Bool {
    // Total over every stored value: a non-positive heartbeat is no real write, and an age that
    // overflows Int64 (a corrupt value) would trap on every read instead of reading as free.
    guard let heartbeatMs = heartbeatMs, heartbeatMs > 0 else { return false }
    let (ageMs, overflowed) = nowMs.subtractingReportingOverflow(heartbeatMs)
    return !overflowed && ageMs >= 0 && ageMs <= staleAfterMs
  }

  /// Nil defaults (no Full Access, no App Group) and an unreadable value read as no meeting:
  /// the keyboard can't prove a meeting holds the mic, and dictation must not die on bad data.
  static func isMeetingRecording(defaults: UserDefaults?, nowMs: Int64) -> Bool {
    let heartbeatMs = defaults?.string(forKey: heartbeatKey).flatMap { Int64($0) }
    return isHeld(heartbeatMs: heartbeatMs, nowMs: nowMs)
  }

  static func micTapRoute(meetingRecording: Bool, recordsInPlace: Bool, recordsDirect: Bool) -> KeyboardMicTapRoute {
    if meetingRecording { return .meetingRecording }
    if recordsInPlace { return .inPlace }
    if recordsDirect { return .direct }
    return .handoff
  }
}
