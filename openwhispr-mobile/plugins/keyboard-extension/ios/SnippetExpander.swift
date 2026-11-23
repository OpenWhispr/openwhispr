import Foundation

/// The app's `expandSnippets` (`src/lib/snippets.ts`), for dictations the keyboard finishes
/// itself: each spoken trigger is replaced with its saved text, matched case-insensitively on
/// word boundaries, longest trigger first. `tests/fixtures/snippet-vectors.json` holds cases
/// generated from the app's version; both test suites run them.
enum SnippetExpander {
  // Whitespace, punctuation or symbol, as the app's BOUNDARY.
  private static let boundary = "[\\s\\p{P}\\p{S}]"

  static func expand(_ text: String, snippets: [DirectDictationConfig.Snippet]) -> String {
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
      result.replaceCharacters(in: match.range, with: lead + replacement)
    }
    return result as String
  }
}
