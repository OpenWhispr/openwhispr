import Foundation

/// A field's autocapitalization type (UITextAutocapitalizationType, kept UIKit-free).
enum AutoCapitalization {
  case none, words, sentences, allCharacters

  /// Whether the next letter starts capitalised after `context`, the text before the cursor:
  /// sentences at the start, after a newline, or after ".", "!" or "?" and a space; words
  /// after any space too.
  func capitalizesNext(after context: String?) -> Bool {
    switch self {
    case .none: return false
    case .allCharacters: return true
    case .words:
      guard let last = context?.last else { return true }
      return last.isWhitespace
    case .sentences:
      // A full stop needs a space after it, as on Apple's keyboard: "e.g." and "github." stay
      // lower-case.
      guard let context, let last = context.last, !last.isNewline else { return true }
      guard let end = context.trimmingCharacters(in: .whitespaces).last else { return true }
      return last.isWhitespace && ".!?\n".contains(end)
    }
  }
}
