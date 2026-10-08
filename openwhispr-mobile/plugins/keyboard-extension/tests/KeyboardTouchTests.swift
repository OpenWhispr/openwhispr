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
    for width: CGFloat in [360, 393, 430, 852] {
      checkProductionLayout(width: width, numbers: false, globe: false, &checks)
      checkProductionLayout(width: width, numbers: true, globe: false, &checks)
      checkProductionLayout(width: width, numbers: false, globe: true, &checks)
    }

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

    var keys = [KeyButton]()
    func collect(_ view: UIView) {
      guard !view.isHidden else { return }
      if let key = view as? KeyButton {
        keys.append(key)
        return
      }
      view.subviews.forEach(collect)
    }
    collect(rows)
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
}
