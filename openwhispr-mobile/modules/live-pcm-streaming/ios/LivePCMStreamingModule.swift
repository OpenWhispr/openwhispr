import AVFoundation
import ExpoModulesCore
import Foundation

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

  // Every engine and session change (start, restart, teardown) runs on this
  // serial queue, so a restart can never overlap another restart or a stop.
  // The watchdog timer and the observers below are confined to it too.
  private let captureQueue = DispatchQueue(label: "com.openwhispr.live-pcm-streaming.capture")
  private var watchdog: DispatchSourceTimer?
  private var observers: [NSObjectProtocol] = []

  public func definition() -> ModuleDefinition {
    Name("LivePCMStreaming")

    Events("pcm-frame", "capture-state")

    AsyncFunction("start") { (sampleRate: Int, promise: Promise) in
      self.start(sampleRate: sampleRate, promise: promise)
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

  private func start(sampleRate: Int, promise: Promise) {
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
          try self.beginStreaming(sampleRate: Double(sampleRate))
          promise.resolve(nil)
        } catch {
          self.teardownOnQueue()
          promise.reject("PCM_START_FAILED", error.localizedDescription)
        }
      }
    }
  }

  // Runs on captureQueue.
  private func beginStreaming(sampleRate: Double) throws {
    stateLock.lock()
    outputSampleRate = sampleRate
    frameNumber = 0
    emittedFrames = 0
    health = CaptureHealthPolicy(startedAtMs: Self.nowMs())
    isStreaming = true
    stateLock.unlock()

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

    stateLock.lock()
    guard isStreaming else {
      stateLock.unlock()
      return
    }
    audioEngine = engine
    converter = audioConverter
    outputFormat = targetFormat
    engineGeneration += 1
    generationReason = reason
    let generation = engineGeneration
    stateLock.unlock()

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
    health.restartAttempted(atMs: Self.nowMs())
    let oldEngine = audioEngine
    let sampleRate = outputSampleRate
    // Retired before the old engine stops, so a late buffer from it is dropped.
    engineGeneration += 1
    generationReason = nil
    audioEngine = nil
    converter = nil
    stateLock.unlock()

    oldEngine?.inputNode.removeTap(onBus: 0)
    oldEngine?.stop()

    do {
      try startEngine(sampleRate: sampleRate, reason: reason)
    } catch {
      // Expected while a phone call holds the session: the watchdog retries.
      NSLog("[LivePCMStreaming] restart (\(reason)) failed: \(error.localizedDescription)")
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
      sendCaptureState(.interrupted, reason: "interruption", capturedMs: capturedMs)
    }
  }

  // Runs on captureQueue. Restarts whether or not iOS sets .shouldResume (a
  // meeting recording is always worth resuming), but only while still
  // interrupted: a watchdog retry may already have brought audio back.
  private func resumeAfterInterruption() {
    stateLock.lock()
    let action: CaptureHealthAction = isStreaming ? health.interruptionEnded() : .none
    stateLock.unlock()

    if action == .restart {
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

    guard action == .restart else { return }
    if before == .capturing && after == .interrupted {
      sendCaptureState(.interrupted, reason: "stalled", capturedMs: capturedMs)
    }
    restartCapture(reason: "watchdog")
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

  // Runs on the audio render thread: keep it cheap.
  private func handleTap(_ inputBuffer: AVAudioPCMBuffer, generation: Int) {
    stateLock.lock()
    let accepted = acceptsBuffer(from: generation)
    let activeConverter = converter
    let activeFormat = outputFormat
    stateLock.unlock()

    guard accepted, let activeConverter, let activeFormat else { return }

    let ratio = activeFormat.sampleRate / inputBuffer.format.sampleRate
    let capacity = AVAudioFrameCount(Double(inputBuffer.frameLength) * ratio + 64)
    guard capacity > 0,
          let outputBuffer = AVAudioPCMBuffer(pcmFormat: activeFormat, frameCapacity: capacity) else {
      return
    }

    var providedInput = false
    var conversionError: NSError?
    let status = activeConverter.convert(to: outputBuffer, error: &conversionError) { _, inputStatus in
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
      return
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
    let base64 = pcm.base64EncodedString()

    stateLock.lock()
    guard acceptsBuffer(from: generation) else {
      stateLock.unlock()
      return
    }
    let number = frameNumber
    let timestampMs = Int(Double(emittedFrames) / outputSampleRate * 1000)
    frameNumber += 1
    emittedFrames += frames
    let resumed = health.frameArrived(atMs: Self.nowMs())
    let resumeReason = generationReason
    let capturedMs = currentCapturedMs()
    stateLock.unlock()

    sendEvent("pcm-frame", [
      "audio": base64,
      "frameNumber": number,
      "timestampMs": timestampMs,
    ])
    if resumed, let resumeReason {
      sendCaptureState(.capturing, reason: resumeReason, capturedMs: capturedMs)
    }
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
    audioEngine = nil
    converter = nil
    outputFormat = nil
    isStreaming = false
    stateLock.unlock()

    guard wasStreaming || engine != nil else { return }

    engine?.inputNode.removeTap(onBus: 0)
    engine?.stop()
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
