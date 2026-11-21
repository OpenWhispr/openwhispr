import Foundation

/// Costs and thresholds of the correction model, in log10 units so they add to the language
/// model's log10 probabilities. Tuned on the benchmark dev splits only. The defaults are
/// English's; `init(language:)` has what German changes.
struct AutocorrectParameters {
  /// A neighbouring key hit instead (distance up to ~1.3 key pitches).
  var adjacentSubstitution = 1.5
  /// Any other letter typed instead.
  var farSubstitution = 4.2
  /// A vowel for another vowel: a spelling mistake more than a slip.
  var vowelSubstitution = 2.8
  /// u typed for ü, a for ä, o for ö, ss for ß: the quick way to type them on a keyboard
  /// that has them only behind a held key.
  var accentSubstitution = 0.6
  var transposition = 1.4
  var missedLetter = 2.1
  /// The second of a double letter missed ("accomodate").
  var missedDoubleLetter = 0.5
  var extraLetter = 3.3
  /// An extra letter on a key next to the one before or after it.
  var extraNeighbour = 2.3
  /// A letter typed twice ("sufferring").
  var extraDoubleLetter = 1.3
  /// Added to an edit of the first letter, which is rarely the wrong one.
  var firstLetterPenalty = 0.3
  /// A second edit in the same word costs this much more.
  var secondEditPenalty = 0.6
  /// log10 P that a typed word the lexicon lacks is what the user meant.
  var unknownWord = -8.0
  /// The same for a capitalised word mid-sentence, which is usually a name.
  var unknownName = -7.0
  /// Per letter beyond four, taken off both of the above: the longer an unknown word, the
  /// less likely it sits one slip from a real word by chance.
  var unknownLengthPenalty = 0.4
  var nameLengthPenalty = 0.5
  /// A known word with a regular ending the lexicon happens to lack ("shuttles", "googled")
  /// scores as its stem less this…
  var inflectedPenalty = 1.0
  /// …but never above this: a form more frequent than the lexicon's rarest words would be in
  /// the lexicon, so "woulds" is no likelier than they are.
  var inflectedCeiling = -7.6
  /// Typed with a capital mid-sentence, a correction to a word the lexicon writes in lower
  /// case costs this: the capital says name (or, in German, noun).
  var lowerCaseForCapitalised = 0.9
  /// Typed in lower case, a correction to a word the lexicon only has capitalised costs this.
  var capitalisedForLowerCase = 0.9
  /// A correction has to beat the typed word by this much.
  var margin = 0.05
  /// …and by this much when the typed word is a word itself ("form" → "from"). English can
  /// afford a small margin since capitalisation-only changes are no longer made for people
  /// who write in lower case; German keeps the larger one.
  var realWordMargin = 0.6
  /// Added to either margin when the correction is the typed word with another regular
  /// ending.
  var otherFormMargin = 1.4
  /// log10 P of a German compound of known words that the lexicon lacks: only a listed
  /// word a slip away and far likelier replaces it ("Lebenstil" → "Lebensstil").
  var compoundWord = -7.0
  /// Taken off a German compound mended in one part ("Hundeschuke" → "Hundeschule"), which
  /// scores as the mended part.
  var compoundPenalty = 2.0
  /// A real word is only swapped for a much more frequent form of the same key ("ill" → "I'll").
  var sameKeyMargin = 1.2
  /// How much less a completion counts than a correction of the same probability, when
  /// ranking the bar's alternatives.
  var completionPenalty = 0.4

  init(language: TypingLanguage = .english) {
    guard language == .german else { return }
    realWordMargin = 1.0
    otherFormMargin = 1.0
    // The German keyboard has umlaut keys, and "schon" and "schön" are both words.
    accentSubstitution = 1.8
    missedLetter = 1.7
    // Double letters are everywhere in German, so one typed is less often a slip.
    extraDoubleLetter = 2.3
    // The lexicon is half again as large and the words longer: fewer strangers.
    unknownWord = -8.8
    unknownLengthPenalty = 0.6
    inflectedCeiling = -9.4
    margin = 0.45
    // A capital mid-sentence is a noun, not a name: no reason to leave the word alone, and
    // every reason to correct it to a noun.
    unknownName = -7.9
    lowerCaseForCapitalised = 1.5
    compoundWord = -9.0
    compoundPenalty = 3.5
  }
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
  var parameters: AutocorrectParameters
  var learned = SupplementaryWords()
  /// Words whose correction the user undid: never corrected again this session.
  var keptAsTyped: Set<String> = []

  /// The user turned down a correction of this word; however it is capitalised next time,
  /// it stays as typed.
  func keepAsTyped(_ word: String) { keptAsTyped.insert(word.lowercased()) }

  init(lexicon: TypingLexicon, language: TypingLanguage, geometry: KeyGeometry) {
    self.lexicon = lexicon
    self.language = language
    self.geometry = geometry
    parameters = AutocorrectParameters(language: language)
  }

  // MARK: Correction

  private struct Found {
    var cost: Double
    var edits: Int
  }

  private struct Candidate {
    var id: Int
    var score: Double
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
    // The typed word in its other capitalisation ("Hell" and "hell") is the same word: its
    // forms count together, and none of them is a correction of another.
    let typedLower = typed.lowercased()
    var typedForms: [Int] = []
    if typedID != nil {
      typedForms = sameKey.filter { lexicon.word($0).lowercased() == typedLower }
    }
    let capitalisedMidSentence = shape == .capitalised && !sentenceStart
    var inflected = false
    if typedID != nil {
      result.typedIsKnown = true
      typedScore = log10(typedForms.reduce(0) { $0 + pow(10, lexicon.log10Probability(of: $1, after: previousID)) })
    } else if isCompound(key) {
      result.typedIsKnown = true
      typedScore = parameters.compoundWord
    } else if let stem = inflectionStem(of: key) {
      inflected = true
      typedScore = min(lexicon.log10Frequency(stem) - parameters.inflectedPenalty, parameters.inflectedCeiling)
    } else {
      let extra = Double(max(0, key.count - 4))
      typedScore = capitalisedMidSentence
        ? parameters.unknownName - parameters.nameLengthPenalty * extra
        : parameters.unknownWord - parameters.unknownLengthPenalty * extra
    }
    if keptAsTyped.contains(typedLower) {
      result.typedIsKnown = true
      typedScore = 0
    }
    // All capitals are typed on purpose, also for a word the lexicon has.
    let deliberate = shape == .upper

    // "Alqn's": a possessive of a word the lexicon has no possessive for is corrected as
    // that word.
    if typedID == nil, typedScore < 0, apostrophes == 1, !deliberate {
      for suffix in ["'s", "\u{2019}s"] where typed.hasSuffix(suffix) {
        let stem = String(typed.dropLast(suffix.count))
        guard stem.count >= 3 else { continue }
        let inner = correct(stem, previous: previous, sentenceStart: sentenceStart, wantsAlternatives: false)
        if let replacement = inner.replacement, !replacement.contains("'") {
          result.replacement = replacement + suffix
          return result
        }
      }
    }

    var found: [Int: Found] = [:]
    let maxEdits = key.count <= 2 ? 0 : (key.count <= 4 ? 1 : 2)
    let budget = key.count <= 4 ? 3.2 : 6.5
    if maxEdits > 0, typedScore < 0 || wantsAlternatives {
      search(key: key, maxEdits: maxEdits, budget: budget, into: &found)
    }
    for id in sameKey { found[id] = Found(cost: 0, edits: 0) }

    var scored: [Candidate] = []
    scored.reserveCapacity(found.count)
    for (id, hit) in found where !typedForms.contains(id) {
      // An apostrophe the user typed is never taken away.
      if apostrophes > 0, !lexicon.utf8(id).contains(0x27) { continue }
      var score = lexicon.log10Probability(of: id, after: previousID) - hit.cost
      // How the word was capitalised says what kind of word was meant.
      if capitalisedMidSentence {
        if hit.edits > 0, !hasCapital(id) { score -= parameters.lowerCaseForCapitalised }
      } else if shape == .lower, hasCapital(id) {
        score -= parameters.capitalisedForLowerCase
      }
      scored.append(Candidate(id: id, score: score, edits: hit.edits))
    }
    scored.sort { $0.score != $1.score ? $0.score > $1.score : $0.id < $1.id }
    mergeCaseForms(&scored, typedInLowerCase: shape == .lower)

    if let best = scored.first, typedScore < 0, !deliberate {
      var needed: Double
      if typedID != nil {
        needed = best.edits == 0 ? parameters.sameKeyMargin : parameters.realWordMargin
      } else {
        needed = parameters.margin
      }
      // "shuttles" for "shuttle": another form of the same word is rarely a slip, and the
      // word before says little about which form was meant.
      if best.edits > 0, areFormsOfOneWord(key, TypingLexicon.key(of: lexicon.word(best.id))) {
        needed += parameters.otherFormMargin
      }
      if best.score > typedScore + needed {
        let replacement = shape.apply(to: lexicon.word(best.id), sentenceStart: sentenceStart)
        if replacement != typed { result.replacement = replacement }
      }
    }
    if result.replacement == nil, typedID == nil, typedScore < 0, shape == .capitalised, apostrophes == 0,
      !inflected, !result.typedIsKnown,
      let compound = compoundCorrection(of: key), compound.score > typedScore + parameters.margin
    {
      result.replacement = shape.apply(to: compound.text, sentenceStart: sentenceStart)
    }

    if wantsAlternatives {
      var seen: Set<String> = [typed]
      if let replacement = result.replacement { seen.insert(replacement) }
      // Corrections and completions compete on one scale, so "Hel" offers "Hello" and
      // "Help" ahead of unlikely respellings.
      var offers = scored.prefix(6).map { (id: Int, score: Double)($0.id, $0.score) }
      for completion in scoredCompletions(ofKey: key, previousID: previousID, limit: 4) {
        offers.append((completion.id, completion.score - parameters.completionPenalty))
      }
      offers.sort { $0.score != $1.score ? $0.score > $1.score : $0.id < $1.id }
      for offer in offers {
        let word = shape.apply(to: lexicon.word(offer.id), sentenceStart: sentenceStart)
        if seen.insert(word).inserted { result.alternatives.append(word) }
      }
    }
    return result
  }

  /// Whether the lexicon writes the word with a capital ("Monday", "iPhone", German nouns).
  private func hasCapital(_ id: Int) -> Bool {
    let word = lexicon.word(id)
    return word != word.lowercased()
  }

  /// "Department" and "department" are one word to correct to: among the best candidates,
  /// forms that differ only in capitals pool their scores, and the form that goes in is the
  /// lower-case one when the word was typed in lower case, else the likelier one.
  /// `scored` is sorted best first and stays so.
  private func mergeCaseForms(_ scored: inout [Candidate], typedInLowerCase: Bool) {
    var changed = false
    var index = 0
    while index < min(scored.count, 3) {
      let first = scored[index]
      let lower = lexicon.word(first.id).lowercased()
      var forms = [first]
      for sibling in lexicon.ids(forKey: TypingLexicon.key(of: lower)) where sibling != first.id {
        guard lexicon.word(sibling).lowercased() == lower,
          let other = scored.firstIndex(where: { $0.id == sibling && $0.edits == first.edits })
        else { continue }
        // Always further down: a likelier form would have taken this one in already.
        forms.append(scored.remove(at: other))
      }
      if forms.count > 1 {
        // `first` was the likeliest of them.
        var chosen = first
        if typedInLowerCase, let plain = forms.first(where: { lexicon.word($0.id) == lower }) { chosen = plain }
        chosen.score = log10(forms.reduce(0) { $0 + pow(10, $1.score) })
        scored[index] = chosen
        changed = true
      }
      index += 1
    }
    if changed { scored.sort { $0.score != $1.score ? $0.score > $1.score : $0.id < $1.id } }
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
    // One way only: the plain letter is the quick way to type the accented one, but nobody
    // holds a key for ü and means u.
    if KeyGeometry.unaccented(intended) == typed { return parameters.accentSubstitution }
    if geometry.areNeighbours(typed, intended) { return parameters.adjacentSubstitution }
    if Autocorrector.vowels.contains(typed), Autocorrector.vowels.contains(intended) {
      return parameters.vowelSubstitution
    }
    return parameters.farSubstitution
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
        let base: Double
        if typed == previous || typed == nextTyped {
          base = parameters.extraDoubleLetter
        } else if (previous != 0 && geometry.areNeighbours(typed, previous)) || (nextTyped != 0 && geometry.areNeighbours(typed, nextTyped)) {
          base = parameters.extraNeighbour
        } else {
          base = parameters.extraLetter
        }
        let extra = cost + editCost(base, at: position, edits: edits)
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

  // MARK: Inflections

  private static let englishEndings = ["s", "es", "ed", "d", "ing", "ly", "er", "ers", "est", "ness", "less", "ful", "able", "ment", "ments", "ings"]
  private static let germanEndings = ["e", "en", "er", "es", "em", "n", "s", "st", "t", "te", "ten", "test", "tet", "ung", "ungen", "heit", "keit", "lich", "isch", "chen", "in", "innen"]

  private static let englishEndingKeys = Set(englishEndings.map { Array($0.utf16) })
  private static let germanEndingKeys = Set(germanEndings.map { Array($0.utf16) })

  /// The most frequent known word that `key` is a regular form of, when there is one: the
  /// word plus an ending, with English's dropped e ("hoping") and y → i ("tried") allowed.
  private func inflectionStem(of key: [UInt16]) -> Int? {
    let endings = language == .german ? Autocorrector.germanEndings : Autocorrector.englishEndings
    var best: Int?
    func offer(_ stem: [UInt16]) {
      guard stem.count >= 3, let id = lexicon.ids(forKey: stem).first else { return }
      if best == nil || lexicon.log10Frequency(id) > lexicon.log10Frequency(best!) { best = id }
    }
    for ending in endings {
      let units = Array(ending.utf16)
      guard key.count > units.count + 2, Array(key.suffix(units.count)) == units else { continue }
      let stem = Array(key.dropLast(units.count))
      if language == .german || Autocorrector.englishTakes(ending, after: stem) { offer(stem) }
      guard language == .english else { continue }
      if ["ed", "ing", "er", "ers", "est", "able", "ings"].contains(ending) {
        offer(stem + [0x65])  // hop(e) + ing
        // A doubled consonant: "stopped" → stop.
        if stem.count >= 4, stem[stem.count - 1] == stem[stem.count - 2] { offer(Array(stem.dropLast())) }
      }
      if ["es", "ed", "er", "est"].contains(ending), stem.last == 0x69 {
        offer(Array(stem.dropLast()) + [0x79])  // tri(y) + ed
      }
    }
    return best
  }

  /// English spelling's say in which ending a word takes as it stands: "-d" only after e
  /// ("googled", never "wheeld"), "-es" after a sibilant or o and "-s" elsewhere, and no
  /// vowel ending straight after e ("hoping", never "hopeing").
  private static func englishTakes(_ ending: String, after stem: [UInt16]) -> Bool {
    guard let last = stem.last else { return false }
    let before = stem.count > 1 ? stem[stem.count - 2] : 0
    // s, x, z, ch, sh
    let sibilant = last == 0x73 || last == 0x78 || last == 0x7A || (last == 0x68 && (before == 0x63 || before == 0x73))
    switch ending {
    case "d": return last == 0x65
    case "s": return !sibilant
    case "es": return sibilant || last == 0x6F
    case "ed", "ing", "er", "ers", "est", "able", "ings": return last != 0x65
    default: return true
    }
  }

  /// Whether two keys are one stem with different regular endings ("evacuates" and
  /// "evacuated", "napkin" and "napkins").
  private func areFormsOfOneWord(_ a: [UInt16], _ b: [UInt16]) -> Bool {
    var shared = 0
    while shared < a.count, shared < b.count, a[shared] == b[shared] { shared += 1 }
    guard shared >= 3 else { return false }
    let endings = language == .german ? Autocorrector.germanEndingKeys : Autocorrector.englishEndingKeys
    func isEnding(_ rest: ArraySlice<UInt16>) -> Bool { rest.isEmpty || endings.contains(Array(rest)) }
    // The endings may share their first letters ("-es" and "-ed").
    for stem in stride(from: shared, through: max(3, shared - 2), by: -1) {
      if isEnding(a[stem...]), isEnding(b[stem...]) { return true }
    }
    return false
  }

  // MARK: Compounds

  /// A German word made of two or three known words, with an optional linking element
  /// between them ("Arbeitszimmer"). Such a word is taken as a word.
  func isCompound(_ key: [UInt16]) -> Bool {
    guard language == .german, key.count >= 8 else { return false }
    return compoundParts(key, from: 0, partsLeft: 3)
  }

  /// Rare words make false joins; a part has to be a reasonably common word.
  private static let compoundPartFloor = -6.2
  /// What German puts between the parts ("Arbeit-s-zimmer", "Diele-n-boden"), longest first.
  private static let linkingElements: [[UInt16]] = ["es", "en", "er", "s", "n", "e"].map { Array($0.utf16) }

  private func isCompoundPart(_ id: Int) -> Bool {
    lexicon.log10Frequency(id) > Autocorrector.compoundPartFloor
  }

  /// A common word, with or without a linking element after it.
  private func isCompoundHead(_ key: [UInt16]) -> Bool {
    if lexicon.ids(forKey: key).contains(where: isCompoundPart) { return true }
    for link in Autocorrector.linkingElements where key.count >= link.count + 3 && Array(key.suffix(link.count)) == link {
      if lexicon.ids(forKey: Array(key.dropLast(link.count))).contains(where: isCompoundPart) { return true }
    }
    return false
  }

  /// "Hundeschuke" → "hundeschule": a noun compound the lexicon lacks, with one slip in one
  /// of its two parts and the other part standing as typed. The score is on the candidates'
  /// scale. A compound is what its last part is, so that part has to be a noun.
  private func compoundCorrection(of key: [UInt16]) -> (text: String, score: Double)? {
    guard language == .german, key.count >= 8 else { return nil }
    var best: (text: String, score: Double)?
    func mended(_ part: [UInt16], noun: Bool) -> (word: String, score: Double)? {
      // A part that is a word, however rare, was not mistyped.
      guard lexicon.ids(forKey: part).isEmpty else { return nil }
      var found: [Int: Found] = [:]
      search(key: part, maxEdits: 1, budget: 3.2, into: &found)
      var top: (id: Int, score: Double)?
      for (id, hit) in found where isCompoundPart(id) && (!noun || hasCapital(id)) {
        let score = lexicon.log10Frequency(id) - hit.cost
        if top == nil || score > top!.score || (score == top!.score && id < top!.id) { top = (id, score) }
      }
      return top.map { (lexicon.word($0.id).lowercased(), $0.score - parameters.compoundPenalty) }
    }
    func offer(_ text: String, _ score: Double) {
      if best == nil || score > best!.score { best = (text, score) }
    }
    for split in 4...(key.count - 4) {
      let head = Array(key[..<split]), tail = Array(key[split...])
      if isCompoundHead(head), let fix = mended(tail, noun: true) {
        offer(String(utf16CodeUnits: head, count: head.count) + fix.word, fix.score)
      }
      if lexicon.ids(forKey: tail).contains(where: { isCompoundPart($0) && hasCapital($0) }),
        let fix = mended(head, noun: false)
      {
        offer(fix.word + String(utf16CodeUnits: tail, count: tail.count), fix.score)
      }
    }
    return best
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
      guard isCompoundPart(lexicon.terminals(of: node).lowerBound) else { continue }
      if position == key.count { return start > 0 }
      guard partsLeft > 1 else { continue }
      if compoundParts(key, from: position, partsLeft: partsLeft - 1) { return true }
      for link in Autocorrector.linkingElements
      where position + link.count < key.count && Array(key[position..<(position + link.count)]) == link {
        if compoundParts(key, from: position + link.count, partsLeft: partsLeft - 1) { return true }
      }
    }
    return false
  }

  // MARK: Completions and predictions

  /// The likeliest words that start with `key`, longer than it.
  func completions(ofKey key: [UInt16], previousID: Int?, shape: CaseShape, sentenceStart: Bool, limit: Int)
    -> [String]
  {
    scoredCompletions(ofKey: key, previousID: previousID, limit: limit)
      .map { shape.apply(to: lexicon.word($0.id), sentenceStart: sentenceStart) }
  }

  private func scoredCompletions(ofKey key: [UInt16], previousID: Int?, limit: Int) -> [(id: Int, score: Double)] {
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
    return Array(best.prefix(limit))
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
    // A prediction opens the sentence, so it takes the capital shift would have given it.
    return best.map { sentenceStart ? CaseShape.capitalisingFirst(lexicon.word($0.id)) : lexicon.word($0.id) }
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
    // Typed in lower case at the start of a sentence means shift was turned off on purpose
    // (the keyboard turns it on there by itself), so the word stays as the lexicon has it.
    case .lower: return word
    }
  }

  static func capitalisingFirst(_ word: String) -> String {
    guard let first = word.first, first.isLowercase else { return word }
    return first.uppercased() + word.dropFirst()
  }
}
