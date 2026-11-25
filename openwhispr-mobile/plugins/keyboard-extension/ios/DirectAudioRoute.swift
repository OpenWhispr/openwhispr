import Foundation

enum DirectAudioRoute {
  // The raw values of AVAudioSession.Port's Bluetooth outputs, so this file needs no AVFoundation.
  private static let bluetoothOutputs: Set<String> = ["BluetoothA2DPOutput", "BluetoothHFP", "BluetoothLE"]

  /// True when recording in the keyboard would disturb the user's audio: on a real phone
  /// WebKit's capture paused other audio for good and dropped AirPods to call quality, where
  /// the app's own recording mixes with it. Then the keyboard uses today's handoff.
  static func blocksDirectCapture(otherAudioPlaying: Bool, outputPortTypes: [String]) -> Bool {
    otherAudioPlaying || outputPortTypes.contains(where: bluetoothOutputs.contains)
  }
}
