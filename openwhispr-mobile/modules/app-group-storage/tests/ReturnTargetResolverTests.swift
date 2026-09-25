import Foundation

@main
struct ReturnTargetResolverTests {
  static func main() {
    extensionUrlWinsAndKeepsTheBundleName()
    bareWhatsAppUrlIsNormalized()
    blankExtensionUrlFallsThroughToExtensionBundle()
    extensionBundleLookupIgnoresCaseAndWhitespace()
    observerIsUsedWhenTheExtensionKnowsNothing()
    unknownObservedBundleResolvesNothing()
    nothingKnownResolvesNothing()
    staleObservationIsIgnored()
    containingAppAndItsExtensionsAreNeverTheHost()
    shouldRetryOnlyWhileLaunching()
    outcomePayloadOmitsMissingHostName()
    everyCatalogEntryOpens()
    print("ReturnTargetResolverTests: all passed")
  }

  static func extensionUrlWinsAndKeepsTheBundleName() {
    let target = ReturnTargetResolver.resolve(
      extensionUrl: "slack://", extensionBundle: "com.tinyspeck.chatlyio", observedBundle: "com.apple.MobileSMS")
    precondition(target?.url.absoluteString == "slack://", "extension URL must win")
    precondition(target?.hostName == "Slack", "name comes from the extension bundle")
    precondition(target?.source == .extensionUrl, "source is the extension URL")
  }

  static func bareWhatsAppUrlIsNormalized() {
    let target = ReturnTargetResolver.resolve(
      extensionUrl: " WhatsApp:// ", extensionBundle: nil, observedBundle: nil)
    precondition(target?.url.absoluteString == "whatsapp://send", "bare whatsapp:// opens the send screen")
  }

  static func blankExtensionUrlFallsThroughToExtensionBundle() {
    let target = ReturnTargetResolver.resolve(
      extensionUrl: "  ", extensionBundle: "com.apple.MobileSMS", observedBundle: nil)
    precondition(target?.url.absoluteString == "sms://", "blank URL falls through to the bundle")
    precondition(target?.source == .extensionBundle, "source is the extension bundle")
    precondition(target?.hostName == "Messages", "Messages name")
  }

  static func extensionBundleLookupIgnoresCaseAndWhitespace() {
    precondition(HostAppCatalog.lookup(" COM.TINYSPECK.CHATLYIO\n")?.name == "Slack", "case/whitespace-insensitive")
    precondition(HostAppCatalog.lookup(nil) == nil, "nil bundle")
    precondition(HostAppCatalog.lookup("") == nil, "empty bundle")
  }

  static func observerIsUsedWhenTheExtensionKnowsNothing() {
    let target = ReturnTargetResolver.resolve(
      extensionUrl: nil, extensionBundle: nil, observedBundle: "com.tinyspeck.chatlyio")
    precondition(target?.url.absoluteString == "slack://", "observer bundle resolves")
    precondition(target?.source == .observer, "source is the observer")
    precondition(target?.hostName == "Slack", "observer host name")
  }

  static func unknownObservedBundleResolvesNothing() {
    precondition(
      ReturnTargetResolver.resolve(extensionUrl: nil, extensionBundle: nil, observedBundle: "com.example.unknown") == nil,
      "a host outside the catalog has no return URL")
  }

  static func nothingKnownResolvesNothing() {
    precondition(
      ReturnTargetResolver.resolve(extensionUrl: nil, extensionBundle: nil, observedBundle: nil) == nil,
      "no inputs, no target")
  }

  static func staleObservationIsIgnored() {
    let invokedAt = Date(timeIntervalSince1970: 1_000)
    precondition(ReturnTargetResolver.isFresh(observedAt: invokedAt.addingTimeInterval(-4.9), invokedAt: invokedAt), "4.9 s before is fresh")
    precondition(!ReturnTargetResolver.isFresh(observedAt: invokedAt.addingTimeInterval(-5.1), invokedAt: invokedAt), "5.1 s before is stale")
    precondition(ReturnTargetResolver.isFresh(observedAt: invokedAt.addingTimeInterval(1.0), invokedAt: invokedAt), "after the request is fresh")
  }

  static func containingAppAndItsExtensionsAreNeverTheHost() {
    let app = "com.chadpiha.openwhispr"
    precondition(ReturnTargetResolver.isContainingApp("com.chadpiha.openwhispr", appBundle: app), "own app")
    precondition(ReturnTargetResolver.isContainingApp("COM.CHADPIHA.OPENWHISPR.keyboard", appBundle: app), "own extension")
    precondition(!ReturnTargetResolver.isContainingApp("com.chadpiha.openwhisprx", appBundle: app), "prefix without dot is another app")
    precondition(!ReturnTargetResolver.isContainingApp("com.tinyspeck.chatlyio", appBundle: app), "Slack")
    precondition(!ReturnTargetResolver.isContainingApp("com.tinyspeck.chatlyio", appBundle: ""), "unknown own bundle")
  }

  static func shouldRetryOnlyWhileLaunching() {
    precondition(ReturnTargetResolver.shouldRetry(openSucceeded: false, appIsActive: false, retriesLeft: 2), "cold-launch failure retries")
    precondition(!ReturnTargetResolver.shouldRetry(openSucceeded: false, appIsActive: true, retriesLeft: 2), "failure while active (prompt cancelled) is final")
    precondition(!ReturnTargetResolver.shouldRetry(openSucceeded: false, appIsActive: false, retriesLeft: 0), "no retries left")
    precondition(!ReturnTargetResolver.shouldRetry(openSucceeded: true, appIsActive: false, retriesLeft: 2), "success never retries")
  }

  static func outcomePayloadOmitsMissingHostName() {
    let opened = ReturnOutcome(status: .opened, hostName: "Slack").payload
    precondition(opened["status"] as? String == "opened" && opened["hostName"] as? String == "Slack", "opened payload")
    let none = ReturnOutcome(status: .noTarget, hostName: nil).payload
    precondition(none["status"] as? String == "no_target" && none["hostName"] == nil, "no_target payload")
  }

  static func everyCatalogEntryOpens() {
    for (bundle, app) in HostAppCatalog.entries {
      precondition(URL(string: app.returnUrl) != nil, "\(bundle) has an unparseable URL")
      precondition(!app.name.isEmpty, "\(bundle) has no name")
    }
  }
}
