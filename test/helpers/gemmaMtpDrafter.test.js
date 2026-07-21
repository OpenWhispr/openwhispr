const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const modelManagerModulePath = require.resolve("../../src/helpers/modelManagerBridge.js");
const originalLoad = Module._load;
let electronHome = os.tmpdir();

const QAT_ID = "gemma-4-e2b-it-qat-q4_0";
const NON_QAT_ID = "gemma-4-e2b-it-q4_k_m";

function loadModelManager() {
  delete require.cache[modelManagerModulePath];

  Module._load = function loadWithMocks(request) {
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
    return originalLoad.apply(this, arguments);
  };

  try {
    return require("../../src/helpers/modelManagerBridge.js").default;
  } finally {
    Module._load = originalLoad;
  }
}

async function withHome(prefix, fn) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  electronHome = home;
  try {
    return await fn(home);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

const OVER_MIN = Buffer.alloc(1_000_001, 1); // > MIN_FILE_SIZE (1MB)
const UNDER_MIN = Buffer.alloc(500, 1);

test("modelHasDrafter is true only for entries declaring a drafter", () => {
  const mm = loadModelManager();
  const qat = mm.findModelById(QAT_ID).model;
  const plain = mm.findModelById(NON_QAT_ID).model;
  assert.equal(mm.modelHasDrafter(qat), true);
  assert.equal(mm.modelHasDrafter(plain), false);
  assert.equal(mm.modelHasDrafter(undefined), false);
});

test("getDraftDownloadUrl mirrors the main URL shape", () => {
  const mm = loadModelManager();
  const { model, provider } = mm.findModelById(QAT_ID);
  assert.equal(
    mm.getDraftDownloadUrl(provider, model),
    `${provider.baseUrl}/${model.draftHfRepo}/resolve/main/${model.draftFileName}`
  );
});

test("resolveDraftPath returns the path only when a valid drafter file exists", async () => {
  await withHome("openwhispr-draft-resolve-", async () => {
    const mm = loadModelManager();
    mm.ensureInitialized();
    await fs.mkdir(mm.modelsDir, { recursive: true });

    const model = mm.findModelById(QAT_ID).model;
    const draftPath = path.join(mm.modelsDir, model.draftFileName);

    // Missing drafter → null (keeps today's behavior for pre-feature downloads).
    assert.equal(await mm.resolveDraftPath(model), null);

    // Too small → fails the >1MB gate → null.
    await fs.writeFile(draftPath, UNDER_MIN);
    assert.equal(await mm.resolveDraftPath(model), null);

    // Valid drafter → returns the path.
    await fs.writeFile(draftPath, OVER_MIN);
    assert.equal(await mm.resolveDraftPath(model), draftPath);

    // A model with no drafter declared → always null.
    assert.equal(await mm.resolveDraftPath(mm.findModelById(NON_QAT_ID).model), null);
  });
});

test("deleteModel removes the drafter alongside the main file, ignoring a missing drafter", async () => {
  await withHome("openwhispr-draft-delete-", async () => {
    const mm = loadModelManager();
    mm.ensureInitialized();
    await fs.mkdir(mm.modelsDir, { recursive: true });

    const model = mm.findModelById(QAT_ID).model;
    const mainPath = path.join(mm.modelsDir, model.fileName);
    const draftPath = path.join(mm.modelsDir, model.draftFileName);

    await fs.writeFile(mainPath, OVER_MIN);
    await fs.writeFile(draftPath, OVER_MIN);

    await mm.deleteModel(QAT_ID);
    assert.equal(await mm.checkFileExists(mainPath), false);
    assert.equal(await mm.checkFileExists(draftPath), false);

    // Main present, drafter already gone → no throw.
    await fs.writeFile(mainPath, OVER_MIN);
    await mm.deleteModel(QAT_ID);
    assert.equal(await mm.checkFileExists(mainPath), false);
  });
});

test("llama-server start restarts only when model or drafter presence changes", async () => {
  const LlamaServerManager = require("../../src/helpers/llamaServer.js");
  const manager = new LlamaServerManager();

  const calls = [];
  manager._doStart = async (modelPath, options) => {
    manager.ready = true;
    manager.modelPath = modelPath;
    manager.draftModelPath = options.draftModelPath || null;
    calls.push({ modelPath, draftModelPath: manager.draftModelPath });
  };

  await manager.start("/models/main.gguf", {});
  assert.equal(calls.length, 1);

  // Same model, no drafter → no restart.
  await manager.start("/models/main.gguf", {});
  assert.equal(calls.length, 1);

  // Drafter appears for the same model → restart.
  await manager.start("/models/main.gguf", { draftModelPath: "/models/draft.gguf" });
  assert.equal(calls.length, 2);
  assert.equal(manager.draftModelPath, "/models/draft.gguf");

  // Same model, same drafter → no restart.
  await manager.start("/models/main.gguf", { draftModelPath: "/models/draft.gguf" });
  assert.equal(calls.length, 2);

  // Drafter disappears → restart.
  await manager.start("/models/main.gguf", {});
  assert.equal(calls.length, 3);
  assert.equal(manager.draftModelPath, null);
});

// --- Degrade ladder for stale (pre-b9763) Vulkan binaries ---

const LADDER_BASE_ARGS = ["--model", "/models/main.gguf", "--host", "127.0.0.1", "--port", "8221"];
const LADDER_DRAFT_ARGS = [
  "--model-draft",
  "/models/draft.gguf",
  "--spec-type",
  "draft-mtp",
  "--spec-draft-n-max",
  "3",
];

// Builds a manager with _startWithBinary stubbed at the method boundary. shouldFail
// receives a {binary, draft, gpu} descriptor and decides whether that rung throws.
function makeLadderManager(shouldFail) {
  const LlamaServerManager = require("../../src/helpers/llamaServer.js");
  const manager = new LlamaServerManager();
  const attempts = [];
  manager.draftModelPath = "/models/draft.gguf";
  manager._buildEnv = () => ({});
  manager._killCurrentProcess = async () => {};
  manager.findAvailablePort = async () => 8221;
  manager._startWithBinary = async (binary, args) => {
    const attempt = {
      binary,
      draft: args.includes("--model-draft"),
      gpu: args.includes("--n-gpu-layers"),
    };
    attempts.push(attempt);
    if (shouldFail(attempt)) throw new Error(`stub fail: ${binary} draft=${attempt.draft}`);
  };
  return { manager, attempts };
}

const LADDER_BINARIES = { vulkan: "/bin/vulkan", cpu: "/bin/cpu" };

test("degrade ladder attempts GPU+MTP, GPU, CPU+MTP, CPU in that order", async () => {
  const { manager, attempts } = makeLadderManager(() => true);
  await assert.rejects(() =>
    manager._startWithGpuFallback(LADDER_BINARIES, LADDER_BASE_ARGS, {}, LADDER_DRAFT_ARGS)
  );
  assert.deepEqual(attempts, [
    { binary: "/bin/vulkan", draft: true, gpu: true },
    { binary: "/bin/vulkan", draft: false, gpu: true },
    { binary: "/bin/cpu", draft: true, gpu: false },
    { binary: "/bin/cpu", draft: false, gpu: false },
  ]);
  assert.equal(manager.activeBackend, null);
  assert.equal(manager.activeDraftModelPath, null);
});

test("stale vulkan (rejects MTP args) degrades to vulkan WITHOUT draft, not CPU", async () => {
  const { manager, attempts } = makeLadderManager((a) => a.draft);
  await manager._startWithGpuFallback(LADDER_BINARIES, LADDER_BASE_ARGS, {}, LADDER_DRAFT_ARGS);
  assert.deepEqual(attempts, [
    { binary: "/bin/vulkan", draft: true, gpu: true },
    { binary: "/bin/vulkan", draft: false, gpu: true },
  ]);
  assert.equal(manager.activeBackend, "vulkan");
  assert.equal(manager.activeDraftModelPath, null);
});

test("no drafter keeps today's vulkan->cpu order with no extra attempts", async () => {
  const { manager, attempts } = makeLadderManager(() => true);
  manager.draftModelPath = null;
  await assert.rejects(() =>
    manager._startWithGpuFallback(LADDER_BINARIES, LADDER_BASE_ARGS, {}, [])
  );
  assert.deepEqual(attempts, [
    { binary: "/bin/vulkan", draft: false, gpu: true },
    { binary: "/bin/cpu", draft: false, gpu: false },
  ]);
});

test("degraded start does not churn on identical requests", async () => {
  const LlamaServerManager = require("../../src/helpers/llamaServer.js");
  const manager = new LlamaServerManager();

  let starts = 0;
  manager._doStart = async (modelPath, options) => {
    starts++;
    manager.ready = true;
    manager.modelPath = modelPath;
    manager.draftModelPath = options.draftModelPath || null; // REQUESTED, stays stable
    manager.activeDraftModelPath = null; // simulate a degraded start (drafter dropped)
  };

  await manager.start("/models/main.gguf", { draftModelPath: "/models/draft.gguf" });
  assert.equal(starts, 1);
  assert.equal(manager.draftModelPath, "/models/draft.gguf");
  assert.equal(manager.activeDraftModelPath, null);

  // Identical request must NOT bounce the ready server despite the degrade.
  await manager.start("/models/main.gguf", { draftModelPath: "/models/draft.gguf" });
  assert.equal(starts, 1);
});

test("stop() clears both the requested and active draft paths", async () => {
  const LlamaServerManager = require("../../src/helpers/llamaServer.js");
  const manager = new LlamaServerManager();

  manager.draftModelPath = "/models/draft.gguf";
  manager.activeDraftModelPath = "/models/draft.gguf";
  manager.ready = true;
  manager.process = {
    exitCode: undefined,
    kill() {},
    once(event, cb) {
      if (event === "close") cb();
    },
  };

  await manager.stop();
  assert.equal(manager.draftModelPath, null);
  assert.equal(manager.activeDraftModelPath, null);
});
