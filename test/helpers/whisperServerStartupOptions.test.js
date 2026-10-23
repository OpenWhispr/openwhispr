const test = require("node:test");
const assert = require("node:assert/strict");
const WhisperManager = require("../../src/helpers/whisper");
const WhisperServerManager = require("../../src/helpers/whisperServer");
const { pcm16Mono16kWav } = require("./harness/wavFixtures");

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Stub only process startup/teardown and inference, as in whisperServerGpuGuard.
// Keep the real configuration selection, start coordination and dictation path.
function createHarness() {
  const whisper = new WhisperManager();
  const server = whisper.serverManager;
  const firstStart = deferred();
  const starts = [];
  let activeOptions;
  whisper.getModelPath = (name) => `/models/${name}.bin`;
  whisper.getVadModelPath = () => "/models/silero.bin";
  whisper.resolveGpuStartOptions = () => ({});
  server._doStart = async (modelPath, options) => {
    starts.push({ modelPath, options });
    if (starts.length === 1) await firstStart.promise;
    activeOptions = options;
    server.modelPath = modelPath;
    server.gpuSignature = WhisperServerManager.getGpuSignature(options);
    server.process = {};
    server.ready = true;
  };
  server.stop = async () => {
    server.process = null;
    server.ready = false;
    server.modelPath = null;
    server.gpuFallbackActive = false;
  };
  server.transcribe = async () => {
    assert.equal(activeOptions.vadEnabled, true, "the inference must use the requested VAD");
    assert.equal(activeOptions.vadModelPath, "/models/silero.bin");
    return { text: "hello" };
  };
  return { whisper, server, firstStart, starts };
}

for (const overlap of [false, true]) {
  test(`dictation applies VAD ${overlap ? "during" : "after"} cold prewarm`, async () => {
    const h = createHarness();
    const prewarm = h.server.start("/models/base.bin", {});
    if (!overlap) {
      h.firstStart.resolve();
      await prewarm;
    }
    const dictation = h.whisper.transcribeViaServer(pcm16Mono16kWav(), "base", "auto", null, {
      vadEnabled: true,
    });
    h.firstStart.resolve();
    await prewarm;
    assert.equal((await dictation).text, "hello");
    assert.equal(h.starts.length, 2);
    assert.equal(h.whisper._transcribing, false);
  });
}

test("a different model requested during prewarm is loaded before start resolves", async () => {
  const h = createHarness();
  const prewarm = h.server.start("/models/base.bin");
  const selected = h.server.start("/models/small.bin");
  h.firstStart.resolve();
  await Promise.all([prewarm, selected]);
  assert.equal(h.server.modelPath, "/models/small.bin");
  assert.deepEqual(
    h.starts.map((start) => start.modelPath),
    ["/models/base.bin", "/models/small.bin"]
  );
});

test("matching cold starts share one load and preserve the ready no-op", async () => {
  const h = createHarness();
  const options = { threads: 2 };
  const starts = Array.from({ length: 3 }, () => h.server.start("/models/base.bin", options));
  h.firstStart.resolve();
  await Promise.all(starts);
  await h.server.start("/models/base.bin", options);
  assert.equal(h.starts.length, 1);
});

test("waiters during teardown share one replacement instead of spawning competitors", async () => {
  const h = createHarness();
  h.firstStart.resolve();
  await h.server.start("/models/base.bin");
  const stopping = deferred();
  const releaseStop = deferred();
  const stop = h.server.stop;
  let stops = 0;
  h.server.stop = async () => {
    stops += 1;
    stopping.resolve();
    await releaseStop.promise;
    await stop();
  };
  const replacement = h.server.start("/models/small.bin");
  await stopping.promise;
  const peer = h.server.start("/models/small.bin");
  releaseStop.resolve();
  await Promise.all([replacement, peer]);
  assert.equal(stops, 1);
  assert.equal(h.starts.length, 2);
  assert.equal(h.server.modelPath, "/models/small.bin");
});

test("a failed prewarm rejects its caller without poisoning a queued start", async () => {
  const h = createHarness();
  const load = h.server._doStart;
  const error = new Error("prewarm failed");
  let attempts = 0;
  h.server._doStart = async (...args) => {
    if (attempts++ === 0) {
      await h.firstStart.promise;
      throw error;
    }
    return load(...args);
  };
  const prewarm = h.server.start("/models/base.bin").catch((actual) => actual);
  const selected = h.server.start("/models/small.bin").then(
    () => null,
    (actual) => actual
  );
  h.firstStart.resolve();
  assert.equal(await prewarm, error);
  assert.equal(await selected, null);
  assert.equal(h.server.modelPath, "/models/small.bin");
  assert.equal(h.server.startupPromise, null);
});
