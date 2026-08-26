const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const HOTKEY_ENV_KEYS = ["VOICE_AGENT_KEY", "CHAT_AGENT_KEY"];

function snapshotEnvironment() {
  return new Map(
    HOTKEY_ENV_KEYS.map((name) => [
      name,
      { present: Object.hasOwn(process.env, name), value: process.env[name] },
    ])
  );
}

function restoreEnvironment(snapshot) {
  for (const [name, { present, value }] of snapshot) {
    if (present) process.env[name] = value;
    else delete process.env[name];
  }
}

function loadEnvironmentManager(t, userDataDirectory) {
  const environmentPath = require.resolve("../../src/helpers/environment");
  const originalEnvironmentModule = require.cache[environmentPath];
  const originalLoad = Module._load;
  delete require.cache[environmentPath];

  Module._load = function loadWithTestDependencies(request, parent, isMain) {
    if (request === "electron") {
      return {
        app: {
          getPath: () => userDataDirectory,
          getAppPath: () => userDataDirectory,
          isReady: () => false,
        },
        safeStorage: { isEncryptionAvailable: () => false },
      };
    }
    if (request === "./secretCrypto") return { isAvailable: () => false };
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require(environmentPath);
  } finally {
    Module._load = originalLoad;
    t.after(() => {
      if (originalEnvironmentModule) require.cache[environmentPath] = originalEnvironmentModule;
      else delete require.cache[environmentPath];
    });
  }
}

function installDotenvStub(t) {
  const dotenvPath = require.resolve("dotenv");
  const originalDotenv = require.cache[dotenvPath];
  require.cache[dotenvPath] = {
    id: dotenvPath,
    filename: dotenvPath,
    loaded: true,
    exports: { config: () => ({ parsed: {} }) },
  };
  t.after(() => {
    if (originalDotenv) require.cache[dotenvPath] = originalDotenv;
    else delete require.cache[dotenvPath];
  });
}

test("adopts a legacy chat-agent hotkey as the voice-agent hotkey", async (t) => {
  const userDataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "openwhispr-voice-agent-hotkey-")
  );
  const environmentSnapshot = snapshotEnvironment();
  const originalResourcesPath = process.resourcesPath;
  process.resourcesPath = userDataDirectory;
  delete process.env.VOICE_AGENT_KEY;
  process.env.CHAT_AGENT_KEY = "CommandOrControl+;";

  t.after(() => {
    restoreEnvironment(environmentSnapshot);
    process.resourcesPath = originalResourcesPath;
    fs.rmSync(userDataDirectory, { recursive: true, force: true });
  });

  installDotenvStub(t);
  const EnvironmentManager = loadEnvironmentManager(t, userDataDirectory);
  const environmentManager = new EnvironmentManager();
  const saveAllKeysToEnvFile = environmentManager.saveAllKeysToEnvFile.bind(environmentManager);
  let persistence;
  environmentManager.saveAllKeysToEnvFile = () => {
    persistence = saveAllKeysToEnvFile();
    return persistence;
  };

  const hotkey = environmentManager.getVoiceAgentKey();

  assert.equal(hotkey, "CommandOrControl+;");
  assert.ok(persistence);
  const persistenceResult = await persistence;
  const persistedEnvPath = path.join(userDataDirectory, ".env");
  const persistedEnv = fs.readFileSync(persistedEnvPath, "utf8");

  assert.equal(persistenceResult.path, persistedEnvPath);
  assert.equal(process.env.VOICE_AGENT_KEY, "CommandOrControl+;");
  assert.equal(process.env.CHAT_AGENT_KEY, undefined);
  assert.match(persistedEnv, /^VOICE_AGENT_KEY=CommandOrControl\+;$/m);
  assert.doesNotMatch(persistedEnv, /^CHAT_AGENT_KEY=/m);
});

test("device cleanup clears persisted settings and encrypted secret files", async (t) => {
  const userDataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "openwhispr-device-settings-cleanup-")
  );
  const environmentSnapshot = new Map(
    ["OPENAI_API_KEY", "START_MINIMIZED"].map((name) => [
      name,
      { present: Object.hasOwn(process.env, name), value: process.env[name] },
    ])
  );
  const originalResourcesPath = process.resourcesPath;
  process.resourcesPath = userDataDirectory;
  t.after(() => {
    restoreEnvironment(environmentSnapshot);
    process.resourcesPath = originalResourcesPath;
    fs.rmSync(userDataDirectory, { recursive: true, force: true });
  });

  installDotenvStub(t);
  const EnvironmentManager = loadEnvironmentManager(t, userDataDirectory);
  const environmentManager = new EnvironmentManager();
  const secureKeysDirectory = path.join(userDataDirectory, "secure-keys");
  fs.mkdirSync(secureKeysDirectory, { recursive: true });
  fs.writeFileSync(path.join(userDataDirectory, ".env"), "START_MINIMIZED=true\n");
  fs.writeFileSync(path.join(secureKeysDirectory, "OPENAI_API_KEY.enc"), "secret");
  process.env.OPENAI_API_KEY = "test-key";
  process.env.START_MINIMIZED = "true";

  await environmentManager.clearAllPersistedData();

  assert.equal(process.env.OPENAI_API_KEY, undefined);
  assert.equal(process.env.START_MINIMIZED, undefined);
  assert.equal(fs.existsSync(path.join(userDataDirectory, ".env")), false);
  assert.equal(fs.existsSync(secureKeysDirectory), false);
});
