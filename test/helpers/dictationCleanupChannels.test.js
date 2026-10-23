const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("node:module");

// A typo in one of these channel names only shows up when a user presses the
// key on a real desktop, so pin both halves: what WindowManager pushes with
// the cleanup override, what preload forwards, and the invoke channels the
// Settings section calls to commit the rows.

// WindowManager pulls in electron and its sibling managers at require time;
// only the pieces the dictation toggle touches need to behave.
const originalLoad = Module._load;
Module._load = function loadWindowManagerWithStubs(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: { on: () => undefined },
      screen: { on: () => undefined, getPrimaryDisplay: () => ({}) },
      BrowserWindow: class {},
      Menu: {},
      shell: {},
      dialog: {},
    };
  }
  if (request === "./debugLogger") {
    return { warn: () => undefined, debug: () => undefined, log: () => undefined };
  }
  if (request === "./hotkeyManager") {
    const FakeHotkeyManager = class {};
    FakeHotkeyManager.isGlobeLikeHotkey = () => false;
    return FakeHotkeyManager;
  }
  if (request === "./dragManager") return class {};
  if (request === "./menuManager") return {};
  if (request === "./devServerManager") {
    return {
      DEV_SERVER_PORT: 5173,
      DEV_SERVER_URL: "http://localhost:5173",
      getAppFilePath: () => ({ path: "/app/index.html", query: {} }),
      waitForDevServer: async () => undefined,
    };
  }
  if (request === "./dockManager") return {};
  if (request === "./i18nMain") return { i18nMain: { t: (key) => key } };
  if (request === "./windowConfig") {
    return {
      MAIN_WINDOW_CONFIG: {},
      CONTROL_PANEL_CONFIG: {},
      NOTIFICATION_WINDOW_CONFIG: {},
      WINDOW_SIZES: { BASE: { width: 96, height: 96 } },
      ONBOARDING_WINDOW_SIZES: { COMPACT: {}, EXPANDED: {} },
      WindowPositionUtil: {
        setupAlwaysOnTop: () => undefined,
        clampToWorkArea: (b) => b,
        getMainWindowPosition: () => ({ x: 0, y: 0 }),
        getNotificationPosition: () => ({ x: 0, y: 0 }),
      },
      fitAssistantWindowToWorkArea: (s) => s,
      fitAssistantContentWindowToWorkArea: (h) => ({ width: 466, height: h }),
      fitDictationErrorWindowToWorkArea: (s) => s,
      fitDictationErrorContentWindowToWorkArea: (h) => ({ width: 466, height: h }),
      resolveHorizontalWindowDirection: () => "right",
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const WindowManager = require("../../src/helpers/windowManager");
Module._load = originalLoad;

function makeManager() {
  const sent = [];
  const manager = new WindowManager();
  manager.hotkeyManager = { isInListeningMode: () => false };
  manager.setOnboardingActive(false);
  manager.mainWindow = {
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
  };
  manager.showDictationPanel = () => undefined;
  manager.isDictationProcessing = () => false;
  return { manager, sent, channels: () => sent.map((entry) => entry.channel) };
}

function loadPreloadApi() {
  let exposedApi;
  const listeners = new Map();
  const invocations = [];
  const ipcRenderer = {
    invoke: async (...args) => {
      invocations.push(args);
      return undefined;
    },
    on: (channel, listener) => listeners.set(channel, listener),
    removeListener: (channel, listener) => {
      if (listeners.get(channel) === listener) listeners.delete(channel);
    },
    send: () => undefined,
    sendSync: () => undefined,
  };
  const source = fs.readFileSync(path.join(__dirname, "../../preload.js"), "utf8");
  vm.runInNewContext(source, {
    require: (specifier) => {
      if (specifier === "electron") {
        return {
          contextBridge: {
            exposeInMainWorld: (_name, api) => {
              exposedApi = api;
            },
          },
          ipcRenderer,
          webUtils: {},
        };
      }
      throw new Error(`Unexpected preload dependency: ${specifier}`);
    },
    process,
  });
  return { api: exposedApi, listeners, invocations };
}

test("the dictation toggle carries its row's cleanup override to the renderer", () => {
  const { manager, sent } = makeManager();

  manager.sendToggleDictation({ cleanupOverride: "cleaned" });

  // Pre-warms the mic one message ahead of the toggle, and both messages
  // describe the SAME recording: the prepare that opens the mic must not
  // disagree with the toggle about which cleanup was asked for.
  assert.deepEqual(sent, [
    {
      channel: "prepare-dictation",
      payload: { inputKind: "dictation", cleanupOverride: "cleaned" },
    },
    { channel: "toggle-dictation", payload: { cleanupOverride: "cleaned" } },
  ]);
});

test("a row with no override reports the app setting, not a mode", () => {
  const { manager, sent } = makeManager();

  manager.sendToggleDictation({ cleanupOverride: null });

  assert.deepEqual(sent.at(-1), {
    channel: "toggle-dictation",
    payload: { cleanupOverride: null },
  });
});

test("the start message carries the override captured at key-down", () => {
  const { manager, sent } = makeManager();

  manager.sendStartDictation({ cleanupOverride: "raw" });

  assert.deepEqual(sent, [{ channel: "start-dictation", payload: { cleanupOverride: "raw" } }]);
});

// preload used to drop every argument for these two channels, which is how a
// per-row mode would reach main and then vanish on the way to the recording.
test("preload forwards the payload for every channel that carries the override", () => {
  const { api, listeners } = loadPreloadApi();

  for (const [channel, listenerName] of [
    ["toggle-dictation", "onToggleDictation"],
    ["start-dictation", "onStartDictation"],
    ["prepare-dictation", "onPrepareDictation"],
  ]) {
    const received = [];
    const dispose = api[listenerName]((...args) => received.push(args));
    const listener = listeners.get(channel);
    assert.ok(listener, `preload must subscribe to ${channel}`);
    // The Electron event object must not reach the renderer callback.
    listener({ sender: "electron-event" }, { cleanupOverride: "cleaned" });
    assert.deepEqual(received, [[{ cleanupOverride: "cleaned" }]], channel);
    dispose();
    assert.equal(listeners.has(channel), false, `${channel} listener must be removable`);
  }
});

test("the Settings section invokes the row channels the main process handles", async () => {
  const { api, invocations } = loadPreloadApi();
  const rows = [{ key: "Control+Shift+Space", mode: "cleaned" }];

  invocations.length = 0;
  await api.applyDictationHotkeys({ rows });
  assert.deepEqual(invocations, [["apply-dictation-hotkeys", { rows }]]);

  invocations.length = 0;
  await api.getDictationHotkeyConfig();
  assert.deepEqual(invocations, [["get-dictation-hotkey-config"]]);
});

// The beta put cleanup in two extra hotkey sections. Those channels are gone;
// a leftover handler or preload member would be a shortcut nobody can reach
// from the UI, still registered against the user's keys.
test("the retired cleanup-mode channels are gone from main and preload", () => {
  const { api } = loadPreloadApi();
  const mainSource = fs.readFileSync(
    path.join(__dirname, "../../src/helpers/ipcHandlers.js"),
    "utf8"
  );
  const windowManagerSource = fs.readFileSync(
    path.join(__dirname, "../../src/helpers/windowManager.js"),
    "utf8"
  );

  for (const channel of [
    "toggle-raw-dictation",
    "toggle-cleaned-dictation",
    "update-raw-dictation-hotkey",
    "update-cleaned-dictation-hotkey",
    "get-raw-dictation-key",
    "get-cleaned-dictation-key",
  ]) {
    assert.doesNotMatch(mainSource, new RegExp(`"${channel}"`), channel);
  }
  for (const member of [
    "onToggleRawDictation",
    "onToggleCleanedDictation",
    "updateRawDictationHotkey",
    "updateCleanedDictationHotkey",
    "getRawDictationKey",
    "getCleanedDictationKey",
  ]) {
    assert.equal(api[member], undefined, member);
  }
  for (const method of ["sendToggleRawDictation", "sendToggleCleanedDictation"]) {
    assert.doesNotMatch(windowManagerSource, new RegExp(method), method);
  }
});
