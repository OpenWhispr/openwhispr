const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/mediaRecorderReconnect.js");

test("ended capture track needs reconnect", async () => {
  const { captureTrackNeedsReconnect } = await load();
  assert.equal(captureTrackNeedsReconnect({ readyState: "ended" }), true);
});

test("live capture track does not need reconnect", async () => {
  const { captureTrackNeedsReconnect } = await load();
  assert.equal(captureTrackNeedsReconnect({ readyState: "live" }), false);
});

test("missing capture track needs reconnect", async () => {
  const { captureTrackNeedsReconnect } = await load();
  assert.equal(captureTrackNeedsReconnect(null), true);
});

test("reconnect only while MediaRecorder is actively recording", async () => {
  const { shouldAttemptRecordingReconnect } = await load();
  assert.equal(
    shouldAttemptRecordingReconnect({
      isRecording: true,
      mediaRecorderState: "recording",
      track: { readyState: "ended" },
    }),
    true
  );
  assert.equal(
    shouldAttemptRecordingReconnect({
      isRecording: true,
      mediaRecorderState: "inactive",
      track: { readyState: "ended" },
    }),
    false
  );
  assert.equal(
    shouldAttemptRecordingReconnect({
      isRecording: false,
      mediaRecorderState: "recording",
      track: { readyState: "ended" },
    }),
    false
  );
});

test("healthy live track during devicechange does not reconnect", async () => {
  // Plugging in a second mic must not interrupt an ongoing healthy recording.
  const { shouldAttemptRecordingReconnect } = await load();
  assert.equal(
    shouldAttemptRecordingReconnect({
      isRecording: true,
      mediaRecorderState: "recording",
      track: { readyState: "live" },
    }),
    false
  );
});

test("in-flight reconnect is not started twice", async () => {
  const { shouldAttemptRecordingReconnect } = await load();
  assert.equal(
    shouldAttemptRecordingReconnect({
      isRecording: true,
      mediaRecorderState: "recording",
      track: { readyState: "ended" },
      reconnectInFlight: true,
    }),
    false
  );
});
