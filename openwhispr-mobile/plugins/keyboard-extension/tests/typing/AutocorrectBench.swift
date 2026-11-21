import Foundation

/// Criterion 4. The candidate generator is the bundled lexicon alone (no UITextChecker), so
/// the figures are the same on every machine.
enum AutocorrectBench {
  /// Types `word` after `context` and returns what stands in its place after a space.
  static func typed(_ word: String, after context: String, session: TypingSession) -> String {
    session.reset()
    var document = BenchDocument()
    session.noteInserted(context)
    document.text = context
    for character in word + " " {
      document.apply(session.insert(String(character)))
    }
    return String(document.text.dropFirst(context.count).dropLast())
  }

  /// The length of the longest run of words the two share in order.
  static func commonWords(_ a: [Substring], _ b: [Substring]) -> Int {
    var previous = [Int](repeating: 0, count: b.count + 1)
    for word in a {
      var current = [0]
      current.reserveCapacity(b.count + 1)
      for (index, other) in b.enumerated() {
        current.append(word == other ? previous[index] + 1 : max(previous[index + 1], current[index]))
      }
      previous = current
    }
    return previous[b.count]
  }

  static func run(_ environment: BenchEnvironment, verbose: Bool) {
    let corrector = environment.corrector()
    let session = TypingSession(corrector: corrector)
    session.policy = TypingFieldPolicy(autocorrects: true, suggests: false, learns: false)
    let language = environment.language.rawValue
    let layout = environment.layout.rawValue
    let started = Date()

    /// Whether the lexicon has the word as written: when it doesn't, no setting can produce it.
    func known(_ word: String) -> Bool {
      let ids = corrector.lexicon.ids(forKey: TypingLexicon.key(of: word))
      return ids.contains { corrector.lexicon.word($0) == word || corrector.lexicon.word($0) == word.lowercased() }
    }

    // Real misspellings, mid-sentence with no usable word before them.
    var right = 0, total = 0, unchanged = 0, missing = 0
    for line in environment.lines("misspellings.\(language).\(environment.split).tsv") {
      let fields = line.components(separatedBy: "\t")
      guard fields.count == 2 else { continue }
      let result = typed(fields[0], after: "1 ", session: session)
      total += 1
      let inLexicon = known(fields[1])
      if !inLexicon { missing += 1 }
      if result == fields[1] { right += 1 } else if verbose { print("  miss\(inLexicon ? "" : "-oov")  \(fields[0]) → \(result)  (want \(fields[1]))") }
      if result == fields[0] { unchanged += 1 }
    }
    print("misspellings \(language) \(environment.split): top-1 \(percent(right, total)) (\(right)/\(total)), left unchanged \(percent(unchanged, total)), correction not in the lexicon \(percent(missing, total))")

    // Near-miss typos, in their sentence.
    right = 0; total = 0; unchanged = 0; missing = 0
    for line in environment.lines("typos.\(language)-\(layout).\(environment.split).tsv") {
      let fields = line.components(separatedBy: "\t")
      guard fields.count == 3 else { continue }
      let context = fields[0].isEmpty ? "" : fields[0] + " "
      let result = typed(fields[1], after: context, session: session)
      total += 1
      let inLexicon = known(fields[2])
      if !inLexicon { missing += 1 }
      if result == fields[2] { right += 1 } else if verbose { print("  typo\(inLexicon ? "" : "-oov")  \(fields[0]) | \(fields[1]) → \(result)  (want \(fields[2]))") }
      if result == fields[1] { unchanged += 1 }
    }
    print("typos \(language)-\(layout) \(environment.split): top-1 \(percent(right, total)) (\(right)/\(total)), left unchanged \(percent(unchanged, total)), intended word not in the lexicon \(percent(missing, total))")

    // Over-correction: type every sentence as written and count the words that change. The
    // headline figure is strict: every changed word counts. Changes that only add a capital
    // ("i" → "I", "french" → "French") are also counted on their own, since the source text
    // is informal and a keyboard is meant to make them.
    var changed = 0, words = 0, caseOnly = 0, pronoun = 0
    for sentence in environment.lines("sentences.\(language).\(environment.split).txt") {
      session.reset()
      var document = BenchDocument()
      for character in sentence + " " {
        document.apply(session.insert(String(character)))
      }
      let original = sentence.split(separator: " ")
      let produced = document.text.split(separator: " ")
      words += original.count
      if original.count == produced.count {
        for (before, after) in zip(original, produced) where before != after {
          changed += 1
          if before.lowercased() == after.lowercased() {
            caseOnly += 1
            if before.lowercased().hasPrefix("i") && (before.count == 1 || before.dropFirst().first == "'" || before.dropFirst().first == "\u{2019}") { pronoun += 1 }
          }
          if verbose { print("  over  \(before) → \(after)") }
        }
      } else {
        // A word split in two (a missed space put back) or joined shifts every later word:
        // the words are lined up first, so it counts as the one word that changed.
        changed += original.count - commonWords(original, produced)
        if verbose { print("  over-split  \(sentence)\n           →  \(document.text)") }
      }
    }
    print("over-correction \(language) \(environment.split): \(percent(changed, words)) of words changed (\(changed)/\(words)); capitalisation only \(percent(caseOnly, words)) (\(caseOnly), of which the pronoun I \(pronoun)); other changes \(percent(changed - caseOnly, words)) (\(changed - caseOnly))")
    print(String(format: "autocorrect bench took %.1f s", Date().timeIntervalSince(started)))
  }
}
