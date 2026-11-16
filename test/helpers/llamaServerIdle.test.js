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
  // A restart waits while `processing` is set; the handoff grace and /slots
  // timeouts behind the real check are covered in llamaServerContext.test.js.
  manager._isBusy = async () => manager.processing;
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

// A background chat answer talks to the port directly, so only /slots shows it is running.
test("switching models waits for an answer still being generated", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { manager, stops } = makeManager();
  await manager.start("/models/chat.gguf");
  manager.processing = true;

  let started = false;
  const restart = manager.start("/models/summary.gguf").then(() => (started = true));
  await settle();
  assert.equal(stops.length, 0, "the running answer keeps its server");

  t.mock.timers.tick(5000);
  await settle();
  assert.equal(stops.length, 0);

  manager.processing = false;
  t.mock.timers.tick(1000);
  await settle();
  await settle();
  await restart;
  assert.equal(stops.length, 1);
  assert.equal(started, true);
  assert.equal(manager.modelPath, "/models/summary.gguf");
});

test("switching models doesn't wait for an answer forever", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { manager, stops } = makeManager();
  await manager.start("/models/chat.gguf");
  manager.processing = true;
  const refused = assert.rejects(manager.start("/models/summary.gguf"), {
    code: "LOCAL_MODEL_BUSY",
  });
  for (let elapsed = 0; elapsed <= 61_000; elapsed += 1000) {
    await settle();
    t.mock.timers.tick(1000);
  }
  await refused;
  assert.equal(stops.length, 0, "the answer keeps its server");
  assert.equal(manager.modelPath, "/models/chat.gguf");
});

test("an idle server switches models without waiting", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { manager, stops } = makeManager();
  await manager.start("/models/chat.gguf");
  await manager.start("/models/summary.gguf");
  assert.equal(stops.length, 1);
  assert.equal(manager.modelPath, "/models/summary.gguf");
});

test("requests that arrive during the wait share one restart", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { manager, stops } = makeManager();
  let spawns = 0;
  const doStart = manager._doStart;
  manager._doStart = async (...args) => {
    spawns += 1;
    return doStart(...args);
  };
  await manager.start("/models/chat.gguf");
  spawns = 0;
  manager.processing = true;
  const first = manager.start("/models/summary.gguf");
  await settle();
  const second = manager.start("/models/summary.gguf");
  await settle();
  assert.equal(stops.length, 0, "the running answer keeps its server");
  manager.processing = false;
  t.mock.timers.tick(1000);
  await settle();
  await settle();
  await Promise.all([first, second]);
  assert.equal(stops.length, 1);
  assert.equal(spawns, 1);
});

test("a deferred stop waits for the answer and a later need cancels it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { manager, stops } = makeManager();
  await manager.start("/models/chat.gguf");
  manager.processing = true;

  const cancelled = manager.stopWhenIdle();
  await settle();
  assert.equal(stops.length, 0);
  manager.cancelDeferredStop();
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(await cancelled, false);
  assert.equal(stops.length, 0);

  const deferredStop = manager.stopWhenIdle();
  await settle();
  manager.processing = false;
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(await deferredStop, true);
  assert.equal(stops.length, 1);
});

test("asking for the running server cancels a deferred stop", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { manager, stops } = makeManager();
  await manager.start("/models/chat.gguf");
  manager.processing = true;
  const deferredStop = manager.stopWhenIdle();
  await settle();
  await manager.start("/models/chat.gguf");
  manager.processing = false;
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(await deferredStop, false);
  assert.equal(stops.length, 0);
});

test("a start refused while the answer runs leaves a deferred stop in place", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { manager, stops } = makeManager();
  await manager.start("/models/chat.gguf");
  manager.processing = true;
  const deferredStop = manager.stopWhenIdle();
  await settle();
  await assert.rejects(manager.start("/models/summary.gguf", { busyWaitMs: 0 }), {
    code: "LOCAL_MODEL_BUSY",
  });
  manager.processing = false;
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(await deferredStop, true);
  assert.equal(stops.length, 1);
});

for (const [label, modelPath, options] of [
  ["another model", "/models/other.gguf", { contextSize: 4096 }],
  ["a larger context", "/models/summary.gguf", { contextSize: 8192 }],
  ["another drafter", "/models/summary.gguf", { contextSize: 4096, draftModelPath: "/draft.gguf" }],
]) {
  test(`a request for ${label} cannot share an incompatible restart's success`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const { manager, stops } = makeManager();
    await manager.start("/models/chat.gguf");
    manager.processing = true;
    const ready = Promise.withResolvers();
    const doStart = manager._doStart;
    manager._doStart = async (...args) => {
      await ready.promise;
      return doStart(...args);
    };
    const first = manager.start("/models/summary.gguf", { contextSize: 4096 });
    await settle();
    manager.processing = false;
    t.mock.timers.tick(1000);
    await settle();
    const second = manager.start(modelPath, { ...options, busyWaitMs: 0 });
    const rejected = assert.rejects(second, /another request|different|incompatible/i);
    ready.resolve();
    await first;
    await rejected;
    assert.equal(manager.modelPath, "/models/summary.gguf");
    assert.equal(manager.contextSize, 4096);
    assert.equal(manager.draftModelPath, null);
    assert.equal(stops.length, 1, "the rejected request leaves the first caller's server running");
  });
}

test("compatible requests share a cold start and keep the larger context", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { manager, stops } = makeManager();
  const ready = Promise.withResolvers();
  const doStart = manager._doStart;
  let starts = 0;
  manager._doStart = async (...args) => {
    starts += 1;
    await ready.promise;
    return doStart(...args);
  };
  const first = manager.start("/models/chat.gguf", { contextSize: 8192 });
  const second = manager.start("/models/chat.gguf", { contextSize: 4096 });
  ready.resolve();
  await Promise.all([first, second]);
  assert.equal(starts, 1);
  assert.equal(stops.length, 0);
  assert.equal(manager.contextSize, 8192);
});

test("restarting an unhealthy server does not wait for its slots response", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { manager, stops } = makeManager();
  await manager.start("/models/chat.gguf");
  manager.ready = false;
  const slots = Promise.withResolvers();
  manager._requestJson = () => slots.promise;
  const restarting = manager.start("/models/chat.gguf");
  t.after(async () => {
    slots.resolve([]);
    await restarting;
  });
  await settle();
  assert.equal(stops.length, 1, "recovery must not depend on an unresponsive server");
  assert.equal(manager.ready, true);
});

test("a deferred stop without a server cleans up without contacting a local service", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const manager = new LlamaServerManager();
  const requests = [];
  manager._requestJson = async (path) => {
    requests.push(path);
    return [];
  };
  manager.ready = true;
  manager.contextSize = 4096;
  manager.resetIdleTimer();
  assert.equal(await manager.stopWhenIdle(), true);
  assert.deepEqual(requests, [], "a missing server has no slots endpoint to poll");
  assert.equal(manager.ready, false);
  assert.equal(manager.contextSize, null);
  assert.equal(manager.idleTimer, null);
  assert.equal(manager.deferredStop, null);
});

for (const shutdown of ["deferred", "idle"]) {
  test(`a same-model start waits for an in-flight ${shutdown} stop and uses a replacement`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const { EventEmitter } = require("node:events");
    const manager = new LlamaServerManager();
    t.after(() => manager.clearIdleTimer());
    const children = [];
    const signals = [];
    manager._requestJson = async () => [];
    manager._doStart = async (modelPath) => {
      const child = new EventEmitter();
      child.exitCode = null;
      child.kill = (signal) => {
        signals.push(signal || "SIGTERM");
      };
      children.push(child);
      manager.process = child;
      manager.port = 8220 + children.length;
      manager.modelPath = modelPath;
      manager.draftModelPath = null;
      manager.ready = true;
      manager.resetIdleTimer();
    };
    await manager.start("/models/chat.gguf");
    const stopping = shutdown === "deferred" ? manager.stopWhenIdle() : null;
    if (shutdown === "idle") t.mock.timers.tick(5 * MINUTE);
    await settle();
    assert.deepEqual(signals, ["SIGTERM"]);
    let returned = false;
    const starting = manager.start("/models/chat.gguf").then(() => {
      returned = true;
    });
    t.after(async () => {
      children[0].emit("close", 0);
      await Promise.all([stopping, starting]);
    });
    await settle();
    assert.equal(returned, false, "a terminating server must never be handed to a caller");
    assert.equal(manager.getStatus().running, false);
    const duplicateStop = manager.stop();
    assert.deepEqual(signals, ["SIGTERM"], "concurrent stops share the same shutdown");
    children[0].emit("close", 0);
    await Promise.all([stopping, duplicateStop, starting]);
    assert.equal(children.length, 2);
    assert.equal(manager.process, children[1]);
    assert.equal(manager.port, 8222);
    assert.equal(manager.ready, true);
    assert.equal(manager.modelPath, "/models/chat.gguf");
  });
}

for (const reuse of ["preferences", "same-model start"]) {
  test(`a binary refresh survives ${reuse} and waits for the active answer`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const { manager, stops } = makeManager();
    manager.setKeepResident(true);
    await manager.start("/models/chat.gguf");
    manager.processing = true;

    const refresh = manager.stopWhenIdle({ cancelOnReuse: false });
    await settle();
    if (reuse === "preferences") manager.cancelDeferredStop();
    else await manager.start("/models/chat.gguf");
    t.mock.timers.tick(1000);
    await settle();
    assert.equal(stops.length, 0, "the current answer still owns its server");

    manager.processing = false;
    t.mock.timers.tick(1000);
    await settle();
    assert.equal(await refresh, true);
    assert.equal(stops.length, 1, "the next inference can load the installed GPU binary");
  });
}
