const test = require("node:test");
const { afterEach, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

process.env.NODE_ENV = "test";

const updaterModulePath = require.resolve("../../src/updater.js");
const originalLoad = Module._load;
const originalPlatform = process.platform;
const originalAppImage = process.env.APPIMAGE;

const STARTUP_DELAY_MS = 3000;
const PERIODIC_INTERVAL_MS = 4 * 60 * 60 * 1000;

function makeAutoUpdater({ offline = false } = {}) {
  const listeners = {};
  const autoUpdater = {
    calls: 0,
    downloads: 0,
    listeners,
    setFeedURL() {},
    on(event, handler) {
      listeners[event] = handler;
    },
    removeListener() {},
    checkForUpdates() {
      autoUpdater.calls += 1;
      if (offline) {
        // electron-updater emits the error before rejecting
        const error = new Error("net::ERR_INTERNET_DISCONNECTED");
        listeners.error?.(error);
        return Promise.reject(error);
      }
      return Promise.resolve({ isUpdateAvailable: false });
    },
    downloadUpdate() {
      autoUpdater.downloads += 1;
      return Promise.resolve();
    },
  };
  return autoUpdater;
}

// updater.js requires electron and child_process lazily (constructor, cleanup(),
// Rosetta probe), so the mocks stay installed until afterEach.
function createUpdateManager(autoUpdater) {
  delete require.cache[updaterModulePath];
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "electron-updater") return { autoUpdater };
    if (request === "electron") return { autoUpdater: { on() {}, removeListener() {} } };
    if (request === "child_process") return { execSync: () => "0" };
    return originalLoad.call(this, request, parent, isMain);
  };
  const UpdateManager = require(updaterModulePath);
  return new UpdateManager();
}

function makeRendererWindow(sent) {
  return {
    isDestroyed: () => false,
    webContents: {
      send(channel) {
        sent.push(channel);
      },
    },
  };
}

function setPlatform(platform) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

beforeEach((t) => {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
  // The updater is unsupported on Linux outside an AppImage, so a test that
  // does not pick a platform would never check for updates on a Linux CI runner.
  setPlatform("darwin");
});

afterEach(() => {
  Module._load = originalLoad;
  setPlatform(originalPlatform);
  if (originalAppImage === undefined) delete process.env.APPIMAGE;
  else process.env.APPIMAGE = originalAppImage;
});

test("startup and periodic checks run whether or not automatic updates are on", (t) => {
  for (const enabled of [true, false, null]) {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const autoUpdater = makeAutoUpdater();
    const manager = createUpdateManager(autoUpdater);
    if (enabled !== null) manager.setAutoUpdatesEnabled(enabled);

    manager.checkForUpdatesOnStartup();
    t.mock.timers.tick(STARTUP_DELAY_MS);
    assert.equal(autoUpdater.calls, 1, `startup check with preference ${enabled}`);
    t.mock.timers.tick(PERIODIC_INTERVAL_MS);
    assert.equal(autoUpdater.calls, 2, `periodic check with preference ${enabled}`);

    manager.cleanup();
    t.mock.timers.reset();
  }
});

test("before the renderer syncs the preference, an available update is not downloaded", () => {
  const autoUpdater = makeAutoUpdater();
  const manager = createUpdateManager(autoUpdater);

  autoUpdater.listeners["update-available"]({ version: "9.9.9" });
  assert.equal(autoUpdater.downloads, 0);

  manager.cleanup();
});

test("with automatic updates on, an available update downloads itself exactly once", () => {
  const autoUpdater = makeAutoUpdater();
  const manager = createUpdateManager(autoUpdater);
  manager.setAutoUpdatesEnabled(true);

  autoUpdater.listeners["update-available"]({ version: "9.9.9" });
  assert.equal(autoUpdater.downloads, 1);

  // A periodic re-check while the download is in flight must not start another.
  autoUpdater.listeners["update-available"]({ version: "9.9.9" });
  assert.equal(autoUpdater.downloads, 1);

  autoUpdater.listeners["update-downloaded"]({ version: "9.9.9" });
  autoUpdater.listeners["update-available"]({ version: "9.9.9" });
  assert.equal(autoUpdater.downloads, 1, "a downloaded update is never fetched again");

  manager.cleanup();
});

test("with automatic updates off, an available update waits for the user", () => {
  const autoUpdater = makeAutoUpdater();
  const manager = createUpdateManager(autoUpdater);
  manager.setAutoUpdatesEnabled(false);

  autoUpdater.listeners["update-available"]({ version: "9.9.9" });
  assert.equal(autoUpdater.downloads, 0);

  manager.cleanup();
});

test("a relaunch leaves a downloaded update uninstalled on that quit", () => {
  const autoUpdater = makeAutoUpdater();
  const manager = createUpdateManager(autoUpdater);
  assert.equal(autoUpdater.autoInstallOnAppQuit, true);

  manager.deferInstallOnQuit();
  assert.equal(autoUpdater.autoInstallOnAppQuit, false);

  manager.cleanup();
});

test("enabling automatic updates after the startup check found one starts the download", () => {
  const autoUpdater = makeAutoUpdater();
  const manager = createUpdateManager(autoUpdater);

  autoUpdater.listeners["update-available"]({ version: "9.9.9" });
  assert.equal(autoUpdater.downloads, 0, "preference unknown, so nothing downloads yet");

  manager.setAutoUpdatesEnabled(true);
  assert.equal(autoUpdater.downloads, 1);

  manager.setAutoUpdatesEnabled(true);
  assert.equal(autoUpdater.downloads, 1, "re-syncing the preference does not restart it");

  manager.cleanup();
});

test("a failed background check only reaches renderers as update-error", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const autoUpdater = makeAutoUpdater({ offline: true });
  const manager = createUpdateManager(autoUpdater);
  const sent = [];
  manager.setWindowManager({
    mainWindow: makeRendererWindow(sent),
    controlPanelWindow: makeRendererWindow(sent),
  });

  manager.checkForUpdatesOnStartup();
  t.mock.timers.tick(STARTUP_DELAY_MS);
  assert.deepEqual([...new Set(sent)], ["update-error"]);

  manager.cleanup();
});

test("on macOS and Windows the updater reports itself as supported", async () => {
  for (const platform of ["darwin", "win32"]) {
    setPlatform(platform);
    const manager = createUpdateManager(makeAutoUpdater());
    assert.equal((await manager.getUpdateStatus()).isSupported, true, platform);
    manager.cleanup();
  }
});

test("a Linux AppImage is supported, but deb/rpm/tar.gz installs never touch the feed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  setPlatform("linux");

  process.env.APPIMAGE = "/opt/OpenWhispr.AppImage";
  const appImage = createUpdateManager(makeAutoUpdater());
  assert.equal((await appImage.getUpdateStatus()).isSupported, true);
  appImage.cleanup();

  delete process.env.APPIMAGE;
  const autoUpdater = makeAutoUpdater();
  const packaged = createUpdateManager(autoUpdater);
  packaged.setAutoUpdatesEnabled(true);
  assert.equal((await packaged.getUpdateStatus()).isSupported, false);

  packaged.checkForUpdatesOnStartup();
  t.mock.timers.tick(STARTUP_DELAY_MS + PERIODIC_INTERVAL_MS);
  assert.equal(autoUpdater.calls, 0, "no automatic checks are scheduled");

  const result = await packaged.checkForUpdates();
  assert.equal(autoUpdater.calls, 0, "a manual check short-circuits too");
  assert.equal(result.updateAvailable, false);
  assert.match(result.message, /package manager/);

  packaged.cleanup();
});
