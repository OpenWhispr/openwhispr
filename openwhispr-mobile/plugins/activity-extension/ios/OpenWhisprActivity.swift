import ActivityKit
import AppIntents
import WidgetKit
import SwiftUI

private let recordingRed = Color(red: 1.0, green: 0.27, blue: 0.23)
private let brandBlue = Color(red: 0.141, green: 0.341, blue: 0.839)

// MARK: - Brand mark

struct BrandMark: View {
  var color: Color = .white

  var body: some View {
    GeometryReader { geo in
      let s = min(geo.size.width, geo.size.height)
      ZStack {
        Circle()
          .stroke(color, lineWidth: s * 0.075)
          .padding(s * 0.0375)
        HStack(spacing: s * 0.108) {
          Capsule().fill(color).frame(width: s * 0.092, height: s * 0.29)
          Capsule().fill(color).frame(width: s * 0.092, height: s * 0.46)
          Capsule().fill(color).frame(width: s * 0.092, height: s * 0.29)
        }
      }
      .frame(width: s, height: s)
    }
  }
}

struct BrandBadge: View {
  var size: CGFloat

  var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: size * 0.27, style: .continuous)
        .fill(
          LinearGradient(
            colors: [
              Color(red: 0.141, green: 0.341, blue: 0.839),
              Color(red: 0.055, green: 0.212, blue: 0.565),
            ],
            startPoint: .top,
            endPoint: .bottom
          )
        )
      BrandMark()
        .frame(width: size * 0.66, height: size * 0.66)
    }
    .frame(width: size, height: size)
  }
}

struct ElapsedText: View {
  let startedAt: Date
  var color: Color = .white
  var size: CGFloat = 15

  var body: some View {
    Text(timerInterval: startedAt...startedAt.addingTimeInterval(60 * 60 * 24), countsDown: false)
      .monospacedDigit()
      .font(.system(size: size, weight: .semibold))
      .foregroundColor(color)
  }
}

struct RecordingDot: View {
  var size: CGFloat = 7

  var body: some View {
    Circle().fill(recordingRed).frame(width: size, height: size)
  }
}

// MARK: - Power button (turn dictation mode off)

struct PowerButton: View {
  var size: CGFloat = 30

  var body: some View {
    if #available(iOS 17.0, *) {
      Button(intent: ToggleDictationModeIntent()) {
        glyph
      }
      .buttonStyle(.plain)
    } else {
      glyph
    }
  }

  private var glyph: some View {
    Image(systemName: "power")
      .font(.system(size: size * 0.62, weight: .semibold))
      .foregroundColor(.white)
      .frame(width: size, height: size)
      .background(Circle().fill(Color.white.opacity(0.16)))
  }
}

// MARK: - End button (stop the meeting recording)

/// Same translucent material as PowerButton. Omitted before iOS 17, where
/// `Button(intent:)` doesn't exist; tapping the card still opens the app.
struct EndButton: View {
  var body: some View {
    if #available(iOS 17.0, *) {
      Button(intent: EndMeetingIntent()) {
        Text("End")
          .font(.system(size: 15, weight: .semibold))
          .foregroundColor(.white)
          .padding(.horizontal, 18)
          .padding(.vertical, 8)
          .background(Capsule().fill(Color.white.opacity(0.16)))
      }
      .buttonStyle(.plain)
    }
  }
}

// MARK: - Lock screen / banner

struct RecordingLockScreenView: View {
  let state: RecordingActivityAttributes.ContentState

  var body: some View {
    HStack(spacing: 12) {
      BrandBadge(size: 40)
      VStack(alignment: .leading, spacing: 2) {
        Text("OpenWhispr")
          .font(.system(size: 15, weight: .semibold))
          .foregroundColor(.white)
        if state.phase == .recording {
          HStack(spacing: 5) {
            RecordingDot()
            Text("Recording")
              .font(.system(size: 13))
              .foregroundColor(.white.opacity(0.6))
          }
        } else {
          Text("Dictation mode is active")
            .font(.system(size: 13))
            .foregroundColor(.white.opacity(0.6))
        }
      }
      Spacer()
      if state.phase == .recording {
        ElapsedText(startedAt: state.startedAt, color: .white.opacity(0.85))
      }
      PowerButton(size: 34)
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 12)
  }
}

struct MeetingLockScreenView: View {
  let state: RecordingActivityAttributes.ContentState

  var body: some View {
    HStack(spacing: 12) {
      BrandBadge(size: 40)
      VStack(alignment: .leading, spacing: 2) {
        Text(state.displayTitle)
          .font(.system(size: 15, weight: .semibold))
          .foregroundColor(.white)
          .lineLimit(1)
        MeetingSubtitle(state: state, size: 13)
      }
      Spacer(minLength: 8)
      if state.phase == .recording {
        EndButton()
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 12)
  }
}

struct MeetingSubtitle: View {
  let state: RecordingActivityAttributes.ContentState
  var size: CGFloat

  var body: some View {
    if state.phase == .processing {
      Text("Recorded \(state.recordedDurationLabel)")
        .font(.system(size: size))
        .foregroundColor(.white.opacity(0.6))
    } else {
      HStack(spacing: 5) {
        RecordingDot(size: size * 0.54)
        (Text("Recording · ")
          + Text(
            timerInterval: state.startedAt...state.startedAt.addingTimeInterval(60 * 60 * 24),
            countsDown: false))
          .monospacedDigit()
          .font(.system(size: size))
          .foregroundColor(.white.opacity(0.6))
      }
    }
  }
}

// MARK: - Widget

@main
struct OpenWhisprActivityBundle: WidgetBundle {
  var body: some Widget {
    RecordingLiveActivity()
  }
}

struct RecordingLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: RecordingActivityAttributes.self) { context in
      Group {
        if context.state.mode == .meeting {
          MeetingLockScreenView(state: context.state)
        } else {
          RecordingLockScreenView(state: context.state)
        }
      }
      .activityBackgroundTint(Color.black.opacity(0.6))
      .activitySystemActionForegroundColor(.white)
    } dynamicIsland: { context in
      if context.state.mode == .meeting {
        return meetingIsland(context.state)
      }
      return dictationIsland(context.state)
    }
  }

  private func dictationIsland(_ state: RecordingActivityAttributes.ContentState) -> DynamicIsland {
    DynamicIsland {
      DynamicIslandExpandedRegion(.leading) {
        HStack(spacing: 10) {
          BrandBadge(size: 34)
          VStack(alignment: .leading, spacing: 1) {
            Text("OpenWhispr")
              .font(.system(size: 14, weight: .semibold))
              .foregroundColor(.white)
              .lineLimit(1)
              .minimumScaleFactor(0.7)
            Text(state.phase == .recording ? "Recording" : "Active")
              .font(.system(size: 12))
              .foregroundColor(.white.opacity(0.6))
              .lineLimit(1)
              .minimumScaleFactor(0.7)
          }
        }
      }
      DynamicIslandExpandedRegion(.trailing) {
        HStack(spacing: 8) {
          if state.phase == .recording {
            ElapsedText(startedAt: state.startedAt, color: .white.opacity(0.7))
          }
          PowerButton(size: 30)
        }
      }
    } compactLeading: {
      BrandBadge(size: 22)
    } compactTrailing: {
      if state.phase == .recording {
        ElapsedText(startedAt: state.startedAt)
          .frame(maxWidth: 44)
      }
    } minimal: {
      BrandBadge(size: 22)
    }
    .keylineTint(brandBlue)
  }

  private func meetingIsland(_ state: RecordingActivityAttributes.ContentState) -> DynamicIsland {
    DynamicIsland {
      DynamicIslandExpandedRegion(.leading) {
        HStack(spacing: 10) {
          BrandBadge(size: 34)
          VStack(alignment: .leading, spacing: 1) {
            Text(state.displayTitle)
              .font(.system(size: 14, weight: .semibold))
              .foregroundColor(.white)
              .lineLimit(1)
              .minimumScaleFactor(0.7)
            MeetingSubtitle(state: state, size: 12)
          }
        }
      }
      DynamicIslandExpandedRegion(.trailing) {
        if state.phase == .recording {
          EndButton()
        }
      }
    } compactLeading: {
      BrandBadge(size: 22)
    } compactTrailing: {
      if state.phase == .recording {
        // Meetings run past an hour, and "1:02:03" is wider than the 44 pt slot.
        ElapsedText(startedAt: state.startedAt, color: recordingRed)
          .lineLimit(1)
          .minimumScaleFactor(0.6)
          .frame(maxWidth: 44)
      } else {
        Image(systemName: "waveform")
          .font(.system(size: 12, weight: .semibold))
          .foregroundColor(.white.opacity(0.6))
      }
    } minimal: {
      BrandBadge(size: 22)
    }
    .keylineTint(brandBlue)
  }
}
