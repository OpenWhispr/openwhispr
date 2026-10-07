const test = require("node:test");
const assert = require("node:assert");
const ParakeetWsServer = require("../../src/helpers/parakeetWsServer");

// Reproduces the real race from audit-logs/10-live-debugging-findings.md #3:
// dictation (model A) is mid-transcribe when meeting mode requests model B.
// Without serialization, start(modelB) stops the process mid-request and the
// dictation caller's socket dies with ECONNRESET.
function stubbedServer({ modelName, language = null }) {
  const server = new ParakeetWsServer();
  server.ready = true;
  server.process = { pid: 1 }; // stand-in for a running child process
  server.modelName = modelName;
  server.language = language;
  server.stop = async () => {
    server.process = null;
    server.ready = false;
  };
  server._doStart = async (nextModelName) => {
    server.modelName = nextModelName;
    server.ready = true;
    server.process = { pid: 2 };
  };
  return server;
}

test("start() does not stop the process while a transcribe() use is still active", async () => {
  const server = stubbedServer({ modelName: "model-a" });
  const stopSpy = [];
  const originalStop = server.stop;
  server.stop = async (...args) => {
    stopSpy.push(Date.now());
    return originalStop(...args);
  };

  // Caller 1 (dictation) is mid-transcribe on model-a.
  server._acquireUse();

  // Caller 2 (meeting mode) requests model-b, which needs a restart.
  const switchPromise = server.start("model-b", "/path/b", "offline");
  await new Promise((resolve) => setImmediate(resolve));

  assert.strictEqual(stopSpy.length, 0, "must not stop the process mid-transcribe");
  assert.strictEqual(server.modelName, "model-a", "the active model must not change yet");

  // Caller 1's transcribe() finishes and releases its use.
  server._releaseUse();
  await switchPromise;

  assert.strictEqual(stopSpy.length, 1, "stop() runs once the in-flight use has drained");
  assert.strictEqual(server.modelName, "model-b");
});

test("start() switches immediately when there is no in-flight use", async () => {
  const server = stubbedServer({ modelName: "model-a" });

  await server.start("model-b", "/path/b", "offline");

  assert.strictEqual(server.modelName, "model-b");
});

test("activeUses counter and drain waiters exist on a fresh server", () => {
  const server = new ParakeetWsServer();
  assert.strictEqual(server.activeUses, 0, "activeUses should start at 0");
  assert.ok(Array.isArray(server.drainWaiters), "drainWaiters should exist");
});
