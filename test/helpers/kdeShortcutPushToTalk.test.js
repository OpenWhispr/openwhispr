const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const KDEShortcutManager = require("../../src/helpers/kdeShortcut");

test("modifier-only KDE shortcuts are rejected for push-to-talk on Wayland", async () => {
  const previousSessionType = process.env.XDG_SESSION_TYPE;
  process.env.XDG_SESSION_TYPE = "wayland";
  const component = new EventEmitter();
  const manager = new KDEShortcutManager();
  manager.bus = {
    invoke(_message, callback) {
      callback(null, []);
    },
    getService() {
      return {
        getInterface(_path, _interface, callback) {
          callback(null, component);
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
    setShortcut(_actionId, keys, _flags, callback) {
      callback(null, keys);
    },
  };

  try {
    assert.equal(
      await manager.registerKeybinding("Control+Super", "dictation", () => undefined, true),
      "modifier-only"
    );
  } finally {
    if (previousSessionType === undefined) delete process.env.XDG_SESSION_TYPE;
    else process.env.XDG_SESSION_TYPE = previousSessionType;
  }
});

test("KDE release events use the same friendly-name fallback as press events", async () => {
  const component = new EventEmitter();
  const phases = [];
  const manager = new KDEShortcutManager();
  manager.bus = {
    getService() {
      return {
        getInterface(_path, _interface, callback) {
          callback(null, component);
        },
      };
    },
  };
  manager.registeredSlots.add("dictation");
  manager.callbacks.set("dictation", (_hotkey, phase) => phases.push(phase));

  assert.equal(await manager._listenForComponent(), true);
  component.emit("globalShortcutReleased", "openwhispr", "OpenWhispr dictation");
  assert.deepEqual(phases, ["up"]);
});

test("KDE release events reach every push-capable slot but never the meeting slot", async () => {
  const component = new EventEmitter();
  const phases = [];
  const manager = new KDEShortcutManager();
  manager.bus = {
    getService() {
      return {
        getInterface(_path, _interface, callback) {
          callback(null, component);
        },
      };
    },
  };
  for (const slotName of ["dictation", "voiceAgent", "translation", "meeting"]) {
    manager.registeredSlots.add(slotName);
    manager.callbacks.set(slotName, (_hotkey, phase) => phases.push([slotName, phase]));
  }

  assert.equal(await manager._listenForComponent(), true);
  component.emit("globalShortcutReleased", "openwhispr", "voiceAgent");
  component.emit("globalShortcutReleased", "openwhispr", "translation");
  component.emit("globalShortcutReleased", "openwhispr", "dictation");
  // The meeting callback takes no phase: a release must not start a second
  // meeting.
  component.emit("globalShortcutReleased", "openwhispr", "meeting");
  assert.deepEqual(phases, [
    ["voiceAgent", "up"],
    ["translation", "up"],
    ["dictation", "up"],
  ]);
});

test("the KDE modifier-only push-to-talk rule applies to every slot", async () => {
  const previousSessionType = process.env.XDG_SESSION_TYPE;
  process.env.XDG_SESSION_TYPE = "wayland";
  const manager = new KDEShortcutManager();
  manager.kglobalaccel = {};
  manager.bus = {
    invoke(_message, callback) {
      callback(null, []);
    },
  };
  try {
    assert.equal(
      await manager.registerKeybinding("Control+Super", "voiceAgent", () => undefined, true),
      "modifier-only"
    );
  } finally {
    if (previousSessionType === undefined) delete process.env.XDG_SESSION_TYPE;
    else process.env.XDG_SESSION_TYPE = previousSessionType;
  }
});
