import Foundation

/// Deterministic clock for the async sequencing helpers: sleeping advances time.
final class FakeClock {
  var now = 0
  func sleep(_ ms: Int) async { now += ms }
}

@main
struct HotkeyDictationLogicTests {
  static func snapshot(
    recordingActive: Bool = false,
    sessionReady: Bool = false,
    heartbeatAgeMs: Int? = 1_000,
    status: String? = "idle",
    statusAgeMs: Int? = 1_000,
    deliveryPending: Bool = false,
    startInProgress: Bool = false,
    jsReady: Bool = true,
    canColdStart: Bool = false
  ) -> HotkeySnapshot {
    HotkeySnapshot(
      recordingActive: recordingActive,
      sessionReady: sessionReady,
      heartbeatAgeMs: heartbeatAgeMs,
      status: status,
      statusAgeMs: statusAgeMs,
      deliveryPending: deliveryPending,
      startInProgress: startInProgress,
      jsReady: jsReady,
      canColdStart: canColdStart)
  }

  static func main() async {
    // decidePress: a fresh recording always stops, even while busy/pending (double press).
    precondition(HotkeyDecision.decidePress(snapshot(recordingActive: true, heartbeatAgeMs: 5_000)) == .stop)
    precondition(HotkeyDecision.decidePress(snapshot(
      recordingActive: true, status: "transcribing", deliveryPending: true)) == .stop)
    // Task 7 fix: a press while a start is in flight is ignored even once the recording
    // flag is up; otherwise it stops the recording before the starting press sees it,
    // and that press reports a failed start and never arms the watcher.
    precondition(HotkeyDecision.decidePress(snapshot(recordingActive: true, startInProgress: true)) == .ignoreStarting)
    // Task 7 fix: shared "warm"/"recording" flags are only trusted when this process's
    // JS is ready. A killed process leaves them fresh for up to 5 s, and a new process
    // posting start before its own listener exists loses the recording.
    precondition(HotkeyDecision.decidePress(snapshot(sessionReady: true, jsReady: false, canColdStart: true)) == .startCold)
    precondition(HotkeyDecision.decidePress(snapshot(recordingActive: true, jsReady: false, canColdStart: true)) == .startCold)
    precondition(HotkeyDecision.decidePress(snapshot(
      sessionReady: true, status: "transcribing", jsReady: false, canColdStart: true)) == .startCold)
    // A recording flag with a stale heartbeat is a leftover, not a recording.
    precondition(HotkeyDecision.decidePress(snapshot(recordingActive: true, heartbeatAgeMs: 5_001)) == .explain)
    precondition(HotkeyDecision.decidePress(snapshot(recordingActive: true, heartbeatAgeMs: nil)) == .explain)
    // Busy statuses refuse a new start while fresh.
    for status in ["transcribing", "cleaning", "agent_generating"] {
      precondition(HotkeyDecision.decidePress(snapshot(sessionReady: true, status: status)) == .ignoreBusy)
    }
    precondition(HotkeyDecision.decidePress(snapshot(
      sessionReady: true, status: "transcribing", statusAgeMs: 300_000)) == .ignoreBusy)
    precondition(HotkeyDecision.decidePress(snapshot(
      sessionReady: true, status: "transcribing", statusAgeMs: 300_001)) == .startWarm)
    precondition(HotkeyDecision.decidePress(snapshot(
      sessionReady: true, status: "transcribing", statusAgeMs: nil)) == .startWarm)
    // A pending hotkey delivery blocks a new start even when the status is idle.
    // A hotkey delivery still in flight (in-process) blocks a new start even when the status is idle.
    precondition(HotkeyDecision.decidePress(snapshot(sessionReady: true, deliveryPending: true)) == .ignoreBusy)
    // Review fix #2: a press while a start is still in flight (cold JS wait, or the
    // ~100 ms before the recording flag flips) is ignored silently, never a second start.
    precondition(HotkeyDecision.decidePress(snapshot(sessionReady: true, startInProgress: true)) == .ignoreStarting)
    precondition(HotkeyDecision.decidePress(snapshot(startInProgress: true, canColdStart: true)) == .ignoreStarting)
    precondition(HotkeyDecision.decidePress(snapshot(
      sessionReady: true, status: "transcribing", startInProgress: true)) == .ignoreStarting)
    // Warm vs cold vs explain.
    precondition(HotkeyDecision.decidePress(snapshot(sessionReady: true)) == .startWarm)
    precondition(HotkeyDecision.decidePress(snapshot(sessionReady: true, heartbeatAgeMs: 5_001, canColdStart: true)) == .startCold)
    precondition(HotkeyDecision.decidePress(snapshot(sessionReady: false, canColdStart: true)) == .startCold)
    precondition(HotkeyDecision.decidePress(snapshot(sessionReady: false, canColdStart: false)) == .explain)

    // Review fix #1: the watcher runs from start, so a recording in progress is its own
    // outcome and the delivery clock stays paused until the recording ends (by any path).
    precondition(HotkeyDecision.deliveryOutcome(
      jobId: "a", pendingTranscript: nil, pendingJobId: nil, status: "recording") == .recording)
    precondition(HotkeyDecision.banner(for: .recording) == nil)
    precondition(HotkeyDecision.nextDeliveryDeadline(current: nil, outcome: .recording, nowMs: 1_000) == nil)
    precondition(HotkeyDecision.nextDeliveryDeadline(current: 9_999, outcome: .recording, nowMs: 1_000) == nil)
    precondition(HotkeyDecision.nextDeliveryDeadline(current: nil, outcome: .pending, nowMs: 1_000)
      == 1_000 + HotkeyDecision.deliveryTimeoutMs)
    precondition(HotkeyDecision.nextDeliveryDeadline(current: 5_000, outcome: .pending, nowMs: 9_000) == 5_000)

    // Task 7 fix: a live recording is `.recording` whatever the shared status says. A
    // previous job's delayed JS cleanup can write "idle" (no_speech → cleanup after
    // 2.2 s) while the next hotkey recording is running.
    precondition(HotkeyDecision.deliveryOutcome(
      jobId: "a", pendingTranscript: nil, pendingJobId: nil, status: "idle", recordingActive: true) == .recording)
    precondition(HotkeyDecision.deliveryOutcome(
      jobId: "a", pendingTranscript: nil, pendingJobId: nil, status: "no_speech", recordingActive: true) == .recording)
    precondition(HotkeyDecision.deliveryOutcome(
      jobId: "a", pendingTranscript: nil, pendingJobId: nil, status: "idle", recordingActive: false) == .failed)

    // Review fix #3: the JS-ready stamp only counts when this process wrote it.
    precondition(HotkeyDecision.isJsReadyStamp("4242:1790000000000", pid: 4242))
    precondition(!HotkeyDecision.isJsReadyStamp("4241:1790000000000", pid: 4242))
    precondition(!HotkeyDecision.isJsReadyStamp("1790000000000", pid: 4242))
    precondition(!HotkeyDecision.isJsReadyStamp(nil, pid: 4242))
    precondition(!HotkeyDecision.isJsReadyStamp("", pid: 4242))

    // Review fix #4: only the newest banner's timer may clear it.
    do {
      var generations = BannerGenerations()
      let first = generations.next()
      let second = generations.next()
      precondition(!generations.isCurrent(first))
      precondition(generations.isCurrent(second))
    }

    // deliveryOutcome.
    precondition(HotkeyDecision.deliveryOutcome(
      jobId: "a", pendingTranscript: "hello", pendingJobId: "a", status: "ready") == .copy("hello"))
    precondition(HotkeyDecision.deliveryOutcome(
      jobId: "a", pendingTranscript: "hello", pendingJobId: "b", status: "ready") == .pending)
    precondition(HotkeyDecision.deliveryOutcome(
      jobId: "a", pendingTranscript: "", pendingJobId: "a", status: "ready") == .pending)
    precondition(HotkeyDecision.deliveryOutcome(
      jobId: "a", pendingTranscript: nil, pendingJobId: nil, status: "transcribing") == .pending)
    precondition(HotkeyDecision.deliveryOutcome(
      jobId: "a", pendingTranscript: nil, pendingJobId: nil, status: "no_speech") == .noSpeech)
    for status in ["error", "setup_required", "idle"] {
      precondition(HotkeyDecision.deliveryOutcome(
        jobId: "a", pendingTranscript: nil, pendingJobId: nil, status: status) == .failed)
    }

    // Banners (Review Focus 3: a timeout reads as a failure and frees the hotkey).
    precondition(HotkeyDecision.timeoutOutcome == .failed)
    precondition(HotkeyDecision.banner(for: .copy("x")) == .copied)
    precondition(HotkeyDecision.banner(for: .noSpeech) == .noSpeech)
    precondition(HotkeyDecision.banner(for: .failed) == .failed)
    precondition(HotkeyDecision.banner(for: .pending) == nil)
    precondition(HotkeyBanner.copied.body == "Copied — press ⌘V to paste")
    precondition(HotkeyBanner.stillTranscribing.body == "Still transcribing…")
    precondition(HotkeyBanner.openApp.body == "Open OpenWhispr to turn on dictation mode")
    precondition(HotkeyBanner.noSpeech.body == "No speech detected")
    precondition(HotkeyBanner.failed.body == "Couldn't transcribe — open OpenWhispr")

    // runColdStart: JS ready at t=250 → start; start never runs before ready.
    do {
      let clock = FakeClock()
      var calls: [String] = []
      let result = await HotkeyDecision.runColdStart(ColdStartDeps(
        isJsReady: { clock.now >= 250 },
        startWarm: {
          precondition(clock.now >= 250, "start posted before JS was ready")
          calls.append("start")
          return true
        },
        sleepMs: clock.sleep,
        nowMs: { clock.now }))
      precondition(result == .started)
      precondition(calls == ["start"])
    }
    // runColdStart: JS never ready → nothing started, gives up after 8 s.
    do {
      let clock = FakeClock()
      var calls: [String] = []
      let result = await HotkeyDecision.runColdStart(ColdStartDeps(
        isJsReady: { false },
        startWarm: { calls.append("start"); return true },
        sleepMs: clock.sleep,
        nowMs: { clock.now }))
      precondition(result == .jsNotReady)
      precondition(calls.isEmpty)
      precondition(clock.now >= HotkeyDecision.jsReadyTimeoutMs)
    }
    // runColdStart: ready but the recording never starts.
    do {
      let clock = FakeClock()
      let result = await HotkeyDecision.runColdStart(ColdStartDeps(
        isJsReady: { true },
        startWarm: { false },
        sleepMs: clock.sleep,
        nowMs: { clock.now }))
      precondition(result == .startFailed)
    }
    // waitUntil returns true as soon as the check passes, false at the deadline.
    do {
      let clock = FakeClock()
      let hit = await HotkeyDecision.waitUntil(
        timeoutMs: 2_000, nowMs: { clock.now }, sleepMs: clock.sleep) { clock.now >= 300 }
      precondition(hit && clock.now == 300)
      let miss = await HotkeyDecision.waitUntil(
        timeoutMs: 2_000, nowMs: { clock.now }, sleepMs: clock.sleep) { false }
      precondition(!miss)
    }

    print("HotkeyDictationLogicTests passed")
  }
}
