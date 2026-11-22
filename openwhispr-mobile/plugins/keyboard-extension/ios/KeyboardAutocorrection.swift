import Foundation

/// No UIKit here: the host's freshly read context, never the word buffer, authorizes edits.
struct KeyboardCorrectionContext: Equatable {
  let document: UUID
  let before: String?
  let after: String?
  let selection: String?
  let allowed: Bool

  // UIKit may report nil after the cursor at end-of-document. Missing LEFT context
  // still prevents replacement; nil and empty right/selection reports are equivalent.
  var isSafe: Bool { allowed && before != nil && (selection ?? "").isEmpty }

  static func == (lhs: Self, rhs: Self) -> Bool {
    lhs.document == rhs.document && lhs.before == rhs.before
      && (lhs.after ?? "") == (rhs.after ?? "")
      && (lhs.selection ?? "") == (rhs.selection ?? "") && lhs.allowed == rhs.allowed
  }

  static func reported(document: UUID, before: String?, after: String?, selection: String?,
                       allowed: Bool, hasText: Bool) -> Self {
    // Only a genuinely empty field can seed tracking without left context. Never infer
    // that our previous insert landed from a buffer, or normalize an opaque nonempty field.
    let readableBefore = before ?? (!hasText && (after ?? "").isEmpty ? "" : nil)
    return Self(document: document, before: readableBefore, after: after,
                selection: selection, allowed: allowed)
  }

  func inserting(_ text: String) -> Self {
    Self(document: document, before: before.map { $0 + text }, after: after,
         selection: selection, allowed: allowed)
  }
}

/// A language the keyboard can correct. `code` is what the app's Settings write to the App
/// Group (`src/lib/keyboardAutocorrection.ts` lists the same codes); `dictionaries` are
/// UITextChecker identifiers in order of preference, then any `<code>_`/`<code>-` variant;
/// `letters` are the lowercase letters a correctable word of this language may use.
struct KeyboardCorrectionLanguage: Equatable {
  let code: String
  let dictionaries: [String]
  let letters: Set<Character>

  private static let latin = Set("abcdefghijklmnopqrstuvwxyz")
  static let german = Self(code: "de", dictionaries: ["de_DE", "de-DE", "de"],
                           letters: latin.union("äöüß"))
  static let english = Self(code: "en", dictionaries: ["en_US", "en-US", "en_GB", "en-GB", "en"],
                            letters: latin)
  /// Adding a language: an entry here, its code in the app's list, and tests.
  static let all = [german, english]
  static let defaultSelection = [german, english]
  /// Each language is another lookup at every space; matches the app's cap.
  static let maxSelected = 3

  /// Parses the App Group value ("de,en"). Unknown codes are ignored, duplicates dropped and
  /// the list capped; nothing usable (missing key, no Full Access) means the default.
  static func selection(from raw: String?) -> [KeyboardCorrectionLanguage] {
    var picked: [KeyboardCorrectionLanguage] = []
    for part in (raw ?? "").split(separator: ",") {
      let code = part.trimmingCharacters(in: .whitespaces).lowercased()
      if let language = all.first(where: { $0.code == code }), !picked.contains(language),
         picked.count < maxSelected {
        picked.append(language)
      }
    }
    return picked.isEmpty ? defaultSelection : picked
  }

  static func letters(of languages: [KeyboardCorrectionLanguage]) -> Set<Character> {
    languages.reduce(into: Set<Character>()) { $0.formUnion($1.letters) }
  }
}

protocol KeyboardCorrectionProvider {
  func suggestions(for word: String) -> [String]
  /// `before` is the field's text before the word (for the sentence's language); never logged.
  func suggestions(for word: String, before: String) -> [String]
  /// The letters of the languages it corrects; words with any other letter are left alone.
  var letters: Set<Character> { get }
  /// How common a proposal is (0 = most common), or nil when unknown.
  func frequencyRank(of candidate: String) -> Int?
}

extension KeyboardCorrectionProvider {
  func suggestions(for word: String, before: String) -> [String] { suggestions(for: word) }
  var letters: Set<Character> { KeyboardCorrectionRules.defaultLetters }
  func frequencyRank(of candidate: String) -> Int? { nil }
}

enum KeyboardCorrectionRules {
  static let defaultLetters = KeyboardCorrectionLanguage.letters(
    of: KeyboardCorrectionLanguage.defaultSelection)

  // Deliberately narrow: the selected languages' letters, no identifiers, mixed case, combining
  // marks, punctuation, emoji, digits, or capitalization changes. Character indexing, not UTF-16.
  static func isWord(_ word: String,
                     letters: Set<Character> = KeyboardCorrectionRules.defaultLetters) -> Bool {
    let lower = word.lowercased()
    return (3...20).contains(word.count)
      && lower.allSatisfy { letters.contains($0) }
      && word.unicodeScalars.count == word.count
      && (word == lower || word == String(lower.prefix(1)).uppercased() + lower.dropFirst())
  }

  // The keyboard's own letter rows (KeyboardViewController.letterRows), centred as drawn:
  // the middle row half a key in, the bottom row a whole key in (shift sits beside it).
  private static let keyRows: [(keys: String, offset: Double)] = [
    ("qwertyuiop", 0), ("asdfghjkl", 0.5), ("zxcvbnm", 1.5),
  ]

  private static let keyCentres: [Character: (row: Int, x: Double)] = {
    var centres: [Character: (row: Int, x: Double)] = [:]
    for (row, line) in keyRows.enumerated() {
      for (index, key) in line.keys.enumerated() { centres[key] = (row, Double(index) + line.offset) }
    }
    return centres
  }()

  /// Keys that touch on the drawn layout: either side in a row, and the keys of the next row
  /// that overlap it (two from the top rows, the one straight below/above for the bottom row).
  static let keyNeighbors: [Character: Set<Character>] = {
    var neighbors: [Character: Set<Character>] = [:]
    for (key, a) in keyCentres {
      neighbors[key] = Set(keyCentres.compactMap { other, b in
        guard other != key else { return nil }
        let dx = abs(a.x - b.x)
        if a.row == b.row { return dx == 1 ? other : nil }
        return abs(a.row - b.row) == 1 && dx < 1 ? other : nil
      })
    }
    return neighbors
  }()

  static func areNeighborKeys(_ a: Character, _ b: Character) -> Bool {
    let lowerA = Character(a.lowercased()), lowerB = Character(b.lowercased())
    return keyNeighbors[lowerA]?.contains(lowerB) == true
  }

  /// How many letters the neighbouring-key search replaces: one in three-letter words, two in
  /// four-letter words, three from five letters on.
  static func maxNeighborSlips(forLength length: Int) -> Int {
    length >= 5 ? 3 : length == 4 ? 2 : length == 3 ? 1 : 0
  }

  // Edit weights, tuned with the frequency weight below on the 50,000 most common German and
  // English words and random typos (70% sideways). A slip sideways in a row is the commonest
  // typo; a slip to the row above or below less likely; a letter for its umlaut (a↔ä, o↔ö, u↔ü, s↔ß) counts like a
  // slip; any other wrong key costs two edits. A swap of adjacent letters costs one, a missing
  // or extra letter one and a half (otherwise dropping a letter of a common short word wins
  // too often).
  static let rowSlipCost = 1.0
  static let insertDeleteCost = 1.5
  static let diagonalSlipCost = 1.5
  static let otherLetterCost = 2.0
  private static let umlauts: Set<String> = ["aä", "äa", "oö", "öo", "uü", "üu", "sß", "ßs"]

  static func substitutionCost(_ a: Character, _ b: Character) -> Double {
    let lowerA = Character(a.lowercased()), lowerB = Character(b.lowercased())
    if lowerA == lowerB { return 0 }
    if umlauts.contains(String([lowerA, lowerB])) { return rowSlipCost }
    guard keyNeighbors[lowerA]?.contains(lowerB) == true,
          let centreA = keyCentres[lowerA], let centreB = keyCentres[lowerB] else { return otherLetterCost }
    return centreA.row == centreB.row ? rowSlipCost : diagonalSlipCost
  }

  /// The most edit weight a word may need: one slip (diagonal included) in three letters; two
  /// slips in four letters (not two diagonal ones); three in five or six letters (at most two
  /// diagonal); four from seven letters on. A wrong far-away letter counts as two slips.
  static func maxEditCost(forLength length: Int) -> Double {
    switch length {
    case ..<3: return 0
    case 3: return 1.5
    case 4: return 2.5
    case 5, 6: return 4.0
    default: return 5.0
    }
  }

  /// Weighted edit distance (optimal string alignment: substitutions by key distance,
  /// insertions, deletions and swaps of adjacent letters), or nil when the words are equal or
  /// further apart than `maxEditCost` allows for the typed word.
  static func editCost(from word: String, to candidate: String) -> Double? {
    let source = Array(word), target = Array(candidate)
    let limit = maxEditCost(forLength: source.count)
    guard source != target,
          Double(abs(source.count - target.count)) * insertDeleteCost <= limit + 1e-9 else { return nil }
    var table = Array(repeating: Array(repeating: 0.0, count: target.count + 1), count: source.count + 1)
    for i in 0...source.count { table[i][0] = Double(i) * insertDeleteCost }
    for j in 0...target.count { table[0][j] = Double(j) * insertDeleteCost }
    for i in stride(from: 1, through: source.count, by: 1) {
      for j in stride(from: 1, through: target.count, by: 1) {
        var best = min(table[i - 1][j] + insertDeleteCost, table[i][j - 1] + insertDeleteCost,
                       table[i - 1][j - 1] + substitutionCost(source[i - 1], target[j - 1]))
        if i > 1, j > 1, source[i - 1] == target[j - 2], source[i - 2] == target[j - 1] {
          best = min(best, table[i - 2][j - 2] + 1)
        }
        table[i][j] = best
      }
    }
    let cost = table[source.count][target.count]
    return cost <= limit + 1e-9 ? cost : nil
  }

  /// 0.3 edits per doubling of a word's frequency rank: a common word wins over a rarer one
  /// that is slightly closer (`hsbd` → `habe` rather than `hand` or `habs`). Tuned with the
  /// edit weights above on mixed typos (slips, swaps, missing and extra letters). An unknown rank
  /// counts as fairly rare, so between unranked words the edit cost decides.
  static let frequencyWeight = 0.3
  static let unrankedFrequencyRank = 20_000

  static func score(cost: Double, rank: Int?) -> Double {
    cost + frequencyWeight * log2(Double(min(rank ?? unrankedFrequencyRank, unrankedFrequencyRank)) + 1)
  }

  // German spelled without its special letters: ae/oe/ue for ä/ö/ü (Ae/Oe/Ue at the start of
  // a capitalised word) and ss for ß. Each pair is a choice, so `Gruesse` yields `Grüsse`,
  // `Grueße` and `Grüße`. ß costs a little more than an umlaut, since ss is often right.
  static let umlautTranscriptionCost = 0.3
  static let eszettTranscriptionCost = 0.5
  private static let transcriptionPairs: [(pair: String, letter: Character, cost: Double)] = [
    ("ae", "ä", umlautTranscriptionCost), ("oe", "ö", umlautTranscriptionCost),
    ("ue", "ü", umlautTranscriptionCost), ("ss", "ß", eszettTranscriptionCost),
  ]
  /// More pairs than this in one word are left alone (2^6 spellings at most).
  static let maxTranscriptionPairs = 6

  /// The language of the words before the cursor: the code of the only language that knows
  /// some of the last eight words (two letters or more) that the others don't, or nil when
  /// none or several do (`ich habe` → de, `I have` → en, `so` → nil, `ich have` → nil).
  static func sentenceLanguage(before: String, codes: [String],
                               knows: (_ word: String, _ code: String) -> Bool) -> String? {
    let words = before.split { !$0.isLetter }.suffix(8).map(String.init).filter { $0.count >= 2 }
    var only = Set<String>()
    for word in words {
      let knownBy = codes.filter { knows(word, $0) || knows(word.lowercased(), $0) }
      if knownBy.count == 1 { only.insert(knownBy[0]) }
    }
    return only.count == 1 ? only.first : nil
  }

  static func capitalized(_ word: String) -> String {
    word.prefix(1).uppercased() + word.dropFirst()
  }

  /// Every respelling of `word` with at least one pair replaced, its cost and how many pairs
  /// it replaced.
  static func transcriptions(of word: String) -> [(word: String, cost: Double, pairs: Int)] {
    let characters = Array(word)
    var sites: [(index: Int, letter: Character, cost: Double)] = []
    var index = 0
    while index < characters.count - 1 {
      let pair = String(characters[index...index + 1])
      let lower = pair.lowercased()
      // Only a lowercase pair, or Ae/Oe/Ue opening a capitalised word (never ss there).
      if let match = transcriptionPairs.first(where: { $0.pair == lower }),
         pair == lower || (index == 0 && pair == lower.prefix(1).uppercased() + lower.dropFirst()
                           && match.letter != "ß") {
        let letter = pair == lower ? match.letter : Character(match.letter.uppercased())
        sites.append((index, letter, match.cost))
        index += 2
      } else {
        index += 1
      }
    }
    guard !sites.isEmpty, sites.count <= maxTranscriptionPairs else { return [] }
    var result: [(word: String, cost: Double, pairs: Int)] = []
    for mask in 1..<(1 << sites.count) {
      var output: [Character] = []
      var cost = 0.0
      var pairs = 0
      var position = 0
      for (bit, site) in sites.enumerated() where mask & (1 << bit) != 0 {
        output += characters[position..<site.index]
        output.append(site.letter)
        cost += site.cost
        pairs += 1
        position = site.index + 2
      }
      output += characters[position...]
      result.append((String(output), cost, pairs))
    }
    return result
  }

  /// The eligible candidate with the lowest score (edit cost plus frequency); a tie goes to the
  /// earliest in `suggestions`. A candidate that is the word's own spelling with ä/ö/ü/ß
  /// (`schoen` → `schön`, `Strasse` → `Straße`) wins over every other: typing an unknown word
  /// whose umlaut spelling is a word almost always means that word. Among those, the one
  /// replacing the most pairs wins (`gruesse` → `grüße`, not the Swiss `grüsse`). More corrections, at the
  /// risk of picking the wrong word of two; backspace right after undoes it.
  static func replacement(for word: String, suggestions: [String],
                          letters: Set<Character> = KeyboardCorrectionRules.defaultLetters,
                          rank: (String) -> Int? = { _ in nil }) -> String? {
    guard isWord(word, letters: letters) else { return nil }
    // A lowercase respelling may also come capitalised: German nouns (`strasse` → `Straße`).
    let respellings = Dictionary(transcriptions(of: word).flatMap { respelling in
      [(respelling.word, (respelling.cost, respelling.pairs)),
       (capitalized(respelling.word), (respelling.cost, respelling.pairs))]
    }, uniquingKeysWith: { $0.0 <= $1.0 ? $0 : $1 })
    var best: (word: String, score: Double, pairs: Int)?
    var seen = Set<String>()
    for candidate in suggestions where seen.insert(candidate).inserted {
      let respelled = respellings[candidate]
      // A capitalised word keeps its capital; a lowercase one may gain one (a German noun:
      // the provider only offers capitalised proposals for lowercase words that are nouns).
      guard isWord(candidate, letters: letters),
            word == word.lowercased() || candidate != candidate.lowercased() else { continue }
      guard let cost = respelled?.0 ?? editCost(from: word, to: candidate) else { continue }
      let candidateScore = score(cost: cost, rank: rank(candidate))
      let pairs = respelled?.1 ?? 0
      if best == nil || pairs > best!.pairs
          || (pairs == best!.pairs && candidateScore < best!.score - 1e-9) {
        best = (candidate, candidateScore, pairs)
      }
    }
    return best?.word
  }

  /// Known words made by replacing up to `maxSlips` letters of `word` with neighbouring keys,
  /// one level of slips after the other, since a common word with more slips can still win
  /// (`fubktiojiert` → `funktioniert` without UITextChecker proposing it). A level whose
  /// variants would push the total past `budget` lookups is skipped with all after it, and a
  /// level cut short by `shouldStop` is dropped whole: an unfinished level could miss a closer
  /// word than the one it found.
  /// Known words one swap of adjacent letters, one missing letter (from `letters`) or one
  /// extra letter away. UITextChecker usually proposes these but not always (`kalppt` →
  /// `klappt`). The first letter keeps its case, so a title-case word is never edited there.
  static func singleEditCandidates(for word: String, letters: Set<Character>,
                                   shouldStop: () -> Bool = { false },
                                   isKnown: (String) -> Bool) -> [String] {
    let characters = Array(word)
    guard characters.count >= 3 else { return [] }
    let titleCase = word != word.lowercased()
    let start = titleCase ? 1 : 0
    var variants: [[Character]] = []
    for index in start..<(characters.count - 1) where characters[index] != characters[index + 1] {
      var swapped = characters
      swapped.swapAt(index, index + 1)
      variants.append(swapped)
    }
    if characters.count >= 4 {
      for index in start..<characters.count {
        var shorter = characters
        shorter.remove(at: index)
        variants.append(shorter)
      }
    }
    let alphabet = letters.sorted()
    for index in max(start, 1)...characters.count {
      for letter in alphabet {
        var longer = characters
        longer.insert(letter, at: index)
        variants.append(longer)
      }
    }
    var found: [String] = []
    var seen = Set<String>()
    for variant in variants {
      if shouldStop() { return [] }
      let text = String(variant)
      if seen.insert(text).inserted, text != word, isKnown(text) { found.append(text) }
    }
    return found
  }

  static func neighborSlipCandidates(for word: String, maxSlips: Int, budget: Int = 1_500,
                                     shouldStop: () -> Bool = { false },
                                     isKnown: (String) -> Bool) -> [String] {
    let characters = Array(word)
    let limit = min(maxSlips, maxNeighborSlips(forLength: characters.count))
    guard limit > 0 else { return [] }
    let titleCase = word != word.lowercased()
    // Lowercase neighbours per position; the first one is capitalised again for title case.
    let options: [[Character]] = characters.enumerated().map { index, character in
      let lower = Character(character.lowercased())
      return (keyNeighbors[lower] ?? []).sorted().map { neighbor in
        index == 0 && titleCase ? Character(neighbor.uppercased()) : neighbor
      }
    }
    var used = 0
    var result: [String] = []
    for slips in 1...limit {
      var positions = Array(0..<slips)
      var variants = 0
      var combinationsPossible = true
      // Count first, so an oversized level is skipped before any lookup.
      while combinationsPossible {
        variants += positions.reduce(1) { $0 * options[$1].count }
        combinationsPossible = nextCombination(&positions, upTo: characters.count)
      }
      guard used + variants <= budget else { break }
      used += variants
      var found: [String] = []
      positions = Array(0..<slips)
      combinationsPossible = true
      while combinationsPossible {
        var picks = Array(repeating: 0, count: slips)
        var morePicks = positions.allSatisfy { !options[$0].isEmpty }
        while morePicks {
          if shouldStop() { return result }
          var variant = characters
          for (slot, position) in positions.enumerated() { variant[position] = options[position][picks[slot]] }
          let text = String(variant)
          if isKnown(text) { found.append(text) }
          // Next neighbour choice, like an odometer.
          morePicks = false
          for slot in picks.indices.reversed() {
            picks[slot] += 1
            if picks[slot] < options[positions[slot]].count { morePicks = true; break }
            picks[slot] = 0
          }
        }
        combinationsPossible = nextCombination(&positions, upTo: characters.count)
      }
      result += found
    }
    return result
  }

  /// Advances `positions` to the next ascending combination below `count`; false at the end.
  private static func nextCombination(_ positions: inout [Int], upTo count: Int) -> Bool {
    var slot = positions.count - 1
    while slot >= 0 && positions[slot] == count - positions.count + slot { slot -= 1 }
    guard slot >= 0 else { return false }
    positions[slot] += 1
    for next in (slot + 1)..<positions.count { positions[next] = positions[next - 1] + 1 }
    return true
  }
}

struct KeyboardAutocorrection {
  /// Keys that end a word and correct it, like space: the delimiter is typed after the
  /// replacement (`nciht?` → `nicht?`).
  static let delimiters: Set<String> = [" ", "?", "!", ".", ","]
  /// Marks that pull a space typed before them back onto the word (`nicht ?` → `nicht?`).
  static let spaceHuggingMarks: Set<String> = ["?", "!", ".", ","]

  /// Whether typing `mark` should first delete the space before the cursor: one space right
  /// after a letter or digit. Not after other punctuation or several spaces (`Hallo  .`,
  /// `- .`), and never with a selection or unknown left context.
  static func removesSpace(before mark: String, in context: KeyboardCorrectionContext) -> Bool {
    guard spaceHuggingMarks.contains(mark), context.isSafe, let before = context.before,
          before.last == " " else { return false }
    let word = before.dropLast()
    guard let last = word.last else { return false }
    return last.isLetter || last.isNumber
  }

  struct Edit {
    let original: String
    let replacement: String
    let context: KeyboardCorrectionContext
    /// The key that triggered the correction, typed after the replacement.
    var delimiter = " "
  }
  private var expected: KeyboardCorrectionContext?
  private var word = ""
  private var undo: Edit?
  /// When the correction was made (system uptime, seconds), for the undo window.
  private var undoTime: TimeInterval = 0
  private(set) var awaitingHostReport = false
  /// How long backspace undoes a correction; after that it is an ordinary backspace.
  static let undoWindow: TimeInterval = 3
  var hasTrackedWord: Bool { expected != nil && !word.isEmpty }

  mutating func invalidate() {
    expected = nil
    word = ""
    undo = nil
    awaitingHostReport = false
  }

  mutating func hostWillChange() {
    // Do not discard a possible acknowledgement of our own insert. No edit is allowed
    // until the corresponding did-change report matches the complete expected context.
    awaitingHostReport = true
  }

  mutating func hostDidChange(_ context: KeyboardCorrectionContext) {
    guard context.isSafe, expected == context else { invalidate(); return }
    awaitingHostReport = false
  }

  mutating func reconcile(_ context: KeyboardCorrectionContext) {
    guard !awaitingHostReport, context.isSafe, expected == context else { invalidate(); return }
  }

  /// Called before a manual character insert, not for shortcuts, dictation or agent output.
  mutating func manualInsertion(_ text: String, in context: KeyboardCorrectionContext) {
    reconcile(context)
    undo = nil
    guard context.isSafe, text.count == 1, text.first?.isLetter == true else {
      invalidate()
      return
    }
    if word.isEmpty {
      // Never adopt an existing word or something after punctuation (URLs/code/mentions),
      // including the `?`/`!` of a correction (`nicht?abc`).
      guard context.before?.isEmpty == true || context.before?.last?.isWhitespace == true else {
        invalidate()
        return
      }
    }
    word += text
    guard word.count <= 20 else { invalidate(); return }
    expected = context.inserting(text)
  }

  mutating func correction(in context: KeyboardCorrectionContext,
                           provider: KeyboardCorrectionProvider,
                           delimiter: String = " ") -> Edit? {
    reconcile(context)
    let letters = provider.letters
    guard Self.delimiters.contains(delimiter), expected != nil, KeyboardCorrectionRules.isWord(word, letters: letters),
          (context.after ?? "").isEmpty || context.after?.first?.isWhitespace == true,
          let replacement = KeyboardCorrectionRules.replacement(
            for: word,
            suggestions: provider.suggestions(
              for: word, before: String((context.before ?? "").dropLast(word.count))),
            letters: letters,
            rank: { provider.frequencyRank(of: $0) }) else { return nil }
    return Edit(original: word, replacement: replacement, context: context, delimiter: delimiter)
  }

  mutating func didCorrect(_ edit: Edit, at now: TimeInterval = ProcessInfo.processInfo.systemUptime) {
    invalidate()
    guard let before = edit.context.before else { return }
    let prefix = String(before.dropLast(edit.original.count))
    expected = KeyboardCorrectionContext(
      document: edit.context.document, before: prefix + edit.replacement + edit.delimiter,
      after: edit.context.after, selection: edit.context.selection, allowed: edit.context.allowed)
    undo = edit
    undoTime = now
  }

  /// Consumed even on failure. After undo, the restored word is deliberately not tracked.
  /// Only within `undoWindow` seconds of the correction; later backspace deletes normally.
  mutating func takeUndo(in context: KeyboardCorrectionContext,
                         at now: TimeInterval = ProcessInfo.processInfo.systemUptime) -> Edit? {
    reconcile(context)
    let edit = now - undoTime <= Self.undoWindow ? undo : nil
    invalidate()
    return edit
  }
}
