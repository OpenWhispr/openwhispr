import Foundation

// Writes a meeting's 16 kHz mono PCM16 to a WAV file while it records. The
// header is kept close to the truth (every 5 s of audio and at finish), so a
// file left by a killed app plays up to its last patch and repairRecording can
// fix the rest from the file's size.
//
// Threads: init runs on the caller's thread; append only enqueues, so it is
// safe on the audio render thread; every file operation runs on `queue`;
// finish blocks its caller until the queue has written and closed the file.
// onFailure runs on `queue` (or on finish's caller, inside finish), at most
// once; set it before the first append.
final class MeetingRecordingWriter {
  static let sampleRate = 16_000
  static let channels = 1
  static let bitsPerSample = 16
  private static let headerPatchIntervalBytes = sampleRate * channels * (bitsPerSample / 8) * 5

  let url: URL
  var onFailure: (() -> Void)?

  private let queue = DispatchQueue(label: "com.openwhispr.live-pcm-streaming.recording-writer")
  // Everything below is confined to `queue` after init.
  private var handle: FileHandle?
  private var dataBytes: UInt64 = 0
  private var bytesSinceHeaderPatch = 0
  private var finished = false

  /// Creates (or truncates) the file and writes a header for zero bytes of audio.
  init(url: URL) throws {
    self.url = url
    let header = WavHeader.make(
      sampleRate: Self.sampleRate,
      channels: Self.channels,
      bitsPerSample: Self.bitsPerSample,
      dataBytes: 0
    )
    try header.write(to: url)
    let fileHandle = try FileHandle(forWritingTo: url)
    do {
      try fileHandle.seekToEnd()
    } catch {
      try? fileHandle.close()
      throw error
    }
    handle = fileHandle
  }

  func append(_ pcm16: Data) {
    guard !pcm16.isEmpty else { return }
    queue.async { [self] in
      guard !finished, let handle else { return }
      do {
        try handle.write(contentsOf: pcm16)
        dataBytes += UInt64(pcm16.count)
        bytesSinceHeaderPatch += pcm16.count
        if bytesSinceHeaderPatch >= Self.headerPatchIntervalBytes {
          bytesSinceHeaderPatch = 0
          try Self.writeSizes(to: handle, dataBytes: Self.clampedDataBytes(dataBytes))
          try handle.seekToEnd()
        }
      } catch {
        failOnQueue()
      }
    }
  }

  /// Writes the final sizes and closes the file. Idempotent; later appends are ignored.
  func finish() {
    queue.sync { [self] in
      guard !finished else { return }
      finished = true
      guard let handle else { return }
      do {
        try Self.writeSizes(to: handle, dataBytes: Self.clampedDataBytes(dataBytes))
        try handle.synchronize()
        try handle.close()
        self.handle = nil
      } catch {
        failOnQueue()
      }
    }
  }

  // Runs on `queue`. Stops writing for good. The sizes are patched from what
  // actually reached the file, best effort: a full disk still takes an
  // in-place rewrite of bytes it already holds.
  private func failOnQueue() {
    guard let handle else { return }
    if let end = try? handle.seekToEnd() {
      let bytes = WavHeader.dataBytes(
        forFileSize: end,
        channels: Self.channels,
        bitsPerSample: Self.bitsPerSample
      )
      try? Self.writeSizes(to: handle, dataBytes: bytes)
    }
    try? handle.close()
    self.handle = nil
    onFailure?()
  }

  private static func clampedDataBytes(_ bytes: UInt64) -> UInt32 {
    return WavHeader.dataBytes(
      forFileSize: UInt64(WavHeader.byteCount) + bytes,
      channels: channels,
      bitsPerSample: bitsPerSample
    )
  }

  // Rewrites only the RIFF and data size fields; leaves the handle's offset moved.
  private static func writeSizes(to handle: FileHandle, dataBytes: UInt32) throws {
    let header = WavHeader.make(
      sampleRate: sampleRate,
      channels: channels,
      bitsPerSample: bitsPerSample,
      dataBytes: dataBytes
    )
    try handle.seek(toOffset: 4)
    try handle.write(contentsOf: header[4..<8])
    try handle.seek(toOffset: 40)
    try handle.write(contentsOf: header[40..<44])
  }

  /// Rewrites a recording's size fields from its real size, for a file whose
  /// writer never finished (the app was killed). False when the file is
  /// missing, shorter than a header, not a WAV file, or cannot be written.
  static func repairHeader(at url: URL) -> Bool {
    guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
          let size = (attributes[.size] as? NSNumber)?.uint64Value,
          size >= UInt64(WavHeader.byteCount) else {
      return false
    }
    do {
      let handle = try FileHandle(forUpdating: url)
      defer { try? handle.close() }
      guard let head = try handle.read(upToCount: 12), head.count == 12,
            String(bytes: head[0..<4], encoding: .ascii) == "RIFF",
            String(bytes: head[8..<12], encoding: .ascii) == "WAVE" else {
        return false
      }
      let bytes = WavHeader.dataBytes(forFileSize: size, channels: channels, bitsPerSample: bitsPerSample)
      try writeSizes(to: handle, dataBytes: bytes)
      try handle.synchronize()
      return true
    } catch {
      return false
    }
  }
}
