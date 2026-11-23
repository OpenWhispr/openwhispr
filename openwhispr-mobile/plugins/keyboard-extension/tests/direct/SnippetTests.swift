import Foundation

extension DirectDictationTests {
  private struct SnippetVector: Decodable {
    struct Entry: Decodable { let trigger: String; let replacement: String }
    let name: String
    let snippets: [Entry]
    let text: String
    let expected: String
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
      expect(SnippetExpander.expand(vector.text, snippets: snippets), vector.expected, "snippet vector \(vector.name)")
    }
  }
}
