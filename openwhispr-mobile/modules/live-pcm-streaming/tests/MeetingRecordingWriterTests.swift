import Darwin
import Foundation

@main
struct MeetingRecordingWriterTests {
  static let fileManager = FileManager.default
  // 100 ms of 16 kHz mono PCM16.
  static let chunk = Data(repeating: 1, count: 3_200)

  static func main() throws {
    // A write past the file size limit must fail with EFBIG, not kill the process.
    signal(SIGXFSZ, SIG_IGN)
    let dir = fileManager.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try fileManager.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? fileManager.removeItem(at: dir) }

    try initStartsAnExistingFileFromZero(dir)
    try headerIsPatchedEveryFiveSecondsWithoutFinish(dir)
    try finishIsIdempotentAndIgnoresLaterAppends(dir)
    try finishRemovesARecordingWithNoAudio(dir)
    try repairRefusesWhatItDidNotWrite(dir)
    try initThatCannotWriteRemovesTheFile(dir)
    try writeFailureStopsWritingAndReportsOnce(dir)
    try failureBeforeAnyAudioRemovesTheFile(dir)
    print("MeetingRecordingWriterTests: all passed")
  }

  static func expect(_ condition: Bool, _ message: String) {
    precondition(condition, message)
  }

  static func le32(_ data: Data, _ offset: Int) -> Int {
    let bytes = [UInt8](data)
    return Int(bytes[offset]) | Int(bytes[offset + 1]) << 8
      | Int(bytes[offset + 2]) << 16 | Int(bytes[offset + 3]) << 24
  }

  static func withFileSizeLimit(_ bytes: rlim_t, _ body: () throws -> Void) rethrows {
    var original = rlimit()
    getrlimit(RLIMIT_FSIZE, &original)
    var limited = original
    limited.rlim_cur = bytes
    setrlimit(RLIMIT_FSIZE, &limited)
    defer { setrlimit(RLIMIT_FSIZE, &original) }
    try body()
  }

  static func initStartsAnExistingFileFromZero(_ dir: URL) throws {
    let url = dir.appendingPathComponent("existing.wav")
    try Data(repeating: 7, count: 999).write(to: url)
    let writer = try MeetingRecordingWriter(url: url)
    let fresh = try Data(contentsOf: url)
    expect(fresh.count == 44, "truncated to a header")
    expect(le32(fresh, 4) == 36 && le32(fresh, 40) == 0, "header for no audio")
    writer.append(chunk)
    writer.finish()
    let done = try Data(contentsOf: url)
    expect(done.count == 44 + 3_200 && le32(done, 40) == 3_200, "only the new audio")
  }

  static func headerIsPatchedEveryFiveSecondsWithoutFinish(_ dir: URL) throws {
    let url = dir.appendingPathComponent("killed.wav")
    let writer = try MeetingRecordingWriter(url: url)
    for _ in 0..<60 { writer.append(chunk) }
    writer.waitUntilWritten()
    var data = try Data(contentsOf: url)
    expect(data.count == 44 + 192_000, "all 6 s on disk")
    expect(le32(data, 40) == 160_000 && le32(data, 4) == 36 + 160_000, "patched at 5 s")

    // The app is killed here; a stray odd byte is left at the end.
    let tail = try FileHandle(forWritingTo: url)
    try tail.seekToEnd()
    try tail.write(contentsOf: Data([9]))
    try tail.close()
    expect(MeetingRecordingWriter.repairHeader(at: url), "repaired")
    data = try Data(contentsOf: url)
    expect(le32(data, 40) == 192_000 && le32(data, 4) == 36 + 192_000, "sizes from the real length")
  }

  static func finishIsIdempotentAndIgnoresLaterAppends(_ dir: URL) throws {
    let url = dir.appendingPathComponent("finished.wav")
    let writer = try MeetingRecordingWriter(url: url)
    writer.append(chunk)
    writer.append(chunk)
    writer.finish()
    writer.append(chunk)
    writer.finish()
    let data = try Data(contentsOf: url)
    expect(data.count == 44 + 6_400 && le32(data, 40) == 6_400, "final sizes, nothing after finish")
  }

  static func finishRemovesARecordingWithNoAudio(_ dir: URL) throws {
    let url = dir.appendingPathComponent("empty.wav")
    let writer = try MeetingRecordingWriter(url: url)
    writer.finish()
    expect(!fileManager.fileExists(atPath: url.path), "an empty recording is removed")
  }

  static func repairRefusesWhatItDidNotWrite(_ dir: URL) throws {
    expect(!MeetingRecordingWriter.repairHeader(at: dir.appendingPathComponent("none.wav")), "missing")

    let short = dir.appendingPathComponent("short.wav")
    try Data(count: 20).write(to: short)
    expect(!MeetingRecordingWriter.repairHeader(at: short), "shorter than a header")

    let notWav = dir.appendingPathComponent("not.wav")
    try Data(repeating: 0, count: 100).write(to: notWav)
    expect(!MeetingRecordingWriter.repairHeader(at: notWav), "not a WAV")

    // A valid WAV with a LIST chunk before its data: offset 40 is not the data size.
    var listFirst = WavHeader.make(sampleRate: 16_000, channels: 1, bitsPerSample: 16, dataBytes: 8)
    listFirst.replaceSubrange(36..<44, with: Array("LIST".utf8) + [4, 0, 0, 0])
    listFirst.append(contentsOf: Array("INFO".utf8))
    listFirst.append(contentsOf: Array("data".utf8) + [8, 0, 0, 0])
    listFirst.append(Data(repeating: 3, count: 9))
    let otherLayout = dir.appendingPathComponent("list.wav")
    try listFirst.write(to: otherLayout)
    expect(!MeetingRecordingWriter.repairHeader(at: otherLayout), "data chunk elsewhere")
    expect(try Data(contentsOf: otherLayout) == listFirst, "left byte for byte")
  }

  static func initThatCannotWriteRemovesTheFile(_ dir: URL) throws {
    let url = dir.appendingPathComponent("no-room.wav")
    var threw = false
    withFileSizeLimit(20) {
      do {
        _ = try MeetingRecordingWriter(url: url)
      } catch {
        threw = true
      }
    }
    expect(threw, "the header write fails")
    expect(!fileManager.fileExists(atPath: url.path), "the created file is removed")

    let missingDir = dir.appendingPathComponent("no/such/dir.wav")
    expect((try? MeetingRecordingWriter(url: missingDir)) == nil, "unopenable path throws")
  }

  static func writeFailureStopsWritingAndReportsOnce(_ dir: URL) throws {
    let url = dir.appendingPathComponent("disk-full.wav")
    var failures = 0
    withFileSizeLimit(44 + 6_400 + 100) {
      guard let writer = try? MeetingRecordingWriter(url: url) else {
        expect(false, "header fits")
        return
      }
      writer.onFailure = { failures += 1 }
      for _ in 0..<5 { writer.append(chunk) }
      writer.finish()
    }
    expect(failures == 1, "reported once")
    let data = try Data(contentsOf: url)
    expect(data.count == 44 + 6_500, "nothing written after the failure")
    expect(le32(data, 40) == 6_500 && le32(data, 4) == 36 + 6_500, "sizes from what reached the file")
  }

  static func failureBeforeAnyAudioRemovesTheFile(_ dir: URL) throws {
    let url = dir.appendingPathComponent("full-at-start.wav")
    var failures = 0
    withFileSizeLimit(44) {
      guard let writer = try? MeetingRecordingWriter(url: url) else {
        expect(false, "header fits")
        return
      }
      writer.onFailure = { failures += 1 }
      writer.append(chunk)
      writer.finish()
    }
    expect(failures == 1, "reported once")
    expect(!fileManager.fileExists(atPath: url.path), "a failed recording with no audio is removed")
  }
}
