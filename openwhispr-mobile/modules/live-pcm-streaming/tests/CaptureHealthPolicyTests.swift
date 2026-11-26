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
    retriesEverySecondWhileInterrupted()
    fallsBackToFiveSecondsAfter25s()
    anInterruptionThatEndsResetsTheBound()
    attemptNumbersRestartPerInterruption()
    backgroundTimeIsReleasedWhenCaptureReturns()
    backgroundTimeIsReleasedWhenTheBoundPasses()
    aStartedEngineGetsTheStallGraceEvenInsideTheFastWindow()
    aFailedAttemptIsRetriedAfterOneSecond()
    aLateRetryIsDueWithinTheTolerance()
    anInterruptionsEndOpensAFreshFastWindow()
    aFailedRestartAfterTheEndIsRetriedASecondLater()
    anEndWhileCapturingChangesNothing()
    theEndsWindowClosesAfter25s()
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
    q.restartFailed(atMs: 5_000)
    expect(q.tick(atMs: 5_400) == .none, "failed retries are a second apart while interrupted")
    expect(q.tick(atMs: 6_000) == .restart, "second retry")
    q.restartAttempted(atMs: 6_000)
    expect(q.frameArrived(atMs: 6_400) == true, "first frame ends the interruption")
    expect(q.state == .capturing, "capturing again")
    expect(q.tick(atMs: 8_000) == .none, "healthy again")
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
    expect(p.interruptionEnded(atMs: 500) == .none, "capturing: nothing to resume")
    expect(p.interrupted(atMs: 1_000) == true, "interrupted")
    expect(p.interruptionEnded(atMs: 1_050) == .restart, "interrupted: resume")
    p.restartAttempted(atMs: 1_100)
    expect(p.frameArrived(atMs: 1_400) == true, "a watchdog retry brought audio back")
    expect(p.interruptionEnded(atMs: 1_500) == .none, "a late .ended restarts nothing")
  }

  static func retriesEverySecondWhileInterrupted() {
    var p = CaptureHealthPolicy(startedAtMs: 0)
    expect(p.retryIntervalMs(atMs: 500) == CaptureHealthPolicy.retryEveryMs, "5 s outside an interruption")
    expect(p.interrupted(atMs: 1_000) == true, "interrupted")
    expect(p.retryIntervalMs(atMs: 1_000) == 1_000, "1 s while interrupted")
    expect(p.tick(atMs: 1_000) == .restart, "first retry at once")
    // The restart reads the clock a few ms after the tick that asked for it.
    p.restartAttempted(atMs: 1_005)
    p.restartFailed(atMs: 1_005)
    expect(p.tick(atMs: 1_400) == .none, "not twice in one second")
    expect(p.tick(atMs: 2_000) == .restart, "the next tick retries, despite the restart's few ms")
    p.restartAttempted(atMs: 2_003)
    p.restartFailed(atMs: 2_003)
    expect(p.tick(atMs: 2_998) == .restart, "a tick that fires a little early still retries")
  }

  static func fallsBackToFiveSecondsAfter25s() {
    var p = CaptureHealthPolicy(startedAtMs: 0)
    expect(p.interrupted(atMs: 1_000) == true, "interrupted")
    var at: Int64 = 1_000
    while at < 26_000 {
      expect(p.tick(atMs: at) == .restart, "every second inside the bound (\(at))")
      p.restartAttempted(atMs: at)
      p.restartFailed(atMs: at)
      at += 1_000
    }
    expect(p.retryIntervalMs(atMs: 26_000) == CaptureHealthPolicy.retryEveryMs, "5 s once 25 s have passed")
    expect(p.tick(atMs: 26_000) == .none, "no longer every second")
    expect(p.tick(atMs: 29_000) == .none, "4 s after the last retry")
    expect(p.tick(atMs: 30_000) == .restart, "5 s after the last retry")
  }

  static func anInterruptionThatEndsResetsTheBound() {
    var p = CaptureHealthPolicy(startedAtMs: 0)
    expect(p.interrupted(atMs: 1_000) == true, "first interruption")
    expect(p.tick(atMs: 30_000) == .restart, "retry")
    p.restartAttempted(atMs: 30_000)
    expect(p.retryIntervalMs(atMs: 30_000) == CaptureHealthPolicy.retryEveryMs, "past the bound")
    expect(p.frameArrived(atMs: 30_500) == true, "audio back")
    expect(p.interrupted(atMs: 40_000) == true, "second interruption")
    expect(p.retryIntervalMs(atMs: 40_000) == 1_000, "the new interruption gets its own 25 s")
    expect(p.tick(atMs: 40_000) == .restart, "first retry")
    p.restartAttempted(atMs: 40_000)
    p.restartFailed(atMs: 40_000)
    expect(p.tick(atMs: 41_000) == .restart, "a second later")
  }

  static func attemptNumbersRestartPerInterruption() {
    var p = CaptureHealthPolicy(startedAtMs: 0)
    expect(p.restartAttempted(atMs: 500) == 1, "a restart while capturing is attempt 1")
    expect(p.restartAttempted(atMs: 600) == 1, "and so is the next one")
    expect(p.interrupted(atMs: 1_000) == true, "interrupted")
    expect(p.restartAttempted(atMs: 1_000) == 1, "first attempt")
    expect(p.restartAttempted(atMs: 2_000) == 2, "second attempt")
    expect(p.restartAttempted(atMs: 3_000) == 3, "third attempt")
    expect(p.frameArrived(atMs: 3_400) == true, "audio back")
    expect(p.interrupted(atMs: 5_000) == true, "new interruption")
    expect(p.restartAttempted(atMs: 5_000) == 1, "counting starts over")
    expect(p.frameArrived(atMs: 5_400) == true, "audio back")
    expect(p.tick(atMs: 8_400) == .restart, "a stall")
    expect(p.restartAttempted(atMs: 8_400) == 1, "a stall starts over too")
  }

  static func backgroundTimeIsReleasedWhenCaptureReturns() {
    var p = CaptureHealthPolicy(startedAtMs: 0)
    expect(p.wantsBackgroundTime(atMs: 500) == false, "nothing to hold while capturing")
    expect(p.interrupted(atMs: 1_000) == true, "interrupted")
    expect(p.wantsBackgroundTime(atMs: 1_000) == true, "held from the interruption's beginning")
    p.restartAttempted(atMs: 1_000)
    expect(p.frameArrived(atMs: 1_400) == true, "audio back")
    expect(p.wantsBackgroundTime(atMs: 1_400) == false, "released when capture returns")
    expect(p.tick(atMs: 4_400) == .restart, "a stall")
    expect(p.wantsBackgroundTime(atMs: 4_400) == true, "a stall is an interruption too")
  }

  static func backgroundTimeIsReleasedWhenTheBoundPasses() {
    var p = CaptureHealthPolicy(startedAtMs: 0)
    expect(p.interrupted(atMs: 1_000) == true, "interrupted")
    expect(p.wantsBackgroundTime(atMs: 25_999) == true, "still inside 25 s")
    expect(p.wantsBackgroundTime(atMs: 26_000) == false, "released once 25 s have passed")
  }

  static func aStartedEngineGetsTheStallGraceEvenInsideTheFastWindow() {
    var p = CaptureHealthPolicy(startedAtMs: 0)
    expect(p.interrupted(atMs: 1_000) == true, "interrupted")
    expect(p.tick(atMs: 1_000) == .restart, "first retry")
    // The session took it and the engine started; its first buffer is slow.
    p.restartAttempted(atMs: 1_005)
    expect(p.tick(atMs: 2_000) == .none, "not torn down a second later")
    expect(p.tick(atMs: 3_000) == .none, "nor two seconds later")
    expect(p.tick(atMs: 4_000) == .restart, "a stall grace after the restart, it is retried")
  }

  static func aFailedAttemptIsRetriedAfterOneSecond() {
    var p = CaptureHealthPolicy(startedAtMs: 0)
    expect(p.interrupted(atMs: 1_000) == true, "interrupted")
    expect(p.tick(atMs: 1_000) == .restart, "first retry")
    p.restartAttempted(atMs: 1_000)
    // The session refused activation.
    p.restartFailed(atMs: 1_050)
    expect(p.tick(atMs: 1_500) == .none, "not within the same second")
    expect(p.tick(atMs: 2_000) == .restart, "a second later")
    p.restartAttempted(atMs: 2_000)
    expect(p.tick(atMs: 3_000) == .none, "an attempt that started gets the stall grace")
  }

  static func aLateRetryIsDueWithinTheTolerance() {
    var p = CaptureHealthPolicy(startedAtMs: 0)
    expect(p.interrupted(atMs: 1_000) == true, "interrupted")
    p.restartAttempted(atMs: 30_000)
    p.restartFailed(atMs: 30_000)
    expect(p.tick(atMs: 34_400) == .none, "4.4 s after the window's last retry")
    expect(p.tick(atMs: 34_600) == .restart, "4.6 s is within the 500 ms tolerance of 5 s")
    p.restartAttempted(atMs: 34_600)
    expect(p.tick(atMs: 37_600) == .none, "a started attempt outside the window waits the full 5 s")
    expect(p.tick(atMs: 39_600) == .restart, "5 s after it")
  }

  static func anInterruptionsEndOpensAFreshFastWindow() {
    var p = CaptureHealthPolicy(startedAtMs: 0)
    expect(p.interrupted(atMs: 1_000) == true, "a phone call")
    expect(p.restartAttempted(atMs: 1_000) == 1, "first attempt")
    p.restartFailed(atMs: 1_000)
    // The call outlasts the first window, and the app is suspended meanwhile.
    expect(p.wantsBackgroundTime(atMs: 60_000) == false, "the first window has passed")
    expect(p.retryIntervalMs(atMs: 60_000) == CaptureHealthPolicy.retryEveryMs, "5 s late in the call")
    expect(p.interruptionEnded(atMs: 60_000) == .restart, "the call ended")
    expect(p.wantsBackgroundTime(atMs: 60_000) == true, "background time again from the end")
    expect(p.retryIntervalMs(atMs: 60_000) == 1_000, "1 s again from the end")
    expect(p.restartAttempted(atMs: 60_000) == 2, "attempts keep counting from the call's beginning")
  }

  static func aFailedRestartAfterTheEndIsRetriedASecondLater() {
    var p = CaptureHealthPolicy(startedAtMs: 0)
    expect(p.interrupted(atMs: 1_000) == true, "a phone call")
    expect(p.interruptionEnded(atMs: 60_000) == .restart, "the call ended")
    p.restartAttempted(atMs: 60_005)
    // iOS refused the session for a moment after the call.
    p.restartFailed(atMs: 60_010)
    expect(p.tick(atMs: 60_500) == .none, "not within the same second")
    expect(p.tick(atMs: 61_000) == .restart, "a second later, not five")
    p.restartAttempted(atMs: 61_000)
    expect(p.tick(atMs: 62_000) == .none, "an attempt that started gets the stall grace")
    expect(p.tick(atMs: 64_000) == .restart, "and is retried once the grace passes")
  }

  static func anEndWhileCapturingChangesNothing() {
    var p = CaptureHealthPolicy(startedAtMs: 0)
    expect(p.frameArrived(atMs: 1_000) == false, "capturing")
    expect(p.interruptionEnded(atMs: 1_500) == .none, "nothing to resume")
    expect(p.state == .capturing, "still capturing")
    expect(p.wantsBackgroundTime(atMs: 1_500) == false, "no background time")
    expect(p.retryIntervalMs(atMs: 1_500) == CaptureHealthPolicy.retryEveryMs, "no fast window")
    expect(p.tick(atMs: 3_999) == .none, "the stall grace still counts from the last frame")
    expect(p.tick(atMs: 4_000) == .restart, "3 s after the last frame is a stall")
  }

  static func theEndsWindowClosesAfter25s() {
    var p = CaptureHealthPolicy(startedAtMs: 0)
    expect(p.interrupted(atMs: 1_000) == true, "a phone call")
    expect(p.interruptionEnded(atMs: 60_000) == .restart, "the call ended")
    p.restartAttempted(atMs: 60_000)
    p.restartFailed(atMs: 60_000)
    var at: Int64 = 61_000
    while at < 85_000 {
      expect(p.tick(atMs: at) == .restart, "every second inside the end's window (\(at))")
      p.restartAttempted(atMs: at)
      p.restartFailed(atMs: at)
      at += 1_000
    }
    expect(p.wantsBackgroundTime(atMs: 84_999) == true, "still inside 25 s of the end")
    expect(p.wantsBackgroundTime(atMs: 85_000) == false, "released 25 s after the end")
    expect(p.tick(atMs: 85_000) == .none, "no longer every second")
    expect(p.tick(atMs: 88_000) == .none, "4 s after the last retry")
    expect(p.tick(atMs: 89_000) == .restart, "5 s after the last retry")
  }
}
