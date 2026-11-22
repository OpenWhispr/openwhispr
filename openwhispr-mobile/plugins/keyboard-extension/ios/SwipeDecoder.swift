import Foundation

/// The weights of the swipe decoder. Distances are in key pitches, scores in log10 units.
struct SwipeParameters {
  /// How far the path's two ends may be from a word's first and last key.
  var endRadius = 1.25
  /// A word is considered when its ideal length is within these bounds of the path's:
  /// corner cutting makes the path shorter than the ideal one, wobble makes it longer.
  var shortestRatio = 0.6
  var longestRatio = 1.5
  var lengthSlack = 1.2
  /// Cost of the mean squared distance between path and word once both are laid over each
  /// other (their shapes), and of the offset between them (where the path was drawn).
  var shapeWeight = 9.0
  var offsetWeight = 5.0
  /// A longer path says more about its word: the fit counts 1 + this × the path's length
  /// times, so a long word isn't outvoted by a short common one that fits a little worse.
  /// Kept small: tuned on simulated paths it was 0.3, and real fingers then lost common
  /// words to rarer, longer ones of a similar shape ("message" → "meagre").
  var lengthEvidence = 0.1
  /// Paths further than this from a word (mean squared distance) are dropped unscored.
  var farthest = 1.1
  /// How much a word's frequency counts against how well it fits the path.
  /// Doubled after replaying swipes recorded on a phone: at 1.0 the right word was usually
  /// second to a rare word that fitted the wobble of a real path a little better
  /// ("nice" → "Noyce", "that" → "Thar").
  var languageWeight = 2.0
  /// Cost of the squared distance (in key pitches) between the path's two ends and the
  /// word's first and last keys. A swipe's ends are aimed at, unlike its middle, and they are
  /// what tells "hello" from "help" and "have" from "gave".
  var endWeight = 3.0
  /// How far a word's template cuts each corner, as a fraction of the shorter leg. Fingers
  /// round corners, so a template through the exact key centres fits long words badly.
  var cornerCut = 0.25
}

/// Turns a swipe across the letter keys into words (after SHARK2: Kristensson & Zhai 2004).
/// A word's template is the line through its keys' centres; path and template are resampled
/// to the same number of points and compared point by point, and the fit is weighed against
/// the word's probability. Not thread-safe: use it from one queue.
final class SwipeDecoder {
  var parameters = SwipeParameters()

  private let lexicon: TypingLexicon
  private let pitch: Float
  private let keyX: [Float]
  private let keyY: [Float]
  /// Key index by UTF-16 code, `noKey` for letters the layout can't type.
  private var keyByCode: [UInt16: UInt8] = [:]
  private static let noKey = UInt8.max

  /// One trie node that ends a word: the keys it passes through and their path's length.
  private struct Entry {
    let node: UInt32
    let keysStart: UInt32
    let length: Float
    let keyCount: UInt8
  }
  /// Entries by first and last key, shortest first, built per first key when a swipe first
  /// starts near it: templates for every word up front would cost memory the keyboard
  /// extension doesn't have.
  private var buckets: [Int: [Entry]] = [:]
  private var builtFirstKeys = Set<UInt8>()
  /// Every entry's keys, repeated letters collapsed ("hello" → h e l o).
  private var entryKeys: [UInt8] = []

  private static let sampleCount = 32
  private let pathSamples: UnsafeMutablePointer<Float>
  private let templateSamples: UnsafeMutablePointer<Float>
  private let corners: UnsafeMutablePointer<Float>
  private static let longestWord = 64
  /// Points a template has at most: each corner becomes a short curve.
  private static let curveSteps = 4
  private static let cornerCapacity = longestWord * (curveSteps + 1) + 2

  init(lexicon: TypingLexicon, geometry: KeyGeometry) {
    self.lexicon = lexicon
    pitch = Float(geometry.pitch)
    var xs: [Float] = [], ys: [Float] = []
    var indexByCentre: [String: UInt8] = [:]
    // Sorted so key indices don't depend on dictionary order.
    for (code, centre) in geometry.centresByCode.sorted(by: { $0.key < $1.key }) {
      indexByCentre["\(centre.x),\(centre.y)"] = UInt8(xs.count)
      keyByCode[code] = UInt8(xs.count)
      xs.append(Float(centre.x) / pitch)
      ys.append(Float(centre.y) / pitch)
    }
    // Letters typed on another letter's key (ß on s; ä on a where there's no ä key).
    for code: UInt16 in 0xC0...0x17F where keyByCode[code] == nil {
      if let centre = geometry.centre(code), let index = indexByCentre["\(centre.x),\(centre.y)"] {
        keyByCode[code] = index
      }
    }
    keyX = xs
    keyY = ys
    pathSamples = .allocate(capacity: 2 * SwipeDecoder.sampleCount)
    templateSamples = .allocate(capacity: 2 * SwipeDecoder.sampleCount)
    corners = .allocate(capacity: 2 * SwipeDecoder.cornerCapacity)
  }

  deinit {
    pathSamples.deallocate()
    templateSamples.deallocate()
    corners.deallocate()
  }

  /// Builds the index for every first key, so no swipe pays for it. Takes tens of
  /// milliseconds; meant for a background queue before the decoder is first used.
  func prepare() {
    for key in 0..<keyX.count { buildIndex(firstKey: UInt8(key)) }
  }

  /// The words a swipe most likely meant, best first, as the lexicon writes them; words that
  /// differ only in case come once. `path` is in the same coordinates as the geometry's key
  /// centres. Returns nothing for a path with no word near it, never loose letters.
  func decode(path: [CGPoint], previous: String? = nil, sentenceStart: Bool = false, limit: Int = 3) -> [String] {
    let previousID = sentenceStart ? TypingLexicon.sentenceStart : previous.flatMap { lexicon.id(of: $0) }
    return decode(path: path, previousID: previousID, limit: limit)
  }

  func decode(path: [CGPoint], previousID: Int?, limit: Int = 3) -> [String] {
    guard path.count >= 2, limit > 0, !keyX.isEmpty else { return [] }
    let count = min(path.count, 4096)
    var points = [Float](repeating: 0, count: 2 * count)
    for index in 0..<count {
      points[2 * index] = Float(path[index].x) / pitch
      points[2 * index + 1] = Float(path[index].y) / pitch
    }
    let pathLength = points.withUnsafeBufferPointer {
      SwipeDecoder.resample($0.baseAddress!, count: count, into: pathSamples)
    }

    let radius = Float(parameters.endRadius)
    let starts = keys(near: points[0], points[1], within: radius)
    let ends = keys(near: points[2 * count - 2], points[2 * count - 1], within: radius)
    let shortest = pathLength * Float(parameters.shortestRatio) - Float(parameters.lengthSlack)
    let longest = pathLength * Float(parameters.longestRatio) + Float(parameters.lengthSlack)
    let shapeWeight = Float(parameters.shapeWeight), offsetWeight = Float(parameters.offsetWeight)
    let languageWeight = parameters.languageWeight
    let endWeight = Float(parameters.endWeight)
    let samples = SwipeDecoder.sampleCount
    let cutoff = Float(parameters.farthest) * Float(samples)
    let evidence = 1 + Float(parameters.lengthEvidence) * pathLength

    // The best few keys by fit and by their commonest word's frequency; their words are
    // then ranked with the previous word taken into account.
    var best: [(score: Double, fit: Double, node: Int)] = []
    let keep = max(8, 3 * limit)

    for first in starts {
      buildIndex(firstKey: first)
      for last in ends {
        guard let bucket = buckets[Int(first) << 8 | Int(last)] else { continue }
        var lower = 0, upper = bucket.count
        while lower < upper {
          let middle = (lower + upper) / 2
          if bucket[middle].length < shortest { lower = middle + 1 } else { upper = middle }
        }
        var index = lower
        while index < bucket.count, bucket[index].length <= longest {
          let entry = bucket[index]
          index += 1
          template(for: entry)
          var sumX: Float = 0, sumY: Float = 0, sumSquares: Float = 0
          var sample = 0
          while sample < samples, sumSquares <= cutoff {
            let dx = pathSamples[2 * sample] - templateSamples[2 * sample]
            let dy = pathSamples[2 * sample + 1] - templateSamples[2 * sample + 1]
            sumX += dx
            sumY += dy
            sumSquares += dx * dx + dy * dy
            sample += 1
          }
          guard sumSquares <= cutoff else { continue }
          let n = Float(samples)
          let offset = (sumX * sumX + sumY * sumY) / (n * n)
          let shape = max(0, sumSquares / n - offset)
          // Where the finger came down and where it lifted are aimed at; the middle is not.
          let last = 2 * (samples - 1)
          let startX = pathSamples[0] - templateSamples[0], startY = pathSamples[1] - templateSamples[1]
          let endX = pathSamples[last] - templateSamples[last], endY = pathSamples[last + 1] - templateSamples[last + 1]
          let ends = startX * startX + startY * startY + endX * endX + endY * endY
          let fit = Double(-(shapeWeight * shape + offsetWeight * offset) * evidence - endWeight * ends)
          let node = Int(entry.node)
          let score = fit + languageWeight * lexicon.log10Frequency(lexicon.terminals(of: node).lowerBound)
          if best.count < keep || score > best[best.count - 1].score {
            let position = best.firstIndex { $0.score < score } ?? best.count
            best.insert((score, fit, node), at: position)
            if best.count > keep { best.removeLast() }
          }
        }
      }
    }

    var words: [(score: Double, word: String, folded: String)] = []
    for candidate in best {
      for id in lexicon.terminals(of: candidate.node) {
        let word = lexicon.word(id)
        let score = candidate.fit + languageWeight * lexicon.log10Probability(of: id, after: previousID)
        words.append((score, word, word.lowercased()))
      }
    }
    words.sort { $0.score > $1.score }
    var result: [String] = []
    var seen = Set<String>()
    for entry in words where seen.insert(entry.folded).inserted {
      result.append(entry.word)
      if result.count == limit { break }
    }
    return result
  }

  // MARK: Index

  private func keys(near x: Float, _ y: Float, within radius: Float) -> [UInt8] {
    var found: [UInt8] = []
    for key in 0..<keyX.count {
      let dx = keyX[key] - x, dy = keyY[key] - y
      if dx * dx + dy * dy <= radius * radius { found.append(UInt8(key)) }
    }
    return found
  }

  private func buildIndex(firstKey: UInt8) {
    guard builtFirstKeys.insert(firstKey).inserted else { return }
    var touched = Set<Int>()
    var keys: [UInt8] = []
    let root = TypingLexicon.root
    let start = lexicon.firstChild(of: root)
    for child in start..<(start + lexicon.childCount(of: root))
    where keyByCode[lexicon.character(of: child)] == firstKey {
      keys.removeAll(keepingCapacity: true)
      visit(child, keys: &keys, length: 0, touched: &touched)
    }
    for bucket in touched {
      buckets[bucket]?.sort { $0.length < $1.length }
    }
  }

  private func visit(_ node: Int, keys: inout [UInt8], length: Float, touched: inout Set<Int>) {
    // A word with a letter the layout can't type (a digit, a hyphen) can't be swiped, nor
    // can anything longer that starts with it.
    guard let key = keyByCode[lexicon.character(of: node)], keys.count < SwipeDecoder.longestWord else { return }
    var length = length
    let pushed = keys.last != key
    if pushed {
      if let last = keys.last {
        let dx = keyX[Int(key)] - keyX[Int(last)], dy = keyY[Int(key)] - keyY[Int(last)]
        length += (dx * dx + dy * dy).squareRoot()
      }
      keys.append(key)
    }
    // One key is a tap, not a swipe.
    if keys.count >= 2, !lexicon.terminals(of: node).isEmpty {
      let bucket = Int(keys[0]) << 8 | Int(key)
      buckets[bucket, default: []].append(
        Entry(node: UInt32(node), keysStart: UInt32(entryKeys.count), length: length, keyCount: UInt8(keys.count))
      )
      entryKeys.append(contentsOf: keys)
      touched.insert(bucket)
    }
    let start = lexicon.firstChild(of: node)
    for child in start..<(start + lexicon.childCount(of: node)) {
      visit(child, keys: &keys, length: length, touched: &touched)
    }
    if pushed { keys.removeLast() }
  }

  // MARK: Templates

  /// Writes the entry's template, resampled, to `templateSamples`.
  private func template(for entry: Entry) {
    let count = Int(entry.keyCount)
    let start = Int(entry.keysStart)
    let cut = Float(parameters.cornerCut)
    var written = 0
    @inline(__always) func add(_ x: Float, _ y: Float) {
      corners[2 * written] = x
      corners[2 * written + 1] = y
      written += 1
    }
    entryKeys.withUnsafeBufferPointer { keys in
      for index in 0..<count {
        let key = Int(keys[start + index])
        let x = keyX[key], y = keyY[key]
        guard cut > 0, index > 0, index < count - 1 else {
          add(x, y)
          continue
        }
        let before = Int(keys[start + index - 1]), after = Int(keys[start + index + 1])
        let inX = keyX[before] - x, inY = keyY[before] - y
        let outX = keyX[after] - x, outY = keyY[after] - y
        let reach = cut * min((inX * inX + inY * inY).squareRoot(), (outX * outX + outY * outY).squareRoot())
        let inScale = reach / (inX * inX + inY * inY).squareRoot()
        let outScale = reach / (outX * outX + outY * outY).squareRoot()
        let fromX = x + inX * inScale, fromY = y + inY * inScale
        let toX = x + outX * outScale, toY = y + outY * outScale
        // A quadratic curve from one leg to the other, pulled towards the key.
        for step in 0...SwipeDecoder.curveSteps {
          let t = Float(step) / Float(SwipeDecoder.curveSteps)
          let a = (1 - t) * (1 - t), b = 2 * t * (1 - t), c = t * t
          add(a * fromX + b * x + c * toX, a * fromY + b * y + c * toY)
        }
      }
    }
    _ = SwipeDecoder.resample(corners, count: written, into: templateSamples)
  }

  /// Resamples a polyline (x, y pairs) to `sampleCount` points evenly spaced along it and
  /// returns its length.
  @discardableResult
  private static func resample(
    _ points: UnsafePointer<Float>, count: Int, into output: UnsafeMutablePointer<Float>
  ) -> Float {
    var total: Float = 0
    for index in 1..<max(count, 1) {
      let dx = points[2 * index] - points[2 * index - 2], dy = points[2 * index + 1] - points[2 * index - 1]
      total += (dx * dx + dy * dy).squareRoot()
    }
    let step = total / Float(sampleCount - 1)
    output[0] = points[0]
    output[1] = points[1]
    var written = 1
    var segment = 1
    var walked: Float = 0  // Length of the segments before `segment`.
    while written < sampleCount - 1, segment < count, step > 0 {
      let fromX = points[2 * segment - 2], fromY = points[2 * segment - 1]
      let dx = points[2 * segment] - fromX, dy = points[2 * segment + 1] - fromY
      let length = (dx * dx + dy * dy).squareRoot()
      let target = step * Float(written)
      if target <= walked + length, length > 0 {
        let t = (target - walked) / length
        output[2 * written] = fromX + dx * t
        output[2 * written + 1] = fromY + dy * t
        written += 1
      } else {
        walked += length
        segment += 1
      }
    }
    // Rounding can leave the last few unwritten; they belong at the end.
    while written < sampleCount {
      output[2 * written] = points[2 * count - 2]
      output[2 * written + 1] = points[2 * count - 1]
      written += 1
    }
    return total
  }
}

/// Decides whether a touch on the keyboard is a swipe across the letters or a tap. Fed the
/// touch's samples as they arrive; once it answers `.tap` or `.swipe` the answer stays.
struct SwipeGestureClassifier {
  enum Verdict { case undecided, tap, swipe }

  /// A touch that never moves further than this from where it began is a tap, however long
  /// it lasts: fast typists slide a little on every key. In key pitches.
  static let tapSlop: CGFloat = 0.3
  /// A swipe has moved at least this far from where it began, enough to be on another key
  /// from anywhere on the first. In key pitches.
  static let swipeTravel: CGFloat = 0.8
  /// A finger that rests this long before moving is holding the key (for its accents), not
  /// starting a swipe. In seconds.
  static let holdDelay: TimeInterval = 0.3

  private let pitch: CGFloat
  private var start: (point: CGPoint, time: TimeInterval)?
  private(set) var verdict: Verdict

  /// `startsOnLetter`: whether the touch began on a letter key; only those start a swipe.
  init(pitch: CGFloat, startsOnLetter: Bool) {
    self.pitch = pitch
    verdict = startsOnLetter && pitch > 0 ? .undecided : .tap
  }

  @discardableResult
  mutating func add(_ point: CGPoint, at time: TimeInterval) -> Verdict {
    guard verdict == .undecided else { return verdict }
    guard let start else {
      self.start = (point, time)
      return verdict
    }
    let dx = point.x - start.point.x, dy = point.y - start.point.y
    let travel = (dx * dx + dy * dy).squareRoot() / pitch
    if travel <= SwipeGestureClassifier.tapSlop {
      if time - start.time >= SwipeGestureClassifier.holdDelay { verdict = .tap }
    } else if travel >= SwipeGestureClassifier.swipeTravel {
      verdict = .swipe
    }
    return verdict
  }

  /// Another finger came down while this one was undecided: two-thumb typing, where the
  /// next key is hit before the last is let go.
  mutating func otherTouchBegan() {
    if verdict == .undecided { verdict = .tap }
  }

  /// The finger lifted; anything not yet a swipe was a tap.
  @discardableResult
  mutating func end() -> Verdict {
    if verdict == .undecided { verdict = .tap }
    return verdict
  }

  /// A whole touch at once.
  static func isSwipe(
    samples: [(point: CGPoint, time: TimeInterval)], pitch: CGFloat, startsOnLetter: Bool
  ) -> Bool {
    var classifier = SwipeGestureClassifier(pitch: pitch, startsOnLetter: startsOnLetter)
    for sample in samples { classifier.add(sample.point, at: sample.time) }
    return classifier.end() == .swipe
  }
}
