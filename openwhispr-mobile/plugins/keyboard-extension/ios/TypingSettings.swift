import Foundation

/// How the suggestion bar shares the top of the keyboard with the dictation controls.
enum SuggestionBarStyle: String {
  /// One strip: the three buttons at rest; while a word is typed, the suggestions sit
  /// between tone and the assistant and dictation is a mic button.
  case strip
  /// A suggestion row above the toolbar.
  case row
}

/// The typing preferences the app and the keyboard share through the App Group. The app
/// writes strings (its storage module only stores strings); the keyboard also writes the
/// language and layout when they are switched from the keyboard itself.
struct TypingSettings: Equatable {
  var language: TypingLanguage
  var layout: KeyLayoutKind
  var hapticsEnabled: Bool
  var barStyle: SuggestionBarStyle

  static let languageKey = "keyboard_typing_language"
  static let layoutKey = "keyboard_typing_layout"
  static let hapticsKey = "keyboard_haptics_enabled"
  static let barStyleKey = "keyboard_suggestion_bar_style"
  /// Milliseconds since 1970, set by the app's "Clear learned words"; the keyboard drops
  /// what it learned before then.
  static let learnedWordsClearedAtKey = "keyboard_learned_words_cleared_at_ms"

  /// The style used when none is stored. Flip this to compare the two layouts.
  static let defaultBarStyle = SuggestionBarStyle.strip

  /// Unset values fall back to the device: German when it comes before English in the
  /// preferred languages, and the layout that language usually has.
  init(
    defaults: UserDefaults?,
    preferredLanguages: [String] = Locale.preferredLanguages
  ) {
    let language = defaults?.string(forKey: TypingSettings.languageKey).flatMap(TypingLanguage.init(rawValue:))
      ?? TypingLanguage.preferred(from: preferredLanguages)
    self.language = language
    layout = defaults?.string(forKey: TypingSettings.layoutKey).flatMap(KeyLayoutKind.init(rawValue:))
      ?? language.defaultLayout
    hapticsEnabled = defaults?.string(forKey: TypingSettings.hapticsKey) != "0"
    barStyle = defaults?.string(forKey: TypingSettings.barStyleKey).flatMap(SuggestionBarStyle.init(rawValue:))
      ?? TypingSettings.defaultBarStyle
  }

  /// Records a language picked in the keyboard. The layout follows the language only when
  /// the user never chose one.
  static func store(language: TypingLanguage, in defaults: UserDefaults?) {
    defaults?.set(language.rawValue, forKey: languageKey)
  }

  static func store(layout: KeyLayoutKind, in defaults: UserDefaults?) {
    defaults?.set(layout.rawValue, forKey: layoutKey)
  }
}
