const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// The get-hotkey-mode-info handler is what the Settings ActivationModeSelector
// rows actually read: hotkeyManager.supportsPushToTalk being honest is not
// enough if the IPC never routes its answer to the renderer.

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
    handle: (channel, fn) => handlers.set(channel, fn),
    on: () => {},
    removeHandler: () => {},
  },
  net: { fetch: async () => ({ ok: true, json: async () => ({}) }) },
  BrowserWindow: class BrowserWindow {
    static getAllWindows() {
      return [];
    }
    static fromWebContents() {
      return null;
    }
  },
  globalShortcut: {
    register: () => true,
    unregister: () => undefined,
    isRegistered: () => false,
    unregisterAll: () => undefined,
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

// Registration only stores closures, so every manager the mode-info handler
// does not touch can be an inert stub (same pattern as
// retryTranscriptionHandler.test.js).
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

function buildFakeThis(hotkeyManager) {
  const windowManager = new Proxy(
    {
      hotkeyManager,
      isUsingNativeShortcutHotkeys: () => hotkeyManager.isUsingNativeShortcut(),
      isUsingGnomeHotkeys: () => false,
      isUsingHyprlandHotkeys: () => false,
      isUsingKDEHotkeys: () => false,
    },
    { get: (t, prop) => (prop in t ? t[prop] : anything()) }
  );
  const target = { windowManager, linuxKeyManager: null };
  return new Proxy(target, {
    get: (t, prop) => (prop in t ? t[prop] : anything()),
  });
}

let modeInfoHandler;
let HotkeyManager;
test.before(() => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  HotkeyManager = require("../../src/helpers/hotkeyManager");
  Ctor.prototype.setupHandlers.call(buildFakeThis(new HotkeyManager()));
  modeInfoHandler = handlers.get("get-hotkey-mode-info");
  assert.ok(modeInfoHandler, "get-hotkey-mode-info must be registered");
});

test.after(() => {
  Module._load = originalLoad;
});

const withPlatform = async (platform, fn) => {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
};

test("macOS mode info reports a plain single key as Hold-incapable, with a reason", async () => {
  await withPlatform("darwin", async () => {
    const info = await modeInfoHandler({ sender: {} }, "F13", "dictation");
    assert.equal(info.supportsPushToTalk, false);
    assert.equal(typeof info.pushToTalkUnavailableReason, "string");

    const slotInfo = await modeInfoHandler({ sender: {} }, "F13", "voiceAgent");
    assert.equal(slotInfo.supportsPushToTalk, false);
  });
});

test("macOS mode info keeps Hold available for hotkeys with release detection", async () => {
  await withPlatform("darwin", async () => {
    for (const hotkey of ["Command+Period", "GLOBE", "RightOption", "MouseButton4"]) {
      const info = await modeInfoHandler({ sender: {} }, hotkey, "dictation");
      assert.equal(info.supportsPushToTalk, true, `${hotkey} should support Hold`);
      assert.equal(info.pushToTalkUnavailableReason, null);
    }
  });
});

test("Windows mode info keeps every regular hotkey Hold-capable", async () => {
  await withPlatform("win32", async () => {
    for (const [hotkey, slot] of [
      ["F13", "dictation"],
      ["F9", "voiceAgent"],
      ["Control+Shift+T", "translation"],
    ]) {
      const info = await modeInfoHandler({ sender: {} }, hotkey, slot);
      assert.equal(info.supportsPushToTalk, true, `${hotkey}/${slot} should support Hold`);
    }
  });
});
