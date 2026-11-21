import Foundation

extension TypingTests {
  /// EmojiCatalog and EmojiPreferences against the bundled ios/Resources/emoji.bin.
  static func runEmojiTests(plugin: URL) {
    let url = plugin.appendingPathComponent("ios/Resources/emoji.bin")
    guard let catalog = EmojiCatalog(url: url) else {
      check("emoji: the catalog opens", false)
      return
    }

    // Categories
    let categories = catalog.categories
    check("emoji: eight categories in Apple's order", categories.map(\.id) == EmojiCategoryID.allCases)
    check("emoji: every category has emoji", categories.allSatisfy { !$0.emoji.isEmpty })
    check("emoji: smileys start with 😀", categories.first?.emoji.first?.string == "😀")
    check("emoji: people are in the smileys tab", categories[0].emoji.contains { $0.string == "👍" })
    check("emoji: activity comes before travel", categories[3].emoji.contains { $0.string == "⚽" })
    let all = categories.flatMap(\.emoji)
    check("emoji: indexes follow keyboard order", all.map(\.index) == Array(0..<all.count))
    check("emoji: no skin tone is listed on its own", !all.contains { $0.string == "👍🏽" })
    check("emoji: no component is listed", !all.contains { $0.string == "🏻" || $0.string == "🦰" })

    // Skin tones
    func find(_ string: String) -> Emoji? { all.first { $0.string == string } }
    if let thumb = find("👍"), let grin = find("😀"), let holding = find("🧑‍🤝‍🧑") {
      check("emoji: thumbs up has five tones", catalog.variants(of: thumb) == ["👍🏻", "👍🏼", "👍🏽", "👍🏾", "👍🏿"])
      check("emoji: a face has no tones", !grin.hasSkinTones && catalog.variants(of: grin).isEmpty)
      check(
        "emoji: two people get the five same-tone variants",
        catalog.variants(of: holding) == ["🧑🏻‍🤝‍🧑🏻", "🧑🏼‍🤝‍🧑🏼", "🧑🏽‍🤝‍🧑🏽", "🧑🏾‍🤝‍🧑🏾", "🧑🏿‍🤝‍🧑🏿"]
      )
      check("emoji: a toned string finds its base", catalog.emoji(matching: "👍🏽") == thumb)
      check("emoji: a string without its selector finds its base", catalog.emoji(matching: "\u{2764}")?.string == "❤️")
      check("emoji: text finds nothing", catalog.emoji(matching: "a") == nil)
    } else {
      check("emoji: 👍, 😀 and 🧑‍🤝‍🧑 are in the catalog", false)
    }

    // Names
    if let pizza = find("🍕") {
      check("emoji: English name", catalog.name(of: pizza, language: .english) == "pizza")
      check("emoji: German name", catalog.name(of: pizza, language: .german) == "Pizza")
    }
    if let thumb = find("👍") {
      check("emoji: a toned emoji keeps its own name", catalog.name(of: thumb, language: .english) == "thumbs up")
    }
    if let last = all.last {
      check("emoji: the last emoji has a name", !catalog.name(of: last, language: .german).isEmpty)
    }

    // Search
    func search(_ query: String, _ language: TypingLanguage, limit: Int = 20) -> [String] {
      catalog.search(query, language: language, limit: limit).map(\.string)
    }
    check("emoji search: a name comes first", search("pizza", .english).first == "🍕")
    check("emoji search: a prefix matches", search("piz", .english).contains("🍕"))
    check("emoji search: case doesn't matter", search("PIZZA", .english).first == "🍕")
    check("emoji search: keywords match", search("pepperoni", .english).contains("🍕"))
    check("emoji search: words AND together", search("red heart", .english).first == "❤️")
    check("emoji search: word order doesn't matter", search("heart red", .english).contains("❤️"))
    check("emoji search: every word must match", !search("red pizza", .english).contains("🍕"))
    check("emoji search: the middle of a word doesn't match", !search("izza", .english).contains("🍕"))
    check("emoji search: German names", search("Hund", .german).contains("🐕"))
    check("emoji search: diacritics don't matter", search("Bar", .german).contains("🐻") && search("bär", .german).contains("🐻"))
    check("emoji search: ß is ss", search("fussball", .german).contains("⚽") && search("Fußball", .german).contains("⚽"))
    check("emoji search: the typing language only", !search("Hund", .english).contains("🐕"))
    check("emoji search: flags by country", search("germany", .english).contains("🇩🇪") && search("deutschland", .german).contains("🇩🇪"))
    check("emoji search: the limit holds", search("face", .english, limit: 5).count == 5)
    check("emoji search: an empty query finds nothing", search("  ", .english).isEmpty && search("", .german).isEmpty)
    check("emoji search: no match is empty", search("qqqq", .english).isEmpty)
    check("emoji search: tones aren't results", !search("thumbs up", .english).contains("👍🏽"))
    check("emoji search: a tone's name doesn't find the emoji", !search("dark skin", .english, limit: 500).contains("👍"))

    // The suggestion bar's emoji
    func offered(_ word: String, _ language: TypingLanguage) -> String? {
      catalog.emoji(forWord: word, language: language)?.string
    }
    check("emoji word: pizza", offered("pizza", .english) == "🍕" && offered("Pizza", .german) == "🍕")
    check("emoji word: dog and Hund", offered("dog", .english) == "🐶" && offered("Hund", .german) == "🐶")
    check("emoji word: heart and Herz", offered("heart", .english) == "❤️" && offered("Herz", .german) == "❤️")
    check("emoji word: fire and Feuer", offered("fire", .english) == "🔥" && offered("Feuer", .german) == "🔥")
    check("emoji word: upper case", offered("FIRE", .english) == "🔥")
    check("emoji word: a country's flag", offered("Germany", .english) == "🇩🇪" && offered("Deutschland", .german) == "🇩🇪")
    check("emoji word: Bär but not Bar", offered("Bär", .german) == "🐻" && offered("Bar", .german) == nil)
    for word in ["the", "and", "is", "a", "to", "you", "it", "up", "ok", "watch", "fly", "flag", "face", ""] {
      check("emoji word: nothing for \"\(word)\"", offered(word, .english) == nil)
    }
    for word in ["ich", "und", "der", "ist", "nicht", "mal", "Taste", "plus", "gut", "Flagge"] {
      check("emoji word: nothing for \"\(word)\"", offered(word, .german) == nil)
    }
    check("emoji word: the other language's word", offered("Feuer", .english) == nil && offered("fire", .german) == nil)
    check("emoji word: two words", offered("red heart", .english) == nil)

    // The drawable filter
    var asked: [String: Int] = [:]
    let limited = EmojiCatalog(url: url) { string in
      asked[string, default: 0] += 1
      return false
    }
    if let limited {
      let kept = limited.categories.flatMap(\.emoji)
      check("emoji filter: undrawable emoji are dropped", !kept.isEmpty && kept.count < all.count)
      check("emoji filter: old emoji aren't asked about", kept.contains { $0.string == "😀" } && asked["😀"] == nil)
      check("emoji filter: search leaves them out too", limited.search("face", language: .english, limit: 500).count < catalog.search("face", language: .english, limit: 500).count)
      check("emoji filter: undrawable tones mean no tones", kept.first { $0.string == "👍" }.map { limited.variants(of: $0).isEmpty } == true)
      _ = limited.canDraw("👍🏽")
      _ = limited.search("face", language: .english, limit: 500)
      check("emoji filter: each emoji is asked about once", asked.values.allSatisfy { $0 == 1 })
    }
    check("emoji: a missing file gives no catalog", EmojiCatalog(url: plugin.appendingPathComponent("ios/Resources/none.bin")) == nil)

    // Preferences
    let memory = EmojiPreferences(url: nil)
    for string in ["😀", "🍕", "😀"] { memory.recordUse(of: string) }
    check("emoji recents: most recent first, no repeats", memory.recents == ["😀", "🍕"])
    for value in 0..<40 { memory.recordUse(of: "e\(value)") }
    check("emoji recents: capped at thirty", memory.recents.count == EmojiPreferences.maxRecents && memory.recents.first == "e39")

    let file = FileManager.default.temporaryDirectory.appendingPathComponent("emoji-preferences-\(UUID().uuidString).json")
    defer { try? FileManager.default.removeItem(at: file) }
    if let thumb = find("👍") {
      let saved = EmojiPreferences(url: file)
      check("emoji tone: plain until one is picked", saved.preferred(for: thumb) == "👍" && saved.skinTone(for: thumb) == nil)
      saved.setSkinTone("👍🏽", for: thumb)
      saved.recordUse(of: "👍🏽")
      saved.recordUse(of: "🍕")
      check("emoji tone: the pick is what a tap inserts", saved.preferred(for: thumb) == "👍🏽")
      let reopened = EmojiPreferences(url: file)
      check("emoji preferences: recents survive a restart", reopened.recents == ["🍕", "👍🏽"])
      check("emoji preferences: the tone survives a restart", reopened.preferred(for: thumb) == "👍🏽")
      reopened.setSkinTone("👍", for: thumb)
      check("emoji tone: picking the plain one forgets the tone", EmojiPreferences(url: file).skinTone(for: thumb) == nil)
    }
    try? Data("not json".utf8).write(to: file)
    check("emoji preferences: a broken file starts empty", EmojiPreferences(url: file).recents.isEmpty)
  }
}
