const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const vm = require("node:vm");
const { deferred } = require("./harness/deferred");
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

function loadDebugLoggingHandler(environmentManager, envPath) {
  const source = fs.readFileSync(require.resolve("../../src/helpers/ipcHandlers.js"), "utf8");
  const start = source.indexOf('    ipcMain.handle("set-debug-logging",');
  const end = source.indexOf('    ipcMain.handle("open-logs-folder",', start);
  assert.ok(start >= 0 && end > start, "the debug logging handler must be registered");

  let toggleDebugLogging;
  // Execute the real IPC registration without starting unrelated Electron services.
  vm.runInNewContext(`(function () { ${source.slice(start, end)} }).call(context)`, {
    context: { environmentManager },
    ipcMain: {
      handle(channel, handler) {
        assert.equal(channel, "set-debug-logging");
        toggleDebugLogging = handler;
      },
    },
    app: { getPath: () => path.dirname(envPath) },
    debugLogger: require("../../src/helpers/debugLogger"),
    require,
    process,
  });
  return toggleDebugLogging;
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

test("the debug toggle creates a missing settings file", async (t) => {
  const { EnvironmentManager, envPath } = setup(t);
  const toggleDebugLogging = loadDebugLoggingHandler(new EnvironmentManager(), envPath);

  const result = await toggleDebugLogging(null, true);

  assert.equal(result.success, true);
  assert.equal(parseDotenv(fs.readFileSync(envPath, "utf8")).OPENWHISPR_LOG_LEVEL, "debug");
});

test("a failed debug save reports failure and the next toggle can still persist", async (t) => {
  const { EnvironmentManager, envPath } = setup(t);
  process.env.OPENWHISPR_LOG_LEVEL = "info";
  const environmentManager = new EnvironmentManager();
  const toggleDebugLogging = loadDebugLoggingHandler(environmentManager, envPath);
  t.mock.method(require("../../src/helpers/debugLogger"), "error", () => {});
  t.mock.method(
    fsPromises,
    "writeFile",
    async () => {
      throw new Error("Disk write failed");
    },
    { times: 1 }
  );

  const failed = await toggleDebugLogging(null, true);
  assert.equal(failed.success, false);
  assert.equal(failed.error, "Disk write failed");
  assert.equal(fs.existsSync(envPath), false);

  await environmentManager.saveAllKeysToEnvFile();
  assert.equal(parseDotenv(fs.readFileSync(envPath, "utf8")).OPENWHISPR_LOG_LEVEL, "info");

  const retried = await toggleDebugLogging(null, false);
  assert.equal(retried.success, true);
  assert.equal(parseDotenv(fs.readFileSync(envPath, "utf8")).OPENWHISPR_LOG_LEVEL, "info");
});

for (const enabled of [false, true]) {
  test(`turning debug logging ${enabled ? "on" : "off"} preserves unrelated environment lines`, async (t) => {
    const { EnvironmentManager, envPath } = setup(t);
    const originalContent = "# Custom settings\nOPENWHISPR_CACHE_ROOT=/custom/models\n\n";
    fs.writeFileSync(envPath, originalContent + "OPENWHISPR_LOG_LEVEL=debug\n");
    // Keep the custom setting on disk without importing it into the test process.
    const environmentManager = Object.create(EnvironmentManager.prototype);
    const toggleDebugLogging = loadDebugLoggingHandler(environmentManager, envPath);

    const result = await toggleDebugLogging(null, enabled);

    assert.equal(result.success, true);
    assert.equal(
      fs.readFileSync(envPath, "utf8"),
      originalContent + `OPENWHISPR_LOG_LEVEL=${enabled ? "debug" : "info"}\n`
    );
  });

  test(`turning debug logging ${enabled ? "on" : "off"} survives an in-flight settings save`, async (t) => {
    const { EnvironmentManager, envPath } = setup(t);
    fs.writeFileSync(envPath, `OPENWHISPR_LOG_LEVEL=${enabled ? "info" : "debug"}\n`);
    const environmentManager = new EnvironmentManager();
    const toggleDebugLogging = loadDebugLoggingHandler(environmentManager, envPath);
    const writeStarted = deferred();
    const releaseWrite = deferred();
    const writeFile = fsPromises.writeFile;
    let heldWrite = false;
    t.mock.method(fsPromises, "writeFile", async (file, ...args) => {
      if (file === `${envPath}.tmp` && !heldWrite) {
        heldWrite = true;
        writeStarted.resolve();
        await releaseWrite.promise;
      }
      return writeFile(file, ...args);
    });

    const saves = trackSaves(environmentManager);
    environmentManager.saveActivationMode("push");
    await writeStarted.promise;
    let toggleSettled = false;
    const toggle = toggleDebugLogging(null, enabled).then((result) => {
      toggleSettled = true;
      return result;
    });
    let settledBeforeWrite;
    try {
      await new Promise((resolve) => setImmediate(resolve));
      settledBeforeWrite = toggleSettled;
    } finally {
      releaseWrite.resolve();
    }
    const [result] = await Promise.all([toggle, saves.last]);

    assert.equal(result.success, true);
    assert.equal(result.enabled, enabled);
    const saved = parseDotenv(fs.readFileSync(envPath, "utf8"));
    assert.equal(saved.OPENWHISPR_LOG_LEVEL, enabled ? "debug" : "info");
    assert.equal(saved.ACTIVATION_MODE, "push");
    assert.equal(settledBeforeWrite, false, "success must wait for queued persistence");

    for (const name of ENV_KEYS) delete process.env[name];
    new EnvironmentManager();
    assert.equal(process.env.OPENWHISPR_LOG_LEVEL, enabled ? "debug" : "info");
  });
}
