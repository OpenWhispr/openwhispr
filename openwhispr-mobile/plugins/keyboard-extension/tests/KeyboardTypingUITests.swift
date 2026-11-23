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
  func uiTestChangeFieldDuringTyping() {
    lastKeystrokeAt = CACurrentMediaTime()
    textDidChange(nil)
  }
  var uiTestFieldPolicy: TypingFieldPolicy? { typingEngine?.session.policy }
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
  var uiTestSpaceKey: UIButton? { spaceButton }
  func uiTestShowRecording() { showRecordingCanvas() }
  func uiTestSwipe(_ path: [CGPoint]) { commitSwipe(path: path) }
  func uiTestPickLanguage(_ language: TypingLanguage) { pickTypingLanguage(language) }
  func uiTestPickSwissFrench() { pickSwissFrench() }
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
  haptics: Bool = true, width: CGFloat = 402, swissFrench: Bool = false,
  configure: (TestTextProxy) -> Void = { _ in }
) -> (KeyboardViewController, TestTextProxy, CountingKeyFeedback) {
  var settings = TypingSettings(defaults: nil, preferredLanguages: [language.rawValue])
  settings.language = language
  settings.layout = layout ?? (swissFrench ? .qwertz : language.defaultLayout)
  settings.swissFrenchKeys = swissFrench
  settings.typingHelpEnabled = !swissFrench
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

  // "Other" language: the keyboard has no word list for it, so it leaves the text alone.
  do {
    var settings = TypingSettings(defaults: nil, preferredLanguages: ["en"])
    settings.typingHelpEnabled = false
    KeyboardViewController.typingSettingsOverride = settings
    KeyboardViewController.typingResourcesOverride = typingResources
    let proxy = TestTextProxy()
    proxy.tracksText = true
    proxy.documentContextBeforeInput = ""
    TestEnvironment.proxy = proxy
    let keyboard = KeyboardViewController.makeLaidOutKeyboard(width: 402)
    keyboard.viewWillAppear(false)
    keyboard.uiTestType("Teh lekker")
    checks.check(
      "other language: nothing is corrected (got \(proxy.documentContextBeforeInput ?? "nil"))",
      proxy.documentContextBeforeInput == "Teh lekker"
    )
    checks.check(
      "other language: no suggestions, pill stays put",
      keyboard.uiTestSuggestions.isEmpty && !keyboard.uiTestStripShowsSuggestions
    )
  }
  do {
    let defaults = UserDefaults(suiteName: "keyboard-other-language-test")!
    defer { defaults.removePersistentDomain(forName: "keyboard-other-language-test") }
    TypingSettings.storeOtherLanguage(in: defaults)
    checks.check("other language: stored value turns typing help off", !TypingSettings(defaults: defaults).typingHelpEnabled)
    checks.check(
      "unset on a device with neither English nor German: no typing help",
      !TypingSettings(defaults: nil, preferredLanguages: ["fr-FR"]).typingHelpEnabled
        && !TypingSettings(defaults: nil, preferredLanguages: ["fr-CH", "it-CH"]).typingHelpEnabled
    )
    checks.check(
      "unset on a device that lists English or German anywhere: typing help",
      TypingSettings(defaults: nil, preferredLanguages: ["en-ZA", "af-ZA"]).typingHelpEnabled
        && TypingSettings(defaults: nil, preferredLanguages: ["af-ZA", "en-ZA"]).typingHelpEnabled
        && TypingSettings(defaults: nil, preferredLanguages: ["fr-FR", "de-DE"]).typingHelpEnabled
    )
    let emptyDefaults = UserDefaults(suiteName: "keyboard-other-language-test-empty")!
    defer { emptyDefaults.removePersistentDomain(forName: "keyboard-other-language-test-empty") }
    TypingSettings.store(language: .english, in: emptyDefaults)
    checks.check(
      "a chosen language wins over a French-first device",
      TypingSettings(defaults: emptyDefaults, preferredLanguages: ["fr-FR"]).typingHelpEnabled
    )
    TypingSettings.store(language: .german, in: defaults)
    let german = TypingSettings(defaults: defaults)
    checks.check("picking a language turns typing help back on", german.typingHelpEnabled && german.language == .german)
  }

  do {
    let (keyboard, proxy, _) = makeTypingKeyboard()
    keyboard.uiTestType("Teh")
    proxy.selectedText = " world"
    keyboard.uiTestType(" ")
    checks.check("space over a selection preserves preceding text", proxy.deletes == 0 && proxy.inserted.last == " ")
  }
  do {
    let (keyboard, proxy, _) = makeTypingKeyboard()
    keyboard.uiTestType("Teh ")
    let before = proxy.deletes
    proxy.selectedText = "next"
    keyboard.touchTestTapDelete()
    checks.check("backspace over a selection only removes that selection", proxy.deletes == before + 1)
  }
  do {
    let (keyboard, proxy, _) = makeTypingKeyboard()
    keyboard.uiTestType("Teh")
    proxy.documentIdentifier = UUID()
    proxy.documentContextBeforeInput = ""
    proxy.autocorrectionType = .no
    keyboard.uiTestChangeFieldDuringTyping()
    checks.check("privacy policy changes before the next key", keyboard.uiTestFieldPolicy == TypingFieldPolicy.none)
    keyboard.uiTestType("Teh ")
    checks.check("a new field immediately gets its own policy and context", proxy.documentContextBeforeInput == "Teh " && keyboard.uiTestSuggestions.isEmpty)
  }
  do {
    let (keyboard, proxy, _) = makeTypingKeyboard { proxy in
      proxy.hasText = true
      proxy.tracksText = false
      proxy.documentContextBeforeInput = nil
      proxy.documentContextAfterInput = nil
    }
    keyboard.uiTestType("Teh ")
    checks.check("a host that withholds its text gets plain typing", proxy.deletes == 0 && keyboard.uiTestSuggestions.isEmpty)
  }
  do {
    let (keyboard, _, _) = makeTypingKeyboard { proxy in
      proxy.tracksText = false
      proxy.documentContextBeforeInput = nil
      proxy.documentContextAfterInput = nil
    }
    keyboard.uiTestType("Zqx")
    checks.check("a silent host cannot offer its typed word for learning", keyboard.uiTestSuggestions.isEmpty)
  }

  // The pronoun, through the keys: mid-sentence, after a lower-case start, and typed again
  // after deleting it.
  do {
    let (keyboard, proxy, _) = makeTypingKeyboard()
    keyboard.uiTestType("Now i think i can ")
    checks.check("i mid-sentence becomes I (got \(proxy.documentContextBeforeInput ?? "nil"))", proxy.documentContextBeforeInput == "Now I think I can ")
    let (lower, lowerProxy, _) = makeTypingKeyboard { $0.autocapitalizationType = .none }
    lower.uiTestType("now i think ")
    checks.check("i becomes I in a field that doesn't capitalise (got \(lowerProxy.documentContextBeforeInput ?? "nil"))", lowerProxy.documentContextBeforeInput == "now I think ")
    let (again, againProxy, _) = makeTypingKeyboard()
    again.uiTestType("Now i ")
    // One backspace takes the capital back this once; it must not turn the correction off.
    again.touchTestTapDelete()
    checks.check("backspace after I undoes it once (got \(againProxy.documentContextBeforeInput ?? "nil"))", againProxy.documentContextBeforeInput == "Now i ")
    again.touchTestTapDelete()
    again.touchTestTapDelete()
    again.uiTestType("i am and i go ")
    checks.check("i is still capitalised afterwards (got \(againProxy.documentContextBeforeInput ?? "nil"))", againProxy.documentContextBeforeInput == "Now I am and I go ")
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

    // Swiss French: è, é and à where German has its umlauts, typed and capitalised like any
    // letter, with no typing help (there is no French word list).
    let (swiss, swissProxy, _) = makeTypingKeyboard()
    swiss.uiTestPickSwissFrench()
    swiss.view.layoutIfNeeded()
    let swissRows = swiss.uiTestLetterRows
    checks.check(
      "fr_CH rows are QWERTZ with è, é and à",
      String(swissRows[0]) == "qwertzuiopè" && String(swissRows[1]) == "asdfghjkléà" && String(swissRows[2]) == "yxcvbnm"
    )
    let swissLetters = swissRows.flatMap { $0 }
    checks.check("fr_CH has no repeated key", Set(swissLetters).count == swissLetters.count)
    swiss.uiTestType("Èéày")
    checks.check(
      "fr_CH types È at a sentence start, then é à y (got \(swissProxy.documentContextBeforeInput ?? "nil"))",
      swissProxy.documentContextBeforeInput == "Èéày"
    )
    swiss.uiTestType(" teh ")
    checks.check(
      "fr_CH: nothing is corrected and nothing suggested (got \(swissProxy.documentContextBeforeInput ?? "nil"))",
      swissProxy.documentContextBeforeInput == "Èéày teh " && swiss.uiTestSuggestions.isEmpty
    )
    let (laidOut, _, _) = makeTypingKeyboard(swissFrench: true)
    let (english, _, _) = makeTypingKeyboard()
    let swissWidths = laidOut.touchTestLetters.map(\.bounds.width)
    let englishWidth = english.uiTestKey("q")?.bounds.width ?? 0
    checks.check(
      "fr_CH: 29 letter keys of one width, narrower than English (\(swissWidths.first ?? 0) vs \(englishWidth))",
      swissWidths.count == 29 && swissWidths[0] > 10 && swissWidths[0] < englishWidth
        && swissWidths.allSatisfy { abs($0 - swissWidths[0]) < 0.5 }
    )
    swiss.uiTestPickLanguage(.english)
    swiss.view.layoutIfNeeded()
    checks.check("picking English takes the Swiss keys away", String(swiss.uiTestLetterRows[0]).hasPrefix("qwert") && swiss.uiTestKey("è") == nil)

    let swissDefaults = UserDefaults(suiteName: "keyboard-swiss-french-test")!
    defer { swissDefaults.removePersistentDomain(forName: "keyboard-swiss-french-test") }
    TypingSettings.storeSwissFrench(in: swissDefaults)
    let stored = TypingSettings(defaults: swissDefaults, preferredLanguages: ["en-US"])
    checks.check(
      "stored fr_CH: Swiss keys, QWERTZ, no typing help",
      stored.swissFrenchKeys && stored.layout == .qwertz && !stored.typingHelpEnabled
    )
    TypingSettings.store(layout: .qwerty, in: swissDefaults)
    checks.check("a chosen layout wins for fr_CH", TypingSettings(defaults: swissDefaults).layout == .qwerty)
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
  // The same for the Swiss French keys, which have no typing help to lean the targets.
  for width: CGFloat in [360, 402, 440] {
    let (keyboard, _, _) = makeTypingKeyboard(width: width, swissFrench: true)
    var wrong = 0
    for key in keyboard.touchTestLetters {
      let frame = key.convert(key.bounds, to: keyboard.touchTestRows)
      for (fx, fy) in [(0.5, 0.5), (0.21, 0.21), (0.79, 0.21), (0.21, 0.79), (0.79, 0.79)] {
        let point = CGPoint(x: frame.minX + frame.width * fx, y: frame.minY + frame.height * fy)
        if keyboard.touchTestRows.hitTest(point, with: nil) !== key { wrong += 1 }
      }
    }
    checks.check("fr_CH \(Int(width)) pt: the inner 60% of every key types it", keyboard.touchTestLetters.count == 29 && wrong == 0)
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
      keyboard.uiTestTapEmojiKey()
      if let panel = keyboard.uiTestEmojiPanel {
        keyboard.emojiPanelDidTapSearch(panel)
        keyboard.uiTestSwipe(path)
        checks.check("an emoji search swipe edits only the query", panel.searchText.lowercased() == "hello " && proxy.documentContextBeforeInput == "")
      }
    } else {
      checks.check("laid-out geometry is available", false)
    }
    // A fast tap that slid off its key arrives as a very short swipe: it types that key.
    let (sliding, slidingProxy, _) = makeTypingKeyboard()
    if let start = sliding.uiTestGeometry?.centres["h"] {
      sliding.uiTestSwipe([start, CGPoint(x: start.x + 12, y: start.y + 4), CGPoint(x: start.x + 34, y: start.y + 6)])
      checks.check("a short slide types the key it began on", slidingProxy.documentContextBeforeInput == "H")
    }
  }

  do {
    let (keyboard, proxy, _) = makeTypingKeyboard()
    checks.check(
      "assistive activation types a space",
      keyboard.uiTestSpaceKey?.accessibilityActivate() == true && proxy.documentContextBeforeInput == " "
    )
    #if targetEnvironment(simulator)
    // The simulator runs UIApplicationMain, which dispatches UIControl's target actions.
    keyboard.uiTestSpaceKey?.sendActions(for: .touchUpInside)
    checks.check("a touch-free space action types once", proxy.documentContextBeforeInput == "  ")
    #endif
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
    // A press that slides across the bar still types its space (here the second in a row,
    // so the double-space full stop) and never starts the trackpad.
    keyboard.uiTestTrackpad { $0.began(at: start, time: 1) }
    keyboard.uiTestTrackpad { $0.moved(to: CGPoint(x: 260, y: 250), time: 1.05) }
    keyboard.uiTestTrackpad { $0.ended(at: CGPoint(x: 300, y: 250), time: 1.1) }
    checks.check("a slid press on space types a space and never starts the trackpad", proxy.documentContextBeforeInput == "Hello world. " && proxy.cursorMoves.isEmpty && !keyboard.uiTestLabelsFaded)
    // Hold, then drag left: labels fade, a tick plays, the cursor moves by graphemes.
    let ticks = feedback.ticks
    keyboard.uiTestTrackpad { $0.began(at: start, time: 2) }
    keyboard.uiTestTrackpad { $0.holdTimerFired(time: 2.36) }
    checks.check("hold starts trackpad mode: labels fade with a tick", keyboard.uiTestLabelsFaded && feedback.ticks == ticks + 1)
    keyboard.uiTestTrackpad { $0.moved(to: CGPoint(x: 200 - 27, y: 250), time: 2.6) }
    checks.check("dragging moves the cursor", proxy.cursorMoves.reduce(0, +) == -3)
    keyboard.uiTestTrackpad { $0.ended(at: CGPoint(x: 173, y: 250), time: 2.7) }
    checks.check("lifting ends trackpad mode and leaves the cursor", !keyboard.uiTestLabelsFaded && proxy.cursorMoves.reduce(0, +) == -3)
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
      keyboard.uiTestTapEmojiKey()
      keyboard.uiTestShowRecording()
      checks.check("recording dismisses the emoji grid", keyboard.touchTestCanvasShown && !keyboard.uiTestEmojiShown && panel.superview == nil)
    }
    let (url, _, _) = makeTypingKeyboard { $0.keyboardType = .URL }
    checks.check("URL field: no emoji key", url.uiTestEmojiKey?.isHidden == true)
  }

  // The German rows (eleven keys) and English on QWERTZ pass the same routing checks as
  // QWERTY at the smallest and largest phones, in both orientations: no tap is dropped and
  // every key takes the touches nearest to it.
  // On the Mac runner, like the QWERTY sweeps: a view with no screen has whole-point pixels,
  // which the sweep's edge sampling assumes.
  #if !targetEnvironment(simulator)
  for (name, language, layout) in [("German QWERTZ", TypingLanguage.german, KeyLayoutKind.qwertz), ("English QWERTZ", .english, .qwertz)] {
    var settings = TypingSettings(defaults: nil, preferredLanguages: [language.rawValue])
    settings.language = language
    settings.layout = layout
    KeyboardViewController.typingSettingsOverride = settings
    KeyboardTouchTests.checkProductionLayout("\(name) portrait with globe", width: 375, globe: true, &checks)
    KeyboardTouchTests.checkProductionLayout("\(name) portrait", width: 440, &checks)
    KeyboardTouchTests.checkProductionLayout("\(name) landscape with globe", width: 667, globe: true, landscape: true, &checks)
    KeyboardTouchTests.checkProductionLayout("\(name) landscape", width: 956, landscape: true, &checks)
  }
  #endif

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
  private static var hostKeyboard: KeyboardViewController?

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
      // Its view only: as a child controller the keyboard would ask its parent for the host
      // app with private keys that only a real keyboard host answers.
      if let root = hostWindow?.rootViewController {
        root.view.subviews.forEach { $0.removeFromSuperview() }
        root.view.addSubview($0.view)
      }
    }
    hostKeyboard = keyboard
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
    // The emoji are a web page, loaded and drawn in WebKit's process: wait for it and ask
    // WebKit for its picture, since a layer render sees none of it. Only in a real window.
    var emoji: (image: UIImage, frame: CGRect)?
    if state == "emoji", hostWindow != nil, let panel = keyboard.uiTestEmojiPanel {
      let deadline = Date().addingTimeInterval(10)
      while !panel.isContentReady, Date() < deadline { keyboard.uiTestPump() }
      RunLoop.main.run(until: Date().addingTimeInterval(0.3))
      var answered = false
      panel.snapshotContent { image, frame in
        if let image { emoji = (image, panel.convert(frame, to: keyboard.view)) }
        answered = true
      }
      while !answered, Date() < deadline { keyboard.uiTestPump() }
    }
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
      emoji?.image.draw(in: emoji?.frame ?? .zero)
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
