const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const modelRegistryData = require("../../shared/ai/modelRegistryData.json");
const { buildGguf, LLAMA_3_2_3B_ENTRIES } = require("./harness/ggufFixtures");

// Drives the primary local LLM path end to end — the IPC bridge
// (localReasoningBridge) → modelManagerBridge.runInference →
// llamaServer.inference — against an HTTP stub standing in for llama-server,
// so the request body that actually reaches the wire is what gets asserted.
// Electron is stubbed the same way modelManagerBridgeDownloadStatus.test.js
// does; the fake model file and the pre-"started" server keep runInference on
// its happy path without spawning anything.

const originalLoad = Module._load;
const CHAIN_MODULES = [
  "../../src/services/localReasoningBridge.js",
  "../../src/helpers/modelManagerBridge.js",
  "../../src/helpers/modelDirUtils.js",
  "../../src/helpers/llamaServer.js",
].map((relative) => require.resolve(relative));
let electronHome = os.tmpdir();

function loadChain() {
  for (const modulePath of CHAIN_MODULES) delete require.cache[modulePath];

  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "electron") {
      return {
        app: {
          isReady: () => true,
          getAppPath: () => process.cwd(),
          getPath: (name) => (name === "home" ? electronHome : path.join(electronHome, name)),
        },
        net: {},
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    require("../../src/helpers/modelDirUtils.js");
    const bridge = require("../../src/services/localReasoningBridge.js").default;
    const modelManager = require("../../src/helpers/modelManagerBridge.js").default;
    return { bridge, modelManager };
  } finally {
    Module._load = originalLoad;
  }
}

// A real GGUF header padded past the minimum-size check, so the context
// ceiling is computed from the model's own architecture rather than falling
// back to the baseline the moment a caller asks for a bigger window.
const MODEL_FILE = Buffer.concat([buildGguf(LLAMA_3_2_3B_ENTRIES), Buffer.alloc(1_000_001, 1)]);
const ROOMY_MACHINE_BYTES = 48 * 1024 * 1024 * 1024;

// Stands up the stub server plus a bridge whose model manager already
// believes llama-server is running that model on the stub's port.
async function setupChain(t, respond) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "openwhispr-local-chain-"));
  electronHome = home;
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      requests.push(JSON.parse(raw));
      const reply = respond();
      // null leaves the request hanging, like a model still generating.
      if (reply === null) return;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });

  const { bridge, modelManager } = loadChain();
  const model = modelRegistryData.localProviders[0].models[0];
  modelManager.ensureInitialized();
  await fs.mkdir(modelManager.modelsDir, { recursive: true });
  await fs.writeFile(path.join(modelManager.modelsDir, model.fileName), MODEL_FILE);
  modelManager._systemMemoryBytes = () => ROOMY_MACHINE_BYTES;

  const serverManager = modelManager.serverManager;
  serverManager.cachedServerBinaryPaths = { default: "/stub/llama-server" };
  serverManager.ready = true;
  serverManager.process = {};
  serverManager.port = server.address().port;
  modelManager.currentServerModelId = model.id;
  t.after(() => serverManager.clearIdleTimer());

  return { bridge, modelManager, modelId: model.id, requests, serverManager };
}

const completion = (finishReason, content) => ({
  choices: [{ finish_reason: finishReason, message: { content } }],
});

test("requireCompleteOutput rejects a truncated reply through the whole local chain", async (t) => {
  const { bridge, modelId } = await setupChain(t, () => completion("length", "partial edi"));

  await assert.rejects(
    () => bridge.processText("edit this", modelId, { requireCompleteOutput: true }),
    (error) => {
      assert.equal(error.code, "OUTPUT_TRUNCATED");
      assert.match(error.message, /truncated/);
      return true;
    }
  );
});

test("a truncated reply still resolves when the caller did not require complete output", async (t) => {
  const { bridge, modelId } = await setupChain(t, () => completion("length", "partial"));

  assert.equal(await bridge.processText("clean this", modelId, {}), "partial");
});

test("an explicit temperature of 0 reaches llama-server instead of the 0.7 default", async (t) => {
  const { bridge, modelId, requests } = await setupChain(t, () => completion("stop", "ok"));

  await bridge.processText("clean this", modelId, { temperature: 0 });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].temperature, 0);
});

test("a caller's contextSize reaches the server start (regression: it was dropped)", async (t) => {
  // ReasoningConfig.contextSize was declared, written by selection editing,
  // and then rebuilt away in this bridge, so it never reached anything. The
  // field only means something now that the server can grow, so the wiring
  // needs a guard that fails if anyone rebuilds the config object again.
  // It raises the floor only as far as the machine's ceiling allows, which is
  // why this harness has to present a machine and a model that can afford it.
  const { bridge, modelId, serverManager } = await setupChain(t, () => completion("stop", "ok"));

  const started = [];
  serverManager._doStart = async (modelPath, options = {}) => {
    started.push(options.contextSize);
    serverManager.ready = true;
    serverManager.process = {};
  };
  serverManager.stop = async () => {
    serverManager.ready = false;
    serverManager.process = null;
    serverManager.contextSize = null;
  };
  serverManager.contextSize = 16384;

  await bridge.processText("short text", modelId, { contextSize: 32768 });

  assert.deepEqual(started, [32768]);
});

test("refuseClippedByWindow reaches runInference (the bridge rebuilds the config)", async (t) => {
  const { bridge, modelManager, modelId } = await setupChain(t, () => completion("stop", "ok"));
  const forwarded = [];
  const runInference = modelManager.runInference.bind(modelManager);
  modelManager.runInference = (id, text, options) => {
    forwarded.push(options);
    return runInference(id, text, options);
  };

  await bridge.processText("summarise this", modelId, { refuseClippedByWindow: true });

  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].refuseClippedByWindow, true);
});

test("a second request while one is in flight is refused with a typed code", async (t) => {
  // A note summarised in parts holds the bridge for minutes; whatever arrives
  // meanwhile (another note's action, dictation cleanup) must fail with a code
  // the renderer can translate rather than the raw guard text.
  const { bridge, modelManager, modelId } = await setupChain(t, () => completion("stop", "ok"));
  let release;
  modelManager.runInference = () =>
    new Promise((resolve) => {
      release = () => resolve("first reply");
    });

  const first = bridge.processText("first", modelId, {});
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(bridge.processText("second", modelId, {}), (error) => {
    assert.equal(error.code, "LOCAL_MODEL_BUSY");
    return true;
  });

  release();
  assert.equal(await first, "first reply");
});

test("cancel aborts only the in-flight request carrying that id, and frees the slot", async (t) => {
  // A note cancelled mid-part used to hold the one local slot until the model
  // finished, so an immediate rerun (or dictation cleanup) was refused as busy.
  let hang = true;
  const { bridge, modelId, requests } = await setupChain(t, () =>
    hang ? null : completion("stop", "ok")
  );

  const pending = bridge.processText("long part", modelId, { requestId: "run-1" });
  const settled = pending.then(
    () => "resolved",
    (error) => error
  );
  while (requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));

  bridge.cancel("run-2");
  const stillPending = await Promise.race([
    settled,
    new Promise((resolve) => setTimeout(() => resolve("pending"), 50)),
  ]);
  assert.equal(stillPending, "pending", "another caller's id must not abort this request");

  bridge.cancel("run-1");
  assert.ok((await settled) instanceof Error, "the tagged request is aborted");

  hang = false;
  assert.equal(await bridge.processText("next", modelId, {}), "ok");
});
