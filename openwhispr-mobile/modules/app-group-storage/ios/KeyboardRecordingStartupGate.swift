// Darwin requests can arrive before JS restores local preferences. Keep only
// the latest original job, and never revive one stopped or replaced while waiting.
struct KeyboardRecordingStartupGate {
  private var pendingJobId: String?

  mutating func requestStart(
    jobId: String, isReady: Bool, stopRequested: Bool = false, cancelled: Bool = false
  ) -> Bool {
    if stopRequested || cancelled {
      pendingJobId = nil
      return false
    }
    pendingJobId = isReady ? nil : jobId
    return isReady
  }

  mutating func release(currentJobId: String?, stopRequested: Bool, cancelled: Bool) -> Bool {
    defer { pendingJobId = nil }
    guard let pendingJobId else { return false }
    return pendingJobId == currentJobId && !stopRequested && !cancelled
  }

  mutating func reset() {
    pendingJobId = nil
  }
}
