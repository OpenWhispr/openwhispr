const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
// The real parser, taken before any test stubs dotenv's loader
const { parse: parseDotenv } = require("dotenv");

// Runs outside Electron: stub the app userData path and version before loading.
let userDataDir = null;
let appVersion = "1.9.1";

require.cache[require.resolve("electron")] = {
  exports: { app: { getPath: () => userDataDir, getVersion: () => appVersion } },
};

// Never touch the OS keychain: EnvironmentManager's .env writer asks secretCrypto
// whether encryption is available, which opens the real keychain.
const secretCryptoPath = require.resolve("../../src/helpers/secretCrypto.js");
require.cache[secretCryptoPath] = {
  id: secretCryptoPath,
  filename: secretCryptoPath,
  loaded: true,
  exports: { isAvailable: () => false },
};

const { resetWhisperGpuFailureOnUpgrade } = require("../../src/helpers/whisperGpuUpgradeReset.js");

const DEVICE_LOST = "vk::PhysicalDevice::createDevice: ErrorDeviceLost";
const KERNEL_IMAGE = "CUDA error: no kernel image is available for execution on the device";
// The failure flag and the reasons saved with it (#1736) are one record
const FAILURE_KEYS = [
  "WHISPER_GPU_FAILED",
  "WHISPER_GPU_FAILED_REASON_CUDA",
  "WHISPER_GPU_FAILED_REASON_VULKAN",
];

function makeEnvManager() {
  const manager = { removals: [] };
  manager.removeKeyFromEnvFile = async (key) => {
    manager.removals.push(key);
  };
  return manager;
}

function clearFailureKeys() {
  for (const key of FAILURE_KEYS) delete process.env[key];
}

test.beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpu-upgrade-reset-"));
  appVersion = "1.9.1";
  clearFailureKeys();
});

test.afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
  clearFailureKeys();
});

// Real EnvironmentManager (electron and secretCrypto stubbed above) with
// dotenv's loader stubbed and resourcesPath pinned, so the test owns the .env.
async function withRealEnvironmentManager(run) {
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
    await run(new EnvironmentManager(), path.join(userDataDir, ".env"));
  } finally {
    if (originalDotenv) require.cache[dotenvPath] = originalDotenv;
    else delete require.cache[dotenvPath];
    process.resourcesPath = originalResourcesPath;
  }
}

// Removals are queued one after another, so the last one settles after all
function trackRemovals(envManager) {
  const realRemove = envManager.removeKeyFromEnvFile.bind(envManager);
  const tracked = { last: null };
  envManager.removeKeyFromEnvFile = (key) => (tracked.last = realRemove(key));
  return tracked;
}

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

test("an upgrade clears the saved reasons together with the flag", () => {
  process.env.WHISPER_GPU_FAILED = "cuda,vulkan";
  process.env.WHISPER_GPU_FAILED_REASON_CUDA = KERNEL_IMAGE;
  process.env.WHISPER_GPU_FAILED_REASON_VULKAN = DEVICE_LOST;
  const envManager = makeEnvManager();

  assert.equal(resetWhisperGpuFailureOnUpgrade(envManager), true);

  for (const key of FAILURE_KEYS) assert.equal(process.env[key], undefined, key);
  assert.deepEqual(envManager.removals, FAILURE_KEYS);
});

test("reset removes only the WHISPER_GPU_FAILED line; hand-added .env lines survive", async () => {
  await withRealEnvironmentManager(async (envManager, envPath) => {
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
    const removals = trackRemovals(envManager);

    assert.equal(resetWhisperGpuFailureOnUpgrade(envManager), true);
    assert.equal(process.env.WHISPER_GPU_FAILED, undefined);
    assert.ok(removals.last);
    await removals.last;

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
  });
});

test("an upgrade removes the reason lines from .env too; hand-added lines survive", async () => {
  await withRealEnvironmentManager(async (envManager, envPath) => {
    fs.writeFileSync(
      envPath,
      [
        "# OpenWhispr Environment Variables",
        "OPENWHISPR_LOG_LEVEL=debug",
        "WHISPER_GPU_FAILED=vulkan",
        `WHISPER_GPU_FAILED_REASON_VULKAN=${DEVICE_LOST}`,
        "WHISPER_VULKAN_ENABLED=true",
        "",
      ].join("\n")
    );
    process.env.WHISPER_GPU_FAILED = "vulkan";
    process.env.WHISPER_GPU_FAILED_REASON_VULKAN = DEVICE_LOST;
    const removals = trackRemovals(envManager);

    assert.equal(resetWhisperGpuFailureOnUpgrade(envManager), true);
    await removals.last;

    assert.equal(
      fs.readFileSync(envPath, "utf8"),
      [
        "# OpenWhispr Environment Variables",
        "OPENWHISPR_LOG_LEVEL=debug",
        "WHISPER_VULKAN_ENABLED=true",
        "",
      ].join("\n")
    );
  });
});

test("a saved reason survives a full .env rewrite and reads back unchanged", async () => {
  await withRealEnvironmentManager(async (envManager, envPath) => {
    process.env.WHISPER_GPU_FAILED = "cuda,vulkan";
    process.env.WHISPER_GPU_FAILED_REASON_CUDA = KERNEL_IMAGE;
    process.env.WHISPER_GPU_FAILED_REASON_VULKAN = DEVICE_LOST;

    // _syncStartupEnv rewrites the whole file from PERSISTED_KEYS
    await envManager.saveAllKeysToEnvFile();

    const saved = parseDotenv(fs.readFileSync(envPath, "utf8"));
    assert.equal(saved.WHISPER_GPU_FAILED, "cuda,vulkan");
    assert.equal(saved.WHISPER_GPU_FAILED_REASON_CUDA, KERNEL_IMAGE);
    assert.equal(saved.WHISPER_GPU_FAILED_REASON_VULKAN, DEVICE_LOST);
  });
});
