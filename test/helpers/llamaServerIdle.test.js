const test = require("node:test");
const assert = require("node:assert/strict");

const LlamaServerManager = require("../../src/helpers/llamaServer.js");

const MINUTE = 60 * 1000;

// A manager whose spawn is stubbed at the _doStart boundary but still arms the
// idle timer the way a real start does, and whose stop is recorded.
function makeManager() {
  const manager = new LlamaServerManager();
  const stops = [];
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

  assert.equal(stops.length, 0, "an active server must not idle out");

  t.mock.timers.tick(1 * MINUTE + 1);
  assert.equal(stops.length, 1, "it still stops once really idle");
});
