import Foundation
import UIKit
import os.log

#if canImport(ActivityKit)
import ActivityKit
#endif

/// Owns the session-scoped recording Live Activity. The activity exists while
/// "dictation mode" is enabled: started in a foreground window (the in-app toggle
/// or the keyboard cold-handoff), updated per dictation from the background, and
/// ended when dictation mode is turned off. All ActivityKit work is iOS 16.2+
/// guarded and dispatched to the main queue.
final class LiveActivityController {
  static let shared = LiveActivityController()

  private let log = Logger(subsystem: "com.gizmolabs.openwhispr", category: "LiveActivity")

  private init() {}

  private var bundleId: String { Bundle.main.bundleIdentifier ?? "com.gizmolabs.openwhispr" }
  private var statusNotificationName: String { "\(bundleId).keyboardStatusChanged" }
  private var dictationModeNotificationName: String { "\(bundleId).dictationModeChanged" }
  private var sharedDefaults: UserDefaults? { UserDefaults(suiteName: "group.\(bundleId)") }
  private var isObserving = false
  private var foregroundObserverToken: NSObjectProtocol?

  // MARK: - Dictation mode (the user-controlled gate)

  func isDictationModeEnabled() -> Bool {
    // Default ON: enabled unless the user has explicitly turned it off.
    sharedDefaults?.string(forKey: "dictation_mode_enabled") != "0"
  }

  func setDictationMode(_ enabled: Bool) {
    sharedDefaults?.set(enabled ? "1" : "0", forKey: "dictation_mode_enabled")
    // Badge (this controller) and warm mic (AppGroupStorageModule) both observe this.
    postDictationModeChanged()
  }

  private func postDictationModeChanged() {
    let center = CFNotificationCenterGetDarwinNotifyCenter()
    CFNotificationCenterPostNotification(
      center, CFNotificationName(dictationModeNotificationName as CFString), nil, nil, true)
  }

  // True while a keyboard dictation is actively recording. Lets the pill appear
  // for a one-off dictation even when dictation mode (the persistent warm-mic
  // session) is off — e.g. a cross-app handoff from a user who never enabled it.
  private func isRecordingActive() -> Bool {
    sharedDefaults?.string(forKey: "keyboard_recording_active") == "1"
  }

  // MARK: - Observation (per-dictation background updates)

  /// Observe keyboard recording status changes to flip the activity's phase.
  /// Same CFNotificationCenter Darwin pattern as AppGroupStorageModule.
  func startObserving() {
    guard !isObserving else { return }
    isObserving = true

    let center = CFNotificationCenterGetDarwinNotifyCenter()
    let observer = Unmanaged.passUnretained(self).toOpaque()
    CFNotificationCenterAddObserver(
      center,
      observer,
      { (_, observer, _, _, _) in
        guard let observer else { return }
        let controller = Unmanaged<LiveActivityController>.fromOpaque(observer).takeUnretainedValue()
        DispatchQueue.main.async { controller.handleKeyboardStatusChanged() }
      },
      statusNotificationName as CFString,
      nil,
      .deliverImmediately
    )
    CFNotificationCenterAddObserver(
      center,
      observer,
      { (_, observer, _, _, _) in
        guard let observer else { return }
        let controller = Unmanaged<LiveActivityController>.fromOpaque(observer).takeUnretainedValue()
        DispatchQueue.main.async { controller.handleDictationModeChanged() }
      },
      dictationModeNotificationName as CFString,
      nil,
      .deliverImmediately
    )
    // Cold-handoff safety net: the URL handler can call startSession() while the
    // scene is still .inactive, so Activity.request fails. Re-attempt the start
    // the moment the app is genuinely foreground-active (idempotent — startOnMain
    // no-ops if an activity already exists).
    foregroundObserverToken = NotificationCenter.default.addObserver(
      forName: UIApplication.didBecomeActiveNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      guard #available(iOS 16.2, *), let self else { return }
      if self.isDictationModeEnabled() || self.isRecordingActive() { self.startOnMain() }
    }
    log.info("Observing keyboard recording status")
  }

  private func handleKeyboardStatusChanged() {
    DispatchQueue.main.async { [weak self] in
      guard #available(iOS 16.2, *) else { return }
      self?.updateOnMain()
    }
  }

  private func handleDictationModeChanged() {
    DispatchQueue.main.async { [weak self] in
      guard #available(iOS 16.2, *), let self else { return }
      if self.isDictationModeEnabled() {
        self.startOnMain()
      } else {
        LiveActivityController.endOnMain()
      }
    }
  }

  // MARK: - Lifecycle

  /// Start the session activity if dictation mode is on and none is running.
  /// Must be called while the app is foreground (in-app toggle or cold-handoff).
  func startSession() {
    DispatchQueue.main.async { [weak self] in
      guard #available(iOS 16.2, *) else { return }
      self?.startOnMain()
    }
  }

  func endSession() {
    DispatchQueue.main.async {
      guard #available(iOS 16.2, *) else { return }
      LiveActivityController.endOnMain()
    }
  }

  @available(iOS 16.2, *)
  private func startOnMain() {
    #if canImport(ActivityKit)
    guard isDictationModeEnabled() || isRecordingActive() else {
      log.info("Dictation mode off and not recording; skipping start")
      return
    }
    guard ActivityAuthorizationInfo().areActivitiesEnabled else {
      log.info("Live Activities disabled by the user; skipping")
      return
    }
    guard Activity<RecordingActivityAttributes>.activities.isEmpty else {
      log.info("Session activity already running; skipping start")
      return
    }
    let isRecording = sharedDefaults?.string(forKey: "keyboard_recording_active") == "1"
    let state = RecordingActivityAttributes.ContentState(
      phase: isRecording ? .recording : .idle, startedAt: Date())
    do {
      _ = try Activity.request(
        attributes: RecordingActivityAttributes(),
        content: ActivityContent(state: state, staleDate: Date(timeIntervalSinceNow: 60 * 60)),
        pushType: nil)
      log.info("Session Live Activity started")
    } catch {
      log.error("Failed to start Live Activity: \(error.localizedDescription, privacy: .public)")
    }
    #endif
  }

  @available(iOS 16.2, *)
  private func updateOnMain() {
    #if canImport(ActivityKit)
    let isRecording = isRecordingActive()
    // A recording-only pill (dictation mode off) has nothing to show once the
    // recording stops — end it instead of leaving an idle pill lingering. With
    // dictation mode on, the session pill persists as idle between dictations.
    if !isRecording && !isDictationModeEnabled() {
      LiveActivityController.endOnMain()
      return
    }
    guard let activity = Activity<RecordingActivityAttributes>.activities.first else { return }
    let state = RecordingActivityAttributes.ContentState(
      phase: isRecording ? .recording : .idle, startedAt: Date())
    Task {
      await activity.update(
        ActivityContent(state: state, staleDate: Date(timeIntervalSinceNow: 60 * 60)))
    }
    #endif
  }

  @available(iOS 16.2, *)
  private static func endOnMain() {
    #if canImport(ActivityKit)
    Task {
      for activity in Activity<RecordingActivityAttributes>.activities {
        await activity.end(nil, dismissalPolicy: .immediate)
      }
    }
    #endif
  }
}
