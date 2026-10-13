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

  public func definition() -> ModuleDefinition {
    Name("LivePCMStreaming")

    Events("pcm-frame")

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
      do {
        try self.beginStreaming(sampleRate: Double(sampleRate))
        promise.resolve(nil)
      } catch {
        self.teardown()
        promise.reject("PCM_START_FAILED", error.localizedDescription)
      }
    }
  }

  private func beginStreaming(sampleRate: Double) throws {
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
    audioEngine = engine
    converter = audioConverter
    outputFormat = targetFormat
    outputSampleRate = sampleRate
    frameNumber = 0
    emittedFrames = 0
    isStreaming = true
    stateLock.unlock()

    inputNode.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { [weak self] buffer, _ in
      self?.handleTap(buffer)
    }

    engine.prepare()
    do {
      try engine.start()
    } catch {
      inputNode.removeTap(onBus: 0)
      throw error
    }
  }

  private func handleTap(_ inputBuffer: AVAudioPCMBuffer) {
    stateLock.lock()
    let streaming = isStreaming
    let activeConverter = converter
    let activeFormat = outputFormat
    stateLock.unlock()

    guard streaming, let activeConverter, let activeFormat else { return }

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
    guard isStreaming else {
      stateLock.unlock()
      return
    }
    let number = frameNumber
    let timestampMs = Int(Double(emittedFrames) / outputSampleRate * 1000)
    frameNumber += 1
    emittedFrames += frames
    stateLock.unlock()

    sendEvent("pcm-frame", [
      "audio": base64,
      "frameNumber": number,
      "timestampMs": timestampMs,
    ])
  }

  // Idempotent: safe to call from stop(), a failed start(), or OnDestroy.
  private func teardown() {
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
