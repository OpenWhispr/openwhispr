import Foundation
import os.log

/// The App Group handshake the keyboard extension uses (KeyboardHandoffProvider
/// requestStart/requestStop in KeyboardViewController.swift), driven from the
/// hotkey intent so hotkey recordings take exactly the keyboard's recording path.
final class HotkeyDictationSession {
  static let log = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "com.gizmolabs.openwhispr",
    category: "HotkeyDictation")

  let bundleId: String
  private let defaults: UserDefaults

  init?() {
    let bundleId = Bundle.main.bundleIdentifier ?? "com.gizmolabs.openwhispr"
    guard let defaults = UserDefaults(suiteName: "group.\(bundleId)") else { return nil }
    self.bundleId = bundleId
    self.defaults = defaults
  }

  static func nowMs() -> Int { Int(Date().timeIntervalSince1970 * 1000) }

  static func sleepMs(_ ms: Int) async {
    try? await Task.sleep(nanoseconds: UInt64(ms) * 1_000_000)
  }

  private func ageMs(_ key: String) -> Int? {
    guard let raw = defaults.string(forKey: key), let stampMs = Double(raw) else { return nil }
    return Self.nowMs() - Int(stampMs)
  }

  /// `deliveryPending` and `startInProgress` are in-process state (the intent and the
  /// watcher share the app process), so no App Group key can leave them stuck.
  func snapshot(canColdStart: Bool, deliveryPending: Bool, startInProgress: Bool) -> HotkeySnapshot {
    HotkeySnapshot(
      recordingActive: defaults.string(forKey: HotkeyKeys.recordingActive) == "1",
      sessionReady: defaults.string(forKey: HotkeyKeys.backgroundSessionReady) == "1",
      heartbeatAgeMs: ageMs(HotkeyKeys.backgroundSessionHeartbeat),
      status: defaults.string(forKey: HotkeyKeys.transcriptionStatus),
      statusAgeMs: ageMs(HotkeyKeys.transcriptionStatusUpdatedAtMs),
      deliveryPending: deliveryPending,
      startInProgress: startInProgress,
      jsReady: isJsReady,
      canColdStart: canColdStart)
  }

  var isJsReady: Bool {
    HotkeyDecision.isJsReadyStamp(
      defaults.string(forKey: HotkeyKeys.hotkeyJsReadyAtMs), pid: getpid())
  }

  var isRecording: Bool {
    HotkeyDecision.isRecording(snapshot(canColdStart: false, deliveryPending: false, startInProgress: false))
  }

  /// The job id of the recording the last successful startWarm() began.
  private(set) var startedJobId: String?

  /// Mirrors KeyboardHandoffProvider.requestStart, then waits for the app's start
  /// observer to report the recording.
  func startWarm() async -> Bool {
    let startedAt = Self.nowMs()
    let jobId = "\(startedAt)-\(UUID().uuidString)"
    defaults.set("0", forKey: HotkeyKeys.stopRequested)
    defaults.removeObject(forKey: HotkeyKeys.stopRequestedAtMs)
    defaults.set("0", forKey: HotkeyKeys.recordingActive)
    defaults.removeObject(forKey: HotkeyKeys.audioLevel)
    defaults.removeObject(forKey: HotkeyKeys.pendingTranscript)
    defaults.removeObject(forKey: HotkeyKeys.pendingTranscriptJobId)
    defaults.removeObject(forKey: HotkeyKeys.orphanedRawTranscript)
    defaults.removeObject(forKey: HotkeyKeys.orphanedRawTranscriptJobId)
    defaults.set(jobId, forKey: HotkeyKeys.recordingJobId)
    defaults.set("recording", forKey: HotkeyKeys.transcriptionStatus)
    defaults.set(String(startedAt), forKey: HotkeyKeys.transcriptionStatusUpdatedAtMs)
    defaults.removeObject(forKey: HotkeyKeys.transcriptionError)
    // Flush before the post: the app's start handler records under whatever job id it reads.
    defaults.synchronize()
    post(HotkeyNotification.startRecording)

    let started = await HotkeyDecision.waitUntil(
      timeoutMs: HotkeyDecision.warmStartTimeoutMs, nowMs: Self.nowMs, sleepMs: Self.sleepMs
    ) { self.isRecording }
    startedJobId = started ? jobId : nil
    Self.log.info(
      "start jobId=\(jobId, privacy: .public) started=\(started, privacy: .public) latencyMs=\(Self.nowMs() - startedAt, privacy: .public)")
    return started
  }

  /// Mirrors KeyboardHandoffProvider.requestStop.
  func stop() {
    let nowMs = String(Self.nowMs())
    defaults.set("1", forKey: HotkeyKeys.stopRequested)
    defaults.set(nowMs, forKey: HotkeyKeys.stopRequestedAtMs)
    defaults.set("transcribing", forKey: HotkeyKeys.transcriptionStatus)
    defaults.set(nowMs, forKey: HotkeyKeys.transcriptionStatusUpdatedAtMs)
    defaults.synchronize()
    post(HotkeyNotification.stopRecording)
  }

  func readDelivery(jobId: String) -> DeliveryOutcome {
    HotkeyDecision.deliveryOutcome(
      jobId: jobId,
      pendingTranscript: defaults.string(forKey: HotkeyKeys.pendingTranscript),
      pendingJobId: defaults.string(forKey: HotkeyKeys.pendingTranscriptJobId),
      status: defaults.string(forKey: HotkeyKeys.transcriptionStatus),
      recordingActive: isRecording)
  }

  /// Takes the transcript off the keyboard's pending slot so the OpenWhispr
  /// keyboard never inserts it a second time the next time it opens.
  func consumeTranscript() {
    defaults.removeObject(forKey: HotkeyKeys.pendingTranscript)
    defaults.removeObject(forKey: HotkeyKeys.pendingTranscriptJobId)
    defaults.set("idle", forKey: HotkeyKeys.transcriptionStatus)
    defaults.set(String(Self.nowMs()), forKey: HotkeyKeys.transcriptionStatusUpdatedAtMs)
    defaults.removeObject(forKey: HotkeyKeys.transcriptionError)
    defaults.synchronize()
    post(HotkeyNotification.keyboardStatusChanged)
  }

  private func post(_ suffix: String) {
    CFNotificationCenterPostNotification(
      CFNotificationCenterGetDarwinNotifyCenter(),
      CFNotificationName(HotkeyNotification.name(suffix, bundleId: bundleId) as CFString),
      nil, nil, true)
  }
}
