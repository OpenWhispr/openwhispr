const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { deferred } = require("../lib/settingsAuditHarness");

function loadWindowManager() {
  const sends = [];
  class Win extends EventEmitter {
    constructor() {
      super();
      this.webContents = new EventEmitter();
      this.webContents.mainFrame = { id: "current-document" };
      this.webContents.send = (...args) => sends.push(args);
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.isCrashed = () => false;
    }
    isDestroyed() {
      return false;
    }
    isMinimized() {
      return false;
    }
    isVisible() {
      return true;
    }
    focus() {}
    setTitle() {}
  }
  class Stub {}
  const mocks = {
    electron: {
      app: { on() {} },
      screen: {},
      BrowserWindow: Win,
      dialog: {},
      ipcMain: {},
      Menu: {},
    },
    "./debugLogger": { debug() {}, error() {} },
    "./tokenStore": {},
    "./accountScopeBinding": {},
    "./meetingNotificationDestination": {},
    "./linuxWindowInputRegion": {},
    "./externalUrlOpener": {},
    "./hotkeyManager": Stub,
    "./dragManager": Stub,
    "./mainWindowPlacementCoordinator": Stub,
    "./menuManager": { setupControlPanelMenu() {} },
    "./devServerManager": {},
    "./navigationGuard": {},
    "./dockManager": { setControlPanelVisible() {} },
    "./i18nMain": { i18nMain: { t: (key) => key } },
    "./notificationTimer": { NotificationDismissTimer: Stub },
    "./dictationLifecycle": {
      DICTATION_LIFECYCLE: { IDLE: "idle" },
      DICTATION_INPUT_KIND: { DICTATION: "dictation" },
    },
    "./windowConfig": {
      WINDOW_SIZES: { BASE: {} },
      CONTROL_PANEL_CONFIG: {},
      NOTIFICATION_WINDOW_CONFIG: {},
    },
    "./onboardingWindowBounds": {},
    "./onboardingInputPolicy": {},
    "./hotkeyRepeatGate": {},
    url: require("node:url"),
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync("src/helpers/windowManager.js", "utf8"), {
    require: (name) => {
      assert.ok(name in mocks, name);
      return mocks[name];
    },
    module,
    process,
    setTimeout: () => 1,
    clearTimeout() {},
  });
  return { WindowManager: module.exports, sends };
}

test("native Settings intent survives cold loading, wrong/stale readiness, reload and host replacement until ack", async () => {
  const { WindowManager, sends } = loadWindowManager();
  const manager = new WindowManager();
  const loading = deferred();
  manager.loadWindowContent = () => loading.promise;
  const opening = manager.openSettings("speechToText");
  const contents = manager.controlPanelWindow.webContents;
  const event = () => ({ sender: contents, senderFrame: contents.mainFrame });
  assert.equal(sends.length, 0, "document loading is not host readiness");
  const documentId = manager.getSettingsDocumentId(event());
  manager.setSettingsHostReady(
    { sender: {}, senderFrame: contents.mainFrame },
    "wrong",
    true,
    documentId
  );
  manager.setSettingsHostReady({ sender: contents, senderFrame: {} }, "subframe", true, documentId);
  assert.equal(sends.length, 0);
  loading.resolve();
  await opening;
  assert.equal(sends.length, 0, "slow auth/lazy/onboarding gates still have no host");
  manager.setSettingsHostReady(event(), "host-one", true, documentId);
  const first = sends.at(-1)[1];
  assert.equal(first.hostId, "host-one");
  assert.equal(first.section, "speechToText");
  manager.setSettingsHostReady(event(), "host-one", false, documentId);
  manager.acknowledgeSettingsOpen(event(), "host-one", first.requestId);
  assert.equal(manager._pendingSettingsOpen, first.requestId, "disposed host cannot consume");
  manager.setSettingsHostReady(event(), "host-two", true, documentId);
  assert.equal(sends.at(-1)[1].section, "speechToText", "replacement host retains named intent");
  manager.acknowledgeSettingsOpen(event(), "host-one", first.requestId);
  assert.notEqual(manager._pendingSettingsOpen, null);
  manager.acknowledgeSettingsOpen(event(), "host-two", first.requestId);
  assert.equal(manager._pendingSettingsOpen, null);
  assert.equal(manager._pendingSettingsSection, null);
  await manager.openSettings("llms");
  await manager.openSettings();
  const latest = sends.at(-1)[1];
  manager.acknowledgeSettingsOpen(event(), "host-two", latest.requestId - 1);
  assert.equal(manager._pendingSettingsOpen, latest.requestId);
  contents.emit("did-start-navigation", {}, "https://example.com", false, true);
  assert.equal(
    manager._settingsHost?.id,
    "host-two",
    "a navigation will-navigate blocks keeps the host"
  );
  const oldEvent = event();
  contents.emit("did-navigate", {}, "app");
  contents.mainFrame = { id: "reload" };
  manager.setSettingsHostReady(oldEvent, "stale-document", true, documentId);
  manager.setSettingsHostReady(event(), "stale-same-frame", true, documentId);
  assert.equal(manager._settingsHost, null);
  manager.setSettingsHostReady(event(), "reloaded", true, manager.getSettingsDocumentId(event()));
  assert.equal(sends.at(-1)[1].requestId, latest.requestId);
  assert.equal(sends.at(-1)[1].section, "llms", "reload retains the unacknowledged section");
  manager.acknowledgeSettingsOpen(event(), "reloaded", latest.requestId);
  assert.equal(manager._pendingSettingsOpen, null);
  let restored = false;
  manager.controlPanelWindow.isMinimized = () => true;
  manager.controlPanelWindow.restore = () => {
    restored = true;
  };
  await manager.openSettings();
  assert.equal(
    sends.at(-1)[1].section,
    undefined,
    "a consumed section does not leak into later opens"
  );
  assert.equal(restored, true, "native request also surfaces a minimized panel");
});
