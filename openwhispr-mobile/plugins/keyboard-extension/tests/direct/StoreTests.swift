import Foundation

extension DirectDictationTests {
  final class TestClock {
    var ms: Int64 = 1_800_000_000_000
    func advance(seconds: Double) { ms += Int64(seconds * 1000) }
  }

  static func tempFolder(_ label: String) -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("direct-\(label)-\(UUID().uuidString)")
    try! FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
  }

  static func exists(_ url: URL) -> Bool { FileManager.default.fileExists(atPath: url.path) }

  static func testStore() {
    let documentID = UUID()
    let folder = tempFolder("store")
    defer { try? FileManager.default.removeItem(at: folder) }
    let clock = TestClock()
    let store = DirectDictationStore(directory: folder, now: { clock.ms })

    // begin → complete
    try! store.begin(jobId: "j1", userId: "u1", documentID: documentID, tone: "formal")
    let begun = store.record(jobId: "j1")
    expect(begun?.status, .pending, "begin writes a pending record")
    expect(begun?.startedAtMs, clock.ms, "startedAtMs from the clock")
    expect(begun?.tone, "formal", "tone recorded")
    expect(begun?.userId, "u1", "user recorded")
    for url in [store.pcmURL(jobId: "j1"), store.audioURL(jobId: "j1"), store.bodyURL(jobId: "j1")] {
      try! Data([0]).write(to: url)
    }
    clock.advance(seconds: 5)
    try! store.complete(jobId: "j1", text: "Hello.", originalText: "hello", cleanupApplied: true, durationMs: 4_000)
    let done = store.record(jobId: "j1")
    expect(done?.status, .completed, "complete sets the status")
    expect(done?.text, "Hello.", "complete keeps the text")
    expect(done?.originalText, "hello", "complete keeps the original")
    expect(done?.cleanupApplied, true, "complete keeps cleanupApplied")
    expect(done?.completedAtMs, clock.ms, "completedAtMs from the clock")
    expect(done?.durationMs, 4_000, "duration")
    expect(exists(store.pcmURL(jobId: "j1")) || exists(store.audioURL(jobId: "j1")) || exists(store.bodyURL(jobId: "j1")),
           false, "complete removes the audio and body")
    let keys = (try? JSONSerialization.jsonObject(with: Data(contentsOf: folder.appendingPathComponent("j1.json")))) as? [String: Any]
    expect(keys?["jobId"] as? String, "j1", "camelCase jobId on disk")
    expect(keys?["status"] as? String, "completed", "status on disk")

    // fail keeps the encoded audio only.
    try! store.begin(jobId: "j2", userId: "u1", documentID: documentID, tone: "default")
    for url in [store.pcmURL(jobId: "j2"), store.audioURL(jobId: "j2"), store.bodyURL(jobId: "j2")] {
      try! Data([0]).write(to: url)
    }
    try! store.fail(jobId: "j2", durationMs: 2_000)
    expect(store.record(jobId: "j2")?.status, .failed, "fail sets the status")
    expect(exists(store.audioURL(jobId: "j2")), true, "fail keeps the .m4a")
    expect(exists(store.pcmURL(jobId: "j2")), false, "fail removes the .pcm")
    expect(exists(store.bodyURL(jobId: "j2")), false, "fail removes the .body")

    // cancel leaves nothing.
    try! store.begin(jobId: "j3", userId: "u1", documentID: documentID, tone: "default")
    try! Data([0]).write(to: store.pcmURL(jobId: "j3"))
    try! Data([0]).write(to: store.audioURL(jobId: "j3"))
    store.cancel(jobId: "j3")
    let left = (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
    expect(left.filter { $0.hasPrefix("j3.") }, [], "cancel removes every file of the job")

    // resumable
    let resume = tempFolder("resume")
    defer { try? FileManager.default.removeItem(at: resume) }
    let resumeStore = DirectDictationStore(directory: resume, now: { clock.ms })
    try! resumeStore.begin(jobId: "r1", userId: "u1", documentID: documentID, tone: "default")
    try! Data([0]).write(to: resumeStore.audioURL(jobId: "r1"))
    clock.advance(seconds: 9 * 60)
    expect(resumeStore.resumable(userId: "u1", documentID: documentID)?.jobId, "r1", "resumable at 9 minutes")
    expect(resumeStore.resumable(userId: "u2", documentID: documentID) == nil, true, "not another user's")
    clock.advance(seconds: 2 * 60)
    expect(resumeStore.resumable(userId: "u1", documentID: documentID) == nil, true, "not after 10 minutes")
    try! resumeStore.begin(jobId: "r2", userId: "u1", documentID: documentID, tone: "default")
    try! Data([0]).write(to: resumeStore.pcmURL(jobId: "r2"))
    expect(resumeStore.resumable(userId: "u1", documentID: documentID)?.jobId, "r2", "a .pcm alone is resumable: it can still be encoded")
    try! Data([0]).write(to: resumeStore.audioURL(jobId: "r2"))
    expect(resumeStore.resumable(userId: "u1", documentID: documentID)?.jobId, "r2", "resumable once encoded")
    try! resumeStore.complete(jobId: "r2", text: "t", originalText: nil, cleanupApplied: nil, durationMs: 1)
    expect(resumeStore.resumable(userId: "u1", documentID: documentID) == nil, true, "not a completed record")

    // Older records omit the document ID. History can import them, but automatic insertion
    // cannot establish where they belong.
    let legacyRecord = #"{"jobId":"legacy","userId":"u1","status":"pending","startedAtMs":TIMESTAMP,"durationMs":1000,"tone":"default"}"#
      .replacingOccurrences(of: "TIMESTAMP", with: String(clock.ms))
    try! Data(legacyRecord.utf8).write(to: resume.appendingPathComponent("legacy.json"))
    try! Data([0]).write(to: resumeStore.audioURL(jobId: "legacy"))
    expect(resumeStore.record(jobId: "legacy")?.status, .pending, "legacy records remain readable")
    expect(resumeStore.resumable(userId: "u1", documentID: documentID) == nil, true, "legacy takes cannot auto-resume")

    // A corrupt record is skipped, not fatal.
    try! Data("{".utf8).write(to: resume.appendingPathComponent("broken.json"))
    expect(resumeStore.record(jobId: "broken") == nil, true, "corrupt record reads as nil")
    expect(resumeStore.resumable(userId: "u1", documentID: documentID) == nil, true, "corrupt record ignored")

    // prune: 502 completed → 500 newest.
    let many = tempFolder("prune")
    defer { try? FileManager.default.removeItem(at: many) }
    let pruneClock = TestClock()
    let pruneStore = DirectDictationStore(directory: many, now: { pruneClock.ms })
    for index in 0..<502 {
      let id = String(format: "p%03d", index)
      try! pruneStore.begin(jobId: id, userId: "u1", documentID: documentID, tone: "default")
      try! pruneStore.complete(jobId: id, text: "t", originalText: nil, cleanupApplied: nil, durationMs: 1)
      pruneClock.advance(seconds: 1)
    }
    pruneStore.prune()
    let kept = ((try? FileManager.default.contentsOfDirectory(atPath: many.path)) ?? []).filter { $0.hasSuffix(".json") }
    expect(kept.count, 500, "prune keeps 500 records")
    expect(kept.contains("p000.json") || kept.contains("p001.json"), false, "prune drops the oldest")

    // prune: 12 failed → 12 records, 10 newest audio files.
    let failed = tempFolder("prune-failed")
    defer { try? FileManager.default.removeItem(at: failed) }
    let failedStore = DirectDictationStore(directory: failed, now: { pruneClock.ms })
    for index in 0..<12 {
      let id = String(format: "f%02d", index)
      try! failedStore.begin(jobId: id, userId: "u1", documentID: documentID, tone: "default")
      let audio = index.isMultiple(of: 2) ? failedStore.pcmURL(jobId: id) : failedStore.audioURL(jobId: id)
      try! Data([0]).write(to: audio)
      try! failedStore.fail(jobId: id, durationMs: 1)
      pruneClock.advance(seconds: 1)
    }
    let files = (try? FileManager.default.contentsOfDirectory(atPath: failed.path)) ?? []
    expect(files.filter { $0.hasSuffix(".json") }.count, 12, "failed records all kept")
    expect(files.filter { $0.hasSuffix(".m4a") || $0.hasSuffix(".pcm") }.count, 10, "only 10 failed audio files kept")
    expect(files.contains("f00.pcm") || files.contains("f01.m4a"), false, "oldest failed audio dropped")
  }
}
