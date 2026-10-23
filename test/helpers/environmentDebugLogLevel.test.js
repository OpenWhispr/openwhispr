const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
// The real parser, taken before any test stubs dotenv's loader
const { parse: parseDotenv } = require("dotenv");

const ENV_KEYS = ["OPENWHISPR_LOG_LEVEL", "DICTATION_KEY", "ACTIVATION_MODE"];

function snapshotEnvironment() {
  return new Map(
    ENV_KEYS.map((name) => [
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

// Loads only the userData .env (as dotenv would at startup) so a developer's
// repo-root .env cannot leak into the test.
function installDotenvStub(t, userDataEnvPath) {
  const dotenvPath = require.resolve("dotenv");
  const originalDotenv = require.cache[dotenvPath];
  require.cache[dotenvPath] = {
    id: dotenvPath,
    filename: dotenvPath,
    loaded: true,
    exports: {
      config: ({ path: envPath, override }) => {
        if (envPath !== userDataEnvPath || !fs.existsSync(envPath)) return { parsed: {} };
        const parsed = parseDotenv(fs.readFileSync(envPath, "utf8"));
        for (const [name, value] of Object.entries(parsed)) {
          if (override || !Object.hasOwn(process.env, name)) process.env[name] = value;
        }
        return { parsed };
      },
    },
  };
  t.after(() => {
    if (originalDotenv) require.cache[dotenvPath] = originalDotenv;
    else delete require.cache[dotenvPath];
  });
}

function setup(t) {
  const userDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-debug-log-level-"));
  const environmentSnapshot = snapshotEnvironment();
  const originalResourcesPath = process.resourcesPath;
  process.resourcesPath = userDataDirectory;
  for (const name of ENV_KEYS) delete process.env[name];
  t.after(() => {
    restoreEnvironment(environmentSnapshot);
    process.resourcesPath = originalResourcesPath;
    fs.rmSync(userDataDirectory, { recursive: true, force: true });
  });
  const envPath = path.join(userDataDirectory, ".env");
  installDotenvStub(t, envPath);
  return { EnvironmentManager: loadEnvironmentManager(t, userDataDirectory), envPath };
}

// Settings setters fire saveAllKeysToEnvFile() without awaiting it
function trackSaves(environmentManager) {
  const saveAllKeysToEnvFile = environmentManager.saveAllKeysToEnvFile.bind(environmentManager);
  const tracked = { last: null };
  environmentManager.saveAllKeysToEnvFile = () => (tracked.last = saveAllKeysToEnvFile());
  return tracked;
}

test("debug logging enabled in Settings survives a settings save and the next launch", async (t) => {
  const { EnvironmentManager, envPath } = setup(t);
  // What set-debug-logging leaves in .env after the user turns debug logging on
  fs.writeFileSync(
    envPath,
    [
      "# OpenWhispr Environment Variables",
      "DICTATION_KEY=Fn",
      "ACTIVATION_MODE=tap",
      "",
      "# Debug logging setting",
      "OPENWHISPR_LOG_LEVEL=debug",
    ].join("\n")
  );

  const environmentManager = new EnvironmentManager();
  const saves = trackSaves(environmentManager);
  environmentManager.saveActivationMode("push");
  assert.ok(saves.last);
  await saves.last;

  const saved = parseDotenv(fs.readFileSync(envPath, "utf8"));
  assert.equal(saved.ACTIVATION_MODE, "push");
  assert.equal(saved.OPENWHISPR_LOG_LEVEL, "debug");

  // Next launch: a fresh process reads the level back from .env
  for (const name of ENV_KEYS) delete process.env[name];
  new EnvironmentManager();
  assert.equal(process.env.OPENWHISPR_LOG_LEVEL, "debug");
});

test("debug logging turned off persists as info; never enabled writes no line", async (t) => {
  const { EnvironmentManager, envPath } = setup(t);
  fs.writeFileSync(envPath, "DICTATION_KEY=Fn\n");

  const environmentManager = new EnvironmentManager();
  const saves = trackSaves(environmentManager);
  environmentManager.saveActivationMode("push");
  await saves.last;
  assert.doesNotMatch(fs.readFileSync(envPath, "utf8"), /OPENWHISPR_LOG_LEVEL/);

  // set-debug-logging(false) sets the session value to info
  process.env.OPENWHISPR_LOG_LEVEL = "info";
  environmentManager.saveActivationMode("tap");
  await saves.last;
  assert.equal(parseDotenv(fs.readFileSync(envPath, "utf8")).OPENWHISPR_LOG_LEVEL, "info");
});
