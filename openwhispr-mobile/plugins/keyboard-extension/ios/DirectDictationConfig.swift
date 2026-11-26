import Foundation

/// The app's snapshot of what a direct dictation needs, read from the App Group key
/// `keyboard_direct_config` (written by `src/lib/keyboardDirectSync.ts`). A snapshot this
/// build can't trust decodes to nil, and the keyboard keeps today's handoff.
struct DirectDictationConfig: Equatable {
  static let supportedVersion = 2

  /// Where the take is transcribed. Only `.cloud` carries a server: a Local snapshot has no
  /// URL to send anything to.
  enum Engine: Equatable {
    case cloud(apiBaseURL: URL)
    case local(model: DirectLocalModel, languageHint: String?)
  }

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

  /// `prompt` carries `{{targetLanguage}}`. Off for snapshots written before translation.
  struct Translation: Equatable {
    let enabled: Bool
    let prompt: String
  }

  let userId: String
  let engine: Engine
  let appVersion: String?
  let language: String?
  let cleanup: Cleanup
  let dictionary: Dictionary
  let snippets: [Snippet]
  let translation: Translation

  /// nil unless the JSON parses, `version == 2`, `enabled == true` and `userId` is non-empty.
  /// A Cloud snapshot also needs `apiBaseUrl` to be https (or http on localhost / 127.0.0.1);
  /// a Local one needs a known `local.model` and no URL.
  static func decode(_ json: String?) -> DirectDictationConfig? {
    guard let data = json?.data(using: .utf8),
      let raw = try? JSONDecoder().decode(Raw.self, from: data),
      raw.version == supportedVersion,
      raw.enabled == true,
      let userId = raw.userId, !userId.isEmpty,
      let engine = decodeEngine(raw)
    else { return nil }

    return DirectDictationConfig(
      userId: userId,
      engine: engine,
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
      snippets: (raw.snippets ?? []).map { Snippet(trigger: $0.trigger, replacement: $0.replacement) },
      translation: Translation(
        enabled: raw.translation?.enabled ?? false,
        prompt: raw.translation?.prompt ?? ""
      )
    )
  }

  // A missing `engine` is not read as Cloud: version 2 always writes it, so its absence means
  // a snapshot this build doesn't understand.
  private static func decodeEngine(_ raw: Raw) -> Engine? {
    switch raw.engine {
    case "cloud":
      guard let base = raw.apiBaseUrl.flatMap(URL.init(string:)), isTrustedHost(base) else { return nil }
      return .cloud(apiBaseURL: base)
    case "local":
      guard let model = raw.local?.model.flatMap(DirectLocalModel.init(rawValue:)) else { return nil }
      return .local(model: model, languageHint: nonEmpty(raw.local?.languageHint))
    default:
      return nil
    }
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

    struct RawLocal: Decodable {
      let model: String?
      let languageHint: String?
    }

    struct RawSnippet: Decodable {
      let trigger: String
      let replacement: String
    }

    struct RawTranslation: Decodable {
      let enabled: Bool?
      let prompt: String?
    }

    let version: Int?
    let enabled: Bool?
    let engine: String?
    let local: RawLocal?
    let userId: String?
    let apiBaseUrl: String?
    let appVersion: String?
    let language: String?
    let cleanup: RawCleanup?
    let dictionary: RawDictionary?
    let snippets: [RawSnippet]?
    let translation: RawTranslation?
  }
}
