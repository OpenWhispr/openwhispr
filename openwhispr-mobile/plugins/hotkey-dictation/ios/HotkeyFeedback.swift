import AudioToolbox
import Foundation
import UserNotifications

/// Status for a dictation started from a hardware-keyboard shortcut. iPad has no
/// Dynamic Island, so the Live Activity is invisible while typing: chimes carry
/// start/stop, and a banner reports the result without taking focus.
enum HotkeyFeedback {
  private static let bannerId = "hotkey-dictation-status"
  private static let bannerLifetime: TimeInterval = 4

  /// iOS's own begin/end-recording sounds.
  static func playBegin() { AudioServicesPlaySystemSound(1113) }
  static func playEnd() { AudioServicesPlaySystemSound(1114) }

  /// Main thread only.
  private static var generations = BannerGenerations()

  /// Replaces the previous banner, then clears it from Notification Center.
  /// Skipped without notification permission; the chimes still play.
  static func show(_ banner: HotkeyBanner) {
    let center = UNUserNotificationCenter.current()
    center.getNotificationSettings { settings in
      let allowed: Set<UNAuthorizationStatus> = [.authorized, .provisional, .ephemeral]
      guard allowed.contains(settings.authorizationStatus) else {
        HotkeyDictationSession.log.info("banner.skippedNoPermission")
        return
      }
      DispatchQueue.main.async {
        let generation = generations.next()
        let content = UNMutableNotificationContent()
        content.title = "OpenWhispr"
        content.body = banner.body
        content.threadIdentifier = bannerId
        content.interruptionLevel = .active
        center.removeDeliveredNotifications(withIdentifiers: [bannerId])
        center.add(UNNotificationRequest(identifier: bannerId, content: content, trigger: nil))
        // A newer banner reuses the identifier; its own timer clears it.
        DispatchQueue.main.asyncAfter(deadline: .now() + bannerLifetime) {
          guard generations.isCurrent(generation) else { return }
          center.removeDeliveredNotifications(withIdentifiers: [bannerId])
        }
      }
    }
  }
}
