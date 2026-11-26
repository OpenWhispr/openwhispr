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
