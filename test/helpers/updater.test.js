const test = require("node:test");
const { afterEach, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

process.env.NODE_ENV = "test";

const updaterModulePath = require.resolve("../../src/updater.js");
const originalLoad = Module._load;

const STARTUP_DELAY_MS = 3000;
const PERIODIC_INTERVAL_MS = 4 * 60 * 60 * 1000;

function makeAutoUpdater({ offline = false } = {}) {
  const listeners = {};
  const autoUpdater = {
    calls: 0,
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

beforeEach((t) => {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
});

afterEach(() => {
  Module._load = originalLoad;
});

test("with App updates off, startup and periodic checks never reach the update feed", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const autoUpdater = makeAutoUpdater();
  const manager = createUpdateManager(autoUpdater);
  manager.setWindowManager({
    notificationPrefs: { notificationsEnabled: true, notifyUpdates: false },
  });

  manager.checkForUpdatesOnStartup();
  t.mock.timers.tick(STARTUP_DELAY_MS);
  assert.equal(autoUpdater.calls, 0, "startup check must be skipped");
  t.mock.timers.tick(PERIODIC_INTERVAL_MS);
  assert.equal(autoUpdater.calls, 0, "periodic check must be skipped");

  manager.cleanup();
});

test("with App updates on, startup and periodic checks run as before", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const autoUpdater = makeAutoUpdater();
  const manager = createUpdateManager(autoUpdater);
  manager.setWindowManager({
    notificationPrefs: { notificationsEnabled: true, notifyUpdates: true },
  });

  manager.checkForUpdatesOnStartup();
  t.mock.timers.tick(STARTUP_DELAY_MS);
  assert.equal(autoUpdater.calls, 1);
  t.mock.timers.tick(PERIODIC_INTERVAL_MS);
  assert.equal(autoUpdater.calls, 2);

  manager.cleanup();
});

test("prefs are read at fire time, so toggling App updates takes effect without a restart", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const autoUpdater = makeAutoUpdater();
  const manager = createUpdateManager(autoUpdater);
  const windowManager = {
    notificationPrefs: { notificationsEnabled: true, notifyUpdates: false },
  };
  manager.setWindowManager(windowManager);
  manager.checkForUpdatesOnStartup();
  t.mock.timers.tick(STARTUP_DELAY_MS);
  assert.equal(autoUpdater.calls, 0);

  windowManager.notificationPrefs.notifyUpdates = true;
  t.mock.timers.tick(PERIODIC_INTERVAL_MS);
  assert.equal(autoUpdater.calls, 1, "next periodic tick runs once re-enabled");

  windowManager.notificationPrefs.notifyUpdates = false;
  t.mock.timers.tick(PERIODIC_INTERVAL_MS);
  assert.equal(autoUpdater.calls, 1, "and is skipped again once disabled");

  manager.cleanup();
});

test("before renderer prefs arrive, checks keep today's check-by-default behavior", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const autoUpdater = makeAutoUpdater();
  const manager = createUpdateManager(autoUpdater);

  manager.checkForUpdatesOnStartup();
  t.mock.timers.tick(STARTUP_DELAY_MS);
  assert.equal(autoUpdater.calls, 1);

  manager.cleanup();
});

test("a manual Check for Updates is never gated by the toggle", async () => {
  const autoUpdater = makeAutoUpdater();
  const manager = createUpdateManager(autoUpdater);
  manager.setWindowManager({
    notificationPrefs: { notificationsEnabled: false, notifyUpdates: false },
  });

  const result = await manager.checkForUpdates();

  assert.equal(autoUpdater.calls, 1);
  assert.equal(result.updateAvailable, false);
});

test("offline with App updates off, no update-error reaches the renderers (#1605)", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const autoUpdater = makeAutoUpdater({ offline: true });
  const manager = createUpdateManager(autoUpdater);
  const sent = [];
  const windowManager = {
    notificationPrefs: { notificationsEnabled: true, notifyUpdates: false },
    mainWindow: makeRendererWindow(sent),
    controlPanelWindow: makeRendererWindow(sent),
  };
  manager.setWindowManager(windowManager);

  manager.checkForUpdatesOnStartup();
  t.mock.timers.tick(STARTUP_DELAY_MS);
  assert.deepEqual(sent, [], "a skipped check produces no renderer traffic at all");

  windowManager.notificationPrefs.notifyUpdates = true;
  t.mock.timers.tick(PERIODIC_INTERVAL_MS);
  assert.ok(sent.includes("update-error"));

  manager.cleanup();
});

test("the update-available popup honors the same App updates gate", () => {
  const cases = [
    { prefs: { notificationsEnabled: true, notifyUpdates: true }, shown: 1 },
    { prefs: { notificationsEnabled: true, notifyUpdates: false }, shown: 0 },
    { prefs: { notificationsEnabled: false, notifyUpdates: true }, shown: 0 },
  ];

  for (const { prefs, shown } of cases) {
    const autoUpdater = makeAutoUpdater();
    const manager = createUpdateManager(autoUpdater);
    const popups = [];
    manager.setWindowManager({
      notificationPrefs: prefs,
      showUpdateNotification(info) {
        popups.push(info);
        return Promise.resolve();
      },
    });

    autoUpdater.listeners["update-available"]({ version: "9.9.9" });

    assert.equal(popups.length, shown, JSON.stringify(prefs));
    manager.cleanup();
  }
});
