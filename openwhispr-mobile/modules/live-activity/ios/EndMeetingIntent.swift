import AppIntents
import Foundation

/// End button on the meeting Live Activity. Runs in the app's process
/// (LiveActivityIntent), which background audio keeps alive while a meeting records.
/// Compiled into both the app and the widget target, so it only posts the Darwin
/// notification; LiveActivityController does the work.
@available(iOS 17.0, *)
struct EndMeetingIntent: LiveActivityIntent {
  static var title: LocalizedStringResource = "End meeting recording"
  static var description = IntentDescription("Stops the OpenWhispr meeting recording.")
  // Only meaningful from the meeting card; keep it out of the Shortcuts app.
  static var isDiscoverable: Bool = false

  func perform() async throws -> some IntentResult {
    let bundleId = Bundle.main.bundleIdentifier ?? "com.gizmolabs.openwhispr"
    let name = "\(bundleId).endMeetingRequested" as CFString
    CFNotificationCenterPostNotification(
      CFNotificationCenterGetDarwinNotifyCenter(),
      CFNotificationName(name), nil, nil, true)
    return .result()
  }
}
