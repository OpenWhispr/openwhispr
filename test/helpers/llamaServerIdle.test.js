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
    manager.process = {};
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

test("a server that cannot answer /slots is stopped as before", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { manager, stops } = makeManager();
  manager._requestJson = async () => null;

  await manager.start("/models/main.gguf");
  t.mock.timers.tick(5 * MINUTE + 1);
  await settle();

  assert.equal(stops.length, 1);
});

test("a request that arrives while /slots is checked keeps the server", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { manager, stops } = makeManager();
  let answerSlots;
  manager._requestJson = () =>
    new Promise((resolve) => {
      answerSlots = resolve;
    });

  await manager.start("/models/main.gguf");
  t.mock.timers.tick(5 * MINUTE + 1);
  await manager.start("/models/main.gguf");
  answerSlots([{ is_processing: false }]);
  await settle();

  assert.equal(stops.length, 0, "the newer request's timer owns the decision now");
});

// Opt-in residency must survive idle without sending artificial inference.
test("an opted-in resident server stays loaded after five idle minutes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { manager, stops } = makeManager();
  manager.setKeepResident(true);
  await manager.start("/models/main.gguf");
  t.mock.timers.tick(30 * MINUTE);
  await settle();
  assert.equal(stops.length, 0);
  assert.equal(manager.idleTimer, null);
});

test("enabling residency cancels an already pending idle unload", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { manager, stops } = makeManager();
  await manager.start("/models/main.gguf");
  t.mock.timers.tick(4 * MINUTE);
  manager.setKeepResident(true);
  t.mock.timers.tick(2 * MINUTE);
  await settle();
  assert.equal(stops.length, 0);
  assert.equal(manager.idleTimer, null);
});

test("a resident server still stops and restarts when its context must grow", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { manager, stops } = makeManager();
  manager.setKeepResident(true);
  await manager.start("/models/main.gguf", { contextSize: 16384 });
  await manager.start("/models/main.gguf", { contextSize: 32768 });
  assert.equal(stops.length, 1);
  assert.equal(manager.contextSize, 32768);
  assert.equal(manager.idleTimer, null);
});

test("turning residency off idles the running server out five minutes later", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { manager, stops } = makeManager();
  manager.setKeepResident(true);

  await manager.start("/models/main.gguf");
  t.mock.timers.tick(30 * MINUTE);
  manager.setKeepResident(false);
  t.mock.timers.tick(5 * MINUTE - 1);
  await settle();
  assert.equal(stops.length, 0, "the countdown starts when residency goes off");

  t.mock.timers.tick(2);
  await settle();
  assert.equal(stops.length, 1);
});

// On Windows and Linux the GPU fallback ladder can take longer than the idle timeout.
test("turning residency off during a start leaves the countdown to the finished start", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { manager, stops } = makeManager();
  const { promise: ready, resolve: finishStart } = Promise.withResolvers();
  const doStart = manager._doStart;
  manager._doStart = async (...args) => {
    manager.process = {};
    await ready;
    await doStart(...args);
  };
  manager.setKeepResident(true);

  const starting = manager.start("/models/main.gguf");
  manager.setKeepResident(false);
  t.mock.timers.tick(30 * MINUTE);
  await settle();
  assert.equal(stops.length, 0, "a server still starting is never idled out");

  finishStart();
  await starting;
  t.mock.timers.tick(5 * MINUTE);
  await settle();
  assert.equal(stops.length, 1);
});

test("turning residency off while a restart stops the old server leaves the countdown to the new start", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { manager, stops } = makeManager();
  manager.setKeepResident(true);
  await manager.start("/models/main.gguf");

  const { promise: oldStopped, resolve: finishStop } = Promise.withResolvers();
  const { promise: ready, resolve: finishStart } = Promise.withResolvers();
  const stop = manager.stop;
  manager.stop = async () => {
    await stop();
    await oldStopped;
  };
  const doStart = manager._doStart;
  manager._doStart = async (...args) => {
    await ready;
    await doStart(...args);
  };

  const restarting = manager.start("/models/other.gguf");
  manager.setKeepResident(false);
  finishStop();
  await settle();
  t.mock.timers.tick(30 * MINUTE);
  await settle();
  assert.equal(stops.length, 1, "only the restart stopped the old server");

  finishStart();
  await restarting;
  t.mock.timers.tick(5 * MINUTE);
  await settle();
  assert.equal(stops.length, 2);
});

// Every window resends the setting on load and when its local-model or policy inputs change.
test("resyncing an unchanged residency setting leaves the idle countdown alone", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { manager, stops } = makeManager();

  await manager.start("/models/main.gguf");
  t.mock.timers.tick(4 * MINUTE);
  manager.setKeepResident(false);
  t.mock.timers.tick(1 * MINUTE + 1);
  await settle();

  assert.equal(stops.length, 1);
});
