import Foundation

@main
struct CaptureLeasePolicyTests {
  static func main() {
    holdersShareOneLeaseUntilTheLastRelease()
    heartbeatIsHeldOnlyWhileFresh()
    print("CaptureLeasePolicyTests: all passed")
  }

  static func expect(_ condition: Bool, _ message: String) {
    precondition(condition, message)
  }

  static func holdersShareOneLeaseUntilTheLastRelease() {
    var policy = CaptureLeasePolicy()
    expect(policy.isHeld == false, "starts free")
    expect(policy.acquire("meeting-cloud") == true, "first holder parks")
    expect(policy.acquire("meeting-cloud") == false, "same owner twice is one holder")
    expect(policy.acquire("meeting-local") == false, "second holder does not park again")
    expect(policy.release("meeting-cloud") == false, "still held by the other owner")
    expect(policy.isHeld == true, "held until the last release")
    expect(policy.release("unknown") == false, "unknown owner changes nothing")
    expect(policy.release("meeting-local") == true, "last release re-arms")
    expect(policy.isHeld == false, "free again")
    expect(policy.release("meeting-local") == false, "double release is a no-op")
  }

  static func heartbeatIsHeldOnlyWhileFresh() {
    let now: Int64 = 1_800_000_000_000
    expect(CaptureLeaseHeartbeat.staleAfterMs == 15_000, "stale after 15 s")
    expect(CaptureLeaseHeartbeat.isHeld(heartbeatMs: nil, nowMs: now) == false, "no heartbeat is free")
    expect(CaptureLeaseHeartbeat.isHeld(heartbeatMs: now, nowMs: now) == true, "just written is held")
    expect(CaptureLeaseHeartbeat.isHeld(heartbeatMs: now - 4_000, nowMs: now) == true, "4 s old is held")
    expect(CaptureLeaseHeartbeat.isHeld(heartbeatMs: now - 15_000, nowMs: now) == true, "exactly 15 s old is held")
    expect(CaptureLeaseHeartbeat.isHeld(heartbeatMs: now - 15_001, nowMs: now) == false, "15.001 s old is stale")
    expect(CaptureLeaseHeartbeat.isHeld(heartbeatMs: now + 1, nowMs: now) == false, "a future heartbeat (clock moved back) is free")
    // Absolute stored values a corrupt write could leave: never held, never a trap. Same list in
    // plugins/keyboard-extension/tests/direct/LeaseTests.swift.
    expect(CaptureLeaseHeartbeat.isHeld(heartbeatMs: Int64.min, nowMs: now) == false, "Int64.min is free, not an overflow trap")
    expect(CaptureLeaseHeartbeat.isHeld(heartbeatMs: -1, nowMs: now) == false, "a negative heartbeat is free")
    expect(CaptureLeaseHeartbeat.isHeld(heartbeatMs: 0, nowMs: now) == false, "a zero heartbeat is free")
    expect(CaptureLeaseHeartbeat.isHeld(heartbeatMs: Int64.max, nowMs: Int64.min) == false, "an overflowing age is free")
  }
}
