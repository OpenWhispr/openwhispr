import Foundation

extension DirectDictationTests {
  private struct SnippetVector: Decodable {
    struct Entry: Decodable { let trigger: String; let replacement: String }
    let name: String
    let snippets: [Entry]
    let text: String
    let expected: String
    /// [year, month, day, hour, minute] in local time, for a vector with variables.
    let now: [Int]?
    let locale: String?
  }

  /// A time in the local time zone, as the app's tests build one with `new Date(y, m - 1, d, h, min)`.
  private static func localTime(_ year: Int, _ month: Int, _ day: Int, _ hour: Int, _ minute: Int) -> Date {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = .current
    return calendar.date(from: DateComponents(year: year, month: month, day: day, hour: hour, minute: minute))!
  }

  /// The vectors' expected values come from the app's expandSnippets (Jest checks them too).
  static func testSnippets() {
    let url = fixtures.appendingPathComponent("snippet-vectors.json")
    guard let data = try? Data(contentsOf: url),
      let vectors = try? JSONDecoder().decode([SnippetVector].self, from: data)
    else {
      expect("unreadable", "readable", "snippet-vectors.json at \(url.path)")
      return
    }
    expect(vectors.count >= 13, true, "vector count")
    for vector in vectors {
      let snippets = vector.snippets.map { DirectDictationConfig.Snippet(trigger: $0.trigger, replacement: $0.replacement) }
      let now = vector.now.map { localTime($0[0], $0[1], $0[2], $0[3], $0[4]) } ?? Date()
      let locale = vector.locale.map { Locale(identifier: $0) } ?? .current
      expect(SnippetExpander.expand(vector.text, snippets: snippets, now: now, locale: locale), vector.expected, "snippet vector \(vector.name)")
    }
  }

  /// What Foundation prints for each variable. Only the date and `{{locale}}` in en-US are shared
  /// vectors: elsewhere Node, which runs the app's Jest suite, writes the time differently (an
  /// unpadded 24-hour hour, a plain space before AM) from Foundation, which Hermes uses on iOS.
  static func testSnippetVariables() {
    let morning = localTime(2026, 11, 18, 9, 5)
    let all = "{{date}} | {{time}} | {{datetime}} | {{locale}}"
    let formats: [(String, String)] = [
      ("en-US", "11/18/2026 | 9:05\u{202F}AM | 11/18/2026, 9:05\u{202F}AM | en-US"),
      ("en-GB", "18/11/2026 | 09:05 | 18/11/2026, 09:05 | en-GB"),
      ("de-DE", "18.11.2026 | 09:05 | 18.11.2026, 09:05 | de-DE"),
      ("ja-JP", "2026/11/18 | 9:05 | 2026/11/18 9:05 | ja-JP"),
    ]
    for (identifier, expected) in formats {
      let filled = SnippetExpander.resolveVariables(all, now: morning, locale: Locale(identifier: identifier))
      expect(filled, expected, "variables in \(identifier)")
    }
    expect(SnippetExpander.resolveVariables("{{locale}}", locale: Locale(identifier: "en_US")), "en-US", "locale as BCP 47")

    let usEnglish = Locale(identifier: "en-US")
    let literal = "{{clipboard}} {{Date}} {{ date }} {{constructor}} {{__proto__}} {date}"
    expect(SnippetExpander.resolveVariables(literal, now: morning, locale: usEnglish), literal, "unknown placeholders stay")

    let stamp = [DirectDictationConfig.Snippet(trigger: "stamp", replacement: "Logged {{date}} at {{time}}")]
    expect(
      SnippetExpander.expand("stamp, then put {{date}} in the template", snippets: stamp, now: morning, locale: usEnglish),
      "Logged 11/18/2026 at 9:05\u{202F}AM, then put {{date}} in the template",
      "variables filled only in the saved text"
    )
    expect(
      SnippetExpander.expand("put {{date}} in the template", snippets: stamp, now: morning, locale: usEnglish),
      "put {{date}} in the template",
      "dictated placeholder without a trigger"
    )

    let evening = localTime(2026, 11, 18, 21, 5)
    let clocks = [
      DirectDictationConfig.Snippet(trigger: "start", replacement: "{{time}}"),
      DirectDictationConfig.Snippet(trigger: "stamp", replacement: "{{datetime}}"),
    ]
    expect(
      SnippetExpander.expand("start, stamp, start", snippets: clocks, now: evening, locale: usEnglish),
      "9:05\u{202F}PM, 11/18/2026, 9:05\u{202F}PM, 9:05\u{202F}PM",
      "one clock for every snippet"
    )
  }
}
