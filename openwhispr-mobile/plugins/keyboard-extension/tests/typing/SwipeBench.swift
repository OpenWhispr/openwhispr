import Foundation

extension SwipeParameters {
  /// For tuning runs: `name=value` on the command line.
  mutating func set(_ name: String, _ value: Double) {
    switch name {
    case "endRadius": endRadius = value
    case "shortestRatio": shortestRatio = value
    case "longestRatio": longestRatio = value
    case "lengthSlack": lengthSlack = value
    case "shapeWeight": shapeWeight = value
    case "offsetWeight": offsetWeight = value
    case "lengthEvidence": lengthEvidence = value
    case "farthest": farthest = value
    case "languageWeight": languageWeight = value
    case "cornerCut": cornerCut = value
    default: fatalError("Unknown parameter \(name)")
    }
  }
}

/// A finger's path across the keys of a word, as the swipe benchmark and tests draw it.
enum SwipeSimulator {
  /// The path for `word`, or nil when a letter has no key. Each key is aimed at with Gaussian
  /// noise (`noise` key widths, standard deviation), corners are cut, and the finger is
  /// sampled at 60–120 Hz while its speed varies by ±30%.
  static func path(
    for word: String, geometry: KeyGeometry, noise: Double = 0.2, generator: inout SeededGenerator
  ) -> [CGPoint]? {
    var aims: [CGPoint] = []
    var lastKey: CGPoint?
    for code in TypingLexicon.key(of: word) {
      guard let centre = geometry.centre(code) else { return nil }
      // A double letter is one stop on its key.
      if let lastKey, lastKey.x == centre.x, lastKey.y == centre.y { continue }
      lastKey = centre
      let spread = noise * Double(geometry.keySize.width)
      aims.append(CGPoint(
        x: Double(centre.x) + spread * generator.gaussian(), y: Double(centre.y) + spread * generator.gaussian()
      ))
    }
    guard !aims.isEmpty else { return nil }

    // The line the finger follows: straight between aims, each corner replaced by a curve
    // that starts and ends 10–40% of the shorter leg away from it.
    var line: [CGPoint] = [aims[0]]
    for index in aims.indices.dropFirst().dropLast() {
      let before = aims[index - 1], corner = aims[index], after = aims[index + 1]
      let inLength = distance(before, corner), outLength = distance(corner, after)
      let reach = (0.1 + 0.3 * generator.unit()) * min(inLength, outLength)
      guard inLength > 0, outLength > 0 else {
        line.append(corner)
        continue
      }
      let from = mix(corner, before, reach / inLength), to = mix(corner, after, reach / outLength)
      for step in 0...8 {
        let t = Double(step) / 8
        let a = (1 - t) * (1 - t), b = 2 * t * (1 - t), c = t * t
        line.append(CGPoint(
          x: a * Double(from.x) + b * Double(corner.x) + c * Double(to.x),
          y: a * Double(from.y) + b * Double(corner.y) + c * Double(to.y)
        ))
      }
    }
    if aims.count > 1 { line.append(aims[aims.count - 1]) }

    // Walk the line at about 25 keys a second, the speed swinging ±30% along the way.
    let interval = 1 / (60 + 60 * generator.unit())
    let baseSpeed = 25 * Double(geometry.pitch)
    let phase = 2 * Double.pi * generator.unit()
    let wavelength = (3 + 5 * generator.unit()) * Double(geometry.pitch)
    var samples: [CGPoint] = [line[0]]
    var segment = 1
    var along = 0.0  // Distance into the current segment.
    var travelled = 0.0
    while segment < line.count {
      var step = baseSpeed * (1 + 0.3 * sin(phase + 2 * .pi * travelled / wavelength)) * interval
      travelled += step
      while segment < line.count {
        let length = distance(line[segment - 1], line[segment])
        if along + step <= length {
          along += step
          samples.append(mix(line[segment - 1], line[segment], length > 0 ? along / length : 0))
          break
        }
        step -= length - along
        along = 0
        segment += 1
      }
    }
    // The finger lifts where the path ends, between two samples.
    if line.count > 1 { samples.append(line[line.count - 1]) }
    return samples
  }

  private static func distance(_ a: CGPoint, _ b: CGPoint) -> Double {
    let dx = Double(a.x - b.x), dy = Double(a.y - b.y)
    return (dx * dx + dy * dy).squareRoot()
  }

  private static func mix(_ a: CGPoint, _ b: CGPoint, _ t: Double) -> CGPoint {
    CGPoint(x: Double(a.x) + (Double(b.x) - Double(a.x)) * t, y: Double(a.y) + (Double(b.y) - Double(a.y)) * t)
  }
}

/// Swipes every word of the swipe list once and counts how often the decoder gets it back.
enum SwipeBench {
  /// Dev is for tuning, test for reporting; the word list is the same.
  static func seed(for split: String) -> UInt64 {
    switch split {
    case "dev": return 0x5EED_0001_D0E5_CAFE
    case "test": return 0x7E57_0002_BEEF_F00D
    default: fatalError("Expected dev or test, not \(split)")
    }
  }

  static func run(_ environment: BenchEnvironment, verbose: Bool) {
    let lexicon = environment.lexicon()
    let geometry = environment.geometry()
    let decoder = SwipeDecoder(lexicon: lexicon, geometry: geometry)
    for (name, value) in environment.overrides { decoder.parameters.set(name, value) }
    var generator = SeededGenerator(seed: seed(for: environment.split))
    // Both lists are lower-case ("john", "sie"), and capitals are the caller's job, so
    // results are compared without regard to case.

    var words = 0, top1 = 0, top3 = 0, missing = 0
    var weight = 0.0, weightedTop1 = 0.0, weightedTop3 = 0.0
    var times: [Double] = []
    for line in environment.lines("swipe-words.\(environment.language.rawValue).tsv") {
      let fields = line.split(separator: "\t")
      guard fields.count == 2, let count = Double(fields[1]) else { continue }
      let word = String(fields[0])
      words += 1
      weight += count
      // Drawn even for a word the lexicon lacks, so every word's path stays the same when
      // the lexicon changes.
      let path = SwipeSimulator.path(for: word, geometry: geometry, generator: &generator)
      let known = lexicon.ids(forKey: TypingLexicon.key(of: word)).contains { lexicon.word($0).lowercased() == word }
      guard known, let path else {
        missing += 1
        if verbose { print("MISSING \(word)") }
        continue
      }
      let started = DispatchTime.now().uptimeNanoseconds
      let decoded = decoder.decode(path: path, limit: 3)
      times.append(Double(DispatchTime.now().uptimeNanoseconds - started) / 1e6)
      let candidates = decoded.map { $0.lowercased() }
      if candidates.first == word {
        top1 += 1
        weightedTop1 += count
      }
      if candidates.contains(word) {
        top3 += 1
        weightedTop3 += count
      } else if verbose {
        print("MISS \(word) → \(candidates.joined(separator: " "))")
      }
      if verbose, candidates.first != word, candidates.contains(word) {
        print("SECOND \(word) → \(candidates.joined(separator: " "))")
      }
    }

    times.sort()
    let mean = times.reduce(0, +) / Double(max(times.count, 1))
    let p95 = times.isEmpty ? 0 : times[min(times.count - 1, Int(Double(times.count) * 0.95))]
    print("Swipe \(environment.language.rawValue)/\(environment.layout.rawValue) \(environment.split): \(words) words, \(missing) not in the lexicon (counted as failures)")
    print(String(format: "  weighted  top-1 %.2f%%  top-3 %.2f%%", 100 * weightedTop1 / weight, 100 * weightedTop3 / weight))
    print("  uniform   top-1 \(percent(top1, words))  top-3 \(percent(top3, words))")
    print(String(format: "  decode    mean %.2f ms  p95 %.2f ms  max %.2f ms", mean, p95, times.last ?? 0))
  }
}
