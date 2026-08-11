const test = require("node:test");
const assert = require("node:assert/strict");

const WhisperServerManager = require("../../src/helpers/whisperServer");

const { resolveWhisperIdleTimeoutMs } = WhisperServerManager;

test("resolveWhisperIdleTimeoutMs defaults to 0 (never) when unset", () => {
  assert.equal(resolveWhisperIdleTimeoutMs({}), 0);
});

test("resolveWhisperIdleTimeoutMs treats '0' as never", () => {
  assert.equal(resolveWhisperIdleTimeoutMs({ WHISPER_IDLE_TIMEOUT_MS: "0" }), 0);
});

test("resolveWhisperIdleTimeoutMs falls back to 0 on non-numeric input", () => {
  assert.equal(resolveWhisperIdleTimeoutMs({ WHISPER_IDLE_TIMEOUT_MS: "not-a-number" }), 0);
});

test("resolveWhisperIdleTimeoutMs falls back to 0 on negative input", () => {
  assert.equal(resolveWhisperIdleTimeoutMs({ WHISPER_IDLE_TIMEOUT_MS: "-300000" }), 0);
});

test("resolveWhisperIdleTimeoutMs returns the parsed positive integer", () => {
  assert.equal(resolveWhisperIdleTimeoutMs({ WHISPER_IDLE_TIMEOUT_MS: "300000" }), 300000);
});

test("resolveWhisperIdleTimeoutMs defaults to process.env when no env arg is passed", () => {
  const prev = process.env.WHISPER_IDLE_TIMEOUT_MS;
  process.env.WHISPER_IDLE_TIMEOUT_MS = "900000";
  try {
    assert.equal(resolveWhisperIdleTimeoutMs(), 900000);
  } finally {
    if (prev === undefined) delete process.env.WHISPER_IDLE_TIMEOUT_MS;
    else process.env.WHISPER_IDLE_TIMEOUT_MS = prev;
  }
});

test("resetIdleTimer never arms a timer for a remote server", () => {
  const manager = new WhisperServerManager();
  manager.isRemote = true;
  process.env.WHISPER_IDLE_TIMEOUT_MS = "300000";
  try {
    manager.resetIdleTimer();
    assert.equal(manager.idleTimer, null);
  } finally {
    delete process.env.WHISPER_IDLE_TIMEOUT_MS;
  }
});

test("resetIdleTimer does not arm a timer when the resolved timeout is 0", () => {
  const manager = new WhisperServerManager();
  manager.isRemote = false;
  delete process.env.WHISPER_IDLE_TIMEOUT_MS;
  manager.resetIdleTimer();
  assert.equal(manager.idleTimer, null);
});

test("resetIdleTimer arms a timer for a local server with a nonzero timeout", () => {
  const manager = new WhisperServerManager();
  manager.isRemote = false;
  process.env.WHISPER_IDLE_TIMEOUT_MS = "300000";
  try {
    manager.resetIdleTimer();
    assert.notEqual(manager.idleTimer, null);
  } finally {
    manager.clearIdleTimer();
    delete process.env.WHISPER_IDLE_TIMEOUT_MS;
  }
});

test("clearIdleTimer clears an armed timer", () => {
  const manager = new WhisperServerManager();
  manager.isRemote = false;
  process.env.WHISPER_IDLE_TIMEOUT_MS = "300000";
  try {
    manager.resetIdleTimer();
    assert.notEqual(manager.idleTimer, null);
    manager.clearIdleTimer();
    assert.equal(manager.idleTimer, null);
  } finally {
    delete process.env.WHISPER_IDLE_TIMEOUT_MS;
  }
});
