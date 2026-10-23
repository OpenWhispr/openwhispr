const test = require("node:test");
const assert = require("node:assert/strict");
const {
  loadGnomeShortcut,
  onGnome,
  keybindingWrites,
  wroteKeybinding,
  startDBusService,
} = require("./harness/gnomeShortcut");

const dbusSend = (dest, method) =>
  `dbus-send --session --type=method_call --dest=${dest} /com/openwhispr/App com.openwhispr.App.${method}`;

test(
  "an installed build registers under the app's own names",
  onGnome({ OPENWHISPR_CHANNEL: "production" }, async () => {
    const { GnomeShortcutManager, writes } = loadGnomeShortcut();
    const manager = new GnomeShortcutManager();

    assert.equal(await manager.registerKeybinding("<Control><Alt>d", "dictation"), true);
    assert.deepEqual(keybindingWrites(writes, "openwhispr"), {
      name: "OpenWhispr Toggle",
      binding: "<Control><Alt>d",
      command: dbusSend("com.openwhispr.App", "Toggle"),
    });

    const bus = await startDBusService(new GnomeShortcutManager());
    assert.equal(bus.requestedName, "com.openwhispr.App");
  })
);

test(
  "a development build keeps its keybindings and bus name apart from an installed one",
  onGnome({ OPENWHISPR_CHANNEL: "development" }, async () => {
    const { GnomeShortcutManager, writes } = loadGnomeShortcut();
    const manager = new GnomeShortcutManager();

    assert.equal(await manager.registerKeybinding("<Control><Alt>d", "dictation"), true);
    assert.equal(await manager.registerKeybinding("<Control><Alt>m", "meeting"), true);

    assert.deepEqual(keybindingWrites(writes, "openwhispr-development"), {
      name: "OpenWhispr (development) Toggle",
      binding: "<Control><Alt>d",
      command: dbusSend("com.openwhispr.App.development", "Toggle"),
    });
    assert.equal(
      keybindingWrites(writes, "openwhispr-development-meeting").command,
      dbusSend("com.openwhispr.App.development", "ToggleMeeting")
    );
    assert.equal(wroteKeybinding(writes, "openwhispr"), false);
    assert.equal(wroteKeybinding(writes, "openwhispr-meeting"), false);

    const bus = await startDBusService(new GnomeShortcutManager());
    assert.equal(bus.requestedName, "com.openwhispr.App.development");
  })
);
