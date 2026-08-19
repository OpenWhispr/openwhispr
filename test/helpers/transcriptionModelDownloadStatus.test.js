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

function stubMacosVersion(t, version) {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const systemVersionDescriptor = Object.getOwnPropertyDescriptor(process, "getSystemVersion");

  Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
  Object.defineProperty(process, "getSystemVersion", {
    configurable: true,
    value: () => version,
  });

  t.after(() => {
    Object.defineProperty(process, "platform", platformDescriptor);
    if (systemVersionDescriptor) {
      Object.defineProperty(process, "getSystemVersion", systemVersionDescriptor);
    } else {
      delete process.getSystemVersion;
    }
  });
}

test("Parakeet reports its packaged runtime as unsupported on macOS below 15.5", async (t) => {
  stubMacosVersion(t, "12.7.6");
  const manager = new ParakeetManager();
  manager.serverManager.getBinaryPath = () => "/Applications/OpenWhispr.app/parakeet";

  const result = await manager.checkInstallation();

  assert.deepEqual(result, {
    installed: true,
    working: false,
    supported: false,
    code: "PARAKEET_UNSUPPORTED_OS",
    message:
      "Parakeet requires macOS 15.5 or later. Use cloud transcription (or Whisper where supported) on this Mac.",
    minimumMacOSVersion: "15.5",
  });
});

test("Parakeet refuses explicit server startup on unsupported macOS", async (t) => {
  stubMacosVersion(t, "12.7.6");
  const manager = new ParakeetManager();
  const model = Object.keys(modelRegistryData.parakeetModels)[0];
  let startCalls = 0;
  manager.serverManager.startServer = async () => {
    startCalls += 1;
    return { success: true };
  };

  const result = await manager.startServer(model);

  assert.deepEqual(result, {
    success: false,
    code: "PARAKEET_UNSUPPORTED_OS",
    reason:
      "Parakeet requires macOS 15.5 or later. Use cloud transcription (or Whisper where supported) on this Mac.",
  });
  assert.equal(startCalls, 0);
});

test("Parakeet refuses a missing-model download before filesystem or download setup", async (t) => {
  stubMacosVersion(t, "12.7.6");
  const manager = new ParakeetManager();
  const model = Object.keys(modelRegistryData.parakeetModels)[0];
  let modelStatusChecks = 0;
  let modelDirectoryChecks = 0;
  manager.serverManager.isModelDownloaded = () => {
    modelStatusChecks += 1;
    return false;
  };
  manager.getModelsDir = () => {
    modelDirectoryChecks += 1;
    throw new Error("unexpected model-directory access");
  };

  await assert.rejects(
    manager.downloadParakeetModel(model),
    (error) =>
      error.code === "PARAKEET_UNSUPPORTED_OS" &&
      error.message ===
        "Parakeet requires macOS 15.5 or later. Use cloud transcription (or Whisper where supported) on this Mac."
  );
  assert.equal(modelStatusChecks, 0);
  assert.equal(modelDirectoryChecks, 0);
});

test("Parakeet refuses streaming startup on unsupported macOS", async (t) => {
  stubMacosVersion(t, "12.7.6");
  const manager = new ParakeetManager();
  const model = Object.keys(modelRegistryData.parakeetModels).find((candidate) =>
    manager.supportsOnlineStreaming(candidate)
  );
  let startCalls = 0;
  manager.serverManager.startServer = async () => {
    startCalls += 1;
    return { success: true };
  };

  await assert.rejects(
    manager.createOnlineStream(model),
    (error) => error.code === "PARAKEET_UNSUPPORTED_OS"
  );
  assert.equal(startCalls, 0);
});

test("Parakeet refuses transcription before touching the sidecar on unsupported macOS", async (t) => {
  stubMacosVersion(t, "12.7.6");
  const manager = new ParakeetManager();
  const model = Object.keys(modelRegistryData.parakeetModels)[0];
  let transcribeCalls = 0;
  manager.serverManager.isAvailable = () => true;
  manager.serverManager.isModelDownloaded = () => true;
  manager.serverManager.transcribe = async () => {
    transcribeCalls += 1;
    return { text: "unexpected" };
  };

  await assert.rejects(
    manager.transcribeLocalParakeet(Buffer.from("audio"), { model }),
    (error) => error.code === "PARAKEET_UNSUPPORTED_OS"
  );
  assert.equal(transcribeCalls, 0);
});

test("Parakeet skips startup prewarming on unsupported macOS", async (t) => {
  stubMacosVersion(t, "12.7.6");
  const modelsDir = await fs.mkdtemp(path.join(os.tmpdir(), "openwhispr-parakeet-capability-"));
  t.after(() => fs.rm(modelsDir, { recursive: true, force: true }));
  const manager = new ParakeetManager();
  const model = Object.keys(modelRegistryData.parakeetModels)[0];
  let startCalls = 0;
  manager.getModelsDir = () => modelsDir;
  manager.logDependencyStatus = async () => {};
  manager.serverManager.isAvailable = () => true;
  manager.serverManager.isModelDownloaded = () => true;
  manager.serverManager.startServer = async () => {
    startCalls += 1;
    return { success: true };
  };

  await manager.initializeAtStartup({
    localTranscriptionProvider: "nvidia",
    parakeetModel: model,
  });

  assert.equal(startCalls, 0);
});

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
