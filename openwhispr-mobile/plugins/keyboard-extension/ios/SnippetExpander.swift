import Foundation

/// The app's `expandSnippets` (`src/lib/snippets.ts`), for dictations the keyboard finishes
/// itself: each spoken trigger is replaced with its saved text, matched case-insensitively on
/// word boundaries, longest trigger first, and the variables in that saved text are filled.
/// `tests/fixtures/snippet-vectors.json` holds cases generated from the app's version; both test
/// suites run them.
enum SnippetExpander {
  // Whitespace, punctuation or symbol, as the app's BOUNDARY.
  private static let boundary = "[\\s\\p{P}\\p{S}]"

  // The app's placeholder pattern: ASCII names, case-sensitive, no spaces inside the braces.
  // A fixed pattern, so it always compiles.
  private static let placeholder = try! NSRegularExpression(pattern: "\\{\\{([A-Za-z][A-Za-z0-9_]*)\\}\\}")

  /// `now` is read once per call, so two stamps in one dictation agree, as in the app.
  static func expand(
    _ text: String,
    snippets: [DirectDictationConfig.Snippet],
    now: Date = Date(),
    locale: Locale = .current
  ) -> String {
    guard !text.isEmpty, !snippets.isEmpty else { return text }

    var replacements: [String: String] = [:]
    var order: [String] = []
    for snippet in snippets {
      let key = snippet.trigger.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
      guard !key.isEmpty else { continue }
      if replacements[key] == nil { order.append(key) }
      replacements[key] = snippet.replacement
    }
    guard !replacements.isEmpty else { return text }

    // Longest first (UTF-16 length, as JavaScript measures it) so "investor ask" beats "ask".
    let alternatives = order
      .enumerated()
      .sorted { lhs, rhs in
        let (left, right) = (lhs.element.utf16.count, rhs.element.utf16.count)
        return left != right ? left > right : lhs.offset < rhs.offset
      }
      .map { NSRegularExpression.escapedPattern(for: $0.element) }
    let pattern = "(^|\(boundary))(?:\(alternatives.joined(separator: "|")))(?=$|\(boundary))"
    guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
      return text
    }

    let source = text as NSString
    let result = NSMutableString(string: source)
    let matches = regex.matches(in: text, range: NSRange(location: 0, length: source.length))
    // Splice from the end so earlier ranges stay valid. Never a replacement template, which
    // would read `$` and `\` in the user's saved text as references.
    for match in matches.reversed() {
      let lead = source.substring(with: match.range(at: 1))
      let leadLength = (lead as NSString).length
      let triggerRange = NSRange(location: match.range.location + leadLength, length: match.range.length - leadLength)
      let trigger = source.substring(with: triggerRange).lowercased()
      guard let replacement = replacements[trigger] else { continue }
      // Only the saved text is filled: a `{{date}}` the user dictated stays as spoken.
      result.replaceCharacters(in: match.range, with: lead + resolveVariables(replacement, now: now, locale: locale))
    }
    return result as String
  }

  /// The app's `resolveSnippetVariables`: fills `{{date}}`, `{{time}}`, `{{datetime}}` and
  /// `{{locale}}` in a snippet's saved text. Any other `{{…}}` stays as typed, and there is no
  /// escape for these four. The app keeps the placeholders when its runtime can't format dates;
  /// Foundation always can, so nothing here falls back.
  static func resolveVariables(_ text: String, now: Date = Date(), locale: Locale = .current) -> String {
    guard text.contains("{{") else { return text }
    let source = text as NSString
    let result = NSMutableString(string: source)
    var values: [String: String]?
    for match in placeholder.matches(in: text, range: NSRange(location: 0, length: source.length)).reversed() {
      if values == nil { values = variableValues(now: now, locale: locale) }
      guard let value = values?[source.substring(with: match.range(at: 1))] else { continue }
      result.replaceCharacters(in: match.range, with: value)
    }
    return result as String
  }

  // The app asks Intl for a numeric year, two-digit month and day, and the locale's own hour
  // with two-digit minutes. Hermes formats those on iOS through these same localized
  // NSDateFormatter templates, so the keyboard prints what the app prints on the phone (Node,
  // in Jest, differs: `9:05` where Foundation pads to `09:05`, a plain space before AM).
  private static func variableValues(now: Date, locale: Locale) -> [String: String] {
    let formatter = DateFormatter()
    formatter.locale = locale
    func format(_ template: String) -> String {
      formatter.setLocalizedDateFormatFromTemplate(template)
      return formatter.string(from: now)
    }
    return [
      "date": format("yyyyMMdd"),
      "time": format("jmm"),
      "datetime": format("yyyyMMddjmm"),
      // A BCP 47 tag (`en-US`, never `en_US`), as Intl reports it.
      "locale": locale.identifier(.bcp47),
    ]
  }
}
