import Foundation

/// Who holds the app's audio session for capture (meeting recordings). While any
/// owner holds it, the keyboard's warm mic stays parked, so its idle timer can
/// never deactivate the session under a recording. Owners are counted once each,
/// so a repeated acquire or a stray release can't unbalance the lease.
struct CaptureLeasePolicy {
  private(set) var holders: Set<String> = []

  var isHeld: Bool { !holders.isEmpty }

  /// True when `owner` is the first holder: the caller parks the warm mic.
  mutating func acquire(_ owner: String) -> Bool {
    let wasHeld = isHeld
    holders.insert(owner)
    return !wasHeld
  }

  /// True when `owner` was the last holder: the caller may re-arm the warm mic.
  mutating func release(_ owner: String) -> Bool {
    guard holders.remove(owner) != nil else { return false }
    return !isHeld
  }
}

/// The lease as the keyboard sees it: the app writes an epoch-ms heartbeat to the
/// App Group while it holds the lease. A crash can't release the lease, so an old
/// heartbeat counts as free; so does one from the future, since a clock moved back
/// would otherwise hold the keyboard's mic off until the clock caught up.
// The keyboard extension keeps its own copy of this rule (plugins/keyboard-extension/ios/MeetingCaptureLease.swift),
// pinned to the same test vectors. Change both together.
enum CaptureLeaseHeartbeat {
  static let staleAfterMs: Int64 = 15_000

  static func isHeld(heartbeatMs: Int64?, nowMs: Int64) -> Bool {
    // Total over every stored value: a non-positive heartbeat is no real write, and an age that
    // overflows Int64 (a corrupt value) would trap on every read instead of reading as free.
    guard let heartbeatMs = heartbeatMs, heartbeatMs > 0 else { return false }
    let (ageMs, overflowed) = nowMs.subtractingReportingOverflow(heartbeatMs)
    return !overflowed && ageMs >= 0 && ageMs <= staleAfterMs
  }
}
