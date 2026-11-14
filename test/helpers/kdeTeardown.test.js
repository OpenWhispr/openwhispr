const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// KGlobalAccel grabs a shortcut at the compositor, so "we stopped listening"
// and "the key is free" are different facts. The manager used to return
// nothing at all: every caller — the capture teardown, a row edit, a row
// removal, unregisterSlot — read `undefined` as a confirmed release and
// reported a clean rollback that had not happened, leaving an action
// registered with KGlobalAccel that no row in the UI could remove.
//
// These run the real KDEShortcutManager and the real HotkeyManager, with the
// kglobalaccel D-Bus proxy faked. Nothing here touches this machine.

const originalLoad = Module._load;
Module._load = function loadWithElectronStub(request, parent, isMain) {
  if (request === "electron") {
    return {
      globalShortcut: {
        register: () => true,
        unregister: () => {},
        isRegistered: () => false,
        unregisterAll: () => {},
      },
      BrowserWindow: class {
        static getAllWindows() {
          return [];
        }
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const KDEShortcutManager = require("../../src/helpers/kdeShortcut.js");
const HotkeyManager = require("../../src/helpers/hotkeyManager.js");
const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");

test.after(() => {
  Module._load = originalLoad;
});

// A KGlobalAccel stand-in: `refuse` makes unRegister call back with an error,
// which is what a busy or disagreeing kglobalaccel does.
function kdeManagerWith({ refuse = () => false } = {}) {
  const manager = new KDEShortcutManager();
  const unregistered = [];
  manager.kglobalaccel = {
    unRegister(actionId, callback) {
      const bindingId = actionId[1];
      if (refuse(bindingId)) return callback(new Error("synthetic D-Bus refusal"));
      unregistered.push(bindingId);
      callback(null);
    },
  };
  return { manager, unregistered };
}

test("a confirmed KGlobalAccel release answers true and drops the binding", async () => {
  const { manager, unregistered } = kdeManagerWith();
  manager.registeredSlots.add("dictation#1");
  manager.callbacks.set("dictation#1", () => {});

  assert.equal(await manager.unregisterKeybinding("dictation#1"), true);
  assert.deepEqual(unregistered, ["dictation#1"]);
  assert.equal(manager.registeredSlots.has("dictation#1"), false);
  assert.equal(manager.callbacks.has("dictation#1"), false);
});

test("a refused release answers false and keeps the binding as ours", async () => {
  const { manager } = kdeManagerWith({ refuse: () => true });
  manager.registeredSlots.add("dictation#1");
  manager.callbacks.set("dictation#1", () => {});

  assert.equal(await manager.unregisterKeybinding("dictation#1"), false);
  // Kept deliberately: the compositor may still hold the key, and a later
  // attempt needs to know the binding is there.
  assert.equal(manager.registeredSlots.has("dictation#1"), true);
  assert.equal(manager.callbacks.has("dictation#1"), true);
});

test("with no connection, only a binding we never registered counts as released", async () => {
  const manager = new KDEShortcutManager();
  manager.kglobalaccel = null;
  assert.equal(await manager.unregisterKeybinding("dictation"), true);

  manager.registeredSlots.add("dictation");
  assert.equal(
    await manager.unregisterKeybinding("dictation"),
    false,
    "a lost bus cannot confirm that KGlobalAccel let go"
  );
});

function managerWithKde(kdeManager, { hotkeys, bindingIds }) {
  const hotkeyManager = new HotkeyManager();
  hotkeyManager.useKDE = true;
  hotkeyManager.activationMode = "tap";
  hotkeyManager.kdeManager = kdeManager;
  hotkeyManager.slots.set("dictation", {
    hotkeys,
    accelerators: [],
    bindingIds,
    generation: 1,
    callback: () => {},
  });
  return hotkeyManager;
}

test("an unconfirmed release reaches the manager as a refusal, not as silence", async () => {
  const { manager } = kdeManagerWith({ refuse: (id) => id === "dictation#1" });
  manager.registeredSlots.add("dictation");
  manager.registeredSlots.add("dictation#1");
  const hotkeyManager = managerWithKde(manager, {
    hotkeys: ["Control+F8", "Control+F9"],
    bindingIds: ["dictation", "dictation#1"],
  });

  assert.equal(await hotkeyManager._unregisterBinding("kde", "dictation"), true);
  assert.equal(await hotkeyManager._unregisterBinding("kde", "dictation#1"), false);
  assert.equal(
    await hotkeyManager._releaseBindings("kde", ["dictation", "dictation#1"]),
    false,
    "one refused release makes the whole pass unreleased"
  );
});

// unregisterSlot is its own caller: it used to empty the slot and resolve true
// while both KGlobalAccel actions were still registered.
test("unregisterSlot keeps the slot when KGlobalAccel would not let go", async () => {
  const { manager } = kdeManagerWith({ refuse: (id) => id === "dictation#1" });
  manager.registeredSlots.add("dictation");
  manager.registeredSlots.add("dictation#1");
  const hotkeyManager = managerWithKde(manager, {
    hotkeys: ["Control+F8", "Control+F9"],
    bindingIds: ["dictation", "dictation#1"],
  });

  assert.equal(await hotkeyManager.unregisterSlot("dictation"), false);
  assert.deepEqual(
    hotkeyManager.getSlotHotkeys("dictation"),
    ["Control+F8", "Control+F9"],
    "the slot still describes what the desktop still holds"
  );
});

test("unregisterSlot clears the slot once every action is confirmed released", async () => {
  const { manager } = kdeManagerWith();
  manager.registeredSlots.add("dictation");
  manager.registeredSlots.add("dictation#1");
  const hotkeyManager = managerWithKde(manager, {
    hotkeys: ["Control+F8", "Control+F9"],
    bindingIds: ["dictation", "dictation#1"],
  });

  assert.equal(await hotkeyManager.unregisterSlot("dictation"), true);
  assert.deepEqual(hotkeyManager.getSlotHotkeys("dictation"), []);
});

// Removing a row is the case that bites: the row disappears from the UI, so if
// its action survives in KGlobalAccel there is no row left to remove it with.
test("removing a row whose action survives is reported as degraded", async () => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);

  const { manager } = kdeManagerWith({ refuse: (id) => id === "dictation#1" });
  manager.registeredSlots.add("dictation");
  manager.registeredSlots.add("dictation#1");
  manager.registerKeybinding = async () => true;
  const hotkeyManager = managerWithKde(manager, {
    hotkeys: ["Control+F8", "Control+F9"],
    bindingIds: ["dictation", "dictation#1"],
  });

  let rows = [
    { key: "Control+F8", mode: "cleaned" },
    { key: "Control+F9", mode: "raw" },
  ];
  const windowManager = {
    hotkeyManager,
    getDictationRows: () => rows,
    setDictationRows: (next) => {
      rows = next;
    },
    getDictationOwner: () => null,
    setHotkeyCommitInFlight: () => {},
    updateHotkey: (keys, options) => hotkeyManager.updateHotkey(keys, () => {}, options),
  };
  const target = {
    windowManager,
    environmentManager: {
      getDictationHotkeyConfig: () => "",
      saveStagedKeys: async () => ({ success: true }),
      constructor: { encodeDictationHotkeyConfig: (value) => value },
    },
  };

  const result = await IPCHandlers.prototype._applyDictationHotkeys.call(target, {
    rows: [{ key: "Control+F8", mode: "cleaned" }],
  });

  assert.equal(result.success, true, "the remaining row is bound, so the edit did apply");
  assert.equal(
    result.degraded,
    true,
    "but the removed row's action may still be grabbed by KGlobalAccel, and the user has no row left to remove it with"
  );
  assert.deepEqual(rows, [{ key: "Control+F8", mode: "cleaned" }]);
});

test("removing a row whose action is confirmed released is a clean edit", async () => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);

  const { manager } = kdeManagerWith();
  manager.registeredSlots.add("dictation");
  manager.registeredSlots.add("dictation#1");
  manager.registerKeybinding = async () => true;
  const hotkeyManager = managerWithKde(manager, {
    hotkeys: ["Control+F8", "Control+F9"],
    bindingIds: ["dictation", "dictation#1"],
  });

  let rows = [
    { key: "Control+F8", mode: "cleaned" },
    { key: "Control+F9", mode: "raw" },
  ];
  const windowManager = {
    hotkeyManager,
    getDictationRows: () => rows,
    setDictationRows: (next) => {
      rows = next;
    },
    getDictationOwner: () => null,
    setHotkeyCommitInFlight: () => {},
    updateHotkey: (keys, options) => hotkeyManager.updateHotkey(keys, () => {}, options),
  };

  const result = await IPCHandlers.prototype._applyDictationHotkeys.call(
    {
      windowManager,
      environmentManager: {
        getDictationHotkeyConfig: () => "",
        saveStagedKeys: async () => ({ success: true }),
        constructor: { encodeDictationHotkeyConfig: (value) => value },
      },
    },
    { rows: [{ key: "Control+F8", mode: "cleaned" }] }
  );

  assert.equal(result.success, true);
  assert.notEqual(result.degraded, true);
});
