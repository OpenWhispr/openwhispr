import UIKit

/// Learns which app opened a keyboard handoff.
///
/// iOS 26.4 stopped telling the keyboard extension its host (`_hostBundleID`
/// returns "<null>"). UIKit in the containing app still receives the remote
/// keyboard's source bundle in `_UIRemoteKeyboards.currentState`, about a second
/// after the keyboard opens the app. The value is transient (cleared once
/// processed), so it is observed from launch, never polled.
///
/// This is a UIKit implementation detail, not API. Every hop is checked; when
/// one is missing the observer stays inert and returns fall back to the swipe screen.
final class HostAppObserver: NSObject {
  static let shared = HostAppObserver()

  private(set) var isAvailable = false
  private var remoteKeyboards: NSObject?
  private var lastBundle: String?
  private var lastObservedAt: Date?
  private var waiters: [UUID: Waiter] = [:]

  private struct Waiter {
    let since: Date
    let completion: (String?) -> Void
  }

  func start() {
    dispatchPrecondition(condition: .onQueue(.main))
    guard remoteKeyboards == nil else { return }
    guard let remoteKeyboardsClass = NSClassFromString("_UIRemoteKeyboards") as? NSObject.Type else {
      log("unavailable: no _UIRemoteKeyboards")
      return
    }
    let sharedSelector = NSSelectorFromString("sharedRemoteKeyboards")
    guard remoteKeyboardsClass.responds(to: sharedSelector),
          let shared = remoteKeyboardsClass.perform(sharedSelector)?.takeUnretainedValue() as? NSObject,
          shared.responds(to: NSSelectorFromString("currentState"))
    else {
      log("unavailable: no sharedRemoteKeyboards.currentState")
      return
    }
    remoteKeyboards = shared
    shared.addObserver(self, forKeyPath: "currentState", options: [.new, .initial], context: nil)
    isAvailable = true
    log("installed")
  }

  func latest(since: Date) -> String? {
    guard let lastBundle, let lastObservedAt, lastObservedAt >= since else { return nil }
    return lastBundle
  }

  func waitForHost(since: Date, timeout: TimeInterval, completion: @escaping (String?) -> Void) {
    dispatchPrecondition(condition: .onQueue(.main))
    if let bundle = latest(since: since) {
      completion(bundle)
      return
    }
    guard isAvailable else {
      completion(nil)
      return
    }
    let id = UUID()
    waiters[id] = Waiter(since: since, completion: completion)
    DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak self] in
      guard let waiter = self?.waiters.removeValue(forKey: id) else { return }
      waiter.completion(nil)
    }
  }

  override func observeValue(
    forKeyPath keyPath: String?,
    of object: Any?,
    change: [NSKeyValueChangeKey: Any]?,
    context: UnsafeMutableRawPointer?
  ) {
    // NSNull (cleared state) is an NSObject that doesn't respond, so it reads as nil.
    let state = change?[.newKey] as? NSObject
    let sourceSelector = NSSelectorFromString("sourceBundleIdentifier")
    let bundle = state?.responds(to: sourceSelector) == true
      ? state?.perform(sourceSelector)?.takeUnretainedValue() as? String
      : nil
    DispatchQueue.main.async { self.record(bundle) }
  }

  private func record(_ rawBundle: String?) {
    guard let bundle = rawBundle?.trimmingCharacters(in: .whitespacesAndNewlines), !bundle.isEmpty,
          !ReturnTargetResolver.isContainingApp(bundle, appBundle: Bundle.main.bundleIdentifier ?? "")
    else { return }
    let observedAt = Date()
    lastBundle = bundle
    lastObservedAt = observedAt
    log("detected \(bundle)")
    for (id, waiter) in waiters where observedAt >= waiter.since {
      waiters.removeValue(forKey: id)
      waiter.completion(bundle)
    }
  }

  private func log(_ message: String) {
    #if DEBUG
    NSLog("[HostAppObserver] %@", message)
    #endif
  }
}
