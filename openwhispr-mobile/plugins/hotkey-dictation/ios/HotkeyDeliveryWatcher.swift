import Foundation
import UIKit

/// Watches a hotkey recording from the moment it starts until its transcript is
/// copied. Starting at the recording (not at the stop press) means a hotkey
/// dictation is delivered however it ends: a second press, an audio interruption,
/// or a stop from the app. The delivery clock only runs once the recording has
/// ended. Lives for the process; one job at a time (decidePress refuses a new
/// start while `isWatching`). Main thread only.
final class HotkeyDeliveryWatcher {
  static let shared = HotkeyDeliveryWatcher()

  private var jobId: String?
  private var session: HotkeyDictationSession?
  private var deadlineMs: Int?
  private var timer: Timer?
  private var isObserving = false

  private init() {}

  var isWatching: Bool { jobId != nil }

  func watch(jobId: String, session: HotkeyDictationSession) {
    self.jobId = jobId
    self.session = session
    deadlineMs = nil
    startObserving(bundleId: session.bundleId)
    timer?.invalidate()
    // Fallback for a missed Darwin post; the observers make the common case instant.
    timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in
      HotkeyDeliveryWatcher.shared.check()
    }
    HotkeyDictationSession.log.info("delivery.watch jobId=\(jobId, privacy: .public)")
    check()
  }

  func check() {
    guard let jobId, let session else { return }
    var outcome = session.readDelivery(jobId: jobId)
    let nowMs = HotkeyDictationSession.nowMs()
    deadlineMs = HotkeyDecision.nextDeliveryDeadline(current: deadlineMs, outcome: outcome, nowMs: nowMs)
    if outcome == .recording || outcome == .pending {
      guard let deadlineMs, nowMs >= deadlineMs else { return }
      outcome = HotkeyDecision.timeoutOutcome
    }
    if case .copy(let text) = outcome {
      UIPasteboard.general.string = text
      session.consumeTranscript()
      HotkeyDictationSession.log.info("delivery.copied chars=\(text.count, privacy: .public)")
    } else {
      HotkeyDictationSession.log.info("delivery.ended outcome=\(String(describing: outcome), privacy: .public)")
    }
    finish(banner: HotkeyDecision.banner(for: outcome))
  }

  private func finish(banner: HotkeyBanner?) {
    timer?.invalidate()
    timer = nil
    jobId = nil
    session = nil
    deadlineMs = nil
    if let banner { HotkeyFeedback.show(banner) }
  }

  private func startObserving(bundleId: String) {
    guard !isObserving else { return }
    isObserving = true
    let callback: CFNotificationCallback = { _, _, _, _, _ in
      DispatchQueue.main.async { HotkeyDeliveryWatcher.shared.check() }
    }
    for suffix in [HotkeyNotification.transcriptReady, HotkeyNotification.keyboardStatusChanged] {
      CFNotificationCenterAddObserver(
        CFNotificationCenterGetDarwinNotifyCenter(),
        Unmanaged.passUnretained(self).toOpaque(),
        callback,
        HotkeyNotification.name(suffix, bundleId: bundleId) as CFString,
        nil,
        .deliverImmediately)
    }
  }
}
