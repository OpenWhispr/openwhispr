import Foundation

extension DirectDictationTests {
  static func makeConfig(
    cleanup: Bool = true, language: String? = "en", toneApplies: Bool = true, personal: [String] = ["Kubernetes"],
    shared: [String] = ["Gizmo"], prompt: String = "Kubernetes, Gizmo", appVersion: String? = "1.2.6"
  ) -> DirectDictationConfig {
    DirectDictationConfig(
      userId: "u1",
      apiBaseURL: URL(string: "https://api.openwhispr.com")!,
      appVersion: appVersion,
      language: language,
      cleanup: .init(enabled: cleanup, language: language, toneApplies: toneApplies),
      dictionary: .init(personal: personal, shared: shared, prompt: prompt),
      snippets: []
    )
  }

  static func fieldList(_ config: DirectDictationConfig, tone: String) -> [String] {
    let context = DirectRequestContext(config: config, jobId: "123-abc", tone: tone, cookie: "session=1")
    return DirectDictationRequests.transcribeFields(context).map { "\($0.name)=\($0.value)" }
  }

  static func json(_ text: String) -> Data { Data(text.utf8) }

  static func testRequests() {
    let base = ["clientType=mobile", "requestContext=keyboard", "purpose=dictation", "jobId=123-abc",
                "clientTranscriptionId=123-abc"]
    let cleanupFields = ["cleanup=full", "cleanupEnabled=1", "cleanupTimeoutMs=12000"]

    expect(fieldList(makeConfig(), tone: "formal"),
           base + ["language=en", "prompt=Kubernetes, Gizmo"] + cleanupFields
             + ["cleanupLanguage=en", "cleanupLocale=en", "customDictionary=[\"Kubernetes\"]",
                "sharedDictionary=[\"Gizmo\"]", "tone=formal"],
           "fields: cleanup on, tone formal, language, shared words")
    expect(fieldList(makeConfig(cleanup: false), tone: "formal"),
           base + ["language=en", "prompt=Kubernetes, Gizmo"], "fields: cleanup off")
    expect(fieldList(makeConfig(shared: []), tone: "default"),
           base + ["language=en", "prompt=Kubernetes, Gizmo"] + cleanupFields
             + ["cleanupLanguage=en", "cleanupLocale=en", "customDictionary=[\"Kubernetes\"]"],
           "fields: default tone, no shared words")
    // As the app: no customDictionary field when there are no personal words.
    expect(fieldList(makeConfig(personal: [], shared: []), tone: "default").contains { $0.hasPrefix("customDictionary=") },
           false, "fields: no personal words")
    expect(fieldList(makeConfig(toneApplies: false), tone: "formal").contains { $0.hasPrefix("tone=") }, false,
           "fields: tone not applicable")
    expect(fieldList(makeConfig(language: nil, prompt: ""), tone: "casual"),
           base + cleanupFields + ["customDictionary=[\"Kubernetes\"]", "sharedDictionary=[\"Gizmo\"]", "tone=casual"],
           "fields: no language, no prompt")

    // The body file, byte for byte.
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("direct-req-\(UUID().uuidString)")
    try! FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: folder) }
    let audio = folder.appendingPathComponent("j1.m4a")
    let body = folder.appendingPathComponent("j1.body")
    try! Data([1, 2, 3, 4]).write(to: audio)
    let minimal = DirectRequestContext(
      config: makeConfig(cleanup: false, language: nil, prompt: ""), jobId: "j1", tone: "default", cookie: "session=1"
    )
    let request = try! DirectDictationRequests.makeTranscribeRequest(minimal, audioURL: audio, bodyURL: body, boundary: "B")
    var expected = Data()
    for (name, value) in [("clientType", "mobile"), ("requestContext", "keyboard"), ("purpose", "dictation"),
                          ("jobId", "j1"), ("clientTranscriptionId", "j1")] {
      expected.append(Data("--B\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".utf8))
    }
    expected.append(Data("--B\r\nContent-Disposition: form-data; name=\"file\"; filename=\"j1.m4a\"\r\nContent-Type: audio/mp4\r\n\r\n".utf8))
    expected.append(Data([1, 2, 3, 4]))
    expected.append(Data("\r\n--B--\r\n".utf8))
    expect(try! Data(contentsOf: body), expected, "multipart body file")
    expect(request.url?.absoluteString, "https://api.openwhispr.com/api/transcribe", "transcribe url")
    expect(request.url?.host, "api.openwhispr.com", "cookie only goes to the config's host")
    expect(request.httpMethod, "POST", "method")
    expect(request.httpBody == nil, true, "body comes from the file")
    expect(request.timeoutInterval, 60, "transcribe timeout")
    expect(request.value(forHTTPHeaderField: "Content-Type"), "multipart/form-data; boundary=B", "content type, boundary last and unquoted")
    expect(request.value(forHTTPHeaderField: "Cookie"), "session=1", "cookie")
    expect(request.value(forHTTPHeaderField: "x-openwhispr-platform"), "mobile", "platform header")
    expect(request.value(forHTTPHeaderField: "x-openwhispr-policy-version"), "1", "policy header")
    expect(request.value(forHTTPHeaderField: "x-openwhispr-version"), "1.2.6", "version header")
    let noVersion = DirectRequestContext(config: makeConfig(appVersion: nil), jobId: "j1", tone: "default", cookie: "c")
    let unversioned = try! DirectDictationRequests.makeTranscribeRequest(noVersion, audioURL: audio, bodyURL: body, boundary: "B")
    expect(unversioned.value(forHTTPHeaderField: "x-openwhispr-version") == nil, true, "no version header without a version")

    // The cleanup retry.
    let formal = DirectRequestContext(config: makeConfig(), jobId: "j1", tone: "formal", cookie: "session=1")
    let reason = try! DirectDictationRequests.makeReasonRequest(formal, rawText: "hello there")
    expect(reason.url?.absoluteString, "https://api.openwhispr.com/api/reason", "reason url")
    expect(reason.httpMethod, "POST", "reason method")
    expect(reason.timeoutInterval, 12, "reason timeout")
    expect(reason.value(forHTTPHeaderField: "Content-Type"), "application/json", "reason content type")
    expect(reason.value(forHTTPHeaderField: "x-openwhispr-cleanup-timeout-ms"), "12000", "reason cleanup timeout")
    expect(reason.value(forHTTPHeaderField: "Cookie"), "session=1", "reason cookie")
    let sent = (try? JSONSerialization.jsonObject(with: reason.httpBody ?? Data())) as? [String: Any] ?? [:]
    expect(sent["text"] as? String, "hello there", "reason text")
    expect(sent["promptMode"] as? String, "cleanup", "reason promptMode")
    expect(sent["purpose"] as? String, "cleanup", "reason purpose")
    expect(sent["clientType"] as? String, "mobile", "reason clientType")
    expect(sent["customDictionary"] as? [String], ["Kubernetes"], "reason dictionary")
    expect(sent["sharedDictionary"] as? [String], ["Gizmo"], "reason shared dictionary")
    expect(sent["language"] as? String, "en", "reason language")
    expect(sent["locale"] as? String, "en", "reason locale")
    expect(sent["tone"] as? String, "formal", "reason tone")
    let plain = DirectRequestContext(config: makeConfig(language: nil, toneApplies: false, shared: []), jobId: "j1", tone: "formal", cookie: "c")
    let plainBody = (try? JSONSerialization.jsonObject(with: (try! DirectDictationRequests.makeReasonRequest(plain, rawText: "x")).httpBody ?? Data())) as? [String: Any] ?? [:]
    expect(Set(plainBody.keys), ["text", "promptMode", "purpose", "clientType", "customDictionary"], "reason keys without optional values")

    // Responses.
    typealias R = DirectDictationRequests
    expect(R.parseTranscribe(status: 200, body: json(#"{"text":"Hello.","originalText":"hello","cleanupApplied":true}"#)),
           .success(text: "Hello.", originalText: "hello", cleanupApplied: true), "200 cleaned")
    expect(R.parseTranscribe(status: 200, body: json(#"{"cleaned_text":"Hi.","raw_text":"hi","cleanup_applied":false}"#)),
           .success(text: "Hi.", originalText: "hi", cleanupApplied: false), "200 snake_case aliases")
    expect(R.parseTranscribe(status: 200, body: json(#"{"originalText":"only raw"}"#)),
           .success(text: "only raw", originalText: "only raw", cleanupApplied: nil), "200 with only originalText")
    expect(R.parseTranscribe(status: 200, body: json(#"{"text":"  "}"#)), .noSpeech, "200 blank text")
    for key in ["original_text", "rawText", "raw_text", "rawTranscript", "raw_transcript"] {
      let body = try! JSONSerialization.data(withJSONObject: [key: "spoken words"])
      expect(R.parseTranscribe(status: 200, body: body),
             .success(text: "spoken words", originalText: "spoken words", cleanupApplied: nil), "raw alias " + key)
    }
    expect(R.parseTranscribe(status: 422, body: json(#"{"code":"NO_SPEECH_DETECTED"}"#)), .noSpeech, "422 no speech")
    expect(R.parseTranscribe(status: 422, body: json(#"{"code":"UNPROCESSABLE_AUDIO"}"#)), .rejected, "422 unprocessable")
    expect(R.parseTranscribe(status: 401, body: Data()), .unauthorized, "401")
    expect(R.parseTranscribe(status: 403, body: json(#"{"code":"POLICY_MODE_BLOCKED"}"#)), .policyBlocked, "403")
    expect(R.parseTranscribe(status: 426, body: Data()), .policyBlocked, "426")
    expect(R.parseTranscribe(status: 429, body: json(#"{"limitReached":true}"#)), .limitReached, "429")
    expect(R.parseTranscribe(status: 500, body: Data()), .retryable, "500")
    expect(R.parseTranscribe(status: 503, body: Data()), .retryable, "503")
    expect(R.parseTranscribe(status: 408, body: Data()), .retryable, "408")
    expect(R.parseTranscribe(status: 0, body: Data()), .retryable, "transport error")
    expect(R.parseTranscribe(status: 413, body: Data()), .rejected, "413")
    expect(R.parseTranscribe(status: 200, body: json("<html>")), .retryable, "200 that isn't JSON")
    expect(R.parseReason(status: 200, body: json(#"{"text":"Cleaned."}"#)), "Cleaned.", "reason 200")
    expect(R.parseReason(status: 200, body: json(#"{"text":""}"#)) == nil, true, "reason empty text")
    expect(R.parseReason(status: 403, body: json(#"{"text":"x"}"#)) == nil, true, "reason refused")
  }
}
