import ActivityKit
import AppIntents
import WidgetKit
import SwiftUI

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

  var body: some View {
    Text(timerInterval: startedAt...startedAt.addingTimeInterval(60 * 60 * 24), countsDown: false)
      .monospacedDigit()
      .font(.system(size: 15, weight: .semibold))
      .foregroundColor(color)
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
            Circle()
              .fill(Color(red: 1.0, green: 0.27, blue: 0.23))
              .frame(width: 7, height: 7)
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
      RecordingLockScreenView(state: context.state)
        .activityBackgroundTint(Color.black.opacity(0.6))
        .activitySystemActionForegroundColor(.white)
    } dynamicIsland: { context in
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
              Text(context.state.phase == .recording ? "Recording" : "Active")
                .font(.system(size: 12))
                .foregroundColor(.white.opacity(0.6))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            }
          }
        }
        DynamicIslandExpandedRegion(.trailing) {
          HStack(spacing: 8) {
            if context.state.phase == .recording {
              ElapsedText(startedAt: context.state.startedAt, color: .white.opacity(0.7))
            }
            PowerButton(size: 30)
          }
        }
      } compactLeading: {
        BrandBadge(size: 22)
      } compactTrailing: {
        if context.state.phase == .recording {
          ElapsedText(startedAt: context.state.startedAt)
            .frame(maxWidth: 44)
        }
      } minimal: {
        BrandBadge(size: 22)
      }
      .keylineTint(Color(red: 0.141, green: 0.341, blue: 0.839))
    }
  }
}
