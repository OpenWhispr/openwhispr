import AVFoundation
import ExpoModulesCore
import Foundation
import UIKit

private enum LivePCMError: LocalizedError {
  case invalidInputFormat
  case formatCreationFailed
  case converterCreationFailed

  var errorDescription: String? {
    switch self {
    case .invalidInputFormat: return "Microphone input format is unavailable"
    case .formatCreationFailed: return "Could not create the target PCM format"
    case .converterCreationFailed: return "Could not create the audio converter"
    }
  }
}

private struct StartOptions: Record {
  /// file:// URI to record 16 kHz mono WAV into while streaming.
  @Field var recordingUri: String?
}

// Streams microphone PCM16 to JS for realtime transcription. Captures with
// AVAudioSession mode .default so iOS keeps its input conditioning (AGC, mic
// array processing) ON. Meetings are far-field: with .measurement (the raw-audio
// desktop-parity path originally used here), an across-the-table speaker landed
// so close to the noise floor that the server VAD never fired for them — the
// same quiet-capture failure the keyboard recorder hit (see
// AppGroupStorageModule.configureAudioSessionForCapture). Audio is resampled to
// the requested rate (default 24 kHz), downmixed to mono, packed to
// little-endian Int16, base64-encoded, and emitted frame-by-frame via "pcm-frame".
public class LivePCMStreamingModule: Module {
  private let stateLock = NSLock()
  private var audioEngine: AVAudioEngine?
  // A single converter is reused across every tap callback so the resampler's
  // internal state stays continuous — per-buffer converters would drop or
  // duplicate samples at each frame boundary.
  private var converter: AVAudioConverter?
  private var outputFormat: AVAudioFormat?
  private var isStreaming = false
  private var frameNumber = 0
  private var emittedFrames = 0
  private var outputSampleRate: Double = 24000
  private var health = CaptureHealthPolicy(startedAtMs: 0)
  // Each engine's tap carries the generation it was installed under; any
  // change of engine (or an interruption, which leaves the old engine's late
  // buffers in flight) bumps it, so stale buffers never reach the converter,
  // the counters or the policy.
  private var engineGeneration = 0
  // The restart that built the current generation's engine, reported with
  // "capturing". nil for the first start's engine and for a generation with no
  // engine yet.
  private var generationReason: String?

  // The meeting's crash-safe recording, fed the same accepted buffers as the
  // stream so both share one capture clock. The writer lives for the whole
  // recording; the converter belongs to the current engine, because a restart
  // can change the input format.
  private var recordingWriter: MeetingRecordingWriter?
  private var recordingConverter: AVAudioConverter?
  private var recordingFailureReported = false

  // Every engine and session change (start, restart, teardown) runs on this
  // serial queue, so a restart can never overlap another restart or a stop.
  // The watchdog timer and the observers below are confined to it too.
  private let captureQueue = DispatchQueue(label: "com.openwhispr.live-pcm-streaming.capture")
  private var watchdog: DispatchSourceTimer?
  private var observers: [NSObjectProtocol] = []

  // Background time held through an interruption's fast retries
  // (`CaptureHealthPolicy.wantsBackgroundTime`): once another app takes the
  // microphone the engine is silent, and without this iOS may suspend the app
  // before the watchdog's retries get the microphone back. The identifier is
  // only touched on the main thread; the request flag is guarded by stateLock,
  // and requests are queued to main under it so they apply in order.
  private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
  private var backgroundTimeRequested = false

  public func definition() -> ModuleDefinition {
    Name("LivePCMStreaming")

    Events("pcm-frame", "capture-state", "recording-failed")

    AsyncFunction("start") { (sampleRate: Int, options: StartOptions?, promise: Promise) in
      self.start(sampleRate: sampleRate, recordingUri: options?.recordingUri, promise: promise)
    }

    AsyncFunction("repairRecording") { (uri: String) -> Bool in
      return self.repairRecording(uri: uri)
    }

    AsyncFunction("excludeFromBackup") { (uri: String) -> Bool in
      guard let url = Self.fileUrl(from: uri) else { return false }
      return MeetingRecordingWriter.excludeFromBackup(url)
    }

    AsyncFunction("stop") { (promise: Promise) in
      self.teardown()
      promise.resolve(nil)
    }

    Function("isRecording") { () -> Bool in
      self.stateLock.lock()
      defer { self.stateLock.unlock() }
      return self.isStreaming
    }

    OnDestroy {
      self.teardown()
    }
  }

  private func start(sampleRate: Int, recordingUri: String?, promise: Promise) {
    stateLock.lock()
    let alreadyStreaming = isStreaming
    stateLock.unlock()
    if alreadyStreaming {
      promise.reject("ALREADY_RECORDING", "Live PCM streaming is already running")
      return
    }

    requestMicPermission { [weak self] granted in
      guard let self else { return }
      guard granted else {
        promise.reject("MIC_PERMISSION_DENIED", "Microphone permission was not granted")
        return
      }
      self.captureQueue.async {
        self.stateLock.lock()
        let startedMeanwhile = self.isStreaming
        self.stateLock.unlock()
        if startedMeanwhile {
          promise.reject("ALREADY_RECORDING", "Live PCM streaming is already running")
          return
        }
        do {
          try self.beginStreaming(sampleRate: Double(sampleRate), recordingUri: recordingUri)
          promise.resolve(nil)
        } catch {
          self.teardownOnQueue()
          // A call holding the audio session gets its own code, so JS can say why.
          promise.reject(StartRejection.code(for: error), error.localizedDescription)
        }
      }
    }
  }

  // Runs on captureQueue.
  private func beginStreaming(sampleRate: Double, recordingUri: String?) throws {
    // A recording that cannot be opened never fails the stream.
    var writer: MeetingRecordingWriter?
    if let recordingUri {
      if let url = Self.fileUrl(from: recordingUri) {
        writer = try? MeetingRecordingWriter(url: url)
      }
      writer?.onFailure = { [weak self, weak writer] in
        self?.recordingFailed(writer)
      }
    }
    let writerFailed = recordingUri != nil && writer == nil

    stateLock.lock()
    outputSampleRate = sampleRate
    frameNumber = 0
    emittedFrames = 0
    health = CaptureHealthPolicy(startedAtMs: Self.nowMs())
    recordingWriter = writer
    recordingConverter = nil
    recordingFailureReported = writerFailed
    isStreaming = true
    stateLock.unlock()

    if writerFailed {
      sendEvent("recording-failed", [:])
    }

    try startEngine(sampleRate: sampleRate, reason: nil)
    startObserving()
  }

  // Runs on captureQueue. Builds a fresh engine, converter and tap; a restart
  // needs a new converter because the input format may have changed with the
  // route. Leaves `isStreaming` alone and never deactivates the session.
  private func startEngine(sampleRate: Double, reason: String?) throws {
    let session = AVAudioSession.sharedInstance()
    // .record without Bluetooth options keeps input on the built-in mic even
    // when AirPods are connected — an HFP headset mic only hears its wearer.
    try session.setCategory(.record, mode: .default)
    try session.setActive(true)

    let engine = AVAudioEngine()
    let inputNode = engine.inputNode
    let inputFormat = inputNode.inputFormat(forBus: 0)
    guard inputFormat.channelCount > 0, inputFormat.sampleRate > 0 else {
      throw LivePCMError.invalidInputFormat
    }

    // Hardware input is typically 48 kHz stereo/mono float; the converter
    // resamples and downmixes to the requested mono rate.
    guard let targetFormat = AVAudioFormat(
      commonFormat: .pcmFormatFloat32,
      sampleRate: sampleRate,
      channels: 1,
      interleaved: false
    ) else {
      throw LivePCMError.formatCreationFailed
    }
    guard let audioConverter = AVAudioConverter(from: inputFormat, to: targetFormat) else {
      throw LivePCMError.converterCreationFailed
    }
    let fileConverter = AVAudioFormat(
      commonFormat: .pcmFormatFloat32,
      sampleRate: Double(MeetingRecordingWriter.sampleRate),
      channels: AVAudioChannelCount(MeetingRecordingWriter.channels),
      interleaved: false
    ).flatMap { AVAudioConverter(from: inputFormat, to: $0) }

    stateLock.lock()
    guard isStreaming else {
      stateLock.unlock()
      return
    }
    audioEngine = engine
    converter = audioConverter
    outputFormat = targetFormat
    // The writer stays: a new engine keeps appending to the same file.
    let lostWriter = fileConverter == nil ? recordingWriter : nil
    if lostWriter != nil {
      recordingWriter = nil
    }
    recordingConverter = recordingWriter != nil ? fileConverter : nil
    engineGeneration += 1
    generationReason = reason
    let generation = engineGeneration
    stateLock.unlock()

    if let lostWriter {
      // This engine's audio cannot reach the file; keep what it already holds.
      lostWriter.finish()
      recordingFailed(nil)
    }

    inputNode.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { [weak self] buffer, _ in
      self?.handleTap(buffer, generation: generation)
    }

    engine.prepare()
    do {
      try engine.start()
    } catch {
      inputNode.removeTap(onBus: 0)
      stateLock.lock()
      if audioEngine === engine {
        audioEngine = nil
        converter = nil
        recordingConverter = nil
        generationReason = nil
      }
      stateLock.unlock()
      throw error
    }
  }

  // Runs on captureQueue. Replaces the engine without ending the recording:
  // JS keeps its session and the captured-audio clock keeps counting.
  private func restartCapture(reason: String) {
    stateLock.lock()
    guard isStreaming else {
      stateLock.unlock()
      return
    }
    let attempt = health.restartAttempted(atMs: Self.nowMs())
    let oldEngine = audioEngine
    let sampleRate = outputSampleRate
    // Retired before the old engine stops, so a late buffer from it is dropped.
    engineGeneration += 1
    generationReason = nil
    audioEngine = nil
    converter = nil
    recordingConverter = nil
    stateLock.unlock()

    oldEngine?.inputNode.removeTap(onBus: 0)
    oldEngine?.stop()

    // Every attempt is logged, so a device log shows whether retries kept
    // running in the background and what iOS answered each one.
    do {
      try startEngine(sampleRate: sampleRate, reason: reason)
      NSLog("[LivePCMStreaming] restart (\(reason)) attempt=\(attempt) ok")
    } catch {
      // Expected while a phone call holds the session: the watchdog retries,
      // a second later while the interruption is young or has just ended.
      stateLock.lock()
      health.restartFailed(atMs: Self.nowMs())
      stateLock.unlock()
      NSLog("[LivePCMStreaming] restart (\(reason)) attempt=\(attempt) failed: \(error.localizedDescription)")
    }
  }

  // Runs on captureQueue.
  private func startObserving() {
    guard watchdog == nil, observers.isEmpty else { return }
    let center = NotificationCenter.default

    observers.append(center.addObserver(
      forName: AVAudioSession.interruptionNotification,
      object: AVAudioSession.sharedInstance(),
      queue: nil
    ) { [weak self] notification in
      guard let rawType = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
            let type = AVAudioSession.InterruptionType(rawValue: rawType) else { return }
      self?.captureQueue.async { [weak self] in
        guard let self else { return }
        if type == .began {
          self.markInterrupted()
        } else if type == .ended {
          self.resumeAfterInterruption()
        }
      }
    })

    observers.append(center.addObserver(
      forName: .AVAudioEngineConfigurationChange,
      object: nil,
      queue: nil
    ) { [weak self] notification in
      let changedEngine = notification.object as AnyObject?
      self?.captureQueue.async { [weak self] in
        guard let self else { return }
        // Only this module's current engine; other engines in the app (and
        // engines this module already replaced) are not ours to restart.
        self.stateLock.lock()
        let isOurs = self.isStreaming && changedEngine != nil && changedEngine === self.audioEngine
        self.stateLock.unlock()
        if isOurs {
          self.restartCapture(reason: "configurationChange")
        }
      }
    })

    observers.append(center.addObserver(
      forName: AVAudioSession.mediaServicesWereResetNotification,
      object: nil,
      queue: nil
    ) { [weak self] _ in
      self?.captureQueue.async { [weak self] in
        self?.restartCapture(reason: "mediaServicesReset")
      }
    })

    let timer = DispatchSource.makeTimerSource(queue: captureQueue)
    timer.schedule(deadline: .now() + 1, repeating: 1)
    timer.setEventHandler { [weak self] in
      self?.watchdogTick()
    }
    watchdog = timer
    timer.resume()
  }

  // Runs on captureQueue.
  private func stopObserving() {
    watchdog?.cancel()
    watchdog = nil
    for observer in observers {
      NotificationCenter.default.removeObserver(observer)
    }
    observers.removeAll()
  }

  // Runs on captureQueue.
  private func markInterrupted() {
    stateLock.lock()
    guard isStreaming else {
      stateLock.unlock()
      return
    }
    let changed = health.interrupted(atMs: Self.nowMs())
    // iOS has stopped this engine, but buffers it already rendered can still
    // reach the tap; they must not read as audio coming back.
    engineGeneration += 1
    generationReason = nil
    let capturedMs = currentCapturedMs()
    stateLock.unlock()

    if changed {
      requestBackgroundTime(newInterruption: true)
      sendCaptureState(.interrupted, reason: "interruption", capturedMs: capturedMs)
    }
  }

  // Runs on captureQueue. Restarts whether or not iOS sets .shouldResume (a
  // meeting recording is always worth resuming), but only while still
  // interrupted: a watchdog retry may already have brought audio back. The
  // end opens a fresh window of one-second retries with background time:
  // after a call longer than the first window the app has been suspended,
  // and iOS often refuses this first attempt.
  private func resumeAfterInterruption() {
    stateLock.lock()
    let action: CaptureHealthAction = isStreaming ? health.interruptionEnded(atMs: Self.nowMs()) : .none
    stateLock.unlock()

    if action == .restart {
      requestBackgroundTime(newInterruption: true)
      restartCapture(reason: "interruptionEnded")
    }
  }

  // Runs on captureQueue, once a second while streaming.
  private func watchdogTick() {
    stateLock.lock()
    guard isStreaming else {
      stateLock.unlock()
      return
    }
    let before = health.state
    let action = health.tick(atMs: Self.nowMs())
    let after = health.state
    let capturedMs = currentCapturedMs()
    stateLock.unlock()

    let stalled = before == .capturing && after == .interrupted
    // Also where the background time ends once the fast retries' bound passes.
    requestBackgroundTime(newInterruption: stalled)
    guard action == .restart else { return }
    if stalled {
      sendCaptureState(.interrupted, reason: "stalled", capturedMs: capturedMs)
    }
    restartCapture(reason: "watchdog")
  }

  // Any thread; takes stateLock, so never call it holding the lock. Reads
  // what the policy wants under the lock, so a request never acts on a stale
  // answer (capture returning on the render thread meanwhile). Queues the
  // change to main only when the wanted state changes, or when an
  // interruption begins or ends (`newInterruption`; either opens a fresh
  // window), which swaps any task still held for a fresh one.
  private func requestBackgroundTime(newInterruption: Bool = false) {
    stateLock.lock()
    defer { stateLock.unlock() }
    let wanted = isStreaming && health.wantsBackgroundTime(atMs: Self.nowMs())
    let changed = wanted != backgroundTimeRequested
    backgroundTimeRequested = wanted
    guard changed || (wanted && newInterruption) else { return }
    // Queued under the lock, so two threads' requests reach main in the order
    // they were made.
    DispatchQueue.main.async {
      self.applyBackgroundTime(wanted, replacingHeld: newInterruption)
    }
  }

  // Main thread. Begins the new task before ending a held one, so the app is
  // never left without background time in between.
  private func applyBackgroundTime(_ wanted: Bool, replacingHeld: Bool) {
    dispatchPrecondition(condition: .onQueue(.main))
    guard wanted else {
      endBackgroundTask(backgroundTask)
      return
    }
    let held = backgroundTask
    if held != .invalid && !replacingHeld { return }
    var task = UIBackgroundTaskIdentifier.invalid
    task = UIApplication.shared.beginBackgroundTask(withName: "OpenWhisprMeetingInterruption") {
      // Main thread. iOS ran out of background time before capture returned.
      NSLog("[LivePCMStreaming] background time expired during an interruption")
      self.endBackgroundTask(task)
    }
    // iOS can refuse (.invalid); a task already held then stays.
    guard task != .invalid else {
      NSLog("[LivePCMStreaming] background time refused during an interruption")
      return
    }
    backgroundTask = task
    if held != .invalid {
      UIApplication.shared.endBackgroundTask(held)
    }
    // In the foreground the remaining time is DBL_MAX, which Int() would trap on.
    let remaining = UIApplication.shared.backgroundTimeRemaining
    let remainingText = remaining < 3_600 ? "\(Int(remaining)) s" : "unlimited (foreground)"
    NSLog("[LivePCMStreaming] background time held, \(remainingText) remaining")
  }

  // Main thread. Ends `task` only while it is the one held, so a task is never
  // ended twice.
  private func endBackgroundTask(_ task: UIBackgroundTaskIdentifier) {
    dispatchPrecondition(condition: .onQueue(.main))
    guard task != .invalid, task == backgroundTask else { return }
    UIApplication.shared.endBackgroundTask(task)
    backgroundTask = .invalid
    NSLog("[LivePCMStreaming] background time released")
  }

  private func sendCaptureState(_ state: CaptureHealthState, reason: String, capturedMs: Int) {
    sendEvent("capture-state", [
      "state": state.rawValue,
      "reason": reason,
      "capturedMs": capturedMs,
    ])
  }

  // Caller holds stateLock.
  private func currentCapturedMs() -> Int {
    return Int(Double(emittedFrames) / outputSampleRate * 1000)
  }

  private static func nowMs() -> Int64 {
    return Int64(DispatchTime.now().uptimeNanoseconds / 1_000_000)
  }

  // Caller holds stateLock. A buffer counts only from the current generation's
  // engine, and only ends an interruption when that engine came from a restart,
  // so "capturing" always names a restart that really happened.
  private func acceptsBuffer(from generation: Int) -> Bool {
    return isStreaming
      && generation == engineGeneration
      && (health.state == .capturing || generationReason != nil)
  }

  // Runs on the audio render thread: keep it cheap. The file write only
  // enqueues; the disk work runs on the writer's queue.
  private func handleTap(_ inputBuffer: AVAudioPCMBuffer, generation: Int) {
    stateLock.lock()
    let accepted = acceptsBuffer(from: generation)
    let activeConverter = converter
    let activeFormat = outputFormat
    let fileConverter = recordingWriter != nil ? recordingConverter : nil
    stateLock.unlock()

    guard accepted, let activeConverter, let activeFormat else { return }

    // Converted before the stream so a buffer the stream can't use still
    // reaches the file's converter, keeping its resampler continuous.
    let recordingPcm = fileConverter.flatMap {
      Self.convertToPCM16(inputBuffer, with: $0, to: $0.outputFormat)
    }
    let streamPcm = Self.convertToPCM16(inputBuffer, with: activeConverter, to: activeFormat)

    stateLock.lock()
    guard acceptsBuffer(from: generation) else {
      stateLock.unlock()
      return
    }
    let writer = recordingWriter
    guard let streamPcm else {
      stateLock.unlock()
      if let recordingPcm { writer?.append(recordingPcm) }
      return
    }
    let frames = streamPcm.count / 2
    let number = frameNumber
    let timestampMs = Int(Double(emittedFrames) / outputSampleRate * 1000)
    frameNumber += 1
    emittedFrames += frames
    let resumed = health.frameArrived(atMs: Self.nowMs())
    let resumeReason = generationReason
    let capturedMs = currentCapturedMs()
    stateLock.unlock()

    if let recordingPcm { writer?.append(recordingPcm) }
    sendEvent("pcm-frame", [
      "audio": streamPcm.base64EncodedString(),
      "frameNumber": number,
      "timestampMs": timestampMs,
    ])
    if resumed {
      // Capture is back: the interruption's background time is no longer needed.
      requestBackgroundTime()
    }
    if resumed, let resumeReason {
      sendCaptureState(.capturing, reason: resumeReason, capturedMs: capturedMs)
    }
  }

  // Runs on the audio render thread. Converts one tap buffer through the
  // engine's long-lived converter and packs it as little-endian Int16; nil
  // when the converter produced nothing.
  private static func convertToPCM16(
    _ inputBuffer: AVAudioPCMBuffer,
    with audioConverter: AVAudioConverter,
    to format: AVAudioFormat
  ) -> Data? {
    let ratio = format.sampleRate / inputBuffer.format.sampleRate
    let capacity = AVAudioFrameCount(Double(inputBuffer.frameLength) * ratio + 64)
    guard capacity > 0,
          let outputBuffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else {
      return nil
    }

    var providedInput = false
    var conversionError: NSError?
    let status = audioConverter.convert(to: outputBuffer, error: &conversionError) { _, inputStatus in
      if providedInput {
        inputStatus.pointee = .noDataNow
        return nil
      }
      providedInput = true
      inputStatus.pointee = .haveData
      return inputBuffer
    }

    guard conversionError == nil, status != .error,
          outputBuffer.frameLength > 0,
          let samples = outputBuffer.floatChannelData?[0] else {
      return nil
    }

    let frames = Int(outputBuffer.frameLength)
    var pcm = Data(capacity: frames * 2)
    for index in 0..<frames {
      let clamped = max(-1.0, min(1.0, samples[index]))
      // Asymmetric scale (0x8000 for negatives, 0x7fff for positives) matches
      // the desktop capture worklet's float32 -> Int16 conversion exactly.
      let scaled = clamped < 0 ? clamped * 32768.0 : clamped * 32767.0
      var sample = Int16(scaled).littleEndian
      withUnsafeBytes(of: &sample) { pcm.append(contentsOf: $0) }
    }
    return pcm
  }

  // Any thread; takes stateLock, so never call it holding the lock (nothing
  // calls finish() under the lock either). Detaches a failed writer and
  // reports the recording's failure once; the stream carries on.
  private func recordingFailed(_ writer: MeetingRecordingWriter?) {
    stateLock.lock()
    if let writer, recordingWriter === writer {
      recordingWriter = nil
      recordingConverter = nil
    }
    let shouldReport = !recordingFailureReported
    recordingFailureReported = true
    stateLock.unlock()

    if shouldReport {
      sendEvent("recording-failed", [:])
    }
  }

  // Runs on the Expo module queue; serialized with start and stop on
  // captureQueue so it can never patch the file being recorded.
  private func repairRecording(uri: String) -> Bool {
    guard let url = Self.fileUrl(from: uri) else { return false }
    return captureQueue.sync {
      self.stateLock.lock()
      let activePath = self.recordingWriter.map { Self.comparablePath($0.url) }
      self.stateLock.unlock()
      if activePath == Self.comparablePath(url) {
        return false
      }
      return MeetingRecordingWriter.repairHeader(at: url)
    }
  }

  private static func fileUrl(from uri: String) -> URL? {
    if uri.hasPrefix("file://") {
      return URL(string: uri)
    }
    return URL(fileURLWithPath: uri)
  }

  private static func comparablePath(_ url: URL) -> String {
    return url.standardizedFileURL.resolvingSymlinksInPath().path
  }

  // Idempotent: safe to call from stop(), a failed start(), or OnDestroy.
  // Waits for a queued or running restart, so none can bring capture back.
  private func teardown() {
    captureQueue.sync {
      self.teardownOnQueue()
    }
  }

  // Runs on captureQueue.
  private func teardownOnQueue() {
    stopObserving()

    stateLock.lock()
    let engine = audioEngine
    let wasStreaming = isStreaming
    let writer = recordingWriter
    audioEngine = nil
    converter = nil
    outputFormat = nil
    recordingWriter = nil
    recordingConverter = nil
    isStreaming = false
    stateLock.unlock()
    // After isStreaming is false, so the request releases any task held.
    requestBackgroundTime()

    guard wasStreaming || engine != nil else { return }

    engine?.inputNode.removeTap(onBus: 0)
    engine?.stop()
    // Blocks until the writer's queue has written everything queued and the
    // final sizes, so stop() resolves on a complete file. The writer's queue
    // never waits on captureQueue, so this sync cannot deadlock.
    writer?.finish()
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  private func requestMicPermission(_ completion: @escaping (Bool) -> Void) {
    if #available(iOS 17.0, *) {
      switch AVAudioApplication.shared.recordPermission {
      case .granted: completion(true)
      case .denied: completion(false)
      default: AVAudioApplication.requestRecordPermission(completionHandler: completion)
      }
    } else {
      let session = AVAudioSession.sharedInstance()
      switch session.recordPermission {
      case .granted: completion(true)
      case .denied: completion(false)
      default: session.requestRecordPermission(completion)
      }
    }
  }
}
