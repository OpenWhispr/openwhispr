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

private final class KeyButton: UIButton {
  var hitTestOutsets = UIEdgeInsets(top: 6, left: 3, bottom: 6, right: 3)

  var normalBackground: UIColor = .clear {
    didSet { if !isHighlighted { backgroundColor = normalBackground } }
  }

  // Same luminous-rim treatment as PillBackgroundView: a white top-lit gradient
  // masked to the border stroke, so the key reads as glass-edged. Opt-in —
  // regular keys stay layer-free.
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
    guard let rim = glassRimLayer, let mask = rim.mask as? CAShapeLayer else { return }
    rim.frame = bounds
    mask.frame = bounds
    let inset = Self.glassRimWidth / 2
    mask.path = UIBezierPath(
      roundedRect: bounds.insetBy(dx: inset, dy: inset),
      cornerRadius: max(0, layer.cornerRadius - inset)
    ).cgPath
  }

  override var isHighlighted: Bool {
    didSet {
      guard isHighlighted else {
        backgroundColor = normalBackground
        return
      }
      // Resolve the (possibly dynamic) colour for the current appearance, then
      // nudge it for press feedback: lighter on dark keys, darker on light keys.
      let resolved = normalBackground.resolvedColor(with: traitCollection)
      let delta: CGFloat = traitCollection.userInterfaceStyle == .dark ? 0.12 : -0.10
      backgroundColor = resolved.brightened(by: delta)
    }
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

private extension UIColor {
  func brightened(by amount: CGFloat) -> UIColor {
    var h: CGFloat = 0, s: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
    getHue(&h, saturation: &s, brightness: &b, alpha: &a)
    return UIColor(hue: h, saturation: s, brightness: max(0, min(b + amount, 1.0)), alpha: a)
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
  }

  private enum KeyRole {
    case character
    case utility
    case space
  }

  private enum Palette {
    /// A colour that resolves differently for light vs dark appearance.
    private static func dynamic(light: UIColor, dark: UIColor) -> UIColor {
      UIColor { traits in traits.userInterfaceStyle == .dark ? dark : light }
    }

    // Keys adapt to the native keyboard per appearance: white letter keys and
    // grey special keys on a light backdrop, dark greys on dark. The root view
    // is transparent, so the backdrop itself is supplied by the system.
    static let keyBackground = dynamic(
      light: UIColor(red: 1.00, green: 1.00, blue: 1.00, alpha: 1.0),
      dark: UIColor(red: 0.34, green: 0.35, blue: 0.37, alpha: 1.0)
    )
    static let utilityKeyBackground = dynamic(
      light: UIColor(red: 0.68, green: 0.70, blue: 0.74, alpha: 1.0),
      dark: UIColor(red: 0.39, green: 0.40, blue: 0.43, alpha: 1.0)
    )
    static let keyText = dynamic(
      light: UIColor(red: 0.00, green: 0.00, blue: 0.00, alpha: 1.0),
      dark: UIColor(red: 0.96, green: 0.96, blue: 0.97, alpha: 1.0)
    )

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
    static let dictationButtonSize: CGFloat = 40
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
    let keyboardHeightPortrait: CGFloat
    let keyboardHeightLandscape: CGFloat
    let rootHorizontalPadding: CGFloat
    let rootTopPadding: CGFloat
    let rootBottomPadding: CGFloat
    let rootSectionSpacing: CGFloat
    let dictationStripHeight: CGFloat
    let keyboardRowSpacing: CGFloat
    let rowHeight: CGFloat
    let keySpacing: CGFloat
    let keyCornerRadius: CGFloat

    static let compact = KeyboardMetrics(
      keyboardHeightPortrait: 222, keyboardHeightLandscape: 168,
      rootHorizontalPadding: 3, rootTopPadding: 5, rootBottomPadding: 5,
      rootSectionSpacing: 8, dictationStripHeight: 46,
      keyboardRowSpacing: 9, rowHeight: 38,
      keySpacing: 5, keyCornerRadius: 5
    )

    static let regular = KeyboardMetrics(
      keyboardHeightPortrait: 299, keyboardHeightLandscape: 224,
      rootHorizontalPadding: 3, rootTopPadding: 6, rootBottomPadding: 6,
      rootSectionSpacing: 10, dictationStripHeight: 52,
      keyboardRowSpacing: 11, rowHeight: 42,
      keySpacing: 6, keyCornerRadius: 5
    )

    static let large = KeyboardMetrics(
      keyboardHeightPortrait: 309, keyboardHeightLandscape: 236,
      rootHorizontalPadding: 4, rootTopPadding: 7, rootBottomPadding: 7,
      rootSectionSpacing: 11, dictationStripHeight: 54,
      keyboardRowSpacing: 12, rowHeight: 44,
      keySpacing: 6, keyCornerRadius: 6
    )

    static func current(forWidth width: CGFloat) -> KeyboardMetrics {
      switch KeyboardSize.detect(width: width) {
      case .compact: return .compact
      case .regular: return .regular
      case .large: return .large
      }
    }
  }

  private var metrics: KeyboardMetrics = .current(forWidth: UIScreen.main.bounds.width)

  private let rootStack = UIStackView()
  private let dictationStrip = UIView()
  private let recordButton = UIButton(type: .system)
  private let recordButtonBackground = PillBackgroundView()
  private let processingDots = ProcessingDotsView()
  // Sits beside the processing pill ("Transcribing"/"Cleaning up") to abandon
  // the in-flight transcription. Hidden in every other state.
  private let processingCancelButton = UIButton(type: .system)
  private let toneButton = KeyButton(type: .system)
  private let keyboardRowsStack = UIStackView()
  private let lettersRowsStack = UIStackView()
  private let numbersRowsStack = UIStackView()

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
  private var returnButton: KeyButton?
  private var fieldShortcutButtons: [KeyButton] = []
  private var fieldShortcutWidthConstraints: [NSLayoutConstraint] = []
  // Leading gap before each field shortcut. Collapses to 0 when the shortcut is
  // hidden so space and return keep a single keySpacing gap, matching every other key.
  private var fieldShortcutGapConstraints: [NSLayoutConstraint] = []
  private var dictationLinkHosting: UIHostingController<DictationLinkView>?
  // Detected once at setup (the host is fixed for the extension's lifetime).
  // Avoids calling the heavy private-API host detection on every button refresh.
  private var hostIsOwnApp = false
  private var didRequestCancelForCurrentSession = false

  private var layoutMode: KeyboardLayoutMode = .letters
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
  private var rootLeadingConstraint: NSLayoutConstraint?
  private var rootTrailingConstraint: NSLayoutConstraint?
  private var rootTopConstraint: NSLayoutConstraint?
  private var rootBottomConstraint: NSLayoutConstraint?
  private var dictationStripHeightConstraint: NSLayoutConstraint?
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

  override func viewDidLoad() {
    super.viewDidLoad()
    KeyboardLog.ui.info("Keyboard loaded. hasFullAccess=\(self.hasFullAccess, privacy: .public)")
    KeyboardLog.echo("Keyboard loaded. hasFullAccess=\(self.hasFullAccess)")
    metrics = KeyboardMetrics.current(forWidth: view.bounds.width)
    setupLayout()
    refreshRecordButton()
    buildKeyboardIfNeeded()
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    refreshMetricsIfNeeded()
    applyKeyboardHeight()
  }

  private func applyKeyboardHeight() {
    let keyboardHeight = traitCollection.verticalSizeClass == .compact
      ? metrics.keyboardHeightLandscape
      : metrics.keyboardHeightPortrait

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

  @objc private func handleCharacterKeyTapped(_ sender: UIButton) {
    guard let title = sender.title(for: .normal), !title.isEmpty else { return }
    playKeyClick()

    let insertion: String
    if layoutMode == .letters {
      let baseCharacter = title.lowercased()
      insertion = isShiftEnabled ? baseCharacter.uppercased() : baseCharacter
    } else {
      insertion = title
    }

    let smartInsertion = smartQuoteSubstitution(for: insertion) ?? insertion
    textDocumentProxy.insertText(smartInsertion)

    if layoutMode == .letters && isShiftEnabled && !isCapsLocked {
      isShiftEnabled = false
      refreshShiftState()
    }
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
  }

  @objc private func handleBackspaceLongPress(_ gesture: UILongPressGestureRecognizer) {
    switch gesture.state {
    case .began:
      startDeleteRepeating()
    case .ended, .cancelled, .failed:
      stopDeleteRepeating()
    default:
      break
    }
  }

  @objc private func handleLayoutModeSwitchTapped() {
    playKeyClick()
    layoutMode = layoutMode == .letters ? .numbers : .letters
    isCapsLocked = false
    isShiftEnabled = layoutMode == .letters ? shouldAutoCapitalize() : false
    refreshVisibleKeyboardMode()
    refreshShiftState()
  }

  @objc private func handleSpaceTapped() {
    playKeyClick()
    if !applyDoubleSpacePeriod() {
      textDocumentProxy.insertText(" ")
    }
    syncShiftWithContextIfNeeded()
  }

  @objc private func handleShortcutTapped(_ sender: UIButton) {
    guard let title = sender.title(for: .normal), !title.isEmpty else { return }
    playKeyClick()
    textDocumentProxy.insertText(title)
    syncShiftWithContextIfNeeded()
  }

  @objc private func handleNextKeyboardTapped() {
    playKeyClick()
    advanceToNextInputMode()
  }

  @objc private func handleInputModeListButton(_ sender: UIButton, forEvent event: UIEvent) {
    handleInputModeList(from: sender, with: event)
  }

  private func applyDoubleSpacePeriod() -> Bool {
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
  }

  private func setupLayout() {
    // Transparent so the system keyboard backdrop shows through, letting the
    // keyboard blend seamlessly with the system chrome above and below (the
    // candidate area and the globe/dictation safe-area bar) instead of sitting
    // on a mismatched grey panel. Keys keep their own backgrounds.
    view.backgroundColor = .clear

    rootStack.axis = .vertical
    rootStack.spacing = metrics.rootSectionSpacing
    rootStack.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(rootStack)

    rootLeadingConstraint = rootStack.leadingAnchor.constraint(
      equalTo: view.leadingAnchor,
      constant: metrics.rootHorizontalPadding
    )
    rootTrailingConstraint = rootStack.trailingAnchor.constraint(
      equalTo: view.trailingAnchor,
      constant: -metrics.rootHorizontalPadding
    )
    rootTopConstraint = rootStack.topAnchor.constraint(
      equalTo: view.topAnchor,
      constant: metrics.rootTopPadding
    )
    rootBottomConstraint = rootStack.bottomAnchor.constraint(
      equalTo: view.bottomAnchor,
      constant: -metrics.rootBottomPadding
    )

    NSLayoutConstraint.activate([
      rootLeadingConstraint,
      rootTrailingConstraint,
      rootTopConstraint,
      rootBottomConstraint,
    ].compactMap { $0 })

    setupDictationStrip()
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

      // Centered slightly high so the 168pt landscape-compact height still
      // clears the ✕ above and the globe below.
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
        agentRecordingHint = Self.agentComposeHints.randomElement()
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

  private func setupDictationStrip() {
    dictationStrip.translatesAutoresizingMaskIntoConstraints = false

    // The pill background sits behind the button; the button itself is
    // transparent so its icon and label render on top. Corner radius is half the
    // height, giving a full pill in every state.
    recordButtonBackground.translatesAutoresizingMaskIntoConstraints = false
    recordButtonBackground.layer.cornerRadius = Metrics.dictationButtonSize / 2
    dictationStrip.addSubview(recordButtonBackground)

    recordButton.translatesAutoresizingMaskIntoConstraints = false
    dictationStrip.addSubview(recordButton)

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

    // Animated dots overlaid where the leading icon sits (leading inset 16),
    // shown only in the "Processing"/"Starting"/"Stopping" states.
    processingDots.translatesAutoresizingMaskIntoConstraints = false
    processingDots.isHidden = true
    recordButton.addSubview(processingDots)
    NSLayoutConstraint.activate([
      processingDots.leadingAnchor.constraint(equalTo: recordButton.leadingAnchor, constant: 16),
      processingDots.centerYAnchor.constraint(equalTo: recordButton.centerYAnchor),
      processingDots.widthAnchor.constraint(equalToConstant: ProcessingDotsView.preferredSize.width),
      processingDots.heightAnchor.constraint(equalToConstant: ProcessingDotsView.preferredSize.height),
    ])

    // X to cancel an in-flight transcription, pinned just past the pill's
    // trailing edge; shown only in the "Transcribing"/"Cleaning up" states
    // (see showLongRunningRecordState).
    let processingCancelSize: CGFloat = 30
    configureIconButton(
      processingCancelButton,
      systemImage: "xmark",
      accessibilityLabel: "Cancel transcription",
      action: #selector(handleProcessingCancelTapped),
      size: processingCancelSize,
      symbolPointSize: 13
    )
    processingCancelButton.isHidden = true
    dictationStrip.addSubview(processingCancelButton)
    NSLayoutConstraint.activate([
      processingCancelButton.leadingAnchor.constraint(equalTo: recordButton.trailingAnchor, constant: 8),
      processingCancelButton.centerYAnchor.constraint(equalTo: recordButton.centerYAnchor),
      processingCancelButton.widthAnchor.constraint(equalToConstant: processingCancelSize),
      processingCancelButton.heightAnchor.constraint(equalToConstant: processingCancelSize),
    ])

    let toneButtonSize: CGFloat = 36
    toneButton.translatesAutoresizingMaskIntoConstraints = false
    toneButton.tintColor = .label
    toneButton.normalBackground = UIColor.secondarySystemBackground
    toneButton.layer.cornerRadius = toneButtonSize / 2
    toneButton.showsGlassRim = true
    // gauge.with.dots.needle.bottom.50percent is iOS 16+; fall back to the classic
    // gauge on the extension's 15.1 deployment target.
    toneButton.setImage(
      UIImage(systemName: "gauge.with.dots.needle.bottom.50percent") ?? UIImage(systemName: "gauge"),
      for: .normal
    )
    toneButton.setPreferredSymbolConfiguration(
      UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold),
      forImageIn: .normal
    )
    toneButton.accessibilityLabel = "Dictation tone"
    toneButton.showsMenuAsPrimaryAction = true
    dictationStrip.addSubview(toneButton)
    NSLayoutConstraint.activate([
      toneButton.leadingAnchor.constraint(equalTo: dictationStrip.leadingAnchor, constant: 8),
      toneButton.centerYAnchor.constraint(equalTo: dictationStrip.centerYAnchor),
      toneButton.widthAnchor.constraint(equalToConstant: toneButtonSize),
      toneButton.heightAnchor.constraint(equalToConstant: toneButtonSize),
    ])
    refreshToneButton()

    // Agent entry button, mirroring the tone button on the trailing edge. A press
    // gesture (not a tap target) so it can write the request before the Link
    // overlay fires the handoff — the same coordination the record button uses.
    let agentButtonSize: CGFloat = 36
    agentButton.translatesAutoresizingMaskIntoConstraints = false
    agentButton.tintColor = .label
    agentButton.normalBackground = UIColor.secondarySystemBackground
    agentButton.layer.cornerRadius = agentButtonSize / 2
    agentButton.showsGlassRim = true
    agentButton.setImage(UIImage(systemName: "wand.and.stars"), for: .normal)
    agentButton.setPreferredSymbolConfiguration(
      UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold),
      forImageIn: .normal
    )
    agentButton.accessibilityLabel = "Ask the dictation agent"
    let agentPress = UILongPressGestureRecognizer(
      target: self,
      action: #selector(handleAgentButtonPress(_:))
    )
    agentPress.minimumPressDuration = 0
    agentPress.cancelsTouchesInView = false
    agentPress.delaysTouchesBegan = false
    agentPress.delegate = self
    agentButton.addGestureRecognizer(agentPress)
    dictationStrip.addSubview(agentButton)
    NSLayoutConstraint.activate([
      agentButton.trailingAnchor.constraint(equalTo: dictationStrip.trailingAnchor, constant: -8),
      agentButton.centerYAnchor.constraint(equalTo: dictationStrip.centerYAnchor),
      agentButton.widthAnchor.constraint(equalToConstant: agentButtonSize),
      agentButton.heightAnchor.constraint(equalToConstant: agentButtonSize),
    ])
    setupAgentLink()
    refreshAgentButton()

    // The button is centered in the strip and sizes itself to its content,
    // capped so a long label can't overflow the strip.
    NSLayoutConstraint.activate([
      {
        let constraint = dictationStrip.heightAnchor.constraint(
          equalToConstant: metrics.dictationStripHeight
        )
        dictationStripHeightConstraint = constraint
        return constraint
      }(),
      recordButton.centerXAnchor.constraint(equalTo: dictationStrip.centerXAnchor),
      recordButton.centerYAnchor.constraint(equalTo: dictationStrip.centerYAnchor),
      recordButton.heightAnchor.constraint(equalToConstant: Metrics.dictationButtonSize),
      recordButton.widthAnchor.constraint(lessThanOrEqualTo: dictationStrip.widthAnchor, constant: -16),

      // Background tracks the button's frame exactly.
      recordButtonBackground.leadingAnchor.constraint(equalTo: recordButton.leadingAnchor),
      recordButtonBackground.trailingAnchor.constraint(equalTo: recordButton.trailingAnchor),
      recordButtonBackground.topAnchor.constraint(equalTo: recordButton.topAnchor),
      recordButtonBackground.bottomAnchor.constraint(equalTo: recordButton.bottomAnchor),
    ])

    setupDictationLink()

    rootStack.addArrangedSubview(dictationStrip)
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
    let menuTitle = applicable ? "Dictation Tone" : "Turn on Cloud to use tones"
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
    keyboardRowsStack.spacing = metrics.keyboardRowSpacing
    keyboardRowsStack.translatesAutoresizingMaskIntoConstraints = false
    rootStack.addArrangedSubview(keyboardRowsStack)

    [lettersRowsStack, numbersRowsStack].forEach { stack in
      stack.axis = .vertical
      stack.spacing = metrics.keyboardRowSpacing
      stack.translatesAutoresizingMaskIntoConstraints = false
    }
  }

  private func buildKeyboardIfNeeded() {
    guard !didBuildKeyboard else {
      refreshVisibleKeyboardMode()
      return
    }
    didBuildKeyboard = true
    rebuildKeyboard()
  }

  private func rebuildKeyboard() {
    keyboardRowsStack.arrangedSubviews.forEach { view in
      keyboardRowsStack.removeArrangedSubview(view)
      view.removeFromSuperview()
    }

    characterButtons.removeAll()
    fieldShortcutButtons.removeAll()
    fieldShortcutWidthConstraints.removeAll(keepingCapacity: true)
    fieldShortcutGapConstraints.removeAll(keepingCapacity: true)
    shiftButton = nil
    modeButton = nil
    returnButton = nil
    rowHeightConstraints.removeAll(keepingCapacity: true)

    lettersRowsStack.arrangedSubviews.forEach { view in
      lettersRowsStack.removeArrangedSubview(view)
      view.removeFromSuperview()
    }
    numbersRowsStack.arrangedSubviews.forEach { view in
      numbersRowsStack.removeArrangedSubview(view)
      view.removeFromSuperview()
    }

    lettersRowsStack.addArrangedSubview(
      makeCharacterRow(["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"], registersLetters: true)
    )
    lettersRowsStack.addArrangedSubview(
      makeCharacterRow(["a", "s", "d", "f", "g", "h", "j", "k", "l"], inset: 18, registersLetters: true)
    )
    lettersRowsStack.addArrangedSubview(makeLettersThirdRow())

    numbersRowsStack.addArrangedSubview(
      makeCharacterRow(["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"])
    )
    numbersRowsStack.addArrangedSubview(
      makeCharacterRow(["-", "/", ":", ";", "(", ")", "$", "&", "@", "\""])
    )
    numbersRowsStack.addArrangedSubview(makeNumbersThirdRow())

    keyboardRowsStack.addArrangedSubview(lettersRowsStack)
    keyboardRowsStack.addArrangedSubview(numbersRowsStack)
    keyboardRowsStack.addArrangedSubview(makeMainBottomRow())
    refreshVisibleKeyboardMode()
    refreshFieldAwareKeys()
    refreshShiftState()
  }

  private func constrainRowHeight(_ row: UIView) {
    let constraint = row.heightAnchor.constraint(equalToConstant: metrics.rowHeight)
    constraint.isActive = true
    rowHeightConstraints.append(constraint)
  }

  private func refreshMetricsIfNeeded() {
    let width = view.bounds.width
    guard width.isFinite, width > 0, abs(width - lastMetricsWidth) > 1 else { return }
    lastMetricsWidth = width

    let nextMetrics = KeyboardMetrics.current(forWidth: width)
    guard nextMetrics != metrics else { return }
    metrics = nextMetrics

    rootLeadingConstraint?.constant = metrics.rootHorizontalPadding
    rootTrailingConstraint?.constant = -metrics.rootHorizontalPadding
    rootTopConstraint?.constant = metrics.rootTopPadding
    rootBottomConstraint?.constant = -metrics.rootBottomPadding
    rootStack.spacing = metrics.rootSectionSpacing
    keyboardRowsStack.spacing = metrics.keyboardRowSpacing
    lettersRowsStack.spacing = metrics.keyboardRowSpacing
    numbersRowsStack.spacing = metrics.keyboardRowSpacing
    dictationStripHeightConstraint?.constant = metrics.dictationStripHeight

    if didBuildKeyboard {
      rebuildKeyboard()
    }
  }

  private func refreshVisibleKeyboardMode() {
    lettersRowsStack.isHidden = layoutMode != .letters
    numbersRowsStack.isHidden = layoutMode != .numbers
    modeButton?.setTitle(layoutMode == .letters ? "123" : "ABC", for: .normal)
    refreshFieldAwareKeys()
  }

  private func refreshFieldAwareKeys() {
    refreshReturnKey()
    refreshFieldShortcuts()
  }

  private func refreshReturnKey() {
    guard let returnButton else { return }

    let label: String?
    switch textDocumentProxy.returnKeyType {
    case .go:
      label = "Go"
    case .search:
      label = "Search"
    case .send:
      label = "Send"
    case .done:
      label = "Done"
    case .next:
      label = "Next"
    case .join:
      label = "Join"
    default:
      label = nil
    }

    if let label {
      returnButton.setImage(nil, for: .normal)
      returnButton.setTitle(label, for: .normal)
      returnButton.titleLabel?.font = UIFont.systemFont(ofSize: 14, weight: .semibold)
    } else {
      returnButton.setTitle(nil, for: .normal)
      returnButton.setImage(UIImage(systemName: "return.left")?.withRenderingMode(.alwaysTemplate), for: .normal)
      returnButton.setPreferredSymbolConfiguration(
        UIImage.SymbolConfiguration(pointSize: 18, weight: .medium),
        forImageIn: .normal
      )
    }
  }

  private func refreshFieldShortcuts() {
    guard fieldShortcutButtons.count == 2,
          fieldShortcutWidthConstraints.count == 2,
          fieldShortcutGapConstraints.count == 2 else { return }

    let shortcuts: [String]
    switch textDocumentProxy.keyboardType {
    case .emailAddress:
      shortcuts = ["@", ".com"]
    case .URL:
      shortcuts = ["/", ".com"]
    case .webSearch:
      shortcuts = [".", ".com"]
    default:
      shortcuts = []
    }

    for (index, button) in fieldShortcutButtons.enumerated() {
      let value = index < shortcuts.count ? shortcuts[index] : nil
      button.setTitle(value, for: .normal)
      button.isHidden = value == nil
      fieldShortcutWidthConstraints[index].constant = value == nil
        ? 0
        : (value == ".com" ? 56 : 44)
      fieldShortcutGapConstraints[index].constant = value == nil ? 0 : -metrics.keySpacing
    }
  }

  private func playKeyClick() {
    UIDevice.current.playInputClick()
  }

  private func makeCharacterRow(
    _ keys: [String],
    inset: CGFloat = 0,
    registersLetters: Bool = false
  ) -> UIView {
    let rowContainer = UIView()
    rowContainer.translatesAutoresizingMaskIntoConstraints = false
    constrainRowHeight(rowContainer)

    let rowStack = UIStackView()
    rowStack.axis = .horizontal
    rowStack.spacing = metrics.keySpacing
    rowStack.distribution = .fillEqually
    rowStack.translatesAutoresizingMaskIntoConstraints = false
    rowContainer.addSubview(rowStack)

    NSLayoutConstraint.activate([
      rowStack.leadingAnchor.constraint(equalTo: rowContainer.leadingAnchor, constant: inset),
      rowStack.trailingAnchor.constraint(equalTo: rowContainer.trailingAnchor, constant: -inset),
      rowStack.topAnchor.constraint(equalTo: rowContainer.topAnchor),
      rowStack.bottomAnchor.constraint(equalTo: rowContainer.bottomAnchor),
    ])

    for key in keys {
      let button = makeKeyButton(title: key, role: .character)
      button.addTarget(self, action: #selector(handleCharacterKeyTapped), for: .touchUpInside)
      if registersLetters {
        characterButtons.append(button)
      }
      rowStack.addArrangedSubview(button)
    }

    return rowContainer
  }

  private func makeLettersThirdRow() -> UIView {
    let rowContainer = UIView()
    rowContainer.translatesAutoresizingMaskIntoConstraints = false
    constrainRowHeight(rowContainer)

    let rowStack = UIStackView()
    rowStack.axis = .horizontal
    rowStack.spacing = metrics.keySpacing
    rowStack.translatesAutoresizingMaskIntoConstraints = false
    rowContainer.addSubview(rowStack)

    NSLayoutConstraint.activate([
      rowStack.leadingAnchor.constraint(equalTo: rowContainer.leadingAnchor),
      rowStack.trailingAnchor.constraint(equalTo: rowContainer.trailingAnchor),
      rowStack.topAnchor.constraint(equalTo: rowContainer.topAnchor),
      rowStack.bottomAnchor.constraint(equalTo: rowContainer.bottomAnchor),
    ])

    let shift = makeKeyButton(title: nil, imageSystemName: "shift", role: .utility)
    shift.addTarget(self, action: #selector(handleShiftTapped), for: .touchUpInside)
    shift.widthAnchor.constraint(equalToConstant: 52).isActive = true
    shiftButton = shift

    let lettersStack = UIStackView()
    lettersStack.axis = .horizontal
    lettersStack.spacing = metrics.keySpacing
    lettersStack.distribution = .fillEqually

    for key in ["z", "x", "c", "v", "b", "n", "m"] {
      let button = makeKeyButton(title: key, role: .character)
      button.addTarget(self, action: #selector(handleCharacterKeyTapped), for: .touchUpInside)
      characterButtons.append(button)
      lettersStack.addArrangedSubview(button)
    }

    let backspace = makeKeyButton(title: nil, imageSystemName: "delete.left", role: .utility)
    backspace.addTarget(self, action: #selector(handleBackspaceTapped), for: .touchUpInside)
    let longPress = UILongPressGestureRecognizer(
      target: self,
      action: #selector(handleBackspaceLongPress(_:))
    )
    longPress.minimumPressDuration = 0.35
    backspace.addGestureRecognizer(longPress)
    backspace.widthAnchor.constraint(equalToConstant: 58).isActive = true

    rowStack.addArrangedSubview(shift)
    rowStack.addArrangedSubview(lettersStack)
    rowStack.addArrangedSubview(backspace)

    return rowContainer
  }

  private func makeNumbersThirdRow() -> UIView {
    let rowContainer = UIView()
    rowContainer.translatesAutoresizingMaskIntoConstraints = false
    constrainRowHeight(rowContainer)

    let rowStack = UIStackView()
    rowStack.axis = .horizontal
    rowStack.spacing = metrics.keySpacing
    rowStack.translatesAutoresizingMaskIntoConstraints = false
    rowContainer.addSubview(rowStack)

    NSLayoutConstraint.activate([
      rowStack.leadingAnchor.constraint(equalTo: rowContainer.leadingAnchor),
      rowStack.trailingAnchor.constraint(equalTo: rowContainer.trailingAnchor),
      rowStack.topAnchor.constraint(equalTo: rowContainer.topAnchor),
      rowStack.bottomAnchor.constraint(equalTo: rowContainer.bottomAnchor),
    ])

    let symbolToggleButton = makeKeyButton(title: "#+=", role: .utility)
    symbolToggleButton.addTarget(self, action: #selector(handleLayoutModeSwitchTapped), for: .touchUpInside)
    symbolToggleButton.widthAnchor.constraint(equalToConstant: 56).isActive = true

    let symbolsStack = UIStackView()
    symbolsStack.axis = .horizontal
    symbolsStack.spacing = metrics.keySpacing
    symbolsStack.distribution = .fillEqually

    for key in [".", ",", "?", "!", "'"] {
      let button = makeKeyButton(title: key, role: .character)
      button.addTarget(self, action: #selector(handleCharacterKeyTapped), for: .touchUpInside)
      symbolsStack.addArrangedSubview(button)
    }

    let backspace = makeKeyButton(title: nil, imageSystemName: "delete.left", role: .utility)
    backspace.addTarget(self, action: #selector(handleBackspaceTapped), for: .touchUpInside)
    let longPress = UILongPressGestureRecognizer(
      target: self,
      action: #selector(handleBackspaceLongPress(_:))
    )
    longPress.minimumPressDuration = 0.35
    backspace.addGestureRecognizer(longPress)
    backspace.widthAnchor.constraint(equalToConstant: 58).isActive = true

    rowStack.addArrangedSubview(symbolToggleButton)
    rowStack.addArrangedSubview(symbolsStack)
    rowStack.addArrangedSubview(backspace)

    return rowContainer
  }

  private func makeMainBottomRow() -> UIView {
    let rowContainer = UIView()
    rowContainer.translatesAutoresizingMaskIntoConstraints = false
    constrainRowHeight(rowContainer)

    let modeButton = makeKeyButton(
      title: layoutMode == .letters ? "123" : "ABC",
      role: .utility
    )
    modeButton.addTarget(self, action: #selector(handleLayoutModeSwitchTapped), for: .touchUpInside)
    modeButton.translatesAutoresizingMaskIntoConstraints = false
    modeButton.widthAnchor.constraint(equalToConstant: 56).isActive = true
    self.modeButton = modeButton

    let nextKeyboardButton = makeNextKeyboardButton()
    nextKeyboardButton.translatesAutoresizingMaskIntoConstraints = false
    nextKeyboardButton.widthAnchor.constraint(equalToConstant: needsInputModeSwitchKey ? 42 : 0).isActive = true

    let spaceButton = makeKeyButton(title: nil, role: .space)
    spaceButton.addTarget(self, action: #selector(handleSpaceTapped), for: .touchUpInside)
    spaceButton.translatesAutoresizingMaskIntoConstraints = false
    addSpaceBranding(to: spaceButton)

    let returnButton = makeKeyButton(title: nil, imageSystemName: "return.left", role: .utility)
    returnButton.addTarget(self, action: #selector(handleReturnTapped), for: .touchUpInside)
    returnButton.translatesAutoresizingMaskIntoConstraints = false
    returnButton.widthAnchor.constraint(equalToConstant: 62).isActive = true
    self.returnButton = returnButton

    let shortcutOne = makeKeyButton(title: "@", role: .utility)
    shortcutOne.addTarget(self, action: #selector(handleShortcutTapped(_:)), for: .touchUpInside)
    shortcutOne.translatesAutoresizingMaskIntoConstraints = false
    let shortcutOneWidth = shortcutOne.widthAnchor.constraint(equalToConstant: 44)
    shortcutOneWidth.isActive = true

    let shortcutTwo = makeKeyButton(title: ".com", role: .utility)
    shortcutTwo.addTarget(self, action: #selector(handleShortcutTapped(_:)), for: .touchUpInside)
    shortcutTwo.translatesAutoresizingMaskIntoConstraints = false
    let shortcutTwoWidth = shortcutTwo.widthAnchor.constraint(equalToConstant: 56)
    shortcutTwoWidth.isActive = true
    fieldShortcutButtons = [shortcutOne, shortcutTwo]
    fieldShortcutWidthConstraints = [shortcutOneWidth, shortcutTwoWidth]

    // Captured so refreshFieldShortcuts can collapse the gap when a shortcut hides.
    let spaceToShortcutOneGap = spaceButton.trailingAnchor.constraint(
      equalTo: shortcutOne.leadingAnchor, constant: -metrics.keySpacing)
    let shortcutOneToTwoGap = shortcutOne.trailingAnchor.constraint(
      equalTo: shortcutTwo.leadingAnchor, constant: -metrics.keySpacing)
    fieldShortcutGapConstraints = [spaceToShortcutOneGap, shortcutOneToTwoGap]

    rowContainer.addSubview(nextKeyboardButton)
    rowContainer.addSubview(modeButton)
    rowContainer.addSubview(spaceButton)
    rowContainer.addSubview(shortcutOne)
    rowContainer.addSubview(shortcutTwo)
    rowContainer.addSubview(returnButton)

    NSLayoutConstraint.activate([
      nextKeyboardButton.leadingAnchor.constraint(equalTo: rowContainer.leadingAnchor),
      nextKeyboardButton.topAnchor.constraint(equalTo: rowContainer.topAnchor),
      nextKeyboardButton.bottomAnchor.constraint(equalTo: rowContainer.bottomAnchor),

      modeButton.leadingAnchor.constraint(equalTo: nextKeyboardButton.trailingAnchor, constant: metrics.keySpacing),
      modeButton.topAnchor.constraint(equalTo: rowContainer.topAnchor),
      modeButton.bottomAnchor.constraint(equalTo: rowContainer.bottomAnchor),

      returnButton.trailingAnchor.constraint(equalTo: rowContainer.trailingAnchor),
      returnButton.topAnchor.constraint(equalTo: rowContainer.topAnchor),
      returnButton.bottomAnchor.constraint(equalTo: rowContainer.bottomAnchor),

      spaceButton.leadingAnchor.constraint(equalTo: modeButton.trailingAnchor, constant: metrics.keySpacing),
      spaceToShortcutOneGap,
      spaceButton.topAnchor.constraint(equalTo: rowContainer.topAnchor),
      spaceButton.bottomAnchor.constraint(equalTo: rowContainer.bottomAnchor),

      shortcutOneToTwoGap,
      shortcutOne.topAnchor.constraint(equalTo: rowContainer.topAnchor),
      shortcutOne.bottomAnchor.constraint(equalTo: rowContainer.bottomAnchor),

      shortcutTwo.trailingAnchor.constraint(equalTo: returnButton.leadingAnchor, constant: -metrics.keySpacing),
      shortcutTwo.topAnchor.constraint(equalTo: rowContainer.topAnchor),
      shortcutTwo.bottomAnchor.constraint(equalTo: rowContainer.bottomAnchor),
    ])

    return rowContainer
  }

  private func makeNextKeyboardButton() -> KeyButton {
    let button = makeKeyButton(title: nil, imageSystemName: "globe", role: .utility)
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

  // The space bar shows the OpenWhispr logo + wordmark instead of "space". The
  // overlay is non-interactive so taps still reach the underlying space key.
  private func addSpaceBranding(to spaceButton: UIButton) {
    let logo = UIImageView(image: CachedImages.brandLogoMark)
    logo.tintColor = Palette.keyText
    logo.contentMode = .scaleAspectFit

    let label = UILabel()
    label.text = "OpenWhispr"
    label.font = UIFont.systemFont(ofSize: 15, weight: .medium)
    label.textColor = Palette.keyText

    let stack = UIStackView(arrangedSubviews: [logo, label])
    stack.axis = .horizontal
    stack.spacing = 7
    stack.alignment = .center
    stack.isUserInteractionEnabled = false
    stack.translatesAutoresizingMaskIntoConstraints = false
    spaceButton.addSubview(stack)

    NSLayoutConstraint.activate([
      stack.centerXAnchor.constraint(equalTo: spaceButton.centerXAnchor),
      stack.centerYAnchor.constraint(equalTo: spaceButton.centerYAnchor),
      logo.widthAnchor.constraint(equalToConstant: 18),
      logo.heightAnchor.constraint(equalToConstant: 18),
    ])
  }

  private func makeKeyButton(
    title: String?,
    imageSystemName: String? = nil,
    role: KeyRole
  ) -> KeyButton {
    let button = KeyButton(type: .custom)
    button.layer.cornerRadius = metrics.keyCornerRadius
    button.layer.cornerCurve = .continuous

    let bgColor: UIColor
    switch role {
    case .character, .space:
      bgColor = Palette.keyBackground
    case .utility:
      bgColor = Palette.utilityKeyBackground
    }
    button.normalBackground = bgColor
    button.setTitleColor(Palette.keyText, for: .normal)
    button.setTitleColor(Palette.keyText.withAlphaComponent(0.5), for: .highlighted)

    if let title {
      button.setTitle(title, for: .normal)
      button.titleLabel?.font = UIFont.systemFont(
        ofSize: role == .character ? 22 : 15,
        weight: role == .character ? .light : .medium
      )
    }

    if let imageSystemName {
      let image = UIImage(systemName: imageSystemName)?
        .withRenderingMode(.alwaysTemplate)
      button.setImage(image, for: .normal)
      button.tintColor = Palette.keyText
      button.imageView?.contentMode = .scaleAspectFit
      button.setPreferredSymbolConfiguration(
        UIImage.SymbolConfiguration(pointSize: 18, weight: .medium),
        forImageIn: .normal
      )
    }

    return button
  }

  private func refreshShiftState() {
    guard layoutMode == .letters else { return }

    for button in characterButtons {
      guard let title = button.title(for: .normal), !title.isEmpty else { continue }
      let lowercase = title.lowercased()
      button.setTitle(isShiftEnabled ? lowercase.uppercased() : lowercase, for: .normal)
    }

    guard let shiftButton else { return }

    if isCapsLocked {
      shiftButton.setImage(CachedImages.capslockFill, for: .normal)
      shiftButton.normalBackground = Palette.accent
      shiftButton.tintColor = .white
    } else if isShiftEnabled {
      shiftButton.setImage(CachedImages.shiftFill, for: .normal)
      shiftButton.normalBackground = Palette.accent
      shiftButton.tintColor = .white
    } else {
      shiftButton.setImage(CachedImages.shift, for: .normal)
      shiftButton.normalBackground = Palette.utilityKeyBackground
      shiftButton.tintColor = Palette.keyText
    }
  }

  private func syncShiftWithContextIfNeeded() {
    guard layoutMode == .letters && !isCapsLocked else { return }

    let shouldEnableShift = shouldAutoCapitalize()
    if shouldEnableShift != isShiftEnabled {
      isShiftEnabled = shouldEnableShift
      refreshShiftState()
    }
  }

  private func shouldAutoCapitalize() -> Bool {
    guard let context = textDocumentProxy.documentContextBeforeInput else {
      return true
    }

    let trimmed = context.trimmingCharacters(in: .whitespaces)
    if trimmed.isEmpty {
      return true
    }

    guard let lastCharacter = trimmed.last else {
      return true
    }

    return lastCharacter == "." || lastCharacter == "!" || lastCharacter == "?" || lastCharacter == "\n"
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
      applyRecordButtonStyle(title: "Tap to speak", systemImage: "mic.fill")
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
    config.contentInsets = NSDirectionalEdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 18)
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

    // Not applicable ⇒ locked behind Cloud. Point at the app, swallow the tap.
    guard provider.isAgentApplicable() else {
      playKeyClick()
      showTransientRecordState(
        title: "Turn on Cloud in app",
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
    agentRecordingHint = Self.agentComposeHints.randomElement()

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
    agentRecordingHint = Self.agentFollowUpHints.randomElement()
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
