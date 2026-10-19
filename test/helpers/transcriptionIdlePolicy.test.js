const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/transcriptionIdlePolicy.js");

test("server is left running while a transcription is in progress", async () => {
  const { shouldPauseServer, IDLE_TIMEOUT_MS } = await load();

  const nowMs = 1000000;
  const lastActivityMs = nowMs - IDLE_TIMEOUT_MS - 10000; // Well past threshold

  assert.equal(
    shouldPauseServer({
      serverRunning: true,
      transcribing: true, // Active transcription blocks pause
      rewarmInFlight: false,
      lastActivityMs,
      nowMs,
    }),
    false,
    "Server must not pause during active transcription, even after idle threshold"
  );
});

test("server is left running while a re-warm is in progress", async () => {
  const { shouldPauseServer, IDLE_TIMEOUT_MS } = await load();

  const nowMs = 1000000;
  const lastActivityMs = nowMs - IDLE_TIMEOUT_MS - 10000; // Well past threshold

  assert.equal(
    shouldPauseServer({
      serverRunning: true,
      transcribing: false,
      rewarmInFlight: true, // Wake-from-sleep re-warm blocks pause
      lastActivityMs,
      nowMs,
    }),
    false,
    "Server must not pause during wake-from-sleep re-warm"
  );
});

test("server becomes eligible to pause after inactivity threshold", async () => {
  const { shouldPauseServer, IDLE_TIMEOUT_MS } = await load();

  const nowMs = 1000000;
  const lastActivityMs = nowMs - IDLE_TIMEOUT_MS - 1000; // Just past threshold

  assert.equal(
    shouldPauseServer({
      serverRunning: true,
      transcribing: false,
      rewarmInFlight: false,
      lastActivityMs,
      nowMs,
    }),
    true,
    "Server should pause after idle threshold with no active work"
  );
});

test("recent activity delays the pause", async () => {
  const { shouldPauseServer, IDLE_TIMEOUT_MS } = await load();

  const nowMs = 1000000;
  const lastActivityMs = nowMs - IDLE_TIMEOUT_MS + 60000; // 1 minute before threshold

  assert.equal(
    shouldPauseServer({
      serverRunning: true,
      transcribing: false,
      rewarmInFlight: false,
      lastActivityMs,
      nowMs,
    }),
    false,
    "Server should not pause when recent activity is within threshold"
  );
});

test("server at exact threshold boundary should pause", async () => {
  const { shouldPauseServer, IDLE_TIMEOUT_MS } = await load();

  const nowMs = 1000000;
  const lastActivityMs = nowMs - IDLE_TIMEOUT_MS; // Exactly at threshold

  assert.equal(
    shouldPauseServer({
      serverRunning: true,
      transcribing: false,
      rewarmInFlight: false,
      lastActivityMs,
      nowMs,
    }),
    true,
    "Server should pause at exact threshold boundary"
  );
});

test("stopped server does not trigger pause again", async () => {
  const { shouldPauseServer, IDLE_TIMEOUT_MS } = await load();

  const nowMs = 1000000;
  const lastActivityMs = nowMs - IDLE_TIMEOUT_MS - 10000;

  assert.equal(
    shouldPauseServer({
      serverRunning: false, // Already stopped
      transcribing: false,
      rewarmInFlight: false,
      lastActivityMs,
      nowMs,
    }),
    false,
    "Already-stopped server should not trigger pause action"
  );
});

test("custom idle timeout is respected", async () => {
  const { shouldPauseServer } = await load();

  const customTimeoutMs = 2 * 60 * 1000; // 2 minutes
  const nowMs = 1000000;
  const lastActivityMs = nowMs - customTimeoutMs - 1000; // Past custom threshold

  assert.equal(
    shouldPauseServer({
      serverRunning: true,
      transcribing: false,
      rewarmInFlight: false,
      lastActivityMs,
      nowMs,
      idleTimeoutMs: customTimeoutMs,
    }),
    true,
    "Should respect custom idle timeout"
  );
});

test("resume is needed when server is stopped", async () => {
  const { shouldResumeServer } = await load();

  assert.equal(
    shouldResumeServer({
      serverRunning: false,
      transcribing: false,
    }),
    true,
    "Should resume server when it's not running"
  );
});

test("resume is not needed when server is already running", async () => {
  const { shouldResumeServer } = await load();

  assert.equal(
    shouldResumeServer({
      serverRunning: true,
      transcribing: false,
    }),
    false,
    "Should not resume when server is already running"
  );
});

test("resume is not triggered during concurrent transcription", async () => {
  const { shouldResumeServer } = await load();

  assert.equal(
    shouldResumeServer({
      serverRunning: false,
      transcribing: true, // Already transcribing (concurrent request)
    }),
    false,
    "Should not double-resume during concurrent request"
  );
});

test("activity recording returns the current timestamp", async () => {
  const { recordActivity } = await load();

  const nowMs = 1234567890;
  const recorded = recordActivity(nowMs);

  assert.equal(recorded, nowMs, "Should record activity with current timestamp");
});

test("idle timer reset is triggered after activity completion", async () => {
  const { shouldResetIdleTimer } = await load();

  assert.equal(
    shouldResetIdleTimer({
      serverRunning: true,
      transcribing: false, // Just finished
    }),
    true,
    "Should reset idle timer after activity completes"
  );
});

test("idle timer reset does not trigger when server is stopped", async () => {
  const { shouldResetIdleTimer } = await load();

  assert.equal(
    shouldResetIdleTimer({
      serverRunning: false,
      transcribing: false,
    }),
    false,
    "Should not reset timer when server is not running"
  );
});

test("coexistence: transcription blocks pause, then re-warm blocks pause, then idle pause succeeds", async () => {
  const { shouldPauseServer, IDLE_TIMEOUT_MS } = await load();

  const nowMs = 1000000;
  const lastActivityMs = nowMs - IDLE_TIMEOUT_MS - 10000;

  // Phase 1: Transcription in progress
  assert.equal(
    shouldPauseServer({
      serverRunning: true,
      transcribing: true,
      rewarmInFlight: false,
      lastActivityMs,
      nowMs,
    }),
    false,
    "Pause blocked by transcription"
  );

  // Phase 2: Transcription done, re-warm starts
  assert.equal(
    shouldPauseServer({
      serverRunning: true,
      transcribing: false,
      rewarmInFlight: true,
      lastActivityMs,
      nowMs,
    }),
    false,
    "Pause blocked by re-warm"
  );

  // Phase 3: Both clear, idle pause proceeds
  assert.equal(
    shouldPauseServer({
      serverRunning: true,
      transcribing: false,
      rewarmInFlight: false,
      lastActivityMs,
      nowMs,
    }),
    true,
    "Pause succeeds when both guards clear"
  );
});

test("resume during stop succeeds by checking serverRunning", async () => {
  const { shouldResumeServer } = await load();

  // Scenario: Request arrives while server is in the process of stopping
  // serverRunning will be false once stop completes
  assert.equal(
    shouldResumeServer({
      serverRunning: false,
      transcribing: false,
    }),
    true,
    "Resume should succeed when server is stopped or stopping"
  );
});

test("multiple activities keep resetting the timer", async () => {
  const { shouldPauseServer, recordActivity, IDLE_TIMEOUT_MS } = await load();

  let nowMs = 1000000;
  let lastActivityMs = recordActivity(nowMs);

  // Activity 1
  nowMs += 60000; // +1 minute
  assert.equal(
    shouldPauseServer({
      serverRunning: true,
      transcribing: false,
      rewarmInFlight: false,
      lastActivityMs,
      nowMs,
    }),
    false,
    "Should not pause after 1 minute"
  );

  // Activity 2 - reset
  lastActivityMs = recordActivity(nowMs);
  nowMs += 60000; // +1 minute
  assert.equal(
    shouldPauseServer({
      serverRunning: true,
      transcribing: false,
      rewarmInFlight: false,
      lastActivityMs,
      nowMs,
    }),
    false,
    "Should not pause after another 1 minute"
  );

  // Now wait past threshold
  nowMs += IDLE_TIMEOUT_MS + 1000;
  assert.equal(
    shouldPauseServer({
      serverRunning: true,
      transcribing: false,
      rewarmInFlight: false,
      lastActivityMs,
      nowMs,
    }),
    true,
    "Should pause after full idle timeout from last activity"
  );
});
