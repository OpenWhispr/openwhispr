const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const ENV_KEYS = ["OPENWHISPR_LOG_LEVEL", "DICTATION_KEY"];

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

function setup(t) {
  const userDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-set-env-key-"));
  const environmentSnapshot = new Map(
    ENV_KEYS.map((name) => [
      name,
      { present: Object.hasOwn(process.env, name), value: process.env[name] },
    ])
  );
  const originalResourcesPath = process.resourcesPath;
  process.resourcesPath = userDataDirectory;
  for (const name of ENV_KEYS) delete process.env[name];
  t.after(() => {
    for (const [name, { present, value }] of environmentSnapshot) {
      if (present) process.env[name] = value;
      else delete process.env[name];
    }
    process.resourcesPath = originalResourcesPath;
    fs.rmSync(userDataDirectory, { recursive: true, force: true });
  });

  installDotenvStub(t);
  const EnvironmentManager = loadEnvironmentManager(t, userDataDirectory);
  return {
    environmentManager: new EnvironmentManager(),
    envPath: path.join(userDataDirectory, ".env"),
  };
}

test("replaces the key's line in place and keeps every other line verbatim", async (t) => {
  const { environmentManager, envPath } = setup(t);
  fs.writeFileSync(envPath, "# comment\nDICTATION_KEY=F8\nOPENWHISPR_LOG_LEVEL=info\nCUSTOM=1\n");

  await environmentManager.setKeyInEnvFile("OPENWHISPR_LOG_LEVEL", "debug");

  assert.equal(
    fs.readFileSync(envPath, "utf8"),
    "# comment\nDICTATION_KEY=F8\nOPENWHISPR_LOG_LEVEL=debug\nCUSTOM=1\n"
  );
});

test("appends the key on its own line when the file has no trailing newline", async (t) => {
  const { environmentManager, envPath } = setup(t);
  fs.writeFileSync(envPath, "DICTATION_KEY=F8");

  await environmentManager.setKeyInEnvFile("OPENWHISPR_LOG_LEVEL", "debug");

  assert.equal(fs.readFileSync(envPath, "utf8"), "DICTATION_KEY=F8\nOPENWHISPR_LOG_LEVEL=debug\n");
});

test("creates .env when it does not exist yet", async (t) => {
  const { environmentManager, envPath } = setup(t);

  await environmentManager.setKeyInEnvFile("OPENWHISPR_LOG_LEVEL", "debug");

  assert.equal(fs.readFileSync(envPath, "utf8"), "OPENWHISPR_LOG_LEVEL=debug\n");
});

test("runs after a full rewrite already queued, so the rewrite can't overwrite it", async (t) => {
  const { environmentManager, envPath } = setup(t);
  process.env.DICTATION_KEY = "F8";

  const rewrite = environmentManager.saveAllKeysToEnvFile();
  const setKey = environmentManager.setKeyInEnvFile("OPENWHISPR_LOG_LEVEL", "debug");
  await Promise.all([rewrite, setKey]);

  const content = fs.readFileSync(envPath, "utf8");
  assert.match(content, /^DICTATION_KEY=F8$/m);
  assert.match(content, /^OPENWHISPR_LOG_LEVEL=debug$/m);
});
