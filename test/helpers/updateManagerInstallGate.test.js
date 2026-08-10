const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

// setupAutoUpdater is a no-op under NODE_ENV=development; force a non-dev env
// so the gate is exercised the same way it is in a packaged app.
process.env.NODE_ENV = "test";

// Mock electron-updater and electron before requiring src/updater.js, so the
// UpdateManager wires the gate against an inspectable fake.
const fakeAutoUpdater = {
  autoDownload: undefined,
  autoInstallOnAppQuit: undefined,
  logger: null,
  channel: null,
  listeners: {},
  addQuitHandlerCalls: 0,
  setFeedURL() {},
  on(event, handler) {
    this.listeners[event] = handler;
  },
  removeListener() {},
  addQuitHandler() {
    this.addQuitHandlerCalls += 1;
  },
};
const fakeElectron = {
  autoUpdater: { on() {}, removeListener() {} },
  app: { getVersion: () => "0.0.0-test" },
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron-updater") return { autoUpdater: fakeAutoUpdater };
  if (request === "electron") return fakeElectron;
  return origLoad.call(this, request, ...rest);
};

const UpdateManager = require("../../src/updater");

function freshManager() {
  fakeAutoUpdater.autoDownload = undefined;
  fakeAutoUpdater.autoInstallOnAppQuit = undefined;
  fakeAutoUpdater.listeners = {};
  fakeAutoUpdater.addQuitHandlerCalls = 0;
  return new UpdateManager();
}

test("flag defaults to true at setup when UPDATE_AUTO_INSTALL is unset", () => {
  delete process.env.UPDATE_AUTO_INSTALL;
  freshManager();
  assert.equal(fakeAutoUpdater.autoInstallOnAppQuit, true);
});

test("flag is false at setup when UPDATE_AUTO_INSTALL=false", () => {
  process.env.UPDATE_AUTO_INSTALL = "false";
  freshManager();
  assert.equal(fakeAutoUpdater.autoInstallOnAppQuit, false);
  delete process.env.UPDATE_AUTO_INSTALL;
});

test("flag is set during construction, before any download can complete", () => {
  delete process.env.UPDATE_AUTO_INSTALL;
  const manager = freshManager();
  // The flag must be live before update-downloaded fires: electron-updater
  // reads it right after the download to register its install-on-quit hook.
  assert.equal(typeof fakeAutoUpdater.listeners["update-downloaded"], "function");
  assert.equal(fakeAutoUpdater.autoInstallOnAppQuit, true);
  assert.equal(manager.updateDownloaded, false);
});

test("setAutoInstallOnAppQuit(false) turns the live flag off without touching the quit hook", () => {
  delete process.env.UPDATE_AUTO_INSTALL;
  const manager = freshManager();
  const result = manager.setAutoInstallOnAppQuit(false);
  assert.equal(fakeAutoUpdater.autoInstallOnAppQuit, false);
  assert.equal(fakeAutoUpdater.addQuitHandlerCalls, 0);
  assert.deepEqual(result, { success: true, enabled: false });
});

test("re-enabling after a download that completed while gated re-registers the quit hook", () => {
  process.env.UPDATE_AUTO_INSTALL = "false";
  const manager = freshManager();
  fakeAutoUpdater.listeners["update-downloaded"]({ version: "9.9.9" });
  assert.equal(manager.updateDownloaded, true);

  manager.setAutoInstallOnAppQuit(true);
  assert.equal(fakeAutoUpdater.autoInstallOnAppQuit, true);
  assert.equal(fakeAutoUpdater.addQuitHandlerCalls, 1);
  delete process.env.UPDATE_AUTO_INSTALL;
});

test("enabling with no pending download does not register the quit hook", () => {
  delete process.env.UPDATE_AUTO_INSTALL;
  const manager = freshManager();
  manager.setAutoInstallOnAppQuit(true);
  assert.equal(fakeAutoUpdater.autoInstallOnAppQuit, true);
  assert.equal(fakeAutoUpdater.addQuitHandlerCalls, 0);
});

test("non-boolean input disables the flag instead of coercing to enabled", () => {
  delete process.env.UPDATE_AUTO_INSTALL;
  const manager = freshManager();
  const result = manager.setAutoInstallOnAppQuit("yes");
  assert.equal(fakeAutoUpdater.autoInstallOnAppQuit, false);
  assert.deepEqual(result, { success: true, enabled: false });
});

test("survives an electron-updater build without the protected addQuitHandler", () => {
  process.env.UPDATE_AUTO_INSTALL = "false";
  const manager = freshManager();
  fakeAutoUpdater.listeners["update-downloaded"]({ version: "9.9.9" });
  const saved = fakeAutoUpdater.addQuitHandler;
  fakeAutoUpdater.addQuitHandler = undefined;
  try {
    assert.doesNotThrow(() => manager.setAutoInstallOnAppQuit(true));
    assert.equal(fakeAutoUpdater.autoInstallOnAppQuit, true);
  } finally {
    fakeAutoUpdater.addQuitHandler = saved;
    delete process.env.UPDATE_AUTO_INSTALL;
  }
});
