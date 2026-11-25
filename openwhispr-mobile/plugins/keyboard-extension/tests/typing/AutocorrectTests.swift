import Darwin
import Foundation

/// Unit tests for autocorrect: what a word becomes when a space follows it, typed through a
/// session against the bundled lexicon as the keyboard would.
extension TypingTests {
  static func runAutocorrectTests(plugin: URL) {
    runEnglishAutocorrectTests(BenchEnvironment(plugin: plugin, language: .english, layout: .qwerty, split: "dev"))
    runGermanAutocorrectTests(BenchEnvironment(plugin: plugin, language: .german, layout: .qwertz, split: "dev"))
    runDocumentAndLearningTests(plugin: plugin)
    runSessionTests(BenchEnvironment(plugin: plugin, language: .english, layout: .qwerty, split: "dev"))
    // The keyboard asks for the word list to be read ahead as it appears.
    for language in [TypingLanguage.english, .german] {
      let lexicon = BenchEnvironment(plugin: plugin, language: language, layout: .qwerty, split: "dev").lexicon()
      check("\(language.rawValue) lexicon accepts the read-ahead hint", lexicon.prefetch())
      check("\(language.rawValue) lexicon still answers after it", lexicon.id(of: language == .english ? "the" : "der") != nil)
    }
  }

  private static func runDocumentAndLearningTests(plugin: URL) {
    let resources = plugin.appendingPathComponent("ios/Resources")
    let storage = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    do {
      try FileManager.default.createDirectory(at: storage, withIntermediateDirectories: true)
      defer { try? FileManager.default.removeItem(at: storage) }
      func engine() -> TypingEngine {
        TypingEngine(language: .english, layout: .qwerty, resources: resources, storage: storage)!
      }
      let wordsFile = TypingEngine.learnedWordsURL(in: storage, language: .english)
      try JSONEncoder().encode(["form": 2]).write(to: wordsFile)
      let first = engine()
      for letter in "He went away form " { _ = first.session.insert(String(letter)) }
      check("legacy learned counts do not suppress dictionary corrections", first.session.tail == "He went away from ")
      first.session.reset()
      first.session.resync(before: "Teh")
      first.session.resync(before: "")
      check("clearing the document clears composing text", first.session.insert(" ") == TextEdit(insert: " "))
      first.session.resync(before: "Teh")
      first.session.resync(before: "Te")
      check("moving the cursor left one character updates the composing text", first.session.tail == "Te")
      let longPrefix = String(repeating: "Already here. ", count: 30)
      first.session.resync(before: longPrefix)
      for letter in "Teh " { _ = first.session.insert(String(letter)) }
      first.session.resync(before: longPrefix + "The ")
      check("a matching host report preserves undo in a long document", first.session.backspace()?.insert == "Teh ")
      first.session.reset()
      for letter in "He went away form " { _ = first.session.insert(String(letter)) }
      _ = first.session.backspace()
      let reopened = engine()
      for letter in "He went away form " { _ = reopened.session.insert(String(letter)) }
      check("reopening preserves a rejected real-word correction", reopened.session.tail == "He went away form ")
      first.clearLearnedWords(storage: storage)
      reopened.learnedWords.learn("newword")
      check("a retained writer cannot resurrect cleared words", engine().learnedWords.words == ["newword"])
      let descriptor = open(wordsFile.appendingPathExtension("lock").path, O_RDWR)
      guard descriptor >= 0 else {
        check("can exercise a contended learned-word file", false)
        return
      }
      defer { close(descriptor) }
      _ = flock(descriptor, LOCK_EX)
      let released = DispatchSemaphore(value: 0)
      DispatchQueue.global().asyncAfter(deadline: .now() + 0.6) {
        flock(descriptor, LOCK_UN)
        released.signal()
      }
      let start = ProcessInfo.processInfo.systemUptime
      reopened.learnedWords.learn("busy")
      check("a suspended writer cannot stall typing", ProcessInfo.processInfo.systemUptime - start < 0.4)
      check("a contended clear remains pending", !reopened.learnedWords.removeAll())
      released.wait()
      check("a pending clear succeeds once storage is available", reopened.learnedWords.removeAll() && engine().learnedWords.words.isEmpty)
    } catch {
      check("can prepare temporary learned-word storage", false)
    }
  }

  /// Whole lines typed through a session, key by key.
  private static func runSessionTests(_ environment: BenchEnvironment) {
    let session = TypingSession(corrector: environment.corrector())
    session.policy = TypingFieldPolicy(autocorrects: true, suggests: false, learns: false)
    func typed(_ text: String) -> String {
      session.reset()
      var document = BenchDocument()
      for character in text { document.apply(session.insert(String(character))) }
      return document.text
    }
    // A capital at the start: the writer uses capitals, so the keyboard supplies the rest.
    check("capitals are added for someone who uses them", typed("I think i like french food ") == "I think I like French food ")
    // Lower case at the start means shift was turned off there: capitals are left out.
    check("lower-case writers keep lower-case names but still get the pronoun", typed("i think i like french food ") == "I think I like french food ")
    check("lower-case writing still gets real corrections", typed("i think teh food is good ") == "I think the food is good ")
    check("a new sentence with a capital brings capitals back", typed("ok. Then i left ") == "ok. Then I left ")
    // A real word is not swapped for a commoner one a key-slip away without support from the
    // sentence, least of all a name.
    check("a name stays: Kim is not I'm", typed("My friend Kim is here ") == "My friend Kim is here ")
    check("a name at the start of a sentence stays", typed("Kim is here ") == "Kim is here ")
    check("context still fixes a real-word slip", typed("He went away form here ") == "He went away from here ")
    // Corrected, deleted and typed again the same way: it is kept.
    do {
      session.reset()
      var document = BenchDocument()
      for character in "I saw teh " { document.apply(session.insert(String(character))) }
      let corrected = document.text
      // Delete the corrected word and the space, then type the original again.
      for _ in 0..<4 {
        if let edit = session.backspace() { document.apply(edit) } else { document.text.removeLast() }
      }
      for character in "teh " { document.apply(session.insert(String(character))) }
      check("a word typed again after its correction is kept (\(corrected) → \(document.text))", corrected == "I saw the " && document.text.hasSuffix("teh "))
    }
    // A missed space is put back; the second word is never dropped.
    check("a missed space is put back", typed("I need help withthis now ") == "I need help with this now ")
    check("a missed space after a name is put back", typed("My friend Kimis here ") == "My friend Kim is here ")
    // A letter straight after the full stop: an address or abbreviation, not a sentence end.
    check("a correction before a full stop is undone when a letter follows", typed("I asked i.e. him ") .hasPrefix("I asked i.e."))
    check("an address keeps its lower case", typed("Mail kent.shoemaker now ").contains("kent.shoemaker"))
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
