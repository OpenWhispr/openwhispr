const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const fs = require("fs");
const Module = require("module");

// Mock electron and the OS keyring before environment.js loads, same harness
// as secretKeys.test.js, so nothing touches the developer's real keychain.
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), "ow-autoinstall-test-"));
process.resourcesPath = tmpUserData;
const fakeElectron = {
  app: { getPath: () => tmpUserData },
  safeStorage: { isEncryptionAvailable: () => false },
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return fakeElectron;
  if (request === "@napi-rs/keyring") throw new Error("keyring disabled in tests");
  return origLoad.call(this, request, ...rest);
};

const EnvironmentManager = require("../../src/helpers/environment");

test("defaults to enabled when the key was never saved", () => {
  delete process.env.UPDATE_AUTO_INSTALL;
  const env = new EnvironmentManager();
  assert.equal(env.getUpdateAutoInstall(), true);
});

test("saveUpdateAutoInstall(false) round-trips through the getter and process.env", () => {
  const env = new EnvironmentManager();
  env.saveUpdateAutoInstall(false);
  assert.equal(process.env.UPDATE_AUTO_INSTALL, "false");
  assert.equal(env.getUpdateAutoInstall(), false);
});

test("disabled setting survives a restart via the userData .env file", async () => {
  const env = new EnvironmentManager();
  env.saveUpdateAutoInstall(false);
  await env.saveAllKeysToEnvFile();

  // Simulate a fresh boot: wipe the live value and let the constructor
  // re-hydrate process.env from the persisted .env, like main.js startup does.
  delete process.env.UPDATE_AUTO_INSTALL;
  const rebooted = new EnvironmentManager();
  assert.equal(rebooted.getUpdateAutoInstall(), false);
});

test("saveUpdateAutoInstall(true) restores the enabled state end to end", async () => {
  const env = new EnvironmentManager();
  env.saveUpdateAutoInstall(true);
  await env.saveAllKeysToEnvFile();
  assert.equal(env.getUpdateAutoInstall(), true);

  delete process.env.UPDATE_AUTO_INSTALL;
  const rebooted = new EnvironmentManager();
  assert.equal(rebooted.getUpdateAutoInstall(), true);
});

test("non-boolean save input is stored as disabled only for literal true", () => {
  const env = new EnvironmentManager();
  env.saveUpdateAutoInstall("yes");
  assert.equal(process.env.UPDATE_AUTO_INSTALL, "false");
  assert.equal(env.getUpdateAutoInstall(), false);
  env.saveUpdateAutoInstall(true);
  assert.equal(env.getUpdateAutoInstall(), true);
});
