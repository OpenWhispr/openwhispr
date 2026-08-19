const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const windowManagerPath = require.resolve("../../src/helpers/windowManager");
const originalLoad = Module._load;

class HotkeyManager {
  static isGlobeLikeHotkey() {
    return false;
  }

  unregisterAll() {}
}

class DragManager {}

class FakeNotificationDismissTimer {
  constructor() {
    this.startedWith = [];
    this.cancelCount = 0;
  }

  start(timeoutMs) {
    this.startedWith.push(timeoutMs);
  }

  cancel() {
    this.cancelCount += 1;
  }

  pause() {}

  resume() {}
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function loadWindowManager(linuxNotifier) {
  delete require.cache[windowManagerPath];

  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "electron") {
      return {
        app: { on() {} },
        screen: {},
        BrowserWindow: class {},
        shell: {},
        dialog: {},
      };
    }
    if (request === "./debugLogger") {
      return { info() {}, warn() {}, debug() {}, error() {}, log() {} };
    }
    if (request === "./hotkeyManager") return HotkeyManager;
    if (request === "./dragManager") return DragManager;
    if (request === "./menuManager") return {};
    if (request === "./devServerManager") return { DEV_SERVER_PORT: 3000 };
    if (request === "./dockManager") return {};
    if (request === "./i18nMain") return { i18nMain: { t: (key) => key } };
    if (request === "./notificationTimer") {
      return {
        NotificationDismissTimer: FakeNotificationDismissTimer,
        getNotificationTimeoutMs: () => 30 * 1000,
      };
    }
    if (request === "./linuxNotifier") {
      return {
        linuxNotifier,
        buildMeetingPromptContent: () => ({
          title: "Meeting detected",
          body: "Want to take notes?",
          actionKey: "start",
          actionLabel: "Take notes",
        }),
        buildUpdatePromptContent: () => ({
          title: "Update available",
          body: "Restart to update",
          actionKey: "update",
          actionLabel: "Update",
        }),
        CLOSE_REASON_EXPIRED: 1,
        CLOSE_REASON_DISMISSED: 2,
      };
    }
    if (request === "./windowConfig") {
      return {
        MAIN_WINDOW_CONFIG: {},
        CONTROL_PANEL_CONFIG: {},
        AGENT_OVERLAY_CONFIG: {},
        NOTIFICATION_WINDOW_CONFIG: {},
        TRANSCRIPTION_PREVIEW_CONFIG: {},
        TRANSCRIPTION_PREVIEW_SIZE_LIMITS: {},
        WINDOW_SIZES: {},
        WindowPositionUtil: {},
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require(windowManagerPath);
  } finally {
    Module._load = originalLoad;
  }
}

function createNativeShowHarness() {
  const pendingShow = deferred();
  const closedIds = [];
  const linuxNotifier = {
    isSupported: () => true,
    show: () => pendingShow.promise,
  };
  const WindowManager = loadWindowManager(linuxNotifier);
  const manager = new WindowManager();
  const resolveShow = (id) => {
    pendingShow.resolve({
      id,
      close: () => closedIds.push(id),
    });
  };
  return { manager, closedIds, resolveShow };
}

test("dismissing a meeting prompt cancels a native show still in flight", async () => {
  const { manager, closedIds, resolveShow } = createNativeShowHarness();
  const showPromise = manager.showMeetingNotification({
    detectionId: "detection-1",
    source: "calendar",
  });

  manager.dismissMeetingNotification();
  resolveShow(41);
  await showPromise;

  assert.equal(manager._nativeMeetingNotification, null);
  assert.deepEqual(closedIds, [41]);
  assert.deepEqual(manager._notificationDismissTimer.startedWith, []);
});

test("dismissing an update prompt cancels a native show still in flight", async () => {
  const { manager, closedIds, resolveShow } = createNativeShowHarness();
  const showPromise = manager.showUpdateNotification({ version: "1.2.3" });

  manager.dismissUpdateNotification();
  resolveShow(42);
  await showPromise;

  try {
    assert.equal(manager._nativeUpdateNotification, null);
    assert.deepEqual(closedIds, [42]);
    assert.equal(manager._updateNotificationAutoDismiss, undefined);
  } finally {
    manager.dismissUpdateNotification({ persistent: false });
  }
});
