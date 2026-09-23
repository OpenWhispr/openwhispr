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
  globalShortcut: {},
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

// A real HotkeyManager answers for Hold; only its backend and the listener
// probe are faked.
const HotkeyManager = require("../../src/helpers/hotkeyManager");

const inputDenied = () => ({ available: false, reason: "input_access_denied" });
let hotkeyManager;

test.before(() => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const target = {
    windowManager: {
      get hotkeyManager() {
        return hotkeyManager;
      },
      isUsingGnomeHotkeys: () => hotkeyManager.isUsingGnome(),
      isUsingHyprlandHotkeys: () => hotkeyManager.isUsingHyprland(),
      isUsingKDEHotkeys: () => hotkeyManager.isUsingKDE(),
      isUsingNativeShortcutHotkeys: () => hotkeyManager.isUsingNativeShortcut(),
    },
    linuxKeyManager: { checkAvailability: inputDenied },
  };
  IPCHandlers.prototype.setupHandlers.call(
    new Proxy(target, {
      get: (value, property) => (property in value ? value[property] : anything()),
    })
  );
});

test.after(() => {
  Module._load = originalLoad;
});

// The handler decides everything before its first await, so the patched
// platform covers the whole answer.
function hotkeyModeInfo(backend) {
  hotkeyManager = Object.assign(new HotkeyManager(), {
    isInitialized: true,
    nativeListenerProbe: inputDenied,
    ...backend,
  });
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  try {
    return handlers.get("get-hotkey-mode-info")({}, "F8");
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

// GNOME (portal), KDE and Hyprland deliver press and release themselves, so a
// user without /dev/input access can still hold, and the setup box would send
// them to run sudo for nothing.
const DESKTOP_BACKENDS = {
  GNOME: { useGnome: true, gnomeManager: { supportsPushToTalk: () => true } },
  KDE: { useKDE: true },
  Hyprland: { useHyprland: true },
};

for (const [desktop, backend] of Object.entries(DESKTOP_BACKENDS)) {
  test(`${desktop} holds without the evdev listener, so no input setup is shown`, async () => {
    const info = await hotkeyModeInfo(backend);

    assert.equal(info.supportsPushToTalk, true);
    assert.equal(info.linuxInputAccessDenied, false);
  });
}

test("without a desktop backend, denied input access reaches the renderer", async () => {
  const info = await hotkeyModeInfo({});

  assert.equal(info.supportsPushToTalk, false);
  assert.equal(info.linuxInputAccessDenied, true);
  assert.match(info.pushToTalkUnavailableReason, /usermod/);
});
