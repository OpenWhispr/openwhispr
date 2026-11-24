import Foundation

@main
struct CaptureHealthPolicyTests {
  static func main() {
    silenceAfterStartIsAStall()
    interruptionRetriesUntilAudioReturns()
    restartWhileCapturingGetsAFreshGrace()
    interruptionDuringAStallIsReportedOnce()
    resumingClearsTheRetryTime()
    interruptionEndedRestartsOnlyWhileInterrupted()
    print("CaptureHealthPolicyTests: all passed")
  }

  static func expect(_ condition: Bool, _ message: String) {
    precondition(condition, message)
  }

  static func silenceAfterStartIsAStall() {
    var p = CaptureHealthPolicy(startedAtMs: 0)
    expect(p.tick(atMs: 2_999) == .none, "inside the startup grace")
    expect(p.tick(atMs: 3_000) == .restart, "no frame for 3 s is a stall")
    expect(p.state == .interrupted, "a stall is an interruption")
  }

  static func interruptionRetriesUntilAudioReturns() {
    var q = CaptureHealthPolicy(startedAtMs: 0)
    expect(q.frameArrived(atMs: 1_000) == false, "healthy frame changes nothing")
    expect(q.tick(atMs: 3_500) == .none, "2.5 s since the last frame")
    expect(q.interrupted(atMs: 4_000) == true, "system interruption")
    expect(q.interrupted(atMs: 4_100) == false, "reported once")
    expect(q.tick(atMs: 5_000) == .restart, "first retry on the next tick")
    q.restartAttempted(atMs: 5_000)
    expect(q.tick(atMs: 9_999) == .none, "retries are 5 s apart")
    expect(q.tick(atMs: 10_000) == .restart, "second retry")
    q.restartAttempted(atMs: 10_000)
    expect(q.frameArrived(atMs: 10_400) == true, "first frame ends the interruption")
    expect(q.state == .capturing, "capturing again")
    expect(q.tick(atMs: 12_000) == .none, "healthy again")
  }

  static func restartWhileCapturingGetsAFreshGrace() {
    var p = CaptureHealthPolicy(startedAtMs: 0)
    expect(p.frameArrived(atMs: 1_000) == false, "healthy frame")
    p.restartAttempted(atMs: 3_500)
    expect(p.tick(atMs: 5_000) == .none, "grace counts from the restart")
    expect(p.state == .capturing, "still capturing inside the grace")
    expect(p.tick(atMs: 6_500) == .restart, "3 s after the restart is a stall")
  }

  static func interruptionDuringAStallIsReportedOnce() {
    var p = CaptureHealthPolicy(startedAtMs: 0)
    expect(p.tick(atMs: 3_000) == .restart, "stall")
    expect(p.interrupted(atMs: 3_100) == false, "already interrupted by the stall")
    expect(p.state == .interrupted, "still interrupted")
  }

  static func resumingClearsTheRetryTime() {
    var p = CaptureHealthPolicy(startedAtMs: 0)
    expect(p.interrupted(atMs: 1_000) == true, "first interruption")
    expect(p.tick(atMs: 1_500) == .restart, "first retry")
    p.restartAttempted(atMs: 1_500)
    expect(p.frameArrived(atMs: 2_000) == true, "audio back")
    expect(p.interrupted(atMs: 2_500) == true, "second interruption")
    expect(p.tick(atMs: 3_000) == .restart, "second interruption retries on its first tick")
  }

  static func interruptionEndedRestartsOnlyWhileInterrupted() {
    var p = CaptureHealthPolicy(startedAtMs: 0)
    expect(p.interruptionEnded() == .none, "capturing: nothing to resume")
    expect(p.interrupted(atMs: 1_000) == true, "interrupted")
    expect(p.interruptionEnded() == .restart, "interrupted: resume")
    p.restartAttempted(atMs: 1_100)
    expect(p.frameArrived(atMs: 1_400) == true, "a watchdog retry brought audio back")
    expect(p.interruptionEnded() == .none, "a late .ended restarts nothing")
  }
}
