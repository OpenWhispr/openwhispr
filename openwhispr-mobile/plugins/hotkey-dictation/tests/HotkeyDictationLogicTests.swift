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
    jsReady: Bool = true
  ) -> HotkeySnapshot {
    HotkeySnapshot(
      recordingActive: recordingActive,
      sessionReady: sessionReady,
      heartbeatAgeMs: heartbeatAgeMs,
      status: status,
      statusAgeMs: statusAgeMs,
      deliveryPending: deliveryPending,
      startInProgress: startInProgress,
      jsReady: jsReady)
  }

  static func outcome(
    pendingTranscript: String? = nil,
    pendingJobId: String? = nil,
    status: String?,
    recordingActive: Bool = false
  ) -> DeliveryOutcome {
    HotkeyDecision.deliveryOutcome(
      jobId: "a",
      pendingTranscript: pendingTranscript,
      pendingJobId: pendingJobId,
      status: status,
      recordingActive: recordingActive)
  }

  static func main() async {
    // decidePress — a live recording stops, even while its delivery is being watched.
    precondition(HotkeyDecision.decidePress(snapshot(recordingActive: true, heartbeatAgeMs: 5_000)) == .stop)
    precondition(HotkeyDecision.decidePress(snapshot(
      recordingActive: true, status: "transcribing", deliveryPending: true)) == .stop)

    // A start in flight owns the hotkey: a second press is ignored silently, even once
    // the recording flag is up, so it can never stop the recording before the starting
    // press sees it or start a second one.
    precondition(HotkeyDecision.decidePress(snapshot(recordingActive: true, startInProgress: true)) == .ignoreStarting)
    precondition(HotkeyDecision.decidePress(snapshot(sessionReady: true, startInProgress: true)) == .ignoreStarting)
    precondition(HotkeyDecision.decidePress(snapshot(startInProgress: true)) == .ignoreStarting)
    precondition(HotkeyDecision.decidePress(snapshot(
      sessionReady: true, status: "transcribing", startInProgress: true)) == .ignoreStarting)

    // Shared flags are only trusted once this process's JS is ready: a killed process
    // leaves them fresh for up to 5 s.
    precondition(HotkeyDecision.decidePress(snapshot(sessionReady: true, jsReady: false)) == .startCold)
    precondition(HotkeyDecision.decidePress(snapshot(recordingActive: true, jsReady: false)) == .startCold)
    precondition(HotkeyDecision.decidePress(snapshot(
      sessionReady: true, status: "transcribing", jsReady: false)) == .startCold)

    // A recording flag with a stale heartbeat is a leftover, not a recording.
    precondition(HotkeyDecision.decidePress(snapshot(recordingActive: true, heartbeatAgeMs: 5_001)) == .startCold)
    precondition(HotkeyDecision.decidePress(snapshot(recordingActive: true, heartbeatAgeMs: nil)) == .startCold)

    // Busy statuses refuse a new start while fresh; so does a delivery still in flight.
    for status in ["transcribing", "cleaning", "agent_generating"] {
      precondition(HotkeyDecision.decidePress(snapshot(sessionReady: true, status: status)) == .ignoreBusy)
    }
    precondition(HotkeyDecision.decidePress(snapshot(
      sessionReady: true, status: "transcribing", statusAgeMs: 300_000)) == .ignoreBusy)
    precondition(HotkeyDecision.decidePress(snapshot(
      sessionReady: true, status: "transcribing", statusAgeMs: 300_001)) == .startWarm)
    precondition(HotkeyDecision.decidePress(snapshot(
      sessionReady: true, status: "transcribing", statusAgeMs: nil)) == .startWarm)
    precondition(HotkeyDecision.decidePress(snapshot(sessionReady: true, deliveryPending: true)) == .ignoreBusy)

    // Warm vs cold.
    precondition(HotkeyDecision.decidePress(snapshot(sessionReady: true)) == .startWarm)
    precondition(HotkeyDecision.decidePress(snapshot(sessionReady: true, heartbeatAgeMs: 5_001)) == .startCold)
    precondition(HotkeyDecision.decidePress(snapshot(sessionReady: false)) == .startCold)

    // deliveryOutcome — the transcript for this job is copied.
    precondition(outcome(pendingTranscript: "hello", pendingJobId: "a", status: "ready") == .copy("hello"))
    precondition(outcome(pendingTranscript: "hello", pendingJobId: "b", status: "ready") == .pending)
    precondition(outcome(pendingTranscript: "", pendingJobId: "a", status: "ready") == .pending)
    precondition(outcome(status: "transcribing") == .pending)
    precondition(outcome(status: "no_speech") == .noSpeech)
    for status in ["error", "setup_required", "idle"] {
      precondition(outcome(status: status) == .failed)
    }

    // The live recording flag decides `.recording`, whatever the shared status says:
    // a previous job's delayed JS cleanup can write "idle" during the next recording,
    // and a "recording" status left without a live flag must not pause the timeout.
    precondition(outcome(status: "idle", recordingActive: true) == .recording)
    precondition(outcome(status: "no_speech", recordingActive: true) == .recording)
    precondition(outcome(status: "recording", recordingActive: false) == .pending)

    // The delivery clock is paused while recording and starts once the recording ends.
    precondition(HotkeyDecision.nextDeliveryDeadline(current: nil, outcome: .recording, nowMs: 1_000) == nil)
    precondition(HotkeyDecision.nextDeliveryDeadline(current: 9_999, outcome: .recording, nowMs: 1_000) == nil)
    precondition(HotkeyDecision.nextDeliveryDeadline(current: nil, outcome: .pending, nowMs: 1_000)
      == 1_000 + HotkeyDecision.deliveryTimeoutMs)
    precondition(HotkeyDecision.nextDeliveryDeadline(current: 5_000, outcome: .pending, nowMs: 9_000) == 5_000)

    // Banners: a timeout reads as a failure and frees the hotkey.
    precondition(HotkeyDecision.timeoutOutcome == .failed)
    precondition(HotkeyDecision.banner(for: .copy("x")) == .copied)
    precondition(HotkeyDecision.banner(for: .noSpeech) == .noSpeech)
    precondition(HotkeyDecision.banner(for: .failed) == .failed)
    precondition(HotkeyDecision.banner(for: .pending) == nil)
    precondition(HotkeyDecision.banner(for: .recording) == nil)
    precondition(HotkeyBanner.copied.body == "Copied — press ⌘V to paste")
    precondition(HotkeyBanner.stillTranscribing.body == "Still transcribing…")
    precondition(HotkeyBanner.openApp.body == "Open OpenWhispr to turn on dictation mode")
    precondition(HotkeyBanner.noSpeech.body == "No speech detected")
    precondition(HotkeyBanner.failed.body == "Couldn't transcribe — open OpenWhispr")

    // Only the newest banner's timer may clear it.
    do {
      var generations = BannerGenerations()
      let first = generations.next()
      let second = generations.next()
      precondition(!generations.isCurrent(first))
      precondition(generations.isCurrent(second))
    }

    // The JS-ready stamp only counts when this process wrote it.
    precondition(HotkeyDecision.isJsReadyStamp("4242:1790000000000", pid: 4242))
    precondition(!HotkeyDecision.isJsReadyStamp("4241:1790000000000", pid: 4242))
    precondition(!HotkeyDecision.isJsReadyStamp("1790000000000", pid: 4242))
    precondition(!HotkeyDecision.isJsReadyStamp(nil, pid: 4242))
    precondition(!HotkeyDecision.isJsReadyStamp("", pid: 4242))

    // runColdStart: JS ready at t=250 → start; start never runs before ready.
    do {
      let clock = FakeClock()
      var calls: [String] = []
      let result = await HotkeyDecision.runColdStart(ColdStartDeps(
        isJsReady: { clock.now >= 250 },
        startWarm: {
          precondition(clock.now >= 250, "start posted before JS was ready")
          calls.append("start")
          return "job"
        },
        sleepMs: clock.sleep,
        nowMs: { clock.now }))
      precondition(result == .started(jobId: "job"))
      precondition(calls == ["start"])
    }
    // runColdStart: JS never ready → nothing started, gives up after 8 s.
    do {
      let clock = FakeClock()
      var calls: [String] = []
      let result = await HotkeyDecision.runColdStart(ColdStartDeps(
        isJsReady: { false },
        startWarm: { calls.append("start"); return "job" },
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
        startWarm: { nil },
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
