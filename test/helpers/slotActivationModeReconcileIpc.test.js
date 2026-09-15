const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// reconcileSlotActivationMode (ipcHandlers.js) has no export of its own — it
// is a closure reached only through the update-voice-agent-hotkey and
// update-translation-hotkey IPC handlers, registered by the same
// setupHandlers() pass hotkeyModeInfoIpc.test.js already drives. Same stub
// seam: fake "electron" via Module._load, capture every ipcMain.handle
// registration into a Map, then call the captured handler functions
// directly with fake IPC args.

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;

const handlers = new Map();
const broadcasts = [];

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

// A minimal, faithful stand-in for windowManager's real
// getSlotActivationMode/setSlotActivationModeCache contract: the cache only
// moves on a truthy verdict, exactly like the real GNOME-portal-backed
// implementation exercised in hotkeyActivationMode.test.js's "verifies
// Hold ... rolls back on failure" test. `accept: false` lets a case simulate
// the portal refusing the requested mode, the way it does there.
function makeSlotModeState(initialMode, { accept = true } = {}) {
  let mode = initialMode;
  const setCalls = [];
  return {
    setCalls,
    getSlotActivationMode: () => mode,
    setSlotActivationModeCache: async (_slotName, requestedMode) => {
      setCalls.push(requestedMode);
      if (!accept) return false;
      mode = requestedMode;
      return true;
    },
  };
}

let IPCHandlers;
let Ctor;
test.before(() => {
  delete require.cache[handlersModulePath];
  IPCHandlers = require(handlersModulePath);
  Ctor = IPCHandlers.default || IPCHandlers;
});

test.after(() => {
  Module._load = originalLoad;
});

// Builds a fresh fake `this`, registers every handler against it (fresh
// closures over this exact fake), and hands back the two handlers under
// test plus the capture arrays a case asserts on.
function setup({ slotState, slotHotkey, canHold, registerResult }) {
  broadcasts.length = 0;
  const savedSlotModes = [];
  const savedVoiceAgentKeys = [];
  const savedTranslationKeys = [];

  const hotkeyManager = new Proxy(
    {
      getSlotHotkey: () => slotHotkey,
      supportsPushToTalk: () => canHold,
      registerSlot: async () => registerResult,
      unregisterSlot: () => undefined,
    },
    { get: (t, prop) => (prop in t ? t[prop] : anything()) }
  );

  const windowManager = new Proxy(
    {
      hotkeyManager,
      _voiceAgentHotkeyCallback: () => undefined,
      _translationHotkeyCallback: () => undefined,
      getSlotActivationMode: slotState.getSlotActivationMode,
      setSlotActivationModeCache: slotState.setSlotActivationModeCache,
      reconcileNativeKeyListeners: () => undefined,
      isUsingNativeShortcutHotkeys: () => false,
      isUsingGnomeHotkeys: () => false,
      isUsingHyprlandHotkeys: () => false,
      isUsingKDEHotkeys: () => false,
    },
    { get: (t, prop) => (prop in t ? t[prop] : anything()) }
  );

  const environmentManager = new Proxy(
    {
      saveSlotActivationMode: (slotName, mode) => savedSlotModes.push([slotName, mode]),
      saveVoiceAgentKey: (key) => savedVoiceAgentKeys.push(key),
      saveTranslationKey: (key) => savedTranslationKeys.push(key),
    },
    { get: (t, prop) => (prop in t ? t[prop] : anything()) }
  );

  const target = { windowManager, environmentManager, linuxKeyManager: null };
  const fakeThis = new Proxy(target, {
    get: (t, prop) => (prop in t ? t[prop] : anything()),
  });

  Ctor.prototype.setupHandlers.call(fakeThis);
  const voiceAgentHandler = handlers.get("update-voice-agent-hotkey");
  const translationHandler = handlers.get("update-translation-hotkey");
  assert.ok(voiceAgentHandler, "update-voice-agent-hotkey must be registered");
  assert.ok(translationHandler, "update-translation-hotkey must be registered");

  return {
    voiceAgentHandler,
    translationHandler,
    savedSlotModes,
    savedVoiceAgentKeys,
    savedTranslationKeys,
  };
}

test("a slot on Tap whose new hotkey can Hold is promoted to push; env and broadcast agree", async () => {
  const slotState = makeSlotModeState("tap");
  const { voiceAgentHandler, savedSlotModes } = setup({
    slotState,
    slotHotkey: "F9",
    canHold: true,
    registerResult: { success: true },
  });

  const result = await voiceAgentHandler({ sender: {} }, "F9");

  assert.equal(result.success, true);
  assert.deepEqual(slotState.setCalls, ["push"]);
  assert.deepEqual(savedSlotModes, [["voiceAgent", "push"]]);
  assert.deepEqual(broadcasts, [{ key: "voiceAgentActivationMode", value: "push" }]);
});

test("a slot on Hold whose new hotkey cannot Hold is demoted to tap", async () => {
  const slotState = makeSlotModeState("push");
  const { voiceAgentHandler, savedSlotModes } = setup({
    slotState,
    slotHotkey: "F13",
    canHold: false,
    registerResult: { success: true },
  });

  const result = await voiceAgentHandler({ sender: {} }, "F13");

  assert.equal(result.success, true);
  assert.deepEqual(slotState.setCalls, ["tap"]);
  assert.deepEqual(savedSlotModes, [["voiceAgent", "tap"]]);
  assert.deepEqual(broadcasts, [{ key: "voiceAgentActivationMode", value: "tap" }]);
});

test("a slot with no hotkey bound resolves to tap (fail-closed), via the clear path", async () => {
  const slotState = makeSlotModeState("push");
  const { translationHandler, savedSlotModes, savedTranslationKeys } = setup({
    slotState,
    slotHotkey: undefined, // getSlotHotkey reads "unbound" post-unregister
    canHold: true, // must not matter: hotkey is falsy, so this is never consulted
    registerResult: undefined, // the clear branch never calls registerSlot
  });

  const result = await translationHandler({ sender: {} }, "");

  assert.equal(result.success, true);
  assert.deepEqual(savedTranslationKeys, [""]);
  assert.deepEqual(slotState.setCalls, ["tap"]);
  assert.deepEqual(savedSlotModes, [["translation", "tap"]]);
  assert.deepEqual(broadcasts, [{ key: "translationActivationMode", value: "tap" }]);
});

test("a slot already at the preferred mode is left alone: no persist, no broadcast", async () => {
  const slotState = makeSlotModeState("push");
  const { voiceAgentHandler, savedSlotModes } = setup({
    slotState,
    slotHotkey: "F9",
    canHold: true,
    registerResult: { success: true },
  });

  const result = await voiceAgentHandler({ sender: {} }, "F9");

  assert.equal(result.success, true);
  // The early return fires before the cache setter is ever called.
  assert.deepEqual(slotState.setCalls, []);
  assert.deepEqual(savedSlotModes, []);
  assert.deepEqual(broadcasts, []);
});

test("a refused cache write persists and broadcasts the effective read-back, never the attempted mode", async () => {
  // Mirrors the GNOME-portal rollback in hotkeyActivationMode.test.js: the
  // manager refuses "push", so the cache — and everything downstream of it —
  // must stay on "tap". A regression that persisted/broadcast the attempted
  // `preferred` value instead of the `effective` read-back would report
  // "push" here and this assertion would catch it.
  const slotState = makeSlotModeState("tap", { accept: false });
  const { voiceAgentHandler, savedSlotModes } = setup({
    slotState,
    slotHotkey: "F9",
    canHold: true,
    registerResult: { success: true },
  });

  const result = await voiceAgentHandler({ sender: {} }, "F9");

  assert.equal(result.success, true);
  // The attempt was for "push" ...
  assert.deepEqual(slotState.setCalls, ["push"]);
  // ... but the portal refused it, so "tap" is what actually landed, and
  // "tap" — never "push" — is what gets persisted and broadcast.
  assert.deepEqual(savedSlotModes, [["voiceAgent", "tap"]]);
  assert.deepEqual(broadcasts, [{ key: "voiceAgentActivationMode", value: "tap" }]);
});
