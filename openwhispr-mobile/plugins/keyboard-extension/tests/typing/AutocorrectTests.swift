import Foundation

/// Unit tests for autocorrect: what a word becomes when a space follows it, typed through a
/// session against the bundled lexicon as the keyboard would.
extension TypingTests {
  static func runAutocorrectTests(plugin: URL) {
    runEnglishAutocorrectTests(BenchEnvironment(plugin: plugin, language: .english, layout: .qwerty, split: "dev"))
    runGermanAutocorrectTests(BenchEnvironment(plugin: plugin, language: .german, layout: .qwertz, split: "dev"))
  }

  /// `expect("teh", "the", after: "this is")` checks the correction; a word expected to stay
  /// is its own expectation.
  private static func checker(_ environment: BenchEnvironment) -> (String, String, String) -> Void {
    let session = TypingSession(corrector: environment.corrector())
    session.policy = TypingFieldPolicy(autocorrects: true, suggests: false, learns: false)
    let language = environment.language.rawValue
    return { word, expected, context in
      let result = AutocorrectBench.typed(word, after: context.isEmpty ? "" : context + " ", session: session)
      let label = word == expected ? "\"\(word)\" stays" : "\"\(word)\" → \"\(expected)\""
      check("\(language): \(label)\(context.isEmpty ? "" : " after \"\(context)\"")\(result == expected ? "" : " (got \"\(result)\")")", result == expected)
    }
  }

  private static func runEnglishAutocorrectTests(_ environment: BenchEnvironment) {
    let expect = checker(environment)
    // Slips and misspellings of unknown words.
    expect("teh", "the", "this is")
    expect("wierd", "weird", "that was")
    expect("definately", "definitely", "it is")
    expect("controled", "controlled", "it is")
    expect("Teh", "The", "")
    // Apostrophes: put in, never taken out, and a dangling one left alone.
    expect("dont", "don't", "I")
    expect("it'", "it'", "what")
    expect("don't", "don't", "I")
    // A word typed for another, where the word before makes it clear, and not otherwise.
    expect("form", "from", "far away")
    expect("form", "form", "fill in the")
    expect("jot", "not", "agree and")
    // The form the lexicon writes in lower case when the word was typed so.
    expect("deparment", "department", "the")
    expect("Deparment", "Department", "the State")
    // Names, capitals and regular forms the lexicon lacks stay.
    expect("Kowalczyk", "Kowalczyk", "ask Mr")
    expect("MSN", "MSN", "on")
    expect("TEH", "TEH", "this is")
    expect("shuttles", "shuttles", "the space")
    expect("Street", "Street", "on Main")
    expect("street", "street", "the")
    // …while a capitalised word a slip from a known one is mended.
    expect("Lodnon", "London", "flew to")
    expect("Hixden", "Hidden", "to")
  }

  private static func runGermanAutocorrectTests(_ environment: BenchEnvironment) {
    let expect = checker(environment)
    expect("fur", "für", "danke")
    expect("Leistungn", "Leistungen", "einige")
    expect("nciht", "nicht", "ich kann")
    // Nouns: a capital mid-sentence is no sign of a name.
    expect("Problel", "Problem", "ohne")
    // Compounds the lexicon lacks stand, and a slip in one part is mended.
    expect("Hundeschulbesitzer", "Hundeschulbesitzer", "der")
    expect("Wunschgewicht", "Wunschgewicht", "mein")
    expect("Musukhaus", "Musikhaus", "das")
    expect("Lebenstil", "Lebensstil", "der")
    // The old spelling is the user's to keep, and ü is not a slip for u.
    expect("daß", "daß", "sagte,")
    expect("schon", "schon", "ist")
    expect("Müller", "Müller", "Herr")
  }
}
