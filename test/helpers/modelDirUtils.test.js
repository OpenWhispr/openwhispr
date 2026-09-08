const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("node:module");
const { describe, it, beforeEach, afterEach } = require("node:test");

describe("modelDirUtils cache policy (#1279, #1399)", () => {
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

  function setPlatform(platform) {
    Object.defineProperty(process, "platform", { value: platform });
  }

  function createRedirectedWindowsFixture() {
    setPlatform("win32");
    const home = path.join(tempRoot, "Users", "stan");
    const legacyRoot = path.join(home, ".cache", "openwhispr");
    const redirectedProfile = path.join(tempRoot, "RedirectedUsers", "stan");
    const redirectedRoot = path.join(redirectedProfile, ".cache", "openwhispr");
    process.env.USERPROFILE = redirectedProfile;
    return { home, legacyRoot, redirectedRoot };
  }

  function writeModel(directory, name, contents) {
    fs.mkdirSync(directory, { recursive: true });
    const filePath = path.join(directory, name);
    fs.writeFileSync(filePath, contents);
    return filePath;
  }

  function withFsOverrides(overrides, callback) {
    const originals = Object.fromEntries(
      Object.keys(overrides).map((method) => [method, fs[method]])
    );
    Object.assign(fs, overrides);
    try {
      return callback();
    } finally {
      Object.assign(fs, originals);
    }
  }

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ow-cache-test-"));
    process.env = { ...originalEnv };
    delete process.env.OPENWHISPR_CACHE_ROOT;
    delete process.env.USERPROFILE;
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
    setPlatform("win32");
    const override = path.join(tempRoot, "ascii-cache");
    process.env.OPENWHISPR_CACHE_ROOT = override;
    const { getCacheRoot } = loadFresh(path.join(tempRoot, "使用者", "詩涵"));
    assert.strictEqual(getCacheRoot(), override);
    assert.ok(fs.existsSync(override));
  });

  it("gives OPENWHISPR_CACHE_ROOT precedence over an ASCII-safe Windows home", () => {
    setPlatform("win32");
    const home = path.join(tempRoot, "Users", "stan");
    const override = path.join(tempRoot, "custom-cache");
    process.env.OPENWHISPR_CACHE_ROOT = override;

    const { getCacheRoot } = loadFresh(home);

    assert.strictEqual(getCacheRoot(), override);
  });

  it("uses a redirected USERPROFILE on Windows", () => {
    const { home, redirectedRoot } = createRedirectedWindowsFixture();

    const { getCacheRoot } = loadFresh(home);

    assert.strictEqual(getCacheRoot(), redirectedRoot);
  });

  it("honors an absolute XDG_CACHE_HOME on Linux", () => {
    setPlatform("linux");
    const home = path.join(tempRoot, "home", "stan");
    const xdgCacheHome = path.join(tempRoot, "xdg-cache");
    process.env.XDG_CACHE_HOME = xdgCacheHome;

    const { getCacheRoot } = loadFresh(home);

    assert.strictEqual(getCacheRoot(), path.join(xdgCacheHome, "openwhispr"));
  });

  it("gives OPENWHISPR_CACHE_ROOT precedence over XDG_CACHE_HOME", () => {
    setPlatform("linux");
    const home = path.join(tempRoot, "home", "stan");
    const override = path.join(tempRoot, "custom-cache");
    process.env.OPENWHISPR_CACHE_ROOT = override;
    process.env.XDG_CACHE_HOME = path.join(tempRoot, "xdg-cache");

    const { getCacheRoot } = loadFresh(home);

    assert.strictEqual(getCacheRoot(), override);
  });

  it("keeps the home cache when XDG_CACHE_HOME is relative", () => {
    setPlatform("linux");
    const home = path.join(tempRoot, "home", "stan");
    process.env.XDG_CACHE_HOME = "relative-cache";

    const { getCacheRoot } = loadFresh(home);

    assert.strictEqual(getCacheRoot(), path.join(home, ".cache", "openwhispr"));
  });

  it("preserves the macOS home-cache default", () => {
    setPlatform("darwin");
    const home = path.join(tempRoot, "Users", "stan");

    const { getCacheRoot } = loadFresh(home);

    assert.strictEqual(getCacheRoot(), path.join(home, ".cache", "openwhispr"));
  });

  it("honors OPENWHISPR_CACHE_ROOT on macOS", () => {
    setPlatform("darwin");
    const home = path.join(tempRoot, "Users", "stan");
    const override = path.join(tempRoot, "custom-cache");
    process.env.OPENWHISPR_CACHE_ROOT = override;

    const { getCacheRoot } = loadFresh(home);

    assert.strictEqual(getCacheRoot(), override);
  });

  it("falls back to ProgramData when redirected USERPROFILE is unsafe", () => {
    setPlatform("win32");
    const home = path.join(tempRoot, "Users", "stan");
    const programData = path.join(tempRoot, "ProgramData");
    process.env.USERPROFILE = path.join(tempRoot, "Redirected Users", "stan");
    process.env.ProgramData = programData;

    const { getCacheRoot } = loadFresh(home);

    assert.strictEqual(getCacheRoot(), path.join(programData, "OpenWhispr", "cache"));
  });

  it("skips an unsafe ProgramData fallback", () => {
    setPlatform("win32");
    const home = path.join(tempRoot, "Users", "stan");
    const systemDrive = path.join(tempRoot, "SystemDrive");
    process.env.USERPROFILE = path.join(tempRoot, "Redirected Users", "stan");
    process.env.ProgramData = path.join(tempRoot, "Program Data");
    process.env.SystemDrive = systemDrive;

    const { getCacheRoot } = loadFresh(home);

    assert.strictEqual(getCacheRoot(), path.join(systemDrive, "OpenWhispr", "cache"));
  });

  it("keeps all model consumers on the selected cache root", () => {
    setPlatform("win32");
    const home = path.join(tempRoot, "Users", "stan");
    const override = path.join(tempRoot, "custom-cache");
    process.env.OPENWHISPR_CACHE_ROOT = override;

    const { getCacheRoot, getModelsDirForService } = loadFresh(home);

    assert.strictEqual(getCacheRoot(), override);
    assert.strictEqual(getModelsDirForService("whisper"), path.join(override, "whisper-models"));
    assert.strictEqual(getModelsDirForService("parakeet"), path.join(override, "parakeet-models"));
    assert.strictEqual(
      getModelsDirForService("diarization"),
      path.join(override, "diarization-models")
    );
    assert.strictEqual(path.join(getCacheRoot(), "models"), path.join(override, "models"));
  });

  it("falls back to ProgramData cache when home cache path is non-ASCII", () => {
    setPlatform("win32");
    const programData = path.join(tempRoot, "ProgramData");
    process.env.ProgramData = programData;

    const { getCacheRoot, getModelsDirForService } = loadFresh(
      path.join(tempRoot, "使用者", "詩涵")
    );
    const root = getCacheRoot();
    assert.strictEqual(root, path.join(programData, "OpenWhispr", "cache"));
    assert.ok(fs.existsSync(root));
    assert.strictEqual(getModelsDirForService("whisper"), path.join(root, "whisper-models"));
  });

  it("keeps home cache on Windows when the path is ASCII-safe", () => {
    setPlatform("win32");
    const home = path.join(tempRoot, "Users", "stan");
    const { getCacheRoot } = loadFresh(home);
    assert.strictEqual(getCacheRoot(), path.join(home, ".cache", "openwhispr"));
  });

  it("migrates legacy model dirs into the safe root and leaves home-based dirs alone", () => {
    setPlatform("win32");
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

  it("migrates legacy model dirs when USERPROFILE redirects the cache", () => {
    const { home, legacyRoot, redirectedRoot } = createRedirectedWindowsFixture();
    writeModel(path.join(legacyRoot, "whisper-models"), "ggml-base.bin", "model");

    const { getCacheRoot } = loadFresh(home);

    assert.strictEqual(getCacheRoot(), redirectedRoot);
    assert.strictEqual(
      fs.readFileSync(path.join(redirectedRoot, "whisper-models", "ggml-base.bin"), "utf8"),
      "model"
    );
    assert.ok(!fs.existsSync(path.join(legacyRoot, "whisper-models")));
  });

  it("stages cross-volume migrations before removing the legacy model directory", () => {
    const { home, legacyRoot, redirectedRoot } = createRedirectedWindowsFixture();
    const legacyModels = path.join(legacyRoot, "whisper-models");
    const redirectedModels = path.join(redirectedRoot, "whisper-models");
    writeModel(legacyModels, "ggml-base.bin", "model");

    const { getCacheRoot } = loadFresh(home);
    const originalRenameSync = fs.renameSync;
    const root = withFsOverrides(
      {
        renameSync: (from, to) => {
          if (from === legacyModels && to === redirectedModels) {
            const error = new Error("cross-volume move");
            error.code = "EXDEV";
            throw error;
          }
          return originalRenameSync(from, to);
        },
      },
      () => getCacheRoot()
    );

    assert.strictEqual(root, redirectedRoot);
    assert.ok(fs.existsSync(path.join(redirectedModels, "ggml-base.bin")));
    assert.ok(!fs.existsSync(legacyModels));
    assert.ok(!fs.existsSync(`${redirectedModels}.migrating`));
  });

  it("keeps the legacy cache discoverable after a migration failure and retries later", () => {
    const { home, legacyRoot, redirectedRoot } = createRedirectedWindowsFixture();
    const legacyModels = path.join(legacyRoot, "whisper-models");
    const redirectedModels = path.join(redirectedRoot, "whisper-models");
    writeModel(legacyModels, "ggml-base.bin", "model");

    const { getCacheRoot } = loadFresh(home);
    const originalRenameSync = fs.renameSync;
    const originalCpSync = fs.cpSync;
    const firstResolution = withFsOverrides(
      {
        renameSync: (from, to) => {
          if (from === legacyModels && to === redirectedModels) {
            const error = new Error("cross-volume move blocked");
            error.code = "EXDEV";
            throw error;
          }
          return originalRenameSync(from, to);
        },
        cpSync: (from, to, options) => {
          if (from === legacyModels) throw new Error("copy blocked");
          return originalCpSync(from, to, options);
        },
      },
      () => getCacheRoot()
    );

    assert.strictEqual(firstResolution, legacyRoot);
    assert.ok(fs.existsSync(path.join(legacyModels, "ggml-base.bin")));
    assert.ok(!fs.existsSync(`${redirectedModels}.migrating`));

    assert.strictEqual(getCacheRoot(), redirectedRoot);
    assert.ok(fs.existsSync(path.join(redirectedModels, "ggml-base.bin")));
    assert.ok(!fs.existsSync(legacyModels));
  });

  it("rolls back earlier moves when staging cleanup fails", () => {
    const { home, legacyRoot, redirectedRoot } = createRedirectedWindowsFixture();
    const legacyWhisper = path.join(legacyRoot, "whisper-models");
    const legacyParakeet = path.join(legacyRoot, "parakeet-models");
    const redirectedWhisper = path.join(redirectedRoot, "whisper-models");
    const redirectedParakeet = path.join(redirectedRoot, "parakeet-models");
    const parakeetStaging = `${redirectedParakeet}.migrating`;
    writeModel(legacyWhisper, "ggml-base.bin", "whisper");
    writeModel(legacyParakeet, "model.int8.onnx", "parakeet");

    const { getCacheRoot } = loadFresh(home);
    const originalRenameSync = fs.renameSync;
    const originalRmSync = fs.rmSync;
    const root = withFsOverrides(
      {
        renameSync: (from, to) => {
          if (from === legacyParakeet && to === redirectedParakeet) {
            const error = new Error("cross-volume move");
            error.code = "EXDEV";
            throw error;
          }
          return originalRenameSync(from, to);
        },
        rmSync: (target, options) => {
          if (target === parakeetStaging) throw new Error("staging cleanup blocked");
          return originalRmSync(target, options);
        },
      },
      () => getCacheRoot()
    );

    assert.strictEqual(root, legacyRoot);
    assert.ok(fs.existsSync(path.join(legacyWhisper, "ggml-base.bin")));
    assert.ok(fs.existsSync(path.join(legacyParakeet, "model.int8.onnx")));
    assert.ok(!fs.existsSync(redirectedWhisper));
    assert.ok(!fs.existsSync(redirectedParakeet));
  });

  it("restores files removed by a partial cross-volume source cleanup", () => {
    const { home, legacyRoot, redirectedRoot } = createRedirectedWindowsFixture();
    const legacyModels = path.join(legacyRoot, "whisper-models");
    const redirectedModels = path.join(redirectedRoot, "whisper-models");
    const firstModel = writeModel(legacyModels, "ggml-base.bin", "base");
    const secondModel = writeModel(legacyModels, "ggml-small.bin", "small");

    const { getCacheRoot } = loadFresh(home);
    const originalRenameSync = fs.renameSync;
    const originalRmSync = fs.rmSync;
    const root = withFsOverrides(
      {
        renameSync: (from, to) => {
          if (from === legacyModels && to === redirectedModels) {
            const error = new Error("cross-volume move");
            error.code = "EXDEV";
            throw error;
          }
          return originalRenameSync(from, to);
        },
        rmSync: (target, options) => {
          if (target === legacyModels) {
            fs.unlinkSync(firstModel);
            throw new Error("source cleanup interrupted");
          }
          return originalRmSync(target, options);
        },
      },
      () => getCacheRoot()
    );

    assert.strictEqual(root, legacyRoot);
    assert.strictEqual(fs.readFileSync(firstModel, "utf8"), "base");
    assert.strictEqual(fs.readFileSync(secondModel, "utf8"), "small");
    assert.ok(!fs.existsSync(redirectedModels));
  });

  it("never overwrites models already present at the safe root", () => {
    setPlatform("win32");
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
