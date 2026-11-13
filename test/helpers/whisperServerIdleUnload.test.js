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

// A dictation that starts while the server is down warms it in the background,
// so the cold start overlaps the speech instead of following it.
function makeWarmableWhisper() {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-warm-"));
  const modelFile = path.join(dir, "ggml-turbo.bin");
  fs.writeFileSync(modelFile, "");
  const whisper = new WhisperManager();
  const starts = [];
  const sm = whisper.serverManager;
  sm.isAvailable = () => true;
  sm._doStart = async (modelPath, options) => {
    starts.push({ modelPath, options });
    // The real _doStart records the GPU part of the start signature.
    sm.gpuSignature = WhisperServerManager.getGpuSignature(options);
    sm.process = {};
    sm.ready = true;
    sm.modelPath = modelPath;
  };
  sm.stop = async () => {
    sm.clearIdleTimer();
    sm.process = null;
    sm.ready = false;
  };
  whisper.getModelPath = () => modelFile;
  whisper.resolveGpuStartOptions = () => ({ useCuda: true, useVulkan: false });
  return { whisper, sm, starts, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("a dictation after an idle unload restarts the server with the last dictation's options", async (t) => {
  const { whisper, sm, starts, cleanup } = makeWarmableWhisper();
  t.after(cleanup);
  const dictationOptions = {
    useCuda: true,
    useVulkan: false,
    vadEnabled: true,
    vadModelPath: "/vad.bin",
  };
  await sm._policyAllowedStart(whisper.getModelPath(), dictationOptions);
  await sm.stop(); // the idle unload

  const result = await whisper.warmForDictation("turbo-q5");
  assert.equal(result.success, true);
  assert.equal(starts.length, 2);
  assert.equal(starts[1].options.vadEnabled, true, "VAD is replayed");
  assert.equal(whisper.currentServerModel, "turbo-q5");

  // The transcription's own start finds the same signature and does not restart.
  await sm._policyAllowedStart(whisper.getModelPath(), dictationOptions);
  assert.equal(starts.length, 2);
});

test("a running or starting server is left alone by the dictation warm-up", async (t) => {
  const { whisper, sm, starts, cleanup } = makeWarmableWhisper();
  t.after(cleanup);
  await sm._policyAllowedStart(whisper.getModelPath(), {});
  assert.deepEqual(await whisper.warmForDictation("turbo-q5"), { success: true, skipped: true });

  sm.ready = false;
  sm.startupPromise = Promise.resolve();
  assert.deepEqual(await whisper.warmForDictation("turbo-q5"), { success: true, skipped: true });
  sm.startupPromise = null;

  sm.isRemote = true;
  assert.deepEqual(await whisper.warmForDictation("turbo-q5"), { success: true, skipped: true });
  assert.equal(starts.length, 1);
});
