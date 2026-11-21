// Appended after KeyboardTouchTests.swift by the runner: the typing-help features on the real
// controller (autocorrect, suggestions, layouts, trackpad, haptics, emoji, number pad, swipe),
// and the screenshot renderer.

private let typingResources = URL(fileURLWithPath: #filePath)
  .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("ios/Resources")

private extension KeyboardViewController {
  func uiTestKey(_ letter: Character) -> KeyButton? {
    characterButtons.first { $0.output == String(letter) }
  }

  /// Types through the same handlers the keys call. Letters go through their keys (so
  /// shift applies); everything else is typed as its key would type it.
  func uiTestType(_ text: String) {
    for character in text {
      if character == " " {
        handleSpaceTapped()
      } else if let key = uiTestKey(Character(character.lowercased())), character.isLetter {
        let wantsUpper = character.isUppercase
        if wantsUpper != isShiftEnabled, !isCapsLocked { handleShiftTapped() }
        handleCharacterKeyTapped(key)
      } else {
        typeText(String(character))
        refreshAfterEdit()
      }
    }
    uiTestPump()
  }

  /// Lets the coalesced suggestion refresh run.
  func uiTestPump() { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }

  var uiTestSuggestions: [Suggestion] { suggestionBar.suggestions }
  var uiTestStripShowsSuggestions: Bool { isSuggestionBarShown && !suggestionBar.isHidden }
  var uiTestPillFrame: CGRect {
    // Off-window, a constraint change inside the toolbar isn't laid out until asked.
    topBar.layoutIfNeeded()
    return recordButton.convert(recordButton.bounds, to: view)
  }
  var uiTestToneFrame: CGRect { toneButton.convert(toneButton.bounds, to: view) }
  var uiTestBarFrame: CGRect { suggestionBar.convert(suggestionBar.bounds, to: view) }
  var uiTestLetterRows: [[Character]] { letterRows }
  var uiTestEmojiKey: KeyButton? { emojiButton }
  var uiTestEmojiShown: Bool { isEmojiPanelShown }
  var uiTestEmojiSearching: Bool { isEmojiSearching }
  var uiTestEmojiPanel: EmojiPanelView? { emojiPanel }
  var uiTestNumberPadShown: Bool { isNumberPadShown }
  var uiTestLabelsFaded: Bool { characterButtons.first?.labelsFaded ?? false }
  var uiTestContentHeight: CGFloat { contentHeight }
  var uiTestGeometry: KeyGeometry? { laidOutKeyGeometry() }
  func uiTestPick(_ index: Int) { handleSuggestionPicked(suggestionBar.suggestions[index]) }
  func uiTestTapEmojiKey() { handleEmojiKeyTapped() }
  func uiTestSwipe(_ path: [CGPoint]) { commitSwipe(path: path) }
  func uiTestPickLanguage(_ language: TypingLanguage) { pickTypingLanguage(language) }
  func uiTestSyncGeometry() {
    view.layoutIfNeeded()
    _ = loadedTypingEngine()
    geometryWidth = 0
    refreshLaidOutGeometry()
  }
  func uiTestTrackpad(_ step: (inout TrackpadGesture) -> TrackpadOutput) {
    applyTrackpad(step(&trackpadGesture))
  }
  func uiTestPadKey(_ title: String) -> KeyButton? {
    var found: KeyButton?
    func visit(_ view: UIView) {
      if let key = view as? KeyButton, key.output == title { found = key }
      view.subviews.forEach(visit)
    }
    visit(numberPadStack)
    return found
  }
  func uiTestTapPad(_ title: String) {
    if let key = uiTestPadKey(title) { handlePadKeyTapped(key) }
  }
}

@MainActor
private func makeTypingKeyboard(
  language: TypingLanguage = .english, layout: KeyLayoutKind? = nil, barStyle: SuggestionBarStyle = .strip,
  haptics: Bool = true, width: CGFloat = 402, configure: (TestTextProxy) -> Void = { _ in }
) -> (KeyboardViewController, TestTextProxy, CountingKeyFeedback) {
  var settings = TypingSettings(defaults: nil, preferredLanguages: [language.rawValue])
  settings.language = language
  settings.layout = layout ?? language.defaultLayout
  settings.barStyle = barStyle
  settings.hapticsEnabled = haptics
  KeyboardViewController.typingSettingsOverride = settings
  KeyboardViewController.typingResourcesOverride = typingResources
  let proxy = TestTextProxy()
  proxy.tracksText = true
  proxy.documentContextBeforeInput = ""
  configure(proxy)
  TestEnvironment.proxy = proxy
  let keyboard = KeyboardViewController.makeLaidOutKeyboard(width: width)
  let feedback = CountingKeyFeedback()
  keyboard.keyFeedback = feedback
  keyboard.viewWillAppear(false)
  keyboard.uiTestSyncGeometry()
  return (keyboard, proxy, feedback)
}

@MainActor
private func checkTypingHelp(_ checks: inout TouchChecks) {
  TestEnvironment.reset()
  defer {
    TestEnvironment.reset()
    KeyboardViewController.typingSettingsOverride = nil
    KeyboardViewController.typingResourcesOverride = nil
  }

  // Autocorrect at a word boundary, and backspace taking it back.
  do {
    let (keyboard, proxy, _) = makeTypingKeyboard()
    keyboard.uiTestType("Teh ")
    checks.check("autocorrect: Teh → The", proxy.documentContextBeforeInput == "The ")
    keyboard.touchTestTapDelete()
    checks.check("backspace undoes the correction (got \(proxy.documentContextBeforeInput ?? "nil"))", proxy.documentContextBeforeInput == "Teh ")
    keyboard.uiTestType("teh ")
    checks.check("an undone correction isn't made again", proxy.documentContextBeforeInput == "Teh teh ")
  }

  // The suggestion bar, strip style: the pill gives way to three slots and a mic button.
  do {
    let (keyboard, proxy, _) = makeTypingKeyboard()
    let restPill = keyboard.uiTestPillFrame
    checks.check("strip at rest: no suggestions showing", !keyboard.uiTestStripShowsSuggestions)
    keyboard.uiTestType("Hel")
    keyboard.view.layoutIfNeeded()
    checks.check("typing shows suggestions", keyboard.uiTestStripShowsSuggestions && !keyboard.uiTestSuggestions.isEmpty)
    let pill = keyboard.uiTestPillFrame
    checks.check("dictation stays a 44pt-wide target beside the suggestions ", abs(pill.width - 44) < 0.5 && pill.width < restPill.width)
    let bar = keyboard.uiTestBarFrame
    checks.check(
      "suggestions sit between tone and the mic button",
      bar.minX >= keyboard.uiTestToneFrame.maxX && bar.maxX <= pill.minX
    )
    // The pill's target reaches 4pt below the strip: 44pt tall.
    let below = CGPoint(x: pill.midX, y: pill.maxY + 3)
    let hit = keyboard.view.hitTest(below, with: nil)
    checks.check("the mic button's target is 44pt tall", hit != nil && !(hit is KeyButton) && hit !== keyboard.view)
    checks.check("the word as typed is offered first, in quotes' slot", keyboard.uiTestSuggestions.first?.kind == .typed)
    if let index = keyboard.uiTestSuggestions.firstIndex(where: { $0.kind == .word }) {
      let word = keyboard.uiTestSuggestions[index].text
      keyboard.uiTestPick(index)
      checks.check("picking a suggestion replaces the word", proxy.documentContextBeforeInput == word + " ")
    } else {
      checks.check("Hel offers a word (got \(keyboard.uiTestSuggestions.map(\.text)))", false)
    }
    let (emojiKeyboard, _, _) = makeTypingKeyboard()
    emojiKeyboard.uiTestType("Pizza")
    checks.check(
      "a word with an emoji offers it (\(emojiKeyboard.uiTestSuggestions.map(\.text)))",
      emojiKeyboard.uiTestSuggestions.contains { $0.kind == .emoji && $0.text == "🍕" }
    )
  }

  // Row style: the bar has its own row; the keyboard is taller and the pill never shrinks.
  do {
    let (strip, _, _) = makeTypingKeyboard()
    let (row, _, _) = makeTypingKeyboard(barStyle: .row)
    checks.check("row style is one row taller", abs(row.uiTestContentHeight - strip.uiTestContentHeight - 36) < 0.5)
    let restPill = row.uiTestPillFrame
    row.uiTestType("Hel")
    row.view.layoutIfNeeded()
    checks.check("row style keeps the full pill while typing", abs(row.uiTestPillFrame.width - restPill.width) < 0.5)
    checks.check("row style shows suggestions", !row.uiTestSuggestions.isEmpty)
  }

  // Fields that ask for no help get none.
  let plainFields: [(String, (TestTextProxy) -> Void)] = [
    ("autocorrection off", { $0.autocorrectionType = .no }),
    ("spell checking off", { $0.spellCheckingType = .no }),
    ("URL keyboard", { $0.keyboardType = .URL }),
    ("email keyboard", { $0.keyboardType = .emailAddress }),
    ("username", { $0.textContentType = .username }),
    ("password", { $0.textContentType = .password }),
    ("one-time code", { $0.textContentType = .oneTimeCode }),
    ("email content", { $0.textContentType = .emailAddress }),
    ("secure entry", { $0.isSecureTextEntry = true }),
  ]
  for (name, configure) in plainFields {
    let (keyboard, proxy, _) = makeTypingKeyboard { proxy in
      proxy.autocapitalizationType = .none
      configure(proxy)
    }
    keyboard.uiTestType("teh")
    checks.check("\(name): no suggestions", keyboard.uiTestSuggestions.isEmpty)
    keyboard.typeTextForTest(" ")
    checks.check("\(name): no autocorrect", proxy.documentContextBeforeInput == "teh ")
  }

  // Haptics: one light tap per key, none when switched off; clicks either way.
  do {
    let (keyboard, _, feedback) = makeTypingKeyboard()
    keyboard.uiTestType("Hi ")
    keyboard.touchTestTapDelete()
    checks.check("a haptic tap per key", feedback.taps == 4 && feedback.clicks == 4)
    let (quiet, _, quietFeedback) = makeTypingKeyboard(haptics: false)
    quiet.uiTestType("Hi ")
    checks.check("haptics off: clicks only", quietFeedback.taps == 0 && quietFeedback.clicks == 3)
  }

  // Layouts: German has umlaut keys on either layout; QWERTZ swaps Y and Z.
  do {
    let (german, proxy, _) = makeTypingKeyboard(language: .german)
    let rows = german.uiTestLetterRows
    checks.check("de/QWERTZ rows", String(rows[0]) == "qwertzuiopü" && String(rows[1]) == "asdfghjklöä" && String(rows[2]) == "yxcvbnm")
    german.uiTestType("Fur ")
    checks.check("German: fur → Für (umlaut restored)", proxy.documentContextBeforeInput == "Für ")
    let (englishZ, _, _) = makeTypingKeyboard(language: .english, layout: .qwertz)
    checks.check("en/QWERTZ rows", String(englishZ.uiTestLetterRows[0]) == "qwertzuiop" && String(englishZ.uiTestLetterRows[2]) == "yxcvbnm")
    let (germanY, _, _) = makeTypingKeyboard(language: .german, layout: .qwerty)
    checks.check("de/QWERTY rows", String(germanY.uiTestLetterRows[0]) == "qwertyuiopü")

    // Switching the typing language from the keyboard rebuilds the keys.
    let (switching, _, _) = makeTypingKeyboard()
    switching.uiTestPickLanguage(.german)
    switching.view.layoutIfNeeded()
    checks.check("language switch: German keys, QWERTZ by default", String(switching.uiTestLetterRows[0]) == "qwertzuiopü")
  }

  // Every letter key's centre and inner 60% type that key on every layout and width, with a
  // word under way (dynamic hit targets in play).
  for (language, layout) in [(TypingLanguage.english, KeyLayoutKind.qwerty), (.german, .qwertz), (.english, .qwertz)] {
    for width: CGFloat in [375, 440] {
      let (keyboard, _, _) = makeTypingKeyboard(language: language, layout: layout, width: width)
      keyboard.uiTestType("th")
      var wrong = 0
      for key in keyboard.touchTestLetters {
        let frame = key.convert(key.bounds, to: keyboard.touchTestRows)
        for (fx, fy) in [(0.5, 0.5), (0.21, 0.21), (0.79, 0.21), (0.21, 0.79), (0.79, 0.79)] {
          let point = CGPoint(x: frame.minX + frame.width * fx, y: frame.minY + frame.height * fy)
          if keyboard.touchTestRows.hitTest(point, with: nil) !== key { wrong += 1 }
        }
      }
      checks.check("\(language.rawValue)/\(layout.rawValue) \(Int(width)) pt: the inner 60% of every key types it", wrong == 0)
    }
  }

  // Dynamic targets: after "th", a touch in the gap between W and E, nearer W, means E.
  do {
    let (keyboard, _, _) = makeTypingKeyboard()
    keyboard.uiTestType("th")
    if let w = keyboard.uiTestKey("w"), let e = keyboard.uiTestKey("e") {
      let wFrame = w.convert(w.bounds, to: keyboard.touchTestRows)
      let eFrame = e.convert(e.bounds, to: keyboard.touchTestRows)
      let point = CGPoint(x: wFrame.maxX + (eFrame.minX - wFrame.maxX) * 0.3, y: wFrame.midY)
      checks.check("after th, the W|E boundary leans to E", keyboard.touchTestRows.hitTest(point, with: nil) === e)
    }
  }

  // Swipe: a path through the keys types the word and a space; backspace removes it whole.
  do {
    let (keyboard, proxy, _) = makeTypingKeyboard()
    if let geometry = keyboard.uiTestGeometry {
      var path: [CGPoint] = []
      let stops = "hello".compactMap { geometry.centres[$0] }
      for (from, to) in zip(stops, stops.dropFirst()) {
        for step in 0..<12 {
          let t = CGFloat(step) / 12
          path.append(CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t))
        }
      }
      path.append(stops[stops.count - 1])
      keyboard.uiTestSwipe(path)
      checks.check("swipe types the word and a space", proxy.documentContextBeforeInput == "Hello ")
      keyboard.touchTestTapDelete()
      checks.check("backspace removes a swiped word whole", proxy.documentContextBeforeInput == "")
    } else {
      checks.check("laid-out geometry is available", false)
    }
  }

  // Space-bar trackpad.
  do {
    let (keyboard, proxy, feedback) = makeTypingKeyboard { proxy in
      proxy.documentContextBeforeInput = "Hello world"
    }
    let start = CGPoint(x: 200, y: 250)
    // A tap types a space.
    keyboard.uiTestTrackpad { $0.began(at: start, time: 0) }
    keyboard.uiTestTrackpad { $0.ended(at: start, time: 0.08) }
    checks.check("space tap types a space", proxy.documentContextBeforeInput == "Hello world ")
    // A quick swipe across the bar types nothing and never starts the trackpad.
    keyboard.uiTestTrackpad { $0.began(at: start, time: 1) }
    keyboard.uiTestTrackpad { $0.moved(to: CGPoint(x: 260, y: 250), time: 1.05) }
    keyboard.uiTestTrackpad { $0.ended(at: CGPoint(x: 300, y: 250), time: 1.1) }
    checks.check("a quick swipe over space does nothing", proxy.documentContextBeforeInput == "Hello world " && proxy.cursorMoves.isEmpty && !keyboard.uiTestLabelsFaded)
    // Hold, then drag left: labels fade, a tick plays, the cursor moves by graphemes.
    let ticks = feedback.ticks
    keyboard.uiTestTrackpad { $0.began(at: start, time: 2) }
    keyboard.uiTestTrackpad { $0.holdTimerFired(time: 2.36) }
    checks.check("hold starts trackpad mode: labels fade with a tick", keyboard.uiTestLabelsFaded && feedback.ticks == ticks + 1)
    keyboard.uiTestTrackpad { $0.moved(to: CGPoint(x: 200 - 27, y: 250), time: 2.6) }
    checks.check("dragging moves the cursor", proxy.cursorMoves.reduce(0, +) == -3 && proxy.documentContextBeforeInput == "Hello wor")
    keyboard.uiTestTrackpad { $0.ended(at: CGPoint(x: 173, y: 250), time: 2.7) }
    checks.check("lifting ends trackpad mode and leaves the cursor", !keyboard.uiTestLabelsFaded && proxy.documentContextBeforeInput == "Hello wor")
  }

  // Emoji: the key opens the panel, a pick goes into the document, search takes the keys.
  do {
    let (keyboard, proxy, _) = makeTypingKeyboard()
    checks.check("the bottom row has an emoji key", keyboard.uiTestEmojiKey?.isHidden == false)
    keyboard.uiTestTapEmojiKey()
    checks.check("the emoji key opens the panel", keyboard.uiTestEmojiShown)
    if let panel = keyboard.uiTestEmojiPanel {
      keyboard.emojiPanel(panel, didPick: "🍕")
      checks.check("a picked emoji is typed", proxy.documentContextBeforeInput == "🍕")
      keyboard.emojiPanelDidTapSearch(panel)
      keyboard.uiTestType("piz")
      checks.check(
        "search takes the letter keys, not the document",
        keyboard.uiTestEmojiSearching && panel.searchText.lowercased() == "piz" && proxy.documentContextBeforeInput == "🍕"
      )
      keyboard.emojiPanelDidCancelSearch(panel)
      keyboard.emojiPanelDidTapLetters(panel)
      checks.check("ABC returns to the keys", !keyboard.uiTestEmojiShown && !keyboard.uiTestEmojiSearching)
    }
    let (url, _, _) = makeTypingKeyboard { $0.keyboardType = .URL }
    checks.check("URL field: no emoji key", url.uiTestEmojiKey?.isHidden == true)
  }

  // Number pad fields get a pad.
  do {
    let (keyboard, proxy, _) = makeTypingKeyboard { $0.keyboardType = .numberPad }
    checks.check("number pad shows for a numberPad field", keyboard.uiTestNumberPadShown && keyboard.uiTestPadKey("5") != nil)
    keyboard.uiTestTapPad("5")
    keyboard.uiTestTapPad("0")
    checks.check("pad keys type digits", proxy.documentContextBeforeInput == "50")
    let (decimal, _, _) = makeTypingKeyboard { $0.keyboardType = .decimalPad }
    checks.check("decimal pad has a decimal key", decimal.uiTestPadKey(Locale.current.decimalSeparator ?? ".") != nil)
    let (phone, _, _) = makeTypingKeyboard { $0.keyboardType = .phonePad }
    checks.check("phone pad has a + key", phone.uiTestPadKey("+") != nil)
    let (text, _, _) = makeTypingKeyboard()
    checks.check("text fields keep the letter keys", !text.uiTestNumberPadShown)
  }
}

private extension KeyboardViewController {
  /// A character typed as a symbol key would type it, without the space bar's own rules.
  func typeTextForTest(_ text: String) {
    typeText(text)
    refreshAfterEdit()
    uiTestPump()
  }
}

// MARK: - Screenshots

/// Renders the keyboard to PNGs for the visual review: one per device size, layout,
/// appearance and state, named like the Apple reference shots.
@MainActor
private enum KeyboardScreenshots {
  struct Device {
    let name: String
    let width: CGFloat
    let landscape: Bool
    let globe: Bool
  }

  static let devices = [
    Device(name: "se", width: 375, landscape: false, globe: true),
    Device(name: "se", width: 667, landscape: true, globe: true),
    Device(name: "promax", width: 440, landscape: false, globe: false),
    Device(name: "promax", width: 956, landscape: true, globe: false),
  ]

  /// In the simulator harness: a real window, so appearance and fonts are the device's own.
  static var hostWindow: UIWindow?

  /// `devicePrefix` limits the run to one device's sizes ("se" on the SE simulator).
  static func render(to directory: URL, devicePrefix: String? = nil) {
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let layouts: [(String, TypingLanguage, KeyLayoutKind)] = [
      ("en", .english, .qwerty), ("de", .german, .qwertz), ("en-qwertz", .english, .qwertz),
    ]
    for device in devices where devicePrefix == nil || device.name == devicePrefix {
      for (layoutName, language, layout) in layouts {
        for dark in [false, true] {
          var states = ["rest", "typing"]
          if layoutName == "en" { states += ["numbers", "symbols", "emoji", "numberpad", "row-rest", "row-typing", "accents"] }
          for state in states {
            let image = shot(device: device, language: language, layout: layout, dark: dark, state: state)
            let orientation = device.landscape ? "landscape" : "portrait"
            let name = "\(device.name)-\(layoutName)-\(dark ? "dark" : "light")-\(orientation)-\(state).png"
            try? image.pngData()?.write(to: directory.appendingPathComponent(name))
          }
        }
      }
    }
    print("Screenshots written to \(directory.path)")
  }

  static func shot(device: Device, language: TypingLanguage, layout: KeyLayoutKind, dark: Bool, state: String) -> UIImage {
    TestEnvironment.reset()
    TestEnvironment.globe = device.globe
    TestEnvironment.landscape = device.landscape
    var settings = TypingSettings(defaults: nil, preferredLanguages: [language.rawValue])
    settings.language = language
    settings.layout = layout
    settings.barStyle = state.hasPrefix("row") ? .row : .strip
    KeyboardViewController.typingSettingsOverride = settings
    KeyboardViewController.typingResourcesOverride = typingResources
    let proxy = TestTextProxy()
    proxy.tracksText = true
    proxy.documentContextBeforeInput = ""
    if state == "numberpad" { proxy.keyboardType = .numberPad }
    TestEnvironment.proxy = proxy
    let page: TestPage = state == "numbers" ? .numbers : (state == "symbols" ? .symbols : .letters)
    hostWindow?.overrideUserInterfaceStyle = dark ? .dark : .light
    let keyboard = KeyboardViewController.makeLaidOutKeyboard(width: device.width, page: page) {
      $0.overrideUserInterfaceStyle = dark ? .dark : .light
      // In a window before its keys are built, so every colour resolves for the appearance.
      if let root = hostWindow?.rootViewController {
        root.children.forEach { child in
          child.view.removeFromSuperview()
          child.removeFromParent()
        }
        root.addChild($0)
        root.view.addSubview($0.view)
      }
    }
    keyboard.viewWillAppear(false)
    keyboard.uiTestSyncGeometry()
    switch state {
    case "typing", "row-typing": keyboard.uiTestType(language == .german ? "Hal" : "Hel")
    case "emoji": keyboard.uiTestTapEmojiKey()
    case "accents": keyboard.uiTestShowAccents(for: "e")
    default: break
    }
    keyboard.uiTestPump()
    let height = keyboard.view.systemLayoutSizeFitting(
      CGSize(width: device.width, height: 0), withHorizontalFittingPriority: .required,
      verticalFittingPriority: .fittingSizeLevel
    ).height
    keyboard.view.frame = CGRect(x: 0, y: 0, width: device.width, height: height)
    keyboard.view.layoutIfNeeded()
    keyboard.uiTestPump()

    // The view is transparent: iOS draws its keyboard glass behind it. Apple's measured
    // backdrop stands in, with the 17pt of glass iOS 26 draws above the view in portrait.
    let traits = UITraitCollection(userInterfaceStyle: dark ? .dark : .light)
    // Off-window, views made before the appearance override keep the colours they first
    // resolved; on a device the trait change redraws them. Redraw by hand here.
    func redraw(_ view: UIView) {
      view.overrideUserInterfaceStyle = dark ? .dark : .light
      if let label = view as? UILabel {
        let color = label.textColor
        label.textColor = nil
        label.textColor = color
      }
      if let color = view.backgroundColor {
        view.backgroundColor = nil
        view.backgroundColor = color
      }
      view.tintColorDidChange()
      view.setNeedsDisplay()
      view.subviews.forEach(redraw)
    }
    traits.performAsCurrent { redraw(keyboard.view) }
    let glassAbove: CGFloat = device.landscape ? 0 : 17
    let size = CGSize(width: device.width, height: height + glassAbove)
    let format = UIGraphicsImageRendererFormat()
    format.scale = min(3, floor(1200 / device.width * 4) / 4)
    format.opaque = true
    return UIGraphicsImageRenderer(size: size, format: format).image { context in
      let backdrop = dark ? UIColor(white: 23 / 255, alpha: 1) : UIColor(red: 226 / 255, green: 228 / 255, blue: 232 / 255, alpha: 1)
      backdrop.setFill()
      context.fill(CGRect(origin: .zero, size: size))
      context.cgContext.translateBy(x: 0, y: glassAbove)
      traits.performAsCurrent { keyboard.view.layer.render(in: context.cgContext) }
    }
  }
}

private extension KeyboardViewController {
  func uiTestShowAccents(for letter: Character) {
    guard let key = uiTestKey(letter) else { return }
    let accents = KeyRows.accents(for: letter, language: typingSettings.language)
    accentPopup.show(
      ([letter] + accents).map { String($0) },
      font: metrics.keycaps.lowercase,
      keyFrame: key.convert(key.bounds, to: rootStack),
      container: rootStack.layoutMarginsGuide.layoutFrame,
      cornerRadius: metrics.keyCornerRadius
    )
  }
}
