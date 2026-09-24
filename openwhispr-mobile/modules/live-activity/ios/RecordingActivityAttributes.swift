#if canImport(ActivityKit)
import ActivityKit
import Foundation

/// Shared contract between the app (requests/updates the activity) and the widget
/// extension (renders it). The activity is session-scoped: `ContentState.phase`
/// flips between recording and idle across the session; `startedAt` drives the
/// self-counting timer for the current recording.
@available(iOS 16.1, *)
public struct RecordingActivityAttributes: ActivityAttributes {
  public enum Phase: String, Codable, Hashable {
    case recording
    case idle
  }

  public struct ContentState: Codable, Hashable {
    public var phase: Phase
    public var startedAt: Date

    public init(phase: Phase, startedAt: Date) {
      self.phase = phase
      self.startedAt = startedAt
    }
  }

  public init() {}
}
#endif
