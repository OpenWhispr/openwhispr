import Foundation

@main
struct ProviderRequestTransportTests {
  static func main() throws {
    let baseURL = ProcessInfo.processInfo.environment["PROVIDER_TEST_BASE_URL"]!
    let transport = ProviderRequestTransport()
    let semaphore = DispatchSemaphore(value: 0)
    var redirectStatus: Int?
    transport.request(
      requestId: "redirect-check",
      url: URL(string: "\(baseURL)/redirect")!,
      method: "POST",
      headers: ["Authorization": "Bearer synthetic-test-credential"],
      body: Data("test payload".utf8),
      bodyFileURL: nil,
      timeout: 5
    ) { result in
      if case .success(let response) = result { redirectStatus = response.status }
      semaphore.signal()
    }
    precondition(semaphore.wait(timeout: .now() + 10) == .success, "Redirect request timed out")
    precondition(redirectStatus == 307, "Redirect must be returned instead of followed")

    let bodyFile = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try Data("synthetic multipart audio".utf8).write(to: bodyFile)
    var uploadRedirectStatus: Int?
    transport.request(
      requestId: "upload-redirect-check", url: URL(string: "\(baseURL)/redirect")!, method: "POST",
      headers: ["Authorization": "Bearer synthetic-test-credential"], body: nil,
      bodyFileURL: bodyFile, timeout: 5
    ) { result in
      if case .success(let response) = result { uploadRedirectStatus = response.status }
      semaphore.signal()
    }
    precondition(semaphore.wait(timeout: .now() + 10) == .success, "File upload timed out")
    precondition(uploadRedirectStatus == 307, "File uploads must also refuse redirects")
    precondition(!FileManager.default.fileExists(atPath: bodyFile.path), "Temporary body file should be removed")

    var cancelled = false
    transport.request(
      requestId: "cancel-check", url: URL(string: "\(baseURL)/slow")!, method: "GET",
      headers: [:], body: nil, bodyFileURL: nil, timeout: 5
    ) { result in
      if case .failure(.cancelled) = result { cancelled = true }
      semaphore.signal()
    }
    transport.cancel(requestId: "cancel-check")
    precondition(semaphore.wait(timeout: .now() + 10) == .success, "Cancellation timed out")
    precondition(cancelled, "Cancellation must stop the native task")

    var cancelledBeforeStart = false
    let cancelledBodyFile = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try Data("cancelled audio".utf8).write(to: cancelledBodyFile)
    transport.cancel(requestId: "cancel-before-start")
    transport.request(
      requestId: "cancel-before-start", url: URL(string: "\(baseURL)/must-not-start")!, method: "POST",
      headers: [:], body: nil, bodyFileURL: cancelledBodyFile, timeout: 5
    ) { result in
      if case .failure(.cancelled) = result { cancelledBeforeStart = true }
      semaphore.signal()
    }
    precondition(semaphore.wait(timeout: .now() + 10) == .success, "Pre-start cancellation timed out")
    precondition(cancelledBeforeStart, "Cancellation before native registration must prevent the request")
    precondition(!FileManager.default.fileExists(atPath: cancelledBodyFile.path), "Cancelled body file should be removed")

    var responseBody: String?
    transport.request(
      requestId: "json-check", url: URL(string: "\(baseURL)/json")!, method: "POST",
      headers: ["Content-Type": "application/json"], body: Data("{}".utf8), bodyFileURL: nil, timeout: 5
    ) { result in
      if case .success(let response) = result { responseBody = response.body }
      semaphore.signal()
    }
    precondition(semaphore.wait(timeout: .now() + 10) == .success, "JSON request timed out")
    precondition(responseBody == "{\"text\":\"ok\"}", "Successful response should remain available")

    var failedResponseBody: String?
    transport.request(
      requestId: "error-check", url: URL(string: "\(baseURL)/error")!, method: "GET",
      headers: [:], body: nil, bodyFileURL: nil, timeout: 5
    ) { result in
      if case .success(let response) = result { failedResponseBody = response.body }
      semaphore.signal()
    }
    precondition(semaphore.wait(timeout: .now() + 10) == .success, "Error request timed out")
    precondition(failedResponseBody == "", "Provider error bodies must be redacted")

    var sameOriginRedirectStatus: Int?
    transport.request(
      requestId: "same-origin-redirect-check", url: URL(string: "\(baseURL)/redirect-same")!, method: "POST",
      headers: ["Authorization": "Bearer synthetic-test-credential"], body: Data("test payload".utf8),
      bodyFileURL: nil, timeout: 5
    ) { result in
      if case .success(let response) = result { sameOriginRedirectStatus = response.status }
      semaphore.signal()
    }
    precondition(semaphore.wait(timeout: .now() + 10) == .success, "Same-origin redirect timed out")
    precondition(sameOriginRedirectStatus == 307, "Same-origin redirects must also be returned instead of followed")

    var expired = false
    transport.request(
      requestId: "expire-check", url: URL(string: "\(baseURL)/slow")!, method: "GET",
      headers: [:], body: nil, bodyFileURL: nil, timeout: 5
    ) { result in
      if case .failure(.backgroundExpired) = result { expired = true }
      semaphore.signal()
    }
    transport.expire(requestId: "expire-check")
    precondition(semaphore.wait(timeout: .now() + 10) == .success, "Background expiry timed out")
    precondition(expired, "An expired background task must not look like a user cancellation")

    precondition(ProviderRequestTransport().resourceTimeout == 600, "Provider requests are capped at 10 minutes in total")
    let tricklingTransport = ProviderRequestTransport(resourceTimeout: 2)
    var trickleFailed = false
    let trickleStartedAt = Date()
    tricklingTransport.request(
      requestId: "trickle-check", url: URL(string: "\(baseURL)/trickle")!, method: "GET",
      headers: [:], body: nil, bodyFileURL: nil, timeout: 5
    ) { result in
      if case .failure(.timedOut) = result { trickleFailed = true }
      semaphore.signal()
    }
    precondition(semaphore.wait(timeout: .now() + 15) == .success, "Trickle request timed out")
    precondition(trickleFailed, "A server that keeps trickling bytes must hit the total request limit and say so")
    precondition(Date().timeIntervalSince(trickleStartedAt) < 5, "The total limit must stop the request before the trickle ends")

    let tlsURL = ProcessInfo.processInfo.environment["PROVIDER_TEST_TLS_URL"]!
    var untrusted = false
    transport.request(
      requestId: "tls-check", url: URL(string: "\(tlsURL)/json")!, method: "GET",
      headers: [:], body: nil, bodyFileURL: nil, timeout: 5
    ) { result in
      if case .failure(.untrustedCertificate) = result { untrusted = true }
      semaphore.signal()
    }
    precondition(semaphore.wait(timeout: .now() + 10) == .success, "TLS request timed out")
    precondition(untrusted, "A self-signed certificate must be reported as untrusted, not as a network failure")

    func classify(_ code: Int, host: String = "api.openai.com", elapsed: TimeInterval = 1) -> ProviderTransportError {
      ProviderRequestTransport.failure(
        for: NSError(domain: NSURLErrorDomain, code: code), host: host, elapsed: elapsed, resourceTimeout: 600)
    }
    guard case .network = classify(NSURLErrorSecureConnectionFailed) else {
      preconditionFailure("A handshake that fails for any reason, such as a dropped connection, must stay retryable")
    }
    guard case .untrustedCertificate = classify(NSURLErrorServerCertificateHasBadDate) else {
      preconditionFailure("An expired certificate must be reported as untrusted")
    }
    guard case .timedOut = classify(NSURLErrorTimedOut, elapsed: 600) else {
      preconditionFailure("Hitting the total request limit must not look like an unreachable server")
    }
    guard case .network = classify(NSURLErrorTimedOut, elapsed: 300) else {
      preconditionFailure("An idle timeout before the total limit stays a retryable network failure")
    }
    guard case .localNetwork = classify(NSURLErrorTimedOut, host: "192.168.1.20", elapsed: 300) else {
      preconditionFailure("A local server that stops answering points at Local Network access")
    }

    let limit = ProviderRequestTransport.audioLimitBytes
    precondition(limit == 25 * 1024 * 1024)
    let audioDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: audioDirectory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: audioDirectory) }
    func sparseFile(_ name: String, size: UInt64) throws -> URL {
      let url = audioDirectory.appendingPathComponent(name)
      FileManager.default.createFile(atPath: url.path, contents: nil)
      let handle = try FileHandle(forWritingTo: url)
      try handle.truncate(atOffset: size)
      try handle.close()
      return url
    }
    let atLimit = try sparseFile("at-limit.m4a", size: UInt64(limit))
    let overLimit = try sparseFile("over-limit.m4a", size: UInt64(limit) + 1)
    let missing = audioDirectory.appendingPathComponent("missing.m4a")
    precondition(ProviderRequestTransport.audioFileError(atLimit) == nil, "Audio at the limit is accepted")
    precondition(ProviderRequestTransport.audioFileError(overLimit) == .audioTooLarge, "Audio over the limit is refused natively")
    precondition(ProviderRequestTransport.audioFileError(missing) == .audioUnavailable)
    precondition(ProviderRequestTransport.fileURL(from: atLimit.absoluteString) == atLimit)
    precondition(ProviderRequestTransport.fileURL(from: atLimit.path) == atLimit)
    precondition(ProviderRequestTransport.fileURL(from: "https://example.com/audio.m4a") == nil)

    for value in ["https://example.com", "http://127.0.0.1", "http://192.168.1.2", "http://100.64.1.1", "http://host.local", "http://host.ts.net", "http://[::1]"] {
      precondition(ProviderRequestTransport.isAllowedURL(URL(string: value)!), "Expected allowed URL")
    }
    for value in ["http://example.com", "http://127.example.com", "https://user:secret@example.com", "file:///tmp/audio", "https://example.com/#token"] {
      precondition(!ProviderRequestTransport.isAllowedURL(URL(string: value)!), "Expected rejected URL")
    }
    let snapshot = """
    {"version":1,"jobId":"original-job","apiKey":"synthetic-secret","route":{"provider":"byok","inferenceRoute":{"mode":"providers","scope":"dictation","providerId":"openai","modelId":"whisper-1","endpoint":"https://api.openai.com/v1","credentialRef":"provider.openai","apiKey":"synthetic-secret"},"cleanupRoute":{"mode":"openwhispr","scope":"cleanup"},"agentRoute":{"mode":"local","scope":"agent"}}}
    """
    let metadata = ProviderJobMetadata.decode(snapshot)
    precondition(metadata?.jobId == "original-job")
    precondition(metadata?.route.cleanupRoute?.mode == "openwhispr")
    precondition(metadata?.route.agentRoute?.mode == "local")
    precondition(metadata?.matchesDestination(URL(string: "https://api.openai.com/v1/audio/transcriptions")!) == true)
    precondition(metadata?.matchesDestination(URL(string: "https://other.example.com/v1/audio/transcriptions")!) == false)
    precondition(metadata?.transcript(from: "{\"text\":\"saved raw transcript\"}") == "saved raw transcript")
    precondition(metadata?.resultEnvelope(text: "raw text")?.contains("original-job") == true)
    precondition(metadata?.encoded?.contains("synthetic-secret") == false)
    precondition(ProviderJobMetadata.decode(snapshot.replacingOccurrences(of: "https://api.openai.com/v1", with: "https://api.openai.com/v1?api_key=synthetic-secret")) == nil)
    precondition(ProviderJobMetadata.decode(snapshot.replacingOccurrences(of: "\"version\":1", with: "\"version\":2")) == nil)
    precondition(ProviderJobMetadata.decode(snapshot.replacingOccurrences(of: "\"scope\":\"dictation\"", with: "\"scope\":\"meeting\"")) == nil, "Meeting routes are not a mobile BYOK scope")
    let openAIDestination = URL(string: "https://api.openai.com/v1/audio/transcriptions")!
    precondition(ProviderRequestTransport.recoveryError(snapshotJSON: snapshot, destination: openAIDestination, audioUri: atLimit.absoluteString) == nil)
    precondition(
      ProviderRequestTransport.recoveryError(snapshotJSON: snapshot, destination: openAIDestination, audioUri: missing.absoluteString) == .audioUnavailable,
      "A missing recording is an audio failure, not an invalid route"
    )
    precondition(ProviderRequestTransport.recoveryError(snapshotJSON: snapshot, destination: openAIDestination, audioUri: overLimit.absoluteString) == .audioTooLarge)
    precondition(ProviderRequestTransport.recoveryError(snapshotJSON: snapshot, destination: URL(string: "https://other.example.com/v1/audio/transcriptions")!, audioUri: atLimit.absoluteString) == .invalidRecoveryRoute)
    precondition(ProviderRequestTransport.recoveryError(snapshotJSON: snapshot.replacingOccurrences(of: "\"scope\":\"dictation\"", with: "\"scope\":\"cleanup\""), destination: openAIDestination, audioUri: atLimit.absoluteString) == .invalidRecoveryRoute)
    precondition(ProviderRequestTransport.recoveryError(snapshotJSON: snapshot, destination: openAIDestination, audioUri: "") == .audioUnavailable)
    let contextSnapshot = snapshot.replacingOccurrences(of: "\"jobId\":\"original-job\"", with: "\"jobId\":\"original-job\",\"requestContext\":\"recording\"")
    precondition(ProviderJobMetadata.decode(contextSnapshot)?.resultEnvelope(text: "raw")?.contains("recording") == true)
    let suiteName = "ProviderRecoveryTests.\(UUID().uuidString)"
    let storage = UserDefaults(suiteName: suiteName)!
    defer { storage.removePersistentDomain(forName: suiteName) }
    storage.set("{\"version\":1,\"jobIds\":[\"indexed\"]}", forKey: "provider_pending_jobs")
    storage.set(snapshot, forKey: "keyboard_upload_route.original-job")
    storage.set("file:///older.wav", forKey: "keyboard_upload_audio.older")
    storage.set("{bad", forKey: "keyboard_provider_result.corrupt")
    precondition(ProviderRecoveryStore.pendingJobIds(in: storage) == ["corrupt", "indexed", "older", "original-job"], "Index must include every legacy or superseded job")
    ProviderRecoveryStore.clear(jobId: "original-job", in: storage)
    precondition(ProviderRecoveryStore.pendingJobIds(in: storage) == ["corrupt", "indexed", "older"], "Clearing one durable job must preserve others")
    precondition(storage.string(forKey: "provider_pending_jobs")?.contains("synthetic-secret") == false)
    storage.set("{broken", forKey: "provider_pending_jobs")
    precondition(ProviderRecoveryStore.pendingJobIds(in: storage) == ["corrupt", "older"], "Per-job records must repair an interrupted index write")
    print("Native redirect refusal, expiry, time limits, certificate errors, audio checks, URL rules, and secret-free recovery snapshots passed")
  }
}
