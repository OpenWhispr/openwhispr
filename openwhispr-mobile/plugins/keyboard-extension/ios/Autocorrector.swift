import Foundation

/// Costs and thresholds of the correction model, in log10 units so they add to the language
/// model's log10 probabilities. Tuned on the benchmark dev splits only.
struct AutocorrectParameters {
  /// A neighbouring key hit instead (distance up to ~1.3 key pitches).
  var adjacentSubstitution = 1.5
  /// Any other letter typed instead.
  var farSubstitution = 3.6
  /// A vowel for another vowel: a spelling mistake more than a slip.
  var vowelSubstitution = 2.5
  /// u for ü, a for ä, o for ö, ss for ß.
  var accentSubstitution = 0.6
  var transposition = 1.8
  var missedLetter = 2.3
  /// The second of a double letter missed ("accomodate").
  var missedDoubleLetter = 1.3
  var extraLetter = 3.0
  /// An extra letter that doubles its neighbour or sits on a key next to it.
  var extraNeighbour = 1.9
  /// Added to an edit of the first letter, which is rarely the wrong one.
  var firstLetterPenalty = 0.7
  /// A second edit in the same word costs this much more.
  var secondEditPenalty = 0.6
  /// log10 P that a typed word the lexicon lacks is what the user meant.
  var unknownWord = -7.4
  /// The same for a capitalised word mid-sentence, which is usually a name.
  var unknownName = -5.6
  /// Per letter beyond eight: long unknown words are compounds and names, not slips.
  var unknownLengthBonus = 0.12
  /// A correction has to beat the typed word by this much.
  var margin = 0.25
  /// …and by this much when the typed word is a word itself ("form" → "from").
  var realWordMargin = 1.6
  /// A real word is only swapped for a much more frequent form of the same key ("ill" → "I'll").
  var sameKeyMargin = 1.2
  var completionPenalty = 0.9
}

struct CorrectionResult {
  /// The typed word is one the keyboard knows, as typed.
  var typedIsKnown = false
  /// What to replace the typed word with at a word boundary; nil leaves it.
  var replacement: String?
  /// Other words worth offering, best first (corrections, then completions).
  var alternatives: [String] = []
}

/// Words the user has taught the keyboard and words iOS supplies (contacts, text
/// replacements): known words outside the bundled lexicon.
struct SupplementaryWords {
  /// Key → the word as written.
  private(set) var words: [[UInt16]: String] = [:]

  mutating func insert(_ word: String) {
    let key = TypingLexicon.key(of: word)
    guard !key.isEmpty else { return }
    words[key] = word
  }

  mutating func remove(_ word: String) { words[TypingLexicon.key(of: word)] = nil }
  mutating func removeAll() { words.removeAll() }
  func word(forKey key: [UInt16]) -> String? { words[key] }
  var isEmpty: Bool { words.isEmpty }
}

final class Autocorrector {
  let lexicon: TypingLexicon
  let language: TypingLanguage
  var geometry: KeyGeometry
  var parameters = AutocorrectParameters()
  var learned = SupplementaryWords()
  /// Words whose correction the user undid: never corrected again this session.
  var keptAsTyped: Set<String> = []

  init(lexicon: TypingLexicon, language: TypingLanguage, geometry: KeyGeometry) {
    self.lexicon = lexicon
    self.language = language
    self.geometry = geometry
  }

  // MARK: Correction

  private struct Found {
    var cost: Double
    var edits: Int
  }

  /// The correction for `typed` at a word boundary, and alternatives for the suggestion bar.
  /// `previous` is the word before it; nil at the start of a sentence.
  func correct(_ typed: String, previous: String?, sentenceStart: Bool, wantsAlternatives: Bool = true)
    -> CorrectionResult
  {
    var result = CorrectionResult()
    let key = TypingLexicon.key(of: typed)
    guard !key.isEmpty, key.count <= 28 else { return result }
    let previousID = sentenceStart ? TypingLexicon.sentenceStart : previous.flatMap { lexicon.id(of: $0) }
    let shape = CaseShape(of: typed)

    // The typed word itself.
    let sameKey = lexicon.ids(forKey: key)
    var typedScore: Double
    var typedID: Int?
    for id in sameKey where matchesAsTyped(typed, form: lexicon.word(id), shape: shape, sentenceStart: sentenceStart) {
      typedID = id
      break
    }
    // Shouting and inner capitals are deliberate: acronyms, names, "iPhone".
    if typedID == nil, shape == .upper || shape == .mixed {
      result.typedIsKnown = !sameKey.isEmpty
      return result
    }
    // "group's", "dogs'": a known word with a possessive is a known word.
    let apostrophes = typed.filter { $0 == "'" || $0 == "\u{2019}" }.count
    if typedID == nil, apostrophes > 0 {
      for suffix in ["'s", "\u{2019}s", "'", "\u{2019}"] where typed.hasSuffix(suffix) {
        let stem = String(typed.dropLast(suffix.count))
        if !stem.isEmpty, !lexicon.ids(forKey: TypingLexicon.key(of: stem)).isEmpty || learned.word(forKey: TypingLexicon.key(of: stem)) != nil {
          result.typedIsKnown = true
          return result
        }
      }
    }
    if typedID == nil, let learnedWord = learned.word(forKey: key) {
      result.typedIsKnown = true
      if learnedWord != typed, shape == .lower, learnedWord.lowercased() != typed {
        // Learned with capitals or an apostrophe of its own.
        result.replacement = learnedWord
      }
      return result
    }
    if let typedID {
      result.typedIsKnown = true
      typedScore = lexicon.log10Probability(of: typedID, after: previousID)
    } else if isCompound(key) {
      result.typedIsKnown = true
      typedScore = 0
    } else {
      let capitalised = shape != .lower && !sentenceStart
      typedScore = (capitalised ? parameters.unknownName : parameters.unknownWord)
        + parameters.unknownLengthBonus * Double(max(0, key.count - 8))
    }
    if keptAsTyped.contains(typed) {
      result.typedIsKnown = true
      typedScore = 0
    }

    var found: [Int: Found] = [:]
    let maxEdits = key.count <= 2 ? 0 : (key.count <= 4 ? 1 : 2)
    let budget = key.count <= 4 ? 3.2 : 6.5
    if maxEdits > 0, typedScore < 0 || wantsAlternatives {
      search(key: key, maxEdits: maxEdits, budget: budget, into: &found)
    }
    for id in sameKey { found[id] = Found(cost: 0, edits: 0) }

    var scored: [(id: Int, score: Double, edits: Int)] = []
    scored.reserveCapacity(found.count)
    for (id, hit) in found where id != typedID {
      // An apostrophe the user typed is never taken away.
      if apostrophes > 0, !lexicon.utf8(id).contains(0x27) { continue }
      scored.append((id, lexicon.log10Probability(of: id, after: previousID) - hit.cost, hit.edits))
    }
    scored.sort { $0.score != $1.score ? $0.score > $1.score : $0.id < $1.id }

    if let best = scored.first, typedScore < 0 {
      let needed: Double
      if typedID != nil {
        needed = best.edits == 0 ? parameters.sameKeyMargin : parameters.realWordMargin
      } else {
        needed = parameters.margin
      }
      if best.score > typedScore + needed {
        let replacement = shape.apply(to: lexicon.word(best.id), sentenceStart: sentenceStart)
        if replacement != typed { result.replacement = replacement }
      }
    }

    if wantsAlternatives {
      var seen: Set<String> = [typed]
      if let replacement = result.replacement { seen.insert(replacement) }
      for candidate in scored.prefix(6) {
        let word = shape.apply(to: lexicon.word(candidate.id), sentenceStart: sentenceStart)
        if seen.insert(word).inserted { result.alternatives.append(word) }
      }
      for word in completions(ofKey: key, previousID: previousID, shape: shape, sentenceStart: sentenceStart, limit: 4) {
        if seen.insert(word).inserted { result.alternatives.append(word) }
      }
    }
    return result
  }

  /// Typed with shift held, a word still counts as typed: "Sie" for "sie", "HELLO" for "hello".
  private func matchesAsTyped(_ typed: String, form: String, shape: CaseShape, sentenceStart: Bool) -> Bool {
    if form == typed { return true }
    // An apostrophe the user left out, or capitals the word has of its own, is a correction.
    guard form.utf16.count == typed.utf16.count else { return false }
    switch shape {
    case .lower: return false
    case .capitalised: return form.lowercased() == typed.lowercased() && form == form.lowercased()
    case .upper: return form.uppercased() == typed
    case .mixed: return false
    }
  }

  // MARK: Candidate search

  private static let vowels: Set<UInt16> = Set("aeiouyäöü".utf16)

  private func substitutionCost(typed: UInt16, intended: UInt16) -> Double {
    if KeyGeometry.unaccented(intended) == typed || KeyGeometry.unaccented(typed) == intended {
      return parameters.accentSubstitution
    }
    if geometry.areNeighbours(typed, intended) { return parameters.adjacentSubstitution }
    if Autocorrector.vowels.contains(typed), Autocorrector.vowels.contains(intended) {
      return parameters.vowelSubstitution
    }
    return parameters.farSubstitution
  }

  private func isNeighbour(_ a: UInt16, _ b: UInt16) -> Bool {
    a == b || geometry.areNeighbours(a, b)
  }

  private enum LastEdit { case none, extra, missed }

  private func search(key: [UInt16], maxEdits: Int, budget: Double, into found: inout [Int: Found]) {
    let count = key.count
    func record(_ node: Int, _ cost: Double, _ edits: Int) {
      for id in lexicon.terminals(of: node) {
        if let existing = found[id], existing.cost <= cost { continue }
        found[id] = Found(cost: cost, edits: edits)
      }
    }
    func editCost(_ base: Double, at position: Int, edits: Int) -> Double {
      base + (position == 0 ? parameters.firstLetterPenalty : 0) + (edits > 0 ? parameters.secondEditPenalty : 0)
    }
    func visit(_ node: Int, _ position: Int, _ cost: Double, _ edits: Int, _ last: LastEdit, _ previous: UInt16) {
      if position == count {
        if edits > 0 { record(node, cost, edits) }
        // A letter missed at the very end.
        if edits < maxEdits, last != .extra {
          let first = lexicon.firstChild(of: node)
          for child in first..<(first + lexicon.childCount(of: node)) {
            let character = lexicon.character(of: child)
            let base = character == previous ? parameters.missedDoubleLetter : parameters.missedLetter
            let next = cost + editCost(base, at: position, edits: edits)
            if next <= budget { record(child, next, edits + 1) }
          }
        }
        return
      }
      let typed = key[position]
      let first = lexicon.firstChild(of: node)
      let end = first + lexicon.childCount(of: node)
      for child in first..<end {
        let character = lexicon.character(of: child)
        if character == typed {
          visit(child, position + 1, cost, edits, .none, character)
          continue
        }
        guard edits < maxEdits else { continue }
        // ss typed for ß.
        if character == 0xDF, typed == 0x73, position + 1 < count, key[position + 1] == 0x73 {
          let next = cost + parameters.accentSubstitution
          if next <= budget { visit(child, position + 2, next, edits + 1, .none, character) }
        }
        // Another letter typed instead of this one.
        let substituted = cost + editCost(substitutionCost(typed: typed, intended: character), at: position, edits: edits)
        if substituted <= budget { visit(child, position + 1, substituted, edits + 1, .none, character) }
        // This letter missed.
        if last != .extra {
          let base = character == previous ? parameters.missedDoubleLetter : parameters.missedLetter
          let missed = cost + editCost(base, at: position, edits: edits)
          if missed <= budget { visit(child, position, missed, edits + 1, .missed, character) }
        }
      }
      guard edits < maxEdits else { return }
      // An extra letter typed here.
      if last != .missed {
        let nextTyped = position + 1 < count ? key[position + 1] : 0
        let near = (previous != 0 && isNeighbour(typed, previous)) || (nextTyped != 0 && isNeighbour(typed, nextTyped))
        let extra = cost + editCost(near ? parameters.extraNeighbour : parameters.extraLetter, at: position, edits: edits)
        if extra <= budget { visit(node, position + 1, extra, edits + 1, .extra, previous) }
      }
      // Two letters swapped.
      if position + 1 < count, key[position + 1] != typed,
        let firstSwap = lexicon.child(of: node, character: key[position + 1]),
        let secondSwap = lexicon.child(of: firstSwap, character: typed)
      {
        let swapped = cost + editCost(parameters.transposition, at: position, edits: edits)
        if swapped <= budget { visit(secondSwap, position + 2, swapped, edits + 1, .none, typed) }
      }
    }
    visit(TypingLexicon.root, 0, 0, 0, .none, 0)
  }

  // MARK: Compounds

  /// A German word made of two or three known words, with an optional linking s
  /// ("Arbeitszimmer"). Such a word is taken as spelled right.
  func isCompound(_ key: [UInt16]) -> Bool {
    guard language == .german, key.count >= 8 else { return false }
    return compoundParts(key, from: 0, partsLeft: 3)
  }

  private func compoundParts(_ key: [UInt16], from start: Int, partsLeft: Int) -> Bool {
    var node = TypingLexicon.root
    var position = start
    while position < key.count {
      guard let next = lexicon.child(of: node, character: key[position]) else { return false }
      node = next
      position += 1
      let length = position - start
      guard length >= 3, !lexicon.terminals(of: node).isEmpty else { continue }
      // Rare words make false joins; a part has to be a reasonably common word.
      guard lexicon.log10Frequency(lexicon.terminals(of: node).lowerBound) > -6.2 else { continue }
      if position == key.count { return start > 0 }
      guard partsLeft > 1 else { continue }
      if compoundParts(key, from: position, partsLeft: partsLeft - 1) { return true }
      if key[position] == 0x73, position + 1 < key.count,
        compoundParts(key, from: position + 1, partsLeft: partsLeft - 1)
      {
        return true
      }
    }
    return false
  }

  // MARK: Completions and predictions

  /// The likeliest words that start with `key`, longer than it.
  func completions(ofKey key: [UInt16], previousID: Int?, shape: CaseShape, sentenceStart: Bool, limit: Int)
    -> [String]
  {
    guard !key.isEmpty, let node = lexicon.node(forKey: key) else { return [] }
    let range = lexicon.words(under: node)
    let exact = lexicon.terminals(of: node)
    var best: [(id: Int, score: Double)] = []
    func offer(_ id: Int, _ score: Double) {
      if best.count == limit * 2, let last = best.last, score <= last.score { return }
      if best.contains(where: { $0.id == id }) { return }
      let index = best.firstIndex { $0.score < score } ?? best.count
      best.insert((id, score), at: index)
      if best.count > limit * 2 { best.removeLast() }
    }
    for id in range where !exact.contains(id) {
      offer(id, lexicon.log10Frequency(id) + log10(1 - TypingLexicon.pairWeight))
    }
    if let previousID {
      for index in lexicon.followers(of: previousID) {
        let follower = lexicon.follower(at: index)
        guard range.contains(follower.id), !exact.contains(follower.id) else { continue }
        best.removeAll { $0.id == follower.id }
        offer(follower.id, lexicon.log10Probability(of: follower.id, after: previousID))
      }
    }
    return best.prefix(limit).map { shape.apply(to: lexicon.word($0.id), sentenceStart: sentenceStart) }
  }

  /// The likeliest next words after `previous` (nil: at the start of a sentence).
  func predictions(after previous: String?, sentenceStart: Bool, limit: Int = 3) -> [String] {
    let previousID = sentenceStart ? TypingLexicon.sentenceStart : previous.flatMap { lexicon.id(of: $0) }
    guard let previousID else { return [] }
    var best: [(id: Int, score: Double)] = []
    for index in lexicon.followers(of: previousID) {
      let follower = lexicon.follower(at: index)
      if best.count == limit, let last = best.last, follower.log10 <= last.score { continue }
      let position = best.firstIndex { $0.score < follower.log10 } ?? best.count
      best.insert((follower.id, follower.log10), at: position)
      if best.count > limit { best.removeLast() }
    }
    return best.map { CaseShape.lower.apply(to: lexicon.word($0.id), sentenceStart: sentenceStart) }
  }
}

/// How a typed word used shift, carried over to what replaces it.
enum CaseShape {
  case lower, capitalised, upper, mixed

  init(of word: String) {
    let letters = word.filter(\.isLetter)
    guard let first = letters.first else {
      self = .lower
      return
    }
    if letters.count > 1, letters.allSatisfy(\.isUppercase) {
      self = .upper
    } else if first.isUppercase, letters.dropFirst().allSatisfy(\.isLowercase) {
      self = .capitalised
    } else if letters.allSatisfy(\.isLowercase) {
      self = .lower
    } else {
      self = .mixed
    }
  }

  /// `word` is a lexicon word, which may have capitals of its own ("Monday", "iPhone").
  func apply(to word: String, sentenceStart: Bool) -> String {
    switch self {
    case .upper: return word.uppercased()
    case .capitalised, .mixed: return CaseShape.capitalisingFirst(word)
    case .lower: return sentenceStart ? CaseShape.capitalisingFirst(word) : word
    }
  }

  static func capitalisingFirst(_ word: String) -> String {
    guard let first = word.first, first.isLowercase else { return word }
    return first.uppercased() + word.dropFirst()
  }
}
