// The runner appends this to KeyboardViewController.swift so private production
// types remain private while the tests exercise the actual UIKit implementation.
private extension KeyboardViewController {
  static func makeTouchTestStack() -> UIStackView {
    KeyboardViewController().keyboardRowsStack
  }
}

@main
private enum KeyboardTouchTests {
  @MainActor
  static func main() {
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
    var failures = [String]()
    var checks = 0

    func expect(_ label: String, _ point: CGPoint, _ expected: UIView?) {
      checks += 1
      let actual = stack.hitTest(point, with: nil)
      if actual !== expected {
        failures.append(label)
        print("FAIL: \(label)")
      }
    }

    expect("key center", CGPoint(x: 20, y: 20), topLeft)
    expect("row gap closer to upper key", CGPoint(x: 20, y: 45), topLeft)
    expect("row gap closer to lower key", CGPoint(x: 20, y: 50), bottomLeft)
    expect("horizontal gap closer to left", CGPoint(x: 49, y: 20), topLeft)
    expect("horizontal gap closer to right", CGPoint(x: 51, y: 20), topRight)

    // UIKit visits later siblings first. Expanded target overlap must not steal
    // a tap from a visibly closer key solely because it was added last.
    topLeft.hitTestOutsets.right = 8
    topRight.hitTestOutsets.left = 8
    expect("visible left edge beats overlapping right target", CGPoint(x: 46, y: 20), topLeft)
    expect("visible right edge beats overlapping left target", CGPoint(x: 54, y: 20), topRight)
    expect("overlapping gap chooses nearer left", CGPoint(x: 49, y: 20), topLeft)
    expect("overlapping gap chooses nearer right", CGPoint(x: 51, y: 20), topRight)

    // A hidden layout sits above the visible one in the production hierarchy.
    let hiddenRow = UIView(frame: topRow.frame)
    let hiddenKey = KeyButton(type: .custom)
    hiddenKey.frame = topLeft.frame
    hiddenRow.addSubview(hiddenKey)
    hiddenRow.isHidden = true
    stack.addSubview(hiddenRow)
    expect("hidden layout never steals a gap", CGPoint(x: 20, y: 45), topLeft)
    hiddenRow.isHidden = false
    hiddenRow.alpha = 0
    expect("transparent layout never steals a gap", CGPoint(x: 20, y: 45), topLeft)
    hiddenRow.alpha = 1
    hiddenRow.isUserInteractionEnabled = false
    expect("noninteractive layout never steals a gap", CGPoint(x: 20, y: 45), topLeft)

    topLeft.isEnabled = false
    checks += 1
    if stack.hitTest(CGPoint(x: 20, y: 45), with: nil) === topLeft {
      failures.append("disabled key")
    }
    topLeft.isEnabled = true

    expect("outside rows does not capture dictation-strip taps", CGPoint(x: 20, y: -1), nil)
    expect("outside right boundary", CGPoint(x: 101, y: 20), nil)
    stack.isHidden = true
    expect("hidden keyboard", CGPoint(x: 20, y: 20), nil)
    stack.isHidden = false
    stack.isUserInteractionEnabled = false
    expect("disabled keyboard interaction", CGPoint(x: 20, y: 20), nil)
    stack.isUserInteractionEnabled = true

    // The third row adds another letters stack between shift and backspace.
    let nested = UIStackView(frame: topLeft.frame)
    topLeft.removeFromSuperview()
    topRow.subviews[0].addSubview(nested)
    topLeft.frame = nested.bounds
    nested.addSubview(topLeft)
    expect("nested third-row key receives a gap tap", CGPoint(x: 20, y: 45), topLeft)

    // Exercise every row-gap pixel that lies in an expanded key target.
    for y in 42...52 {
      let expected = y <= 47 ? topLeft : bottomLeft
      expect("continuous row target at y=\(y)", CGPoint(x: 20, y: CGFloat(y)), expected)
    }

    print("Keyboard touch routing: \(checks - failures.count)/\(checks) passed")
    precondition(failures.isEmpty, failures.joined(separator: ", "))
  }
}
