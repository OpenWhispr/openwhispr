const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;
const handlers = new Map();

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
    handle: (channel, handler) => handlers.set(channel, handler),
    on: () => {},
    emit: () => {},
    removeHandler: () => {},
  },
  net: { fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) },
  BrowserWindow: class BrowserWindow {
    static getAllWindows() {
      return [];
    }

    static fromWebContents() {
      return null;
    }
  },
  shell: {},
  dialog: {},
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
  session: { fromPartition: () => ({}) },
  clipboard: {},
  nativeImage: {},
  globalShortcut: { unregister: () => {}, isRegistered: () => true },
  utilityProcess: {},
  MessageChannelMain: class {},
};

Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (
    parent?.filename === handlersModulePath &&
    (request.startsWith("./") || request.startsWith("../"))
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

const HotkeyManager = require("../../src/helpers/hotkeyManager");

let hotkeyManager;
let setListeningMode;
let updateHotkey;

test.before(() => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const target = {
    windowManager: {
      get hotkeyManager() {
        return hotkeyManager;
      },
      controlPanelWindow: null,
      setHotkeyListeningMode: () => {},
      createHotkeyCallback: () => () => {},
      reconcileNativeKeyListeners: () => {},
      getActivationMode: () => "tap",
      updateHotkey: (hotkey) => hotkeyManager.updateHotkey(hotkey, () => {}),
    },
  };
  const ipc = new Proxy(target, {
    get: (value, property) => (property in value ? value[property] : anything()),
    set: (value, property, next) => {
      value[property] = next;
      return true;
    },
  });
  IPCHandlers.prototype.setupHandlers.call(ipc);
  setListeningMode = (enabled) =>
    handlers.get("set-hotkey-listening-mode")({ sender: {} }, enabled);
  updateHotkey = (hotkey) => handlers.get("update-hotkey")({ sender: {} }, hotkey);
});

test.after(() => {
  Module._load = originalLoad;
});

// Each kglobalaccel round trip yields to the event loop, as the D-Bus calls do.
const roundTrip = () => new Promise((resolve) => setImmediate(resolve));

function kdeBackend(slots) {
  const kde = {
    registeredSlots: new Set(slots),
    bound: {},
    unregistered: [],
    registered: [],
    async unregisterKeybinding(slot) {
      await roundTrip();
      this.unregistered.push(slot);
      this.registeredSlots.delete(slot);
      delete this.bound[slot];
    },
    // setShortcut answers with the key the action holds once the call lands, so
    // a second registration landing in between reads as a conflict, as it did live.
    async registerKeybinding(hotkey, slot) {
      await roundTrip();
      this.bound[slot] = hotkey;
      await roundTrip();
      if (this.bound[slot] !== hotkey) return "conflict";
      this.registered.push([slot, hotkey]);
      this.registeredSlots.add(slot);
      return true;
    },
  };
  hotkeyManager = Object.assign(new HotkeyManager(), {
    isInitialized: true,
    useKDE: true,
    kdeManager: kde,
    currentHotkey: "Control+Super",
    saveHotkeyToRenderer: async () => true,
    notifyActiveHotkey: () => {},
  });
  hotkeyManager.slots.set("voiceAgent", {
    hotkeys: ["Control+Alt+Space"],
    callback: () => {},
    accelerators: [],
  });
  return kde;
}

// While the hotkey field records, KWin would otherwise take a registered chord
// such as Ctrl+Meta for OpenWhispr itself, and the field would see only Ctrl.
test("hotkey capture on KDE releases every KDE binding and restores them after", async () => {
  const kde = kdeBackend(["dictation", "voiceAgent"]);

  await setListeningMode(true);
  assert.deepEqual(kde.unregistered, ["dictation", "voiceAgent"]);
  assert.equal(kde.registeredSlots.size, 0);

  await setListeningMode(false);
  assert.deepEqual(kde.registered, [
    ["dictation", "Control+Super"],
    ["voiceAgent", "Control+Alt+Space"],
  ]);
});

// The field sends the new hotkey and then leaves capture mode without waiting,
// so leaving capture must not re-register the old hotkey over the new one.
// Which one lands first depends on timing, so try the exit at several delays.
test("a hotkey picked in the field stays bound after capture mode ends", async () => {
  for (let delay = 0; delay <= 4; delay++) {
    const kde = kdeBackend(["dictation"]);
    hotkeyManager.currentHotkey = "Control+Alt";
    await setListeningMode(true);

    const leaveCapture = async () => {
      for (let i = 0; i < delay; i++) await roundTrip();
      await setListeningMode(false);
    };
    await Promise.all([updateHotkey("Control+Super"), leaveCapture()]);

    assert.equal(hotkeyManager.currentHotkey, "Control+Super", `exit delayed ${delay}`);
    assert.equal(kde.bound.dictation, "Control+Super", `exit delayed ${delay}`);
  }
});

test("a hotkey change that fails does not hold up the next one", async () => {
  kdeBackend([]);
  const failed = hotkeyManager.runExclusive(async () => {
    throw new Error("D-Bus went away");
  });
  await assert.rejects(failed, /D-Bus went away/);
  assert.equal(await hotkeyManager.runExclusive(async () => "next"), "next");
});

test("a hotkey change that never settles stops blocking the next one", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  kdeBackend([]);
  hotkeyManager.runExclusive(() => new Promise(() => {}));
  let ran = false;
  const next = hotkeyManager.runExclusive(async () => {
    ran = true;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ran, false);
  t.mock.timers.tick(10000);
  await next;
  assert.equal(ran, true);
});

test("every hotkey field's change runs in the same queue as capture mode", async () => {
  kdeBackend([]);
  const queued = [];
  const runExclusive = hotkeyManager.runExclusive.bind(hotkeyManager);
  hotkeyManager.runExclusive = (task) => {
    queued.push(task);
    return runExclusive(task);
  };

  for (const channel of [
    "update-hotkey",
    "update-voice-agent-hotkey",
    "update-translation-hotkey",
    "set-hotkey-listening-mode",
  ]) {
    const before = queued.length;
    await handlers.get(channel)({ sender: {} }, channel === "set-hotkey-listening-mode");
    assert.equal(queued.length, before + 1, channel);
  }
});
