import Foundation

/// Hit targets: every letter of the benchmark sentences is tapped at its key's centre plus
/// Gaussian noise of a quarter of a key width, and the wrong letters are counted with fixed
/// targets and with the dynamic ones. The taps are the same for both.
enum TargetsBench {
  static let seeds: [String: UInt64] = ["dev": 0x7A9_D0E5, "test": 0x7A9_7E57]

  struct Result {
    var taps = 0
    var fixedWrong = 0
    var dynamicWrong = 0
    /// Taps the fixed targets got right and the dynamic ones got wrong.
    var broken = 0
    var seconds = 0.0
    var slowest = 0.0
  }

  static func measure(_ environment: BenchEnvironment, model: HitTargetModel, verbose: Bool = false) -> Result {
    let lexicon = model.lexicon, geometry = model.geometry
    guard let seed = seeds[environment.split] else { fatalError("Expected a split: dev or test") }
    var generator = SeededGenerator(seed: seed)
    let noise = Double(geometry.keySize.width) / 4
    var result = Result()
    var prefix: [UInt16] = []
    prefix.reserveCapacity(32)

    for sentence in environment.lines("sentences.\(environment.language.rawValue).\(environment.split).txt") {
      var previousID: Int? = TypingLexicon.sentenceStart
      for token in sentence.split(separator: " ") {
        // nil: no word to go on, so the model is asked for its fixed targets.
        var context: [UInt16]? = []
        var wordPrevious = previousID
        prefix.removeAll(keepingCapacity: true)
        for character in token.lowercased() {
          let units = Array(String(character).utf16)
          if character == "'" || character == "\u{2019}" { continue }  // not part of a word's key
          guard character.isLetter, units.count == 1 else {
            // A new word starts after a hyphen or a quote, with nothing known before it;
            // after a digit ("3rd", "10am") what follows isn't a word at all.
            prefix.removeAll(keepingCapacity: true)
            context = character.isNumber ? nil : []
            wordPrevious = nil
            continue
          }
          let code = units[0]
          if let centre = geometry.centresByCode[code] {
            let point = CGPoint(
              x: Double(centre.x) + noise * generator.gaussian(),
              y: Double(centre.y) + noise * generator.gaussian()
            )
            let fixed = model.fixedLetter(at: point)
            let started = DispatchTime.now().uptimeNanoseconds
            let dynamic = model.letter(at: point, prefix: context == nil ? nil : prefix, previousID: wordPrevious)
            let took = Double(DispatchTime.now().uptimeNanoseconds - started) / 1e9
            result.seconds += took
            result.slowest = max(result.slowest, took)
            result.taps += 1
            if fixed != code { result.fixedWrong += 1 }
            if dynamic != code {
              result.dynamicWrong += 1
              if fixed == code {
                result.broken += 1
                if verbose {
                  let typed = dynamic.flatMap { UnicodeScalar($0) }.map { String(Character($0)) } ?? "?"
                  print("  broke  \(token): \(character) → \(typed)")
                }
              }
            }
          }
          prefix.append(code)
        }
        previousID = previous(after: token, lexicon: lexicon)
      }
    }
    return result
  }

  /// What the next word has before it: the token when it is a word, the start of a
  /// sentence after closing punctuation, otherwise nothing known.
  static func previous(after token: Substring, lexicon: TypingLexicon) -> Int? {
    if let last = token.last, ".!?".contains(last) { return TypingLexicon.sentenceStart }
    guard token.allSatisfy({ $0.isLetter || $0 == "'" || $0 == "\u{2019}" }) else { return nil }
    return lexicon.id(of: String(token))
  }

  static func run(_ environment: BenchEnvironment, verbose: Bool) {
    let model = HitTargetModel(lexicon: environment.lexicon(), geometry: environment.geometry())
    for (name, value) in environment.overrides { model.parameters.set(name, value) }
    let result = measure(environment, model: model, verbose: verbose)
    let reduction = result.fixedWrong == 0
      ? 0 : 100 * Double(result.fixedWrong - result.dynamicWrong) / Double(result.fixedWrong)
    print(
      "targets \(environment.language.rawValue)-\(environment.layout.rawValue) \(environment.split): "
        + "\(result.taps) taps, fixed \(percent(result.fixedWrong, result.taps)) wrong (\(result.fixedWrong)), "
        + "dynamic \(percent(result.dynamicWrong, result.taps)) wrong (\(result.dynamicWrong)), "
        + String(format: "reduction %.1f%%, ", reduction)
        + "\(result.broken) right taps made wrong, "
        + String(format: "%.2f µs per tap, slowest %.0f µs", 1e6 * result.seconds / Double(max(result.taps, 1)), 1e6 * result.slowest)
    )
  }
}
