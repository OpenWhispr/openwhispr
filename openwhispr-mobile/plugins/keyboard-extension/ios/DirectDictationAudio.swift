import Foundation

/// Appends 16 kHz mono Int16 little-endian samples to a file as they arrive, so a long take
/// never sits in the keyboard's memory (its limit is small and unpublished).
final class PcmFileWriter {
  static let sampleRate = 16_000

  private let handle: FileHandle
  private(set) var sampleCount = 0
  /// Largest absolute sample value seen, 0...32768.
  private(set) var peakSample = 0
  private var closed = false

  var durationMs: Int { sampleCount * 1000 / Self.sampleRate }

  init(url: URL) throws {
    FileManager.default.createFile(atPath: url.path, contents: nil)
    handle = try FileHandle(forWritingTo: url)
    try handle.truncate(atOffset: 0)
  }

  func append(_ pcm: Data) throws {
    guard !closed, !pcm.isEmpty else { return }
    try handle.write(contentsOf: pcm)
    pcm.withUnsafeBytes { raw in
      let samples = raw.bindMemory(to: Int16.self)
      for sample in samples {
        let magnitude = abs(Int(Int16(littleEndian: sample)))
        if magnitude > peakSample { peakSample = magnitude }
      }
    }
    sampleCount += pcm.count / 2
  }

  func close() {
    guard !closed else { return }
    closed = true
    try? handle.close()
  }

  deinit { close() }
}

/// Without WebKit's call processing the microphone is about 25 dB quieter than with it, so the
/// keyboard applies one factor to the whole take before encoding.
enum DirectGain {
  static let targetPeak: Float = 0.7 * 32_767
  static let maximum: Float = 31.6  // 30 dB
  /// What the waveform adds to a live level: the take's own gain isn't known until it ends,
  /// so the bars use the typical shortfall of a capture without voice processing (25 dB).
  static let displayBoost: Float = 17.8

  /// clamp(targetPeak / peakSample, 1, maximum); 1 when peakSample is 0.
  static func factor(peakSample: Int) -> Float {
    guard peakSample > 0 else { return 1 }
    return min(max(targetPeak / Float(peakSample), 1), maximum)
  }
}

struct SpeechActivity: Equatable {
  let durationMs: Int
  let speechMs: Int
  let peakDb: Double
  let noSpeechLikely: Bool
  /// too_short | nearly_silent | low_speech_activity | speech_activity_detected | analysis_empty
  let reason: String
}

/// The app's no-speech check (`AppGroupStorageModule.analyzeSpeechActivity`) fed chunk by chunk
/// instead of read back from a file: the same 20 ms frames, thresholds and reasons, so the
/// keyboard and the app agree on what counts as no speech.
struct SpeechActivityMeter {
  private let sampleRate: Int
  private let frameLength: Int
  private var frameDbValues: [Double] = []
  private var analyzedSamples = 0
  private var pending: [Int16] = []
  private var totalSamples = 0

  init(sampleRate: Int = 16_000) {
    self.sampleRate = max(sampleRate, 1)
    frameLength = max(256, Int(Double(self.sampleRate) * 0.02))
  }

  mutating func add(_ pcm: Data) {
    pcm.withUnsafeBytes { raw in
      for sample in raw.bindMemory(to: Int16.self) {
        pending.append(Int16(littleEndian: sample))
      }
    }
    totalSamples += pcm.count / 2
    var start = 0
    while pending.count - start >= frameLength {
      addFrame(pending[start..<(start + frameLength)])
      start += frameLength
    }
    if start > 0 { pending.removeFirst(start) }
  }

  /// `gain`: the factor the take will be amplified by before it is sent. The check judges the
  /// take at that level: a capture without WebKit's voice processing is about 25 dB quieter
  /// than the app's recordings, and at its raw level ordinary speech reads as silence.
  func result(gain: Float = 1) -> SpeechActivity {
    var meter = self
    // The app's file loop reads a shorter last frame; so does this.
    if !meter.pending.isEmpty {
      meter.addFrame(meter.pending[...])
      meter.pending.removeAll()
    }
    let durationMs = totalSamples * 1000 / sampleRate
    guard !meter.frameDbValues.isEmpty else {
      return SpeechActivity(
        durationMs: durationMs, speechMs: 0, peakDb: -120, noSpeechLikely: false, reason: "analysis_empty"
      )
    }

    let gainDb = 20 * log10(Double(max(gain, 1)))
    let values = meter.frameDbValues.map { min(0, $0 + gainDb) }
    let analyzedMs = Double(meter.analyzedSamples) / Double(sampleRate) * 1000
    let peakDb = values.max() ?? -120
    let averageDb = values.reduce(0, +) / Double(values.count)
    let noiseFloorDb = Self.percentile(values, 0.20)
    let thresholdDb = max(-48, min(-30, noiseFloorDb + 10))
    let speechFrames = values.filter { $0 >= thresholdDb }.count
    let speechActivityMs = analyzedMs * Double(speechFrames) / Double(values.count)
    let speechRatio = analyzedMs > 0 ? speechActivityMs / analyzedMs : 0

    let tooShort = durationMs < 250
    let nearlySilent = peakDb < -48
    let littleSpeech = speechActivityMs < 160 && speechRatio < 0.08 && peakDb < -34 && averageDb < -45
    let reason: String
    if tooShort {
      reason = "too_short"
    } else if nearlySilent {
      reason = "nearly_silent"
    } else if littleSpeech {
      reason = "low_speech_activity"
    } else {
      reason = "speech_activity_detected"
    }
    return SpeechActivity(
      durationMs: durationMs,
      speechMs: Int(speechActivityMs.rounded()),
      peakDb: peakDb,
      noSpeechLikely: tooShort || nearlySilent || littleSpeech,
      reason: reason
    )
  }

  private mutating func addFrame(_ frame: ArraySlice<Int16>) {
    guard !frame.isEmpty else { return }
    var sumSquares = 0.0
    for sample in frame {
      let value = Double(sample) / Double(Int16.max)
      sumSquares += value * value
    }
    let rms = (sumSquares / Double(frame.count)).squareRoot()
    frameDbValues.append(20 * log10(max(rms, 0.000_001)))
    analyzedSamples += frame.count
  }

  private static func percentile(_ values: [Double], _ percentile: Double) -> Double {
    guard !values.isEmpty else { return -120 }
    let sorted = values.sorted()
    let index = Int((Double(sorted.count - 1) * max(0, min(percentile, 1))).rounded())
    return sorted[index]
  }
}

/// Speech and peak of a take already on disk, for one whose keyboard died before encoding it.
enum PcmFileScan {
  static func scan(_ url: URL) -> (activity: SpeechActivity, peakSample: Int)? {
    guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
    defer { try? handle.close() }
    var meter = SpeechActivityMeter()
    var peak = 0
    while let chunk = try? handle.read(upToCount: 64 * 1024), !chunk.isEmpty {
      meter.add(chunk)
      chunk.withUnsafeBytes { raw in
        for sample in raw.bindMemory(to: Int16.self) {
          peak = max(peak, abs(Int(Int16(littleEndian: sample))))
        }
      }
    }
    return (meter.result(), peak)
  }
}

/// The app's waveform mapping (`AppGroupStorageModule.swift`): (dB + 50) / 50, clamped to 0...1.
func directMeterLevel(rms: Float) -> Float {
  let db = 20 * log10(max(rms, 0.000_01))
  return max(0, min(1, (db + 50) / 50))
}
