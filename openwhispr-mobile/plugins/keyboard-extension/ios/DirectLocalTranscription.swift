import Foundation

/// The Parakeet model a Local snapshot names. The raw values are the contract strings of
/// `keyboard_direct_config` and of a record's `engine`.
enum DirectLocalModel: String, Equatable {
  case parakeetV2 = "parakeet-v2"
  case parakeetV3 = "parakeet-v3"

  /// The model's folder under the App Group's `SpeechModels/`, as the app stores it.
  var folderName: String {
    switch self {
    case .parakeetV2: return "parakeet-tdt-0.6b-v2-coreml"
    case .parakeetV3: return "parakeet-tdt-0.6b-v3-coreml"
    }
  }
}

/// On-device transcription for the keyboard. The FluidAudio-backed one in the keyboard; a fake
/// in tests. Every call happens on the main thread, and completions come back on it.
protocol DirectLocalTranscriber: AnyObject {
  /// The model loaded and ready to transcribe, if any.
  var readyModel: DirectLocalModel? { get }
  /// Loads `model` in the background when it isn't ready (or loading) already.
  func prepare(_ model: DirectLocalModel)
  func transcribe(
    wavURL: URL, languageHint: String?, completion: @escaping (Result<String, Error>) -> Void
  ) -> DirectCancellable
}

/// Wraps the keyboard's 16 kHz mono Int16 PCM in a WAV header, which is what the transcriber
/// reads from disk.
enum PcmWav {
  static let sampleRate: UInt32 = 16_000
  static let headerSize = 44

  static func wrap(pcmURL: URL, into wavURL: URL) throws {
    let pcm = try FileHandle(forReadingFrom: pcmURL)
    defer { try? pcm.close() }
    let dataSize = try pcm.seekToEnd()
    guard dataSize <= UInt64(UInt32.max) - UInt64(headerSize) else { throw CocoaError(.fileWriteFileExists) }
    try pcm.seek(toOffset: 0)

    FileManager.default.createFile(atPath: wavURL.path, contents: nil)
    let wav = try FileHandle(forWritingTo: wavURL)
    defer { try? wav.close() }
    try wav.truncate(atOffset: 0)
    try wav.write(contentsOf: header(dataSize: UInt32(dataSize)))
    // Streamed, as a five-minute take is ~9.6 MB and the keyboard's memory is tight.
    while let chunk = try pcm.read(upToCount: 64 * 1024), !chunk.isEmpty {
      try wav.write(contentsOf: chunk)
    }
  }

  static func header(dataSize: UInt32) -> Data {
    let channels: UInt16 = 1
    let bitsPerSample: UInt16 = 16
    let blockAlign = channels * bitsPerSample / 8
    var data = Data()
    data.append(contentsOf: Array("RIFF".utf8))
    append(UInt32(36) + dataSize, to: &data)
    data.append(contentsOf: Array("WAVE".utf8))
    data.append(contentsOf: Array("fmt ".utf8))
    append(UInt32(16), to: &data)  // PCM format chunk size
    append(UInt16(1), to: &data)  // PCM
    append(channels, to: &data)
    append(sampleRate, to: &data)
    append(sampleRate * UInt32(blockAlign), to: &data)  // byte rate
    append(blockAlign, to: &data)
    append(bitsPerSample, to: &data)
    data.append(contentsOf: Array("data".utf8))
    append(dataSize, to: &data)
    return data
  }

  private static func append<T: FixedWidthInteger>(_ value: T, to data: inout Data) {
    withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) }
  }
}

/// Whether the keyboard has room for Parakeet. From the spike on an iPhone 16 Pro (limit
/// 177 MB): a cold load rose ~42 MB, a transcription ~18 MB, recording ~4 MB.
struct KeyboardParakeetBudget {
  static let megabyte = 1024 * 1024
  /// The smallest keyboard limit (footprint + available) worth loading into.
  static let minimumLimit = 120 * megabyte
  static let loadHeadroom = 64 * megabyte
  static let transcriptionHeadroom = 32 * megabyte

  /// `available == 0` means no limit is reported (the simulator).
  static func allowsLoad(footprint: Int, available: Int) -> Bool {
    guard available != 0 else { return true }
    return footprint + available >= minimumLimit && available >= loadHeadroom
  }

  static func allowsTranscription(footprint: Int, available: Int) -> Bool {
    guard available != 0 else { return true }
    return available >= transcriptionHeadroom
  }
}
