import Darwin
import Foundation

// Peak-memory measurement for the Parakeet-vs-Whisper benchmark.
//
// We report `phys_footprint` from TASK_VM_INFO — the exact number iOS Jetsam meters against the
// per-process limit, and what Xcode's memory gauge shows. This is the value that decides whether a
// model is viable on a 4GB device, so it is the ground truth for the go/no-go, NOT the JS heap
// (which never sees the CoreML/ANE allocations that dominate here).
enum MemoryProbe {
  /// Current physical footprint in bytes (the value Jetsam meters). 0 if the query fails.
  static func footprintBytes() -> UInt64 {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(
      MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
    let kr = withUnsafeMutablePointer(to: &info) {
      $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
        task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
      }
    }
    guard kr == KERN_SUCCESS else { return 0 }
    return info.phys_footprint
  }

  /// Headroom in bytes before THIS process hits its Jetsam limit (iOS 13+).
  /// Complements footprint: lets us express "peaked at X MB, with Y MB of headroom left".
  static func availableBytes() -> UInt64 {
    UInt64(os_proc_available_memory())
  }
}

/// Samples `phys_footprint` on its own queue (~50ms) so it keeps measuring while a transcribe call
/// is suspended on the ANE. Reused for BOTH engines (Parakeet natively, Whisper via start/stop from
/// JS) so the memory A/B is apples-to-apples.
final class PeakSampler {
  private let queue = DispatchQueue(label: "parakeet-asr.memsampler")
  private var timer: DispatchSourceTimer?
  private(set) var peak: UInt64 = 0
  private(set) var baseline: UInt64 = 0
  private(set) var minAvailable: UInt64 = .max

  func start(intervalMs: Int = 50) {
    stop()  // idempotent: never leak a prior timer
    let base = MemoryProbe.footprintBytes()
    baseline = base
    peak = base
    minAvailable = MemoryProbe.availableBytes()

    let t = DispatchSource.makeTimerSource(queue: queue)
    t.schedule(deadline: .now(), repeating: .milliseconds(intervalMs))
    t.setEventHandler { [weak self] in
      guard let self else { return }
      self.peak = max(self.peak, MemoryProbe.footprintBytes())
      self.minAvailable = min(self.minAvailable, MemoryProbe.availableBytes())
    }
    t.resume()
    timer = t
  }

  @discardableResult
  func stop() -> (peak: UInt64, baseline: UInt64, minAvailable: UInt64) {
    timer?.cancel()
    timer = nil
    let avail = minAvailable == .max ? MemoryProbe.availableBytes() : minAvailable
    return (peak, baseline, avail)
  }
}
