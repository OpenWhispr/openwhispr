import Foundation

extension DirectDictationTests {
  /// On Chad's phone, recording in the keyboard paused music for good, so the keyboard steps
  /// aside while other audio plays. Bluetooth output alone doesn't: with nothing playing,
  /// AirPods dropping to call quality for the take costs the user nothing.
  static func testRoute() {
    typealias R = DirectAudioRoute
    expect(R.blocksDirectCapture(otherAudioPlaying: true), true, "music playing")
    expect(R.blocksDirectCapture(otherAudioPlaying: false), false, "nothing playing, any output")
  }
}
