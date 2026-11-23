import Foundation

/// Everything the keyboard needs to type in one language: the bundled lexicon, the
/// corrector over it, the session that follows the text, and the user's learned words.
/// Loading it maps the lexicon file and reads the small learned-words file; nothing else.
final class TypingEngine {
  let language: TypingLanguage
  let lexicon: TypingLexicon
  let corrector: Autocorrector
  let session: TypingSession
  let learnedWords: LearnedWordStore
  private var systemWords = SupplementaryWords()

  /// `resources` holds lexicon-<language>.bin. `storage` is the App Group container, where
  /// learned words stay; nil keeps them in memory (no Full Access, tests).
  init?(language: TypingLanguage, layout: KeyLayoutKind, resources: URL, storage: URL?) {
    let file = resources.appendingPathComponent("lexicon-\(language.rawValue).bin")
    guard let lexicon = TypingLexicon(url: file) else { return nil }
    self.language = language
    self.lexicon = lexicon
    corrector = Autocorrector(
      lexicon: lexicon, language: language, geometry: .nominal(language: language, layout: layout)
    )
    learnedWords = LearnedWordStore(url: storage.map { TypingEngine.learnedWordsURL(in: $0, language: language) })
    session = TypingSession(corrector: corrector)
    session.learnedWords = learnedWords
    applyLearnedWords()
  }

  static func learnedWordsURL(in storage: URL, language: TypingLanguage) -> URL {
    storage.appendingPathComponent("keyboard-learned-words-\(language.rawValue).json")
  }

  /// Forgets every learned word, in this keyboard and on disk, for every language.
  @discardableResult
  func clearLearnedWords(storage: URL?) -> Bool {
    var cleared = learnedWords.removeAll()
    applyLearnedWords()
    guard let storage else { return cleared }
    for language in TypingLanguage.allCases where language != self.language {
      if !LearnedWordStore(url: Self.learnedWordsURL(in: storage, language: language)).removeAll() { cleared = false }
    }
    return cleared
  }

  func reloadLearnedWords() {
    learnedWords.reload()
    applyLearnedWords()
  }

  private func applyLearnedWords() {
    corrector.learned = systemWords
    corrector.keptAsTyped.removeAll()
    for word in learnedWords.words { corrector.learned.insert(word) }
    for word in learnedWords.keptAsTyped { corrector.keepAsTyped(word) }
    session.reset()
  }

  /// iOS text replacements ("omw" → "On my way!") and names from Contacts, from UILexicon:
  /// (what the user types, what it stands for). An entry that stands for itself is a name
  /// the keyboard should know; any other is a replacement.
  func setSystemEntries(_ entries: [(input: String, replacement: String)]) {
    var replacements: [String: String] = [:]
    for entry in entries {
      if entry.input.lowercased() == entry.replacement.lowercased() {
        // Single words only: the corrector looks words up one at a time.
        if !entry.replacement.contains(" ") {
          systemWords.insert(entry.replacement)
          corrector.learned.insert(entry.replacement)
        }
      } else {
        replacements[entry.input.lowercased()] = entry.replacement
      }
    }
    session.replacements = replacements
  }
}
