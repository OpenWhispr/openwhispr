const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const vm = require("node:vm");

const mainSource = fs.readFileSync(require.resolve("../../main.js"), "utf8");
const initializer = mainSource.slice(
  mainSource.indexOf("function initializeNativeKeyListeners() {"),
  mainSource.indexOf("function initializeCoreManagers() {")
);
const restoreSlot = mainSource.slice(
  mainSource.indexOf("  const restoreRecordingSlot = async"),
  mainSource.indexOf("  await restoreRecordingSlot(")
);
const settledHandler = mainSource.slice(
  mainSource.indexOf('  hotkeyManager.on("dictation-activation-mode-settled"'),
  mainSource.indexOf('  ipcMain.on("floating-icon-auto-hide-changed"')
);

function makeHarness(t, platform, { available = true, rejectKeys = [] } = {}) {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const previousKey = process.env.DICTATION_KEY;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  t.after(() => {
    Object.defineProperty(process, "platform", platformDescriptor);
    if (previousKey === undefined) delete process.env.DICTATION_KEY;
    else process.env.DICTATION_KEY = previousKey;
  });
  const children = [];
  const bound = new Map();
  const windows = [];
  const debugLogger = { debug() {}, warn() {}, log() {}, error() {}, info() {} };
  const BrowserWindow = class {
    static getAllWindows() {
      return windows;
    }
  };
  const electron = {
    BrowserWindow,
    globalShortcut: {
      register(key, callback) {
        if (rejectKeys.includes(key) || bound.has(key)) return false;
        bound.set(key, callback);
        return true;
      },
      unregister: (key) => bound.delete(key),
      unregisterAll: () => bound.clear(),
      isRegistered: (key) => bound.has(key),
    },
    app: { on() {} },
    screen: { on() {} },
  };
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron") return electron;
    if (request === "./debugLogger") return debugLogger;
    if (request === "./i18nMain")
      return { i18nMain: { t: (key) => key, getFixedT: () => (key) => key } };
    if (request === "./gnomeShortcut")
      return class {
        static isGnome() {
          return false;
        }
      };
    if (request === "./hyprlandShortcut")
      return class {
        static isWayland() {
          return false;
        }
      };
    if (request === "./kdeShortcut")
      return class {
        static isKDE() {
          return false;
        }
      };
    if (["./dragManager", "./menuManager"].includes(request)) return class {};
    if (request === "./dockManager") return {};
    if (request === "./devServerManager") return {};
    if (request === "./windowConfig")
      return {
        WINDOW_SIZES: { BASE: {} },
        WindowPositionUtil: {},
      };
    if (request === "fs" && /(?:windows|linux)KeyManager/.test(parent.filename))
      return {
        statSync() {
          if (!available) throw new Error("missing native helper");
          return { isFile: () => true };
        },
      };
    if (request === "child_process" && /(?:windows|linux)KeyManager/.test(parent.filename))
      return {
        spawn(_path, [key]) {
          const child = Object.assign(new EventEmitter(), { key });
          child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
          child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
          child.kill = () => {
            child.killed = true;
          };
          children.push(child);
          return child;
        },
      };
    return originalLoad.call(this, request, parent, isMain);
  };
  let windowManager, nativeKeyManager;
  try {
    for (const name of ["windowManager", "hotkeyManager", "windowsKeyManager", "linuxKeyManager"]) {
      delete require.cache[require.resolve(`../../src/helpers/${name}`)];
    }
    windowManager = new (require("../../src/helpers/windowManager"))();
    nativeKeyManager = new (require(
      `../../src/helpers/${platform === "win32" ? "windows" : "linux"}KeyManager`
    ))();
  } finally {
    Module._load = originalLoad;
  }
  t.after(() => nativeKeyManager.stop());
  const hotkeyManager = windowManager.hotkeyManager;
  hotkeyManager.nativeKeyManager = nativeKeyManager;
  windowManager[platform === "win32" ? "windowsKeyManager" : "linuxKeyManager"] = nativeKeyManager;
  const messages = [];
  windowManager.mainWindow = {
    isDestroyed: () => false,
    webContents: {
      send: (...args) => messages.push(args),
      isLoading: () => false,
      executeJavaScript: async () => "",
    },
  };
  windows.push(windowManager.mainWindow);
  hotkeyManager.mainWindow = windowManager.mainWindow;
  windowManager._onboardingActive = false;
  const calls = [];
  windowManager._sendDictationToggle = (channel) => calls.push(channel);
  windowManager.sendToggleDictation = () => calls.push("toggle-dictation");
  windowManager.sendToggleVoiceAgent = () => calls.push("toggle-voice-agent");
  windowManager.sendToggleTranslation = () => calls.push("toggle-translation");
  windowManager.sendPrepareDictation = ({ inputKind }) => {
    calls.push(`prepare:${inputKind}`);
    windowManager._dictationLifecycleState = "preparing";
    windowManager._dictationInputKind = inputKind;
  };
  windowManager.sendStartDictation = ({ inputKind }) => {
    calls.push(`start:${inputKind}`);
    windowManager._dictationLifecycleState = "recording";
    windowManager._dictationInputKind = inputKind;
  };
  windowManager.sendStopDictation = () => {
    calls.push("stop");
    windowManager._dictationLifecycleState = "idle";
  };
  windowManager.sendCancelDictationPreparation = () => calls.push("cancel-preparation");
  windowManager.showDictationPanel = () => {};
  windowManager.hideDictationPanel = () => {};
  windowManager.startManualMeeting = () => calls.push("meeting");
  hotkeyManager._persistHotkeyToEnvFile = async () => {};
  hotkeyManager.saveHotkeyToRenderer = async () => true;
  hotkeyManager.on("native-listeners-reconcile", () => windowManager.reconcileNativeKeyListeners());
  const persisted = [];
  const modes = { voiceAgent: "push", translation: "push" };
  const environmentManager = {
    saveActivationMode(mode) {
      persisted.push(["dictation", mode]);
    },
    saveSlotActivationMode(slot, mode) {
      modes[slot] = mode;
      persisted.push([slot, mode]);
    },
    getSlotActivationModes: () => ({ ...modes }),
  };
  const context = {
    process,
    hotkeyManager,
    windowManager,
    environmentManager,
    BrowserWindow,
    debugLogger,
    windowsKeyManager: nativeKeyManager,
    linuxKeyManager: nativeKeyManager,
    ipcMain: new EventEmitter(),
    isLiveWindow: (win) => win && !win.isDestroyed(),
    i18nMain: { t: (key) => key, getFixedT: () => (key) => key },
  };
  const main = vm.runInNewContext(
    `let activationModeChangeQueue = Promise.resolve();\n${initializer}\n${settledHandler}\n${restoreSlot}\ninitializeNativeKeyListeners();\n({ flush: () => activationModeChangeQueue, restoreRecordingSlot });`,
    context
  );
  return {
    windowManager,
    hotkeyManager,
    nativeKeyManager,
    children,
    bound,
    calls,
    messages,
    windows,
    persisted,
    modes,
    ...main,
  };
}

for (const platform of ["win32", "linux"]) {
  test(`${platform}: startup Hold requests with a missing helper retain working regular Tap keys for all recording slots`, async (t) => {
    const h = makeHarness(t, platform, { available: false });
    process.env.DICTATION_KEY = "F8";
    await h.windowManager.setActivationModeCache("push", { deferCapabilityCheck: true });
    await h.windowManager.initializeHotkey();
    await h.flush();
    await h.restoreRecordingSlot(
      "voiceAgent",
      "F9",
      h.windowManager.createHotkeyCallback("assistant")
    );
    await h.restoreRecordingSlot(
      "translation",
      "F10",
      h.windowManager.createHotkeyCallback("translation")
    );
    for (const [slot, key] of [
      ["dictation", "F8"],
      ["voiceAgent", "F9"],
      ["translation", "F10"],
    ]) {
      assert.equal(h.hotkeyManager.getSlotHotkey(slot), key);
      assert.equal(h.windowManager.getSlotActivationMode(slot), "tap");
      assert.equal(h.hotkeyManager.getSlotActivationMode(slot), "tap");
      h.bound.get(key)();
      assert.ok(h.persisted.some(([name, mode]) => name === slot && mode === "tap"));
      const settingKey = slot === "dictation" ? "activationMode" : `${slot}ActivationMode`;
      assert.ok(
        h.messages.some(
          ([channel, data]) =>
            channel === "setting-updated" && data.key === settingKey && data.value === "tap"
        )
      );
    }
    assert.deepEqual(h.calls, ["toggle-dictation", "toggle-voice-agent", "toggle-translation"]);
    assert.equal(h.windows.length, 1, "main fallback needs no Settings window");
    assert.equal(h.children.length, 0);
  });

  test(`${platform}: native-only missing helper cannot claim successful Tap on startup or edit`, async (t) => {
    const h = makeHarness(t, platform, { available: false });
    process.env.DICTATION_KEY = "RightControl";
    await h.windowManager.setActivationModeCache("push", { deferCapabilityCheck: true });
    await h.windowManager.initializeHotkey();
    await h.flush();
    assert.notEqual(h.hotkeyManager.getCurrentHotkey(), "RightControl");
    const previous = h.hotkeyManager.getCurrentHotkey();
    const result = await h.windowManager.updateHotkey("RightControl");
    assert.equal(result.success, false);
    assert.equal(h.hotkeyManager.getCurrentHotkey(), previous);
    assert.equal(h.bound.has(previous), true);
  });

  test(`${platform}: fallback cleanup cannot re-enable a failed Hold before an explicit retry succeeds`, async (t) => {
    const h = makeHarness(t, platform);
    h.hotkeyManager.setupShortcuts("F9", h.windowManager.createHotkeyCallback());
    const initial = h.hotkeyManager.resolveActivationMode("F9");
    h.children[0].stdout.emit("data", "READY\n");
    await initial;
    await h.windowManager.setActivationModeCache("push");
    h.children[0].emit("error", new Error("hook lost"));
    await h.flush();
    assert.equal(h.windowManager.getActivationMode(), "tap");
    assert.equal(h.nativeKeyManager.readiness.size, 0, "main removed unused failed readers");
    assert.equal(h.hotkeyManager.supportsPushToTalk("F9"), false);
    assert.equal(await h.windowManager.setActivationModeCache("push"), false);
    assert.equal(h.windowManager.getActivationMode(), "tap");
    const edit = h.windowManager.updateHotkey("F9");
    assert.equal(h.children.length, 2);
    assert.equal(h.hotkeyManager.supportsPushToTalk("F9"), false);
    assert.equal(await h.windowManager.setActivationModeCache("push"), false);
    h.children[1].stdout.emit("data", "READY\n");
    assert.equal((await edit).success, true);
    assert.equal(h.hotkeyManager.supportsPushToTalk("F9"), true);
    assert.equal(h.windowManager.getActivationMode(), "push");
  });

  test(`${platform}: successful readiness enables Hold; a candidate reader never duplicates Electron Tap`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
    const h = makeHarness(t, platform);
    h.hotkeyManager.setupShortcuts("F8", h.windowManager.createHotkeyCallback());
    const candidate = h.hotkeyManager.resolveActivationMode("F8");
    h.children[0].stdout.emit("data", "READY\nKEY_DOWN\n");
    assert.equal(await candidate, "push");
    assert.deepEqual(h.calls, []);
    h.bound.get("F8")();
    assert.deepEqual(h.calls, ["toggle-dictation"]);
    h.calls.length = 0;
    await h.windowManager.setActivationModeCache("push");
    h.children[0].stdout.emit("data", "KEY_DOWN\n");
    t.mock.timers.tick(150);
    h.children[0].stdout.emit("data", "KEY_UP\n");
    assert.deepEqual(h.calls, ["prepare:dictation", "start:dictation", "stop"]);
    h.calls.length = 0;
    t.mock.timers.tick(600);
    h.children[0].stdout.emit("data", "KEY_DOWN\nKEY_UP\n");
    t.mock.timers.tick(170);
    h.children[0].stdout.emit("data", "KEY_DOWN\nKEY_UP\n");
    assert.equal(h.windowManager.isHandsFreeActive("dictation"), true);
    t.mock.timers.tick(600);
    h.children[0].stdout.emit("data", "KEY_DOWN\nKEY_UP\n");
    assert.equal(h.windowManager.isHandsFreeActive("dictation"), false);
    assert.equal(h.calls.filter((call) => call === "start:dictation").length, 1);
    assert.equal(h.calls.filter((call) => call === "stop").length, 1);
  });
}

for (const backend of ["KDE", "Gnome", "Hyprland"]) {
  test(`${backend}: native phase-owned Hold survives optional evdev permission failure`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
    const h = makeHarness(t, "linux");
    const slots =
      backend === "Hyprland"
        ? [["dictation", "dictation", "F8"]]
        : [
            ["dictation", "dictation", "F8"],
            ["voiceAgent", "assistant", "F9"],
            ["translation", "translation", "F10"],
          ];
    for (const [slot, kind, key] of slots) {
      h.hotkeyManager.setupShortcuts(key, h.windowManager.createHotkeyCallback(kind), slot);
      if (slot === "dictation") await h.windowManager.setActivationModeCache("push");
      else await h.windowManager.setSlotActivationModeCache(slot, "push");
    }
    h.hotkeyManager[`use${backend}`] = true;
    if (backend === "Gnome") h.hotkeyManager.gnomeManager = { supportsPushToTalk: () => true };
    h.windowManager.reconcileNativeKeyListeners();
    assert.equal(h.children.length, 0);
    const optionalReader = h.nativeKeyManager.ensureReady(["F20"]);
    h.children[0].stdout.emit("data", "NO_PERMISSION\nREADY\n");
    assert.equal(await optionalReader, false);
    await h.flush();
    assert.deepEqual(h.persisted, []);
    for (const [slot, kind, key] of slots) {
      assert.equal(h.windowManager.getSlotActivationMode(slot), "push");
      const callback = h.hotkeyManager.slots.get(slot).callback;
      callback(key, "down");
      t.mock.timers.tick(150);
      callback(key, "up");
      t.mock.timers.tick(600);
      assert.ok(h.calls.includes(`start:${kind}`));
    }
  });
}

test("a failed unused candidate preserves the current Hold recording and current binding", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const h = makeHarness(t, "win32", { rejectKeys: ["F10"] });
  h.hotkeyManager.setupShortcuts("F9", h.windowManager.createHotkeyCallback());
  const initial = h.hotkeyManager.resolveActivationMode("F9");
  h.children[0].stdout.emit("data", "READY\n");
  await initial;
  await h.windowManager.setActivationModeCache("push");
  h.children[0].stdout.emit("data", "KEY_DOWN\n");
  t.mock.timers.tick(150);
  const recording = h.windowManager.nativePushState;
  const edit = h.windowManager.updateHotkey("F10");
  h.children[1].emit("error", new Error("candidate failed"));
  assert.equal((await edit).success, false);
  await h.flush();
  assert.equal(h.hotkeyManager.getCurrentHotkey(), "F9");
  assert.equal(h.windowManager.getActivationMode(), "push");
  assert.equal(h.windowManager.nativePushState, recording);
  assert.equal(h.children[0].killed, undefined);
  assert.equal(h.children[1].killed, true);
  assert.deepEqual(h.persisted, []);
  assert.equal(h.calls.includes("stop"), false);
  h.windowManager.resetNativePushState();
});

test("a failed current key demotes only its slot and leaves another kind's recording alone", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const h = makeHarness(t, "win32");
  h.hotkeyManager.setupShortcuts("F8", h.windowManager.createHotkeyCallback());
  h.hotkeyManager.setupShortcuts(
    "F9",
    h.windowManager.createHotkeyCallback("assistant"),
    "voiceAgent"
  );
  const ready = h.nativeKeyManager.ensureReady(["F8", "F9"]);
  h.children.forEach((child) => child.stdout.emit("data", "READY\n"));
  await ready;
  await h.windowManager.setActivationModeCache("push");
  await h.windowManager.setSlotActivationModeCache("voiceAgent", "push");
  h.children[1].stdout.emit("data", "KEY_DOWN\n");
  t.mock.timers.tick(150);
  const recording = h.windowManager.nativePushState;
  h.children[0].emit("exit", 0, null);
  await h.flush();
  assert.equal(h.windowManager.getActivationMode(), "tap");
  assert.equal(h.windowManager.getSlotActivationMode("voiceAgent"), "push");
  assert.equal(h.windowManager.nativePushState, recording);
  assert.equal(h.calls.includes("stop"), false);
  assert.deepEqual(h.persisted, [["dictation", "tap"]]);
  h.windowManager.resetNativePushState();
});

test("an active native-only Hold ends promptly on reader failure without claiming working Tap", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const h = makeHarness(t, "win32");
  const ready = h.nativeKeyManager.ensureReady(["RightControl"]);
  h.children[0].stdout.emit("data", "READY\n");
  await ready;
  h.hotkeyManager.setupShortcuts("RightControl", h.windowManager.createHotkeyCallback());
  await h.windowManager.setActivationModeCache("push");
  h.children[0].stdout.emit("data", "KEY_DOWN\n");
  t.mock.timers.tick(150);
  h.children[0].emit("error", new Error("reader lost"));
  await h.flush();
  assert.equal(h.windowManager.nativePushState, null);
  assert.equal(h.calls.filter((call) => call === "stop").length, 1);
  assert.equal(h.windowManager.getActivationMode(), "push");
  assert.deepEqual(h.persisted, []);
  assert.ok(h.messages.some(([channel]) => channel === "hotkey-registration-failed"));
});

test("persisted Tap is preserved at startup; an explicit later edit retries and recovers Hold", async (t) => {
  const h = makeHarness(t, "win32");
  process.env.DICTATION_KEY = "F9";
  await h.windowManager.setActivationModeCache("tap", { deferCapabilityCheck: true });
  await h.windowManager.initializeHotkey();
  await h.flush();
  assert.equal(h.children.length, 0);
  assert.equal(h.windowManager.getActivationMode(), "tap");
  const edit = h.windowManager.updateHotkey("F10");
  h.children[0].stdout.emit("data", "READY\n");
  assert.equal((await edit).activationMode, "push");
  assert.equal(h.windowManager.getActivationMode(), "push");
  assert.equal(h.bound.has("F9"), false);
  assert.equal(h.bound.has("F10"), true);
});

for (const [platform, failure] of [
  ["win32", "error"],
  ["win32", "zero"],
  ["win32", "timeout"],
  ["linux", "permission"],
]) {
  test(`${platform}: startup ${failure} settles the saved key to working Tap`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = makeHarness(t, platform);
    process.env.DICTATION_KEY = "F9";
    await h.windowManager.setActivationModeCache("push", { deferCapabilityCheck: true });
    const startup = h.windowManager.initializeHotkey();
    const child = h.children[0];
    if (failure === "error") child.emit("error", new Error("no hook"));
    if (failure === "zero") child.emit("exit", 0, null);
    if (failure === "timeout") t.mock.timers.tick(5000);
    if (failure === "permission") child.stdout.emit("data", "NO_PERMISSION\nREADY\n");
    await startup;
    await h.flush();
    assert.equal(h.hotkeyManager.getCurrentHotkey(), "F9");
    assert.equal(h.windowManager.getActivationMode(), "tap");
    assert.equal(h.hotkeyManager.activationMode, "tap");
    h.bound.get("F9")();
    assert.deepEqual(h.calls, ["toggle-dictation"]);
    assert.equal(h.children.length, 1, "fallback reconciliation must not retry the failed reader");
  });
}

test("a global hotkey list uses one conservative mode when its second reader fails", async (t) => {
  const h = makeHarness(t, "win32");
  const resolved = h.hotkeyManager.resolveActivationMode("F8,F9");
  h.children[0].stdout.emit("data", "READY\n");
  h.children[1].emit("error", new Error("second reader rejected"));
  assert.equal(await resolved, "tap");
  assert.equal(h.nativeKeyManager.canWatch("F8"), true);
  assert.equal(h.nativeKeyManager.canWatch("F9"), false);
});

test("permission notice in Settings cannot mutate any activation mode", () => {
  const settingsSource = fs.readFileSync(
    require.resolve("../../src/components/SettingsPage.tsx"),
    "utf8"
  );
  const effectStart = settingsSource.lastIndexOf(
    "  useEffect(() => {",
    settingsSource.indexOf("onLinuxPttPermissionDenied")
  );
  const effectEnd = settingsSource.indexOf("\n\n  useEffect", effectStart);
  let callback,
    notices = 0;
  const forbiddenWrite = () => {
    throw new Error("renderer attempted to change activation mode");
  };
  vm.runInNewContext(settingsSource.slice(effectStart, effectEnd), {
    useEffect: (effect) => effect(),
    window: {
      electronAPI: {
        onLinuxPttPermissionDenied: (listener) => {
          callback = listener;
        },
      },
    },
    toast: () => notices++,
    t: (key) => key,
    setActivationMode: forbiddenWrite,
    setVoiceAgentActivationMode: forbiddenWrite,
    setTranslationActivationMode: forbiddenWrite,
  });
  callback();
  assert.equal(notices, 1);
});
