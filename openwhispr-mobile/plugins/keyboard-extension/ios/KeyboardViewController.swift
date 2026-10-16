import os
import SwiftUI
import UIKit

private enum KeyboardLog {
  static let ui = Logger(subsystem: "com.gizmolabs.openwhispr.keyboard", category: "UI")
  static let transcription = Logger(
    subsystem: "com.gizmolabs.openwhispr.keyboard",
    category: "Transcription"
  )
  static let storage = Logger(subsystem: "com.gizmolabs.openwhispr.keyboard", category: "Storage")

  static func echo(_ message: String) {
    #if DEBUG
    NSLog("[OpenWhisprKeyboard] %@", message)
    #endif
  }
}

/// Every colour the keyboard draws. Theme-dependent ones are dynamic: iOS applies both a
/// light/dark switch and the host field's keyboardAppearance to the extension, so views
/// restyle with no code. (Overriding the style from textDocumentProxy.keyboardAppearance
/// freezes it: for a default field the proxy reports the style resolved at focus.)
private enum Palette {
  /// A colour that resolves differently for light vs dark appearance.
  private static func dynamic(light: UIColor, dark: UIColor) -> UIColor {
    UIColor { traits in traits.userInterfaceStyle == .dark ? dark : light }
  }

  private static func rgb(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat) -> UIColor {
    UIColor(red: r / 255, green: g / 255, blue: b / 255, alpha: 1)
  }

  // Apple's iOS 26 keys, one colour for every key, measured over the system glass:
  // (255,255,255) on (226,228,232) light, (61,61,61) on (23,23,23) dark. The view is
  // transparent, so the system draws the glass and these composite over it. Dark is a
  // grey that also matches Apple over a coloured backdrop ((126,61,63) on (108,22,24)).
  // Apple's light keys blend with the app content beneath the glass, which an extension
  // cannot see, so light matches on plain backdrops only.
  static let keyBackground = dynamic(light: UIColor(white: 1, alpha: 0.96), dark: UIColor(white: 0.73, alpha: 0.235))
  // Pressed function key: (196,197,200) light, (125,125,125) dark.
  static let keyPressedBackground = dynamic(light: UIColor(white: 0, alpha: 0.135), dark: UIColor(white: 1, alpha: 0.44))
  // Disabled return: key (191,193,197) / (116,116,116), glyph (172,173,177) / (129,129,129).
  static let keyDisabledBackground = dynamic(light: UIColor(white: 0, alpha: 0.155), dark: UIColor(white: 1, alpha: 0.40))
  static let keyDisabledText = dynamic(light: rgb(172, 173, 177), dark: rgb(129, 129, 129))
  // The prominent return key (Go, Search, Send, Done…) is system blue in both modes; held,
  // it shows as a plain key (keyBackground, keyText glyph).
  static let returnKeyProminent = rgb(0, 122, 255)
  static let keyText = dynamic(light: .black, dark: .white)
  // Key preview balloon, opaque as Apple's in both modes: the key under it stays hidden (its
  // glyph shows through Apple's dark one by at most 3). No shadow.
  static let popupBackground = dynamic(light: .white, dark: UIColor(white: 80 / 255, alpha: 1))

  // Brand blue and the warning amber read well on both appearances, so they
  // stay fixed.
  static let accent = UIColor(red: 0.03, green: 0.52, blue: 1.00, alpha: 1.0)
  static let issue = UIColor(red: 1.00, green: 0.62, blue: 0.04, alpha: 1.0)

  // Ink for the persistent "Turn on Full Access" pill (#1C1300 on issue amber
  // = 5.6:1, passes AA). White on the same amber is 2.1:1 and fails. The
  // transient amber states keep white ink — a 1.2s flash is not something a
  // low-vision user has to read, a permanent notice is.
  static let issueInk = UIColor(red: 0.110, green: 0.075, blue: 0.000, alpha: 1.0)

  // The desktop app's accent purple (#6C50E9, oklch(0.55 0.22 285)). Tints the
  // cancel button while cleanup runs. Fixed across appearances like accent.
  static let cleanupAccent = UIColor(red: 0.424, green: 0.314, blue: 0.914, alpha: 1.0)

  // App-icon blue gradient (deep cobalt → navy, #2457D6 → #0E3690), sampled
  // from the OpenWhispr app icon. Used for the "Activate" button.
  static let brandGradientStart = UIColor(red: 0.141, green: 0.341, blue: 0.839, alpha: 1.0)
  static let brandGradientEnd = UIColor(red: 0.055, green: 0.212, blue: 0.565, alpha: 1.0)
}

/// Apple's iOS 26 keycap type, measured at 3x on the iPhone 17 Pro: capitals and digits
/// have a 15.3pt cap height and lowercase a 13pt x-height (Apple draws lowercase larger),
/// all regular weight, on one baseline 6.5pt below the key's centre in portrait. The faces
/// that change with orientation are in Keycaps.
private enum KeyFont {
  static let modeLabel = UIFont.systemFont(ofSize: 17.75, weight: .regular)  // 123, ABC
  static let pageLabel = UIFont.systemFont(ofSize: 15, weight: .regular)  // 123 in row 3
  static let domainLabel = UIFont.systemFont(ofSize: 19, weight: .regular)  // .com, larger than 123/ABC
  static let moreSymbolsLabel = UIFont.systemFont(ofSize: 12, weight: .semibold)  // #+= in row 3
  static let glyph = UIImage.SymbolConfiguration(pointSize: 19, weight: .regular)  // shift, delete, return, globe
  static let characterBaseline: CGFloat = 6.5
  static let moreSymbolsBaseline: CGFloat = 3.17

  /// Apple sets ".", ",", "_", "#" and ":" lower than the other characters' baseline.
  static func baseline(for character: String) -> CGFloat {
    switch character {
    case ".", ",": return characterBaseline + 2.67
    case "_": return characterBaseline + 3
    case "#", ":": return characterBaseline + 1
    default: return characterBaseline
    }
  }

  /// The bottom row's field keys: its "#" is the regular-size one, on the shared baseline.
  static func shortcutBaseline(for character: String, raisesPeriod: Bool) -> CGFloat {
    switch character {
    case "#": return characterBaseline
    case "." where raisesPeriod: return baseline(for: character) - 4
    default: return baseline(for: character)
    }
  }
  // Apple's caps-lock glyph sits a little above centre (shift/delete: Keycaps; return glyphs:
  // ReturnKeyStyle).
  static let capsLockGlyphOffset: CGFloat = -0.33

  /// Apple's iOS 26 keycaps are SF Compact (narrower round letters than SF Pro), which has no
  /// public font API, so this loads the copy iOS ships. Sizes keep SF Pro's cap and x-heights.
  /// Nil where the file is missing; the SF Pro fallback then matches every height and baseline.
  static func compact(size: CGFloat, weight: CGFloat, caseSensitive: Bool = false) -> UIFont? {
    var path = "/System/Library/Fonts/Core/SFCompact.ttf"
    #if targetEnvironment(simulator)
    path = (ProcessInfo.processInfo.environment["IPHONE_SIMULATOR_ROOT"] ?? "") + path
    #endif
    guard let descriptors = CTFontManagerCreateFontDescriptorsFromURL(
      URL(fileURLWithPath: path) as CFURL
    ) as? [CTFontDescriptor], let descriptor = descriptors.first else { return nil }
    var weighted = CTFontDescriptorCreateCopyWithVariation(descriptor, 0x7767_6874 as CFNumber, weight)
    if caseSensitive {
      weighted = CTFontDescriptorCreateCopyWithFeature(
        weighted, kCaseSensitiveLayoutType as CFNumber, kCaseSensitiveLayoutOnSelector as CFNumber
      )
    }
    return CTFontCreateWithFontDescriptor(weighted, size, nil) as UIFont
  }
}

/// The keycap faces and nudges that change with orientation. Landscape keys are shorter:
/// there Apple sets letters 11% smaller with lowercase 0.67pt higher, the "123" key at the
/// 15pt row-3 size but "ABC" full size and 0.5pt lower, ".com" 0.5pt lower and shift/delete
/// on centre (17 Pro).
private struct Keycaps: Equatable {
  struct Label: Equatable {
    let font: UIFont
    let baseline: CGFloat
  }

  let lowercase: UIFont
  /// Also digits and symbols, which Apple raises to the capitals (case-sensitive forms).
  let uppercase: UIFont
  /// …except ":", "#" and "_", which Apple draws larger and without those forms.
  let large: UIFont
  /// The mode key's titles: "123" on the letters page, "ABC" on the others.
  let label123: Label
  let labelABC: Label
  let domainBaseline: CGFloat  // .com
  /// The lowercase baseline, from the capitals'.
  let lowercaseBaselineShift: CGFloat
  /// Shift and delete glyphs, from UIKit's centring.
  let edgeGlyphOffset: CGFloat

  static let portrait = Keycaps(
    scale: 1,
    label123: Label(font: KeyFont.modeLabel, baseline: 5.5),
    labelABC: Label(font: KeyFont.modeLabel, baseline: 5.5),
    domainBaseline: 3.67,
    lowercaseBaselineShift: 0,
    edgeGlyphOffset: 0.67
  )
  static let landscape = Keycaps(
    scale: 0.89,
    label123: Label(font: KeyFont.pageLabel, baseline: 4.83),
    labelABC: Label(font: KeyFont.modeLabel, baseline: 6),
    domainBaseline: 4.17,
    lowercaseBaselineShift: -0.67,
    edgeGlyphOffset: 0
  )

  private init(
    scale: CGFloat,
    label123: Label,
    labelABC: Label,
    domainBaseline: CGFloat,
    lowercaseBaselineShift: CGFloat,
    edgeGlyphOffset: CGFloat
  ) {
    lowercase = KeyFont.compact(size: 24.67 * scale, weight: 420)
      ?? UIFont.systemFont(ofSize: 24.5 * scale, weight: UIFont.Weight(-0.08))
    uppercase = KeyFont.compact(size: 22.4 * scale, weight: 480, caseSensitive: true)
      ?? UIFont.systemFont(ofSize: 21.5 * scale, weight: UIFont.Weight(0.1))
    large = KeyFont.compact(size: 27 * scale, weight: 480) ?? uppercase
    self.label123 = label123
    self.labelABC = labelABC
    self.domainBaseline = domainBaseline
    self.lowercaseBaselineShift = lowercaseBaselineShift
    self.edgeGlyphOffset = edgeGlyphOffset
  }

  func character(_ display: String) -> UIFont {
    switch display {
    case ":", "#", "_": return large
    default: return uppercase
    }
  }
}

/// Route through row/stack boundaries so a key's enlarged target also works in
/// the gaps between rows. UIKit's default hit testing stops at a parent whose
/// bounds do not contain the touch, before consulting the key's point(inside:).
/// Touches no key claims keep UIKit's default target.
private final class KeyboardRowsStack: UIStackView {
  /// Padding around the rows that still routes to the nearest key, as the system
  /// keyboard does at its edges.
  var touchMargins = UIEdgeInsets.zero

  override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
    let expanded = bounds.inset(
      by: UIEdgeInsets(
        top: -touchMargins.top,
        left: -touchMargins.left,
        bottom: -touchMargins.bottom,
        right: -touchMargins.right
      )
    )
    return expanded.contains(point)
  }

  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    guard let defaultTarget = super.hitTest(point, with: event) else { return nil }

    var nearest: KeyButton?
    var nearestDistance = CGFloat.infinity
    var nearestCenterDistance = CGFloat.infinity

    func visit(_ view: UIView) {
      guard !view.isHidden, view.isUserInteractionEnabled, view.alpha >= 0.01 else { return }
      if let key = view as? KeyButton {
        guard key.isEnabled,
              key.point(inside: key.convert(point, from: self), with: event) else { return }

        // Prefer the visible key rectangle over another key's expanded area.
        // In a gap, choose the nearer edge; center distance breaks edge ties.
        // This avoids UIKit's reverse-subview-order bias in overlapping targets.
        let rect = key.convert(key.bounds, to: self)
        let dx = max(rect.minX - point.x, 0, point.x - rect.maxX)
        let dy = max(rect.minY - point.y, 0, point.y - rect.maxY)
        let distance = dx * dx + dy * dy
        let centerDX = point.x - rect.midX
        let centerDY = point.y - rect.midY
        let centerDistance = centerDX * centerDX + centerDY * centerDY
        if distance < nearestDistance
          || (distance == nearestDistance && centerDistance < nearestCenterDistance) {
          nearest = key
          nearestDistance = distance
          nearestCenterDistance = centerDistance
        }
        return
      }
      view.subviews.forEach(visit)
    }

    subviews.forEach(visit)
    return nearest ?? defaultTarget
  }
}

private extension UIColor {
  func brightened(by amount: CGFloat) -> UIColor {
    var h: CGFloat = 0, s: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
    getHue(&h, saturation: &s, brightness: &b, alpha: &a)
    return UIColor(hue: h, saturation: s, brightness: max(0, min(b + amount, 1.0)), alpha: a)
  }
}

private final class KeyButton: UIButton {
  var hitTestOutsets = UIEdgeInsets(top: 6, left: 3, bottom: 6, right: 3)
  /// What the key inserts; the title is only what it shows (” displays, " inserts).
  var output: String?

  var normalBackground: UIColor = .clear {
    didSet { refreshPressedLook() }
  }
  var pressedBackground: UIColor?
  /// The glyph colour while pressed, where it isn't the key's tint (the held blue return).
  var pressedTint: UIColor? {
    didSet { refreshPressedLook() }
  }
  /// Keeps the pressed look while a long press owns the touch (delete repeating), as Apple's
  /// key stays pressed for the whole hold.
  var isLongPressed = false {
    didSet { refreshPressedLook() }
  }
  /// Where the title's baseline sits below the key's centre; nil keeps UIKit's centring.
  var titleBaselineFromCenter: CGFloat? {
    didSet { setNeedsLayout() }
  }
  /// Nudges the glyph down (or up, negative) from UIKit's centring to Apple's position.
  var imageOffsetY: CGFloat = 0 {
    didSet { setNeedsLayout() }
  }

  // UIKit asks for this rect on every layout, so the nudge neither accumulates nor gets lost
  // when the image changes, as a frame offset or a transform applied after layout did.
  override func imageRect(forContentRect contentRect: CGRect) -> CGRect {
    super.imageRect(forContentRect: contentRect).offsetBy(dx: 0, dy: imageOffsetY)
  }

  // Same luminous-rim treatment as PillBackgroundView: a white top-lit gradient
  // masked to the border stroke, so the button reads as glass-edged. Opt-in —
  // only the toolbar's tone and agent buttons use it.
  var showsGlassRim = false {
    didSet {
      guard showsGlassRim != oldValue else { return }
      if showsGlassRim { installGlassRim() } else { removeGlassRim() }
    }
  }

  private static let glassRimWidth: CGFloat = 1.5
  private var glassRimLayer: CAGradientLayer?

  private func installGlassRim() {
    let rim = CAGradientLayer()
    rim.colors = [
      UIColor(white: 1, alpha: 0.55).cgColor,
      UIColor(white: 1, alpha: 0.12).cgColor,
    ]
    rim.startPoint = CGPoint(x: 0.5, y: 0)
    rim.endPoint = CGPoint(x: 0.5, y: 1)
    let mask = CAShapeLayer()
    mask.fillColor = UIColor.clear.cgColor
    mask.strokeColor = UIColor.black.cgColor
    mask.lineWidth = Self.glassRimWidth
    rim.mask = mask
    layer.addSublayer(rim)
    glassRimLayer = rim
    setNeedsLayout()
  }

  private func removeGlassRim() {
    glassRimLayer?.removeFromSuperlayer()
    glassRimLayer = nil
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    if let titleBaselineFromCenter, let label = titleLabel, let font = label.font {
      label.frame.origin.y =
        bounds.midY + titleBaselineFromCenter - font.ascender - (label.bounds.height - font.lineHeight) / 2
    }
    if let rim = glassRimLayer, let mask = rim.mask as? CAShapeLayer {
      rim.frame = bounds
      mask.frame = bounds
      let inset = Self.glassRimWidth / 2
      mask.path = UIBezierPath(
        roundedRect: bounds.insetBy(dx: inset, dy: inset),
        cornerRadius: max(0, layer.cornerRadius - inset)
      ).cgPath
    }
  }

  override var isHighlighted: Bool {
    didSet { refreshPressedLook() }
  }

  // UIKit darkens a highlighted image that falls back to the normal state's; Apple's pressed
  // glyphs keep their colour, so the highlighted state carries the same image and size.
  override func setImage(_ image: UIImage?, for state: UIControl.State) {
    super.setImage(image, for: state)
    if state == .normal { super.setImage(image, for: .highlighted) }
  }

  override func setPreferredSymbolConfiguration(
    _ configuration: UIImage.SymbolConfiguration?, forImageIn state: UIControl.State
  ) {
    super.setPreferredSymbolConfiguration(configuration, forImageIn: state)
    if state == .normal { super.setPreferredSymbolConfiguration(configuration, forImageIn: .highlighted) }
  }

  private func refreshPressedLook() {
    let isPressed = isHighlighted || isLongPressed
    backgroundColor = isPressed ? (pressedBackground ?? normalBackground) : normalBackground
    // nil hands the glyph back to the button's tint.
    imageView?.tintColor = isPressed ? pressedTint : nil
  }

  override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
    let expanded = bounds.inset(
      by: UIEdgeInsets(
        top: -hitTestOutsets.top,
        left: -hitTestOutsets.left,
        bottom: -hitTestOutsets.bottom,
        right: -hitTestOutsets.right
      )
    )
    return expanded.contains(point)
  }
}

/// A diagonal-gradient (top-left → bottom-right) background, rounded to its
/// corner radius, with a soft drop shadow. Sits behind the transparent record
/// button so the button's icon/text render on top of it.
///
/// `.adaptive` is the idle dictation style — a dark-grey filled pill in light
/// mode, an outlined (transparent + light border) pill in dark mode. `.solid`
/// is a flat colour fill used for transient states (processing, errors).
private final class PillBackgroundView: UIView {
  enum Style {
    case adaptive            // grey fill (light) / outlined (dark) — "Tap to speak"
    case gradient([UIColor]) // brand blue gradient — "Activate"
    case solid(UIColor)      // flat colour — transient/issue states
  }

  private static let adaptiveFill = UIColor { traits in
    traits.userInterfaceStyle == .dark
      ? .clear
      : UIColor(red: 0.27, green: 0.27, blue: 0.29, alpha: 1.0)
  }

  private static let rimWidth: CGFloat = 1.5

  private let gradientLayer = CAGradientLayer()
  private let rimLayer = CAGradientLayer()    // glass edge highlight
  private let rimMask = CAShapeLayer()        // masks the rim to the border only
  private let highlightLayer = CALayer()      // white press overlay (lightens on touch)
  private var style: Style = .adaptive

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    layer.cornerCurve = .continuous

    // Base gradient fill (used by .gradient), behind everything.
    gradientLayer.startPoint = CGPoint(x: 0, y: 0)
    gradientLayer.endPoint = CGPoint(x: 1, y: 1)
    gradientLayer.cornerCurve = .continuous
    gradientLayer.masksToBounds = true
    layer.addSublayer(gradientLayer)

    // The "glass" is a luminous rim on the border — bright at the top edge,
    // fading down — rather than a sheen across the surface. A white vertical
    // gradient is masked to just the border stroke.
    rimLayer.colors = [
      UIColor(white: 1, alpha: 0.55).cgColor,
      UIColor(white: 1, alpha: 0.12).cgColor,
    ]
    rimLayer.startPoint = CGPoint(x: 0.5, y: 0)
    rimLayer.endPoint = CGPoint(x: 0.5, y: 1)
    rimMask.fillColor = UIColor.clear.cgColor
    rimMask.strokeColor = UIColor.black.cgColor
    rimMask.lineWidth = Self.rimWidth
    rimLayer.mask = rimMask
    layer.addSublayer(rimLayer)

    // White overlay on top of the fill (but behind the button's content, which
    // is a sibling view) — fades in on press so the button lights up.
    highlightLayer.backgroundColor = UIColor.white.cgColor
    highlightLayer.opacity = 0
    highlightLayer.masksToBounds = true
    layer.addSublayer(highlightLayer)

    // Drop shadow so the pill reads as a raised button.
    layer.shadowColor = UIColor.black.cgColor
    layer.shadowOpacity = 0.20
    layer.shadowRadius = 5
    layer.shadowOffset = CGSize(width: 0, height: 2)

    apply()
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    gradientLayer.frame = bounds
    gradientLayer.cornerRadius = layer.cornerRadius

    rimLayer.frame = bounds
    rimMask.frame = bounds
    let inset = Self.rimWidth / 2
    rimMask.path = UIBezierPath(
      roundedRect: bounds.insetBy(dx: inset, dy: inset),
      cornerRadius: max(0, layer.cornerRadius - inset)
    ).cgPath

    highlightLayer.frame = bounds
    highlightLayer.cornerRadius = layer.cornerRadius

    layer.shadowPath = UIBezierPath(roundedRect: bounds, cornerRadius: layer.cornerRadius).cgPath
  }

  func setStyle(_ style: Style) {
    self.style = style
    apply()
  }

  // Pressed = lights up: white overlay fades in and the shadow softens.
  func setPressed(_ pressed: Bool) {
    CATransaction.begin()
    CATransaction.setAnimationDuration(0.09)
    highlightLayer.opacity = pressed ? 0.22 : 0
    layer.shadowOpacity = pressed ? 0.12 : 0.20
    CATransaction.commit()
  }

  private func apply() {
    switch style {
    case .adaptive:
      gradientLayer.isHidden = true
      backgroundColor = Self.adaptiveFill
    case .gradient(let colors):
      gradientLayer.isHidden = false
      gradientLayer.colors = colors.map { $0.cgColor }
      backgroundColor = .clear
    case .solid(let color):
      gradientLayer.isHidden = true
      backgroundColor = color
    }
  }
}

/// Three dots that bounce up and down in a staggered wave — the animated
/// "Processing" indicator, so the state reads as alive rather than stuck.
private final class ProcessingDotsView: UIView {
  private static let dotSize: CGFloat = 4.5
  private static let gap: CGFloat = 4
  static let preferredSize = CGSize(width: dotSize * 3 + gap * 2, height: 14)

  private let dots: [CALayer]

  override init(frame: CGRect) {
    dots = (0..<3).map { _ in
      let dot = CALayer()
      dot.backgroundColor = UIColor.white.cgColor
      dot.cornerRadius = ProcessingDotsView.dotSize / 2
      return dot
    }
    super.init(frame: frame)
    isUserInteractionEnabled = false
    dots.forEach { layer.addSublayer($0) }
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override var intrinsicContentSize: CGSize { Self.preferredSize }

  override func layoutSubviews() {
    super.layoutSubviews()
    var x: CGFloat = 0
    for dot in dots {
      dot.frame = CGRect(
        x: x, y: bounds.midY - Self.dotSize / 2,
        width: Self.dotSize, height: Self.dotSize
      )
      x += Self.dotSize + Self.gap
    }
  }

  func startAnimating() {
    for (index, dot) in dots.enumerated() {
      dot.removeAllAnimations()
      let move = CABasicAnimation(keyPath: "transform.translation.y")
      move.fromValue = 1.5
      move.toValue = -2.5
      let fade = CABasicAnimation(keyPath: "opacity")
      fade.fromValue = 0.55
      fade.toValue = 1.0
      let group = CAAnimationGroup()
      group.animations = [move, fade]
      group.duration = 0.55
      group.autoreverses = true
      group.repeatCount = .infinity
      group.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
      group.beginTime = CACurrentMediaTime() + Double(index) * 0.15
      dot.add(group, forKey: "bounce")
    }
  }

  func stopAnimating() {
    dots.forEach { $0.removeAllAnimations() }
  }
}

/// Apple's iOS 26 key preview, measured on the iPhone 17 Pro: a head 12pt wider than the
/// key on each side with 12pt corners, its top 66pt above the key's, joined to the key by
/// an S-curve, and no shadow. Extensions can't draw above their view, so a top-row head
/// starts at the view's top instead. An edge key's head is flush with the key's outer side
/// and reaches 22pt (left edge) or 20pt (right edge) past its inner side, its letter centred
/// where a full-width head ending there would centre it (17 Pro and Pro Max).
private final class KeyPopupView: UIView {
  private static let headOutset: CGFloat = 12
  private static let leftEdgeReach: CGFloat = 22
  private static let rightEdgeReach: CGFloat = 20
  private static let headRise: CGFloat = 66
  private static let headHeight: CGFloat = 50
  private static let headRadius: CGFloat = 12
  private static let neckLength: CGFloat = 22
  private static let glyphBaseline: CGFloat = 47
  private static let glyphScale: CGFloat = 1.556

  private let fill = UIView()
  private let shapeMask = CAShapeLayer()
  private let label = UILabel()
  private weak var owner: UIView?
  private var pendingHide: DispatchWorkItem?

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    isHidden = true
    fill.backgroundColor = Palette.popupBackground
    shapeMask.fillColor = UIColor.black.cgColor
    fill.layer.mask = shapeMask
    addSubview(fill)
    label.textAlignment = .center
    label.textColor = Palette.keyText
    addSubview(label)
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  /// Shows `text` over `keyFrame` (superview coordinates), kept inside `container`.
  func show(
    _ text: String,
    font: UIFont,
    keyFrame: CGRect,
    keyCornerRadius: CGFloat,
    container: CGRect,
    owner: UIView
  ) {
    var (minX, maxX) = (keyFrame.minX - Self.headOutset, keyFrame.maxX + Self.headOutset)
    var glyphMidX = keyFrame.midX
    if minX < container.minX {
      (minX, maxX) = (keyFrame.minX, keyFrame.maxX + Self.leftEdgeReach)
      glyphMidX = maxX - keyFrame.width / 2 - Self.headOutset
    } else if maxX > container.maxX {
      (minX, maxX) = (keyFrame.minX - Self.rightEdgeReach, keyFrame.maxX)
      glyphMidX = minX + keyFrame.width / 2 + Self.headOutset
    }
    let head = CGRect(
      x: minX,
      y: max(container.minY, keyFrame.minY - Self.headRise),
      width: maxX - minX,
      height: Self.headHeight
    )
    frame = head.union(keyFrame)
    let headRect = head.offsetBy(dx: -frame.minX, dy: -frame.minY)
    let keyRect = keyFrame.offsetBy(dx: -frame.minX, dy: -frame.minY)
    fill.frame = bounds
    shapeMask.frame = fill.bounds
    shapeMask.path = Self.balloon(head: headRect, key: keyRect, keyCornerRadius: keyCornerRadius).cgPath

    // The keycap's own face and weight, enlarged: Apple's preview letter matches its key's.
    label.font = font.withSize(font.pointSize * Self.glyphScale)
    label.text = text
    label.sizeToFit()
    label.frame.origin = CGPoint(
      x: glyphMidX - frame.minX - label.bounds.width / 2,
      y: headRect.minY + Self.glyphBaseline - label.font.ascender
        - (label.bounds.height - label.font.lineHeight) / 2
    )
    pendingHide?.cancel()
    pendingHide = nil
    self.owner = owner
    isHidden = false
  }

  /// Hides the preview, but only for the key that showed it when `owner` is given, so a
  /// rolled second key's preview survives the first key's release. `after` keeps it up a
  /// moment past the release, as Apple's does (~50ms, measured on iOS 26.5); a new
  /// `show` or an immediate `hide` cancels the wait.
  func hide(owner: UIView? = nil, after delay: TimeInterval = 0) {
    guard owner == nil || owner === self.owner else { return }
    pendingHide?.cancel()
    pendingHide = nil
    guard delay > 0 else {
      isHidden = true
      self.owner = nil
      return
    }
    let work = DispatchWorkItem { [weak self] in self?.hide(owner: owner) }
    pendingHide = work
    DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
  }

  private static func balloon(head: CGRect, key: CGRect, keyCornerRadius r: CGFloat) -> UIBezierPath {
    let neckEnd = min(head.maxY + neckLength, key.maxY - r)
    let neckMid = (head.maxY + neckEnd) / 2
    let path = UIBezierPath()
    path.move(to: CGPoint(x: head.minX, y: head.minY + headRadius))
    path.addArc(
      withCenter: CGPoint(x: head.minX + headRadius, y: head.minY + headRadius),
      radius: headRadius, startAngle: .pi, endAngle: 1.5 * .pi, clockwise: true
    )
    path.addArc(
      withCenter: CGPoint(x: head.maxX - headRadius, y: head.minY + headRadius),
      radius: headRadius, startAngle: 1.5 * .pi, endAngle: 0, clockwise: true
    )
    path.addLine(to: CGPoint(x: head.maxX, y: head.maxY))
    path.addCurve(
      to: CGPoint(x: key.maxX, y: neckEnd),
      controlPoint1: CGPoint(x: head.maxX, y: neckMid),
      controlPoint2: CGPoint(x: key.maxX, y: neckMid)
    )
    path.addArc(
      withCenter: CGPoint(x: key.maxX - r, y: key.maxY - r),
      radius: r, startAngle: 0, endAngle: 0.5 * .pi, clockwise: true
    )
    path.addArc(
      withCenter: CGPoint(x: key.minX + r, y: key.maxY - r),
      radius: r, startAngle: 0.5 * .pi, endAngle: .pi, clockwise: true
    )
    path.addLine(to: CGPoint(x: key.minX, y: neckEnd))
    path.addCurve(
      to: CGPoint(x: head.minX, y: head.maxY),
      controlPoint1: CGPoint(x: key.minX, y: neckMid),
      controlPoint2: CGPoint(x: head.minX, y: neckMid)
    )
    path.close()
    return path
  }
}

private struct DictationLinkView: View {
  let url: URL

  var body: some View {
    Link(destination: url) {
      Color.clear
        .contentShape(Rectangle())
    }
  }
}

final class KeyboardViewController: UIInputViewController, UIGestureRecognizerDelegate {
  private static func infoString(_ key: String) -> String? {
    guard let value = Bundle.main.object(forInfoDictionaryKey: key) as? String else { return nil }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }

  private static var resolvedContainingAppBundleID: String {
    if let configured = infoString("OpenWhisprContainingAppBundleIdentifier") {
      return configured
    }
    let bundleID = Bundle.main.bundleIdentifier ?? "com.gizmolabs.openwhispr.keyboard"
    let suffix = ".keyboard"
    return bundleID.hasSuffix(suffix) ? String(bundleID.dropLast(suffix.count)) : bundleID
  }

  private static var appUrlScheme: String {
    infoString("OpenWhisprAppScheme") ?? "openwhispr"
  }

  private static var darwinStatusNotificationName: String {
    "\(resolvedContainingAppBundleID).keyboardStatusChanged"
  }
  private static var darwinTranscriptReadyNotificationName: String {
    "\(resolvedContainingAppBundleID).transcriptReady"
  }

  private enum KeyboardLayoutMode {
    case letters
    case numbers
    case symbols
  }

  private enum KeyRole {
    case character
    case utility
  }

  private enum CachedImages {
    static let shift = UIImage(systemName: "shift")?.withRenderingMode(.alwaysTemplate)
    static let shiftFill = UIImage(systemName: "shift.fill")?.withRenderingMode(.alwaysTemplate)
    static let capslockFill = UIImage(systemName: "capslock.fill")?.withRenderingMode(.alwaysTemplate)

    // Transparent image the size of the animated processing dots, so the button
    // reserves the right space while the real dots are overlaid on top.
    static let processingDotsSpacer = UIGraphicsImageRenderer(
      size: ProcessingDotsView.preferredSize
    ).image { _ in }

    // The full OpenWhispr logo mark: a ring enclosing three rounded bars
    // (short / tall / short), matching the app icon. Rendered as a template so
    // the button tint applies.
    static let brandLogoMark = makeBrandLogoMark()

    private static func makeBrandLogoMark() -> UIImage {
      let diameter: CGFloat = 24
      let ringWidth: CGFloat = 1.8
      let barWidth: CGFloat = 2.2
      let barSpacing: CGFloat = 2.6
      let barHeights: [CGFloat] = [7, 11, 7]

      let renderer = UIGraphicsImageRenderer(size: CGSize(width: diameter, height: diameter))
      let image = renderer.image { _ in
        UIColor.black.setStroke()
        UIColor.black.setFill()

        let ringRect = CGRect(
          x: ringWidth / 2,
          y: ringWidth / 2,
          width: diameter - ringWidth,
          height: diameter - ringWidth
        )
        let ring = UIBezierPath(ovalIn: ringRect)
        ring.lineWidth = ringWidth
        ring.stroke()

        let totalBarsWidth = barWidth * CGFloat(barHeights.count)
          + barSpacing * CGFloat(barHeights.count - 1)
        var x = (diameter - totalBarsWidth) / 2
        for height in barHeights {
          let rect = CGRect(x: x, y: (diameter - height) / 2, width: barWidth, height: height)
          UIBezierPath(roundedRect: rect, cornerRadius: barWidth / 2).fill()
          x += barWidth + barSpacing
        }
      }
      return image.withRenderingMode(.alwaysTemplate)
    }
  }

  private enum Metrics {
    // The toolbar: tone, the centred dictation pill, agent.
    static let dictationButtonSize: CGFloat = 40
    /// Where the pill's icon starts; the animated dots overlay the icon's place.
    static let pillLeadingInset: CGFloat = 16
    static let toolbarButtonSize: CGFloat = 36
    static let toolbarButtonInset: CGFloat = 8
    static let processingCancelSize: CGFloat = 30
    static let recordingWaveformBarCount = 28
    static let recordingWaveformHeight: CGFloat = 84
    static let recordingWaveformBarWidth: CGFloat = 3
    static let recordingWaveformBarSpacing: CGFloat = 4
    static let recordingActionButtonSize: CGFloat = 36
  }

  private enum KeyboardSize {
    case compact, regular, large

    static func detect(width: CGFloat) -> KeyboardSize {
      let fallbackWidth = UIScreen.main.bounds.width
      let width = width.isFinite && width > 0 ? width : fallbackWidth
      guard width.isFinite, width > 0 else { return .regular }
      if width >= 410 { return .large }
      if width < 375 { return .compact }
      return .regular
    }
  }

  private struct KeyboardMetrics: Equatable {
    /// The toolbar strip, where the pill and buttons centre: from the view's top, its height,
    /// and the gap below it to row 1. The band above the keys is the three together.
    var stripTop: CGFloat
    var stripHeight: CGFloat
    var stripGapBelow: CGFloat
    /// The toolbar's side inset, from the keyboard's edge: tone and agent sit this far in, plus
    /// their own 8pt. The bar itself starts at sideMargin, so the strip reaches past it.
    var stripSideInset: CGFloat
    let sideMargin: CGFloat
    let keyGap: CGFloat
    let keyHeight: CGFloat
    let rowGap: CGFloat
    let bottomPadding: CGFloat
    let keyCornerRadius: CGFloat
    /// Shift, delete, and the #+= / 123 key on the symbol pages, in letter keys.
    var functionKeys: CGFloat = 1.35
    /// 123/ABC and return: 2.5w + 1.5g in portrait, so they end under Z and start under M.
    var bottomKeys: CGFloat = 2.5
    var bottomGaps: CGFloat = 1.5
    /// The webSearch "." key, in letter keys.
    var searchShortcutKeys: CGFloat = 1
    /// Return beside it: 1.75w + 0.75g in portrait (63.33pt on the 17 Pro, 70pt on the Pro Max).
    var narrowReturnKeys: CGFloat = 1.75
    var narrowReturnGaps: CGFloat = 0.75
    var keycaps = Keycaps.portrait

    var topBarHeight: CGFloat { stripTop + stripHeight + stripGapBelow }
    var keyboardHeight: CGFloat { topBarHeight + 4 * keyHeight + 3 * rowGap + bottomPadding }

    // Keys: Apple's iOS 26 keyboard, measured on the iOS 26.5 simulator at 3x: 17 Pro
    // (402pt) and 17 Pro Max (440pt). Margins and gaps stay put; keys grow with width.
    // Toolbar: a strip as tall as the pill, one row gap above row 1. iOS 26 draws ~17pt of
    // glass above the view, where nothing can be drawn, so that glass is the space above the
    // pill; before iOS 26 the strip gets a row gap.
    static let regular = KeyboardMetrics(
      stripTop: 0, stripHeight: 40, stripGapBelow: 11, stripSideInset: 3,
      sideMargin: 6.5, keyGap: 6, keyHeight: 43, rowGap: 11, bottomPadding: 3,
      keyCornerRadius: 8
    )
    // 17 Pro Max: rows sit 2pt higher than on the 17 Pro's 3pt padding.
    static let large = KeyboardMetrics(
      stripTop: 0, stripHeight: 40, stripGapBelow: 11, stripSideInset: 4,
      sideMargin: 6.5, keyGap: 6, keyHeight: 45, rowGap: 11, bottomPadding: 5,
      keyCornerRadius: 8
    )
    // Home-button phones (needsInputModeSwitchKey, no system bar): iPhone SE (3rd gen),
    // 375pt at 2x. Same margins; shorter keys, wider row gaps.
    static let homeButton = KeyboardMetrics(
      stripTop: 0, stripHeight: 40, stripGapBelow: 12, stripSideInset: 3,
      sideMargin: 6.5, keyGap: 6, keyHeight: 42, rowGap: 12, bottomPadding: 4,
      keyCornerRadius: 8
    )
    // Under 375pt without a globe key: Display Zoom on Face ID phones (320pt), which
    // can't be measured here. Apple's margins, shorter keys.
    static let compact = KeyboardMetrics(
      stripTop: 0, stripHeight: 40, stripGapBelow: 10, stripSideInset: 3,
      sideMargin: 6.5, keyGap: 6, keyHeight: 39, rowGap: 10, bottomPadding: 3,
      keyCornerRadius: 7
    )
    // 17 Pro landscape: 123 and return span two keys (Q–W, O–P); key corners as in
    // portrait. No glass is drawn above the view here; the pill sits 5pt from the top and
    // from row 1, so the keys keep Apple's landscape height.
    static let landscape = KeyboardMetrics(
      stripTop: 5, stripHeight: 40, stripGapBelow: 5, stripSideInset: 4,
      sideMargin: 4, keyGap: 6, keyHeight: 27.33, rowGap: 8, bottomPadding: 4,
      keyCornerRadius: 8, functionKeys: 1.33, bottomKeys: 2, bottomGaps: 1,
      searchShortcutKeys: 0.785, narrowReturnKeys: 1.435, narrowReturnGaps: 0, keycaps: .landscape
    )

    static func current(forWidth width: CGFloat, landscape: Bool, homeButton: Bool) -> KeyboardMetrics {
      if landscape { return .landscape }
      var metrics: KeyboardMetrics
      let size = KeyboardSize.detect(width: width)
      if homeButton, size != .large {
        metrics = .homeButton
      } else {
        switch size {
        case .compact: metrics = .compact
        case .regular: metrics = .regular
        case .large: metrics = .large
        }
      }
      // Before iOS 26 nothing is drawn above the view, so the strip keeps a row gap above it
      // (unverified here: only the iOS 26.5 simulator is installed).
      if #unavailable(iOS 26) { metrics.stripTop = metrics.rowGap }
      return metrics
    }
  }

  /// The bottom row Apple shows for a keyboard type: the field keys between space and
  /// return, and how wide they are.
  private struct BottomRowLayout: Equatable {
    enum ShortcutWidth {
      case shared  // URL: the keys share the space bar's span
      case half    // email, twitter: half a 123 key each
      case letter  // webSearch: one letter key
    }

    var shortcuts: [String] = []
    var shortcutWidth = ShortcutWidth.half
    var showsSpace = true
    var showsReturn = true
    var narrowReturn = false
    /// Apple draws email's and web search's "." 4pt higher than a typed period (17 Pro).
    var raisesPeriod = false

    static func forKeyboardType(_ type: UIKeyboardType?) -> BottomRowLayout {
      switch type {
      case .URL?: return BottomRowLayout(shortcuts: [".", "/", ".com"], shortcutWidth: .shared, showsSpace: false)
      case .emailAddress?: return BottomRowLayout(shortcuts: ["@", "."], raisesPeriod: true)
      case .webSearch?:
        return BottomRowLayout(shortcuts: ["."], shortcutWidth: .letter, narrowReturn: true, raisesPeriod: true)
      case .twitter?: return BottomRowLayout(shortcuts: ["@", "#"], showsReturn: false)
      default: return BottomRowLayout()
      }
    }
  }

  /// Width constraints refreshBottomRow switches between, rebuilt with the keys.
  private struct BottomRowConstraints {
    var halfWidth: [NSLayoutConstraint] = []
    var letterWidth: [NSLayoutConstraint] = []
    var sharedWidth: [NSLayoutConstraint] = []
    var returnWidth: NSLayoutConstraint?
    var narrowReturnWidth: NSLayoutConstraint?
  }

  /// Apple's iOS 26 return key per returnKeyType: a glyph, and blue for the actions.
  private struct ReturnKeyStyle: Equatable {
    let symbolName: String
    let accessibilityLabel: String
    let isProminent: Bool
    /// From UIKit's centring to Apple's position (17 Pro): its return glyphs sit 1.83pt above
    /// the key's centre, ✓ 1.5pt, ↵ 0.5pt above and the phone 6.33pt below.
    var glyphOffsetY: CGFloat = -1.83

    static func forReturnKeyType(_ type: UIReturnKeyType?) -> ReturnKeyStyle {
      switch type ?? .default {
      case .go: return ReturnKeyStyle(symbolName: "arrow.right", accessibilityLabel: "Go", isProminent: true)
      case .join: return ReturnKeyStyle(symbolName: "arrow.right", accessibilityLabel: "Join", isProminent: true)
      case .route: return ReturnKeyStyle(symbolName: "arrow.right", accessibilityLabel: "Route", isProminent: true)
      case .search, .google, .yahoo:
        return ReturnKeyStyle(symbolName: "magnifyingglass", accessibilityLabel: "Search", isProminent: true)
      case .send: return ReturnKeyStyle(symbolName: "arrow.up", accessibilityLabel: "Send", isProminent: true)
      case .done:
        return ReturnKeyStyle(symbolName: "checkmark", accessibilityLabel: "Done", isProminent: true, glyphOffsetY: -1.5)
      case .emergencyCall:
        return ReturnKeyStyle(
          symbolName: "phone", accessibilityLabel: "Emergency call", isProminent: true, glyphOffsetY: 6.33
        )
      case .next: return ReturnKeyStyle(symbolName: "chevron.right", accessibilityLabel: "Next", isProminent: false)
      case .continue:
        return ReturnKeyStyle(symbolName: "chevron.right", accessibilityLabel: "Continue", isProminent: false)
      default:
        return ReturnKeyStyle(
          symbolName: "return.left", accessibilityLabel: "Return", isProminent: false, glyphOffsetY: -0.5
        )
      }
    }
  }

  private var metrics: KeyboardMetrics = .current(
    forWidth: UIScreen.main.bounds.width, landscape: false, homeButton: false
  )

  private let rootStack = UIStackView()
  // The toolbar: tone, the centred dictation pill, agent. The strip guide is the
  // pill-high strip at the top of the band, where the buttons centre.
  private let topBar = UIView()
  private let stripGuide = UILayoutGuide()
  private var stripConstraints: [NSLayoutConstraint] = []
  private let recordButton = UIButton(type: .system)
  private let recordButtonBackground = PillBackgroundView()
  private let processingDots = ProcessingDotsView()
  // Sits beside the processing pill ("Transcribing"/"Cleaning up") to abandon
  // the in-flight transcription. Hidden in every other state.
  private let processingCancelButton = UIButton(type: .system)
  private let toneButton = KeyButton(type: .system)
  private let keyboardRowsStack = KeyboardRowsStack()
  private let lettersRowsStack = UIStackView()
  private let numbersRowsStack = UIStackView()
  private let symbolsRowsStack = UIStackView()
  private let keyPopup = KeyPopupView()
  // One letter key's width, (row width − 9 gaps) / 10. Every key width is a multiple of
  // it, so the layout follows the screen width without any width constants.
  private let keyWidthGuide = UILayoutGuide()
  private var keyWidthGuideConstraint: NSLayoutConstraint?

  private let recordingCanvas = UIView()
  // Shown whenever hasFullAccess is false, in place of the keys AND the
  // dictation strip — the amber pill and this panel are never on screen
  // together. Built lazily: the healthy path never needs it and the
  // extension's memory budget is tight.
  private let fullAccessPanel = UIView()
  private let fullAccessPanelTitleLabel = UILabel()
  private let fullAccessPanelBodyLabel = UILabel()
  private let fullAccessPanelCloseButton = UIButton(type: .system)
  private var fullAccessPanelGlobeButton: KeyButton?
  private var didSetupFullAccessPanel = false
  // Controller-lifetime on purpose: a fresh keyboard session shows the panel
  // again, and the App Group is unavailable for persistence.
  private var didDismissFullAccessPanel = false
  private let recordingCaptionLabel = UILabel()
  // Top-of-canvas header, shown only for agent recordings ("Tell {name} What to
  // Write"); hidden for normal dictation, which has no title.
  private let recordingHeaderLabel = UILabel()
  private let recordingWaveformStack = UIStackView()
  private let recordingConfirmButton = UIButton(type: .system)
  private let recordingCancelButton = UIButton(type: .system)

  private let agentButton = KeyButton(type: .system)

  private let agentReviewCanvas = UIView()
  private let agentReviewHeaderLabel = UILabel()
  private let agentReviewTextView = UITextView()
  private let agentReviewInsertButton = UIButton(type: .system)
  private let agentReviewDismissButton = UIButton(type: .system)
  private let agentReviewRegenerateButton = UIButton(type: .system)
  private let agentReviewFollowUpButton = UIButton(type: .system)
  private let agentReviewPagerPrevButton = UIButton(type: .system)
  private let agentReviewPagerNextButton = UIButton(type: .system)
  private let agentReviewPagerLabel = UILabel()
  private let agentReviewActionStack = UIStackView()
  // "Open OpenWhispr" wake-links overlaying the regenerate/follow-up buttons,
  // enabled only when the app's heartbeat is stale (both actions need it alive).
  private var agentReviewRegenerateWakeLink: UIHostingController<DictationLinkView>?
  private var agentReviewFollowUpWakeLink: UIHostingController<DictationLinkView>?

  private var recordingWaveformBars: [UIView] = []
  private var characterButtons: [KeyButton] = []
  private var shiftButton: KeyButton?
  private var modeButton: KeyButton?
  private var spaceButton: KeyButton?
  private var returnButton: KeyButton?
  // The bottom row's field-specific keys (URL ". / .com", email "@ .", …) and the width
  // constraints refreshBottomRow switches between.
  private var shortcutButtons: [KeyButton] = []
  private var bottomRowConstraints = BottomRowConstraints()
  private var appliedBottomRowLayout: BottomRowLayout?
  private var dictationLinkHosting: UIHostingController<DictationLinkView>?
  // Detected once at setup (the host is fixed for the extension's lifetime).
  // Avoids calling the heavy private-API host detection on every button refresh.
  private var hostIsOwnApp = false
  private var didRequestCancelForCurrentSession = false

  private var layoutMode: KeyboardLayoutMode = .letters
  /// Something was typed on the 123/#+= pages since leaving letters; space then returns to
  /// letters, as on Apple's keyboard (a bare space keeps the page).
  private var typedOnSymbolPage = false
  private var isShiftEnabled = true
  private var isCapsLocked = false
  private var lastShiftTapDate: Date?

  private var deleteRepeatTimer: Timer?
  private var deleteRepeatCount = 0
  private var issueResetTimer: Timer?
  private var recordingPollTimer: Timer?
  private var waitForTranscriptTimer: Timer?
  private var isObservingHandoffNotifications = false
  private var didBuildKeyboard = false
  private var lastMetricsWidth: CGFloat = 0
  private var rootHeightConstraint: NSLayoutConstraint?
  private var topBarHeightConstraint: NSLayoutConstraint?
  private var keyboardHeightConstraint: NSLayoutConstraint?
  private var rowHeightConstraints: [NSLayoutConstraint] = []
  private var isRemoteRecordingActive = false
  private var isDarwinStartPending = false
  private var darwinStartPendingTicks = 0
  private var darwinStartActiveTicks = 0
  private var didRequestStopForCurrentSession = false
  // The job the user cancelled from the processing pill. A transcript that
  // still lands for it (the app finished before observing the cancel) is
  // discarded by job id instead of being inserted into the field.
  private var cancelledProcessingJobId: String?
  private var voiceMeterHistory: [CGFloat] = []
  private var smoothedVoiceLevel: CGFloat = 0

  // Agent flow state. isAgentGenerating gates the "Writing" pill + result poll so
  // it can't collide with a normal-dictation transcription. The Link overlay
  // drives the not-ready handoff exactly like the record button's.
  private var agentLinkHosting: UIHostingController<DictationLinkView>?
  // The current recording is an agent instruction (spoken → generated), so its
  // canvas header and post-stop state differ from normal dictation. Set when the
  // agent button starts recording in place; cleared on reset/exit.
  private var isAgentRecordingActive = false
  // The recording-canvas header shown for the current agent recording. Compose
  // uses "Tell {name} What to Write"; a follow-up overrides it with "Describe
  // your changes". nil ⇒ the compose default (resolved when the canvas shows).
  private var agentRecordingHeaderText: String?
  // Example instruction shown under the waveform (in place of "Listening")
  // while an agent recording is live. One random pick per recording, stashed at
  // record-start so canvas re-shows don't reshuffle it.
  // Selection-flavored hints stay in the shared pool even when nothing is
  // highlighted — they're the only discoverability that highlighted text can
  // be operated on.
  private static let agentComposeHints = [
    "Translate the highlighted text to Spanish",
    "Write a formal apology for being late",
    "Turn the highlighted text into a bullet list",
    "Ask for a deadline extension",
    "Write a birthday message for my coworker, Jessica",
  ]
  private static let agentFollowUpHints = [
    "Make it more casual",
    "Add a sign-off",
    "Make it shorter",
  ]
  private var agentRecordingHint: String?

  // An example to say, unless the app's own walkthrough is telling the user what to say.
  private func agentHint(from hints: [String]) -> String? {
    KeyboardHandoffProvider.shared.agentHintsHidden() ? nil : hints.randomElement()
  }
  private var isAgentGenerating = false
  private var waitForAgentResultTimer: Timer?
  private var agentReviewNoteResetTimer: Timer?
  private var isAgentReviewShown = false
  // Pager state, local to the shown card: every generated version and the one
  // currently displayed. Switching pages only updates the text view (no App
  // Group writes); insert uses agentReviewVersions[agentReviewActiveIndex].
  private var agentReviewVersions: [String] = []
  private var agentReviewActiveIndex = 0
  // The session the shown reply belongs to, so follow-up/regenerate thread onto
  // it. Empty when no card is shown.
  private var agentReviewSessionId = ""
  // A card action (regenerate or follow-up) is generating with the previous
  // versions retained underneath: an error/app-death/cancel restores the card
  // (existing versions stay insertable) instead of dropping to idle, per the plan.
  private var isAgentActionInFlight = false
  // Set while a regenerate is generating: the session/recording-job is unchanged
  // so the pre-action result is still readable. Any result adopted (poll OR the
  // Darwin agent_ready path) must be newer than this action timestamp. nil for
  // the initial compose and follow-up (a fresh recording job supersedes instead).
  private var agentActionMinUpdatedAtMs: Int64?
  // Rejection memory for agent generations the user cancelled or that timed out
  // in the keyboard while the app kept streaming. The app can race past its own
  // cancel checkpoint and write agent_ready + a result seconds later (or on the
  // next keyboard open, ≤10 min); every adoption point (poll, Darwin agent_ready,
  // resume-on-reopen) drops a result matching one of these so a cancelled/timed-
  // out card can't pop up unprompted. Mirrors `cancelledProcessingJobId`.
  //   compose/follow-up: the recording jobId the result carries.
  //   regenerate: the action's atMs (its result's jobId is "<atMs>-<uuid>").
  private var rejectedAgentJobIds: Set<String> = []
  private var rejectedAgentActionAtMs: Set<Int64> = []

  private var layoutWidth: CGFloat {
    view.bounds.width > 0 ? view.bounds.width : UIScreen.main.bounds.width
  }

  private var isLandscapeLayout: Bool {
    switch traitCollection.verticalSizeClass {
    case .compact: return true
    case .regular: return false
    default: return UIScreen.main.bounds.width > UIScreen.main.bounds.height
    }
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    KeyboardLog.ui.info("Keyboard loaded. hasFullAccess=\(self.hasFullAccess, privacy: .public)")
    KeyboardLog.echo("Keyboard loaded. hasFullAccess=\(self.hasFullAccess)")
    metrics = KeyboardMetrics.current(
      forWidth: layoutWidth, landscape: isLandscapeLayout, homeButton: needsInputModeSwitchKey
    )
    setupLayout()
    applyKeyboardHeight()
    refreshRecordButton()
    buildKeyboardIfNeeded()
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    refreshMetricsIfNeeded()
    applyKeyboardHeight()
  }

  private func applyKeyboardHeight() {
    let keyboardHeight = metrics.keyboardHeight

    if let keyboardHeightConstraint {
      keyboardHeightConstraint.constant = keyboardHeight
    } else {
      let constraint = view.heightAnchor.constraint(equalToConstant: keyboardHeight)
      constraint.priority = UILayoutPriority(999)
      constraint.isActive = true
      keyboardHeightConstraint = constraint
    }
    preferredContentSize = CGSize(width: view.bounds.width, height: keyboardHeight)
  }

  override func textDidChange(_ textInput: UITextInput?) {
    super.textDidChange(textInput)
    syncShiftWithContextIfNeeded()
    refreshFieldAwareKeys()
    _ = consumePendingTranscriptIfAvailable(trigger: "textDidChange")
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    // Without Full Access every write below is a no-op and every resume gate
    // reads a dead App Group. Today this method reaches refreshRecordButton()
    // anyway, but only because four separate resume gates each happen to fail
    // closed — an explicit guard means a future early return can't silently
    // reintroduce a dead-but-healthy-looking keyboard.
    guard hasFullAccess else {
      refreshRecordButton()
      return
    }
    KeyboardHandoffProvider.shared.markShown()
    KeyboardHandoffProvider.shared.storeHostReturnInfo(from: self)
    refreshToneButton()
    refreshAgentButton()
    // The review card owns the screen until the user acts on it; don't let a
    // stale recording flag or resume path tear it down on reappear. Re-gate its
    // controls so the regenerate/follow-up wake-links reflect current app
    // liveness after time away.
    if isAgentReviewShown {
      refreshAgentReviewControls()
      startHandoffObservers()
      startRecordingPoll()
      return
    }
    let consumedPendingTranscript = consumePendingTranscriptIfAvailable(trigger: "viewDidAppear")
    isRemoteRecordingActive = KeyboardHandoffProvider.shared.isRecordingActive()
    if isRemoteRecordingActive {
      // Recover the agent flag if the keyboard was rebuilt mid-recording, so the
      // canvas header/accent and the post-stop generating path are correct.
      isAgentRecordingActive = KeyboardHandoffProvider.shared.hasAgentJobForCurrentRecording()
      enterRecordingMode()
    } else if !consumedPendingTranscript && !resumeFreshHandoffState() {
      refreshRecordButton()
    }
    logRecordMarker("viewDidAppear", extra: "consumedPending=\(consumedPendingTranscript)")
    startHandoffObservers()
    startRecordingPoll()
  }

  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    logRecordMarker("viewWillDisappear")
    stopDeleteRepeating()
    issueResetTimer?.invalidate()
    waitForTranscriptTimer?.invalidate()
    waitForAgentResultTimer?.invalidate()
    agentReviewNoteResetTimer?.invalidate()
    stopRecordingPoll()
    stopHandoffObservers()
  }

  deinit {
    stopDeleteRepeating()
    issueResetTimer?.invalidate()
    waitForTranscriptTimer?.invalidate()
    waitForAgentResultTimer?.invalidate()
    agentReviewNoteResetTimer?.invalidate()
    stopRecordingPoll()
    stopHandoffObservers()
  }

  @objc private func handleCharacterKeyTapped(_ sender: KeyButton) {
    guard let output = sender.output else { return }
    playKeyClick()

    let insertion = layoutMode == .letters && isShiftEnabled ? output.uppercased() : output
    let text = smartQuoteSubstitution(for: insertion) ?? insertion
    textDocumentProxy.insertText(text)
    if layoutMode != .letters {
      // Apple's apostrophe returns to letters at once ("rock 'n' roll", "'90s").
      if output == "'" { returnToLetters() } else { typedOnSymbolPage = true }
    }

    // Shift ends after one letter unless the field capitalizes the next one too (all
    // characters); iOS doesn't report the keyboard's own inserts back in time to rely on.
    syncShiftWithContextIfNeeded()
    refreshAfterEdit()
  }

  @objc private func handleCharacterKeyDown(_ sender: KeyButton) {
    guard let text = sender.title(for: .normal) else { return }
    keyPopup.show(
      text,
      font: sender.titleLabel?.font ?? metrics.keycaps.uppercase,
      keyFrame: sender.convert(sender.bounds, to: rootStack),
      keyCornerRadius: metrics.keyCornerRadius,
      container: rootStack.layoutMarginsGuide.layoutFrame,
      owner: sender
    )
  }

  @objc private func handleCharacterKeyReleased(_ sender: KeyButton) {
    keyPopup.hide(owner: sender, after: 0.05)
  }

  @objc private func handleShiftTapped() {
    playKeyClick()
    let now = Date()

    if isCapsLocked {
      isCapsLocked = false
      isShiftEnabled = false
      lastShiftTapDate = nil
      refreshShiftState()
      return
    }

    if isShiftEnabled,
      let previousTap = lastShiftTapDate,
      now.timeIntervalSince(previousTap) < 0.33
    {
      isCapsLocked = true
      isShiftEnabled = true
    } else {
      isCapsLocked = false
      isShiftEnabled.toggle()
    }

    lastShiftTapDate = now
    refreshShiftState()
  }

  @objc private func handleBackspaceTapped() {
    playKeyClick()
    textDocumentProxy.deleteBackward()
    refreshAfterEdit()
  }

  @objc private func handleBackspaceLongPress(_ gesture: UILongPressGestureRecognizer) {
    switch gesture.state {
    case .began:
      (gesture.view as? KeyButton)?.isLongPressed = true
      startDeleteRepeating()
    case .ended, .cancelled, .failed:
      (gesture.view as? KeyButton)?.isLongPressed = false
      stopDeleteRepeating()
      refreshAfterEdit()
    default:
      break
    }
  }

  /// Bottom row 123/ABC: letters ⇄ numbers.
  @objc private func handleModeKeyTapped() {
    playKeyClick()
    layoutMode = layoutMode == .letters ? .numbers : .letters
    typedOnSymbolPage = false
    isCapsLocked = false
    isShiftEnabled = layoutMode == .letters ? shouldAutoCapitalize() : false
    refreshVisibleKeyboardMode()
    refreshShiftState()
  }

  /// Row 3 #+= / 123: numbers ⇄ symbols.
  @objc private func handlePageKeyTapped() {
    playKeyClick()
    layoutMode = layoutMode == .numbers ? .symbols : .numbers
    refreshVisibleKeyboardMode()
  }

  @objc private func handleSpaceTapped() {
    playKeyClick()
    if !applyDoubleSpacePeriod() {
      textDocumentProxy.insertText(" ")
    }
    if layoutMode != .letters && typedOnSymbolPage { returnToLetters() }
    syncShiftWithContextIfNeeded()
    refreshAfterEdit()
  }

  /// Leaves the 123/#+= pages for letters, with shift following the text (after "e.g. " too).
  private func returnToLetters() {
    layoutMode = .letters
    typedOnSymbolPage = false
    isCapsLocked = false
    isShiftEnabled = shouldAutoCapitalize()
    refreshVisibleKeyboardMode()
    refreshShiftState()
  }

  @objc private func handleShortcutTapped(_ sender: KeyButton) {
    guard let output = sender.output else { return }
    playKeyClick()
    textDocumentProxy.insertText(output)
    syncShiftWithContextIfNeeded()
    refreshAfterEdit()
  }

  @objc private func handleNextKeyboardTapped() {
    playKeyClick()
    advanceToNextInputMode()
  }

  @objc private func handleInputModeListButton(_ sender: UIButton, forEvent event: UIEvent) {
    handleInputModeList(from: sender, with: event)
  }

  private func applyDoubleSpacePeriod() -> Bool {
    // Space over a selection replaces it with a space, never ". ".
    guard (textDocumentProxy.selectedText ?? "").isEmpty else { return false }
    let context = textDocumentProxy.documentContextBeforeInput ?? ""
    let chars = Array(context)
    guard chars.count >= 2 else { return false }
    guard chars.last == " " else { return false }
    let prior = chars[chars.count - 2]
    guard prior.isLetter || prior.isNumber else { return false }

    textDocumentProxy.deleteBackward()
    textDocumentProxy.insertText(". ")
    return true
  }

  private func smartQuoteSubstitution(for character: String) -> String? {
    guard character == "\"" || character == "'" else { return nil }
    let context = textDocumentProxy.documentContextBeforeInput ?? ""
    let opening = shouldUseOpeningQuote(context: context)
    if character == "\"" {
      return opening ? "\u{201C}" : "\u{201D}"
    }
    return opening ? "\u{2018}" : "\u{2019}"
  }

  private func shouldUseOpeningQuote(context: String) -> Bool {
    guard let last = context.last else { return true }
    if last.isWhitespace { return true }
    if last == "(" || last == "[" || last == "{" { return true }
    return false
  }

  @objc private func handleReturnTapped() {
    playKeyClick()
    textDocumentProxy.insertText("\n")
    syncShiftWithContextIfNeeded()
    refreshAfterEdit()
  }

  private func setupLayout() {
    // (Nearly) transparent so the system keyboard backdrop shows through, letting the
    // keyboard blend seamlessly with the system chrome above and below (the
    // candidate area and the globe/dictation safe-area bar) instead of sitting
    // on a mismatched grey panel. Keys keep their own backgrounds.
    // iOS sends a keyboard extension no touches where its pixels are fully transparent, so
    // a clear view drops every tap in the gaps and padding that KeyboardRowsStack routes.
    // 0.1% black is invisible (no pixel value changes) and keeps those taps.
    view.backgroundColor = UIColor(white: 0, alpha: 0.001)

    // The toolbar, then the gap to row 1, then the rows.
    rootStack.axis = .vertical
    rootStack.spacing = metrics.stripGapBelow
    // The padding is a layout margin, not an offset from the edges, so the stack
    // spans the whole keyboard and touches in the padding can reach the rows.
    rootStack.isLayoutMarginsRelativeArrangement = true
    rootStack.insetsLayoutMarginsFromSafeArea = false
    rootStack.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(rootStack)

    // iOS first lays a third-party keyboard out at its own default height (444pt on a
    // 17 Pro) for a frame or two before adopting ours. The content keeps its own height
    // on the bottom edge, so keys never stretch; only the top constraint yields.
    rootHeightConstraint = rootStack.heightAnchor.constraint(equalToConstant: metrics.keyboardHeight)
    rootHeightConstraint?.priority = UILayoutPriority(999)
    let rootTopConstraint = rootStack.topAnchor.constraint(equalTo: view.topAnchor)
    rootTopConstraint.priority = .defaultHigh

    NSLayoutConstraint.activate([
      rootStack.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      rootStack.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      rootStack.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      rootTopConstraint,
      rootHeightConstraint,
    ].compactMap { $0 })
    applyRootPadding()

    setupTopBar()
    setupKeyboardArea()
    setupRecordingCanvas()
    setupAgentReviewCanvas()
  }

  private func setupRecordingCanvas() {
    // Transparent like the root view, so the recording overlay sits directly on
    // the system keyboard backdrop (the keys are faded out while it's shown). It
    // still intercepts touches, so the hidden keys can't be tapped.
    recordingCanvas.backgroundColor = .clear
    recordingCanvas.translatesAutoresizingMaskIntoConstraints = false
    recordingCanvas.alpha = 0
    recordingCanvas.isUserInteractionEnabled = false
    view.addSubview(recordingCanvas)

    configureIconButton(
      recordingCancelButton,
      systemImage: "xmark",
      accessibilityLabel: "Cancel recording",
      action: #selector(handleCancelRecordingTapped)
    )
    recordingCanvas.addSubview(recordingCancelButton)

    configureIconButton(
      recordingConfirmButton,
      systemImage: "checkmark",
      accessibilityLabel: "Confirm and transcribe",
      action: #selector(handleStopRecordingTapped)
    )
    recordingCanvas.addSubview(recordingConfirmButton)

    recordingWaveformStack.axis = .horizontal
    recordingWaveformStack.spacing = Metrics.recordingWaveformBarSpacing
    recordingWaveformStack.alignment = .center
    recordingWaveformStack.translatesAutoresizingMaskIntoConstraints = false
    recordingCanvas.addSubview(recordingWaveformStack)

    for _ in 0..<Metrics.recordingWaveformBarCount {
      let bar = UIView()
      bar.translatesAutoresizingMaskIntoConstraints = false
      bar.backgroundColor = Palette.accent
      bar.layer.cornerRadius = 1.5
      bar.alpha = 0.5
      bar.widthAnchor.constraint(equalToConstant: Metrics.recordingWaveformBarWidth).isActive = true
      bar.heightAnchor.constraint(equalToConstant: Metrics.recordingWaveformHeight).isActive = true
      bar.transform = CGAffineTransform(scaleX: 1, y: 0.08)
      recordingWaveformBars.append(bar)
      recordingWaveformStack.addArrangedSubview(bar)
    }

    recordingCaptionLabel.translatesAutoresizingMaskIntoConstraints = false
    recordingCaptionLabel.text = "Listening"
    recordingCaptionLabel.font = UIFont.systemFont(ofSize: 13, weight: .medium)
    recordingCaptionLabel.textColor = Palette.keyText.withAlphaComponent(0.55)
    recordingCaptionLabel.textAlignment = .center
    recordingCanvas.addSubview(recordingCaptionLabel)

    recordingHeaderLabel.translatesAutoresizingMaskIntoConstraints = false
    recordingHeaderLabel.font = UIFont.systemFont(ofSize: 15, weight: .semibold)
    recordingHeaderLabel.textColor = Palette.keyText
    recordingHeaderLabel.textAlignment = .center
    recordingHeaderLabel.adjustsFontSizeToFitWidth = true
    recordingHeaderLabel.minimumScaleFactor = 0.8
    recordingHeaderLabel.isHidden = true
    recordingCanvas.addSubview(recordingHeaderLabel)

    NSLayoutConstraint.activate([
      recordingCanvas.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      recordingCanvas.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      recordingCanvas.topAnchor.constraint(equalTo: view.topAnchor),
      recordingCanvas.bottomAnchor.constraint(equalTo: view.bottomAnchor),

      recordingCancelButton.leadingAnchor.constraint(equalTo: recordingCanvas.leadingAnchor, constant: 16),
      recordingCancelButton.topAnchor.constraint(equalTo: recordingCanvas.topAnchor, constant: 12),
      recordingCancelButton.widthAnchor.constraint(equalToConstant: Metrics.recordingActionButtonSize),
      recordingCancelButton.heightAnchor.constraint(equalToConstant: Metrics.recordingActionButtonSize),

      recordingConfirmButton.trailingAnchor.constraint(equalTo: recordingCanvas.trailingAnchor, constant: -16),
      recordingConfirmButton.topAnchor.constraint(equalTo: recordingCanvas.topAnchor, constant: 12),
      recordingConfirmButton.widthAnchor.constraint(equalToConstant: Metrics.recordingActionButtonSize),
      recordingConfirmButton.heightAnchor.constraint(equalToConstant: Metrics.recordingActionButtonSize),

      recordingHeaderLabel.centerYAnchor.constraint(equalTo: recordingCancelButton.centerYAnchor),
      recordingHeaderLabel.leadingAnchor.constraint(equalTo: recordingCancelButton.trailingAnchor, constant: 8),
      recordingHeaderLabel.trailingAnchor.constraint(equalTo: recordingConfirmButton.leadingAnchor, constant: -8),

      recordingWaveformStack.centerXAnchor.constraint(equalTo: recordingCanvas.centerXAnchor),
      recordingWaveformStack.centerYAnchor.constraint(equalTo: recordingCanvas.centerYAnchor, constant: -6),

      recordingCaptionLabel.centerXAnchor.constraint(equalTo: recordingCanvas.centerXAnchor),
      recordingCaptionLabel.topAnchor.constraint(equalTo: recordingWaveformStack.bottomAnchor, constant: 14),
    ])
  }

  /// The agent review overlay: an alpha-swapped card (like recordingCanvas) at
  /// the existing keyboard height. Its top row mirrors the recording canvas (✕
  /// dismiss / ✓ insert in the corners) with the "Ask for changes" follow-up
  /// capsule centred between them; a scrollable read-only text view of the
  /// generated text; a bottom bar with ↻ regenerate leading and the 1/N pager
  /// centred. The header label is hidden by default and only surfaces to flash a
  /// transient note (see flashAgentReviewNote), swapping out with the capsule.
  private func setupAgentReviewCanvas() {
    agentReviewCanvas.backgroundColor = .clear
    agentReviewCanvas.translatesAutoresizingMaskIntoConstraints = false
    agentReviewCanvas.alpha = 0
    agentReviewCanvas.isUserInteractionEnabled = false
    view.addSubview(agentReviewCanvas)

    // Hidden until flashAgentReviewNote surfaces it: it shares the top-centre slot
    // with the follow-up capsule, hiding the capsule while a note is shown.
    agentReviewHeaderLabel.translatesAutoresizingMaskIntoConstraints = false
    agentReviewHeaderLabel.font = UIFont.systemFont(ofSize: 13, weight: .semibold)
    agentReviewHeaderLabel.textColor = Palette.keyText.withAlphaComponent(0.55)
    agentReviewHeaderLabel.textAlignment = .center
    agentReviewHeaderLabel.adjustsFontSizeToFitWidth = true
    agentReviewHeaderLabel.minimumScaleFactor = 0.8
    agentReviewHeaderLabel.isHidden = true
    agentReviewCanvas.addSubview(agentReviewHeaderLabel)

    agentReviewTextView.translatesAutoresizingMaskIntoConstraints = false
    agentReviewTextView.backgroundColor = .clear
    // Read-only but scrollable: scrolling is a scroll-view behaviour independent
    // of text selection, so leaving it non-selectable avoids any selection UI
    // (which keyboard extensions can't present anyway) while still scrolling.
    agentReviewTextView.isEditable = false
    agentReviewTextView.isSelectable = false
    agentReviewTextView.isScrollEnabled = true
    agentReviewTextView.alwaysBounceVertical = true
    agentReviewTextView.showsVerticalScrollIndicator = true
    agentReviewTextView.textContainerInset = UIEdgeInsets(top: 4, left: 2, bottom: 4, right: 2)
    agentReviewTextView.font = UIFont.systemFont(ofSize: 16, weight: .regular)
    agentReviewTextView.textColor = Palette.keyText
    agentReviewCanvas.addSubview(agentReviewTextView)

    configureIconButton(
      agentReviewDismissButton,
      systemImage: "xmark",
      accessibilityLabel: "Dismiss",
      action: #selector(handleAgentReviewDismissTapped)
    )
    agentReviewCanvas.addSubview(agentReviewDismissButton)

    configureIconButton(
      agentReviewInsertButton,
      systemImage: "checkmark",
      accessibilityLabel: "Insert",
      action: #selector(handleAgentReviewInsertTapped)
    )
    agentReviewInsertButton.backgroundColor = Palette.cleanupAccent
    agentReviewInsertButton.tintColor = .white
    agentReviewCanvas.addSubview(agentReviewInsertButton)

    configureIconButton(
      agentReviewRegenerateButton,
      systemImage: "arrow.clockwise",
      accessibilityLabel: "Regenerate",
      action: #selector(handleAgentReviewRegenerateTapped)
    )
    configureIconButton(
      agentReviewPagerPrevButton,
      systemImage: "chevron.left",
      accessibilityLabel: "Previous version",
      action: #selector(handleAgentReviewPagerPrevTapped),
      symbolPointSize: 15
    )
    configureIconButton(
      agentReviewPagerNextButton,
      systemImage: "chevron.right",
      accessibilityLabel: "Next version",
      action: #selector(handleAgentReviewPagerNextTapped),
      symbolPointSize: 15
    )
    configureAgentReviewFollowUpCapsule()

    // The pager chevrons hug the "1/N" label with no pill background, reading as
    // a single control rather than three separate keys.
    agentReviewPagerPrevButton.backgroundColor = .clear
    agentReviewPagerNextButton.backgroundColor = .clear
    agentReviewPagerLabel.translatesAutoresizingMaskIntoConstraints = false
    agentReviewPagerLabel.font = UIFont.systemFont(ofSize: 15, weight: .semibold)
    agentReviewPagerLabel.textColor = Palette.keyText.withAlphaComponent(0.55)
    agentReviewPagerLabel.textAlignment = .center
    agentReviewPagerLabel.setContentHuggingPriority(.required, for: .horizontal)

    agentReviewActionStack.axis = .horizontal
    agentReviewActionStack.alignment = .center
    agentReviewActionStack.spacing = 2
    agentReviewActionStack.translatesAutoresizingMaskIntoConstraints = false
    agentReviewActionStack.addArrangedSubview(agentReviewPagerPrevButton)
    agentReviewActionStack.addArrangedSubview(agentReviewPagerLabel)
    agentReviewActionStack.addArrangedSubview(agentReviewPagerNextButton)
    agentReviewCanvas.addSubview(agentReviewActionStack)

    agentReviewRegenerateButton.translatesAutoresizingMaskIntoConstraints = false
    agentReviewCanvas.addSubview(agentReviewRegenerateButton)
    agentReviewCanvas.addSubview(agentReviewFollowUpButton)

    NSLayoutConstraint.activate([
      agentReviewCanvas.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      agentReviewCanvas.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      agentReviewCanvas.topAnchor.constraint(equalTo: view.topAnchor),
      agentReviewCanvas.bottomAnchor.constraint(equalTo: view.bottomAnchor),

      // Top row mirrors the recording canvas: ✕ leading / ✓ trailing at 16,12.
      agentReviewDismissButton.leadingAnchor.constraint(equalTo: agentReviewCanvas.leadingAnchor, constant: 16),
      agentReviewDismissButton.topAnchor.constraint(equalTo: agentReviewCanvas.topAnchor, constant: 12),
      agentReviewDismissButton.widthAnchor.constraint(equalToConstant: Metrics.recordingActionButtonSize),
      agentReviewDismissButton.heightAnchor.constraint(equalToConstant: Metrics.recordingActionButtonSize),

      agentReviewInsertButton.trailingAnchor.constraint(equalTo: agentReviewCanvas.trailingAnchor, constant: -16),
      agentReviewInsertButton.topAnchor.constraint(equalTo: agentReviewCanvas.topAnchor, constant: 12),
      agentReviewInsertButton.widthAnchor.constraint(equalToConstant: Metrics.recordingActionButtonSize),
      agentReviewInsertButton.heightAnchor.constraint(equalToConstant: Metrics.recordingActionButtonSize),

      // Follow-up capsule fills the top-centre slot between ✕ and ✓. Leading/
      // trailing ≥ constraints keep it clear of both edge buttons on narrow widths.
      agentReviewFollowUpButton.heightAnchor.constraint(equalToConstant: Metrics.recordingActionButtonSize),
      agentReviewFollowUpButton.centerXAnchor.constraint(equalTo: agentReviewCanvas.centerXAnchor),
      agentReviewFollowUpButton.centerYAnchor.constraint(equalTo: agentReviewDismissButton.centerYAnchor),
      agentReviewFollowUpButton.leadingAnchor.constraint(
        greaterThanOrEqualTo: agentReviewDismissButton.trailingAnchor, constant: 8),
      agentReviewFollowUpButton.trailingAnchor.constraint(
        lessThanOrEqualTo: agentReviewInsertButton.leadingAnchor, constant: -8),

      // The header shares the capsule's slot: shown only while a note flashes.
      agentReviewHeaderLabel.centerYAnchor.constraint(equalTo: agentReviewDismissButton.centerYAnchor),
      agentReviewHeaderLabel.leadingAnchor.constraint(equalTo: agentReviewDismissButton.trailingAnchor, constant: 8),
      agentReviewHeaderLabel.trailingAnchor.constraint(equalTo: agentReviewInsertButton.leadingAnchor, constant: -8),

      // Bottom bar: ↻ regenerate leading, pager centred, bottom-right empty.
      agentReviewRegenerateButton.leadingAnchor.constraint(equalTo: agentReviewCanvas.leadingAnchor, constant: 16),
      agentReviewRegenerateButton.bottomAnchor.constraint(equalTo: agentReviewCanvas.bottomAnchor, constant: -12),
      agentReviewRegenerateButton.widthAnchor.constraint(equalToConstant: Metrics.recordingActionButtonSize),
      agentReviewRegenerateButton.heightAnchor.constraint(equalToConstant: Metrics.recordingActionButtonSize),

      agentReviewPagerPrevButton.widthAnchor.constraint(equalToConstant: 24),
      agentReviewPagerPrevButton.heightAnchor.constraint(equalToConstant: Metrics.recordingActionButtonSize),
      agentReviewPagerNextButton.widthAnchor.constraint(equalToConstant: 24),
      agentReviewPagerNextButton.heightAnchor.constraint(equalToConstant: Metrics.recordingActionButtonSize),

      // Pager centred on the regenerate button's baseline.
      agentReviewActionStack.centerXAnchor.constraint(equalTo: agentReviewCanvas.centerXAnchor),
      agentReviewActionStack.centerYAnchor.constraint(equalTo: agentReviewRegenerateButton.centerYAnchor),
      agentReviewActionStack.leadingAnchor.constraint(
        greaterThanOrEqualTo: agentReviewRegenerateButton.trailingAnchor, constant: 8),
      agentReviewActionStack.trailingAnchor.constraint(
        lessThanOrEqualTo: agentReviewCanvas.trailingAnchor, constant: -16),

      // Text view spans between the ✕ top row and the ↻ bottom bar.
      agentReviewTextView.topAnchor.constraint(equalTo: agentReviewDismissButton.bottomAnchor, constant: 10),
      agentReviewTextView.leadingAnchor.constraint(equalTo: agentReviewCanvas.leadingAnchor, constant: 18),
      agentReviewTextView.trailingAnchor.constraint(equalTo: agentReviewCanvas.trailingAnchor, constant: -18),
      agentReviewTextView.bottomAnchor.constraint(equalTo: agentReviewRegenerateButton.topAnchor, constant: -10),
    ])

    setupAgentReviewWakeLinks()
  }

  /// The follow-up control is a labelled capsule ("🎙 Ask for changes") rather
  /// than a bare icon button — built with UIButton.Configuration like the record
  /// button. It keeps the 36pt height/key styling; the mic glyph is tinted the
  /// agent purple while the label stays key-text.
  private func configureAgentReviewFollowUpCapsule() {
    agentReviewFollowUpButton.translatesAutoresizingMaskIntoConstraints = false
    agentReviewFollowUpButton.backgroundColor = Palette.keyBackground
    agentReviewFollowUpButton.layer.cornerRadius = Metrics.recordingActionButtonSize / 2
    agentReviewFollowUpButton.layer.cornerCurve = .continuous
    agentReviewFollowUpButton.accessibilityLabel = "Ask for changes"

    var config = UIButton.Configuration.plain()
    config.title = "Ask for changes"
    // The title tints key-text (baseForegroundColor); the mic glyph is pinned to
    // the agent purple with an alwaysOriginal image so it ignores that tint.
    config.baseForegroundColor = Palette.keyText
    config.image = UIImage(systemName: "mic.fill")?
      .withTintColor(Palette.cleanupAccent, renderingMode: .alwaysOriginal)
    config.imagePadding = 6
    config.imagePlacement = .leading
    config.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 12, bottom: 0, trailing: 14)
    config.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(pointSize: 13, weight: .semibold)
    config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { incoming in
      var outgoing = incoming
      outgoing.font = UIFont.systemFont(ofSize: 13, weight: .semibold)
      return outgoing
    }
    agentReviewFollowUpButton.configuration = config
    agentReviewFollowUpButton.addTarget(
      self, action: #selector(handleAgentReviewFollowUpTapped), for: .touchUpInside
    )
  }

  /// Overlays each app-requiring card control (regenerate, follow-up) with a
  /// SwiftUI Link to OpenWhispr, mirroring the entry button's handoff link. The
  /// links stay disabled while the app is alive; refreshAgentReviewControls
  /// enables them when the heartbeat goes stale so a tap wakes the app instead.
  ///
  /// Each button also gets a zero-duration press recogniser (like the record
  /// button's) that, when its wake-link is live, writes the request/action into
  /// the App Group *before* the Link opens the app — so the woken app performs
  /// the right work instead of an unrelated recording:
  ///   • follow-up → a recording-handoff URL; the gesture writes a follow_up
  ///     request + hides the card, so the recording becomes an agent follow-up.
  ///   • regenerate → an `intent=agent-action` URL the app short-circuits into
  ///     its cold-start `runAgentAction` replay; the gesture writes the action
  ///     + at-ms twin first (NO recording is started for a regenerate wake).
  private func setupAgentReviewWakeLinks() {
    guard let regenerateURL = makeReviewWakeURL(intent: "agent-action"),
          let followUpURL = makeReviewWakeURL(intent: nil) else { return }

    agentReviewRegenerateWakeLink = installWakeLink(url: regenerateURL, over: agentReviewRegenerateButton)
    agentReviewFollowUpWakeLink = installWakeLink(url: followUpURL, over: agentReviewFollowUpButton)

    let regeneratePress = UILongPressGestureRecognizer(
      target: self, action: #selector(handleRegenerateWakePress(_:))
    )
    regeneratePress.minimumPressDuration = 0
    regeneratePress.cancelsTouchesInView = false
    regeneratePress.delaysTouchesBegan = false
    regeneratePress.delegate = self
    agentReviewRegenerateButton.addGestureRecognizer(regeneratePress)

    let followUpPress = UILongPressGestureRecognizer(
      target: self, action: #selector(handleFollowUpWakePress(_:))
    )
    followUpPress.minimumPressDuration = 0
    followUpPress.cancelsTouchesInView = false
    followUpPress.delaysTouchesBegan = false
    followUpPress.delegate = self
    agentReviewFollowUpButton.addGestureRecognizer(followUpPress)
  }

  /// Builds a keyboard-dictation wake URL carrying the host return info. `intent`
  /// (e.g. "agent-action") lets the app's URL handler route the wake to a
  /// non-recording path; nil is the normal recording handoff.
  private func makeReviewWakeURL(intent: String?) -> URL? {
    let provider = KeyboardHandoffProvider.shared
    var components = URLComponents(string: "\(Self.appUrlScheme)://keyboard-dictation")!
    components.queryItems = [URLQueryItem(name: "source", value: "keyboard")]
    if let intent {
      components.queryItems?.append(URLQueryItem(name: "intent", value: intent))
    }
    if let scheme = provider.hostUrlScheme(from: self) {
      components.queryItems?.append(URLQueryItem(name: "returnScheme", value: scheme))
    }
    if let bundle = provider.detectHostBundleID(from: self) {
      components.queryItems?.append(URLQueryItem(name: "hostBundle", value: bundle))
    }
    return components.url
  }

  /// Regenerate wake: when the wake-link is live (app dead), write the action +
  /// at-ms twin so the woken app replays it via runAgentAction. The Link opens
  /// the `intent=agent-action` URL simultaneously; no recording is started.
  @objc private func handleRegenerateWakePress(_ gesture: UILongPressGestureRecognizer) {
    guard gesture.state == .ended,
          agentReviewRegenerateWakeLink?.view.isUserInteractionEnabled == true,
          !agentReviewSessionId.isEmpty else { return }
    KeyboardHandoffProvider.shared.writeAgentRegenerateAction(sessionId: agentReviewSessionId)
    logRecordMarker("handleRegenerateWakePress", extra: "session=\(agentReviewSessionId)")
  }

  /// Follow-up wake: when the wake-link is live, write a follow_up request and
  /// hide the card before the Link opens the recording-handoff URL — so the
  /// recording the woken app starts is a legitimate agent follow-up job.
  @objc private func handleFollowUpWakePress(_ gesture: UILongPressGestureRecognizer) {
    guard gesture.state == .ended,
          agentReviewFollowUpWakeLink?.view.isUserInteractionEnabled == true,
          !agentReviewSessionId.isEmpty else { return }
    KeyboardHandoffProvider.shared.writeAgentFollowUpRequest(sessionId: agentReviewSessionId)
    isAgentRecordingActive = true
    logRecordMarker("handleFollowUpWakePress", extra: "session=\(agentReviewSessionId)")
    hideAgentReviewCard(clearState: false)
  }

  private func installWakeLink(
    url: URL,
    over button: UIButton
  ) -> UIHostingController<DictationLinkView> {
    let hosting = UIHostingController(rootView: DictationLinkView(url: url))
    hosting.view.backgroundColor = .clear
    hosting.view.isOpaque = false
    hosting.view.isUserInteractionEnabled = false
    hosting.view.translatesAutoresizingMaskIntoConstraints = false
    addChild(hosting)
    button.addSubview(hosting.view)
    hosting.didMove(toParent: self)
    NSLayoutConstraint.activate([
      hosting.view.leadingAnchor.constraint(equalTo: button.leadingAnchor),
      hosting.view.trailingAnchor.constraint(equalTo: button.trailingAnchor),
      hosting.view.topAnchor.constraint(equalTo: button.topAnchor),
      hosting.view.bottomAnchor.constraint(equalTo: button.bottomAnchor),
    ])
    return hosting
  }

  private func configureIconButton(
    _ button: UIButton,
    systemImage: String,
    accessibilityLabel: String,
    action: Selector,
    size: CGFloat = Metrics.recordingActionButtonSize,
    symbolPointSize: CGFloat = 15
  ) {
    button.translatesAutoresizingMaskIntoConstraints = false
    button.backgroundColor = Palette.keyBackground
    button.layer.cornerRadius = size / 2
    button.layer.cornerCurve = .continuous
    button.tintColor = Palette.keyText
    button.setImage(UIImage(systemName: systemImage), for: .normal)
    button.setPreferredSymbolConfiguration(
      UIImage.SymbolConfiguration(pointSize: symbolPointSize, weight: .semibold),
      forImageIn: .normal
    )
    button.accessibilityLabel = accessibilityLabel
    button.addTarget(self, action: action, for: .touchUpInside)
  }

  private func setupFullAccessPanelIfNeeded() {
    guard !didSetupFullAccessPanel else { return }
    didSetupFullAccessPanel = true

    fullAccessPanel.backgroundColor = .clear
    fullAccessPanel.translatesAutoresizingMaskIntoConstraints = false
    fullAccessPanel.alpha = 0
    fullAccessPanel.isUserInteractionEnabled = false
    view.addSubview(fullAccessPanel)

    configureIconButton(
      fullAccessPanelCloseButton,
      systemImage: "xmark",
      accessibilityLabel: "Dismiss",
      action: #selector(handleFullAccessPanelCloseTapped)
    )
    fullAccessPanel.addSubview(fullAccessPanelCloseButton)

    fullAccessPanelTitleLabel.translatesAutoresizingMaskIntoConstraints = false
    fullAccessPanelTitleLabel.text = "Dictation needs Full Access"
    fullAccessPanelTitleLabel.font = UIFont.systemFont(ofSize: 16, weight: .semibold)
    fullAccessPanelTitleLabel.textColor = Palette.keyText
    fullAccessPanelTitleLabel.textAlignment = .center
    fullAccessPanelTitleLabel.adjustsFontSizeToFitWidth = true
    fullAccessPanelTitleLabel.minimumScaleFactor = 0.8
    fullAccessPanel.addSubview(fullAccessPanelTitleLabel)

    fullAccessPanelBodyLabel.translatesAutoresizingMaskIntoConstraints = false
    // Names the destination rather than promising the app will surface it: the
    // Home banner only fires when the app update boundary reveals the loss, and
    // a mid-version revoke (manual toggle, keyboard re-added, iOS upgrade) is
    // invisible to the probe — so this path is the only reliable way back.
    fullAccessPanelBodyLabel.text =
      "In OpenWhispr, open Account ▸ Preferences ▸ Keyboard."
    fullAccessPanelBodyLabel.font = UIFont.systemFont(ofSize: 13, weight: .regular)
    fullAccessPanelBodyLabel.textColor = Palette.keyText.withAlphaComponent(0.7)
    fullAccessPanelBodyLabel.textAlignment = .center
    fullAccessPanelBodyLabel.numberOfLines = 0
    fullAccessPanel.addSubview(fullAccessPanelBodyLabel)

    // Apple requires the keyboard-switching affordance even here; the factory
    // wires both input-mode targets and hides itself when iOS says no switcher
    // is needed.
    let globe = makeNextKeyboardButton()
    globe.translatesAutoresizingMaskIntoConstraints = false
    fullAccessPanelGlobeButton = globe
    fullAccessPanel.addSubview(globe)

    NSLayoutConstraint.activate([
      fullAccessPanel.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      fullAccessPanel.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      fullAccessPanel.topAnchor.constraint(equalTo: view.topAnchor),
      fullAccessPanel.bottomAnchor.constraint(equalTo: view.bottomAnchor),

      fullAccessPanelCloseButton.leadingAnchor.constraint(
        equalTo: fullAccessPanel.leadingAnchor, constant: 16
      ),
      fullAccessPanelCloseButton.topAnchor.constraint(
        equalTo: fullAccessPanel.topAnchor, constant: 12
      ),
      fullAccessPanelCloseButton.widthAnchor.constraint(
        equalToConstant: Metrics.recordingActionButtonSize
      ),
      fullAccessPanelCloseButton.heightAnchor.constraint(
        equalToConstant: Metrics.recordingActionButtonSize
      ),

      // Centered slightly high so the 187pt landscape height still clears
      // the ✕ above and the globe below.
      fullAccessPanelTitleLabel.centerXAnchor.constraint(equalTo: fullAccessPanel.centerXAnchor),
      fullAccessPanelTitleLabel.centerYAnchor.constraint(
        equalTo: fullAccessPanel.centerYAnchor, constant: -16
      ),
      fullAccessPanelTitleLabel.leadingAnchor.constraint(
        greaterThanOrEqualTo: fullAccessPanel.leadingAnchor, constant: 24
      ),
      fullAccessPanelTitleLabel.trailingAnchor.constraint(
        lessThanOrEqualTo: fullAccessPanel.trailingAnchor, constant: -24
      ),

      fullAccessPanelBodyLabel.topAnchor.constraint(
        equalTo: fullAccessPanelTitleLabel.bottomAnchor, constant: 6
      ),
      fullAccessPanelBodyLabel.centerXAnchor.constraint(equalTo: fullAccessPanel.centerXAnchor),
      fullAccessPanelBodyLabel.leadingAnchor.constraint(
        greaterThanOrEqualTo: fullAccessPanel.leadingAnchor, constant: 32
      ),
      fullAccessPanelBodyLabel.trailingAnchor.constraint(
        lessThanOrEqualTo: fullAccessPanel.trailingAnchor, constant: -32
      ),

      globe.leadingAnchor.constraint(equalTo: fullAccessPanel.leadingAnchor, constant: 6),
      globe.bottomAnchor.constraint(equalTo: fullAccessPanel.bottomAnchor, constant: -6),
      globe.widthAnchor.constraint(equalToConstant: 42),
      globe.heightAnchor.constraint(equalToConstant: 42),
    ])
  }

  private func showFullAccessPanel(animated: Bool) {
    setupFullAccessPanelIfNeeded()
    guard !fullAccessPanel.isUserInteractionEnabled else { return }
    fullAccessPanel.isUserInteractionEnabled = true
    view.bringSubviewToFront(fullAccessPanel)
    let apply = {
      self.fullAccessPanel.alpha = 1
      self.rootStack.alpha = 0
    }
    if animated {
      UIView.animate(withDuration: 0.18, delay: 0, options: .curveEaseOut, animations: apply)
    } else {
      apply()
    }
    UIAccessibility.post(notification: .screenChanged, argument: fullAccessPanelTitleLabel)
  }

  private func hideFullAccessPanel(animated: Bool) {
    guard didSetupFullAccessPanel, fullAccessPanel.isUserInteractionEnabled else { return }
    fullAccessPanel.isUserInteractionEnabled = false
    let apply = {
      self.fullAccessPanel.alpha = 0
      self.rootStack.alpha = 1
    }
    if animated {
      UIView.animate(withDuration: 0.18, delay: 0, options: .curveEaseOut, animations: apply)
    } else {
      apply()
    }
  }

  @objc private func handleFullAccessPanelCloseTapped() {
    didDismissFullAccessPanel = true
    hideFullAccessPanel(animated: true)
  }

  // The one thing the keyboard CAN do without Full Access: local UI. The pill
  // re-opens the panel, so it is honestly tappable again.
  @objc private func handleFullAccessPillTapped() {
    didDismissFullAccessPanel = false
    showFullAccessPanel(animated: true)
  }

  private func showRecordingCanvas() {
    setCanvasActionButtonsEnabled(true)
    recordingCanvas.isUserInteractionEnabled = true

    if isAgentRecordingActive {
      // Deep-link/recovery starts never pass through the tap handlers, so pick
      // (and stash) a hint lazily here.
      if agentRecordingHint == nil {
        agentRecordingHint = agentHint(from: Self.agentComposeHints)
      }
      recordingCaptionLabel.text = agentRecordingHint.map { "\u{201C}\($0)\u{201D}" } ?? "Listening"
      recordingHeaderLabel.text = agentRecordingHeaderText
        ?? "Tell \(KeyboardHandoffProvider.shared.agentName()) What to Write"
      recordingHeaderLabel.isHidden = false
      setRecordingWaveformColor(Palette.cleanupAccent)
    } else {
      recordingCaptionLabel.text = "Listening"
      recordingHeaderLabel.isHidden = true
      setRecordingWaveformColor(Palette.accent)
    }

    UIView.animate(withDuration: 0.18, delay: 0, options: .curveEaseOut, animations: {
      self.recordingCanvas.alpha = 1
      self.rootStack.alpha = 0
    })
  }

  private func setRecordingWaveformColor(_ color: UIColor) {
    for bar in recordingWaveformBars {
      bar.backgroundColor = color
    }
  }

  private func hideRecordingCanvas() {
    recordingCanvas.isUserInteractionEnabled = false
    resetRecordingWaveformBars()

    UIView.animate(withDuration: 0.18, delay: 0, options: .curveEaseOut, animations: {
      self.recordingCanvas.alpha = 0
      self.rootStack.alpha = 1
    })
  }

  private func setCanvasActionButtonsEnabled(_ enabled: Bool) {
    recordingCancelButton.isEnabled = enabled
    recordingConfirmButton.isEnabled = enabled
    let alpha: CGFloat = enabled ? 1 : 0.5
    recordingCancelButton.alpha = alpha
    recordingConfirmButton.alpha = alpha
  }

  private func resetRecordingWaveformBars() {
    for bar in recordingWaveformBars {
      bar.alpha = 0.35
      bar.transform = CGAffineTransform(scaleX: 1, y: 0.08)
    }
  }

  /// The toolbar: the tone menu on the left, the dictation pill centred, the agent wand on
  /// the right.
  private func setupTopBar() {
    topBar.translatesAutoresizingMaskIntoConstraints = false
    topBar.addLayoutGuide(stripGuide)

    // The pill background sits behind the button; the button itself is
    // transparent so its icon and label render on top. Corner radius is half the
    // height, giving a full pill in every state.
    recordButtonBackground.translatesAutoresizingMaskIntoConstraints = false
    recordButtonBackground.layer.cornerRadius = Metrics.dictationButtonSize / 2
    topBar.addSubview(recordButtonBackground)

    recordButton.translatesAutoresizingMaskIntoConstraints = false
    topBar.addSubview(recordButton)

    // Press feedback. The hand-off tap is handled by the SwiftUI link overlay,
    // so observe touches without consuming them (cancelsTouchesInView = false)
    // and recognise alongside the link's own gesture.
    let pressGesture = UILongPressGestureRecognizer(
      target: self,
      action: #selector(handleRecordButtonPress(_:))
    )
    pressGesture.minimumPressDuration = 0
    pressGesture.cancelsTouchesInView = false
    pressGesture.delaysTouchesBegan = false
    pressGesture.delegate = self
    recordButton.addGestureRecognizer(pressGesture)

    // Animated dots overlaid where the leading icon sits, shown only in the
    // "Processing"/"Starting"/"Stopping" states.
    processingDots.translatesAutoresizingMaskIntoConstraints = false
    processingDots.isHidden = true
    recordButton.addSubview(processingDots)
    NSLayoutConstraint.activate([
      processingDots.leadingAnchor.constraint(equalTo: recordButton.leadingAnchor, constant: Metrics.pillLeadingInset),
      processingDots.centerYAnchor.constraint(equalTo: recordButton.centerYAnchor),
      processingDots.widthAnchor.constraint(equalToConstant: ProcessingDotsView.preferredSize.width),
      processingDots.heightAnchor.constraint(equalToConstant: ProcessingDotsView.preferredSize.height),
    ])

    // X to cancel an in-flight transcription, pinned just past the pill's
    // trailing edge; shown only in the "Transcribing"/"Cleaning up" states
    // (see showLongRunningRecordState).
    configureIconButton(
      processingCancelButton,
      systemImage: "xmark",
      accessibilityLabel: "Cancel transcription",
      action: #selector(handleProcessingCancelTapped),
      size: Metrics.processingCancelSize,
      symbolPointSize: 13
    )
    processingCancelButton.isHidden = true
    topBar.addSubview(processingCancelButton)

    // gauge.with.dots.needle.bottom.50percent is iOS 16+; fall back to the classic
    // gauge on the extension's 15.1 deployment target.
    configureToolbarButton(
      toneButton,
      image: UIImage(systemName: "gauge.with.dots.needle.bottom.50percent") ?? UIImage(systemName: "gauge"),
      accessibilityLabel: "Dictation tone"
    )
    toneButton.showsMenuAsPrimaryAction = true
    refreshToneButton()

    // Agent entry button, mirroring the tone button on the trailing edge. A press
    // gesture (not a tap target) so it can write the request before the Link
    // overlay fires the handoff — the same coordination the record button uses.
    configureToolbarButton(
      agentButton,
      image: UIImage(systemName: "wand.and.stars"),
      accessibilityLabel: "Ask the voice assistant"
    )
    let agentPress = UILongPressGestureRecognizer(
      target: self,
      action: #selector(handleAgentButtonPress(_:))
    )
    agentPress.minimumPressDuration = 0
    agentPress.cancelsTouchesInView = false
    agentPress.delaysTouchesBegan = false
    agentPress.delegate = self
    agentButton.addGestureRecognizer(agentPress)

    let topBarHeight = topBar.heightAnchor.constraint(equalToConstant: metrics.stripTop + metrics.stripHeight)
    topBarHeightConstraint = topBarHeight
    stripConstraints = [
      stripGuide.topAnchor.constraint(equalTo: topBar.topAnchor, constant: metrics.stripTop),
      stripGuide.heightAnchor.constraint(equalToConstant: metrics.stripHeight),
      stripGuide.leadingAnchor.constraint(equalTo: topBar.leadingAnchor, constant: stripEdgeOffset),
      stripGuide.trailingAnchor.constraint(equalTo: topBar.trailingAnchor, constant: -stripEdgeOffset),
    ]
    // The pill is centred in the strip and sizes itself to its content, capped so a
    // long label can't overflow the strip.
    NSLayoutConstraint.activate(stripConstraints + [
      topBarHeight,

      toneButton.leadingAnchor.constraint(equalTo: stripGuide.leadingAnchor, constant: Metrics.toolbarButtonInset),
      toneButton.centerYAnchor.constraint(equalTo: stripGuide.centerYAnchor),
      toneButton.widthAnchor.constraint(equalToConstant: Metrics.toolbarButtonSize),
      toneButton.heightAnchor.constraint(equalToConstant: Metrics.toolbarButtonSize),

      agentButton.trailingAnchor.constraint(equalTo: stripGuide.trailingAnchor, constant: -Metrics.toolbarButtonInset),
      agentButton.centerYAnchor.constraint(equalTo: stripGuide.centerYAnchor),
      agentButton.widthAnchor.constraint(equalToConstant: Metrics.toolbarButtonSize),
      agentButton.heightAnchor.constraint(equalToConstant: Metrics.toolbarButtonSize),

      recordButton.centerXAnchor.constraint(equalTo: stripGuide.centerXAnchor),
      recordButton.centerYAnchor.constraint(equalTo: stripGuide.centerYAnchor),
      recordButton.heightAnchor.constraint(equalToConstant: Metrics.dictationButtonSize),
      recordButton.widthAnchor.constraint(lessThanOrEqualTo: stripGuide.widthAnchor, constant: -16),

      // Background tracks the button's frame exactly.
      recordButtonBackground.leadingAnchor.constraint(equalTo: recordButton.leadingAnchor),
      recordButtonBackground.trailingAnchor.constraint(equalTo: recordButton.trailingAnchor),
      recordButtonBackground.topAnchor.constraint(equalTo: recordButton.topAnchor),
      recordButtonBackground.bottomAnchor.constraint(equalTo: recordButton.bottomAnchor),

      processingCancelButton.leadingAnchor.constraint(equalTo: recordButton.trailingAnchor, constant: 8),
      processingCancelButton.centerYAnchor.constraint(equalTo: recordButton.centerYAnchor),
      processingCancelButton.widthAnchor.constraint(equalToConstant: Metrics.processingCancelSize),
      processingCancelButton.heightAnchor.constraint(equalToConstant: Metrics.processingCancelSize),
    ])

    setupAgentLink()
    refreshAgentButton()
    setupDictationLink()

    rootStack.addArrangedSubview(topBar)
  }

  /// The round tone and agent buttons: a grey disc with a glass rim.
  private func configureToolbarButton(_ button: KeyButton, image: UIImage?, accessibilityLabel: String) {
    button.translatesAutoresizingMaskIntoConstraints = false
    button.tintColor = .label
    button.normalBackground = UIColor.secondarySystemBackground
    button.pressedBackground = UIColor { traits in
      let delta: CGFloat = traits.userInterfaceStyle == .dark ? 0.12 : -0.10
      return UIColor.secondarySystemBackground.resolvedColor(with: traits).brightened(by: delta)
    }
    button.layer.cornerRadius = Metrics.toolbarButtonSize / 2
    button.showsGlassRim = true
    button.setImage(image, for: .normal)
    button.setPreferredSymbolConfiguration(
      UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold),
      forImageIn: .normal
    )
    button.accessibilityLabel = accessibilityLabel
    topBar.addSubview(button)
  }

  /// The strip's inset from the bar, which starts at the keys' side margin.
  private var stripEdgeOffset: CGFloat { metrics.stripSideInset - metrics.sideMargin }

  private func updateStripConstraints() {
    let constants = [metrics.stripTop, metrics.stripHeight, stripEdgeOffset, -stripEdgeOffset]
    for (constraint, constant) in zip(stripConstraints, constants) {
      constraint.constant = constant
    }
  }

  private func refreshAfterEdit() {
    refreshReturnKey()
  }

  private static let toneMenuItems: [(value: String, title: String)] = [
    ("default", "Default"),
    ("formal", "Formal"),
    ("casual", "Casual"),
    ("very_casual", "Very Casual"),
    ("excited", "Excited"),
  ]

  private func refreshToneButton() {
    // isToneApplicable() fails open on a dead App Group — `guard let defaults`
    // then `!= "0"` reads a live-but-empty suite as applicable — so the tone
    // gate needs its own check. Dim and lock rather than isEnabled = false,
    // which applies UIButton.Configuration's own foreground transform on top.
    guard hasFullAccess else {
      toneButton.menu = nil
      toneButton.isUserInteractionEnabled = false
      toneButton.alpha = 0.4
      return
    }
    let provider = KeyboardHandoffProvider.shared
    let current = provider.currentTone()
    let applicable = provider.isToneApplicable()

    // When tone isn't applicable (private mode, or cleanup off) the styled tones
    // live behind Cloud. Lock every tone but Default so it reads as gated rather
    // than broken, and show the reason as a short, single-line header instead of
    // the old wrapping disabled row.
    let lockImage = applicable ? nil : UIImage(systemName: "lock.fill")
    let actions: [UIAction] = Self.toneMenuItems.map { item in
      let locked = !applicable && item.value != "default"
      let action = UIAction(
        title: item.title,
        image: locked ? lockImage : nil,
        state: item.value == current ? .on : .off
      ) { [weak self] _ in
        KeyboardHandoffProvider.shared.setTone(item.value)
        self?.refreshToneButton()
      }
      if locked { action.attributes = [.disabled] }
      return action
    }

    // Label the menu in both states: its purpose when usable, the upgrade path
    // when locked. The header costs one row of the height-capped menu, so on
    // shorter keyboards the last tone ("Excited") can fall into the scroll
    // region instead of showing inline.
    let menuTitle = applicable ? "Dictation Tone" : "Tones are off in Local Mode"
    toneButton.menu = UIMenu(title: menuTitle, children: actions)
    toneButton.isUserInteractionEnabled = true
    toneButton.alpha = applicable ? 1.0 : 0.4
  }

  /// The dictation deep link the agent button hands off with when the background
  /// session isn't ready — identical to the record button's, since the app keys
  /// the agent path off the presence of keyboard_agent_request, not the URL.
  private func setupAgentLink() {
    let provider = KeyboardHandoffProvider.shared
    var components = URLComponents(string: "\(Self.appUrlScheme)://keyboard-dictation")!
    components.queryItems = [URLQueryItem(name: "source", value: "keyboard")]
    if let scheme = provider.hostUrlScheme(from: self) {
      components.queryItems?.append(URLQueryItem(name: "returnScheme", value: scheme))
    }
    if let bundle = provider.detectHostBundleID(from: self) {
      components.queryItems?.append(URLQueryItem(name: "hostBundle", value: bundle))
    }
    guard let url = components.url else { return }

    let hosting = UIHostingController(rootView: DictationLinkView(url: url))
    hosting.view.backgroundColor = .clear
    hosting.view.isOpaque = false
    hosting.view.translatesAutoresizingMaskIntoConstraints = false

    addChild(hosting)
    agentButton.addSubview(hosting.view)
    hosting.didMove(toParent: self)

    NSLayoutConstraint.activate([
      hosting.view.leadingAnchor.constraint(equalTo: agentButton.leadingAnchor),
      hosting.view.trailingAnchor.constraint(equalTo: agentButton.trailingAnchor),
      hosting.view.topAnchor.constraint(equalTo: agentButton.topAnchor),
      hosting.view.bottomAnchor.constraint(equalTo: agentButton.bottomAnchor),
    ])

    agentLinkHosting = hosting
  }

  /// Gating mirrors refreshToneButton: hidden when the agent is disabled, dimmed
  /// (with a transient upgrade pill on tap) when Cloud isn't on. When usable, the
  /// Link overlay is enabled only for the handoff path — an in-place tap goes
  /// through requestStart() in the press handler instead.
  private func refreshAgentButton() {
    // isAgentEnabled() already fails closed on a dead App Group; stating it
    // makes the intent greppable rather than incidental.
    guard hasFullAccess else {
      agentButton.isHidden = true
      agentLinkHosting?.view.isUserInteractionEnabled = false
      return
    }
    let provider = KeyboardHandoffProvider.shared
    let enabled = provider.isAgentEnabled()
    agentButton.isHidden = !enabled
    guard enabled else {
      agentLinkHosting?.view.isUserInteractionEnabled = false
      return
    }

    let applicable = provider.isAgentApplicable()
    agentButton.alpha = applicable ? 1.0 : 0.4

    let recordsInPlace = provider.isBackgroundSessionReady()
      || hostIsOwnApp
      || provider.isContainingAppForeground()
    // The Link fires only for a usable, applicable, hand-off tap. When it isn't
    // applicable the press handler shows the upgrade pill and swallows the tap.
    agentLinkHosting?.view.isUserInteractionEnabled = applicable && !recordsInPlace
  }


  private func setupDictationLink() {
    let provider = KeyboardHandoffProvider.shared
    provider.storeHostReturnInfo(from: self)

    var components = URLComponents(string: "\(Self.appUrlScheme)://keyboard-dictation")!
    components.queryItems = [URLQueryItem(name: "source", value: "keyboard")]
    if let scheme = provider.hostUrlScheme(from: self) {
      components.queryItems?.append(URLQueryItem(name: "returnScheme", value: scheme))
    }
    if let bundle = provider.detectHostBundleID(from: self) {
      components.queryItems?.append(URLQueryItem(name: "hostBundle", value: bundle))
      hostIsOwnApp = provider.isContainingAppBundle(bundle)
    }

    guard let url = components.url else { return }

    let hosting = UIHostingController(rootView: DictationLinkView(url: url))
    hosting.view.backgroundColor = .clear
    hosting.view.isOpaque = false
    hosting.view.translatesAutoresizingMaskIntoConstraints = false

    addChild(hosting)
    recordButton.addSubview(hosting.view)
    hosting.didMove(toParent: self)

    NSLayoutConstraint.activate([
      hosting.view.leadingAnchor.constraint(equalTo: recordButton.leadingAnchor),
      hosting.view.trailingAnchor.constraint(equalTo: recordButton.trailingAnchor),
      hosting.view.topAnchor.constraint(equalTo: recordButton.topAnchor),
      hosting.view.bottomAnchor.constraint(equalTo: recordButton.bottomAnchor),
    ])

    dictationLinkHosting = hosting
  }

  private func setupKeyboardArea() {
    keyboardRowsStack.axis = .vertical
    keyboardRowsStack.spacing = metrics.rowGap
    keyboardRowsStack.translatesAutoresizingMaskIntoConstraints = false
    rootStack.addArrangedSubview(keyboardRowsStack)

    [lettersRowsStack, numbersRowsStack, symbolsRowsStack].forEach { stack in
      stack.axis = .vertical
      stack.spacing = metrics.rowGap
      stack.translatesAutoresizingMaskIntoConstraints = false
    }

    keyboardRowsStack.addLayoutGuide(keyWidthGuide)
    let guideWidth = keyWidthGuide.widthAnchor.constraint(
      equalTo: keyboardRowsStack.widthAnchor,
      multiplier: 0.1,
      constant: -0.9 * metrics.keyGap
    )
    NSLayoutConstraint.activate([
      guideWidth,
      keyWidthGuide.leadingAnchor.constraint(equalTo: keyboardRowsStack.leadingAnchor),
      keyWidthGuide.topAnchor.constraint(equalTo: keyboardRowsStack.topAnchor),
      keyWidthGuide.heightAnchor.constraint(equalToConstant: 0),
    ])
    keyWidthGuideConstraint = guideWidth

    // Above the bar and the keys, and inside rootStack so it fades and locks with them
    // whenever a canvas covers the keyboard.
    rootStack.addSubview(keyPopup)
  }

  private func buildKeyboardIfNeeded() {
    guard !didBuildKeyboard else {
      refreshVisibleKeyboardMode()
      return
    }
    didBuildKeyboard = true
    rebuildKeyboard()
  }

  private static let letterRows: [[String]] = [
    ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
    ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
    ["z", "x", "c", "v", "b", "n", "m"],
  ]
  // (display, output): the quote keys show curly marks and insert straight ones, which
  // smartQuoteSubstitution turns into context-aware curly quotes.
  private static let numberRows: [[(display: String, output: String)]] = [
    "1234567890".map { (String($0), String($0)) },
    ["-", "/", ":", ";", "(", ")", "$", "&", "@"].map { ($0, $0) } + [("\u{201D}", "\"")],
  ]
  private static let symbolRows: [[(display: String, output: String)]] = [
    ["[", "]", "{", "}", "#", "%", "^", "*", "+", "="].map { ($0, $0) },
    ["_", "\\", "|", "~", "<", ">", "\u{20AC}", "\u{00A3}", "\u{00A5}", "\u{2022}"].map { ($0, $0) },
  ]
  private static let punctuationRow: [(display: String, output: String)] = [
    (".", "."), (",", ","), ("?", "?"), ("!", "!"), ("\u{2019}", "'"),
  ]

  private func rebuildKeyboard() {
    keyPopup.hide()
    for stack in [keyboardRowsStack, lettersRowsStack, numbersRowsStack, symbolsRowsStack] {
      stack.arrangedSubviews.forEach { view in
        stack.removeArrangedSubview(view)
        view.removeFromSuperview()
      }
    }

    characterButtons.removeAll()
    shortcutButtons.removeAll()
    bottomRowConstraints = BottomRowConstraints()
    appliedBottomRowLayout = nil
    shiftButton = nil
    modeButton = nil
    spaceButton = nil
    returnButton = nil
    rowHeightConstraints.removeAll(keepingCapacity: true)

    // Pages first: key widths are constraints on keyWidthGuide, which can only be
    // activated once a row shares an ancestor with it.
    keyboardRowsStack.addArrangedSubview(lettersRowsStack)
    keyboardRowsStack.addArrangedSubview(numbersRowsStack)
    keyboardRowsStack.addArrangedSubview(symbolsRowsStack)

    let letters = Self.letterRows.map { row in row.map { (display: $0, output: $0) } }
    addCharacterRow(letters[0], to: lettersRowsStack, registersLetters: true)
    addCharacterRow(letters[1], to: lettersRowsStack, registersLetters: true)
    addLettersThirdRow(letters[2], to: lettersRowsStack)
    addMainBottomRow(to: keyboardRowsStack)
    refreshVisibleKeyboardMode()
    refreshShiftState()
  }

  private func constrainRowHeight(_ row: UIView) {
    let constraint = row.heightAnchor.constraint(equalToConstant: metrics.keyHeight)
    constraint.isActive = true
    rowHeightConstraints.append(constraint)
  }

  /// A width of `keys` letter keys plus `gaps` key gaps.
  private func widthOfKeys(
    _ view: UIView,
    keys: CGFloat,
    gaps: CGFloat = 0,
    priority: UILayoutPriority = .required
  ) -> NSLayoutConstraint {
    let constraint = view.widthAnchor.constraint(
      equalTo: keyWidthGuide.widthAnchor,
      multiplier: keys,
      constant: gaps * metrics.keyGap
    )
    constraint.priority = priority
    return constraint
  }

  /// A letter key's width at the current keyboard width, before layout has run.
  private var estimatedKeyWidth: CGFloat {
    let width = lastMetricsWidth > 0 ? lastMetricsWidth : UIScreen.main.bounds.width
    return max(0, (width - 2 * metrics.sideMargin - 9 * metrics.keyGap) / 10)
  }

  private func applyRootPadding() {
    rootStack.directionalLayoutMargins = NSDirectionalEdgeInsets(
      top: 0, leading: metrics.sideMargin, bottom: metrics.bottomPadding, trailing: metrics.sideMargin
    )
    rootStack.spacing = metrics.stripGapBelow
    // The rows take the padding at the keyboard's sides and bottom, and the half of the
    // gap below the toolbar that is nearer to them. The side margin is a half point, which
    // layout rounds to pixels; one more point reaches the screen edge whatever the scale.
    keyboardRowsStack.touchMargins = UIEdgeInsets(
      top: metrics.stripGapBelow / 2,
      left: metrics.sideMargin + 1,
      bottom: metrics.bottomPadding + 1,
      right: metrics.sideMargin + 1
    )
  }

  private func refreshMetricsIfNeeded() {
    let width = view.bounds.width
    guard width.isFinite, width > 0, abs(width - lastMetricsWidth) > 1 else { return }
    lastMetricsWidth = width

    let nextMetrics = KeyboardMetrics.current(
      forWidth: width, landscape: isLandscapeLayout, homeButton: needsInputModeSwitchKey
    )
    guard nextMetrics != metrics else { return }
    metrics = nextMetrics

    applyRootPadding()
    rootHeightConstraint?.constant = metrics.keyboardHeight
    [keyboardRowsStack, lettersRowsStack, numbersRowsStack, symbolsRowsStack].forEach {
      $0.spacing = metrics.rowGap
    }
    keyWidthGuideConstraint?.constant = -0.9 * metrics.keyGap
    topBarHeightConstraint?.constant = metrics.stripTop + metrics.stripHeight
    updateStripConstraints()

    if didBuildKeyboard {
      rebuildKeyboard()
    }
  }

  private func refreshVisibleKeyboardMode() {
    keyPopup.hide()
    buildPageIfNeeded()
    lettersRowsStack.isHidden = layoutMode != .letters
    numbersRowsStack.isHidden = layoutMode != .numbers
    symbolsRowsStack.isHidden = layoutMode != .symbols
    let modeLabel = layoutMode == .letters ? metrics.keycaps.label123 : metrics.keycaps.labelABC
    modeButton?.setTitle(layoutMode == .letters ? "123" : "ABC", for: .normal)
    modeButton?.titleLabel?.font = modeLabel.font
    modeButton?.titleBaselineFromCenter = modeLabel.baseline
    refreshFieldAwareKeys()
  }

  /// The 123 and #+= pages are built the first time they show: built up front, they held
  /// about 2MB of the extension's memory while hidden.
  private func buildPageIfNeeded() {
    switch layoutMode {
    case .numbers where numbersRowsStack.arrangedSubviews.isEmpty:
      addCharacterRow(Self.numberRows[0], to: numbersRowsStack)
      addCharacterRow(Self.numberRows[1], to: numbersRowsStack)
      addPunctuationThirdRow(pageKeyTitle: "#+=", to: numbersRowsStack)
    case .symbols where symbolsRowsStack.arrangedSubviews.isEmpty:
      addCharacterRow(Self.symbolRows[0], to: symbolsRowsStack)
      addCharacterRow(Self.symbolRows[1], to: symbolsRowsStack)
      addPunctuationThirdRow(pageKeyTitle: "123", to: symbolsRowsStack)
    default:
      break
    }
  }

  private func refreshFieldAwareKeys() {
    refreshReturnKey()
    refreshBottomRow()
  }

  private func refreshReturnKey() {
    guard let returnButton else { return }
    let style = ReturnKeyStyle.forReturnKeyType(textDocumentProxy.returnKeyType)
    let isDisabled = textDocumentProxy.enablesReturnKeyAutomatically == true && !textDocumentProxy.hasText
    returnButton.setImage(UIImage(systemName: style.symbolName)?.withRenderingMode(.alwaysTemplate), for: .normal)
    returnButton.imageOffsetY = style.glyphOffsetY
    returnButton.accessibilityLabel = style.accessibilityLabel
    // Not isEnabled: UIKit would dim the glyph on top of Apple's disabled colours.
    returnButton.isUserInteractionEnabled = !isDisabled
    returnButton.accessibilityTraits = isDisabled ? [.button, .notEnabled] : .button
    if isDisabled {
      returnButton.normalBackground = Palette.keyDisabledBackground
      returnButton.pressedBackground = nil
      returnButton.pressedTint = nil
      returnButton.tintColor = Palette.keyDisabledText
    } else if style.isProminent {
      returnButton.normalBackground = Palette.returnKeyProminent
      returnButton.pressedBackground = Palette.keyBackground
      returnButton.pressedTint = Palette.keyText
      returnButton.tintColor = .white
    } else {
      returnButton.normalBackground = Palette.keyBackground
      returnButton.pressedBackground = Palette.keyPressedBackground
      returnButton.pressedTint = nil
      returnButton.tintColor = Palette.keyText
    }
  }

  private func refreshBottomRow() {
    let layout = BottomRowLayout.forKeyboardType(textDocumentProxy.keyboardType)
    guard layout != appliedBottomRowLayout, shortcutButtons.count == 3, let spaceButton, let returnButton
    else { return }
    appliedBottomRowLayout = layout

    let constraints = bottomRowConstraints
    NSLayoutConstraint.deactivate(constraints.halfWidth + constraints.letterWidth + constraints.sharedWidth)
    for (index, button) in shortcutButtons.enumerated() {
      let value = layout.shortcuts.indices.contains(index) ? layout.shortcuts[index] : nil
      button.output = value
      button.setTitle(value, for: .normal)
      button.isHidden = value == nil
      guard let value else { continue }
      let isDomain = value.count > 1
      button.titleLabel?.font = isDomain ? KeyFont.domainLabel : metrics.keycaps.uppercase
      button.titleBaselineFromCenter = isDomain
        ? metrics.keycaps.domainBaseline
        : KeyFont.shortcutBaseline(for: value, raisesPeriod: layout.raisesPeriod)
      switch layout.shortcutWidth {
      case .shared:
        if index > 0 { constraints.sharedWidth[index - 1].isActive = true }
      case .half:
        constraints.halfWidth[index].isActive = true
      case .letter:
        constraints.letterWidth[index].isActive = true
      }
    }
    spaceButton.isHidden = !layout.showsSpace
    returnButton.isHidden = !layout.showsReturn
    constraints.returnWidth?.isActive = !layout.narrowReturn
    constraints.narrowReturnWidth?.isActive = layout.narrowReturn
  }

  private func playKeyClick() {
    UIDevice.current.playInputClick()
  }

  /// A row container, already in `stack` so its keys can be sized against keyWidthGuide.
  private func addRowContainer(to stack: UIStackView) -> UIView {
    let rowContainer = UIView()
    rowContainer.translatesAutoresizingMaskIntoConstraints = false
    stack.addArrangedSubview(rowContainer)
    constrainRowHeight(rowContainer)
    return rowContainer
  }

  /// One row of equal character keys. Rows shorter than ten keys are centred, which
  /// gives the A row Apple's half-key indent.
  private func addCharacterRow(
    _ keys: [(display: String, output: String)],
    to stack: UIStackView,
    registersLetters: Bool = false
  ) {
    let rowContainer = addRowContainer(to: stack)
    let rowStack = makeKeyStack(keys, registersLetters: registersLetters)
    rowContainer.addSubview(rowStack)
    NSLayoutConstraint.activate([
      rowStack.centerXAnchor.constraint(equalTo: rowContainer.centerXAnchor),
      widthOfKeys(rowStack, keys: CGFloat(keys.count), gaps: CGFloat(keys.count - 1)),
      rowStack.topAnchor.constraint(equalTo: rowContainer.topAnchor),
      rowStack.bottomAnchor.constraint(equalTo: rowContainer.bottomAnchor),
    ])
  }

  private func makeKeyStack(
    _ keys: [(display: String, output: String)],
    registersLetters: Bool
  ) -> UIStackView {
    let stack = UIStackView()
    stack.axis = .horizontal
    stack.spacing = metrics.keyGap
    stack.distribution = .fillEqually
    stack.translatesAutoresizingMaskIntoConstraints = false
    for key in keys {
      let button = makeKeyButton(display: key.display, output: key.output, role: .character)
      button.addTarget(self, action: #selector(handleCharacterKeyTapped(_:)), for: .touchUpInside)
      button.addTarget(self, action: #selector(handleCharacterKeyDown(_:)), for: .touchDown)
      button.addTarget(
        self,
        action: #selector(handleCharacterKeyReleased(_:)),
        for: [.touchUpInside, .touchUpOutside, .touchCancel, .touchDragExit]
      )
      if registersLetters {
        characterButtons.append(button)
      }
      stack.addArrangedSubview(button)
    }
    return stack
  }

  private func addLettersThirdRow(_ keys: [(display: String, output: String)], to stack: UIStackView) {
    let shift = makeKeyButton(display: nil, imageSystemName: "shift", role: .utility)
    shift.imageOffsetY = metrics.keycaps.edgeGlyphOffset
    shift.addTarget(self, action: #selector(handleShiftTapped), for: .touchUpInside)
    shiftButton = shift
    addThirdRow(leadingKey: shift, keys: makeKeyStack(keys, registersLetters: true), to: stack)
  }

  private func addPunctuationThirdRow(pageKeyTitle: String, to stack: UIStackView) {
    let pageKey = makeKeyButton(display: pageKeyTitle, role: .utility)
    if pageKeyTitle == "#+=" {
      pageKey.titleLabel?.font = KeyFont.moreSymbolsLabel
      pageKey.titleBaselineFromCenter = KeyFont.moreSymbolsBaseline
    } else {
      pageKey.titleLabel?.font = KeyFont.pageLabel
    }
    pageKey.addTarget(self, action: #selector(handlePageKeyTapped), for: .touchUpInside)
    addThirdRow(
      leadingKey: pageKey, keys: makeKeyStack(Self.punctuationRow, registersLetters: false), to: stack
    )
  }

  /// Row 3 of every page: a function key at each edge and seven letter widths of keys
  /// centred between them, so Z sits under S and the five symbol keys span Z…M.
  private func addThirdRow(leadingKey: KeyButton, keys: UIStackView, to stack: UIStackView) {
    let rowContainer = addRowContainer(to: stack)

    let backspace = makeKeyButton(display: nil, imageSystemName: "delete.left", role: .utility)
    backspace.imageOffsetY = metrics.keycaps.edgeGlyphOffset
    backspace.addTarget(self, action: #selector(handleBackspaceTapped), for: .touchUpInside)
    let longPress = UILongPressGestureRecognizer(
      target: self,
      action: #selector(handleBackspaceLongPress(_:))
    )
    longPress.minimumPressDuration = 0.35
    backspace.addGestureRecognizer(longPress)

    for item in [leadingKey, keys, backspace] {
      rowContainer.addSubview(item)
      item.topAnchor.constraint(equalTo: rowContainer.topAnchor).isActive = true
      item.bottomAnchor.constraint(equalTo: rowContainer.bottomAnchor).isActive = true
    }
    NSLayoutConstraint.activate([
      leadingKey.leadingAnchor.constraint(equalTo: rowContainer.leadingAnchor),
      widthOfKeys(leadingKey, keys: metrics.functionKeys),
      backspace.trailingAnchor.constraint(equalTo: rowContainer.trailingAnchor),
      widthOfKeys(backspace, keys: metrics.functionKeys),
      keys.centerXAnchor.constraint(equalTo: rowContainer.centerXAnchor),
      widthOfKeys(keys, keys: 7, gaps: 6),
    ])
  }

  /// 123 · (globe) · space · field keys · return. Widths follow Apple's: 123 ends under Z
  /// and return starts under M; the field keys and return change with the keyboard type.
  private func addMainBottomRow(to stack: UIStackView) {
    let row = UIStackView()
    row.axis = .horizontal
    row.spacing = metrics.keyGap
    row.translatesAutoresizingMaskIntoConstraints = false
    stack.addArrangedSubview(row)
    constrainRowHeight(row)

    let modeButton = makeKeyButton(display: layoutMode == .letters ? "123" : "ABC", role: .utility)
    modeButton.addTarget(self, action: #selector(handleModeKeyTapped), for: .touchUpInside)
    self.modeButton = modeButton

    // After 123, as Apple's; with it showing, 123 and the globe share one 123 width.
    let globeButton = makeNextKeyboardButton()

    let spaceButton = makeKeyButton(display: nil, role: .utility)
    spaceButton.addTarget(self, action: #selector(handleSpaceTapped), for: .touchUpInside)
    spaceButton.setContentHuggingPriority(UILayoutPriority(1), for: .horizontal)
    spaceButton.setContentCompressionResistancePriority(UILayoutPriority(1), for: .horizontal)
    // Blank, as Apple's is; the OpenWhispr logo sits in the dictation pill.
    spaceButton.accessibilityLabel = "space"
    self.spaceButton = spaceButton

    let shortcuts = (0..<3).map { _ in
      let button = makeKeyButton(display: nil, role: .utility)
      button.addTarget(self, action: #selector(handleShortcutTapped(_:)), for: .touchUpInside)
      return button
    }
    shortcutButtons = shortcuts

    let returnButton = makeKeyButton(display: nil, imageSystemName: "return.left", role: .utility)
    returnButton.addTarget(self, action: #selector(handleReturnTapped), for: .touchUpInside)
    self.returnButton = returnButton

    ([modeButton, globeButton, spaceButton] + shortcuts + [returnButton]).forEach(row.addArrangedSubview)

    // Keys that can hide in the stack get 999 widths, so the stack's own zero-width
    // hiding constraint wins without a conflict.
    let hideable = UILayoutPriority.required - 1
    let halfBottomKey = { (view: UIView) in
      self.widthOfKeys(
        view, keys: self.metrics.bottomKeys / 2, gaps: (self.metrics.bottomGaps - 1) / 2, priority: hideable
      )
    }
    bottomRowConstraints = BottomRowConstraints(
      halfWidth: shortcuts.map(halfBottomKey),
      letterWidth: shortcuts.map { widthOfKeys($0, keys: metrics.searchShortcutKeys, priority: hideable) },
      sharedWidth: shortcuts.dropFirst().map {
        let constraint = $0.widthAnchor.constraint(equalTo: shortcuts[0].widthAnchor)
        constraint.priority = hideable
        return constraint
      },
      returnWidth: widthOfKeys(
        returnButton, keys: metrics.bottomKeys, gaps: metrics.bottomGaps, priority: hideable
      ),
      narrowReturnWidth: widthOfKeys(
        returnButton, keys: metrics.narrowReturnKeys, gaps: metrics.narrowReturnGaps, priority: hideable
      )
    )
    NSLayoutConstraint.activate([
      needsInputModeSwitchKey
        ? halfBottomKey(modeButton)
        : widthOfKeys(modeButton, keys: metrics.bottomKeys, gaps: metrics.bottomGaps),
      halfBottomKey(globeButton),
    ])
  }

  private func makeNextKeyboardButton() -> KeyButton {
    let button = makeKeyButton(display: nil, imageSystemName: "globe", role: .utility)
    button.accessibilityLabel = "Next keyboard"
    button.isHidden = !needsInputModeSwitchKey
    button.addTarget(self, action: #selector(handleNextKeyboardTapped), for: .touchUpInside)
    button.addTarget(
      self,
      action: #selector(handleInputModeListButton(_:forEvent:)),
      for: .allTouchEvents
    )
    return button
  }

  private func makeKeyButton(
    display: String?,
    output: String? = nil,
    imageSystemName: String? = nil,
    role: KeyRole
  ) -> KeyButton {
    let button = KeyButton(type: .custom)
    button.translatesAutoresizingMaskIntoConstraints = false
    button.output = output
    // Each key's target reaches across the gaps, Apple's half-key indent on the A row and
    // the keyboard's padding, so no gap or pixel-rounding sliver is dead;
    // KeyboardRowsStack gives every touch to the nearest key.
    button.hitTestOutsets = UIEdgeInsets(
      top: metrics.rowGap, left: estimatedKeyWidth, bottom: metrics.rowGap, right: estimatedKeyWidth
    )
    button.layer.cornerRadius = metrics.keyCornerRadius
    button.layer.cornerCurve = .continuous

    // One colour for every key, as Apple's; no shadow. Character keys show a pop-up
    // instead of a pressed colour.
    button.normalBackground = Palette.keyBackground
    button.pressedBackground = role == .character ? nil : Palette.keyPressedBackground
    button.setTitleColor(Palette.keyText, for: .normal)

    if let display {
      button.setTitle(display, for: .normal)
      button.titleLabel?.font = role == .character ? metrics.keycaps.character(display) : metrics.keycaps.label123.font
      button.titleBaselineFromCenter =
        role == .character ? KeyFont.baseline(for: display) : metrics.keycaps.label123.baseline
    }

    if let imageSystemName {
      let image = UIImage(systemName: imageSystemName)?
        .withRenderingMode(.alwaysTemplate)
      button.setImage(image, for: .normal)
      button.tintColor = Palette.keyText
      button.imageView?.contentMode = .scaleAspectFit
      button.setPreferredSymbolConfiguration(KeyFont.glyph, forImageIn: .normal)
    }

    return button
  }

  private func refreshShiftState() {
    guard layoutMode == .letters else { return }

    for button in characterButtons {
      guard let output = button.output else { continue }
      button.setTitle(isShiftEnabled ? output.uppercased() : output, for: .normal)
      button.titleLabel?.font = isShiftEnabled ? metrics.keycaps.uppercase : metrics.keycaps.lowercase
      button.titleBaselineFromCenter =
        KeyFont.characterBaseline + (isShiftEnabled ? 0 : metrics.keycaps.lowercaseBaselineShift)
    }

    // Apple changes only the glyph; the key keeps its colour.
    let shiftImage = isCapsLocked
      ? CachedImages.capslockFill
      : (isShiftEnabled ? CachedImages.shiftFill : CachedImages.shift)
    shiftButton?.setImage(shiftImage, for: .normal)
    shiftButton?.imageOffsetY = isCapsLocked ? KeyFont.capsLockGlyphOffset : metrics.keycaps.edgeGlyphOffset
  }

  private func syncShiftWithContextIfNeeded() {
    guard layoutMode == .letters && !isCapsLocked else { return }

    let shouldEnableShift = shouldAutoCapitalize()
    if shouldEnableShift != isShiftEnabled {
      isShiftEnabled = shouldEnableShift
      refreshShiftState()
    }
  }

  /// Follows the field's autocapitalization type, as Apple's keyboard does (URL and email
  /// fields start lowercase).
  private func shouldAutoCapitalize() -> Bool {
    let capitalization: AutoCapitalization
    switch textDocumentProxy.autocapitalizationType ?? .sentences {
    case .none: capitalization = .none
    case .words: capitalization = .words
    case .allCharacters: capitalization = .allCharacters
    default: capitalization = .sentences
    }
    return capitalization.capitalizesNext(after: textDocumentProxy.documentContextBeforeInput)
  }

  private func startDeleteRepeating() {
    stopDeleteRepeating()
    deleteRepeatCount = 0
    performRepeatingDelete()
  }

  private func stopDeleteRepeating() {
    deleteRepeatTimer?.invalidate()
    deleteRepeatTimer = nil
    deleteRepeatCount = 0
  }

  private func performRepeatingDelete() {
    playKeyClick()
    if deleteRepeatCount >= 24 && deleteRepeatCount % 6 == 0 {
      deletePreviousWordChunk()
    } else {
      textDocumentProxy.deleteBackward()
    }
    deleteRepeatCount += 1
    scheduleNextDeleteRepeat()
  }

  private func scheduleNextDeleteRepeat() {
    let interval: TimeInterval
    if deleteRepeatCount < 6 {
      interval = 0.09
    } else if deleteRepeatCount < 18 {
      interval = 0.06
    } else {
      interval = 0.035
    }

    deleteRepeatTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: false) {
      [weak self] _ in
      self?.performRepeatingDelete()
    }
    if let deleteRepeatTimer {
      RunLoop.main.add(deleteRepeatTimer, forMode: .common)
    }
  }

  private func deletePreviousWordChunk() {
    guard let context = textDocumentProxy.documentContextBeforeInput, !context.isEmpty else {
      textDocumentProxy.deleteBackward()
      return
    }

    let suffix = Array(context.reversed())
    var deleteCount = 0
    var hasSeenWordCharacter = false

    for character in suffix {
      if character.isWhitespace || character.isPunctuation {
        if hasSeenWordCharacter { break }
      } else {
        hasSeenWordCharacter = true
      }
      deleteCount += 1
    }

    for _ in 0..<max(1, deleteCount) {
      textDocumentProxy.deleteBackward()
    }
  }

  private func startRecordingPoll() {
    stopRecordingPoll()
    recordingPollTimer = Timer.scheduledTimer(withTimeInterval: 0.12, repeats: true) { [weak self] _ in
      self?.pollRecordingState()
    }
    if let recordingPollTimer {
      RunLoop.main.add(recordingPollTimer, forMode: .common)
    }
  }

  private func stopRecordingPoll() {
    recordingPollTimer?.invalidate()
    recordingPollTimer = nil
  }

  private func startHandoffObservers() {
    guard !isObservingHandoffNotifications else { return }
    let center = CFNotificationCenterGetDarwinNotifyCenter()
    let observer = Unmanaged.passUnretained(self).toOpaque()
    let callback: CFNotificationCallback = { _, observer, _, _, _ in
      guard let observer else { return }
      let controller = Unmanaged<KeyboardViewController>.fromOpaque(observer).takeUnretainedValue()
      DispatchQueue.main.async {
        controller.handleHandoffNotification()
      }
    }

    CFNotificationCenterAddObserver(
      center,
      observer,
      callback,
      Self.darwinStatusNotificationName as CFString,
      nil,
      .deliverImmediately
    )
    CFNotificationCenterAddObserver(
      center,
      observer,
      callback,
      Self.darwinTranscriptReadyNotificationName as CFString,
      nil,
      .deliverImmediately
    )
    isObservingHandoffNotifications = true
  }

  private func stopHandoffObservers() {
    guard isObservingHandoffNotifications else { return }
    let center = CFNotificationCenterGetDarwinNotifyCenter()
    let observer = Unmanaged.passUnretained(self).toOpaque()
    CFNotificationCenterRemoveObserver(
      center,
      observer,
      CFNotificationName(Self.darwinStatusNotificationName as CFString),
      nil
    )
    CFNotificationCenterRemoveObserver(
      center,
      observer,
      CFNotificationName(Self.darwinTranscriptReadyNotificationName as CFString),
      nil
    )
    isObservingHandoffNotifications = false
  }

  private func handleHandoffNotification() {
    // Once the review card is up, ignore status churn — the user is deciding
    // whether to insert; only their tap should dismiss it.
    if isAgentReviewShown { return }
    if consumePendingTranscriptIfAvailable(trigger: "darwinNotification") {
      waitForTranscriptTimer?.invalidate()
      waitForTranscriptTimer = nil
      return
    }
    applySharedHandoffStatus()
  }

  private func applySharedHandoffStatus() {
    let provider = KeyboardHandoffProvider.shared
    guard let status = provider.transcriptionStatus() else { return }
    switch status {
    case "transcribing", "cleaning":
      // The app flips the shared status to "transcribing" whenever it
      // finalizes a recording — including one the user just cancelled. Don't
      // let that Darwin echo resurrect the pill after cancel reset the button.
      if let cancelled = cancelledProcessingJobId,
         provider.currentRecordingJobId() == cancelled {
        logRecordMarker("handoffStatus.ignoredCancelledJob", extra: "job=\(cancelled)")
        return
      }
      showLongRunningRecordState(title: status == "cleaning" ? "Cleaning up" : "Transcribing")
      // A Darwin-driven pill needs the transcript poll running — it is the
      // pill's only exit path (transcript, failure status, or timeout).
      if waitForTranscriptTimer == nil {
        waitForTranscript()
      }
    case "ready":
      showLongRunningRecordState(title: "Inserting")
    case "idle":
      // Cancel/discard resets the shared status to idle. Clear a waiting pill
      // instead of letting it spin against a job that no longer exists.
      if !isRemoteRecordingActive, !isDarwinStartPending, waitForTranscriptTimer != nil {
        logRecordMarker("handoffStatus.idleReset")
        waitForTranscriptTimer?.invalidate()
        waitForTranscriptTimer = nil
        refreshRecordButton()
      }
    case "no_speech":
      surfaceHandoffFailure(title: "No speech")
    case "setup_required":
      surfaceHandoffFailure(title: "Set up in app")
    case "error":
      surfaceHandoffFailure(title: "Try again")
    case "agent_generating":
      // The Darwin notification for agent_generating can arrive before our own
      // exitRecordingMode has entered the state (or after returning from a
      // handoff). Show the "Writing" pill and start polling if we aren't already.
      if !isAgentGenerating {
        enterAgentGenerating()
      }
    case "agent_ready":
      // Respect an in-flight regenerate's freshness gate so a stale pre-action
      // result delivered on this Darwin poke can't close the action early, and
      // drop a result for a cancelled/timed-out generation the app raced to
      // finish (it would otherwise pop the card seconds after the user cancelled).
      if let result = KeyboardHandoffProvider.shared.readAgentResult() {
        if isAgentResultRejected(result) {
          logRecordMarker("applySharedHandoffStatus.rejected", extra: "job=\(result.jobId)")
          KeyboardHandoffProvider.shared.clearAgentResult()
          KeyboardHandoffProvider.shared.clearTranscriptionStatus()
        } else if agentResultSatisfiesAction(result) {
          handleAgentReady(result)
        }
      }
    case "agent_error":
      handleAgentError(detail: KeyboardHandoffProvider.shared.transcriptionError())
    default:
      break
    }
  }

  /// Terminal failure: stop waiting for a transcript, clear the shared status
  /// so it can't resurface as stale state later, and show the issue pill. Also
  /// tears down an in-flight agent wait: a silent agent recording writes
  /// `no_speech` (not `agent_error`), which routes here — without this the agent
  /// poll would keep ticking for ~75s and re-flash a spurious "Try again". A
  /// mid-action follow-up keeps its retained card (existing versions stay
  /// insertable) with a note, matching the agent_error/cancel behaviour.
  private func surfaceHandoffFailure(title: String) {
    waitForTranscriptTimer?.invalidate()
    waitForTranscriptTimer = nil
    if isAgentGenerating {
      stopWaitingForAgentResult()
      isAgentGenerating = false
      agentActionMinUpdatedAtMs = nil
      processingCancelButton.isHidden = true
      KeyboardHandoffProvider.shared.clearAgentRequest()
      KeyboardHandoffProvider.shared.clearTranscriptionStatus()
      if isAgentActionInFlight, !agentReviewVersions.isEmpty {
        isAgentActionInFlight = false
        restoreAgentReviewCard()
        flashAgentReviewNote(title)
        return
      }
      isAgentActionInFlight = false
      showIssueState(title: title)
      return
    }
    KeyboardHandoffProvider.shared.clearTranscriptionStatus()
    showIssueState(title: title)
  }

  /// When the keyboard reappears while the app is still working (the user
  /// switched fields or apps mid-transcription) or shortly after a failure it
  /// never saw, restore that state instead of silently resetting to idle.
  /// Returns false when there's nothing fresh to resume.
  private func resumeFreshHandoffState() -> Bool {
    let provider = KeyboardHandoffProvider.shared
    guard let status = provider.transcriptionStatus(),
          let ageMs = provider.transcriptionStatusAgeMs() else { return false }
    switch status {
    case "transcribing", "cleaning":
      guard ageMs < 120_000 else { return false }
      isDarwinStartPending = false
      darwinStartPendingTicks = 0
      darwinStartActiveTicks = 0
      didRequestStopForCurrentSession = false
      logRecordMarker("viewDidAppear.resumedStatus", extra: "status=\(status) ageMs=\(ageMs)")
      showLongRunningRecordState(title: status == "cleaning" ? "Cleaning up" : "Transcribing")
      waitForTranscript()
      return true
    case "error":
      guard ageMs < 15_000 else { return false }
      logRecordMarker("viewDidAppear.resumedStatus", extra: "status=error ageMs=\(ageMs)")
      surfaceHandoffFailure(title: "Try again")
      return true
    case "setup_required":
      guard ageMs < 15_000 else { return false }
      logRecordMarker("viewDidAppear.resumedStatus", extra: "status=setup_required ageMs=\(ageMs)")
      surfaceHandoffFailure(title: "Set up in app")
      return true
    case "no_speech":
      guard ageMs < 15_000 else { return false }
      logRecordMarker("viewDidAppear.resumedStatus", extra: "status=no_speech ageMs=\(ageMs)")
      surfaceHandoffFailure(title: "No speech")
      return true
    case "agent_generating":
      // The app is still transcribing/generating — resume the "Writing" state and
      // its poll (which owns the app-death and timeout fallbacks).
      guard ageMs < 120_000 else { return false }
      logRecordMarker("viewDidAppear.resumedStatus", extra: "status=agent_generating ageMs=\(ageMs)")
      enterAgentGenerating()
      return true
    case "agent_ready":
      // Re-open into the review card only while the result is fresh (<10 min);
      // anything older — or a result for a generation cancelled/timed-out this
      // session — is discarded so a stale reply can't ambush a later field.
      if let result = provider.readAgentResult(),
         !isAgentResultRejected(result),
         let updatedAtMs = result.updatedAtMs,
         Date().timeIntervalSince1970 * 1000 - updatedAtMs < 600_000 {
        logRecordMarker("viewDidAppear.resumedStatus", extra: "status=agent_ready")
        showAgentReviewCard(result)
        return true
      }
      provider.clearAgentResult()
      provider.clearTranscriptionStatus()
      return false
    case "agent_error":
      guard ageMs < 15_000 else { return false }
      logRecordMarker("viewDidAppear.resumedStatus", extra: "status=agent_error ageMs=\(ageMs)")
      handleAgentError(detail: provider.transcriptionError())
      return true
    default:
      return false
    }
  }

  private func logRecordMarker(_ marker: String, extra: String = "") {
    let sharedState = KeyboardHandoffProvider.shared.recordingStateSnapshot()
    let suffix = extra.isEmpty ? "" : " \(extra)"
    KeyboardLog.echo(
      "MARKER \(marker) localActive=\(isRemoteRecordingActive) pending=\(isDarwinStartPending) pendingTicks=\(darwinStartPendingTicks) activeTicks=\(darwinStartActiveTicks) requestedStop=\(didRequestStopForCurrentSession) sharedActive=\(sharedState.active) sharedReady=\(sharedState.ready) sharedWarm=\(sharedState.warmMic) stopReq=\(sharedState.stopRequested)\(suffix)"
    )
  }

  private func refreshRecordButton() {
    issueResetTimer?.invalidate()
    issueResetTimer = nil

    isDarwinStartPending = false
    darwinStartPendingTicks = 0
    darwinStartActiveTicks = 0
    didRequestStopForCurrentSession = false
    isAgentRecordingActive = false
    agentRecordingHeaderText = nil
    agentRecordingHint = nil

    recordButton.removeTarget(self, action: #selector(handleDarwinRecordTapped), for: .touchUpInside)
    recordButton.removeTarget(self, action: #selector(handleStopRecordingTapped), for: .touchUpInside)
    recordButton.removeTarget(
      self, action: #selector(handleFullAccessPillTapped), for: .touchUpInside
    )

    // Full Access is off: every UserDefaults(suiteName:) read no-ops, so
    // dictation is dead while typing keeps working — the keyboard looks healthy
    // and the pill silently does nothing. Convert the dead control into the fix.
    // The extension cannot report this to the app (reporting needs the shared
    // container the loss takes away), so the message has to be drawn here.
    //
    // Persistent, unlike showIssueState / showTransientRecordState: no timer
    // reverts it. The pill cannot link anywhere — an extension without Full
    // Access cannot open any URL — so it opens the explanatory panel instead,
    // which is local UI and therefore the one thing that still works. This must
    // precede the recordsInPlace computation — hostIsOwnApp comes from bundle
    // detection, not the App Group, so it can be true here and would otherwise
    // offer "Tap to speak" into a dead recorder.
    guard hasFullAccess else {
      dictationLinkHosting?.view.isUserInteractionEnabled = false
      applyRecordButtonStyle(
        title: "Turn on Full Access",
        systemImage: "exclamationmark.triangle.fill",
        solidBackground: Palette.issue,
        foreground: Palette.issueInk
      )
      recordButton.addTarget(
        self, action: #selector(handleFullAccessPillTapped), for: .touchUpInside
      )
      // Unanimated before the window exists (viewDidLoad path): the panel should
      // be the first frame, not a flash of keys that then fade.
      if !didDismissFullAccessPanel {
        showFullAccessPanel(animated: view.window != nil)
      }
      resetVoiceMeterBars()
      // Neither control can reach the App Group either; refreshToneButton is
      // not part of the normal refresh path, so call it explicitly.
      refreshToneButton()
      refreshAgentButton()
      logRecordMarker("refreshRecordButton.noFullAccess")
      return
    }
    // Full Access is back (iOS relaunches the extension when it's granted, but
    // belt-and-braces for an in-place flip): the panel has nothing to say.
    hideFullAccessPanel(animated: false)

    // Inside OpenWhispr itself, tapping records in place (the app's URL handler
    // detects the self-hosted case and starts recording without switching apps),
    // so show "Tap to speak" with a mic. Elsewhere, a tap hands off to the app,
    // so show "Activate" with the brand logo.
    let backgroundReady = KeyboardHandoffProvider.shared.isBackgroundSessionReady()
    // Bundle-id detection (hostIsOwnApp) misses often; the app's foreground
    // heartbeat is the reliable "we're inside OpenWhispr" signal. Either one
    // means a tap records in place instead of bouncing to the handoff screen.
    let containingAppForeground = KeyboardHandoffProvider.shared.isContainingAppForeground()
    let selfHosted = hostIsOwnApp || containingAppForeground
    let recordsInPlace = backgroundReady || selfHosted
    dictationLinkHosting?.view.isUserInteractionEnabled = !recordsInPlace

    if recordsInPlace {
      recordButton.addTarget(self, action: #selector(handleDarwinRecordTapped), for: .touchUpInside)
    }

    if recordsInPlace {
      applyRecordButtonStyle(title: "Tap to speak", image: CachedImages.brandLogoMark)
    } else {
      applyRecordButtonStyle(
        title: "Activate",
        image: CachedImages.brandLogoMark,
        gradient: [Palette.brandGradientStart, Palette.brandGradientEnd]
      )
    }
    resetVoiceMeterBars()
    refreshAgentButton()
    logRecordMarker(
      "refreshRecordButton",
      extra:
        "backgroundReady=\(backgroundReady) hostIsOwnApp=\(hostIsOwnApp) containingAppForeground=\(containingAppForeground) selfHosted=\(selfHosted)"
    )
  }

  private func showTransientRecordState(
    title: String,
    systemImage: String,
    background: UIColor,
    duration: TimeInterval
  ) {
    issueResetTimer?.invalidate()
    issueResetTimer = nil
    dictationLinkHosting?.view.isUserInteractionEnabled = false
    applyRecordButtonStyle(
      title: title,
      systemImage: systemImage,
      solidBackground: background
    )
    issueResetTimer = Timer.scheduledTimer(withTimeInterval: duration, repeats: false) {
      [weak self] _ in
      self?.refreshRecordButton()
    }
    if let issueResetTimer {
      RunLoop.main.add(issueResetTimer, forMode: .common)
    }
  }

  private func showLongRunningRecordState(title: String) {
    issueResetTimer?.invalidate()
    issueResetTimer = nil
    dictationLinkHosting?.view.isUserInteractionEnabled = false
    // Cleanup uses the desktop accent purple to match the widget; the other
    // long-running states stay on the brand blue.
    applyRecordButtonStyle(
      title: title,
      systemImage: "ellipsis",
      solidBackground: title == "Cleaning up" ? Palette.cleanupAccent : Palette.accent
    )
    // "Inserting" is too brief and effect-less to cancel; only the waiting
    // states offer the X.
    processingCancelButton.isHidden = !(title == "Transcribing" || title == "Cleaning up")
  }

  private func showIssueState(title: String) {
    KeyboardLog.ui.error("Issue state shown: \(title, privacy: .public)")
    KeyboardLog.echo("Issue state shown: \(title)")
    dictationLinkHosting?.view.isUserInteractionEnabled = false
    applyRecordButtonStyle(
      title: title,
      systemImage: "exclamationmark",
      solidBackground: Palette.issue
    )

    issueResetTimer?.invalidate()
    issueResetTimer = Timer.scheduledTimer(withTimeInterval: 1.2, repeats: false) { [weak self] _ in
      self?.refreshRecordButton()
    }
    if let issueResetTimer {
      RunLoop.main.add(issueResetTimer, forMode: .common)
    }
  }

  private func applyRecordButtonStyle(
    title: String,
    systemImage: String? = nil,
    image: UIImage? = nil,
    solidBackground: UIColor? = nil,
    gradient: [UIColor]? = nil,
    // Tints title and symbol together via baseForegroundColor. Defaults to
    // white so every existing call site is unchanged; only the persistent
    // Full Access state needs dark ink for contrast on amber.
    foreground: UIColor = .white
  ) {
    // The "ellipsis" states (Processing/Starting/Stopping) use the animated dots
    // overlay instead of a static symbol; the image is then a transparent spacer
    // that reserves the dots' space in the layout.
    let useDots = systemImage == "ellipsis"

    // Plain config so the button draws no background of its own — the pill
    // background view behind the content provides it.
    var config = UIButton.Configuration.plain()
    config.title = title
    if useDots {
      config.image = CachedImages.processingDotsSpacer
    } else if let image {
      config.image = image
    } else if let systemImage {
      config.image = UIImage(systemName: systemImage)
    }
    config.imagePadding = 7
    config.imagePlacement = .leading
    config.baseForegroundColor = foreground
    config.contentInsets = NSDirectionalEdgeInsets(top: 8, leading: Metrics.pillLeadingInset, bottom: 8, trailing: 18)
    config.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold)
    config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { incoming in
      var outgoing = incoming
      outgoing.font = UIFont.systemFont(ofSize: 16, weight: .semibold)
      return outgoing
    }
    recordButton.configuration = config

    // "Activate" uses the brand gradient; transient/issue states pass a solid
    // colour; everything else (incl. "Tap to speak") uses the adaptive pill.
    let pillStyle: PillBackgroundView.Style
    if let gradient {
      pillStyle = .gradient(gradient)
    } else if let solidBackground {
      pillStyle = .solid(solidBackground)
    } else {
      pillStyle = .adaptive
    }
    recordButtonBackground.setStyle(pillStyle)

    // Run the animated dots only while an "ellipsis" state is showing.
    if useDots {
      processingDots.isHidden = false
      processingDots.startAnimating()
    } else {
      processingDots.stopAnimating()
      processingDots.isHidden = true
    }

    // Cancel is only valid mid-transcription; every other style hides it. The
    // cancellable states re-show it after this call (showLongRunningRecordState).
    processingCancelButton.isHidden = true

    recordButton.accessibilityLabel = title
    switch title {
    case "Activate":
      recordButton.accessibilityHint = "Opens OpenWhispr to dictate"
    case "Turn on Full Access":
      recordButton.accessibilityHint = "Shows how to turn on Full Access"
    default:
      recordButton.accessibilityHint = "Starts dictation"
    }
  }

  @objc private func handleRecordButtonPress(_ gesture: UILongPressGestureRecognizer) {
    switch gesture.state {
    case .began:
      setRecordButtonPressed(true)
    case .ended:
      setRecordButtonPressed(false)
      // In "Activate" mode the tap itself is handled by the SwiftUI link
      // overlay, which gives no callback. Stamp the tap in the App Group so
      // the app can recover the handoff when the deep link never reaches JS
      // (cold-launch getInitialURL races deliver null and the tap dies).
      if dictationLinkHosting?.view.isUserInteractionEnabled == true {
        KeyboardHandoffProvider.shared.markHandoffIntent()
      }
    case .cancelled, .failed:
      setRecordButtonPressed(false)
    default:
      break
    }
  }

  // Pressed state: the pill lights up and scales down slightly for a tactile feel.
  private func setRecordButtonPressed(_ pressed: Bool) {
    recordButtonBackground.setPressed(pressed)
    UIView.animate(
      withDuration: 0.09,
      delay: 0,
      options: [.allowUserInteraction, .beginFromCurrentState]
    ) {
      let transform = pressed ? CGAffineTransform(scaleX: 0.97, y: 0.97) : .identity
      self.recordButton.transform = transform
      self.recordButtonBackground.transform = transform
    }
  }

  @objc private func handleAgentButtonPress(_ gesture: UILongPressGestureRecognizer) {
    switch gesture.state {
    case .began:
      UIView.animate(withDuration: 0.09, delay: 0, options: [.allowUserInteraction, .beginFromCurrentState]) {
        self.agentButton.transform = CGAffineTransform(scaleX: 0.9, y: 0.9)
      }
    case .ended:
      UIView.animate(withDuration: 0.09, delay: 0, options: [.allowUserInteraction, .beginFromCurrentState]) {
        self.agentButton.transform = .identity
      }
      handleAgentButtonTapped()
    case .cancelled, .failed:
      UIView.animate(withDuration: 0.09, delay: 0, options: [.allowUserInteraction, .beginFromCurrentState]) {
        self.agentButton.transform = .identity
      }
    default:
      break
    }
  }

  /// Fired when the agent button is released. Captures the field selection (and,
  /// if opted in, the surrounding context), writes the one-shot compose request,
  /// then starts recording via the same two paths as the record button: an
  /// in-place requestStart when the background session is warm, else a deep-link
  /// handoff (the Link overlay opens the URL; here we only stamp intent).
  private func handleAgentButtonTapped() {
    guard !isDarwinStartPending, !isRemoteRecordingActive, !isAgentGenerating else { return }
    let provider = KeyboardHandoffProvider.shared
    guard provider.isAgentEnabled() else { return }

    // Not applicable ⇒ Private mode is on. Point at it, swallow the tap.
    guard provider.isAgentApplicable() else {
      playKeyClick()
      showTransientRecordState(
        title: "Off in Local Mode",
        systemImage: "lock.fill",
        background: Palette.issue,
        duration: 1.6
      )
      return
    }

    playKeyClick()

    // Capture from the live proxy before any handoff drops focus. selectedText is
    // usually nil outside our own app (degrade silently); context only on opt-in.
    let selectedText = textDocumentProxy.selectedText
    var contextBefore: String?
    var contextAfter: String?
    if provider.agentSharesContext() {
      contextBefore = textDocumentProxy.documentContextBeforeInput
      contextAfter = textDocumentProxy.documentContextAfterInput
    }
    provider.writeAgentComposeRequest(
      selectedText: selectedText,
      contextBefore: contextBefore,
      contextAfter: contextAfter
    )

    let recordsInPlace = provider.isBackgroundSessionReady()
      || hostIsOwnApp
      || provider.isContainingAppForeground()

    // When text is selected, cue the recording canvas with "Rewriting Selection"
    // so the user knows the instruction will rewrite that text. Degrade silently
    // when selectedText is nil (most third-party apps don't expose it).
    let selectionCaption: String? = (selectedText?.isEmpty == false) ? "Rewriting Selection" : nil
    agentRecordingHint = agentHint(from: Self.agentComposeHints)

    if recordsInPlace {
      isAgentRecordingActive = true
      logRecordMarker("handleAgentButtonTapped.inPlace")
      startAgentRecordingInPlace(caption: selectionCaption)
    } else {
      // The Link overlay opens the dictation URL; stamp intent so the app can
      // recover the handoff if the deep link races to null on cold launch. The
      // recording that follows becomes an agent job because the request is set.
      isAgentRecordingActive = true
      logRecordMarker("handleAgentButtonTapped.handoff")
      provider.markHandoffIntent()
    }
  }

  /// Starts an in-place agent recording. Mirrors handleDarwinRecordTapped's
  /// requestStart handshake and "Starting" pill; enterRecordingMode then swaps in
  /// the agent header because isAgentRecordingActive is set. `caption` overrides
  /// the recording-canvas header (a follow-up passes "Describe your changes").
  private func startAgentRecordingInPlace(caption: String? = nil) {
    agentRecordingHeaderText = caption
    recordButton.removeTarget(self, action: #selector(handleDarwinRecordTapped), for: .touchUpInside)
    recordButton.removeTarget(self, action: #selector(handleStopRecordingTapped), for: .touchUpInside)

    cancelledProcessingJobId = nil
    isRemoteRecordingActive = false
    didRequestStopForCurrentSession = false
    KeyboardHandoffProvider.shared.requestStart()
    isDarwinStartPending = true
    darwinStartPendingTicks = 0
    darwinStartActiveTicks = 0

    showTransientRecordState(
      title: "Starting",
      systemImage: "ellipsis",
      background: Palette.cleanupAccent,
      duration: 3.0
    )
  }

  // Allow the press gesture to coexist with the link overlay's own recogniser.
  func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer,
    shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
  ) -> Bool {
    true
  }

  private func formatTranscription(_ text: String) -> String {
    text
      .replacingOccurrences(of: "[ \\t]+", with: " ", options: .regularExpression)
      .replacingOccurrences(of: "\\n{3,}", with: "\n\n", options: .regularExpression)
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private func insertSmartText(_ text: String) {
    guard !text.isEmpty else { return }

    let context = textDocumentProxy.documentContextBeforeInput ?? ""
    let needsLeadingSpace =
      !context.isEmpty
      && !context.hasSuffix(" ")
      && !context.hasSuffix("\n")
      && !text.hasPrefix("\n")
      && !text.hasPrefix(",")
      && !text.hasPrefix(".")

    let insertion = needsLeadingSpace ? " \(text)" : text
    textDocumentProxy.insertText(insertion)
    // Shift follows the text (it was synced before the text arrived).
    syncShiftWithContextIfNeeded()
    refreshAfterEdit()
  }

  @discardableResult
  private func consumePendingTranscriptIfAvailable(trigger: String) -> Bool {
    // A transcript that lands for a cancelled job (the app raced past its cancel
    // checkpoint) must be dropped, never inserted into the field.
    if let cancelledProcessingJobId,
       KeyboardHandoffProvider.shared.discardPendingTranscriptIfMatches(jobId: cancelledProcessingJobId) {
      logRecordMarker("consumePending.discardedCancelled", extra: "job=\(cancelledProcessingJobId)")
      self.cancelledProcessingJobId = nil
      return false
    }

    guard let pending = KeyboardHandoffProvider.shared.consumePendingTranscript() else {
      return false
    }

    let text = formatTranscription(pending)
    guard !text.isEmpty else {
      return false
    }

    KeyboardLog.transcription.info(
      "Inserted pending transcript from app. trigger=\(trigger, privacy: .public) chars=\(text.count, privacy: .public)"
    )
    KeyboardLog.echo("Inserted pending transcript from app. chars=\(text.count)")
    insertSmartText(text)
    showTransientRecordState(
      title: "Inserted",
      systemImage: "checkmark",
      background: Palette.accent,
      duration: 1.1
    )
    // The keyboard stays up after inserting so the user can keep dictating or
    // editing; they dismiss it themselves when done.
    return true
  }

  private func pollRecordingState() {
    if isAgentReviewShown { return }
    let provider = KeyboardHandoffProvider.shared

    if isDarwinStartPending {
      darwinStartPendingTicks += 1
      if provider.isRecordingActive() {
        darwinStartActiveTicks += 1
        if darwinStartActiveTicks == 1 {
          logRecordMarker("poll.pendingActiveDetected")
        }
        if darwinStartActiveTicks < 2 {
          return
        }
        isDarwinStartPending = false
        darwinStartPendingTicks = 0
        darwinStartActiveTicks = 0
        isRemoteRecordingActive = true
        logRecordMarker("poll.pendingConfirmedActive")
        enterRecordingMode()
        return
      }
      darwinStartActiveTicks = 0
      // A dead app can't ack the start: after a force-quit the heartbeat
      // freezes and goes stale within seconds, and an interruption drops the
      // ready flag. Bail to the handoff fallback then, instead of stranding
      // the user on "Starting" for the full timeout.
      if darwinStartPendingTicks >= 4, !provider.isBackgroundSessionReady() {
        logRecordMarker("poll.pendingAbortNotReady", extra: "ticks=\(darwinStartPendingTicks)")
        handleDarwinStartFallback()
        return
      }
      if darwinStartPendingTicks >= 20 {
        logRecordMarker("poll.pendingTimeout")
        handleDarwinStartFallback()
        return
      }
      return
    }

    let active = provider.isRecordingActive()

    if active && !isRemoteRecordingActive {
      isRemoteRecordingActive = true
      // A recording we didn't start locally (handoff): recover whether it's an
      // agent job so the canvas and post-stop path match.
      if !isAgentRecordingActive {
        isAgentRecordingActive = provider.hasAgentJobForCurrentRecording()
      }
      logRecordMarker("poll.transitionToActive")
      enterRecordingMode()
    } else if !active && isRemoteRecordingActive {
      isRemoteRecordingActive = false
      if didRequestStopForCurrentSession {
        didRequestStopForCurrentSession = false
        logRecordMarker("poll.transitionToInactive.expected")
        exitRecordingMode()
      } else {
        logRecordMarker("poll.transitionToInactive.unexpected")
        if !consumePendingTranscriptIfAvailable(trigger: "unexpectedInactive") {
          showIssueState(title: "Recording interrupted")
        }
      }
      return
    }

    if active {
      updateVoiceMeterBars(level: provider.currentAudioLevel())
    }
  }

  private func enterRecordingMode() {
    issueResetTimer?.invalidate()
    issueResetTimer = nil

    dictationLinkHosting?.view.isUserInteractionEnabled = false
    isDarwinStartPending = false
    darwinStartPendingTicks = 0
    darwinStartActiveTicks = 0
    didRequestStopForCurrentSession = false
    didRequestCancelForCurrentSession = false

    recordButton.removeTarget(self, action: #selector(handleDarwinRecordTapped), for: .touchUpInside)
    recordButton.removeTarget(self, action: #selector(handleStopRecordingTapped), for: .touchUpInside)

    showRecordingCanvas()
    logRecordMarker("enterRecordingMode")
  }

  private func exitRecordingMode() {
    isDarwinStartPending = false
    darwinStartPendingTicks = 0
    darwinStartActiveTicks = 0

    let wasCancel = didRequestCancelForCurrentSession
    didRequestCancelForCurrentSession = false

    recordButton.removeTarget(self, action: #selector(handleDarwinRecordTapped), for: .touchUpInside)
    recordButton.removeTarget(self, action: #selector(handleStopRecordingTapped), for: .touchUpInside)

    hideRecordingCanvas()
    resetVoiceMeterBars()

    if wasCancel {
      logRecordMarker("exitRecordingMode.canceled")
      // Cancelling an agent recording also drops the pending request so the app
      // won't produce a result for it. refreshRecordButton clears the flag.
      if isAgentRecordingActive {
        KeyboardHandoffProvider.shared.clearAgentRequest()
      }
      agentRecordingHeaderText = nil
      agentRecordingHint = nil
      // A cancelled follow-up returns to the card it came from (existing versions
      // stay insertable); a cancelled first-time recording returns to idle.
      if isAgentActionInFlight, !agentReviewVersions.isEmpty {
        isAgentActionInFlight = false
        isAgentRecordingActive = false
        restoreAgentReviewCard()
        return
      }
      isAgentActionInFlight = false
      refreshRecordButton()
      return
    }

    // Agent recordings transcribe → generate; enter the "Writing" state and poll
    // the agent result instead of the plain transcript.
    if isAgentRecordingActive {
      logRecordMarker("exitRecordingMode.agent")
      agentRecordingHeaderText = nil
      enterAgentGenerating()
      return
    }

    showLongRunningRecordState(title: "Transcribing")

    logRecordMarker("exitRecordingMode")
    waitForTranscript()
  }

  private func updateVoiceMeterBars(level: Float) {
    let clamped = min(max(CGFloat(level), 0), 1)
    // Gate out the ambient floor (~-37 dB and below) so the bars fall back to
    // baseline in silence, and keep the response near-linear so they track
    // loudness instead of slamming to full height on the faintest sound.
    // Mirrors the JS home-screen waveform (recordingWaveformPattern.ts).
    let gated = clamped < 0.26 ? 0 : clamped
    let emphasized = min(1, CGFloat(pow(Double(gated), 0.85)))
    let smoothing = emphasized > smoothedVoiceLevel ? CGFloat(0.78) : CGFloat(0.34)
    smoothedVoiceLevel += (emphasized - smoothedVoiceLevel) * smoothing

    voiceMeterHistory.append(smoothedVoiceLevel)
    let maxHistory = recordingWaveformBars.count
    if voiceMeterHistory.count > maxHistory {
      voiceMeterHistory.removeFirst(voiceMeterHistory.count - maxHistory)
    }

    let canvasLevels = meterLevelsForBars(from: voiceMeterHistory, barCount: recordingWaveformBars.count)
    for (index, bar) in recordingWaveformBars.enumerated() {
      let value = min(max(canvasLevels[index], 0), 1)
      let scale = CGFloat(0.08 + value * 0.92)
      let alpha = CGFloat(0.35 + value * 0.65)
      UIView.animate(withDuration: 0.08, delay: 0, options: .curveLinear) {
        bar.transform = CGAffineTransform(scaleX: 1, y: scale)
        bar.alpha = alpha
      }
    }
  }

  private func resetVoiceMeterBars() {
    voiceMeterHistory.removeAll(keepingCapacity: true)
    smoothedVoiceLevel = 0
  }

  private func meterLevelsForBars(from history: [CGFloat], barCount: Int) -> [CGFloat] {
    guard barCount > 0 else { return [] }
    guard !history.isEmpty else { return Array(repeating: 0, count: barCount) }

    let recent = Array(history.suffix(barCount))
    if recent.count <= barCount {
      return Array(repeating: 0, count: barCount - recent.count) + recent
    }
    return recent
  }

  @objc private func handleStopRecordingTapped() {
    didRequestStopForCurrentSession = true
    didRequestCancelForCurrentSession = false
    logRecordMarker("handleStopRecordingTapped.beforeRequest")
    KeyboardHandoffProvider.shared.requestStop()
    recordButton.removeTarget(self, action: #selector(handleStopRecordingTapped), for: .touchUpInside)

    setCanvasActionButtonsEnabled(false)
    recordingCaptionLabel.text = isAgentRecordingActive ? "Writing…" : "Transcribing…"

    showTransientRecordState(
      title: "Stopping",
      systemImage: "ellipsis",
      background: isAgentRecordingActive ? Palette.cleanupAccent : Palette.accent,
      duration: 5.0
    )
    logRecordMarker("handleStopRecordingTapped.afterRequest")
  }

  @objc private func handleCancelRecordingTapped() {
    didRequestStopForCurrentSession = true
    didRequestCancelForCurrentSession = true
    // Remember the job so the app's follow-up writes for it (the shared
    // "transcribing" status from its stopRecording, or a late transcript)
    // can't resurrect UI for a dictation the user just abandoned.
    cancelledProcessingJobId = KeyboardHandoffProvider.shared.currentRecordingJobId()
    logRecordMarker("handleCancelRecordingTapped")
    KeyboardHandoffProvider.shared.requestCancel()
    // Defensively flip the active flag locally — if the host app isn't
    // actually recording (e.g., a stale flag put us in the canvas), the
    // metering tick won't observe stop_requested, so nothing else would
    // clear this. Without this we'd be stuck on the canvas.
    KeyboardHandoffProvider.shared.forceClearActiveFlag()
    recordButton.removeTarget(self, action: #selector(handleStopRecordingTapped), for: .touchUpInside)

    setCanvasActionButtonsEnabled(false)
    recordingCaptionLabel.text = "Canceled"
  }

  /// Cancel from the processing pill (post-recording). The app honours the
  /// cancel flag at its transcription checkpoints; here we also stop waiting,
  /// remember the job so a late transcript can't slip in, and return to idle.
  @objc private func handleProcessingCancelTapped() {
    let provider = KeyboardHandoffProvider.shared

    // During agent generation the same X aborts the compose. The app's currency
    // check / cancel flag drops any result for this job; we clear the local
    // expectation and the agent keys. An in-flight action (regenerate/follow-up)
    // returns to the card — its existing versions stay insertable — instead of
    // idle; a first-time compose has no card, so it returns to idle.
    if isAgentGenerating {
      logRecordMarker("handleProcessingCancelTapped.agent")
      stopWaitingForAgentResult()
      // Remember this generation so a result the app writes after racing past its
      // own cancel checkpoint is dropped, not shown, at any later adoption point.
      rememberRejectedAgentGeneration()
      isAgentGenerating = false
      agentActionMinUpdatedAtMs = nil
      provider.cancelProcessingJob()
      provider.clearAgentRequest()
      if isAgentActionInFlight, !agentReviewVersions.isEmpty {
        isAgentActionInFlight = false
        isAgentRecordingActive = false
        restoreAgentReviewCard()
        return
      }
      isAgentActionInFlight = false
      provider.clearAgentResult()
      refreshRecordButton()
      return
    }

    cancelledProcessingJobId = provider.currentRecordingJobId()
    logRecordMarker(
      "handleProcessingCancelTapped",
      extra: "job=\(cancelledProcessingJobId ?? "-")"
    )
    provider.cancelProcessingJob()
    waitForTranscriptTimer?.invalidate()
    waitForTranscriptTimer = nil
    refreshRecordButton()
  }

  @objc private func handleDarwinRecordTapped() {
    guard !isDarwinStartPending, !isRemoteRecordingActive else { return }

    recordButton.removeTarget(self, action: #selector(handleDarwinRecordTapped), for: .touchUpInside)
    recordButton.removeTarget(self, action: #selector(handleStopRecordingTapped), for: .touchUpInside)

    cancelledProcessingJobId = nil
    isRemoteRecordingActive = false
    didRequestStopForCurrentSession = false
    logRecordMarker("handleDarwinRecordTapped.beforeRequest")
    KeyboardHandoffProvider.shared.requestStart()
    isDarwinStartPending = true
    darwinStartPendingTicks = 0
    darwinStartActiveTicks = 0
    logRecordMarker("handleDarwinRecordTapped.afterRequest")

    showTransientRecordState(
      title: "Starting",
      systemImage: "ellipsis",
      background: Palette.accent,
      duration: 3.0
    )
  }

  private func handleDarwinStartFallback() {
    isDarwinStartPending = false
    darwinStartPendingTicks = 0
    darwinStartActiveTicks = 0
    didRequestStopForCurrentSession = false

    KeyboardHandoffProvider.shared.clearBackgroundSessionReady()

    // A follow-up recording failed to start: the existing card versions are still
    // insertable, so restore the card instead of abandoning them to idle.
    if isAgentActionInFlight, !agentReviewVersions.isEmpty {
      isAgentActionInFlight = false
      isAgentRecordingActive = false
      restoreAgentReviewCard()
      flashAgentReviewNote(hostIsOwnApp ? "Try again" : "Tap to open app")
      logRecordMarker("handleDarwinStartFallback.restoreCard")
      return
    }
    isAgentActionInFlight = false
    agentReviewVersions = []
    refreshRecordButton()
    showIssueState(title: hostIsOwnApp ? "Try again" : "Tap to open app")
    logRecordMarker("handleDarwinStartFallback")
  }

  private func waitForTranscript() {
    var attempts = 0
    logRecordMarker("waitForTranscript.start")
    waitForTranscriptTimer?.invalidate()
    waitForTranscriptTimer = Timer.scheduledTimer(withTimeInterval: 0.75, repeats: true) { [weak self] t in
      guard let self else {
        t.invalidate()
        return
      }
      attempts += 1
      if self.consumePendingTranscriptIfAvailable(trigger: "waitForTranscript") {
        self.logRecordMarker("waitForTranscript.consumed", extra: "attempts=\(attempts)")
        t.invalidate()
        self.waitForTranscriptTimer = nil
        return
      }
      // The app reports failures through the shared status, but Darwin
      // delivery isn't guaranteed — poll it here rather than spinning on
      // "Transcribing" until the timeout.
      let status = KeyboardHandoffProvider.shared.transcriptionStatus()
      if status == "error" || status == "no_speech" || status == "setup_required" {
        self.logRecordMarker(
          "waitForTranscript.failedStatus",
          extra: "status=\(status ?? "-") attempts=\(attempts)"
        )
        let failureTitle: String
        switch status {
        case "no_speech": failureTitle = "No speech"
        case "setup_required": failureTitle = "Set up in app"
        default: failureTitle = "Try again"
        }
        self.surfaceHandoffFailure(title: failureTitle)
      } else if status == "idle", attempts > 4 {
        // Cancel/discard ended the job without a transcript; stop waiting
        // instead of spinning until the two-minute timeout. Grace ticks cover
        // the moment before the app stamps "transcribing" on a normal stop.
        self.logRecordMarker("waitForTranscript.idleReset", extra: "attempts=\(attempts)")
        t.invalidate()
        self.waitForTranscriptTimer = nil
        self.refreshRecordButton()
      } else if attempts > 160 {
        self.logRecordMarker("waitForTranscript.timeout")
        self.surfaceHandoffFailure(title: "Try again")
      }
    }
    if let waitForTranscriptTimer {
      RunLoop.main.add(waitForTranscriptTimer, forMode: .common)
    }
  }

  // MARK: - Agent generating + review

  /// Post-recording state for an agent job: the app is transcribing the spoken
  /// instruction and generating a reply. Shows the purple "Writing" pill with a
  /// cancel X and polls for the result.
  private func enterAgentGenerating() {
    isAgentGenerating = true
    agentActionMinUpdatedAtMs = nil
    showAgentWritingState()
    waitForAgentResult()
  }

  /// Regenerate path: the card's session is unchanged and no new recording runs,
  /// so the pre-action result is still readable. Fade the card out to the Phase 2
  /// "Writing" pill (keeping the local versions so error/cancel can restore it),
  /// then wait for a result the app wrote no earlier than the action's timestamp
  /// (agentActionMinUpdatedAtMs gates both the poll and the Darwin ready path).
  private func enterAgentRegenerating(minUpdatedAtMs: Int64) {
    isAgentGenerating = true
    isAgentActionInFlight = true
    agentActionMinUpdatedAtMs = minUpdatedAtMs
    hideAgentReviewCard(clearState: false)
    showAgentWritingState()
    waitForAgentResult()
  }

  private func showAgentWritingState() {
    issueResetTimer?.invalidate()
    issueResetTimer = nil
    dictationLinkHosting?.view.isUserInteractionEnabled = false
    applyRecordButtonStyle(
      title: "Writing",
      systemImage: "ellipsis",
      solidBackground: Palette.cleanupAccent
    )
    processingCancelButton.isHidden = false
  }

  /// Belt-and-suspenders poll (Darwin delivery of agent_ready/agent_error isn't
  /// guaranteed). Clone of waitForTranscript: 0.75s ticks, resolves on the shared
  /// status, additionally detects app death via a stale heartbeat and caps at ~75s.
  /// Adoption is gated by agentActionMinUpdatedAtMs: for a regenerate (session /
  /// recording-job unchanged, so the pre-action result is still readable) a result
  /// is accepted only once the app rewrites it at/after the action timestamp; for
  /// compose/follow-up it's nil and the first readable, non-superseded result wins.
  private func waitForAgentResult() {
    var attempts = 0
    logRecordMarker("waitForAgentResult.start")
    waitForAgentResultTimer?.invalidate()
    waitForAgentResultTimer = Timer.scheduledTimer(withTimeInterval: 0.75, repeats: true) { [weak self] t in
      guard let self else {
        t.invalidate()
        return
      }
      guard self.isAgentGenerating else {
        t.invalidate()
        self.waitForAgentResultTimer = nil
        return
      }
      attempts += 1

      let provider = KeyboardHandoffProvider.shared
      let status = provider.transcriptionStatus()

      if status == "agent_ready" {
        if let result = provider.readAgentResult() {
          if self.isAgentResultRejected(result) {
            // A cancelled/timed-out generation the app finished anyway. Drop the
            // stale result + status so it can't open a card; keep polling in case
            // a newer, legitimate result for this wait is still coming.
            self.logRecordMarker("waitForAgentResult.rejected", extra: "job=\(result.jobId)")
            provider.clearAgentResult()
            provider.clearTranscriptionStatus()
            return
          }
          if self.agentResultSatisfiesAction(result) {
            self.logRecordMarker("waitForAgentResult.ready", extra: "attempts=\(attempts)")
            self.handleAgentReady(result)
            return
          }
          // Action wait only: the readable result is the pre-action one the app
          // hasn't rewritten yet. Keep waiting (the app-death/timeout guards
          // below still apply) rather than treating this as a missing result.
          return
        }
        // Status says ready but no readable result; keep polling a few ticks
        // (Darwin/write races), then give up.
        if attempts > 8 {
          self.handleAgentError(detail: nil)
        }
        return
      }

      if status == "agent_error" {
        self.logRecordMarker("waitForAgentResult.error", extra: "attempts=\(attempts)")
        self.handleAgentError(detail: provider.transcriptionError())
        return
      }

      // App-death detection: still generating but no fresh heartbeat ⇒ the app
      // process was jetsam'd mid-job; no result will ever land.
      if status == "agent_generating", !provider.isAppHeartbeatFresh() {
        self.logRecordMarker("waitForAgentResult.appDied", extra: "attempts=\(attempts)")
        self.surfaceAgentFailure(title: "Open OpenWhispr")
        return
      }

      // ~75s hard timeout (0.75s × 100). JS worst case (transcribe + 55s stream +
      // retry + 55s retry) can exceed this, so remember the job/action first: a
      // slow-but-successful result that lands later must be dropped, not shown.
      if attempts > 100 {
        self.logRecordMarker("waitForAgentResult.timeout")
        self.rememberRejectedAgentGeneration()
        self.surfaceAgentFailure(title: "Try again")
      }
    }
    if let waitForAgentResultTimer {
      RunLoop.main.add(waitForAgentResultTimer, forMode: .common)
    }
  }

  private func stopWaitingForAgentResult() {
    waitForAgentResultTimer?.invalidate()
    waitForAgentResultTimer = nil
  }

  /// Result landed: stop polling, clear the "generating" flags, and show the card
  /// on the newest result (its activeIndex). The new result supersedes any
  /// versions retained for an in-flight action.
  private func handleAgentReady(_ result: AgentResult) {
    stopWaitingForAgentResult()
    isAgentGenerating = false
    isAgentActionInFlight = false
    agentActionMinUpdatedAtMs = nil
    processingCancelButton.isHidden = true
    showAgentReviewCard(result)
  }

  /// agent_error routing. Mid-action (regenerate/follow-up) the existing versions
  /// stay insertable: restore the card and flash a transient note instead of
  /// dropping to idle; usage_limit still reads "Limit reached", others "Try
  /// again". With no card to keep, fall back to the Phase 2 issue pill.
  private func handleAgentError(detail: String?) {
    stopWaitingForAgentResult()
    isAgentGenerating = false
    agentActionMinUpdatedAtMs = nil
    processingCancelButton.isHidden = true
    KeyboardHandoffProvider.shared.clearTranscriptionStatus()
    KeyboardHandoffProvider.shared.clearAgentRequest()
    // session_expired means the session TTL lapsed — retrying the same session
    // can't succeed, so prompt a fresh start instead of the retryable "Try again".
    let title: String
    switch detail {
    case "usage_limit": title = "Limit reached"
    case "session_expired": title = "Start over"
    // An anonymous onboarding session; only creating an account clears it.
    case "account_required": title = "Create an account"
    // No agent provider is chosen for the Providers mode; retrying can't help.
    case "agent_setup_required": title = "Set up in app"
    default: title = "Try again"
    }
    if isAgentActionInFlight, !agentReviewVersions.isEmpty {
      isAgentActionInFlight = false
      restoreAgentReviewCard()
      flashAgentReviewNote(title)
      return
    }
    isAgentActionInFlight = false
    showIssueState(title: title)
  }

  /// Terminal agent failure that isn't a plain retry (app died, missing result).
  /// Mid-action, keep the card (existing versions insertable) with a note; else
  /// stop the shared status resurfacing, clear the request, and show the pill.
  private func surfaceAgentFailure(title: String) {
    stopWaitingForAgentResult()
    isAgentGenerating = false
    agentActionMinUpdatedAtMs = nil
    processingCancelButton.isHidden = true
    KeyboardHandoffProvider.shared.clearTranscriptionStatus()
    KeyboardHandoffProvider.shared.clearAgentRequest()
    if isAgentActionInFlight, !agentReviewVersions.isEmpty {
      isAgentActionInFlight = false
      restoreAgentReviewCard()
      flashAgentReviewNote(title)
      return
    }
    isAgentActionInFlight = false
    showIssueState(title: title)
  }

  /// Briefly flashes a transient note (an action error) in the top-centre slot,
  /// hiding the follow-up capsule while it shows, then restores the capsule. The
  /// card's versions stay insertable throughout — this is the card-scoped
  /// analogue of showTransientRecordState.
  private func flashAgentReviewNote(_ text: String) {
    agentReviewNoteResetTimer?.invalidate()
    agentReviewHeaderLabel.text = text
    agentReviewHeaderLabel.isHidden = false
    agentReviewFollowUpButton.isHidden = true
    agentReviewNoteResetTimer = Timer.scheduledTimer(withTimeInterval: 1.6, repeats: false) { [weak self] _ in
      guard let self, self.isAgentReviewShown else { return }
      self.agentReviewHeaderLabel.isHidden = true
      self.agentReviewFollowUpButton.isHidden = false
    }
    if let agentReviewNoteResetTimer {
      RunLoop.main.add(agentReviewNoteResetTimer, forMode: .common)
    }
  }

  /// Shows the card on the given result, adopting its versions and (newest)
  /// active index. Seeds the local pager/session state the middle controls act on.
  private func showAgentReviewCard(_ result: AgentResult) {
    isAgentReviewShown = true
    agentReviewVersions = result.versions
    agentReviewActiveIndex = result.activeIndex
    agentReviewSessionId = result.sessionId
    // Clear any transient note left over from a prior session so the capsule (not
    // a stale header note) shows on a fresh card.
    agentReviewNoteResetTimer?.invalidate()
    agentReviewHeaderLabel.isHidden = true
    agentReviewFollowUpButton.isHidden = false
    displayActiveAgentVersion()
    refreshAgentReviewControls()
    // Reset any lingering transient state on the (now hidden) record button.
    issueResetTimer?.invalidate()
    issueResetTimer = nil
    processingCancelButton.isHidden = true

    agentReviewCanvas.isUserInteractionEnabled = true
    UIView.animate(withDuration: 0.18, delay: 0, options: .curveEaseOut, animations: {
      self.agentReviewCanvas.alpha = 1
      self.rootStack.alpha = 0
    })
  }

  /// Loads the currently-paged version into the read-only text view, scrolled to
  /// the top. Pure UI — no App Group writes.
  private func displayActiveAgentVersion() {
    guard agentReviewVersions.indices.contains(agentReviewActiveIndex) else { return }
    agentReviewTextView.text = agentReviewVersions[agentReviewActiveIndex]
    agentReviewTextView.setContentOffset(.zero, animated: false)
  }

  /// Updates the 1/N pager (hidden when a single version) and gates the
  /// regenerate/follow-up controls on app-heartbeat freshness: fresh ⇒ the button
  /// handlers run; stale ⇒ the "Open OpenWhispr" wake-link overlay takes the tap.
  private func refreshAgentReviewControls() {
    let count = agentReviewVersions.count
    let showPager = count > 1
    agentReviewPagerPrevButton.isHidden = !showPager
    agentReviewPagerNextButton.isHidden = !showPager
    agentReviewPagerLabel.isHidden = !showPager
    if showPager {
      agentReviewPagerLabel.text = "\(agentReviewActiveIndex + 1)/\(count)"
      agentReviewPagerPrevButton.isEnabled = agentReviewActiveIndex > 0
      agentReviewPagerNextButton.isEnabled = agentReviewActiveIndex < count - 1
      agentReviewPagerPrevButton.alpha = agentReviewPagerPrevButton.isEnabled ? 1.0 : 0.35
      agentReviewPagerNextButton.alpha = agentReviewPagerNextButton.isEnabled ? 1.0 : 0.35
    }

    // Regenerate/follow-up need the app alive. When its heartbeat is stale the
    // wake-link overlays each button (like the entry button's handoff link) so a
    // tap opens OpenWhispr instead of writing an action the dead app can't serve.
    let appAlive = KeyboardHandoffProvider.shared.isAppHeartbeatFresh()
    agentReviewRegenerateWakeLink?.view.isUserInteractionEnabled = !appAlive
    agentReviewFollowUpWakeLink?.view.isUserInteractionEnabled = !appAlive
  }

  /// Fades the card out. Fully dismisses (clearState: true) after insert/dismiss;
  /// a regenerate keeps the local versions/session so error or cancel can restore
  /// the card without a re-read (clearState: false).
  private func hideAgentReviewCard(clearState: Bool = true) {
    isAgentReviewShown = false
    agentReviewCanvas.isUserInteractionEnabled = false
    if clearState {
      agentReviewTextView.text = ""
      agentReviewVersions = []
      agentReviewActiveIndex = 0
      agentReviewSessionId = ""
    }
    UIView.animate(withDuration: 0.18, delay: 0, options: .curveEaseOut, animations: {
      self.agentReviewCanvas.alpha = 0
      self.rootStack.alpha = 1
    })
  }

  /// Restores the card from the retained local versions (used when a regenerate
  /// is cancelled or errors — the existing versions stay viewable/insertable).
  private func restoreAgentReviewCard() {
    guard !agentReviewVersions.isEmpty else { return }
    isAgentReviewShown = true
    displayActiveAgentVersion()
    refreshAgentReviewControls()
    processingCancelButton.isHidden = true
    agentReviewCanvas.isUserInteractionEnabled = true
    UIView.animate(withDuration: 0.18, delay: 0, options: .curveEaseOut, animations: {
      self.agentReviewCanvas.alpha = 1
      self.rootStack.alpha = 0
    })
  }

  /// ✓ insert: drop the generated text into the field (natively replacing a
  /// still-live selection), flash "Inserted", clear the result, return to idle.
  @objc private func handleAgentReviewInsertTapped() {
    let text = agentReviewTextView.text ?? ""
    playKeyClick()
    hideAgentReviewCard()
    insertSmartText(text)
    KeyboardHandoffProvider.shared.clearAgentResult()
    KeyboardHandoffProvider.shared.clearTranscriptionStatus()
    logRecordMarker("handleAgentReviewInsertTapped", extra: "chars=\(text.count)")
    showTransientRecordState(
      title: "Inserted",
      systemImage: "checkmark",
      background: Palette.accent,
      duration: 1.1
    )
  }

  /// ✕ dismiss: discard the result and return to idle without inserting.
  @objc private func handleAgentReviewDismissTapped() {
    playKeyClick()
    hideAgentReviewCard()
    KeyboardHandoffProvider.shared.clearAgentResult()
    KeyboardHandoffProvider.shared.clearTranscriptionStatus()
    logRecordMarker("handleAgentReviewDismissTapped")
    refreshRecordButton()
  }

  /// ↻ regenerate: ask the app for a fresh version of the same session. The wake
  /// link handles the app-dead case, but re-check freshness here (the button may
  /// have been tapped in the same tick the app died). Writes the action, pokes
  /// the app, and transitions to "Writing" waiting for a result newer than now.
  @objc private func handleAgentReviewRegenerateTapped() {
    guard isAgentReviewShown, !isAgentGenerating else { return }
    let provider = KeyboardHandoffProvider.shared
    guard provider.isAppHeartbeatFresh() else {
      // App went stale between the layout refresh and this tap; re-gate so the
      // wake link takes over on the next interaction.
      refreshAgentReviewControls()
      return
    }
    playKeyClick()
    let atMs = provider.writeAgentRegenerateAction(sessionId: agentReviewSessionId)
    logRecordMarker("handleAgentReviewRegenerateTapped", extra: "session=\(agentReviewSessionId)")
    enterAgentRegenerating(minUpdatedAtMs: atMs)
  }

  /// Follow-up mic: refine the last reply by voice. Writes a follow-up request
  /// (reusing the session; no context re-capture) and starts recording in place
  /// with the "Describe your changes" caption. The normal pipeline then runs
  /// (transcribe → generate) and the card returns with the updated version.
  @objc private func handleAgentReviewFollowUpTapped() {
    guard isAgentReviewShown, !isAgentGenerating, !isDarwinStartPending, !isRemoteRecordingActive else { return }
    let provider = KeyboardHandoffProvider.shared
    guard provider.isAppHeartbeatFresh() else {
      refreshAgentReviewControls()
      return
    }
    playKeyClick()
    provider.writeAgentFollowUpRequest(sessionId: agentReviewSessionId)
    logRecordMarker("handleAgentReviewFollowUpTapped", extra: "session=\(agentReviewSessionId)")
    // Keep the versions so an error/cancel during the follow-up restores the card.
    isAgentActionInFlight = true
    isAgentRecordingActive = true
    hideAgentReviewCard(clearState: false)
    agentRecordingHint = agentHint(from: Self.agentFollowUpHints)
    startAgentRecordingInPlace(caption: "Describe your changes")
  }

  @objc private func handleAgentReviewPagerPrevTapped() {
    guard agentReviewActiveIndex > 0 else { return }
    playKeyClick()
    agentReviewActiveIndex -= 1
    displayActiveAgentVersion()
    refreshAgentReviewControls()
  }

  @objc private func handleAgentReviewPagerNextTapped() {
    guard agentReviewActiveIndex < agentReviewVersions.count - 1 else { return }
    playKeyClick()
    agentReviewActiveIndex += 1
    displayActiveAgentVersion()
    refreshAgentReviewControls()
  }

  /// Whether a readable result may be adopted for the current wait. A regenerate
  /// (agentActionMinUpdatedAtMs set) requires the app to have rewritten the result
  /// at/after the action timestamp; compose/follow-up accept the first readable,
  /// non-superseded result. Gates both the poll and the Darwin agent_ready path.
  private func agentResultSatisfiesAction(_ result: AgentResult) -> Bool {
    guard let minUpdatedAtMs = agentActionMinUpdatedAtMs else { return true }
    guard let updatedAtMs = result.updatedAtMs else { return false }
    return Int64(updatedAtMs) >= minUpdatedAtMs
  }

  /// Records the in-flight generation as rejected so a late agent_ready/result
  /// the app writes after we stopped waiting (cancel or timeout) can never open a
  /// card. A regenerate is keyed by its action timestamp (the result jobId is
  /// "<atMs>-<uuid>"); a compose/follow-up by the current recording jobId.
  private func rememberRejectedAgentGeneration() {
    if let atMs = agentActionMinUpdatedAtMs {
      rejectedAgentActionAtMs.insert(atMs)
    }
    if let jobId = KeyboardHandoffProvider.shared.currentRecordingJobId(),
       !jobId.isEmpty {
      rejectedAgentJobIds.insert(jobId)
    }
  }

  /// True when the result belongs to a generation the user cancelled or that the
  /// keyboard timed out on. Consulted at every adoption point (poll, Darwin
  /// agent_ready, resume-on-reopen) so a stale result is dropped, not shown.
  private func isAgentResultRejected(_ result: AgentResult) -> Bool {
    if rejectedAgentJobIds.contains(result.jobId) { return true }
    if let dash = result.jobId.firstIndex(of: "-"),
       let atMs = Int64(result.jobId[..<dash]),
       rejectedAgentActionAtMs.contains(atMs) {
      return true
    }
    return false
  }
}

/// A validated snapshot of `keyboard_agent_result`: every generated version and
/// the app's chosen active index (for the 1/N pager), the session the reply
/// belongs to (for follow-up/regenerate actions), the recording job it belongs
/// to (for currency checks), and when the app wrote it (for the resume-on-reopen
/// freshness window and action-driven result waits).
private struct AgentResult {
  let versions: [String]
  let activeIndex: Int
  let sessionId: String
  let jobId: String
  let updatedAtMs: Double?
}

private struct KeyboardHandoffProvider {
  static let shared = KeyboardHandoffProvider()

  private static func infoString(_ key: String) -> String? {
    guard let value = Bundle.main.object(forInfoDictionaryKey: key) as? String else { return nil }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }

  private static var resolvedContainingAppBundleID: String {
    if let configured = infoString("OpenWhisprContainingAppBundleIdentifier") {
      return configured
    }
    let bundleID = Bundle.main.bundleIdentifier ?? "com.gizmolabs.openwhispr.keyboard"
    let suffix = ".keyboard"
    return bundleID.hasSuffix(suffix) ? String(bundleID.dropLast(suffix.count)) : bundleID
  }

  // Matches the app-side probe's identity exactly (nativeApplicationVersion +
  // nativeBuildVersion). A TestFlight rebuild bumps only CFBundleVersion, and
  // that alone must break equality — iOS can reset Full Access on any native
  // install, not just marketing releases.
  private static let bundleVersionIdentity: String = {
    let short = infoString("CFBundleShortVersionString") ?? "unknown"
    let build = infoString("CFBundleVersion") ?? "unknown"
    return "\(short)+\(build)"
  }()

  private var appGroupId: String {
    "group.\(Self.resolvedContainingAppBundleID)"
  }
  private let pendingTranscriptKey = "keyboard_pending_transcript"
  private let pendingTranscriptJobIdKey = "keyboard_pending_transcript_job_id"
  private let orphanedRawTranscriptKey = "keyboard_orphaned_raw_transcript"
  private let orphanedRawTranscriptJobIdKey = "keyboard_orphaned_raw_transcript_job_id"
  private let recordingJobIdKey = "keyboard_recording_job_id"
  private let recordingActiveKey = "keyboard_recording_active"
  private let audioLevelKey = "keyboard_audio_level"
  private let stopRequestedKey = "keyboard_stop_requested"
  private let stopRequestedAtMsKey = "keyboard_stop_requested_at_ms"
  private let cancelRequestedKey = "keyboard_cancel_requested"
  private let shownAtMsKey = "keyboard_shown_at_ms"
  private let shownAtVersionKey = "keyboard_shown_version"
  private let handoffIntentAtMsKey = "keyboard_handoff_intent_at_ms"
  private let backgroundSessionReadyKey = "background_session_ready"
  private let backgroundSessionWarmMicKey = "background_session_warm_mic"
  private let backgroundSessionHeartbeatKey = "background_session_heartbeat"
  private let transcriptionStatusKey = "keyboard_transcription_status"
  private let transcriptionErrorKey = "keyboard_transcription_error"
  private let transcriptionStatusUpdatedAtMsKey = "keyboard_transcription_status_updated_at_ms"
  private let dictationToneKey = "keyboard_dictation_tone"
  private let toneApplicableKey = "keyboard_tone_applicable"
  // Dictation-agent mirror keys (app-written, persist across launches) and the
  // one-shot request / result channels shared with the main app.
  private let agentEnabledKey = "keyboard_agent_enabled"
  private let agentApplicableKey = "keyboard_agent_applicable"
  private let agentShareContextKey = "keyboard_agent_share_context"
  private let agentNameKey = "keyboard_agent_name"
  private let agentRequestKey = "keyboard_agent_request"
  private let agentJobKey = "keyboard_agent_job"
  private let agentResultKey = "keyboard_agent_result"
  private let agentActionKey = "keyboard_agent_action"
  private let agentActionAtMsKey = "keyboard_agent_action_at_ms"
  private let agentHintsHiddenUntilMsKey = "keyboard_agent_hints_hidden_until_ms"
  static let toneValues = ["default", "formal", "casual", "very_casual", "excited"]
  private static var darwinStartNotificationName: String {
    "\(resolvedContainingAppBundleID).startRecording"
  }
  private static var darwinStopNotificationName: String {
    "\(resolvedContainingAppBundleID).stopRecording"
  }
  private static var darwinAgentActionNotificationName: String {
    "\(resolvedContainingAppBundleID).agentAction"
  }

  private static let bundleToScheme: [String: String] = [
    "com.whatsapp.WhatsApp": "whatsapp://send",
    "net.whatsapp.WhatsApp": "whatsapp://send",
    "net.whatsapp.WhatsAppSMB": "whatsapp-business://",
    "com.burbn.instagram": "instagram://",
    "com.atebits.Tweetie2": "twitter://",
    "com.facebook.Facebook": "fb://",
    "com.facebook.Messenger": "fb-messenger://",
    "com.tinyspeck.chatlyio": "slack://",
    "com.skype.skype": "skype://",
    "ph.telegra.Telegraph": "tg://",
    "org.whispersystems.signal": "sgnl://",
    "com.viber": "viber://",
    "jp.naver.line": "line://",
    "com.google.Gmail": "googlegmail://",
    "com.google.Docs": "googledocs://",
    "com.microsoft.Office.Outlook": "ms-outlook://",
    "com.microsoft.skype.teams": "msteams://",
    "com.apple.mobilemail": "message://",
    "com.apple.MobileSMS": "sms://",
    "com.apple.mobilenotes": "mobilenotes://",
    "com.microsoft.teams": "msteams://",
    "notion.id": "notion://",
    "com.discord.Discord": "discord://",
    "com.linkedin.LinkedIn": "linkedin://",
    "com.reddit.Reddit": "reddit://",
    "com.hammerandchisel.discord": "discord://",
    "us.zoom.videomeetings": "zoomus://",
    "com.openai.chat": "chatgpt://",
    "com.google.chrome.ios": "googlechrome://",
    "com.apple.mobilesafari": "x-web-search://",
    "com.zhiliaoapp.musically": "snssdk1128://",
    "com.snapchat.snapchat": "snapchat://",
    "com.toyopagroup.picaboo": "snapchat://",
  ]

  private static let normalizedBundleToScheme: [String: String] = {
    var normalized: [String: String] = [:]
    for (bundle, scheme) in bundleToScheme {
      normalized[bundle.lowercased()] = scheme
    }
    return normalized
  }()

  func consumePendingTranscript() -> String? {
    guard let sharedDefaults = UserDefaults(suiteName: appGroupId) else {
      KeyboardLog.storage.error("Unable to open app-group defaults for keyboard handoff.")
      KeyboardLog.echo("Unable to open app-group defaults for keyboard handoff.")
      return nil
    }

    guard let raw = sharedDefaults.string(forKey: pendingTranscriptKey) else {
      return nil
    }

    let pendingJobId = sharedDefaults.string(forKey: pendingTranscriptJobIdKey)
    let activeJobId = sharedDefaults.string(forKey: recordingJobIdKey)
    if let pendingJobId,
       let activeJobId,
       !pendingJobId.isEmpty,
       !activeJobId.isEmpty,
       pendingJobId != activeJobId,
       isPendingSuperseded(pendingJobId: pendingJobId, activeJobId: activeJobId) {
      sharedDefaults.removeObject(forKey: pendingTranscriptKey)
      sharedDefaults.removeObject(forKey: pendingTranscriptJobIdKey)
      KeyboardLog.echo("MARKER consumePendingTranscript.stale pendingJob=\(pendingJobId) activeJob=\(activeJobId)")
      return nil
    }

    sharedDefaults.removeObject(forKey: pendingTranscriptKey)
    sharedDefaults.removeObject(forKey: pendingTranscriptJobIdKey)
    sharedDefaults.removeObject(forKey: recordingJobIdKey)
    sharedDefaults.set("idle", forKey: transcriptionStatusKey)
    sharedDefaults.removeObject(forKey: transcriptionErrorKey)
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }

  func currentTone() -> String {
    guard let defaults = UserDefaults(suiteName: appGroupId),
          let raw = defaults.string(forKey: dictationToneKey),
          Self.toneValues.contains(raw) else {
      return "default"
    }
    return raw
  }

  func setTone(_ tone: String) {
    guard Self.toneValues.contains(tone),
          let defaults = UserDefaults(suiteName: appGroupId) else { return }
    defaults.set(tone, forKey: dictationToneKey)
    defaults.synchronize()
  }

  func isToneApplicable() -> Bool {
    guard let defaults = UserDefaults(suiteName: appGroupId) else { return false }
    return defaults.string(forKey: toneApplicableKey) != "0"
  }

  // MARK: Dictation agent

  /// The dictation agent is off entirely unless the app has mirrored enabled=1.
  func isAgentEnabled() -> Bool {
    UserDefaults(suiteName: appGroupId)?.string(forKey: agentEnabledKey) == "1"
  }

  /// Applicable = usable in the current mode (Cloud on). Not applicable ⇒ the
  /// entry button is dimmed and points the user at the app, mirroring tone.
  func isAgentApplicable() -> Bool {
    UserDefaults(suiteName: appGroupId)?.string(forKey: agentApplicableKey) == "1"
  }

  /// Only when the user has opted in do we share the surrounding field text.
  func agentSharesContext() -> Bool {
    UserDefaults(suiteName: appGroupId)?.string(forKey: agentShareContextKey) == "1"
  }

  /// Display name shown in the recording/review headers ("Tell {name}…").
  func agentName() -> String {
    guard let raw = UserDefaults(suiteName: appGroupId)?.string(forKey: agentNameKey) else {
      return "your agent"
    }
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? "your agent" : trimmed
  }

  /// The app hides the example instructions until this deadline while its own walkthrough says
  /// what to dictate (onboarding's voice assistant step). A deadline, so a step the app never left
  /// (killed mid-onboarding) stops hiding them on its own.
  func agentHintsHidden() -> Bool {
    guard let raw = UserDefaults(suiteName: appGroupId)?.string(forKey: agentHintsHiddenUntilMsKey),
          let untilMs = Double(raw) else { return false }
    return Date().timeIntervalSince1970 * 1000 < untilMs
  }

  /// True when the app has written its heartbeat within the last 5s (same rule
  /// used for recording-active). While the agent is generating, a stale/missing
  /// heartbeat means the app process died mid-job and no result is coming.
  func isAppHeartbeatFresh() -> Bool {
    guard let defaults = UserDefaults(suiteName: appGroupId),
          let raw = defaults.string(forKey: backgroundSessionHeartbeatKey),
          let heartbeatMs = Double(raw) else { return false }
    return Date().timeIntervalSince1970 * 1000 - heartbeatMs <= 5_000
  }

  /// Writes the one-shot compose request the app consumes at recording start.
  /// selectedText is always captured; the before/after context only when the
  /// user opted in. Mirrors keyboardAgentSync's KeyboardAgentRequest shape.
  func writeAgentComposeRequest(
    selectedText: String?,
    contextBefore: String?,
    contextAfter: String?
  ) {
    guard let defaults = UserDefaults(suiteName: appGroupId) else { return }
    var payload: [String: Any] = [
      "kind": "compose",
      "requestedAtMs": Int(Date().timeIntervalSince1970 * 1000),
    ]
    if let selectedText, !selectedText.isEmpty { payload["selectedText"] = selectedText }
    if let contextBefore, !contextBefore.isEmpty { payload["contextBefore"] = contextBefore }
    if let contextAfter, !contextAfter.isEmpty { payload["contextAfter"] = contextAfter }
    guard let data = try? JSONSerialization.data(withJSONObject: payload),
          let json = String(data: data, encoding: .utf8) else { return }
    defaults.set(json, forKey: agentRequestKey)
    defaults.synchronize()
    KeyboardLog.echo("MARKER provider.writeAgentComposeRequest chars=\(json.count)")
  }

  func clearAgentRequest() {
    guard let defaults = UserDefaults(suiteName: appGroupId) else { return }
    defaults.removeObject(forKey: agentRequestKey)
    defaults.synchronize()
  }

  /// Writes a follow-up compose request that rides the existing recording flow:
  /// the app reuses `sessionId` so the reply threads onto the same session. No
  /// selectedText/context is re-captured — the follow-up refines the last reply.
  func writeAgentFollowUpRequest(sessionId: String) {
    guard let defaults = UserDefaults(suiteName: appGroupId) else { return }
    let payload: [String: Any] = [
      "kind": "follow_up",
      "sessionId": sessionId,
      "requestedAtMs": Int(Date().timeIntervalSince1970 * 1000),
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: payload),
          let json = String(data: data, encoding: .utf8) else { return }
    defaults.set(json, forKey: agentRequestKey)
    defaults.synchronize()
    KeyboardLog.echo("MARKER provider.writeAgentFollowUpRequest session=\(sessionId)")
  }

  /// Writes the one-shot regenerate action + its epoch-ms twin, then pokes the
  /// app via the `.agentAction` Darwin notification. `requestId` uses the job-id
  /// timestamp-prefix style so the app can apply its timestamp-supersede rule;
  /// returns `atMs` so the caller can wait for a result written no earlier.
  @discardableResult
  func writeAgentRegenerateAction(sessionId: String) -> Int64 {
    let atMs = Int64(Date().timeIntervalSince1970 * 1000)
    guard let defaults = UserDefaults(suiteName: appGroupId) else { return atMs }
    let requestId = "\(atMs)-\(UUID().uuidString)"
    let payload: [String: Any] = [
      "type": "regenerate",
      "sessionId": sessionId,
      "requestId": requestId,
      "atMs": atMs,
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: payload),
          let json = String(data: data, encoding: .utf8) else { return atMs }
    defaults.set(json, forKey: agentActionKey)
    defaults.set(String(atMs), forKey: agentActionAtMsKey)
    defaults.synchronize()
    postDarwinNotification(Self.darwinAgentActionNotificationName)
    KeyboardLog.echo("MARKER provider.writeAgentRegenerateAction session=\(sessionId) requestId=\(requestId)")
    return atMs
  }

  /// True when the app has snapshotted an agent job whose id matches the current
  /// recording. Lets the keyboard recover "this recording is an agent one" after
  /// it was rebuilt mid-recording (a common jetsam case on the handoff path).
  func hasAgentJobForCurrentRecording() -> Bool {
    guard let defaults = UserDefaults(suiteName: appGroupId),
          let activeJobId = defaults.string(forKey: recordingJobIdKey),
          !activeJobId.isEmpty,
          let raw = defaults.string(forKey: agentJobKey),
          let data = raw.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let jobId = object["jobId"] as? String else {
      return false
    }
    return jobId == activeJobId
  }

  /// Reads (without clearing) the agent result. Returns nil on absence/invalid
  /// JSON, or when the result's job is superseded by a newer recording — reusing
  /// the same timestamp-prefix staleness rule as pending transcripts.
  func readAgentResult() -> AgentResult? {
    guard let defaults = UserDefaults(suiteName: appGroupId),
          let raw = defaults.string(forKey: agentResultKey),
          let data = raw.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let versions = object["versions"] as? [String],
          !versions.isEmpty,
          let jobId = object["jobId"] as? String else {
      return nil
    }
    let activeIndex = object["activeIndex"] as? Int ?? 0
    let clampedIndex = min(max(activeIndex, 0), versions.count - 1)
    let updatedAtMs = (object["updatedAtMs"] as? NSNumber)?.doubleValue
    // Session identity drives follow-up/regenerate; fall back to the job id for
    // legacy writes that predate the session field.
    let sessionId = (object["sessionId"] as? String) ?? jobId

    let activeJobId = defaults.string(forKey: recordingJobIdKey)
    if let activeJobId, !activeJobId.isEmpty, !jobId.isEmpty, activeJobId != jobId,
       isPendingSuperseded(pendingJobId: jobId, activeJobId: activeJobId) {
      KeyboardLog.echo("MARKER provider.readAgentResult.stale resultJob=\(jobId) activeJob=\(activeJobId)")
      return nil
    }

    return AgentResult(
      versions: versions,
      activeIndex: clampedIndex,
      sessionId: sessionId,
      jobId: jobId,
      updatedAtMs: updatedAtMs
    )
  }

  func clearAgentResult() {
    guard let defaults = UserDefaults(suiteName: appGroupId) else { return }
    defaults.removeObject(forKey: agentResultKey)
    defaults.synchronize()
  }

  /// Job IDs embed their creation time ("<ms>-<rand>") in every generator, so
  /// staleness is decided by age: a pending transcript is superseded only when
  /// the active job is strictly newer. A bookkeeping mismatch caused by the
  /// cross-process write race over the shared job-id key must not throw away
  /// the transcript the user is waiting on.
  private func isPendingSuperseded(pendingJobId: String, activeJobId: String) -> Bool {
    guard let pendingMs = jobCreationMs(pendingJobId),
          let activeMs = jobCreationMs(activeJobId) else {
      return true  // unparsable → keep the old strict-mismatch behaviour
    }
    return activeMs > pendingMs
  }

  private func jobCreationMs(_ jobId: String) -> Double? {
    guard let prefix = jobId.split(separator: "-").first else { return nil }
    return Double(prefix)
  }

  /// Stamps the App Group with the moment the keyboard came on screen so the
  /// main app can detect a successful keyboard switch during onboarding.
  func markShown() {
    guard let defaults = UserDefaults(suiteName: appGroupId) else { return }
    defaults.set(String(Int(Date().timeIntervalSince1970 * 1000)), forKey: shownAtMsKey)
    defaults.set(Self.bundleVersionIdentity, forKey: shownAtVersionKey)
    defaults.synchronize()
  }

  func isRecordingActive() -> Bool {
    guard let defaults = UserDefaults(suiteName: appGroupId) else { return false }
    guard defaults.string(forKey: recordingActiveKey) == "1" else { return false }

    // The host app writes a heartbeat every 1s while alive. If it's missing
    // or stale (>5s), the flag is a leftover from a crashed or killed session;
    // clear it so the keyboard doesn't get stuck showing the recording canvas.
    if let rawHeartbeat = defaults.string(forKey: backgroundSessionHeartbeatKey),
       let heartbeatMs = Double(rawHeartbeat) {
      let ageMs = Date().timeIntervalSince1970 * 1000 - heartbeatMs
      if ageMs <= 5_000 {
        return true
      }
      KeyboardLog.echo("MARKER isRecordingActive.staleHeartbeat clearing ageMs=\(Int(ageMs))")
    } else {
      KeyboardLog.echo("MARKER isRecordingActive.noHeartbeat clearing")
    }
    defaults.set("0", forKey: recordingActiveKey)
    defaults.synchronize()
    return false
  }

  func forceClearActiveFlag() {
    guard let defaults = UserDefaults(suiteName: appGroupId) else { return }
    defaults.set("0", forKey: recordingActiveKey)
  }

  func clearBackgroundSessionReady() {
    guard let defaults = UserDefaults(suiteName: appGroupId) else { return }
    defaults.set("0", forKey: backgroundSessionReadyKey)
    defaults.synchronize()
  }

  func currentAudioLevel() -> Float {
    guard let defaults = UserDefaults(suiteName: appGroupId),
          let raw = defaults.string(forKey: audioLevelKey),
          let value = Float(raw) else { return 0 }
    return min(max(value, 0), 1)
  }

  func requestStop() {
    guard let defaults = UserDefaults(suiteName: appGroupId) else { return }
    defaults.set("1", forKey: stopRequestedKey)
    defaults.set(String(Int(Date().timeIntervalSince1970 * 1000)), forKey: stopRequestedAtMsKey)
    defaults.set("transcribing", forKey: transcriptionStatusKey)
    defaults.set(
      String(Int(Date().timeIntervalSince1970 * 1000)),
      forKey: transcriptionStatusUpdatedAtMsKey
    )
    postDarwinNotification(Self.darwinStopNotificationName)
    let state = recordingStateSnapshot()
    KeyboardLog.echo(
      "MARKER provider.requestStop sharedActive=\(state.active) sharedReady=\(state.ready) sharedWarm=\(state.warmMic) stopReq=\(state.stopRequested)"
    )
  }

  func requestCancel() {
    guard let defaults = UserDefaults(suiteName: appGroupId) else { return }
    defaults.set("1", forKey: cancelRequestedKey)
    requestStop()
    KeyboardLog.echo("MARKER provider.requestCancel")
  }

  func currentRecordingJobId() -> String? {
    UserDefaults(suiteName: appGroupId)?.string(forKey: recordingJobIdKey)
  }

  /// Cancel during the transcription phase (recording already stopped). Raises
  /// the cancel flag the app polls at its checkpoints and clears any transcript
  /// already written for this job, leaving the status idle.
  func cancelProcessingJob() {
    guard let defaults = UserDefaults(suiteName: appGroupId) else { return }
    defaults.set("1", forKey: cancelRequestedKey)
    defaults.removeObject(forKey: pendingTranscriptKey)
    defaults.removeObject(forKey: pendingTranscriptJobIdKey)
    defaults.removeObject(forKey: orphanedRawTranscriptKey)
    defaults.removeObject(forKey: orphanedRawTranscriptJobIdKey)
    defaults.set("idle", forKey: transcriptionStatusKey)
    defaults.removeObject(forKey: transcriptionErrorKey)
    defaults.synchronize()
    KeyboardLog.echo("MARKER provider.cancelProcessingJob")
  }

  /// Drops a pending transcript that belongs to a cancelled job. Returns true
  /// when it discarded one, so the caller knows not to insert anything.
  func discardPendingTranscriptIfMatches(jobId: String) -> Bool {
    guard let defaults = UserDefaults(suiteName: appGroupId),
          defaults.string(forKey: pendingTranscriptKey) != nil,
          defaults.string(forKey: pendingTranscriptJobIdKey) == jobId else { return false }
    defaults.removeObject(forKey: pendingTranscriptKey)
    defaults.removeObject(forKey: pendingTranscriptJobIdKey)
    defaults.set("idle", forKey: transcriptionStatusKey)
    defaults.removeObject(forKey: transcriptionErrorKey)
    KeyboardLog.echo("MARKER provider.discardPendingTranscriptIfMatches job=\(jobId)")
    return true
  }

  /// The bundle identifier of the app that contains this keyboard extension
  /// (the extension's own bundle id minus the ".keyboard" suffix).
  private var containingAppBundleID: String {
    Self.resolvedContainingAppBundleID
  }

  /// True when `bundle` is OpenWhispr itself (or one of its extensions), meaning
  /// the keyboard is running inside the app and a tap records in place rather
  /// than handing off. Mirrors the JS `isSelfHosted` check in useKeyboardHandoff.
  func isContainingAppBundle(_ bundle: String) -> Bool {
    let host = bundle.lowercased()
    let appBundle = containingAppBundleID.lowercased()
    guard !appBundle.isEmpty else { return false }
    return host == appBundle || host.hasPrefix(appBundle + ".")
  }

  func detectHostBundleID(from controller: UIInputViewController) -> String? {
    if let bundleId = controller.parent?.value(forKey: "_hostBundleID") as? String,
       bundleId != "<null>", !bundleId.isEmpty {
      KeyboardLog.echo("Host detected via KVC: \(bundleId)")
      return bundleId
    }
    KeyboardLog.echo("KVC host detection failed, parent=\(controller.parent != nil ? "present" : "nil")")

    guard let pid = controller.parent?.value(forKey: "_hostPID") else {
      KeyboardLog.echo("XPC host detection failed: no _hostPID")
      return nil
    }
    let selector = NSSelectorFromString("defaultService")
    guard let anyClass: AnyObject = NSClassFromString("PKService"),
          let pkService = anyClass as? NSObjectProtocol,
          pkService.responds(to: selector),
          let serverInis = pkService.perform(selector)?.takeUnretainedValue() as? NSObjectProtocol
    else { return nil }
    let personalities = serverInis.perform(NSSelectorFromString("personalities"))?.takeUnretainedValue()
    let bundleId = Bundle.main.bundleIdentifier ?? ""
    guard let dict = personalities as? NSDictionary,
          let infos = dict[bundleId] as? NSDictionary,
          let info = infos[pid] as? AnyObject,
          let con = info.perform(NSSelectorFromString("connection"))?.takeUnretainedValue() as? NSObjectProtocol
    else { return nil }
    let xpcCon = con.perform(NSSelectorFromString("_xpcConnection"))?.takeUnretainedValue()
    guard let xpcCon = xpcCon else { return nil }
    guard let handle = dlopen("/usr/lib/libc.dylib", RTLD_NOW) else { return nil }
    defer { dlclose(handle) }
    guard let sym = dlsym(handle, "xpc_connection_copy_bundle_id") else { return nil }
    typealias XPCFunc = @convention(c) (AnyObject) -> UnsafePointer<CChar>?
    let cFunc = unsafeBitCast(sym, to: XPCFunc.self)
    guard let response = cFunc(xpcCon) else { return nil }
    return String(cString: response)
  }

  func hostUrlScheme(from controller: UIInputViewController) -> String? {
    guard let bundleId = detectHostBundleID(from: controller) else { return nil }
    return Self.bundleToScheme[bundleId] ?? Self.normalizedBundleToScheme[bundleId.lowercased()]
  }

  func storeHostReturnInfo(from controller: UIInputViewController) {
    guard let defaults = UserDefaults(suiteName: appGroupId) else { return }
    if let scheme = hostUrlScheme(from: controller) {
      defaults.set(scheme, forKey: "keyboard_return_url")
      KeyboardLog.echo("Stored return URL: \(scheme)")
    } else {
      KeyboardLog.echo("No return URL scheme found for host")
    }
    if let bundle = detectHostBundleID(from: controller) {
      defaults.set(bundle, forKey: "keyboard_return_bundle")
    }
    defaults.synchronize()
  }

  func isBackgroundSessionReady() -> Bool {
    guard let defaults = UserDefaults(suiteName: appGroupId) else { return false }
    guard defaults.string(forKey: backgroundSessionReadyKey) == "1" else { return false }

    guard let rawHeartbeat = defaults.string(forKey: backgroundSessionHeartbeatKey),
          let heartbeatMs = Double(rawHeartbeat) else {
      KeyboardLog.echo("MARKER provider.backgroundReady.noHeartbeat appAssumedDead")
      return false
    }

    let ageMs = Date().timeIntervalSince1970 * 1000 - heartbeatMs
    if ageMs <= 5_000 {
      return true
    }
    KeyboardLog.echo("MARKER provider.backgroundReady.heartbeatStale ageMs=\(Int(ageMs))")
    return false
  }

  /// True when the containing app (OpenWhispr) is itself in the foreground, so
  /// the keyboard is running inside our own app and a tap should record in place
  /// rather than hand off. The app refreshes this timestamp every couple seconds
  /// while foreground and clears it on background; a stale value (app killed)
  /// fails the freshness check, so another host app never reads a false positive.
  /// Private-API host bundle-id detection is unreliable, so this is the signal.
  func isContainingAppForeground() -> Bool {
    guard let defaults = UserDefaults(suiteName: appGroupId) else { return false }
    guard let raw = defaults.string(forKey: "containing_app_foreground_at_ms"),
          let atMs = Double(raw) else { return false }
    let ageMs = Date().timeIntervalSince1970 * 1000 - atMs
    return ageMs <= 5_000
  }

  func requestStart() {
    if let defaults = UserDefaults(suiteName: appGroupId) {
      let jobId = "\(Int(Date().timeIntervalSince1970 * 1000))-\(UUID().uuidString)"
      defaults.set("0", forKey: stopRequestedKey)
      defaults.removeObject(forKey: stopRequestedAtMsKey)
      defaults.set("0", forKey: recordingActiveKey)
      defaults.removeObject(forKey: audioLevelKey)
      defaults.removeObject(forKey: pendingTranscriptKey)
      defaults.removeObject(forKey: pendingTranscriptJobIdKey)
      defaults.removeObject(forKey: orphanedRawTranscriptKey)
      defaults.removeObject(forKey: orphanedRawTranscriptJobIdKey)
      defaults.set(jobId, forKey: recordingJobIdKey)
      defaults.set("recording", forKey: transcriptionStatusKey)
      defaults.set(
        String(Int(Date().timeIntervalSince1970 * 1000)),
        forKey: transcriptionStatusUpdatedAtMsKey
      )
      defaults.removeObject(forKey: transcriptionErrorKey)
      // Flush before the Darwin post: the app's start handler records under
      // whatever job id it reads, and a stale snapshot here is how recordings
      // end up keyed to the previous session's id (see resolveRecordingJobId's
      // echo-write for the other half of this handshake).
      defaults.synchronize()
      let state = recordingStateSnapshot()
      KeyboardLog.echo(
        "MARKER provider.requestStart.reset jobId=\(jobId) sharedActive=\(state.active) sharedReady=\(state.ready) sharedWarm=\(state.warmMic) stopReq=\(state.stopRequested)"
      )
    }

    postDarwinNotification(Self.darwinStartNotificationName)
    let state = recordingStateSnapshot()
    KeyboardLog.echo(
      "MARKER provider.requestStart.posted sharedActive=\(state.active) sharedReady=\(state.ready) sharedWarm=\(state.warmMic) stopReq=\(state.stopRequested)"
    )
  }

  func recordingStateSnapshot() -> (active: String, ready: String, stopRequested: String, warmMic: String) {
    guard let defaults = UserDefaults(suiteName: appGroupId) else {
      return ("?", "?", "?", "?")
    }
    return (
      defaults.string(forKey: recordingActiveKey) ?? "-",
      defaults.string(forKey: backgroundSessionReadyKey) ?? "-",
      defaults.string(forKey: stopRequestedKey) ?? "-",
      defaults.string(forKey: backgroundSessionWarmMicKey) ?? "-"
    )
  }

  func transcriptionStatus() -> String? {
    guard let defaults = UserDefaults(suiteName: appGroupId) else { return nil }
    return defaults.string(forKey: transcriptionStatusKey)
  }

  /// The error detail riding alongside an error status: `usage_limit`,
  /// `session_expired`, or a free-form message.
  func transcriptionError() -> String? {
    UserDefaults(suiteName: appGroupId)?.string(forKey: transcriptionErrorKey)
  }

  /// Milliseconds since the shared transcription status last changed, or nil
  /// when no writer has stamped it (e.g. right after the app reset state).
  func transcriptionStatusAgeMs() -> Int? {
    guard let defaults = UserDefaults(suiteName: appGroupId),
          let raw = defaults.string(forKey: transcriptionStatusUpdatedAtMsKey),
          let updatedAtMs = Double(raw) else { return nil }
    return Int(Date().timeIntervalSince1970 * 1000 - updatedAtMs)
  }

  func clearTranscriptionStatus() {
    guard let defaults = UserDefaults(suiteName: appGroupId) else { return }
    defaults.set("idle", forKey: transcriptionStatusKey)
    defaults.removeObject(forKey: transcriptionErrorKey)
  }

  /// Stamped on every Activate tap so the main app can recover the handoff if
  /// the deep link itself never arrives (cold-launch getInitialURL race).
  func markHandoffIntent() {
    guard let defaults = UserDefaults(suiteName: appGroupId) else { return }
    defaults.set(String(Int(Date().timeIntervalSince1970 * 1000)), forKey: handoffIntentAtMsKey)
    defaults.synchronize()
    KeyboardLog.echo("MARKER provider.markHandoffIntent")
  }

  private func postDarwinNotification(_ name: String) {
    let center = CFNotificationCenterGetDarwinNotifyCenter()
    CFNotificationCenterPostNotification(
      center,
      CFNotificationName(name as CFString),
      nil,
      nil,
      true
    )
  }
}

extension KeyboardViewController: UIInputViewAudioFeedback {
  var enableInputClicksWhenVisible: Bool { true }
}
