import Foundation

extension TypingTests {
  static func runSwipeTests(plugin: URL) {
    runSwipeClassifierTests()
    for (language, layout) in [(TypingLanguage.english, KeyLayoutKind.qwerty), (.german, .qwertz)] {
      let environment = BenchEnvironment(plugin: plugin, language: language, layout: layout, split: "dev")
      runSwipeDecoderTests(environment)
    }
  }

  private static func runSwipeClassifierTests() {
    let pitch: CGFloat = 40
    func touch(to end: CGFloat, over duration: TimeInterval, steps: Int = 6) -> [(point: CGPoint, time: TimeInterval)] {
      (0...steps).map { step in
        let t = Double(step) / Double(steps)
        return (CGPoint(x: 100 + Double(end) * Double(pitch) * t, y: 20), duration * t)
      }
    }
    func isSwipe(_ samples: [(point: CGPoint, time: TimeInterval)], onLetter: Bool = true) -> Bool {
      SwipeGestureClassifier.isSwipe(samples: samples, pitch: pitch, startsOnLetter: onLetter)
    }

    check("a still tap is a tap", !isSwipe(touch(to: 0, over: 0.05)))
    check("a fast tap sliding 0.3 key is a tap", !isSwipe(touch(to: 0.3, over: 0.04)))
    check("a slow tap sliding 0.3 key is a tap", !isSwipe(touch(to: 0.3, over: 0.6)))
    check("a tap sliding half a key is a tap", !isSwipe(touch(to: 0.5, over: 0.08)))
    check("a slide across three keys is a swipe", isSwipe(touch(to: 3, over: 0.25)))
    check("a slide to the next key is a swipe", isSwipe(touch(to: 1, over: 0.12)))
    check("a slide that starts off the letters is a tap", !isSwipe(touch(to: 3, over: 0.25), onLetter: false))
    check("a slide after holding the key is a tap", !isSwipe(touch(to: 0.1, over: 0.4) + [(CGPoint(x: 220, y: 20), 0.6)]))

    // Two thumbs: the second key is hit before the first is let go, and the first then
    // slides away.
    var first = SwipeGestureClassifier(pitch: pitch, startsOnLetter: true)
    first.add(CGPoint(x: 100, y: 20), at: 0)
    first.add(CGPoint(x: 104, y: 21), at: 0.03)
    first.otherTouchBegan()
    check("an overlapped tap is never a swipe", first.add(CGPoint(x: 220, y: 20), at: 0.08) == .tap)
    var second = SwipeGestureClassifier(pitch: pitch, startsOnLetter: true)
    second.add(CGPoint(x: 300, y: 60), at: 0.03)
    second.add(CGPoint(x: 306, y: 62), at: 0.07)
    check("the overlapping tap is a tap", second.end() == .tap)

    var swipe = SwipeGestureClassifier(pitch: pitch, startsOnLetter: true)
    swipe.add(CGPoint(x: 100, y: 20), at: 0)
    check("a swipe is undecided before it has travelled", swipe.add(CGPoint(x: 110, y: 20), at: 0.02) == .undecided)
    check("a swipe is known once it has travelled", swipe.add(CGPoint(x: 140, y: 22), at: 0.06) == .swipe)
    swipe.otherTouchBegan()
    check("a swipe stays a swipe", swipe.end() == .swipe)
  }

  private static func runSwipeDecoderTests(_ environment: BenchEnvironment) {
    let lexicon = environment.lexicon()
    let geometry = environment.geometry()
    let decoder = SwipeDecoder(lexicon: lexicon, geometry: geometry)
    let name = environment.language.rawValue
    var generator = SeededGenerator(seed: 11)

    // Repeated letters, a word along one row, a word that doubles back, umlauts and ß.
    let words = environment.language == .german
      ? ["hallo", "schön", "straße", "zwischen", "können", "für"]
      : ["hello", "people", "there", "were", "letter", "quite"]
    for word in words {
      guard let path = SwipeSimulator.path(for: word, geometry: geometry, noise: 0, generator: &generator) else {
        check("\(name): \(word) has a path", false)
        continue
      }
      let decoded = decoder.decode(path: path)
      check("\(name): a clean swipe of \(word) gives it first, not \(decoded)", decoded.first?.lowercased() == word)
    }

    // Whatever the finger draws, the answer is whole words from the lexicon.
    var onlyWords = true
    for _ in 0..<300 {
      let keys = Array(geometry.centres.values)
      var path: [CGPoint] = []
      for _ in 0..<(2 + Int(generator.unit() * 6)) {
        let centre = keys[Int(generator.unit() * Double(keys.count)) % keys.count]
        path.append(CGPoint(
          x: Double(centre.x) + 15 * generator.gaussian(), y: Double(centre.y) + 15 * generator.gaussian()
        ))
      }
      for word in decoder.decode(path: path, limit: 5) {
        let known = lexicon.ids(forKey: TypingLexicon.key(of: word)).contains { lexicon.word($0) == word }
        if !known || TypingLexicon.key(of: word).count < 2 { onlyWords = false }
      }
    }
    check("\(name): a swipe only ever gives lexicon words", onlyWords)
    check("\(name): a path of one point gives nothing", decoder.decode(path: [CGPoint(x: 50, y: 20)]).isEmpty)
    check("\(name): a path far from the keys gives nothing", decoder.decode(
      path: [CGPoint(x: -400, y: -400), CGPoint(x: -300, y: -400)]
    ).isEmpty)
    check("\(name): asking for one word gives one", decoder.decode(
      path: SwipeSimulator.path(for: words[0], geometry: geometry, noise: 0, generator: &generator) ?? [], limit: 1
    ).count == 1)
  }
}
