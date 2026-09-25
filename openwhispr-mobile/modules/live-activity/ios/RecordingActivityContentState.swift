import Foundation

/// Which recording owns the single Live Activity.
public enum RecordingActivityMode: String, Codable, Hashable {
  case dictation
  case meeting
}

/// `idle` is dictation-only (session up, not recording); `processing` is meeting-only.
public enum RecordingActivityPhase: String, Codable, Hashable {
  case recording
  case idle
  case processing
}

/// Foundation-only so the resolver tests can compile it with plain `swiftc` on macOS;
/// `RecordingActivityAttributes` (ActivityKit) aliases it as its `ContentState`.
public struct RecordingActivityContentState: Codable, Hashable {
  public var mode: RecordingActivityMode
  public var phase: RecordingActivityPhase
  public var startedAt: Date
  public var title: String?
  public var recordedSeconds: Int?

  public init(
    mode: RecordingActivityMode = .dictation,
    phase: RecordingActivityPhase,
    startedAt: Date,
    title: String? = nil,
    recordedSeconds: Int? = nil
  ) {
    self.mode = mode
    self.phase = phase
    self.startedAt = startedAt
    self.title = title
    self.recordedSeconds = recordedSeconds
  }

  private enum CodingKeys: String, CodingKey {
    case mode, phase, startedAt, title, recordedSeconds
  }

  // An activity started by a build that predates meetings carries only
  // `phase` + `startedAt`; it must keep decoding after an app update.
  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    mode = try container.decodeIfPresent(RecordingActivityMode.self, forKey: .mode) ?? .dictation
    phase = try container.decode(RecordingActivityPhase.self, forKey: .phase)
    startedAt = try container.decode(Date.self, forKey: .startedAt)
    title = try container.decodeIfPresent(String.self, forKey: .title)
    recordedSeconds = try container.decodeIfPresent(Int.self, forKey: .recordedSeconds)
  }

  /// Meeting card headline.
  public var displayTitle: String {
    if phase == .processing { return "Processing notes…" }
    return title ?? "Taking notes…"
  }

  /// "42:10" or "1:02:03".
  public var recordedDurationLabel: String {
    let total = max(0, recordedSeconds ?? 0)
    let hours = total / 3600
    let minutes = (total % 3600) / 60
    let seconds = total % 60
    return hours > 0
      ? String(format: "%d:%02d:%02d", hours, minutes, seconds)
      : String(format: "%d:%02d", minutes, seconds)
  }
}
