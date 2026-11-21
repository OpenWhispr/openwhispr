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

    // Over-correction: type every sentence as written and count the words that change.
    var changed = 0, words = 0
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
          if verbose { print("  over  \(before) → \(after)") }
        }
      } else {
        changed += abs(original.count - produced.count) + zip(original, produced).filter { $0 != $1 }.count
      }
    }
    print("over-correction \(language) \(environment.split): \(percent(changed, words)) of words changed (\(changed)/\(words))")
    print(String(format: "autocorrect bench took %.1f s", Date().timeIntervalSince(started)))
  }
}
