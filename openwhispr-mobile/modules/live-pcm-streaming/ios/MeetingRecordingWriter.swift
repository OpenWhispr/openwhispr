import Foundation

// Writes a meeting's 16 kHz mono PCM16 to a WAV file while it records. The
// header is kept close to the truth (every 5 s of audio and at finish), so a
// file left by a killed app plays up to its last patch and repairRecording can
// fix the rest from the file's size.
//
// Threads: init runs on the caller's thread; append only enqueues, so it is
// safe on the audio render thread; every file operation after init runs on `queue`;
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

  /// Creates (or truncates) the file and writes a header for zero bytes of
  /// audio. A file it created but could not write is removed before throwing.
  init(url: URL) throws {
    self.url = url
    let header = WavHeader.make(
      sampleRate: Self.sampleRate,
      channels: Self.channels,
      bitsPerSample: Self.bitsPerSample,
      dataBytes: 0
    )
    let descriptor = open(url.path, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
    guard descriptor >= 0 else {
      throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
    let fileHandle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    do {
      try fileHandle.write(contentsOf: header)
    } catch {
      try? fileHandle.close()
      try? FileManager.default.removeItem(at: url)
      throw error
    }
    handle = fileHandle
    // The recording lives in Documents only so iOS never purges it mid-meeting; it is
    // temporary and must not ride along in an iCloud or device backup.
    Self.excludeFromBackup(url)
  }

  /// Marks a file as left out of iCloud and device backups. False when it could
  /// not be set (the file is missing). A file written again by replacing it
  /// loses the mark and needs it set again.
  @discardableResult
  static func excludeFromBackup(_ url: URL) -> Bool {
    var target = url
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    do {
      try target.setResourceValues(values)
      return true
    } catch {
      return false
    }
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

  /// Blocks until every append queued so far has reached the file, without
  /// finishing it. Lets tests read a recording as a killed app would leave it.
  func waitUntilWritten() {
    queue.sync {}
  }

  /// Writes the final sizes and closes the file, or removes it when no audio
  /// was ever written (an empty recording must never stand in for one).
  /// Idempotent; later appends are ignored.
  func finish() {
    queue.sync { [self] in
      guard !finished else { return }
      finished = true
      guard let handle else { return }
      if dataBytes > 0 {
        do {
          try Self.writeSizes(to: handle, dataBytes: Self.clampedDataBytes(dataBytes))
          try handle.synchronize()
        } catch {
          failOnQueue()
          return
        }
      }
      // The file is complete once its sizes are synced; a failed close loses nothing.
      try? handle.close()
      self.handle = nil
      if dataBytes == 0 {
        try? FileManager.default.removeItem(at: url)
      }
    }
  }

  // Runs on `queue`. Stops writing for good. The sizes are patched from what
  // actually reached the file, best effort: a full disk still takes an
  // in-place rewrite of bytes it already holds. A file left with no audio is
  // removed.
  private func failOnQueue() {
    guard let handle else { return }
    var audioBytes: UInt32 = 0
    if let end = try? handle.seekToEnd() {
      audioBytes = WavHeader.dataBytes(
        forFileSize: end,
        channels: Self.channels,
        bitsPerSample: Self.bitsPerSample
      )
      if audioBytes > 0 {
        try? Self.writeSizes(to: handle, dataBytes: audioBytes)
      }
    }
    try? handle.close()
    self.handle = nil
    if !Self.keepsFileAfterFailure(audioBytesOnDisk: audioBytes, dataBytesWritten: dataBytes) {
      try? FileManager.default.removeItem(at: url)
    }
    onFailure?()
  }

  // A failed seekToEnd reads as no audio on disk, so the bytes this writer itself wrote are
  // the floor: a file that holds audio is never deleted for a size it could not read.
  static func keepsFileAfterFailure(audioBytesOnDisk: UInt32, dataBytesWritten: UInt64) -> Bool {
    return audioBytesOnDisk > 0 || dataBytesWritten > 0
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
  /// missing, shorter than a header, not a canonical WAV file (its data chunk
  /// right after a 16-byte fmt chunk), or cannot be written.
  static func repairHeader(at url: URL) -> Bool {
    guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
          let size = (attributes[.size] as? NSNumber)?.uint64Value,
          size >= UInt64(WavHeader.byteCount) else {
      return false
    }
    do {
      let handle = try FileHandle(forUpdating: url)
      defer { try? handle.close() }
      // Offset 40 is the data size only when `data` sits at 36; anything else
      // is not a file this writer made and is left untouched.
      guard let head = try handle.read(upToCount: 40), head.count == 40,
            String(bytes: head[0..<4], encoding: .ascii) == "RIFF",
            String(bytes: head[8..<12], encoding: .ascii) == "WAVE",
            String(bytes: head[36..<40], encoding: .ascii) == "data" else {
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
