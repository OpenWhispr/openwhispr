import Foundation

/// App Group keys shared with the keyboard extension (KeyboardViewController.swift)
/// and AppGroupStorageModule.swift. The values must stay identical to theirs:
/// the hotkey drives the keyboard's recording handshake, it doesn't have its own.
enum HotkeyKeys {
  static let pendingTranscript = "keyboard_pending_transcript"
  static let pendingTranscriptJobId = "keyboard_pending_transcript_job_id"
  static let orphanedRawTranscript = "keyboard_orphaned_raw_transcript"
  static let orphanedRawTranscriptJobId = "keyboard_orphaned_raw_transcript_job_id"
  static let recordingJobId = "keyboard_recording_job_id"
  static let recordingActive = "keyboard_recording_active"
  static let audioLevel = "keyboard_audio_level"
  static let stopRequested = "keyboard_stop_requested"
  static let stopRequestedAtMs = "keyboard_stop_requested_at_ms"
  static let backgroundSessionReady = "background_session_ready"
  static let backgroundSessionHeartbeat = "background_session_heartbeat"
  static let transcriptionStatus = "keyboard_transcription_status"
  static let transcriptionError = "keyboard_transcription_error"
  static let transcriptionStatusUpdatedAtMs = "keyboard_transcription_status_updated_at_ms"
  /// "<pid>:<ms>", written through AppGroupStorageModule.markHotkeyJsReady once
  /// useKeyboardHandoff's recording listeners are subscribed.
  static let hotkeyJsReadyAtMs = "hotkey_js_ready_at_ms"
}

enum HotkeyNotification {
  static let startRecording = "startRecording"
  static let stopRecording = "stopRecording"
  static let keyboardStatusChanged = "keyboardStatusChanged"
  static let transcriptReady = "transcriptReady"

  static func name(_ suffix: String, bundleId: String) -> String { "\(bundleId).\(suffix)" }
}

struct HotkeySnapshot: Equatable {
  var recordingActive: Bool
  var sessionReady: Bool
  var heartbeatAgeMs: Int?
  var status: String?
  var statusAgeMs: Int?
  /// In-process: a hotkey recording is being watched until its transcript is delivered.
  var deliveryPending: Bool
  /// In-process: a hotkey start is in flight (cold JS wait, or waiting for the recording flag).
  var startInProgress: Bool
  /// This process's JS listeners are subscribed (pid-scoped stamp). Until then the
  /// shared flags may still describe a process that was just killed.
  var jsReady: Bool
  var canColdStart: Bool
}

enum PressAction: Equatable {
  case stop, ignoreStarting, ignoreBusy, startWarm, startCold, explain
}

enum DeliveryOutcome: Equatable {
  case copy(String), noSpeech, failed, pending, recording
}

/// Only the newest banner's removal timer may clear it; an older banner's timer
/// must not remove the one that replaced it.
struct BannerGenerations {
  private var current = 0

  mutating func next() -> Int {
    current += 1
    return current
  }

  func isCurrent(_ generation: Int) -> Bool { generation == current }
}

enum HotkeyBanner: Equatable {
  case copied, stillTranscribing, openApp, noSpeech, failed

  var body: String {
    switch self {
    case .copied: return "Copied — press ⌘V to paste"
    case .stillTranscribing: return "Still transcribing…"
    case .openApp: return "Open OpenWhispr to turn on dictation mode"
    case .noSpeech: return "No speech detected"
    case .failed: return "Couldn't transcribe — open OpenWhispr"
    }
  }
}

enum ColdStartResult: Equatable {
  case started, jsNotReady, startFailed
}

struct ColdStartDeps {
  var isJsReady: () -> Bool
  var startWarm: () async -> Bool
  var sleepMs: (Int) async -> Void
  var nowMs: () -> Int
}

enum HotkeyDecision {
  /// The host app stamps its heartbeat every second while alive.
  static let heartbeatFreshMs = 5_000
  /// A busy status older than this is a leftover from a dead job.
  static let busyStatusMaxAgeMs = 300_000
  static let warmStartTimeoutMs = 2_000
  static let jsReadyTimeoutMs = 8_000
  static let deliveryTimeoutMs = 300_000
  static let pollMs = 100
  static let busyStatuses: Set<String> = ["transcribing", "cleaning", "agent_generating"]
  static let timeoutOutcome: DeliveryOutcome = .failed

  static func isHeartbeatFresh(_ snapshot: HotkeySnapshot) -> Bool {
    guard let age = snapshot.heartbeatAgeMs else { return false }
    return age <= heartbeatFreshMs
  }

  static func isRecording(_ snapshot: HotkeySnapshot) -> Bool {
    snapshot.recordingActive && isHeartbeatFresh(snapshot)
  }

  static func isWarm(_ snapshot: HotkeySnapshot) -> Bool {
    snapshot.sessionReady && isHeartbeatFresh(snapshot)
  }

  static func decidePress(_ snapshot: HotkeySnapshot) -> PressAction {
    // A start in flight owns the hotkey until it has seen its recording begin; a stop
    // slipped in here would end that recording before the starting press notices.
    if snapshot.startInProgress { return .ignoreStarting }
    // Shared flags are trusted only once this process's JS is listening: a killed
    // process leaves "ready"/"recording" and a fresh heartbeat behind for up to 5 s.
    // Recording comes before deliveryPending, which is also true while a hotkey
    // recording runs (the watcher is armed at start).
    if snapshot.jsReady && isRecording(snapshot) { return .stop }
    if snapshot.deliveryPending { return .ignoreBusy }
    if snapshot.jsReady {
      let busyStatus = snapshot.status.map { busyStatuses.contains($0) } ?? false
      let statusFresh = snapshot.statusAgeMs.map { $0 <= busyStatusMaxAgeMs } ?? false
      if busyStatus && statusFresh { return .ignoreBusy }
      if isWarm(snapshot) { return .startWarm }
    }
    if snapshot.canColdStart { return .startCold }
    return .explain
  }

  /// The ready stamp is "<pid>:<ms>". A stamp left by a process that died without
  /// running the hook's cleanup must not make a fresh process look ready.
  static func isJsReadyStamp(_ raw: String?, pid: Int32) -> Bool {
    guard let raw, let separator = raw.firstIndex(of: ":") else { return false }
    return Int32(raw[raw.startIndex..<separator]) == pid
  }

  /// The delivery clock runs only once the recording has ended (by any path), so a
  /// long dictation never times out while it is still being spoken.
  static func nextDeliveryDeadline(current: Int?, outcome: DeliveryOutcome, nowMs: Int) -> Int? {
    if outcome == .recording { return nil }
    return current ?? nowMs + deliveryTimeoutMs
  }

  /// `recordingActive` is the live recording flag (fresh heartbeat). It wins over
  /// the shared status, which a previous job's delayed JS cleanup can overwrite
  /// with "idle" while the next recording is running.
  static func deliveryOutcome(
    jobId: String,
    pendingTranscript: String?,
    pendingJobId: String?,
    status: String?,
    recordingActive: Bool = false
  ) -> DeliveryOutcome {
    if let text = pendingTranscript, !text.isEmpty, pendingJobId == jobId { return .copy(text) }
    if recordingActive { return .recording }
    switch status {
    case "recording": return .recording
    case "no_speech": return .noSpeech
    // "idle" after a stop means the job ended without leaving a transcript for us.
    case "error", "setup_required", "idle": return .failed
    default: return .pending
    }
  }

  static func banner(for outcome: DeliveryOutcome) -> HotkeyBanner? {
    switch outcome {
    case .copy: return .copied
    case .noSpeech: return .noSpeech
    case .failed: return .failed
    case .pending, .recording: return nil
    }
  }

  static func waitUntil(
    timeoutMs: Int,
    pollMs: Int = HotkeyDecision.pollMs,
    nowMs: () -> Int,
    sleepMs: (Int) async -> Void,
    _ check: () -> Bool
  ) async -> Bool {
    let deadline = nowMs() + timeoutMs
    while true {
      if check() { return true }
      if nowMs() >= deadline { return false }
      await sleepMs(pollMs)
    }
  }

  /// Cold start never records before JS is listening: on a background launch the
  /// native start/stop events would otherwise fire before useKeyboardHandoff
  /// subscribes, losing the route snapshot and, for short dictations, the audio.
  static func runColdStart(_ deps: ColdStartDeps) async -> ColdStartResult {
    let ready = await waitUntil(
      timeoutMs: jsReadyTimeoutMs, nowMs: deps.nowMs, sleepMs: deps.sleepMs, deps.isJsReady)
    guard ready else { return .jsNotReady }
    return await deps.startWarm() ? .started : .startFailed
  }
}
