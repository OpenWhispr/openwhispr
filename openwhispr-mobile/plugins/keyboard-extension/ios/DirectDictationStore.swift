import Foundation

/// One dictation the keyboard handled itself. The app reads these (`src/lib/keyboardDirectOutbox.ts`)
/// to add History rows and word counts, so the keys are part of a contract: keep them camelCase.
struct DirectDictationRecord: Codable, Equatable {
  enum Status: String, Codable { case pending, completed, failed }

  var jobId: String
  var status: Status
  var userId: String
  var documentID: UUID?
  var startedAtMs: Int64
  var completedAtMs: Int64?
  var durationMs: Int
  var tone: String
  var text: String?
  var originalText: String?
  var cleanupApplied: Bool?
  /// "cloud", or the Local model's raw value ("parakeet-v2", "parakeet-v3"). Records written
  /// before Local existed have none and are Cloud takes.
  var engine: String?
  /// The keyboard's target when the dictation started, so a resumed take translates into it.
  /// Only a Cloud take has one.
  var translationTarget: String?
  var translationLabel: String?
  /// The language `text` was translated into; nil when it wasn't.
  var translatedTo: String?
  /// The take had a target and `text` was left untranslated for a reason other than an unchanged
  /// reply, so History can say so. Optional: records written before it still decode.
  var translationFailed: Bool?

  static let cloudEngine = "cloud"

  var isCloud: Bool { engine == nil || engine == Self.cloudEngine }
}

/// Per-dictation files in the App Group container: `<jobId>.json` (the record), `<jobId>.pcm`
/// (the take while it is recorded), `<jobId>.m4a` (what is uploaded, and kept for a retry in
/// the app), `<jobId>.body` (the multipart upload) and `<jobId>.wav` (what a Local take hands
/// the transcriber). One file per dictation, so the keyboard
/// and the app never rewrite each other's data.
final class DirectDictationStore {
  static let folderName = "direct-dictations"
  static let resumeWindowMs: Int64 = 10 * 60 * 1000
  static let maxRecords = 500
  static let maxFailedAudio = 10

  private let directory: URL
  /// Epoch milliseconds; the state machine reads it too, so its tests share the store's clock.
  let now: () -> Int64
  private let fileManager = FileManager.default

  init(directory: URL, now: @escaping () -> Int64) {
    self.directory = directory
    self.now = now
  }

  func pcmURL(jobId: String) -> URL { directory.appendingPathComponent("\(jobId).pcm") }
  func audioURL(jobId: String) -> URL { directory.appendingPathComponent("\(jobId).m4a") }
  func bodyURL(jobId: String) -> URL { directory.appendingPathComponent("\(jobId).body") }
  func wavURL(jobId: String) -> URL { directory.appendingPathComponent("\(jobId).wav") }
  private func recordURL(jobId: String) -> URL { directory.appendingPathComponent("\(jobId).json") }
  // DirectAudioEncoder writes here first, then moves the finished file to audioURL.
  private func partialURL(jobId: String) -> URL { DirectAudioEncoder.partialURL(for: audioURL(jobId: jobId)) }

  /// Written before recording starts, so audio on disk always has an owner.
  func begin(
    jobId: String, userId: String, documentID: UUID, tone: String, engine: String,
    translationTarget: String?, translationLabel: String?
  ) throws {
    try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
    try write(DirectDictationRecord(
      jobId: jobId, status: .pending, userId: userId, documentID: documentID, startedAtMs: now(), completedAtMs: nil,
      durationMs: 0, tone: tone, text: nil, originalText: nil, cleanupApplied: nil,
      engine: engine, translationTarget: translationTarget, translationLabel: translationLabel,
      translatedTo: nil, translationFailed: nil
    ))
  }

  func setDuration(jobId: String, durationMs: Int) throws {
    guard var record = record(jobId: jobId) else { throw CocoaError(.fileReadNoSuchFile) }
    record.durationMs = durationMs
    try write(record)
  }

  func complete(
    jobId: String, text: String, originalText: String?, cleanupApplied: Bool?, translatedTo: String?,
    translationFailed: Bool, durationMs: Int
  ) throws {
    guard var record = record(jobId: jobId) else { return }
    record.status = .completed
    record.completedAtMs = now()
    record.durationMs = durationMs
    record.text = text
    record.originalText = originalText
    record.cleanupApplied = cleanupApplied
    record.translatedTo = translatedTo
    record.translationFailed = translationFailed
    try write(record)
    remove([
      pcmURL(jobId: jobId), audioURL(jobId: jobId), bodyURL(jobId: jobId), partialURL(jobId: jobId),
      wavURL(jobId: jobId),
    ])
  }

  /// History can retry from the encoded take, or from PCM if encoding failed (and always from
  /// PCM for a Local take, which is never encoded).
  func fail(jobId: String, durationMs: Int) throws {
    guard var record = record(jobId: jobId) else { return }
    record.status = .failed
    record.completedAtMs = now()
    record.durationMs = durationMs
    try write(record)
    remove([bodyURL(jobId: jobId), partialURL(jobId: jobId), wavURL(jobId: jobId)])
    if fileManager.fileExists(atPath: audioURL(jobId: jobId).path) { remove([pcmURL(jobId: jobId)]) }
    prune()
  }

  func cancel(jobId: String) {
    remove([
      recordURL(jobId: jobId), pcmURL(jobId: jobId), audioURL(jobId: jobId), bodyURL(jobId: jobId),
      partialURL(jobId: jobId), wavURL(jobId: jobId),
    ])
  }

  func record(jobId: String) -> DirectDictationRecord? {
    guard let data = try? Data(contentsOf: recordURL(jobId: jobId)) else { return nil }
    return try? JSONDecoder().decode(DirectDictationRecord.self, from: data)
  }

  /// The newest pending record of `userId` that started less than 10 minutes ago and still has
  /// its audio: the `.m4a`, or the `.pcm` of a take the keyboard was killed before encoding.
  /// Only Cloud takes: resuming means uploading, and a Local take never leaves the device.
  func resumable(userId: String, documentID: UUID) -> DirectDictationRecord? {
    let cutoff = now() - Self.resumeWindowMs
    return allRecords()
      .filter { record in
        record.status == .pending && record.isCloud && record.userId == userId && record.documentID == documentID
          && record.startedAtMs > cutoff
          && (fileManager.fileExists(atPath: audioURL(jobId: record.jobId).path)
            || fileManager.fileExists(atPath: pcmURL(jobId: record.jobId).path))
      }
      .max { order($0, $1) }
  }

  /// Keeps the 500 newest records and the audio of the 10 newest failed ones.
  func prune() {
    let records = allRecords().sorted { order($1, $0) }  // newest first
    for record in records.dropFirst(Self.maxRecords) { cancel(jobId: record.jobId) }
    let failed = records.prefix(Self.maxRecords).filter { $0.status == .failed }
    for record in failed.dropFirst(Self.maxFailedAudio) {
      remove([audioURL(jobId: record.jobId), pcmURL(jobId: record.jobId), wavURL(jobId: record.jobId)])
    }
  }

  private func allRecords() -> [DirectDictationRecord] {
    let names = (try? fileManager.contentsOfDirectory(atPath: directory.path)) ?? []
    return names
      .filter { $0.hasSuffix(".json") }
      .compactMap { record(jobId: String($0.dropLast(".json".count))) }
  }

  // Older first: by start time, then job id (which starts with the start time in ms).
  private func order(_ lhs: DirectDictationRecord, _ rhs: DirectDictationRecord) -> Bool {
    lhs.startedAtMs != rhs.startedAtMs ? lhs.startedAtMs < rhs.startedAtMs : lhs.jobId < rhs.jobId
  }

  private func write(_ record: DirectDictationRecord) throws {
    let data = try JSONEncoder().encode(record)
    try data.write(to: recordURL(jobId: record.jobId), options: .atomic)
  }

  private func remove(_ urls: [URL]) {
    for url in urls { try? fileManager.removeItem(at: url) }
  }
}
