import Foundation

enum DirectAudioRoute {
  /// True when recording in the keyboard would disturb the user's audio: on a real phone,
  /// WebKit's capture paused other audio for good, where the app's own recording mixes with it
  /// (and keeps AirPods with high-quality recording at full quality). Then the keyboard uses the
  /// handoff. Bluetooth output
  /// alone doesn't block: with nothing playing, AirPods dropping to call quality for the take
  /// costs the user nothing.
  static func blocksDirectCapture(otherAudioPlaying: Bool) -> Bool {
    otherAudioPlaying
  }
}
