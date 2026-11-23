// Appended after the other test files by run-keyboard-sim-harness.py, which builds the lot as a
// small iOS app for the simulator. There the keyboard runs in a real window on a real iOS:
// the same tests, true light and dark screenshots, and the latency and memory measurements.

#if targetEnvironment(simulator)
import Darwin
import WebKit

/// The app's memory as iOS counts it against a process's limit.
private func physFootprintMB() -> Double {
  var info = task_vm_info_data_t()
  var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
  let result = withUnsafeMutablePointer(to: &info) { pointer in
    pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
      task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
    }
  }
  return result == KERN_SUCCESS ? Double(info.phys_footprint) / 1_048_576 : -1
}

private extension KeyboardViewController {
  /// The scroll view of the web view the emoji panel draws its emoji in.
  var harnessEmojiCollection: UIScrollView? {
    var found: UIScrollView?
    func visit(_ view: UIView) {
      if let web = view as? WKWebView, found == nil { found = web.scrollView }
      view.subviews.forEach(visit)
    }
    if let panel = emojiPanel { visit(panel) }
    return found
  }

  /// The emoji page loads in WebKit's process; wait until it shows the panel's state.
  func harnessAwaitEmojiPage() {
    let deadline = Date().addingTimeInterval(10)
    // Loaded, and its width known here: the scroll view learns it with WebKit's next frame.
    while Date() < deadline,
      emojiPanel?.isContentReady == false
        || (harnessEmojiCollection.map { $0.contentSize.width <= 980 } ?? false)
    {
      RunLoop.main.run(until: Date().addingTimeInterval(0.02))
    }
  }

  /// A key press as UIKit delivers it at touch-up, timed to the moment insertText returns.
  func harnessTimedTap(_ key: KeyButton) -> Double {
    let before = TestEnvironment.proxy.inserted.count
    let start = CACurrentMediaTime()
    key.sendActions(for: .touchUpInside)
    let end = TestEnvironment.proxy.inserted.count > before ? TestEnvironment.proxy.lastInsertAt : CACurrentMediaTime()
    return (end - start) * 1000
  }

  func harnessTimedSpace() -> Double {
    let before = TestEnvironment.proxy.inserted.count
    let start = CACurrentMediaTime()
    handleSpaceTapped()
    let end = TestEnvironment.proxy.inserted.count > before ? TestEnvironment.proxy.lastInsertAt : CACurrentMediaTime()
    return (end - start) * 1000
  }
}

@MainActor
private enum SimHarness {
  static var window: UIWindow?
  static var lines: [String] = []
  static var output: URL?
  /// Keeps the keyboard on screen alive.
  static var mounted: KeyboardViewController?

  /// Written out line by line, so a run that stalls shows how far it got.
  static func log(_ line: String) {
    lines.append(line)
    print(line)
    if let output {
      try? lines.joined(separator: "\n").write(to: output.appendingPathComponent("progress.txt"), atomically: true, encoding: .utf8)
    }
  }

  static func pump(_ seconds: TimeInterval = 0.002) { RunLoop.main.run(until: Date().addingTimeInterval(seconds)) }

  /// A keyboard at the bottom of the window, as iOS would place it.
  static func mount(_ keyboard: KeyboardViewController) {
    guard let window, let root = window.rootViewController else { return }
    // Its view only, not a child controller: the keyboard looks up its host through its
    // parent with private keys that only a real keyboard host answers.
    root.view.subviews.forEach { $0.removeFromSuperview() }
    mounted = keyboard
    root.view.addSubview(keyboard.view)
    let height = keyboard.uiTestContentHeight
    keyboard.view.frame = CGRect(x: 0, y: window.bounds.height - height - 40, width: window.bounds.width, height: height)
    keyboard.view.layoutIfNeeded()
    keyboard.viewWillAppear(false)
    keyboard.uiTestSyncGeometry()
    pump(0.05)
  }

  static func percentile(_ values: [Double], _ p: Double) -> Double {
    let sorted = values.sorted()
    guard !sorted.isEmpty else { return 0 }
    return sorted[min(sorted.count - 1, Int(Double(sorted.count) * p))]
  }

  /// Criterion 6: latency from touch-up to insertText returning, and peak phys_footprint
  /// over a session of typing, swiping, scrolling the whole emoji panel and starting a
  /// dictation capture.
  static func perf(language: TypingLanguage) {
    let baseline = physFootprintMB()
    var peak = baseline
    func sample(_ label: String) {
      let now = physFootprintMB()
      peak = max(peak, now)
      log(String(format: "  footprint after %@: %.1f MB", label, now))
    }

    let (keyboard, _, _) = makeTypingKeyboard(language: language, width: window?.bounds.width ?? 402)
    mount(keyboard)
    sample("keyboard shown")

    // Typing: dev sentences, letters and spaces as their keys type them.
    let sentencesURL = typingResources.deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("tests/benchmarks/sentences.\(language.rawValue).dev.txt")
    let text = ((try? String(contentsOf: sentencesURL, encoding: .utf8)) ?? "").prefix(4_000)
    var letterTimes: [Double] = []
    var spaceTimes: [Double] = []
    for character in text {
      if character == " " || character == "\n" {
        spaceTimes.append(keyboard.harnessTimedSpace())
      } else if let key = keyboard.uiTestKey(Character(character.lowercased())) {
        letterTimes.append(keyboard.harnessTimedTap(key))
      } else {
        continue
      }
      // The suggestion refresh runs after the key, as it does between real keystrokes.
      pump(0.0005)
      peak = max(peak, physFootprintMB())
    }
    let all = letterTimes + spaceTimes
    log(String(
      format: "latency %@ (touch-up to insertText returning, %d keys): median %.3f ms, p95 %.3f ms, p99 %.3f ms, max %.3f ms",
      language.rawValue, all.count, percentile(all, 0.5), percentile(all, 0.95), percentile(all, 0.99), all.max() ?? 0
    ))
    log(String(
      format: "  letters: p95 %.3f ms, max %.3f ms; word boundaries (space, with autocorrect): p95 %.3f ms, max %.3f ms",
      percentile(letterTimes, 0.95), letterTimes.max() ?? 0, percentile(spaceTimes, 0.95), spaceTimes.max() ?? 0
    ))
    sample("typing \(all.count) keys")

    // Swiping: straight paths through the keys of common words.
    if let geometry = keyboard.uiTestGeometry {
      let words = String(text).split(whereSeparator: { !$0.isLetter }).filter { $0.count >= 3 }.prefix(300)
      var swipeTimes: [Double] = []
      for word in words {
        let stops = String(word).lowercased().compactMap { geometry.centres[$0] }
        guard stops.count >= 2 else { continue }
        var path: [CGPoint] = []
        for (from, to) in zip(stops, stops.dropFirst()) {
          for step in 0..<8 {
            let t = CGFloat(step) / 8
            path.append(CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t))
          }
        }
        path.append(stops[stops.count - 1])
        let start = CACurrentMediaTime()
        keyboard.uiTestSwipe(path)
        swipeTimes.append((CACurrentMediaTime() - start) * 1000)
        pump(0.0005)
        peak = max(peak, physFootprintMB())
      }
      log(String(format: "  swipe commit (%d words): median %.3f ms, max %.3f ms", swipeTimes.count, percentile(swipeTimes, 0.5), swipeTimes.max() ?? 0))
    }
    sample("swiping")

    // The whole emoji panel, end to end and back.
    keyboard.uiTestTapEmojiKey()
    keyboard.view.layoutIfNeeded()
    pump(0.05)
    keyboard.harnessAwaitEmojiPage()
    if let collection = keyboard.harnessEmojiCollection {
      let end = max(0, collection.contentSize.width - collection.bounds.width)
      var offset: CGFloat = 0
      while offset < end {
        offset = min(end, offset + collection.bounds.width * 0.8)
        collection.setContentOffset(CGPoint(x: offset, y: 0), animated: false)
        // Long enough for WebKit to draw each screenful, as a finger scrolling would.
        pump(0.03)
        peak = max(peak, physFootprintMB())
      }
      log(String(format: "  emoji panel scrolled %.0f pt of content", end))
    } else {
      log("  emoji panel: no web view found")
    }
    sample("scrolling the emoji panel")
    if let panel = keyboard.uiTestEmojiPanel { keyboard.emojiPanelDidTapLetters(panel) }

    // Starting a dictation: the WebKit capture the keyboard records with.
    let capture = WebAudioCapture()
    capture.attach(to: keyboard.view)
    capture.start()
    for _ in 0..<40 {
      pump(0.05)
      peak = max(peak, physFootprintMB())
    }
    sample("starting a dictation capture")
    capture.stop()

    log(String(format: "memory %@: baseline %.1f MB, peak phys_footprint %.1f MB", language.rawValue, baseline, peak))
  }

  /// WebKit delivers VoiceOver and keyboard activations as a click without touch events.
  static func checkEmojiButtonActivation(_ checks: inout TouchChecks) {
    let (keyboard, proxy, _) = makeTypingKeyboard()
    mount(keyboard)
    keyboard.uiTestTapEmojiKey()
    guard let panel = keyboard.uiTestEmojiPanel,
      let webView = panel.subviews.compactMap({ $0 as? WKWebView }).first
    else {
      checks.check("emoji button is mounted in WebKit", false)
      return
    }
    let deadline = Date().addingTimeInterval(10)
    while !panel.isContentReady, Date() < deadline { pump(0.02) }
    var activated: String?
    webView.evaluateJavaScript("""
      (() => {
        const button = document.querySelector('#g button[aria-label]');
        button.focus();
        button.click();
        return button.textContent;
      })()
      """) { result, _ in activated = result as? String }
    while (activated == nil || proxy.inserted.isEmpty), Date() < deadline { pump(0.02) }
    checks.check("activating an emoji button inserts it once", activated != nil && proxy.inserted == [activated ?? ""])
  }

  static func run(arguments: [String], output: URL) {
    self.output = output
    TestEnvironment.install()
    TestEnvironment.globe = UIScreen.main.bounds.width <= 375
    func argument(_ flag: String) -> String? {
      arguments.firstIndex(of: flag).flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil }
    }
    if let text = argument("--host-field") {
      // A focused text view, so iOS brings up whichever keyboard is current: with the dev
      // keyboard selected, that is the real installed extension. The runner screenshots it.
      let field = UITextView(frame: CGRect(x: 16, y: 80, width: (window?.bounds.width ?? 402) - 32, height: 160))
      field.font = .systemFont(ofSize: 20)
      field.text = text
      if arguments.contains("--number-pad") { field.keyboardType = .numberPad }
      if arguments.contains("--url") { field.keyboardType = .URL }
      window?.overrideUserInterfaceStyle = arguments.contains("--dark") ? .dark : .light
      window?.rootViewController?.view.addSubview(field)
      field.becomeFirstResponder()
      if let typed = argument("--host-types") {
        // The host changes the text itself a moment later, as a user's first key would.
        Timer.scheduledTimer(withTimeInterval: 4, repeats: false) { _ in field.insertText(typed) }
      }
      // Back to UIKit's own run loop while the keyboard is up: iOS doesn't present its
      // keyboard to an app that is stuck inside one long callback.
      Timer.scheduledTimer(withTimeInterval: Double(argument("--hold") ?? "12") ?? 12, repeats: false) { _ in
        MainActor.assumeIsolated {
          log("host field held")
          finish(output: output)
        }
      }
      return
    }
    if arguments.contains("--emoji-web-experiment") {
      // The same grid as text in a web view: are the glyph caches charged to this process?
      let catalog = EmojiCatalog(url: typingResources.appendingPathComponent("emoji.bin"))
      let all = (catalog?.categories ?? []).flatMap { $0.emoji.map(\.string) }
      log(String(format: "web: before %.1f MB", physFootprintMB()))
      let web = WKWebView(frame: CGRect(x: 0, y: 300, width: window?.bounds.width ?? 402, height: 220))
      window?.rootViewController?.view.addSubview(web)
      let cells = all.map { "<span>\($0)</span>" }.joined()
      let html = "<meta name=viewport content='width=device-width,initial-scale=1'><style>body{margin:0;font-size:30px;display:grid;grid-auto-flow:column;grid-template-rows:repeat(5,44px);grid-auto-columns:44px;width:max-content}span{text-align:center;line-height:44px}</style>" + cells
      web.loadHTMLString(html, baseURL: nil)
      pump(3)
      log(String(format: "web: loaded %.1f MB, content width %.0f", physFootprintMB(), web.scrollView.contentSize.width))
      let end = max(0, web.scrollView.contentSize.width - web.bounds.width)
      var offset: CGFloat = 0
      var peak = physFootprintMB()
      while offset < end {
        offset = min(end, offset + 300)
        web.scrollView.setContentOffset(CGPoint(x: offset, y: 0), animated: false)
        pump(0.03)
        peak = max(peak, physFootprintMB())
      }
      pump(1)
      log(String(format: "web: after scrolling everything %.1f MB, peak %.1f MB", physFootprintMB(), peak))
    }
    if let mode = argument("--emoji-cache-experiment") {
      // How much memory drawing every emoji costs, by how the font is obtained.
      let catalog = EmojiCatalog(url: typingResources.appendingPathComponent("emoji.bin"))
      let all = (catalog?.categories ?? []).flatMap { $0.emoji.map(\.string) }
      let systemFont = CTFontCreateWithName("AppleColorEmoji" as CFString, 30, nil)
      let url = (CTFontCopyAttribute(systemFont, kCTFontURLAttribute) as? URL) ?? URL(fileURLWithPath: "/")
      log("emoji font file: \(url.path)")
      func privateFont() -> CTFont? {
        guard let descriptors = CTFontManagerCreateFontDescriptorsFromURL(url as CFURL) as? [CTFontDescriptor],
          let descriptor = descriptors.first else { return nil }
        return CTFontCreateWithFontDescriptor(descriptor, 30, nil)
      }
      let size = CGSize(width: 40, height: 40)
      let format = UIGraphicsImageRendererFormat()
      format.scale = 3
      let renderer = UIGraphicsImageRenderer(size: size, format: format)
      log(String(format: "%@: before %.1f MB, %d emoji, private font available %@", mode, physFootprintMB(), all.count, privateFont() == nil ? "no" : "yes"))
      var font: CTFont? = mode == "system" ? CTFontCreateWithName("AppleColorEmoji" as CFString, 30, nil) : privateFont()
      var peak = physFootprintMB()
      for (index, emoji) in all.enumerated() {
        autoreleasepool {
          if mode == "private-recycled", index % 150 == 0 { font = privateFont() }
          guard let font else { return }
          let line = CTLineCreateWithAttributedString(
            NSAttributedString(string: emoji, attributes: [NSAttributedString.Key(kCTFontAttributeName as String): font])
          )
          _ = renderer.image { context in
            context.cgContext.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
            context.cgContext.textPosition = CGPoint(x: 4, y: 30)
            CTLineDraw(line, context.cgContext)
          }
        }
        peak = max(peak, physFootprintMB())
      }
      log(String(format: "%@: after %.1f MB, peak %.1f MB", mode, physFootprintMB(), peak))
      font = nil
      pump(0.5)
      log(String(format: "%@: after releasing the font %.1f MB", mode, physFootprintMB()))
      UIApplication.shared.perform(Selector(("_performMemoryWarning")))
      pump(2)
      log(String(format: "%@: after a simulated memory warning %.1f MB", mode, physFootprintMB()))
      pump(20)
      log(String(format: "%@: 20 s later %.1f MB", mode, physFootprintMB()))
    }
    if arguments.contains("--emoji-memory") {
      // Scrolls the emoji panel end to end, then idles so the process can be inspected
      // from the Mac (vmmap, footprint).
      let (keyboard, _, _) = makeTypingKeyboard(width: window?.bounds.width ?? 402)
      mount(keyboard)
      log(String(format: "before emoji: %.1f MB", physFootprintMB()))
      keyboard.uiTestTapEmojiKey()
      keyboard.view.layoutIfNeeded()
      pump(0.05)
      keyboard.harnessAwaitEmojiPage()
      log(String(format: "emoji page loaded: %.1f MB", physFootprintMB()))
      if let collection = keyboard.harnessEmojiCollection {
        let end = max(0, collection.contentSize.width - collection.bounds.width)
        var offset: CGFloat = 0
        while offset < end {
          offset = min(end, offset + collection.bounds.width * 0.8)
          collection.setContentOffset(CGPoint(x: offset, y: 0), animated: false)
          // Long enough for WebKit to draw each screenful, as a finger scrolling would.
          pump(0.03)
        }
        log(String(format: "emoji panel scrolled %.0f pt of content", end))
      } else {
        log("emoji panel: no web view found")
      }
      log(String(format: "after emoji scroll: %.1f MB (pid %d)", physFootprintMB(), getpid()))
      pump(Double(argument("--hold") ?? "0") ?? 0)
      log(String(format: "after hold: %.1f MB", physFootprintMB()))
    }
    if arguments.contains("--perf") {
      // One language per launch for the memory figure: a second session in the same
      // process starts on top of the first one's footprint.
      let only = argument("--perf-language").flatMap(TypingLanguage.init(rawValue:))
      for language in [TypingLanguage.english, .german] where only == nil || only == language {
        perf(language: language)
      }
    }
    if arguments.contains("--tests") {
      var checks = TouchChecks()
      checkTypingHelp(&checks)
      checkEmojiButtonActivation(&checks)
      log("Typing UI checks on iOS \(UIDevice.current.systemVersion): \(checks.count - checks.failures.count)/\(checks.count) passed")
      checks.failures.forEach { log("FAIL: \($0)") }
    }
    if let directory = argument("--screenshots") {
      KeyboardScreenshots.hostWindow = window
      KeyboardScreenshots.render(to: URL(fileURLWithPath: directory), devicePrefix: argument("--device"))
      log("screenshots written to \(directory)")
    }
    finish(output: output)
  }

  static func finish(output: URL) -> Never {
    try? lines.joined(separator: "\n").write(to: output.appendingPathComponent("result.txt"), atomically: true, encoding: .utf8)
    try? "done".write(to: output.appendingPathComponent("done"), atomically: true, encoding: .utf8)
    exit(0)
  }
}

final class SimHarnessAppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?

  func application(
    _ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    let window = UIWindow(frame: UIScreen.main.bounds)
    let root = UIViewController()
    root.view.backgroundColor = .systemBackground
    window.rootViewController = root
    window.makeKeyAndVisible()
    self.window = window
    let arguments = ProcessInfo.processInfo.arguments
    let output = arguments.firstIndex(of: "--output").flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil }
      .map { URL(fileURLWithPath: $0) } ?? FileManager.default.temporaryDirectory
    // A timer, not a main-queue block: the keyboard queues its suggestion refresh on the
    // main queue, which doesn't run other blocks while one of its own is still running.
    Timer.scheduledTimer(withTimeInterval: 0.5, repeats: false) { _ in
      MainActor.assumeIsolated {
        SimHarness.window = window
        SimHarness.run(arguments: arguments, output: output)
      }
    }
    return true
  }
}

func runSimHarnessApp() -> Never {
  exit(UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(SimHarnessAppDelegate.self)))
}
#endif
