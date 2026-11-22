import Foundation

/// Unit tests for the hit-target model and the space-bar trackpad.
extension TypingTests {
  static func runHitTargetTests(plugin: URL) {
    let prefixes = ["", "q", "t", "th", "s", "sc", "a", "e", "i", "n", "un", "be", "wh", "ge", "ei", "zu", "x", "xqzj"]
      .map(TypingLexicon.key(of:))
    for language in TypingLanguage.allCases {
      for layout in KeyLayoutKind.allCases {
        let environment = BenchEnvironment(plugin: plugin, language: language, layout: layout, split: "dev")
        let lexicon = environment.lexicon()
        let geometry = environment.geometry()
        let model = HitTargetModel(lexicon: lexicon, geometry: geometry)
        let name = "\(language.rawValue)-\(layout.rawValue)"
        let previous: [Int?] = [nil, TypingLexicon.sentenceStart, lexicon.id(of: language == .german ? "der" : "the")]
        let halfWidth = Double(geometry.keySize.width) * 0.3, halfHeight = Double(geometry.keySize.height) * 0.3

        // The guarantee, against the tuned model and one with nothing holding the lexicon back.
        for unbounded in [false, true] {
          if unbounded {
            model.parameters.cap = 1000
            model.parameters.floor = 0
            model.parameters.unknownMass = 0
            model.parameters.sigma = 1
          }
          var stolen = 0
          for (code, centre) in geometry.centresByCode {
            for column in -6...6 {
              for row in -6...6 {
                let point = CGPoint(
                  x: Double(centre.x) + halfWidth * 0.999 * Double(column) / 6,
                  y: Double(centre.y) + halfHeight * 0.999 * Double(row) / 6
                )
                if model.fixedLetter(at: point) != code { stolen += 1 }
                for prefix in prefixes {
                  for id in previous where model.letter(at: point, prefix: prefix, previousID: id) != code {
                    stolen += 1
                  }
                }
              }
            }
          }
          check("\(name): a tap in the inner 60% of a key types that key\(unbounded ? " (unbounded prior)" : "")", stolen == 0)
        }
        model.parameters = HitTargetParameters()

        // Between two keys the expected letter wins; without a word to go on the nearer key does.
        guard let u = geometry.centresByCode[0x75], let i = geometry.centresByCode[0x69] else { continue }
        let towardI = CGPoint(x: (u.x + i.x) / 2 + 2, y: u.y)
        check("\(name): fixed targets type the nearer key", model.fixedLetter(at: towardI) == 0x69)
        check("\(name): after q the boundary leans toward u", model.letter(at: towardI, prefix: [0x71], previousID: nil) == 0x75)
        check("\(name): no word context gives the fixed target", model.letter(at: towardI, prefix: nil, previousID: nil) == 0x69)
        check(
          "\(name): an unknown prefix gives the fixed target",
          model.letter(at: towardI, prefix: TypingLexicon.key(of: "xqzj"), previousID: nil) == 0x69
        )
        check(
          "\(name): a tap outside the letter area types the nearest key",
          model.letter(at: CGPoint(x: -20, y: -30), prefix: [], previousID: nil) == 0x71
            && model.fixedLetter(at: CGPoint(x: -20, y: -30)) == 0x71
        )
      }
    }
  }

  static func runTrackpadTests() {
    let hold = TrackpadGesture.holdThreshold
    let origin = CGPoint(x: 100, y: 20)

    // Tap, hold, swipe.
    var gesture = TrackpadGesture()
    check("trackpad: touch down does nothing yet", gesture.began(at: origin, time: 0) == .none)
    check("trackpad: a quick lift types a space", gesture.ended(at: CGPoint(x: 103, y: 21), time: 0.12) == .typeSpace)

    gesture = TrackpadGesture()
    _ = gesture.began(at: origin, time: 0)
    check("trackpad: the timer before the threshold does nothing", gesture.holdTimerFired(time: hold - 0.01) == .none)
    check("trackpad: not tracking before the threshold", !gesture.isTracking)
    check("trackpad: the hold begins trackpad mode", gesture.holdTimerFired(time: hold) == .began)
    check("trackpad: the hold begins only once", gesture.holdTimerFired(time: hold + 0.1) == .none)
    check("trackpad: lifting ends trackpad mode without a space", gesture.ended(at: origin, time: hold + 0.2) == .ended)
    check("trackpad: idle after the lift", gesture.moved(to: origin, time: hold + 0.3) == .none)

    gesture = TrackpadGesture()
    _ = gesture.began(at: origin, time: 0)
    check("trackpad: a small wobble is not a swipe", gesture.moved(to: CGPoint(x: 104, y: 22), time: 0.1) == .none)
    check("trackpad: a resting finger's next move begins it", gesture.moved(to: CGPoint(x: 105, y: 22), time: hold + 0.01) == .began)

    gesture = TrackpadGesture()
    _ = gesture.began(at: origin, time: 0)
    check("trackpad: a quick swipe does nothing", gesture.moved(to: CGPoint(x: 140, y: 20), time: 0.05) == .none)
    check("trackpad: a swipe never starts trackpad mode", gesture.holdTimerFired(time: hold) == .none)
    check("trackpad: nor when it lingers", gesture.moved(to: CGPoint(x: 200, y: 20), time: hold + 0.5) == .none)
    check("trackpad: a press that slid still types its space", gesture.ended(at: CGPoint(x: 200, y: 20), time: hold + 0.6) == .typeSpace)

    gesture = TrackpadGesture()
    _ = gesture.began(at: origin, time: 0)
    check("trackpad: a press that never became the trackpad types a space", gesture.ended(at: origin, time: hold + 0.3) == .typeSpace)

    gesture = TrackpadGesture()
    _ = gesture.began(at: origin, time: 0)
    _ = gesture.holdTimerFired(time: hold)
    check("trackpad: a cancelled drag ends", gesture.cancelled() == .ended)

    // A slow drag: one grapheme per 9 pt, the remainder carried over.
    gesture = TrackpadGesture()
    _ = gesture.began(at: origin, time: 0)
    _ = gesture.holdTimerFired(time: hold)
    var time = hold
    func drag(_ gesture: inout TrackpadGesture, dx: CGFloat, dy: CGFloat = 0, from point: inout CGPoint, over seconds: TimeInterval) -> TrackpadOutput {
      point = CGPoint(x: point.x + dx, y: point.y + dy)
      time += seconds
      return gesture.moved(to: point, time: time)
    }
    var point = origin
    check("trackpad: under a step moves nothing", drag(&gesture, dx: 5, from: &point, over: 0.1) == .none)
    check("trackpad: the remainder completes a step", drag(&gesture, dx: 5, from: &point, over: 0.1) == .move(steps: 1, lines: 0))
    check("trackpad: 18 pt slowly is two steps", drag(&gesture, dx: 17, from: &point, over: 0.2) == .move(steps: 2, lines: 0))
    check("trackpad: dragging left steps back", drag(&gesture, dx: -27, from: &point, over: 0.3) == .move(steps: -3, lines: 0))
    check("trackpad: a fast drag covers three times as far", drag(&gesture, dx: 27, from: &point, over: 0.01) == .move(steps: 9, lines: 0))
    check("trackpad: sideways drift changes no line", drag(&gesture, dx: 40, dy: 30, from: &point, over: 0.4) == .move(steps: 4, lines: 0))
    check("trackpad: 24 pt down is a line", drag(&gesture, dx: 0, dy: 25, from: &point, over: 0.2) == .move(steps: 0, lines: 1))
    check("trackpad: 48 pt up is two lines", drag(&gesture, dx: 0, dy: -50, from: &point, over: 0.3) == .move(steps: 0, lines: -2))
    check("trackpad: acceleration is 1 when slow", TrackpadGesture.acceleration(atSpeed: 100) == 1)
    check("trackpad: acceleration is capped", TrackpadGesture.acceleration(atSpeed: 5000) == TrackpadGesture.maxAcceleration)

    // Cursor offsets, in UTF-16 units, one grapheme per step.
    let family = "👨‍👩‍👧"  // 8 units
    let accented = "e\u{301}"  // 2 units
    var cursor = TrackpadCursorModel(before: "ab\(family)", after: "\(accented)🇩🇪z")
    check("cursor: back over an emoji sequence", cursor.moveHorizontally(-1) == -8)
    check("cursor: back over a letter", cursor.moveHorizontally(-1) == -1)
    check("cursor: stops at the start", cursor.moveHorizontally(-5) == -1 && cursor.index == 0)
    check("cursor: stays at the start", cursor.moveHorizontally(-1) == 0)
    check("cursor: forward over letters and the emoji", cursor.moveHorizontally(3) == 10)
    check("cursor: forward over a combining mark", cursor.moveHorizontally(1) == 2)
    check("cursor: forward over a flag", cursor.moveHorizontally(1) == 4)
    check("cursor: stops at the end", cursor.moveHorizontally(9) == 1 && cursor.after.isEmpty)
    check("cursor: stays at the end", cursor.moveHorizontally(2) == 0)
    check("cursor: the text is unchanged", cursor.before == "ab\(family)\(accented)🇩🇪z")

    // A scripted drag end to end: hold, slow right, fast left.
    gesture = TrackpadGesture()
    cursor = TrackpadCursorModel(before: "Hi 👍", after: " there")
    _ = gesture.began(at: origin, time: 0)
    _ = gesture.holdTimerFired(time: hold)
    point = origin
    time = hold
    var offsets: [Int] = []
    for (dx, seconds) in [(CGFloat(10), 0.1), (20, 0.2), (-30, 0.01), (-90, 0.02)] {
      if case let .move(steps, lines) = drag(&gesture, dx: dx, from: &point, over: seconds) {
        offsets.append(cursor.move(steps: steps, lines: lines))
      }
    }
    check("cursor: a scripted drag gives the offsets \(offsets)", offsets == [1, 2, -8, 0])
    check("cursor: and ends at the start of the text", cursor.index == 0 && gesture.ended(at: point, time: time + 0.1) == .ended)

    // Vertical moves cross hard line breaks and keep the column.
    cursor = TrackpadCursorModel(before: "first line\nab\nthird 👍 li", after: "ne\nlast")
    check("cursor: up to a shorter line stops at its end", cursor.moveVertically(-1) == -12 && cursor.before == "first line\nab")
    check("cursor: up again returns to the column", cursor.moveVertically(-1) == -3 && cursor.before == "first line")
    check("cursor: stays on the first line", cursor.moveVertically(-1) == 0)
    check("cursor: down two lines keeps the column", cursor.moveVertically(2) == 15 && cursor.before == "first line\nab\nthird 👍 li")
    check("cursor: down to the last line stops at its end", cursor.moveVertically(3) == 7 && cursor.after.isEmpty)
    check("cursor: stays on the last line", cursor.moveVertically(1) == 0)
    check("cursor: a sideways move resets the column", cursor.moveHorizontally(-1) == -1 && cursor.moveVertically(-1) == -14)
    check("cursor: column 3 of the third line", cursor.before == "first line\nab\nthi")
    // A wrapped paragraph: no line breaks, so a row is an estimate.
    let paragraph = String(repeating: "word ", count: 30)
    var wrapped = TrackpadCursorModel(before: paragraph, after: "", wrapWidth: 40)
    check("cursor: up in a wrapped paragraph moves one row", wrapped.moveVertically(-1) == -40)
    check("cursor: up two more rows", wrapped.moveVertically(-2) == -80)
    check("cursor: stops short of a full row from the start", wrapped.moveVertically(-1) == 0 && wrapped.before.count == 30)
    check("cursor: down a row", wrapped.moveVertically(1) == 40)
    var mixed = TrackpadCursorModel(before: paragraph + "\nshort\nend", after: "", wrapWidth: 40)
    check("cursor: a near line break still keeps the column", mixed.moveVertically(-1) == -6 && mixed.before.hasSuffix("\nsho"))
    check("cursor: then rows into the long paragraph", mixed.moveVertically(-1) == -40)

    var windows = TrackpadCursorModel(before: "ab\r\ncd", after: "")
    check("cursor: \\r\\n is one line break", windows.moveVertically(-1) == -4 && windows.before == "ab")
    var empty = TrackpadCursorModel(before: "", after: "")
    check("cursor: empty text never moves", empty.move(steps: 3, lines: -2) == 0)
  }
}
