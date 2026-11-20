import CoreText
import UIKit

/// Whether the running system can draw an emoji. The catalog lists every emoji Unicode has,
/// and one the system's font doesn't know would show as a box or as its parts side by side.
enum EmojiDrawability {
  private static let fontName = "AppleColorEmoji"
  private static let font = CTFontCreateWithName(fontName as CFString, 16, nil)

  /// True when the string shapes to one glyph of Apple Color Emoji: no missing glyph, no other
  /// font standing in, and a joined sequence (a family, a flag, a skin tone) not falling apart.
  static func canDraw(_ string: String) -> Bool {
    let attributes = [NSAttributedString.Key(kCTFontAttributeName as String): font]
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: string, attributes: attributes))
    guard let runs = CTLineGetGlyphRuns(line) as? [CTRun], runs.count == 1, CTRunGetGlyphCount(runs[0]) == 1 else {
      return false
    }
    var glyph = CGGlyph(0)
    CTRunGetGlyphs(runs[0], CFRange(location: 0, length: 1), &glyph)
    let runAttributes = CTRunGetAttributes(runs[0]) as NSDictionary
    guard glyph != 0, let runFont = runAttributes[kCTFontAttributeName as String] else { return false }
    // A CoreFoundation type: the cast can't fail.
    return CTFontCopyPostScriptName(runFont as! CTFont) as String == fontName
  }
}

protocol EmojiPanelDelegate: AnyObject {
  /// Insert this emoji. The panel has already recorded it in Recents.
  func emojiPanel(_ panel: EmojiPanelView, didPick emoji: String)
  /// Delete backward in the document; repeats while the key is held.
  func emojiPanelDidTapDelete(_ panel: EmojiPanelView)
  /// Back to the letter keys.
  func emojiPanelDidTapLetters(_ panel: EmojiPanelView)
  /// The search field was tapped: show the letter keys, route them to the panel and call
  /// `beginSearch()`.
  func emojiPanelDidTapSearch(_ panel: EmojiPanelView)
  /// The search field's ✕ was tapped: call `endSearch()` and bring the panel back.
  func emojiPanelDidCancelSearch(_ panel: EmojiPanelView)
}

/// The emoji keyboard: a search field, the emoji in columns that scroll sideways through
/// Recents and the categories, and a tab bar with the keys back to letters and to delete.
/// It replaces the key rows; while searching it is only the field and one strip of results
/// (`searchHeight`), since the letter keys have to stay on screen to type the query.
///
/// Emoji are drawn as text in reused cells, and the lists are the catalog's own arrays, so
/// scrolling through all of them holds no more than the cells on screen.
final class EmojiPanelView: UIView, UICollectionViewDataSource, UICollectionViewDelegateFlowLayout {
  /// The height to give the panel while `isSearching`.
  static let searchHeight: CGFloat = 86

  weak var delegate: EmojiPanelDelegate?

  /// The typing language: what search matches against and what the labels are written in.
  var language: TypingLanguage {
    didSet {
      guard language != oldValue else { return }
      updateLabels()
      updateSearchResults()
    }
  }

  private(set) var isSearching = false

  /// The query in the search field. The controller sends typed keys here while `isSearching`.
  var searchText = "" {
    didSet {
      guard searchText != oldValue else { return }
      updateSearchField()
      updateSearchResults()
    }
  }

  private enum Item {
    /// A recently used emoji, as it was inserted.
    case recent(String)
    case emoji(Emoji)
  }

  private let catalog: EmojiCatalog
  private let preferences: EmojiPreferences
  private var recents: [String] = []
  private var results: [Emoji] = []

  private let layout = UICollectionViewFlowLayout()
  private let collection: UICollectionView
  private let searchField = UIControl()
  private let searchIcon = UIImageView()
  private let searchLabel = UILabel()
  private let caret = UIView()
  private let cancelSearchButton = UIButton(type: .system)
  private let emptyLabel = UILabel()
  private let tabBar = UIView()
  private let lettersButton = UIButton(type: .system)
  private let deleteButton = UIButton(type: .system)
  private var tabButtons: [UIButton] = []
  private var selectedSection = 0
  private var emojiFont = UIFont.systemFont(ofSize: 30)
  private var laidOutSize = CGSize.zero
  private var deleteTimer: Timer?

  private let toneShield = UIControl()
  private let tonePicker = EmojiTonePicker()
  private var toneBase: Emoji?

  private static let searchRowHeight: CGFloat = 38
  private static let tabBarHeight: CGFloat = 40
  private static let cellIdentifier = "emoji"

  init(catalog: EmojiCatalog, preferences: EmojiPreferences, language: TypingLanguage) {
    self.catalog = catalog
    self.preferences = preferences
    self.language = language
    collection = UICollectionView(frame: .zero, collectionViewLayout: layout)
    super.init(frame: .zero)
    backgroundColor = .clear
    setUpCollection()
    setUpSearchField()
    setUpTabBar()
    setUpTonePicker()
    updateLabels()
    reloadRecents()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

  // MARK: Search

  func beginSearch() {
    guard !isSearching else { return }
    isSearching = true
    searchText = ""
    modeChanged()
  }

  func endSearch() {
    guard isSearching else { return }
    isSearching = false
    searchText = ""
    modeChanged()
  }

  func appendSearch(_ text: String) { searchText += text }

  func deleteSearchBackward() {
    if !searchText.isEmpty { searchText.removeLast() }
  }

  /// Takes the Recents list from the preferences again. The panel does this itself each time
  /// it comes on screen, never while it is showing: emoji jumping to the front under the
  /// finger would make the next tap land on the wrong one.
  func reloadRecents() {
    recents = preferences.recents.filter(catalog.canDraw)
    // With nothing used yet the panel opens on the smileys, so that is the tab to mark.
    if recents.isEmpty, selectedSection == 0, !isSearching { selectedSection = 1 }
    collection.reloadData()
    updateTabs()
  }

  private func modeChanged() {
    hideTonePicker()
    stopDeleting()
    tabBar.isHidden = isSearching
    updateSearchField()
    updateSearchResults()
    collection.setContentOffset(CGPoint(x: -collection.contentInset.left, y: 0), animated: false)
    setNeedsLayout()
  }

  private func updateSearchResults() {
    results = isSearching ? catalog.search(searchText, language: language, limit: 60) : []
    emptyLabel.isHidden = !(isSearching && !searchText.isEmpty && results.isEmpty)
    guard isSearching else { return }
    collection.reloadData()
    collection.setContentOffset(CGPoint(x: -collection.contentInset.left, y: 0), animated: false)
  }

  // MARK: Items

  private var sectionCount: Int { isSearching ? 1 : 1 + catalog.categories.count }

  private func itemCount(in section: Int) -> Int {
    // An empty query shows Recents, as Apple's search does.
    if isSearching { return searchText.isEmpty ? recents.count : results.count }
    return section == 0 ? recents.count : catalog.categories[section - 1].emoji.count
  }

  private func item(at indexPath: IndexPath) -> Item {
    if isSearching { return searchText.isEmpty ? .recent(recents[indexPath.item]) : .emoji(results[indexPath.item]) }
    if indexPath.section == 0 { return .recent(recents[indexPath.item]) }
    return .emoji(catalog.categories[indexPath.section - 1].emoji[indexPath.item])
  }

  /// What the cell shows and a tap inserts: the emoji in the skin tone the user picked for it.
  private func string(for item: Item) -> String {
    switch item {
    case .recent(let string):
      return string
    case .emoji(let emoji):
      guard let tone = preferences.skinTone(for: emoji), catalog.canDraw(tone) else { return emoji.string }
      return tone
    }
  }

  private func base(of item: Item) -> Emoji? {
    switch item {
    case .recent(let string): return catalog.emoji(matching: string)
    case .emoji(let emoji): return emoji
    }
  }

  private func pick(_ string: String) {
    preferences.recordUse(of: string)
    delegate?.emojiPanel(self, didPick: string)
  }

  // MARK: Collection view

  private func setUpCollection() {
    layout.scrollDirection = .horizontal
    layout.minimumLineSpacing = 0
    layout.minimumInteritemSpacing = 0
    // Smaller than any panel until the first layout sizes the cells; the flow layout complains
    // about items taller than the collection view.
    layout.itemSize = CGSize(width: 30, height: 30)
    collection.backgroundColor = .clear
    collection.showsHorizontalScrollIndicator = false
    collection.alwaysBounceHorizontal = true
    collection.isPrefetchingEnabled = false
    collection.contentInset = UIEdgeInsets(top: 0, left: 4, bottom: 0, right: 4)
    collection.dataSource = self
    collection.delegate = self
    collection.register(EmojiCell.self, forCellWithReuseIdentifier: EmojiPanelView.cellIdentifier)
    let press = UILongPressGestureRecognizer(target: self, action: #selector(longPressed(_:)))
    press.minimumPressDuration = 0.35
    collection.addGestureRecognizer(press)
    addSubview(collection)

    emptyLabel.font = .systemFont(ofSize: 15)
    emptyLabel.textColor = .secondaryLabel
    emptyLabel.textAlignment = .center
    emptyLabel.isHidden = true
    addSubview(emptyLabel)
  }

  func numberOfSections(in collectionView: UICollectionView) -> Int { sectionCount }

  func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int {
    itemCount(in: section)
  }

  func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
    let cell = collectionView.dequeueReusableCell(withReuseIdentifier: EmojiPanelView.cellIdentifier, for: indexPath)
    if let cell = cell as? EmojiCell { configure(cell, at: indexPath) }
    return cell
  }

  private func configure(_ cell: EmojiCell, at indexPath: IndexPath) {
    let item = item(at: indexPath)
    cell.label.font = emojiFont
    cell.label.text = string(for: item)
    if case .emoji(let emoji) = item {
      cell.accessibilityLabel = catalog.name(of: emoji, language: language)
    } else {
      cell.accessibilityLabel = cell.label.text
    }
  }

  func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
    collectionView.deselectItem(at: indexPath, animated: false)
    pick(string(for: item(at: indexPath)))
  }

  func collectionView(
    _ collectionView: UICollectionView, layout collectionViewLayout: UICollectionViewLayout,
    insetForSectionAt section: Int
  ) -> UIEdgeInsets {
    // A gap after each category, so where one ends shows while scrolling.
    let isLast = section == sectionCount - 1
    return UIEdgeInsets(top: 0, left: 0, bottom: 0, right: itemCount(in: section) == 0 || isLast ? 0 : 14)
  }

  func scrollViewDidScroll(_ scrollView: UIScrollView) {
    guard !isSearching else { return }
    let probe = CGPoint(
      x: scrollView.contentOffset.x + scrollView.contentInset.left + layout.itemSize.width / 2,
      y: layout.itemSize.height / 2
    )
    if let section = collection.indexPathForItem(at: probe)?.section, section != selectedSection {
      selectedSection = section
      updateTabs()
    }
  }

  func scrollViewWillBeginDragging(_ scrollView: UIScrollView) { hideTonePicker() }

  // MARK: Search field

  private func setUpSearchField() {
    searchField.backgroundColor = .tertiarySystemFill
    searchField.layer.cornerRadius = 9
    searchField.layer.cornerCurve = .continuous
    searchField.addTarget(self, action: #selector(searchFieldTapped), for: .touchUpInside)
    searchField.isAccessibilityElement = true
    searchField.accessibilityTraits = .searchField
    addSubview(searchField)

    searchIcon.image = EmojiPanelView.symbol(["magnifyingglass"], pointSize: 14)
    searchIcon.tintColor = .secondaryLabel
    searchIcon.contentMode = .center
    searchField.addSubview(searchIcon)

    searchLabel.font = .systemFont(ofSize: 16)
    searchLabel.lineBreakMode = .byTruncatingHead
    searchField.addSubview(searchLabel)

    caret.backgroundColor = .systemBlue
    caret.layer.cornerRadius = 1
    searchField.addSubview(caret)

    cancelSearchButton.setImage(EmojiPanelView.symbol(["xmark.circle.fill"], pointSize: 15), for: .normal)
    cancelSearchButton.tintColor = .secondaryLabel
    cancelSearchButton.addTarget(self, action: #selector(cancelSearchTapped), for: .touchUpInside)
    searchField.addSubview(cancelSearchButton)
    updateSearchField()
  }

  private func updateSearchField() {
    let showsQuery = isSearching && !searchText.isEmpty
    searchLabel.text = showsQuery ? searchText : text("Search Emoji", "Emoji suchen")
    searchLabel.textColor = showsQuery ? .label : .secondaryLabel
    searchField.accessibilityLabel = text("Search Emoji", "Emoji suchen")
    searchField.accessibilityValue = showsQuery ? searchText : nil
    caret.isHidden = !isSearching
    cancelSearchButton.isHidden = !isSearching
    setNeedsLayout()
  }

  @objc private func searchFieldTapped() {
    if !isSearching { delegate?.emojiPanelDidTapSearch(self) }
  }

  @objc private func cancelSearchTapped() { delegate?.emojiPanelDidCancelSearch(self) }

  // MARK: Tab bar

  private func setUpTabBar() {
    addSubview(tabBar)

    lettersButton.setTitle("ABC", for: .normal)
    lettersButton.titleLabel?.font = .systemFont(ofSize: 15)
    lettersButton.tintColor = .label
    lettersButton.addTarget(self, action: #selector(lettersTapped), for: .touchUpInside)
    tabBar.addSubview(lettersButton)

    deleteButton.setImage(EmojiPanelView.symbol(["delete.left", "delete.backward"], pointSize: 18), for: .normal)
    deleteButton.tintColor = .label
    deleteButton.addTarget(self, action: #selector(deleteDown), for: .touchDown)
    deleteButton.addTarget(self, action: #selector(stopDeleting), for: [.touchUpInside, .touchUpOutside, .touchCancel])
    tabBar.addSubview(deleteButton)

    // Each name with older stand-ins: a symbol missing on iOS 15 must not leave an empty tab.
    let symbols: [[String]] = [
      ["clock"], ["face.smiling"], ["pawprint", "leaf", "hare"], ["fork.knife", "cup.and.saucer"],
      ["soccerball", "sportscourt", "figure.walk"], ["car", "airplane"], ["lightbulb"],
      ["number", "textformat.123"], ["flag"],
    ]
    for (section, names) in symbols.enumerated() {
      let button = UIButton(type: .system)
      button.setImage(EmojiPanelView.symbol(names, pointSize: 15), for: .normal)
      button.tag = section
      button.layer.cornerRadius = 13
      button.addTarget(self, action: #selector(tabTapped(_:)), for: .touchUpInside)
      tabBar.addSubview(button)
      tabButtons.append(button)
    }
    updateTabs()
  }

  private static func symbol(_ names: [String], pointSize: CGFloat) -> UIImage? {
    let configuration = UIImage.SymbolConfiguration(pointSize: pointSize, weight: .regular)
    for name in names {
      if let image = UIImage(systemName: name, withConfiguration: configuration) { return image }
    }
    return nil
  }

  private func updateTabs() {
    for button in tabButtons {
      let isSelected = button.tag == selectedSection
      button.tintColor = isSelected ? .label : .secondaryLabel
      button.backgroundColor = isSelected ? .tertiarySystemFill : .clear
      button.accessibilityTraits = isSelected ? [.button, .selected] : .button
      // Recents has nothing to scroll to until an emoji was used.
      button.isEnabled = itemCount(in: button.tag) > 0 || isSearching
    }
  }

  private func updateLabels() {
    for button in tabButtons {
      button.accessibilityLabel =
        button.tag == 0
        ? text("Recents", "Zuletzt verwendet") : EmojiCategoryID.allCases[button.tag - 1].title(language: language)
    }
    lettersButton.accessibilityLabel = text("Letters", "Buchstaben")
    deleteButton.accessibilityLabel = text("Delete", "Löschen")
    emptyLabel.text = text("No Emoji Found", "Keine Emojis gefunden")
    updateSearchField()
  }

  private func text(_ english: String, _ german: String) -> String { language == .german ? german : english }

  @objc private func tabTapped(_ button: UIButton) {
    let section = button.tag
    guard !isSearching, itemCount(in: section) > 0,
      let frame = collection.layoutAttributesForItem(at: IndexPath(item: 0, section: section))?.frame
    else { return }
    hideTonePicker()
    let inset = collection.contentInset
    let furthest = max(-inset.left, collection.contentSize.width + inset.right - collection.bounds.width)
    collection.setContentOffset(CGPoint(x: min(frame.minX - inset.left, furthest), y: 0), animated: false)
    // At the far end the scroll can stop short of the section; the tapped tab is still the one.
    selectedSection = section
    updateTabs()
  }

  @objc private func lettersTapped() { delegate?.emojiPanelDidTapLetters(self) }

  @objc private func deleteDown() {
    delegate?.emojiPanelDidTapDelete(self)
    stopDeleting()
    // Hold to keep deleting, at the system keyboard's pace: a pause, then steadily.
    deleteTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: false) { [weak self] _ in
      self?.deleteTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
        guard let self else { return }
        self.delegate?.emojiPanelDidTapDelete(self)
      }
    }
  }

  @objc private func stopDeleting() {
    deleteTimer?.invalidate()
    deleteTimer = nil
  }

  // MARK: Skin tones

  private func setUpTonePicker() {
    toneShield.isHidden = true
    toneShield.addTarget(self, action: #selector(hideTonePicker), for: .touchDown)
    addSubview(toneShield)
    tonePicker.isHidden = true
    tonePicker.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(toneTapped(_:))))
    addSubview(tonePicker)
  }

  @objc private func longPressed(_ press: UILongPressGestureRecognizer) {
    switch press.state {
    case .began:
      guard let indexPath = collection.indexPathForItem(at: press.location(in: collection)),
        let cell = collection.cellForItem(at: indexPath), let base = base(of: item(at: indexPath))
      else { return }
      let tones = catalog.variants(of: base)
      guard !tones.isEmpty else { return }
      toneBase = base
      tonePicker.show([base.string] + tones, selected: string(for: .emoji(base)))
      placeTonePicker(over: convert(cell.frame, from: collection))
    case .changed:
      // One gesture like Apple's: hold, slide to a tone, let go.
      if !tonePicker.isHidden { tonePicker.highlight(at: press.location(in: tonePicker)) }
    case .ended:
      if !tonePicker.isHidden, let tone = tonePicker.option(at: press.location(in: tonePicker)) { choose(tone) }
    default:
      break
    }
  }

  private func placeTonePicker(over cell: CGRect) {
    let size = tonePicker.intrinsicContentSize
    let x = min(max(4, cell.midX - size.width / 2), max(4, bounds.width - size.width - 4))
    // Above the emoji when there is room in the panel, else below it: never under the finger,
    // or the hold itself would pick a tone.
    let above = cell.minY - size.height - 4
    tonePicker.frame = CGRect(origin: CGPoint(x: x, y: above >= 2 ? above : cell.maxY + 4), size: size)
    tonePicker.isHidden = false
    toneShield.isHidden = false
  }

  @objc private func toneTapped(_ tap: UITapGestureRecognizer) {
    if let tone = tonePicker.option(at: tap.location(in: tonePicker)) { choose(tone) }
  }

  private func choose(_ tone: String) {
    guard let base = toneBase else { return }
    preferences.setSkinTone(tone, for: base)
    hideTonePicker()
    pick(tone)
    for cell in collection.visibleCells {
      if let cell = cell as? EmojiCell, let indexPath = collection.indexPath(for: cell) { configure(cell, at: indexPath) }
    }
  }

  @objc private func hideTonePicker() {
    tonePicker.isHidden = true
    toneShield.isHidden = true
    toneBase = nil
  }

  // MARK: Layout

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil {
      stopDeleting()
      hideTonePicker()
    } else {
      reloadRecents()
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let rowHeight = EmojiPanelView.searchRowHeight
    searchField.frame = CGRect(x: 8, y: 4, width: bounds.width - 16, height: rowHeight - 8)
    let fieldHeight = searchField.bounds.height
    searchIcon.frame = CGRect(x: 6, y: 0, width: 22, height: fieldHeight)
    cancelSearchButton.frame = CGRect(x: searchField.bounds.width - 34, y: 0, width: 34, height: fieldHeight)
    let labelWidth = min(
      searchLabel.intrinsicContentSize.width, searchField.bounds.width - 32 - (isSearching ? 40 : 8)
    )
    searchLabel.frame = CGRect(x: 32, y: 0, width: max(0, labelWidth), height: fieldHeight)
    let showsQuery = isSearching && !searchText.isEmpty
    caret.frame = CGRect(x: showsQuery ? searchLabel.frame.maxX + 1 : 31, y: (fieldHeight - 18) / 2, width: 2, height: 18)

    let barHeight = isSearching ? 0 : EmojiPanelView.tabBarHeight
    tabBar.frame = CGRect(x: 0, y: bounds.height - barHeight, width: bounds.width, height: barHeight)
    lettersButton.frame = CGRect(x: 2, y: 0, width: 48, height: barHeight)
    deleteButton.frame = CGRect(x: bounds.width - 50, y: 0, width: 48, height: barHeight)
    let tabWidth = (bounds.width - 104) / CGFloat(max(1, tabButtons.count))
    for (index, button) in tabButtons.enumerated() {
      let slot = CGRect(x: 52 + CGFloat(index) * tabWidth, y: 0, width: tabWidth, height: barHeight)
      let side = min(26, tabWidth)
      button.frame = CGRect(x: slot.midX - side / 2, y: slot.midY - 13, width: side, height: 26)
    }

    collection.frame = CGRect(
      x: 0, y: rowHeight, width: bounds.width, height: max(0, bounds.height - rowHeight - barHeight)
    )
    emptyLabel.frame = collection.frame
    toneShield.frame = bounds
    updateGrid()
  }

  /// Sizes the cells so whole rows fill the height, at about the system keyboard's emoji size.
  private func updateGrid() {
    let size = collection.bounds.size
    guard size != laidOutSize, size.width > 0, size.height > 0 else { return }
    // Where the user was, to return there: a new cell size moves every column.
    let anchor = collection.indexPathForItem(
      at: CGPoint(x: collection.contentOffset.x + collection.contentInset.left + layout.itemSize.width / 2, y: 1)
    )
    laidOutSize = size
    let rows = max(1, Int(size.height / 34))
    let cellHeight = (size.height / CGFloat(rows)).rounded(.down)
    let columns = max(1, Int(size.width / max(cellHeight, 40)))
    layout.itemSize = CGSize(width: (size.width / CGFloat(columns)).rounded(.down), height: cellHeight)
    emojiFont = .systemFont(ofSize: min(32, (cellHeight * 0.8).rounded()))
    layout.invalidateLayout()
    collection.reloadData()
    collection.layoutIfNeeded()
    if let anchor, anchor.section < sectionCount, anchor.item < itemCount(in: anchor.section),
      let frame = collection.layoutAttributesForItem(at: anchor)?.frame
    {
      collection.contentOffset = CGPoint(x: frame.minX - collection.contentInset.left, y: 0)
    }
  }
}

/// One emoji, drawn as text. A label, not an image: the system caches glyphs for the font, and
/// nothing per emoji stays alive once the cell is reused.
private final class EmojiCell: UICollectionViewCell {
  let label = UILabel()

  override init(frame: CGRect) {
    super.init(frame: frame)
    label.textAlignment = .center
    label.frame = contentView.bounds
    label.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    contentView.addSubview(label)
    contentView.layer.cornerRadius = 8
    isAccessibilityElement = true
    accessibilityTraits = .button
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

  override var isHighlighted: Bool {
    didSet { contentView.backgroundColor = isHighlighted ? .tertiarySystemFill : .clear }
  }
}

/// The bubble with an emoji's plain form and its five skin tones.
private final class EmojiTonePicker: UIView {
  private var labels: [UILabel] = []
  private var options: [String] = []
  private static let optionSize = CGSize(width: 42, height: 46)
  private static let padding: CGFloat = 5

  override init(frame: CGRect) {
    super.init(frame: frame)
    // An opaque key-popup colour: the bubble covers emoji, which must not show through.
    backgroundColor = UIColor { $0.userInterfaceStyle == .dark ? UIColor(white: 0.36, alpha: 1) : .white }
    layer.cornerRadius = 12
    layer.cornerCurve = .continuous
    layer.shadowColor = UIColor.black.cgColor
    layer.shadowOpacity = 0.25
    layer.shadowRadius = 6
    layer.shadowOffset = CGSize(width: 0, height: 2)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

  override var intrinsicContentSize: CGSize {
    CGSize(
      width: CGFloat(options.count) * EmojiTonePicker.optionSize.width + 2 * EmojiTonePicker.padding,
      height: EmojiTonePicker.optionSize.height + 2 * EmojiTonePicker.padding
    )
  }

  func show(_ options: [String], selected: String) {
    self.options = options
    labels.forEach { $0.removeFromSuperview() }
    labels = options.enumerated().map { index, option in
      let label = UILabel()
      label.text = option
      label.font = .systemFont(ofSize: 30)
      label.textAlignment = .center
      label.layer.cornerRadius = 8
      label.layer.masksToBounds = true
      label.frame = CGRect(
        origin: CGPoint(
          x: EmojiTonePicker.padding + CGFloat(index) * EmojiTonePicker.optionSize.width, y: EmojiTonePicker.padding
        ),
        size: EmojiTonePicker.optionSize
      )
      addSubview(label)
      return label
    }
    highlight(options.firstIndex(of: selected))
  }

  /// The option under a point, with some slack above and below for a sliding finger.
  func option(at point: CGPoint) -> String? { index(at: point).map { options[$0] } }

  func highlight(at point: CGPoint) {
    if let index = index(at: point) { highlight(index) }
  }

  private func index(at point: CGPoint) -> Int? {
    guard bounds.insetBy(dx: 0, dy: -24).contains(point) else { return nil }
    let index = Int((point.x - EmojiTonePicker.padding) / EmojiTonePicker.optionSize.width)
    return options.indices.contains(index) ? index : nil
  }

  private func highlight(_ index: Int?) {
    for (position, label) in labels.enumerated() {
      label.backgroundColor = position == index ? .systemBlue : .clear
    }
  }
}
