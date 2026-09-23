const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// Execute the actual IPC closures, WindowManager cache setter, HotkeyManager,
// and KDE adapter, including macOS fallback ownership. Only Electron and desktop
// D-Bus transport are simulated.

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;

const handlers = new Map();
const broadcasts = [];
const electronRegistrations = new Map();
const refusedAccelerators = new Set();
const registrationEvents = [];

const fakeWindow = {
  isDestroyed: () => false,
  webContents: {
    send: (_channel, payload) => broadcasts.push(payload),
  },
};

const electronStub = {
  app: {
    getPath: () => "/tmp",
    getName: () => "test",
    getVersion: () => "0.0.0",
    isPackaged: false,
    on: () => {},
    requestSingleInstanceLock: () => true,
  },
  ipcMain: {
    handle: (channel, fn) => handlers.set(channel, fn),
    on: () => {},
    removeHandler: () => {},
  },
  net: { fetch: async () => ({ ok: true, json: async () => ({}) }) },
  BrowserWindow: class BrowserWindow {
    static getAllWindows() {
      return [fakeWindow];
    }
    static fromWebContents() {
      return null;
    }
  },
  globalShortcut: {
    register: (accelerator, callback) => {
      registrationEvents.push(["register", accelerator]);
      if (refusedAccelerators.has(accelerator) || electronRegistrations.has(accelerator))
        return false;
      electronRegistrations.set(accelerator, callback);
      return true;
    },
    unregister: (accelerator) => electronRegistrations.delete(accelerator),
    isRegistered: (accelerator) => electronRegistrations.has(accelerator),
    unregisterAll: () => electronRegistrations.clear(),
  },
  shell: {},
  dialog: {},
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
  session: { fromPartition: () => ({}) },
  clipboard: {},
  nativeImage: {},
  utilityProcess: {},
  MessageChannelMain: class {},
};

Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "electron") return electronStub;
  return originalLoad.call(this, request, parent, isMain);
};

// Registration only stores closures, so every manager the two handlers under
// test do not touch can be an inert stub (same pattern as
// hotkeyModeInfoIpc.test.js / retryTranscriptionHandler.test.js).
function anything() {
  return new Proxy(function () {}, {
    get: (t, prop) => {
      if (prop === Symbol.toPrimitive || prop === "toString") return () => "";
      if (prop === "then") return undefined;
      return anything();
    },
    apply: () => anything(),
  });
}

const { EventEmitter } = require("node:events");
const HotkeyManager = require("../../src/helpers/hotkeyManager");
const KDEShortcutManager = require("../../src/helpers/kdeShortcut");
const WindowManager = require("../../src/helpers/windowManager");
const IPCHandlers = require(handlersModulePath);
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const originalSessionType = process.env.XDG_SESSION_TYPE;

test.before(() => {
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  process.env.XDG_SESSION_TYPE = "wayland";
});
test.after(() => {
  Module._load = originalLoad;
  Object.defineProperty(process, "platform", originalPlatform);
  if (originalSessionType === undefined) delete process.env.XDG_SESSION_TYPE;
  else process.env.XDG_SESSION_TYPE = originalSessionType;
});

async function setup(slotName, initialKey = "F9", initialMode = "push", { backend = "kde" } = {}) {
  broadcasts.length = 0;
  electronRegistrations.clear();
  refusedAccelerators.clear();
  registrationEvents.length = 0;
  const manager = new HotkeyManager();
  manager.currentHotkey = "F8";
  const kde = new KDEShortcutManager();
  const bindings = new Map();
  const phases = [];
  const actions = [];
  let dispatch;
  const saved = [];
  const notifications = [];
  const faults = { conflict: false, setFailures: 0, removeFailure: false, removeWait: null };
  const component = new EventEmitter();
  const operations = [];
  kde.bus = {
    invoke: (_message, callback) => callback(null, faults.conflict ? [["other-app"]] : []),
    getService: () => ({ getInterface: (_path, _iface, callback) => callback(null, component) }),
  };
  kde.kglobalaccel = {
    unRegister(action, callback) {
      operations.push("remove");
      const finish = () => {
        if (faults.removeFailure) return callback(new Error("remove refused"));
        bindings.delete(action[1]);
        callback(null);
      };
      if (faults.removeWait) faults.removeWait(finish);
      else finish();
    },
    doRegister: (_action, callback) => callback(null),
    setShortcut(action, keys, _flags, callback) {
      operations.push("set");
      if (faults.setFailures > 0) {
        faults.setFailures--;
        return callback(new Error("set refused"));
      }
      bindings.set(action[1], keys[0]);
      callback(null, keys);
    },
  };
  manager.useKDE = backend === "kde";
  manager.kdeManager = backend === "kde" ? kde : null;
  manager.slotActivationModes[slotName] = initialMode;
  const callback = (key, phase) => {
    phases.push(phase);
    return dispatch?.(key, phase);
  };
  assert.equal(
    (await manager.registerSlot(slotName, initialKey, callback, { atomic: true })).success,
    true
  );
  const windowManager = new Proxy(
    {
      hotkeyManager: manager,
      _cachedSlotActivationModes: {
        voiceAgent: "tap",
        translation: "tap",
        [slotName]: initialMode,
      },
      _voiceAgentHotkeyCallback: callback,
      _translationHotkeyCallback: callback,
      isDictationProcessing: () => false,
      _sendDictationToggle: (channel) => actions.push(channel),
      startMacCompoundPushToTalk: (hotkey, kind) => actions.push(["hold", hotkey, kind]),
      getSlotActivationMode: WindowManager.prototype.getSlotActivationMode,
      setSlotActivationModeCache: WindowManager.prototype.setSlotActivationModeCache,
      reconcileNativeKeyListeners: () => undefined,
    },
    { get: (target, property) => (property in target ? target[property] : anything()) }
  );
  dispatch = WindowManager.prototype.createHotkeyCallback.call(
    windowManager,
    slotName === "voiceAgent" ? "assistant" : "translation"
  );
  const environmentManager = new Proxy(
    {
      saveSlotActivationMode: (slot, mode) => saved.push([slot, mode]),
      saveVoiceAgentKey: (key) => saved.push(["voiceAgentKey", key]),
      saveTranslationKey: (key) => saved.push(["translationKey", key]),
    },
    { get: (target, property) => (property in target ? target[property] : anything()) }
  );
  const target = new Proxy(
    {
      windowManager,
      environmentManager,
      _notifyHotkeyChanged: (key) => notifications.push(key),
    },
    { get: (target, property) => (property in target ? target[property] : anything()) }
  );
  IPCHandlers.prototype.setupHandlers.call(target);
  const update = handlers.get(
    slotName === "voiceAgent" ? "update-voice-agent-hotkey" : "update-translation-hotkey"
  );
  operations.length = 0;
  return {
    manager,
    kde,
    bindings,
    component,
    phases,
    actions,
    saved,
    notifications,
    faults,
    operations,
    windowManager,
    update: (key) => update({}, key),
  };
}

for (const slotName of ["voiceAgent", "translation"]) {
  test(`${slotName}: KDE Hold to modifier-only replacement selects Tap before registration`, async () => {
    const h = await setup(slotName);
    const result = await h.update("Control+Super");
    assert.equal(result.success, true);
    assert.equal(h.bindings.get(slotName), KDEShortcutManager.convertToQtKeyCode("Control+Super"));
    assert.deepEqual(h.manager.getSlotHotkeys(slotName), ["Control+Super"]);
    assert.equal(h.manager.getSlotActivationMode(slotName), "tap");
    assert.equal(h.windowManager.getSlotActivationMode(slotName), "tap");
    assert.ok(h.saved.some(([slot, mode]) => slot === slotName && mode === "tap"));
    assert.deepEqual(broadcasts, [{ key: `${slotName}ActivationMode`, value: "tap" }]);
    h.component.emit("globalShortcutPressed", "openwhispr", slotName);
    assert.deepEqual(h.phases, ["down"]);
    assert.deepEqual(h.actions, [
      slotName === "voiceAgent" ? "toggle-voice-agent" : "toggle-translation",
    ]);
  });

  test(`${slotName}: a KDE conflict preserves the previous key and callback without teardown`, async () => {
    const h = await setup(slotName, "Control+Super", "tap");
    h.faults.conflict = true;
    assert.equal((await h.update("F10")).success, false);
    assert.deepEqual(h.operations, []);
    assert.equal(h.bindings.get(slotName), KDEShortcutManager.convertToQtKeyCode("Control+Super"));
    assert.deepEqual(h.manager.getSlotHotkeys(slotName), ["Control+Super"]);
    assert.equal(h.manager.getSlotActivationMode(slotName), "tap");
    assert.equal(h.windowManager.getSlotActivationMode(slotName), "tap");
    assert.deepEqual(h.saved, []);
    assert.deepEqual(broadcasts, []);
    assert.deepEqual(h.notifications, []);
    h.component.emit("globalShortcutPressed", "openwhispr", slotName);
    assert.deepEqual(h.phases, ["down"]);
  });

  test(`${slotName}: a mutation-stage KDE failure restores the actual previous binding`, async () => {
    const h = await setup(slotName, "Control+Super", "tap");
    h.faults.setFailures = 1;
    assert.equal((await h.update("F10")).success, false);
    assert.equal(h.bindings.get(slotName), KDEShortcutManager.convertToQtKeyCode("Control+Super"));
    assert.deepEqual(h.manager.getSlotHotkeys(slotName), ["Control+Super"]);
    assert.equal(h.manager.getSlotActivationMode(slotName), "tap");
    assert.equal(h.windowManager.getSlotActivationMode(slotName), "tap");
    assert.deepEqual(h.saved, []);
    assert.deepEqual(broadcasts, []);
    h.component.emit("globalShortcutPressed", "openwhispr", slotName);
    assert.deepEqual(h.phases, ["down"]);
  });
}

test("native clear waits for removal and then persists the empty Tap slot", async () => {
  const h = await setup("translation");
  let finishRemoval;
  h.faults.removeWait = (finish) => {
    finishRemoval = finish;
  };
  let settled = false;
  const update = h.update("").then((result) => {
    settled = true;
    return result;
  });
  await new Promise(setImmediate);
  assert.equal(settled, false);
  assert.deepEqual(h.saved, []);
  assert.deepEqual(h.manager.getSlotHotkeys("translation"), ["F9"]);
  h.faults.removeWait = null;
  finishRemoval();
  assert.equal((await update).success, true);
  assert.equal(h.bindings.has("translation"), false);
  assert.deepEqual(h.manager.getSlotHotkeys("translation"), []);
  assert.equal(h.windowManager.getSlotActivationMode("translation"), "tap");
  h.component.emit("globalShortcutPressed", "openwhispr", "translation");
  assert.deepEqual(h.phases, []);
  assert.ok(h.saved.some(([key, value]) => key === "translationKey" && value === ""));
});

test("failed native clear preserves the saved key and live binding", async () => {
  const h = await setup("voiceAgent");
  h.faults.removeFailure = true;
  assert.equal((await h.update("")).success, false);
  assert.deepEqual(h.manager.getSlotHotkeys("voiceAgent"), ["F9"]);
  assert.equal(h.bindings.has("voiceAgent"), true);
  assert.deepEqual(h.saved, []);
  assert.deepEqual(broadcasts, []);
});

test("failed rollback reports lost registration instead of retaining false active metadata", async () => {
  const h = await setup("voiceAgent", "Control+Super", "tap");
  h.faults.setFailures = 2;
  const result = await h.update("F10");
  assert.equal(result.success, false);
  assert.equal(h.bindings.has("voiceAgent"), false);
  assert.deepEqual(h.manager.getSlotHotkeys("voiceAgent"), []);
  assert.deepEqual(h.saved, []);
  assert.deepEqual(broadcasts, []);
});

test("a replacement queued during native clear waits until removal is complete", async () => {
  const h = await setup("translation");
  let finishRemoval;
  h.faults.removeWait = (finish) => {
    finishRemoval = finish;
  };
  const removal = h.manager.unregisterSlot("translation");
  await new Promise(setImmediate);
  let settled = false;
  const replacement = h.manager
    .registerSlot("translation", "F10", () => undefined, { atomic: true, activationMode: "push" })
    .then((result) => {
      settled = true;
      return result;
    });
  await new Promise(setImmediate);
  assert.equal(settled, false);
  assert.deepEqual(h.operations, ["remove"]);
  h.faults.removeWait = null;
  finishRemoval();
  assert.equal(await removal, true);
  assert.equal((await replacement).success, true);
  assert.equal(h.bindings.get("translation"), KDEShortcutManager.convertToQtKeyCode("F10"));
  assert.deepEqual(h.manager.getSlotHotkeys("translation"), ["F10"]);
});

test("KDE validates the applied primary key without rejecting ignored conflicting secondary keys", async () => {
  const h = await setup("translation");
  const result = await h.manager.registerSlot("translation", "F10,F8", () => undefined, {
    atomic: true,
    activationMode: "push",
  });
  assert.equal(result.success, true);
  assert.equal(result.hotkey, "F10");
  assert.deepEqual(h.manager.getSlotHotkeys("translation"), ["F10"]);
  assert.equal(h.bindings.get("translation"), KDEShortcutManager.convertToQtKeyCode("F10"));
});

function useMac(t) {
  const previous = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  t.after(() => Object.defineProperty(process, "platform", previous));
}

for (const slotName of ["voiceAgent", "translation"]) {
  for (const hotkey of ["MediaPlayPause", "F24", "F9,MediaPlayPause"]) {
    test(`${slotName}: macOS ${hotkey} settles the entire replacement to working Tap`, async (t) => {
      useMac(t);
      const h = await setup(slotName, "F9", "push", { backend: "global" });
      assert.deepEqual(h.manager.getMacNativeListenerConfig([slotName]).watchKeys, ["F9"]);
      assert.equal((await h.update(hotkey)).success, true);
      const keys = hotkey.split(",");
      assert.deepEqual(h.manager.getSlotHotkeys(slotName), keys);
      assert.equal(h.manager.getSlotActivationMode(slotName), "tap");
      assert.equal(h.windowManager.getSlotActivationMode(slotName), "tap");
      assert.deepEqual(h.manager.getMacNativeListenerConfig([slotName]).watchKeys, []);
      assert.deepEqual([...electronRegistrations.keys()], keys);
      assert.deepEqual(h.saved, [
        [`${slotName}Key`, hotkey],
        [slotName, "tap"],
      ]);
      assert.deepEqual(broadcasts, [{ key: `${slotName}ActivationMode`, value: "tap" }]);
      assert.deepEqual(h.notifications, [hotkey]);
      await electronRegistrations.get(keys.at(-1))();
      assert.deepEqual(h.actions, [
        slotName === "voiceAgent" ? "toggle-voice-agent" : "toggle-translation",
      ]);
    });
  }

  test(`${slotName}: a refused macOS Tap replacement preserves the working Hold callback`, async (t) => {
    useMac(t);
    const h = await setup(slotName, "Command+Period", "push", { backend: "global" });
    refusedAccelerators.add("MediaPlayPause");
    const previousCallback = h.manager.slots.get(slotName).callback;
    assert.equal((await h.update("MediaPlayPause")).success, false);
    assert.deepEqual(h.manager.getSlotHotkeys(slotName), ["Command+Period"]);
    assert.equal(h.manager.getSlotActivationMode(slotName), "push");
    assert.equal(h.windowManager.getSlotActivationMode(slotName), "push");
    assert.equal(h.manager.slots.get(slotName).callback, previousCallback);
    assert.deepEqual(h.manager.getMacNativeListenerConfig([slotName]).watchKeys, []);
    assert.deepEqual([...electronRegistrations.keys()], ["Command+Period"]);
    assert.deepEqual(h.saved, []);
    assert.deepEqual(broadcasts, []);
    assert.deepEqual(h.notifications, []);
    await electronRegistrations.get("Command+Period")();
    assert.deepEqual(h.actions, [
      ["hold", "Command+Period", slotName === "voiceAgent" ? "assistant" : "translation"],
    ]);
  });
}

for (const storage of ["env", "localStorage"]) {
  for (const hotkey of ["MediaPlayPause", "F24", "F9,MediaPlayPause"]) {
    test(`macOS startup retains ${storage} ${hotkey} and selects Tap before registration`, async (t) => {
      useMac(t);
      const previousKey = process.env.DICTATION_KEY;
      t.after(() => {
        if (previousKey === undefined) delete process.env.DICTATION_KEY;
        else process.env.DICTATION_KEY = previousKey;
      });
      if (storage === "env") process.env.DICTATION_KEY = hotkey;
      else delete process.env.DICTATION_KEY;
      electronRegistrations.clear();
      refusedAccelerators.clear();
      registrationEvents.length = 0;
      const manager = new HotkeyManager();
      manager.activationMode = "push";
      const persistedKeys = [];
      manager._persistHotkeyToEnvFile = async (key) => persistedKeys.push(key);
      const actions = [];
      const windowManager = {
        hotkeyManager: manager,
        _cachedActivationMode: "push",
        isDictationProcessing: () => false,
        getSlotActivationMode: WindowManager.prototype.getSlotActivationMode,
        _sendDictationToggle: (channel) => actions.push(channel),
      };
      manager.on("dictation-activation-mode-settled", (mode) => {
        registrationEvents.push(["mode", mode]);
        windowManager._cachedActivationMode = mode;
      });
      const mainWindow = {
        isDestroyed: () => false,
        webContents: {
          isLoading: () => false,
          executeJavaScript: async () => hotkey,
          send: () => undefined,
        },
      };
      await manager.initializeHotkey(
        mainWindow,
        WindowManager.prototype.createHotkeyCallback.call(windowManager)
      );
      const keys = hotkey.split(",");
      assert.deepEqual(manager.getSlotHotkeys("dictation"), keys);
      assert.equal(manager.getSlotActivationMode("dictation"), "tap");
      assert.equal(windowManager.getSlotActivationMode("dictation"), "tap");
      assert.deepEqual(manager.getMacNativeListenerConfig(["dictation"]).watchKeys, []);
      assert.deepEqual(registrationEvents, [
        ["mode", "tap"],
        ...keys.map((key) => ["register", key]),
      ]);
      assert.deepEqual(persistedKeys, storage === "localStorage" ? [hotkey] : []);
      await electronRegistrations.get(keys.at(-1))();
      assert.deepEqual(actions, ["toggle-dictation"]);
    });
  }
}
