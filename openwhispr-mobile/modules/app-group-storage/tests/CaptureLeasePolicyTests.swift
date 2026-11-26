import Foundation

@main
struct CaptureLeasePolicyTests {
  static func main() {
    holdersShareOneLeaseUntilTheLastRelease()
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
}
