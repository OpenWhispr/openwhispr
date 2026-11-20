import Foundation

/// What a touch on the space bar turned out to mean.
enum TrackpadOutput: Equatable {
  case none
  /// A tap: type a space.
  case typeSpace
  /// The hold completed: fade the key labels and tick the haptic.
  case began
  /// Move the cursor by this many graphemes (right is positive) and lines (down is positive).
  case move(steps: Int, lines: Int)
  /// The finger lifted in trackpad mode; the cursor stays where it is.
  case ended
}

/// The space bar's touch, as on the iOS keyboard: a tap types a space, pressing and holding
/// turns the keyboard into a trackpad, and a quick swipe across the bar does neither.
///
/// Feed it the touch's events. A finger held still sends no events, so the caller also
/// runs a timer for `holdThreshold` after `began` and calls `holdTimerFired`.
struct TrackpadGesture {
  /// How long the finger rests before trackpad mode starts.
  static let holdThreshold: TimeInterval = 0.35
  /// A finger that travels further than this before the hold completes is swiping.
  static let slop: CGFloat = 10
  /// Slow horizontal drag distance per grapheme.
  static let pointsPerStep: CGFloat = 9
  /// Vertical drag distance per line: more than a step, so a sideways drag doesn't change line.
  static let pointsPerLine: CGFloat = 24
  /// Drags at or below this speed (points per second) move one grapheme per `pointsPerStep`.
  static let slowSpeed: CGFloat = 250
  /// Drags at or above this speed move `maxAcceleration` times as far.
  static let fastSpeed: CGFloat = 1250
  static let maxAcceleration: CGFloat = 3

  private enum State {
    case idle
    case pending(start: CGPoint, time: TimeInterval)
    /// Moved too far too early; nothing more happens for this touch.
    case swiping
    case tracking(last: CGPoint, time: TimeInterval)
  }

  private var state = State.idle
  /// Parts of a step and of a line not yet paid out.
  private var stepRemainder: CGFloat = 0
  private var lineRemainder: CGFloat = 0

  var isTracking: Bool {
    if case .tracking = state { return true }
    return false
  }

  mutating func began(at point: CGPoint, time: TimeInterval) -> TrackpadOutput {
    state = .pending(start: point, time: time)
    stepRemainder = 0
    lineRemainder = 0
    return .none
  }

  mutating func moved(to point: CGPoint, time: TimeInterval) -> TrackpadOutput {
    switch state {
    case .idle, .swiping:
      return .none
    case let .pending(start, startTime):
      if TrackpadGesture.distance(start, point) > TrackpadGesture.slop {
        // Too far whether or not the time is up: the timer would have fired first had the
        // finger rested through the threshold.
        state = .swiping
        return .none
      }
      guard time - startTime >= TrackpadGesture.holdThreshold else { return .none }
      // The drag is measured from here, so the wobble during the hold moves nothing.
      state = .tracking(last: point, time: time)
      return .began
    case let .tracking(last, lastTime):
      state = .tracking(last: point, time: time)
      let dx = point.x - last.x, dy = point.y - last.y
      let elapsed = CGFloat(time - lastTime)
      let speed = elapsed > 0 ? abs(dx) / elapsed : 0
      stepRemainder += dx * TrackpadGesture.acceleration(atSpeed: speed) / TrackpadGesture.pointsPerStep
      // Only a mostly vertical movement counts toward a line, or the drift of a long
      // sideways drag would add up to one.
      if abs(dy) > abs(dx) { lineRemainder += dy / TrackpadGesture.pointsPerLine }
      let steps = Int(stepRemainder), lines = Int(lineRemainder)  // toward zero
      stepRemainder -= CGFloat(steps)
      lineRemainder -= CGFloat(lines)
      return steps == 0 && lines == 0 ? .none : .move(steps: steps, lines: lines)
    }
  }

  /// The caller's hold timer went off at `time`.
  mutating func holdTimerFired(time: TimeInterval) -> TrackpadOutput {
    guard case let .pending(start, startTime) = state,
          time - startTime >= TrackpadGesture.holdThreshold else { return .none }
    state = .tracking(last: start, time: time)
    return .began
  }

  mutating func ended(at point: CGPoint, time: TimeInterval) -> TrackpadOutput {
    defer { state = .idle }
    switch state {
    case .idle, .swiping:
      return .none
    case let .pending(start, startTime):
      // A long press that never became a drag (the timer didn't run) types nothing,
      // like a hold-and-release on the iOS space bar.
      let quick = time - startTime < TrackpadGesture.holdThreshold
      return quick && TrackpadGesture.distance(start, point) <= TrackpadGesture.slop ? .typeSpace : .none
    case .tracking:
      return .ended
    }
  }

  /// The system took the touch away.
  mutating func cancelled() -> TrackpadOutput {
    defer { state = .idle }
    return isTracking ? .ended : .none
  }

  /// How many times further a drag at `speed` (points per second) carries the cursor.
  static func acceleration(atSpeed speed: CGFloat) -> CGFloat {
    let share = (speed - slowSpeed) / (fastSpeed - slowSpeed)
    return 1 + (maxAcceleration - 1) * min(max(share, 0), 1)
  }

  private static func distance(_ a: CGPoint, _ b: CGPoint) -> CGFloat {
    let dx = a.x - b.x, dy = a.y - b.y
    return (dx * dx + dy * dy).squareRoot()
  }
}

/// The text around the cursor during a trackpad drag. The host's documentContextBefore and
/// documentContextAfter lag behind while the cursor moves, so the drag works on this copy,
/// taken when trackpad mode begins.
///
/// The moves return offsets for `UITextDocumentProxy.adjustTextPosition(byCharacterOffset:)`
/// in UTF-16 code units. The documentation says "characters", but hosts count the units of
/// their NSString: passing 1 across an emoji leaves the cursor inside it. A step here is
/// one grapheme (a Swift Character: an emoji with its modifiers, a letter with its
/// combining marks, "\r\n"), returned as however many units it takes.
///
/// The cursor stops at the ends of the text it knows. The host usually hands over only
/// the surrounding paragraph or so, so that can be short of the document's ends.
struct TrackpadCursorModel {
  private let characters: [Character]
  /// Graphemes before the cursor.
  private(set) var index: Int
  /// The column vertical moves aim for, kept across short lines until a sideways move.
  private var wantedColumn: Int?

  init(before: String, after: String) {
    characters = Array(before) + Array(after)
    index = before.count
  }

  var before: String { String(characters[..<index]) }
  var after: String { String(characters[index...]) }

  /// Both moves of a `.move` output, as one offset.
  mutating func move(steps: Int, lines: Int) -> Int {
    moveHorizontally(steps) + moveVertically(lines)
  }

  /// Moves `steps` graphemes (right is positive), stopping at either end of the text.
  mutating func moveHorizontally(_ steps: Int) -> Int {
    guard steps != 0 else { return 0 }
    wantedColumn = nil
    return go(to: index + steps)
  }

  /// Moves `lines` hard lines (down is positive), keeping the column where the line is long
  /// enough. Soft-wrapped lines can't be seen from here, so only line breaks count. At the
  /// first or last line it stays put.
  mutating func moveVertically(_ lines: Int) -> Int {
    guard lines != 0 else { return 0 }
    var starts = [0]
    for (position, character) in characters.enumerated() where character.isNewline {
      starts.append(position + 1)
    }
    let line = (starts.lastIndex { $0 <= index }) ?? 0
    let column = wantedColumn ?? (index - starts[line])
    let target = min(max(line + lines, 0), starts.count - 1)
    guard target != line else { return 0 }
    wantedColumn = column
    // A line's length leaves out the break that ends it.
    let end = target + 1 < starts.count ? starts[target + 1] - 1 : characters.count
    return go(to: min(starts[target] + column, end))
  }

  private mutating func go(to position: Int) -> Int {
    let target = min(max(position, 0), characters.count)
    let crossed = target > index ? characters[index..<target] : characters[target..<index]
    let units = crossed.reduce(0) { $0 + $1.utf16.count }
    defer { index = target }
    return target > index ? units : -units
  }
}
