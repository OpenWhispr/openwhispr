import Foundation
import UIKit
import os.log

#if canImport(ActivityKit)
import ActivityKit
#endif

/// Owns the single recording Live Activity. Two sources share it: keyboard
/// "dictation mode" (updated from the background via Darwin notifications) and an
/// in-app meeting (driven from JS). Every trigger goes through LiveActivityResolver,
/// so a meeting always wins and hands the activity back when it ends. One activity
/// instead of two because `Activity.request` only succeeds in the foreground while
/// `update` works from the background, which is where a lock-screen End tap lands.
/// All state is main-queue only.
final class LiveActivityController {
  static let shared = LiveActivityController()

  private let log = Logger(subsystem: "com.gizmolabs.openwhispr", category: "LiveActivity")

  private init() {}

  private var bundleId: String { Bundle.main.bundleIdentifier ?? "com.gizmolabs.openwhispr" }
  private var statusNotificationName: String { "\(bundleId).keyboardStatusChanged" }
  private var dictationModeNotificationName: String { "\(bundleId).dictationModeChanged" }
  private var endMeetingNotificationName: String { "\(bundleId).endMeetingRequested" }
  private var sharedDefaults: UserDefaults? { UserDefaults(suiteName: "group.\(bundleId)") }
  private var isObserving = false
  private var foregroundObserverToken: NSObjectProtocol?

  /// Non-nil while MeetingRecordScreen has a meeting recording or processing.
  private var meeting: MeetingSnapshot?
  /// Held from a lock-screen End until the meeting clears, since background audio
  /// stops keeping the app alive once the mic stops.
  private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
  private var endMeetingHandler: (() -> Void)?
  /// Tail of the ActivityKit operation queue. Independent Tasks per reconcile could
  /// land out of order (a lock-screen End's "Processing notes…" arriving after the
  /// hand-back to dictation would stick forever), so each operation resolves and
  /// applies only after the previous one finishes.
  private var opChain: Task<Void, Never>?

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

  // MARK: - Observation

  func startObserving() {
    onMain {
      guard !self.isObserving else { return }
      self.isObserving = true

      self.addDarwinObserver(self.statusNotificationName) { $0.reconcile() }
      self.addDarwinObserver(self.dictationModeNotificationName) { $0.reconcile() }
      self.addDarwinObserver(self.endMeetingNotificationName) { $0.handleEndMeetingRequested() }
      // Cold-handoff safety net: the URL handler can call startSession() while the
      // scene is still .inactive, so Activity.request fails. Re-attempt the start
      // the moment the app is genuinely foreground-active. Request-only: an existing
      // card showing the right mode and phase is left untouched so a running keyboard
      // timer isn't reset; a wrong one heals.
      self.foregroundObserverToken = NotificationCenter.default.addObserver(
        forName: UIApplication.didBecomeActiveNotification,
        object: nil,
        queue: .main
      ) { _ in
        // The controller is a process-lifetime singleton, like the Darwin boxes.
        self.reconcile(requestOnly: true)
      }
      self.log.info("Observing keyboard, dictation-mode, and end-meeting notifications")
    }
  }

  private func addDarwinObserver(
    _ name: String, handler: @escaping (LiveActivityController) -> Void
  ) {
    let box = Unmanaged.passRetained(DarwinHandlerBox(controller: self, handler: handler))
    CFNotificationCenterAddObserver(
      CFNotificationCenterGetDarwinNotifyCenter(),
      box.toOpaque(),
      { (_, observer, _, _, _) in
        guard let observer else { return }
        let box = Unmanaged<DarwinHandlerBox>.fromOpaque(observer).takeUnretainedValue()
        DispatchQueue.main.async { box.handler(box.controller) }
      },
      name as CFString,
      nil,
      .deliverImmediately
    )
  }

  // MARK: - JS runtime lifecycle

  func setEndMeetingHandler(_ handler: @escaping () -> Void) {
    onMain { self.endMeetingHandler = handler }
  }

  /// The JS runtime just (re)started, so no meeting can exist yet. Anything left
  /// from before (dev reload, crash, background relaunch) is an orphan.
  func resetForNewJSRuntime() {
    onMain {
      self.meeting = nil
      self.endBackgroundWork()
      if self.isShowingMeeting() { self.reconcile() }
    }
  }

  // MARK: - Meeting (driven from MeetingRecordScreen)

  func startMeeting(title: String?, startedAt: Date) {
    onMain {
      // A task still held from the previous meeting's lock-screen End must not
      // leak into this one.
      self.endBackgroundWork()
      self.meeting = MeetingSnapshot(title: title, startedAt: startedAt, phase: .recording)
      self.reconcile()
    }
  }

  func setMeetingProcessing(recordedSeconds: Int) {
    onMain {
      guard let current = self.meeting else { return }
      self.meeting = MeetingSnapshot(
        title: current.title, startedAt: current.startedAt,
        phase: .processing(recordedSeconds: max(0, recordedSeconds)))
      self.reconcile()
    }
  }

  func endMeeting() {
    onMain {
      self.meeting = nil
      // Release the background task only once the hand-back has landed.
      self.reconcile { self.endBackgroundWork() }
    }
  }

  private func handleEndMeetingRequested() {
    guard let current = meeting else {
      // Orphaned card (its meeting's process is gone): clear it.
      reconcile()
      return
    }
    guard case .recording = current.phase else { return }
    beginBackgroundWork()
    let recordedSeconds = max(0, Int(Date().timeIntervalSince(current.startedAt)))
    meeting = MeetingSnapshot(
      title: current.title, startedAt: current.startedAt,
      phase: .processing(recordedSeconds: recordedSeconds))
    reconcile()
    endMeetingHandler?()
  }

  // MARK: - Session (keyboard handoff API)

  /// Start the session activity if the resolver says one should show and none is
  /// running (a running one is only corrected if its mode or phase is wrong). Must
  /// be called while the app is foreground.
  func startSession() {
    onMain { self.reconcile(requestOnly: true) }
  }

  /// Ends the dictation session card. A meeting owns the card while it runs, so
  /// this is ignored until the meeting ends.
  func endSession() {
    onMain {
      guard self.meeting == nil else { return }
      self.endAll(completion: nil)
    }
  }

  // MARK: - Background work

  private func beginBackgroundWork() {
    guard backgroundTask == .invalid else { return }
    backgroundTask = UIApplication.shared.beginBackgroundTask(
      withName: "OpenWhisprMeetingFinish"
    ) { [weak self] in
      self?.endBackgroundWork()
    }
  }

  private func endBackgroundWork() {
    guard backgroundTask != .invalid else { return }
    UIApplication.shared.endBackgroundTask(backgroundTask)
    backgroundTask = .invalid
  }

  // MARK: - Resolve + apply

  private func onMain(_ work: @escaping () -> Void) {
    if Thread.isMainThread { work() } else { DispatchQueue.main.async(execute: work) }
  }

  /// Main only. The operation runs on the main actor once every earlier one is done.
  private func enqueue(_ operation: @escaping @MainActor () async -> Void) {
    let previous = opChain
    opChain = Task { @MainActor in
      await previous?.value
      await operation()
    }
  }

  /// Resolves when the operation runs, not when it is queued, so it acts on the
  /// latest state and on the activities left by the operations before it.
  private func reconcile(requestOnly: Bool = false, completion: (() -> Void)? = nil) {
    #if canImport(ActivityKit)
    if #available(iOS 16.2, *) {
      enqueue {
        await self.reconcileActivity(requestOnly: requestOnly)
        completion?()
      }
      return
    }
    #endif
    completion?()
  }

  private func endAll(completion: (() -> Void)?) {
    #if canImport(ActivityKit)
    if #available(iOS 16.2, *) {
      enqueue {
        await self.endAllActivities()
        completion?()
      }
      return
    }
    #endif
    completion?()
  }

  private func isShowingMeeting() -> Bool {
    #if canImport(ActivityKit)
    if #available(iOS 16.2, *) {
      return Activity<RecordingActivityAttributes>.activities.contains {
        $0.content.state.mode == .meeting
      }
    }
    #endif
    return false
  }

  #if canImport(ActivityKit)
  @available(iOS 16.2, *)
  @MainActor
  private func reconcileActivity(requestOnly: Bool) async {
    let now = Date()
    guard
      let state = LiveActivityResolver.resolve(
        meeting: meeting,
        keyboardRecording: isRecordingActive(),
        dictationMode: isDictationModeEnabled(),
        now: now)
    else {
      await endAllActivities()
      return
    }
    let content = ActivityContent(
      state: state, staleDate: LiveActivityResolver.staleDate(for: state, now: now))

    // Ended activities can linger in `.activities` on the lock screen (e.g. past
    // the 8-hour ActivityKit cap), so only a live one can be updated in place —
    // otherwise fall through and request a fresh activity.
    if let activity = Activity<RecordingActivityAttributes>.activities.first(where: {
      $0.activityState == .active || $0.activityState == .stale
    }) {
      // Only `startedAt` differs on a card already showing the right mode and phase,
      // and updating it would reset a running keyboard timer.
      let shown = activity.content.state
      if requestOnly && shown.mode == state.mode && shown.phase == state.phase { return }
      await activity.update(content)
      return
    }

    // `request` fails from the background anyway; .inactive still tries, since a
    // cold handoff calls startSession() before the scene becomes active.
    guard UIApplication.shared.applicationState != .background else {
      log.info("App is in the background; not requesting a Live Activity")
      return
    }
    guard ActivityAuthorizationInfo().areActivitiesEnabled else {
      log.info("Live Activities disabled by the user; skipping")
      return
    }
    do {
      _ = try Activity.request(
        attributes: RecordingActivityAttributes(), content: content, pushType: nil)
      log.info("Live Activity started (\(state.mode.rawValue, privacy: .public))")
    } catch {
      // Expected while the scene is still .inactive; the foreground observer retries.
      log.error("Failed to start Live Activity: \(error.localizedDescription, privacy: .public)")
    }
  }

  @available(iOS 16.2, *)
  @MainActor
  private func endAllActivities() async {
    for activity in Activity<RecordingActivityAttributes>.activities {
      await activity.end(nil, dismissalPolicy: .immediate)
    }
  }
  #endif
}

/// Carries a Darwin observer's handler through the C callback's context pointer.
/// Retained for the process lifetime, like the controller singleton itself.
private final class DarwinHandlerBox {
  let controller: LiveActivityController
  let handler: (LiveActivityController) -> Void

  init(controller: LiveActivityController, handler: @escaping (LiveActivityController) -> Void) {
    self.controller = controller
    self.handler = handler
  }
}
