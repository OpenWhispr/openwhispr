import Foundation

public enum CaptureHealthState: String {
  case capturing, interrupted
}

public enum CaptureHealthAction: Equatable {
  case none, restart
}

// Decides when meeting capture needs its engine rebuilt. iOS stops AVAudioEngine
// for calls, Siri, alarms and route changes, sometimes without any notification,
// so the only reliable health signal is whether buffers keep reaching the tap.
// Times are monotonic milliseconds supplied by the caller, which keeps this
// deterministic for tests.
public struct CaptureHealthPolicy {
  /// Silence from the tap this long means capture has stopped.
  public static let stallAfterMs: Int64 = 3_000
  /// Late in an interruption, restarts are spaced this far apart: during a
  /// phone call every attempt fails, and hammering the session does not help.
  public static let retryEveryMs: Int64 = 5_000
  /// Early in an interruption, a restart the session refused is retried a
  /// second later: another app that borrowed the microphone for a moment is
  /// usually done within seconds, and each second of waiting is a second
  /// missing from the meeting. A restart whose engine started gets the stall
  /// grace instead, so a slow first buffer is not torn down.
  public static let fastRetryEveryMs: Int64 = 1_000
  /// How long into an interruption the one-second retries last. The app holds
  /// background time for this long too (`wantsBackgroundTime`), so the retries
  /// keep running after another app took the microphone.
  public static let fastRetryForMs: Int64 = 25_000
  /// The watchdog ticks once a second, and a restart reads the clock a few ms
  /// after the tick that asked for it, so a retry is due this much early;
  /// otherwise every one-second retry would slip to the tick after.
  public static let retryToleranceMs: Int64 = 500

  public private(set) var state: CaptureHealthState = .capturing
  private var lastFrameAtMs: Int64
  private var lastRestartAtMs: Int64?
  // The last restart's engine never started (`restartFailed`).
  private var lastRestartFailed = false
  // When the current interruption began; nil while capturing.
  private var interruptedAtMs: Int64?
  // Restarts since the current interruption began (or since the last restart
  // while capturing, which stands alone).
  private var attempts = 0

  public init(startedAtMs: Int64) {
    // The start counts as the last frame, so the first buffers get the same
    // grace as any later gap.
    lastFrameAtMs = startedAtMs
  }

  /// A buffer reached the tap. True when this ends an interruption.
  public mutating func frameArrived(atMs: Int64) -> Bool {
    lastFrameAtMs = atMs
    guard state == .interrupted else { return false }
    state = .capturing
    // A later interruption should get its first retry on the next tick.
    lastRestartAtMs = nil
    interruptedAtMs = nil
    attempts = 0
    return true
  }

  /// The system stopped capture. True when the state changed.
  public mutating func interrupted(atMs: Int64) -> Bool {
    guard state == .capturing else { return false }
    beginInterruption(atMs: atMs)
    return true
  }

  /// Once a second. `.restart` when capture has stalled or a retry is due.
  public mutating func tick(atMs: Int64) -> CaptureHealthAction {
    switch state {
    case .capturing:
      guard atMs - lastFrameAtMs >= Self.stallAfterMs else { return .none }
      beginInterruption(atMs: atMs)
      return .restart
    case .interrupted:
      guard let lastRestartAtMs else { return .restart }
      let interval = retryIntervalMs(atMs: atMs)
      // An engine that started may just be slow to deliver its first buffer.
      let wait = lastRestartFailed ? interval : max(Self.stallAfterMs, interval)
      return atMs - lastRestartAtMs < wait - Self.retryToleranceMs ? .none : .restart
    }
  }

  /// How far apart failed restarts are right now: a second for the first
  /// `fastRetryForMs` of an interruption, `retryEveryMs` otherwise.
  public func retryIntervalMs(atMs: Int64) -> Int64 {
    return inFastRetryWindow(atMs: atMs) ? Self.fastRetryEveryMs : Self.retryEveryMs
  }

  /// True while the app should hold background time: from an interruption's
  /// beginning until capture returns or `fastRetryForMs` has passed.
  public func wantsBackgroundTime(atMs: Int64) -> Bool {
    return inFastRetryWindow(atMs: atMs)
  }

  private func inFastRetryWindow(atMs: Int64) -> Bool {
    guard state == .interrupted, let interruptedAtMs else { return false }
    return atMs - interruptedAtMs < Self.fastRetryForMs
  }

  private mutating func beginInterruption(atMs: Int64) {
    state = .interrupted
    interruptedAtMs = atMs
    attempts = 0
  }

  /// The system ended an interruption. `.restart` only while still
  /// interrupted: when a watchdog retry already brought audio back, another
  /// restart would only cut a gap into the recording.
  public func interruptionEnded() -> CaptureHealthAction {
    return state == .interrupted ? .restart : .none
  }

  /// Records a restart and returns its attempt number within the current
  /// interruption (always 1 for a restart while capturing).
  @discardableResult
  public mutating func restartAttempted(atMs: Int64) -> Int {
    lastRestartAtMs = atMs
    lastRestartFailed = false
    attempts = state == .capturing ? 1 : attempts + 1
    // A restart while capturing (route change, media reset) gets the full
    // stall grace from the restart, not from the last buffer before it: a
    // Bluetooth route can take seconds before its notification arrives.
    if state == .capturing {
      lastFrameAtMs = max(lastFrameAtMs, atMs)
    }
    return attempts
  }

  /// The restart recorded by `restartAttempted` never started an engine (the
  /// session refused it, say). Inside the fast window the next one is due a
  /// second after this failure. Reported separately from the attempt so the
  /// attempt number is taken before the new engine's buffers can end the
  /// interruption.
  public mutating func restartFailed(atMs: Int64) {
    lastRestartAtMs = atMs
    lastRestartFailed = true
  }
}
