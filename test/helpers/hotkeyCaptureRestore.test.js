const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// Capture mode releases every shortcut so the field can read raw keys, then
// puts them back when the field closes — including when the user cancels and
// nothing changed. The desktop restores used to re-bind ONE hotkey, so a
// second or third dictation row never came back while the slot (and the UI)
// still advertised it. This runs the real IPC handler against a real
// HotkeyManager, with only the desktop boundary faked.

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const handlers = new Map();

const electronStub = {
  app: { getPath: () => "/tmp", on: () => {}, isPackaged: false },
  ipcMain: {
    handle: (channel, handler) => handlers.set(channel, handler),
    on: () => {},
    emit: () => {},
    removeHandler: () => {},
  },
  globalShortcut: {
    register: () => true,
    unregister: () => {},
    isRegistered: () => false,
    unregisterAll: () => {},
  },
  BrowserWindow: class BrowserWindow {
    static getAllWindows() {
      return [];
    }

    static fromWebContents() {
      return null;
    }
  },
  net: { fetch: async () => ({ ok: true }) },
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

const REAL_HELPERS = new Set([
  "./hotkeyList",
  "./hotkeyCanonical",
  "./hotkeyBindingId",
  "./dictationHotkeyConfig",
  "./hotkeyManager",
]);

const originalLoad = Module._load;
Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "electron") return electronStub;
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

const HotkeyManager = require("../../src/helpers/hotkeyManager");

test.after(() => {
  Module._load = originalLoad;
});

// A GNOME desktop that records what it currently holds. `refuse` lets a test
// make one binding unrestorable.
function gnomeDesktop({ refuse = () => false } = {}) {
  const active = new Map();
  // The real manager's registeredSlots is keyed by BINDING ID — the id each
  // row registered under, not the slot name — and capture-enter walks it to
  // release what the desktop holds.
  const registeredSlots = new Set();
  return {
    active,
    manager: {
      registeredSlots,
      setBindingCallback() {},
      clearBindingCallback() {},
      async unregisterPushToTalk() {
        return true;
      },
      async unregisterKeybinding(bindingId) {
        if (bindingId) {
          active.delete(bindingId);
          registeredSlots.delete(bindingId);
        } else {
          active.clear();
          registeredSlots.clear();
        }
        return true;
      },
      async registerKeybinding(hotkey, bindingId) {
        if (refuse(bindingId)) return false;
        active.set(bindingId, hotkey);
        registeredSlots.add(bindingId);
        return true;
      },
    },
  };
}

// KDE is the one backend whose manager used to answer nothing at all. Its
// stand-in therefore answers exactly as the real one now does: true only when
// KGlobalAccel confirmed, false when it refused, with the bookkeeping kept.
function kdeDesktop({ refuse = () => false } = {}) {
  const active = new Map();
  const registeredSlots = new Set();
  return {
    active,
    manager: {
      registeredSlots,
      async unregisterKeybinding(bindingId) {
        active.delete(bindingId);
        registeredSlots.delete(bindingId);
        return true;
      },
      async registerKeybinding(hotkey, bindingId) {
        if (refuse(bindingId)) return false;
        active.set(bindingId, hotkey);
        registeredSlots.add(bindingId);
        return true;
      },
    },
  };
}

function fixture({ refuse, refuseRelease = false, holdRelease = false, backend = "gnome" } = {}) {
  handlers.clear();
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);

  const desktop = backend === "kde" ? kdeDesktop({ refuse }) : gnomeDesktop({ refuse });
  if (refuseRelease) {
    desktop.manager.unregisterKeybinding = async () => false;
    if (desktop.manager.unregisterPushToTalk) {
      desktop.manager.unregisterPushToTalk = async () => false;
    }
  }
  // Holds the teardown open — whatever it does — so a second focus can arrive
  // while the first one is still running.
  let releaseTeardown = () => {};
  if (holdRelease) {
    const barrier = new Promise((resolve) => {
      releaseTeardown = resolve;
    });
    const held = desktop.manager.unregisterKeybinding;
    desktop.manager.unregisterKeybinding = async (bindingId) => {
      await barrier;
      return held.call(desktop.manager, bindingId);
    };
  }
  const hotkeyManager = new HotkeyManager();
  hotkeyManager.activationMode = "tap";
  if (backend === "kde") {
    hotkeyManager.useKDE = true;
    hotkeyManager.kdeManager = desktop.manager;
  } else {
    hotkeyManager.useGnome = true;
    hotkeyManager.gnomeManager = desktop.manager;
  }

  const dictationCallback = () => {};
  hotkeyManager.slots.set("dictation", {
    hotkeys: ["Control+F8", "Control+F9"],
    accelerators: [],
    bindingIds: ["dictation", "dictation#1"],
    generation: 1,
    callback: dictationCallback,
  });
  for (const [bindingId, shortcut] of backend === "kde"
    ? [
        ["dictation", "Control+F8"],
        ["dictation#1", "Control+F9"],
      ]
    : [
        ["dictation", "<Control>F8"],
        ["dictation#1", "<Control>F9"],
      ]) {
    desktop.active.set(bindingId, shortcut);
    desktop.manager.registeredSlots.add(bindingId);
  }

  let dictationRows = [{ key: "Control+F8", mode: null }];
  const windowManager = {
    hotkeyManager,
    controlPanelWindow: {},
    setHotkeyListeningMode: (enabled) => hotkeyManager.setListeningMode(enabled),
    createHotkeyCallback: () => () => {},
    reconcileNativeKeyListeners: () => {},
    getActivationMode: () => "tap",
    isUsingNativeShortcutHotkeys: () => true,
    getDictationRows: () => dictationRows,
    setDictationRows: (rows) => {
      dictationRows = rows;
    },
    getDictationOwner: () => null,
    setHotkeyCommitInFlight: () => {},
    updateHotkey: (keys, options) =>
      hotkeyManager.updateHotkey(keys, windowManager.createHotkeyCallback(), options),
  };

  const broadcasts = [];
  // Built on the real prototype, so the queue that serializes capture against
  // row commits is the real one rather than a test stand-in.
  const target = Object.assign(Object.create(IPCHandlers.prototype), {
    windowManager,
    environmentManager: {
      getActivationMode: () => "tap",
      getDictationHotkeyConfig: () => "",
      saveStagedKeys: async () => ({ success: true }),
      constructor: { encodeDictationHotkeyConfig: (value) => value },
    },
    _notifyHotkeyCaptureFailed: (phase) => broadcasts.push(phase),
    _dictationCommitQueue: null,
    _hotkeyCaptureMode: false,
    _hotkeyCaptureRequest: null,
    _hotkeyCaptureToken: 0,
  });
  IPCHandlers.prototype.setupHandlers.call(
    new Proxy(target, {
      get: (value, property) => (property in value ? value[property] : anything()),
      set: (value, property, next) => {
        value[property] = next;
        return true;
      },
    })
  );

  const capture = handlers.get("set-hotkey-listening-mode");
  assert.ok(capture, "the capture handler registered");
  return {
    desktop,
    hotkeyManager,
    broadcasts,
    handlers,
    releaseTeardown: () => releaseTeardown(),
    enter: () => capture({ sender: {} }, true),
    leave: () => capture({ sender: {} }, false),
  };
}

test("every dictation row comes back after a cancelled capture, not just the first", async () => {
  const f = fixture();

  assert.deepEqual(await f.enter(), { success: true });
  assert.deepEqual([...f.desktop.active.keys()], [], "capture releases every row");

  const left = await f.leave();

  assert.deepEqual(left, { success: true });
  assert.deepEqual(
    [...f.desktop.active.entries()],
    [
      ["dictation", "<Control>F8"],
      ["dictation#1", "<Control>F9"],
    ],
    "both rows are bound again, each under its own binding id"
  );
  // What the slot advertises now matches what the desktop holds.
  assert.deepEqual(f.hotkeyManager.getSlotHotkeys("dictation"), ["Control+F8", "Control+F9"]);
});

test("the restored rows keep their own identity on dispatch", async () => {
  const f = fixture();
  const fired = [];
  f.hotkeyManager.slots.get("dictation").callback = (hotkey, phase) => fired.push([hotkey, phase]);
  f.hotkeyManager.gnomeManager.setBindingCallback = (bindingId, callback) => {
    f.hotkeyManager.gnomeManager[`cb:${bindingId}`] = callback;
  };

  await f.enter();
  await f.leave();

  // The second row's binding must dispatch as the second row — a restore that
  // re-bound row 0 under every id would report Control+F8 here.
  f.hotkeyManager.gnomeManager["cb:dictation#1"]("dictation#1", "down");
  assert.deepEqual(fired, [["Control+F9", "down"]]);
});

test("a restore the desktop refuses is reported rather than claimed", async () => {
  const f = fixture({ refuse: (bindingId) => bindingId === "dictation#1" });

  await f.enter();
  const left = await f.leave();

  assert.equal(left.success, false);
  assert.equal(left.reason, "capture_restore_failed");
  assert.equal(left.degraded, true, "the keys may be unclaimed, and the caller is told so");
});

test("a non-dictation slot is restored too", async () => {
  const f = fixture();
  const registeredSlots = [];
  f.hotkeyManager.registerSlot = async (slot, hotkeys) => {
    registeredSlots.push([slot, hotkeys]);
    return { success: true };
  };
  f.hotkeyManager.slots.set("meeting", {
    hotkeys: ["Control+Shift+M"],
    accelerators: [],
    bindingIds: ["meeting"],
    generation: 1,
    callback: () => {},
  });

  await f.enter();
  await f.leave();

  assert.deepEqual(registeredSlots, [
    ["dictation", ["Control+F8", "Control+F9"]],
    ["meeting", ["Control+Shift+M"]],
  ]);
});

// The native layer reports an unconfirmed rollback as degraded. Every wrapper
// above it has to carry that, or the renderer presents the previous shortcuts
// as known-good while the desktop may hold neither set.
test("an uncertain rollback is still uncertain at the update boundary", async () => {
  const f = fixture();
  const manager = f.hotkeyManager;
  // The desktop refuses both the new row AND the restore of the old one.
  manager.gnomeManager.registerKeybinding = async (_hotkey, bindingId) => bindingId === "nothing";

  const result = await manager.updateHotkey(["Control+F8", "Control+F10"], () => {}, {
    publish: false,
  });

  assert.equal(result.success, false);
  assert.equal(result.degraded, true);
});

// A shortcut the desktop will not give up keeps firing while the field is
// open: the next keystroke starts a recording instead of being recorded. The
// enter has to refuse, and the field has to stop capturing.
test("a capture the desktop will not allow is refused rather than entered", async () => {
  const f = fixture({ refuseRelease: true });

  const enter = await f.enter();

  assert.equal(enter.success, false);
  assert.equal(enter.reason, "capture_release_failed");
  assert.equal(enter.degraded, true);
  assert.deepEqual(f.broadcasts, ["release"], "a surface outside the field is told too");
  // Listening mode is dropped again, so dictation is not left deaf.
  assert.equal(f.hotkeyManager.isInListeningMode(), false);
  assert.deepEqual(
    [...f.desktop.active.keys()],
    ["dictation", "dictation#1"],
    "the shortcuts the desktop kept are still described as active"
  );
});

test("a slot other than dictation failing to restore is reported too", async () => {
  const f = fixture();
  f.hotkeyManager.slots.set("meeting", {
    hotkeys: ["Control+F10"],
    accelerators: [],
    bindingIds: ["meeting"],
    generation: 1,
    callback: () => {},
  });
  const realRegisterSlot = f.hotkeyManager.registerSlot.bind(f.hotkeyManager);
  f.hotkeyManager.registerSlot = async (slot, hotkeys, callback) =>
    slot === "meeting"
      ? { success: false, error: "Control+F10 is taken" }
      : realRegisterSlot(slot, hotkeys, callback);

  await f.enter();
  const left = await f.leave();

  assert.equal(left.success, false);
  assert.equal(left.reason, "capture_restore_failed");
  assert.deepEqual(f.broadcasts, ["restore"]);
});

// Capture restore and a row commit both release and re-register the dictation
// slot. Interleaved, one binds a snapshot the other has already replaced.
test("a capture exit and a row commit do not interleave", async () => {
  const f = fixture();
  const order = [];
  const apply = f.handlers.get("apply-dictation-hotkeys");
  assert.ok(apply, "the commit handler registered");

  const realRegisterSlot = f.hotkeyManager.registerSlot.bind(f.hotkeyManager);
  f.hotkeyManager.registerSlot = async (...args) => {
    order.push("restore:start");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const result = await realRegisterSlot(...args);
    order.push("restore:end");
    return result;
  };
  f.hotkeyManager.updateHotkey = async () => {
    order.push("commit:start");
    await new Promise((resolve) => setTimeout(resolve, 5));
    order.push("commit:end");
    return { success: true };
  };

  await f.enter();
  // Both in the same tick, in the order a captured chord produces them: the
  // field commits the new KEY (a mode-only edit re-registers nothing, so it
  // could not interleave), then blurs.
  const commit = apply({}, { rows: [{ key: "Control+F11", mode: "cleaned" }] });
  const leave = f.leave();
  await Promise.all([commit, leave]);

  assert.deepEqual(order, ["commit:start", "commit:end", "restore:start", "restore:end"]);
});

// One focus reaches main through several paths (DOM focus, the Windows
// autofocus handshake, window focus, visibility). A later caller must get the
// first request's real answer, not a "skipped" read off the flag the first one
// had only just set: that told the field the shortcuts were released while the
// teardown was still running, and hid a refusal from it completely.
test("a repeated enter waits for the first one's answer instead of reporting skipped", async () => {
  const f = fixture({ holdRelease: true });

  const first = f.enter();
  await new Promise((resolve) => setImmediate(resolve));
  const duplicate = f.enter();
  // Nothing has been released yet, so no answer may claim otherwise.
  assert.deepEqual([...f.desktop.active.keys()], ["dictation", "dictation#1"]);

  f.releaseTeardown();
  const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);

  assert.deepEqual(firstResult, { success: true });
  assert.equal(duplicateResult, firstResult, "the same answer, not a second teardown");
  assert.deepEqual([...f.desktop.active.keys()], [], "released exactly once");
});

test("a repeated enter inherits a refusal rather than reporting success", async () => {
  const f = fixture({ holdRelease: true, refuseRelease: true });

  const first = f.enter();
  await new Promise((resolve) => setImmediate(resolve));
  const duplicate = f.enter();
  f.releaseTeardown();
  const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);

  assert.equal(firstResult.success, false);
  assert.equal(firstResult.reason, "capture_release_failed");
  assert.equal(duplicateResult, firstResult, "every focus path hears the refusal");
  // And the app is back out of capture mode, once.
  assert.equal(f.hotkeyManager.isInListeningMode(), false);
});

test("a blur during an enter is not collapsed into it", async () => {
  const f = fixture({ holdRelease: true });

  const enter = f.enter();
  await new Promise((resolve) => setImmediate(resolve));
  const leave = f.leave();
  assert.notEqual(enter, leave, "a different requested state is its own transition");
  f.releaseTeardown();

  assert.deepEqual(await enter, { success: true });
  assert.deepEqual(await leave, { success: true });
  // The field closed, so the shortcuts are bound again.
  assert.deepEqual(
    [...f.desktop.active.entries()],
    [
      ["dictation", "<Control>F8"],
      ["dictation#1", "<Control>F9"],
    ]
  );
});

// KDE was the one backend with no capture teardown at all. KGlobalAccel grabs
// the key at the compositor, so an unreleased shortcut does not merely risk a
// stray dispatch — the field never sees the chord, because KGlobalAccel
// swallows it. Suppressing our own callback is not a release.
test("KDE releases every registered action for capture, and restores them after", async () => {
  const f = fixture({ backend: "kde" });

  assert.deepEqual(await f.enter(), { success: true });
  assert.deepEqual([...f.desktop.active.keys()], [], "both KGlobalAccel actions are released");

  const left = await f.leave();

  assert.deepEqual(left, { success: true });
  assert.deepEqual(
    [...f.desktop.active.entries()],
    [
      ["dictation", "Control+F8"],
      ["dictation#1", "Control+F9"],
    ],
    "and both rows are registered again, each under its own binding id"
  );
  assert.deepEqual(f.hotkeyManager.getSlotHotkeys("dictation"), ["Control+F8", "Control+F9"]);
});

test("a KDE capture whose release KGlobalAccel refuses is not entered", async () => {
  const f = fixture({ backend: "kde", refuseRelease: true });

  const enter = await f.enter();

  assert.equal(enter.success, false);
  assert.equal(enter.reason, "capture_release_failed");
  assert.equal(enter.degraded, true);
  assert.deepEqual(f.broadcasts, ["release"]);
  assert.equal(f.hotkeyManager.isInListeningMode(), false);
  assert.deepEqual(
    [...f.desktop.active.keys()],
    ["dictation", "dictation#1"],
    "the actions KGlobalAccel kept are still described as held"
  );
});

// A teardown is rarely all-or-nothing. Whatever DID come free has to go back,
// because the field is not going to open and nothing else would restore it.
test("a partly refused KDE release puts back the row it did release", async () => {
  const f = fixture({ backend: "kde" });
  const realUnregister = f.desktop.manager.unregisterKeybinding.bind(f.desktop.manager);
  f.desktop.manager.unregisterKeybinding = async (bindingId) =>
    bindingId === "dictation#1" ? false : realUnregister(bindingId);

  const enter = await f.enter();

  assert.equal(enter.success, false);
  assert.equal(enter.reason, "capture_release_failed");
  assert.deepEqual(
    [...f.desktop.active.keys()].sort(),
    ["dictation", "dictation#1"],
    "the released row was restored; the refused one was never gone"
  );
});
