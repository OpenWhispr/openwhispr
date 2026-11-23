import Foundation

/// The bundled word list and language model for one language: words with their frequency,
/// a trie over their keys, and word-pair frequencies. The file (built by
/// tools/build-lexicon.py, which documents the layout) is mapped, never read into memory, so
/// it costs the keyboard's memory budget only the pages a lookup touches.
final class TypingLexicon {
  private let data: NSData
  private let base: UnsafeRawPointer
  let wordCount: Int
  private let nodeCount: Int
  private let stringOffsets: UnsafePointer<UInt32>
  private let stringBlob: UnsafePointer<UInt8>
  private let unigram: UnsafePointer<UInt8>
  private let cumulative: UnsafePointer<Float32>
  private let lastCharacters: UnsafePointer<UInt16>
  private let nodes: UnsafeRawPointer
  private let pairOffsets: UnsafePointer<UInt32>
  private let pairs: UnsafePointer<UInt32>

  /// How much a word pair counts against the word's own frequency.
  static let pairWeight = 0.7

  init?(url: URL) {
    guard let data = try? NSData(contentsOf: url, options: .alwaysMapped), data.length >= 44 else { return nil }
    self.data = data
    base = data.bytes
    let header = base.assumingMemoryBound(to: UInt32.self)
    // "OWLX", version 1.
    guard header[0] == 0x584C_574F, header[1] == 1 else { return nil }
    wordCount = Int(header[2])
    nodeCount = Int(header[3])
    let offsets = (0..<6).map { Int(header[5 + $0]) }
    guard offsets.allSatisfy({ $0 < data.length }), wordCount > 0, nodeCount > 0 else { return nil }
    stringOffsets = (base + offsets[0]).assumingMemoryBound(to: UInt32.self)
    stringBlob = (base + offsets[0] + 4 * (wordCount + 1)).assumingMemoryBound(to: UInt8.self)
    unigram = (base + offsets[1]).assumingMemoryBound(to: UInt8.self)
    cumulative = (base + offsets[2]).assumingMemoryBound(to: Float32.self)
    lastCharacters = (base + offsets[3]).assumingMemoryBound(to: UInt16.self)
    nodes = base + offsets[4]
    pairOffsets = (base + offsets[5]).assumingMemoryBound(to: UInt32.self)
    pairs = (base + offsets[5] + 4 * (wordCount + 1)).assumingMemoryBound(to: UInt32.self)
  }

  /// A word's key: lower case, apostrophes dropped ("Don't" → "dont").
  static func key(of word: String) -> [UInt16] {
    var key: [UInt16] = []
    key.reserveCapacity(word.utf16.count)
    for unit in word.lowercased().utf16 where unit != 0x27 && unit != 0x2019 {
      key.append(unit)
    }
    return key
  }

  // MARK: Words

  func word(_ id: Int) -> String {
    let start = Int(stringOffsets[id]), end = Int(stringOffsets[id + 1])
    return String(decoding: UnsafeBufferPointer(start: stringBlob + start, count: end - start), as: UTF8.self)
  }

  /// log10 of the word's own frequency.
  @inline(__always) func log10Frequency(_ id: Int) -> Double { -Double(unigram[id]) / 25 }

  @inline(__always) func lastCharacter(_ id: Int) -> UInt16 { lastCharacters[id] }

  /// The summed frequency of the words in a run of ids.
  @inline(__always) func mass(_ range: Range<Int>) -> Double {
    Double(cumulative[range.upperBound] - cumulative[range.lowerBound])
  }

  /// A word's UTF-8 bytes, without building a String.
  @inline(__always) func utf8(_ id: Int) -> UnsafeBufferPointer<UInt8> {
    let start = Int(stringOffsets[id]), end = Int(stringOffsets[id + 1])
    return UnsafeBufferPointer(start: stringBlob + start, count: end - start)
  }

  // MARK: Trie

  static let root = 0

  @inline(__always) private func node(_ index: Int) -> UnsafeRawPointer { nodes + 16 * index }
  @inline(__always) func character(of node: Int) -> UInt16 { self.node(node).load(as: UInt16.self) }
  @inline(__always) func childCount(of node: Int) -> Int { Int(self.node(node).load(fromByteOffset: 2, as: UInt8.self)) }
  @inline(__always) func firstChild(of node: Int) -> Int { Int(self.node(node).load(fromByteOffset: 4, as: UInt32.self)) }
  /// The words that end exactly at this node, most frequent first.
  @inline(__always) func terminals(of node: Int) -> Range<Int> {
    let lo = Int(self.node(node).load(fromByteOffset: 8, as: UInt32.self))
    return lo..<(lo + Int(self.node(node).load(fromByteOffset: 3, as: UInt8.self)))
  }
  /// Every word whose key starts with this node's prefix.
  @inline(__always) func words(under node: Int) -> Range<Int> {
    Int(self.node(node).load(fromByteOffset: 8, as: UInt32.self))..<Int(self.node(node).load(fromByteOffset: 12, as: UInt32.self))
  }

  func child(of node: Int, character: UInt16) -> Int? {
    var lo = firstChild(of: node)
    var hi = lo + childCount(of: node)
    while lo < hi {
      let mid = (lo + hi) / 2
      let value = self.character(of: mid)
      if value == character { return mid }
      if value < character { lo = mid + 1 } else { hi = mid }
    }
    return nil
  }

  func node(forKey key: [UInt16]) -> Int? {
    var node = TypingLexicon.root
    for character in key {
      guard let next = child(of: node, character: character) else { return nil }
      node = next
    }
    return node
  }

  /// The ids of the words with exactly this key ("sie" → sie, Sie).
  func ids(forKey key: [UInt16]) -> Range<Int> {
    guard !key.isEmpty, let node = node(forKey: key) else { return 0..<0 }
    return terminals(of: node)
  }

  /// The id of a word as written, else of the most frequent word with its key.
  func id(of word: String) -> Int? {
    let candidates = ids(forKey: TypingLexicon.key(of: word))
    guard !candidates.isEmpty else { return nil }
    for id in candidates where self.word(id) == word { return id }
    return candidates.lowerBound
  }

  // MARK: Word pairs

  /// Id 0: the start of a sentence.
  static let sentenceStart = 0

  @inline(__always) func followers(of previous: Int) -> Range<Int> {
    Int(pairOffsets[previous])..<Int(pairOffsets[previous + 1])
  }
  @inline(__always) func follower(at index: Int) -> (id: Int, log10: Double) {
    let value = pairs[index]
    return (Int(value >> 8), -Double(value & 0xFF) / 25)
  }

  /// log10 P(word | previous) from the pair table alone; nil when the pair isn't there.
  func pairLog10(previous: Int, word: Int) -> Double? {
    var lo = Int(pairOffsets[previous]), hi = Int(pairOffsets[previous + 1])
    while lo < hi {
      let mid = (lo + hi) / 2
      let id = Int(pairs[mid] >> 8)
      if id == word { return -Double(pairs[mid] & 0xFF) / 25 }
      if id < word { lo = mid + 1 } else { hi = mid }
    }
    return nil
  }

  /// log10 P(word | previous): the pair frequency mixed with the word's own.
  func log10Probability(of word: Int, after previous: Int?) -> Double {
    let own = pow(10, log10Frequency(word))
    guard let previous else { return log10Frequency(word) }
    let pair = pairLog10(previous: previous, word: word).map { pow(10, $0) } ?? 0
    return log10(TypingLexicon.pairWeight * pair + (1 - TypingLexicon.pairWeight) * own)
  }

  /// P(the next word is in `range` | previous), mixed as above.
  func probability(ofWordsIn range: Range<Int>, after previous: Int?) -> Double {
    let own = mass(range)
    guard let previous else { return own }
    var lo = Int(pairOffsets[previous])
    let end = Int(pairOffsets[previous + 1])
    var hi = end
    while lo < hi {
      let mid = (lo + hi) / 2
      if Int(pairs[mid] >> 8) < range.lowerBound { lo = mid + 1 } else { hi = mid }
    }
    var pair = 0.0
    while lo < end, Int(pairs[lo] >> 8) < range.upperBound {
      pair += pow(10, -Double(pairs[lo] & 0xFF) / 25)
      lo += 1
    }
    return TypingLexicon.pairWeight * pair + (1 - TypingLexicon.pairWeight) * own
  }
}
