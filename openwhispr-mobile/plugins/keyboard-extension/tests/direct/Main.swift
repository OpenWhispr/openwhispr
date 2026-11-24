import Foundation

/// Runner for the direct-dictation tests (scripts/test-keyboard-direct.sh). Each test file
/// extends this enum with one `test…()` and adds its call to `main()`.
@main
enum DirectDictationTests {
  static var failures = 0
  /// plugins/keyboard-extension/tests/fixtures, passed by the script.
  static var fixtures = URL(fileURLWithPath: "plugins/keyboard-extension/tests/fixtures")

  static func expect<T: Equatable>(_ actual: T, _ expected: T, _ name: String, line: Int = #line) {
    guard actual != expected else { return }
    failures += 1
    print("FAIL \(name) [line \(line)]: got \(actual), expected \(expected)")
  }

  static func main() {
    if CommandLine.arguments.count > 1 { fixtures = URL(fileURLWithPath: CommandLine.arguments[1]) }
    testConfig()
    testAudio()
    testSnippets()
    testRequests()
    testStore()
    testStateMachine()
    testRoute()
    testCredential()
    testLocal()
    print(failures == 0 ? "PASS" : "\(failures) failure(s)")
    exit(failures == 0 ? 0 : 1)
  }
}
