import Foundation

/// The in-app meeting as the controller tracks it.
public struct MeetingSnapshot: Equatable {
  public enum Phase: Equatable {
    case recording
    case processing(recordedSeconds: Int)
  }

  public var title: String?
  public var startedAt: Date
  public var phase: Phase

  public init(title: String?, startedAt: Date, phase: Phase) {
    self.title = title
    self.startedAt = startedAt
    self.phase = phase
  }
}

/// Decides what the single recording Live Activity shows. A meeting always wins so
/// keyboard/dictation-mode events can never overwrite or end it mid-meeting; when the
/// meeting clears, the activity falls back to the dictation session (or ends).
public enum LiveActivityResolver {
  public static func resolve(
    meeting: MeetingSnapshot?,
    keyboardRecording: Bool,
    dictationMode: Bool,
    now: Date
  ) -> RecordingActivityContentState? {
    if let meeting {
      switch meeting.phase {
      case .recording:
        return RecordingActivityContentState(
          mode: .meeting, phase: .recording, startedAt: meeting.startedAt, title: meeting.title)
      case .processing(let recordedSeconds):
        return RecordingActivityContentState(
          mode: .meeting, phase: .processing, startedAt: meeting.startedAt, title: meeting.title,
          recordedSeconds: recordedSeconds)
      }
    }
    if keyboardRecording {
      return RecordingActivityContentState(phase: .recording, startedAt: now)
    }
    if dictationMode {
      return RecordingActivityContentState(phase: .idle, startedAt: now)
    }
    return nil
  }

  /// Without push updates the stale date can never move later, so a meeting is
  /// stale only at ActivityKit's cap.
  public static func staleDate(for state: RecordingActivityContentState, now: Date) -> Date {
    state.mode == .meeting
      ? state.startedAt.addingTimeInterval(RecordingActivityContentState.maxActivityDuration)
      : now.addingTimeInterval(60 * 60)
  }
}
