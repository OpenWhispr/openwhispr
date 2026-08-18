const Module = require("node:module");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const modelRegistryData = require("../../../src/models/modelRegistryData.json");

// Stands up the primary local LLM path end to end — the IPC bridge
// (localReasoningBridge) → modelManagerBridge.runInference →
// llamaServer.inference — against an HTTP stub standing in for llama-server,
// so the request body that actually reaches the wire is what gets asserted.
// Electron is stubbed the same way modelManagerBridgeDownloadStatus.test.js
// does; the fake model files and the pre-"started" server keep runInference on
// its happy path without spawning anything.

const originalLoad = Module._load;
const CHAIN_MODULES = [
  "../../../src/services/localReasoningBridge.js",
  "../../../src/helpers/modelManagerBridge.js",
  "../../../src/helpers/modelDirUtils.js",
  "../../../src/helpers/llamaServer.js",
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
    require("../../../src/helpers/modelDirUtils.js");
    const bridge = require("../../../src/services/localReasoningBridge.js").default;
    const modelManager = require("../../../src/helpers/modelManagerBridge.js").default;
    return { bridge, modelManager };
  } finally {
    Module._load = originalLoad;
  }
}

const OVER_MIN_FILE_SIZE = Buffer.alloc(1_000_001, 1);

function findRegistryModel(modelId) {
  for (const provider of modelRegistryData.localProviders) {
    const model = provider.models.find((m) => m.id === modelId);
    if (model) return model;
  }
  return null;
}

const completion = (finishReason, content) => ({
  choices: [{ finish_reason: finishReason, message: { content } }],
});

/**
 * Sets up the stub server plus a bridge whose model manager already believes
 * llama-server is running on the stub's port. `useModel(id)` writes the fake
 * GGUF for a registry model (or the supplied `{ id, fileName }` for a
 * non-registry one) and points the manager at it, so a test can walk many
 * models without restarting anything. `requests` collects the wire bodies in
 * order; `inferenceCalls` records the options each llamaServer.inference call
 * received.
 */
async function setupLocalChain(t, { respond = () => completion("stop", "ok") } = {}) {
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
  modelManager.ensureInitialized();
  await fs.mkdir(modelManager.modelsDir, { recursive: true });

  const serverManager = modelManager.serverManager;
  serverManager.cachedServerBinaryPaths = { default: "/stub/llama-server" };
  serverManager.ready = true;
  serverManager.process = {};
  serverManager.port = server.address().port;
  t.after(() => serverManager.clearIdleTimer());

  const inferenceCalls = [];
  const realInference = serverManager.inference.bind(serverManager);
  serverManager.inference = (messages, options) => {
    inferenceCalls.push(options);
    return realInference(messages, options);
  };

  const written = new Set();
  const useModel = async (modelOrId) => {
    const model = typeof modelOrId === "string" ? findRegistryModel(modelOrId) : modelOrId;
    if (!model) throw new Error(`No registry model with id ${modelOrId}`);
    if (!written.has(model.fileName)) {
      await fs.writeFile(path.join(modelManager.modelsDir, model.fileName), OVER_MIN_FILE_SIZE);
      written.add(model.fileName);
    }
    modelManager.currentServerModelId = model.id;
    return model.id;
  };

  return { bridge, modelManager, serverManager, requests, inferenceCalls, useModel };
}

module.exports = { setupLocalChain, completion, findRegistryModel };
