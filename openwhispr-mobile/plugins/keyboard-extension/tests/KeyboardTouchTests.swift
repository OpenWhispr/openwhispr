// The runner appends this to KeyboardViewController.swift so private production
// types remain private while the tests exercise the actual UIKit implementation.

/// What the keyboard reads from iOS, stubbed: Mac Catalyst, where these tests run, is an
/// iPad in regular size classes with no text field behind the keyboard.
@MainActor
private enum TestEnvironment {
  /// needsInputModeSwitchKey: true on iPhones with a Home button.
  static var globe = false
  /// A compact vertical size class: a phone in landscape.
  static var landscape = false
  static var tablet = false
  // Layout and touch-routing checks exercise the keyboard, not the permissions
  // overlay. Permission-specific checks explicitly show and dismiss that panel.
  static var fullAccess = true
  static var proxy = TestTextProxy()

  static func install() {
    func stub(_ cls: AnyClass, _ selector: Selector, _ block: Any) {
      method_setImplementation(class_getInstanceMethod(cls, selector)!, imp_implementationWithBlock(block))
    }
    let globeStub: @convention(block) (AnyObject) -> Bool = { _ in MainActor.assumeIsolated { globe } }
    stub(UIInputViewController.self, #selector(getter: UIInputViewController.needsInputModeSwitchKey), globeStub)
    let fullAccessStub: @convention(block) (AnyObject) -> Bool = { _ in MainActor.assumeIsolated { fullAccess } }
    stub(UIInputViewController.self, #selector(getter: UIInputViewController.hasFullAccess), fullAccessStub)
    let proxyStub: @convention(block) (AnyObject) -> AnyObject = { _ in MainActor.assumeIsolated { proxy } }
    stub(UIInputViewController.self, #selector(getter: UIInputViewController.textDocumentProxy), proxyStub)
    let sizeClassStub: @convention(block) (AnyObject) -> UIUserInterfaceSizeClass = { _ in
      MainActor.assumeIsolated { landscape ? .compact : .regular }
    }
    stub(UITraitCollection.self, #selector(getter: UITraitCollection.verticalSizeClass), sizeClassStub)
    let idiomStub: @convention(block) (AnyObject) -> UIUserInterfaceIdiom = { _ in
      MainActor.assumeIsolated { tablet ? .pad : .phone }
    }
    stub(UIDevice.self, #selector(getter: UIDevice.userInterfaceIdiom), idiomStub)
  }

  static func reset() {
    globe = false
    landscape = false
    tablet = false
    fullAccess = true
    proxy = TestTextProxy()
  }
}

/// The field behind the keyboard.
private final class TestTextProxy: NSObject, UITextDocumentProxy {
  var documentContextBeforeInput: String?
  var documentContextAfterInput: String?
  var selectedText: String?
  var documentInputMode: UITextInputMode?
  var documentIdentifier = UUID()
  var hasText = false
  var keyboardType: UIKeyboardType = .default
  var returnKeyType: UIReturnKeyType = .default
  var enablesReturnKeyAutomatically = false
  var autocapitalizationType: UITextAutocapitalizationType = .sentences
  var smartQuotesType: UITextSmartQuotesType = .default
  var isSecureTextEntry = false
  private(set) var inserted = [String]()

  func adjustTextPosition(byCharacterOffset offset: Int) {}
  func setMarkedText(_ markedText: String, selectedRange: NSRange) {}
  func unmarkText() {}
  func insertText(_ text: String) { inserted.append(text) }
  func deleteBackward() {}
}

private enum TestPage {
  case letters, numbers, symbols
}

private extension KeyboardHandoffProvider {
  var touchTestDefaults: UserDefaults? { UserDefaults(suiteName: appGroupId) }
}

private extension KeyboardViewController {
  static func makeTouchTestStack() -> UIStackView {
    KeyboardViewController().keyboardRowsStack
  }

  /// The production keyboard laid out at `width` and its content height (or `height`), in
  /// the stubbed TestEnvironment.
  static func makeLaidOutKeyboard(width: CGFloat, page: TestPage = .letters, height: CGFloat? = nil)
    -> KeyboardViewController
  {
    let controller = KeyboardViewController()
    controller.loadViewIfNeeded()
    if page != .letters {
      controller.handleModeKeyTapped()
    }
    if page == .symbols {
      controller.handlePageKeyTapped()
    }
    // The first pass picks the metrics for `width`; the second sizes the view to its rows.
    controller.view.frame = CGRect(x: 0, y: 0, width: width, height: 400)
    controller.view.layoutIfNeeded()
    let fittedHeight = controller.view.systemLayoutSizeFitting(
      CGSize(width: width, height: 0),
      withHorizontalFittingPriority: .required,
      verticalFittingPriority: .fittingSizeLevel
    ).height
    controller.view.frame = CGRect(x: 0, y: 0, width: width, height: height ?? fittedHeight)
    controller.view.layoutIfNeeded()
    return controller
  }

  @MainActor
  static func checkMinimalKeyboardHeight(
    _ checks: inout TouchChecks, width: CGFloat, globe: Bool = false, landscape: Bool = false
  ) {
    TestEnvironment.reset()
    defer { TestEnvironment.reset() }
    TestEnvironment.globe = globe
    TestEnvironment.landscape = landscape
    TestEnvironment.fullAccess = true
    guard let defaults = KeyboardHandoffProvider.shared.touchTestDefaults else {
      checks.check("minimal keyboard has an App Group store", false)
      return
    }
    let keys = ["keyboard_dictation_tone", "keyboard_tone_applicable", "keyboard_minimal_enabled"]
    let saved = keys.map { defaults.object(forKey: $0) }
    let animationsEnabled = UIView.areAnimationsEnabled
    UIView.setAnimationsEnabled(false)
    defer {
      for (key, value) in zip(keys, saved) {
        if let value { defaults.set(value, forKey: key) }
        else { defaults.removeObject(forKey: key) }
      }
      defaults.synchronize()
      UIView.setAnimationsEnabled(animationsEnabled)
    }
    defaults.set("default", forKey: "keyboard_dictation_tone")
    defaults.set("1", forKey: "keyboard_tone_applicable")
    defaults.set("1", forKey: "keyboard_minimal_enabled")
    defaults.synchronize()
    let controller = makeLaidOutKeyboard(width: width)
    // Mirror the host adopting preferredContentSize after each layout transition.
    func layout() {
      controller.view.frame.size.height = controller.preferredContentSize.height
      controller.view.setNeedsLayout()
      controller.view.layoutIfNeeded()
    }
    func frameInKeyboard(_ view: UIView) -> CGRect {
      view.convert(view.bounds, to: controller.view)
    }
    func checkTappable(_ label: String, _ button: UIButton) {
      let frame = frameInKeyboard(button)
      checks.check("\(label) stays inside keyboard", controller.view.bounds.contains(frame))
      let target = controller.view.hitTest(CGPoint(x: frame.midX, y: frame.midY), with: nil)
      checks.check("\(label) receives touches", target === button || target?.isDescendant(of: button) == true)
    }
    controller.minimalKeyboardEnabled = true
    controller.keyboardRowsStack.isHidden = true
    controller.applyRootPadding()
    controller.applyKeyboardHeight()
    let compactHeight = controller.typingLayoutHeight
    checks.check("minimal toolbar is shorter than typing layout", compactHeight < controller.metrics.keyboardHeight)
    checks.check("uncreated permissions panel does not reserve height",
      !controller.didSetupFullAccessPanel && controller.keyboardHeightConstraint?.constant == compactHeight)
    checks.check("host receives compact preferred height", controller.preferredContentSize.height == compactHeight)

    controller.showFullAccessPanel(animated: false)
    layout()
    checks.check("visible permissions panel expands keyboard",
      controller.view.bounds.height == controller.metrics.keyboardHeight)
    controller.hideFullAccessPanel(animated: false)
    layout()
    checks.check("dismissed permissions panel restores compact height",
      controller.view.bounds.height == compactHeight)
    if globe { checkTappable("minimal globe", controller.minimalGlobeButton) }

    controller.showRecordingCanvas()
    layout()
    checks.check("minimal recording frame stays compact", controller.view.bounds.height == compactHeight)
    checkTappable("compact cancel", controller.recordingCancelButton)
    checkTappable("compact confirm", controller.recordingConfirmButton)
    checks.check("compact waveform uses the full-size dictation color",
      controller.recordingWaveformBars.allSatisfy { $0.backgroundColor == Palette.accent })
    checks.check("compact waveform stays inside its pill",
      frameInKeyboard(controller.recordingPill).contains(frameInKeyboard(controller.recordingWaveformStack)))
    checks.check("minimal recording keeps compact height",
      controller.keyboardHeightConstraint?.constant == compactHeight)
    checks.check("minimal recording shows waveform pill without caption",
      !controller.recordingPill.isHidden && controller.recordingCaptionLabel.isHidden)
    checks.check("minimal recording uses toolbar-aligned controls",
      controller.compactRecordingConstraints.allSatisfy { $0.isActive }
        && controller.regularRecordingConstraints.allSatisfy { !$0.isActive })
    controller.isAgentRecordingActive = true
    controller.configureRecordingLayout()
    checks.check("compact agent waveform retains the full-size agent color",
      controller.recordingWaveformBars.allSatisfy { $0.backgroundColor == Palette.cleanupAccent })
    controller.isAgentRecordingActive = false
    controller.configureRecordingLayout()
    controller.hideRecordingCanvas()
    layout()
    checks.check("ending recording restores compact height",
      controller.keyboardHeightConstraint?.constant == compactHeight)

    // This headless UIKit executable has no UIApplication event loop. Check
    // target/action wiring, then invoke the same production handler directly.
    checks.check("tone button is wired to compact menu handler",
      controller.toneButton.actions(forTarget: controller, forControlEvent: .touchUpInside)?
        .contains("handleCompactToneTapped") == true)
    controller.handleCompactToneTapped()
    layout()
    checks.check("tone menu expands minimal keyboard",
      controller.view.bounds.height == compactHeight + Self.compactToneMenuHeight
        && !controller.compactToneMenu.isHidden)
    let formal = controller.compactToneMenu.arrangedSubviews.compactMap { $0 as? UIButton }
      .first { $0.title(for: .normal) == "Formal" }
    checks.check("compact menu offers the formal tone", formal != nil)
    if let formal {
      checkTappable("formal tone", formal)
      controller.selectCompactTone("formal")
    }
    layout()
    checks.check("tone selection persists to App Group",
      KeyboardHandoffProvider.shared.currentTone() == "formal")
    checks.check("tone selection collapses keyboard",
      controller.view.bounds.height == compactHeight && controller.compactToneMenu.isHidden)

    controller.handleCompactToneTapped()
    controller.handleCompactToneTapped()
    layout()
    checks.check("tapping tone icon again collapses keyboard",
      controller.view.bounds.height == compactHeight && controller.compactToneMenu.isHidden)

    controller.handleCompactToneTapped()
    controller.viewWillDisappear(false)
    // The same preference refresh runs when this controller reappears.
    controller.refreshMinimalKeyboardPreference()
    layout()
    checks.check("leaving and reopening keyboard dismisses tone menu",
      !controller.isCompactToneMenuShown && controller.compactToneMenu.isHidden
        && controller.view.bounds.height == compactHeight)

    controller.touchTestShowAgentResult()
    layout()
    checks.check("agent review expands compact keyboard",
      controller.view.bounds.height == controller.metrics.keyboardHeight + Metrics.agentReviewExtraHeight)
    checks.check("review text stays inside keyboard",
      controller.view.bounds.contains(frameInKeyboard(controller.agentReviewTextView)))
    controller.hideAgentReviewCard()
    layout()
    checks.check("dismissing review restores compact frame", controller.view.bounds.height == compactHeight)

    controller.minimalKeyboardEnabled = false
    controller.keyboardRowsStack.isHidden = false
    controller.minimalGlobeButton.isHidden = true
    controller.applyRootPadding()
    controller.showRecordingCanvas()
    layout()
    checkTappable("regular cancel", controller.recordingCancelButton)
    checkTappable("regular confirm", controller.recordingConfirmButton)
    checks.check("regular waveform retains dictation color",
      controller.recordingWaveformBars.allSatisfy { $0.backgroundColor == Palette.accent })
    checks.check("regular recording retains full canvas",
      controller.recordingPill.isHidden && !controller.recordingCaptionLabel.isHidden
        && controller.regularRecordingConstraints.allSatisfy { $0.isActive })
    checks.check("disabling minimal layout restores full height",
      controller.keyboardHeightConstraint?.constant == controller.metrics.keyboardHeight)
  }

  var touchTestRows: KeyboardRowsStack { keyboardRowsStack }
  var touchTestRowHeight: CGFloat { metrics.keyHeight }
  var touchTestPadding: (side: CGFloat, bottom: CGFloat) {
    (metrics.sideMargin, metrics.bottomPadding)
  }
  var touchTestIsLandscape: Bool { metrics == .landscape }
  var touchTestIsTablet: Bool { metrics == .tablet }
  var touchTestLandscapeKeyHeight: CGFloat { KeyboardMetrics.landscape.keyHeight }
  var touchTestKeyboardHeight: CGFloat { metrics.keyboardHeight }
  var touchTestStripTop: CGFloat { metrics.stripTop }
  var touchTestReviewExtraHeight: CGFloat { Metrics.agentReviewExtraHeight }
  var touchTestHeightConstant: CGFloat? { keyboardHeightConstraint?.constant }
  var touchTestLetters: [KeyButton] { characterButtons }
  var touchTestReturn: KeyButton { returnButton! }
  var touchTestShortcuts: [String] { shortcutButtons.filter { !$0.isHidden }.compactMap(\.output) }
  var touchTestShift: Bool { isShiftEnabled }
  var touchTestBuiltWithGlobe: Bool { keysBuiltWithGlobe }
  var touchTestToolbar: UIView { topBar }
  func touchTestShowReviewCard(_ shown: Bool) {
    isAgentReviewShown = shown
    applyKeyboardHeight()
  }
  func touchTestShowAgentResult() {
    showAgentReviewCard(AgentResult(versions: ["Hi"], activeIndex: 0, sessionId: "s", jobId: "j", updatedAtMs: nil))
  }
  func touchTestRegenerate() { enterAgentRegenerating(minUpdatedAtMs: 0) }
  func touchTestAgentError() { handleAgentError(detail: nil) }
  func touchTestEndCardAction() {
    stopWaitingForAgentResult()
    isAgentGenerating = false
    isAgentActionInFlight = false
  }
  func touchTestDismissCard() { hideAgentReviewCard() }
  func touchTestTextDidChange() { textDidChange(nil) }
  func touchTestInsertTranscript(_ text: String) { insertSmartText(text) }
  func touchTestTapLetter(_ index: Int) { handleCharacterKeyTapped(characterButtons[index]) }
  func touchTestTapReturn() { handleReturnTapped() }
  func touchTestTapDelete() { handleBackspaceTapped() }
  func touchTestTapMode() { handleModeKeyTapped() }
  func touchTestQuote(_ character: String) -> String? { smartQuoteSubstitution(for: character) }
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
    TestEnvironment.install()
    // Opt-in fast path for iterating on compact-layout transitions; CI runs
    // the complete suite unless this is explicitly requested.
    if ProcessInfo.processInfo.environment["KEYBOARD_MINIMAL_ONLY"] == "1" {
      KeyboardViewController.checkMinimalKeyboardHeight(&checks, width: 402)
      KeyboardViewController.checkMinimalKeyboardHeight(&checks, width: 375, globe: true)
      KeyboardViewController.checkMinimalKeyboardHeight(&checks, width: 852, landscape: true)
      print("Minimal keyboard: \(checks.count - checks.failures.count)/\(checks.count) passed")
      exit(checks.failures.isEmpty ? 0 : 1)
    }
    checkSyntheticRows(&checks)
    checkEdgeTies(&checks)
    checkOtherControls(&checks)
    // iPhone widths in portrait: Display Zoom, SE and mini, 16, 17 Pro, Plus, Pro Max.
    for width: CGFloat in [360, 375, 393, 402, 430, 440] {
      checkProductionLayout("portrait", width: width, &checks)
      checkProductionLayout("portrait", width: width, page: .numbers, &checks)
      checkProductionLayout("portrait with globe", width: width, globe: true, &checks)
    }
    checkProductionLayout("portrait", width: 402, page: .symbols, &checks)
    for width: CGFloat in [852, 956] {
      checkProductionLayout("landscape", width: width, landscape: true, &checks)
      checkProductionLayout("landscape", width: width, page: .numbers, landscape: true, &checks)
    }
    checkProductionLayout("landscape with globe", width: 667, globe: true, landscape: true, &checks)
    checkProductionLayout("iPad", width: 1024, tablet: true, &checks)
    checkProductionLayout("iPad floating", width: 320, tablet: true, &checks)
    let fieldTypes: [(UIKeyboardType, String)] = [(.URL, "URL"), (.emailAddress, "email"), (.webSearch, "web search"), (.twitter, "twitter")]
    for (type, name) in fieldTypes {
      let proxy = TestTextProxy()
      proxy.keyboardType = type
      checkProductionLayout("\(name) field", width: 402, proxy: proxy, &checks)
      checkProductionLayout("\(name) field landscape", width: 852, landscape: true, proxy: proxy, &checks)
    }
    // Return sits beside space, ".com" and "." in these.
    for (type, name) in [(UIKeyboardType.default, "text"), (.URL, "URL"), (.webSearch, "web search")] {
      checkProductionLayout("greyed return, \(name) field", width: 402, proxy: emptySearchField(type), &checks)
    }
    checkFieldAwareKeys(&checks)
    checkLayoutChanges(&checks)
    KeyboardViewController.checkMinimalKeyboardHeight(&checks, width: 402)
    KeyboardViewController.checkMinimalKeyboardHeight(&checks, width: 375, globe: true)
    KeyboardViewController.checkMinimalKeyboardHeight(&checks, width: 852, landscape: true)
    checkTyping(&checks)

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
    _ name: String,
    width: CGFloat,
    page: TestPage = .letters,
    globe: Bool = false,
    landscape: Bool = false,
    tablet: Bool = false,
    proxy: TestTextProxy? = nil,
    _ checks: inout TouchChecks
  ) {
    TestEnvironment.reset()
    defer { TestEnvironment.reset() }
    TestEnvironment.globe = globe
    TestEnvironment.landscape = landscape
    TestEnvironment.tablet = tablet
    TestEnvironment.proxy = proxy ?? TestTextProxy()
    let controller = KeyboardViewController.makeLaidOutKeyboard(width: width, page: page)
    let rows = controller.touchTestRows
    let layout = "\(Int(width)) pt \(name) \(page)"
    checks.check(
      "\(layout): landscape metrics exactly in landscape",
      (controller.touchTestIsLandscape) == landscape
    )

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
    // Layout rounds a half-point margin (6.5pt) to the pixel grid: half a pixel either way.
    // These views have no screen, so a pixel is a whole point here.
    let rounding = 0.5 / max(root.contentScaleFactor, 1) + 0.01
    checks.check(
      "\(layout): rows keep the keyboard's padding",
      abs(rows.frame.minX - padding.side) <= rounding
        && abs(root.bounds.maxX - rows.frame.maxX - padding.side) <= rounding
        && abs(root.bounds.maxY - rows.frame.maxY - padding.bottom) <= rounding
    )
    let top = (strip.frame.maxY + rows.frame.minY) / 2
    let visibleKeys = Set(keys.map(ObjectIdentifier.init))
    var dropped = 0
    var hiddenHits = 0
    for y in stride(from: top, to: root.bounds.height, by: 1) {
      // UIKit produces autoreleased objects during hit testing. Bound their
      // lifetime while checking every half-point across the entire keyboard.
      autoreleasepool {
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
    }
    checks.check("\(layout): no tap below the dictation strip is dropped (\(dropped))", dropped == 0)
    checks.check("\(layout): no tap reaches a hidden key (\(hiddenHits))", hiddenHits == 0)

    let stripHalf = CGPoint(x: root.bounds.midX, y: top - 0.5)
    checks.check("\(layout): the strip's half of the gap takes no key taps", !(root.hitTest(stripHalf, with: nil) is KeyButton))
  }

  /// An empty search field whose return key greys until something is typed.
  @MainActor
  static func emptySearchField(_ type: UIKeyboardType) -> TestTextProxy {
    let proxy = TestTextProxy()
    proxy.keyboardType = type
    proxy.returnKeyType = .search
    proxy.enablesReturnKeyAutomatically = true
    return proxy
  }

  /// The return key and the bottom row follow the field.
  @MainActor
  static func checkFieldAwareKeys(_ checks: inout TouchChecks) {
    TestEnvironment.reset()
    defer { TestEnvironment.reset() }

    // A greyed return key keeps its taps and does nothing with them, as Apple's does.
    let proxy = emptySearchField(.default)
    TestEnvironment.proxy = proxy
    let controller = KeyboardViewController.makeLaidOutKeyboard(width: 402)
    let rows = controller.touchTestRows
    let returnKey = controller.touchTestReturn
    let returnRect = returnKey.convert(returnKey.bounds, to: rows)
    let edgeHits = stride(from: returnRect.minX + 1, to: returnRect.maxX, by: 1).filter {
      rows.hitTest(CGPoint(x: $0, y: returnRect.midY), with: nil) !== returnKey
    }
    checks.check("greyed return: its whole face is its own (\(edgeHits.count) elsewhere)", edgeHits.isEmpty)
    controller.touchTestTapReturn()
    checks.check("greyed return: a tap types nothing", proxy.inserted.isEmpty)
    proxy.hasText = true
    controller.touchTestTapReturn()
    checks.check("return types a newline once the field has text", proxy.inserted == ["\n"])
    // Emptied again by the user: greyed again.
    proxy.hasText = false
    proxy.documentContextBeforeInput = ""
    controller.touchTestTextDidChange()
    controller.touchTestTapReturn()
    checks.check("return greys again once the field is empty", proxy.inserted == ["\n"])

    // A host that never reports its text: once something was typed, return still works.
    let hidden = emptySearchField(.default)
    TestEnvironment.proxy = hidden
    let hiddenKeyboard = KeyboardViewController.makeLaidOutKeyboard(width: 402)
    hiddenKeyboard.touchTestTapLetter(0)
    hiddenKeyboard.touchTestTextDidChange()
    hiddenKeyboard.touchTestTapReturn()
    checks.check("field that hides its text: return types a newline", hidden.inserted == ["Q", "\n"])

    // Twitter: @ and # in place of return on letters; Apple's usual row on 123 and #+=.
    let twitter = TestTextProxy()
    twitter.keyboardType = .twitter
    TestEnvironment.proxy = twitter
    let twitterKeyboard = KeyboardViewController.makeLaidOutKeyboard(width: 402)
    let shortcuts = { twitterKeyboard.touchTestShortcuts }
    checks.check("twitter letters: @ and #", shortcuts() == ["@", "#"])
    checks.check("twitter letters: no return", twitterKeyboard.touchTestReturn.isHidden)
    twitterKeyboard.touchTestTapMode()
    twitterKeyboard.view.layoutIfNeeded()
    checks.check("twitter 123: return", !twitterKeyboard.touchTestReturn.isHidden && shortcuts().isEmpty)
    twitterKeyboard.touchTestTapMode()
    checks.check("twitter back on letters: @ and # again", shortcuts() == ["@", "#"])
  }

  /// Layout follows rotation, the globe key, the real width, a short view and the review card.
  @MainActor
  static func checkLayoutChanges(_ checks: inout TouchChecks) {
    TestEnvironment.reset()
    defer { TestEnvironment.reset() }

    func layout(_ controller: KeyboardViewController, width: CGFloat, height: CGFloat) {
      controller.view.frame = CGRect(x: 0, y: 0, width: width, height: height)
      controller.view.setNeedsLayout()
      controller.view.layoutIfNeeded()
    }

    // Rotation lays out at the new width before the size class flips; the flip alone must
    // still bring the landscape keys.
    let rotated = KeyboardViewController.makeLaidOutKeyboard(width: 852)
    checks.check("852pt with a regular size class: portrait metrics", !rotated.touchTestIsLandscape)
    TestEnvironment.landscape = true
    layout(rotated, width: 852, height: rotated.view.bounds.height)
    checks.check("size class flip alone: landscape metrics", rotated.touchTestIsLandscape)
    checks.check(
      "size class flip alone: rows rebuilt at landscape height",
      abs(rotated.touchTestLetters[0].bounds.height - rotated.touchTestLandscapeKeyHeight) < 0.5
    )
    TestEnvironment.landscape = false

    // needsInputModeSwitchKey settling after the keys were built brings the globe key.
    let settling = KeyboardViewController.makeLaidOutKeyboard(width: 375)
    checks.check("no globe key while needsInputModeSwitchKey is false", !settling.touchTestBuiltWithGlobe)
    TestEnvironment.globe = true
    layout(settling, width: 375, height: settling.view.bounds.height)
    checks.check("needsInputModeSwitchKey turning true rebuilds with the globe key", settling.touchTestBuiltWithGlobe)
    TestEnvironment.globe = false

    // The same on an iPad, where the globe key doesn't change the metrics.
    TestEnvironment.tablet = true
    let settlingTablet = KeyboardViewController.makeLaidOutKeyboard(width: 1024)
    TestEnvironment.globe = true
    layout(settlingTablet, width: 1024, height: settlingTablet.view.bounds.height)
    checks.check("iPad: needsInputModeSwitchKey turning true rebuilds with the globe key", settlingTablet.touchTestBuiltWithGlobe)
    TestEnvironment.globe = false
    TestEnvironment.tablet = false

    // Keys are first built against the screen's width; their reach follows the real one. In
    // landscape the metrics don't change with the width, so nothing rebuilds the keys.
    TestEnvironment.landscape = true
    let narrow = KeyboardViewController.makeLaidOutKeyboard(width: 812)
    let keyWidth = narrow.touchTestLetters[0].bounds.width
    checks.check(
      "touch reach follows the laid-out key width (\(narrow.touchTestLetters[0].hitTestOutsets.left) vs \(keyWidth))",
      abs(narrow.touchTestLetters[0].hitTestOutsets.left - keyWidth) < 0.5
    )
    TestEnvironment.landscape = false

    // A view shorter than the keyboard keeps the toolbar on screen.
    let short = KeyboardViewController.makeLaidOutKeyboard(width: 402, height: 200)
    let toolbar = short.touchTestToolbar.convert(short.touchTestToolbar.bounds, to: short.view)
    checks.check("short view: toolbar stays on screen (top \(toolbar.minY))", toolbar.minY >= -0.5)

    // The review card grows the keyboard while it shows, and gives the height back.
    let card = KeyboardViewController.makeLaidOutKeyboard(width: 402)
    let keyboardHeight = card.touchTestKeyboardHeight
    card.touchTestShowReviewCard(true)
    checks.check(
      "review card: keyboard 40pt taller",
      card.touchTestHeightConstant == keyboardHeight + card.touchTestReviewExtraHeight
    )
    card.touchTestShowReviewCard(false)
    checks.check("review card gone: Apple's height again", card.touchTestHeightConstant == keyboardHeight)

    // A regenerate keeps the card's height while it writes, through an error and back.
    let cardHeight = keyboardHeight + card.touchTestReviewExtraHeight
    // Only a layout the keyboard asked for, as iOS runs it.
    func height() -> CGFloat? {
      card.view.layoutIfNeeded()
      return card.touchTestHeightConstant
    }
    card.touchTestShowAgentResult()
    card.touchTestRegenerate()
    checks.check("regenerating: the card's height stays", height() == cardHeight)
    card.touchTestAgentError()
    checks.check("regenerate failed: card back at its height", height() == cardHeight)
    card.touchTestRegenerate()
    card.touchTestEndCardAction()
    checks.check("action over without the card: Apple's height again", height() == keyboardHeight)
    card.touchTestShowAgentResult()
    card.touchTestDismissCard()
    checks.check("card dismissed: Apple's height again", height() == keyboardHeight)

    // A docked iPad keyboard keeps the height it had before the rebuild.
    TestEnvironment.tablet = true
    let tablet = KeyboardViewController.makeLaidOutKeyboard(width: 1024)
    checks.check("iPad: 309pt, with a gap above the toolbar", tablet.touchTestIsTablet && tablet.touchTestKeyboardHeight == 309 && tablet.touchTestStripTop > 0)
    let floating = KeyboardViewController.makeLaidOutKeyboard(width: 320)
    checks.check("floating iPad keyboard: phone metrics", !floating.touchTestIsTablet)
  }

  /// Shift, delete and quotes.
  @MainActor
  static func checkTyping(_ checks: inout TouchChecks) {
    TestEnvironment.reset()
    defer { TestEnvironment.reset() }

    // A host that never reports its text: shift still ends after one letter.
    let silent = TestTextProxy()
    TestEnvironment.proxy = silent
    let keyboard = KeyboardViewController.makeLaidOutKeyboard(width: 402)
    checks.check("empty sentence field starts in shift", keyboard.touchTestShift)
    keyboard.touchTestTapLetter(0)
    checks.check("shift ends after a letter without document context", !keyboard.touchTestShift && silent.inserted == ["Q"])
    // Nor does anything else turn it back on mid-word there.
    keyboard.touchTestTextDidChange()
    checks.check("no document context: textDidChange leaves shift off", !keyboard.touchTestShift)
    keyboard.touchTestTapDelete()
    checks.check("no document context: delete leaves shift off", !keyboard.touchTestShift)
    keyboard.touchTestInsertTranscript("hello")
    checks.check("no document context: a transcript leaves shift off", !keyboard.touchTestShift)

    // A field that reports it has text, but none around the cursor.
    let opaque = TestTextProxy()
    opaque.hasText = true
    TestEnvironment.proxy = opaque
    let opaqueKeyboard = KeyboardViewController.makeLaidOutKeyboard(width: 402)
    opaqueKeyboard.touchTestTapLetter(0)
    opaqueKeyboard.touchTestTapDelete()
    checks.check("text not reported around the cursor: delete leaves shift off", !opaqueKeyboard.touchTestShift)

    // All capitals keeps shift on.
    let capitals = TestTextProxy()
    capitals.autocapitalizationType = .allCharacters
    TestEnvironment.proxy = capitals
    let capitalsKeyboard = KeyboardViewController.makeLaidOutKeyboard(width: 402)
    capitalsKeyboard.touchTestTapLetter(0)
    checks.check("all-capitals field keeps shift after a letter", capitalsKeyboard.touchTestShift)

    // Deleting back to a sentence start turns shift on.
    let deleting = TestTextProxy()
    deleting.documentContextBeforeInput = "Hello. W"
    TestEnvironment.proxy = deleting
    let deletingKeyboard = KeyboardViewController.makeLaidOutKeyboard(width: 402)
    // Shift follows the field when the keyboard shows, whether or not textDidChange comes.
    deletingKeyboard.viewWillAppear(false)
    checks.check("opening mid-word: shift off", !deletingKeyboard.touchTestShift)
    deleting.documentContextBeforeInput = "Hello. "
    deletingKeyboard.touchTestTapDelete()
    checks.check("delete back to a sentence start: shift on", deletingKeyboard.touchTestShift)

    // Smart quotes where the field allows them; straight in addresses, URLs and passwords.
    func quote(_ configure: (TestTextProxy) -> Void) -> String? {
      let proxy = TestTextProxy()
      configure(proxy)
      TestEnvironment.proxy = proxy
      return KeyboardViewController.makeLaidOutKeyboard(width: 402).touchTestQuote("'")
    }
    checks.check("default field: curly apostrophe", quote { _ in } == "\u{2018}")
    checks.check("email field: straight apostrophe", quote { $0.keyboardType = .emailAddress } == nil)
    checks.check("URL field: straight apostrophe", quote { $0.keyboardType = .URL } == nil)
    checks.check("password field: straight apostrophe", quote { $0.isSecureTextEntry = true } == nil)
    checks.check("smart quotes off: straight apostrophe", quote { $0.smartQuotesType = .no } == nil)
    checks.check(
      "smart quotes on in an email field: curly",
      quote { $0.keyboardType = .emailAddress; $0.smartQuotesType = .yes } == "\u{2018}"
    )
  }
}
