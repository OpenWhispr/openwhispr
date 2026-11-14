const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// The dictation row commit is run here as the real method, against the real
// WindowManager and the real HotkeyManager. Only the D-Bus/Electron boundary
// and the .env file are faked, because the defects these tests pin are
// ORDERING defects: who learns about a configuration, and when.

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const windowManagerPath = require.resolve("../../src/helpers/windowManager");
const environmentPath = require.resolve("../../src/helpers/environment");

const registrations = new Set();
const sentToAllWindows = [];

const electronStub = {
  app: {
    getPath: () => "/tmp",
    getName: () => "test",
    getVersion: () => "0.0.0",
    isPackaged: false,
    on: () => {},
    requestSingleInstanceLock: () => true,
  },
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {} },
  globalShortcut: {
    register: (accelerator) => {
      registrations.add(accelerator);
      return true;
    },
    unregister: (accelerator) => registrations.delete(accelerator),
    isRegistered: (accelerator) => registrations.has(accelerator),
    unregisterAll: () => registrations.clear(),
  },
  screen: {
    on: () => {},
    getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }),
  },
  BrowserWindow: class BrowserWindow {
    static getAllWindows() {
      return [
        {
          isDestroyed: () => false,
          webContents: {
            send: (channel, payload) => sentToAllWindows.push({ channel, payload }),
          },
        },
      ];
    }

    static fromWebContents() {
      return null;
    }
  },
  Menu: {},
  shell: {},
  dialog: {},
  clipboard: {},
  nativeImage: {},
  net: { fetch: async () => ({ ok: true }) },
  session: { fromPartition: () => ({}) },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
  utilityProcess: {},
  MessageChannelMain: class {},
};

// Every write the app could make to the stored keys, in order. The commit must
// make exactly one, carrying the keys and the rows together.
const envWrites = [];
const environmentStub = class EnvironmentManager {
  static encodeDictationHotkeyConfig(json) {
    return Buffer.from(json, "utf8").toString("base64");
  }

  saveDictationKey(hotkey) {
    envWrites.push({ via: "saveDictationKey", hotkey });
    return { success: true };
  }

  async saveAllKeysToEnvFile() {
    envWrites.push({ via: "saveAllKeysToEnvFile" });
    return { success: true };
  }
};

// Pure helpers stay real: a universal proxy would make parseHotkeyList("F8")
// return a truthy Proxy and every downstream string check would pass.
const REAL_HELPERS = new Set([
  "./hotkeyList",
  "./hotkeyCanonical",
  "./hotkeyBindingId",
  "./dictationHotkeyConfig",
]);

const WINDOW_MANAGER_STUBS = {
  "./menuManager": {},
  "./dockManager": {},
  "./dragManager": class {},
  "./devServerManager": {
    DEV_SERVER_PORT: 5173,
    DEV_SERVER_URL: "http://localhost:5173",
    getAppFilePath: () => ({ path: "/app/index.html", query: {} }),
    waitForDevServer: async () => undefined,
  },
  "./windowConfig": {
    MAIN_WINDOW_CONFIG: {},
    CONTROL_PANEL_CONFIG: {},
    NOTIFICATION_WINDOW_CONFIG: {},
    WINDOW_SIZES: { BASE: { width: 96, height: 96 } },
    ONBOARDING_WINDOW_SIZES: { COMPACT: {}, EXPANDED: {} },
    WindowPositionUtil: {
      setupAlwaysOnTop: () => undefined,
      clampToWorkArea: (bounds) => bounds,
      getMainWindowPosition: () => ({ x: 0, y: 0 }),
      getNotificationPosition: () => ({ x: 0, y: 0 }),
    },
    fitAssistantWindowToWorkArea: (size) => size,
    fitAssistantContentWindowToWorkArea: (height) => ({ width: 466, height }),
    fitDictationErrorWindowToWorkArea: (size) => size,
    fitDictationErrorContentWindowToWorkArea: (height) => ({ width: 466, height }),
    resolveHorizontalWindowDirection: () => "right",
  },
};

const originalLoad = Module._load;
Module._load = function loadWithBoundaryStubs(request, parent, isMain) {
  if (request === "electron") return electronStub;
  // Lazy require inside HotkeyManager.saveHotkeyToRenderer / _persistHotkeyToEnvFile.
  if (request === "./environment" || request === environmentPath) return environmentStub;
  if (parent?.filename === windowManagerPath && request in WINDOW_MANAGER_STUBS) {
    return WINDOW_MANAGER_STUBS[request];
  }
  if (
    parent?.filename === handlersModulePath &&
    (request.startsWith("./") || request.startsWith("../")) &&
    !REAL_HELPERS.has(request)
  ) {
    return anything();
  }
  return originalLoad.call(this, request, parent, isMain);
};

function anything() {
  return new Proxy(function () {}, {
    get: (_target, property) => {
      if (property === Symbol.toPrimitive || property === "toString") return () => "";
      if (property === "then") return undefined;
      return anything();
    },
    apply: () => anything(),
  });
}

delete require.cache[handlersModulePath];
const IPCHandlers = require(handlersModulePath);
const WindowManager = require(windowManagerPath);

test.after(() => {
  Module._load = originalLoad;
});

// A real WindowManager and a real HotkeyManager, with a storage layer whose
// write the test controls.
function fixture({ rows = [{ key: "F8", mode: null }] } = {}) {
  registrations.clear();
  sentToAllWindows.length = 0;
  envWrites.length = 0;

  const windowManager = new WindowManager();
  const sent = [];
  windowManager.showDictationPanel = () => undefined;
  windowManager.hideDictationPanel = () => undefined;
  // Before mainWindow is attached, so its own teardown sends stay out of `sent`.
  windowManager.setOnboardingActive(false);
  windowManager.mainWindow = {
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
  };
  windowManager.hotkeyManager.mainWindow = windowManager.mainWindow;
  windowManager.setDictationRows(rows);
  // Seed the slot the commit will replace, through the real registration path.
  windowManager.hotkeyManager.setupShortcuts(
    rows.map((row) => row.key),
    windowManager.createHotkeyCallback(),
    "dictation"
  );

  const writes = [];
  let settle;
  const environmentManager = {
    constructor: environmentStub,
    getDictationHotkeyConfig: () => "",
    saveStagedKeys: (overrides) => {
      writes.push(overrides);
      return new Promise((resolve, reject) => {
        settle = { resolve: () => resolve({ success: true }), reject };
      });
    },
  };

  const target = { windowManager, environmentManager };
  return {
    windowManager,
    sent,
    writes,
    commit: (nextRows) =>
      IPCHandlers.prototype._applyDictationHotkeys.call(target, { rows: nextRows }),
    resolveWrite: () => settle.resolve(),
    rejectWrite: (error) => settle.reject(error),
    pendingWrite: () => Boolean(settle),
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

// A3: nothing — not main's dispatch cache, not the renderer, not .env — may
// learn about a configuration that has not reached the disk.
test("a committed mode is invisible until the write lands, and visible after", async (t) => {
  const f = fixture({ rows: [{ key: "F8", mode: null }] });

  const commit = f.commit([{ key: "F8", mode: "cleaned" }]);
  await tick();

  assert.equal(f.writes.length, 1, "the write was attempted");
  assert.deepEqual(
    f.windowManager.getDictationRows(),
    [{ key: "F8", mode: null }],
    "dispatch still reads the previous modes while the write is in flight"
  );
  assert.deepEqual(
    f.sent.filter(({ channel }) => channel === "setting-updated"),
    [],
    "the renderer is not told about an uncommitted key"
  );
  assert.deepEqual(
    sentToAllWindows.filter(({ channel }) => channel === "dictation-key-active"),
    []
  );

  f.resolveWrite();
  const result = await commit;

  assert.equal(result.success, true);
  assert.deepEqual(result.rows, [{ key: "F8", mode: "cleaned" }]);
  assert.deepEqual(f.windowManager.getDictationRows(), [{ key: "F8", mode: "cleaned" }]);
  assert.deepEqual(sentToAllWindows.at(-1), { channel: "dictation-key-active", payload: "F8" });
  assert.deepEqual(f.sent.at(-1), {
    channel: "setting-updated",
    payload: { key: "dictationKey", value: "F8" },
  });
  t.diagnostic(`writes: ${JSON.stringify(f.writes)}`);
});

test("a refused write leaves the previous modes in force and announces nothing", async () => {
  const f = fixture({ rows: [{ key: "F8", mode: "raw" }] });

  const commit = f.commit([{ key: "F8", mode: "cleaned" }]);
  await tick();
  f.rejectWrite(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }));
  const result = await commit;

  assert.equal(result.success, false);
  assert.equal(result.reason, "persist_failed");
  assert.match(result.error, /EACCES/);
  assert.equal(result.degraded, false);
  assert.deepEqual(f.windowManager.getDictationRows(), [{ key: "F8", mode: "raw" }]);
  assert.deepEqual(
    sentToAllWindows.filter(({ channel }) => channel === "dictation-key-active"),
    []
  );
  assert.deepEqual(
    f.sent.filter(({ channel }) => channel === "setting-updated"),
    []
  );
});

// HotkeyManager.updateHotkey persists DICTATION_KEY and sends setting-updated by
// itself. Inside the transaction that would put the keys on disk ahead of — or
// instead of — the modes they belong with, and announce a commit that can still
// fail. The transaction's `publish: false` is what stops it.
test("a key change writes once, through the transaction, carrying keys and rows together", async () => {
  const f = fixture({ rows: [{ key: "F8", mode: null }] });

  const commit = f.commit([
    { key: "F9", mode: "cleaned" },
    { key: "Control+Alt+Shift", mode: "raw" },
  ]);
  await tick();

  assert.deepEqual(envWrites, [], "no eager .env write from the registration pass");
  assert.equal(f.writes.length, 1);
  const [write] = f.writes;
  assert.equal(write.DICTATION_KEY, "F9,Control+Alt+Shift");
  assert.equal(
    Buffer.from(write.DICTATION_HOTKEY_CONFIG, "base64").toString("utf8"),
    JSON.stringify([
      { key: "F9", mode: "cleaned" },
      { key: "Control+Alt+Shift", mode: "raw" },
    ])
  );
  assert.deepEqual(
    f.sent.filter(({ channel }) => channel === "setting-updated"),
    [],
    "the key is announced only once the write has landed"
  );

  f.resolveWrite();
  assert.equal((await commit).success, true);
  assert.deepEqual(envWrites, [], "the transaction owns the write; nothing else writes");
  assert.deepEqual(f.sent.at(-1), {
    channel: "setting-updated",
    payload: { key: "dictationKey", value: "F9,Control+Alt+Shift" },
  });
});

test("a mode-only change re-registers nothing", async () => {
  const f = fixture({ rows: [{ key: "F8", mode: null }] });
  const before = [...registrations];

  const commit = f.commit([{ key: "F8", mode: "raw" }]);
  await tick();
  f.resolveWrite();

  assert.equal((await commit).success, true);
  assert.deepEqual([...registrations], before, "the OS binding was left alone");
});

// A4: the gate drops NEW starts only. A release, a cancel and a stop are always
// delivered, so nothing in flight is ever stranded with the mic open.
test("a commit in flight drops new starts and still delivers stops and cancels", async () => {
  const f = fixture({ rows: [{ key: "F8", mode: null }] });

  const commit = f.commit([{ key: "F9", mode: "cleaned" }]);
  await tick();
  assert.equal(f.windowManager.isHotkeyCommitInFlight(), true);

  f.sent.length = 0;
  f.windowManager.sendToggleDictation({ cleanupOverride: null });
  f.windowManager.sendStartDictation({ cleanupOverride: null });
  f.windowManager.sendPrepareDictation({});
  assert.deepEqual(f.sent, [], "no new recording starts while the keys are changing");

  // The push paths set their own press state before the 150 ms start, and that
  // state is what a release matches against, so they refuse the press outright
  // rather than starting a hold the commit would invalidate.
  f.windowManager.startWindowsPushToTalk("F8");
  assert.equal(f.windowManager.winPushState, null, "no Windows hold is claimed");
  f.windowManager.startMacCompoundPushToTalk("Fn+F8");
  assert.equal(f.windowManager.macCompoundPushState, null, "no macOS hold is claimed");
  assert.deepEqual(f.sent, []);

  f.windowManager.sendStopDictation();
  f.windowManager.sendCancelDictationPreparation();
  assert.deepEqual(
    f.sent.map(({ channel }) => channel),
    ["stop-dictation", "cancel-dictation-preparation"]
  );

  f.resolveWrite();
  await commit;
  assert.equal(f.windowManager.isHotkeyCommitInFlight(), false);
  f.sent.length = 0;
  f.windowManager.sendToggleDictation({ cleanupOverride: "cleaned" });
  assert.ok(
    f.sent.some(({ channel }) => channel === "toggle-dictation"),
    "dictation works again once the commit has settled"
  );
});

// getPressOwner only sees the desktop-backend closures. These are the owners on
// Windows, on macOS, on the native Hold paths and for any tap recording — an
// edit under any of them would strand a release or change the modes a live
// recording started with.
const OWNERS = {
  "a desktop binding": (wm) => {
    wm.hotkeyManager._pressOwner = "F8";
  },
  "a Windows push": (wm) => {
    wm.winPushState = { active: true, key: "F8" };
  },
  "a macOS compound push": (wm) => {
    wm.macCompoundPushState = { active: true };
  },
  "a native Hold in main": (wm) => {
    wm.setNativePressOwner("globe");
  },
  "a live recording": (wm) => {
    wm.setDictationLifecycleState("recording");
  },
  "a prepare already sent": (wm) => {
    wm.setDictationLifecycleState("preparing");
  },
};

for (const [description, own] of Object.entries(OWNERS)) {
  test(`an edit is refused while ${description} owns a binding`, async () => {
    const f = fixture({ rows: [{ key: "F8", mode: null }] });
    own(f.windowManager);

    const result = await f.commit([{ key: "F9", mode: "cleaned" }]);

    assert.equal(result.success, false);
    assert.equal(result.reason, "press_in_flight");
    assert.equal(f.pendingWrite(), false, "nothing was written");
    assert.deepEqual(f.windowManager.getDictationRows(), [{ key: "F8", mode: null }]);
    assert.equal(
      f.windowManager.isHotkeyCommitInFlight(),
      false,
      "a refusal does not leave dictation gated"
    );
  });
}

// Processing owns no binding: the keys are idle again and the transcript is
// already in the pipeline, so refusing here would be a misleading error during
// the seconds after every recording.
test("an edit while the transcript is being processed is allowed", async () => {
  const f = fixture({ rows: [{ key: "F8", mode: null }] });
  f.windowManager.setDictationLifecycleState("processing");
  assert.equal(f.windowManager.getDictationOwner(), null);

  const commit = f.commit([{ key: "F8", mode: "cleaned" }]);
  await tick();
  f.resolveWrite();

  assert.equal((await commit).success, true);
});

test("an idle app reports no owner, so an ordinary edit proceeds", async () => {
  const f = fixture({ rows: [{ key: "F8", mode: null }] });
  assert.equal(f.windowManager.getDictationOwner(), null);

  const commit = f.commit([{ key: "F8", mode: "cleaned" }]);
  await tick();
  f.resolveWrite();

  assert.equal((await commit).success, true);
});

// The native layer can accept a commit and still be unsure about the OLD
// bindings: the new rows are bound, and a previous one may ALSO still be
// claimed. That is a success, but not a clean one, and it must stay visible all
// the way to the renderer.
test("a commit whose old bindings were not released reports success AND degraded", async () => {
  const f = fixture({ rows: [{ key: "Control+F8", mode: null }] });
  const hotkeyManager = f.windowManager.hotkeyManager;
  hotkeyManager.useGnome = true;
  hotkeyManager.activationMode = "tap";
  hotkeyManager.slots.set("dictation", {
    hotkeys: ["Control+F8"],
    accelerators: [],
    bindingIds: ["dictation"],
    generation: 1,
    callback: () => {},
  });
  hotkeyManager.gnomeManager = {
    registeredSlots: new Set(["dictation"]),
    setBindingCallback() {},
    async unregisterPushToTalk() {
      return true;
    },
    // The desktop keeps the old binding...
    async unregisterKeybinding() {
      return false;
    },
    // ...while accepting the new one.
    async registerKeybinding() {
      return true;
    },
  };

  const commit = f.commit([{ key: "Control+F9", mode: "cleaned" }]);
  await tick();
  f.resolveWrite();
  const result = await commit;

  assert.equal(result.success, true);
  assert.equal(result.degraded, true, "an unreleased old binding is not a clean swap");
  // Committed, so the rows ARE published: the uncertainty is about the old key.
  assert.deepEqual(f.windowManager.getDictationRows(), [{ key: "Control+F9", mode: "cleaned" }]);
  assert.equal(f.writes.length, 1);
});
