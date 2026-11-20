import Foundation

/// A change to the text before the cursor: delete `deleteCount` characters backwards, then
/// insert.
struct TextEdit: Equatable {
  var deleteCount = 0
  var insert = ""
}

/// What the field behind the keyboard says about itself, as far as typing help goes.
struct FieldTraits: Equatable {
  enum Keyboard { case standard, url, email, number, other }
  var autocorrectionOff = false
  var spellCheckingOff = false
  var keyboard = Keyboard.standard
  /// UITextContentType's raw value.
  var contentType: String?
  var hidesText = false
}

/// What typing help a field gets.
struct TypingFieldPolicy: Equatable {
  var autocorrects = true
  var suggests = true
  var learns = true

  static let none = TypingFieldPolicy(autocorrects: false, suggests: false, learns: false)

  private static let plainContentTypes: Set<String> = ["username", "password", "new-password", "one-time-code", "email"]

  /// No correcting or learning where the field asks for none (autocorrection or spell
  /// checking off), in URL and email keyboards, and for user names, passwords, one-time codes
  /// and email addresses. A field that hides its text is never learned from.
  init(traits: FieldTraits) {
    let plain =
      traits.autocorrectionOff || traits.spellCheckingOff || traits.hidesText
      || traits.keyboard == .url || traits.keyboard == .email || traits.keyboard == .number
      || traits.contentType.map { TypingFieldPolicy.plainContentTypes.contains($0) } == true
    autocorrects = !plain
    suggests = !plain
    learns = !plain
  }

  init(autocorrects: Bool = true, suggests: Bool = true, learns: Bool = true) {
    self.autocorrects = autocorrects
    self.suggests = suggests
    self.learns = learns
  }
}

struct Suggestion: Equatable {
  enum Kind { case typed, correction, word, emoji, replacement }
  var text: String
  var kind: Kind
  /// The one a space will apply.
  var isPending = false
}

/// Follows what is typed and decides corrections, suggestions and what to learn. It never
/// touches the document: it answers each key with the edit to make, so it runs the same in
/// the keyboard and in the benchmarks. Nothing here logs or leaves the process.
final class TypingSession {
  let corrector: Autocorrector
  var policy = TypingFieldPolicy()
  /// iOS text replacements: shortcut in lower case → what it stands for.
  var replacements: [String: String] = [:]
  var learnedWords: LearnedWordStore?
  /// An emoji for a word ("pizza" → 🍕), when there is one.
  var emojiForWord: ((String) -> String?)?

  /// The text before the cursor, as far as the keyboard knows it.
  private(set) var tail = ""
  private var lastCorrection: (original: String, replacement: String, delimiter: String)?
  private var lastSwipe: (inserted: String, alternatives: [String])?
  /// The space before the cursor was added with a suggestion or a swipe: punctuation takes
  /// its place.
  private var endsWithAutoSpace = false
  private var cachedBar: (tail: String, suggestions: [Suggestion])?
  private var cachedCorrection: (tail: String, result: CorrectionResult)?
  private static let tailLimit = 240

  init(corrector: Autocorrector) {
    self.corrector = corrector
  }

  // MARK: Where the cursor is

  static func isWordCharacter(_ character: Character) -> Bool {
    character.isLetter || character == "'" || character == "\u{2019}"
  }

  /// The word being typed: the run of letters and apostrophes before the cursor.
  var composing: Substring {
    var start = tail.endIndex
    while start > tail.startIndex {
      let previous = tail.index(before: start)
      guard TypingSession.isWordCharacter(tail[previous]) else { break }
      start = previous
    }
    return tail[start...]
  }

  private struct Context {
    var previous: String?
    var sentenceStart: Bool
    /// The word touches a symbol that makes it part of an address or identifier.
    var glued: Bool
  }

  private func context(before wordStart: String.Index) -> Context {
    let head = tail[..<wordStart]
    guard let last = head.last else { return Context(previous: nil, sentenceStart: true, glued: false) }
    if !last.isWhitespace {
      let opening: Set<Character> = ["(", "[", "{", "\"", "\u{201C}", "\u{201E}", "\u{2018}", "\u{00AB}"]
      if opening.contains(last) {
        return Context(previous: nil, sentenceStart: head.dropLast().allSatisfy(\.isWhitespace), glued: false)
      }
      return Context(previous: nil, sentenceStart: false, glued: true)
    }
    let trimmed = head.reversed().drop(while: { $0 == " " })
    guard let before = trimmed.first else { return Context(previous: nil, sentenceStart: true, glued: false) }
    if before.isNewline { return Context(previous: nil, sentenceStart: true, glued: false) }
    let closers: Set<Character> = ["\"", "\u{201D}", "\u{2019}", ")", "]"]
    let significant = trimmed.drop(while: { closers.contains($0) }).first ?? before
    if significant == "." || significant == "!" || significant == "?" {
      return Context(previous: nil, sentenceStart: true, glued: false)
    }
    // The word before, across a comma or the like.
    let word = trimmed.drop(while: { !TypingSession.isWordCharacter($0) && !$0.isNumber })
      .prefix(while: TypingSession.isWordCharacter)
    let skipped = trimmed.prefix(while: { !TypingSession.isWordCharacter($0) })
    if word.isEmpty || skipped.contains(where: \.isNumber) {
      return Context(previous: nil, sentenceStart: false, glued: false)
    }
    return Context(previous: String(word.reversed()), sentenceStart: false, glued: false)
  }

  // MARK: Keys

  /// Characters after a word that leave it alone: they make it part of an address, a
  /// number or an identifier.
  private static let gluing: Set<Character> = ["@", "/", "_", "-", "+", "=", "#", "&", "*", "\\", "<", ">", "|", "~", "^", "%", "$"]
  private static let spaceEating: Set<Character> = [".", ",", "!", "?", ";", ":"]

  /// The edit for a key that types `text`, the text itself included.
  func insert(_ text: String) -> TextEdit {
    guard let first = text.first else { return TextEdit() }
    var edit = TextEdit(deleteCount: 0, insert: text)
    let wasAutoSpace = endsWithAutoSpace
    endsWithAutoSpace = false
    lastSwipe = nil

    if TypingSession.isWordCharacter(first) {
      lastCorrection = nil
      append(edit)
      return edit
    }

    if wasAutoSpace, TypingSession.spaceEating.contains(first), tail.last == " " {
      lastCorrection = nil
      edit.deleteCount = 1
      apply(edit)
      return edit
    }

    lastCorrection = nil
    let word = composing
    if !word.isEmpty, !first.isNumber, !TypingSession.gluing.contains(first) {
      let typed = String(word)
      if let replacement = boundaryReplacement(for: typed, wordStart: word.startIndex) {
        edit = TextEdit(deleteCount: typed.count, insert: replacement + text)
        lastCorrection = (typed, replacement, text)
      } else {
        noteKept(typed, wordStart: word.startIndex)
      }
    }
    apply(edit)
    return edit
  }

  private func boundaryReplacement(for typed: String, wordStart: String.Index) -> String? {
    guard policy.autocorrects else { return nil }
    if let expansion = replacements[typed.lowercased()], expansion != typed { return expansion }
    guard typed.first != "'", typed.last != "'", typed.first != "\u{2019}", typed.last != "\u{2019}" else { return nil }
    let context = context(before: wordStart)
    guard !context.glued else { return nil }
    return correction(for: typed, context: context).replacement
  }

  private func correction(for typed: String, context: Context) -> CorrectionResult {
    if let cached = cachedCorrection, cached.tail == tail { return cached.result }
    let result = corrector.correct(typed, previous: context.previous, sentenceStart: context.sentenceStart)
    cachedCorrection = (tail, result)
    return result
  }

  /// A word left as typed: after enough times it is one of the user's own.
  private func noteKept(_ typed: String, wordStart: String.Index) {
    guard policy.learns, let learnedWords, typed.count >= 2, typed.count <= 24 else { return }
    guard typed.allSatisfy(\.isLetter) else { return }
    let context = context(before: wordStart)
    guard !context.glued else { return }
    let result = correction(for: typed, context: context)
    guard !result.typedIsKnown else { return }
    // A capital at the start of a sentence is the keyboard's, not the word's.
    let word = context.sentenceStart ? typed.lowercased() : typed
    if learnedWords.noteUse(of: word) { corrector.learned.insert(word) }
  }

  /// Backspace. An edit when it undoes a correction or removes a swiped word; nil for a
  /// plain delete of one character, which the caller makes.
  func backspace() -> TextEdit? {
    endsWithAutoSpace = false
    if let correction = lastCorrection {
      lastCorrection = nil
      let current = correction.replacement + correction.delimiter
      if tail.hasSuffix(current) {
        let edit = TextEdit(deleteCount: current.count, insert: correction.original + correction.delimiter)
        corrector.keptAsTyped.insert(correction.original)
        if policy.learns, let learnedWords, correction.original.allSatisfy(\.isLetter) {
          learnedWords.learn(correction.original)
          corrector.learned.insert(correction.original)
        }
        apply(edit)
        return edit
      }
    }
    if let swipe = lastSwipe {
      lastSwipe = nil
      if tail.hasSuffix(swipe.inserted) {
        let edit = TextEdit(deleteCount: swipe.inserted.count, insert: "")
        apply(edit)
        return edit
      }
    }
    if !tail.isEmpty { tail.removeLast() }
    return nil
  }

  /// Text put in by something other than a key (a transcript, a paste).
  func noteInserted(_ text: String) {
    lastCorrection = nil
    lastSwipe = nil
    endsWithAutoSpace = false
    append(TextEdit(deleteCount: 0, insert: text))
  }

  func noteDeletedBackward(_ count: Int = 1) {
    lastCorrection = nil
    lastSwipe = nil
    endsWithAutoSpace = false
    tail.removeLast(min(count, tail.count))
  }

  /// A swiped word: a space goes before it when the text needs one and after it, so the
  /// next word can follow at once.
  func insertSwiped(_ word: String, alternatives: [String]) -> TextEdit {
    lastCorrection = nil
    var text = word + " "
    if let last = tail.last, !last.isWhitespace, !["(", "[", "{", "\"", "\u{201C}", "\u{201E}", "/", "-"].contains(last) {
      text = " " + text
    }
    let edit = TextEdit(deleteCount: 0, insert: text)
    apply(edit)
    lastSwipe = (text, alternatives)
    endsWithAutoSpace = true
    return edit
  }

  /// Whether a swiped word would start a sentence, for its capital.
  var isAtSentenceStart: Bool { context(before: composing.startIndex).sentenceStart }

  /// The host moved the cursor or changed the text. `before` is the text it reports before
  /// the cursor; nil when it reports none.
  func resync(before: String?) {
    guard let before else { return }
    if tail.hasSuffix(before) || before.hasSuffix(tail) && before.count == tail.count { return }
    // Hosts report the keyboard's own inserts late: a report that is the known text less
    // its last characters is that, not a change.
    if before.count >= 2 || tail.count <= 2 {
      for dropped in 1...2 where tail.count >= dropped {
        if String(tail.dropLast(dropped)).hasSuffix(before), !before.isEmpty || tail.count == dropped { return }
      }
    }
    tail = String(before.suffix(TypingSession.tailLimit))
    lastCorrection = nil
    lastSwipe = nil
    endsWithAutoSpace = false
  }

  func reset() {
    tail = ""
    lastCorrection = nil
    lastSwipe = nil
    endsWithAutoSpace = false
    cachedBar = nil
    cachedCorrection = nil
  }

  private func append(_ edit: TextEdit) { apply(edit) }

  private func apply(_ edit: TextEdit) {
    tail.removeLast(min(edit.deleteCount, tail.count))
    tail += edit.insert
    if tail.count > TypingSession.tailLimit * 2 { tail = String(tail.suffix(TypingSession.tailLimit)) }
  }

  // MARK: Suggestion bar

  /// Up to three suggestions for the bar. Empty where the field gets none.
  func suggestions() -> [Suggestion] {
    guard policy.suggests else { return [] }
    if let cachedBar, cachedBar.tail == tail { return cachedBar.suggestions }
    let suggestions = makeSuggestions()
    cachedBar = (tail, suggestions)
    return suggestions
  }

  private func makeSuggestions() -> [Suggestion] {
    if let swipe = lastSwipe {
      return swipe.alternatives.prefix(3).map { Suggestion(text: $0, kind: .word) }
    }
    let word = composing
    let context = context(before: word.startIndex)
    guard !word.isEmpty else {
      guard !context.glued else { return [] }
      var slots = corrector.predictions(after: context.previous, sentenceStart: context.sentenceStart)
        .map { Suggestion(text: $0, kind: .word) }
      if let previous = context.previous, let emoji = emojiForWord?(previous.lowercased()) {
        slots = Array(slots.prefix(2)) + [Suggestion(text: emoji, kind: .emoji)]
      }
      return slots
    }
    let typed = String(word)
    if policy.autocorrects, let expansion = replacements[typed.lowercased()], expansion != typed {
      return [
        Suggestion(text: typed, kind: .typed),
        Suggestion(text: expansion, kind: .replacement, isPending: true),
      ]
    }
    guard !context.glued else { return [] }
    let result = correction(for: typed, context: context)
    var slots: [Suggestion] = []
    let pending = policy.autocorrects ? result.replacement : nil
    if pending != nil || !result.typedIsKnown {
      slots.append(Suggestion(text: typed, kind: .typed))
    }
    if let pending {
      slots.append(Suggestion(text: pending, kind: .correction, isPending: true))
    } else if let replacement = result.replacement {
      slots.append(Suggestion(text: replacement, kind: .word))
    }
    for alternative in result.alternatives where slots.count < 3 {
      slots.append(Suggestion(text: alternative, kind: .word))
    }
    if let emoji = emojiForWord?(typed.lowercased()) {
      slots = Array(slots.prefix(2)) + [Suggestion(text: emoji, kind: .emoji)]
    }
    return slots
  }

  /// The edit for a tap on a suggestion.
  func accept(_ suggestion: Suggestion) -> TextEdit {
    lastCorrection = nil
    var edit: TextEdit
    if let swipe = lastSwipe {
      // Another reading of the swipe replaces the word it put in.
      let leadingSpace = swipe.inserted.hasPrefix(" ") ? " " : ""
      edit = TextEdit(deleteCount: tail.hasSuffix(swipe.inserted) ? swipe.inserted.count : 0, insert: leadingSpace + suggestion.text + " ")
      lastSwipe = nil
      apply(edit)
      endsWithAutoSpace = true
      return edit
    }
    let typed = String(composing)
    switch suggestion.kind {
    case .typed:
      corrector.keptAsTyped.insert(typed)
      if policy.learns, let learnedWords, typed.allSatisfy(\.isLetter), typed.count >= 2 {
        learnedWords.learn(typed)
        corrector.learned.insert(typed)
      }
      edit = TextEdit(deleteCount: 0, insert: " ")
    case .emoji:
      edit = TextEdit(deleteCount: typed.count, insert: suggestion.text)
    case .correction, .word, .replacement:
      edit = TextEdit(deleteCount: typed.count, insert: suggestion.text + " ")
    }
    apply(edit)
    endsWithAutoSpace = edit.insert.hasSuffix(" ")
    return edit
  }

  // MARK: For the hit-target model

  /// The word before the one being typed and the letters of it typed so far.
  func nextLetterContext() -> (previous: String?, sentenceStart: Bool, prefix: String) {
    let word = composing
    let context = context(before: word.startIndex)
    return (context.previous, context.sentenceStart, String(word))
  }
}

/// The user's own words, kept in the App Group container and nowhere else. A word is learned
/// the second time it is typed and left alone, or at once when the user undoes its correction
/// or picks it in the suggestion bar.
final class LearnedWordStore {
  private let url: URL?
  private var counts: [String: Int]
  static let usesToLearn = 2
  static let limit = 2000

  /// `url` nil keeps the words in memory only.
  init(url: URL?) {
    self.url = url
    if let url, let data = try? Data(contentsOf: url),
      let stored = try? JSONDecoder().decode([String: Int].self, from: data)
    {
      counts = stored
    } else {
      counts = [:]
    }
  }

  var words: [String] { counts.filter { $0.value >= LearnedWordStore.usesToLearn }.map(\.key).sorted() }

  /// True when this use made it a learned word.
  func noteUse(of word: String) -> Bool {
    let count = (counts[word] ?? 0) + 1
    guard count <= LearnedWordStore.usesToLearn else { return false }
    counts[word] = count
    save()
    return count == LearnedWordStore.usesToLearn
  }

  func learn(_ word: String) {
    guard (counts[word] ?? 0) < LearnedWordStore.usesToLearn else { return }
    counts[word] = LearnedWordStore.usesToLearn
    save()
  }

  func removeAll() {
    counts.removeAll()
    save()
  }

  /// Picks up a clear made by the app while the keyboard was open.
  func reload() {
    guard let url else { return }
    if let data = try? Data(contentsOf: url), let stored = try? JSONDecoder().decode([String: Int].self, from: data) {
      counts = stored
    } else {
      counts = [:]
    }
  }

  private func save() {
    guard let url else { return }
    if counts.count > LearnedWordStore.limit {
      // Words seen once go first.
      let singles = counts.filter { $0.value < LearnedWordStore.usesToLearn }.keys.sorted()
      for word in singles.prefix(counts.count - LearnedWordStore.limit) { counts[word] = nil }
    }
    if let data = try? JSONEncoder().encode(counts) {
      try? data.write(to: url, options: .atomic)
    }
  }
}
