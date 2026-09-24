const test = require("node:test");
const assert = require("node:assert/strict");

const LlamaServerManager = require("../../src/helpers/llamaServer.js");

const MINUTE = 60 * 1000;

// The idle callback awaits the server's /slots answer before it decides.
const settle = () => new Promise(setImmediate);

// A manager whose spawn is stubbed at the _doStart boundary but still arms the
// idle timer the way a real start does, whose /slots answer is scripted, and
// whose stop is recorded.
function makeManager() {
  const manager = new LlamaServerManager();
  const stops = [];
  manager.processing = false;
  manager._requestJson = async (path) =>
    path === "/slots" ? [{ is_processing: false }, { is_processing: manager.processing }] : null;
  manager._doStart = async (modelPath, options = {}) => {
    manager.ready = true;
    manager.modelPath = modelPath;
    manager.draftModelPath = options.draftModelPath || null;
    manager.resetIdleTimer();
  };
  manager.stop = async () => {
    stops.push(Date.now());
    manager.clearIdleTimer();
  };
  return { manager, stops };
}

// Streaming chat (the Voice Assistant panel, typed chat) asks for the running
// server before every turn and then talks to its port directly, so that ask is
// the only activity the server sees. Before this, an active conversation was
// stopped five minutes after the server first started.
test("asking for the already running server postpones the idle stop", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { manager, stops } = makeManager();

  await manager.start("/models/main.gguf");
  t.mock.timers.tick(4 * MINUTE);
  await manager.start("/models/main.gguf");
  t.mock.timers.tick(4 * MINUTE);
  await settle();

  assert.equal(stops.length, 0, "an active server must not idle out");

  t.mock.timers.tick(1 * MINUTE + 1);
  await settle();
  assert.equal(stops.length, 1, "it still stops once really idle");
});

// A single streamed answer can outlast the timeout with no new request.
test("a server still generating an answer is not stopped mid-stream", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { manager, stops } = makeManager();

  await manager.start("/models/main.gguf");
  manager.processing = true;
  t.mock.timers.tick(5 * MINUTE + 1);
  await settle();
  assert.equal(stops.length, 0, "a busy slot must postpone the stop");

  manager.processing = false;
  t.mock.timers.tick(5 * MINUTE + 1);
  await settle();
  assert.equal(stops.length, 1, "it stops once the answer is done");
});
