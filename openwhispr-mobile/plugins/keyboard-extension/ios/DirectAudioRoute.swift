import Foundation

enum DirectAudioRoute {
  // The raw values of AVAudioSession.Port's Bluetooth ports, so this file needs no AVFoundation.
  private static let bluetoothPorts: Set<String> = ["BluetoothA2DPOutput", "BluetoothHFP", "BluetoothLE"]

  static let defaultStartTimeout: TimeInterval = 3
  static let bluetoothStartTimeout: TimeInterval = 8

  /// How long capture may take to start before the take is dropped and the path turned off.
  /// On a phone, WebKit started in under half a second on the built-in mic but took about 2 s
  /// over AirPods, and a car kit or an older headset bringing up its call link can take longer.
  /// A start that fails outright still fails at once, whatever the route.
  static func startTimeout(portTypes: [String]) -> TimeInterval {
    portTypes.contains(where: bluetoothPorts.contains) ? bluetoothStartTimeout : defaultStartTimeout
  }

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
