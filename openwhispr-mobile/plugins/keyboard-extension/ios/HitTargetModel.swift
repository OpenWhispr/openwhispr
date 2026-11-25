import Foundation

/// The knobs of `HitTargetModel`, tuned on the dev sentences (see tests/typing/TargetsBench.swift).
struct HitTargetParameters {
  /// Spread of a tap around the key it was meant for, as a fraction of the key pitch.
  var sigma = 0.21
  /// Share of the next-letter prior given to every letter equally, so none is impossible.
  var floor = 0.05
  /// Frequency mass standing for words the lexicon doesn't have. A prefix with few known
  /// continuations is probably one of those, so its prior flattens toward equal shares.
  var unknownMass = 1e-6
  /// The most a prior may favour one letter over another, in nats. Bounds how far a
  /// boundary moves whatever the lexicon says.
  var cap = 5.0
  /// The centred share of a key, in each direction, where a tap always types that key.
  var innerShare = 0.6

  mutating func set(_ name: String, _ value: Double) {
    switch name {
    case "sigma": sigma = value
    case "floor": floor = value
    case "unknownMass": unknownMass = value
    case "cap": cap = value
    default: fatalError("Unknown parameter \(name)")
    }
  }
}

/// Dynamic hit targets: the keys look the same, but the touch boundary between neighbouring
/// letter keys leans toward the letter the language expects next, as on the iOS keyboard.
/// A tap well inside a key always types that key.
final class HitTargetModel {
  let lexicon: TypingLexicon
  let geometry: KeyGeometry
  var parameters = HitTargetParameters()

  /// The letter keys in a fixed order, so equal scores resolve the same way every time.
  private let codes: [UInt16]
  private let xs: [Double]
  private let ys: [Double]

  init(lexicon: TypingLexicon, geometry: KeyGeometry) {
    self.lexicon = lexicon
    self.geometry = geometry
    let keys = geometry.centresByCode.sorted { $0.key < $1.key }
    codes = keys.map(\.key)
    xs = keys.map { Double($0.value.x) }
    ys = keys.map { Double($0.value.y) }
  }

  /// The key whose centre is nearest: what a keyboard without this model types.
  func fixedLetter(at point: CGPoint) -> UInt16? {
    nearestIndex(Double(point.x), Double(point.y)).map { codes[$0] }
  }

  /// The letter key a tap means.
  ///
  /// - prefix: the lower-case key (`TypingLexicon.key`) of the word typed so far; empty at
  ///   the start of a word; nil when there is no word to go on (right after a digit or a
  ///   symbol), which gives the fixed targets.
  /// - previousID: the lexicon id of the word before, `TypingLexicon.sentenceStart` at the
  ///   start of a sentence, nil when unknown.
  func letter(at point: CGPoint, prefix: [UInt16]?, previousID: Int?) -> UInt16? {
    let x = Double(point.x), y = Double(point.y)
    guard let nearest = nearestIndex(x, y) else { return nil }
    let halfWidth = Double(geometry.keySize.width) * parameters.innerShare / 2
    let halfHeight = Double(geometry.keySize.height) * parameters.innerShare / 2
    // The guarantee: nothing the lexicon says reaches into the middle of a key. Inner
    // rects of different keys can't overlap, so the nearest key is the only one to check.
    if abs(x - xs[nearest]) <= halfWidth, abs(y - ys[nearest]) <= halfHeight { return codes[nearest] }
    guard let prefix, let node = lexicon.node(forKey: prefix) else { return codes[nearest] }

    // Only letters typed next count: the words that end here are a tap on space instead.
    let under = lexicon.words(under: node), ending = lexicon.terminals(of: node)
    let continuing = lexicon.probability(ofWordsIn: ending.upperBound..<under.upperBound, after: previousID)
    let total = continuing + parameters.unknownMass
    guard total > 0 else { return codes[nearest] }

    let sigma = parameters.sigma * Double(geometry.pitch)
    let spatial = 1 / (2 * sigma * sigma)
    // A key further than this can't win even with the whole cap in its favour.
    let nearestSquared = squaredDistance(nearest, x, y)
    let reach = nearestSquared + parameters.cap / spatial
    let equalShare = 1 / Double(codes.count)
    let lowest = -parameters.cap
    var best = nearest
    var bestScore = -Double.infinity
    for index in codes.indices {
      let squared = squaredDistance(index, x, y)
      guard squared <= reach else { continue }
      var mass = 0.0
      if let child = lexicon.child(of: node, character: codes[index]) {
        mass = lexicon.probability(ofWordsIn: lexicon.words(under: child), after: previousID)
      }
      let known = (mass + parameters.unknownMass * equalShare) / total
      let prior = (1 - parameters.floor) * known + parameters.floor * equalShare
      let score = max(log(prior), lowest) - squared * spatial
      if score > bestScore {
        bestScore = score
        best = index
      }
    }
    // The other half of the guarantee: the winner's own middle is the only one a tap may
    // be in, and that was handled above, so a tap in another key's middle never gets here.
    return codes[best]
  }

  @inline(__always) private func squaredDistance(_ index: Int, _ x: Double, _ y: Double) -> Double {
    let dx = x - xs[index], dy = y - ys[index]
    return dx * dx + dy * dy
  }

  private func nearestIndex(_ x: Double, _ y: Double) -> Int? {
    var best: Int?
    var bestSquared = Double.infinity
    for index in codes.indices {
      let squared = squaredDistance(index, x, y)
      if squared < bestSquared {
        bestSquared = squared
        best = index
      }
    }
    return best
  }
}
