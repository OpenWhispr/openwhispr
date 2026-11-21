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
  var harnessEmojiCollection: UICollectionView? {
    var found: UICollectionView?
    func visit(_ view: UIView) {
      if let collection = view as? UICollectionView, found == nil { found = collection }
      view.subviews.forEach(visit)
    }
    if let panel = emojiPanel { visit(panel) }
    return found
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

  static func log(_ line: String) {
    lines.append(line)
    print(line)
  }

  static func pump(_ seconds: TimeInterval = 0.002) { RunLoop.main.run(until: Date().addingTimeInterval(seconds)) }

  /// A keyboard at the bottom of the window, as iOS would place it.
  static func mount(_ keyboard: KeyboardViewController) {
    guard let window else { return }
    window.rootViewController?.children.forEach { child in
      child.view.removeFromSuperview()
      child.removeFromParent()
    }
    window.rootViewController?.addChild(keyboard)
    window.rootViewController?.view.addSubview(keyboard.view)
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
    let text = ((try? String(contentsOf: sentencesURL, encoding: .utf8)) ?? "").prefix(12_000)
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
    if let collection = keyboard.harnessEmojiCollection {
      collection.layoutIfNeeded()
      let end = max(0, collection.contentSize.width - collection.bounds.width)
      var offset: CGFloat = 0
      while offset < end {
        offset = min(end, offset + collection.bounds.width * 0.8)
        collection.setContentOffset(CGPoint(x: offset, y: 0), animated: false)
        collection.layoutIfNeeded()
        pump(0.004)
        peak = max(peak, physFootprintMB())
      }
      log(String(format: "  emoji panel scrolled %.0f pt of content", end))
    } else {
      log("  emoji panel: no collection view found")
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

  static func run(arguments: [String], output: URL) {
    TestEnvironment.install()
    TestEnvironment.globe = UIScreen.main.bounds.width <= 375
    func argument(_ flag: String) -> String? {
      arguments.firstIndex(of: flag).flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil }
    }
    if arguments.contains("--perf") {
      for language in [TypingLanguage.english, .german] { perf(language: language) }
    }
    if arguments.contains("--tests") {
      var checks = TouchChecks()
      checkTypingHelp(&checks)
      log("Typing UI checks on iOS \(UIDevice.current.systemVersion): \(checks.count - checks.failures.count)/\(checks.count) passed")
      checks.failures.forEach { log("FAIL: \($0)") }
    }
    if let directory = argument("--screenshots") {
      KeyboardScreenshots.hostWindow = window
      KeyboardScreenshots.render(to: URL(fileURLWithPath: directory), devicePrefix: argument("--device"))
      log("screenshots written to \(directory)")
    }
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
