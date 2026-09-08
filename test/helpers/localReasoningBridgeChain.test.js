const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const modelRegistryData = require("../../src/models/modelRegistryData.json");

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

const OVER_MIN_FILE_SIZE = Buffer.alloc(1_000_001, 1);

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
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(respond()));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { bridge, modelManager } = loadChain();
  const model = modelRegistryData.localProviders[0].models[0];
  modelManager.ensureInitialized();
  await fs.mkdir(modelManager.modelsDir, { recursive: true });
  await fs.writeFile(path.join(modelManager.modelsDir, model.fileName), OVER_MIN_FILE_SIZE);

  const serverManager = modelManager.serverManager;
  serverManager.cachedServerBinaryPaths = { default: "/stub/llama-server" };
  serverManager.ready = true;
  serverManager.process = {};
  serverManager.port = server.address().port;
  modelManager.currentServerModelId = model.id;
  t.after(() => serverManager.clearIdleTimer());

  return { bridge, modelId: model.id, requests };
}

const completion = (finishReason, content) => ({
  choices: [{ finish_reason: finishReason, message: { content } }],
});

test("requireCompleteOutput rejects a truncated reply through the whole local chain", async (t) => {
  const { bridge, modelId } = await setupChain(t, () => completion("length", "partial edi"));

  await assert.rejects(
    () => bridge.processText("edit this", modelId, { requireCompleteOutput: true }),
    /truncated/
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
