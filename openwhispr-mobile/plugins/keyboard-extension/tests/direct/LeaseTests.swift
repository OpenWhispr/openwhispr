import Foundation

/// While a meeting records, the app publishes a capture-lease heartbeat to the App Group and the
/// keyboard must not take the microphone: no take of its own, no start request to the app's warm
/// mic, no handoff into the app.
extension DirectDictationTests {
  static func testLease() {
    leaseSharedVectors()
    leaseReaderReadsTheDecimalString()
    leaseDirectCaptureRefusedWhileHeld()
    leaseDirectCaptureAllowedOnceStale()
    leaseDirectCaptureAllowedWhenKeyAbsent()
    leaseTakeAlreadyRecordingIsLeftAlone()
    leaseMicTapDuringMeetingStartsNothing()
  }

  /// One suite per test, so runs never see each other's heartbeat.
  static func leaseDefaults() -> (UserDefaults, String) {
    let name = "keyboard-lease-tests-\(UUID().uuidString)"
    return (UserDefaults(suiteName: name)!, name)
  }

  /// The same vectors as the app's copy in
  /// modules/app-group-storage/tests/CaptureLeasePolicyTests.swift (heartbeatIsHeldOnlyWhileFresh;
  /// keep the two lists identical),
  /// so the keyboard and the app can never disagree on whether a meeting holds the microphone.
  static func leaseSharedVectors() {
    let now: Int64 = 1_800_000_000_000
    expect(MeetingCaptureLease.staleAfterMs, 15_000, "lease vectors: stale after 15 s")
    expect(MeetingCaptureLease.isHeld(heartbeatMs: nil, nowMs: now), false, "lease vectors: no heartbeat is free")
    expect(MeetingCaptureLease.isHeld(heartbeatMs: now, nowMs: now), true, "lease vectors: just written is held")
    expect(MeetingCaptureLease.isHeld(heartbeatMs: now - 4_000, nowMs: now), true, "lease vectors: 4 s old is held")
    expect(MeetingCaptureLease.isHeld(heartbeatMs: now - 15_000, nowMs: now), true, "lease vectors: exactly 15 s old is held")
    expect(MeetingCaptureLease.isHeld(heartbeatMs: now - 15_001, nowMs: now), false, "lease vectors: 15.001 s old is stale")
    expect(MeetingCaptureLease.isHeld(heartbeatMs: now + 1, nowMs: now), false, "lease vectors: a future heartbeat is free")
    // Absolute stored values a corrupt write could leave: never held, never a trap.
    expect(MeetingCaptureLease.isHeld(heartbeatMs: Int64.min, nowMs: now), false, "lease vectors: Int64.min is free, not an overflow trap")
    expect(MeetingCaptureLease.isHeld(heartbeatMs: -1, nowMs: now), false, "lease vectors: a negative heartbeat is free")
    expect(MeetingCaptureLease.isHeld(heartbeatMs: 0, nowMs: now), false, "lease vectors: a zero heartbeat is free")
    expect(MeetingCaptureLease.isHeld(heartbeatMs: Int64.max, nowMs: Int64.min), false, "lease vectors: an overflowing age is free")
  }

  static func leaseReaderReadsTheDecimalString() {
    let now: Int64 = 1_800_000_000_000
    let (defaults, name) = leaseDefaults()
    defer { UserDefaults().removePersistentDomain(forName: name) }
    expect(MeetingCaptureLease.heartbeatKey, "capture_lease_heartbeat_ms", "lease reader: the app's key")
    expect(MeetingCaptureLease.isMeetingRecording(defaults: nil, nowMs: now), false, "lease reader: no App Group is free")
    expect(MeetingCaptureLease.isMeetingRecording(defaults: defaults, nowMs: now), false, "lease reader: absent key is free")
    defaults.set(String(now - 2_000), forKey: MeetingCaptureLease.heartbeatKey)
    expect(MeetingCaptureLease.isMeetingRecording(defaults: defaults, nowMs: now), true, "lease reader: fresh heartbeat is held")
    defaults.set(String(now - 15_001), forKey: MeetingCaptureLease.heartbeatKey)
    expect(MeetingCaptureLease.isMeetingRecording(defaults: defaults, nowMs: now), false, "lease reader: stale heartbeat is free")
    defaults.set("not a number", forKey: MeetingCaptureLease.heartbeatKey)
    expect(MeetingCaptureLease.isMeetingRecording(defaults: defaults, nowMs: now), false, "lease reader: garbage is free")
    defaults.set("", forKey: MeetingCaptureLease.heartbeatKey)
    expect(MeetingCaptureLease.isMeetingRecording(defaults: defaults, nowMs: now), false, "lease reader: an empty string is free")
    defaults.set(String(Int64.min), forKey: MeetingCaptureLease.heartbeatKey)
    expect(MeetingCaptureLease.isMeetingRecording(defaults: defaults, nowMs: now), false, "lease reader: Int64.min is free, not a trap")
    defaults.set("99999999999999999999", forKey: MeetingCaptureLease.heartbeatKey)
    expect(MeetingCaptureLease.isMeetingRecording(defaults: defaults, nowMs: now), false, "lease reader: a number past Int64 is free")
  }

  static func leaseDirectCaptureRefusedWhileHeld() {
    let h = Harness()
    let (defaults, name) = leaseDefaults()
    defer {
      h.cleanup()
      UserDefaults().removePersistentDomain(forName: name)
    }
    h.meetingDefaults = defaults
    defaults.set(String(h.clock.ms - 4_000), forKey: MeetingCaptureLease.heartbeatKey)
    expect(h.dictation.isEligible, false, "direct capture is refused while the lease is held: not eligible")
    h.dictation.start()
    expect(h.capture.startCount, 0, "direct capture is refused while the lease is held: no capture")
    expect(h.state, .idle, "direct capture is refused while the lease is held: stays idle")
    expect(h.files(), [], "direct capture is refused while the lease is held: no job left behind")
  }

  static func leaseDirectCaptureAllowedOnceStale() {
    let h = Harness()
    let (defaults, name) = leaseDefaults()
    defer {
      h.cleanup()
      UserDefaults().removePersistentDomain(forName: name)
    }
    h.meetingDefaults = defaults
    defaults.set(String(h.clock.ms), forKey: MeetingCaptureLease.heartbeatKey)
    expect(h.dictation.isEligible, false, "direct capture is allowed once the heartbeat is stale: held first")
    // The app crashed mid-meeting: nothing refreshes the heartbeat.
    h.clock.advance(seconds: 15.001)
    expect(h.dictation.isEligible, true, "direct capture is allowed once the heartbeat is stale: eligible")
    h.dictation.start()
    expect(h.capture.startCount, 1, "direct capture is allowed once the heartbeat is stale: capture starts")
  }

  static func leaseDirectCaptureAllowedWhenKeyAbsent() {
    let h = Harness()
    let (defaults, name) = leaseDefaults()
    defer {
      h.cleanup()
      UserDefaults().removePersistentDomain(forName: name)
    }
    h.meetingDefaults = defaults
    defaults.set(String(h.clock.ms), forKey: MeetingCaptureLease.heartbeatKey)
    // The meeting ended: the app removes the key on release.
    defaults.removeObject(forKey: MeetingCaptureLease.heartbeatKey)
    expect(h.dictation.isEligible, true, "direct capture is allowed when the key is absent: eligible")
    h.dictation.start()
    expect(h.capture.startCount, 1, "direct capture is allowed when the key is absent: capture starts")
  }

  /// A take the keyboard was already recording when the meeting began keeps going; only new
  /// takes are refused.
  static func leaseTakeAlreadyRecordingIsLeftAlone() {
    let h = Harness()
    let (defaults, name) = leaseDefaults()
    defer {
      h.cleanup()
      UserDefaults().removePersistentDomain(forName: name)
    }
    h.meetingDefaults = defaults
    h.dictation.start()
    h.capture.started()
    defaults.set(String(h.clock.ms), forKey: MeetingCaptureLease.heartbeatKey)
    h.feed(h.loud(seconds: 1))
    expect(h.capture.stopCount, 0, "lease: a take in progress is not stopped")
    expect(h.state, .recording, "lease: a take in progress keeps recording")
  }

  /// The keyboard view controller can't run here (UIKit), so its tap route is a pure decision it
  /// follows: the meeting wins over every way of starting audio.
  static func leaseMicTapDuringMeetingStartsNothing() {
    for inPlace in [false, true] {
      for direct in [false, true] {
        expect(
          MeetingCaptureLease.micTapRoute(meetingRecording: true, recordsInPlace: inPlace, recordsDirect: direct),
          .meetingRecording,
          "a mic tap during a meeting posts no start notification and opens no handoff (inPlace=\(inPlace) direct=\(direct))"
        )
      }
    }
    expect(
      MeetingCaptureLease.micTapRoute(meetingRecording: false, recordsInPlace: true, recordsDirect: true),
      .inPlace, "mic route: no meeting, warm app records in place"
    )
    expect(
      MeetingCaptureLease.micTapRoute(meetingRecording: false, recordsInPlace: false, recordsDirect: true),
      .direct, "mic route: no meeting, the keyboard records itself"
    )
    expect(
      MeetingCaptureLease.micTapRoute(meetingRecording: false, recordsInPlace: false, recordsDirect: false),
      .handoff, "mic route: no meeting, the tap opens the app"
    )
    expect(MeetingCaptureLease.unavailableHint, "Unavailable while a meeting is recording", "mic route: the hint")
  }
}
