import UIKit

/// The three-slot suggestion bar. It only draws and reports taps; what the slots hold is
/// decided by TypingSession.
final class SuggestionBarView: UIView {
  /// Apple's bar: 17pt text, hairline separators a little over half the bar's height.
  private enum Look {
    static let font = UIFont.systemFont(ofSize: 17, weight: .regular)
    static let emojiFont = UIFont.systemFont(ofSize: 22)
    static let separatorWidth: CGFloat = 1
    static let separatorInset: CGFloat = 9
    static let pendingInset = UIEdgeInsets(top: 4, left: 3, bottom: 4, right: 3)
    static let pendingCornerRadius: CGFloat = 7
    static let textInset: CGFloat = 6
  }

  static let slotCount = 3

  var onPick: ((Suggestion) -> Void)?
  private(set) var suggestions: [Suggestion] = []
  /// „…“ in German, “…” in English, around the word as typed.
  var quotes: (open: String, close: String) = ("\u{201C}", "\u{201D}")

  private let slots: [UIButton] = (0..<SuggestionBarView.slotCount).map { _ in UIButton(type: .custom) }
  private let highlights: [UIView] = (0..<SuggestionBarView.slotCount).map { _ in UIView() }
  private let separators: [UIView] = (0..<(SuggestionBarView.slotCount - 1)).map { _ in UIView() }

  override init(frame: CGRect) {
    super.init(frame: frame)
    for (index, slot) in slots.enumerated() {
      let highlight = highlights[index]
      highlight.isUserInteractionEnabled = false
      highlight.layer.cornerRadius = Look.pendingCornerRadius
      highlight.layer.cornerCurve = .continuous
      highlight.backgroundColor = UIColor { traits in
        traits.userInterfaceStyle == .dark ? UIColor(white: 1, alpha: 0.16) : UIColor(white: 1, alpha: 0.75)
      }
      highlight.isHidden = true
      addSubview(highlight)

      slot.tag = index
      slot.setTitleColor(.label, for: .normal)
      slot.setTitleColor(UIColor.label.withAlphaComponent(0.4), for: .highlighted)
      slot.titleLabel?.font = Look.font
      slot.titleLabel?.lineBreakMode = .byTruncatingMiddle
      slot.titleLabel?.adjustsFontSizeToFitWidth = true
      slot.titleLabel?.minimumScaleFactor = 0.7
      slot.contentEdgeInsets = UIEdgeInsets(top: 0, left: Look.textInset, bottom: 0, right: Look.textInset)
      slot.addTarget(self, action: #selector(handleSlotTapped(_:)), for: .touchUpInside)
      slot.isHidden = true
      addSubview(slot)
    }
    for separator in separators {
      separator.backgroundColor = UIColor.label.withAlphaComponent(0.16)
      separator.isUserInteractionEnabled = false
      addSubview(separator)
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

  func show(_ suggestions: [Suggestion]) {
    let shown = Array(suggestions.prefix(SuggestionBarView.slotCount))
    guard shown != self.suggestions else { return }
    self.suggestions = shown
    for (index, slot) in slots.enumerated() {
      guard index < shown.count else {
        slot.isHidden = true
        highlights[index].isHidden = true
        continue
      }
      let suggestion = shown[index]
      let title = suggestion.kind == .typed ? quotes.open + suggestion.text + quotes.close : suggestion.text
      slot.setTitle(title, for: .normal)
      slot.titleLabel?.font = suggestion.kind == .emoji ? Look.emojiFont : Look.font
      slot.accessibilityLabel = suggestion.text
      slot.isHidden = false
      highlights[index].isHidden = !suggestion.isPending
    }
    setNeedsLayout()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let count = CGFloat(SuggestionBarView.slotCount)
    let slotWidth = (bounds.width - Look.separatorWidth * (count - 1)) / count
    for (index, slot) in slots.enumerated() {
      let x = CGFloat(index) * (slotWidth + Look.separatorWidth)
      slot.frame = CGRect(x: x, y: 0, width: slotWidth, height: bounds.height)
      highlights[index].frame = slot.frame.inset(by: Look.pendingInset)
    }
    for (index, separator) in separators.enumerated() {
      separator.frame = CGRect(
        x: CGFloat(index + 1) * slotWidth + CGFloat(index) * Look.separatorWidth,
        y: Look.separatorInset,
        width: Look.separatorWidth,
        height: max(0, bounds.height - 2 * Look.separatorInset)
      )
      // Apple draws a separator only between two filled slots' columns; with one
      // suggestion the bar would otherwise look like an empty table.
      separator.isHidden = suggestions.isEmpty
    }
  }

  @objc private func handleSlotTapped(_ sender: UIButton) {
    guard suggestions.indices.contains(sender.tag) else { return }
    onPick?(suggestions[sender.tag])
  }
}
