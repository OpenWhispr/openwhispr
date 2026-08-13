const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const WebSocket = require("ws");

const ParakeetWsServer = require("../../src/helpers/parakeetWsServer");

const { resolveParakeetIdleTimeoutMs, shouldSkipParakeetRestart } = ParakeetWsServer;

function createFakeProcess() {
  return Object.assign(new EventEmitter(), {
    exitCode: null,
    pid: 12345,
    kill: () => {},
  });
}

test("resolveParakeetIdleTimeoutMs defaults to 0 (never) when unset", () => {
  assert.equal(resolveParakeetIdleTimeoutMs({}), 0);
});

test("resolveParakeetIdleTimeoutMs treats '0' as never", () => {
  assert.equal(resolveParakeetIdleTimeoutMs({ PARAKEET_IDLE_TIMEOUT_MS: "0" }), 0);
});

test("resolveParakeetIdleTimeoutMs falls back to 0 on non-numeric input", () => {
  assert.equal(resolveParakeetIdleTimeoutMs({ PARAKEET_IDLE_TIMEOUT_MS: "not-a-number" }), 0);
});

test("resolveParakeetIdleTimeoutMs falls back to 0 on negative input", () => {
  assert.equal(resolveParakeetIdleTimeoutMs({ PARAKEET_IDLE_TIMEOUT_MS: "-300000" }), 0);
});

test("resolveParakeetIdleTimeoutMs returns the parsed positive integer", () => {
  assert.equal(resolveParakeetIdleTimeoutMs({ PARAKEET_IDLE_TIMEOUT_MS: "300000" }), 300000);
});

test("resolveParakeetIdleTimeoutMs defaults to process.env when no env arg is passed", () => {
  const prev = process.env.PARAKEET_IDLE_TIMEOUT_MS;
  process.env.PARAKEET_IDLE_TIMEOUT_MS = "900000";
  try {
    assert.equal(resolveParakeetIdleTimeoutMs(), 900000);
  } finally {
    if (prev === undefined) delete process.env.PARAKEET_IDLE_TIMEOUT_MS;
    else process.env.PARAKEET_IDLE_TIMEOUT_MS = prev;
  }
});

test("resetIdleTimer does not arm a timer when the resolved timeout is 0", () => {
  const manager = new ParakeetWsServer();
  delete process.env.PARAKEET_IDLE_TIMEOUT_MS;
  manager.resetIdleTimer();
  assert.equal(manager.idleTimer, null);
});

test("resetIdleTimer arms a timer for a nonzero timeout", () => {
  const manager = new ParakeetWsServer();
  process.env.PARAKEET_IDLE_TIMEOUT_MS = "300000";
  try {
    manager.resetIdleTimer();
    assert.notEqual(manager.idleTimer, null);
  } finally {
    manager.clearIdleTimer();
    delete process.env.PARAKEET_IDLE_TIMEOUT_MS;
  }
});

test("resetIdleTimer never arms while a stream is active", () => {
  const manager = new ParakeetWsServer();
  process.env.PARAKEET_IDLE_TIMEOUT_MS = "300000";
  try {
    manager.activeStreamCount = 1;
    manager.resetIdleTimer();
    assert.equal(manager.idleTimer, null);
  } finally {
    manager.clearIdleTimer();
    delete process.env.PARAKEET_IDLE_TIMEOUT_MS;
  }
});

test("clearIdleTimer clears an armed timer", () => {
  const manager = new ParakeetWsServer();
  process.env.PARAKEET_IDLE_TIMEOUT_MS = "300000";
  try {
    manager.resetIdleTimer();
    assert.notEqual(manager.idleTimer, null);
    manager.clearIdleTimer();
    assert.equal(manager.idleTimer, null);
  } finally {
    delete process.env.PARAKEET_IDLE_TIMEOUT_MS;
  }
});

test("stop() flips ready to false synchronously, before the process actually closes", async () => {
  const manager = new ParakeetWsServer();
  const fakeProcess = createFakeProcess();
  manager.ready = true;
  manager.process = fakeProcess;

  const stopping = manager.stop();
  assert.equal(manager.ready, false);

  fakeProcess.emit("close");
  await stopping;
});

test("stop() resets process/port/modelName after the process closes normally", async () => {
  const manager = new ParakeetWsServer();
  const fakeProcess = createFakeProcess();
  manager.ready = true;
  manager.process = fakeProcess;
  manager.port = 6006;
  manager.modelName = "parakeet-tdt-0.6b-v3";
  manager.modelDir = "/tmp/parakeet-model";
  manager.modelRuntime = "online";

  const stopping = manager.stop();
  fakeProcess.emit("close");
  await stopping;

  assert.equal(manager.process, null);
  assert.equal(manager.port, null);
  assert.equal(manager.modelName, null);
  assert.equal(manager.modelDir, null);
  assert.equal(manager.modelRuntime, "offline");
});

test("concurrent stop() calls coalesce onto one teardown (single kill)", async () => {
  const manager = new ParakeetWsServer();
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

test("shouldSkipParakeetRestart returns true only when ready and the model matches", () => {
  assert.equal(shouldSkipParakeetRestart({ ready: true, modelNameMatches: true }), true);
  assert.equal(shouldSkipParakeetRestart({ ready: false, modelNameMatches: true }), false);
  assert.equal(shouldSkipParakeetRestart({ ready: true, modelNameMatches: false }), false);
});

test("getStatus().idleTimeoutMs reflects the resolved timeout", () => {
  const manager = new ParakeetWsServer();
  process.env.PARAKEET_IDLE_TIMEOUT_MS = "300000";
  try {
    assert.equal(manager.getStatus().idleTimeoutMs, 300000);
  } finally {
    delete process.env.PARAKEET_IDLE_TIMEOUT_MS;
  }
});

test("createOnlineStream suppresses the idle timer for its whole lifetime", async () => {
  const wss = new WebSocket.Server({ port: 0 });
  await new Promise((resolve) => wss.once("listening", resolve));
  wss.on("connection", (ws) => {
    ws.on("message", (data) => {
      if (data.toString() === "Done") ws.send("Done!");
    });
  });

  const manager = new ParakeetWsServer();
  manager.ready = true;
  manager.process = createFakeProcess();
  manager.port = wss.address().port;
  manager.modelRuntime = "online";
  process.env.PARAKEET_IDLE_TIMEOUT_MS = "300000";

  try {
    manager.resetIdleTimer();
    assert.notEqual(manager.idleTimer, null);

    const stream = manager.createOnlineStream({});
    assert.equal(manager.idleTimer, null, "creating a stream clears the idle timer");
    assert.equal(manager.activeStreamCount, 1);

    // A resetIdleTimer() from an unrelated caller (e.g. transcribe()'s finally)
    // must stay suppressed while the stream is open.
    manager.resetIdleTimer();
    assert.equal(manager.idleTimer, null);

    await stream.finish();
    assert.equal(manager.activeStreamCount, 0);
    assert.notEqual(manager.idleTimer, null, "the last stream to close rearms the timer");
  } finally {
    manager.clearIdleTimer();
    delete process.env.PARAKEET_IDLE_TIMEOUT_MS;
    await new Promise((resolve) => wss.close(resolve));
  }
});
