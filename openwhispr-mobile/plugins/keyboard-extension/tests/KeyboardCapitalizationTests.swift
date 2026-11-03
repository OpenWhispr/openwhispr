import Foundation

@main
enum KeyboardCapitalizationTests {
  private static var failures = 0

  private static func expect<T: Equatable>(_ actual: T, _ expected: T, _ name: String, line: Int = #line) {
    guard actual != expected else { return }
    failures += 1
    print("FAIL \(name) [line \(line)]: got \(actual), expected \(expected)")
  }

  static func main() {
    testAutoCapitalization()
    print(failures == 0 ? "PASS" : "\(failures) failure(s)")
    exit(failures == 0 ? 0 : 1)
  }

  static func testAutoCapitalization() {
    let sentences: [(String?, Bool)] = [
      (nil, true), ("", true), ("Hi", false), ("Hi ", false), ("Hi, ", false), ("Hi.", false), ("Hi. ", true),
      ("Hi!  ", true), ("Hi?", false), ("Hi\n", true), ("e.g.", false), ("github.", false), ("Hi\n ", true),
    ]
    for (context, expected) in sentences {
      expect(AutoCapitalization.sentences.capitalizesNext(after: context), expected, "sentences(\(String(describing: context)))")
    }
    let words: [(String?, Bool)] = [(nil, true), ("", true), ("Mary", false), ("Mary ", true), ("Mary\n", true), ("Mary-", false)]
    for (context, expected) in words {
      expect(AutoCapitalization.words.capitalizesNext(after: context), expected, "words(\(String(describing: context)))")
    }
    for context in [nil, "", "Hi. ", "a"] as [String?] {
      expect(AutoCapitalization.none.capitalizesNext(after: context), false, "none(\(String(describing: context)))")
      expect(AutoCapitalization.allCharacters.capitalizesNext(after: context), true, "allCharacters(\(String(describing: context)))")
    }
  }
}
