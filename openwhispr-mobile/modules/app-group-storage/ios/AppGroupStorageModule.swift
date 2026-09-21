import ExpoModulesCore
import UIKit
import AVFoundation

public class AppGroupStorageModule: Module {
  private var appBundleId: String {
    Bundle.main.bundleIdentifier ?? "com.gizmolabs.openwhispr"
  }
  private var appGroupId: String {
    "group.\(appBundleId)"
  }
  private let stopRequestedKey = "keyboard_stop_requested"
  private let stopRequestedAtMsKey = "keyboard_stop_requested_at_ms"
  private let transcriptionStatusKey = "keyboard_transcription_status"
  private let transcriptionErrorKey = "keyboard_transcription_error"
  private let transcriptionStatusUpdatedAtMsKey = "keyboard_transcription_status_updated_at_ms"
  private let pendingTranscriptKey = "keyboard_pending_transcript"
  private let orphanedRawTranscriptKey = "keyboard_orphaned_raw_transcript"
  private let recordingJobIdKey = "keyboard_recording_job_id"
  private let preferredRecordingFormatKey = "keyboard_recording_format"
  // Agent mode — one-shot / per-job keys cleared on launch
  private let agentRequestKey = "keyboard_agent_request"
  private let agentJobKey = "keyboard_agent_job"
  private let agentResultKey = "keyboard_agent_result"
  private let agentActionKey = "keyboard_agent_action"
  private let agentActionAtMsKey = "keyboard_agent_action_at_ms"
  private static var notificationPrefix: String {
    Bundle.main.bundleIdentifier ?? "com.gizmolabs.openwhispr"
  }
  private static var darwinStopNotificationName: String {
    "\(notificationPrefix).stopRecording"
  }
  private static var darwinStartNotificationName: String {
    "\(notificationPrefix).startRecording"
  }
  private static var darwinStatusNotificationName: String {
    "\(notificationPrefix).keyboardStatusChanged"
  }
  private static var darwinTranscriptReadyNotificationName: String {
    "\(notificationPrefix).transcriptReady"
  }
  private static var darwinDictationModeChangedNotificationName: String {
    "\(notificationPrefix).dictationModeChanged"
  }
  private static var darwinAgentActionNotificationName: String {
    "\(notificationPrefix).agentAction"
  }
  private static let hostBundleFallbackUrls: [String: String] = [
    "com.whatsapp.WhatsApp": "whatsapp://send",
    "net.whatsapp.WhatsApp": "whatsapp://send",
    "net.whatsapp.WhatsAppSMB": "whatsapp-business://",
    "com.burbn.instagram": "instagram://",
    "com.atebits.Tweetie2": "twitter://",
    "com.facebook.Facebook": "fb://",
    "com.facebook.Messenger": "fb-messenger://",
    "com.tinyspeck.chatlyio": "slack://",
    "com.skype.skype": "skype://",
    "ph.telegra.Telegraph": "tg://",
    "org.whispersystems.signal": "sgnl://",
    "com.viber": "viber://",
    "jp.naver.line": "line://",
    "com.google.Gmail": "googlegmail://",
    "com.google.Docs": "googledocs://",
    "com.microsoft.Office.Outlook": "ms-outlook://",
    "com.microsoft.skype.teams": "msteams://",
    "com.apple.mobilemail": "message://",
    "com.apple.MobileSMS": "sms://",
    "com.apple.mobilenotes": "mobilenotes://",
    "com.microsoft.teams": "msteams://",
    "notion.id": "notion://",
    "com.discord.Discord": "discord://",
    "com.linkedin.LinkedIn": "linkedin://",
    "com.reddit.Reddit": "reddit://",
    "com.hammerandchisel.discord": "discord://",
    "us.zoom.videomeetings": "zoomus://",
    "com.openai.chat": "chatgpt://",
    "com.google.chrome.ios": "googlechrome://",
    "com.apple.mobilesafari": "x-web-search://",
    "com.zhiliaoapp.musically": "snssdk1128://",
    "com.snapchat.snapchat": "snapchat://",
    "com.toyopagroup.picaboo": "snapchat://"
  ]
  private static let normalizedHostBundleFallbackUrls: [String: String] = {
    var normalized: [String: String] = [:]
    for (bundle, url) in hostBundleFallbackUrls {
      normalized[bundle.lowercased()] = url
    }
    return normalized
  }()

  private let audioStateLock = NSLock()
  // Serializes session/engine lifecycle (start/stop/arm/release/rebuild).
  // startNativeRecording runs on the JS thread while the foreground re-arm and
  // Darwin handlers run on main; on an Activate handoff both try to
  // reconfigure the shared AVAudioSession at once, which intermittently fails
  // activation ("Session activation failed"). Recursive because stop/shutdown
  // nest inside the interruption handlers. Always acquired OUTSIDE
  // audioStateLock; the input tap only ever takes audioStateLock, so the
  // audio thread never waits on pipeline work.
  private let audioPipelineLock = NSRecursiveLock()
  private var audioEngine: AVAudioEngine?
  private var recordingFile: AVAudioFile?
  private var recordingFileUrl: URL?
  private var recordingConverter: AVAudioConverter?
  private var recordingTargetFormat: AVAudioFormat?
  private var isClipRecording: Bool = false
  private var clipStartedAtMs: Int64 = 0
  private var currentRecordingJobId: String?
  private var latestAudioLevel: Float = 0
  private var didLogFileWriteError: Bool = false
  // Liveness proof for the audio engine. audioEngine.isRunning lies after the
  // app is suspended with a warm mic: the frozen engine still reports running
  // on resume even though iOS deactivated its session, so no buffers flow.
  // Trusting it left armWarmMic short-circuiting forever and the keyboard
  // stuck on "Activate" until the app was killed.
  private var lastInputBufferAtMs: Int64 = 0
  private var engineStartedAtMs: Int64 = 0

  private var meteringTimer: Timer?
  private var keepAliveHeartbeatTimer: Timer?
  private var warmMicIdleTimer: Timer?
  private let warmMicIdleTimeoutSeconds: TimeInterval = 10 * 60  // 10 min, tunable (spec §3)
  private let dictationModeEnabledKey = "dictation_mode_enabled"
  private var backgroundTaskId: UIBackgroundTaskIdentifier = .invalid

  private var isObservingStopNotification: Bool = false
  private var isObservingStartNotification: Bool = false
  private var isObservingStatusNotification: Bool = false
  private var isObservingDictationModeNotification: Bool = false
  private var isObservingAgentActionNotification: Bool = false
  private var foregroundObserverToken: NSObjectProtocol?
  private var backgroundObserverToken: NSObjectProtocol?
  private var audioInterruptionObserverToken: NSObjectProtocol?
  private var mediaServicesResetObserverToken: NSObjectProtocol?
  // Refreshed while OpenWhispr is foreground so the keyboard can tell it is
  // hosted by our own app (record in place) rather than another app (hand off).
  private var foregroundHeartbeatTimer: Timer?
  private let containingAppForegroundKey = "containing_app_foreground_at_ms"

  private var returnNavigationInFlight: Bool = false
  private var lastReturnAttemptUrl: String?
  private var lastReturnAttemptAt: Date?

  public func definition() -> ModuleDefinition {
    Name("AppGroupStorage")

    Events(
      "onRecordingStopped",
      "onRecordingError",
      "onBackgroundRecordingStarted",
      "onKeyboardStatusChanged",
      "onAgentAction"
    )

    OnCreate {
      self.initializeSharedState()
      self.addDarwinStartObserver()
      self.addDarwinStatusObserver()
      self.addDarwinDictationModeObserver()
      self.addDarwinAgentActionObserver()
      self.addForegroundObserver()
      self.addBackgroundObserver()
      self.addAudioSessionObservers()
      DispatchQueue.main.async {
        if UIApplication.shared.applicationState == .active {
          self.startForegroundHeartbeat()
          if self.isDictationModeEnabled() {
            self.armWarmMic(reason: "onCreate")
          }
        }
      }
      self.logMarker("onCreate")
    }

    Function("setItem") { (key: String, value: String) -> Bool in
      guard let defaults = UserDefaults(suiteName: self.appGroupId) else {
        return false
      }
      defaults.set(value, forKey: key)
      defaults.synchronize()
      return defaults.string(forKey: key) == value
    }

    Function("getItem") { (key: String) -> String? in
      guard let defaults = UserDefaults(suiteName: self.appGroupId) else {
        return nil
      }
      defaults.synchronize()
      return defaults.string(forKey: key)
    }

    Function("removeItem") { (key: String) -> Bool in
      guard let defaults = UserDefaults(suiteName: self.appGroupId) else {
        return false
      }
      defaults.removeObject(forKey: key)
      defaults.synchronize()
      return defaults.object(forKey: key) == nil
    }

    Function("setKeyboardStatus") { (status: String, detail: String?) -> Void in
      self.setKeyboardStatus(status, detail: detail)
    }

    Function("markKeyboardTiming") { (name: String) -> Void in
      self.markKeyboardTiming(name)
    }

    AsyncFunction("analyzeSpeechActivity") { (fileUri: String, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          let result = try self.analyzeSpeechActivity(fileUri: fileUri)
          promise.resolve(result)
        } catch {
          promise.reject("SPEECH_ACTIVITY_ANALYSIS_FAILED", error.localizedDescription)
        }
      }
    }

    AsyncFunction("convertRecordingToWav") { (fileUri: String, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          let result = try self.convertRecordingToWav(fileUri: fileUri)
          promise.resolve(result)
        } catch {
          promise.reject("RECORDING_WAV_CONVERSION_FAILED", error.localizedDescription)
        }
      }
    }

    Function("getActiveInputModes") { () -> [String] in
      // Reads the user's currently installed iOS keyboards. Each returned
      // tag looks like "en-US", "he-IL", "emoji", etc. Used by the
      // onboarding language step to pre-select languages the user has
      // already configured as keyboards.
      let modes = UITextInputMode.activeInputModes
      return modes.compactMap { $0.primaryLanguage }
    }

    Function("returnToPreviousApp") { () -> Void in
      self.logMarker("returnToPreviousApp.invoked")
      DispatchQueue.main.async {
        // On a cold launch UIApplication.open can fail while the app is still
        // transitioning to active; a couple of short retries covers that
        // window. Retrying a failed open is safe — nothing happened.
        self.navigateBackToPreviousApp(maxRetries: 2)
      }
    }

    Function("startNativeRecording") { () -> Bool in
      return self.startRecording(trigger: "js.startNativeRecording")
    }

    Function("stopNativeRecording") { () -> Void in
      DispatchQueue.main.async {
        self.stopRecording(reason: "js.stopNativeRecording")
      }
    }

    Function("endProcessingTask") { () -> Void in
      self.endBackgroundTask()
    }

    // Called right after onboarding wins the mic permission. Warming is
    // otherwise only retried on the next foreground, which would leave the
    // keyboard reporting "not ready" for the rest of the session. Safe to call
    // when permission was refused — armWarmMic re-checks and no-ops.
    Function("armWarmMic") { () -> Void in
      DispatchQueue.main.async {
        self.armWarmMic(reason: "js.permissionGranted")
      }
    }

    OnDestroy {
      DispatchQueue.main.async {
        self.stopRecording(reason: "module.onDestroy")
        self.shutdownAudioPipeline(reason: "module.onDestroy")
        self.endBackgroundTask()
        self.removeDarwinStartObserver()
        self.removeDarwinStopObserver()
        self.removeDarwinStatusObserver()
        self.removeDarwinDictationModeObserver()
        self.removeDarwinAgentActionObserver()
        self.removeForegroundObserver()
        self.removeBackgroundObserver()
        self.removeAudioSessionObservers()
        self.stopForegroundHeartbeat()
        self.stopWarmMicIdleTimer()
        self.stopKeepAliveHeartbeat()
        // Graceful termination: preserve a not-yet-inserted agent RESULT so it
        // survives a clean quit the same way it survives jetsam — the keyboard
        // can still show/insert it on reopen (≤10 min). On-launch clearing (the
        // OnCreate path) still wipes it so a stale reply is never replayed later.
        self.initializeSharedState(preserveAgentResult: true)
        self.logMarker("onDestroy.dispatchedCleanup")
      }
    }
  }

  // MARK: - Shared State

  private func initializeSharedState(preserveAgentResult: Bool = false) {
    guard let defaults = UserDefaults(suiteName: appGroupId) else { return }
    defaults.set("0", forKey: "keyboard_recording_active")
    defaults.set("0", forKey: "background_session_ready")
    defaults.set("0", forKey: "background_session_warm_mic")
    defaults.removeObject(forKey: stopRequestedKey)
    defaults.removeObject(forKey: stopRequestedAtMsKey)
    defaults.removeObject(forKey: "keyboard_audio_level")
    defaults.removeObject(forKey: "background_session_heartbeat")
    defaults.removeObject(forKey: containingAppForegroundKey)
    defaults.removeObject(forKey: recordingJobIdKey)
    defaults.set("idle", forKey: transcriptionStatusKey)
    defaults.removeObject(forKey: transcriptionErrorKey)
    defaults.removeObject(forKey: transcriptionStatusUpdatedAtMsKey)
    // Agent one-shot / per-job keys: cleared on every launch so stale requests
    // from a previous session are never replayed. Config-mirror keys
    // (keyboard_agent_enabled / applicable / name / share_context) are NOT
    // cleared — they persist like the tone mirror keys.
    defaults.removeObject(forKey: agentRequestKey)
    defaults.removeObject(forKey: agentJobKey)
    defaults.removeObject(forKey: agentActionKey)
    defaults.removeObject(forKey: agentActionAtMsKey)
    // The RESULT key holds a generated-but-not-yet-inserted reply. On graceful
    // termination keep it so the keyboard can still insert it on reopen (matches
    // its jetsam survival); on launch it's always cleared so it can't be replayed.
    if !preserveAgentResult {
      defaults.removeObject(forKey: agentResultKey)
    }
    defaults.synchronize()
  }

  private func setSharedRecordingState(
    active: Bool,
    ready: Bool,
    clearStopRequested: Bool,
    clearAudioLevel: Bool
  ) {
    guard let defaults = UserDefaults(suiteName: appGroupId) else { return }

    defaults.set(active ? "1" : "0", forKey: "keyboard_recording_active")
    defaults.set(ready ? "1" : "0", forKey: "background_session_ready")
    defaults.set(ready ? "1" : "0", forKey: "background_session_warm_mic")

    if clearStopRequested {
      defaults.removeObject(forKey: stopRequestedKey)
      defaults.removeObject(forKey: stopRequestedAtMsKey)
    }
    if clearAudioLevel {
      defaults.removeObject(forKey: "keyboard_audio_level")
    }

    defaults.set(
      String(Int(Date().timeIntervalSince1970 * 1000)),
      forKey: "keyboard_recording_state_updated_at_ms"
    )
    defaults.synchronize()
  }

  private func sharedStateSnapshot() -> (active: String, ready: String, stopRequested: String, warm: String) {
    guard let defaults = UserDefaults(suiteName: appGroupId) else {
      return ("?", "?", "?", "?")
    }
    return (
      defaults.string(forKey: "keyboard_recording_active") ?? "-",
      defaults.string(forKey: "background_session_ready") ?? "-",
      defaults.string(forKey: stopRequestedKey) ?? "-",
      defaults.string(forKey: "background_session_warm_mic") ?? "-"
    )
  }

  private func setWarmMicState(isWarm: Bool) {
    guard let defaults = UserDefaults(suiteName: appGroupId) else { return }
    defaults.set(isWarm ? "1" : "0", forKey: "background_session_warm_mic")
    defaults.set(isWarm ? "1" : "0", forKey: "background_session_ready")
    defaults.synchronize()
  }

  private func setKeyboardStatus(_ status: String, detail: String? = nil) {
    guard let defaults = UserDefaults(suiteName: appGroupId) else { return }
    defaults.set(status, forKey: transcriptionStatusKey)
    defaults.set(String(Int(Date().timeIntervalSince1970 * 1000)), forKey: transcriptionStatusUpdatedAtMsKey)
    if let detail, !detail.isEmpty {
      defaults.set(detail, forKey: transcriptionErrorKey)
    } else if status != "error" {
      defaults.removeObject(forKey: transcriptionErrorKey)
    }
    defaults.synchronize()
    sendKeyboardStatusChanged(trigger: "setKeyboardStatus")
    postDarwinNotification(Self.darwinStatusNotificationName)
    if status == "ready" {
      postDarwinNotification(Self.darwinTranscriptReadyNotificationName)
    }
  }

  private func sendKeyboardStatusChanged(trigger: String) {
    let emit = {
      guard let defaults = UserDefaults(suiteName: self.appGroupId) else { return }
      var payload: [String: Any] = [
        "hasPendingTranscript": defaults.string(forKey: self.pendingTranscriptKey) != nil,
        "hasOrphanedRawTranscript": defaults.string(forKey: self.orphanedRawTranscriptKey) != nil
      ]
      if let status = defaults.string(forKey: self.transcriptionStatusKey) {
        payload["status"] = status
      }
      if let error = defaults.string(forKey: self.transcriptionErrorKey) {
        payload["error"] = error
      }
      if let updatedAtMs = defaults.string(forKey: self.transcriptionStatusUpdatedAtMsKey) {
        payload["updatedAtMs"] = updatedAtMs
      }
      if let jobId = defaults.string(forKey: self.recordingJobIdKey) {
        payload["jobId"] = jobId
      }
      payload["trigger"] = trigger
      self.sendEvent("onKeyboardStatusChanged", payload)
    }

    if Thread.isMainThread {
      emit()
    } else {
      DispatchQueue.main.async(execute: emit)
    }
  }

  private func markKeyboardTiming(_ name: String) {
    let sanitized = name.replacingOccurrences(of: "[^A-Za-z0-9_]", with: "_", options: .regularExpression)
    guard !sanitized.isEmpty,
          let defaults = UserDefaults(suiteName: appGroupId) else { return }
    defaults.set(
      String(Int(Date().timeIntervalSince1970 * 1000)),
      forKey: "keyboard_timing_\(sanitized)_ms"
    )
  }

  private func resolveAudioFileUrl(_ fileUri: String) -> URL {
    if fileUri.hasPrefix("file://"), let url = URL(string: fileUri) {
      return url
    }
    return URL(fileURLWithPath: fileUri)
  }

  private func analyzeSpeechActivity(fileUri: String) throws -> [String: Any] {
    let fileUrl = resolveAudioFileUrl(fileUri)
    let audioFile = try AVAudioFile(forReading: fileUrl)
    let format = audioFile.processingFormat
    let sampleRate = max(format.sampleRate, 1)
    let totalFrames = audioFile.length
    let durationMs = Double(totalFrames) / sampleRate * 1000
    let targetFrameCount = AVAudioFrameCount(max(256, Int(sampleRate * 0.02)))
    guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: targetFrameCount) else {
      throw NSError(domain: "AppGroupStorage", code: 4, userInfo: [
        NSLocalizedDescriptionKey: "Unable to allocate speech analysis buffer"
      ])
    }

    var frameDbValues: [Double] = []
    var analyzedMs = 0.0

    while audioFile.framePosition < totalFrames {
      let remaining = AVAudioFrameCount(min(Int64(targetFrameCount), totalFrames - audioFile.framePosition))
      if remaining == 0 { break }
      try audioFile.read(into: buffer, frameCount: remaining)
      let frameLength = Int(buffer.frameLength)
      if frameLength == 0 { break }

      let rms = rmsLevel(from: buffer)
      let db = 20 * log10(max(rms, 0.000_001))
      frameDbValues.append(db)
      analyzedMs += Double(frameLength) / sampleRate * 1000
    }

    guard !frameDbValues.isEmpty else {
      return [
        "durationMs": durationMs,
        "analyzedMs": analyzedMs,
        "speechActivityMs": 0,
        "speechRatio": 0,
        "peakDb": -120,
        "averageDb": -120,
        "noiseFloorDb": -120,
        "thresholdDb": -48,
        "noSpeechLikely": false,
        "reason": "analysis_empty",
        "confidence": 0
      ]
    }

    let peakDb = frameDbValues.max() ?? -120
    let averageDb = frameDbValues.reduce(0, +) / Double(frameDbValues.count)
    let noiseFloorDb = percentile(frameDbValues, percentile: 0.20)
    let thresholdDb = max(-48, min(-30, noiseFloorDb + 10))
    let speechFrames = frameDbValues.filter { $0 >= thresholdDb }.count
    let speechActivityMs = analyzedMs * Double(speechFrames) / Double(frameDbValues.count)
    let speechRatio = analyzedMs > 0 ? speechActivityMs / analyzedMs : 0

    let tooShort = durationMs < 250
    let nearlySilent = peakDb < -48
    let littleSpeech =
      speechActivityMs < 160 &&
      speechRatio < 0.08 &&
      peakDb < -34 &&
      averageDb < -45
    let noSpeechLikely = tooShort || nearlySilent || littleSpeech
    let reason: String
    let confidence: Double
    if tooShort {
      reason = "too_short"
      confidence = 0.92
    } else if nearlySilent {
      reason = "nearly_silent"
      confidence = 0.95
    } else if littleSpeech {
      reason = "low_speech_activity"
      confidence = 0.78
    } else {
      reason = "speech_activity_detected"
      confidence = 0.65
    }

    return [
      "durationMs": durationMs,
      "analyzedMs": analyzedMs,
      "speechActivityMs": speechActivityMs,
      "speechRatio": speechRatio,
      "peakDb": peakDb,
      "averageDb": averageDb,
      "noiseFloorDb": noiseFloorDb,
      "thresholdDb": thresholdDb,
      "noSpeechLikely": noSpeechLikely,
      "reason": reason,
      "confidence": confidence
    ]
  }

  private func convertRecordingToWav(fileUri: String) throws -> [String: Any] {
    let sourceUrl = resolveAudioFileUrl(fileUri)
    let sourceFile = try AVAudioFile(forReading: sourceUrl)
    let inputFormat = sourceFile.processingFormat
    guard let targetFormat = AVAudioFormat(
      commonFormat: .pcmFormatInt16,
      sampleRate: 16_000,
      channels: 1,
      interleaved: false
    ) else {
      throw NSError(domain: "AppGroupStorage", code: 4, userInfo: [
        NSLocalizedDescriptionKey: "Unable to create 16 kHz mono fallback format"
      ])
    }
    guard let converter = AVAudioConverter(from: inputFormat, to: targetFormat) else {
      throw NSError(domain: "AppGroupStorage", code: 5, userInfo: [
        NSLocalizedDescriptionKey: "Unable to create WAV fallback converter"
      ])
    }

    let timestamp = Int(Date().timeIntervalSince1970 * 1000)
    let sourceName = sourceUrl.deletingPathExtension().lastPathComponent
    let outputUrl = FileManager.default.temporaryDirectory
      .appendingPathComponent("\(sourceName)_fallback_\(timestamp).wav")
    let outputFile = try AVAudioFile(
      forWriting: outputUrl,
      settings: targetFormat.settings,
      commonFormat: targetFormat.commonFormat,
      interleaved: targetFormat.isInterleaved
    )

    let chunkFrames: AVAudioFrameCount = 4096
    while sourceFile.framePosition < sourceFile.length {
      let framesRemaining = sourceFile.length - sourceFile.framePosition
      let framesToRead = AVAudioFrameCount(Swift.min(Int64(chunkFrames), framesRemaining))
      guard framesToRead > 0 else { break }
      guard let inputBuffer = AVAudioPCMBuffer(
        pcmFormat: inputFormat,
        frameCapacity: framesToRead
      ) else {
        throw NSError(domain: "AppGroupStorage", code: 6, userInfo: [
          NSLocalizedDescriptionKey: "Unable to allocate conversion input buffer"
        ])
      }
      try sourceFile.read(into: inputBuffer, frameCount: framesToRead)
      guard inputBuffer.frameLength > 0 else { break }
      if let converted = convertBuffer(inputBuffer, converter: converter, targetFormat: targetFormat) {
        try outputFile.write(from: converted)
      }
    }

    let fileSize = fileSizeBytes(for: outputUrl)
    logMarker(
      "recordingFile.convertedToWav",
      extra: "source=\(sourceUrl.lastPathComponent) output=\(outputUrl.lastPathComponent) bytes=\(fileSize ?? -1)"
    )

    return [
      "fileUri": outputUrl.absoluteString,
      "fileName": outputUrl.lastPathComponent,
      "mimeType": recordingMimeType(for: outputUrl),
      "fileSizeBytes": fileSize ?? 0
    ]
  }

  // whisper.rn's bundled WAV parser is stricter than AVFoundation and rejects
  // the non-canonical WAV container AVAudioFile produces ("Invalid WAV file"),
  // even though the PCM is valid. Rewrite the recording as a canonical 16-bit
  // PCM WAV so on-device transcription can read it. Only touches .wav files;
  // any failure leaves the original untouched.
  private func rewriteAsCanonicalWav(at url: URL) {
    guard url.pathExtension.lowercased() == "wav" else { return }
    guard let sourceFile = try? AVAudioFile(forReading: url), sourceFile.length > 0 else { return }

    let sampleRate = sourceFile.fileFormat.sampleRate
    let channelCount = sourceFile.fileFormat.channelCount
    let readFormat = sourceFile.processingFormat
    guard let readBuffer = AVAudioPCMBuffer(
      pcmFormat: readFormat,
      frameCapacity: AVAudioFrameCount(sourceFile.length)
    ) else { return }

    do {
      try sourceFile.read(into: readBuffer)
    } catch {
      return
    }

    guard let int16Format = AVAudioFormat(
      commonFormat: .pcmFormatInt16,
      sampleRate: sampleRate,
      channels: channelCount,
      interleaved: true
    ),
      let converter = AVAudioConverter(from: readFormat, to: int16Format),
      let int16Buffer = AVAudioPCMBuffer(pcmFormat: int16Format, frameCapacity: readBuffer.frameLength)
    else { return }

    var providedInput = false
    var conversionError: NSError?
    converter.convert(to: int16Buffer, error: &conversionError) { _, outStatus in
      if providedInput {
        outStatus.pointee = .noDataNow
        return nil
      }
      providedInput = true
      outStatus.pointee = .haveData
      return readBuffer
    }

    guard conversionError == nil,
      int16Buffer.frameLength > 0,
      let channelData = int16Buffer.int16ChannelData
    else { return }

    let channels = Int(channelCount)
    let pcm = Data(bytes: channelData[0], count: Int(int16Buffer.frameLength) * channels * 2)
    let canonical = canonicalWavData(
      pcm: pcm,
      sampleRate: UInt32(sampleRate),
      channels: UInt16(channels),
      bitsPerSample: 16
    )

    do {
      try canonical.write(to: url, options: .atomic)
      logMarker(
        "recordingFile.canonicalizedWav",
        extra: "frames=\(int16Buffer.frameLength) bytes=\(canonical.count)"
      )
    } catch {
      logMarker("recordingFile.canonicalizeFailed", extra: "error=\(error.localizedDescription)")
    }
  }

  private func canonicalWavData(
    pcm: Data,
    sampleRate: UInt32,
    channels: UInt16,
    bitsPerSample: UInt16
  ) -> Data {
    var data = Data()
    func appendLE32(_ value: UInt32) {
      var le = value.littleEndian
      data.append(Data(bytes: &le, count: 4))
    }
    func appendLE16(_ value: UInt16) {
      var le = value.littleEndian
      data.append(Data(bytes: &le, count: 2))
    }

    let byteRate = sampleRate * UInt32(channels) * UInt32(bitsPerSample / 8)
    let blockAlign = channels * (bitsPerSample / 8)
    let dataSize = UInt32(pcm.count)

    data.append(Data("RIFF".utf8))
    appendLE32(36 + dataSize)
    data.append(Data("WAVE".utf8))
    data.append(Data("fmt ".utf8))
    appendLE32(16)
    appendLE16(1) // PCM
    appendLE16(channels)
    appendLE32(sampleRate)
    appendLE32(byteRate)
    appendLE16(blockAlign)
    appendLE16(bitsPerSample)
    data.append(Data("data".utf8))
    appendLE32(dataSize)
    data.append(pcm)
    return data
  }

  private func rmsLevel(from buffer: AVAudioPCMBuffer) -> Double {
    let frameLength = Int(buffer.frameLength)
    let channelCount = Int(buffer.format.channelCount)
    guard frameLength > 0, channelCount > 0 else { return 0 }

    var sumSquares = 0.0
    var sampleCount = 0

    if let channels = buffer.floatChannelData {
      for channel in 0..<channelCount {
        let samples = channels[channel]
        for frame in 0..<frameLength {
          let sample = Double(samples[frame])
          sumSquares += sample * sample
          sampleCount += 1
        }
      }
    } else if let channels = buffer.int16ChannelData {
      for channel in 0..<channelCount {
        let samples = channels[channel]
        for frame in 0..<frameLength {
          let sample = Double(samples[frame]) / Double(Int16.max)
          sumSquares += sample * sample
          sampleCount += 1
        }
      }
    }

    guard sampleCount > 0 else { return 0 }
    return sqrt(sumSquares / Double(sampleCount))
  }

  private func percentile(_ values: [Double], percentile: Double) -> Double {
    guard !values.isEmpty else { return -120 }
    let sorted = values.sorted()
    let clamped = max(0, min(percentile, 1))
    let index = Int(round(Double(sorted.count - 1) * clamped))
    return sorted[index]
  }

  private func resolveRecordingJobId(trigger: String) -> String {
    if let defaults = UserDefaults(suiteName: appGroupId),
       let existing = defaults.string(forKey: recordingJobIdKey),
       !existing.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      // Echo the value back: if this read raced the keyboard's write and saw
      // the previous session's id, the recording will run under that id —
      // rewriting makes the shared key converge on the id the recording
      // actually uses, keeping the stop event and pending-transcript
      // staleness checks consistent.
      defaults.set(existing, forKey: recordingJobIdKey)
      defaults.synchronize()
      return existing
    }

    let generated = "\(Int(Date().timeIntervalSince1970 * 1000))-\(UUID().uuidString)"
    if let defaults = UserDefaults(suiteName: appGroupId) {
      defaults.set(generated, forKey: recordingJobIdKey)
      defaults.synchronize()
    }
    logMarker("recordingJob.generated", extra: "trigger=\(trigger)")
    return generated
  }

  private func sharedRecordingJobId() -> String? {
    guard let defaults = UserDefaults(suiteName: appGroupId),
          let jobId = defaults.string(forKey: recordingJobIdKey),
          !jobId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      return nil
    }
    return jobId
  }

  private func fileSizeBytes(for url: URL) -> Int? {
    guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
          let size = attributes[.size] as? NSNumber else {
      return nil
    }
    return size.intValue
  }

  private func postDarwinNotification(_ name: String) {
    let center = CFNotificationCenterGetDarwinNotifyCenter()
    CFNotificationCenterPostNotification(
      center,
      CFNotificationName(name as CFString),
      nil,
      nil,
      true
    )
  }

  private func logMarker(_ marker: String, extra: String = "") {
    #if DEBUG
    let state = sharedStateSnapshot()
    let suffix = extra.isEmpty ? "" : " \(extra)"
    let clipState = isClipRecording ? "recording" : "idle"
    let engineState = (audioEngine?.isRunning == true) ? "on" : "off"
    NSLog(
      "[AppGroupStorage][MARKER] %@ clip=%@ engine=%@ obsStart=%@ obsStop=%@ sharedActive=%@ sharedReady=%@ sharedWarm=%@ stopReq=%@%@",
      marker,
      clipState,
      engineState,
      isObservingStartNotification ? "1" : "0",
      isObservingStopNotification ? "1" : "0",
      state.active,
      state.ready,
      state.warm,
      state.stopRequested,
      suffix
    )
    #endif
  }

  // MARK: - Recording Lifecycle

  private func startRecording(trigger: String) -> Bool {
    audioPipelineLock.lock()
    defer { audioPipelineLock.unlock() }
    logMarker("startRecording.begin", extra: "trigger=\(trigger)")
    let jobId = resolveRecordingJobId(trigger: trigger)

    audioStateLock.lock()
    let alreadyRecording = isClipRecording
    audioStateLock.unlock()
    if alreadyRecording {
      logMarker("startRecording.rejectedAlreadyRecording", extra: "trigger=\(trigger)")
      return false
    }

    var didStart = false
    defer {
      if !didStart {
        addDarwinStartObserver()
        // Flowing check: advertising ready=1 off a zombie's isRunning sends
        // the keyboard straight into another doomed Darwin start (thrash).
        let engineRunning = isAudioEngineRunning() && isInputFlowing()
        setSharedRecordingState(
          active: false,
          ready: engineRunning,
          clearStopRequested: false,
          clearAudioLevel: true
        )
        logMarker("startRecording.deferredFailure", extra: "trigger=\(trigger)")
      }
    }

    removeDarwinStartObserver()

    // isInputFlowing guards against a zombie engine (suspended-and-resumed
    // with a dead session): reusing one records pure silence, so re-activate
    // the session and let ensureAudioEngineRunning rebuild instead.
    let engineAlreadyRunning = isAudioEngineRunning() && isInputFlowing()
    if !engineAlreadyRunning {
      do {
        try configureAudioSessionForCapture()
      } catch {
        setKeyboardStatus("error", detail: "audio_session_failed")
        sendEvent("onRecordingError", [
          "message": "Failed to configure audio session: \(error.localizedDescription)"
        ])
        logMarker("startRecording.audioSessionError", extra: "trigger=\(trigger)")
        return false
      }
    } else {
      logMarker("startRecording.reuseWarmSession", extra: "trigger=\(trigger)")
    }

    guard ensureAudioEngineRunning(reason: "startRecording.\(trigger)") else {
      setKeyboardStatus("error", detail: "audio_engine_start_failed")
      sendEvent("onRecordingError", [
        "message": "Failed to start audio engine"
      ])
      logMarker("startRecording.audioEngineStartFailed", extra: "trigger=\(trigger)")
      return false
    }

    let recordingTarget: (AVAudioFile, URL)
    do {
      recordingTarget = try createRecordingFile()
    } catch {
      setKeyboardStatus("error", detail: "recording_file_create_failed")
      sendEvent("onRecordingError", [
        "message": "Failed to create recording file: \(error.localizedDescription)"
      ])
      logMarker("startRecording.fileCreateError", extra: "trigger=\(trigger)")
      return false
    }

    audioStateLock.lock()
    recordingFile = recordingTarget.0
    recordingFileUrl = recordingTarget.1
    isClipRecording = true
    clipStartedAtMs = Int64(Date().timeIntervalSince1970 * 1000)
    currentRecordingJobId = jobId
    latestAudioLevel = 0
    didLogFileWriteError = false
    audioStateLock.unlock()

    setSharedRecordingState(active: true, ready: true, clearStopRequested: true, clearAudioLevel: true)
    setKeyboardStatus("recording")
    if let defaults = UserDefaults(suiteName: appGroupId) {
      defaults.removeObject(forKey: "keyboard_cancel_requested")
    }
    addDarwinStopObserver()
    startMeteringTimer()
    startKeepAliveHeartbeat()
    updateKeepAliveHeartbeat()
    resetWarmMicIdleTimer()

    didStart = true
    logMarker("startRecording.success", extra: "trigger=\(trigger) jobId=\(jobId)")
    return true
  }

  private func stopRecording(reason: String) {
    audioPipelineLock.lock()
    defer { audioPipelineLock.unlock() }
    logMarker("stopRecording.begin", extra: "reason=\(reason)")

    audioStateLock.lock()
    let wasRecording = isClipRecording
    let fileUrl = recordingFileUrl
    let startedAtMs = clipStartedAtMs
    let jobId = currentRecordingJobId ?? sharedRecordingJobId()
    if wasRecording {
      isClipRecording = false
      recordingFile = nil
      recordingFileUrl = nil
      recordingConverter = nil
      recordingTargetFormat = nil
      clipStartedAtMs = 0
      currentRecordingJobId = nil
      latestAudioLevel = 0
      didLogFileWriteError = false
    }
    audioStateLock.unlock()

    guard wasRecording else {
      logMarker("stopRecording.noopNoActiveClip", extra: "reason=\(reason)")
      return
    }

    backgroundTaskId = UIApplication.shared.beginBackgroundTask(withName: "OpenWhisprTranscription") {
      self.endBackgroundTask()
    }

    stopMeteringTimer()
    removeDarwinStopObserver()

    let engineRunning = isAudioEngineRunning() && isInputFlowing()
    setSharedRecordingState(active: false, ready: engineRunning, clearStopRequested: true, clearAudioLevel: true)
    setKeyboardStatus("transcribing")

    if let fileUrl {
      rewriteAsCanonicalWav(at: fileUrl)
      let fileSize = fileSizeBytes(for: fileUrl)
      let durationMs = Int64(Date().timeIntervalSince1970 * 1000) - startedAtMs
      logMarker(
        "stopRecording.fileReady",
        extra: "bytes=\(fileSize ?? -1) durationMs=\(durationMs)"
      )
      sendEvent("onRecordingStopped", [
        "fileUri": fileUrl.absoluteString,
        "fileName": fileUrl.lastPathComponent,
        "mimeType": recordingMimeType(for: fileUrl),
        "recordingFormat": fileUrl.pathExtension.lowercased(),
        "jobId": jobId ?? "",
        "fileSizeBytes": fileSize ?? 0,
        "recordingDurationMs": durationMs
      ])
    } else {
      setKeyboardStatus("error", detail: "recording_missing_file_url")
      sendEvent("onRecordingError", [
        "message": "Recording stopped but no file URL was available"
      ])
      logMarker("stopRecording.missingFileUrl", extra: "reason=\(reason)")
    }

    addDarwinStartObserver()

    if engineRunning {
      setWarmMicState(isWarm: true)
      startKeepAliveHeartbeat()
      updateKeepAliveHeartbeat()
      resetWarmMicIdleTimer()
    } else {
      setWarmMicState(isWarm: false)
      stopKeepAliveHeartbeat()
      logMarker("stopRecording.engineNotRunning", extra: "reason=\(reason)")
    }

    logMarker("stopRecording.success", extra: "reason=\(reason)")
  }

  private func startMeteringTimer() {
    stopMeteringTimer()
    meteringTimer = Timer.scheduledTimer(withTimeInterval: 0.12, repeats: true) { [weak self] _ in
      self?.onMeteringTick()
    }
    if let meteringTimer {
      RunLoop.main.add(meteringTimer, forMode: .common)
    }
  }

  private func stopMeteringTimer() {
    meteringTimer?.invalidate()
    meteringTimer = nil
  }

  private func onMeteringTick() {
    audioStateLock.lock()
    let active = isClipRecording
    let level = latestAudioLevel
    let startedAtMs = clipStartedAtMs
    audioStateLock.unlock()

    guard active else { return }

    guard let defaults = UserDefaults(suiteName: appGroupId) else { return }

    let levelString = String(format: "%.3f", max(0, min(1, level)))
    defaults.set(levelString, forKey: "keyboard_audio_level")

    if defaults.string(forKey: stopRequestedKey) == "1" {
      let stopRequestedAtMs = Int64(defaults.string(forKey: stopRequestedAtMsKey) ?? "") ?? 0
      if stopRequestedAtMs >= startedAtMs && stopRequestedAtMs > 0 {
        logMarker(
          "metering.stopRequestedObserved",
          extra: "stopAtMs=\(stopRequestedAtMs) clipStartMs=\(startedAtMs)"
        )
        stopRecording(reason: "metering.stopRequested")
      } else {
        defaults.removeObject(forKey: stopRequestedKey)
        defaults.removeObject(forKey: stopRequestedAtMsKey)
        logMarker(
          "metering.ignoredStaleStopRequest",
          extra: "stopAtMs=\(stopRequestedAtMs) clipStartMs=\(startedAtMs)"
        )
      }
    }
  }

  // MARK: - Audio Engine

  private func configureAudioSessionForCapture() throws {
    let session = AVAudioSession.sharedInstance()
    // .default (not .measurement) so iOS applies its normal input gain/AGC to
    // the mic. .measurement disables that conditioning for "raw" audio, which
    // captured voice so quietly (~-40 dB peak, only ~12 dB over the noise floor)
    // that the speech-activity check discarded it as no-speech unless the user
    // nearly shouted. If this still isn't loud enough, .voiceChat applies
    // stronger voice AGC.
    try session.setCategory(
      .playAndRecord,
      mode: .default,
      options: [.defaultToSpeaker, .allowBluetoothHFP, .mixWithOthers]
    )

    // During a cold launch handed off from another app — and equally during a
    // resume from suspension — the system audio session is still transitioning
    // and setActive throws transiently ("Session activation failed") before it
    // succeeds. Retry across that window (~1s); the warm path succeeds on the
    // first attempt and never sleeps.
    var lastError: Error?
    for attempt in 0..<5 {
      do {
        try session.setActive(true, options: [])
        if attempt > 0 {
          logMarker("audioSession.activatedAfterRetry", extra: "attempt=\(attempt)")
        }
        return
      } catch {
        lastError = error
        logMarker(
          "audioSession.activateRetry",
          extra: "attempt=\(attempt) error=\(error.localizedDescription)"
        )
        Thread.sleep(forTimeInterval: 0.2)
      }
    }
    throw lastError ?? NSError(domain: "AppGroupStorage", code: -1)
  }

  private func ensureAudioEngineRunning(reason: String) -> Bool {
    if let audioEngine, audioEngine.isRunning, isInputFlowing() {
      setWarmMicState(isWarm: true)
      // No-op when already ticking; repairs a heartbeat that died while the
      // engine kept running (keyboard treats a stale heartbeat as app-dead).
      startKeepAliveHeartbeat()
      return true
    }

    if let audioEngine {
      if audioEngine.isRunning {
        logMarker("audioEngine.zombieRebuild", extra: "reason=\(reason)")
      }
      audioEngine.inputNode.removeTap(onBus: 0)
      audioEngine.stop()
      self.audioEngine = nil
    }

    let engine = AVAudioEngine()
    let inputNode = engine.inputNode
    let inputFormat = inputNode.inputFormat(forBus: 0)

    guard inputFormat.channelCount > 0 else {
      logMarker("audioEngine.invalidInputFormat", extra: "reason=\(reason)")
      return false
    }

    inputNode.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { [weak self] buffer, _ in
      self?.handleInputBuffer(buffer)
    }

    engine.prepare()

    do {
      try engine.start()
      self.audioEngine = engine
      engineStartedAtMs = Int64(Date().timeIntervalSince1970 * 1000)
      setWarmMicState(isWarm: true)
      startKeepAliveHeartbeat()
      updateKeepAliveHeartbeat()
      logMarker(
        "audioEngine.started",
        extra: "reason=\(reason) sr=\(Int(inputFormat.sampleRate)) ch=\(inputFormat.channelCount)"
      )
      return true
    } catch {
      inputNode.removeTap(onBus: 0)
      logMarker("audioEngine.startFailed", extra: "reason=\(reason) error=\(error.localizedDescription)")
      return false
    }
  }

  private func shutdownAudioPipeline(reason: String) {
    audioPipelineLock.lock()
    defer { audioPipelineLock.unlock() }
    stopMeteringTimer()

    audioStateLock.lock()
    isClipRecording = false
    recordingFile = nil
    recordingFileUrl = nil
    recordingConverter = nil
    recordingTargetFormat = nil
    clipStartedAtMs = 0
    currentRecordingJobId = nil
    latestAudioLevel = 0
    didLogFileWriteError = false
    audioStateLock.unlock()

    if let audioEngine {
      audioEngine.inputNode.removeTap(onBus: 0)
      audioEngine.stop()
      self.audioEngine = nil
    }

    setWarmMicState(isWarm: false)
    stopKeepAliveHeartbeat()

    do {
      try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    } catch {
      logMarker("audioEngine.deactivateSessionFailed", extra: "reason=\(reason) error=\(error.localizedDescription)")
    }

    logMarker("audioEngine.stopped", extra: "reason=\(reason)")
  }

  private func isAudioEngineRunning() -> Bool {
    return audioEngine?.isRunning == true
  }

  /// True when the input tap has delivered a buffer recently, i.e. the engine
  /// is genuinely capturing — not a zombie left over from app suspension whose
  /// isRunning flag never flipped. Engines started moments ago get a grace
  /// window because their first buffer hasn't arrived yet.
  private func isInputFlowing() -> Bool {
    audioStateLock.lock()
    let lastBufferAtMs = lastInputBufferAtMs
    audioStateLock.unlock()
    let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
    if nowMs - engineStartedAtMs <= 2_500 {
      return true
    }
    return nowMs - lastBufferAtMs <= 2_500
  }

  private func createRecordingFile() throws -> (AVAudioFile, URL) {
    guard let audioEngine else {
      throw NSError(domain: "AppGroupStorage", code: 1, userInfo: [
        NSLocalizedDescriptionKey: "Audio engine not available"
      ])
    }

    let inputFormat = audioEngine.inputNode.inputFormat(forBus: 0)
    let timestamp = Int(Date().timeIntervalSince1970 * 1000)

    if preferredRecordingFormat() == "m4a" {
      do {
        return try createCompressedRecordingFile(inputFormat: inputFormat, timestamp: timestamp)
      } catch {
        logMarker(
          "recordingFile.compressedCreateFailed",
          extra: "error=\(error.localizedDescription)"
        )
      }
    }

    return try createWavRecordingFile(inputFormat: inputFormat, timestamp: timestamp)
  }

  private func preferredRecordingFormat() -> String {
    guard let defaults = UserDefaults(suiteName: appGroupId) else {
      return "wav"
    }

    switch defaults.string(forKey: preferredRecordingFormatKey)?.lowercased() {
    case "m4a", "compressed", "aac":
      return "m4a"
    default:
      return "wav"
    }
  }

  private func createCompressedRecordingFile(
    inputFormat: AVAudioFormat,
    timestamp: Int
  ) throws -> (AVAudioFile, URL) {
    let filePath = NSTemporaryDirectory() + "openwhispr_recording_\(timestamp).m4a"
    let fileUrl = URL(fileURLWithPath: filePath)
    let settings: [String: Any] = [
      AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
      AVSampleRateKey: 16_000,
      AVNumberOfChannelsKey: 1,
      AVEncoderBitRateKey: 32_000,
      AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue
    ]

    let file = try AVAudioFile(forWriting: fileUrl, settings: settings)
    let targetFormat = file.processingFormat
    guard let converter = AVAudioConverter(from: inputFormat, to: targetFormat) else {
      throw NSError(domain: "AppGroupStorage", code: 3, userInfo: [
        NSLocalizedDescriptionKey: "Unable to create AAC recording converter"
      ])
    }

    recordingTargetFormat = targetFormat
    recordingConverter = converter
    logMarker(
      "recordingFile.created",
      extra: "codec=aac inputSr=\(Int(inputFormat.sampleRate)) inputCh=\(inputFormat.channelCount) targetSr=\(Int(targetFormat.sampleRate)) targetCh=\(targetFormat.channelCount)"
    )

    return (file, fileUrl)
  }

  private func createWavRecordingFile(
    inputFormat: AVAudioFormat,
    timestamp: Int
  ) throws -> (AVAudioFile, URL) {
    guard let targetFormat = AVAudioFormat(
      commonFormat: .pcmFormatInt16,
      sampleRate: 16_000,
      channels: 1,
      interleaved: false
    ) else {
      throw NSError(domain: "AppGroupStorage", code: 2, userInfo: [
        NSLocalizedDescriptionKey: "Unable to create 16 kHz mono recording format"
      ])
    }

    let filePath = NSTemporaryDirectory() + "openwhispr_recording_\(timestamp).wav"
    let fileUrl = URL(fileURLWithPath: filePath)

    let file = try AVAudioFile(
      forWriting: fileUrl,
      settings: targetFormat.settings,
      commonFormat: targetFormat.commonFormat,
      interleaved: targetFormat.isInterleaved
    )

    recordingTargetFormat = targetFormat
    recordingConverter = AVAudioConverter(from: inputFormat, to: targetFormat)
    logMarker(
      "recordingFile.created",
      extra: "codec=wav inputSr=\(Int(inputFormat.sampleRate)) inputCh=\(inputFormat.channelCount) targetSr=16000 targetCh=1"
    )

    return (file, fileUrl)
  }

  private func recordingMimeType(for fileUrl: URL) -> String {
    switch fileUrl.pathExtension.lowercased() {
    case "wav", "wave":
      return "audio/wav"
    case "m4a":
      return "audio/m4a"
    case "mp4":
      return "audio/mp4"
    case "mp3":
      return "audio/mpeg"
    default:
      return "application/octet-stream"
    }
  }

  private func handleInputBuffer(_ buffer: AVAudioPCMBuffer) {
    let level = normalizedLevel(from: buffer)

    audioStateLock.lock()
    latestAudioLevel = level
    lastInputBufferAtMs = Int64(Date().timeIntervalSince1970 * 1000)
    let active = isClipRecording
    let converter = recordingConverter
    let targetFormat = recordingTargetFormat
    audioStateLock.unlock()

    guard active else {
      return
    }

    // Conversion is pure CPU and never touches recordingFile, so it stays
    // outside the lock (convertBuffer self-locks for failure logging).
    let bufferToWrite: AVAudioPCMBuffer?
    if let converter, let targetFormat {
      bufferToWrite = convertBuffer(buffer, converter: converter, targetFormat: targetFormat)
    } else {
      bufferToWrite = buffer
    }
    guard let bufferToWrite else {
      return
    }

    // Write while holding the lock so stopRecording cannot drop the file's
    // last reference mid-write. The tap only ever holds a strong reference to
    // recordingFile inside this critical section, so once stopRecording nils
    // it under the lock, ARC deallocates the AVAudioFile synchronously and
    // finalizes the WAV header before onRecordingStopped fires. Otherwise an
    // in-flight tap write defers finalization and consumers read a WAV whose
    // header isn't written yet.
    var writeError: Error?
    audioStateLock.lock()
    if isClipRecording, let file = recordingFile {
      do {
        try file.write(from: bufferToWrite)
      } catch {
        writeError = error
      }
    }
    audioStateLock.unlock()

    if let writeError {
      logAudioWriteFailureOnce("audioTap.writeFailed", error: writeError.localizedDescription)
    }
  }

  private func convertBuffer(
    _ buffer: AVAudioPCMBuffer,
    converter: AVAudioConverter,
    targetFormat: AVAudioFormat
  ) -> AVAudioPCMBuffer? {
    let ratio = targetFormat.sampleRate / buffer.format.sampleRate
    let capacity = AVAudioFrameCount(max(1, Double(buffer.frameLength) * ratio + 32))
    guard let output = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else {
      return nil
    }

    var didProvideInput = false
    var conversionError: NSError?
    let status = converter.convert(to: output, error: &conversionError) { _, outStatus in
      if didProvideInput {
        outStatus.pointee = .noDataNow
        return nil
      }
      didProvideInput = true
      outStatus.pointee = .haveData
      return buffer
    }

    if let conversionError {
      logAudioWriteFailureOnce("audioTap.convertFailed", error: conversionError.localizedDescription)
      return nil
    }

    guard status != .error, output.frameLength > 0 else {
      return nil
    }
    return output
  }

  private func logAudioWriteFailureOnce(_ marker: String, error: String) {
    var shouldLog = false
    audioStateLock.lock()
    if !didLogFileWriteError {
      didLogFileWriteError = true
      shouldLog = true
    }
    audioStateLock.unlock()
    if shouldLog {
      logMarker(marker, extra: "error=\(error)")
    }
  }

  private func normalizedLevel(from buffer: AVAudioPCMBuffer) -> Float {
    guard let channelData = buffer.floatChannelData else {
      return 0
    }

    let frameLength = Int(buffer.frameLength)
    guard frameLength > 0 else {
      return 0
    }

    let samples = channelData[0]
    var sum: Float = 0
    for i in 0..<frameLength {
      let sample = samples[i]
      sum += sample * sample
    }

    let rms = sqrt(sum / Float(frameLength))
    let db = 20 * log10(max(rms, 0.000_01))
    // Anchor the floor at -50 dB, not the -60 digital floor. With input AGC
    // enabled, room ambient sits well above -60, so -60 made silence read as a
    // third of full scale and the meter never dropped. Matches the JS waveform.
    return max(0, min(1, (db + 50) / 50))
  }

  // MARK: - Darwin Notifications

  private func addDarwinStatusObserver() {
    guard !isObservingStatusNotification else { return }

    let center = CFNotificationCenterGetDarwinNotifyCenter()
    let observer = Unmanaged.passUnretained(self).toOpaque()

    CFNotificationCenterAddObserver(
      center,
      observer,
      { (_, observer, _, _, _) in
        guard let observer else { return }
        let module = Unmanaged<AppGroupStorageModule>.fromOpaque(observer).takeUnretainedValue()
        DispatchQueue.main.async {
          module.sendKeyboardStatusChanged(trigger: "darwin.statusNotification")
        }
      },
      AppGroupStorageModule.darwinStatusNotificationName as CFString,
      nil,
      .deliverImmediately
    )

    isObservingStatusNotification = true
    logMarker("darwinStatusObserver.added")
  }

  private func removeDarwinStatusObserver() {
    guard isObservingStatusNotification else { return }

    let center = CFNotificationCenterGetDarwinNotifyCenter()
    let observer = Unmanaged.passUnretained(self).toOpaque()

    CFNotificationCenterRemoveObserver(
      center,
      observer,
      CFNotificationName(AppGroupStorageModule.darwinStatusNotificationName as CFString),
      nil
    )

    isObservingStatusNotification = false
    logMarker("darwinStatusObserver.removed")
  }

  private func addDarwinStopObserver() {
    guard !isObservingStopNotification else { return }

    let center = CFNotificationCenterGetDarwinNotifyCenter()
    let observer = Unmanaged.passUnretained(self).toOpaque()

    CFNotificationCenterAddObserver(
      center,
      observer,
      { (_, observer, _, _, _) in
        guard let observer else { return }
        let module = Unmanaged<AppGroupStorageModule>.fromOpaque(observer).takeUnretainedValue()
        DispatchQueue.main.async {
          module.logMarker("darwinStopObserver.received")
          module.stopRecording(reason: "darwin.stopNotification")
        }
      },
      AppGroupStorageModule.darwinStopNotificationName as CFString,
      nil,
      .deliverImmediately
    )

    isObservingStopNotification = true
    logMarker("darwinStopObserver.added")
  }

  private func removeDarwinStopObserver() {
    guard isObservingStopNotification else { return }

    let center = CFNotificationCenterGetDarwinNotifyCenter()
    let observer = Unmanaged.passUnretained(self).toOpaque()

    CFNotificationCenterRemoveObserver(
      center,
      observer,
      CFNotificationName(AppGroupStorageModule.darwinStopNotificationName as CFString),
      nil
    )

    isObservingStopNotification = false
    logMarker("darwinStopObserver.removed")
  }

  private func addDarwinStartObserver() {
    guard !isObservingStartNotification else { return }

    let center = CFNotificationCenterGetDarwinNotifyCenter()
    let observer = Unmanaged.passUnretained(self).toOpaque()

    CFNotificationCenterAddObserver(
      center,
      observer,
      { (_, observer, _, _, _) in
        guard let observer else { return }
        let module = Unmanaged<AppGroupStorageModule>.fromOpaque(observer).takeUnretainedValue()
        DispatchQueue.main.async {
          module.logMarker("darwinStartObserver.received")
          if module.startRecording(trigger: "darwin.startNotification") {
            module.logMarker("darwinStartObserver.startSucceeded")
            module.sendEvent("onBackgroundRecordingStarted", [:])
          } else {
            module.logMarker("darwinStartObserver.startFailed")
          }
        }
      },
      AppGroupStorageModule.darwinStartNotificationName as CFString,
      nil,
      .deliverImmediately
    )

    isObservingStartNotification = true
    logMarker("darwinStartObserver.added")
  }

  private func removeDarwinStartObserver() {
    guard isObservingStartNotification else { return }

    let center = CFNotificationCenterGetDarwinNotifyCenter()
    let observer = Unmanaged.passUnretained(self).toOpaque()

    CFNotificationCenterRemoveObserver(
      center,
      observer,
      CFNotificationName(AppGroupStorageModule.darwinStartNotificationName as CFString),
      nil
    )

    isObservingStartNotification = false
    logMarker("darwinStartObserver.removed")
  }

  private func addDarwinDictationModeObserver() {
    guard !isObservingDictationModeNotification else { return }
    let center = CFNotificationCenterGetDarwinNotifyCenter()
    let observer = Unmanaged.passUnretained(self).toOpaque()
    CFNotificationCenterAddObserver(
      center, observer,
      { (_, observer, _, _, _) in
        guard let observer else { return }
        let module = Unmanaged<AppGroupStorageModule>.fromOpaque(observer).takeUnretainedValue()
        DispatchQueue.main.async { module.handleDictationModeChanged() }
      },
      AppGroupStorageModule.darwinDictationModeChangedNotificationName as CFString,
      nil, .deliverImmediately)
    isObservingDictationModeNotification = true
    logMarker("darwinDictationModeObserver.added")
  }

  private func removeDarwinDictationModeObserver() {
    guard isObservingDictationModeNotification else { return }
    let center = CFNotificationCenterGetDarwinNotifyCenter()
    let observer = Unmanaged.passUnretained(self).toOpaque()
    CFNotificationCenterRemoveObserver(
      center, observer,
      CFNotificationName(AppGroupStorageModule.darwinDictationModeChangedNotificationName as CFString),
      nil)
    isObservingDictationModeNotification = false
    logMarker("darwinDictationModeObserver.removed")
  }

  private func addDarwinAgentActionObserver() {
    guard !isObservingAgentActionNotification else { return }
    let center = CFNotificationCenterGetDarwinNotifyCenter()
    let observer = Unmanaged.passUnretained(self).toOpaque()
    CFNotificationCenterAddObserver(
      center, observer,
      { (_, observer, _, _, _) in
        guard let observer else { return }
        let module = Unmanaged<AppGroupStorageModule>.fromOpaque(observer).takeUnretainedValue()
        DispatchQueue.main.async {
          module.logMarker("darwinAgentActionObserver.received")
          module.sendEvent("onAgentAction", [:])
        }
      },
      AppGroupStorageModule.darwinAgentActionNotificationName as CFString,
      nil, .deliverImmediately)
    isObservingAgentActionNotification = true
    logMarker("darwinAgentActionObserver.added")
  }

  private func removeDarwinAgentActionObserver() {
    guard isObservingAgentActionNotification else { return }
    let center = CFNotificationCenterGetDarwinNotifyCenter()
    let observer = Unmanaged.passUnretained(self).toOpaque()
    CFNotificationCenterRemoveObserver(
      center, observer,
      CFNotificationName(AppGroupStorageModule.darwinAgentActionNotificationName as CFString),
      nil)
    isObservingAgentActionNotification = false
    logMarker("darwinAgentActionObserver.removed")
  }

  private func handleDictationModeChanged() {
    if isDictationModeEnabled() {
      logMarker("dictationModeChanged.enabled")
      armWarmMic(reason: "dictationModeChanged")
    } else {
      logMarker("dictationModeChanged.disabled")
      releaseWarmMic(reason: "dictationModeChanged")
    }
  }

  private func addForegroundObserver() {
    guard foregroundObserverToken == nil else { return }
    foregroundObserverToken = NotificationCenter.default.addObserver(
      forName: UIApplication.didBecomeActiveNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      self?.handleAppDidBecomeActive()
    }
    logMarker("foregroundObserver.added")
  }

  private func removeForegroundObserver() {
    guard let token = foregroundObserverToken else { return }
    NotificationCenter.default.removeObserver(token)
    foregroundObserverToken = nil
  }

  private func addBackgroundObserver() {
    guard backgroundObserverToken == nil else { return }
    backgroundObserverToken = NotificationCenter.default.addObserver(
      forName: UIApplication.didEnterBackgroundNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      self?.stopForegroundHeartbeat()
    }
  }

  private func removeBackgroundObserver() {
    guard let token = backgroundObserverToken else { return }
    NotificationCenter.default.removeObserver(token)
    backgroundObserverToken = nil
  }

  // MARK: - Audio Session Health

  private func addAudioSessionObservers() {
    guard audioInterruptionObserverToken == nil else { return }
    let center = NotificationCenter.default
    let session = AVAudioSession.sharedInstance()
    audioInterruptionObserverToken = center.addObserver(
      forName: AVAudioSession.interruptionNotification,
      object: session,
      queue: .main
    ) { [weak self] notification in
      self?.handleAudioSessionInterruption(notification)
    }
    mediaServicesResetObserverToken = center.addObserver(
      forName: AVAudioSession.mediaServicesWereResetNotification,
      object: session,
      queue: .main
    ) { [weak self] _ in
      self?.handleMediaServicesReset()
    }
    logMarker("audioSessionObservers.added")
  }

  private func removeAudioSessionObservers() {
    let center = NotificationCenter.default
    if let token = audioInterruptionObserverToken {
      center.removeObserver(token)
      audioInterruptionObserverToken = nil
    }
    if let token = mediaServicesResetObserverToken {
      center.removeObserver(token)
      mediaServicesResetObserverToken = nil
    }
  }

  private func handleAudioSessionInterruption(_ notification: Notification) {
    guard let rawType = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
          let type = AVAudioSession.InterruptionType(rawValue: rawType) else { return }

    switch type {
    case .began:
      // Pre-iOS 16 posts a synthetic .began at resume when the app was
      // suspended mid-session (reason raw value 1, .appWasSuspended — the
      // symbol is deprecated in 16). The foreground re-arm already covers
      // that case, and tearing down here could race it.
      if let rawReason = notification.userInfo?[AVAudioSessionInterruptionReasonKey] as? UInt,
         rawReason == 1 {
        logMarker("audioSession.interruptionBegan.ignoredAppWasSuspended")
        return
      }
      audioPipelineLock.lock()
      defer { audioPipelineLock.unlock() }
      audioStateLock.lock()
      let recording = isClipRecording
      audioStateLock.unlock()
      logMarker("audioSession.interruptionBegan", extra: "recording=\(recording)")
      if recording {
        // Finalize the clip so speech captured before the interruption still
        // gets transcribed; stopRecording handles the file and the JS handoff.
        stopRecording(reason: "audioSession.interruption")
      }
      // The system already took the mic; drop the warm pipeline and shared
      // flags now so the keyboard falls back to Activate immediately instead
      // of timing out its start request against a dead session.
      releaseWarmMic(reason: "audioSession.interruption")
    case .ended:
      let rawOptions = notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
      let shouldResume = AVAudioSession.InterruptionOptions(rawValue: rawOptions).contains(.shouldResume)
      logMarker("audioSession.interruptionEnded", extra: "shouldResume=\(shouldResume)")
      // Without .shouldResume another app still owns the mic; the next
      // foreground re-arms via handleAppDidBecomeActive.
      if shouldResume {
        armWarmMic(reason: "interruptionEnded")
      }
    @unknown default:
      break
    }
  }

  /// The audio daemon crashed and restarted (QA1749): every session and
  /// engine object is invalid, regardless of what state it reports. Discard
  /// the pipeline and rebuild from scratch.
  private func handleMediaServicesReset() {
    audioPipelineLock.lock()
    defer { audioPipelineLock.unlock() }
    audioStateLock.lock()
    let recording = isClipRecording
    audioStateLock.unlock()
    logMarker("audioSession.mediaServicesReset", extra: "recording=\(recording)")
    if recording {
      stopRecording(reason: "audioSession.mediaServicesReset")
    }
    shutdownAudioPipeline(reason: "audioSession.mediaServicesReset")
    armWarmMic(reason: "mediaServicesReset")
  }

  private func handleAppDidBecomeActive() {
    startForegroundHeartbeat()
    guard isDictationModeEnabled() else { return }
    logMarker("appDidBecomeActive.armOrReset")
    armWarmMic(reason: "appForeground")  // arms if cold, resets idle timer if already warm
  }

  // Lets the keyboard tell whether it is running inside OpenWhispr itself. While
  // the app is foreground this timestamp is refreshed every couple seconds; the
  // keyboard treats a fresh value as "host is our own app" and records in place
  // instead of doing a cross-app handoff (which would wrongly show the "swipe
  // back to your app" screen). Private-API host bundle-id detection is
  // unreliable, so this is the source of truth. Cleared on background and goes
  // stale within seconds if the app is killed, so another host app never reads a
  // false positive.
  private func startForegroundHeartbeat() {
    updateForegroundHeartbeat()
    guard foregroundHeartbeatTimer == nil else { return }
    let timer = Timer(timeInterval: 2.0, repeats: true) { [weak self] _ in
      self?.updateForegroundHeartbeat()
    }
    RunLoop.main.add(timer, forMode: .common)
    foregroundHeartbeatTimer = timer
  }

  private func updateForegroundHeartbeat() {
    guard let defaults = UserDefaults(suiteName: appGroupId) else { return }
    defaults.set(
      String(Int(Date().timeIntervalSince1970 * 1000)),
      forKey: containingAppForegroundKey
    )
    defaults.synchronize()
  }

  private func stopForegroundHeartbeat() {
    foregroundHeartbeatTimer?.invalidate()
    foregroundHeartbeatTimer = nil
    guard let defaults = UserDefaults(suiteName: appGroupId) else { return }
    defaults.removeObject(forKey: containingAppForegroundKey)
    defaults.synchronize()
  }

  // MARK: - Warm Mic (dictation mode)

  private func isDictationModeEnabled() -> Bool {
    // Default ON: enabled unless explicitly "0" (matches LiveActivityController).
    UserDefaults(suiteName: appGroupId)?.string(forKey: dictationModeEnabledKey) != "0"
  }

  /// Reads the mic permission WITHOUT requesting it. Warming activates a
  /// .playAndRecord session and taps the input node, which is itself what makes
  /// iOS raise the permission prompt — so warming while permission is
  /// undetermined fires an unexplained prompt at launch, before onboarding can
  /// say why (App Store Guideline 5.1.1(iv)). Onboarding owns the request; this
  /// only ever reads.
  private func hasRecordPermission() -> Bool {
    if #available(iOS 17.0, *) {
      return AVAudioApplication.shared.recordPermission == .granted
    }
    return AVAudioSession.sharedInstance().recordPermission == .granted
  }

  /// Hold the mic warm without recording. The input tap already discards buffers
  /// while `isClipRecording == false`, so no idle audio is written to disk. Must run
  /// on the main thread / foreground for the audio-session activation to succeed.
  private func armWarmMic(reason: String) {
    audioPipelineLock.lock()
    defer { audioPipelineLock.unlock() }
    guard isDictationModeEnabled() else {
      logMarker("armWarmMic.skippedDisabled", extra: "reason=\(reason)")
      return
    }
    // Without permission there is nothing to warm, and attempting it would
    // raise the system prompt from wherever we happen to be (launch, resume).
    // The keyboard stays un-ready, which is the truthful state: it cannot
    // dictate until the user grants access via onboarding or Settings.
    guard hasRecordPermission() else {
      logMarker("armWarmMic.skippedNoPermission", extra: "reason=\(reason)")
      return
    }
    audioStateLock.lock()
    let recording = isClipRecording
    audioStateLock.unlock()
    guard !recording else {
      // A live clip owns the shared flags (active=1); don't clobber them.
      logMarker("armWarmMic.skippedRecording", extra: "reason=\(reason)")
      resetWarmMicIdleTimer()
      return
    }
    // isRunning alone is not proof of warmth — a suspended-and-resumed engine
    // reports running with a dead session (zombie). Require flowing input;
    // otherwise reconfigure the session so ensureAudioEngineRunning can
    // rebuild on a live one.
    let verifiedWarm = isAudioEngineRunning() && isInputFlowing()
    if !verifiedWarm {
      do {
        try configureAudioSessionForCapture()
      } catch {
        logMarker("armWarmMic.audioSessionFailed", extra: "reason=\(reason) err=\(error.localizedDescription)")
        return
      }
    }
    guard ensureAudioEngineRunning(reason: "armWarmMic.\(reason)") else {
      logMarker("armWarmMic.engineStartFailed", extra: "reason=\(reason)")
      return
    }
    // Always re-write the shared flags, warm or not: the keyboard clears
    // background_session_ready after a failed Darwin start, and this is the
    // only path that repairs it when the app comes to the foreground. Skipping
    // it while "already warm" is what left the keyboard stuck on Activate
    // until the app was killed.
    // No recording file created → tap discards input until a real dictation starts.
    setSharedRecordingState(active: false, ready: true, clearStopRequested: false, clearAudioLevel: true)
    resetWarmMicIdleTimer()
    logMarker(verifiedWarm ? "armWarmMic.alreadyWarm" : "armWarmMic.warmed", extra: "reason=\(reason)")
  }

  /// Release the warm mic: stop engine, deactivate session, drop the amber indicator,
  /// let the app suspend. No-op if a clip is actively recording.
  private func releaseWarmMic(reason: String) {
    audioPipelineLock.lock()
    defer { audioPipelineLock.unlock() }
    stopWarmMicIdleTimer()
    audioStateLock.lock()
    let recording = isClipRecording
    audioStateLock.unlock()
    guard !recording else {
      logMarker("releaseWarmMic.skippedRecording", extra: "reason=\(reason)")
      return
    }
    shutdownAudioPipeline(reason: "releaseWarmMic.\(reason)")
    logMarker("releaseWarmMic.released", extra: "reason=\(reason)")
  }

  private func resetWarmMicIdleTimer() {
    stopWarmMicIdleTimer()
    let timer = Timer(timeInterval: warmMicIdleTimeoutSeconds, repeats: false) { [weak self] _ in
      self?.onWarmMicIdleTimeout()
    }
    RunLoop.main.add(timer, forMode: .common)
    warmMicIdleTimer = timer
    logMarker("warmMicIdleTimer.reset", extra: "seconds=\(Int(warmMicIdleTimeoutSeconds))")
  }

  private func stopWarmMicIdleTimer() {
    warmMicIdleTimer?.invalidate()
    warmMicIdleTimer = nil
  }

  private func onWarmMicIdleTimeout() {
    audioStateLock.lock()
    let recording = isClipRecording
    audioStateLock.unlock()
    guard !recording else {
      logMarker("warmMicIdle.skippedRecording")
      resetWarmMicIdleTimer()
      return
    }
    logMarker("warmMicIdle.releasing")
    releaseWarmMic(reason: "idleTimeout")
  }

  // MARK: - Keep Alive Heartbeat

  private func startKeepAliveHeartbeat() {
    if keepAliveHeartbeatTimer != nil { return }

    keepAliveHeartbeatTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
      self?.updateKeepAliveHeartbeat()
    }
    if let keepAliveHeartbeatTimer {
      RunLoop.main.add(keepAliveHeartbeatTimer, forMode: .common)
    }
    updateKeepAliveHeartbeat()
    logMarker("keepAliveHeartbeat.started")
  }

  private func stopKeepAliveHeartbeat() {
    keepAliveHeartbeatTimer?.invalidate()
    keepAliveHeartbeatTimer = nil

    if let defaults = UserDefaults(suiteName: appGroupId) {
      defaults.removeObject(forKey: "background_session_heartbeat")
      defaults.synchronize()
    }
    logMarker("keepAliveHeartbeat.stopped")
  }

  private func updateKeepAliveHeartbeat() {
    if let defaults = UserDefaults(suiteName: appGroupId) {
      defaults.set(String(Int(Date().timeIntervalSince1970 * 1000)), forKey: "background_session_heartbeat")
      defaults.synchronize()
    }
  }

  // MARK: - Return to Previous App

  private func navigateBackToPreviousApp(maxRetries: Int = 0, delay: TimeInterval = 0.2) {
    guard let defaults = UserDefaults(suiteName: appGroupId) else {
      #if DEBUG
      NSLog("[AppGroupStorage] navigateBack: no app group defaults")
      #endif
      return
    }
    defaults.synchronize()

    guard let url = resolveReturnUrl(defaults: defaults) else {
      #if DEBUG
      NSLog("[AppGroupStorage] navigateBack: no return URL found in UserDefaults")
      #endif
      logMarker("navigateBack.missingUrl")
      return
    }

    let urlString = url.absoluteString
    if returnNavigationInFlight {
      #if DEBUG
      NSLog("[AppGroupStorage] navigateBack: open already in flight, skipping duplicate")
      #endif
      logMarker("navigateBack.skippedInFlight", extra: "url=\(urlString)")
      return
    }

    let now = Date()
    if let lastUrl = lastReturnAttemptUrl,
      let lastAttemptAt = lastReturnAttemptAt,
      lastUrl == urlString,
      now.timeIntervalSince(lastAttemptAt) < 1.2
    {
      #if DEBUG
      NSLog("[AppGroupStorage] navigateBack: skipping rapid duplicate for %@", urlString)
      #endif
      logMarker("navigateBack.skippedRapidDuplicate", extra: "url=\(urlString)")
      return
    }

    returnNavigationInFlight = true
    lastReturnAttemptUrl = urlString
    lastReturnAttemptAt = now

    #if DEBUG
    NSLog("[AppGroupStorage] navigateBack: attempting open %@", urlString)
    #endif
    logMarker("navigateBack.attemptOpen", extra: "url=\(urlString)")
    UIApplication.shared.open(url, options: [:]) { [weak self] success in
      guard let self else { return }
      self.returnNavigationInFlight = false
      #if DEBUG
      NSLog("[AppGroupStorage] navigateBack: open result=%@", success ? "success" : "failed")
      #endif
      self.logMarker(
        success ? "navigateBack.openSuccess" : "navigateBack.openFailed",
        extra: "url=\(urlString)"
      )
      if success {
        defaults.removeObject(forKey: "keyboard_return_url")
        defaults.removeObject(forKey: "keyboard_return_bundle")
        defaults.synchronize()
        self.lastReturnAttemptUrl = nil
        self.lastReturnAttemptAt = nil
        return
      }

      guard maxRetries > 0 else {
        #if DEBUG
        NSLog("[AppGroupStorage] navigateBack: exhausted retries for %@", urlString)
        #endif
        self.logMarker("navigateBack.retryExhausted", extra: "url=\(urlString)")
        return
      }

      DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
        self.navigateBackToPreviousApp(
          maxRetries: maxRetries - 1,
          delay: min(delay * 1.6, 1.0)
        )
      }
    }
  }

  private func resolveReturnUrl(defaults: UserDefaults) -> URL? {
    if let rawUrl = defaults.string(forKey: "keyboard_return_url"),
       let normalizedUrl = normalizeReturnUrl(rawUrl) {
      defaults.set(normalizedUrl.absoluteString, forKey: "keyboard_return_url")
      defaults.synchronize()
      return normalizedUrl
    }

    guard let hostBundle = defaults.string(forKey: "keyboard_return_bundle") else {
      return nil
    }

    let trimmedBundle = hostBundle.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedBundle.isEmpty else {
      return nil
    }

    guard let fallbackUrlString =
      Self.hostBundleFallbackUrls[trimmedBundle]
      ?? Self.normalizedHostBundleFallbackUrls[trimmedBundle.lowercased()],
      let fallbackUrl = URL(string: fallbackUrlString) else {
      return nil
    }

    defaults.set(fallbackUrlString, forKey: "keyboard_return_url")
    defaults.synchronize()
    return fallbackUrl
  }

  private func normalizeReturnUrl(_ rawUrl: String) -> URL? {
    let trimmed = rawUrl.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      return nil
    }

    let normalized =
      trimmed.caseInsensitiveCompare("whatsapp://") == .orderedSame ? "whatsapp://send" : trimmed
    return URL(string: normalized)
  }

  // MARK: - Background Task

  private func endBackgroundTask() {
    if backgroundTaskId != .invalid {
      UIApplication.shared.endBackgroundTask(backgroundTaskId)
      backgroundTaskId = .invalid
    }
  }
}
