const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const modelRegistryData = require("../../src/models/modelRegistryData.json");
const downloadUtils = require("../../src/helpers/downloadUtils");
const LocalModelDownloadStatus = require("../../src/helpers/localModelDownloadStatus");

const originalLoad = Module._load;
const modelManagerModulePath = require.resolve("../../src/helpers/modelManagerBridge.js");
const modelDirUtilsModulePath = require.resolve("../../src/helpers/modelDirUtils.js");
let electronHome = os.tmpdir();

function loadModelManager({ downloadFile, checkDiskSpace } = {}) {
  delete require.cache[modelManagerModulePath];
  delete require.cache[modelDirUtilsModulePath];

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

    if (request === "./downloadUtils" && parent?.filename === modelManagerModulePath) {
      return {
        ...downloadUtils,
        ...(downloadFile ? { downloadFile } : {}),
        ...(checkDiskSpace ? { checkDiskSpace } : {}),
      };
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    // modelManagerBridge requires modelDirUtils lazily (inside getModelsDir),
    // after this mock is uninstalled. Load it with the Electron stub, then pin
    // this manager to the test home so host XDG/OPENWHISPR cache overrides
    // cannot expose real downloaded models to the test.
    require("../../src/helpers/modelDirUtils.js");
    const modelManager = require("../../src/helpers/modelManagerBridge.js").default;
    modelManager.getModelsDir = () => path.join(electronHome, ".cache", "openwhispr", "models");
    return modelManager;
  } finally {
    Module._load = originalLoad;
  }
}

async function loadModelDownloadHandler(modelManager) {
  const source = await fs.readFile(require.resolve("../../src/helpers/ipcHandlers.js"), "utf8");
  const start = source.indexOf('    ipcMain.handle("model-download",');
  const end = source.indexOf('    ipcMain.handle("model-delete",', start);
  assert.ok(start >= 0 && end > start, "the model-download handler must be registered");

  const events = [];
  const status = new LocalModelDownloadStatus();
  const context = {
    localModelDownloadStatus: status,
    windowManager: {
      sendToControlPanel(channel, data) {
        events.push({ channel, ...data });
      },
    },
  };
  let handleDownload;
  // Execute the production registration without booting unrelated Electron services.
  vm.runInNewContext(`(function () { ${source.slice(start, end)} }).call(context)`, {
    context,
    ipcMain: {
      handle(channel, handler) {
        assert.equal(channel, "model-download");
        handleDownload = handler;
      },
    },
    require(request) {
      assert.equal(request, "./modelManagerBridge");
      return { default: modelManager };
    },
  });
  return { handleDownload, events, status };
}

for (const outcome of ["cancel", "error", "complete"]) {
  test(`the owning IPC request settles after ${outcome} when a duplicate arrives during preflight`, async (t) => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "openwhispr-ipc-owner-"));
    electronHome = tmpHome;
    const preflight = Promise.withResolvers();
    const transferStarted = Promise.withResolvers();
    const transferFinished = Promise.withResolvers();
    const modelManager = loadModelManager({
      checkDiskSpace: async () => ({ ok: true, availableBytes: Infinity }),
      downloadFile: async (_url, destination, { signal, onProgress }) => {
        signal.onAbort = () =>
          transferFinished.reject(Object.assign(new Error("cancelled"), { isAbort: true }));
        onProgress(420_000, 1_000_001);
        transferStarted.resolve();
        await transferFinished.promise;
        await fs.writeFile(destination, Buffer.alloc(1_000_001));
      },
    });
    const model = modelRegistryData.localProviders[0].models[0];
    const checkModelValid = modelManager.checkModelValid.bind(modelManager);
    let firstCheck = true;
    modelManager.checkModelValid = async (modelPath) => {
      if (firstCheck) {
        firstCheck = false;
        await preflight.promise;
      }
      return checkModelValid(modelPath);
    };
    const { handleDownload, events, status } = await loadModelDownloadHandler(modelManager);
    const owner = handleDownload({}, model.id);
    const duplicate = handleDownload({}, model.id);
    t.after(async () => {
      preflight.resolve();
      transferFinished.resolve();
      await Promise.allSettled([owner, duplicate]);
      await fs.rm(tmpHome, { recursive: true, force: true });
    });

    const duplicateResult = await Promise.race([
      duplicate,
      transferStarted.promise.then(() => ({ code: "DUPLICATE_STARTED_TRANSFER" })),
    ]);
    assert.equal(duplicateResult.code, "DOWNLOAD_IN_PROGRESS");
    assert.equal(duplicateResult.success, false);
    assert.equal(status.getActiveDownloads().length, 1);
    assert.equal(status.getActiveDownloads()[0].progress, 0);
    assert.equal(events.length, 0);

    preflight.resolve();
    await transferStarted.promise;
    assert.equal(status.getActiveDownloads()[0].downloadedBytes, 420_000);
    const progressSequence = status.getActiveDownloads()[0].sequence;

    if (outcome === "cancel") {
      assert.equal(modelManager.cancelDownload(model.id), true);
      assert.equal(status.has("llm", model.id), true);
    } else if (outcome === "error") {
      transferFinished.reject(new Error("connection lost"));
    } else {
      transferFinished.resolve();
    }

    const result = await owner;
    assert.equal(result.success, outcome === "complete");
    if (outcome !== "complete") {
      assert.equal(result.code, outcome === "cancel" ? "DOWNLOAD_CANCELLED" : "NETWORK_ERROR");
    }
    assert.deepEqual(status.getActiveDownloads(), []);
    assert.equal(modelManager.activeDownloads.size, 0);
    assert.equal(modelManager.activeRequests.size, 0);
    assert.equal(modelManager.downloadReservations.size, 0);
    const terminalEvents = events.filter((event) => event.type !== "progress");
    assert.equal(terminalEvents.length, 1);
    assert.equal(terminalEvents[0].modelId, model.id);
    assert.equal(terminalEvents[0].type, outcome === "complete" ? "complete" : "error");
    assert.ok(terminalEvents[0].sequence > progressSequence);
  });
}

test("the IPC registry permits distinct LLM transfers and settles them independently", async (t) => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "openwhispr-ipc-concurrent-"));
  electronHome = tmpHome;
  const [firstModel, secondModel] = modelRegistryData.localProviders[0].models;
  const firstTransfer = Promise.withResolvers();
  const secondTransfer = Promise.withResolvers();
  const bothStarted = Promise.withResolvers();
  let startedCount = 0;
  const modelManager = loadModelManager({
    checkDiskSpace: async () => ({ ok: true, availableBytes: Infinity }),
    downloadFile: async (_url, destination, { onProgress }) => {
      const transfer = destination.endsWith(firstModel.fileName) ? firstTransfer : secondTransfer;
      onProgress(420_000, 1_000_001);
      startedCount += 1;
      if (startedCount === 2) bothStarted.resolve();
      await transfer.promise;
      await fs.writeFile(destination, Buffer.alloc(1_000_001));
    },
  });
  const { handleDownload, events, status } = await loadModelDownloadHandler(modelManager);
  const firstRequest = handleDownload({}, firstModel.id);
  const secondRequest = handleDownload({}, secondModel.id);
  t.after(async () => {
    firstTransfer.resolve();
    secondTransfer.resolve();
    await Promise.allSettled([firstRequest, secondRequest]);
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  await bothStarted.promise;
  assert.equal(status.getActiveDownloads().length, 2);
  firstTransfer.reject(new Error("connection lost"));
  assert.equal((await firstRequest).code, "NETWORK_ERROR");
  assert.equal(status.has("llm", firstModel.id), false);
  assert.equal(status.has("llm", secondModel.id), true);
  secondTransfer.resolve();
  assert.equal((await secondRequest).success, true);
  assert.deepEqual(status.getActiveDownloads(), []);
  assert.deepEqual(
    events.filter((event) => event.type !== "progress").map((event) => [event.modelId, event.type]),
    [
      [firstModel.id, "error"],
      [secondModel.id, "complete"],
    ]
  );
});

test("getAllModels surfaces in-flight local model download state", async (t) => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "openwhispr-model-status-"));
  electronHome = tmpHome;
  t.after(() => fs.rm(tmpHome, { recursive: true, force: true }));

  const modelManager = loadModelManager();
  const model = modelRegistryData.localProviders[0].models[0];

  modelManager.activeDownloads.set(model.id, true);
  modelManager.downloadProgress.set(model.id, {
    modelId: model.id,
    progress: 42,
    downloadedSize: 420,
    totalSize: 1000,
  });
  t.after(() => {
    modelManager.activeDownloads.clear();
    modelManager.downloadProgress.clear();
  });

  const models = await modelManager.getAllModels();
  const activeModel = models.find((candidate) => candidate.id === model.id);

  assert.equal(activeModel.isDownloaded, false);
  assert.equal(activeModel.isDownloading, true);
  assert.equal(activeModel.downloadProgress, 42);
  assert.equal(activeModel.downloadedSize, 420);
  assert.equal(activeModel.totalSize, 1000);
  assert.equal(activeModel.path, null);
});

test("getAllModels retries when a download completes during filesystem checks", async (t) => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "openwhispr-model-snapshot-"));
  electronHome = tmpHome;
  t.after(() => fs.rm(tmpHome, { recursive: true, force: true }));

  const modelManager = loadModelManager();
  const model = modelRegistryData.localProviders[0].models[0];
  const originalCheckModelValid = modelManager.checkModelValid;
  let checkCount = 0;
  let downloadCompleted = false;

  modelManager.activeDownloads.set(model.id, true);
  modelManager.downloadLifecycleVersion += 1;
  modelManager.downloadProgress.set(model.id, {
    modelId: model.id,
    progress: 42,
    downloadedSize: 420,
    totalSize: 1000,
  });
  modelManager.checkModelValid = async (modelPath) => {
    checkCount += 1;
    if (checkCount === 2) {
      modelManager.activeDownloads.delete(model.id);
      modelManager.downloadProgress.delete(model.id);
      modelManager.downloadLifecycleVersion += 1;
      downloadCompleted = true;
    }
    return downloadCompleted && modelPath.endsWith(model.fileName);
  };
  t.after(() => {
    modelManager.checkModelValid = originalCheckModelValid;
    modelManager.activeDownloads.clear();
    modelManager.downloadProgress.clear();
  });

  const models = await modelManager.getAllModels();
  const completedModel = models.find((candidate) => candidate.id === model.id);

  assert.ok(
    checkCount > modelRegistryData.localProviders.flatMap((provider) => provider.models).length
  );
  assert.equal(completedModel.isDownloaded, true);
  assert.equal(completedModel.isDownloading, false);
  assert.equal(completedModel.downloadProgress, 0);
  assert.equal(completedModel.downloadedSize, 0);
  assert.equal(completedModel.totalSize, 0);
});

test("downloadModel permits distinct local models to download concurrently", async (t) => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "openwhispr-single-download-"));
  electronHome = tmpHome;
  t.after(() => fs.rm(tmpHome, { recursive: true, force: true }));

  const [firstModel, secondModel] = modelRegistryData.localProviders.flatMap(
    (provider) => provider.models
  );
  const started = [];
  let releaseDownloads;
  const downloadsStarted = new Promise((resolve) => {
    releaseDownloads = resolve;
  });
  let continueDownloads;
  const allowDownloadsToFinish = new Promise((resolve) => {
    continueDownloads = resolve;
  });
  const modelManager = loadModelManager({
    downloadFile: async (_url, destination, options) => {
      started.push(destination);
      options.onProgress?.(1, 2);
      if (started.length === 2) releaseDownloads();
      await allowDownloadsToFinish;
      await fs.writeFile(destination, Buffer.alloc(1_000_001));
    },
  });

  const firstDownload = modelManager.downloadModel(firstModel.id);
  const secondDownload = modelManager.downloadModel(secondModel.id);

  await downloadsStarted;
  assert.equal(modelManager.activeDownloads.has(firstModel.id), true);
  assert.equal(modelManager.activeDownloads.has(secondModel.id), true);

  continueDownloads();
  await Promise.all([firstDownload, secondDownload]);
});

test("parallel downloads reserve their combined disk space", async (t) => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "openwhispr-disk-reservation-"));
  electronHome = tmpHome;
  t.after(() => fs.rm(tmpHome, { recursive: true, force: true }));

  const [firstModel, secondModel] = modelRegistryData.localProviders
    .flatMap((provider) => provider.models)
    .filter((model) => !model.draftFileName)
    .slice(0, 2);
  const required = [firstModel, secondModel].map(
    (model) => (model.sizeBytes || model.sizeMb * 1_000_000) * 1.2
  );
  const availableBytes = Math.max(...required) + 1;
  let releaseFirst;
  const firstCanFinish = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let firstStarted;
  const firstDidStart = new Promise((resolve) => {
    firstStarted = resolve;
  });
  const modelManager = loadModelManager({
    checkDiskSpace: async (_directory, requiredBytes) => ({
      ok: requiredBytes <= availableBytes,
      availableBytes,
    }),
    downloadFile: async (_url, destination) => {
      firstStarted();
      await firstCanFinish;
      await fs.writeFile(destination, Buffer.alloc(1_000_001));
    },
  });

  const firstDownload = modelManager.downloadModel(firstModel.id);
  await firstDidStart;
  await assert.rejects(
    modelManager.downloadModel(secondModel.id),
    (error) => error.code === "INSUFFICIENT_DISK_SPACE"
  );

  releaseFirst();
  await firstDownload;
  assert.equal(modelManager.downloadReservations.size, 0);
});

test("cancelling an optional drafter does not complete the model download", async (t) => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "openwhispr-drafter-cancel-"));
  electronHome = tmpHome;
  t.after(() => fs.rm(tmpHome, { recursive: true, force: true }));

  let downloadCount = 0;
  const modelManager = loadModelManager({
    checkDiskSpace: async () => ({ ok: true, availableBytes: Number.MAX_SAFE_INTEGER }),
    downloadFile: async (_url, destination) => {
      downloadCount += 1;
      if (downloadCount === 1) {
        await fs.writeFile(destination, Buffer.alloc(1_000_001));
        return;
      }
      const error = new Error("cancelled");
      error.isAbort = true;
      throw error;
    },
  });
  const model = modelRegistryData.localProviders
    .flatMap((provider) => provider.models)
    .find((candidate) => candidate.draftFileName);

  await assert.rejects(
    modelManager.downloadModel(model.id),
    (error) => error.code === "DOWNLOAD_CANCELLED"
  );
  assert.equal(
    await modelManager.checkFileExists(path.join(modelManager.modelsDir, model.fileName)),
    true
  );
  assert.equal(
    await modelManager.checkFileExists(path.join(modelManager.modelsDir, model.draftFileName)),
    false
  );
});

test("downloadModel rejects a duplicate local model download", async (t) => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "openwhispr-duplicate-download-"));
  electronHome = tmpHome;
  t.after(() => fs.rm(tmpHome, { recursive: true, force: true }));

  const modelManager = loadModelManager();
  const model = modelRegistryData.localProviders[0].models[0];
  modelManager.activeDownloads.set(model.id, true);
  t.after(() => modelManager.activeDownloads.clear());

  await assert.rejects(
    modelManager.downloadModel(model.id),
    (error) => error.code === "DOWNLOAD_IN_PROGRESS" && error.details.modelId === model.id
  );
});

test("cancelDownload keeps the local LLM guard until the request unwinds", async (t) => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "openwhispr-cancel-guard-"));
  electronHome = tmpHome;
  t.after(() => fs.rm(tmpHome, { recursive: true, force: true }));

  const modelManager = loadModelManager();
  const [model, otherModel] = modelRegistryData.localProviders.flatMap(
    (provider) => provider.models
  );
  let aborted = false;

  modelManager.activeDownloads.set(model.id, true);
  modelManager.activeDownloads.set(otherModel.id, true);
  modelManager.activeRequests.set(model.id, {
    abort() {
      aborted = true;
    },
  });
  modelManager.downloadProgress.set(model.id, {
    modelId: model.id,
    progress: 42,
    downloadedSize: 420,
    totalSize: 1000,
  });
  modelManager.activeRequests.set(otherModel.id, { abort() {} });
  modelManager.downloadProgress.set(otherModel.id, {
    modelId: otherModel.id,
    progress: 24,
    downloadedSize: 240,
    totalSize: 1000,
  });
  t.after(() => {
    modelManager.activeDownloads.clear();
    modelManager.activeRequests.clear();
    modelManager.downloadProgress.clear();
  });

  assert.equal(modelManager.cancelDownload(model.id), true);
  assert.equal(aborted, true);
  assert.equal(modelManager.activeDownloads.has(model.id), true);
  assert.equal(modelManager.activeRequests.has(model.id), true);
  assert.equal(modelManager.downloadProgress.has(model.id), true);
  assert.equal(modelManager.activeDownloads.has(otherModel.id), true);
  assert.equal(modelManager.activeRequests.has(otherModel.id), true);
  assert.equal(modelManager.downloadProgress.has(otherModel.id), true);
});
