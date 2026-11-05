// MARK: - Scene life cycle (plugins/scene-lifecycle)
//
// Appended to AppDelegate.swift by withSceneLifecycle, which supplies the imports (Expo, React).
//
// Apps built with the iOS 27 SDK must adopt the scene-based life cycle (Apple TN3187): UIKit
// asserts while connecting the first scene otherwise. Ported from Expo SDK 58's
// ExpoAppSceneDelegate and SceneEventForwarder; drop the plugin once the app is on an Expo SDK
// whose template ships its own SceneDelegate.
//
// Under scenes UIKit stops calling the app delegate's URL, user-activity, life-cycle and
// quick-action methods. This delegate hands every such event back to AppDelegate, whose overrides
// (AppsFlyer, RCTLinkingManager) and ExpoAppDelegate subscribers (expo-linking, expo-router,
// expo-dev-launcher) then run exactly as before.

@objc(SceneDelegate)
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene else {
      return
    }
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate,
      let factory = appDelegate.reactNativeFactory
    else {
      fatalError("SceneDelegate needs the React Native factory AppDelegate creates at launch.")
    }

    let window = UIWindow(windowScene: windowScene)
    self.window = window
    // Code that reads `UIApplication.shared.delegate?.window` (expo-updates, expo-system-ui)
    // keeps working.
    appDelegate.window = window

    // Linking.getInitialURL() only reads launch options, which no longer carry the URL or
    // activity that cold-started the app, so rebuild them from the connection options.
    let browsingWebActivity = connectionOptions.userActivities.first {
      $0.activityType == NSUserActivityTypeBrowsingWeb
    }
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      initialProperties: nil,
      launchOptions: Self.launchOptions(
        url: connectionOptions.urlContexts.first?.url,
        userActivity: browsingWebActivity
      )
    )

    connectionOptions.urlContexts.forEach {
      SceneEventForwarder.open(url: $0.url, options: Self.openURLOptions(from: $0.options))
    }
    connectionOptions.userActivities.forEach { SceneEventForwarder.continue($0) }

    // A quick action that cold-starts the app arrives here, not in
    // windowScene(_:performActionFor:completionHandler:).
    if let shortcutItem = connectionOptions.shortcutItem {
      SceneEventForwarder.perform(shortcutItem) { _ in }
    }
  }

  func sceneDidDisconnect(_ scene: UIScene) {
    window = nil
  }

  func sceneDidBecomeActive(_ scene: UIScene) {
    SceneEventForwarder.appDelegate?.applicationDidBecomeActive(UIApplication.shared)
  }

  func sceneWillResignActive(_ scene: UIScene) {
    SceneEventForwarder.appDelegate?.applicationWillResignActive(UIApplication.shared)
  }

  func sceneWillEnterForeground(_ scene: UIScene) {
    SceneEventForwarder.appDelegate?.applicationWillEnterForeground(UIApplication.shared)
  }

  func sceneDidEnterBackground(_ scene: UIScene) {
    SceneEventForwarder.appDelegate?.applicationDidEnterBackground(UIApplication.shared)
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    URLContexts.forEach {
      SceneEventForwarder.open(url: $0.url, options: Self.openURLOptions(from: $0.options))
    }
  }

  func scene(_ scene: UIScene, willContinueUserActivityWithType userActivityType: String) {
    // The scene callback has no return value, so the app delegate's answer is ignored.
    _ = SceneEventForwarder.appDelegate?.application(
      UIApplication.shared,
      willContinueUserActivityWithType: userActivityType
    )
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    SceneEventForwarder.continue(userActivity)
  }

  func scene(
    _ scene: UIScene,
    didFailToContinueUserActivityWithType userActivityType: String,
    error: Error
  ) {
    SceneEventForwarder.appDelegate?.application(
      UIApplication.shared,
      didFailToContinueUserActivityWithType: userActivityType,
      error: error
    )
  }

  func scene(_ scene: UIScene, didUpdate userActivity: NSUserActivity) {
    SceneEventForwarder.appDelegate?.application(UIApplication.shared, didUpdate: userActivity)
  }

  func windowScene(
    _ windowScene: UIWindowScene,
    performActionFor shortcutItem: UIApplicationShortcutItem,
    completionHandler: @escaping (Bool) -> Void
  ) {
    SceneEventForwarder.perform(shortcutItem, completionHandler: completionHandler)
  }

  /// The launch options `Linking.getInitialURL()` reads, or nil when no URL or browsing-web
  /// activity started the app. Keys are spelled out because their UIApplication accessors are
  /// deprecated in favor of the scene APIs, while React Native still reads these exact keys.
  static func launchOptions(
    url: URL?,
    userActivity: NSUserActivity?
  ) -> [UIApplication.LaunchOptionsKey: Any]? {
    var launchOptions: [UIApplication.LaunchOptionsKey: Any] = [:]
    if let url {
      launchOptions[UIApplication.LaunchOptionsKey(rawValue: "UIApplicationLaunchOptionsURLKey")] = url
    }
    if let userActivity {
      let key = UIApplication.LaunchOptionsKey(
        rawValue: "UIApplicationLaunchOptionsUserActivityDictionaryKey"
      )
      launchOptions[key] = [
        "UIApplicationLaunchOptionsUserActivityTypeKey": userActivity.activityType,
        "UIApplicationLaunchOptionsUserActivityKey": userActivity,
      ]
    }
    return launchOptions.isEmpty ? nil : launchOptions
  }

  private static func openURLOptions(
    from sceneOptions: UIScene.OpenURLOptions
  ) -> [UIApplication.OpenURLOptionsKey: Any] {
    var options: [UIApplication.OpenURLOptionsKey: Any] = [:]
    if let sourceApplication = sceneOptions.sourceApplication {
      options[.sourceApplication] = sourceApplication
    }
    if let annotation = sceneOptions.annotation {
      options[.annotation] = annotation
    }
    options[.openInPlace] = sceneOptions.openInPlace
    return options
  }
}

/// Hands scene events to AppDelegate and makes sure React Native hears about each link once.
private enum SceneEventForwarder {
  static var appDelegate: AppDelegate? {
    UIApplication.shared.delegate as? AppDelegate
  }

  static func open(url: URL, options: [UIApplication.OpenURLOptionsKey: Any]) {
    let application = UIApplication.shared
    notifyLinkingManagerUnlessAlreadyNotified(of: url) {
      _ = appDelegate?.application(application, open: url, options: options)
    } notify: {
      RCTLinkingManager.application(application, open: url, options: options)
    }
  }

  static func `continue`(_ userActivity: NSUserActivity) {
    let application = UIApplication.shared
    // RCTLinkingManager only announces browsing-web activities, so other types have nothing to
    // dedupe against.
    notifyLinkingManagerUnlessAlreadyNotified(of: userActivity.webpageURL) {
      _ = appDelegate?.application(application, continue: userActivity, restorationHandler: { _ in })
    } notify: {
      RCTLinkingManager.application(application, continue: userActivity, restorationHandler: { _ in })
    }
  }

  /// UIKit waits on `completionHandler`, so it has to run exactly once.
  static func perform(
    _ shortcutItem: UIApplicationShortcutItem,
    completionHandler: @escaping (Bool) -> Void
  ) {
    guard let appDelegate else {
      completionHandler(false)
      return
    }
    appDelegate.application(
      UIApplication.shared,
      performActionFor: shortcutItem,
      completionHandler: completionHandler
    )
  }

  /// AppDelegate's open-URL override skips RCTLinkingManager when an Expo subscriber claims the
  /// link, so RCTLinkingManager is told directly unless AppDelegate already told it; telling it
  /// twice would fire the JS `url` event twice.
  private static func notifyLinkingManagerUnlessAlreadyNotified(
    of url: URL?,
    during body: () -> Void,
    notify: () -> Void
  ) {
    guard let url else {
      body()
      notify()
      return
    }
    let observer = LinkingManagerObserver(url: url)
    body()
    if !observer.wasNotified {
      notify()
    }
  }
}

/// Observes the notification RCTLinkingManager posts for every link it handles. The name is
/// private to React Native's RCTLinkingManager.mm (expo-router spells it out the same way); if
/// React Native renames it, a link is delivered twice, never lost.
private final class LinkingManagerObserver: NSObject {
  private let expectedURL: String
  private(set) var wasNotified = false

  init(url: URL) {
    expectedURL = url.absoluteString
    super.init()
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(linkingManagerDidOpenURL(_:)),
      name: Notification.Name("RCTOpenURLNotification"),
      object: nil
    )
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
  }

  @objc
  private func linkingManagerDidOpenURL(_ notification: Notification) {
    wasNotified = wasNotified || notification.userInfo?["url"] as? String == expectedURL
  }
}
