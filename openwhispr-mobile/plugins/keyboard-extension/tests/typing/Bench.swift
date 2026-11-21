import Foundation

/// Shared by the benchmark commands: where the data is and how an engine is put together.
struct BenchEnvironment {
  let plugin: URL
  let language: TypingLanguage
  let layout: KeyLayoutKind
  let split: String
  var overrides: [String: Double] = [:]

  var benchmarks: URL { plugin.appendingPathComponent("tests/benchmarks") }

  func lexicon() -> TypingLexicon {
    let url = plugin.appendingPathComponent("ios/Resources/lexicon-\(language.rawValue).bin")
    guard let lexicon = TypingLexicon(url: url) else { fatalError("Can't read \(url.path)") }
    return lexicon
  }

  func geometry() -> KeyGeometry { KeyGeometry.nominal(language: language, layout: layout) }

  func corrector() -> Autocorrector {
    let corrector = Autocorrector(lexicon: lexicon(), language: language, geometry: geometry())
    for (name, value) in overrides { corrector.parameters.set(name, value) }
    return corrector
  }

  func lines(_ name: String) -> [String] {
    let url = benchmarks.appendingPathComponent(name)
    guard let text = try? String(contentsOf: url, encoding: .utf8) else { fatalError("Can't read \(url.path)") }
    return text.split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
  }
}

extension AutocorrectParameters {
  /// For tuning runs: `name=value` on the command line.
  mutating func set(_ name: String, _ value: Double) {
    switch name {
    case "adjacentSubstitution": adjacentSubstitution = value
    case "farSubstitution": farSubstitution = value
    case "vowelSubstitution": vowelSubstitution = value
    case "accentSubstitution": accentSubstitution = value
    case "transposition": transposition = value
    case "missedLetter": missedLetter = value
    case "missedDoubleLetter": missedDoubleLetter = value
    case "extraLetter": extraLetter = value
    case "extraNeighbour": extraNeighbour = value
    case "extraDoubleLetter": extraDoubleLetter = value
    case "inflectedCeiling": inflectedCeiling = value
    case "lowerCaseForCapitalised": lowerCaseForCapitalised = value
    case "capitalisedForLowerCase": capitalisedForLowerCase = value
    case "otherFormMargin": otherFormMargin = value
    case "compoundPenalty": compoundPenalty = value
    case "compoundWord": compoundWord = value
    case "firstLetterPenalty": firstLetterPenalty = value
    case "secondEditPenalty": secondEditPenalty = value
    case "unknownWord": unknownWord = value
    case "unknownName": unknownName = value
    case "unknownLengthPenalty": unknownLengthPenalty = value
    case "nameLengthPenalty": nameLengthPenalty = value
    case "inflectedPenalty": inflectedPenalty = value
    case "margin": margin = value
    case "realWordMargin": realWordMargin = value
    case "sameKeyMargin": sameKeyMargin = value
    case "completionPenalty": completionPenalty = value
    default: fatalError("Unknown parameter \(name)")
    }
  }
}

/// A document the session's edits are applied to, as the text field would.
struct BenchDocument {
  var text = ""
  mutating func apply(_ edit: TextEdit) {
    text.removeLast(min(edit.deleteCount, text.count))
    text += edit.insert
  }
}

/// SplitMix64: the same numbers on every machine, so simulated taps and swipes repeat.
struct SeededGenerator: RandomNumberGenerator {
  private var state: UInt64
  init(seed: UInt64) { state = seed }
  mutating func next() -> UInt64 {
    state &+= 0x9E37_79B9_7F4A_7C15
    var z = state
    z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
    z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
    return z ^ (z >> 31)
  }
  mutating func unit() -> Double { Double(next() >> 11) / Double(1 << 53) }
  /// Standard normal, Box–Muller.
  mutating func gaussian() -> Double {
    let u = max(unit(), 1e-12), v = unit()
    return (-2 * log(u)).squareRoot() * cos(2 * .pi * v)
  }
}

func percent(_ part: Int, _ whole: Int) -> String {
  whole == 0 ? "n/a" : String(format: "%.2f%%", 100 * Double(part) / Double(whole))
}
