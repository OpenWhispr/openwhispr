const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("node:module");
const { describe, it, beforeEach, afterEach } = require("node:test");

describe("modelDirUtils ASCII-safe cache (#1399)", () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const originalEnv = { ...process.env };
  const originalLoad = Module._load;
  let tempRoot;
  let mockedHome;

  function loadFresh(homeDir) {
    mockedHome = homeDir;
    Module._load = function loadWithElectronStub(request, parent, isMain) {
      if (request === "electron") {
        return {
          app: {
            getPath: (name) => (name === "home" ? mockedHome : tempRoot),
            isReady: () => true,
          },
        };
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    const resolved = require.resolve("../../src/helpers/modelDirUtils");
    delete require.cache[resolved];
    return require("../../src/helpers/modelDirUtils");
  }

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ow-cache-test-"));
    process.env = { ...originalEnv };
    delete process.env.OPENWHISPR_CACHE_ROOT;
    delete process.env.XDG_CACHE_HOME;
  });

  afterEach(() => {
    Module._load = originalLoad;
    if (originalPlatform) {
      Object.defineProperty(process, "platform", originalPlatform);
    }
    process.env = { ...originalEnv };
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("pathHasProblematicChars flags non-ASCII and spaces", () => {
    const { pathHasProblematicChars } = loadFresh(path.join(tempRoot, "ascii-user"));
    assert.strictEqual(pathHasProblematicChars("C:\\Users\\Anton\\.cache\\openwhispr"), false);
    assert.strictEqual(pathHasProblematicChars("C:\\Users\\Антон\\.cache\\openwhispr"), true);
    assert.strictEqual(pathHasProblematicChars("C:\\Users\\詩涵\\.cache\\openwhispr"), true);
    assert.strictEqual(pathHasProblematicChars("C:\\Users\\Stan Shih\\.cache\\openwhispr"), true);
  });

  it("honors OPENWHISPR_CACHE_ROOT when ASCII-safe", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const override = path.join(tempRoot, "ascii-cache");
    process.env.OPENWHISPR_CACHE_ROOT = override;
    const { getCacheRoot } = loadFresh(path.join(tempRoot, "使用者", "詩涵"));
    assert.strictEqual(getCacheRoot(), override);
    assert.ok(fs.existsSync(override));
  });

  it("falls back to ProgramData cache when home cache path is non-ASCII", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const programData = path.join(tempRoot, "ProgramData");
    process.env.ProgramData = programData;

    const { getCacheRoot, getModelsDirForService } = loadFresh(
      path.join(tempRoot, "使用者", "詩涵")
    );
    const root = getCacheRoot();
    assert.strictEqual(root, path.join(programData, "OpenWhispr", "cache"));
    assert.ok(fs.existsSync(root));
    assert.strictEqual(
      getModelsDirForService("whisper"),
      path.join(root, "whisper-models")
    );
  });

  it("keeps home cache on Windows when the path is ASCII-safe", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const home = path.join(tempRoot, "Users", "stan");
    const { getCacheRoot } = loadFresh(home);
    assert.strictEqual(getCacheRoot(), path.join(home, ".cache", "openwhispr"));
  });

  it("migrates legacy model dirs into the safe root and leaves home-based dirs alone", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const programData = path.join(tempRoot, "ProgramData");
    process.env.ProgramData = programData;

    const home = path.join(tempRoot, "使用者", "詩涵");
    const legacyRoot = path.join(home, ".cache", "openwhispr");
    fs.mkdirSync(path.join(legacyRoot, "whisper-models"), { recursive: true });
    fs.writeFileSync(path.join(legacyRoot, "whisper-models", "ggml-base.bin"), "model");
    fs.mkdirSync(path.join(legacyRoot, "models"), { recursive: true });
    fs.writeFileSync(path.join(legacyRoot, "models", "qwen.gguf"), "llm");
    fs.mkdirSync(path.join(legacyRoot, "qdrant-data"), { recursive: true });
    fs.mkdirSync(path.join(legacyRoot, "embedding-models"), { recursive: true });

    const { getCacheRoot } = loadFresh(home);
    const root = getCacheRoot();

    assert.strictEqual(root, path.join(programData, "OpenWhispr", "cache"));
    assert.strictEqual(
      fs.readFileSync(path.join(root, "whisper-models", "ggml-base.bin"), "utf8"),
      "model"
    );
    assert.strictEqual(fs.readFileSync(path.join(root, "models", "qwen.gguf"), "utf8"), "llm");
    assert.ok(!fs.existsSync(path.join(legacyRoot, "whisper-models")));
    assert.ok(!fs.existsSync(path.join(legacyRoot, "models")));
    // qdrantManager and localEmbeddings read these from the home cache directly.
    assert.ok(fs.existsSync(path.join(legacyRoot, "qdrant-data")));
    assert.ok(fs.existsSync(path.join(legacyRoot, "embedding-models")));
  });

  it("never overwrites models already present at the safe root", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const programData = path.join(tempRoot, "ProgramData");
    process.env.ProgramData = programData;

    const home = path.join(tempRoot, "使用者", "詩涵");
    const legacyDir = path.join(home, ".cache", "openwhispr", "whisper-models");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "ggml-base.bin"), "old");

    const newDir = path.join(programData, "OpenWhispr", "cache", "whisper-models");
    fs.mkdirSync(newDir, { recursive: true });
    fs.writeFileSync(path.join(newDir, "ggml-base.bin"), "new");

    const { getCacheRoot } = loadFresh(home);
    getCacheRoot();

    assert.strictEqual(fs.readFileSync(path.join(newDir, "ggml-base.bin"), "utf8"), "new");
    assert.strictEqual(fs.readFileSync(path.join(legacyDir, "ggml-base.bin"), "utf8"), "old");
  });
});
