const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const KDEShortcutManager = require("../../src/helpers/kdeShortcut");

function managerAssigning(assignedKey) {
  const manager = new KDEShortcutManager();
  manager.bus = {
    invoke(_message, callback) {
      callback(null, []);
    },
    getService() {
      return {
        getInterface(_path, _interface, callback) {
          callback(null, new EventEmitter());
        },
      };
    },
  };
  manager.kglobalaccel = {
    unRegister(_actionId, callback) {
      callback(null);
    },
    doRegister(_actionId, callback) {
      callback(null);
    },
    setShortcut(_actionId, _keys, _flags, callback) {
      callback(null, [assignedKey]);
    },
  };
  return manager;
}

async function withWayland(fn) {
  const previousSessionType = process.env.XDG_SESSION_TYPE;
  process.env.XDG_SESSION_TYPE = "wayland";
  try {
    await fn();
  } finally {
    if (previousSessionType === undefined) delete process.env.XDG_SESSION_TYPE;
    else process.env.XDG_SESSION_TYPE = previousSessionType;
  }
}

// What kglobalacceld 6.8 answers for a modifier-only chord: the last modifier
// in Shift, Alt, Control, Meta order becomes the key (KDE/kglobalacceld ea65b9225).
const PLASMA_68_ANSWERS = [
  ["Control+Super", 0x11000021], // Meta | Key_Control
  ["Control+Shift", 0x05000020], // Ctrl | Key_Shift
  ["Control+Alt", 0x05000023], // Ctrl | Key_Alt
  ["Super", 0x01000022], // Key_Meta
];

test("a modifier-only chord stored as modifiers plus a modifier key is not a conflict", async () => {
  await withWayland(async () => {
    for (const [hotkey, answer] of PLASMA_68_ANSWERS) {
      const manager = managerAssigning(answer);
      assert.equal(await manager.registerKeybinding(hotkey, "dictation", () => {}), true, hotkey);
    }
  });
});

test("a key KDE refused is still a conflict", async () => {
  await withWayland(async () => {
    // KF5 and kglobalacceld 6.0-6.6 answer a key another component owns with an empty one.
    for (const hotkey of ["Control+Super", "Control+F8"]) {
      const manager = managerAssigning(0);
      assert.equal(
        await manager.registerKeybinding(hotkey, "dictation", () => {}),
        "conflict",
        hotkey
      );
    }
  });
});
