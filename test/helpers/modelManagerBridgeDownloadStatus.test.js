const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const modelRegistryData = require("../../src/models/modelRegistryData.json");
const downloadUtils = require("../../src/helpers/downloadUtils");

const originalLoad = Module._load;
const modelManagerModulePath = require.resolve("../../src/helpers/modelManagerBridge.js");
let electronHome = os.tmpdir();

function loadModelManager({ downloadFile } = {}) {
  delete require.cache[modelManagerModulePath];

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
      return { ...downloadUtils, ...(downloadFile ? { downloadFile } : {}) };
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require("../../src/helpers/modelManagerBridge.js").default;
  } finally {
    Module._load = originalLoad;
  }
}

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
  const [model, otherModel] = modelRegistryData.localProviders.flatMap((provider) => provider.models);
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
