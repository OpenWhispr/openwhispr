const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// The meeting dispatch/start/teardown paths live inside the IPCHandlers
// registration closure, so — like ipcPolicyHeaderCoverage.test.js — this pins
// the wiring at the source level.
const source = fs.readFileSync(path.join(__dirname, "../../src/helpers/ipcHandlers.js"), "utf8");

test("every meeting realtime connect labels the stream and gives system its own VAD threshold", () => {
  assert.match(source, /const MEETING_SYSTEM_VAD_THRESHOLD = 0\.3;/);
  assert.match(
    source,
    /withMeetingSourceConnectOpts = \(connectOpts, source\) => \(\{\s*\.\.\.connectOpts,\s*streamLabel: source,\s*\.\.\.\(source === "system" \? \{ vadThreshold: MEETING_SYSTEM_VAD_THRESHOLD \} : \{\}\),\s*\}\)/
  );
  // Initial connect and mid-meeting reconnect both go through the helper; a
  // bare ...connectOpts spread would silently drop the system channel's
  // threshold and its stream label.
  assert.equal(
    (source.match(/\.\.\.withMeetingSourceConnectOpts\(connectOpts, source\)/g) ?? []).length,
    2
  );
  assert.doesNotMatch(source, /connect\(\{ apiKey: secret, token: secret, \.\.\.connectOpts \}\)/);
});

test("streaming dispatch logs system-channel levels", () => {
  assert.match(
    source,
    /source === "system" && buffer\.length >= 2[\s\S]{0,400}?"Meeting system audio stats"/
  );
});

test("silent system audio warning arms on start and clears on every teardown path", () => {
  // Armed only when a system-audio strategy is active (never for mic-only).
  assert.match(
    source,
    /result\.systemAudioStrategy && result\.systemAudioStrategy !== "unsupported"[\s\S]{0,160}?armMeetingSystemAudioSilenceTimer\(/
  );
  assert.match(source, /send\("meeting-system-audio-silent", \{ systemAudioStrategy \}\)/);
  // Normal/forced stop and error rollback both clear the one-shot timer.
  const rollbackStart = source.indexOf("const rollbackMeetingTranscriptionStart");
  const stopStart = source.indexOf("const stopMeetingTranscription");
  assert.ok(rollbackStart >= 0 && stopStart > rollbackStart);
  const rollbackSection = source.slice(
    rollbackStart,
    source.indexOf("const setupDictationCallbacks")
  );
  assert.match(rollbackSection, /clearMeetingSystemAudioSilenceTimer\(\);/);
  const stopSection = source.slice(
    stopStart,
    source.indexOf("const meetingTranscriptionLifecycle")
  );
  assert.match(stopSection, /clearMeetingSystemAudioSilenceTimer\(\);/);
});

test("a silent Windows capture hands the live session to renderer loopback", () => {
  // probe/activation success cannot see this failure, so the helper's own
  // capture_silent warning is the only trigger back to the Chromium fallback.
  assert.match(
    source,
    /if \(code === "capture_silent"\) \{\s*void degradeMeetingSystemAudioToLoopback\(event\);/
  );

  const degradeStart = source.indexOf("const degradeMeetingSystemAudioToLoopback");
  assert.ok(degradeStart >= 0);
  const degradeSection = source.slice(
    degradeStart,
    source.indexOf("const startManagedMeetingSystemAudio")
  );
  // One-shot, and never fires once the helper has proven it can hear audio.
  assert.match(
    degradeSection,
    /if \(meetingSystemAudioDegraded \|\| meetingSystemAudioHeard\) return;/
  );
  assert.match(degradeSection, /windowsLoopbackAudioManager\?\.stop\(\)/);
  assert.match(degradeSection, /send\("meeting-system-audio-degraded"\)/);

  // Leaking the latch across sessions would pin the fallback off for the rest
  // of the app's life, so it resets everywhere the heard-audio latch does.
  assert.equal(
    (source.match(/meetingSystemAudioHeard = false;\s*\n\s*meetingSystemAudioDegraded = false;/g) ?? [])
      .length,
    2
  );
});

test("the system-audio watchdog is armed beside the silence timer and torn down with it", () => {
  // Same gate as the one-shot warning: never armed for a mic-only session.
  assert.match(
    source,
    /result\.systemAudioStrategy && result\.systemAudioStrategy !== "unsupported"[\s\S]{0,240}?startMeetingSystemAudioWatchdog\(meetingConnectionWin, result\.systemAudioStrategy\)/
  );
  // Only the macOS tap emits a chunk per period, so only it can be judged on
  // delivery gaps; the loopback helpers may legitimately go idle.
  assert.match(source, /watchesDelivery: systemAudioStrategy === "native"/);

  // The ticker is the only timer the controller owns, and leaking one would
  // keep judging a session that has already ended.
  assert.match(
    source,
    /const stopMeetingSystemAudioWatchdog = \(\) => \{[\s\S]{0,400}?clearMeetingSystemAudioTicker\(\);[\s\S]{0,300}?meetingSystemAudioWatchdog\.stop\(\);/
  );

  // Arming runs after capture has started and attached itself, so it must clear
  // only the ticker. Calling the full teardown here detaches the capture the
  // start path just installed, which is how the first draft shipped a watchdog
  // that reported stalls it could not recover from.
  const armStart = source.indexOf("const startMeetingSystemAudioWatchdog");
  assert.ok(armStart >= 0);
  const armSection = source.slice(armStart, source.indexOf("const rollbackMeetingTranscriptionStart"));
  assert.match(armSection, /clearMeetingSystemAudioTicker\(\);/);
  assert.doesNotMatch(armSection, /stopMeetingSystemAudioWatchdog\(\);/);
  assert.doesNotMatch(armSection, /detachCapture\(\)/);

  // Every path that clears the one-shot timer also stops the watchdog, plus the
  // mic-only fallback, which strands the restart hook on a dead manager.
  for (const [label, from, to] of [
    [
      "rollback",
      "const rollbackMeetingTranscriptionStart",
      "const setupDictationCallbacks",
    ],
    ["stop", "const stopMeetingTranscription", "const meetingTranscriptionLifecycle"],
    ["mic-only fallback", "const fallBackToMicOnly", "const startMeetingSystemAudio = async"],
  ]) {
    const start = source.indexOf(from);
    const end = source.indexOf(to);
    assert.ok(start >= 0 && end > start, `${label} section not found`);
    assert.match(source.slice(start, end), /stopMeetingSystemAudioWatchdog\(\);/, label);
  }
});

test("the watchdog sees every system chunk and the helper's device warning", () => {
  // The audible check used to be skipped once the call had been heard, which is
  // exactly the window in which the tap dies (#1990).
  assert.match(
    source,
    /const audible = rms >= MEETING_MIC_SILENCE_RMS \|\| peak >= MEETING_MIC_SILENCE_PEAK;\s*meetingSystemAudioWatchdog\.recordChunk\(audible\);/
  );
  assert.match(
    source,
    /if \(code === "device_invalidated"\) \{\s*meetingSystemAudioWatchdog\.reportDeviceInvalidated\(\);/
  );

  // Recovery bounces the helper process, so the capture must be attached by the
  // same call that started it, not by the arming path.
  const managedStart = source.indexOf("const startManagedMeetingSystemAudio");
  assert.ok(managedStart >= 0);
  const managedSection = source.slice(managedStart, source.indexOf("const fallBackToMicOnly"));
  assert.match(
    managedSection,
    /meetingSystemAudioWatchdog\.attachCapture\(\{\s*stop: \(\) => manager\.stop\(\),\s*start: startCapture,/
  );

  // The interruption reaches the renderer; a log-only warning would leave the
  // user watching a recording that has stopped hearing the call.
  assert.match(source, /send\("meeting-system-audio-interrupted", payload\)/);
});
