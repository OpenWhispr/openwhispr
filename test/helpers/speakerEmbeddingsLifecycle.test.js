const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const WORKER_SOURCE = fs.readFileSync(path.resolve("src/workers/onnxWorker.js"), "utf8");
const SPEAKER_SOURCE = fs.readFileSync(path.resolve("src/helpers/speakerEmbeddings.js"), "utf8");

const SAMPLES = new Float32Array(16000 * 2).fill(0.1);

function createTimers() {
  const timers = [];
  return {
    timers,
    active: () => timers.filter((timer) => !timer.cleared && !timer.fired),
    setTimeout(callback) {
      const timer = { callback, cleared: false, fired: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cleared = true;
    },
    fire(timer) {
      timer.fired = true;
      timer.callback();
    },
  };
}

function createHarness() {
  const events = [];
  const logs = [];
  const timers = createTimers();
  let releaseInference;
  let gateInference = false;
  const nativeSession = (name) => ({
    inputNames: ["input"],
    async run() {
      events.push(`${name}.run`);
      if (gateInference) {
        await new Promise((resolve) => {
          releaseInference = resolve;
        });
      }
      events.push(`${name}.done`);
      return { output: { data: new Float32Array(512).fill(1) } };
    },
    async release() {
      events.push(`${name}.release`);
    },
  });
  const workerContext = vm.createContext({
    require(name) {
      if (name === "onnxruntime-node")
        return {
          InferenceSession: { create: async () => nativeSession("speaker") },
          Tensor: class {},
        };
      return require(name);
    },
    process: { env: {}, on() {}, parentPort: { once() {} } },
    setImmediate,
  });
  vm.runInContext(WORKER_SOURCE, workerContext);
  const dispatch = vm.runInContext("dispatch", workerContext);
  const client = {
    generation: 0,
    failNext: null,
    async request(method, payload) {
      events.push(method);
      if (this.failNext === method) {
        this.failNext = null;
        throw new Error("worker unavailable");
      }
      const { reply } = await dispatch({ id: 1, method, payload });
      if (reply.error) throw new Error(reply.error.message);
      return reply.result;
    },
    async releaseIfIdle() {
      events.push("releaseIfIdle");
      return true;
    },
  };
  const context = vm.createContext({
    module: { exports: {} },
    process: {},
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    require(name) {
      if (name === "fs") return { existsSync: () => true };
      if (name === "./debugLogger")
        return Object.fromEntries(
          ["debug", "warn"].map((level) => [
            level,
            (message, meta) => logs.push({ level, message, meta }),
          ])
        );
      if (name === "./modelDirUtils") return { getModelsDirForService: () => "/models" };
      if (name === "./onnxWorkerClient") return client;
      return require(name);
    },
  });
  vm.runInContext(SPEAKER_SOURCE, context);
  return {
    speaker: context.module.exports,
    client,
    events,
    logs,
    timers,
    gateInference() {
      gateInference = true;
    },
    releaseInference() {
      gateInference = false;
      releaseInference();
    },
  };
}

async function flush() {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

test("an extract arms an idle unload that releases the speaker session, then the worker", async () => {
  const h = createHarness();
  assert.ok(await h.speaker.extractEmbeddingFromSamples(SAMPLES));
  const [timer] = h.timers.active();
  h.timers.fire(timer);
  await flush();
  const { sessions } = await h.client.request("ping", {});
  assert.equal(sessions.speaker, false);
  assert.ok(h.events.indexOf("speaker.release") < h.events.indexOf("releaseIfIdle"));
});

test("each extract restarts the idle window", async () => {
  const h = createHarness();
  await h.speaker.extractEmbeddingFromSamples(SAMPLES);
  await h.speaker.extractEmbeddingFromSamples(SAMPLES);
  assert.equal(h.timers.active().length, 1);
});

test("extracts queued together leave a single idle timer", async () => {
  const h = createHarness();
  h.gateInference();
  const first = h.speaker.extractEmbeddingFromSamples(SAMPLES);
  const second = h.speaker.extractEmbeddingFromSamples(SAMPLES);
  await flush();
  h.releaseInference();
  await Promise.all([first, second]);
  assert.equal(h.timers.active().length, 1);
});

test("a failed extract still arms the idle unload", async () => {
  const h = createHarness();
  h.client.failNext = "speaker.extract";
  await assert.rejects(h.speaker.extractEmbeddingFromSamples(SAMPLES), /worker unavailable/);
  assert.equal(h.timers.active().length, 1);
});

test("an extract in flight holds off the idle unload until it finishes", async () => {
  const h = createHarness();
  await h.speaker.extractEmbeddingFromSamples(SAMPLES);
  h.gateInference();
  const second = h.speaker.extractEmbeddingFromSamples(SAMPLES);
  assert.equal(h.timers.active().length, 0);
  await flush();
  h.releaseInference();
  await second;
  assert.equal(h.timers.active().length, 1);
  assert.ok(!h.events.includes("speaker.unload"));
});

test("a segment too short to embed neither loads the model nor arms the timer", async () => {
  const h = createHarness();
  assert.equal(await h.speaker.extractEmbeddingFromSamples(new Float32Array(1000)), null);
  assert.deepEqual(h.events, []);
  assert.equal(h.timers.timers.length, 0);
});

test("unload waits for an in-flight extract and a racing extract reloads after release", async () => {
  const h = createHarness();
  h.gateInference();
  const first = h.speaker.extractEmbeddingFromSamples(SAMPLES);
  await flush();
  const unloading = h.speaker.unload();
  const second = h.speaker.extractEmbeddingFromSamples(SAMPLES);
  await flush();
  assert.ok(!h.events.includes("speaker.release"));
  h.releaseInference();
  await Promise.all([first, unloading, second]);
  assert.deepEqual(
    h.events.filter((event) => event.startsWith("speaker")),
    [
      "speaker.load",
      "speaker.extract",
      "speaker.run",
      "speaker.done",
      "speaker.unload",
      "speaker.release",
      "speaker.load",
      "speaker.extract",
      "speaker.run",
      "speaker.done",
    ]
  );
});

test("worker serializes speaker unload behind in-flight native inference", async () => {
  const h = createHarness();
  await h.client.request("speaker.load", { modelPath: "speaker" });
  h.gateInference();
  const extracting = h.client.request("speaker.extract", { samplesBuffer: SAMPLES.buffer });
  await flush();
  const unloading = h.client.request("speaker.unload", {});
  await flush();
  assert.ok(!h.events.includes("speaker.release"));
  h.releaseInference();
  await Promise.all([extracting, unloading]);
  assert.ok(h.events.indexOf("speaker.done") < h.events.indexOf("speaker.release"));
});

test("reloads after the shared worker restarts", async () => {
  const h = createHarness();
  await h.speaker.extractEmbeddingFromSamples(SAMPLES);
  h.client.generation += 1;
  await h.speaker.extractEmbeddingFromSamples(SAMPLES);
  assert.equal(h.events.filter((event) => event === "speaker.load").length, 2);
});

test("a failed idle unload is logged and the next extract still reloads", async () => {
  const h = createHarness();
  await h.speaker.extractEmbeddingFromSamples(SAMPLES);
  h.client.failNext = "speaker.unload";
  h.timers.fire(h.timers.active()[0]);
  await flush();
  assert.ok(
    h.logs.some((entry) => entry.level === "warn" && /idle unload failed/.test(entry.message))
  );
  await h.speaker.extractEmbeddingFromSamples(SAMPLES);
  assert.equal(h.events.filter((event) => event === "speaker.load").length, 2);
});
