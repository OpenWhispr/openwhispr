import Foundation

/// The code `start` rejects with for an error thrown while starting capture. Foundation-only so
/// the mapping can be tested off-device.
enum StartRejection {
  // AVAudioSession refuses to activate while a phone call (or another app with priority) holds
  // the audio session: '!pri' insufficientPriority and '!int' cannotInterruptOthers. Raw values
  // because AVFAudio isn't available here; the session reports them as OSStatus codes.
  static let insufficientPriority = 561_017_449
  static let cannotInterruptOthers = 560_557_684
  // Where the refusal arrives depends on how the SDK bridges it, so both are accepted.
  static let sessionErrorDomains: Set<String> = [NSOSStatusErrorDomain, "AVAudioSessionErrorDomain"]

  /// `MIC_UNAVAILABLE` when the audio session refused to activate, else `PCM_START_FAILED`.
  static func code(for error: Error) -> String {
    let nsError = error as NSError
    guard sessionErrorDomains.contains(nsError.domain) else { return "PCM_START_FAILED" }
    switch nsError.code {
    case insufficientPriority, cannotInterruptOthers: return "MIC_UNAVAILABLE"
    default: return "PCM_START_FAILED"
    }
  }
}
