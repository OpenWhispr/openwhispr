import UIKit
import os

/// Public, on-device API only. No learned words or text leave the keyboard.
///
/// Checks the languages picked in the app's Settings together (German and English by
/// default), since the keyboard has no language switch: a word any of their dictionaries
/// knows is left alone (an English word in German text, or the reverse), unless the
/// sentence's language or a German umlaut respelling says otherwise, and each proposal must be
/// a known word in the dictionary that offered it. `KeyboardCorrectionRules` then scores the
/// proposals by key distance and frequency; the provider returns the one it picks.
final class TextCheckerCorrectionProvider: KeyboardCorrectionProvider {
  /// The selection this provider was built for; the controller rebuilds it when that changes.
  let languages: [KeyboardCorrectionLanguage]
  /// Only languages with an installed dictionary; their letters bound what can be corrected.
  let letters: Set<Character>
  private let dictionaries: [String]
  /// The language code of each entry in `dictionaries`.
  private let resolvedCodes: [String]
  /// The German dictionary, when German is selected and installed (for ae/oe/ue/ss).
  private let germanDictionary: String?
  private let checker = UITextChecker()
  private var completionCache: [String: [String]] = [:]
  /// How long a space press may spend looking up neighbouring-key variants.
  static let slipSearchNanoseconds: UInt64 = 100_000_000
  private let log = Logger(subsystem: "com.gizmolabs.openwhispr.keyboard", category: "Autocorrection")

  init(languages: [KeyboardCorrectionLanguage]) {
    self.languages = languages
    let available = UITextChecker.availableLanguages
    let resolved = languages.compactMap { language in
      Self.dictionary(for: language, from: available).map { (language, $0) }
    }
    dictionaries = resolved.map { $0.1 }
    resolvedCodes = resolved.map { $0.0.code }
    germanDictionary = resolved.first { $0.0.code == KeyboardCorrectionLanguage.german.code }?.1
    letters = KeyboardCorrectionLanguage.letters(of: resolved.map { $0.0 })
  }

  private static func dictionary(for language: KeyboardCorrectionLanguage,
                                 from available: [String]) -> String? {
    language.dictionaries.first { available.contains($0) }
      ?? available.sorted().first {
        $0.hasPrefix(language.code + "_") || $0.hasPrefix(language.code + "-")
      }
  }

  private func misspelledRange(of word: String, in dictionary: String) -> NSRange {
    let range = NSRange(word.startIndex..<word.endIndex, in: word)
    return checker.rangeOfMisspelledWord(
      in: word, range: range, startingAt: 0, wrap: false, language: dictionary)
  }

  private func isKnown(_ word: String, in dictionary: String) -> Bool {
    misspelledRange(of: word, in: dictionary).location == NSNotFound
  }

  /// How common a word is: its position among UITextChecker's completions of its first two
  /// letters, which Apple orders by likelihood (lower is more common); nil when no selected
  /// dictionary completes to it. Completions are cached per dictionary and prefix, a few dozen
  /// at most, since the keyboard extension runs under a tight memory limit.
  func frequencyRank(of candidate: String) -> Int? {
    dictionaries.compactMap { rank(of: candidate, in: $0) }.min()
  }

  /// The candidate's position among one dictionary's completions of its first two letters.
  private func rank(of candidate: String, in dictionary: String) -> Int? {
    let prefix = String(candidate.prefix(2)).lowercased()
    let key = dictionary + "|" + prefix
    let completions: [String]
    if let cached = completionCache[key] {
      completions = cached
    } else {
      let range = NSRange(prefix.startIndex..<prefix.endIndex, in: prefix)
      completions = (checker.completions(forPartialWordRange: range, in: prefix, language: dictionary) ?? [])
        .map { $0.lowercased() }
      if completionCache.count >= 48 { completionCache.removeAll() }
      completionCache[key] = completions
    }
    return completions.firstIndex(of: candidate.lowercased())
  }

  /// Respellings of a word a dictionary accepts as typed, that German knows, when the typed
  /// spelling isn't a common word in any selected dictionary (no frequency rank): `moechte` or a
  /// learned `fuer` become `möchte` and `für`, while `sued`, `phoenix`, `Masse` and `Busse`
  /// stay. A respelling with ß also needs German not to know the ss spelling, or the ß one to
  /// be common.
  private func knownWordRespellings(of word: String) -> [String] {
    guard let germanDictionary, frequencyRank(of: word) == nil else { return [] }
    let germanKnowsWord = isKnown(word, in: germanDictionary)
    return KeyboardCorrectionRules.transcriptions(of: word).compactMap { respelling in
      guard let spelling = germanSpelling(of: respelling.word, in: germanDictionary) else { return nil }
      guard spelling.contains("ß") else { return spelling }
      return !germanKnowsWord || frequencyRank(of: spelling) != nil ? spelling : nil
    }
  }

  /// The respelling as German knows it: as typed, or capitalised for a noun typed in lowercase.
  private func germanSpelling(of respelling: String, in dictionary: String) -> String? {
    if isKnown(respelling, in: dictionary) { return respelling }
    let noun = KeyboardCorrectionRules.capitalized(respelling)
    return noun != respelling && isKnown(noun, in: dictionary) ? noun : nil
  }

  func suggestions(for word: String) -> [String] { suggestions(for: word, before: "") }

  /// In a sentence in one selected language, a word only another language knows counts as a
  /// typo when it isn't common there (`woe` in German text → `wie`, while `cool` stays), so
  /// that language's dictionary alone checks it.
  func suggestions(for word: String, before: String) -> [String] {
    guard languages.count > 1, !before.isEmpty else { return suggestions(for: word, using: dictionaries) }
    let byCode = Dictionary(uniqueKeysWithValues: zip(resolvedCodes, dictionaries))
    guard let code = KeyboardCorrectionRules.sentenceLanguage(
      before: before, codes: resolvedCodes,
      knows: { word, code in byCode[code].map { self.isKnown(word, in: $0) } ?? false }),
      let sentenceDictionary = byCode[code], !isKnown(word, in: sentenceDictionary) else {
      return suggestions(for: word, using: dictionaries)
    }
    let others = dictionaries.filter { $0 != sentenceDictionary }
    let commonElsewhere = others.contains { dictionary in
      isKnown(word, in: dictionary) && (rank(of: word, in: dictionary).map { $0 < Self.commonRank } ?? false)
    }
    // Flags only: the sentence's language code, never its words.
    log.info("Autocorrection sentence language: \(code, privacy: .public) commonElsewhere=\(commonElsewhere, privacy: .public)")
    return suggestions(for: word, using: commonElsewhere ? dictionaries : [sentenceDictionary])
  }

  /// A word among the first this many completions of its first two letters counts as common
  /// in that language and isn't corrected by another language's sentence.
  static let commonRank = 25

  private func suggestions(for word: String, using dictionaries: [String]) -> [String] {
    guard !dictionaries.isEmpty else {
      log.info("Autocorrection skipped: no dictionary for the selected languages")
      return []
    }
    guard KeyboardCorrectionRules.isWord(word, letters: letters) else { return [] }
    let range = NSRange(word.startIndex..<word.endIndex, in: word)
    // The complete word must be flagged by every dictionary, not just part of it by one.
    guard dictionaries.allSatisfy({ misspelledRange(of: word, in: $0) == range }) else {
      // Except German typed without umlauts that a dictionary (English, or one with Swiss or
      // learned spellings) accepts as it is: `moechte`, `strasse`.
      let respelled = knownWordRespellings(of: word)
      let pick = respelled.isEmpty ? word : KeyboardCorrectionRules.replacement(
        for: word, suggestions: respelled, letters: letters, rank: { frequencyRank(of: $0) }) ?? word
      // A correctly typed lowercase German noun is capitalised (`haus` → `Haus`).
      let final = nounCased(pick)
      // Flags only: which dictionaries accept the word, never the word itself.
      log.info("Autocorrection skipped: whole word not flagged as misspelled in every dictionary (germanKnows=\(self.germanDictionary.map { self.isKnown(word, in: $0) } ?? false, privacy: .public) respellings=\(respelled.count, privacy: .public) capitalised=\(final != final.lowercased() && word == word.lowercased(), privacy: .public) corrects=\(final != word, privacy: .public))")
      return final != word ? [final] : []
    }
    var suggestions: [String] = []
    for dictionary in dictionaries {
      for candidate in checker.guesses(forWordRange: range, in: word, language: dictionary) ?? []
      where !suggestions.contains(candidate) && isKnown(candidate, in: dictionary) {
        suggestions.append(candidate)
      }
    }
    // UITextChecker doesn't always propose swaps or missing/extra letters (`kalppt` →
    // `klappt`), and rarely words several neighbouring-key slips away (`njxbt` → `nicht`), so
    // try those variants against the dictionaries too: single edits first, then every level of
    // slips, since a common word with more slips can beat a rare one with fewer. The space
    // press waits for this, so it stops at a deadline; a level cut short is dropped.
    var timedOut = false
    let deadline = DispatchTime.now().uptimeNanoseconds + Self.slipSearchNanoseconds
    let stop: () -> Bool = {
      if DispatchTime.now().uptimeNanoseconds >= deadline { timedOut = true }
      return timedOut
    }
    // A lowercase variant also counts when German knows it capitalised (a noun: `hsus` → `haus`
    // → `Haus`); `caseFixed` then gives it its capital.
    let known: (String) -> Bool = { variant in
      dictionaries.contains { self.isKnown(variant, in: $0) }
        || self.germanDictionary.map { self.isKnown(KeyboardCorrectionRules.capitalized(variant), in: $0) } == true
    }
    let caseFixed: (String) -> String = { variant in
      guard let german = self.germanDictionary,
            !dictionaries.contains(where: { self.isKnown(variant, in: $0) }) else { return variant }
      let noun = KeyboardCorrectionRules.capitalized(variant)
      return self.isKnown(noun, in: german) ? noun : variant
    }
    // German spelled with ae/oe/ue/ss (`schoen`, `Strasse`); only when ä/ö/ü/ß can be typed
    // in the selected languages, and before anything slower.
    let respellings = germanDictionary.map { german in
      KeyboardCorrectionRules.transcriptions(of: word).compactMap { germanSpelling(of: $0.word, in: german) }
    } ?? []
    let edits = KeyboardCorrectionRules.singleEditCandidates(
      for: word, letters: letters, shouldStop: stop, isKnown: known)
    let slips = timedOut ? [] : KeyboardCorrectionRules.neighborSlipCandidates(
      for: word, maxSlips: KeyboardCorrectionRules.maxNeighborSlips(forLength: word.count),
      shouldStop: stop, isKnown: known)
    var generated = 0
    // The typed word itself, when German only knows it capitalised (`haus` → `Haus`).
    let ownCapital = germanDictionary.map { german -> [String] in
      let noun = KeyboardCorrectionRules.capitalized(word)
      return noun != word && isKnown(noun, in: german) ? [noun] : []
    } ?? []
    for candidate in ownCapital + respellings + (edits + slips).map(caseFixed)
    where !suggestions.contains(candidate) {
      suggestions.append(candidate)
      generated += 1
    }
    // For a lowercase word, a capitalised proposal (Apple's, or a respelled noun) doesn't count
    // when a selected dictionary also lists the word in lowercase (a sentence-start form, or
    // `Essen` for `essen`).
    if word == word.lowercased() {
      suggestions = suggestions.filter { $0 == $0.lowercased() || !listsLowercase($0.lowercased()) }
    }
    let pick = KeyboardCorrectionRules.replacement(
      for: word, suggestions: suggestions, letters: letters, rank: { frequencyRank(of: $0) })
    // The correction takes the noun's capital when it is one (`strasse` → `Straße`).
    let final = pick.map(nounCased)
    // Only control-flow metadata, never the original, proposals or surrounding text.
    log.info("Autocorrection proposals: dictionaries=\(dictionaries.count, privacy: .public) dictionaryCount=\(suggestions.count, privacy: .public) neighborSlips=\(generated, privacy: .public) slipSearchTimedOut=\(timedOut, privacy: .public) capitalised=\(final.map { $0 != $0.lowercased() } == true && word == word.lowercased(), privacy: .public) corrects=\(final != nil, privacy: .public)")
    return final.map { [$0] } ?? []
  }

  /// Whether any selected dictionary's completions list `word` exactly in lowercase.
  private func listsLowercase(_ word: String) -> Bool {
    let range = NSRange(word.startIndex..<word.endIndex, in: word)
    return dictionaries.contains { dictionary in
      (checker.completions(forPartialWordRange: range, in: word, language: dictionary) ?? []).contains(word)
    }
  }

  /// A lowercase word written the way German writes it: capitalised when it is a German noun,
  /// i.e. the German dictionary's completions list it only capitalised and no selected
  /// dictionary lists it in lowercase (so `essen`/`Essen`, `morgen` and English `hand` stay).
  /// Only German is capitalised; anything else, or a word typed capitalised, is returned as is.
  func nounCased(_ word: String) -> String {
    guard let germanDictionary, word == word.lowercased() else { return word }
    let noun = KeyboardCorrectionRules.capitalized(word)
    guard noun != word else { return word }
    let range = NSRange(word.startIndex..<word.endIndex, in: word)
    var germanNoun = false
    for dictionary in dictionaries {
      let completions = checker.completions(forPartialWordRange: range, in: word, language: dictionary) ?? []
      if completions.contains(word) { return word }
      if dictionary == germanDictionary && completions.contains(noun) { germanNoun = true }
    }
    return germanNoun ? noun : word
  }
}
