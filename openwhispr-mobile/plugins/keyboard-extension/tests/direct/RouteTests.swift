import Foundation

extension DirectDictationTests {
  /// On Chad's phone, recording in the keyboard paused music for good, so the keyboard steps
  /// aside while other audio plays. Bluetooth output alone doesn't: with nothing playing,
  /// AirPods dropping to call quality for the take costs the user nothing.
  static func testRoute() {
    typealias R = DirectAudioRoute
    expect(R.blocksDirectCapture(otherAudioPlaying: true), true, "music playing")
    expect(R.blocksDirectCapture(otherAudioPlaying: false), false, "nothing playing, any output")

    let bluetooth = R.bluetoothStartTimeout
    let standard = R.defaultStartTimeout
    expect(R.startTimeout(portTypes: ["Speaker"]), standard, "speaker: default start timeout")
    expect(R.startTimeout(portTypes: ["MicrophoneBuiltIn", "Receiver"]), standard, "built-in mic: default")
    expect(R.startTimeout(portTypes: ["Headphones"]), standard, "wired headphones: default")
    expect(R.startTimeout(portTypes: ["CarAudio"]), standard, "CarPlay: default")
    expect(R.startTimeout(portTypes: []), standard, "no route: default")
    expect(R.startTimeout(portTypes: ["BluetoothA2DPOutput"]), bluetooth, "AirPods (A2DP): longer")
    expect(R.startTimeout(portTypes: ["BluetoothHFP"]), bluetooth, "Bluetooth HFP: longer")
    expect(R.startTimeout(portTypes: ["BluetoothLE"]), bluetooth, "Bluetooth LE: longer")
    expect(R.startTimeout(portTypes: ["MicrophoneBuiltIn", "BluetoothA2DPOutput"]), bluetooth,
           "Bluetooth output with the built-in mic: longer")
    expect(bluetooth > standard, true, "Bluetooth gets more time")
  }
}
