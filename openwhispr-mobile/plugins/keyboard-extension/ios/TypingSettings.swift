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
  /// Each of these can be turned off on its own, from the keyboard's own menu.
  var swipeEnabled = true
  var smartTargetsEnabled = true
  var autocorrectEnabled = true
  /// False when the user types in a language the keyboard has no word list for: no
  /// suggestions, corrections, swipe or smart targets, which would all pull towards English
  /// or German words. The keys, haptics and trackpad stay.
  var typingHelpEnabled = true
  /// Swiss French: è, é and à have keys of their own, where the umlauts are on a German
  /// keyboard. There is no French word list, so it comes without typing help.
  var swissFrenchKeys = false

  static let languageKey = "keyboard_typing_language"
  /// Stored under `languageKey` for a language without typing help.
  static let otherLanguageValue = "other"
  /// Stored under `languageKey` for the Swiss French keys.
  static let swissFrenchValue = "fr_CH"
  static let layoutKey = "keyboard_typing_layout"
  static let hapticsKey = "keyboard_haptics_enabled"
  static let barStyleKey = "keyboard_suggestion_bar_style"
  static let swipeKey = "keyboard_swipe_typing_enabled"
  static let smartTargetsKey = "keyboard_smart_targets_enabled"
  static let autocorrectKey = "keyboard_autocorrect_enabled"
  /// Milliseconds since 1970, set by the app's "Clear learned words"; the keyboard drops
  /// what it learned before then.
  static let learnedWordsClearedAtKey = "keyboard_learned_words_cleared_at_ms"

  /// The style used when none is stored. Flip this to compare the two layouts.
  static let defaultBarStyle = SuggestionBarStyle.strip

  /// Unset values fall back to the device: typing help when one of its preferred languages is
  /// English or German, German rows when German comes before English, and the layout that
  /// language usually has.
  init(
    defaults: UserDefaults?,
    preferredLanguages: [String] = Locale.preferredLanguages
  ) {
    let storedLanguage = defaults?.string(forKey: TypingSettings.languageKey)
    swissFrenchKeys = storedLanguage == TypingSettings.swissFrenchValue
    if let storedLanguage {
      typingHelpEnabled = storedLanguage != TypingSettings.otherLanguageValue && !swissFrenchKeys
    } else {
      // Nobody chose: help only when one of the device's languages is one the keyboard has a
      // word list for. A French speaker's text must not be corrected towards English; someone
      // who lists English second does type it.
      typingHelpEnabled = preferredLanguages.isEmpty
        || preferredLanguages.contains { TypingLanguage(rawValue: String($0.lowercased().prefix(2))) != nil }
    }
    // "Other" still needs letter rows and an emoji search language: the device's.
    let language = storedLanguage.flatMap(TypingLanguage.init(rawValue:))
      ?? TypingLanguage.preferred(from: preferredLanguages)
    self.language = language
    layout = defaults?.string(forKey: TypingSettings.layoutKey).flatMap(KeyLayoutKind.init(rawValue:))
      ?? (swissFrenchKeys ? .qwertz : language.defaultLayout)
    hapticsEnabled = defaults?.string(forKey: TypingSettings.hapticsKey) != "0"
    barStyle = defaults?.string(forKey: TypingSettings.barStyleKey).flatMap(SuggestionBarStyle.init(rawValue:))
      ?? TypingSettings.defaultBarStyle
    swipeEnabled = defaults?.string(forKey: TypingSettings.swipeKey) != "0"
    smartTargetsEnabled = defaults?.string(forKey: TypingSettings.smartTargetsKey) != "0"
    autocorrectEnabled = defaults?.string(forKey: TypingSettings.autocorrectKey) != "0"
  }

  /// Records a language picked in the keyboard. The layout follows the language only when
  /// the user never chose one.
  static func store(language: TypingLanguage, in defaults: UserDefaults?) {
    defaults?.set(language.rawValue, forKey: languageKey)
  }

  static func storeOtherLanguage(in defaults: UserDefaults?) {
    defaults?.set(otherLanguageValue, forKey: languageKey)
  }

  static func storeSwissFrench(in defaults: UserDefaults?) {
    defaults?.set(swissFrenchValue, forKey: languageKey)
  }

  static func store(layout: KeyLayoutKind, in defaults: UserDefaults?) {
    defaults?.set(layout.rawValue, forKey: layoutKey)
  }
}
