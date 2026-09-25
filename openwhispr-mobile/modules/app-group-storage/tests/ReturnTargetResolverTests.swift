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
    gateAllowsOneAttemptAtATime()
    gateDeadlineEndsAHungAttempt()
    lateFinishFromAnOldAttemptLeavesTheNewOneInFlight()
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
    precondition(ReturnTargetResolver.shouldRetry(openSucceeded: false, appWasActive: false, retriesLeft: 2), "an open made while still launching retries")
    precondition(!ReturnTargetResolver.shouldRetry(openSucceeded: false, appWasActive: true, retriesLeft: 2), "an open made while active is final (prompt cancelled)")
    precondition(!ReturnTargetResolver.shouldRetry(openSucceeded: false, appWasActive: false, retriesLeft: 0), "no retries left")
    precondition(!ReturnTargetResolver.shouldRetry(openSucceeded: true, appWasActive: false, retriesLeft: 2), "success never retries")
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

  static func startGate(
    _ gate: ReturnAttemptGate,
    scheduled: @escaping (TimeInterval, @escaping () -> Void) -> Void,
    timeout: ReturnOutcome,
    completion: @escaping (ReturnOutcome) -> Void
  ) -> ((ReturnOutcome) -> Void)? {
    gate.begin(deadline: ReturnTargetResolver.returnDeadline, schedule: scheduled, timeoutOutcome: { timeout }, completion: completion)
  }

  static func gateAllowsOneAttemptAtATime() {
    let gate = ReturnAttemptGate()
    var outcomes: [ReturnOutcomeStatus] = []
    let finish = startGate(gate, scheduled: { _, _ in }, timeout: ReturnOutcome(status: .noTarget, hostName: nil)) {
      outcomes.append($0.status)
    }
    precondition(finish != nil, "the first attempt starts")
    let second = startGate(gate, scheduled: { _, _ in }, timeout: ReturnOutcome(status: .noTarget, hostName: nil)) { _ in }
    precondition(second == nil, "a second attempt is refused while one is in flight")
    finish?(ReturnOutcome(status: .opened, hostName: "Slack"))
    finish?(ReturnOutcome(status: .failed, hostName: "Slack"))
    precondition(outcomes == [.opened], "an attempt finishes exactly once")
    precondition(!gate.isInFlight, "finishing frees the gate")
  }

  static func gateDeadlineEndsAHungAttempt() {
    let gate = ReturnAttemptGate()
    var deadlines: [(TimeInterval, () -> Void)] = []
    var outcomes: [ReturnOutcome] = []
    let finish = startGate(gate, scheduled: { deadlines.append(($0, $1)) }, timeout: ReturnOutcome(status: .failed, hostName: "Slack")) {
      outcomes.append($0)
    }
    precondition(deadlines.count == 1 && deadlines[0].0 == ReturnTargetResolver.returnDeadline, "the deadline is scheduled")
    precondition(ReturnTargetResolver.returnDeadline < 5, "native gives up before JS's 5 s timeout so JS sees the real outcome")
    deadlines[0].1()
    precondition(outcomes.map(\.status) == [.failed] && outcomes.first?.hostName == "Slack", "the deadline resolves failed with the host")
    precondition(!gate.isInFlight, "the deadline frees the gate for the next handoff")
    finish?(ReturnOutcome(status: .opened, hostName: "Slack"))
    precondition(outcomes.count == 1, "a late real outcome is ignored")
  }

  static func lateFinishFromAnOldAttemptLeavesTheNewOneInFlight() {
    let gate = ReturnAttemptGate()
    var deadlines: [() -> Void] = []
    let first = startGate(gate, scheduled: { deadlines.append($1) }, timeout: ReturnOutcome(status: .noTarget, hostName: nil)) { _ in }
    deadlines[0]()
    let second = startGate(gate, scheduled: { _, _ in }, timeout: ReturnOutcome(status: .noTarget, hostName: nil)) { _ in }
    precondition(second != nil, "a new attempt starts after the old one timed out")
    first?(ReturnOutcome(status: .opened, hostName: "Slack"))
    precondition(gate.isInFlight, "the old attempt's late completion must not free the new one")
  }
}
