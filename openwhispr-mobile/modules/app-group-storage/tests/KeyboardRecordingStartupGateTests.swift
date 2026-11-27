import Foundation

@main
struct KeyboardRecordingStartupGateTests {
  static func main() {
    var gate = KeyboardRecordingStartupGate()
    precondition(!gate.requestStart(jobId: "cold", isReady: false), "cold start must wait for local startup")
    precondition(!gate.requestStart(jobId: "cold", isReady: false), "duplicate cold notification must still wait")
    precondition(gate.release(currentJobId: "cold", stopRequested: false, cancelled: false))
    precondition(!gate.release(currentJobId: "cold", stopRequested: false, cancelled: false), "ready is consumed once")

    precondition(gate.requestStart(jobId: "warm", isReady: true), "warm dictation must start immediately")
    precondition(!gate.release(currentJobId: "warm", stopRequested: false, cancelled: false))

    for reason in ["cancel", "stop", "new-job", "missing-job"] {
      precondition(!gate.requestStart(jobId: "pending", isReady: false))
      let currentJob = reason == "new-job" ? "replacement" : reason == "missing-job" ? nil : "pending"
      precondition(!gate.release(currentJobId: currentJob, stopRequested: reason == "stop", cancelled: reason == "cancel"), reason)
      precondition(!gate.release(currentJobId: "pending", stopRequested: false, cancelled: false), "discarded start must not revive")
    }

    precondition(!gate.requestStart(jobId: "older", isReady: false))
    precondition(!gate.requestStart(jobId: "newer", isReady: false))
    precondition(gate.release(currentJobId: "newer", stopRequested: false, cancelled: false))

    // The keyboard's existing startup timeout marks its job cancelled and idle.
    precondition(!gate.requestStart(jobId: "timed-out", isReady: false))
    precondition(!gate.release(currentJobId: "timed-out", stopRequested: false, cancelled: true))
    // A genuine new tap clears that marker and may record normally.
    precondition(gate.requestStart(jobId: "retry", isReady: true))

    // A delayed Darwin duplicate can arrive after readiness, after the user cancelled or stopped.
    for cancelled in [false, true] {
      precondition(!gate.requestStart(jobId: "late-duplicate", isReady: false))
      precondition(!gate.requestStart(jobId: "late-duplicate", isReady: true,
        stopRequested: !cancelled, cancelled: cancelled), "late duplicate must not revive a cancelled/stopped job")
      precondition(!gate.release(currentJobId: "late-duplicate", stopRequested: false, cancelled: false))
    }

    precondition(!gate.requestStart(jobId: "unmounted", isReady: false))
    gate.reset()
    precondition(!gate.release(currentJobId: "unmounted", stopRequested: false, cancelled: false))
    print("Keyboard recording startup gate tests passed")
  }
}
