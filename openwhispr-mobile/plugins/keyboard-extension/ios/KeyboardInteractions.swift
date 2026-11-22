import UIKit
import UIKit.UIGestureRecognizerSubclass

// MARK: - Key feedback

/// What a key press plays. Behind a protocol so tests can count the calls: a simulator has
/// no Taptic Engine to feel.
protocol KeyFeedbackGenerating: AnyObject {
  /// The system key click, which follows the user's Keyboard Clicks setting by itself.
  func click()
  /// A light tap for a key.
  func tap()
  /// A selection tick: trackpad mode starting, an accent row opening.
  func tick()
}

final class SystemKeyFeedback: KeyFeedbackGenerating {
  // Created on first use: a generator the user never needs (haptics off) costs nothing.
  private lazy var impact = UIImpactFeedbackGenerator(style: .light)
  private lazy var selection = UISelectionFeedbackGenerator()

  func click() { UIDevice.current.playInputClick() }

  /// Softer than a full light impact, which felt too strong on every key on a phone.
  private static let tapIntensity: CGFloat = 0.5

  func tap() {
    impact.impactOccurred(intensity: SystemKeyFeedback.tapIntensity)
    // Keeps the Taptic Engine awake for the next key, so fast typing doesn't drop taps.
    impact.prepare()
  }

  func tick() { selection.selectionChanged() }
}

// MARK: - Long-press accents

/// The row of accented letters above a held key. The finger slides along it to choose;
/// letting go types the highlighted one.
final class AccentPopupView: UIView {
  private var labels: [UILabel] = []
  private var options: [String] = []
  private var selectedIndex: Int?
  private let highlight = UIView()

  private enum Look {
    static let cellPadding: CGFloat = 4
    static let minCellWidth: CGFloat = 34
    static let height: CGFloat = 46
    static let gapAboveKey: CGFloat = 6
  }

  var selected: String? { selectedIndex.map { options[$0] } }

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    backgroundColor = UIColor { traits in
      traits.userInterfaceStyle == .dark ? UIColor(white: 80 / 255, alpha: 1) : .white
    }
    layer.cornerCurve = .continuous
    layer.shadowColor = UIColor.black.cgColor
    layer.shadowOpacity = 0.18
    layer.shadowRadius = 6
    layer.shadowOffset = CGSize(width: 0, height: 2)
    highlight.backgroundColor = .systemBlue
    highlight.layer.cornerCurve = .continuous
    addSubview(highlight)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

  /// `options[0]` is the key's own letter and starts selected. Frames are in the
  /// superview's coordinates; the row stays inside `container`.
  func show(_ options: [String], font: UIFont, keyFrame: CGRect, container: CGRect, cornerRadius: CGFloat) {
    self.options = options
    labels.forEach { $0.removeFromSuperview() }
    let cellWidth = max(Look.minCellWidth, keyFrame.width)
    // Rows too long for the keyboard shrink their cells rather than run off the edge.
    let fitted = min(cellWidth, (container.width - 2 * Look.cellPadding) / CGFloat(options.count))
    let width = fitted * CGFloat(options.count) + 2 * Look.cellPadding
    // The first cell sits over the key; keys near the right edge open leftwards instead.
    var x = keyFrame.midX - fitted / 2 - Look.cellPadding
    let opensLeft = x + width > container.maxX
    if opensLeft { x = keyFrame.midX + fitted / 2 + Look.cellPadding - width }
    x = min(max(x, container.minX), container.maxX - width)
    frame = CGRect(x: x, y: keyFrame.minY - Look.gapAboveKey - Look.height, width: width, height: Look.height)
    layer.cornerRadius = cornerRadius + 2
    highlight.layer.cornerRadius = cornerRadius

    let ordered = opensLeft ? Array(options.reversed()) : options
    self.options = ordered
    labels = ordered.enumerated().map { index, text in
      let label = UILabel()
      label.text = text
      label.font = font
      label.textAlignment = .center
      label.frame = CGRect(
        x: Look.cellPadding + CGFloat(index) * fitted, y: Look.cellPadding,
        width: fitted, height: Look.height - 2 * Look.cellPadding
      )
      addSubview(label)
      return label
    }
    isHidden = false
    setSelected(opensLeft ? ordered.count - 1 : 0)
  }

  /// `point` in this view's coordinates; only its x counts, so the finger can stay on the key.
  func select(at point: CGPoint) {
    guard !labels.isEmpty else { return }
    let index = labels.firstIndex { point.x < $0.frame.maxX } ?? labels.count - 1
    setSelected(index)
  }

  private func setSelected(_ index: Int) {
    guard index != selectedIndex || highlight.isHidden else { return }
    selectedIndex = index
    highlight.isHidden = false
    highlight.frame = labels[index].frame
    for (labelIndex, label) in labels.enumerated() {
      label.textColor = labelIndex == index ? .white : .label
    }
  }

  func hide() {
    isHidden = true
    selectedIndex = nil
    highlight.isHidden = true
  }
}

// MARK: - Swipe typing

/// Watches one finger on the letter keys. While the touch could still be a tap it only
/// watches, so the key under it behaves as ever; once the finger has clearly left for
/// another key it begins, which cancels the key's own touch (no stray letter) and any
/// pending accent hold.
final class SwipeTypingRecognizer: UIGestureRecognizer {
  /// Whether a touch at this point (in the recogniser's view) starts on a letter key of a
  /// keyboard that can decode swipes; also the distance between key centres.
  var canStartSwipe: ((CGPoint) -> CGFloat?)?
  private(set) var path: [CGPoint] = []
  /// When each point of `path` was sampled, for the swipe-trace recorder.
  private(set) var times: [TimeInterval] = []
  private var classifier: SwipeGestureClassifier?
  private weak var trackedTouch: UITouch?

  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
    if trackedTouch != nil || touches.count > 1 {
      // A second finger: this is two-thumb typing. An undecided touch stays a tap; a swipe
      // already under way keeps its own finger.
      classifier?.otherTouchBegan()
      if state == .possible { state = .failed }
      for touch in touches where touch !== trackedTouch { ignore(touch, for: event) }
      return
    }
    guard let touch = touches.first, let view else { return }
    let point = touch.location(in: view)
    guard let pitch = canStartSwipe?(point) else {
      state = .failed
      return
    }
    trackedTouch = touch
    path = [point]
    times = [touch.timestamp]
    classifier = SwipeGestureClassifier(pitch: pitch, startsOnLetter: true)
    _ = classifier?.add(point, at: touch.timestamp)
  }

  override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
    guard let touch = trackedTouch, touches.contains(touch), let view else { return }
    // Coalesced touches give the path its full sampling rate on 120 Hz screens.
    let samples = event.coalescedTouches(for: touch) ?? [touch]
    for sample in samples {
      let point = sample.location(in: view)
      path.append(point)
      times.append(sample.timestamp)
      let verdict = classifier?.add(point, at: sample.timestamp)
      if state == .possible {
        if verdict == .swipe {
          state = .began
        } else if verdict == .tap {
          state = .failed
          return
        }
      }
    }
    if state == .began || state == .changed { state = .changed }
  }

  override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
    guard let touch = trackedTouch, touches.contains(touch) else { return }
    state = (state == .began || state == .changed) ? .ended : .failed
  }

  override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
    guard let touch = trackedTouch, touches.contains(touch) else { return }
    state = (state == .began || state == .changed) ? .cancelled : .failed
  }

  override func reset() {
    super.reset()
    trackedTouch = nil
    classifier = nil
    // The path is read by the action for .ended, which runs before reset.
    path = []
    times = []
  }
}

/// The fading line behind a swiping finger.
final class SwipeTrailLayer: CAShapeLayer {
  override init() {
    super.init()
    fillColor = nil
    lineWidth = 5
    lineCap = .round
    lineJoin = .round
    opacity = 0.55
  }

  override init(layer: Any) { super.init(layer: layer) }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

  /// Only the last stretch of the path is drawn, like Apple's trail.
  func show(_ points: [CGPoint], color: UIColor) {
    let tail = points.suffix(40)
    guard let first = tail.first else {
      path = nil
      return
    }
    let line = UIBezierPath()
    line.move(to: first)
    tail.dropFirst().forEach(line.addLine(to:))
    strokeColor = color.cgColor
    path = line.cgPath
  }
}
