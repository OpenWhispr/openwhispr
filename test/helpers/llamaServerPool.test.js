const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const modelRegistryData = require("../../src/models/modelRegistryData.json");
const policy = require("../../src/helpers/llamaContextPolicy");

// Drives modelManagerBridge against stub llama-servers to pin when dictation
// cleanup and the assistant get a server each instead of swapping one, and
// when the pool falls back to the single swapping server.

const originalLoad = Module._load;
const CHAIN_MODULES = [
  "../../src/helpers/modelManagerBridge.js",
  "../../src/helpers/modelDirUtils.js",
  "../../src/helpers/llamaServer.js",
].map((relative) => require.resolve(relative));
let electronHome = os.tmpdir();

function loadModelManager() {
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
    return require("../../src/helpers/modelManagerBridge.js").default;
  } finally {
    Module._load = originalLoad;
  }
}

const GIB = 1024 * 1024 * 1024;
const CLEANUP = "qwen3.5-2b-q4_k_m";
const ASSISTANT = "qwen3.5-4b-q4_k_m";
// What the GGUFs and files on disk report for the two Qwen3.5 models.
const PROFILES = {
  [CLEANUP]: {
    weightsBytes: 1_396_198_496,
    draftWeightsBytes: 0,
    kvBytesPerToken: 51200,
    hasRecurrentState: true,
    trainedContextTokens: 262144,
  },
  [ASSISTANT]: {
    weightsBytes: 3_013_027_808,
    draftWeightsBytes: 0,
    kvBytesPerToken: 135168,
    hasRecurrentState: true,
    trainedContextTokens: 262144,
  },
};
// ~27k estimated tokens: past what the 4B may open beside the 2B on 24 GB
// (~25k), inside what it may open alone (~48k), and on the 32768 rung.
const LONG_PROMPT = "word ".repeat(16000);

function findModel(id) {
  for (const provider of modelRegistryData.localProviders) {
    const model = provider.models.find((entry) => entry.id === id);
    if (model) return model;
  }
  throw new Error(`no registry entry for ${id}`);
}

function fakeLlamaServer(t) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const payload =
        req.url === "/slots"
          ? [{ is_processing: false }]
          : req.url === "/props"
            ? {}
            : req.url === "/tokenize" || req.url === "/apply-template"
              ? null
              : { choices: [{ finish_reason: "stop", message: { content: "done" } }] };
      res.writeHead(payload === null ? 500 : 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload ?? {}));
    });
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server.address().port))
  );
}

async function setup(t, { totalMemoryBytes = 48 * GIB, unifiedMemory = true } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "openwhispr-llama-pool-"));
  electronHome = home;
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  const modelManager = loadModelManager();
  modelManager.ensureInitialized();
  await fs.mkdir(modelManager.modelsDir, { recursive: true });
  for (const id of [CLEANUP, ASSISTANT]) {
    await fs.writeFile(
      path.join(modelManager.modelsDir, findModel(id).fileName),
      Buffer.alloc(1_000_001, 1)
    );
  }
  modelManager._systemMemoryBytes = () => totalMemoryBytes;
  modelManager._unifiedMemory = () => unifiedMemory;
  modelManager._memoryProfile = async (modelInfo) => PROFILES[modelInfo.model.id];

  // Every start, by server, with what it loaded.
  const starts = [];
  for (const [index, server] of modelManager.servers.entries()) {
    const port = await fakeLlamaServer(t);
    server.cachedServerBinaryPaths = { default: "/stub/llama-server" };
    server._doStart = async (modelPath, options = {}) => {
      if (server.failNextStart) {
        server.failNextStart = false;
        throw new Error("llama-server process died during startup");
      }
      starts.push({ server: index, model: path.basename(modelPath), context: options.contextSize });
      server.modelPath = modelPath;
      server.activeContextSize = options.contextSize;
      server.ready = true;
      server.process = {};
      server.port = port;
    };
    server.stop = async () => {
      server.stops = (server.stops || 0) + 1;
      server.ready = false;
      server.process = null;
      server.modelPath = null;
      server.contextSize = null;
      server.activeContextSize = null;
    };
    t.after(() => server.clearIdleTimer());
  }
  return { modelManager, starts };
}

const cleanup = (modelManager, prompt = "um so the meeting moved") =>
  modelManager.runInference(CLEANUP, prompt, { systemPrompt: "Clean up.", busyWaitMs: 2000 });

const assistantStream = (modelManager) => modelManager.serverForModel(ASSISTANT);

const startedModels = (starts) => starts.map((start) => `${start.server}:${start.model}`);

test("alternating cleanup and the assistant loads each model once, on its own server", async (t) => {
  const { modelManager, starts } = await setup(t);

  await cleanup(modelManager);
  const assistantServer = await assistantStream(modelManager);
  for (let turn = 0; turn < 3; turn++) {
    assert.equal(await cleanup(modelManager), "done");
    assert.equal(await assistantStream(modelManager), assistantServer);
  }

  assert.deepEqual(startedModels(starts), [
    `0:${findModel(CLEANUP).fileName}`,
    `1:${findModel(ASSISTANT).fileName}`,
  ]);
  assert.notEqual(modelManager.servers[0].port, assistantServer.port);
  assert.deepEqual(modelManager.loadedModelIds().sort(), [CLEANUP, ASSISTANT].sort());
});

test("a dictation during a streaming answer is cleaned up without touching the answer", async (t) => {
  const { modelManager, starts } = await setup(t);
  const assistantServer = await assistantStream(modelManager);
  // An answer in flight on the assistant's server: a swap would have had to wait for it.
  assistantServer.activeRequest = { destroy: () => {} };

  assert.equal(await cleanup(modelManager), "done");
  assert.equal(assistantServer.stops ?? 0, 0);
  assert.equal(starts.length, 2);
});

test("a machine whose memory can't hold both models keeps swapping one server", async (t) => {
  // 16 GB: half the machine less the OS reserve is 6 GiB; the pair needs ~8.8.
  const { modelManager, starts } = await setup(t, { totalMemoryBytes: 16 * GIB });

  await cleanup(modelManager);
  await assistantStream(modelManager);
  await cleanup(modelManager);

  assert.deepEqual(
    starts.map((start) => start.server),
    [0, 0, 0],
    "every alternation reloads the one server"
  );
  assert.equal(modelManager.servers[1].ready, false);
});

test("off Apple Silicon one server is kept, whatever the system memory", async (t) => {
  // A discrete GPU's own memory isn't probed, and a second model that overflows
  // it would land on the processor.
  const { modelManager, starts } = await setup(t, { unifiedMemory: false });

  await cleanup(modelManager);
  await assistantStream(modelManager);

  assert.deepEqual(
    starts.map((start) => start.server),
    [0, 0]
  );
});

test("a second server that will not start falls back to one server for the session", async (t) => {
  const { modelManager, starts } = await setup(t);
  await cleanup(modelManager);
  modelManager.servers[1].failNextStart = true;

  const server = await assistantStream(modelManager);

  assert.equal(server, modelManager.servers[0], "the request still gets a server, by swapping");
  assert.equal(starts.at(-1).model, findModel(ASSISTANT).fileName);
  await cleanup(modelManager);
  assert.deepEqual(
    starts.map((start) => start.server),
    [0, 0, 0],
    "no second attempt at a second server"
  );
});

test("a failed second server retries the inference on one server too", async (t) => {
  const { modelManager, starts } = await setup(t);
  await assistantStream(modelManager);
  modelManager.servers[1].failNextStart = true;

  assert.equal(await cleanup(modelManager), "done");
  assert.deepEqual(
    starts.map((start) => `${start.server}:${start.model}`),
    [`0:${findModel(ASSISTANT).fileName}`, `0:${findModel(CLEANUP).fileName}`]
  );
});

test("beside another server a model's context ceiling leaves that server its memory", async (t) => {
  const { modelManager } = await setup(t, { totalMemoryBytes: 24 * GIB });
  await cleanup(modelManager);
  const modelInfo = modelManager.findModelById(ASSISTANT);
  const modelPath = path.join(modelManager.modelsDir, modelInfo.model.fileName);

  const alone = await modelManager.contextCeiling(modelInfo, modelPath);
  const beside = await modelManager.contextCeiling(modelInfo, modelPath, {
    residentBytes: await modelManager._otherServersBytes(modelManager.servers[1]),
  });

  assert.ok(beside.ceiling < alone.ceiling, `${beside.ceiling} < ${alone.ceiling}`);
  // Both servers at their ceilings still fit the one-server budget.
  const budget = 24 * GIB * policy.USABLE_MEMORY_FRACTION - policy.FIXED_OS_RESERVE_BYTES;
  const both =
    policy.residentServerBytes(PROFILES[CLEANUP], policy.BASELINE_CONTEXT_SIZE) +
    policy.residentServerBytes(PROFILES[ASSISTANT], beside.ceiling);
  assert.ok(both <= budget, `${both} <= ${budget}`);
});

test("a request too long to fit beside the other server frees it once it is idle", async (t) => {
  // 24 GB: beside the 2B the 4B may open ~25k tokens; alone, ~48k.
  const { modelManager, starts } = await setup(t, { totalMemoryBytes: 24 * GIB });
  await cleanup(modelManager);

  const result = await modelManager.runInference(ASSISTANT, LONG_PROMPT, {
    systemPrompt: "Write notes.",
  });

  assert.equal(result, "done");
  assert.equal(modelManager.servers[0].stops, 1, "the idle cleanup server made room");
  assert.deepEqual(starts.at(-1), {
    server: 1,
    model: findModel(ASSISTANT).fileName,
    context: 32768,
  });
});

test("a swap that needs the other server's memory waits for it, then reports busy", async (t) => {
  // 24 GB holds 2B + 4B but not 4B + Gemma 4 E4B, so a third model must evict both.
  const { modelManager } = await setup(t, { totalMemoryBytes: 24 * GIB });
  const third = modelRegistryData.localProviders
    .flatMap((provider) => provider.models)
    .find((model) => model.id === "gemma-4-e4b-it-q4_k_m");
  assert.ok(third, "fixture model missing from the registry");
  PROFILES[third.id] = {
    weightsBytes: 5_405_170_144,
    draftWeightsBytes: 0,
    kvBytesPerToken: 98304,
    hasRecurrentState: false,
    trainedContextTokens: 131072,
  };
  t.after(() => delete PROFILES[third.id]);
  await fs.writeFile(path.join(modelManager.modelsDir, third.fileName), Buffer.alloc(1_000_001, 1));

  await cleanup(modelManager);
  const assistantServer = await assistantStream(modelManager);
  modelManager.servers[0].lastUsedAt = 0; // cleanup is the one to replace
  // Only the assistant is busy: the cleanup server itself could be swapped at once.
  modelManager.servers[0].handoffUntil = 0;
  assistantServer.activeRequest = { destroy: () => {} };

  await assert.rejects(
    () => modelManager.runInference(third.id, "hello", { busyWaitMs: 300 }),
    (error) => error.code === "LOCAL_MODEL_BUSY"
  );
  assert.equal(assistantServer.stops ?? 0, 0, "the answer in progress is left alone");
  assert.equal(modelManager.servers[0].stops ?? 0, 0, "nothing was swapped out either");
});

test("a cancel ends the wait to free the other server, leaving both alone", async (t) => {
  // 24 GB: a long 4B request beside the 2B must free it first, and the 2B is busy.
  const { modelManager, starts } = await setup(t, { totalMemoryBytes: 24 * GIB });
  await cleanup(modelManager);
  const [cleanupServer] = modelManager.servers;
  cleanupServer.activeRequest = { destroy: () => {} };
  const abortController = new AbortController();
  setTimeout(() => abortController.abort(), 100);
  const startedAt = Date.now();

  await assert.rejects(
    () =>
      modelManager.runInference(ASSISTANT, LONG_PROMPT, {
        systemPrompt: "Write notes.",
        signal: abortController.signal,
      }),
    (error) => error.code === "LOCAL_MODEL_CANCELLED"
  );
  // Without the signal the wait runs its full minute and only the start notices.
  assert.ok(Date.now() - startedAt < 2000, `cancelled after ${Date.now() - startedAt} ms`);
  assert.equal(cleanupServer.stops ?? 0, 0, "the busy cleanup server keeps running");
  assert.ok(
    starts.every((start) => start.context !== 32768),
    "nothing grew to the window the cancelled request wanted"
  );
});

test("stopping the servers stops both, and only unneeded ones when asked", async (t) => {
  const { modelManager } = await setup(t);
  await cleanup(modelManager);
  await assistantStream(modelManager);

  await modelManager.stopServersNotNeeded((modelId) => modelId === ASSISTANT);
  assert.deepEqual(modelManager.loadedModelIds(), [CLEANUP]);

  await assistantStream(modelManager);
  await modelManager.stopServer();
  assert.deepEqual(modelManager.loadedModelIds(), []);
});

test("Keep model loaded reaches both servers", async (t) => {
  const { modelManager } = await setup(t);
  modelManager.setKeepResident(true);
  assert.deepEqual(
    modelManager.servers.map((server) => server.keepResident),
    [true, true]
  );
});

test("each server records its own sidecar pid", async (t) => {
  const { modelManager } = await setup(t);
  const names = modelManager.servers.map((server) => server.pidName);
  assert.equal(new Set(names).size, names.length);
  assert.equal(names[0], "llama", "the first keeps the name older builds wrote");
});
