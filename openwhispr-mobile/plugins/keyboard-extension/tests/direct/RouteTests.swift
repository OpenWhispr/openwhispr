import Foundation

extension DirectDictationTests {
  /// On Chad's phone, recording in the keyboard paused music for good and degraded AirPods,
  /// so the keyboard steps aside in both cases.
  static func testRoute() {
    typealias R = DirectAudioRoute
    expect(R.blocksDirectCapture(otherAudioPlaying: true, outputPortTypes: ["Speaker"]), true, "music on the speaker")
    expect(R.blocksDirectCapture(otherAudioPlaying: false, outputPortTypes: ["Speaker"]), false, "nothing playing, speaker")
    expect(R.blocksDirectCapture(otherAudioPlaying: false, outputPortTypes: ["Receiver"]), false, "nothing playing, receiver")
    expect(R.blocksDirectCapture(otherAudioPlaying: false, outputPortTypes: ["BluetoothA2DPOutput"]), true, "AirPods (A2DP)")
    expect(R.blocksDirectCapture(otherAudioPlaying: false, outputPortTypes: ["BluetoothHFP"]), true, "Bluetooth HFP")
    expect(R.blocksDirectCapture(otherAudioPlaying: false, outputPortTypes: ["BluetoothLE"]), true, "Bluetooth LE")
    expect(R.blocksDirectCapture(otherAudioPlaying: false, outputPortTypes: ["Headphones"]), false, "wired headphones")
    expect(R.blocksDirectCapture(otherAudioPlaying: false, outputPortTypes: ["Headphones", "BluetoothA2DPOutput"]), true,
           "any Bluetooth output")
    expect(R.blocksDirectCapture(otherAudioPlaying: false, outputPortTypes: []), false, "no outputs")
  }
}
