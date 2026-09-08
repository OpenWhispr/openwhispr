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
