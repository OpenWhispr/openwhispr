import Foundation

extension DirectDictationTests {
  static let validConfig = """
    {"version":1,"enabled":true,"disabledReason":null,"userId":"u1",
     "apiBaseUrl":"https://api.openwhispr.com","appVersion":"1.2.6","language":"en",
     "cleanup":{"enabled":true,"language":"en","toneApplies":true},
     "dictionary":{"personal":["Kubernetes"],"shared":["Gizmo"],"prompt":"Kubernetes, Gizmo"},
     "snippets":[{"trigger":"my email","replacement":"a@b.co"}],"futureField":1}
    """

  static let translatedConfig = validConfig.replacingOccurrences(
    of: #","futureField":1"#,
    with: #","translation":{"enabled":true,"prompt":"Translate the text into {{targetLanguage}}."},"futureField":1"#
  )

  static func testConfig() {
    let config = DirectDictationConfig.decode(validConfig)
    expect(config?.userId, "u1", "userId")
    expect(config?.apiBaseURL.absoluteString, "https://api.openwhispr.com", "apiBaseURL")
    expect(config?.cleanup, .init(enabled: true, language: "en", toneApplies: true), "cleanup")
    expect(config?.dictionary.personal, ["Kubernetes"], "personal")
    expect(config?.snippets, [.init(trigger: "my email", replacement: "a@b.co")], "snippets")
    expect(DirectDictationConfig.decode(nil) == nil, true, "nil json")
    expect(DirectDictationConfig.decode("{") == nil, true, "malformed")
    expect(DirectDictationConfig.decode(validConfig.replacingOccurrences(of: "\"version\":1", with: "\"version\":2")) == nil, true, "other version")
    expect(DirectDictationConfig.decode(validConfig.replacingOccurrences(of: "\"enabled\":true", with: "\"enabled\":false")) == nil, true, "disabled")
    expect(DirectDictationConfig.decode(validConfig.replacingOccurrences(of: "https://api.openwhispr.com", with: "http://evil.example")) == nil, true, "http refused")
    expect(DirectDictationConfig.decode(validConfig.replacingOccurrences(of: "https://api.openwhispr.com", with: "http://localhost:3000")) != nil, true, "localhost http allowed")
    expect(DirectDictationConfig.decode(validConfig.replacingOccurrences(of: "\"u1\"", with: "\"\"")) == nil, true, "empty user")
    let sparse = #"{"version":1,"enabled":true,"userId":"u1","apiBaseUrl":"https://api.openwhispr.com","cleanup":{"enabled":false},"dictionary":{},"snippets":[]}"#
    expect(DirectDictationConfig.decode(sparse)?.language == nil, true, "language optional")
    expect(DirectDictationConfig.decode(sparse)?.cleanup.toneApplies, false, "toneApplies defaults false")
    expect(DirectDictationConfig.decode(sparse)?.dictionary.prompt, "", "prompt defaults empty")
    // Snapshots written before translation have no "translation": it decodes as off.
    expect(config?.translation, .init(enabled: false, prompt: ""), "translation missing decodes as off")
    expect(DirectDictationConfig.decode(sparse)?.translation, .init(enabled: false, prompt: ""), "sparse translation off")
    expect(DirectDictationConfig.decode(translatedConfig)?.translation,
           .init(enabled: true, prompt: "Translate the text into {{targetLanguage}}."), "translation decoded")
  }
}
