import ExpoModulesCore
import UIKit

public class CreatorLinkInputModule: Module {
  public func definition() -> ModuleDefinition {
    Name("CreatorLinkInput")
    View(CreatorLinkInputView.self) {
      Events("onInput")
      Prop("value") { (view, value: String) in view.pendingValue = value }
      Prop("mostRecentEventCount") { (view, count: Int) in view.acknowledgedEventCount = count }
      Prop("editable") { (view, editable: Bool) in
        view.field.isEnabled = editable
        if !editable { view.field.resignFirstResponder() }
      }
      OnViewDidUpdateProps { view in view.applyValue() }
    }
  }
}

final class CreatorLinkInputView: ExpoView, UITextFieldDelegate, UITextPasteDelegate, UITextDropDelegate {
  let field = UITextField()
  let onInput = EventDispatcher()
  var pendingValue = ""
  var acknowledgedEventCount = 0
  private var eventCount = 0
  private var replacingPaste = false

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    field.delegate = self
    field.pasteDelegate = self
    field.textDropDelegate = self
    field.keyboardType = .URL
    field.returnKeyType = .go
    field.autocorrectionType = .no
    field.autocapitalizationType = .none
    field.smartQuotesType = .no
    field.smartDashesType = .no
    field.spellCheckingType = .no
    field.accessibilityLabel = "Creator code or link"
    field.placeholder = "Enter a creator code or link"
    field.font = UIFontMetrics(forTextStyle: .body).scaledFont(
      for: UIFont(name: "SpaceGrotesk-Regular", size: 16) ?? .systemFont(ofSize: 16)
    )
    field.adjustsFontForContentSizeCategory = true
    field.textColor = .label
    field.addTarget(self, action: #selector(changed), for: .editingChanged)
    addSubview(field)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    field.frame = bounds.insetBy(dx: 12, dy: 10)
  }

  func applyValue() {
    // A delayed JS render must not replace a newer native edit or its selection.
    guard acknowledgedEventCount == eventCount, field.text != pendingValue else { return }
    field.text = pendingValue
  }

  private func emit(_ source: String) {
    eventCount += 1
    onInput(["text": field.text ?? "", "source": source, "eventCount": eventCount])
  }

  @objc private func changed() {
    if !replacingPaste { emit("edit") }
  }

  func textFieldShouldReturn(_ textField: UITextField) -> Bool {
    guard field.isEnabled else { return false }
    emit("submit")
    field.resignFirstResponder()
    return true
  }

  func textField(_ textField: UITextField, shouldChangeCharactersIn range: NSRange, replacementString string: String) -> Bool {
    let result = (textField.text ?? "") as NSString
    return result.replacingCharacters(in: range, with: string).utf16.count <= 2048
  }

  func textPasteConfigurationSupporting(_ textPasteConfigurationSupporting: UITextPasteConfigurationSupporting,
                                       performPasteOf attributedString: NSAttributedString,
                                       to textRange: UITextRange) -> UITextRange {
    // UIKit invokes this only once the user's paste has resolved. Never read UIPasteboard.
    guard field.isEnabled, field.isFirstResponder, window != nil,
          !attributedString.string.isEmpty else { return textRange }
    let start = field.offset(from: field.beginningOfDocument, to: textRange.start)
    let length = field.offset(from: textRange.start, to: textRange.end)
    let proposed = ((field.text ?? "") as NSString).replacingCharacters(
      in: NSRange(location: start, length: length), with: attributedString.string
    )
    guard proposed.utf16.count <= 2048 else {
      emit("tooLong")
      return textRange
    }
    replacingPaste = true
    field.replace(textRange, withText: attributedString.string)
    replacingPaste = false
    emit("paste")
    field.resignFirstResponder()
    let beginning = field.position(from: field.beginningOfDocument, offset: start)
    let end = field.position(from: field.beginningOfDocument, offset: start + attributedString.length)
    if let beginning, let end, let inserted = field.textRange(from: beginning, to: end) {
      return inserted
    }
    return textRange
  }

  func textDroppableView(_ textDroppableView: UIView & UITextDroppable,
                        proposalForDrop drop: UITextDropRequest) -> UITextDropProposal {
    // Dropping text is not the explicit Paste action that triggers an offer check.
    UITextDropProposal(operation: .cancel)
  }
}
