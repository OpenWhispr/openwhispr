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
  /// While interrupted, restarts are spaced this far apart: during a phone call
  /// every attempt fails, and hammering the session does not help.
  public static let retryEveryMs: Int64 = 5_000

  public private(set) var state: CaptureHealthState = .capturing
  private var lastFrameAtMs: Int64
  private var lastRestartAtMs: Int64?

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
    return true
  }

  /// The system stopped capture. True when the state changed.
  public mutating func interrupted(atMs: Int64) -> Bool {
    guard state == .capturing else { return false }
    state = .interrupted
    return true
  }

  /// Once a second. `.restart` when capture has stalled or a retry is due.
  public mutating func tick(atMs: Int64) -> CaptureHealthAction {
    switch state {
    case .capturing:
      guard atMs - lastFrameAtMs >= Self.stallAfterMs else { return .none }
      state = .interrupted
      return .restart
    case .interrupted:
      if let lastRestartAtMs, atMs - lastRestartAtMs < Self.retryEveryMs {
        return .none
      }
      return .restart
    }
  }

  public mutating func restartAttempted(atMs: Int64) {
    lastRestartAtMs = atMs
  }
}
