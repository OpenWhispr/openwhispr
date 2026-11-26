import Foundation

/// Unit tests for the typing engines. Each check prints on failure; `run` returns whether
/// all passed.
enum TypingTests {
  static var failures = 0
  static var checks = 0

  static func check(_ label: String, _ passed: Bool) {
    checks += 1
    if !passed {
      failures += 1
      print("FAIL: \(label)")
    }
  }

  static func run(plugin: URL) -> Bool {
    runHitTargetTests(plugin: plugin)
    runTrackpadTests()
    runEmojiTests(plugin: plugin)
    runSwipeTests(plugin: plugin)
    runAutocorrectTests(plugin: plugin)
    print("Typing engine tests: \(checks - failures)/\(checks) passed")
    return failures == 0
  }
}
