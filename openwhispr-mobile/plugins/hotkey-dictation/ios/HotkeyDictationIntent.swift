import AppIntents
import Foundation

/// Bound by the user to a key combo under Accessibility → Keyboards → Full
/// Keyboard Access → Commands → Shortcuts. iPadOS hides third-party keyboards
/// while a hardware keyboard is attached, so this is how an iPad user with a
/// Magic Keyboard dictates into other apps; the result goes to the clipboard.
/// Returns no dialog: a result card needs a manual Done, and pressing the combo
/// again would re-run the intent instead of dismissing it.
struct ToggleHotkeyDictationIntent: AppIntent {
  static var title: LocalizedStringResource = "Toggle OpenWhispr Dictation"
  static var description = IntentDescription(
    "Starts dictation. Run it again to stop and copy the transcript to the clipboard.")
  static var openAppWhenRun: Bool = false

  func perform() async throws -> some IntentResult {
    guard let session = HotkeyDictationSession() else {
      HotkeyDictationSession.log.error("press.noAppGroup")
      return .result()
    }
    // No AudioRecordingIntent: its framework check fatally crashes the app when
    // perform() returns with an active audio session and no Live Activity, and the
    // dictation-mode warm mic keeps the session active while a background launch
    // cannot start a Live Activity ("Target is not foreground"). A cold start is
    // still attempted; if iOS refuses the background mic, it falls back to Explain.
    let action = await HotkeyPressCoordinator.shared.claim(session: session, canColdStart: true)
    HotkeyDictationSession.log.info("press action=\(String(describing: action), privacy: .public)")

    switch action {
    case .stop:
      // A hotkey recording is already watched from its start; a keyboard dictation
      // this press stops is left to the keyboard to deliver.
      session.stop()
      HotkeyFeedback.playEnd()
    case .ignoreStarting:
      break
    case .ignoreBusy:
      HotkeyFeedback.show(.stillTranscribing)
    case .startWarm:
      await finishStart(started: await session.startWarm(), session: session)
    case .startCold:
      let result = await HotkeyDecision.runColdStart(ColdStartDeps(
        isJsReady: { session.isJsReady },
        startWarm: { await session.startWarm() },
        sleepMs: HotkeyDictationSession.sleepMs,
        nowMs: HotkeyDictationSession.nowMs))
      HotkeyDictationSession.log.info("coldStart result=\(String(describing: result), privacy: .public)")
      await finishStart(started: result == .started, session: session)
    case .explain:
      HotkeyFeedback.show(.openApp)
    }
    return .result()
  }

  /// Hands a started recording to the watcher before releasing the start slot, so
  /// no press can slip between the two and be misread as idle.
  private func finishStart(started: Bool, session: HotkeyDictationSession) async {
    let jobId = session.startedJobId
    await MainActor.run {
      if started, let jobId {
        HotkeyDeliveryWatcher.shared.watch(jobId: jobId, session: session)
      }
      HotkeyPressCoordinator.shared.releaseStart()
    }
    if started {
      HotkeyFeedback.playBegin()
    } else {
      HotkeyFeedback.show(.openApp)
    }
  }
}

/// Decides a press and, for a start, claims the start slot in one main-actor step,
/// so two presses in flight at once (e.g. a second press during the cold JS wait)
/// can never both start a recording.
@MainActor
final class HotkeyPressCoordinator {
  static let shared = HotkeyPressCoordinator()

  private var startInProgress = false

  private init() {}

  func claim(session: HotkeyDictationSession, canColdStart: Bool) -> PressAction {
    let action = HotkeyDecision.decidePress(session.snapshot(
      canColdStart: canColdStart,
      deliveryPending: HotkeyDeliveryWatcher.shared.isWatching,
      startInProgress: startInProgress))
    if action == .startWarm || action == .startCold { startInProgress = true }
    return action
  }

  func releaseStart() { startInProgress = false }
}


struct OpenWhisprAppShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: ToggleHotkeyDictationIntent(),
      phrases: ["Toggle \(.applicationName) dictation"],
      shortTitle: "Toggle Dictation",
      systemImageName: "mic")
  }
}
