import Foundation

public enum ProviderRecoveryStore {
  private static let lock = NSLock()
  private static let indexKey = "provider_pending_jobs"
  private static let jobPrefixes = ["keyboard_upload_route.", "keyboard_upload_audio.", "keyboard_provider_result."]
  private struct PendingIndex: Codable {
    let version: Int
    let jobIds: [String]
  }

  // Scanning also migrates legacy per-job entries and repairs interrupted index writes.
  static func pendingJobIds(in storage: UserDefaults) -> [String] {
    var ids = Set<String>()
    if let raw = storage.string(forKey: indexKey), let data = raw.data(using: .utf8),
       let index = try? JSONDecoder().decode(PendingIndex.self, from: data), index.version == 1 {
      ids.formUnion(index.jobIds.filter { !$0.isEmpty && $0.count <= 128 })
    }
    for key in storage.dictionaryRepresentation().keys {
      for prefix in jobPrefixes where key.hasPrefix(prefix) {
        let jobId = String(key.dropFirst(prefix.count))
        if !jobId.isEmpty && jobId.count <= 128 { ids.insert(jobId) }
      }
    }
    return ids.sorted()
  }

  private static func writeIndex(_ ids: [String], in storage: UserDefaults) {
    if let data = try? JSONEncoder().encode(PendingIndex(version: 1, jobIds: ids)),
       let raw = String(data: data, encoding: .utf8) { storage.set(raw, forKey: indexKey) }
  }

  public static func listPendingJobIds() throws -> [String] {
    lock.lock(); defer { lock.unlock() }
    let storage = try defaults()
    let ids = pendingJobIds(in: storage)
    writeIndex(ids, in: storage)
    storage.synchronize()
    return ids
  }

  static func clear(jobId: String, in storage: UserDefaults) {
    let remaining = pendingJobIds(in: storage).filter { $0 != jobId }
    for prefix in jobPrefixes { storage.removeObject(forKey: prefix + jobId) }
    writeIndex(remaining, in: storage)
    storage.synchronize()
  }

  public static func clear(jobId: String) throws {
    lock.lock(); defer { lock.unlock() }
    clear(jobId: jobId, in: try defaults())
  }

  private static func validated(_ snapshotJSON: String) throws -> ProviderJobMetadata {
    guard let metadata = ProviderJobMetadata.decode(snapshotJSON), metadata.route.provider == "byok",
          ["dictation", "upload"].contains(metadata.route.inferenceRoute?.scope ?? "") else {
      throw NSError(domain: "ProviderRecovery", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid provider recovery route."])
    }
    return metadata
  }

  private static func defaults() throws -> UserDefaults {
    let bundleId = Bundle.main.bundleIdentifier ?? "com.gizmolabs.openwhispr"
    guard let defaults = UserDefaults(suiteName: "group.\(bundleId)") else {
      throw NSError(domain: "ProviderRecovery", code: 2, userInfo: [NSLocalizedDescriptionKey: "Provider recovery storage is unavailable."])
    }
    return defaults
  }

  public static func savePending(snapshotJSON: String, audioUri: String) throws {
    let metadata = try validated(snapshotJSON)
    guard let audioURL = audioUri.hasPrefix("file://") ? URL(string: audioUri) : (audioUri.hasPrefix("/") ? URL(fileURLWithPath: audioUri) : nil),
          audioURL.isFileURL, FileManager.default.fileExists(atPath: audioURL.path) else {
      throw NSError(domain: "ProviderRecovery", code: 3, userInfo: [NSLocalizedDescriptionKey: "The original recording is unavailable."])
    }
    lock.lock(); defer { lock.unlock() }
    let storage = try defaults()
    storage.set(metadata.encoded, forKey: "keyboard_upload_route.\(metadata.jobId)")
    storage.set(audioUri, forKey: "keyboard_upload_audio.\(metadata.jobId)")
    writeIndex(pendingJobIds(in: storage), in: storage)
    storage.synchronize()
  }

  public static func saveResult(snapshotJSON: String, text: String) throws {
    let metadata = try validated(snapshotJSON)
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, let result = metadata.resultEnvelope(text: trimmed) else {
      throw NSError(domain: "ProviderRecovery", code: 4, userInfo: [NSLocalizedDescriptionKey: "Provider transcript is unavailable."])
    }
    lock.lock(); defer { lock.unlock() }
    let storage = try defaults()
    storage.set(result, forKey: "keyboard_provider_result.\(metadata.jobId)")
    writeIndex(pendingJobIds(in: storage), in: storage)
    storage.synchronize()
  }
}
