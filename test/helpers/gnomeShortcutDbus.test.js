const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const modulePath = require.resolve("../../src/helpers/gnomeShortcut");

test("exports explicit Start and Stop beside the existing GNOME D-Bus toggles", async () => {
  let exported;
  const dbusModule = {
    sessionBus() {
      return {
        connection: { on() {}, end() {} },
        requestName() {},
        exportInterface(methods, _path, iface) {
          exported = { methods, iface };
        },
      };
    },
  };

  const originalLoad = Module._load;
  delete require.cache[modulePath];
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "@homebridge/dbus-native") return dbusModule;
    if (request === "child_process") {
      return { execFileSync: () => "[]" };
    }
    if (request === "./debugLogger") {
      return { log() {} };
    }
    if (request === "./gnomeGlobalShortcutsPortal") {
      return class FakeGnomeGlobalShortcutsPortal {
        async close() {}
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const calls = [];
  let manager;
  try {
    const GnomeShortcutManager = require(modulePath);
    manager = new GnomeShortcutManager();
    assert.equal(
      await manager.initDBusService((hotkey, phase) =>
        calls.push(phase ? `dictation:${phase}` : "dictation")
      ),
      true
    );
  } finally {
    Module._load = originalLoad;
  }
  manager.setMeetingCallback(() => calls.push("meeting"));
  manager.setVoiceAgentCallback(() => calls.push("voiceAgent"));
  manager.setTranslationCallback(() => calls.push("translation"));

  assert.deepEqual(Object.keys(exported.iface.methods).sort(), [
    "Start",
    "Stop",
    "Toggle",
    "ToggleMeeting",
    "ToggleTranslation",
    "ToggleVoiceAgent",
  ]);
  exported.methods.Toggle();
  exported.methods.Start();
  exported.methods.Stop();
  exported.methods.ToggleMeeting();
  exported.methods.ToggleVoiceAgent();
  exported.methods.ToggleTranslation();

  assert.deepEqual(calls, [
    "dictation",
    "dictation:start",
    "dictation:stop",
    "meeting",
    "voiceAgent",
    "translation",
  ]);
});
