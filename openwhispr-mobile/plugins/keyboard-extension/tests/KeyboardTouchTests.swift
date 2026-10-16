// The runner appends this to KeyboardViewController.swift so private production
// types remain private while the tests exercise the actual UIKit implementation.
private extension KeyboardViewController {
  static func makeTouchTestStack() -> UIStackView {
    KeyboardViewController().keyboardRowsStack
  }

  /// The production keyboard laid out at `width` and its content height. `globe`
  /// stands in for needsInputModeSwitchKey: true on iPhones with a Home button.
  static func makeLaidOutKeyboard(width: CGFloat, numbers: Bool, globe: Bool) -> KeyboardViewController {
    let getter = class_getInstanceMethod(
      UIInputViewController.self,
      #selector(getter: UIInputViewController.needsInputModeSwitchKey)
    )!
    let stub: @convention(block) (AnyObject) -> Bool = { _ in globe }
    let original = method_setImplementation(getter, imp_implementationWithBlock(stub))
    defer { method_setImplementation(getter, original) }

    let controller = KeyboardViewController()
    controller.loadViewIfNeeded()
    if numbers {
      controller.handleLayoutModeSwitchTapped()
    }
    // The first pass picks the metrics for `width`; the second sizes the view to its rows.
    controller.view.frame = CGRect(x: 0, y: 0, width: width, height: 400)
    controller.view.layoutIfNeeded()
    let height = controller.view.systemLayoutSizeFitting(
      CGSize(width: width, height: 0),
      withHorizontalFittingPriority: .required,
      verticalFittingPriority: .fittingSizeLevel
    ).height
    controller.view.frame = CGRect(x: 0, y: 0, width: width, height: height)
    controller.view.layoutIfNeeded()
    return controller
  }

  var touchTestRows: KeyboardRowsStack { keyboardRowsStack }
  var touchTestRowHeight: CGFloat { metrics.rowHeight }
  var touchTestPadding: (side: CGFloat, bottom: CGFloat) {
    (metrics.rootHorizontalPadding, metrics.rootBottomPadding)
  }

  static func touchTestRemoveTouchDelays(from recognizers: [UIGestureRecognizer]?) {
    removeTouchDelays(from: recognizers)
  }

  static func touchTestShouldPoll(tick: Int, isLive: Bool) -> Bool {
    shouldPollSharedState(tick: tick, isLive: isLive)
  }

  func touchTestRefreshFieldKeys() { refreshFieldAwareKeys() }
  var touchTestReturnKey: KeyButton? { returnButton }
  var touchTestCoordinator: KeyTouchCoordinator { keyTouches }
  var touchTestIsNumbers: Bool { layoutMode == .numbers }
  var touchTestShiftEnabled: Bool { isShiftEnabled }
  var touchTestDeleteRepeating: Bool { deleteRepeatTimer != nil }
  func touchTestRebuild() { rebuildKeyboard() }
  func touchTestWillDisappear() { viewWillDisappear(false) }
}

private struct TouchChecks {
  private(set) var failures = [String]()
  private(set) var count = 0

  mutating func check(_ label: String, _ passed: Bool) {
    count += 1
    if !passed {
      failures.append(label)
      print("FAIL: \(label)")
    }
  }

  mutating func expect(_ label: String, _ stack: UIView, _ point: CGPoint, _ expected: UIView?) {
    check(label, stack.hitTest(point, with: nil) === expected)
  }
}

@main
private enum KeyboardTouchTests {
  @MainActor
  static func main() {
    var checks = TouchChecks()
    checkSyntheticRows(&checks)
    checkEdgeTies(&checks)
    checkOtherControls(&checks)
    checkWindowTouchDelays(&checks)
    checkPollCadence(&checks)
    checkFieldKeysRefreshOnlyOnChange(&checks)
    checkTouchTracker(&checks)
    checkTouchCoordinator(&checks)
    for width: CGFloat in [360, 393, 430, 852] {
      checkProductionLayout(width: width, numbers: false, globe: false, &checks)
      checkKeyWiring(width: width, numbers: false, globe: false, &checks)
      checkProductionLayout(width: width, numbers: true, globe: false, &checks)
      checkKeyWiring(width: width, numbers: true, globe: false, &checks)
      checkProductionLayout(width: width, numbers: false, globe: true, &checks)
      checkKeyWiring(width: width, numbers: false, globe: true, &checks)
    }
    checkKeyDispatch(&checks)
    checkMidTouchTeardown(&checks)

    print("Keyboard touch routing: \(checks.count - checks.failures.count)/\(checks.count) passed")
    if !checks.failures.isEmpty {
      exit(1)
    }
  }

  @MainActor
  static func checkSyntheticRows(_ checks: inout TouchChecks) {
    let stack = KeyboardViewController.makeTouchTestStack()
    stack.frame = CGRect(x: 0, y: 0, width: 100, height: 95)

    func addRow(y: CGFloat) -> (UIView, KeyButton, KeyButton) {
      let container = UIView(frame: CGRect(x: 0, y: y, width: 100, height: 42))
      let row = UIStackView(frame: container.bounds)
      container.addSubview(row)
      let left = KeyButton(type: .custom)
      left.frame = CGRect(x: 0, y: 0, width: 47, height: 42)
      let right = KeyButton(type: .custom)
      right.frame = CGRect(x: 53, y: 0, width: 47, height: 42)
      row.addSubview(left)
      row.addSubview(right)
      stack.addSubview(container)
      return (container, left, right)
    }

    let (topRow, topLeft, topRight) = addRow(y: 0)
    let (_, bottomLeft, _) = addRow(y: 53)

    checks.expect("key center", stack, CGPoint(x: 20, y: 20), topLeft)
    checks.expect("row gap closer to upper key", stack, CGPoint(x: 20, y: 45), topLeft)
    checks.expect("row gap closer to lower key", stack, CGPoint(x: 20, y: 50), bottomLeft)
    checks.expect("horizontal gap closer to left", stack, CGPoint(x: 49, y: 20), topLeft)
    checks.expect("horizontal gap closer to right", stack, CGPoint(x: 51, y: 20), topRight)

    // UIKit visits later siblings first. Expanded target overlap must not steal
    // a tap from a visibly closer key solely because it was added last.
    topLeft.hitTestOutsets.right = 8
    topRight.hitTestOutsets.left = 8
    checks.expect("visible left edge beats overlapping right target", stack, CGPoint(x: 46, y: 20), topLeft)
    checks.expect("visible right edge beats overlapping left target", stack, CGPoint(x: 54, y: 20), topRight)
    checks.expect("overlapping gap chooses nearer left", stack, CGPoint(x: 49, y: 20), topLeft)
    checks.expect("overlapping gap chooses nearer right", stack, CGPoint(x: 51, y: 20), topRight)
    checks.expect("exact tie keeps the earlier key", stack, CGPoint(x: 50, y: 20), topLeft)
    checks.expect("exact row tie keeps the upper key", stack, CGPoint(x: 20, y: 47.5), topLeft)

    // A hidden layout sits above the visible one in the production hierarchy.
    // Its key covers the tap point, so it would win if it were considered.
    let hiddenRow = UIView(frame: topRow.frame)
    let hiddenKey = KeyButton(type: .custom)
    hiddenKey.frame = topLeft.frame.offsetBy(dx: 0, dy: 4)
    hiddenRow.addSubview(hiddenKey)
    hiddenRow.isHidden = true
    stack.addSubview(hiddenRow)
    checks.expect("hidden layout never steals a gap", stack, CGPoint(x: 20, y: 45), topLeft)
    hiddenRow.isHidden = false
    hiddenRow.alpha = 0
    checks.expect("transparent layout never steals a gap", stack, CGPoint(x: 20, y: 45), topLeft)
    hiddenRow.alpha = 1
    hiddenRow.isUserInteractionEnabled = false
    checks.expect("noninteractive layout never steals a gap", stack, CGPoint(x: 20, y: 45), topLeft)
    hiddenRow.removeFromSuperview()

    // UIKit skips disabled controls, so a disabled key takes no taps at all.
    topLeft.isEnabled = false
    checks.expect("disabled key leaves its gap dead", stack, CGPoint(x: 20, y: 46), stack)
    checks.expect("disabled key lets the lower key take its gap", stack, CGPoint(x: 20, y: 47), bottomLeft)
    checks.expect("disabled key face falls through to its row", stack, CGPoint(x: 20, y: 20), topRow.subviews[0])
    topLeft.isEnabled = true

    checks.expect("outside rows does not capture dictation-strip taps", stack, CGPoint(x: 20, y: -1), nil)
    checks.expect("outside right boundary", stack, CGPoint(x: 101, y: 20), nil)
    stack.isHidden = true
    checks.expect("hidden keyboard", stack, CGPoint(x: 20, y: 20), nil)
    stack.isHidden = false
    stack.alpha = 0
    checks.expect("transparent keyboard", stack, CGPoint(x: 20, y: 20), nil)
    stack.alpha = 1
    stack.isUserInteractionEnabled = false
    checks.expect("disabled keyboard interaction", stack, CGPoint(x: 20, y: 20), nil)
    stack.isUserInteractionEnabled = true

    // The third row adds another letters stack between shift and backspace.
    let nested = UIStackView(frame: topLeft.frame)
    topLeft.removeFromSuperview()
    topRow.subviews[0].addSubview(nested)
    topLeft.frame = nested.bounds
    nested.addSubview(topLeft)
    checks.expect("nested third-row key receives a gap tap", stack, CGPoint(x: 20, y: 45), topLeft)

    // Exercise every row-gap pixel that lies in an expanded key target.
    for y in 42...52 {
      let expected = y <= 47 ? topLeft : bottomLeft
      checks.expect("continuous row target at y=\(y)", stack, CGPoint(x: 20, y: CGFloat(y)), expected)
    }
  }

  /// Keys of unequal width, like shift, backspace and space beside letters.
  @MainActor
  static func checkEdgeTies(_ checks: inout TouchChecks) {
    func makeRow(_ frames: [CGRect]) -> (UIStackView, [KeyButton]) {
      let stack = KeyboardViewController.makeTouchTestStack()
      stack.frame = CGRect(x: 0, y: 0, width: 100, height: 42)
      let row = UIView(frame: stack.bounds)
      stack.addSubview(row)
      let keys = frames.map { frame -> KeyButton in
        let key = KeyButton(type: .custom)
        key.frame = frame
        row.addSubview(key)
        return key
      }
      return (stack, keys)
    }

    // Equal edge distance: the key whose center is nearer wins, in either order.
    let (wideFirst, wideFirstKeys) = makeRow([
      CGRect(x: 0, y: 0, width: 60, height: 42),
      CGRect(x: 64, y: 0, width: 20, height: 42),
    ])
    checks.expect("edge tie goes to the later key with the nearer center", wideFirst, CGPoint(x: 62, y: 20), wideFirstKeys[1])
    let (narrowFirst, narrowFirstKeys) = makeRow([
      CGRect(x: 0, y: 0, width: 20, height: 42),
      CGRect(x: 24, y: 0, width: 60, height: 42),
    ])
    checks.expect("edge tie goes to the earlier key with the nearer center", narrowFirst, CGPoint(x: 22, y: 20), narrowFirstKeys[0])

    // A wide key's visible face wins over a narrow neighbour whose center is nearer.
    wideFirstKeys[1].hitTestOutsets.left = 8
    checks.expect("wide key face beats a nearer narrow center", wideFirst, CGPoint(x: 59, y: 20), wideFirstKeys[0])
    checks.expect("wide key gap edge beats a nearer narrow center", wideFirst, CGPoint(x: 61, y: 20), wideFirstKeys[0])
  }

  /// A control that is not a KeyButton keeps UIKit's default routing.
  @MainActor
  static func checkOtherControls(_ checks: inout TouchChecks) {
    let stack = KeyboardViewController.makeTouchTestStack()
    stack.frame = CGRect(x: 0, y: 0, width: 100, height: 42)
    let row = UIView(frame: stack.bounds)
    stack.addSubview(row)
    let button = UIButton(type: .custom)
    button.frame = CGRect(x: 0, y: 0, width: 40, height: 42)
    row.addSubview(button)
    let key = KeyButton(type: .custom)
    key.frame = CGRect(x: 60, y: 0, width: 40, height: 42)
    row.addSubview(key)

    checks.expect("plain button stays tappable", stack, CGPoint(x: 20, y: 20), button)
    checks.expect("dead point keeps UIKit's target", stack, CGPoint(x: 50, y: 20), row)
  }

  /// Sweeps the real keyboard below the dictation strip, padding included: no tap
  /// is dropped, every key keeps its own face, and a tap just outside a key never
  /// goes to a farther key.
  @MainActor
  static func checkProductionLayout(
    width: CGFloat,
    numbers: Bool,
    globe: Bool,
    _ checks: inout TouchChecks
  ) {
    let controller = KeyboardViewController.makeLaidOutKeyboard(width: width, numbers: numbers, globe: globe)
    let rows = controller.touchTestRows
    let layout = "\(Int(width)) pt \(numbers ? "numbers" : "letters")\(globe ? " with globe" : "")"

    let keys = visibleKeys(in: rows)
    let rects = keys.map { $0.convert($0.bounds, to: rows) }
    checks.check(
      "\(layout): keys laid out at row height",
      keys.count > 20 && rects.allSatisfy { abs($0.height - controller.touchTestRowHeight) < 0.5 }
    )

    func edgeDistance(_ rect: CGRect, _ point: CGPoint) -> CGFloat {
      let dx = max(rect.minX - point.x, 0, point.x - rect.maxX)
      let dy = max(rect.minY - point.y, 0, point.y - rect.maxY)
      return dx * dx + dy * dy
    }

    var wrongFace = 0
    var fartherKey = 0
    for (key, rect) in zip(keys, rects) {
      let faces = [
        CGPoint(x: rect.midX, y: rect.midY),
        CGPoint(x: rect.minX + 1, y: rect.midY), CGPoint(x: rect.maxX - 1, y: rect.midY),
        CGPoint(x: rect.midX, y: rect.minY + 1), CGPoint(x: rect.midX, y: rect.maxY - 1),
      ]
      wrongFace += faces.filter { rows.hitTest($0, with: nil) !== key }.count

      let outside = [
        CGPoint(x: rect.minX - 2, y: rect.midY), CGPoint(x: rect.maxX + 2, y: rect.midY),
        CGPoint(x: rect.midX, y: rect.minY - 2), CGPoint(x: rect.midX, y: rect.maxY + 2),
      ]
      for point in outside where rows.bounds.contains(point) {
        guard let hit = rows.hitTest(point, with: nil) as? KeyButton,
              let index = keys.firstIndex(where: { $0 === hit }) else { continue }
        if edgeDistance(rects[index], point) > edgeDistance(rect, point) {
          fartherKey += 1
        }
      }
    }
    checks.check("\(layout): every key keeps its own face (\(wrongFace) wrong)", wrongFace == 0)
    checks.check("\(layout): no tap beside a key goes to a farther key (\(fartherKey))", fartherKey == 0)

    // Hit-test from the root view, so a touch in the keyboard's padding has to get
    // through every ancestor. Half-point steps across catch the pixel-rounding
    // slivers between equal-width keys; row heights and gaps are whole points.
    let root = controller.view!
    let strip = (rows.superview as! UIStackView).arrangedSubviews[0]
    let padding = controller.touchTestPadding
    checks.check(
      "\(layout): rows keep the keyboard's padding",
      rows.frame.minX == padding.side && root.bounds.maxX - rows.frame.maxX == padding.side
        && root.bounds.maxY - rows.frame.maxY == padding.bottom
    )
    let top = (strip.frame.maxY + rows.frame.minY) / 2
    let visibleKeys = Set(keys.map(ObjectIdentifier.init))
    var dropped = 0
    var hiddenHits = 0
    for y in stride(from: top, to: root.bounds.height, by: 1) {
      for x in stride(from: 0, to: root.bounds.width, by: 0.5) {
        guard let hit = root.hitTest(CGPoint(x: x, y: y), with: nil) as? KeyButton else {
          dropped += 1
          continue
        }
        if !visibleKeys.contains(ObjectIdentifier(hit)) {
          hiddenHits += 1
        }
      }
    }
    checks.check("\(layout): no tap below the dictation strip is dropped (\(dropped))", dropped == 0)
    checks.check("\(layout): no tap reaches a hidden key (\(hiddenHits))", hiddenHits == 0)

    let stripHalf = CGPoint(x: root.bounds.midX, y: top - 0.5)
    checks.check("\(layout): the strip's half of the gap takes no key taps", !(root.hitTest(stripHalf, with: nil) is KeyButton))
  }

  /// The system holds back touches near the screen edges; the keyboard turns
  /// that delay off without stopping a real system swipe from cancelling.
  @MainActor
  static func checkWindowTouchDelays(_ checks: inout TouchChecks) {
    let edge = UIScreenEdgePanGestureRecognizer()
    let tap = UITapGestureRecognizer()
    for recognizer in [edge, tap] {
      recognizer.delaysTouchesBegan = true
      recognizer.delaysTouchesEnded = true
    }
    KeyboardViewController.touchTestRemoveTouchDelays(from: [edge, tap])
    checks.check("window recognizers no longer delay touch-down", !edge.delaysTouchesBegan && !tap.delaysTouchesBegan)
    checks.check("window recognizers no longer delay lift", !edge.delaysTouchesEnded && !tap.delaysTouchesEnded)
    checks.check("a system swipe can still cancel key touches", edge.cancelsTouchesInView && tap.cancelsTouchesInView)
    KeyboardViewController.touchTestRemoveTouchDelays(from: nil)
  }

  /// The shared-state poll reads every tick while a recording starts or runs,
  /// and every fourth tick otherwise.
  @MainActor
  static func checkPollCadence(_ checks: inout TouchChecks) {
    let ticks = Array(1...8)
    checks.check(
      "a live recording reads shared state every tick",
      ticks.allSatisfy { KeyboardViewController.touchTestShouldPoll(tick: $0, isLive: true) }
    )
    checks.check(
      "an idle keyboard reads shared state every fourth tick",
      ticks.filter { KeyboardViewController.touchTestShouldPoll(tick: $0, isLive: false) } == [4, 8]
    )
  }

  /// textDidChange runs on every keystroke; an unchanged field must not touch the
  /// return key. The test clears the key's image between refreshes: a skipped
  /// refresh leaves it cleared, a repeated one puts it back.
  @MainActor
  static func checkFieldKeysRefreshOnlyOnChange(_ checks: inout TouchChecks) {
    let controller = KeyboardViewController.makeLaidOutKeyboard(width: 393, numbers: false, globe: false)
    controller.touchTestRefreshFieldKeys()
    guard let returnKey = controller.touchTestReturnKey else {
      checks.check("return key exists", false)
      return
    }
    checks.check("return key shows its icon", returnKey.image(for: .normal) != nil)
    returnKey.setImage(nil, for: .normal)
    controller.touchTestRefreshFieldKeys()
    checks.check("an unchanged field leaves the return key alone", returnKey.image(for: .normal) == nil)
  }

  /// Apple-keyboard touch rules, without UIKit: rollover keeps press order and two
  /// fingers on one key type it twice.
  @MainActor
  static func checkTouchTracker(_ checks: inout TouchChecks) {
    typealias Tracker = KeyTouchTracker<Int, String>
    func makeTracker() -> Tracker { Tracker(activatesOnTouchDown: { $0 == "⌫" || $0 == "⇧" }) }
    func typed(_ effects: [Tracker.Effect]) -> [String] {
      effects.compactMap { effect in
        if case .activate(let key) = effect { return key }
        return nil
      }
    }
    func lit(_ effects: [Tracker.Effect]) -> [String: Bool] {
      var state = [String: Bool]()
      for case .highlight(let key, let on) in effects { state[key] = on }
      return state
    }

    var tracker = makeTracker()
    checks.check("tracker: a tap lights its key as the finger lands", tracker.began(1, on: "a") == [.highlight("a", true)])
    checks.check("tracker: a tap types on lift", tracker.ended(1) == [.activate("a"), .highlight("a", false)])
    checks.check("tracker: an unknown lift does nothing", tracker.ended(9).isEmpty)

    tracker = makeTracker()
    var effects = tracker.began(1, on: "a") + tracker.began(2, on: "b") + tracker.ended(2) + tracker.ended(1)
    checks.check("tracker: overlapping keys type in press order", typed(effects) == ["a", "b"])

    tracker = makeTracker()
    effects = tracker.began(1, on: "a") + tracker.began(2, on: "b") + tracker.ended(1) + tracker.ended(2)
    checks.check("tracker: overlapping keys lifted in order type once each", typed(effects) == ["a", "b"])

    tracker = makeTracker()
    effects = tracker.began(1, on: "a") + tracker.began(2, on: "b") + tracker.began(3, on: "c")
      + tracker.ended(3) + tracker.ended(2) + tracker.ended(1)
    checks.check("tracker: three fingers lifted in reverse keep press order", typed(effects) == ["a", "b", "c"])

    tracker = makeTracker()
    effects = tracker.began(1, on: "l") + tracker.began(2, on: "l") + tracker.ended(1)
    checks.check("tracker: a key stays lit while a second finger holds it", lit(effects)["l"] == true)
    effects += tracker.ended(2)
    checks.check("tracker: two fingers on one key type it twice", typed(effects) == ["l", "l"])
    checks.check("tracker: the key dims when the last finger lifts", lit(effects)["l"] == false)

    tracker = makeTracker()
    checks.check(
      "tracker: delete acts as the finger lands",
      tracker.began(1, on: "⌫") == [.highlight("⌫", true), .activate("⌫")]
    )
    checks.check("tracker: delete does not act again on lift", tracker.ended(1) == [.highlight("⌫", false)])

    tracker = makeTracker()
    effects = tracker.began(1, on: "a") + tracker.began(2, on: "⌫")
    checks.check("tracker: a pending letter types before delete removes it", typed(effects) == ["a", "⌫"])

    tracker = makeTracker()
    effects = tracker.began(1, on: "a") + tracker.cancelled(1)
    checks.check("tracker: a cancelled touch types nothing", typed(effects).isEmpty && lit(effects)["a"] == false)

    tracker = makeTracker()
    _ = tracker.began(1, on: "a")
    checks.check(
      "tracker: sliding moves the highlight",
      tracker.moved(1, to: "s") == [.highlight("a", false), .highlight("s", true)]
    )
    checks.check("tracker: the key under the lift types", typed(tracker.ended(1)) == ["s"])

    tracker = makeTracker()
    _ = tracker.began(1, on: "a")
    checks.check("tracker: sliding onto shift is ignored", tracker.moved(1, to: "⇧").isEmpty)
    checks.check("tracker: the original key still types", typed(tracker.ended(1)) == ["a"])

    tracker = makeTracker()
    _ = tracker.began(1, on: "a")
    _ = tracker.began(2, on: "b")
    checks.check("tracker: a rolled-over key no longer slides", tracker.moved(1, to: "c").isEmpty)
    checks.check("tracker: a rolled-over key types nothing more on lift", typed(tracker.ended(1)).isEmpty)

    tracker = makeTracker()
    effects = tracker.began(1, on: "a") + tracker.began(2, on: "b")
    effects += tracker.cancelAll()
    checks.check("tracker: cancelling all touches dims every key", lit(effects) == ["a": false, "b": false])
    checks.check("tracker: cancelling all touches forgets them", tracker.activeTouchCount == 0 && tracker.ended(2).isEmpty)

    tracker = makeTracker()
    _ = tracker.began(1, on: "a")
    effects = tracker.began(1, on: "b")
    checks.check("tracker: a reused touch never types its stale key", typed(effects).isEmpty)
    checks.check("tracker: a reused touch types its new key", typed(tracker.ended(1)) == ["b"])

    tracker = makeTracker()
    _ = tracker.began(1, on: "a")
    checks.check("tracker: sliding off every key dims it", tracker.moved(1, to: nil) == [.highlight("a", false)])
    checks.check("tracker: lifting outside every key types nothing", typed(tracker.ended(1)).isEmpty)

    tracker = makeTracker()
    effects = tracker.began(1, on: "a") + tracker.moved(1, to: nil) + tracker.moved(1, to: "b") + tracker.ended(1)
    checks.check("tracker: sliding back onto a key types that key", typed(effects) == ["b"])

    tracker = makeTracker()
    effects = tracker.began(1, on: "a") + tracker.moved(1, to: nil) + tracker.began(2, on: "b")
      + tracker.moved(1, to: "c") + tracker.ended(1) + tracker.ended(2)
    checks.check("tracker: rollover passes over a finger outside the keys", typed(effects) == ["b"])
  }

  /// The coordinator drives real keys: highlight, rollover, where a finger lifts,
  /// delete repeat, the cancel-everything path and VoiceOver activation.
  @MainActor
  static func checkTouchCoordinator(_ checks: inout TouchChecks) {
    let coordinator = KeyTouchCoordinator()
    var typed = [String]()
    var repeating = false
    var repeatStarts = 0
    coordinator.onActivate = { typed.append($0.title(for: .normal) ?? "?") }
    coordinator.onRepeatBegan = {
      repeating = true
      repeatStarts += 1
    }
    coordinator.onRepeatEnded = { repeating = false }
    coordinator.repeatDelay = 0.05

    func makeKey(_ title: String, _ action: KeyAction) -> KeyButton {
      let key = KeyButton(type: .custom)
      key.setTitle(title, for: .normal)
      key.keyAction = action
      key.touchCoordinator = coordinator
      return key
    }
    func wait() { RunLoop.main.run(until: Date().addingTimeInterval(0.2)) }

    let a = makeKey("a", .character)
    let b = makeKey("b", .character)
    let delete = makeKey("⌫", .backspace)
    // Kept alive so their identifiers stay distinct.
    let fingers = (0..<3).map { _ in NSObject() }
    let ids = fingers.map(ObjectIdentifier.init)

    checks.check("coordinated keys accept a second finger", a.isMultipleTouchEnabled)
    coordinator.began(ids[0], on: a)
    checks.check("coordinator lights a pressed key", a.isHighlighted)
    coordinator.began(ids[1], on: b)
    coordinator.ended(ids[1], on: b)
    coordinator.ended(ids[0], on: a)
    checks.check("coordinator types overlapping keys in press order", typed == ["a", "b"])
    checks.check("coordinator dims keys after lift", !a.isHighlighted && !b.isHighlighted)

    typed.removeAll()
    coordinator.began(ids[0], on: a)
    coordinator.ended(ids[0], on: b)
    checks.check("the key under a lift types even with no move before it", typed == ["b"])

    typed.removeAll()
    coordinator.began(ids[0], on: a)
    coordinator.ended(ids[0], on: nil)
    checks.check("lifting outside every key types nothing", typed.isEmpty && !a.isHighlighted)

    typed.removeAll()
    coordinator.began(ids[2], on: delete)
    checks.check("delete acts as the finger lands", typed == ["⌫"])
    wait()
    checks.check("holding delete starts repeating", repeating)
    coordinator.ended(ids[2], on: delete)
    checks.check("lifting delete stops repeating", !repeating)

    coordinator.began(ids[2], on: delete)
    coordinator.ended(ids[2], on: delete)
    wait()
    checks.check("a quick delete tap never starts repeating", !repeating)

    typed.removeAll()
    coordinator.began(ids[2], on: delete)
    coordinator.moved(ids[2], to: a)
    wait()
    checks.check("sliding off delete before the hold cancels the repeat", !repeating)
    coordinator.ended(ids[2], on: a)
    checks.check("a slide off delete types nothing more on lift", typed == ["⌫"])

    coordinator.began(ids[2], on: delete)
    wait()
    coordinator.moved(ids[2], to: a)
    checks.check("once repeating, sliding off delete keeps deleting", repeating)
    coordinator.ended(ids[2], on: a)
    checks.check("lifting the slid finger stops repeating", !repeating)

    repeatStarts = 0
    coordinator.began(ids[0], on: delete)
    wait()
    coordinator.began(ids[1], on: delete)
    wait()
    coordinator.ended(ids[1], on: delete)
    checks.check("delete keeps repeating while another finger holds it", repeating)
    coordinator.ended(ids[0], on: delete)
    checks.check("delete stops repeating when the last finger lifts", !repeating)
    checks.check("two fingers on delete start one repeat", repeatStarts == 1)

    coordinator.began(ids[0], on: a)
    coordinator.began(ids[2], on: delete)
    wait()
    typed.removeAll()
    coordinator.cancelAll()
    checks.check("cancelling all touches stops a held delete", !repeating)
    checks.check("cancelling all touches dims every key", !a.isHighlighted && !delete.isHighlighted)
    coordinator.ended(ids[2], on: delete)
    coordinator.ended(ids[0], on: a)
    checks.check("cancelled touches type nothing when they lift", typed.isEmpty)

    checks.check("VoiceOver types a coordinated key", b.accessibilityActivate() && typed == ["b"])
    let plain = KeyButton(type: .custom)
    checks.check("an uncoordinated key keeps single-touch UIControl behaviour", !plain.isMultipleTouchEnabled)
  }

  /// Every visible key under `root`, in layout order.
  static func visibleKeys(in root: UIView) -> [KeyButton] {
    var keys = [KeyButton]()
    func collect(_ view: UIView) {
      guard !view.isHidden else { return }
      if let key = view as? KeyButton {
        keys.append(key)
        return
      }
      view.subviews.forEach(collect)
    }
    collect(root)
    return keys
  }

  /// Every typing key goes through the coordinator and nothing else; the globe
  /// stays a UIControl for the system input-mode menu.
  @MainActor
  static func checkKeyWiring(width: CGFloat, numbers: Bool, globe: Bool, _ checks: inout TouchChecks) {
    let controller = KeyboardViewController.makeLaidOutKeyboard(width: width, numbers: numbers, globe: globe)
    let layout = "\(Int(width)) pt \(numbers ? "numbers" : "letters")\(globe ? " with globe" : "")"
    let keys = visibleKeys(in: controller.touchTestRows)
    let typing = keys.filter { $0.accessibilityLabel != "Next keyboard" }
    checks.check(
      "\(layout): every typing key goes through the touch coordinator",
      typing.allSatisfy { $0.keyAction != nil && $0.touchCoordinator === controller.touchTestCoordinator }
    )
    checks.check("\(layout): no typing key still fires UIControl actions", typing.allSatisfy { $0.allTargets.isEmpty })
    // UIKit adds press-only focus recognizers to every button; only one that
    // takes touches (like the old delete long press) would compete with the keys.
    checks.check(
      "\(layout): no typing key keeps a touch gesture recognizer",
      typing.allSatisfy { key in
        (key.gestureRecognizers ?? []).allSatisfy { $0.allowedTouchTypes.isEmpty }
      }
    )
    if globe {
      let globeKey = keys.first { $0.accessibilityLabel == "Next keyboard" }
      checks.check(
        "\(layout): the globe key keeps the system input-mode menu",
        globeKey?.keyAction == nil && !(globeKey?.allTargets.isEmpty ?? true)
      )
    }
  }

  /// Coordinator activations reach the controller's handlers: shift as the
  /// finger lands, 123 on lift, and VoiceOver through accessibilityActivate.
  @MainActor
  static func checkKeyDispatch(_ checks: inout TouchChecks) {
    let controller = KeyboardViewController.makeLaidOutKeyboard(width: 393, numbers: false, globe: false)
    let keys = visibleKeys(in: controller.touchTestRows)
    guard let shift = keys.first(where: { $0.keyAction == .shift }),
          let mode = keys.first(where: { $0.keyAction == .layoutMode }) else {
      checks.check("shift and 123 keys exist", false)
      return
    }
    let finger = NSObject()
    let id = ObjectIdentifier(finger)
    let coordinator = controller.touchTestCoordinator

    let shiftBefore = controller.touchTestShiftEnabled
    coordinator.began(id, on: shift)
    checks.check("shift acts as the finger lands", controller.touchTestShiftEnabled != shiftBefore)
    coordinator.ended(id, on: shift)

    coordinator.began(id, on: mode)
    checks.check("123 waits for the lift", !controller.touchTestIsNumbers)
    coordinator.ended(id, on: mode)
    checks.check("123 switches to numbers on lift", controller.touchTestIsNumbers)
    checks.check("VoiceOver switches back to letters", mode.accessibilityActivate() && !controller.touchTestIsNumbers)
  }

  /// A keyboard rebuilt (rotation, width change) or hidden mid-touch must stop a
  /// held delete and leave no key lit: those touches may never end.
  @MainActor
  static func checkMidTouchTeardown(_ checks: inout TouchChecks) {
    let teardowns: [(String, (KeyboardViewController) -> Void)] = [
      ("rebuild", { $0.touchTestRebuild() }),
      ("dismiss", { $0.touchTestWillDisappear() }),
    ]
    for (label, teardown) in teardowns {
      let controller = KeyboardViewController.makeLaidOutKeyboard(width: 393, numbers: false, globe: false)
      guard let delete = visibleKeys(in: controller.touchTestRows).first(where: { $0.keyAction == .backspace }) else {
        checks.check("\(label): delete key exists", false)
        continue
      }
      let finger = NSObject()
      let coordinator = controller.touchTestCoordinator
      coordinator.repeatDelay = 0.05
      coordinator.began(ObjectIdentifier(finger), on: delete)
      RunLoop.main.run(until: Date().addingTimeInterval(0.2))
      checks.check("\(label): a held delete repeats before teardown", controller.touchTestDeleteRepeating)
      teardown(controller)
      checks.check("\(label) mid-touch stops a held delete", !controller.touchTestDeleteRepeating)
      checks.check("\(label) mid-touch leaves delete unlit", !delete.isHighlighted)
    }
  }
}
