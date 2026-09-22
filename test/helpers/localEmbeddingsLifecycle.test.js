const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

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
  vm.runInContext(
    fs.readFileSync(path.resolve("src/workers/onnxWorker.js"), "utf8"),
    workerContext
  );
  const dispatch = vm.runInContext("dispatch", workerContext);
  const client = {
    generation: 0,
    async request(method, payload) {
      events.push(method);
      const { reply } = await dispatch({ id: 1, method, payload });
      if (reply.error) throw new Error(reply.error.message);
      return reply.result;
    },
  };
  const exports = {};
  const localContext = vm.createContext({
    module: { exports },
    __dirname: path.resolve("src/helpers"),
    process: {},
    require(name) {
      if (name === "fs") return { existsSync: () => true };
      if (name === "./debugLogger") return { debug() {} };
      if (name === "./onnxWorkerClient") return client;
      return require(name);
    },
  });
  vm.runInContext(
    fs.readFileSync(path.resolve("src/helpers/localEmbeddings.js"), "utf8"),
    localContext
  );
  return {
    embeddings: localContext.module.exports,
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
