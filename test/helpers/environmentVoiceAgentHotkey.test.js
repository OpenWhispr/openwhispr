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

test("per-slot activation modes persist, normalize, and reject unknown slots", async (t) => {
  const userDataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "openwhispr-slot-activation-mode-")
  );
  const environmentSnapshot = new Map(
    ["VOICE_AGENT_ACTIVATION_MODE", "TRANSLATION_ACTIVATION_MODE"].map((name) => [
      name,
      { present: Object.hasOwn(process.env, name), value: process.env[name] },
    ])
  );
  const originalResourcesPath = process.resourcesPath;
  process.resourcesPath = userDataDirectory;
  delete process.env.VOICE_AGENT_ACTIVATION_MODE;
  delete process.env.TRANSLATION_ACTIVATION_MODE;
  t.after(() => {
    restoreEnvironment(environmentSnapshot);
    process.resourcesPath = originalResourcesPath;
    fs.rmSync(userDataDirectory, { recursive: true, force: true });
  });

  installDotenvStub(t);
  const EnvironmentManager = loadEnvironmentManager(t, userDataDirectory);
  const environmentManager = new EnvironmentManager();
  environmentManager.saveAllKeysToEnvFile = async () => ({});

  assert.deepEqual(environmentManager.getSlotActivationModes(), {
    voiceAgent: "push",
    translation: "push",
  });

  environmentManager.saveSlotActivationMode("voiceAgent", "tap");
  environmentManager.saveSlotActivationMode("translation", "bogus");
  assert.equal(environmentManager.saveSlotActivationMode("meeting", "push"), false);

  assert.deepEqual(environmentManager.getSlotActivationModes(), {
    voiceAgent: "tap",
    translation: "push",
  });
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

test("migrateActivationModesToHold flips every stored Tap to Hold exactly once", async (t) => {
  const userDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-hold-migration-"));
  const keys = [
    "ACTIVATION_MODE",
    "VOICE_AGENT_ACTIVATION_MODE",
    "TRANSLATION_ACTIVATION_MODE",
    "ACTIVATION_MODE_HOLD_MIGRATED",
  ];
  const environmentSnapshot = new Map(
    keys.map((name) => [
      name,
      { present: Object.hasOwn(process.env, name), value: process.env[name] },
    ])
  );
  const originalResourcesPath = process.resourcesPath;
  process.resourcesPath = userDataDirectory;
  for (const name of keys) delete process.env[name];
  process.env.ACTIVATION_MODE = "tap";
  process.env.VOICE_AGENT_ACTIVATION_MODE = "push";
  t.after(() => {
    restoreEnvironment(environmentSnapshot);
    process.resourcesPath = originalResourcesPath;
    fs.rmSync(userDataDirectory, { recursive: true, force: true });
  });

  installDotenvStub(t);
  const EnvironmentManager = loadEnvironmentManager(t, userDataDirectory);
  const environmentManager = new EnvironmentManager();
  let persisted = 0;
  environmentManager.saveAllKeysToEnvFile = async () => {
    persisted += 1;
    return {};
  };

  assert.equal(environmentManager.getActivationMode(), "tap");
  assert.equal(environmentManager.migrateActivationModesToHold(), true);
  assert.equal(environmentManager.getActivationMode(), "push");
  assert.deepEqual(environmentManager.getSlotActivationModes(), {
    voiceAgent: "push",
    translation: "push",
  });
  assert.equal(process.env.ACTIVATION_MODE_HOLD_MIGRATED, "true");
  assert.equal(persisted, 1);

  // A later demotion verdict survives the next launch: the marker holds.
  environmentManager.saveActivationMode("tap");
  assert.equal(environmentManager.migrateActivationModesToHold(), false);
  assert.equal(environmentManager.getActivationMode(), "tap");
});

test("an unset activation mode reads as Hold", async (t) => {
  const userDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-hold-default-"));
  const environmentSnapshot = new Map(
    ["ACTIVATION_MODE"].map((name) => [
      name,
      { present: Object.hasOwn(process.env, name), value: process.env[name] },
    ])
  );
  const originalResourcesPath = process.resourcesPath;
  process.resourcesPath = userDataDirectory;
  delete process.env.ACTIVATION_MODE;
  t.after(() => {
    restoreEnvironment(environmentSnapshot);
    process.resourcesPath = originalResourcesPath;
    fs.rmSync(userDataDirectory, { recursive: true, force: true });
  });

  installDotenvStub(t);
  const EnvironmentManager = loadEnvironmentManager(t, userDataDirectory);
  const environmentManager = new EnvironmentManager();
  environmentManager.saveAllKeysToEnvFile = async () => ({});

  assert.equal(environmentManager.getActivationMode(), "push");
  environmentManager.saveActivationMode("nonsense");
  assert.equal(environmentManager.getActivationMode(), "push");
});

test("migrateActivationModesToHold's marker and verdict survive a real second launch", async (t) => {
  const userDataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "openwhispr-hold-migration-restart-")
  );
  // Kept separate from `keys` below: that array is also used later to clear
  // leftover in-process state before the second launch, and this one must
  // survive that clear (or the second launch's real dotenv.config() calls
  // print their promotional "tip" lines to stdout).
  const quietSnapshot = {
    present: Object.hasOwn(process.env, "DOTENV_CONFIG_QUIET"),
    value: process.env.DOTENV_CONFIG_QUIET,
  };
  process.env.DOTENV_CONFIG_QUIET = "true";

  const keys = [
    "ACTIVATION_MODE",
    "VOICE_AGENT_ACTIVATION_MODE",
    "TRANSLATION_ACTIVATION_MODE",
    "ACTIVATION_MODE_HOLD_MIGRATED",
  ];
  const environmentSnapshot = new Map(
    keys.map((name) => [
      name,
      { present: Object.hasOwn(process.env, name), value: process.env[name] },
    ])
  );
  const originalResourcesPath = process.resourcesPath;
  process.resourcesPath = userDataDirectory;
  for (const name of keys) delete process.env[name];
  process.env.ACTIVATION_MODE = "tap";
  process.env.VOICE_AGENT_ACTIVATION_MODE = "tap";
  t.after(() => {
    if (quietSnapshot.present) process.env.DOTENV_CONFIG_QUIET = quietSnapshot.value;
    else delete process.env.DOTENV_CONFIG_QUIET;
    restoreEnvironment(environmentSnapshot);
    process.resourcesPath = originalResourcesPath;
    fs.rmSync(userDataDirectory, { recursive: true, force: true });
  });

  // Deliberately real dotenv here — no installDotenvStub. Every other test in
  // this file stubs config() to a no-op, which is exactly why none of them
  // can tell a broken PERSISTED_KEYS entry from a working one: a stub never
  // reads the file back. This test's whole point is a genuine second read of
  // the persisted .env, so it needs the real parser. Safe to do unstubbed:
  // .env is gitignored and this worktree has none at its root, so the other
  // fallback paths loadEnvironmentVariables() probes stay no-ops, and
  // process.resourcesPath / app.getPath("userData") both point at the
  // isolated tmp directory above.
  const EnvironmentManager = loadEnvironmentManager(t, userDataDirectory);
  const persistedEnvPath = path.join(userDataDirectory, ".env");

  const firstLaunch = new EnvironmentManager();
  const realSaveAllKeysToEnvFile = firstLaunch.saveAllKeysToEnvFile.bind(firstLaunch);
  let persistence;
  firstLaunch.saveAllKeysToEnvFile = () => {
    persistence = realSaveAllKeysToEnvFile();
    return persistence;
  };

  assert.equal(firstLaunch.migrateActivationModesToHold(), true);
  assert.ok(persistence);
  await persistence;

  const afterMigration = fs.readFileSync(persistedEnvPath, "utf8");
  assert.match(afterMigration, /^ACTIVATION_MODE_HOLD_MIGRATED=true$/m);
  assert.match(afterMigration, /^ACTIVATION_MODE=push$/m);

  // A later convergence verdict on the same launch (the slot-restore loop or
  // the darwin dictation demotion writing "tap" back) must also reach disk
  // before the next launch can honor it.
  firstLaunch.saveActivationMode("tap");
  await persistence;

  const afterDemotion = fs.readFileSync(persistedEnvPath, "utf8");
  assert.match(afterDemotion, /^ACTIVATION_MODE=tap$/m);

  // Clear in-process state so the second instance can only see what actually
  // reached disk — leftover process.env would let this test pass even if the
  // marker write itself were silently broken.
  for (const name of keys) delete process.env[name];

  const secondLaunch = new EnvironmentManager();
  assert.equal(secondLaunch.migrateActivationModesToHold(), false);
  assert.equal(secondLaunch.getActivationMode(), "tap");
});
