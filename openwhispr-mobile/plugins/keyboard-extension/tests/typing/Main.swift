import Foundation

/// The typing engines' benchmarks and unit tests, built with plain swiftc (no UIKit).
///
///     keyboard-typing <plugin dir> test
///     keyboard-typing <plugin dir> autocorrect <en|de> <dev|test> [-v] [name=value …]
///     keyboard-typing <plugin dir> swipe <en|de> <qwerty|qwertz> <dev|test> [-v]
///     keyboard-typing <plugin dir> swipe-real <en|de> [-v] [name=value …]
///     keyboard-typing <plugin dir> targets <en|de> <qwerty|qwertz> <dev|test>
@main
enum TypingMain {
  static func main() {
    let arguments = Array(CommandLine.arguments.dropFirst())
    guard arguments.count >= 2 else {
      print("usage: keyboard-typing <plugin dir> <test|autocorrect|swipe|targets> …")
      exit(2)
    }
    let plugin = URL(fileURLWithPath: arguments[0])
    let rest = Array(arguments.dropFirst(2))
    let verbose = rest.contains("-v")
    var overrides: [String: Double] = [:]
    var positional: [String] = []
    for argument in rest where argument != "-v" {
      let parts = argument.split(separator: "=")
      if parts.count == 2, let value = Double(parts[1]) {
        overrides[String(parts[0])] = value
      } else {
        positional.append(argument)
      }
    }

    func environment(layoutAt index: Int?) -> BenchEnvironment {
      guard let language = positional.first.flatMap(TypingLanguage.init(rawValue:)) else {
        fatalError("Expected a language: en or de")
      }
      let layout = index.flatMap { positional.indices.contains($0) ? KeyLayoutKind(rawValue: positional[$0]) : nil }
        ?? language.defaultLayout
      return BenchEnvironment(
        plugin: plugin, language: language, layout: layout, split: positional.last ?? "dev", overrides: overrides
      )
    }

    switch arguments[1] {
    case "test":
      exit(TypingTests.run(plugin: plugin) ? 0 : 1)
    case "autocorrect":
      AutocorrectBench.run(environment(layoutAt: nil), verbose: verbose)
    case "swipe":
      SwipeBench.run(environment(layoutAt: 1), verbose: verbose)
    case "swipe-real":
      SwipeRealBench.run(environment(layoutAt: nil), verbose: verbose)
    case "targets":
      TargetsBench.run(environment(layoutAt: 1), verbose: verbose)
    default:
      print("Unknown command \(arguments[1])")
      exit(2)
    }
  }
}
