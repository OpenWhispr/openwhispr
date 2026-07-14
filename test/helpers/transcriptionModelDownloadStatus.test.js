const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");

const ParakeetManager = require("../../src/helpers/parakeet");
const WhisperManager = require("../../src/helpers/whisper");
const modelRegistryData = require("../../src/models/modelRegistryData.json");
const downloadUtils = require("../../src/helpers/downloadUtils");
const whisperModulePath = require.resolve("../../src/helpers/whisper");

function activeDownload(model, overrides = {}) {
  return {
    abort() {},
    model,
    phase: "progress",
    percentage: 42,
    downloadedBytes: 420,
    totalBytes: 1000,
    ...overrides,
  };
}

test("listParakeetModels surfaces active installation state", async () => {
  const manager = new ParakeetManager();
  const model = Object.keys(modelRegistryData.parakeetModels)[0];
  manager.serverManager.isModelDownloaded = () => false;
  manager.currentDownloadProcess = activeDownload(model, {
    phase: "installing",
    percentage: 100,
  });

  const result = await manager.listParakeetModels();
  const status = result.models.find((candidate) => candidate.model === model);

  assert.equal(status.downloaded, false);
  assert.equal(status.isDownloading, true);
  assert.equal(status.isInstalling, true);
  assert.equal(status.downloadProgress, 100);
  assert.equal(status.downloadedBytes, 420);
  assert.equal(status.totalBytes, 1000);
});

test("Parakeet rejects a duplicate download without replacing the active request", async () => {
  const manager = new ParakeetManager();
  const model = Object.keys(modelRegistryData.parakeetModels)[0];
  const active = activeDownload(model);
  manager.serverManager.isModelDownloaded = () => false;
  manager.currentDownloadProcess = active;

  await assert.rejects(
    manager.downloadParakeetModel(model),
    (error) => error.code === "DOWNLOAD_IN_PROGRESS" && error.details.activeModel === model
  );
  assert.equal(manager.currentDownloadProcess, active);
});

test("listWhisperModels surfaces active download state", async (t) => {
  const modelsDir = await fs.mkdtemp(path.join(os.tmpdir(), "openwhispr-whisper-status-"));
  t.after(() => fs.rm(modelsDir, { recursive: true, force: true }));

  const manager = new WhisperManager();
  const model = Object.keys(modelRegistryData.whisperModels)[0];
  manager.getModelsDir = () => modelsDir;
  manager.currentDownloadProcess = activeDownload(model);

  const result = await manager.listWhisperModels();
  const status = result.models.find((candidate) => candidate.model === model);

  assert.equal(status.downloaded, false);
  assert.equal(status.isDownloading, true);
  assert.equal(status.downloadProgress, 42);
  assert.equal(status.downloadedBytes, 420);
  assert.equal(status.totalBytes, 1000);
});

test("Whisper rejects a duplicate download without replacing the active request", async (t) => {
  const modelsDir = await fs.mkdtemp(path.join(os.tmpdir(), "openwhispr-whisper-guard-"));
  t.after(() => fs.rm(modelsDir, { recursive: true, force: true }));

  const manager = new WhisperManager();
  const model = Object.keys(modelRegistryData.whisperModels)[0];
  const active = activeDownload(model);
  manager.getModelsDir = () => modelsDir;
  manager.currentDownloadProcess = active;

  await assert.rejects(
    manager.downloadWhisperModel(model),
    (error) => error.code === "DOWNLOAD_IN_PROGRESS" && error.details.activeModel === model
  );
  assert.equal(manager.currentDownloadProcess, active);
});

test("Whisper emits a complete event after validating the downloaded model", async (t) => {
  const modelsDir = await fs.mkdtemp(path.join(os.tmpdir(), "openwhispr-whisper-complete-"));
  t.after(() => fs.rm(modelsDir, { recursive: true, force: true }));

  const originalLoad = Module._load;
  delete require.cache[whisperModulePath];
  Module._load = function loadWithDownloadMock(request, parent, isMain) {
    if (request === "./downloadUtils" && parent?.filename === whisperModulePath) {
      return {
        ...downloadUtils,
        checkDiskSpace: async () => ({ ok: true, availableBytes: Infinity }),
        downloadFile: async (_url, destination, options) => {
          await fs.writeFile(destination, Buffer.alloc(16));
          options.onProgress?.(16, 16);
          return destination;
        },
        validateFileSize: async () => 16,
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  let TestWhisperManager;
  try {
    TestWhisperManager = require("../../src/helpers/whisper");
  } finally {
    Module._load = originalLoad;
    delete require.cache[whisperModulePath];
  }

  const manager = new TestWhisperManager();
  const model = Object.keys(modelRegistryData.whisperModels)[0];
  const events = [];
  manager.getModelsDir = () => modelsDir;

  await manager.downloadWhisperModel(model, (event) => events.push(event));

  assert.equal(events.at(-1)?.type, "complete");
  assert.equal(events.at(-1)?.model, model);
  assert.equal(events.at(-1)?.percentage, 100);
});

test("cancellation keeps the download guard until the active request unwinds", async () => {
  const manager = new ParakeetManager();
  const model = Object.keys(modelRegistryData.parakeetModels)[0];
  let aborted = false;
  const active = activeDownload(model, {
    abort() {
      aborted = true;
    },
  });
  manager.currentDownloadProcess = active;

  const result = await manager.cancelDownload();

  assert.equal(result.success, true);
  assert.equal(aborted, true);
  assert.equal(manager.currentDownloadProcess, active);
});

test("Parakeet refuses cancellation after installation starts", async () => {
  const manager = new ParakeetManager();
  const model = Object.keys(modelRegistryData.parakeetModels)[0];
  let aborted = false;
  const active = activeDownload(model, {
    phase: "installing",
    abort() {
      aborted = true;
    },
  });
  manager.currentDownloadProcess = active;

  const result = await manager.cancelDownload();

  assert.equal(result.success, false);
  assert.equal(result.code, "INSTALLATION_IN_PROGRESS");
  assert.equal(aborted, false);
  assert.equal(manager.currentDownloadProcess, active);
});
