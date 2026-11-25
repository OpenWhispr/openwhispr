import Foundation

@main
enum KeyboardOptionsMenuTests {
  private static var failures = 0

  private static func expect<T: Equatable>(_ actual: T, _ expected: T, _ name: String, line: Int = #line) {
    guard actual != expected else { return }
    failures += 1
    print("FAIL \(name) [line \(line)]: got \(actual), expected \(expected)")
  }

  static func main() {
    testDecoding()
    testEffectiveTarget()
    testSection()
    testRecentsAndBadge()
    print(failures == 0 ? "PASS" : "\(failures) failure(s)")
    exit(failures == 0 ? 0 : 1)
  }

  private static let langs = [
    TranslationLanguage(code: "es", label: "Spanish"),
    TranslationLanguage(code: "fr", label: "French"),
  ]

  static func testDecoding() {
    expect(KeyboardOptionsMenu.decodeLanguages(nil), [], "languages nil")
    expect(KeyboardOptionsMenu.decodeLanguages("not json"), [], "languages malformed")
    expect(KeyboardOptionsMenu.decodeLanguages(#"{"code":"es"}"#), [], "languages non-array")
    expect(KeyboardOptionsMenu.decodeLanguages(#"[{"code":"es","label":"Spanish"}]"#), [langs[0]], "languages valid")
    expect(KeyboardOptionsMenu.decodeRecents(nil), [], "recents nil")
    expect(KeyboardOptionsMenu.decodeRecents("nope"), [], "recents malformed")
    expect(KeyboardOptionsMenu.decodeRecents(#"{"a":1}"#), [], "recents non-array")
    expect(KeyboardOptionsMenu.decodeRecents(#"["es","fr"]"#), ["es", "fr"], "recents valid")
  }

  static func testEffectiveTarget() {
    expect(KeyboardOptionsMenu.effectiveTarget(stored: "th", languages: langs, applicable: true), nil, "unlisted")
    expect(KeyboardOptionsMenu.effectiveTarget(stored: "es", languages: langs, applicable: false), nil, "not applicable")
    expect(KeyboardOptionsMenu.effectiveTarget(stored: "es", languages: langs, applicable: true), "es", "listed")
    expect(KeyboardOptionsMenu.effectiveTarget(stored: nil, languages: langs, applicable: true), nil, "off")
    expect(KeyboardOptionsMenu.effectiveTarget(stored: "ES", languages: langs, applicable: true), nil, "exact match only")
  }

  static func testSection() {
    let section = KeyboardOptionsMenu.translateSection(stored: "es", languages: langs, recents: ["th", "fr"], applicable: true)
    expect(section.recents, [langs[1]], "recents drop codes not in the list")
    expect(section.selected, "es", "selected")
    expect(section.locked, false, "unlocked")
    expect(section.all, langs, "all")

    let locked = KeyboardOptionsMenu.translateSection(stored: "es", languages: langs, recents: [], applicable: false)
    expect(locked.locked, true, "locked")
    expect(locked.selected, nil, "locked has no selection")

    let many = (1...6).map { TranslationLanguage(code: "l\($0)", label: "L\($0)") }
    let capped = KeyboardOptionsMenu.translateSection(
      stored: nil, languages: many, recents: many.map(\.code), applicable: true)
    expect(capped.recents, Array(many.prefix(3)), "recents capped, order kept")
  }

  static func testRecentsAndBadge() {
    expect(KeyboardOptionsMenu.recentsAfterSelecting("fr", current: ["es", "fr", "de", "it"]), ["fr", "es", "de"], "recents move to front")
    expect(KeyboardOptionsMenu.recentsAfterSelecting("es", current: []), ["es"], "recents from empty")
    expect(KeyboardOptionsMenu.badge(for: "es"), "ES", "badge two letters")
    expect(KeyboardOptionsMenu.badge(for: "zh-CN"), "ZH", "badge region stripped")
    expect(KeyboardOptionsMenu.badge(for: "en-US"), "EN", "badge en")
    expect(KeyboardOptionsMenu.badge(for: nil), nil, "badge off")
  }
}
