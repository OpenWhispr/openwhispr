import Foundation

/// The app's snapshot of what a direct dictation needs, read from the App Group key
/// `keyboard_direct_config` (written by `src/lib/keyboardDirectSync.ts`). A snapshot this
/// build can't trust decodes to nil, and the keyboard keeps today's handoff.
struct DirectDictationConfig: Equatable {
  static let supportedVersion = 1

  struct Cleanup: Equatable {
    let enabled: Bool
    let language: String?
    let toneApplies: Bool
  }

  struct Dictionary: Equatable {
    let personal: [String]
    let shared: [String]
    let prompt: String
  }

  struct Snippet: Equatable {
    let trigger: String
    let replacement: String
  }

  let userId: String
  let apiBaseURL: URL
  let appVersion: String?
  let language: String?
  let cleanup: Cleanup
  let dictionary: Dictionary
  let snippets: [Snippet]

  /// nil unless the JSON parses, `version == 1`, `enabled == true`, `userId` is non-empty
  /// and `apiBaseUrl` is https (or http on localhost / 127.0.0.1).
  static func decode(_ json: String?) -> DirectDictationConfig? {
    guard let data = json?.data(using: .utf8),
      let raw = try? JSONDecoder().decode(Raw.self, from: data),
      raw.version == supportedVersion,
      raw.enabled == true,
      let userId = raw.userId, !userId.isEmpty,
      let base = raw.apiBaseUrl.flatMap(URL.init(string:)),
      isTrustedHost(base)
    else { return nil }

    return DirectDictationConfig(
      userId: userId,
      apiBaseURL: base,
      appVersion: raw.appVersion,
      language: nonEmpty(raw.language),
      cleanup: Cleanup(
        enabled: raw.cleanup?.enabled ?? false,
        language: nonEmpty(raw.cleanup?.language),
        toneApplies: raw.cleanup?.toneApplies ?? false
      ),
      dictionary: Dictionary(
        personal: raw.dictionary?.personal ?? [],
        shared: raw.dictionary?.shared ?? [],
        prompt: raw.dictionary?.prompt ?? ""
      ),
      snippets: (raw.snippets ?? []).map { Snippet(trigger: $0.trigger, replacement: $0.replacement) }
    )
  }

  // The session cookie goes to this host, so only TLS, or plain http on this device for
  // development against a local API.
  private static func isTrustedHost(_ url: URL) -> Bool {
    switch url.scheme?.lowercased() {
    case "https": return url.host?.isEmpty == false
    case "http": return url.host == "localhost" || url.host == "127.0.0.1"
    default: return false
    }
  }

  private static func nonEmpty(_ value: String?) -> String? {
    guard let value, !value.isEmpty else { return nil }
    return value
  }

  private struct Raw: Decodable {
    struct RawCleanup: Decodable {
      let enabled: Bool?
      let language: String?
      let toneApplies: Bool?
    }

    struct RawDictionary: Decodable {
      let personal: [String]?
      let shared: [String]?
      let prompt: String?
    }

    struct RawSnippet: Decodable {
      let trigger: String
      let replacement: String
    }

    let version: Int?
    let enabled: Bool?
    let userId: String?
    let apiBaseUrl: String?
    let appVersion: String?
    let language: String?
    let cleanup: RawCleanup?
    let dictionary: RawDictionary?
    let snippets: [RawSnippet]?
  }
}
