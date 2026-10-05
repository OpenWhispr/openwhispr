const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Runs outside Electron: stub the app userData path and version before loading.
let userDataDir = null;
let appVersion = "1.9.1";

require.cache[require.resolve("electron")] = {
  exports: { app: { getPath: () => userDataDir, getVersion: () => appVersion } },
};

const { resetWhisperGpuFailureOnUpgrade } = require("../../src/helpers/whisperGpuUpgradeReset.js");

function makeEnvManager() {
  const manager = { removals: [] };
  manager.removeKeyFromEnvFile = async (key) => {
    manager.removals.push(key);
  };
  return manager;
}

test.beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpu-upgrade-reset-"));
  appVersion = "1.9.1";
  delete process.env.WHISPER_GPU_FAILED;
});

test.afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
  delete process.env.WHISPER_GPU_FAILED;
});

test("clears the remembered GPU failure exactly once per version change", () => {
  process.env.WHISPER_GPU_FAILED = "cuda";
  const envManager = makeEnvManager();

  // First launch of this version (no sentinel yet, e.g. upgrading from 1.8.3)
  assert.equal(resetWhisperGpuFailureOnUpgrade(envManager), true);
  assert.equal(process.env.WHISPER_GPU_FAILED, undefined);
  assert.deepEqual(envManager.removals, ["WHISPER_GPU_FAILED"]);

  // GPU failed again on this version — the flag survives relaunches
  process.env.WHISPER_GPU_FAILED = "cuda";
  assert.equal(resetWhisperGpuFailureOnUpgrade(envManager), false);
  assert.equal(process.env.WHISPER_GPU_FAILED, "cuda");
  assert.equal(envManager.removals.length, 1);

  // The next upgrade earns one more fresh attempt
  appVersion = "1.9.2";
  assert.equal(resetWhisperGpuFailureOnUpgrade(envManager), true);
  assert.equal(process.env.WHISPER_GPU_FAILED, undefined);
  assert.equal(envManager.removals.length, 2);
});

test("records the running version without persisting when no failure is stored", () => {
  const envManager = makeEnvManager();
  assert.equal(resetWhisperGpuFailureOnUpgrade(envManager), false);
  assert.deepEqual(envManager.removals, []);

  // The sentinel now pins this version: a failure recorded later on it sticks
  process.env.WHISPER_GPU_FAILED = "vulkan";
  assert.equal(resetWhisperGpuFailureOnUpgrade(envManager), false);
  assert.equal(process.env.WHISPER_GPU_FAILED, "vulkan");
  assert.deepEqual(envManager.removals, []);
});

test("reset removes only the WHISPER_GPU_FAILED line; hand-added .env lines survive", async () => {
  // Real EnvironmentManager (electron already stubbed above; dotenv stubbed and
  // resourcesPath pinned) so the on-disk .env edit is pinned, not a stub.
  const dotenvPath = require.resolve("dotenv");
  const originalDotenv = require.cache[dotenvPath];
  require.cache[dotenvPath] = {
    id: dotenvPath,
    filename: dotenvPath,
    loaded: true,
    exports: { config: () => ({ parsed: {} }) },
  };
  const originalResourcesPath = process.resourcesPath;
  process.resourcesPath = userDataDir;

  try {
    const EnvironmentManager = require("../../src/helpers/environment.js");
    const envPath = path.join(userDataDir, ".env");
    fs.writeFileSync(
      envPath,
      [
        "# OpenWhispr Environment Variables",
        "OPENWHISPR_LOG_LEVEL=debug", // hand-added: not in PERSISTED_KEYS
        "WHISPER_GPU_FAILED=cuda",
        "WHISPER_CUDA_ENABLED=true",
        "",
      ].join("\n")
    );
    process.env.WHISPER_GPU_FAILED = "cuda";

    const envManager = new EnvironmentManager();
    const realRemove = envManager.removeKeyFromEnvFile.bind(envManager);
    let persistence = null;
    envManager.removeKeyFromEnvFile = (key) => (persistence = realRemove(key));

    assert.equal(resetWhisperGpuFailureOnUpgrade(envManager), true);
    assert.equal(process.env.WHISPER_GPU_FAILED, undefined);
    assert.ok(persistence);
    await persistence;

    assert.equal(
      fs.readFileSync(envPath, "utf8"),
      [
        "# OpenWhispr Environment Variables",
        "OPENWHISPR_LOG_LEVEL=debug",
        "WHISPER_CUDA_ENABLED=true",
        "",
      ].join("\n"),
      "every line except WHISPER_GPU_FAILED is preserved verbatim"
    );

    // A missing .env is tolerated (fresh install: nothing to remove)
    fs.unlinkSync(envPath);
    await envManager.removeKeyFromEnvFile("WHISPER_GPU_FAILED");
    assert.equal(fs.existsSync(envPath), false);
  } finally {
    if (originalDotenv) require.cache[dotenvPath] = originalDotenv;
    else delete require.cache[dotenvPath];
    process.resourcesPath = originalResourcesPath;
  }
});
