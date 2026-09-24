const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const WORKER_SOURCE = fs.readFileSync(path.resolve("src/workers/onnxWorker.js"), "utf8");
const CLIENT_SOURCE = fs.readFileSync(path.resolve("src/helpers/onnxWorkerClient.js"), "utf8");
const EMBEDDINGS_SOURCE = fs.readFileSync(path.resolve("src/helpers/localEmbeddings.js"), "utf8");

function fakeOrt(events, nativeSession) {
  return {
    InferenceSession: {
      create: async (file) => {
        events.push(`${file === "speaker" ? "speaker" : "text"}.create`);
        return nativeSession(file === "speaker" ? "speaker" : "text");
      },
    },
    Tensor: class {},
  };
}

function loadEmbeddings(client) {
  const localContext = vm.createContext({
    module: { exports: {} },
    __dirname: path.resolve("src/helpers"),
    process: {},
    require(name) {
      if (name === "fs") return { existsSync: () => true };
      if (name === "./debugLogger") return { debug() {} };
      if (name === "./onnxWorkerClient") return client;
      return require(name);
    },
  });
  vm.runInContext(EMBEDDINGS_SOURCE, localContext);
  return localContext.module.exports;
}

function createHarness() {
  const events = [];
  let releaseInference;
  let gateInference = false;
  const nativeSession = (name) => ({
    inputNames: ["input"],
    async run() {
      events.push(`${name}.run`);
      if (name === "text" && gateInference) {
        await new Promise((resolve) => {
          releaseInference = resolve;
        });
      }
      events.push(`${name}.done`);
      return { last_hidden_state: { data: new Float32Array(768).fill(1) } };
    },
    async release() {
      events.push(`${name}.release`);
    },
  });
  const workerContext = vm.createContext({
    require(name) {
      if (name === "fs") return { readFileSync: () => JSON.stringify({ model: { vocab: {} } }) };
      if (name === "onnxruntime-node")
        return {
          InferenceSession: {
            create: async (file) => nativeSession(file === "speaker" ? "speaker" : "text"),
          },
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
    async request(method, payload) {
      events.push(method);
      const { reply } = await dispatch({ id: 1, method, payload });
      if (reply.error) throw new Error(reply.error.message);
      return reply.result;
    },
    async releaseIfIdle() {
      events.push("releaseIfIdle");
      return false;
    },
  };
  return {
    embeddings: loadEmbeddings(client),
    client,
    events,
    gateInference() {
      gateInference = true;
    },
    releaseInference() {
      gateInference = false;
      releaseInference();
    },
  };
}

async function nextTurn() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("unloads the text session, preserves speaker inference, and reloads on next embedding", async () => {
  const { embeddings, client, events } = createHarness();
  await client.request("speaker.load", { modelPath: "speaker" });
  await embeddings.embedText("");
  await embeddings.unload();
  const { sessions } = await client.request("ping", {});
  assert.equal(sessions.text, false);
  assert.equal(sessions.speaker, true);
  await client.request("speaker.extract", { samplesBuffer: new Float32Array(400).buffer });
  assert.ok(events.includes("speaker.run"));
  assert.ok(!events.includes("speaker.release"));
  await embeddings.embedText("");
  assert.equal(events.filter((event) => event === "text.load").length, 2);
});

test("unload waits for inference and a racing embedding reloads after release", async () => {
  const harness = createHarness();
  harness.gateInference();
  const first = harness.embeddings.embedText("");
  await nextTurn();
  const unloading = harness.embeddings.unload();
  const second = harness.embeddings.embedText("");
  await nextTurn();
  assert.ok(!harness.events.includes("text.release"));
  harness.releaseInference();
  await Promise.all([first, unloading, second]);
  assert.deepEqual(
    harness.events.filter((event) => event.startsWith("text")),
    [
      "text.load",
      "text.embed",
      "text.run",
      "text.done",
      "text.unload",
      "text.release",
      "text.load",
      "text.embed",
      "text.run",
      "text.done",
    ]
  );
});

test("worker serializes text unload behind in-flight native inference", async () => {
  const harness = createHarness();
  await harness.client.request("text.load", { modelDir: "text" });
  harness.gateInference();
  const first = harness.client.request("text.embed", { text: "" });
  await nextTurn();
  const unload = harness.client.request("text.unload", {});
  await nextTurn();
  assert.ok(!harness.events.includes("text.release"));
  harness.releaseInference();
  await Promise.all([first, unload]);
  assert.ok(harness.events.indexOf("text.done") < harness.events.indexOf("text.release"));
});

test("reloads after the shared worker restarts", async () => {
  const { embeddings, client, events } = createHarness();
  await embeddings.embedText("");
  await client.request("text.unload", {});
  client.generation += 1;
  await embeddings.embedText("");
  assert.equal(events.filter((event) => event === "text.load").length, 2);
});

test("speaker embeddings reload after the shared worker restarts", async () => {
  const methods = [];
  const client = {
    generation: 0,
    async request(method) {
      methods.push(method);
      return method === "speaker.extract" ? { embeddingBuffer: new ArrayBuffer(4) } : { ok: true };
    },
  };
  const context = vm.createContext({
    module: { exports: {} },
    process: {},
    require(name) {
      if (name === "fs") return { existsSync: () => true };
      if (name === "./debugLogger") return { debug() {} };
      if (name === "./modelDirUtils") return { getModelsDirForService: () => "/models" };
      if (name === "./onnxWorkerClient") return client;
      return require(name);
    },
  });
  vm.runInContext(
    fs.readFileSync(path.resolve("src/helpers/speakerEmbeddings.js"), "utf8"),
    context
  );
  const speakerEmbeddings = context.module.exports;
  const samples = new Float32Array(16000 * 2);
  await speakerEmbeddings.extractEmbeddingFromSamples(samples);
  client.generation += 1;
  await speakerEmbeddings.extractEmbeddingFromSamples(samples);
  assert.equal(methods.filter((method) => method === "speaker.load").length, 2);
});

test("a failed load does not block unloading or the next load attempt", async () => {
  const { embeddings, client, events } = createHarness();
  const request = client.request.bind(client);
  let failLoad = true;
  client.request = async (method, payload) => {
    if (method === "text.load" && failLoad) {
      failLoad = false;
      throw new Error("model unavailable");
    }
    return request(method, payload);
  };
  await assert.rejects(embeddings.embedText(""), /model unavailable/);
  await embeddings.unload();
  const result = await embeddings.embedText("");
  assert.equal(result.length, 384);
  assert.equal(events.filter((event) => event === "text.run").length, 1);
});

test("unload waits for the complete embedding batch", async () => {
  const harness = createHarness();
  harness.gateInference();
  const batch = harness.embeddings.embedTexts(["", ""]);
  await nextTurn();
  const unload = harness.embeddings.unload();
  harness.releaseInference();
  assert.equal((await batch).length, 2);
  await unload;
  const finished = harness.events.lastIndexOf("text.done");
  assert.ok(finished < harness.events.indexOf("text.release"));
});

test("unload asks the worker client to release itself once the text session is gone", async () => {
  const { embeddings, events } = createHarness();
  await embeddings.embedText("");
  await embeddings.unload();
  assert.ok(events.indexOf("text.unload") < events.indexOf("releaseIfIdle"));
});

class FakePort extends EventEmitter {
  constructor() {
    super();
    this.peer = null;
    this.closed = false;
  }

  start() {}

  postMessage(data) {
    const { peer } = this;
    setImmediate(() => {
      if (!peer.closed) peer.emit("message", { data });
    });
  }

  close() {
    this.closed = true;
    this.peer.emit("close");
  }
}

// The real client driving the real worker source: each fork boots a fresh worker context.
function createIntegratedHarness() {
  const events = [];
  const workers = [];
  const nativeSession = (name) => ({
    inputNames: ["input"],
    async run() {
      return { last_hidden_state: { data: new Float32Array(768).fill(1) } };
    },
    async release() {
      events.push(`${name}.release`);
    },
  });
  const fork = () => {
    let onInit = null;
    const worker = { exited: null };
    const workerContext = vm.createContext({
      require(name) {
        if (name === "fs") return { readFileSync: () => JSON.stringify({ model: { vocab: {} } }) };
        if (name === "onnxruntime-node") return fakeOrt(events, nativeSession);
        return require(name);
      },
      process: {
        env: {},
        pid: 500 + workers.length,
        on() {},
        exit(code) {
          worker.exited = code;
        },
        parentPort: {
          once(_, callback) {
            onInit = callback;
          },
        },
      },
      setImmediate,
    });
    vm.runInContext(WORKER_SOURCE, workerContext);
    const child = new EventEmitter();
    child.pid = workerContext.process.pid;
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      setImmediate(() => child.emit("exit", 0));
    };
    child.postMessage = (data, ports) => onInit({ data, ports });
    workers.push({ child, worker });
    setImmediate(() => child.emit("spawn"));
    return child;
  };
  const clientContext = vm.createContext({
    module: { exports: {} },
    __dirname: path.resolve("src/helpers"),
    process,
    setTimeout,
    clearTimeout,
    require(name) {
      if (name === "electron")
        return {
          app: { getPath: () => "/tmp" },
          MessageChannelMain: class {
            constructor() {
              this.port1 = new FakePort();
              this.port2 = new FakePort();
              this.port1.peer = this.port2;
              this.port2.peer = this.port1;
            }
          },
          utilityProcess: { fork },
        };
      if (name === "./debugLogger") return { debug() {}, info() {}, warn() {}, error() {} };
      return require(name);
    },
  });
  vm.runInContext(CLIENT_SOURCE, clientContext);
  const client = clientContext.module.exports;
  return { client, embeddings: loadEmbeddings(client), events, workers };
}

test("unloading the last session exits the worker and a later embedding respawns and reloads it", async () => {
  const h = createIntegratedHarness();
  await h.embeddings.embedText("");
  await h.embeddings.unload();
  assert.deepEqual(h.events, ["text.create", "text.release"]);
  assert.equal(h.workers.length, 1);
  assert.equal(h.workers[0].child.killed, true);
  assert.equal(h.client.child, null);
  assert.equal(h.workers[0].worker.exited, 0);
  assert.equal((await h.embeddings.embedText("")).length, 384);
  assert.equal(h.workers.length, 2);
  assert.deepEqual(h.events, ["text.create", "text.release", "text.create"]);
});

test("unloading text keeps the worker alive while diarization holds a speaker session", async () => {
  const h = createIntegratedHarness();
  await h.client.request("speaker.load", { modelPath: "speaker" });
  await h.embeddings.embedText("");
  await h.embeddings.unload();
  assert.equal(h.workers.length, 1);
  assert.equal(h.workers[0].child.killed, false);
  assert.ok(h.client.child);
  const { sessions } = await h.client.request("ping", {});
  assert.equal(sessions.speaker, true);
  assert.equal(sessions.text, false);
});
