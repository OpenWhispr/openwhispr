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
    print("Native redirect refusal, JSON, error redaction, URL rules, and secret-free recovery snapshots passed")
  }
}
