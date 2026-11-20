import Foundation

/// The languages the keyboard types in. Separate from the dictation language.
enum TypingLanguage: String, CaseIterable {
  case english = "en"
  case german = "de"

  /// From the user's preferred languages: German when it comes before English, else English.
  static func preferred(from identifiers: [String] = Locale.preferredLanguages) -> TypingLanguage {
    for identifier in identifiers {
      let code = identifier.lowercased().prefix(2)
      if code == "de" { return .german }
      if code == "en" { return .english }
    }
    return .english
  }

  var defaultLayout: KeyLayoutKind { self == .german ? .qwertz : .qwerty }
}

enum KeyLayoutKind: String, CaseIterable {
  case qwerty
  case qwertz
}

/// The letter rows a language and layout draw. German has umlaut keys on either layout, as
/// Apple's German keyboards do; ß is typed by holding s.
enum KeyRows {
  static func letters(language: TypingLanguage, layout: KeyLayoutKind) -> [[Character]] {
    let top: [Character] = layout == .qwertz ? Array("qwertzuiop") : Array("qwertyuiop")
    let home: [Character] = Array("asdfghjkl")
    let bottom: [Character] = layout == .qwertz ? Array("yxcvbnm") : Array("zxcvbnm")
    switch language {
    case .english: return [top, home, bottom]
    case .german: return [top + ["ü"], home + ["ö", "ä"], bottom]
    }
  }

  /// What holding a key offers, the key's own letter left out. The first entry is what a
  /// plain hold-and-release picks on Apple's keyboard when it differs from the key.
  static func accents(for letter: Character, language: TypingLanguage) -> [Character] {
    let table: [Character: String]
    switch language {
    case .english:
      table = [
        "a": "àáâäæãåā", "c": "çćč", "e": "èéêëēėę", "i": "îïíīįì", "l": "ł", "n": "ñń",
        "o": "ôöòóœøōõ", "s": "ßśš", "u": "ûüùúū", "y": "ÿ", "z": "žźż",
      ]
    case .german:
      table = [
        "a": "àáâæãåā", "c": "çćč", "e": "èéêëēėę", "i": "îïíīįì", "l": "ł", "n": "ñń",
        "o": "ôòóœøōõ", "s": "ßśš", "u": "ûùúū", "y": "ÿ", "z": "žźż",
      ]
    }
    return Array(table[letter] ?? "")
  }
}

/// Where the letter keys are, in points. The engines read only this, so they work the same
/// on the real keyboard (centres taken from the laid-out keys) and in the benchmarks
/// (nominal centres).
struct KeyGeometry {
  /// Key centres by lower-case letter.
  let centres: [Character: CGPoint]
  /// Distance between neighbouring key centres in a row.
  let pitch: CGFloat
  /// A key's drawn size.
  let keySize: CGSize
  /// Distance between row centres.
  let rowPitch: CGFloat

  init(centres: [Character: CGPoint], pitch: CGFloat, keySize: CGSize, rowPitch: CGFloat) {
    self.centres = centres
    self.pitch = pitch
    self.keySize = keySize
    self.rowPitch = rowPitch
    var codes: [UInt16: CGPoint] = [:]
    for (letter, centre) in centres {
      if let code = String(letter).utf16.first { codes[code] = centre }
    }
    centresByCode = codes
  }

  let centresByCode: [UInt16: CGPoint]

  /// The keyboard's portrait geometry at `width` points: Apple's 6 pt gaps, rows centred.
  static func nominal(
    language: TypingLanguage, layout: KeyLayoutKind, width: CGFloat = 402,
    keyHeight: CGFloat = 43, rowGap: CGFloat = 11
  ) -> KeyGeometry {
    let rows = KeyRows.letters(language: language, layout: layout)
    let widest = rows.map(\.count).max() ?? 10
    let gap: CGFloat = widest > 10 ? 5 : 6
    let margin: CGFloat = widest > 10 ? 3 : 6.5
    let keyWidth = (width - 2 * margin - CGFloat(widest - 1) * gap) / CGFloat(widest)
    let pitch = keyWidth + gap
    var centres: [Character: CGPoint] = [:]
    for (rowIndex, row) in rows.enumerated() {
      let rowWidth = CGFloat(row.count) * pitch - gap
      let start = (width - rowWidth) / 2
      for (index, letter) in row.enumerated() {
        centres[letter] = CGPoint(
          x: start + CGFloat(index) * pitch + keyWidth / 2,
          y: CGFloat(rowIndex) * (keyHeight + rowGap) + keyHeight / 2
        )
      }
    }
    return KeyGeometry(
      centres: centres, pitch: pitch, keySize: CGSize(width: keyWidth, height: keyHeight),
      rowPitch: keyHeight + rowGap
    )
  }

  /// The key a letter is typed on: itself, or the key it is an accent of (ß is on s).
  static func baseKey(_ code: UInt16) -> UInt16 {
    switch code {
    case 0xDF: return 0x73  // ß → s
    default: return code
    }
  }

  func centre(_ code: UInt16) -> CGPoint? {
    centresByCode[code] ?? centresByCode[KeyGeometry.baseKey(code)] ?? centresByCode[KeyGeometry.unaccented(code)]
  }

  /// ä → a and so on, for layouts without that key.
  static func unaccented(_ code: UInt16) -> UInt16 {
    switch code {
    case 0xE4: return 0x61
    case 0xF6: return 0x6F
    case 0xFC: return 0x75
    case 0xDF: return 0x73
    default: return code
    }
  }

  /// Keys that touch: beside each other in a row, or overlapping in the row above or below.
  func areNeighbours(_ a: UInt16, _ b: UInt16) -> Bool {
    guard let first = centre(a), let second = centre(b) else { return false }
    let dx = abs(Double(first.x - second.x)) / Double(pitch)
    let dy = abs(Double(first.y - second.y)) / Double(rowPitch)
    if dy < 0.5 { return dx > 0.01 && dx <= 1.1 }
    return dy <= 1.1 && dx <= 0.8
  }

  /// Distance between two letters' keys in key pitches; nil when either has no key.
  func distance(_ a: UInt16, _ b: UInt16) -> Double? {
    guard let first = centre(a), let second = centre(b) else { return nil }
    let dx = Double(first.x - second.x), dy = Double(first.y - second.y)
    return (dx * dx + dy * dy).squareRoot() / Double(pitch)
  }
}
