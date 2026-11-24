import Foundation

extension DirectDictationTests {
  static let validConfig = """
    {"version":2,"enabled":true,"disabledReason":null,"engine":"cloud","local":null,"userId":"u1",
     "apiBaseUrl":"https://api.openwhispr.com","appVersion":"1.2.6","language":"en",
     "cleanup":{"enabled":true,"language":"en","toneApplies":true},
     "dictionary":{"personal":["Kubernetes"],"shared":["Gizmo"],"prompt":"Kubernetes, Gizmo"},
     "snippets":[{"trigger":"my email","replacement":"a@b.co"}],"futureField":1}
    """

  /// The contract's Local example, as `src/lib/keyboardDirectSync.ts` writes it.
  static let localConfig = """
    {"version":2,"enabled":true,"disabledReason":null,"engine":"local",
     "local":{"model":"parakeet-v3","languageHint":"de"},"userId":"u1",
     "apiBaseUrl":"https://api.openwhispr.com","appVersion":"1.2.7","language":"de",
     "cleanup":{"enabled":false,"language":"de","toneApplies":false},
     "dictionary":{"personal":[],"shared":[],"prompt":""},
     "snippets":[{"trigger":"my email","replacement":"a@b.co"}]}
    """

  static func testConfig() {
    let config = DirectDictationConfig.decode(validConfig)
    expect(config?.userId, "u1", "userId")
    expect(config?.engine, .cloud(apiBaseURL: URL(string: "https://api.openwhispr.com")!), "cloud engine")
    expect(config?.cleanup, .init(enabled: true, language: "en", toneApplies: true), "cleanup")
    expect(config?.dictionary.personal, ["Kubernetes"], "personal")
    expect(config?.snippets, [.init(trigger: "my email", replacement: "a@b.co")], "snippets")
    expect(DirectDictationConfig.decode(nil) == nil, true, "nil json")
    expect(DirectDictationConfig.decode("{") == nil, true, "malformed")
    expect(DirectDictationConfig.decode(validConfig.replacingOccurrences(of: "\"version\":2", with: "\"version\":3")) == nil, true, "other version")
    expect(DirectDictationConfig.decode(validConfig.replacingOccurrences(of: "\"enabled\":true", with: "\"enabled\":false")) == nil, true, "disabled")
    expect(DirectDictationConfig.decode(validConfig.replacingOccurrences(of: "https://api.openwhispr.com", with: "http://evil.example")) == nil, true, "http refused")
    expect(DirectDictationConfig.decode(validConfig.replacingOccurrences(of: "https://api.openwhispr.com", with: "http://localhost:3000")) != nil, true, "localhost http allowed")
    expect(DirectDictationConfig.decode(validConfig.replacingOccurrences(of: "\"u1\"", with: "\"\"")) == nil, true, "empty user")
    let sparse = #"{"version":2,"enabled":true,"engine":"cloud","userId":"u1","apiBaseUrl":"https://api.openwhispr.com","cleanup":{"enabled":false},"dictionary":{},"snippets":[]}"#
    expect(DirectDictationConfig.decode(sparse)?.language == nil, true, "language optional")
    expect(DirectDictationConfig.decode(sparse)?.cleanup.toneApplies, false, "toneApplies defaults false")
    expect(DirectDictationConfig.decode(sparse)?.dictionary.prompt, "", "prompt defaults empty")

    testDecodesLocalConfig()
    testLocalNeedsNoApiBase()
    testRejectsVersion1()
    testRejectsUnknownEngine()
    testCloudStillNeedsHttps()
  }

  static func testDecodesLocalConfig() {
    let config = DirectDictationConfig.decode(localConfig)
    expect(config?.engine, .local(model: .parakeetV3, languageHint: "de"), "local: model and hint")
    expect(config?.userId, "u1", "local: userId kept")
    expect(config?.cleanup.enabled, false, "local: cleanup off")
    expect(config?.snippets, [.init(trigger: "my email", replacement: "a@b.co")], "local: snippets kept")
    let v2 = localConfig.replacingOccurrences(of: "parakeet-v3", with: "parakeet-v2")
      .replacingOccurrences(of: #""languageHint":"de""#, with: #""languageHint":null"#)
    expect(DirectDictationConfig.decode(v2)?.engine, .local(model: .parakeetV2, languageHint: nil), "local: v2, no hint")
    expect(DirectLocalModel.parakeetV2.folderName, "parakeet-tdt-0.6b-v2-coreml", "v2 folder")
    expect(DirectLocalModel.parakeetV3.folderName, "parakeet-tdt-0.6b-v3-coreml", "v3 folder")
  }

  static func testLocalNeedsNoApiBase() {
    let noBase = localConfig.replacingOccurrences(of: #""apiBaseUrl":"https://api.openwhispr.com","#, with: "")
    expect(noBase.contains("apiBaseUrl"), false, "fixture has no apiBaseUrl")
    expect(DirectDictationConfig.decode(noBase)?.engine, .local(model: .parakeetV3, languageHint: "de"), "local without apiBaseUrl decodes")
    let insecure = localConfig.replacingOccurrences(of: "https://api.openwhispr.com", with: "http://evil.example")
    expect(DirectDictationConfig.decode(insecure) != nil, true, "local ignores the base URL: nothing is sent to it")
  }

  static func testRejectsVersion1() {
    expect(DirectDictationConfig.decode(validConfig.replacingOccurrences(of: "\"version\":2", with: "\"version\":1")) == nil, true, "cloud v1 refused")
    expect(DirectDictationConfig.decode(localConfig.replacingOccurrences(of: "\"version\":2", with: "\"version\":1")) == nil, true, "local v1 refused")
    let legacy = #"{"version":1,"enabled":true,"userId":"u1","apiBaseUrl":"https://api.openwhispr.com"}"#
    expect(DirectDictationConfig.decode(legacy) == nil, true, "a version 1 snapshot (no engine) refused")
  }

  static func testRejectsUnknownEngine() {
    expect(DirectDictationConfig.decode(validConfig.replacingOccurrences(of: #""engine":"cloud""#, with: #""engine":"whisper""#)) == nil, true, "unknown engine")
    expect(DirectDictationConfig.decode(validConfig.replacingOccurrences(of: #""engine":"cloud","#, with: "")) == nil, true, "missing engine")
    expect(DirectDictationConfig.decode(localConfig.replacingOccurrences(of: "parakeet-v3", with: "parakeet-v9")) == nil, true, "unknown local model")
    expect(DirectDictationConfig.decode(localConfig.replacingOccurrences(of: #""local":{"model":"parakeet-v3","languageHint":"de"}"#, with: #""local":null"#)) == nil, true, "local without its model")
    let disabled = localConfig.replacingOccurrences(of: "\"enabled\":true", with: "\"enabled\":false")
      .replacingOccurrences(of: #""local":{"model":"parakeet-v3","languageHint":"de"}"#, with: #""local":null"#)
    expect(DirectDictationConfig.decode(disabled) == nil, true, "disabled local snapshot")
  }

  static func testCloudStillNeedsHttps() {
    for (base, accepted) in [("http://evil.example", false), ("ftp://api.openwhispr.com", false), ("https://", false),
                             ("http://localhost:3000", true), ("http://127.0.0.1:3000", true),
                             ("https://api.openwhispr.com", true)] {
      let json = validConfig.replacingOccurrences(of: "https://api.openwhispr.com", with: base)
      expect(DirectDictationConfig.decode(json) != nil, accepted, "cloud v2 base \(base)")
    }
    let noBase = validConfig.replacingOccurrences(of: #""apiBaseUrl":"https://api.openwhispr.com","#, with: "")
    expect(DirectDictationConfig.decode(noBase) == nil, true, "cloud needs apiBaseUrl")
  }
}
