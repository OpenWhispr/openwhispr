import CoreText
import UIKit
import WebKit

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
/// Every emoji is drawn as HTML text in one web view, never by UIKit: CoreText keeps a bitmap
/// of each colour glyph it rasterises in a cache that is never emptied, about 60–100 MB for
/// the whole catalog, charged to this process, which iOS ends at roughly 40 MB. In a web view
/// the glyphs are drawn, and cached, in WebKit's own process. The field, the tab bar and the
/// "no results" label stay native.
final class EmojiPanelView: UIView, WKNavigationDelegate {
  /// The height to give the panel while `isSearching`.
  static let searchHeight: CGFloat = 86

  weak var delegate: EmojiPanelDelegate?

  /// The typing language: what search matches against and what the labels are written in.
  var language: TypingLanguage {
    didSet {
      guard language != oldValue else { return }
      updateLabels()
      // The page carries each emoji's name in the typing language, so it is built again.
      if webView != nil { loadPage() }
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

  private let catalog: EmojiCatalog
  private let preferences: EmojiPreferences
  private var recents: [String] = []
  private var results: [Emoji] = []

  /// Made when the panel first comes on screen: the web view and its page of every emoji.
  private var webView: WKWebView?
  private let messages = EmojiMessageHandler()
  /// Whether the page has loaded and shows the panel's current state. Until then the grid
  /// is empty; the tests and the simulator harness wait for it.
  private(set) var isContentReady = false
  private var pageMetrics: [CGFloat] = []

  /// For screenshot tests: the emoji as WebKit draws them, and where in the panel. A layer
  /// render of the panel shows none of it, since the page is drawn in another process.
  func snapshotContent(_ completion: @escaping (UIImage?, CGRect) -> Void) {
    guard let webView else { return completion(nil, .zero) }
    webView.takeSnapshot(with: nil) { image, _ in completion(image, webView.frame) }
  }

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
  private var deleteTimer: Timer?

  private static let searchRowHeight: CGFloat = 38
  private static let tabBarHeight: CGFloat = 40

  init(catalog: EmojiCatalog, preferences: EmojiPreferences, language: TypingLanguage) {
    self.catalog = catalog
    self.preferences = preferences
    self.language = language
    super.init(frame: .zero)
    backgroundColor = .clear
    messages.target = self
    setUpEmptyLabel()
    setUpSearchField()
    setUpTabBar()
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

  func appendSearchWord(_ word: String) {
    let needsSpace = searchText.last.map { !$0.isWhitespace } ?? false
    appendSearch((needsSpace ? " " : "") + word + " ")
  }

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
    showRecents()
    if isSearching, searchText.isEmpty { showStrip() }
    updateTabs()
  }

  private func modeChanged() {
    stopDeleting()
    tabBar.isHidden = isSearching
    updateSearchField()
    run("mode", isSearching)
    updateSearchResults()
    setNeedsLayout()
  }

  private func updateSearchResults() {
    results = isSearching ? catalog.search(searchText, language: language, limit: 60) : []
    emptyLabel.isHidden = !(isSearching && !searchText.isEmpty && results.isEmpty)
    if isSearching { showStrip() }
  }

  /// The search strip: the results, or Recents for an empty query, as Apple's search does.
  private func showStrip() {
    guard isContentReady else { return }
    run("results", searchText.isEmpty ? recents.map(recentCell).joined() : results.map(cell).joined())
  }

  private func showRecents() {
    // Not before the page can take it: building the cells looks every recent emoji up.
    guard isContentReady else { return }
    run("recents", recents.map(recentCell).joined())
  }

  private func itemCount(in section: Int) -> Int {
    section == 0 ? recents.count : catalog.categories[section - 1].emoji.count
  }

  private func pick(_ string: String) {
    preferences.recordUse(of: string)
    delegate?.emojiPanel(self, didPick: string)
  }

  private func setUpEmptyLabel() {
    emptyLabel.font = .systemFont(ofSize: 15)
    emptyLabel.textColor = .secondaryLabel
    emptyLabel.textAlignment = .center
    emptyLabel.isHidden = true
    addSubview(emptyLabel)
  }

  // MARK: The page

  /// One emoji of the page. `b` names the emoji a long press offers skin tones for; the text
  /// is what a tap inserts: the emoji in the tone the user picked for it.
  private func cell(_ emoji: Emoji) -> String {
    var shown = emoji.string
    if let tone = preferences.skinTone(for: emoji), catalog.canDraw(tone) { shown = tone }
    let tones = emoji.hasSkinTones ? " b=\"\(EmojiPanelView.escaped(emoji.string))\"" : ""
    let name = EmojiPanelView.escaped(catalog.name(of: emoji, language: language))
    return "<button class=emoji type=button aria-label=\"\(name)\"\(tones)>\(EmojiPanelView.escaped(shown))</button>"
  }

  /// A recently used emoji, shown as it was inserted. `r` keeps a later tone pick from
  /// changing it.
  private func recentCell(_ string: String) -> String {
    let base = catalog.emoji(matching: string)
    let tones = base?.hasSkinTones == true ? " b=\"\(EmojiPanelView.escaped(base?.string ?? ""))\"" : ""
    let name = EmojiPanelView.escaped(base.map { catalog.name(of: $0, language: language) } ?? string)
    return "<button class=emoji type=button r aria-label=\"\(name)\"\(tones)>\(EmojiPanelView.escaped(string))</button>"
  }

  private static func escaped(_ text: String) -> String {
    text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
      .replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
  }

  private func makeWebView() -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.dataDetectorTypes = []
    configuration.userContentController.add(messages, name: "emoji")
    let webView = WKWebView(frame: .zero, configuration: configuration)
    webView.navigationDelegate = self
    webView.allowsLinkPreview = false
    // Transparent, so the system keyboard's backdrop shows through as it does between keys.
    webView.isOpaque = false
    webView.backgroundColor = .clear
    webView.underPageBackgroundColor = .clear
    webView.scrollView.backgroundColor = .clear
    webView.scrollView.showsHorizontalScrollIndicator = false
    webView.scrollView.showsVerticalScrollIndicator = false
    webView.scrollView.alwaysBounceVertical = false
    webView.scrollView.contentInsetAdjustmentBehavior = .never
    return webView
  }

  private func loadPage() {
    isContentReady = false
    pageMetrics = []
    let sections = catalog.categories.map { "<section>\($0.emoji.map(cell).joined())</section>" }.joined()
    webView?.loadHTMLString(
      EmojiPanelView.pageHead + "<div id=g><section></section>\(sections)</div><div id=s></div><div id=t></div>"
        + "<script>\(EmojiPanelView.pageScript)</script>",
      baseURL: nil
    )
  }

  /// The page is this panel's own text: nothing in it may go anywhere else.
  func webView(
    _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    decisionHandler(navigationAction.request.url?.absoluteString == "about:blank" ? .allow : .cancel)
  }

  /// WebKit's process was ended (memory pressure): the page is gone, so build it again.
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { loadPage() }

  /// Calls one of the page's functions. Before the page has loaded nothing is sent: once it
  /// has, `pageLoaded` gives it the panel's whole state.
  private func run(_ function: String, _ arguments: Any...) {
    guard isContentReady, let data = try? JSONSerialization.data(withJSONObject: arguments),
      let json = String(data: data, encoding: .utf8)
    else { return }
    webView?.evaluateJavaScript("\(function).apply(null,\(json))", completionHandler: nil)
  }

  private func pageLoaded() {
    isContentReady = true
    updatePageMetrics()
    showRecents()
    run("mode", isSearching)
    if isSearching { showStrip() }
  }

  fileprivate func handle(_ body: Any) {
    guard let message = body as? [String: Any], let kind = message["t"] as? String else { return }
    switch kind {
    case "ready":
      pageLoaded()
    case "tap":
      if let string = message["s"] as? String, !string.isEmpty { pick(string) }
    case "section":
      if let section = message["i"] as? Int, tabButtons.indices.contains(section), !isSearching {
        selectedSection = section
        updateTabs()
      }
    case "hold":
      // A long press on an emoji with skin tones: the page shows the choices.
      guard let string = message["b"] as? String, let base = catalog.emoji(matching: string) else { return }
      let tones = catalog.variants(of: base)
      if !tones.isEmpty { run("showTones", [base.string] + tones, message["s"] as? String ?? "") }
    case "tone":
      guard let string = message["b"] as? String, let base = catalog.emoji(matching: string),
        let tone = message["s"] as? String, tone == base.string || catalog.variants(of: base).contains(tone)
      else { return }
      preferences.setSkinTone(tone, for: base)
      run("setTone", base.string, tone)
      pick(tone)
    default:
      break
    }
  }

  /// Sizes the cells so whole rows fill the height, at about the system keyboard's emoji size.
  private func updatePageMetrics() {
    guard let size = webView?.bounds.size, size.width > 0, size.height > 0 else { return }
    let rows = max(1, Int(size.height / 32))
    let cellHeight = (size.height / CGFloat(rows)).rounded(.down)
    // Columns no wider than a comfortable target: a single tall row (landscape) would
    // otherwise spread a handful of emoji across the screen.
    let columns = max(1, Int((size.width - 8) / min(max(cellHeight, 40), 46)))
    let metrics = [
      ((size.width - 8) / CGFloat(columns)).rounded(.down), cellHeight, CGFloat(rows),
      min(32, (cellHeight * 0.8).rounded()),
    ]
    guard metrics != pageMetrics, isContentReady else { return }
    pageMetrics = metrics
    run("layout", metrics[0], metrics[1], metrics[2], metrics[3])
  }

  private static let pageHead = """
    <!doctype html><meta charset=utf-8>
    <meta name=viewport content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
    <meta http-equiv=Content-Security-Policy content="default-src 'none';style-src 'unsafe-inline';script-src 'unsafe-inline'">
    <meta name=color-scheme content="light dark">
    <style>
    :root{color-scheme:light dark;--cw:40px;--ch:36px;--rows:4;--fs:28px;--press:rgba(118,118,128,.12);--bubble:#fff;--blue:#007aff}
    @media(prefers-color-scheme:dark){:root{--press:rgba(118,118,128,.24);--bubble:#5c5c5c;--blue:#0a84ff}}
    html,body{margin:0;height:100%;background:transparent;overflow-y:hidden;touch-action:pan-x;
    -webkit-user-select:none;user-select:none;-webkit-touch-callout:none;-webkit-text-size-adjust:none;
    -webkit-tap-highlight-color:transparent;font-family:"Apple Color Emoji"}
    body{padding:0 4px;width:max-content;min-width:calc(100% - 8px)}
    #g{display:flex;width:max-content}
    section,#s{display:grid;grid-auto-flow:column;grid-template-rows:repeat(var(--rows),var(--ch));grid-auto-columns:var(--cw)}
    section{margin-right:14px}section:empty{display:none}section:last-child{margin-right:0}
    #s,body.q #g{display:none}body.q #s{display:grid}
    button{appearance:none;border:0;background:transparent;color:inherit;font:inherit;padding:0;margin:0}
    .emoji{font-size:var(--fs);line-height:var(--ch);text-align:center;border-radius:8px}
    .emoji.p{background:var(--press)}
    #t{display:none;position:fixed;padding:5px;border-radius:12px;background:var(--bubble);box-shadow:0 2px 6px rgba(0,0,0,.25)}
    #t button{font-weight:normal;font-size:30px;width:42px;height:min(46px,calc(100vh - 12px));line-height:min(46px,calc(100vh - 12px));text-align:center;border-radius:8px}
    #t button.on{background:var(--blue)}
    </style>
    """

  /// Touch handling and the calls the panel makes. A tap is a touch that neither moved nor
  /// scrolled the page; a hold on an emoji with tones asks the panel for them, and the same
  /// finger can slide onto one, as on Apple's keyboard.
  private static let pageScript = """
    var grid=document.getElementById('g'),strip=document.getElementById('s'),tones=document.getElementById('t');
    var secs=grid.children,cur=-1,held=null,touch=null,timer=0,frame=0,pad=4,cw=40;
    function post(m){webkit.messageHandlers.emoji.postMessage(m)}
    function cellOf(e){return e&&e.closest?e.closest('button.emoji'):null}
    function touchOf(list,id){for(var k=0;k<list.length;k++)if(list[k].identifier===id)return list[k];return null}
    function closeTones(){tones.style.display='none';tones.textContent='';held=null}
    function optionAt(x,y){
      if(!held||!tones.children.length)return null;
      var r=tones.getBoundingClientRect();
      if(x<r.left||x>r.right||y<r.top-24||y>r.bottom+24)return null;
      for(var k=0;k<tones.children.length;k++){var q=tones.children[k].getBoundingClientRect();if(x>=q.left&&x<q.right)return tones.children[k]}
      return null}
    function mark(o){for(var k=0;k<tones.children.length;k++)tones.children[k].classList.toggle('on',tones.children[k]===o)}
    function choose(o){post({t:'tone',b:held.getAttribute('b'),s:o.textContent});closeTones()}
    function far(t,u){return Math.abs(t.clientX-u.x)>8||Math.abs(t.clientY-u.y)>8}
    function drop(){clearTimeout(timer);if(touch){if(touch.c)touch.c.classList.remove('p');touch.dead=true}}
    document.addEventListener('touchstart',function(e){
      if(touch)return;
      var t=e.changedTouches[0],c=cellOf(e.target);
      if(held){
        var o=optionAt(t.clientX,t.clientY);
        if(o){mark(o);touch={id:t.identifier,pick:true}}else{closeTones();touch={id:t.identifier,dead:true}}
        return}
      if(!c)return;
      touch={id:t.identifier,c:c,x:t.clientX,y:t.clientY,sx:window.scrollX};
      c.classList.add('p');
      if(c.hasAttribute('b'))timer=setTimeout(function(){
        if(!touch||touch.c!==c||touch.dead)return;
        touch.hold=true;held=c;post({t:'hold',b:c.getAttribute('b'),s:c.textContent})},400);
    },{passive:true});
    document.addEventListener('touchmove',function(e){
      if(!touch||touch.dead)return;
      var t=touchOf(e.changedTouches,touch.id);if(!t)return;
      if(touch.pick){e.preventDefault();mark(optionAt(t.clientX,t.clientY));return}
      if(touch.hold){
        e.preventDefault();
        // The bubble can open under the finger; only a finger that then moves is choosing.
        if(far(t,touch))touch.slid=true;
        if(touch.slid)mark(optionAt(t.clientX,t.clientY));
        return}
      if(far(t,touch)||Math.abs(window.scrollX-touch.sx)>2)drop();
    },{passive:false});
    document.addEventListener('touchend',function(e){
      if(!touch)return;
      var t=touchOf(e.changedTouches,touch.id);if(!t)return;
      var u=touch;touch=null;clearTimeout(timer);
      if(u.c)u.c.classList.remove('p');
      // A plain tap uses the button's click, as do VoiceOver and keyboard activation.
      // Suppress its compatibility click when scrolling or choosing a tone consumed the touch.
      if(u.dead||u.pick||u.hold||Math.abs(window.scrollX-u.sx)>2)e.preventDefault();
      if(!u.dead&&(u.pick||u.hold)){var o=u.pick||u.slid?optionAt(t.clientX,t.clientY):null;if(o)choose(o)}
    },{passive:false});
    document.addEventListener('click',function(e){
      var option=e.target.closest('#t button');
      if(held&&option){choose(option);return}
      var c=cellOf(e.target);
      if(c){closeTones();post({t:'tap',s:c.textContent})}
    });
    document.addEventListener('touchcancel',function(){drop();touch=null},{passive:true});
    function report(){
      if(document.body.className)return;
      var x=window.scrollX+pad+cw/2,s=-1;
      for(var k=0;k<secs.length;k++)if(secs[k].offsetWidth&&secs[k].offsetLeft<=x)s=k;
      if(s>=0&&s!==cur){cur=s;post({t:'section',i:s})}}
    window.addEventListener('scroll',function(){
      if(held&&!touch)closeTones();
      if(!frame)frame=requestAnimationFrame(function(){frame=0;report()})},{passive:true});
    function layout(w,h,rows,fs){
      var a=cellOf(document.elementFromPoint(pad+2,2)),st=document.documentElement.style;
      cw=w;st.setProperty('--cw',w+'px');st.setProperty('--ch',h+'px');st.setProperty('--rows',rows);st.setProperty('--fs',fs+'px');
      closeTones();
      // Back to the emoji the user was at: a new cell size moves every column.
      if(a&&!document.body.className)window.scrollTo(a.offsetLeft-pad,0)}
    function recents(html){secs[0].innerHTML=html;report()}
    function mode(searching){closeTones();document.body.className=searching?'q':'';window.scrollTo(0,0);cur=-1;report()}
    function results(html){closeTones();strip.innerHTML=html;window.scrollTo(0,0)}
    function go(i){var s=secs[i];if(s&&s.offsetWidth){closeTones();window.scrollTo(s.offsetLeft-pad,0)}}
    function setTone(b,s){
      var all=document.querySelectorAll('button.emoji[b]:not([r])');
      for(var k=0;k<all.length;k++)if(all[k].getAttribute('b')===b)all[k].textContent=s}
    function showTones(options,selected){
      if(!held)return;
      tones.textContent='';
      options.forEach(function(s){var e=document.createElement('button');e.type='button';e.textContent=s;if(s===selected)e.className='on';tones.appendChild(e)});
      tones.style.display='flex';
      var r=held.getBoundingClientRect(),w=tones.offsetWidth,h=tones.offsetHeight;
      // Above the emoji when there is room, else below it, else (the search strip) over it.
      var y=r.top-h-4;if(y<2)y=r.bottom+4;if(y+h>innerHeight)y=Math.max(0,(innerHeight-h)/2);
      tones.style.left=Math.min(Math.max(4,r.left+r.width/2-w/2),Math.max(4,innerWidth-w-4))+'px';
      tones.style.top=y+'px'}
    post({t:'ready'});
    """

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
    guard !isSearching, itemCount(in: section) > 0 else { return }
    run("go", section)
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

  // MARK: Layout

  override func didMoveToWindow() {
    super.didMoveToWindow()
    guard window != nil else {
      stopDeleting()
      return
    }
    reloadRecents()
    if webView == nil {
      // Only now: a keyboard that never opens the panel never starts a web view for it.
      let webView = makeWebView()
      insertSubview(webView, belowSubview: emptyLabel)
      self.webView = webView
      setNeedsLayout()
      loadPage()
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

    let content = CGRect(
      x: 0, y: rowHeight, width: bounds.width, height: max(0, bounds.height - rowHeight - barHeight)
    )
    webView?.frame = content
    emptyLabel.frame = content
    updatePageMetrics()
  }
}

/// Hands the page's messages to the panel without the web view's configuration keeping the
/// panel alive (a user content controller retains its handlers).
private final class EmojiMessageHandler: NSObject, WKScriptMessageHandler {
  weak var target: EmojiPanelView?

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    MainActor.assumeIsolated { target?.handle(message.body) }
  }
}
