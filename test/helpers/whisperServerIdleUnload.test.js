const test = require("node:test");
const assert = require("node:assert/strict");

const WhisperServerManager = require("../../src/helpers/whisperServer.js");
const WhisperManager = require("../../src/helpers/whisper.js");
const { shouldRewarmOnWake } = require("../../src/helpers/whisper.js");

const MINUTE = 60 * 1000;
const { IDLE_UNLOAD_TIMEOUT_MS } = WhisperServerManager;

// A manager whose spawn is stubbed at the _doStart boundary, whose inference is
// stubbed below the request tracking, and whose stop is recorded. The policy
// wrapper around start() is covered elsewhere, so the tests start past it.
function makeManager(serverManager = new WhisperServerManager()) {
  const stops = [];
  serverManager._doStart = async (modelPath) => {
    serverManager.process = {};
    serverManager.ready = true;
    serverManager.modelPath = modelPath;
  };
  serverManager._transcribeTracked = async () => serverManager.pendingResult ?? { text: "ok" };
  serverManager.stop = async () => {
    stops.push(Date.now());
    serverManager.clearIdleTimer();
    serverManager.process = null;
    serverManager.ready = false;
  };
  const start = () => serverManager._policyAllowedStart("/models/ggml-turbo.bin", {});
  return { manager: serverManager, stops, start };
}

test("the idle unload is five minutes", () => {
  assert.equal(IDLE_UNLOAD_TIMEOUT_MS, 5 * MINUTE);
});

// #766: by default the transcription model stays resident between dictations.
test("by default a pre-warmed server is never unloaded", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { manager, stops, start } = makeManager();

  await start();
  t.mock.timers.tick(60 * MINUTE);

  assert.equal(stops.length, 0);
  assert.equal(manager.idleTimer, null);
});

// The reported case: the app pre-warms the CUDA server at launch and nobody
// dictates, so the timer must already run from the start, not only after a request.
test("with unload on, a server that only pre-warmed stops after five idle minutes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { manager, stops, start } = makeManager();
  manager.setUnloadWhenIdle(true);
  let idleStops = 0;
  manager.on("idle-stop", () => {
    idleStops += 1;
  });

  await start();
  t.mock.timers.tick(IDLE_UNLOAD_TIMEOUT_MS - 1);
  assert.equal(stops.length, 0);

  t.mock.timers.tick(1);
  assert.equal(stops.length, 1);
  assert.equal(idleStops, 1);
});

test("each dictation postpones the idle unload", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { manager, stops, start } = makeManager();
  manager.setUnloadWhenIdle(true);

  await start();
  t.mock.timers.tick(4 * MINUTE);
  await start(); // a dictation reuses the running server…
  await manager.transcribe(Buffer.alloc(0)); // …and transcribes on it
  t.mock.timers.tick(4 * MINUTE);
  assert.equal(stops.length, 0, "an active server must not idle out");

  t.mock.timers.tick(1 * MINUTE);
  assert.equal(stops.length, 1, "it still stops once really idle");
});

test("a transcription that outlasts the timeout is not cut off", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { manager, stops, start } = makeManager();
  manager.setUnloadWhenIdle(true);
  let finish;
  manager._transcribeTracked = () =>
    new Promise((resolve) => {
      finish = resolve;
    });

  await start();
  const request = manager.transcribe(Buffer.alloc(0));
  t.mock.timers.tick(20 * MINUTE);
  assert.equal(stops.length, 0);

  finish({ text: "long meeting chunk" });
  await request;
  t.mock.timers.tick(IDLE_UNLOAD_TIMEOUT_MS);
  assert.equal(stops.length, 1, "the timeout counts from the end of the request");
});

test("turning unload on arms the timer for a running server, turning it off cancels it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { manager, stops, start } = makeManager();

  await start();
  manager.setUnloadWhenIdle(true);
  t.mock.timers.tick(3 * MINUTE);
  manager.setUnloadWhenIdle(false);
  t.mock.timers.tick(30 * MINUTE);
  assert.equal(stops.length, 0);

  manager.setUnloadWhenIdle(true);
  t.mock.timers.tick(IDLE_UNLOAD_TIMEOUT_MS);
  assert.equal(stops.length, 1);
});

test("resending the same setting does not restart a pending timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { manager, stops, start } = makeManager();
  manager.setUnloadWhenIdle(true);

  await start();
  t.mock.timers.tick(4 * MINUTE);
  manager.setUnloadWhenIdle(true); // every window resends its preferences
  t.mock.timers.tick(1 * MINUTE);
  assert.equal(stops.length, 1);
});

test("a remote whisper-server is never idle-stopped", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { manager, stops } = makeManager();
  manager.setUnloadWhenIdle(true);
  manager.isRemote = true;
  manager.ready = true;
  manager.process = null;

  manager.resetIdleTimer();
  t.mock.timers.tick(60 * MINUTE);
  assert.equal(stops.length, 0);
});

// Without this, a wake from sleep would load the unloaded model back onto the GPU.
test("an idle unload stops the wake re-warm until the next dictation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const whisper = new WhisperManager();
  const { manager, start } = makeManager(whisper.serverManager);
  manager.useCuda = true;
  manager.setUnloadWhenIdle(true);

  await start();
  whisper.currentServerModel = "turbo-q5";
  t.mock.timers.tick(IDLE_UNLOAD_TIMEOUT_MS);

  assert.equal(whisper.currentServerModel, null);
  assert.equal(
    shouldRewarmOnWake({
      isRemote: manager.isRemote,
      useCuda: manager.useCuda,
      useVulkan: manager.useVulkan,
      modelName: whisper.currentServerModel,
      transcribing: false,
      rewarmInFlight: false,
    }),
    false
  );
});
