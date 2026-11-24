import Foundation

/// A dictation translation target, as the app writes it to the App Group (registry code and label).
struct TranslationLanguage: Equatable, Decodable {
  let code: String
  let label: String
}

/// What the keyboard's options menu shows, kept UIKit-free so it can be tested with plain swiftc.
enum KeyboardOptionsMenu {
  static let maxRecents = 3

  struct TranslateSection: Equatable {
    /// nil = Off.
    let selected: String?
    let recents: [TranslationLanguage]
    let all: [TranslationLanguage]
    let locked: Bool
  }

  static func decodeLanguages(_ json: String?) -> [TranslationLanguage] {
    decode(json) ?? []
  }

  static func decodeRecents(_ json: String?) -> [String] {
    decode(json) ?? []
  }

  /// A stored code the app no longer lists (or translation being unavailable) reads as Off, so the
  /// keyboard never translates into a language the user can't see or change.
  static func effectiveTarget(stored: String?, languages: [TranslationLanguage], applicable: Bool) -> String? {
    guard applicable, let stored, languages.contains(where: { $0.code == stored }) else { return nil }
    return stored
  }

  static func translateSection(
    stored: String?, languages: [TranslationLanguage], recents: [String], applicable: Bool
  ) -> TranslateSection {
    let recentLanguages = recents
      .compactMap { code in languages.first { $0.code == code } }
      .prefix(maxRecents)
    return TranslateSection(
      selected: effectiveTarget(stored: stored, languages: languages, applicable: applicable),
      recents: Array(recentLanguages),
      all: languages,
      locked: !applicable)
  }

  static func recentsAfterSelecting(_ code: String, current: [String]) -> [String] {
    Array(([code] + current.filter { $0 != code }).prefix(maxRecents))
  }

  /// "es" → "ES", "zh-CN" → "ZH": the base language only, so the badge stays short.
  static func badge(for target: String?) -> String? {
    guard let target else { return nil }
    let base = target.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false).first ?? ""
    return String(base.prefix(3)).uppercased()
  }

  private static func decode<T: Decodable>(_ json: String?) -> T? {
    guard let data = json?.data(using: .utf8) else { return nil }
    return try? JSONDecoder().decode(T.self, from: data)
  }
}
