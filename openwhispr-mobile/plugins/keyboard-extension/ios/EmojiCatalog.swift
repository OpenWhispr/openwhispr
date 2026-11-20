import Foundation

/// The emoji panel's tabs, in Apple's order.
enum EmojiCategoryID: String, CaseIterable {
  case smileys, animals, food, activity, travel, objects, symbols, flags

  func title(language: TypingLanguage) -> String {
    switch (self, language) {
    case (.smileys, .english): return "Smileys & People"
    case (.animals, .english): return "Animals & Nature"
    case (.food, .english): return "Food & Drink"
    case (.activity, .english): return "Activity"
    case (.travel, .english): return "Travel & Places"
    case (.objects, .english): return "Objects"
    case (.symbols, .english): return "Symbols"
    case (.flags, .english): return "Flags"
    case (.smileys, .german): return "Smileys & Personen"
    case (.animals, .german): return "Tiere & Natur"
    case (.food, .german): return "Essen & Trinken"
    case (.activity, .german): return "Aktivität"
    case (.travel, .german): return "Reisen & Orte"
    case (.objects, .german): return "Objekte"
    case (.symbols, .german): return "Symbole"
    case (.flags, .german): return "Flaggen"
    }
  }
}

/// One emoji of the catalog, without a skin tone. `index` is its place in keyboard order across
/// all categories, which is also its line in the resource's per-emoji sections.
struct Emoji: Equatable {
  let string: String
  let index: Int
  /// Whether the catalog lists skin tones for it; `EmojiCatalog.variants(of:)` has the ones
  /// this system can draw.
  let hasSkinTones: Bool
  /// The Emoji version times ten, the highest of the emoji and its tones.
  fileprivate let version: Int
}

struct EmojiCategory {
  let id: EmojiCategoryID
  let emoji: [Emoji]
}

/// The bundled emoji list: categories, skin tones, names and search, read from the file
/// tools/build-emoji.py writes (which documents the layout). The file is mapped, and only the
/// category lists (about 100 KB) are ever turned into Swift values, on first use; names, search
/// text and the word table are read in place.
final class EmojiCatalog {
  private let data: NSData
  private let sections: [String: Range<Int>]
  private let isDrawable: (String) -> Bool
  private var drawable: [String: Bool] = [:]
  private var lineStarts: [String: [Int]] = [:]
  private var words: [TypingLanguage: [String: Int]] = [:]
  private var skeletons: [String: Int]?

  /// Every emoji the system has drawn since this Emoji version needs no check: the keyboard's
  /// deployment target (iOS 15.1) draws all of Emoji 13.1.
  private static let alwaysDrawableVersion = 131

  /// `isDrawable` says whether the running system can draw an emoji (`EmojiDrawability.canDraw`
  /// on the keyboard); the catalog asks once per emoji and leaves out the ones it can't.
  init?(url: URL, isDrawable: @escaping (String) -> Bool = { _ in true }) {
    guard let data = try? NSData(contentsOf: url, options: .alwaysMapped) else { return nil }
    let bytes = UnsafeBufferPointer(start: data.bytes.assumingMemoryBound(to: UInt8.self), count: data.length)
    guard let headerEnd = bytes.firstIndex(of: 0x0A) else { return nil }
    let header = String(decoding: bytes[..<headerEnd], as: UTF8.self).split(separator: "\t")
    guard header.first == "OWEM1" else { return nil }
    var sections: [String: Range<Int>] = [:]
    var offset = headerEnd + 1
    for entry in header.dropFirst() {
      guard let colon = entry.lastIndex(of: ":"), let length = Int(entry[entry.index(after: colon)...]),
        length >= 0, offset + length <= data.length
      else { return nil }
      sections[String(entry[..<colon])] = offset..<(offset + length)
      offset += length
    }
    self.data = data
    self.sections = sections
    self.isDrawable = isDrawable
  }

  // MARK: Categories

  private struct Loaded {
    var all: [Emoji] = []
    var ranges: [EmojiCategoryID: Range<Int>] = [:]
    var tones: [Int: [String]] = [:]
  }

  private lazy var loaded: Loaded = {
    var loaded = Loaded()
    for id in EmojiCategoryID.allCases {
      let start = loaded.all.count
      for line in text(of: "cat:\(id.rawValue)").split(separator: "\n") {
        let fields = line.split(separator: " ")
        guard fields.count >= 2, let version = Int(fields[0]) else { continue }
        let index = loaded.all.count
        if fields.count > 2 { loaded.tones[index] = fields[2...].map(String.init) }
        loaded.all.append(
          Emoji(string: String(fields[1]), index: index, hasSkinTones: fields.count > 2, version: version)
        )
      }
      loaded.ranges[id] = start..<loaded.all.count
    }
    return loaded
  }()

  /// The categories with the emoji this system can draw, in keyboard order.
  private(set) lazy var categories: [EmojiCategory] = EmojiCategoryID.allCases.map { id in
    let range = loaded.ranges[id] ?? 0..<0
    return EmojiCategory(id: id, emoji: loaded.all[range].filter { canDraw($0) })
  }

  /// The skin tones of an emoji, light to dark; empty when it has none or the system can't
  /// draw them all.
  func variants(of emoji: Emoji) -> [String] {
    guard let tones = loaded.tones[emoji.index], tones.allSatisfy(canDraw) else { return [] }
    return tones
  }

  /// The catalog's emoji for a string that may carry a skin tone ("👍🏽" → 👍).
  func emoji(matching string: String) -> Emoji? {
    if skeletons == nil {
      var table: [String: Int] = [:]
      for emoji in loaded.all { table[EmojiCatalog.skeleton(emoji.string)] = emoji.index }
      skeletons = table
    }
    return skeletons?[EmojiCatalog.skeleton(string)].map { loaded.all[$0] }
  }

  /// Whether the system can draw this string, asked once.
  func canDraw(_ string: String) -> Bool {
    if let known = drawable[string] { return known }
    let verdict = isDrawable(string)
    drawable[string] = verdict
    return verdict
  }

  private func canDraw(_ emoji: Emoji) -> Bool {
    // A version covers the tones too, so an old emoji with newer tones is still checked itself.
    emoji.version <= EmojiCatalog.alwaysDrawableVersion || canDraw(emoji.string)
  }

  /// An emoji without skin tones and variation selectors.
  private static func skeleton(_ string: String) -> String {
    var scalars = String.UnicodeScalarView()
    for scalar in string.unicodeScalars where scalar.value != 0xFE0F && !(0x1F3FB...0x1F3FF).contains(scalar.value) {
      scalars.append(scalar)
    }
    return String(scalars)
  }

  // MARK: Names and search

  /// The emoji's CLDR name ("grinning face", "grinsendes Gesicht"), for VoiceOver.
  func name(of emoji: Emoji, language: TypingLanguage) -> String {
    let section = "names:\(language.rawValue)"
    return line(emoji.index, of: section).map { String(decoding: bytes($0), as: UTF8.self) } ?? ""
  }

  /// Emoji whose name or keywords have a word starting with every word of the query, in the
  /// typing language, ignoring case and diacritics. Best first: the name itself, a name that
  /// starts with the query, a name that has the words, then keywords; keyboard order within each.
  func search(_ query: String, language: TypingLanguage, limit: Int) -> [Emoji] {
    let needles = EmojiCatalog.words(of: query).map { Array($0.utf8) }
    let section = "search:\(language.rawValue)"
    guard !needles.isEmpty, limit > 0, let whole = sections[section] else { return [] }
    let starts = starts(of: section)
    let joined = Array(needles.joined(separator: [0x20]))
    var matches: [(rank: Int, index: Int)] = []
    for (index, start) in starts.enumerated() where index < loaded.all.count {
      let end = (index + 1 < starts.count ? starts[index + 1] : whole.upperBound) - 1
      let line = bytes(start..<end)
      let tab = line.firstIndex(of: 0x09) ?? line.endIndex
      let name = line[..<tab]
      let rank: Int
      if name.elementsEqual(joined) {
        rank = 0
      } else if needles.allSatisfy({ EmojiCatalog.hasWord(name, startingWith: $0) }) {
        rank = name.starts(with: needles[0]) ? 1 : 2
      } else if needles.allSatisfy({ EmojiCatalog.hasWord(line, startingWith: $0) }) {
        rank = 3
      } else {
        continue
      }
      matches.append((rank, index))
    }
    matches.sort { ($0.rank, $0.index) < ($1.rank, $1.index) }
    var result: [Emoji] = []
    for match in matches {
      let emoji = loaded.all[match.index]
      guard canDraw(emoji) else { continue }
      result.append(emoji)
      if result.count == limit { break }
    }
    return result
  }

  /// The one emoji worth offering in the suggestion bar for a typed word ("pizza" → 🍕): the
  /// emoji named that word, a hand-picked one, or a country's flag. Nil for everything else,
  /// function words included; the table is decided in tools/build-emoji.py.
  func emoji(forWord word: String, language: TypingLanguage) -> Emoji? {
    if words[language] == nil {
      var table: [String: Int] = [:]
      for line in text(of: "words:\(language.rawValue)").split(separator: "\n") {
        let fields = line.split(separator: "\t")
        if fields.count == 2, let index = Int(fields[1]) { table[String(fields[0])] = index }
      }
      words[language] = table
    }
    guard let index = words[language]?[EmojiCatalog.wordKey(word)], loaded.all.indices.contains(index) else {
      return nil
    }
    let emoji = loaded.all[index]
    return canDraw(emoji) ? emoji : nil
  }

  /// Lower case, diacritics dropped, ß as ss. Must match `fold` in tools/build-emoji.py.
  static func fold(_ text: String) -> String {
    let decomposed = text.lowercased().replacingOccurrences(of: "ß", with: "ss").decomposedStringWithCanonicalMapping
    var scalars = String.UnicodeScalarView()
    for scalar in decomposed.unicodeScalars where scalar.properties.canonicalCombiningClass == .notReordered {
      scalars.append(scalar)
    }
    return String(scalars)
  }

  /// The folded words of a query: runs of letters and digits.
  static func words(of text: String) -> [String] {
    fold(text).unicodeScalars
      .split { !isWordScalar($0) }
      .map { String(String.UnicodeScalarView($0)) }
  }

  /// How the word table is keyed: lower case only, so "Bar" doesn't find the bear of "Bär".
  /// Must match `word_key` in tools/build-emoji.py.
  static func wordKey(_ word: String) -> String {
    word.trimmingCharacters(in: .whitespacesAndNewlines).lowercased().precomposedStringWithCanonicalMapping
  }

  private static func isWordScalar(_ scalar: Unicode.Scalar) -> Bool {
    switch scalar.properties.generalCategory {
    case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter,
      .decimalNumber, .letterNumber, .otherNumber:
      return true
    default:
      return false
    }
  }

  /// Whether a word of `text` (words are separated by spaces and the name's tab) starts with
  /// `prefix`.
  private static func hasWord(_ text: Slice<UnsafeBufferPointer<UInt8>>, startingWith prefix: [UInt8]) -> Bool {
    var index = text.startIndex
    let last = text.endIndex - prefix.count
    while index <= last {
      if index == text.startIndex || text[index - 1] == 0x20 || text[index - 1] == 0x09,
        text[index..<(index + prefix.count)].elementsEqual(prefix)
      {
        return true
      }
      index += 1
    }
    return false
  }

  // MARK: The mapped file

  private func bytes(_ range: Range<Int>) -> Slice<UnsafeBufferPointer<UInt8>> {
    UnsafeBufferPointer(start: data.bytes.assumingMemoryBound(to: UInt8.self), count: data.length)[range]
  }

  private func text(of section: String) -> String {
    sections[section].map { String(decoding: bytes($0), as: UTF8.self) } ?? ""
  }

  /// Where each line of a section starts, found once per section (8 bytes per emoji).
  private func starts(of section: String) -> [Int] {
    if let known = lineStarts[section] { return known }
    var starts: [Int] = []
    if let range = sections[section] {
      var start = range.lowerBound
      for (offset, byte) in bytes(range).enumerated() where byte == 0x0A {
        starts.append(start)
        start = range.lowerBound + offset + 1
      }
    }
    lineStarts[section] = starts
    return starts
  }

  private func line(_ index: Int, of section: String) -> Range<Int>? {
    let starts = starts(of: section)
    guard starts.indices.contains(index), let whole = sections[section] else { return nil }
    return starts[index]..<((index + 1 < starts.count ? starts[index + 1] : whole.upperBound) - 1)
  }
}

/// What the emoji panel remembers: the emoji used last and the skin tone picked per emoji.
/// Kept as JSON at `url` (a file in the App Group container), or only in memory without one.
/// A keyboard without Full Access can't write there; then it remembers for as long as it lives.
final class EmojiPreferences {
  static let maxRecents = 30

  private struct Stored: Codable {
    var recents: [String] = []
    var skinTones: [String: String] = [:]
  }

  private let url: URL?
  private var stored = Stored()

  init(url: URL?) {
    self.url = url
    if let url, let data = try? Data(contentsOf: url), let stored = try? JSONDecoder().decode(Stored.self, from: data) {
      self.stored = stored
      self.stored.recents = Array(stored.recents.prefix(EmojiPreferences.maxRecents))
    }
  }

  /// The emoji used last, as inserted (with their skin tone), most recent first.
  var recents: [String] { stored.recents }

  func recordUse(of emoji: String) {
    guard stored.recents.first != emoji else { return }
    stored.recents.removeAll { $0 == emoji }
    stored.recents.insert(emoji, at: 0)
    stored.recents = Array(stored.recents.prefix(EmojiPreferences.maxRecents))
    save()
  }

  /// The variant the user picked for an emoji, nil while they haven't (or picked the plain one).
  func skinTone(for emoji: Emoji) -> String? { stored.skinTones[emoji.string] }

  func setSkinTone(_ variant: String?, for emoji: Emoji) {
    let value = variant == emoji.string ? nil : variant
    guard stored.skinTones[emoji.string] != value else { return }
    stored.skinTones[emoji.string] = value
    save()
  }

  /// What a tap on the emoji inserts: the remembered skin tone, else the emoji itself.
  func preferred(for emoji: Emoji) -> String { skinTone(for: emoji) ?? emoji.string }

  private func save() {
    guard let url, let data = try? JSONEncoder().encode(stored) else { return }
    try? data.write(to: url, options: .atomic)
  }
}
