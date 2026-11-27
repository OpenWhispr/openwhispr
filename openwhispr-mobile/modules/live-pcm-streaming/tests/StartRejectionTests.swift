import Foundation

@main
struct StartRejectionTests {
  static func main() {
    aRefusedActivationIsMicUnavailable()
    aRefusalInEitherDomainCounts()
    otherSessionErrorsStayStartFailures()
    theSameCodeInAnotherDomainIsAStartFailure()
    print("StartRejectionTests: all passed")
  }

  static func expect(_ condition: Bool, _ message: String) {
    precondition(condition, message)
  }

  static func aRefusedActivationIsMicUnavailable() {
    // '!pri': a phone call holds the audio session.
    let priority = NSError(domain: NSOSStatusErrorDomain, code: 561_017_449)
    expect(StartRejection.code(for: priority) == "MIC_UNAVAILABLE", "insufficient priority")
    // '!int': the session may not interrupt the app that holds audio.
    let interrupt = NSError(domain: NSOSStatusErrorDomain, code: 560_557_684)
    expect(StartRejection.code(for: interrupt) == "MIC_UNAVAILABLE", "cannot interrupt others")
  }

  static func aRefusalInEitherDomainCounts() {
    let error = NSError(domain: "AVAudioSessionErrorDomain", code: 561_017_449)
    expect(StartRejection.code(for: error) == "MIC_UNAVAILABLE", "AVAudioSession domain")
  }

  static func otherSessionErrorsStayStartFailures() {
    // '!rec': the category has no input; not something a call explains.
    let error = NSError(domain: NSOSStatusErrorDomain, code: 561_145_187)
    expect(StartRejection.code(for: error) == "PCM_START_FAILED", "other OSStatus")
    expect(
      StartRejection.code(for: CocoaError(.fileNoSuchFile)) == "PCM_START_FAILED",
      "non-session error"
    )
  }

  static func theSameCodeInAnotherDomainIsAStartFailure() {
    let error = NSError(domain: NSPOSIXErrorDomain, code: 561_017_449)
    expect(StartRejection.code(for: error) == "PCM_START_FAILED", "POSIX domain")
  }
}
