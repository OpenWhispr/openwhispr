import Foundation

/// An app the keyboard handoff can send the user back to: the URL that opens
/// it and the name the "Back to <App>" button shows.
struct HostApp: Equatable {
  let returnUrl: String
  let name: String
}

enum HostAppCatalog {
  static let entries: [String: HostApp] = [
    "com.whatsapp.WhatsApp": HostApp(returnUrl: "whatsapp://send", name: "WhatsApp"),
    "net.whatsapp.WhatsApp": HostApp(returnUrl: "whatsapp://send", name: "WhatsApp"),
    "net.whatsapp.WhatsAppSMB": HostApp(returnUrl: "whatsapp-business://", name: "WhatsApp Business"),
    "com.burbn.instagram": HostApp(returnUrl: "instagram://", name: "Instagram"),
    "com.atebits.Tweetie2": HostApp(returnUrl: "twitter://", name: "X"),
    "com.facebook.Facebook": HostApp(returnUrl: "fb://", name: "Facebook"),
    "com.facebook.Messenger": HostApp(returnUrl: "fb-messenger://", name: "Messenger"),
    "com.tinyspeck.chatlyio": HostApp(returnUrl: "slack://", name: "Slack"),
    "com.skype.skype": HostApp(returnUrl: "skype://", name: "Skype"),
    "ph.telegra.Telegraph": HostApp(returnUrl: "tg://", name: "Telegram"),
    "org.whispersystems.signal": HostApp(returnUrl: "sgnl://", name: "Signal"),
    "com.viber": HostApp(returnUrl: "viber://", name: "Viber"),
    "jp.naver.line": HostApp(returnUrl: "line://", name: "LINE"),
    "com.google.Gmail": HostApp(returnUrl: "googlegmail://", name: "Gmail"),
    "com.google.Docs": HostApp(returnUrl: "googledocs://", name: "Google Docs"),
    "com.microsoft.Office.Outlook": HostApp(returnUrl: "ms-outlook://", name: "Outlook"),
    "com.microsoft.skype.teams": HostApp(returnUrl: "msteams://", name: "Teams"),
    "com.apple.mobilemail": HostApp(returnUrl: "message://", name: "Mail"),
    "com.apple.MobileSMS": HostApp(returnUrl: "sms://", name: "Messages"),
    "com.apple.mobilenotes": HostApp(returnUrl: "mobilenotes://", name: "Notes"),
    "com.microsoft.teams": HostApp(returnUrl: "msteams://", name: "Teams"),
    "notion.id": HostApp(returnUrl: "notion://", name: "Notion"),
    "com.discord.Discord": HostApp(returnUrl: "discord://", name: "Discord"),
    "com.linkedin.LinkedIn": HostApp(returnUrl: "linkedin://", name: "LinkedIn"),
    "com.reddit.Reddit": HostApp(returnUrl: "reddit://", name: "Reddit"),
    "com.hammerandchisel.discord": HostApp(returnUrl: "discord://", name: "Discord"),
    "us.zoom.videomeetings": HostApp(returnUrl: "zoomus://", name: "Zoom"),
    "com.openai.chat": HostApp(returnUrl: "chatgpt://", name: "ChatGPT"),
    "com.google.chrome.ios": HostApp(returnUrl: "googlechrome://", name: "Chrome"),
    "com.apple.mobilesafari": HostApp(returnUrl: "x-web-search://", name: "Safari"),
    "com.zhiliaoapp.musically": HostApp(returnUrl: "snssdk1128://", name: "TikTok"),
    "com.snapchat.snapchat": HostApp(returnUrl: "snapchat://", name: "Snapchat"),
    "com.toyopagroup.picaboo": HostApp(returnUrl: "snapchat://", name: "Snapchat"),
  ]

  private static let normalizedEntries: [String: HostApp] = {
    var normalized: [String: HostApp] = [:]
    for (bundle, app) in entries {
      normalized[bundle.lowercased()] = app
    }
    return normalized
  }()

  static func lookup(_ bundle: String?) -> HostApp? {
    guard let trimmed = bundle?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
      return nil
    }
    return entries[trimmed] ?? normalizedEntries[trimmed.lowercased()]
  }
}

enum ReturnTargetSource: String {
  case extensionUrl = "extension_url"
  case extensionBundle = "extension_bundle"
  case observer
}

struct ReturnTarget: Equatable {
  let url: URL
  let hostName: String?
  let source: ReturnTargetSource
}

enum ReturnOutcomeStatus: String {
  case opened
  case failed
  case noTarget = "no_target"
  case skipped
}

struct ReturnOutcome {
  let status: ReturnOutcomeStatus
  let hostName: String?

  var payload: [String: Any] {
    var result: [String: Any] = ["status": status.rawValue]
    if let hostName {
      result["hostName"] = hostName
    }
    return result
  }
}

enum ReturnTargetResolver {
  /// How long before a return request an observed host still belongs to this
  /// handoff. Keeps a warm launch from returning to an app the user left minutes ago.
  static let observerLookBack: TimeInterval = 5
  /// How long a return waits for the observer. On a cold launch the host arrives
  /// about a second after the keyboard opens the app, usually after JS asks to return.
  static let observerWaitTimeout: TimeInterval = 2
  /// Longest a return may stay in flight. Covers the observer wait plus the
  /// cold-launch retries, and ends well before JS's 6 s timeout (the main-queue
  /// hop can lag on a cold launch) so JS still gets the real outcome rather
  /// than its own fallback.
  static let returnDeadline: TimeInterval = 4.5

  /// The extension's own detection wins (it still works before iOS 26.4). The
  /// observer only stands in when the extension saw no host: a host it named
  /// but that isn't in the catalog is still that host, not the last one observed.
  static func resolve(extensionUrl: String?, extensionBundle: String?, observedBundle: String?) -> ReturnTarget? {
    let extensionHost = HostAppCatalog.lookup(extensionBundle)
    if let rawUrl = extensionUrl, let url = normalizeReturnUrl(rawUrl) {
      return ReturnTarget(url: url, hostName: extensionHost?.name, source: .extensionUrl)
    }
    if let host = extensionHost, let url = URL(string: host.returnUrl) {
      return ReturnTarget(url: url, hostName: host.name, source: .extensionBundle)
    }
    if !extensionSawHost(extensionBundle), let host = HostAppCatalog.lookup(observedBundle),
       let url = URL(string: host.returnUrl) {
      return ReturnTarget(url: url, hostName: host.name, source: .observer)
    }
    return nil
  }

  /// The extension names its host before iOS 26.4. When it did, waiting on the
  /// observer would only name the same host again.
  static func extensionSawHost(_ extensionBundle: String?) -> Bool {
    !(extensionBundle?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
  }

  static func normalizeReturnUrl(_ rawUrl: String) -> URL? {
    let trimmed = rawUrl.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      return nil
    }
    let normalized =
      trimmed.caseInsensitiveCompare("whatsapp://") == .orderedSame ? "whatsapp://send" : trimmed
    return URL(string: normalized)
  }

  static func isFresh(observedAt: Date, invokedAt: Date) -> Bool {
    observedAt >= invokedAt.addingTimeInterval(-observerLookBack)
  }

  /// The containing app and its extensions host the keyboard in place, so they
  /// are never a return target. Mirrors the keyboard's `isContainingAppBundle`.
  static func isContainingApp(_ bundle: String, appBundle: String) -> Bool {
    let host = bundle.lowercased()
    let app = appBundle.lowercased()
    guard !app.isEmpty else { return false }
    return host == app || host.hasPrefix(app + ".")
  }

  /// A cold launch can fail `open` while the app is still becoming active, and
  /// retrying is safe. An `open` made while the app was already active is final:
  /// iOS returns false when the user cancels its "wants to open" prompt, and a
  /// retry would show it again. The state is sampled before the call because the
  /// app is inactive while that prompt is up, so afterwards the two cases look alike.
  static func shouldRetry(openSucceeded: Bool, appWasActive: Bool, retriesLeft: Int) -> Bool {
    !openSucceeded && !appWasActive && retriesLeft > 0
  }
}

/// One return in flight at a time, finished exactly once, and never longer than
/// its deadline: a hung `open` completion must not leave every later handoff
/// refused as `skipped` (and stuck on "Returning…").
final class ReturnAttemptGate {
  private var current: ReturnAttempt?

  var isInFlight: Bool { current.map { !$0.isFinished } ?? false }

  /// Starts an attempt, or returns nil while another is in flight. `schedule`
  /// runs the deadline (the main queue in the app).
  func begin(
    deadline: TimeInterval,
    schedule: (TimeInterval, @escaping () -> Void) -> Void,
    timeoutOutcome: @escaping () -> ReturnOutcome,
    completion: @escaping (ReturnOutcome) -> Void
  ) -> ReturnAttempt? {
    guard !isInFlight else { return nil }
    let attempt = ReturnAttempt(completion: completion)
    current = attempt
    schedule(deadline) {
      guard !attempt.isFinished else { return }
      attempt.finish(timeoutOutcome())
    }
    return attempt
  }
}

/// A single return's outcome, reported once. Work still queued for it (an
/// observer wait, an `open` retry) checks `isFinished` and stops once the
/// deadline has settled it, so it can't switch apps under a UI that moved on.
final class ReturnAttempt {
  private(set) var isFinished = false
  private let completion: (ReturnOutcome) -> Void

  init(completion: @escaping (ReturnOutcome) -> Void) {
    self.completion = completion
  }

  func finish(_ outcome: ReturnOutcome) {
    guard !isFinished else { return }
    isFinished = true
    completion(outcome)
  }
}
