const test = require("node:test");
const assert = require("node:assert/strict");
const {
  loadGnomeShortcut,
  onGnome,
  keybindingWrites,
  startDBusService,
} = require("./harness/gnomeShortcut");

const dbusSend = (dest, method) =>
  `dbus-send --session --type=method_call --dest=${dest} /com/openwhispr/App com.openwhispr.App.${method}`;

test(
  "Polish and Prompt Engineer get their own GNOME keybindings",
  onGnome({ OPENWHISPR_CHANNEL: "production" }, async () => {
    const { GnomeShortcutManager, writes } = loadGnomeShortcut();
    const manager = new GnomeShortcutManager();

    assert.equal(await manager.registerKeybinding("<Super><Alt>1", "polish"), true);
    assert.equal(await manager.registerKeybinding("<Super><Alt>2", "promptEngineer"), true);

    assert.deepEqual(keybindingWrites(writes, "openwhispr-polish"), {
      name: "OpenWhispr Polish",
      binding: "<Super><Alt>1",
      command: dbusSend("com.openwhispr.App", "RunPolish"),
    });
    assert.deepEqual(keybindingWrites(writes, "openwhispr-prompt-engineer"), {
      name: "OpenWhispr Prompt Engineer",
      binding: "<Super><Alt>2",
      command: dbusSend("com.openwhispr.App", "RunPromptEngineer"),
    });
  })
);

test(
  "a development build's Polish keybinding stays apart from an installed one",
  onGnome({ OPENWHISPR_CHANNEL: "development" }, async () => {
    const { GnomeShortcutManager, writes } = loadGnomeShortcut();
    const manager = new GnomeShortcutManager();

    assert.equal(await manager.registerKeybinding("<Super><Alt>1", "polish"), true);
    assert.deepEqual(keybindingWrites(writes, "openwhispr-development-polish"), {
      name: "OpenWhispr (development) Polish",
      binding: "<Super><Alt>1",
      command: dbusSend("com.openwhispr.App.development", "RunPolish"),
    });
  })
);

test(
  "the D-Bus service answers RunPolish and RunPromptEngineer",
  onGnome({ OPENWHISPR_CHANNEL: "production" }, async () => {
    const { GnomeShortcutManager } = loadGnomeShortcut();
    const calls = [];
    const manager = new GnomeShortcutManager();
    const bus = await startDBusService(manager, () => calls.push("dictation"));
    manager.setPolishCallback(() => calls.push("polish"));
    manager.setPromptEngineerCallback(() => calls.push("promptEngineer"));

    assert.equal(bus.started, true);
    assert.ok(bus.iface.methods.RunPolish);
    assert.ok(bus.iface.methods.RunPromptEngineer);
    bus.methods.RunPolish();
    bus.methods.RunPromptEngineer();
    assert.deepEqual(calls, ["polish", "promptEngineer"]);
  })
);
