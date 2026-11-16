import Foundation

@main
struct LiveActivityResolverTests {
  static var failures = 0

  static func check(_ condition: Bool, _ message: String, line: Int = #line) {
    if !condition {
      failures += 1
      print("FAIL (line \(line)): \(message)")
    }
  }

  static func main() throws {
    let now = Date(timeIntervalSince1970: 1_000_000)
    let start = Date(timeIntervalSince1970: 999_000)
    let recording = MeetingSnapshot(title: "Weekly sync", startedAt: start, phase: .recording)
    let processing = MeetingSnapshot(
      title: nil, startedAt: start, phase: .processing(recordedSeconds: 2530))

    // A meeting wins over every keyboard/dictation combination.
    for keyboard in [false, true] {
      for dictation in [false, true] {
        for awake in [false, true] {
          let flags = "keyboard=\(keyboard), dictation=\(dictation), awake=\(awake)"
          check(
            LiveActivityResolver.resolve(
              meeting: recording, keyboardRecording: keyboard, dictationMode: dictation,
              appAwake: awake, now: now)
              == RecordingActivityContentState(
                mode: .meeting, phase: .recording, startedAt: start, title: "Weekly sync"),
            "recording meeting wins (\(flags))")
          check(
            LiveActivityResolver.resolve(
              meeting: processing, keyboardRecording: keyboard, dictationMode: dictation,
              appAwake: awake, now: now)
              == RecordingActivityContentState(
                mode: .meeting, phase: .processing, startedAt: start, recordedSeconds: 2530),
            "processing meeting wins (\(flags))")
        }
      }
    }

    // Without a meeting: keyboard recording > dictation idle > nothing.
    let keyboardOnly = RecordingActivityContentState(phase: .recording, startedAt: now)
    check(
      LiveActivityResolver.resolve(meeting: nil, keyboardRecording: true, dictationMode: false, appAwake: true, now: now)
        == keyboardOnly, "keyboard recording without dictation mode")
    check(
      LiveActivityResolver.resolve(meeting: nil, keyboardRecording: true, dictationMode: true, appAwake: true, now: now)
        == keyboardOnly, "keyboard recording with dictation mode")
    check(
      LiveActivityResolver.resolve(meeting: nil, keyboardRecording: false, dictationMode: true, appAwake: true, now: now)
        == RecordingActivityContentState(phase: .idle, startedAt: now), "dictation idle")
    check(
      LiveActivityResolver.resolve(meeting: nil, keyboardRecording: false, dictationMode: false, appAwake: true, now: now)
        == nil, "nothing to show ends the activity")

    // Backgrounded without the warm mic, the app is about to suspend, and iOS can kill
    // a suspended app without warning: the idle card must not outlive it.
    check(
      LiveActivityResolver.resolve(meeting: nil, keyboardRecording: false, dictationMode: true, appAwake: false, now: now)
        == nil, "dictation idle ends once the app can suspend")
    check(
      LiveActivityResolver.resolve(meeting: nil, keyboardRecording: true, dictationMode: true, appAwake: false, now: now)
        == keyboardOnly, "a keyboard recording keeps its card while backgrounded")
    check(
      LiveActivityResolver.resolve(meeting: nil, keyboardRecording: false, dictationMode: false, appAwake: false, now: now)
        == nil, "nothing to show while backgrounded ends the activity")

    // Stale dates.
    let meetingState = RecordingActivityContentState(
      mode: .meeting, phase: .recording, startedAt: start)
    check(
      LiveActivityResolver.staleDate(for: meetingState, now: now)
        == start.addingTimeInterval(8 * 60 * 60), "meeting stale date is startedAt + 8h")
    check(
      LiveActivityResolver.staleDate(for: keyboardOnly, now: now)
        == now.addingTimeInterval(60 * 60), "dictation stale date is now + 1h")

    // Display copy.
    check(
      RecordingActivityContentState(mode: .meeting, phase: .recording, startedAt: start).displayTitle
        == "Taking notes…", "untitled meeting")
    check(
      RecordingActivityContentState(
        mode: .meeting, phase: .recording, startedAt: start, title: "Weekly sync"
      ).displayTitle == "Weekly sync", "titled meeting")
    check(
      RecordingActivityContentState(
        mode: .meeting, phase: .processing, startedAt: start, title: "Weekly sync"
      ).displayTitle == "Processing notes…", "processing title")
    let label = { (seconds: Int?) in
      RecordingActivityContentState(
        mode: .meeting, phase: .processing, startedAt: start, recordedSeconds: seconds
      ).recordedDurationLabel
    }
    check(label(2530) == "42:10", "m:ss label")
    check(label(5) == "0:05", "sub-minute label")
    check(label(3723) == "1:02:03", "h:mm:ss label")
    check(label(nil) == "0:00", "missing duration label")
    check(label(-4) == "0:00", "negative duration clamps")

    // A legacy payload (pre-meeting build) still decodes as dictation.
    let legacy = Data(#"{"phase":"idle","startedAt":0}"#.utf8)
    let decoded = try JSONDecoder().decode(RecordingActivityContentState.self, from: legacy)
    check(
      decoded.mode == .dictation && decoded.phase == .idle && decoded.title == nil
        && decoded.recordedSeconds == nil, "legacy payload decodes as dictation")

    // Round trip keeps every field.
    let full = RecordingActivityContentState(
      mode: .meeting, phase: .processing, startedAt: start, title: "Sync", recordedSeconds: 61)
    let roundTripped = try JSONDecoder().decode(
      RecordingActivityContentState.self, from: JSONEncoder().encode(full))
    check(roundTripped == full, "round trip")

    if failures > 0 {
      print("\(failures) failure(s)")
      exit(1)
    }
    print("All live-activity resolver tests passed")
  }
}
