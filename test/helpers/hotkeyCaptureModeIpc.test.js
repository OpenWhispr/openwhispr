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
});

test.after(() => {
  Module._load = originalLoad;
});

function kdeBackend(slots) {
  const kde = {
    registeredSlots: new Set(slots),
    unregistered: [],
    registered: [],
    async unregisterKeybinding(slot) {
      this.unregistered.push(slot);
      this.registeredSlots.delete(slot);
    },
    async registerKeybinding(hotkey, slot) {
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
