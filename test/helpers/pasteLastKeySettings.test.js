const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

// Load environment.js with a stubbed electron so the PASTE_LAST_KEY round trip
// runs outside the app, following the uiLanguageStartup test pattern.
function loadEnvironmentManager(t, userDataDirectory) {
  const originalLoad = Module._load;
  const environmentPath = require.resolve("../../src/helpers/environment");
  delete require.cache[environmentPath];

  Module._load = function loadWithElectronStub(request, parent, isMain) {
    if (request === "electron") {
      return {
        app: {
          getPath: () => userDataDirectory,
          getAppPath: () => userDataDirectory,
          isReady: () => false,
        },
        safeStorage: {
          isEncryptionAvailable: () => false,
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require("../../src/helpers/environment");
  } finally {
    Module._load = originalLoad;
    t.after(() => delete require.cache[environmentPath]);
  }
}

function setupManager(t) {
  const userDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-paste-last-key-"));
  const originalEnvironment = { ...process.env };
  const originalResourcesPath = process.resourcesPath;
  process.resourcesPath = userDataDirectory;
  delete process.env.PASTE_LAST_KEY;
  t.after(() => {
    process.env = originalEnvironment;
    process.resourcesPath = originalResourcesPath;
    fs.rmSync(userDataDirectory, { recursive: true, force: true });
  });

  const EnvironmentManager = loadEnvironmentManager(t, userDataDirectory);
  return { manager: new EnvironmentManager(), userDataDirectory };
}

test("savePasteLastKey round-trips through getPasteLastKey and the .env file", async (t) => {
  const { manager, userDataDirectory } = setupManager(t);

  assert.equal(manager.getPasteLastKey(), "");

  const result = manager.savePasteLastKey("Control+Shift+F9");
  assert.equal(result.success, true);
  assert.equal(manager.getPasteLastKey(), "Control+Shift+F9");

  await manager.saveAllKeysToEnvFile();
  const envContent = fs.readFileSync(path.join(userDataDirectory, ".env"), "utf8");
  assert.match(envContent, /^PASTE_LAST_KEY=Control\+Shift\+F9$/m);
});

test("saving an empty pasteLast key clears the stored hotkey", async (t) => {
  const { manager, userDataDirectory } = setupManager(t);

  manager.savePasteLastKey("F9");
  await manager.saveAllKeysToEnvFile();

  manager.savePasteLastKey("");
  assert.equal(manager.getPasteLastKey(), "");

  await manager.saveAllKeysToEnvFile();
  const envContent = fs.readFileSync(path.join(userDataDirectory, ".env"), "utf8");
  assert.doesNotMatch(envContent, /PASTE_LAST_KEY/);
});
