const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const WhisperServerManager = require("../../src/helpers/whisperServer");

const { resolveWhisperIdleTimeoutMs, shouldSkipRestart } = WhisperServerManager;

function createFakeProcess() {
  return Object.assign(new EventEmitter(), {
    exitCode: null,
    pid: 12345,
    kill: () => {},
  });
}

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

test("stop() flips ready to false synchronously, before the process actually closes", async () => {
  const manager = new WhisperServerManager();
  const fakeProcess = createFakeProcess();
  manager.ready = true;
  manager.process = fakeProcess;

  const stopping = manager.stop();
  assert.equal(manager.ready, false);

  fakeProcess.emit("close");
  await stopping;
});

test("stop() resets process/port/modelPath after the process closes normally", async () => {
  const manager = new WhisperServerManager();
  const fakeProcess = createFakeProcess();
  manager.ready = true;
  manager.process = fakeProcess;
  manager.port = 8181;
  manager.modelPath = "/tmp/model.bin";

  const stopping = manager.stop();
  fakeProcess.emit("close");
  await stopping;

  assert.equal(manager.process, null);
  assert.equal(manager.port, null);
  assert.equal(manager.modelPath, null);
});

test("concurrent stop() calls coalesce onto one teardown (single SIGTERM)", async () => {
  const manager = new WhisperServerManager();
  const fakeProcess = createFakeProcess();
  let killCount = 0;
  fakeProcess.kill = () => {
    killCount += 1;
  };
  manager.ready = true;
  manager.process = fakeProcess;

  const first = manager.stop();
  const second = manager.stop();
  assert.equal(killCount, 1);

  fakeProcess.emit("close");
  await Promise.all([first, second]);
  assert.equal(killCount, 1);
});

test("shouldSkipRestart returns true only when ready and every signature matches", () => {
  const allMatch = {
    ready: true,
    isRemote: false,
    modelPathMatches: true,
    vadSignatureMatches: true,
    threadSignatureMatches: true,
  };
  assert.equal(shouldSkipRestart(allMatch), true);
  assert.equal(shouldSkipRestart({ ...allMatch, ready: false }), false);
  assert.equal(shouldSkipRestart({ ...allMatch, isRemote: true }), false);
  assert.equal(shouldSkipRestart({ ...allMatch, modelPathMatches: false }), false);
  assert.equal(shouldSkipRestart({ ...allMatch, vadSignatureMatches: false }), false);
  assert.equal(shouldSkipRestart({ ...allMatch, threadSignatureMatches: false }), false);
});

test("getStatus().idleTimeoutMs is 0 for a remote server even if a timeout is configured", () => {
  const manager = new WhisperServerManager();
  manager.isRemote = true;
  process.env.WHISPER_IDLE_TIMEOUT_MS = "300000";
  try {
    assert.equal(manager.getStatus().idleTimeoutMs, 0);
  } finally {
    delete process.env.WHISPER_IDLE_TIMEOUT_MS;
  }
});
