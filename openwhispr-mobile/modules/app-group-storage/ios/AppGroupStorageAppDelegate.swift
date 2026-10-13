import ExpoModulesCore
import UIKit

/// Starts HostAppObserver before JS loads. On a cold launch from the keyboard
/// the host arrives about a second after launch and is gone once processed.
public class AppGroupStorageAppDelegate: ExpoAppDelegateSubscriber {
  public required init() {}

  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    HostAppObserver.shared.start()
    return true
  }
}
