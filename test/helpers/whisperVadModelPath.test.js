const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("node:module");
const { describe, it, beforeEach, afterEach } = require("node:test");

// On Windows, whisper-server crashes on a non-ASCII --vad-model path (#1208), so
// a VAD model bundled under an install folder that fails pathHasProblematicChars
// is handed over as a copy in the ASCII-safe cache root.
describe("WhisperManager.getVadModelPath (#1208)", () => {
  const VAD_FILE = "ggml-silero-v5.1.2.bin";
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const originalResourcesPath = process.resourcesPath;
  const originalEnv = { ...process.env };
  const originalLoad = Module._load;
  const modelDirUtilsPath = require.resolve("../../src/helpers/modelDirUtils");
  const whisperPath = require.resolve("../../src/helpers/whisper");
  let tempRoot;
  let cacheRoot;

  // A fresh modelDirUtils with a temp home, so getCacheRoot's one-time migration
  // never moves the real ~/.cache/openwhispr.
  function vadModelPathOn(platform) {
    Module._load = function loadWithElectronStub(request, parent, isMain) {
      if (request === "electron" && parent?.filename === modelDirUtilsPath) {
        return { app: { getPath: () => path.join(tempRoot, "home") } };
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[modelDirUtilsPath];
    delete require.cache[whisperPath];
    const WhisperManager = require(whisperPath);
    const manager = new WhisperManager();
    Object.defineProperty(process, "platform", { value: platform });
    return manager.getVadModelPath();
  }

  function installBundledVad(installDir) {
    const dir = path.join(installDir, "resources", "bin", "whisper-vad");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, VAD_FILE), "silero-weights");
    process.resourcesPath = path.join(installDir, "resources");
    return path.join(dir, VAD_FILE);
  }

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ow-vad-test-"));
    cacheRoot = path.join(tempRoot, "cache");
    process.env.OPENWHISPR_CACHE_ROOT = cacheRoot;
  });

  afterEach(() => {
    Module._load = originalLoad;
    Object.defineProperty(process, "platform", originalPlatform);
    if (originalResourcesPath === undefined) delete process.resourcesPath;
    else process.resourcesPath = originalResourcesPath;
    process.env = { ...originalEnv };
    delete require.cache[modelDirUtilsPath];
    delete require.cache[whisperPath];
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("copies the model into the cache root when the install path is not ASCII", () => {
    installBundledVad(path.join(tempRoot, "Users", "Rémi", "Programs", "OpenWhispr"));

    const vadPath = vadModelPathOn("win32");

    assert.equal(vadPath, path.join(cacheRoot, "whisper-vad", VAD_FILE));
    assert.equal(fs.readFileSync(vadPath, "utf8"), "silero-weights");
  });

  it("runs without VAD rather than pass the crashing path when the copy fails", () => {
    installBundledVad(path.join(tempRoot, "Users", "Rémi", "Programs", "OpenWhispr"));
    fs.mkdirSync(cacheRoot, { recursive: true });
    fs.writeFileSync(path.join(cacheRoot, "whisper-vad"), "not a directory");

    assert.equal(vadModelPathOn("win32"), null);
  });

  it("replaces a copy whose bytes differ from the bundled model", () => {
    installBundledVad(path.join(tempRoot, "Program Files", "OpenWhispr"));
    const copyPath = path.join(cacheRoot, "whisper-vad", VAD_FILE);
    fs.mkdirSync(path.dirname(copyPath), { recursive: true });
    fs.writeFileSync(copyPath, "planted-weight");

    assert.equal(vadModelPathOn("win32"), copyPath);
    assert.equal(fs.readFileSync(copyPath, "utf8"), "silero-weights");
  });

  it("reuses an identical copy without writing it again", () => {
    installBundledVad(path.join(tempRoot, "Users", "Rémi", "Programs", "OpenWhispr"));
    const copyPath = path.join(cacheRoot, "whisper-vad", VAD_FILE);
    fs.mkdirSync(path.dirname(copyPath), { recursive: true });
    fs.writeFileSync(copyPath, "silero-weights");
    const { writeFileSync } = fs;
    fs.writeFileSync = () => {
      throw new Error("EPERM: the copy belongs to another account");
    };
    try {
      assert.equal(vadModelPathOn("win32"), copyPath);
    } finally {
      fs.writeFileSync = writeFileSync;
    }
  });

  it("keeps the bundled model for an ASCII install path", () => {
    const bundled = installBundledVad(path.join(tempRoot, "Programs", "OpenWhispr"));

    assert.equal(vadModelPathOn("win32"), bundled);
    assert.equal(fs.existsSync(path.join(cacheRoot, "whisper-vad")), false);
  });

  it("keeps the bundled model outside Windows", () => {
    const bundled = installBundledVad(path.join(tempRoot, "Users", "Rémi", "OpenWhispr"));

    assert.equal(vadModelPathOn("darwin"), bundled);
  });
});
